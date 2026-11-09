/**
 * Playwright crawl (MIGRATION_PLAN.md §5.1 #5, §7.1 step 1).
 *
 * Per URL: redirect chain + raw response HTML (Node fetch, manual redirects), rendered DOM, one full-page
 * screenshot per viewport (masked selectors hidden, animations disabled, fonts + lazy images loaded,
 * network idle), computed-style snapshot per viewport, network log, same-origin assets downloaded.
 *
 * Writes (workspace-relative):
 *   raw/html/crawl.json                  CrawlIndex
 *   raw/html/pages/<safeId>.json         PageManifest   (+ .raw.html, .rendered.html)
 *   raw/html/assets/<url path>           downloaded images, css, fonts, js
 *   raw/html/assets.json                 AssetRecord[]
 *   raw/html/links.json                  probed internal links (redirect targets, statuses)
 *   design/screenshots/<viewport>/<safeId(path)>.png
 */
import { guardContext, guardedFetch, launchChromium } from "@harness/mirror-core";
import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import { DEFAULT_VIEWPORTS, safeId, type Issue, type StepContext } from "@harness/mirror-core";
import { SETTLE_JS, evalCollect } from "./browser.js";
import { exerciseInteractions, type ViewportInteractions } from "./interactions.js";
import { attr, parseDocument, pathOf, selectAll } from "./dom.js";

export interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

export interface CrawlOptions {
  /** paths or absolute URLs; default site.urls */
  urls?: string[];
  /** follow sitemap.xml + menu links (default site.crawl.follow) */
  follow?: boolean;
  maxPages?: number;
  viewports?: ViewportSpec[];
  /** extra selectors hidden in screenshots (merged with site.crawl.mask and DEFAULT_MASK) */
  mask?: string[];
  /** default true */
  screenshots?: boolean;
  /** open header/nav toggles per viewport: lazy menu code is captured, changes recorded (default true) */
  interactions?: boolean;
  /** abort requests to other origins (analytics, CDNs) for determinism/offline (default true) */
  blockThirdParty?: boolean;
  /** download same-origin images/css/fonts/js (default true) */
  assets?: boolean;
  /** resolve internal links that were not crawled (redirects like /node/2) (default true) */
  probeLinks?: boolean;
  /** max links probed (default 150); only content links (inside <main>) and /node/N-style system paths are probed */
  maxLinkProbes?: number;
  /** inject a browser (tests); otherwise chromium.launch() */
  browser?: Browser;
}

export interface RedirectHop {
  url: string;
  status: number;
  location?: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  mime?: string;
  bytes?: number;
  thirdParty: boolean;
  blocked?: boolean;
  failure?: string;
}

export interface StyleSnapshot {
  viewport: { width: number; height: number };
  documentHeight: number;
  elements: { key: string; selector: string; tag: string; classes: string[]; rect: { x: number; y: number; width: number; height: number }; styles: Record<string, string> }[];
  histograms: Record<string, Record<string, number>>;
  cssVariables: Record<string, string>;
  mediaQueries: string[];
  stylesheets: { href: string | null; media: string; rules: number }[];
  fonts: { family: string; weight: string; style: string; status: string }[];
}

export interface PageManifest {
  id: string; // safeId(path)
  path: string; // final path
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirectChain: RedirectHop[];
  contentType?: string;
  lang?: string;
  title?: string;
  bodyClasses: string[];
  files: { raw: string; rendered: string };
  screenshots: Record<string, string>; // viewport -> workspace-relative png
  /** viewport -> header/nav toggles opened during the crawl and what each changed (interactions.ts) */
  interactions?: Record<string, ViewportInteractions>;
  styles: Record<string, StyleSnapshot>;
  images: { src: string; naturalWidth: number; naturalHeight: number; alt: string }[];
  network: NetworkEntry[];
  links: string[]; // internal paths linked from the page (rendered DOM)
  /** internal links inside <main> of the raw HTML + /node/N-style system paths anywhere (probed for redirects) */
  contentLinks?: string[];
  hreflang: { locale: string; href: string }[];
}

export interface AssetRecord {
  url: string; // absolute URL as requested (incl. query)
  path: string; // URL path (originalPath)
  file: string; // workspace-relative file under raw/html/assets/
  kind: "image" | "stylesheet" | "font" | "script" | "other";
  mime: string;
  size: number;
  sha256: string;
  referencedBy: string[]; // page paths
}

export interface LinkProbe {
  path: string;
  status: number;
  /** answered by a capture replay (a 404 means "not captured", not "broken on the live site") */
  replay?: boolean;
  finalPath?: string;
  chain: RedirectHop[];
}

export interface CrawlIndex {
  baseUrl: string;
  viewports: ViewportSpec[];
  mask: string[];
  pages: { path: string; id: string; status: number; manifest: string; requested: string[] }[];
  redirects: { from: string; to: string; status: number }[];
  failed: { url: string; error: string }[];
  sitemap?: string[];
  /** original origin when the base URL is a capture replay (GET /__replay/status), e.g. https://www.nestle.com */
  origin?: string;
}

