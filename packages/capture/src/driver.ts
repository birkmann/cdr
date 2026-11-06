// The capture driver: headless Chrome over CDP-on-a-pipe, the shared in-page script
// (assets/domCapture.js), then what the page sandbox cannot do. Ported from the earlier project's api/_lib/capture.ts
// (Node, WebSocket) and crates/fig-server/src/capture.rs (Rust; the layout probe, alt walks and variant menus the Node
// port lacked, W11), restructured around a `CaptureDriver` interface so another implementation can replace it.
//
// SSRF: every request the page makes is paused (`Fetch` domain) and only continues when its host passes the guard
// (guard.ts, decided once per host); workers and frames that attach are guarded before they run, popups are closed
// unseen. WebSockets and personalisation endpoints are blocked, downloads denied, service workers off. No cookies are
// brought in: every capture runs in a fresh Chrome profile that is deleted afterwards.
import {
  cssImports,
  dataUrl,
  decodeDataUrl,
  fontFaces,
  imageUses,
  latinRange,
  primaryLang,
} from "./assets.js";
import { cssFontWeight, retryWww, stripOnLoadOverlays, unifyAltImages, visit, wwwVariant } from "./assets.js";
import { findChrome, leaseChrome, type Cdp } from "./cdp.js";
import { DOM_CAPTURE_SOURCE, PERSONALIZATION_BLOCKLIST } from "./generated.js";
import {
  fetchPublic,
  GuardError,
  HostGuard,
  resolveChecked,
  validateUrl,
  type GuardOptions,
} from "./guard.js";
import {
  FRAME_CONSENT_JS,
  NO_DIALOGS_JS,
  NO_SERVICE_WORKERS_JS,
  SHRINK_JS,
  SOLO_JS,
  SPRITE_JS,
  DISMISS_OVERLAYS_JS,
} from "./inpage.js";
import { checkRobots } from "./robots.js";
import { fullPageShot, metricsOf, PAGE_FACTS_JS, SCROLL_THROUGH_JS, type Viewport } from "./shot.js";

/** Texts and overflow at `vp`, read before the shot pins the page. */
async function factsAt(
  cdp: Cdp,
  s: string,
  vp: Viewport,
  probe?: string,
): Promise<Pick<Shot, "texts" | "overflowPx" | "probe">> {
  await cdp.send("Emulation.setDeviceMetricsOverride", metricsOf(vp), s);
  // nothing focused, as for a visitor's first view (a consent click can leave focus on a skip link, which shows it)
  await cdp
    .eval(
      s,
      "(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); return true })()",
      5000,
    )
    .catch(() => null);
  await sleep(400);
  const f: Json = await cdp.eval(s, PAGE_FACTS_JS, 20_000).catch(() => null);
  const p = probe
    ? await cdp.eval(s, probe, 30_000).catch((e) => ({ error: (e as Error).message }))
    : undefined;
  return {
    texts: Array.isArray(f?.texts) ? f.texts : [],
    overflowPx: Number(f?.overflowPx) || 0,
    ...(probe ? { probe: p } : {}),
  };
}

type Json = any;

// ---------------------------------------------------------------------------------------------------- public types

/** Time and size budgets of one capture (config `recreate.budgets`; the earlier project's constants are the defaults). */
export interface CaptureBudgets {
  /** whole capture */
  totalMs: number;
  /** opening and walking the navigation menu */
  menuMs: number;
  /** the menu's next levels */
  submenuMs: number;
  /** submenu levels walked at most */
  submenus: number;
  /** widgets that change in place */
  regionMs: number;
  /** walks at the other widths of the layout range (from the capture's start) */
  altMs: number;
  /** raster boxes screenshotted at most */
  rasters: number;
}

export const DEFAULT_BUDGETS: CaptureBudgets = {
  totalMs: 200_000,
  menuMs: 25_000,
  submenuMs: 45_000,
  submenus: 3,
  regionMs: 70_000,
  altMs: 120_000,
  rasters: 80,
};

/** One capture session: the page loaded at `width`, walked again at `alt` widths; `menus` ⊆ alt get their own menu. */
export interface CaptureSessionPlan {
  width: number;
  alt?: number[];
  menus?: number[];
}

export interface CaptureOptions {
  height?: number;
  /** device pixel ratio for raster screenshots and the resolution images are kept at (1–3, default 2) */
  dpr?: number;
  /** Accept-Language of the visitor (default "en-US,en;q=0.9") */
  lang?: string;
  /** IANA time zone of the visitor */
  timezone?: string;
  budgets?: Partial<CaptureBudgets>;
  guard?: GuardOptions;
  /** refuse URLs robots.txt disallows for every crawler (default true) */
  respectRobots?: boolean;
  /** live reference shots at these widths, taken in a second tab of the same browser right after the capture */
  shotWidths?: number[];
  /** in-page expression evaluated before every live shot (its JSON result lands in `Shot.probe`) */
  shotProbe?: string;
  /** Chrome binary (default findChrome()) */
  chrome?: string;
  signal?: AbortSignal;
  /** progress lines (phase names with timings) */
  log?: (message: string) => void;
  /** the first screen, right after load and overlay dismissal (a JPEG to show while the capture runs) */
  onPeek?: (peek: Peek) => void;
  /** each live reference shot as soon as it is taken (the same shots come back in `CaptureResult.shots`) */
  onShot?: (shot: Shot) => void;
}

/** The visible screen of the live page right after load (JPEG, dpr 1): a preview while the capture runs. */
export interface Peek {
  width: number;
  height: number;
  jpeg: Buffer;
}

/** A full-page screenshot of the live page (or of an output) at one width, dpr 1. */
export interface Shot {
  width: number;
  height: number;
  png: Buffer;
  /** visible text blocks at this width (PAGE_FACTS_JS) */
  texts?: string[];
  /** px the page is wider than the viewport */
  overflowPx?: number;
  /** result of ShotOptions.probe at this width */
  probe?: Json;
}

export interface CaptureResult {
  /** the snapshot (importers/url/snapshot.ts shape: states, alt walks, assets, embedded fonts) */
  snapshot: Json;
  finalUrl: string;
  /** parts the budgets dropped ("alt walk 1180px", "submenus", "rasters beyond 80" …): resumable, reported */
  skipped: string[];
  shots: Shot[];
  ms: number;
}

/** One width where the page's layout switches (domCapture.js 'layout-diff' measures how much changed there). */
export interface LayoutSwitchFound {
  px: number;
  rules: number;
  source: "media" | "container" | "script";
  structural?: number;
  shifted?: number;
  tokens?: number;
  ns?: number;
  nj?: number;
  samples?: string[];
}

export interface LayoutProbe {
  url: string;
  breakpoints: LayoutSwitchFound[];
  samples: number;
  ms: number;
}

export interface ProbeOptions {
  width?: number;
  height?: number;
  lang?: string;
  timezone?: string;
  guard?: GuardOptions;
  respectRobots?: boolean;
  chrome?: string;
  signal?: AbortSignal;
  /** time for the script-switch bisection (default 35 s) */
  budgetMs?: number;
  /** the first screen, right after load (see CaptureOptions.onPeek) */
  onPeek?: (peek: Peek) => void;
}

export interface ShotOptions {
  height?: number;
  /** emulate phone / tablet below 1024 px like the capture (default true) */
  mobileBelow?: number;
  /** request guard; false loads the page unguarded (the recreated output, served from disk) */
  guard?: GuardOptions | false;
  chrome?: string;
  signal?: AbortSignal;
  /** in-page expression evaluated at every width before the shot (its JSON result lands in `Shot.probe`) */
  probe?: string;
}

export interface CaptureDriver {
  readonly id: string;
  probe(url: string, o?: ProbeOptions): Promise<LayoutProbe>;
  capture(url: string, plan: CaptureSessionPlan, o?: CaptureOptions): Promise<CaptureResult>;
  shoot(url: string, widths: number[], o?: ShotOptions): Promise<Shot[]>;
}

