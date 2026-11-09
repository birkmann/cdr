// Capture runs, each into a snapshot folder: live (a real browser records every response at every viewport), Wayback
// (the public archive, for sites that block automated requests) and HAR (a recording made by a person). Every request
// a capture makes goes through the run's request guard (`withRunScope`), as the mirror crawl's do.
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { guardContext, guardedFetch, launchChromium } from "@harness/mirror-core";
import {
  contextOptions,
  fetchChain,
  mediaRefsOf,
  pageCompleteness,
  settlePage,
  STILL_TIMERS_JS,
  type NetworkEntry,
  type RedirectHop,
} from "@harness/mirror-capture";
import {
  browsePages,
  type CaptureBrowser,
  type CaptureContext,
  type CapturePage,
  type Viewport,
} from "./browse.js";
import { importHar, type HarImportResult } from "./har.js";
import { originalUrlFor, startReplayServer } from "./replay.js";
import { isTrackerUrl } from "./rewrite.js";
import { CaptureStore } from "./store.js";
import { WaybackClient } from "./wayback.js";

export interface CaptureLog {
  info(m: string): void;
  warn(m: string): void;
  debug?(m: string): void;
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_SWEEP = 600;

// ---------------------------------------------------------------- live capture

export interface LiveCaptureOptions {
  site: string;
  /** the snapshot folder */
  dir: string;
  url: string;
  viewports: Viewport[];
  log: CaptureLog;
  browser?: CaptureBrowser;
  /** the browser context per viewport; default: the crawl's own context options, frozen timers, request guard */
  newContext?: (browser: CaptureBrowser, viewport: Viewport) => Promise<CaptureContext>;
  /** loads the page and settles it; default: the crawl's `settlePage` */
  visit?: (page: CapturePage, url: string, viewport: Viewport) => Promise<{ status: number }>;
  /** runs with the page settled, before the context closes (screenshots) */
  afterVisit?: (page: CapturePage, viewport: Viewport) => Promise<void>;
}

export interface LiveCaptureReport {
  requestedUrl: string;
  finalUrl: string;
  origin: string;
  chain: RedirectHop[];
  document: { status: number; contentType?: string };
  entries: number;
  bytes: number;
  viewports: { name: string; status: number }[];
  /** requests that failed or answered ≥ 400, trackers excluded */
  failures: { url: string; status?: number; failure?: string; resourceType: string }[];
  /** bodies Playwright could not read back */
  unreadableBodies: string[];
  complete: { incomplete: boolean; failedScripts: string[]; signals: string[] };
  sweep: { tried: number; stored: number };
  /** rendered DOM of the widest viewport */
  html: string;
}

/**
 * Waits for the response bodies, but not for one that never ends (a video or event stream): closing the context then
 * fails those, and they are recorded as unreadable. False when the time ran out first.
 */
export async function settleBodies(pending: Promise<unknown>[], ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([Promise.allSettled(pending).then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

const widestFirst = (viewports: Viewport[]) => [...viewports].sort((a, b) => b.width - a.width);

async function defaultContext(browser: CaptureBrowser, viewport: Viewport): Promise<CaptureContext> {
  const context = await browser.newContext(contextOptions(viewport));
  await context.addInitScript({ content: STILL_TIMERS_JS });
  await guardContext(context);
  return context;
}

/** Visit the page at every viewport with a real browser and put every response into the store. */
export async function captureLive(o: LiveCaptureOptions): Promise<LiveCaptureReport> {
  const { log } = o;
  const chain = await fetchChain(o.url);
  const finalUrl = new URL(chain.finalUrl).href;
  const origin = new URL(finalUrl).origin;
  const store = await CaptureStore.open(o.dir, { site: o.site, origin, fresh: true });
  // redirects on the final origin are answered as redirects; a cross-origin chain is recorded in crawl.json only
  for (const hop of chain.chain)
    if (new URL(hop.url).origin === origin)
      await store.put({
        url: hop.url,
        status: hop.status,
        headers: hop.location ? { location: new URL(hop.location, hop.url).href } : {},
        body: "",
        from: "live:chain",
      });

  const ownBrowser = !o.browser;
  const browser = o.browser ?? (await launchChromium());
  const newContext = o.newContext ?? defaultContext;
  const visit =
    o.visit ??
    (async (page, url) => {
      const { response } = await settlePage(page, url);
      return { status: response?.status() ?? 0 };
    });
  const network: NetworkEntry[] = [];
  const unreadable = new Set<string>();
  const viewports: LiveCaptureReport["viewports"] = [];
  let html = "";
  let documentStatus = chain.status;
  try {
    for (const [i, vp] of widestFirst(o.viewports).entries()) {
      const context = await newContext(browser, vp);
      // newest route first: trackers are refused before anything else sees them
      await context.route(
        (u) => isTrackerUrl(u.href),
        (route) => route.abort("blockedbyclient"),
      );
      const page = await context.newPage();
      const pending: Promise<unknown>[] = [];
      const primary = i === 0;
      page.on("requestfailed", (req) => {
        if (primary && !isTrackerUrl(req.url()))
          network.push({
            url: req.url(),
            method: req.method(),
            resourceType: req.resourceType(),
            thirdParty: !req.url().startsWith(origin),
            failure: req.failure()?.errorText,
          });
      });
      page.on("response", (res) => {
        const url = res.url();
        if (!/^https?:/.test(url) || isTrackerUrl(url)) return;
        const req = res.request();
        const status = res.status();
        if (primary)
          network.push({
            url,
            method: req.method(),
            resourceType: req.resourceType(),
            status,
            mime: (res.headers()["content-type"] ?? "").split(";")[0].trim(),
            thirdParty: !url.startsWith(origin),
          });
        // no usable body in either; the full response of a ranged video is not worth a second request
        if (status === 304 || status === 206) return;
        const put = (body: Buffer | string) => {
          const previous = store.get(url, req.method());
          return store.put(
            { url, method: req.method(), status, headers: res.headers(), body, from: "live:crawl" },
            { replace: !!previous && previous.status !== 200 && status === 200 },
          );
        };
        // settled here: `pending` is only awaited after the visit, too late for a rejection to count as handled
        const record = (saving: Promise<unknown>) =>
          pending.push(
            saving.catch(() => {
              unreadable.add(url);
            }),
          );
        if (status >= 300 && status < 400) {
          record(put(""));
          return;
        }
        record(res.body().then(put));
      });
      try {
        const { status } = await visit(page, finalUrl, vp);
        viewports.push({ name: vp.name, status });
        if (primary) documentStatus = status || documentStatus;
        await o.afterVisit?.(page, vp);
        if (primary) html = await page.content();
        if (!(await settleBodies(pending, FETCH_TIMEOUT_MS)))
          log.info(`${vp.name}: some response bodies never ended; recorded as unreadable`);
      } finally {
        await context.close().catch(() => undefined);
      }
      log.info(`captured ${finalUrl} @${vp.name}: ${store.size} responses so far`);
    }
  } finally {
    if (ownBrowser) await browser.close().catch(() => undefined);
  }

  const sweep = await sweepReferences(store, html, origin, log);
  await captureRobots(store, origin);
  await store.save(true);

  const seen = new Set<string>();
  const failures = network
    .filter((n) => n.failure || (n.status ?? 0) >= 400)
    .filter((n) => !seen.has(n.url) && !!seen.add(n.url))
    .map((n) => ({ url: n.url, status: n.status, failure: n.failure, resourceType: n.resourceType }));
  return {
    requestedUrl: o.url,
    finalUrl,
    origin,
    chain: chain.chain,
    document: { status: documentStatus, contentType: chain.contentType },
    entries: store.size,
    bytes: await storeBytes(store, o.dir),
    viewports,
    failures,
    unreadableBodies: [...unreadable].sort(),
    complete: pageCompleteness(network, html),
    sweep,
    html,
  };
}

async function storeBytes(store: CaptureStore, dir: string): Promise<number> {
  let bytes = 0;
  for (const f of new Set(store.entries().map((e) => e.bodyFile)))
    bytes += (await stat(join(dir, f)).catch(() => ({ size: 0 }))).size;
  return bytes;
}

/** `url()`s in captured CSS and media in the page's HTML that the browser did not need at these viewports. */
async function sweepReferences(
  store: CaptureStore,
  html: string,
  origin: string,
  log: CaptureLog,
): Promise<{ tried: number; stored: number }> {
  const want = new Set<string>(mediaRefsOf(html, origin).filter((u) => !store.get(u)));
  for (const e of store.entries()) {
    if (e.status !== 200 || !/css/.test(e.mime)) continue;
    const css = (await store.readBody(e)).toString("latin1");
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const ref = m[2]!.trim();
      if (/^(data|blob|about|#)/i.test(ref) || ref.startsWith("%23")) continue;
      try {
        const abs = new URL(ref, e.url);
        abs.hash = "";
        if (/^https?:$/.test(abs.protocol) && !store.get(abs.href) && !isTrackerUrl(abs.href))
          want.add(abs.href);
      } catch {
        /* not a URL */
      }
    }
  }
  let stored = 0;
  const targets = [...want].sort().slice(0, MAX_SWEEP);
  for (const url of targets) {
    try {
      const res = await guardedFetch(url, {
        headers: { "user-agent": "cmp-crawler" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      const body = Buffer.from(await res.arrayBuffer());
      await store.put({ url, status: res.status, headers: headersOf(res), body, from: "live:sweep" });
      stored++;
    } catch (e) {
      log.debug?.(`sweep ${url}: ${(e as Error).message}`);
    }
  }
  if (want.size) log.info(`swept ${stored} of ${want.size} referenced resources the browser did not request`);
  return { tried: targets.length, stored };
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => (out[k] = v));
  return out;
}

/** The mirror crawl asks the replay for robots.txt; it should get the page's own, not a miss. */
async function captureRobots(store: CaptureStore, origin: string): Promise<void> {
  const url = `${origin}/robots.txt`;
  if (store.get(url)) return;
  const res = await guardedFetch(url, {
    headers: { "user-agent": "cmp-crawler" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => undefined);
  if (!res) return;
  if (!res.ok) {
    await res.body?.cancel();
    return;
  }
  await store.put({
    url,
    status: res.status,
    headers: headersOf(res),
    body: Buffer.from(await res.arrayBuffer()),
    from: "live:robots",
  });
}

// ---------------------------------------------------------------- does the replay answer what was captured?

export interface ReplayCheck {
  total: number;
  served: number;
  /** at most 20 entries: what was asked for and what came back */
  mismatches: { url: string; expected: number; got: number; reason: string }[];
}

/** Ask a running replay server for every captured GET entry; binary bodies must come back byte for byte. */
export async function checkReplay(store: CaptureStore, replayUrl: string): Promise<ReplayCheck> {
  const check: ReplayCheck = { total: 0, served: 0, mismatches: [] };
  const origin = new URL(store.origin);
  const miss = (url: string, expected: number, got: number, reason: string) => {
    if (check.mismatches.length < 20) check.mismatches.push({ url, expected, got, reason });
  };
  for (const e of store.entries()) {
    if (e.method !== "GET" || isTrackerUrl(e.url)) continue;
    check.total++;
    const u = new URL(e.url);
    const path =
      u.host === origin.host ? `${u.pathname}${u.search}` : `/__ext/${u.host}${u.pathname}${u.search}`;
    let res: Response;
    try {
      res = await fetch(`${replayUrl}${path}`, { redirect: "manual" });
    } catch (err) {
      miss(e.url, e.status, 0, (err as Error).message);
      continue;
    }
    if (res.status !== e.status) {
      await res.body?.cancel();
      miss(e.url, e.status, res.status, "status");
      continue;
    }
    if (e.status >= 300 && e.status < 400) {
      await res.body?.cancel();
      check.served++;
      continue;
    }
    const body = Buffer.from(await res.arrayBuffer());
    const expected = await store.readBody(e);
    // text bodies have their URLs rewritten; everything else must be the captured bytes
    if (/^(image|font|video|audio)\//.test(e.mime) && !body.equals(expected)) {
      miss(e.url, e.status, res.status, "body differs");
      continue;
    }
    check.served++;
  }
  return check;
}

// ---------------------------------------------------------------- Wayback and HAR

export interface ArchiveCaptureOptions {
  site: string;
  dir: string;
  origin: string;
  paths: string[];
  viewports: Viewport[];
  log: CaptureLog;
  /** path → 14-digit Wayback timestamp of the page snapshot (else: latest 200 capture from CDX) */
  timestamps?: Record<string, string>;
  /** inject a Wayback client (tests) */
  wayback?: WaybackClient;
}

export interface ArchiveCaptureReport {
  origin: string;
  entries: number;
  bytes: number;
  snapshots: Record<string, string>;
  unresolved: string[];
  har?: HarImportResult;
}

export function waybackClientFor(dir: string, log?: CaptureLog, offline = false): WaybackClient {
  return new WaybackClient({
    cacheDir: join(dir, ".wayback-cache"),
    log,
    concurrency: 2,
    minIntervalMs: 300,
    offline,
  });
}

function tsOf(from?: string): string | undefined {
  return from?.startsWith("wayback:") ? from.slice(8) : undefined;
}

/** Timestamp picker for on-miss fills: the referer's own capture ts, else the page snapshot ts. */
export function fillTimestamp(
  store: CaptureStore,
  defaults: string[],
): (url: string, referer?: string) => string {
  const fallback = [...defaults].sort()[Math.floor(defaults.length / 2)] ?? "2026";
  return (_url, referer) => {
    if (referer) {
      try {
        const ref = new URL(referer);
        const orig = originalUrlFor(ref.pathname + ref.search, store.origin);
        const e = orig ? store.lookup(orig)?.entry : undefined;
        const ts = tsOf(e?.from);
        if (ts) return ts;
      } catch {
        /* ignore */
      }
    }
    return fallback;
  };
}

/** Every url() in captured CSS, requested through the filling replay. */
export async function fillCssUrls(store: CaptureStore, replayUrl: string): Promise<number> {
  const want = new Set<string>();
  for (const e of store.entries()) {
    if (e.status !== 200 || !/css/.test(e.mime)) continue;
    const css = (await store.readBody(e)).toString("latin1");
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const ref = m[2]!.trim();
      if (/^(data|blob|about|#)/i.test(ref) || ref.startsWith("%23")) continue;
      try {
        const abs = new URL(ref, e.url);
        abs.hash = "";
        if (/^https?:$/.test(abs.protocol) && !store.get(abs.href) && !isTrackerUrl(abs.href))
          want.add(abs.href);
      } catch {
        /* ignore */
      }
    }
  }
  const origin = new URL(store.origin);
  let n = 0;
  for (const u of [...want].sort()) {
    const url = new URL(u);
    const path =
      url.host === origin.host
        ? `${url.pathname}${url.search}`
        : `/__ext/${url.host}${url.pathname}${url.search}`;
    await fetch(`${replayUrl}${path}`).then(
      (r) => r.arrayBuffer(),
      () => undefined,
    );
    n++;
  }
  return n;
}

async function latestSnapshot(client: WaybackClient, url: string): Promise<string | undefined> {
  const rows = await client.cdx({
    url,
    filter: "statuscode:200",
    fl: "timestamp,original,mimetype,statuscode",
    limit: "-20",
  });
  const html = rows.filter((r) => /html/.test(r[2] ?? ""));
  return html.length ? html[html.length - 1]![0] : undefined;
}

/** Page snapshots via `id_`, then a browser pass with on-miss fill at every viewport. */
export async function captureFromWayback(o: ArchiveCaptureOptions): Promise<ArchiveCaptureReport> {
  const { log } = o;
  const store = await CaptureStore.open(o.dir, { site: o.site, origin: o.origin, fresh: true });
  const client = o.wayback ?? waybackClientFor(o.dir, log);
  const snapshots: Record<string, string> = {};
  for (const path of o.paths) {
    const url = new URL(path, o.origin).href;
    const ts = o.timestamps?.[path] ?? (await latestSnapshot(client, url));
    if (!ts) throw new Error(`no Wayback snapshot for ${url}`);
    const r = await client.fetchId(ts, url);
    if (!r || r.status !== 200)
      throw new Error(
        `Wayback snapshot ${ts} of ${url} is not a usable 200 page (challenge page or missing)`,
      );
    snapshots[path] = r.ts;
    await store.put(
      { url, status: 200, headers: r.headers, body: r.body, from: `wayback:${r.ts}` },
      { replace: true },
    );
    log.info(`${path}: snapshot ${r.ts} (${r.body.length} bytes)`);
  }
  await store.save(true);

  const srv = await startReplayServer({
    captureDir: o.dir,
    store,
    csp: false, // let JS-requested third-party URLs reach the route handler (→ /__ext/ → captured)
    missesLog: join(o.dir, "misses-fill.jsonl"),
    fillFromWayback: {
      client,
      timestamp: fillTimestamp(store, Object.values(snapshots)),
      pages: o.paths,
    },
    log,
  });
  try {
    await browsePages({
      replayUrl: srv.url,
      origin: store.origin,
      paths: o.paths,
      viewports: o.viewports,
      log,
    });
    const n = await fillCssUrls(store, srv.url);
    if (n) log.info(`css url() sweep: ${n} referenced resources requested`);
  } finally {
    await srv.close();
  }
  await store.save(true);
  log.info(`fill pass: ${srv.fills} resources fetched into the store, ${srv.misses.size} unresolved`);
  return {
    origin: store.origin,
    entries: store.size,
    bytes: await storeBytes(store, o.dir),
    snapshots,
    unresolved: [...srv.misses.keys()].sort(),
  };
}

/** A recording made by a person in a real browser (authoritative for what it contains). */
export async function captureFromHar(
  o: ArchiveCaptureOptions & { harPath: string },
): Promise<ArchiveCaptureReport> {
  if (!existsSync(o.harPath)) throw new Error(`HAR path not found: ${o.harPath}`);
  const store = await CaptureStore.open(o.dir, { site: o.site, origin: o.origin, fresh: true });
  const har = await importHar(store, o.harPath);
  await store.save(true);
  o.log.info(`HAR: ${har.imported} entries imported from ${har.files.length} file(s)`);
  return {
    origin: store.origin,
    entries: store.size,
    bytes: await storeBytes(store, o.dir),
    snapshots: {},
    unresolved: [],
    har,
  };
}
