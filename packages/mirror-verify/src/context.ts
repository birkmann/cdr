import { guardedFetch, launchChromium } from "@harness/mirror-core";
import { readFile } from "node:fs/promises";
import { DEFAULT_MASK, preferRenderedContent, isServerHtml, pageContentHtml } from "@harness/mirror-capture";
import { join, resolve } from "node:path";
import { DEFAULT_VIEWPORTS, type Logger, type StepContext, type SiteConfig, type Workspace } from "@harness/mirror-core";
import type { Browser } from "playwright";
import { newCaptureContext, type CaptureContextOptions, type ViewportSpec } from "./capture.js";
import { readCcmData } from "./ccm.js";
import { decodeCfEmails, extractHrefs } from "./html.js";
import { loadTextFns } from "./text.js";
import type { CcmData, CrawlPageRecord, CrawlResult, PageResult, Side, VerifyContext } from "./types.js";

export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Hosts verify must never contact (the production origin of a captured/replayed site, e.g. www.nestle.com).
 * Filled by buildVerifyContext; enforced for every Node fetch and every browser context of verify.
 */
export const FORBIDDEN_HOSTS = new Set<string>();

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* relative/invalid: let fetch fail */
  }
  if (host && FORBIDDEN_HOSTS.has(host)) throw new Error(`refused: ${host} is a forbidden production origin (replay it locally)`);
  return guardedFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export async function getPage(url: string): Promise<PageResult> {
  try {
    const res = await fetchWithTimeout(url, { redirect: "follow", headers: { "user-agent": "cmp-verify/1.0" } });
    if (res.redirected && FORBIDDEN_HOSTS.has(new URL(res.url).hostname.toLowerCase())) throw new Error(`redirected to forbidden origin ${res.url}`);
    const contentType = res.headers.get("content-type") ?? "";
    const html = /html|xml/.test(contentType) ? decodeCfEmails(await res.text()) : (await res.arrayBuffer(), "");
    return { url, status: res.status, finalUrl: res.url || url, redirected: res.redirected, contentType, html };
  } catch (e) {
    return { url, status: 0, finalUrl: url, redirected: false, contentType: "", html: "", error: (e as Error).message };
  }
}

/**
 * The old page as a visitor's browser ends up with it (rendered DOM after load + network idle, same host guard as the
 * screenshot contexts). Used for pages whose content the pipeline took from the rendered DOM; `getPage` otherwise.
 */
export async function getRenderedPage(browser: () => Promise<Browser>, url: string, viewport: ViewportSpec, capture: CaptureContextOptions): Promise<PageResult> {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (FORBIDDEN_HOSTS.has(host)) throw new Error(`refused: ${host} is a forbidden production origin (replay it locally)`);
    const ctx = await newCaptureContext(await browser(), viewport, capture);
    try {
      const page = await ctx.newPage();
      let status = 0;
      try {
        const res = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
        status = res?.status() ?? 0;
      } catch (e) {
        if (!/timeout/i.test(String(e)) || page.url() === "about:blank") throw e;
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
        status = 200;
      }
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
      const finalUrl = page.url() || url;
      if (FORBIDDEN_HOSTS.has(new URL(finalUrl).hostname.toLowerCase())) throw new Error(`redirected to forbidden origin ${finalUrl}`);
      const html = decodeCfEmails(await page.content());
      return { url, status, finalUrl, redirected: finalUrl !== url, contentType: "text/html", html };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  } catch (e) {
    return { url, status: 0, finalUrl: url, redirected: false, contentType: "", html: "", error: (e as Error).message };
  }
}

/**
 * Crawl-time records of the crawled pages (html adapter manifests), keyed by normalised path. Empty without an html
 * crawl. `rendered` re-applies the adapter's content-source decision to the captures (@cmp/source-html
 * `preferRenderedContent`), so verify sees the page the way the CCM build did.
 */