export class CaptureError extends Error {
  constructor(
    readonly code:
      | "browser_unavailable"
      | "invalid_url"
      | "blocked_address"
      | "robots"
      | "load_failed"
      | "capture_failed"
      | "cancelled",
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------- constants

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PHONE_MAX = 600;
const TABLET_MAX = 1024;
const CALL_TIMEOUT = 100_000;
const NAVIGATE_TIMEOUT = 45_000;
const CHILD_GUARD_TIMEOUT = 5_000;
const LOAD_TIMEOUT = 30_000;
const IDLE_QUIET = 500;
const IDLE_TIMEOUT = 15_000;
const STUCK_REQUEST = 6_000;
const REQUEST_TIMEOUT = 20_000;
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 300 * 1024 * 1024;
const MAX_ASSET_BYTES = 80 * 1024 * 1024;
const SHRINK_MIN_BYTES = 60_000;
const ALT_MENUS_EXTRA = 30_000;
const MAX_BRAND_SHEET = 3 * 1024 * 1024;
const MAX_BRAND_CSS = 8 * 1024 * 1024;
const FETCH_ALL = { patterns: [{ urlPattern: "*", requestStage: "Request" }] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** how far a reference shot scrolls the page first (lazy images, scroll-revealed content); the shot covers it all */
const SHOT_SCROLL_PX = 30_000;
/** `p`, or `undefined` once `ms` passed (p keeps running) */
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<undefined>((r) => {
      t = setTimeout(() => r(undefined), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(t));
};

type Device = "phone" | "tablet" | "desktop";
export const deviceOf = (width: number): Device =>
  width < PHONE_MAX ? "phone" : width < TABLET_MAX ? "tablet" : "desktop";
/** viewport height when none is given (Pixel 7 / iPad portrait; desktop as fig-server) */
export const deviceHeight = (d: Device) => (d === "phone" ? 844 : d === "tablet" ? 1024 : 1000);

/** The browser's own UA without the headless marker + matching client hints; phones / tablets as Chrome on Android. */
function userAgent(reported: string | undefined, device: Device): { ua: string; meta: Json } {
  const ua = reported?.includes("Chrome/") ? reported.replace("HeadlessChrome/", "Chrome/") : UA;
  const full = ua.split("Chrome/")[1]?.split(/\s/)[0] ?? "131.0.0.0";
  const major = full.split(".")[0] ?? "131";
  const brands = (v: string) => [
    { brand: "Chromium", version: v },
    { brand: "Google Chrome", version: v },
    { brand: "Not?A_Brand", version: "99" },
  ];
  if (device !== "desktop") {
    const phone = device === "phone";
    return {
      ua: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0${phone ? " Mobile" : ""} Safari/537.36`,
      meta: {
        brands: brands(major),
        fullVersionList: brands(full),
        fullVersion: full,
        platform: "Android",
        platformVersion: "14.0.0",
        architecture: "",
        model: phone ? "Pixel 7" : "SM-X710",
        mobile: phone,
        bitness: "",
      },
    };
  }
  const arch = process.arch === "arm64" ? "arm" : "x86";
  const platform =
    process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  return {
    ua,
    meta: {
      brands: brands(major),
      fullVersionList: brands(full),
      fullVersion: full,
      platform,
      platformVersion: "",
      architecture: arch,
      model: "",
      mobile: false,
      bitness: "64",
    },
  };
}

/** `(async function figCapture(opts) {…})(opts)` from the shared script (leading comments stripped). */
export function captureExpression(opts: Json): string {
  const script = DOM_CAPTURE_SOURCE;
  const start = Math.max(0, script.indexOf("(async function"));
  return `${script.slice(start).trimEnd().replace(/;+$/, "")}(${JSON.stringify(opts)})`;
}

// ---------------------------------------------------------------------------------------------------- network proxy

interface Resp {
  session: string;
  requestId: string;
  mime: string;
}

/** Request guard for the page + response bodies for the snapshot assets + network-idle tracking. */
class Proxy {
  private readonly responses = new Map<string, Resp>();
  private readonly started = new Map<string, string>();
  private readonly inflight = new Map<string, number>();
  private changed = Date.now();
  /** targets this capture created itself (every other new page is a popup and is closed) */
  readonly ownTargets = new Set<string>();
  /** Target.createTarget calls in flight: their auto-attach event can arrive before the call returns */
  creating = 0;
  /** sessions of out-of-process iframes (consent dialogs live there) */
  readonly frames: string[] = [];
  ua: { ua: string; meta: Json; lang: string } | null = null;

  constructor(readonly guard: HostGuard | null) {}

  allowed(raw: string): Promise<boolean> {
    return this.guard ? this.guard.allowed(raw) : Promise.resolve(true);
  }

  network(method: string, p: Json, sessionId: string | undefined) {
    const id: string | undefined = p?.requestId;
    if (!id) return;
    const key = `${sessionId ?? ""}|${id}`;
    switch (method) {
      case "Network.requestWillBeSent":
        // streamed media and long-lived connections never go idle
        if (!["Media", "EventSource", "WebSocket"].includes(p.type) && !this.inflight.has(key)) {
          this.inflight.set(key, Date.now());
          this.changed = Date.now();
        }
        if (p.request?.url && !this.started.has(key)) this.started.set(key, p.request.url);
        break;
      case "Network.responseReceived": {
        const url: string | undefined = p.response?.url;
        if (!url) return;
        const mime = String(p.response.mimeType ?? "").toLowerCase();
        if (
          ["Image", "Font", "Stylesheet"].includes(p.type) ||
          mime.startsWith("image/") ||
          mime.includes("font") ||
          mime === "text/css"
        ) {
          const r: Resp = { session: sessionId ?? "", requestId: id, mime };
          // <img src> keeps the URL before redirects (CDN image services redirect a lot)
          const first = this.started.get(key);
          if (first && first !== url) this.responses.set(first, r);
          this.responses.set(url, r);
        }
        break;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        if (this.inflight.delete(key)) this.changed = Date.now();
    }
  }

  /** Nothing started or finished for `quiet` and every open request hung for STUCK_REQUEST, at most `limit`. */
  async networkIdle(quiet: number, limit: number) {
    const end = Date.now() + limit;
    while (Date.now() < end) {
      await sleep(100);
      const now = Date.now();
      if (now - this.changed >= quiet && [...this.inflight.values()].every((t) => now - t >= STUCK_REQUEST))
        return;
    }
  }

  response(url: string) {
    return this.responses.get(url);
  }
}

/** Request guard + network settings of one page / frame / worker session. */
async function guardSession(cdp: Cdp, proxy: Proxy, s: string, frame: boolean, limit: number) {
  const call = (method: string, params: Json) => cdp.send(method, params, s, limit);
  await call("Network.enable", {
    maxTotalBufferSize: MAX_CAPTURE_BYTES,
    maxResourceBufferSize: MAX_RESPONSE_BYTES,
  });
  await call("Network.setBlockedURLs", { urls: ["ws://*", "wss://*", ...PERSONALIZATION_BLOCKLIST] });
  if (proxy.ua)
    await call("Network.setUserAgentOverride", {
      userAgent: proxy.ua.ua,
      acceptLanguage: proxy.ua.lang,
      platform: proxy.ua.meta.platform,
      userAgentMetadata: proxy.ua.meta,
    });
  if (proxy.guard) await call("Fetch.enable", FETCH_ALL);
  if (frame) {
    // the page's own CSP can refuse its own assets (www.example.com with `default-src 'self'` serving CSS from
    // example.com): the capture must see the page its authors designed, not an unstyled one. The request guard
    // above still decides what may load.
    await call("Page.setBypassCSP", { enabled: true }).catch(() => {});
    await call("Network.setBypassServiceWorker", { bypass: true });
    // no service workers: they would run outside the page's request guard
    await call("Page.addScriptToEvaluateOnNewDocument", { source: NO_SERVICE_WORKERS_JS }).catch(() => {});
    // nested out-of-process frames and workers start paused and are guarded the same way
    await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }
}

/** Every request the page makes is paused here: allowed http(s) targets continue, everything else is refused. */
async function handlePaused(cdp: Cdp, proxy: Proxy, p: Json, sessionId: string | undefined) {
  const url: string = p?.request?.url ?? "";
  const ok = /^https?:\/\//.test(url)
    ? await proxy.allowed(url)
    : url.startsWith("data:") || url.startsWith("blob:");
  const id = p?.requestId;
  await (
    ok
      ? cdp.send("Fetch.continueRequest", { requestId: id }, sessionId)
      : cdp.send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }, sessionId)
  ).catch(() => {});
}

/** Auto-attached targets: popups are closed unseen; frames and workers get the guard, then run. */
async function handleAttached(cdp: Cdp, proxy: Proxy, p: Json) {
  const child: string | undefined = p?.sessionId;
  if (!child) return;
  const target: string = p.targetInfo?.targetId ?? "";
  const type: string = p.targetInfo?.type ?? "";
  const waiting = p.waitingForDebugger === true;
  if (type === "page" || type === "tab") {
    if (waiting && !proxy.ownTargets.has(target) && proxy.creating === 0) {
      await cdp.send("Target.closeTarget", { targetId: target }).catch(() => {});
      return;
    }
  } else if (waiting) {
    const frame = type === "iframe";
    try {
      await guardSession(cdp, proxy, child, frame, CHILD_GUARD_TIMEOUT);
    } catch {
      // an iframe we cannot guard must not load anything
      if (frame) {
        await cdp.send("Target.closeTarget", { targetId: target }).catch(() => {});
        return;
      }
    }
    if (frame) proxy.frames.push(child);
  }
  if (waiting) await cdp.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
}

/** Body of `url`: inline `data:`, else as the page loaded it, else fetched with the pinned guarded client. */
async function bodyOf(
  cdp: Cdp,
  proxy: Proxy,
  url: string,
  referer: string,
  guard: GuardOptions,
): Promise<{ type: string; body: Buffer } | null> {
  if (url.startsWith("data:")) {
    const d = decodeDataUrl(url);
    return d && d.body.length <= MAX_RESPONSE_BYTES ? { type: d.mime, body: d.body } : null;
  }
  const r = proxy.response(url);
  if (r) {
    try {
      const b = await cdp.send("Network.getResponseBody", { requestId: r.requestId }, r.session || null);
      const body = b.base64Encoded ? Buffer.from(b.body ?? "", "base64") : Buffer.from(b.body ?? "");
      if (body.length) return { type: r.mime, body };
    } catch {
      /* evicted from Chrome's buffer: fetch it */
    }
  }
  if (!(await proxy.allowed(url))) return null;
  return fetchPublic(
    url,
    { "user-agent": proxy.ua?.ua ?? UA, referer, accept: "*/*" },
    MAX_RESPONSE_BYTES,
    REQUEST_TIMEOUT,
    guard,
  );
}

/** Click "accept" in every iframe (in-process ones through an isolated world, out-of-process in their session). */
async function consentInFrames(cdp: Cdp, proxy: Proxy, page: string): Promise<boolean> {
  let clicked = false;
  const tree: Json = await cdp.send("Page.getFrameTree", {}, page).catch(() => null);
  const frames: string[] = [];
  const stack: Json[] = [...(tree?.frameTree?.childFrames ?? [])];
  while (stack.length) {
    const f = stack.pop();
    if (f?.frame?.id) frames.push(f.frame.id);
    stack.push(...(f?.childFrames ?? []));
  }
  for (const id of frames.slice(0, 30)) {
    const world: Json = await cdp
      .send("Page.createIsolatedWorld", { frameId: id, worldName: "figcap" }, page)
      .catch(() => null);
    if (typeof world?.executionContextId !== "number") continue;
    const v = await cdp.eval(page, FRAME_CONSENT_JS, 3000, world.executionContextId).catch(() => false);
    if (v === true) clicked = true;
  }
  for (const f of [...proxy.frames]) {
    if ((await cdp.eval(f, FRAME_CONSENT_JS, 3000).catch(() => false)) === true) clicked = true;
  }
  return clicked;
}

// ---------------------------------------------------------------------------------------------------- browser setup

interface Opened {
  cdp: Cdp;
  proxy: Proxy;
  page: string;
  helper: string;
  metrics: Json;
  finalUrl: string;
  close(): Promise<void>;
  newPage(): Promise<string>;
}

/** The visible screen of session `s` as a JPEG at dpr 1, handed to `onPeek`; never fails the capture. */
async function peek(
  cdp: Cdp,
  s: string,
  vp: { width: number; height: number; dpr: number },
  onPeek?: (p: Peek) => void,
) {
  if (!onPeek) return;
  const { width, height } = vp;
  try {
    // the scroll position stays where it is: the clip is the visible screen
    const shot = await cdp.send(
      "Page.captureScreenshot",
      { format: "jpeg", quality: 70, clip: { x: 0, y: 0, width, height, scale: 1 / vp.dpr } },
      s,
      10_000,
    );
    if (shot?.data) onPeek({ width, height, jpeg: Buffer.from(shot.data, "base64") });
  } catch {
    /* a preview only */
  }
}

/** Lease Chrome, set up a guarded page emulating a visitor at `width`, load `url` (load + idle + consent). */
async function openPage(
  url: string,
  o: {
    width: number;
    height: number;
    dpr: number;
    lang: string;
    timezone?: string;
    guard: GuardOptions | false;
    chrome?: string;
    signal?: AbortSignal;
    mobileBelow?: number;
    log: (m: string) => void;
  },
): Promise<Opened> {
  const bin = o.chrome ?? findChrome();
  if (!bin)
    throw new CaptureError(
      "browser_unavailable",
      "No Chrome / Chromium found. Install Google Chrome or set HARNESS_CHROME to a Chromium binary.",
    );
  let browser: Awaited<ReturnType<typeof leaseChrome>>;
  try {
    // a warm browser from the pool when one is free (each open gets its own browser context)
    browser = await leaseChrome(bin, { signal: o.signal });
  } catch (e) {
    throw new CaptureError("browser_unavailable", `Chrome did not start: ${(e as Error).message}`);
  }
  const { cdp } = browser;
  const proxy = new Proxy(o.guard === false ? null : new HostGuard(o.guard));
  try {
    cdp.on((method, p, s) => {
      if (method === "Fetch.requestPaused") void handlePaused(cdp, proxy, p, s);
      else if (method === "Target.attachedToTarget") void handleAttached(cdp, proxy, p);
      else if (method === "Page.javascriptDialogOpening")
        void cdp.send("Page.handleJavaScriptDialog", { accept: true }, s).catch(() => {});
      else if (method.startsWith("Network.")) proxy.network(method, p, s);
    });
    const version = await cdp.send("Browser.getVersion").catch(() => ({}));
    const mobileBelow = o.mobileBelow ?? TABLET_MAX;
    const device = o.width < mobileBelow ? deviceOf(Math.min(o.width, TABLET_MAX - 1)) : "desktop";
    const mobile = device !== "desktop";
    proxy.ua = { ...userAgent(version?.userAgent, device), lang: o.lang };
    await cdp
      .send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: browser.contextId })
      .catch(() => {});
    const newTarget = async (background: boolean) => {
      proxy.creating++;
      const t = await cdp
        .send("Target.createTarget", { url: "about:blank", background, browserContextId: browser.contextId })
        .finally(() => proxy.creating--);
      if (!t?.targetId) throw new CaptureError("capture_failed", "no target");
      proxy.ownTargets.add(t.targetId);
      return t.targetId as string;
    };
    const attach = async (target: string) => {
      const a = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
      if (!a?.sessionId) throw new CaptureError("capture_failed", "no session");
      return a.sessionId as string;
    };
    const metrics: Json = { width: o.width, height: o.height, deviceScaleFactor: o.dpr, mobile };
    if (mobile)
      Object.assign(metrics, {
        screenWidth: o.width,
        screenHeight: o.height,
        screenOrientation: { type: "portraitPrimary", angle: 0 },
      });
    /** a guarded, emulated page (the capture's own tab, or the live-shot tab) */
    const setup = async (s: string) => {
      await guardSession(cdp, proxy, s, true, CALL_TIMEOUT);
      if (mobile)
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, s);
      await cdp.send("Emulation.setDeviceMetricsOverride", metrics, s);
      const locale = primaryLang(o.lang);
      if (locale)
        await cdp
          .send("Emulation.setLocaleOverride", { locale: locale.replace("-", "_") }, s)
          .catch(() => {});
      if (o.timezone)
        await cdp.send("Emulation.setTimezoneOverride", { timezoneId: o.timezone }, s).catch(() => {});
      // the site's default (light) scheme, whatever the machine's appearance
      await cdp
        .send(
          "Emulation.setEmulatedMedia",
          { features: [{ name: "prefers-color-scheme", value: "light" }] },
          s,
        )
        .catch(() => {});
      await cdp.send("Page.enable", {}, s);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: NO_DIALOGS_JS }, s).catch(() => {});
      await cdp.send("Page.bringToFront", {}, s).catch(() => {});
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, s).catch(() => {});
    };
    // the page must stay the visible tab: hidden pages throttle timers and pause rAF, lazy loading and video
    const helperTarget = await newTarget(true);
    const pageTarget = await newTarget(false);
    // every page opened from now on (popups) is attached paused, and closed
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const page = await attach(pageTarget);
    const helper = await attach(helperTarget);
    if (proxy.guard) await cdp.send("Fetch.enable", FETCH_ALL, helper);
    await setup(page);
    const finalUrl = await load(cdp, proxy, page, url, o.guard, o.log);
    return {
      cdp,
      proxy,
      page,
      helper,
      metrics,
      finalUrl,
      close: () => browser.close(),
      async newPage() {
        const s = await attach(await newTarget(false));
        await setup(s);
        return s;
      },
    };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

/** Navigate `s` to `url` (apex → `www.` retry), wait for load + network idle, accept consent dialogs in frames. */
async function load(
  cdp: Cdp,
  proxy: Proxy,
  s: string,
  url: string,
  guard: GuardOptions | false,
  log: (m: string) => void,
): Promise<string> {
  const navigate = async (u: string) => {
    try {
      return await cdp.send("Page.navigate", { url: u }, s, NAVIGATE_TIMEOUT);
    } catch {
      throw new CaptureError("load_failed", `${new URL(u).hostname || "the site"} did not respond`);
    }
  };
  let target = url;
  let loaded = cdp.waitFor("Page.loadEventFired", s, LOAD_TIMEOUT);
  let nav = await navigate(target);
  // apex hosts whose certificate Chrome rejects (or that do not answer) while `www.` works: try `www.` once
  const www =
    nav?.errorText && retryWww(nav.errorText) && guard !== false ? wwwVariant(new URL(target)) : null;
  if (www && guard !== false) {
    try {
      validateUrl(www.toString(), guard);
      await resolveChecked(www, guard);
      await sleep(200);
      loaded = cdp.waitFor("Page.loadEventFired", s, LOAD_TIMEOUT);
      const again = await navigate(www.toString());
      if (!again?.errorText) {
        nav = again;
        target = www.toString();
      }
    } catch {
      /* keep the first error */
    }
  }
  if (nav?.errorText) throw new CaptureError("load_failed", `could not load ${target}: ${nav.errorText}`);
  // load event (or give up waiting and capture what is there), then network idle
  await loaded;
  log("loaded");
  await proxy.networkIdle(IDLE_QUIET, IDLE_TIMEOUT);
  log("network idle");
  // consent dialogs in iframes (the capture script handles the page itself); a second round for two-step dialogs
  let clicked = false;
  for (let i = 0; i < 2; i++) {
    if (!(await consentInFrames(cdp, proxy, s))) break;
    clicked = true;
    await sleep(900);
  }
  if (clicked) {
    await sleep(1000);
    await proxy.networkIdle(IDLE_QUIET, 5000);
  }
  await sleep(300);
  // on-load overlays (region switchers, newsletter / app modals): dismissed as a visitor would, else hidden
  await cdp.eval(s, DISMISS_OVERLAYS_JS, 10_000).catch(() => 0);
  const href = await cdp.eval(s, "location.href", 5000).catch(() => target);
  return typeof href === "string" ? href : target;
}

async function preflight(
  url: string,
  guard: GuardOptions,
  respectRobots: boolean | undefined,
  ua?: string,
): Promise<string> {
  let u: URL;
  try {
    u = validateUrl(url, guard);
    await resolveChecked(u, guard);
  } catch (e) {
    if (e instanceof GuardError)
      throw new CaptureError(e.code === "unreachable" ? "load_failed" : e.code, e.message);
    throw e;
  }
  if (respectRobots !== false) {
    const r = await checkRobots(u.toString(), { ...guard, userAgent: ua });
    if (!r.allowed) throw new CaptureError("robots", `${u.toString()}: ${r.rule}`);
  }
  return u.toString();
}

// ---------------------------------------------------------------------------------------------------- the capture

class Session {
  readonly skipped: string[] = [];

  constructor(
    private readonly cdp: Cdp,
    private readonly proxy: Proxy,
    private readonly page: string,
    /** blank page for image re-encoding (its own origin, no page scripts) */
    private readonly helper: string,
    private readonly referer: string,
    private readonly dpr: number,
    private readonly guard: GuardOptions,
    private readonly budgets: CaptureBudgets,
  ) {}

  /** one capture-script step; undefined when it failed or the phase's budget (`until`) is spent */
  private step(opts: Json, ms: number, until: number): Promise<Json | undefined> {
    if (Date.now() >= until) return Promise.resolve(undefined);
    return this.cdp
      .eval(this.page, captureExpression(opts), Math.min(ms, until - Date.now()))
      .catch(() => undefined);
  }

  /** `<use href="/sprite.svg#icon">` → the symbol inlined (still a vector); what cannot be resolved is screenshotted. */
  async inlineSprites(snap: Json) {
    const items: Json[] = [];
    const files = new Set<string>();
    visit(snap.root, (n) => {
      if (!Array.isArray(n.svgExternal)) return;
      for (const r of n.svgExternal) if (typeof r === "string") files.add(r.split("#")[0]);
      if (typeof n.id === "number" && typeof n.svg === "string") items.push({ id: n.id, svg: n.svg });
    });
    if (!items.length) return;
    const texts: Record<string, string> = {};
    for (const f of files) {
      const b = await bodyOf(this.cdp, this.proxy, f, this.referer, this.guard);
      if (b) texts[f] = b.body.toString("utf8");
    }
    const inlined: Json =
      (await this.cdp
        .eval(this.page, `${SPRITE_JS}(${JSON.stringify(items)}, ${JSON.stringify(texts)})`, 20_000)
        .catch(() => null)) ?? {};
    visit(snap.root, (n) => {
      if (!("svgExternal" in n)) return;
      const svg = inlined[String(n.id ?? 0)];
      if (typeof svg === "string") n.svg = svg;
      else {
        n.kind = "raster";
        delete n.svg;
      }
      delete n.svgExternal;
    });
  }

  /**
   * W10: states the CSSOM scan could not reach (script-driven, inherited, covered) read from the browser itself: each
   * control's first instance is scrolled into view, its DOM node found at its centre, the pseudo-class forced over
   * CDP (`CSS.forcePseudoState`) and its computed look compared with the base look. At most 150 controls.
   */
  async forcedStates(snap: Json) {
    const controls: Json[] = Array.isArray(snap.brand?.controls) ? snap.brand.controls : [];
    const todo = controls
      .filter((c) => Array.isArray(c.unreached) && c.unreached.length && c.box)
      .slice(0, 150);
    if (!todo.length) return;
    const s = this.page;
    const ok = await Promise.all([
      this.cdp.send("DOM.enable", {}, s),
      this.cdp.send("CSS.enable", {}, s),
    ]).then(
      () => true,
      () => false,
    );
    if (!ok) return;
    await this.cdp.send("DOM.getDocument", { depth: 0 }, s).catch(() => null);
    const LOOK = String.raw`((x, y) => {
      const el = document.elementFromPoint(x, y)
      if (!el) return null
      const t = el.closest('a,button,[role=button],input,select,summary,label') || el
      const cs = getComputedStyle(t)
      return { backgroundColor: cs.backgroundColor, color: cs.color, borderColor: cs.borderTopColor, borderWidth: parseFloat(cs.borderTopWidth) || 0, outline: cs.outlineStyle === 'none' ? 'none' : cs.outlineWidth + ' ' + cs.outlineStyle + ' ' + cs.outlineColor, boxShadow: cs.boxShadow, textDecoration: (cs.textDecorationLine || 'none').split(' ')[0], opacity: Number(cs.opacity) }
    })`;
    let reached = 0;
    for (const c of todo) {
      const b = c.box;
      const top: number = await this.cdp
        .eval(
          s,
          `(() => { const y = ${Number(b.y) || 0}; window.scrollTo({ top: Math.max(0, y - innerHeight / 3), left: 0, behavior: 'instant' }); return scrollY })()`,
          5000,
        )
        .catch(() => 0);
      const x = (Number(b.x) || 0) + (Number(b.w) || 0) / 2,
        y = (Number(b.y) || 0) + (Number(b.h) || 0) / 2 - (Number(top) || 0);
      const loc = await this.cdp
        .send(
          "DOM.getNodeForLocation",
          { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false },
          s,
        )
        .catch(() => null);
      const nodeId =
        loc?.nodeId ??
        (loc?.backendNodeId
          ? (
              await this.cdp
                .send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [loc.backendNodeId] }, s)
                .catch(() => null)
            )?.nodeIds?.[0]
          : undefined);
      if (!nodeId) continue;
      const base = await this.cdp.eval(s, `${LOOK}(${x}, ${y})`, 5000).catch(() => null);
      if (!base) continue;
      const left: string[] = [];
      for (const state of c.unreached as string[]) {
        // hover: a real pointer over the control (its ancestors are hovered too, as for a visitor);
        // focus / active: the pseudo-class forced on its node
        const forced =
          state === "hover"
            ? await this.cdp
                .send(
                  "Input.dispatchMouseEvent",
                  { type: "mouseMoved", x: Math.round(x), y: Math.round(y) },
                  s,
                )
                .then(
                  () => true,
                  () => false,
                )
            : await this.cdp
                .send(
                  "CSS.forcePseudoState",
                  { nodeId, forcedPseudoClasses: [state === "focus" ? "focus-visible" : state] },
                  s,
                )
                .then(
                  () => true,
                  () => false,
                );
        if (!forced) {
          left.push(state);
          continue;
        }
        await sleep(state === "hover" ? 120 : 60);
        const now = await this.cdp.eval(s, `${LOOK}(${x}, ${y})`, 5000).catch(() => null);
        if (state === "hover")
          await this.cdp
            .send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 }, s)
            .catch(() => {});
        else
          await this.cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }, s).catch(() => {});
        const diff: Json = {};
        if (now) for (const k of Object.keys(now)) if (now[k] !== base[k]) diff[k] = now[k];
        if (Object.keys(diff).length) {
          c[state] = { ...(c[state] ?? {}), ...diff, forced: true };
          reached++;
        } else left.push(state);
      }
      if (left.length) c.unreached = left;
      else delete c.unreached;
    }
    await this.cdp.eval(s, "window.scrollTo({ top: 0, left: 0, behavior: 'instant' })", 5000).catch(() => {});
    if (reached) snap.brand.forcedStates = reached;
  }

  /** Raster boxes: each element screenshotted alone (those above `maxY` only, none that already have pixels). */
  async rasters(snap: Json, maxY?: number) {
    const ids: number[] = [];
    visit(snap.root, (n) => {
      if (n.kind === "raster" && !("src" in n) && (maxY === undefined || (Number(n.rect?.y) || 0) < maxY))
        ids.push(Number(n.id) || 0);
    });
    if (!ids.length) return;
    if (ids.length > this.budgets.rasters) this.skipped.push(`rasters beyond ${this.budgets.rasters}`);
    const s = this.page;
    await this.cdp.send(
      "Emulation.setDefaultBackgroundColorOverride",
      { color: { r: 0, g: 0, b: 0, a: 0 } },
      s,
    );
    const shots = new Map<number, string>();
    for (const id of ids.slice(0, this.budgets.rasters)) {
      const b: Json = await this.cdp.eval(s, `${SOLO_JS}(${id})`, 8000).catch(() => null);
      if (b && b.w >= 1 && b.h >= 1 && b.w * b.h < 8_000_000) {
        // inside the viewport when it fits: capturing beyond it resizes the viewport (vh boxes jump)
        const shot = await this.cdp
          .send(
            "Page.captureScreenshot",
            {
              format: "png",
              captureBeyondViewport: b.inView !== true,
              clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 },
            },
            s,
          )
          .catch(() => null);
        if (shot?.data) shots.set(id, `data:image/png;base64,${shot.data}`);
      }
      await this.cdp.eval(s, "document.getElementById('__figcap_solo')?.remove()", 5000).catch(() => {});
    }
    await this.cdp.send("Emulation.setDefaultBackgroundColorOverride", {}, s).catch(() => {});
    await this.cdp.eval(s, "window.scrollTo({ top: 0, left: 0, behavior: 'instant' })", 5000).catch(() => {});
    // big screenshots (video frames, embeds): WebP instead of PNG
    const big: [number, number, number][] = [];
    visit(snap.root, (n) => {
      const id = Number(n.id) || 0,
        w = Number(n.rect?.w) || 0,
        h = Number(n.rect?.h) || 0;
      if (shots.has(id) && w * h > 40_000) big.push([id, w, h]);
    });
    for (const [id, w, h] of big) {
      const png = shots.get(id)!.split(",")[1];
      const webp = await this.shrink(png, "image/png", w, h);
      if (webp && webp.length < png.length) shots.set(id, webp);
    }
    visit(snap.root, (n) => {
      const src = shots.get(Number(n.id));
      if (src === undefined) return;
      shots.delete(Number(n.id));
      n.src = src;
      delete n.svg;
      delete n.svgExternal;
    });
  }

  private resized(metrics: Json, w: number): Json {
    const m = { ...metrics, width: w };
    if ("screenWidth" in m) m.screenWidth = w;
    return m;
  }

  /**
   * The page walked again at other viewport widths of its layout range: the same DOM, so every box of such a walk
   * names the main walk's box it is (`base`). → snapshots holding the tree and page size only, each with `width`.
   */
  async altWalks(widths: number[], metrics: Json, height: number, until: number): Promise<Json[]> {
    const thaw = () => this.cdp.eval(this.page, captureExpression({ mode: "thaw" }), 8000).catch(() => null);
    const out: Json[] = [];
    for (const w of widths) {
      if (Date.now() > until) {
        this.skipped.push(`alt walk ${w}px`);
        continue;
      }
      await thaw();
      const ok = await this.cdp
        .send("Emulation.setDeviceMetricsOverride", this.resized(metrics, w), this.page)
        .then(
          () => true,
          () => false,
        );
      if (!ok) break;
      // resize handlers (sliders, JS layouts) settle
      await sleep(500);
      const walk: Json = await this.cdp
        .eval(this.page, captureExpression({ prepare: false, alt: true, viewportHeight: height }), 60_000)
        .catch(() => null);
      if (walk?.root && typeof walk.root === "object") {
        for (const k of ["marks", "controls", "fonts", "fontFaces", "sheets", "brand"]) delete walk[k];
        walk.width = w;
        await this.inlineSprites(walk);
        out.push(walk);
      } else this.skipped.push(`alt walk ${w}px (failed)`);
    }
    await thaw();
    await this.cdp.send("Emulation.setDeviceMetricsOverride", metrics, this.page).catch(() => {});
    await sleep(800);
    return out;
  }

  /** The navigation menu of each variant width as it opens there, its trigger named by its main-walk id. */
  async variantMenus(
    widths: number[],
    metrics: Json,
    height: number,
    until: number,
  ): Promise<[number, Json][]> {
    const out: [number, Json][] = [];
    await this.closeMenu();
    for (const w of widths) {
      if (Date.now() > until) {
        this.skipped.push(`menu at ${w}px`);
        continue;
      }
      await this.cdp.eval(this.page, captureExpression({ mode: "thaw" }), 8000).catch(() => null);
      const ok = await this.cdp
        .send("Emulation.setDeviceMetricsOverride", this.resized(metrics, w), this.page)
        .then(
          () => true,
          () => false,
        );
      if (!ok) break;
      await sleep(500);
      const walk: Json = await this.cdp
        .eval(
          this.page,
          captureExpression({ prepare: false, alt: true, viewportHeight: height, menu: true }),
          60_000,
        )
        .catch(() => null);
      const id = walk?.marks?.trigger;
      if (typeof id !== "number") continue;
      let base: number | undefined;
      visit(walk.root, (n) => {
        if (n.id === id) base = n.base;
      });
      const st = await this.menuState(walk, height, Math.min(until, Date.now() + this.budgets.menuMs));
      if (st && typeof base === "number") {
        st.trigger = base;
        delete st.subItems;
        out.push([w, st]);
      }
      if (!(await this.closeMenu())) {
        this.skipped.push(`menus after ${w}px (a menu stayed open)`);
        break;
      }
    }
    await this.cdp.send("Emulation.setDeviceMetricsOverride", metrics, this.page).catch(() => {});
    return out;
  }

  /** Close the open menu as a visitor does, then make sure (click, Escape) and drop its tags. false when it stays open. */
  async closeMenu(): Promise<boolean> {
    const first: Json = await this.cdp
      .eval(this.page, captureExpression({ mode: "menu-close" }), 8000)
      .catch(() => ({}));
    if (first?.ok === true) {
      await this.cdp
        .eval(this.page, captureExpression({ mode: "menu-close", finish: true }), 8000)
        .catch(() => null);
      return true;
    }
    if (typeof first?.x === "number" && typeof first?.y === "number") {
      await this.tap(first.x, first.y);
      await sleep(900);
    }
    const done: Json = await this.cdp
      .eval(this.page, captureExpression({ mode: "menu-close", finish: true }), 10_000)
      .catch(() => ({}));
    return done?.ok === true;
  }

  /** The navigation menu opened by a real tap (a click without touch), walked again with it open → a SnapState. */
  async menuState(snap: Json, height: number, until: number): Promise<Json | null> {
    const trigger = snap.marks?.trigger;
    if (typeof trigger !== "number") return null;
    const at = await this.step({ mode: "menu-open" }, 8000, until);
    if (!at) return null;
    let settled: Json = null;
    if (typeof at.x === "number" && typeof at.y === "number") {
      await this.tap(at.x, at.y);
      settled = await this.step({ mode: "menu-settle" }, 8000, until);
      if (settled === undefined) return null;
      if (settled?.ok !== true) {
        // the tap reached nothing that reacts to it (mouse-only handlers): a plain click on the element
        if ((await this.step({ mode: "menu-open", click: true }, 8000, until)) === undefined) return null;
        settled = await this.step({ mode: "menu-settle" }, 8000, until);
      }
    } else if (at.clicked === true) settled = await this.step({ mode: "menu-settle" }, 8000, until);
    if (settled?.ok !== true) return null;
    const walked = await this.scopedWalk(snap, height, until);
    if (!walked) return null;
    const { st, marks } = walked;
    const out: Json = { kind: "menu", trigger, snapshot: st, motion: settled.motion };
    if (snap.marks?.label != null) out.label = snap.marks.label;
    if (marks.panel != null) out.panel = marks.panel;
    if (marks.close != null) out.close = marks.close;
    const items = Array.from({ length: Number(settled.subs) || 0 }, (_, i) => marks[`sub${i}`] ?? null);
    if (items.length) out.subItems = items;
    return out;
  }

  /** The menu's next levels: each drill-down entry opened, walked, left again → SnapStates of kind 'submenu'. */
  async submenuStates(snap: Json, menu: Json, height: number, until: number, out: Json[]) {
    const items: Json[] = Array.isArray(menu.subItems) ? menu.subItems : [];
    const max = Math.min(items.length, this.budgets.submenus);
    if (items.length > max) this.skipped.push(`submenus beyond ${max}`);
    for (let i = 0; i < max; i++) {
      const opened = await this.step({ mode: "submenu-open", index: i }, 8000, until);
      if (opened === undefined) {
        this.skipped.push(`submenus from ${i + 1}`);
        break;
      }
      if (opened?.clicked !== true) continue;
      const settled = await this.step({ mode: "menu-settle" }, 8000, until);
      if (settled === undefined) break;
      if (settled?.ok === true && typeof items[i] === "number") {
        const walked = await this.scopedWalk(snap, height, until);
        if (walked) {
          const level: Json = {
            kind: "submenu",
            parent: 0,
            item: items[i],
            snapshot: walked.st,
            motion: settled.motion,
          };
          if (settled.label != null) level.label = settled.label;
          for (const k of ["panel", "close", "back"]) if (walked.marks[k] != null) level[k] = walked.marks[k];
          out.push(level);
        }
      }
      const back = await this.step({ mode: "submenu-back" }, 8000, until);
      if (back?.ok !== true) break;
    }
  }

  /** Widgets that change in place: each control clicked, its region walked, the page restored → 'region' states. */
  async regionStates(snap: Json, height: number, until: number, out: Json[]) {
    const n = Array.isArray(snap.controls) ? snap.controls.length : 0;
    for (let i = 0; i < n; i++) {
      const opened = await this.step({ mode: "state-open", index: i }, 8000, until);
      if (opened === undefined) {
        this.skipped.push(`widget states from ${i + 1} of ${n}`);
        break;
      }
      if (opened?.clicked !== true) continue;
      const settled = await this.step({ mode: "state-settle" }, 12_000, until);
      if (settled === undefined) break;
      if (settled?.ok === true && typeof settled.region === "number") {
        const walked = await this.scopedWalk(snap, height, until, "region");
        if (walked) {
          const state: Json = {
            kind: "region",
            index: i,
            region: settled.region,
            toggle: settled.kind === "toggle",
            snapshot: walked.st,
          };
          if (typeof settled.label === "string") state.label = settled.label;
          out.push(state);
        }
      }
      const r = await this.step({ mode: "state-restore", index: i }, 8000, until);
      // nothing changed in place and nothing to undo
      if (r?.ok !== true && settled?.ok === true) break;
    }
  }

  /** The page (or, `scope` 'region', the box a widget changed) walked again in an opened state, with its rasters. */
  async scopedWalk(
    snap: Json,
    height: number,
    until: number,
    scope?: string,
  ): Promise<{ st: Json; marks: Json } | null> {
    if (Date.now() >= until) return null;
    // whatever the open state loads (icons, teaser images), briefly
    await this.proxy.networkIdle(300, 1500);
    const st: Json = await this.cdp
      .eval(
        this.page,
        captureExpression({ prepare: false, state: true, viewportHeight: height, scope: scope ?? null }),
        Math.max(1000, Math.min(30_000, until - Date.now())),
      )
      .catch(() => null);
    if (!st || typeof st !== "object" || !st.root || st.url !== snap.url) return null;
    await this.inlineSprites(st);
    // raster boxes the state did not move keep the page's pixels; the rest within the opened viewport are shot
    const key = (n: Json) =>
      `${n.tag ?? ""}|${Math.round(Number(n.rect?.x) || 0)}|${Math.round(Number(n.rect?.y) || 0)}|${Math.round(Number(n.rect?.w) || 0)}|${Math.round(Number(n.rect?.h) || 0)}`;
    const shot = new Map<string, string>();
    visit(snap.root, (n) => {
      if (n.kind === "raster" && typeof n.src === "string") shot.set(key(n), n.src);
    });
    visit(st.root, (n) => {
      if (n.kind === "raster" && shot.has(key(n))) n.src = shot.get(key(n));
    });
    await this.rasters(st, height).catch(() => {});
    const marks = st.marks ?? {};
    delete st.marks;
    return { st, marks };
  }

  /** A finger tap at a viewport point (touch emulation is on for phones / tablets), else a mouse click. */
  async tap(x: number, y: number) {
    const touch = await this.cdp
      .send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }, this.page)
      .then(
        () => true,
        () => false,
      );
    if (touch) {
      await this.cdp
        .send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, this.page)
        .catch(() => {});
      return;
    }
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.cdp
        .send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, this.page)
        .catch(() => {});
    }
  }

  /** base64 image → WebP data URL at (w × h CSS px) × dpr, never upscaled. */
  async shrink(b64: string, mime: string, w: number, h: number): Promise<string | null> {
    const v = await this.cdp
      .eval(
        this.helper,
        `${SHRINK_JS}(${JSON.stringify(b64)}, ${JSON.stringify(mime)}, ${Math.ceil(w * this.dpr)}, ${Math.ceil(h * this.dpr)})`,
        20_000,
      )
      .catch(() => null);
    return typeof v === "string" && v.startsWith("data:image/webp;base64,") ? v : null;
  }

  /** Every image URL the snapshot (its states and alt walks) draws → data URL, photos re-encoded at display size × dpr. */
  async assets(snap: Json): Promise<Record<string, string>> {
    const uses = new Map<string, [number, number]>();
    imageUses(snap, uses);
    for (const st of Array.isArray(snap.states) ? snap.states : []) imageUses(st.snapshot, uses);
    for (const a of Array.isArray(snap.alt) ? snap.alt : []) {
      imageUses(a, uses);
      if (a.menuState?.snapshot) imageUses(a.menuState.snapshot, uses);
    }
    const list = [...uses].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const encoded: (string | null)[] = new Array(list.length).fill(null);
    let next = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (next < list.length) {
          const i = next++;
          const [u, [w, h]] = list[i];
          encoded[i] = await this.imageData(u, w, h).catch(() => null);
        }
      }),
    );
    const out: Record<string, string> = {};
    let total = 0;
    list.forEach(([u], i) => {
      const d = encoded[i];
      if (!d) return;
      if (total + d.length > MAX_ASSET_BYTES) {
        this.skipped.push(`image ${u.slice(0, 120)} (asset budget)`);
        return;
      }
      total += d.length;
      out[u] = d;
    });
    return out;
  }

  async imageData(u: string, w: number, h: number): Promise<string | null> {
    const b = await bodyOf(this.cdp, this.proxy, u, this.referer, this.guard);
    if (!b) return null;
    const d = dataUrl(b.type, b.body);
    if (!d.startsWith("data:image/")) return null;
    const mime = d.slice(5, d.indexOf(";"));
    if (
      b.body.length >= SHRINK_MIN_BYTES &&
      ["image/jpeg", "image/png", "image/webp", "image/avif"].includes(mime) &&
      w >= 1 &&
      h >= 1
    ) {
      const small = await this.shrink(d.slice(d.indexOf(",") + 1), mime, w, h);
      if (small && small.length < d.length) return small;
    }
    return d;
  }

  /** Text of the cross-origin sheets the brand extras need (`opts.css` of the capture script). */
  async brandCss(sheets: string[]): Promise<{ href: string; text: string }[]> {
    let left = MAX_BRAND_CSS;
    const out: { href: string; text: string }[] = [];
    const list = [...new Set(sheets)];
    const direct = list.length;
    for (let i = 0; i < list.length && i < 60; i++) {
      const b = await bodyOf(this.cdp, this.proxy, list[i], this.referer, this.guard);
      if (!b) continue;
      const text = b.body.toString("utf8");
      if (i < direct) list.push(...cssImports(text, list[i]).filter((u) => !list.includes(u)));
      if (text.length > MAX_BRAND_SHEET || text.length > left) continue;
      left -= text.length;
      out.push({ href: list[i], text });
    }
    return out;
  }

  /** Webfont faces of the families the page (and its states) draws text with, embedded as data URLs. */
  async fonts(snap: Json): Promise<Json[]> {
    const snaps: Json[] = [
      snap,
      ...(Array.isArray(snap.states) ? snap.states.map((st: Json) => st.snapshot) : []),
    ];
    const list = (k: string): Json[] => snaps.flatMap((s) => (Array.isArray(s?.[k]) ? s[k] : []));
    const used = new Set(
      list("fonts")
        .map((f) => String(f?.family ?? "").toLowerCase())
        .filter(Boolean),
    );
    const faces: Json[] = [...list("fontFaces")];
    // cross-origin sheets (and the sheets they @import, one level)
    const sheets: string[] = [...new Set(list("sheets").filter((v): v is string => typeof v === "string"))];
    const direct = sheets.length;
    const seen = new Set<string>();
    for (let i = 0; i < sheets.length && i < 60; i++) {
      const href = sheets[i];
      if (seen.has(href)) continue;
      seen.add(href);
      const b = await bodyOf(this.cdp, this.proxy, href, this.referer, this.guard);
      if (!b) continue;
      const css = b.body.toString("utf8");
      faces.push(...fontFaces(css, href));
      if (i < direct) sheets.push(...cssImports(css, href));
    }
    const rank = (f: unknown) =>
      (({ woff2: 0, woff: 1, truetype: 2, opentype: 3 }) as Record<string, number>)[String(f)] ?? 5;
    const out: Json[] = [];
    const done = new Set<string>();
    for (const face of faces) {
      const family = String(face?.family ?? "");
      if (!used.has(family.toLowerCase())) continue;
      const range: string | null = typeof face.unicodeRange === "string" ? face.unicodeRange : null;
      if (range && !latinRange(range)) continue;
      const key = `${family}|${JSON.stringify(face.weight)}|${JSON.stringify(face.style)}|${range ?? ""}`;
      if (done.has(key)) continue;
      done.add(key);
      const srcs: Json[] = (Array.isArray(face.src) ? [...face.src] : []).sort(
        (a, b) => rank(a?.format) - rank(b?.format),
      );
      // first source that loads and really is a font
      let got: { url: string; d: string } | null = null;
      for (const src of srcs) {
        if (typeof src?.url !== "string") continue;
        const b = await bodyOf(this.cdp, this.proxy, src.url, this.referer, this.guard);
        if (!b) continue;
        const d = dataUrl(b.type, b.body);
        if (d.startsWith("data:font/")) {
          got = { url: src.url, d };
          break;
        }
      }
      if (!got) continue;
      let file: string | null = null;
      if (!got.url.startsWith("data:")) {
        try {
          file = new URL(got.url).pathname.split("/").pop() ?? null;
        } catch {
          /* keep null */
        }
      }
      out.push({
        family,
        weight: (typeof face.weight === "string" ? cssFontWeight(face.weight) : null) ?? "400",
        style: typeof face.style === "string" ? face.style : "normal",
        unicodeRange: range,
        stretch: typeof face.stretch === "string" ? face.stretch : null,
        src: got.d,
        file,
        sourceUrl: got.url.startsWith("data:") ? null : got.url,
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------- driver

/** The bundled driver: local Chrome over CDP on a pipe. */
export class CdpCaptureDriver implements CaptureDriver {
  readonly id = "cdp";

  async capture(url: string, plan: CaptureSessionPlan, o: CaptureOptions = {}): Promise<CaptureResult> {
    const t0 = Date.now();
    const log = (m: string) => o.log?.(`${m} (${Date.now() - t0} ms)`);
    const budgets = { ...DEFAULT_BUDGETS, ...o.budgets };
    const guard = o.guard ?? {};
    const width = Math.round(Math.max(320, Math.min(2560, plan.width)));
    const height = o.height ?? deviceHeight(deviceOf(width));
    const dpr = Math.max(1, Math.min(3, o.dpr ?? 2));
    const lang = o.lang ?? "en-US,en;q=0.9";
    const alt = [...new Set((plan.alt ?? []).map((w) => Math.max(320, Math.min(2560, Math.round(w)))))]
      .filter((w) => w !== width)
      .slice(0, 24);
    const menus = (plan.menus ?? []).filter((w) => alt.includes(w)).slice(0, 8);
    const target = await preflight(url, guard, o.respectRobots);
    const until = t0 + budgets.totalMs;
    const opened = await openPage(target, {
      width,
      height,
      dpr,
      lang,
      timezone: o.timezone,
      guard,
      chrome: o.chrome,
      signal: o.signal,
      log,
    });
    const { cdp, proxy, page, helper, metrics } = opened;
    const cancelled = () => {
      if (o.signal?.aborted) throw new CaptureError("cancelled", "Capture cancelled.");
    };
    try {
      cancelled();
      // the brand extras read the page's cross-origin sheets too: listed by the script, their text passed back in
      const listed: Json = await cdp
        .eval(page, captureExpression({ mode: "sheets" }), 10_000)
        .catch(() => ({}));
      const pre = new Session(cdp, proxy, page, helper, opened.finalUrl, dpr, guard, budgets);
      const css = await pre.brandCss(Array.isArray(listed?.sheets) ? listed.sheets : []);
      log("sheets");
      // overlays that came late (a geo lookup after load): dismissed again right before the walk
      const lateOverlays = Number(await cdp.eval(page, DISMISS_OVERLAYS_JS, 10_000).catch(() => 0)) || 0;
      await peek(cdp, page, { width, height, dpr }, o.onPeek);
      let snap: Json;
      try {
        snap = await cdp.eval(
          page,
          captureExpression({
            viewportHeight: height,
            menu: true,
            states: true,
            brand: true,
            requested: target,
            css,
          }),
          90_000,
        );
      } catch (e) {
        throw new CaptureError("capture_failed", `capture script failed: ${(e as Error).message}`);
      }
      if (!snap || typeof snap !== "object" || !snap.root)
        throw new CaptureError("capture_failed", "the page produced no snapshot");
      if (lateOverlays) snap.dismissedOverlays = lateOverlays;
      log("snapshot");
      cancelled();
      const sx = new Session(
        cdp,
        proxy,
        page,
        helper,
        typeof snap.url === "string" ? snap.url : opened.finalUrl,
        dpr,
        guard,
        budgets,
      );
      await sx.inlineSprites(snap);
      await sx.rasters(snap);
      log("rasters");
      await sx.forcedStates(snap).catch(() => {});
      log("forced states");
      // the same page at the other widths of its layout range (before any state opens): geometry only
      const alts = alt.length
        ? await sx.altWalks(alt, metrics, height, Math.min(until, t0 + budgets.altMs))
        : [];
      if (alt.length) log("alt walks");
      cancelled();
      // widgets that change in place (filters, tabs, expanding cards, accordions), before the menu opens
      const widgetStates: Json[] = [];
      if (Array.isArray(snap.controls) && snap.controls.length) {
        await sx.regionStates(snap, height, Math.min(until, Date.now() + budgets.regionMs), widgetStates);
        log("widget states");
      }
      if (typeof snap.marks?.trigger === "number") {
        const st = await sx.menuState(snap, height, Math.min(until, Date.now() + budgets.menuMs));
        if (st) {
          const states: Json[] = [];
          if (Array.isArray(st.subItems)) {
            const levels: Json[] = [];
            await sx.submenuStates(snap, st, height, Math.min(until, Date.now() + budgets.submenuMs), levels);
            states.push(...levels);
            delete st.subItems;
          }
          snap.states = [st, ...states];
        } else sx.skipped.push("menu (the toggle opened nothing in time)");
        log("menu state");
      }
      // the other variants' own menus, last (a menu that stays open spoils nothing that comes after)
      if (menus.length) {
        for (const [w, st] of await sx.variantMenus(
          menus,
          metrics,
          height,
          Math.min(until, t0 + budgets.altMs + ALT_MENUS_EXTRA),
        )) {
          const a = alts.find((x) => x.width === w);
          if (a) a.menuState = st;
        }
        log("variant menus");
      }
      if (widgetStates.length) snap.states = [...(snap.states ?? []), ...widgetStates];
      delete snap.marks;
      if (alts.length) {
        snap.alt = alts;
        unifyAltImages(snap);
      }
      // a modal the dismissal missed never reaches the recreation (the walk at load and its alt walks only)
      const stripped = stripOnLoadOverlays(snap, height);
      if (stripped) {
        snap.strippedOverlays = stripped;
        sx.skipped.push(`${stripped} on-load overlay(s) left out of the recreation`);
      }
      cancelled();
      snap.assets = await sx.assets(snap);
      log("images");
      snap.embeddedFonts = await sx.fonts(snap);
      log("fonts");
      // live reference shots: a fresh tab in the same browser (warm cache, same consent), right after the capture
      const shots: Shot[] = [];
      if (o.shotWidths?.length) {
        try {
          const s = await opened.newPage();
          // every width on a freshly loaded page: a shot pins box sizes inline, which must not leak into the next width.
          // The first load is the full one (consent in frames, overlays); later widths reload on the warm cache with a
          // short idle wait — consent is a cookie by then.
          for (const [k, w] of o.shotWidths.entries()) {
            cancelled();
            const vp: Viewport = { width: w, height: deviceHeight(deviceOf(w)), mobile: w < TABLET_MAX };
            try {
              await cdp.send("Emulation.setDeviceMetricsOverride", metricsOf(vp), s);
              if (k === 0) await load(cdp, proxy, s, opened.finalUrl, guard, () => {});
              else {
                const loaded = cdp.waitFor("Page.loadEventFired", s, LOAD_TIMEOUT);
                await cdp.send("Page.reload", { ignoreCache: false }, s);
                await loaded;
                await proxy.networkIdle(IDLE_QUIET, 5_000);
                await cdp.eval(s, DISMISS_OVERLAYS_JS, 10_000).catch(() => 0);
              }
              await cdp.eval(s, captureExpression({ mode: "consent" }), 10_000).catch(() => null);
              await cdp.eval(s, `${SCROLL_THROUGH_JS}(${SHOT_SCROLL_PX})`, 60_000).catch(() => null);
              await cdp.eval(s, DISMISS_OVERLAYS_JS, 10_000).catch(() => 0);
              await cdp.eval(s, captureExpression({ mode: "freeze" }), 10_000).catch(() => null);
              const facts = await factsAt(cdp, s, vp, o.shotProbe);
              const png = await fullPageShot(cdp, s, vp);
              const shot: Shot = { width: w, height: png.readUInt32BE(20), png, ...facts };
              shots.push(shot);
              try {
                o.onShot?.(shot);
              } catch {
                /* a listener never fails the capture */
              }
            } catch (e) {
              if (e instanceof CaptureError && e.code === "cancelled") throw e;
              sx.skipped.push(`live shot ${w}px (${(e as Error).message})`);
            }
          }
          log("live shots");
        } catch (e) {
          if (e instanceof CaptureError && e.code === "cancelled") throw e;
          sx.skipped.push(`live shots (${(e as Error).message})`);
        }
      }
      return {
        snapshot: snap,
        finalUrl: typeof snap.url === "string" ? snap.url : opened.finalUrl,
        skipped: [...pre.skipped, ...sx.skipped],
        shots,
        ms: Date.now() - t0,
      };
    } finally {
      await opened.close();
    }
  }

  async probe(url: string, o: ProbeOptions = {}): Promise<LayoutProbe> {
    const t0 = Date.now();
    const guard = o.guard ?? {};
    const width = o.width ?? 1440;
    const height = o.height ?? deviceHeight("desktop");
    const target = await preflight(url, guard, o.respectRobots);
    const opened = await openPage(target, {
      width,
      height,
      dpr: 1,
      lang: o.lang ?? "en-US,en;q=0.9",
      timezone: o.timezone,
      guard,
      chrome: o.chrome,
      signal: o.signal,
      log: () => {},
    });
    try {
      await peek(opened.cdp, opened.page, { width, height, dpr: 1 }, o.onPeek);
      return await layoutProbe(opened.cdp, opened.page, opened.metrics, o.budgetMs ?? 35_000, t0);
    } finally {
      await opened.close();
    }
  }

  async shoot(url: string, widths: number[], o: ShotOptions = {}): Promise<Shot[]> {
    const guard = o.guard === undefined ? {} : o.guard;
    const mobileBelow = o.mobileBelow ?? TABLET_MAX;
    const first = widths[0] ?? 1440;
    const opened = await openPage(url, {
      width: first,
      height: o.height ?? deviceHeight(deviceOf(first)),
      dpr: 1,
      lang: "en-US,en;q=0.9",
      guard,
      chrome: o.chrome,
      signal: o.signal,
      mobileBelow,
      log: () => {},
    });
    try {
      const { cdp, page } = opened;
      const out: Shot[] = [];
      for (const [i, w] of widths.entries()) {
        if (o.signal?.aborted) throw new CaptureError("cancelled", "Cancelled.");
        const vp: Viewport = {
          width: w,
          height: o.height ?? deviceHeight(deviceOf(w)),
          mobile: w < mobileBelow,
        };
        // every width on a freshly loaded page (a shot pins box sizes inline)
        await cdp.send("Emulation.setDeviceMetricsOverride", metricsOf(vp), page);
        if (i > 0) {
          const loaded = cdp.waitFor("Page.loadEventFired", page, LOAD_TIMEOUT);
          await cdp.send("Page.reload", { ignoreCache: false }, page);
          await loaded;
          await opened.proxy.networkIdle(IDLE_QUIET, 5_000);
        }
        await cdp.eval(page, `${SCROLL_THROUGH_JS}(30000)`, 60_000).catch(() => null);
        const facts = await factsAt(cdp, page, vp, o.probe);
        const png = await fullPageShot(cdp, page, vp);
        out.push({ width: w, height: png.readUInt32BE(20), png, ...facts });
      }
      return out;
    } finally {
      await opened.close();
    }
  }
}

/**
 * The page's layout ranges at desktop device: every `@media` width switch of its style sheets, every width where a
 * size container crosses one of its `@container` conditions, and widths a script switches at (the page's structure
 * sampled every 64 px, every change bisected to the px). Each switch with how much changed there and its `source`.
 */
async function layoutProbe(
  cdp: Cdp,
  s: string,
  metrics: Json,
  budgetMs: number,
  t0: number,
): Promise<LayoutProbe> {
  const STEP = 64;
  const evalOpts = (opts: Json) => cdp.eval(s, captureExpression(opts), 20_000).catch(() => null);
  // the page as a visitor sees it: consent banner gone, hints that pop up after a moment there; nothing animating
  await evalOpts({ mode: "consent" });
  await sleep(1500);
  await evalOpts({ mode: "freeze" });
  const found: Json = (await evalOpts({ mode: "breakpoints" })) ?? {};
  let list: [number, number, LayoutSwitchFound["source"]][] = (
    Array.isArray(found.breakpoints) ? found.breakpoints : []
  )
    .filter((b: Json) => typeof b?.px === "number")
    .map((b: Json) => [Math.round(b.px), Number(b.rules) || 0, "media"] as [number, number, "media"])
    .filter(([px]: [number]) => px >= 321 && px <= 2560);
  // the switches with the most rules when a site has very many
  if (list.length > 30)
    list = list
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .sort((a, b) => a[0] - b[0]);
  const hashes = new Map<number, string>();
  const full = new Set<number>();
  const sample = async (w: number, all: boolean, settle: boolean) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...metrics, width: w }, s).catch(() => {});
    await sleep(220);
    const read = async () => {
      const v: Json = await cdp
        .eval(s, captureExpression({ mode: "layout-sig", key: String(w), tokensOnly: !all }), 20_000)
        .catch(() => null);
      return typeof v?.hash === "string" ? v.hash : "";
    };
    let h = await read();
    // scripts that switch on a debounced resize handler need a moment more: read again until two reads agree
    if (settle)
      for (let i = 0; i < 3; i++) {
        await sleep(300);
        const again = await read();
        if (again === h) break;
        h = again;
      }
    return h;
  };
  // two samples at the start width a moment apart: what changes by itself (animations, tickers) is noise
  await evalOpts({ mode: "layout-sig", key: "noise-a" });
  await sleep(400);
  await evalOpts({ mode: "layout-sig", key: "noise-b" });
  for (const [px] of list)
    for (const w of [px - 1, px])
      if (!full.has(w)) {
        full.add(w);
        hashes.set(w, await sample(w, true, false));
      }
  for (const w of [360, 480, 768, 1024, 1440, 1920])
    if (!full.has(w)) {
      full.add(w);
      hashes.set(w, await sample(w, true, false));
    }
  const cont: Json = (await evalOpts({ mode: "container-switches" })) ?? {};
  for (const v of Array.isArray(cont.widths) ? cont.widths : []) {
    const px = Math.round(Number(v));
    if (!(px >= 321 && px <= 2560) || list.some((b) => Math.abs(b[0] - px) <= 1)) continue;
    for (const w of [px - 1, px])
      if (!full.has(w)) {
        full.add(w);
        hashes.set(w, await sample(w, true, false));
      }
    list.push([px, 0, "container"]);
  }
  // script switches: the structure sampled on a grid, every change bisected to the px
  for (let w = 320; w <= 1920; w += STEP) if (!hashes.has(w)) hashes.set(w, await sample(w, false, true));
  const ordered = () => [...hashes.entries()].sort((a, b) => a[0] - b[0]);
  const todo: [number, number][] = [];
  const os = ordered();
  for (let i = 1; i < os.length; i++)
    if (os[i - 1][1] !== os[i][1] && os[i][0] - os[i - 1][0] > 1) todo.push([os[i - 1][0], os[i][0]]);
  const js: number[] = [];
  while (todo.length) {
    if (Date.now() - t0 > budgetMs) break;
    const [lo, hi] = todo.pop()!;
    const hl = hashes.get(lo)!,
      hh = hashes.get(hi)!;
    if (hl === hh) continue;
    if (hi - lo <= 1) {
      js.push(hi);
      continue;
    }
    const mid = lo + Math.floor((hi - lo) / 2);
    const h = await sample(mid, false, true);
    hashes.set(mid, h);
    if (h !== hl) todo.push([lo, mid]);
    if (h !== hh) todo.push([mid, hi]);
  }
  for (const px of js.sort((a, b) => a - b)) {
    if (list.some((b) => Math.abs(b[0] - px) <= 1)) continue;
    for (const w of [px - 1, px]) {
      await sample(w, true, true);
      full.add(w);
    }
    list.push([px, 0, "script"]);
  }
  list.sort((a, b) => a[0] - b[0]);
  const diff: Json =
    (await evalOpts({
      mode: "layout-diff",
      pairs: list.map(([px]) => [String(px - 1), String(px)]),
      noise: ["noise-a", "noise-b"],
    })) ?? {};
  const measured: Json[] = Array.isArray(diff.pairs) ? diff.pairs : [];
  const breakpoints: LayoutSwitchFound[] = list.map(([px, rules, source], i) => {
    const b: LayoutSwitchFound = { px, rules, source };
    const d = measured[i];
    if (d && typeof d === "object") {
      for (const k of ["structural", "shifted", "tokens", "ns", "nj"] as const)
        if (typeof d[k] === "number") b[k] = d[k];
      if (Array.isArray(d.samples)) b.samples = d.samples.map(String);
    }
    return b;
  });
  const sheets: Json = (await evalOpts({ mode: "sheets" })) ?? {};
  return {
    url: typeof sheets.url === "string" ? sheets.url : "",
    breakpoints,
    samples: hashes.size,
    ms: Date.now() - t0,
  };
}