export interface CrawlResult {
  index: CrawlIndex;
  pages: PageManifest[];
  assets: AssetRecord[];
  links: Record<string, LinkProbe>;
  issues: Issue[];
  outputs: string[];
}

/** Well-known consent/cookie banners, always hidden in baseline screenshots. */
/**
 * Consent-manager overlays (fixed position: hiding them does not change layout). With a live site's third parties
 * loading, the CMP appears on the original and on the generated site and would dominate a parity diff.
 */
export const DEFAULT_MASK = [
  "#cookie-banner", "#sliding-popup", ".eu-cookie-compliance-banner",
  "#onetrust-banner-sdk", "#onetrust-consent-sdk", "#CybotCookiebotDialog", "#CybotCookiebotDialogBodyUnderlay",
  "#didomi-host", "#usercentrics-root", "#usercentrics-cmp-ui", "#truste-consent-track", "#consent_blackbar", ".truste_overlay", ".truste_box_overlay",
  "div[id^='sp_message_container']", ".qc-cmp2-container", "#BorlabsCookieBox", ".cky-consent-container", ".cky-overlay", ".osano-cm-window",
  "#iubenda-cs-banner", "#cmpbox", "#cmpbox2", "#cmplz-cookiebanner-container", "#ensModalWrapper", "#ensNotifyBanner", "#ensOverlay",
  // geo/locale suggestion dialogs (shown by IP; not page content)
  "#geoMismatchModal",
];

export const CRAWL_DIR = "raw/html";

/** CSS injected while taking screenshots: hide masked selectors, stop animations/carets. Exported for verify (E). */
export function screenshotCss(mask: string[]): string {
  const sel = [...new Set([...DEFAULT_MASK, ...mask])].join(",\n");
  return `${sel} { visibility: hidden !important; }
*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; }`;
}

/**
 * Analytics, ad, tag-manager and tracking-pixel requests. Never loaded by the crawl or the visual capture (privacy,
 * determinism); everything else a live page loads from other hosts (its CDN, web-component bundles, feature apps) is
 * part of how it looks.
 */
const TRACKER_URL =
  /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|\/gtag\/js|doubleclick\.net|googlesyndication\.com|googleadservices\.com|connect\.facebook\.net|facebook\.com\/tr|hotjar\.com|clarity\.ms|segment\.(io|com)|assets\.adobedtm\.com|omtrdc\.net|demdex\.net|2o7\.net|bat\.bing\.com|snap\.licdn\.com|px\.ads\.linkedin\.com|analytics\.tiktok\.com|newrelic\.com|nr-data\.net|static\.cloudflareinsights\.com|\/cdn-cgi\/(rum|zaraz|beacon)|tiqcdn\.com|tealium|demandbase\.com|company-target\.com|rlcdn\.com|o11\.tech|mouseflow|contentsquare|quantummetric|dynatrace|criteo|taboola|outbrain|adnxs\.com|amazon-adsystem|scorecardresearch|chartbeat|matomo|piwik|plausible\.io|fullstory|heap(analytics)?\.(io|com)|mixpanel|amplitude\.com|braze|optimizely|rum\.hlx\.page|\/akam\/\d+\//i; // /akam/<n>/…: Akamai Bot Manager sensor + pixel (bmw.de), same-origin
export const isTrackerUrl = (url: string): boolean => TRACKER_URL.test(url);

/**
 * Did the original page finish rendering? A capture that lacks the page's own script chunks (Wayback never archives
 * lazily imported bundles) leaves its app on a loading placeholder; that broken state would become the parity baseline
 * and the generated site would copy it. Signals: same-origin scripts that failed (404 / aborted; trackers excluded) and
 * markers of a render that gave up (React's client-render fallback `<!--$!-->`, URLs built from `undefined`).
 * Incomplete = 3+ failed scripts, or 1+ failed script together with a stuck-render marker.
 */
export function pageCompleteness(network: NetworkEntry[], renderedHtml: string): { failedScripts: string[]; signals: string[]; incomplete: boolean } {
  const failedScripts = [
    ...new Set(
      network
        .filter((n) => n.resourceType === "script" && !n.thirdParty && !n.blocked && !isTrackerUrl(n.url) && (!!n.failure || (n.status ?? 0) >= 400))
        .map((n) => n.url),
    ),
  ].sort();
  const signals: string[] = [];
  if (renderedHtml.includes("<!--$!-->")) signals.push("React client-render fallback (<!--$!-->)");
  const undef = renderedHtml.match(/\b(?:src|srcset|href)="[^"]*\bundefined[./]/g)?.length ?? 0;
  if (undef) signals.push(`${undef} URL(s) built from "undefined"`);
  return { failedScripts, signals, incomplete: failedScripts.length >= 3 || (failedScripts.length > 0 && signals.length > 0) };
}

const isLoopbackUrl = (u: string) => {
  try {
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(new URL(u).hostname);
  } catch {
    return false;
  }
};

/**
 * CSS-in-JS (styled-components, emotion) inserts its rules through the CSSOM: the <style> element stays empty in the
 * serialized DOM while the rendered markup carries client-generated class names. Write each sheet's rules into its
 * element (and document-level adopted sheets into a new <style>), so the rendered DOM snapshot styles itself.
 */
