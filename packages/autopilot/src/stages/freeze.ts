// freeze (plan §2.1): capture a site once into a snapshot and serve it from disk for every later stage, so the loop
// measures the pipeline and not the site's drift. A site that blocks automated requests is reported; only with
// `freeze.wayback` is the public archive used instead. Logins, paywalls and captchas are never worked around.
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import {
  checkRobots,
  findChrome,
  requestGuard,
  resolveSource,
  SourceBlocked,
  type GuardOptions,
} from "@harness/mirror";
import { DEFAULT_VIEWPORTS, launchChromium, withRunScope } from "@harness/mirror-core";
import {
  captureScreenshot,
  compareImages,
  loadForCaptureInfo,
  newCaptureContext,
} from "@harness/mirror-verify";
import {
  CaptureStore,
  captureFromWayback,
  captureLive,
  checkReplay,
  isChallengePage,
  startReplayServer,
  type CaptureBrowser,
  type LiveCaptureReport,
  type Viewport,
} from "@harness/mirror-replay";
import type {
  AutopilotPaths,
  Gate,
  SiteConfig,
  SnapshotRef,
  StageContext,
  StageIssue,
  StageRunner,
  StageSummary,
} from "../types.js";

const DAY_MS = 86_400_000;

export interface ReplayFile {
  site: string;
  requestedUrl: string;
  finalUrl: string;
  capturedAt: string;
  source: SnapshotRef["source"];
  entries: number;
  bytes: number;
  /** Live against replay at capture time, per viewport. Later drift is measured against this, never counted as a defect. */
  parity: Record<string, number>;
  wayback?: { snapshots: Record<string, string>; unresolved: string[] };
}

// ---------------------------------------------------------------- snapshots on disk

const currentLink = (paths: Pick<AutopilotPaths, "snapshots">, site: string) =>
  join(paths.snapshots, site, "current");

/** The snapshot folder `current` points at, if it exists and holds a replay. */
export function currentSnapshotDir(
  paths: Pick<AutopilotPaths, "snapshots">,
  site: string,
): string | undefined {
  const link = currentLink(paths, site);
  try {
    const target = readlinkSync(link);
    const dir = resolve(dirname(link), target);
    return existsSync(join(dir, "replay.json")) ? dir : undefined;
  } catch {
    return undefined;
  }
}

export function readReplayFile(dir: string): ReplayFile {
  return JSON.parse(readFileSync(join(dir, "replay.json"), "utf8")) as ReplayFile;
}

export function readSnapshotRef(dir: string): SnapshotRef {
  const r = readReplayFile(dir);
  return { site: r.site, dir, finalUrl: r.finalUrl, capturedAt: r.capturedAt, source: r.source };
}

/** Whole days since a snapshot was captured. */
export function snapshotAgeDays(capturedAt: string, now: number): number {
  return (now - Date.parse(capturedAt)) / DAY_MS;
}

/** A snapshot is reused until it is older than `maxAgeDays`. */
export function isSnapshotFresh(capturedAt: string, maxAgeDays: number, now: number): boolean {
  const age = snapshotAgeDays(capturedAt, now);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeDays;
}

export function pointCurrent(paths: Pick<AutopilotPaths, "snapshots">, site: string, dir: string): void {
  const link = currentLink(paths, site);
  const tmp = `${link}.${process.pid}.tmp`;
  symlinkSync(dir.split("/").pop()!, tmp);
  renameSync(tmp, link);
}

const snapshotStamp = (now: number) =>
  new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

export function siteViewports(site: SiteConfig): Viewport[] {
  if (!site.viewports?.length) return DEFAULT_VIEWPORTS;
  return site.viewports.map((name) => {
    const vp = DEFAULT_VIEWPORTS.find((v) => v.name === name);
    if (!vp) throw new Error(`${site.id}: unknown viewport "${name}"`);
    return vp;
  });
}

// ---------------------------------------------------------------- fixture sites

const FIXTURE_ROOT = "packages/capture/test/sites";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain",
};

/** Serves a fixture site for its capture (127.0.0.1, random port); nothing later stages ever talk to. */
async function serveFixture(root: string, name: string): Promise<{ url: string; close(): Promise<void> }> {
  const dir = join(root, FIXTURE_ROOT, name);
  if (!existsSync(join(dir, "index.html"))) throw new Error(`no fixture site "${name}" at ${dir}`);
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) };
}