export async function loadCrawlPages(ws: Workspace): Promise<Map<string, CrawlPageRecord>> {
  const out = new Map<string, CrawlPageRecord>();
  if (!(await ws.exists("raw/html/crawl.json").catch(() => false))) return out;
  const index = await ws.readJson<{ pages?: { path: string; status: number; manifest: string }[] }>("raw/html/crawl.json").catch(() => ({}) as { pages?: never });
  type Manifest = { files?: { raw?: string; rendered?: string }; links?: string[]; screenshots?: Record<string, string>; styles?: Record<string, { documentHeight?: number }> };
  for (const p of index.pages ?? []) {
    if (p.status !== 200) continue;
    const m = await ws.readJson<Manifest>(p.manifest).catch(() => undefined);
    if (!m?.files?.rendered) continue;
    const files = { raw: m.files.raw, rendered: m.files.rendered };
    let rendered = false;
    if (files.raw) {
      const raw = await ws.readText(files.raw).catch(() => "");
      if (isServerHtml(raw)) {
        const dom = await ws.readText(files.rendered).catch(() => "");
        rendered = !!dom && preferRenderedContent(raw, dom);
      } else rendered = true; // no usable server HTML: the adapter fell back to the rendered DOM
    } else rendered = true;
    const documentHeight: Record<string, number> = {};
    for (const [vp, s] of Object.entries(m.styles ?? {})) if (typeof s?.documentHeight === "number") documentHeight[vp] = s.documentHeight;
    const path = normPath(p.path);
    out.set(path, {
      path,
      links: [...new Set((m.links ?? []).map(normPath))].sort(),
      screenshots: m.screenshots ?? {},
      documentHeight,
      rendered,
      contentHtml: () => pageContentHtml(files, (rel) => ws.readText(rel)).then((r) => r.html),
    });
  }
  return out;
}

/** Crawled POC paths whose content came from the rendered DOM (see loadCrawlPages). */
export async function renderedContentPaths(ws: Workspace): Promise<string[]> {
  return [...(await loadCrawlPages(ws)).values()].filter((r) => r.rendered).map((r) => r.path);
}

export function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** Normalise a path for set comparison: no hash, no trailing slash (except "/"). */
export function normPath(p: string): string {
  const noHash = p.split("#")[0];
  const [path, q] = noHash.split("?");
  let out = path.replace(/\/+$/, "") || "/";
  if (!out.startsWith("/")) out = "/" + out;
  return q ? `${out}?${q}` : out;
}

export function isSkippableHref(href: string): boolean {
  const h = href.trim();
  return !h || h.startsWith("#") || /^(mailto|tel|javascript|data|sms|ftp):/i.test(h);
}

export interface BuildContextOptions {
  newBaseUrl: string;
  oldBaseUrl?: string;
  urls?: string[];
  ccm?: CcmData;
  /** production origin of a captured site (default: captures/<site>/index.json `origin`) — never contacted */
  productionOrigin?: string;
}

/** Production origin recorded by the capture store (captures/<site>/index.json), if the site is replayed. */
export async function captureOrigin(ws: Workspace, site: string): Promise<string | undefined> {
  const candidates = [resolve(process.cwd(), "captures", site, "index.json"), resolve(ws.root, "..", "..", "captures", site, "index.json"), join(ws.root, "..", "captures", site, "index.json")];
  for (const f of [...new Set(candidates)]) {
    try {
      const head = (await readFile(f, "utf8")).slice(0, 4096);
      const m = /"origin"\s*:\s*"([^"]+)"/.exec(head);
      if (m) return m[1];
    } catch {
      /* not captured */
    }
  }
  return undefined;
}

/** www./bare variants of a host */
function hostVariants(host: string): string[] {
  const h = host.toLowerCase();
  return h.startsWith("www.") ? [h, h.slice(4)] : [h, `www.${h}`];
}