const MATERIALIZE_CSSOM_JS = `(() => {
  var text = function (sheet) { try { return Array.prototype.map.call(sheet.cssRules, function (r) { return r.cssText; }).join("\\n"); } catch (e) { return null; } };
  var n = 0;
  Array.prototype.forEach.call(document.querySelectorAll("style"), function (el) {
    if (!el.sheet) return;
    var css = text(el.sheet);
    if (css && css.length > (el.textContent || "").length + 16) { el.textContent = css; el.setAttribute("data-cmp-cssom", ""); n++; }
  });
  (document.adoptedStyleSheets || []).forEach(function (sheet) {
    var css = text(sheet);
    if (!css) return;
    var el = document.createElement("style"); el.setAttribute("data-cmp-adopted", ""); el.textContent = css; document.head.appendChild(el); n++;
  });
  return n;
})()`;

/**
 * Init script (before page scripts) for crawl and visual capture: timers of 2.5 s and more never fire, the end of CSS
 * animations that long is not reported to page scripts, and media does not play. Carousel autoplay, rotating heroes and timed pop-ups (chat coachmarks, newsletter layers) stay in their initial state, the
 * state a generated page shows, so both sides are captured alike and the rendered DOM is not caught mid-rotation.
 */
export const STILL_TIMERS_JS = `(() => {
  var LONG = 2500, st = window.setTimeout, si = window.setInterval;
  // the capture's own page-side scripts (image-load fallbacks) keep real long timers
  Object.defineProperty(window, "__cmpSetTimeout", { value: st.bind(window) });
  window.setTimeout = function (fn, ms) { if (+ms >= LONG) return st(function () {}, 2147483647); return st.apply(window, arguments); };
  window.setInterval = function (fn, ms) { if (+ms >= LONG) return si(function () {}, 2147483647); return si.apply(window, arguments); };
  // the same for CSS-animation-driven autoplay (a 5 s progress bar whose animationend advances the slide)
  ["animationend", "animationiteration"].forEach(function (t) { window.addEventListener(t, function (e) { if (e.elapsedTime * 1000 >= LONG) e.stopImmediatePropagation(); }, true); });
  // and for media-driven autoplay (a hero advances when its video ends): media stays at its first frame
  window.addEventListener("play", function (e) { var m = e.target; if (m && typeof m.pause === "function") m.pause(); }, true);
  window.addEventListener("ended", function (e) { e.stopImmediatePropagation(); }, true);
})();`;

/** A stalled origin (tarpit, WAF) must fail the request instead of hanging the step forever. */
export const FETCH_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 60_000;

/** Browser context options used for every crawl (and to be reused by visual verification). */
export function contextOptions(vp: ViewportSpec) {
  return {
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light" as const,
    reducedMotion: "reduce" as const,
    serviceWorkers: "block" as const,
    userAgent: `Mozilla/5.0 (cmp-crawler; ${vp.name}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36`,
  };
}

/**
 * Navigate, wait for network idle + fonts + lazy images. Exported for verify (E).
 * Robust against pages that never go network-idle (polling widgets, search SDKs, analytics): navigation waits for
 * `load`, network idle is best-effort, lazy images are triggered by scrolling (capped for very long pages), and a short
 * settle lets jQuery/Drupal behaviours finish DOM changes before the DOM/screenshot is taken.
 */
export async function settlePage(page: Page, url: string): Promise<{ response: Response | null; images: PageManifest["images"] }> {
  let response: Response | null = null;
  try {
    response = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  } catch (e) {
    // a sub-resource that never finishes (slow Internet Archive fill in a replay, a hanging third party) must not fail a
    // page whose document arrived: continue with what loaded (verify's capture has the same fallback)
    if (!/timeout/i.test(String(e)) || page.url() === "about:blank") throw e;
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  }
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  const images = (await Promise.race([
    page.evaluate(SETTLE_JS),
    new Promise((r) => setTimeout(() => r([]), 30_000)),
  ])) as PageManifest["images"];
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  return { response, images };
}