// ---------------------------------------------------------------- the stage

export interface FreezeOptions {
  /** Recrawl even when a fresh snapshot exists (`--refresh`). */
  refresh?: boolean;
  /** Site ids whose blocked crawl may use the Wayback Machine (`--wayback bmw`). */
  wayback?: string[];
  now?: () => number;
  /** Replace the real source check (tests). */
  resolve?: typeof resolveSource;
  /** Replace the robots.txt check (tests). */
  robots?: typeof checkRobots;
  /** Replace the live capture (tests). */
  capture?: (
    ctx: StageContext,
    dir: string,
    url: string,
    browser: CaptureBrowser,
  ) => Promise<LiveCaptureReport>;
  /** Replace the archive capture (tests). */
  waybackCapture?: (ctx: StageContext, dir: string, url: string) => Promise<ArchiveOutcome>;
}

interface ArchiveOutcome {
  finalUrl: string;
  entries: number;
  bytes: number;
  snapshots: Record<string, string>;
  unresolved: string[];
}

class Blocked extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
  ) {
    super(`${host}: ${reason}`);
    this.name = "Blocked";
  }
}

const usesWayback = (ctx: StageContext, o: FreezeOptions) =>
  ctx.config.freeze.wayback || ctx.site.freeze?.wayback === true || o.wayback?.includes(ctx.site.id) === true;

function result(
  ctx: StageContext,
  startedAt: number,
  status: StageSummary["status"],
  gates: Gate[],
  issues: StageIssue[],
  artifacts: Record<string, string>,
): StageSummary {
  return {
    stage: "freeze",
    site: ctx.site.id,
    status,
    wallClockMs: Date.now() - startedAt,
    gates,
    issues,
    artifacts,
  };
}

function failSummary(
  ctx: StageContext,
  startedAt: number,
  issue: StageIssue,
  gates: Gate[] = [],
): StageSummary {
  return result(ctx, startedAt, "failed", gates, [issue], {});
}