export async function buildVerifyContext(
  base: { site: SiteConfig; ws: Workspace; log: Logger; options?: Record<string, unknown> },
  opts: BuildContextOptions,
): Promise<VerifyContext> {
  const { site, ws, log } = base;
  const options = base.options ?? {};
  if (!opts.newBaseUrl) throw new Error("verify: newBaseUrl is required (e.g. --new-base-url http://localhost:4410)");
  const newBaseUrl = trimSlash(opts.newBaseUrl);
  const oldBaseUrl = trimSlash(opts.oldBaseUrl ?? site.baseUrl);
  const ccm = opts.ccm ?? (await readCcmData(ws, site));
  const text = await loadTextFns();
  const urls = (opts.urls ?? site.urls ?? ["/"]).map(normPath);

  const seen = new Set<string>();
  // teaser stubs (title/date taken from a listing so links resolve, page itself not migrated) are not page-parity scope
  const isStub = (e: (typeof ccm.entries)[number]) => (e.source as { kind?: string } | undefined)?.kind === "teaser";
  const stubs = [...new Set(ccm.entries.filter((e) => e.path && isStub(e)).map((e) => normPath(e.path!)))];
  const routable = ccm.entries.filter((e) => {
    if (!e.path || (e.status ?? "published") !== "published" || isStub(e)) return false;
    const p = normPath(e.path);
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  const allPaths = [...new Set([...urls, ...routable.map((e) => normPath(e.path!))])];

  const productionOrigin = opts.productionOrigin ?? (options.productionOrigin as string | undefined) ?? (await captureOrigin(ws, site.site));
  const forbidden: string[] = [];
  if (productionOrigin) {
    try {
      const ph = new URL(productionOrigin).hostname;
      const local = [newBaseUrl, oldBaseUrl].some((u) => new URL(u).hostname === ph);
      if (!local) for (const h of hostVariants(ph)) forbidden.push(h);
    } catch {
      /* ignore */
    }
  }
  for (const h of forbidden) FORBIDDEN_HOSTS.add(h);
  for (const [side, u] of [["old", oldBaseUrl], ["new", newBaseUrl]] as const)
    if (FORBIDDEN_HOSTS.has(new URL(u).hostname.toLowerCase()))
      throw new Error(`verify: ${side} base URL ${u} is the production origin of a captured site; use the local replay (e.g. --old-base-url http://localhost:4401)`);

  const hosts = new Set<string>();
  for (const u of [newBaseUrl, oldBaseUrl, site.baseUrl, ccm.settings?.baseUrl, productionOrigin]) {
    try {
      if (u) for (const h of hostVariants(new URL(u).host)) hosts.add(h);
    } catch {
      /* ignore */
    }
  }
  // browser contexts may load from the two sides only (the replay serves third parties under /__ext/)
  const capture: CaptureContextOptions = {
    allowHosts: [...new Set([new URL(newBaseUrl).host, new URL(oldBaseUrl).host, new URL(newBaseUrl).hostname, new URL(oldBaseUrl).hostname])],
    forbiddenHosts: forbidden,
    // a live original (not a local replay) loads its CDNs and feature apps like for a visitor; the new site references
    // the same external resources, so both sides see them
    allowThirdParty: !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(new URL(oldBaseUrl).hostname),
  };
  // site origins embedded in query strings (e.g. /info/SendPage?Ctx=http://localhost:4401/about) → root-relative
  const originRe = new RegExp(
    `https?(?::|%3A)(?://|%2F%2F)(?:${[...hosts].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:/g, "(?::|%3A)")).join("|")})`,
    "gi",
  );
  const stripOrigins = (q: string) => (hosts.size ? q.replace(originRe, "") : q);
  const hostNormalize = (url: string, force = false): string => {
    const s = url.trim();
    try {
      const u = new URL(s, s.startsWith("/") || force ? newBaseUrl + "/" : undefined);
      if (!/^https?:$/.test(u.protocol)) return s;
      if (force || hosts.has(u.host) || s.startsWith("/")) return normPath(u.pathname + (u.search ? stripOrigins(u.search) : ""));
      return s;
    } catch {
      return s;
    }
  };

  // pages whose content the pipeline took from the browser-rendered DOM (client-rendered Next.js pages): the old side
  // is rendered in a browser for them, like the crawl did — the server HTML only holds the widgets' skeletons
  const crawlPages = await loadCrawlPages(ws);
  const renderedOld = new Set<string>([...crawlPages.values()].filter((r) => r.rendered).map((r) => r.path));
  const vps = (site.crawl?.viewports ?? DEFAULT_VIEWPORTS) as ViewportSpec[];
  const renderViewport = vps.reduce((a, b) => (b.width > a.width ? b : a), vps[0] ?? { name: "desktop", width: 1440, height: 900 });

  const cache = new Map<string, Promise<PageResult>>();
  const fetchPage = (side: Side, path: string) => {
    const url = (side === "old" ? oldBaseUrl : newBaseUrl) + (path.startsWith("/") ? path : `/${path}`);
    let p = cache.get(url);
    if (!p) {
      p = side === "old" && renderedOld.has(normPath(path)) ? getRenderedPage(browser, url, renderViewport, capture) : getPage(url);
      cache.set(url, p);
    }
    return p;
  };

  let crawl: Promise<CrawlResult> | undefined;
  const maxPages = Number(options.maxPages ?? Math.max(200, (site.crawl?.maxPages ?? 50) * 4));
  const crawlNew = () => {
    crawl ??= (async () => {
      const origin = new URL(newBaseUrl).origin;
      const queue = [...allPaths];
      const visited = new Set<string>();
      const res: CrawlResult = { pages: [], links: new Map() };
      while (queue.length && visited.size < maxPages) {
        const path = queue.shift()!;
        if (visited.has(path)) continue;
        visited.add(path);
        const page = await fetchPage("new", path);
        res.pages.push({ path, page });
        if (page.status !== 200 || !page.html) continue;
        const targets: string[] = [];
        for (const href of extractHrefs(page.html)) {
          if (isSkippableHref(href)) continue;
          let u: URL;
          try {
            u = new URL(href, page.finalUrl);
          } catch {
            continue;
          }
          if (!/^https?:$/.test(u.protocol)) continue;
          // links to the old/live host count as internal (same domain after cutover)
          if (u.origin !== origin) {
            if (!hosts.has(u.host)) continue;
            u = new URL(u.pathname + u.search, origin);
          }
          u.hash = "";
          targets.push(u.toString());
          const p = normPath(u.pathname + u.search);
          if (!visited.has(p) && !/\.(png|jpe?g|gif|svg|webp|pdf|zip|docx?|xlsx?|mp4|css|js|ico|xml|txt)$/i.test(u.pathname)) queue.push(p);
        }
        res.links.set(path, [...new Set(targets)]);
      }
      return res;
    })();
    return crawl;
  };

  let browserP: Promise<Browser> | undefined;
  const browser = () => {
    browserP ??= launchChromium({ headless: true });
    return browserP;
  };

  return {
    site,
    ws,
    log,
    options,
    oldBaseUrl,
    newBaseUrl,
    urls,
    ccm,
    routable,
    allPaths,
    stubPaths: stubs.filter((p) => !allPaths.includes(p)),
    // consent / geo overlays (DEFAULT_MASK) are hidden in screenshots; they are no key elements either
    mask: [...new Set([...DEFAULT_MASK, ...(site.crawl?.mask ?? [])])],
    capture,
    productionOrigin,
    knownHosts: [...hosts],
    normalizeText: text.normalizeText,
    plainText: text.plainText,
    fetchPage,
    renderedOldPaths: [...renderedOld].sort(),
    crawlPage: (path: string) => crawlPages.get(normPath(path)),
    crawlNew,
    browser,
    hostNormalize,
    async close() {
      if (browserP) await (await browserP).close().catch(() => undefined);
      browserP = undefined;
    },
  };
}

/** `options.urls`: string[] or "/a,/b" (CLI `--urls`); undefined = all site urls. */
export function parseUrlList(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const list = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

export function contextFromStep(ctx: StepContext): Promise<VerifyContext> {
  const o = ctx.options;
  return buildVerifyContext(
    { site: ctx.site, ws: ctx.ws, log: ctx.log, options: o },
    {
      newBaseUrl: String(o.newBaseUrl ?? o["new-base-url"] ?? process.env.NEW_BASE_URL ?? ""),
      oldBaseUrl: (o.oldBaseUrl ?? o["old-base-url"]) as string | undefined,
      urls: parseUrlList(o.urls),
    },
  );
}