/** Follow redirects manually with fetch, returning the chain and the final response body. */
export async function fetchChain(
  url: string,
  opts: { method?: "GET" | "HEAD"; max?: number } = {},
): Promise<{ chain: RedirectHop[]; status: number; finalUrl: string; contentType?: string; body?: string; replay?: boolean }> {
  const chain: RedirectHop[] = [];
  let current = url;
  for (let i = 0; i < (opts.max ?? 10); i++) {
    const res = await guardedFetch(current, { redirect: "manual", method: opts.method ?? "GET", headers: { "user-agent": "cmp-crawler" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      chain.push({ url: current, status: res.status, location: loc });
      await res.body?.cancel();
      current = new URL(loc, current).href;
      continue;
    }
    const contentType = res.headers.get("content-type") ?? undefined;
    const body = opts.method === "HEAD" ? undefined : await res.text();
    return { chain, status: res.status, finalUrl: current, contentType, body, replay: res.headers.get("x-replay") === "1" };
  }
  return { chain, status: 310, finalUrl: current };
}

function normaliseSeed(u: string, base: string): string | undefined {
  const p = pathOf(u, base);
  if (!p) return undefined;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function assetKind(resourceType: string, mime: string): AssetRecord["kind"] {
  if (resourceType === "image" || mime.startsWith("image/")) return "image";
  if (resourceType === "stylesheet" || mime.includes("css")) return "stylesheet";
  if (resourceType === "font" || mime.startsWith("font/") || /woff|ttf|otf/.test(mime)) return "font";
  if (resourceType === "script" || mime.includes("javascript")) return "script";
  return "other";
}

function assetFile(path: string): string {
  const clean = path.replace(/^\/+/, "").split("/").map((s) => s.replace(/[^a-zA-Z0-9._-]+/g, "_")).join("/");
  return `${CRAWL_DIR}/assets/${clean || "index"}`;
}

/** Same-origin menu/nav links + all internal anchors (for follow mode). */
function extractLinks(html: string, base: string): { all: string[]; nav: string[] } {
  const tree = parseDocument(html);
  const all = new Set<string>();
  const nav = new Set<string>();
  for (const a of selectAll("a[href]", tree)) {
    const href = attr(a, "href")!;
    if (href.startsWith("#") || /^(mailto|tel|javascript):/.test(href)) continue;
    const p = pathOf(href, base);
    if (!p || /\.[a-z0-9]{2,5}$/i.test(p) || p.startsWith("/__ext/")) continue;
    all.add(p);
  }
  for (const a of selectAll("nav a[href], [role=navigation] a[href], .language-switcher-language-url a[href]", tree)) {
    const p = pathOf(attr(a, "href")!, base);
    if (p && !p.startsWith("/__ext/")) nav.add(p);
  }
  return { all: [...all].sort(), nav: [...nav].sort() };
}

/** Links worth probing for redirects/broken targets: content links (inside <main>) and Drupal system paths anywhere. */
function contentLinksOf(html: string, base: string): string[] {
  const tree = parseDocument(html);
  const out = new Set<string>();
  const main = selectAll("main, [role=main]", tree);
  const inMain = new Set(main.flatMap((m) => selectAll("a[href]", m)));
  for (const a of selectAll("a[href]", tree)) {
    const href = attr(a, "href")!;
    if (href.startsWith("#") || /^(mailto|tel|javascript):/.test(href)) continue;
    const p = pathOf(href, base);
    if (!p || p.startsWith("/__ext/") || p.startsWith("/cdn-cgi/")) continue;
    if (/^\/(([a-z]{2}(-[a-z]{2})?)\/)?(node|taxonomy\/term|media)\/\d+$/.test(p) || (inMain.has(a) && !/\.[a-z0-9]{2,5}$/i.test(p))) out.add(p);
  }
  // alias candidates published in meta (og:url /home vs canonical /): a captured redirect becomes a CCM redirect
  for (const m of selectAll("link[rel=canonical], meta[property='og:url'], link[rel=shortlink]", tree)) {
    const p = pathOf(attr(m, "href") ?? attr(m, "content") ?? "", base);
    if (p && !p.startsWith("/__ext/")) out.add(p.length > 1 ? p.replace(/\/+$/, "") : p);
  }
  return [...out].sort();
}

/**
 * Same-origin media referenced by the server HTML that a browser visit may not request: <picture>/<source> and srcset
 * candidates for other breakpoints/densities, lazy `data-src`, inline background images, linked documents
 * (Drupal /sites/default/files/*.pdf, AEM /content/dam/*.pdf.asset.<ts>.pdf, …), icons.
 */
export function mediaRefsOf(html: string, base: string): string[] {
  const tree = parseDocument(html);
  const out = new Set<string>();
  const add = (u: string | undefined) => {
    if (!u || u.startsWith("data:")) return;
    const p = pathOf(u, base);
    if (p && !p.startsWith("/__ext/")) out.add(new URL(u, base + "/").href);
  };
  const srcset = (v: string | undefined) => v?.split(/,\s+(?=\S)/).forEach((c) => add(c.trim().split(/\s+/)[0]));
  for (const el of selectAll("img, source", tree)) {
    add(attr(el, "src"));
    add(attr(el, "dataSrc"));
    srcset(attr(el, "srcSet"));
    srcset(attr(el, "dataSrcset"));
  }
  for (const el of selectAll("[style*='url(']", tree)) for (const m of (attr(el, "style") ?? "").matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(m[1]);
  for (const a of selectAll("a[href]", tree)) {
    const href = attr(a, "href")!;
    const p = pathOf(href, base);
    // a same-origin link to a file is a download the page offers, wherever the CMS stores it (bmw.de: a PDF under
    // /content/dam/ was served by the original and 404 on the generated site)
    if (p && /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|webp|svg|mp4)$/i.test(p.split(/[?#]/)[0]!)) add(href);
  }
  for (const l of selectAll("link[rel*=icon], link[rel=image_src]", tree)) add(attr(l, "href"));
  return [...out].sort();
}

function hreflangOf(html: string, base: string): PageManifest["hreflang"] {
  const tree = parseDocument(html);
  return selectAll("link[rel=alternate][hreflang]", tree)
    .map((l) => ({ locale: attr(l, "hrefLang") ?? "", href: pathOf(attr(l, "href") ?? "", base) ?? attr(l, "href") ?? "" }))
    .filter((x) => x.locale);
}

async function sitemapPaths(base: string): Promise<string[]> {
  const out = new Set<string>();
  const queue = [`${base}/sitemap.xml`];
  try {
    const robots = await guardedFetch(`${base}/robots.txt`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (robots.ok) for (const m of (await robots.text()).matchAll(/^Sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  } catch {
    /* no robots */
  }
  const seen = new Set<string>();
  while (queue.length) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await guardedFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        const loc = m[1].replace(/&amp;/g, "&");
        if (/<sitemapindex/.test(xml)) queue.push(loc);
        else {
          const p = pathOf(loc, base);
          if (p) out.add(p);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

export async function crawlSite(ctx: StepContext, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const { ws, site, log } = ctx;
  const base = site.baseUrl.replace(/\/+$/, "");
  const viewports: ViewportSpec[] = opts.viewports ?? site.crawl?.viewports ?? DEFAULT_VIEWPORTS;
  const mask = [...new Set([...(site.crawl?.mask ?? []), ...(opts.mask ?? [])])];
  const follow = opts.follow ?? site.crawl?.follow ?? false;
  const maxPages = opts.maxPages ?? site.crawl?.maxPages ?? 50;
  const wantShots = opts.screenshots !== false;
  // replays (loopback) serve third parties themselves under /__ext/; a live site's own CDNs and feature apps load as usual
  const blockThirdParty = opts.blockThirdParty ?? isLoopbackUrl(base);
  const wantAssets = opts.assets !== false;
  const issues: Issue[] = [];
  const outputs: string[] = [];
  const write = async (rel: string, data: string | Uint8Array) => {
    if (!ctx.dryRun) await ws.writeText(rel, data);
    outputs.push(rel);
  };
  const writeJson = async (rel: string, data: unknown) => write(rel, JSON.stringify(data, null, 2) + "\n");

  const seeds = (opts.urls ?? site.urls ?? ["/"]).map((u) => normaliseSeed(u, base)).filter((p): p is string => !!p);
  // capture replay (N1 source-capture): learn the original origin so CCM can keep production URLs
  let origin: string | undefined;
  try {
    const st = await guardedFetch(`${base}/__replay/status`, { headers: { "user-agent": "cmp-crawler" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (st.ok && (st.headers.get("content-type") ?? "").includes("json")) origin = ((await st.json()) as { origin?: string }).origin;
    else await st.body?.cancel();
  } catch {
    /* not a replay */
  }
  const queue: string[] = [...new Set(seeds)];
  let sitemap: string[] | undefined;
  if (follow) {
    sitemap = await sitemapPaths(base);
    for (const p of sitemap) if (!queue.includes(p)) queue.push(p);
  }

  // desktop (widest) first: its visit provides the rendered DOM, network log and assets
  const vps = [...viewports].sort((a, b) => b.width - a.width);
  const ownBrowser = !opts.browser;
  const browser = opts.browser ?? (await launchChromium());
  const contexts = new Map<string, BrowserContext>();
  const blocked = new Set<string>();
  const assets = new Map<string, AssetRecord>();
  const pages: PageManifest[] = [];
  const index: CrawlIndex = { baseUrl: base, viewports, mask: [...new Set([...DEFAULT_MASK, ...mask])], pages: [], redirects: [], failed: [], sitemap, ...(origin ? { origin } : {}) };
  const crawled = new Map<string, PageManifest>();
  const seen = new Set<string>();

  try {
    for (const vp of vps) {
      const c = await browser.newContext(contextOptions(vp));
      await c.addInitScript({ content: STILL_TIMERS_JS });
      await c.route(
        (u) => /^https?:/.test(u.protocol) && u.origin !== new URL(base).origin && (blockThirdParty || isTrackerUrl(u.href)),
        (route) => {
          blocked.add(route.request().url());
          return route.abort("blockedbyclient");
        },
      );
      await guardContext(c);
      contexts.set(vp.name, c);
    }

    while (queue.length && crawled.size < maxPages) {
      const path = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const requestedUrl = base + path;
      let chain;
      try {
        chain = await fetchChain(requestedUrl);
      } catch (e) {
        index.failed.push({ url: requestedUrl, error: (e as Error).message });
        issues.push({ severity: "error", code: "CRAWL_FETCH_FAILED", message: `${requestedUrl}: ${(e as Error).message}`, ref: path, actionable: true });
        continue;
      }
      const finalPath = pathOf(chain.finalUrl, base) ?? path;
      for (const hop of chain.chain) {
        const from = pathOf(hop.url, base);
        const to = hop.location ? pathOf(new URL(hop.location, hop.url).href, base) : undefined;
        if (from && to) index.redirects.push({ from, to, status: hop.status });
      }
      if (!chain.contentType?.includes("text/html")) {
        issues.push({ severity: "warning", code: "CRAWL_NOT_HTML", message: `${path} is ${chain.contentType ?? "unknown"} (status ${chain.status})`, ref: path });
        continue;
      }
      if (chain.status >= 400) issues.push({ severity: "warning", code: "CRAWL_HTTP_ERROR", message: `${path} returned ${chain.status}`, ref: path, actionable: true });
      const existing = crawled.get(finalPath);
      if (existing) {
        index.pages.find((p) => p.path === finalPath)?.requested.push(path);
        continue;
      }
      seen.add(finalPath);
      const id = safeId(finalPath);
      const manifest: PageManifest = {
        id,
        path: finalPath,
        requestedUrl,
        finalUrl: chain.finalUrl,
        status: chain.status,
        redirectChain: chain.chain,
        contentType: chain.contentType,
        bodyClasses: [],
        files: { raw: `${CRAWL_DIR}/pages/${id}.raw.html`, rendered: `${CRAWL_DIR}/pages/${id}.rendered.html` },
        screenshots: {},
        styles: {},
        images: [],
        network: [],
        links: [],
        hreflang: [],
      };
      await write(manifest.files.raw, chain.body ?? "");
      if (chain.body) manifest.contentLinks = contentLinksOf(chain.body, base);
      let renderedHtml = "";

      for (const [i, vp] of vps.entries()) {
        const page = await contexts.get(vp.name)!.newPage();
        const primary = i === 0;
        const pending: Promise<void>[] = [];
        if (primary) {
          page.on("requestfailed", (req) => {
            const url = req.url();
            manifest.network.push({ url, method: req.method(), resourceType: req.resourceType(), thirdParty: !url.startsWith(base), blocked: blocked.has(url), failure: req.failure()?.errorText });
          });
        }
        page.on("response", (res) => {
          const req = res.request();
          const url = res.url();
          const thirdParty = !url.startsWith(base);
          const mime = (res.headers()["content-type"] ?? "").split(";")[0].trim();
          if (primary) manifest.network.push({ url, method: req.method(), resourceType: req.resourceType(), status: res.status(), mime, thirdParty, bytes: Number(res.headers()["content-length"] ?? 0) || undefined });
          if (!wantAssets || thirdParty || req.resourceType() === "document" || res.status() !== 200) return;
          const kind = assetKind(req.resourceType(), mime);
          // same-origin data the page's scripts fetch (AEM SPA models, feature-app config JSON) is served with the page
          // in static mode; HTML documents and API calls with query strings stay out
          const data = (req.resourceType() === "fetch" || req.resourceType() === "xhr") && req.method() === "GET" && /json|xml|text\/plain/.test(mime) && !new URL(url).search;
          if (kind === "other" && !data) return;
          const p = pathOf(url, base)!;
          const rec = assets.get(p);
          if (rec) {
            if (!rec.referencedBy.includes(finalPath)) rec.referencedBy.push(finalPath);
            return;
          }
          const placeholder: AssetRecord = { url, path: p, file: assetFile(p), kind, mime, size: 0, sha256: "", referencedBy: [finalPath] };
          assets.set(p, placeholder);
          pending.push(
            res
              .body()
              .then(async (buf) => {
                placeholder.size = buf.length;
                placeholder.sha256 = createHash("sha256").update(buf).digest("hex");
                await write(placeholder.file, buf);
              })
              .catch(() => {
                assets.delete(p);
              }),
          );
        });
        try {
          const { response, images } = await settlePage(page, chain.finalUrl);
          if (response && response.status() !== chain.status) log.debug(`browser status ${response.status()} != fetch status ${chain.status} for ${path}`);
          manifest.styles[vp.name] = (await page.evaluate(evalCollect())) as StyleSnapshot;
          if (primary) {
            await page.evaluate(MATERIALIZE_CSSOM_JS).catch(() => undefined);
            const rendered = await page.content();
            renderedHtml = rendered;
            await write(manifest.files.rendered, rendered);
            manifest.images = images;
            manifest.lang = (await page.getAttribute("html", "lang")) ?? undefined;
            manifest.title = await page.title();
            manifest.bodyClasses = ((await page.getAttribute("body", "class")) ?? "").split(/\s+/).filter(Boolean);
            const links = extractLinks(rendered, base);
            manifest.links = links.all;
            manifest.hreflang = hreflangOf(rendered, base);
            if (follow) for (const l of links.nav) if (!seen.has(l) && !queue.includes(l)) queue.push(l);
          }
          if (wantShots) {
            const rel = `design/screenshots/${vp.name}/${id}.png`;
            const buf = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide", scale: "css", style: screenshotCss(mask) });
            await write(rel, buf);
            manifest.screenshots[vp.name] = rel;
          }
          // menus / mobile nav: open each header toggle once (lazy menu bundles are captured by the response listener)
          // and record what it changes, for pages rendered without the original scripts (see interactions.ts)
          if (opts.interactions !== false) {
            const records = await exerciseInteractions(page).catch((e: Error) => {
              log.debug(`interactions ${path} @${vp.name}: ${e.message}`);
              return [];
            });
            if (records.length) (manifest.interactions ??= {})[vp.name] = { width: vp.width, records };
          }
          await Promise.all(pending);
        } catch (e) {
          issues.push({ severity: "error", code: "CRAWL_RENDER_FAILED", message: `${path} @${vp.name}: ${(e as Error).message}`, ref: path, actionable: true });
        } finally {
          await page.close();
        }
      }
      manifest.network.sort((a, b) => a.url.localeCompare(b.url));
      const done = pageCompleteness(manifest.network, renderedHtml);
      if (done.incomplete) {
        const shown = done.failedScripts.slice(0, 5).map((u) => pathOf(u, base) ?? u).join(", ");
        issues.push({
          severity: "warning",
          code: "CRAWL_PAGE_INCOMPLETE",
          message: `${finalPath} did not finish rendering on the source: ${done.failedScripts.length} of its own script(s) failed to load (${shown}${done.failedScripts.length > 5 ? ", …" : ""})${done.signals.length ? `; ${done.signals.join("; ")}` : ""}. The screenshots show that broken state and would become the parity baseline — recapture the page (HAR from a real browser, or another snapshot), then re-run extract.`,
          ref: finalPath,
          actionable: true,
        });
      } else if (done.failedScripts.length) {
        issues.push({ severity: "info", code: "CRAWL_SCRIPTS_FAILED", message: `${finalPath}: ${done.failedScripts.length} script(s) failed to load (${done.failedScripts.map((u) => pathOf(u, base) ?? u).join(", ")})`, ref: finalPath });
      }
      await writeJson(`${CRAWL_DIR}/pages/${id}.json`, manifest);
      pages.push(manifest);
      crawled.set(finalPath, manifest);
      index.pages.push({ path: finalPath, id, status: manifest.status, manifest: `${CRAWL_DIR}/pages/${id}.json`, requested: [path] });
      log.info(`crawled ${finalPath} (${manifest.status}) ${Object.keys(manifest.screenshots).length} screenshot(s)`);
    }
    if (queue.length) issues.push({ severity: "info", code: "CRAWL_MAX_PAGES", message: `maxPages ${maxPages} reached, ${queue.length} URL(s) not crawled` });

    // url()s in downloaded CSS (other breakpoints/hover states) that the browser did not request
    const tried = new Set<string>(); // each missing URL is requested once
    let notCaptured = 0;
    if (wantAssets) {
      for (const css of [...assets.values()].filter((a) => a.kind === "stylesheet")) {
        let text = "";
        try {
          text = await ws.readText(css.file);
        } catch {
          continue;
        }
        for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
          if (m[2].startsWith("data:")) continue;
          const abs = new URL(m[2], css.url).href.split("#")[0];
          const p = pathOf(abs, base);
          if (!p || assets.has(p) || tried.has(abs)) continue;
          tried.add(abs);
          try {
            const res = await guardedFetch(abs, { signal: AbortSignal.timeout(ASSET_TIMEOUT_MS) });
            if (!res.ok) {
              await res.body?.cancel();
              if (res.status === 404 && res.headers.get("x-replay") === "1") notCaptured++;
              else issues.push({ severity: "warning", code: "CRAWL_ASSET_MISSING", message: `${abs} (from ${css.path}) returned ${res.status}`, ref: abs });
              continue;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            const mime = (res.headers.get("content-type") ?? "").split(";")[0];
            const rec: AssetRecord = { url: abs, path: p, file: assetFile(p), kind: assetKind("", mime), mime, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), referencedBy: [css.path] };
            assets.set(p, rec);
            await write(rec.file, buf);
          } catch (e) {
            issues.push({ severity: "warning", code: "CRAWL_ASSET_FAILED", message: `${abs}: ${(e as Error).message}`, ref: abs });
          }
        }
      }
    }
    // media referenced by the server HTML but not requested by the browser (other breakpoints, lazy, linked files)
    if (wantAssets) {
      const wanted = new Map<string, Set<string>>(); // url -> referencing pages
      for (const m of pages) {
        let raw = "";
        try {
          raw = await ws.readText(m.files.raw);
        } catch {
          continue;
        }
        for (const u of mediaRefsOf(raw, base)) wanted.set(u, (wanted.get(u) ?? new Set()).add(m.path));
      }
      let fetched = 0;
      for (const abs of [...wanted.keys()].sort()) {
        const p = pathOf(abs, base);
        if (!p || assets.has(p) || tried.has(abs) || fetched >= 600) continue;
        fetched++;
        tried.add(abs);
        try {
          const res = await guardedFetch(abs, { headers: { "user-agent": "cmp-crawler" }, signal: AbortSignal.timeout(ASSET_TIMEOUT_MS) });
          if (!res.ok) {
            await res.body?.cancel();
            if (res.status === 404 && res.headers.get("x-replay") === "1") notCaptured++;
            else issues.push({ severity: "info", code: "CRAWL_MEDIA_MISSING", message: `${p} (referenced in HTML) returned ${res.status}`, ref: p });
            continue;
          }
          const buf = Buffer.from(await res.arrayBuffer());
          const mime = (res.headers.get("content-type") ?? "").split(";")[0];
          const rec: AssetRecord = { url: abs, path: p, file: assetFile(p), kind: assetKind("", mime), mime, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), referencedBy: [...(wanted.get(abs) ?? [])] };
          assets.set(p, rec);
          await write(rec.file, buf);
        } catch (e) {
          issues.push({ severity: "warning", code: "CRAWL_ASSET_FAILED", message: `${abs}: ${(e as Error).message}`, ref: abs });
        }
      }
    }
    if (notCaptured)
      issues.push({
        severity: "warning",
        code: "CRAWL_ASSETS_NOT_CAPTURED",
        message: `${notCaptured} referenced asset URL(s) (CSS url(), srcset, lazy images, linked files) are not in the capture store (replay 404, see captures/<site>/misses.log)`,
        actionable: true,
      });
  } finally {
    for (const c of contexts.values()) await c.close().catch(() => undefined);
    if (ownBrowser) await browser.close().catch(() => undefined);
  }

  // probe internal links not crawled (e.g. hard-coded /node/2 in body text → 301 alias)
  const links: Record<string, LinkProbe> = {};
  if (opts.probeLinks !== false) {
    const targets = new Set<string>();
    for (const p of pages) for (const l of p.contentLinks ?? p.links) if (!crawled.has(l)) targets.add(l);
    const maxProbes = opts.maxLinkProbes ?? 150;
    if (targets.size > maxProbes) issues.push({ severity: "info", code: "CRAWL_LINK_PROBES_CAPPED", message: `${targets.size} links, probing the first ${maxProbes}` });
    for (const t of [...targets].sort().slice(0, maxProbes)) {
      try {
        // one retry: a replay restart or an on-demand archive fill can drop a single request
        const r = await fetchChain(base + t, { method: "HEAD" }).catch(async () => {
          await new Promise((res) => setTimeout(res, 1500));
          return fetchChain(base + t, { method: "HEAD" });
        });
        links[t] = { path: t, status: r.status, finalPath: pathOf(r.finalUrl, base), chain: r.chain, ...(r.replay ? { replay: true } : {}) };
        for (const hop of r.chain) {
          const from = pathOf(hop.url, base);
          const to = hop.location ? pathOf(new URL(hop.location, hop.url).href, base) : undefined;
          if (from && to && !index.redirects.some((x) => x.from === from)) index.redirects.push({ from, to, status: hop.status });
        }
        if (r.status === 404 && r.replay) issues.push({ severity: "info", code: "LINK_NOT_CAPTURED", message: `internal link ${t} is not in the capture store (replay 404)`, ref: t });
        else if (r.status >= 400) issues.push({ severity: "warning", code: "BROKEN_LINK", message: `internal link ${t} returns ${r.status}`, ref: t, actionable: true });
      } catch (e) {
        links[t] = { path: t, status: 0, chain: [] };
        issues.push({ severity: "warning", code: "LINK_PROBE_FAILED", message: `${t}: ${(e as Error).message}`, ref: t });
      }
    }
  }

  const assetList = [...assets.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const a of assetList) a.referencedBy.sort();
  index.pages.sort((a, b) => a.path.localeCompare(b.path));
  // the site root, when it was not crawled itself: its redirect to the start page (bvg.de/ -> /de) belongs to the site.
  // Root redirects are often geo/session dependent (ibm.com/ -303-> /de-en -301-> /us-en, at times a literal `/de-*`), so
  // the chain is collapsed to one hop `/ -> <final page>` and kept only when it lands on a page we crawled; otherwise the
  // generator falls back to the first configured URL (ROOT_REDIRECT_ADDED).
  if (!crawled.has("/") && !index.redirects.some((x) => x.from === "/")) {
    const root = await fetchChain(base + "/").catch(() => undefined);
    const first = root?.chain[0];
    const to = root && root.status < 400 ? pathOf(root.finalUrl, base) : undefined;
    if (first && to && to !== "/" && crawled.has(to)) index.redirects.push({ from: "/", to, status: first.status });
  }
  index.redirects.sort((a, b) => a.from.localeCompare(b.from));
  await writeJson(`${CRAWL_DIR}/assets.json`, assetList);
  await writeJson(`${CRAWL_DIR}/links.json`, links);
  await writeJson(`${CRAWL_DIR}/crawl.json`, index);
  if (blocked.size) issues.push({ severity: "info", code: "CRAWL_THIRD_PARTY_BLOCKED", message: `${blocked.size} third-party request(s) blocked: ${[...new Set([...blocked].map((u) => new URL(u).host))].join(", ")}` });
  return { index, pages: pages.sort((a, b) => a.path.localeCompare(b.path)), assets: assetList, links, issues, outputs };
}

/** Read a previous crawl back from the workspace. */
export async function readCrawl(ws: StepContext["ws"]): Promise<{ index: CrawlIndex; pages: PageManifest[]; assets: AssetRecord[]; links: Record<string, LinkProbe> } | undefined> {
  if (!(await ws.exists(`${CRAWL_DIR}/crawl.json`))) return undefined;
  const index = await ws.readJson<CrawlIndex>(`${CRAWL_DIR}/crawl.json`);
  const pages: PageManifest[] = [];
  for (const p of index.pages) pages.push(await ws.readJson<PageManifest>(p.manifest));
  const assets = (await ws.exists(`${CRAWL_DIR}/assets.json`)) ? await ws.readJson<AssetRecord[]>(`${CRAWL_DIR}/assets.json`) : [];
  const links = (await ws.exists(`${CRAWL_DIR}/links.json`)) ? await ws.readJson<Record<string, LinkProbe>>(`${CRAWL_DIR}/links.json`) : {};
  return { index, pages, assets, links };
}