async function shootReplay(browser: CaptureBrowser, url: string, vp: Viewport): Promise<Buffer> {
  const context = await newCaptureContext(browser, vp, {});
  try {
    const page = await context.newPage();
    await loadForCaptureInfo(page, url, vp);
    return await captureScreenshot(page, url, vp, { mask: [], skipLoad: true });
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Replays the snapshot on a local port and checks every entry comes back; returns the running server's URL. */
async function verifyReplay(
  ctx: StageContext,
  dir: string,
  finalUrl: string,
): Promise<{
  url: string;
  port: number;
  close(): Promise<void>;
  check: Awaited<ReturnType<typeof checkReplay>>;
}> {
  const store = await CaptureStore.load(dir);
  const port = await ctx.ports.acquire();
  const server = await startReplayServer({
    captureDir: dir,
    store,
    port,
    host: "127.0.0.1",
    missesLog: join(dir, "replay-verify-misses.jsonl"),
  });
  const check = await checkReplay(store, server.url);
  const { pathname, search } = new URL(finalUrl);
  return {
    url: `${server.url}${pathname}${search}`,
    port,
    check,
    close: async () => {
      await server.close();
      ctx.ports.release(port);
    },
  };
}

function replayGate(check: Awaited<ReturnType<typeof checkReplay>>): Gate {
  return {
    id: "replay.assets",
    pass: check.total > 0 && check.served === check.total,
    hard: true,
    value: check.served,
    threshold: check.total,
  };
}

function replayIssues(check: Awaited<ReturnType<typeof checkReplay>>, dir: string): StageIssue[] {
  if (check.served === check.total) return [];
  return [
    {
      code: "SNAPSHOT_INCOMPLETE",
      cause: "replay",
      message: `the replay answers ${check.served} of ${check.total} captured requests (first: ${check.mismatches[0]?.url ?? "?"})`,
      severity: "error",
      evidence: [join(dir, "replay.json")],
    },
  ];
}

/** A snapshot already on disk: check it still answers, reuse it. */
async function reuseSnapshot(ctx: StageContext, dir: string, startedAt: number): Promise<StageSummary> {
  const ref = readReplayFile(dir);
  ctx.log(`reusing snapshot ${dir} (captured ${ref.capturedAt})`);
  const replay = await verifyReplay(ctx, dir, ref.finalUrl);
  try {
    const gates: Gate[] = [
      { id: "crawl.pagesComplete", pass: true, hard: true, value: "reused" },
      replayGate(replay.check),
      recordedParityGate(ref.parity),
    ];
    const issues = replayIssues(replay.check, dir);
    const status = gates.every((g) => !g.hard || g.pass) ? "passed" : "failed";
    return result(ctx, startedAt, status, gates, issues, {
      snapshot: dir,
      replayFile: join(dir, "replay.json"),
    });
  } finally {
    await replay.close();
  }
}

function recordedParityGate(parity: Record<string, number>): Gate {
  const values = Object.values(parity);
  return {
    id: "replay.parity",
    pass: values.length > 0,
    hard: true,
    value: values.length ? Math.min(...values) : "not recorded",
  };
}

async function liveCaptureFn(
  ctx: StageContext,
  dir: string,
  url: string,
  browser: CaptureBrowser,
): Promise<LiveCaptureReport> {
  return captureLive({
    site: ctx.site.id,
    dir,
    url,
    viewports: siteViewports(ctx.site),
    browser,
    log: { info: (m) => ctx.log(m), warn: (m) => ctx.log(`warning: ${m}`) },
    newContext: (b, vp) => newCaptureContext(b, vp, {}),
    visit: (page, target, vp) => loadForCaptureInfo(page, target, vp),
    afterVisit: async (page, vp) => {
      const shot = await captureScreenshot(page, url, vp, { mask: [], skipLoad: true });
      writeFileSync(join(dir, "screens", `${vp.name}.png`), shot);
    },
  });
}

const challengeReason = (report: LiveCaptureReport): string | undefined => {
  if (report.document.status === 403 || report.document.status === 429 || report.document.status === 503)
    return `HTTP ${report.document.status}`;
  if (isChallengePage(report.html)) return "a bot-management challenge page";
  return undefined;
};

function driftGate(ctx: StageContext, dir: string, previousDir: string | undefined): Gate | undefined {
  if (!previousDir) return undefined;
  const values: number[] = [];
  for (const vp of siteViewports(ctx.site)) {
    const a = join(previousDir, "screens", `${vp.name}.png`);
    const b = join(dir, "screens", `${vp.name}.png`);
    if (!existsSync(a) || !existsSync(b)) continue;
    try {
      values.push(compareImages(readFileSync(a), readFileSync(b)).parity);
    } catch (e) {
      ctx.log(`drift: ${(e as Error).message}`);
    }
  }
  if (!values.length) return undefined;
  return { id: "snapshot.drift", pass: true, hard: false, value: Math.min(...values) };
}

/** Live capture, its replay checked and compared at capture time. */
async function captureSite(
  ctx: StageContext,
  o: FreezeOptions,
  dir: string,
  url: string,
  startedAt: number,
  previousDir: string | undefined,
): Promise<StageSummary> {
  const browser = await launchChromium();
  try {
    mkdirSync(join(dir, "screens", "replay"), { recursive: true });
    const report = o.capture
      ? await o.capture(ctx, dir, url, browser)
      : await liveCaptureFn(ctx, dir, url, browser);
    const blocked = challengeReason(report);
    if (blocked) throw new Blocked(new URL(report.finalUrl).hostname, blocked);
    const { html, ...crawl } = report;
    writeFileSync(
      join(dir, "crawl.json"),
      `${JSON.stringify({ ...crawl, capturedAt: new Date(startedAt).toISOString() }, null, 2)}\n`,
    );
    writeFileSync(join(dir, "raw", "rendered.html"), html);
    const complete = report.document.status < 400 && !report.complete.incomplete;
    const issues: StageIssue[] = [];
    if (!complete)
      issues.push({
        code: "SNAPSHOT_INCOMPLETE",
        cause: "page",
        message: `${report.finalUrl} did not render completely (HTTP ${report.document.status}, ${report.complete.failedScripts.length} script(s) failed; ${report.complete.signals.join("; ") || "no stuck-render marker"})`,
        severity: "error",
        evidence: [join(dir, "crawl.json")],
      });
    const replay = await verifyReplay(ctx, dir, report.finalUrl);
    const parity: Record<string, number> = {};
    try {
      for (const vp of siteViewports(ctx.site)) {
        const live = join(dir, "screens", `${vp.name}.png`);
        if (!existsSync(live)) continue;
        const shot = await shootReplay(browser, replay.url, vp);
        writeFileSync(join(dir, "screens", "replay", `${vp.name}.png`), shot);
        parity[vp.name] = compareImages(readFileSync(live), shot).parity;
      }
    } finally {
      await replay.close();
    }
    const gates: Gate[] = [
      {
        id: "crawl.pagesComplete",
        pass: complete,
        hard: true,
        value: report.complete.failedScripts.length,
        threshold: 0,
      },
      replayGate(replay.check),
      recordedParityGate(parity),
    ];
    const drift = driftGate(ctx, dir, previousDir);
    if (drift) gates.push(drift);
    issues.push(...replayIssues(replay.check, dir));
    for (const [vp, value] of Object.entries(parity))
      if (value < 0.97)
        issues.push({
          code: "REPLAY_PARITY_LOW",
          message: `${vp}: the replay matches the live page at ${value.toFixed(4)}`,
          severity: "warning",
          evidence: [join(dir, "screens", "replay", `${vp}.png`), join(dir, "screens", `${vp}.png`)],
        });
    if (report.failures.length)
      issues.push({
        code: "REQUEST_FAILED",
        cause: "capture",
        message: `${report.failures.length} request(s) failed during the capture, for example ${report.failures[0]!.url}`,
        severity: "warning",
        evidence: [join(dir, "crawl.json")],
      });
    const replayFile: ReplayFile = {
      site: ctx.site.id,
      requestedUrl: url,
      finalUrl: report.finalUrl,
      capturedAt: new Date(startedAt).toISOString(),
      source: ctx.site.fixture ? "fixture" : "live",
      entries: report.entries,
      bytes: report.bytes,
      parity,
    };
    writeFileSync(join(dir, "replay.json"), `${JSON.stringify(replayFile, null, 2)}\n`);
    const status = gates.every((g) => !g.hard || g.pass) ? "passed" : "failed";
    if (status === "passed") pointCurrent(ctx.paths, ctx.site.id, dir);
    return result(ctx, startedAt, status, gates, issues, {
      snapshot: dir,
      replayFile: join(dir, "replay.json"),
      crawl: join(dir, "crawl.json"),
      screens: join(dir, "screens"),
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function captureArchive(
  ctx: StageContext,
  o: FreezeOptions,
  dir: string,
  url: string,
  startedAt: number,
  reason: string,
): Promise<StageSummary> {
  const parsed = new URL(url);
  const blockedIssue: StageIssue = {
    code: "BOT_BLOCKED",
    cause: "wayback",
    message: `${parsed.hostname} blocks automated requests (${reason}); the snapshot comes from the Wayback Machine`,
    severity: "warning",
  };
  const archive = o.waybackCapture
    ? await o.waybackCapture(ctx, dir, url)
    : await captureFromWayback({
        site: ctx.site.id,
        dir,
        origin: parsed.origin,
        paths: [`${parsed.pathname}${parsed.search}`],
        viewports: siteViewports(ctx.site),
        log: { info: (m) => ctx.log(m), warn: (m) => ctx.log(`warning: ${m}`) },
      }).then((r) => ({ ...r, finalUrl: url }));
  const replayFile: ReplayFile = {
    site: ctx.site.id,
    requestedUrl: url,
    finalUrl: archive.finalUrl,
    capturedAt: new Date(startedAt).toISOString(),
    source: "wayback",
    entries: archive.entries,
    bytes: archive.bytes,
    parity: {},
    wayback: { snapshots: archive.snapshots, unresolved: archive.unresolved },
  };
  writeFileSync(join(dir, "replay.json"), `${JSON.stringify(replayFile, null, 2)}\n`);
  writeFileSync(
    join(dir, "crawl.json"),
    `${JSON.stringify({ requestedUrl: url, finalUrl: archive.finalUrl, wayback: replayFile.wayback }, null, 2)}\n`,
  );
  const replay = await verifyReplay(ctx, dir, archive.finalUrl);
  const gates: Gate[] = [
    { id: "crawl.pagesComplete", pass: archive.entries > 0, hard: true, value: archive.unresolved.length },
    replayGate(replay.check),
    { id: "replay.parity", pass: true, hard: true, value: "no live page to compare with (Wayback)" },
    { id: "snapshot.source", pass: true, hard: false, value: "wayback" },
  ];
  await replay.close();
  const issues: StageIssue[] = [blockedIssue, ...replayIssues(replay.check, dir)];
  if (archive.unresolved.length)
    issues.push({
      code: "REPLAY_404",
      cause: "wayback",
      message: `${archive.unresolved.length} URL(s) the archive could not answer, for example ${archive.unresolved[0]}`,
      severity: "warning",
      evidence: [join(dir, "replay.json")],
    });
  const status = gates.every((g) => !g.hard || g.pass) ? "passed" : "failed";
  if (status === "passed") pointCurrent(ctx.paths, ctx.site.id, dir);
  return result(ctx, startedAt, status, gates, issues, {
    snapshot: dir,
    replayFile: join(dir, "replay.json"),
  });
}

async function freeze(ctx: StageContext, o: FreezeOptions): Promise<StageSummary> {
  const startedAt = Date.now();
  const now = (o.now ?? Date.now)();
  const siteDir = join(ctx.paths.snapshots, ctx.site.id);
  const current = currentSnapshotDir(ctx.paths, ctx.site.id);
  if (
    !o.refresh &&
    current &&
    isSnapshotFresh(readReplayFile(current).capturedAt, ctx.config.freeze.maxAgeDays, now)
  )
    return reuseSnapshot(ctx, current, startedAt);

  const dir = join(siteDir, snapshotStamp(now));
  mkdirSync(join(dir, "raw"), { recursive: true });
  mkdirSync(join(dir, "screens"), { recursive: true });

  let fixture: Awaited<ReturnType<typeof serveFixture>> | undefined;
  if (ctx.site.fixture) fixture = await serveFixture(ctx.paths.root, ctx.site.fixture);
  const url = fixture?.url ?? ctx.site.url;
  if (!url) throw new Error(`${ctx.site.id} has neither a url nor a fixture`);
  const options: GuardOptions = { allowLocal: !!ctx.site.fixture };
  const guard = requestGuard(options, new Set());
  const chromePath = (() => {
    try {
      return findChrome() ?? undefined;
    } catch {
      return undefined;
    }
  })();
  try {
    return await withRunScope({ guard, chromePath }, async () => {
      const wayback = usesWayback(ctx, o) && !ctx.site.fixture;
      const resolveFn = o.resolve ?? resolveSource;
      const robotsFn = o.robots ?? checkRobots;
      try {
        const robots = await robotsFn(url, { ...options, userAgent: "cmp-crawler" }).catch(
          () => ({ allowed: true }) as { allowed: boolean; rule?: string },
        );
        if (!robots.allowed)
          return failSummary(ctx, startedAt, {
            code: "ROBOTS_DISALLOWED",
            message: `robots.txt disallows ${url} for automated crawlers (${robots.rule ?? "no rule"})`,
            severity: "error",
          });
        await resolveFn(url);
        return await captureSite(ctx, o, dir, url, startedAt, current);
      } catch (e) {
        // a site that never answers automated requests only ever shows up as a timeout
        const silent =
          wayback && (e as Error).name === "TimeoutError" ? "the live page did not answer" : undefined;
        const reason = e instanceof SourceBlocked ? e.reason : e instanceof Blocked ? e.reason : silent;
        if (reason === undefined) throw e;
        const host = new URL(url).hostname;
        ctx.log(`${host} blocks automated requests: ${reason}`);
        if (!wayback)
          return failSummary(ctx, startedAt, {
            code: "BOT_BLOCKED",
            message: `${host} blocks automated requests (${reason}); enable freeze.wayback for this site to use the archive`,
            severity: "error",
          });
        return await captureArchive(ctx, o, dir, url, startedAt, reason);
      }
    });
  } finally {
    await fixture?.close();
  }
}

export function createFreezeStage(options: FreezeOptions = {}): StageRunner {
  return { name: "freeze", run: (ctx) => freeze(ctx, options) };
}

export const freezeStage: StageRunner = createFreezeStage();
