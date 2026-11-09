import { guardContext } from "@harness/mirror-core";
import type { Browser, BrowserContext, Page } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
// browser context options + mask CSS are shared with the crawler (@cmp/source-html) so design/ baselines stay comparable
import { contextOptions, isTrackerUrl, screenshotCss, STILL_TIMERS_JS } from "@harness/mirror-capture";

export interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

/**
 * The single screenshot routine used for BOTH sides (old = original/replay, new = generated app).
 * Keep identical on both sides, otherwise parity scores are meaningless.
 */
export const CAPTURE_SETTINGS = {
  deviceScaleFactor: 1,
  reducedMotion: "reduce" as const,
  colorScheme: "light" as const,
  waitUntil: "networkidle" as const,
  fallbackWaitUntil: "load" as const,
  navigationTimeoutMs: 45_000,
  settleMs: 250,
  fullPage: true,
  animations: "disabled" as const,
  caret: "hide" as const,
  /** masking = visibility:hidden via @cmp/source-html screenshotCss (same as the baselines) */
  pixelmatch: { threshold: 0.1, includeAA: false },
  padColor: [255, 255, 255, 255] as const,
  /** diff attribution: cell size (px) for clustering diff pixels, min diff pixels per cell, max regions reported */
  regions: { cell: 8, minCellPixels: 2, gapCells: 2, max: 12 },
};

export const DEFAULT_BBOX_SELECTORS = ["header", "nav", "main", "footer", "h1", "h2", "h3", "img", '[class*="paragraph--type--"]', '[class*="node--type-"]'];

export interface CaptureContextOptions {
  /**
   * Hosts the page may load from (besides localhost/127.0.0.1). Every other request is aborted on both sides:
   * deterministic (no third-party ads/analytics/CDN drift) and a hard guard against contacting a production origin.
   */
  allowHosts?: string[];
  /**
   * Live original: third-party hosts other than trackers load on both sides (the site's CDN, web-component bundles,
   * feature apps), as for a visitor. forbiddenHosts still apply.
   */
  allowThirdParty?: boolean;
  /** hosts that must never be contacted (e.g. the captured production origin); checked before allowHosts */
  forbiddenHosts?: string[];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Hostname-level request filter shared by the browser contexts (both sides) and the Node fetches of verify. */
export function hostAllowed(url: string, o: CaptureContextOptions = {}): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return true; // data:, blob:, about:
  const host = u.hostname.toLowerCase();
  if ((o.forbiddenHosts ?? []).some((h) => h.toLowerCase() === host)) return false;
  if (LOCAL_HOSTS.has(host)) return true;
  if (o.allowThirdParty) return !isTrackerUrl(u.href);
  if (!o.allowHosts) return true;
  return o.allowHosts.some((h) => h.toLowerCase() === host || h.toLowerCase() === u.host.toLowerCase());
}

/**
 * Init script (runs before any page script, identical on both sides):
 * - lazy images/iframes forced eager (native loading=lazy and late-inserted nodes)
 * - Math.random seeded (carousels / A-B snippets that randomise their start)
 */
const INIT_JS = `(() => {
  var seed = 0x2f6b3c1d;
  Math.random = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  var eager = function (root) {
    if (!root || !root.querySelectorAll) return;
    var els = root.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]');
    for (var i = 0; i < els.length; i++) { els[i].setAttribute("loading", "eager"); }
    if (root.tagName === "IMG" && root.getAttribute("loading") === "lazy") root.setAttribute("loading", "eager");
  };
  try {
    new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) for (var j = 0; j < ms[i].addedNodes.length; j++) eager(ms[i].addedNodes[j]);
    }).observe(document, { childList: true, subtree: true });
  } catch (e) {}
  document.addEventListener("DOMContentLoaded", function () { eager(document); });
})();`;

/**
 * Settle (page side): scroll through the page in viewport steps (IntersectionObserver lazy loaders, lazysizes,
 * background images), back to the top, wait for every image (incl. decode) and every font face.
 */
const SETTLE_JS = `(async () => {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var frames = function () { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(); }); }); }); };
  // same scroll as the crawl (source-html SETTLE_JS): half-viewport steps, 150 ms each, so throttled scroll handlers
  // and IntersectionObserver reveals fire; reveal classes a script removes again off-screen are put back
  var step = Math.max(200, Math.floor(window.innerHeight * 0.5));
  var hidden = new Set();
  Array.prototype.slice.call(document.body.querySelectorAll("*"), 0, 20000).forEach(function (el) { var cs = getComputedStyle(el); if (cs.opacity === "0" || cs.visibility === "hidden") hidden.add(el); });
  var added = new Map();
  var mo = new MutationObserver(function (ms) { ms.forEach(function (m) { var el = m.target; if (!hidden.has(el)) return; var before = (m.oldValue || "").split(/\s+/); Array.prototype.forEach.call(el.classList, function (c) { if (before.indexOf(c) < 0) { if (!added.has(el)) added.set(el, new Set()); added.get(el).add(c); } }); }); });
  mo.observe(document.body, { attributes: true, attributeFilter: ["class"], attributeOldValue: true, subtree: true });
  for (var y = 0, n = 0; y < document.documentElement.scrollHeight && y < 60000 && n < 250; y += step, n++) { window.scrollTo(0, y); await sleep(150); }
  window.scrollTo(0, document.documentElement.scrollHeight); await sleep(200);
  window.scrollTo(0, 0);
  await sleep(100);
  mo.disconnect();
  added.forEach(function (cls, el) { cls.forEach(function (c) { if (!el.classList.contains(c)) el.classList.add(c); }); });
  window.dispatchEvent(new Event("scroll"));
  var imgs = Array.prototype.slice.call(document.images);
  await Promise.all(imgs.map(function (img) {
    var done = img.complete ? Promise.resolve() : new Promise(function (r) { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); (window.__cmpSetTimeout || setTimeout)(r, 5000); });
    return done.then(function () { return img.decode ? img.decode().catch(function () {}) : undefined; });
  }));
  if (document.fonts) {
    await document.fonts.ready;
    var faces = []; document.fonts.forEach(function (f) { if (f.status === "loading") faces.push(f.loaded.catch(function () {})); });
    await Promise.all(faces);
  }
  await frames();
  return { images: imgs.length, fonts: document.fonts ? document.fonts.status : "n/a", height: document.documentElement.scrollHeight };
})()`;

/**
 * Autoplay off (init script, both sides alike): a carousel's own pause control is pressed as soon as it renders, as a
 * visitor would, so slides never advance while the page loads and settles (frame-driven autoplay that no timer patch
 * reaches; volkswagen.de's stage advances every 5 s). Each control is pressed once.
 */
const PAUSE_AUTOPLAY_JS = `(() => {
  var re = /^(pause|pausieren|anhalten|stop|stopp|arr[eê]ter|pausa|detener)\\b|pause (slide|carousel|autoplay|auto)|(slide|carousel|autoplay) (pause|anhalten)/i;
  var scope = "[aria-roledescription=carousel], [aria-roledescription=Carousel], [class*=carousel], [class*=Carousel], [class*=slider], [class*=Slider], [class*=stage], [class*=Stage], [class*=swiper], section";
  var done = new WeakSet();
  var scan = function () {
    Array.prototype.forEach.call(document.querySelectorAll("button, [role=button]"), function (b) {
      if (done.has(b)) return;
      var label = (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();
      if (!re.test(label) || b.getAttribute("aria-pressed") === "true" || !b.closest(scope)) return;
      var r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      done.add(b);
      try { b.click(); } catch (e) {}
    });
  };
  var queued = false;
  var mo = new MutationObserver(function () { if (queued) return; queued = true; Promise.resolve().then(function () { queued = false; scan(); }); });
  var start = function () { scan(); mo.observe(document.documentElement, { childList: true, subtree: true }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();`;

/**
 * Freeze (page side, right before the screenshot, identical on both sides):
 * - every pending interval/timeout cleared → carousel autoplay, rotating banners, tickers stop
 * - known carousel APIs (slick, Swiper, Splide, Flickity, Owl, Bootstrap) paused and reset to the first slide
 * - <video> paused at 0, autoplay removed, reloaded so the poster (or first frame) shows
 * - CSS/Web animations finished; scroll position (0, 0)
 * - position:fixed → absolute and sticky → relative, so full-page shots show them once, where they sit at scroll 0
 */
const FREEZE_JS = `(async () => {
  var frames = function () { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(); }); }); }); };
  var out = { carousels: 0, videos: 0, fixed: 0, sticky: 0, timers: 0 };
  // ending animations must not drive page logic: a carousel whose progress bar is a CSS animation advances a slide on
  // animationend (volkswagen.de hero), so those events stop at the window before the instant end below
  ["animationend", "animationiteration", "transitionend"].forEach(function (t) { window.addEventListener(t, function (e) { e.stopImmediatePropagation(); }, true); });
  // transitions/animations end instantly from here on (scroll-driven fades such as back-to-top settle before we measure)
  var st = document.createElement("style");
  st.setAttribute("data-cmp-freeze", "");
  st.textContent = "*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }";
  (document.head || document.documentElement).appendChild(st);
  // frozen state: viewport changes made by the screenshot itself (full-page capture) must not re-run layout scripts
  window.addEventListener("resize", function (e) { e.stopImmediatePropagation(); }, true);
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event("scroll"));
  await frames();
  try {
    var $ = window.jQuery;
    if ($ && $.fn) {
      if ($.fn.slick) $(".slick-initialized").each(function () { try { $(this).slick("slickPause"); $(this).slick("slickGoTo", 0, true); out.carousels++; } catch (e) {} });
      if ($.fn.owlCarousel) $(".owl-carousel").each(function () { try { $(this).trigger("stop.owl.autoplay"); $(this).trigger("to.owl.carousel", [0, 0]); out.carousels++; } catch (e) {} });
      if ($.fn.carousel) $(".carousel").each(function () { try { $(this).carousel("pause"); out.carousels++; } catch (e) {} });
    }
  } catch (e) {}
  document.querySelectorAll(".swiper, .swiper-container, [class*=swiper]").forEach(function (el) {
    var s = el.swiper; if (!s || s.__cmpFrozen) return; s.__cmpFrozen = true;
    try { if (s.autoplay && s.autoplay.stop) s.autoplay.stop(); if (s.params && s.params.loop && s.slideToLoop) s.slideToLoop(0, 0, false); else if (s.slideTo) s.slideTo(0, 0, false); out.carousels++; } catch (e) {}
  });
  try { if (window.Flickity && window.Flickity.data) document.querySelectorAll(".flickity-enabled").forEach(function (el) { var f = window.Flickity.data(el); if (f) { f.stopPlayer && f.stopPlayer(); f.select && f.select(0, false, true); out.carousels++; } }); } catch (e) {}
  try { document.querySelectorAll(".splide").forEach(function (el) { var s = el.splide; if (s) { try { s.Components.Autoplay.pause(); } catch (e) {} s.go(0); out.carousels++; } }); } catch (e) {}
  document.querySelectorAll("video").forEach(function (v) {
    try { v.removeAttribute("autoplay"); v.autoplay = false; v.pause(); v.preload = "none"; if (v.getAttribute("poster")) v.load(); else v.currentTime = 0; out.videos++; } catch (e) {}
  });
  var max = setTimeout(function () {}, 0);
  for (var i = 1; i <= max; i++) { clearTimeout(i); clearInterval(i); }
  out.timers = max;
  // short animations end in their final state; long or endless ones (an autoplay progress bar whose finish advances the
  // slide) stay at their start, like the long timers the init script never lets fire
  try { document.getAnimations().forEach(function (a) {
    try {
      var t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      var long = t && (t.iterations === Infinity || (typeof t.activeDuration === "number" && t.activeDuration >= 2500));
      if (long) { a.pause(); a.currentTime = 0; } else a.finish();
    } catch (e) { try { a.cancel(); } catch (e2) {} }
  }); } catch (e) {}
  window.scrollTo(0, 0);
  var all = Array.prototype.slice.call(document.body ? document.body.getElementsByTagName("*") : []);
  var fixed = [];
  for (var k = 0; k < all.length; k++) {
    var el = all[k], cs = getComputedStyle(el), pos = cs.position;
    if (pos === "sticky") { el.style.setProperty("position", "relative", "important"); el.style.setProperty("top", "auto", "important"); el.style.setProperty("bottom", "auto", "important"); el.setAttribute("data-cmp-was", "sticky"); out.sticky++; continue; }
    if (pos !== "fixed") continue;
    var r = el.getBoundingClientRect();
    // only fixed elements visible in the first viewport: off-canvas menus etc. stay fixed (they add no scroll overflow)
    if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth || cs.visibility === "hidden" || cs.opacity === "0") continue;
    var m = cs.transform && cs.transform !== "none" ? new DOMMatrix(cs.transform) : null;
    fixed.push({ el: el, top: r.top - (m ? m.m42 : 0), left: r.left - (m ? m.m41 : 0), w: r.width, h: r.height });
  }
  // pin each one where it sits at scroll 0 (document coordinates), so full-page shots show it once, in place
  fixed.forEach(function (f) {
    var s = f.el.style;
    s.setProperty("position", "absolute", "important");
    var p = f.el.offsetParent || document.documentElement, pr = p.getBoundingClientRect(), pcs = getComputedStyle(p);
    s.setProperty("top", (f.top - pr.top - (parseFloat(pcs.borderTopWidth) || 0)) + "px", "important");
    s.setProperty("left", (f.left - pr.left - (parseFloat(pcs.borderLeftWidth) || 0)) + "px", "important");
    s.setProperty("right", "auto", "important");
    s.setProperty("bottom", "auto", "important");
    s.setProperty("width", f.w + "px", "important");
    s.setProperty("height", f.h + "px", "important");
    s.setProperty("margin", "0", "important");
    s.setProperty("box-sizing", "border-box", "important");
    f.el.setAttribute("data-cmp-was", "fixed");
    out.fixed++;
  });
  await frames();
  return out;
})()`;

/** Browser context for one viewport — crawler's contextOptions + init script + host guard. */
/**
 * `mode.motion`: a visitor's browser instead of the screenshot routine — prefers-reduced-motion off, timers and
 * autoplay untouched (players start, carousels run). Same host guard. For probes, never for parity screenshots.
 */
export async function newCaptureContext(browser: Browser, viewport: ViewportSpec, opts: CaptureContextOptions = {}, mode: { motion?: boolean } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...contextOptions(viewport), ...(mode.motion ? { reducedMotion: "no-preference" as const } : {}) });
  await ctx.addInitScript({ content: INIT_JS });
  if (!mode.motion) {
    await ctx.addInitScript({ content: STILL_TIMERS_JS });
    await ctx.addInitScript({ content: PAUSE_AUTOPLAY_JS });
  }
  if (opts.allowHosts || opts.forbiddenHosts?.length) {
    const blocked = new Set<string>();
    (ctx as BrowserContext & { __cmpBlocked?: Set<string> }).__cmpBlocked = blocked;
    await ctx.route(
      (u) => !hostAllowed(u.toString(), opts),
      (route) => {
        blocked.add(new URL(route.request().url()).host);
        return route.abort("blockedbyclient");
      },
    );
  }
  await guardContext(ctx);
  return ctx;
}

/** Hosts blocked so far in a capture context (for the report). */
export function blockedHosts(ctx: BrowserContext): string[] {
  return [...((ctx as BrowserContext & { __cmpBlocked?: Set<string> }).__cmpBlocked ?? [])].sort();
}

export interface LoadInfo {
  status: number;
  images?: number;
  fonts?: string;
  freeze?: { carousels: number; videos: number; fixed: number; sticky: number; timers: number };
}

/** Navigate + settle + freeze (network idle, lazy images, fonts, timers/carousels/videos/fixed). Returns the HTTP status (0 on failure). */
export async function loadForCapture(page: Page, url: string, viewport: ViewportSpec): Promise<number> {
  return (await loadForCaptureInfo(page, url, viewport)).status;
}

export async function loadForCaptureInfo(page: Page, url: string, viewport: ViewportSpec): Promise<LoadInfo> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  let status = 0;
  try {
    const res = await page.goto(url, { waitUntil: CAPTURE_SETTINGS.waitUntil, timeout: CAPTURE_SETTINGS.navigationTimeoutMs });
    status = res?.status() ?? 0;
  } catch {
    const res = await page.goto(url, { waitUntil: CAPTURE_SETTINGS.fallbackWaitUntil, timeout: CAPTURE_SETTINGS.navigationTimeoutMs }).catch(() => null);
    status = res?.status() ?? 0;
  }
  const info: LoadInfo = { status };
  try {
    const s = (await page.evaluate(SETTLE_JS)) as { images: number; fonts: string };
    info.images = s.images;
    info.fonts = s.fonts;
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    // images inserted by the scroll pass (lazy loaders) — settle once more, cheap when nothing changed
    await page.evaluate(SETTLE_JS);
    info.freeze = (await page.evaluate(FREEZE_JS)) as LoadInfo["freeze"];
  } catch {
    /* page without a document (error page, download) */
  }
  await page.waitForTimeout(CAPTURE_SETTINGS.settleMs);
  return info;
}

/** Full-page screenshot: masked selectors (+ known consent banners) hidden via screenshotCss, animations off. */
export async function captureScreenshot(page: Page, url: string, viewport: ViewportSpec, opts: { mask?: string[]; skipLoad?: boolean } = {}): Promise<Buffer> {
  if (!opts.skipLoad) await loadForCapture(page, url, viewport);
  return page.screenshot({
    fullPage: CAPTURE_SETTINGS.fullPage,
    animations: CAPTURE_SETTINGS.animations,
    caret: CAPTURE_SETTINGS.caret,
    scale: "css",
    style: screenshotCss(opts.mask ?? []),
    type: "png",
    timeout: 60_000,
  });
}

export interface Box {
  selector: string;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Page-side box collector as a plain JS string: tsx/esbuild `keepNames` would otherwise wrap inner
 * functions in __name(), which does not exist inside the page.
 */
const COLLECT_BOXES_JS = `(cfg) => {
  var out = [];
  var masked = function (el) {
    for (var i = 0; i < cfg.mask.length; i++) { try { if (el.closest(cfg.mask[i])) return true; } catch (e) {} }
    return false;
  };
  var transparent = function (el) {
    for (var a = el; a && a.nodeType === 1; a = a.parentElement) if (parseFloat(getComputedStyle(a).opacity) < 0.01) return true;
    return false;
  };
  // fully clipped by an overflow:hidden/clip ancestor (collapsed menus, closed accordions, off-slide carousel items)
  var clipped = function (el, r) {
    var x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
    for (var a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      var cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible" && cs.clipPath === "none") continue;
      var ar = a.getBoundingClientRect();
      if (cs.overflowX !== "visible") { x1 = Math.max(x1, ar.left); x2 = Math.min(x2, ar.right); }
      if (cs.overflowY !== "visible") { y1 = Math.max(y1, ar.top); y2 = Math.min(y2, ar.bottom); }
      if (x2 - x1 < 1 || y2 - y1 < 1) return true;
    }
    return false;
  };
  for (var s = 0; s < cfg.selectors.length; s++) {
    var selector = cfg.selectors[s], els = [];
    try { els = Array.prototype.slice.call(document.querySelectorAll(selector)); } catch (e) { continue; }
    var index = 0;
    for (var k = 0; k < els.length; k++) {
      var el = els[k], r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || cs.display === "none" || masked(el) || transparent(el) || clipped(el, r)) continue;
      out.push({ selector: selector, index: index++, x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return out;
}`;

/** Document-space bounding boxes of visible key elements (outside masked regions). */
export async function collectBoxes(page: Page, selectors: string[], mask: string[] = []): Promise<Box[]> {
  return page.evaluate(`(${COLLECT_BOXES_JS})(${JSON.stringify({ selectors, mask })})`) as Promise<Box[]>;
}

// ------------------------------------------------------------------ component boxes (diff attribution)

/** A rendered element that can own a diff region: label = CSS-ish selector, component = nearest component-like ancestor-or-self. */
export interface ComponentBox {
  label: string;
  /** component-like (Drupal paragraph/block/region, BEM component class, landmark, data-component) */
  component: boolean;
  /** labels of component-like ancestors, outermost first */
  path: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

const COLLECT_COMPONENTS_JS = `(cfg) => {
  var re = new RegExp(cfg.componentClass);
  var pri = new RegExp(cfg.priorityClass);
  var label = function (el) {
    var t = el.tagName.toLowerCase();
    var dc = el.getAttribute("data-component") || el.getAttribute("data-cmp-component");
    if (dc) return t + '[data-component="' + dc + '"]';
    var id = el.id && !/^(edit-|[0-9a-f]{8,}|__)/i.test(el.id) && el.id.length < 40 ? "#" + el.id : "";
    var cls = (typeof el.className === "string" ? el.className : "").split(/\\s+/).filter(Boolean);
    var comp = cls.filter(function (c) { return re.test(c); });
    // most specific component class first (paragraph--type--x beats paragraph / field--item)
    comp.sort(function (a, b) { return (pri.test(b) ? 1 : 0) - (pri.test(a) ? 1 : 0); });
    var pick = (comp.length ? comp : id ? [] : cls).filter(function (c) { return c.length < 60 && !/^(js-|is-|has-|active|show|open|lazy|loaded)/.test(c); }).slice(0, 2);
    return t + (pick.length ? "." + pick.join(".") : "") + id;
  };
  var isComp = function (el) {
    if (el.getAttribute("data-component") || el.getAttribute("data-cmp-component")) return true;
    if (/^(HEADER|FOOTER|NAV|MAIN|ASIDE|SECTION|ARTICLE|FORM)$/.test(el.tagName)) return true;
    var cls = typeof el.className === "string" ? el.className : "";
    return cls.split(/\\s+/).some(function (c) { return re.test(c); });
  };
  var out = [];
  var walk = function (el, path, depth) {
    if (out.length > cfg.max || depth > 40) return;
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    if (cs.display === "none") return;
    if (parseFloat(cs.opacity) < 0.01) return;
    var comp = isComp(el);
    var l = label(el);
    if (r.width * r.height >= cfg.minArea && cs.visibility !== "hidden")
      out.push({ label: l, component: comp, path: path.slice(), x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
    var next = comp ? path.concat([l]) : path;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) walk(c, next, depth + 1);
  };
  if (document.body) for (var c0 = document.body.firstElementChild; c0; c0 = c0.nextElementSibling) walk(c0, [], 0);
  return out;
}`;

/**
 * Generic class-name prefixes that mark a "component" on Drupal sites and generated apps (no theme knowledge).
 * Theme-specific prefixes (e.g. DSU/Lightnest `dsu-c-`, `ln-c-`) come from `site.parity.componentClassPrefixes`
 * (theme pack / site yaml) via componentClassRe().
 */
export const GENERIC_COMPONENT_CLASS_PREFIXES = [
  "paragraph--type--",
  "block-",
  "region-",
  "node--type-",
  "view-",
  "views-",
  "field--name-",
  "layout-",
  "c-[a-z]",
  "site-",
  "header",
  "footer",
  "navbar",
  "nav-",
  "menu--",
  "hero",
  "card",
  "carousel",
  "slider",
  "accordion",
  "teaser",
  "banner",
  "cta",
];
/** Prefixes that win the label of a multi-class element (most specific component class first). */
export const GENERIC_PRIORITY_CLASS_PREFIXES = ["paragraph--type--"];

const escRe = (s: string) => s.replace(/[.*+?^${}()|\\]/g, (m) => (m === "[" || m === "]" ? m : "\\" + m));
/** Component class regex source: generic prefixes + the theme's (`extra`, plain prefixes, regex-escaped). */
export function componentClassRe(extra: string[] = []): string {
  return `^(${[...GENERIC_COMPONENT_CLASS_PREFIXES, ...extra.map(escRe)].join("|")})`;
}
/** Priority regex: paragraph types + the theme's prefixes. */
export function priorityClassRe(extra: string[] = []): string {
  return `^(${[...GENERIC_PRIORITY_CLASS_PREFIXES, ...extra.map(escRe)].join("|")})`;
}
/** Generic default (no theme prefixes). */
export const COMPONENT_CLASS_RE = componentClassRe();

export async function collectComponentBoxes(page: Page, opts: { minArea?: number; max?: number; classPrefixes?: string[] } = {}): Promise<ComponentBox[]> {
  const cfg = { componentClass: componentClassRe(opts.classPrefixes), priorityClass: priorityClassRe(opts.classPrefixes), minArea: opts.minArea ?? 64, max: opts.max ?? 8000 };
  return page.evaluate(`(${COLLECT_COMPONENTS_JS})(${JSON.stringify(cfg)})`) as Promise<ComponentBox[]>;
}

export interface BoxDiff {
  selector: string;
  index: number;
  old?: Box;
  new?: Box;
  delta: number; // max |dx|,|dy|,|dw|,|dh|; Infinity when missing on one side
}

export function compareBoxes(oldBoxes: Box[], newBoxes: Box[]): { maxDelta: number; diffs: BoxDiff[]; compared: number } {
  const key = (b: Box) => `${b.selector}#${b.index}`;
  const nm = new Map(newBoxes.map((b) => [key(b), b]));
  const om = new Map(oldBoxes.map((b) => [key(b), b]));
  const diffs: BoxDiff[] = [];
  let maxDelta = 0;
  let compared = 0;
  for (const o of oldBoxes) {
    const n = nm.get(key(o));
    if (!n) {
      diffs.push({ selector: o.selector, index: o.index, old: o, delta: Infinity });
      maxDelta = Infinity;
      continue;
    }
    compared++;
    const d = Math.max(Math.abs(o.x - n.x), Math.abs(o.y - n.y), Math.abs(o.w - n.w), Math.abs(o.h - n.h));
    if (d > maxDelta) maxDelta = d;
    if (d > 0) diffs.push({ selector: o.selector, index: o.index, old: o, new: n, delta: d });
  }
  for (const n of newBoxes)
    if (!om.has(key(n))) {
      diffs.push({ selector: n.selector, index: n.index, new: n, delta: Infinity });
      maxDelta = Infinity;
    }
  diffs.sort((a, b) => b.delta - a.delta || (a.old?.y ?? a.new?.y ?? 0) - (b.old?.y ?? b.new?.y ?? 0));
  return { maxDelta, diffs, compared };
}

function pad(img: PNG, w: number, h: number): PNG {
  if (img.width === w && img.height === h) return img;
  const out = new PNG({ width: w, height: h });
  const [r, g, b, a] = CAPTURE_SETTINGS.padColor;
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
    out.data[i + 3] = a;
  }
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

export interface DiffRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** diff pixels inside the region */
  pixels: number;
  /** share of all diff pixels of the page */
  share: number;
}

export interface ImageCompare {
  parity: number;
  diffPixels: number;
  width: number;
  height: number;
  oldSize: { width: number; height: number };
  newSize: { width: number; height: number };
  diffPng: Buffer;
  /** diff clusters, largest first (document coordinates) */
  regions: DiffRegion[];
  /** 1 = differing pixel (row-major, width × height) — for band attribution */
  mask: Uint8Array;
}

const DIFF_COLOR: [number, number, number] = [255, 0, 0];

/**
 * Cluster diff pixels: grid cells of `cell` px with ≥ minCellPixels diff pixels, 8-connected after closing gaps of
 * `gapCells` cells. Deterministic (row-major scan).
 */
export function diffRegions(mask: Uint8Array, w: number, h: number, total: number, o = CAPTURE_SETTINGS.regions): DiffRegion[] {
  if (!total) return [];
  const cw = Math.ceil(w / o.cell);
  const ch = Math.ceil(h / o.cell);
  const counts = new Uint32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const crow = Math.floor(y / o.cell) * cw;
    for (let x = 0; x < w; x++) if (mask[row + x]) counts[crow + Math.floor(x / o.cell)]++;
  }
  const hot = new Uint8Array(cw * ch);
  for (let i = 0; i < counts.length; i++) if (counts[i] >= o.minCellPixels) hot[i] = 1;
  const label = new Int32Array(cw * ch).fill(-1);
  const regions: Array<DiffRegion & { x2: number; y2: number }> = [];
  const g = o.gapCells;
  for (let cy = 0; cy < ch; cy++)
    for (let cx = 0; cx < cw; cx++) {
      const i0 = cy * cw + cx;
      if (!hot[i0] || label[i0] !== -1) continue;
      const id = regions.length;
      const r = { x: cx, y: cy, x2: cx, y2: cy, w: 0, h: 0, pixels: 0, share: 0 };
      regions.push(r);
      const stack = [i0];
      label[i0] = id;
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % cw;
        const y = (i - x) / cw;
        r.pixels += counts[i];
        if (x < r.x) r.x = x;
        if (x > r.x2) r.x2 = x;
        if (y < r.y) r.y = y;
        if (y > r.y2) r.y2 = y;
        for (let dy = -g - 1; dy <= g + 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= ch) continue;
          for (let dx = -g - 1; dx <= g + 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= cw) continue;
            const j = ny * cw + nx;
            if (hot[j] && label[j] === -1) {
              label[j] = id;
              stack.push(j);
            }
          }
        }
      }
    }
  return regions
    .map((r) => {
      const x = r.x * o.cell;
      const y = r.y * o.cell;
      return { x, y, w: Math.min(w, (r.x2 + 1) * o.cell) - x, h: Math.min(h, (r.y2 + 1) * o.cell) - y, pixels: r.pixels, share: Math.round((r.pixels / total) * 1e4) / 1e4 };
    })
    .filter((r) => r.pixels > 0)
    .sort((a, b) => b.pixels - a.pixels || a.y - b.y || a.x - b.x);
}

/** Outline regions on a diff PNG (2 px, blue), in place. */
function outline(img: PNG, regions: DiffRegion[]) {
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    img.data[i] = 0;
    img.data[i + 1] = 90;
    img.data[i + 2] = 255;
    img.data[i + 3] = 255;
  };
  for (const r of regions)
    for (let t = 0; t < 2; t++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        put(x, r.y + t);
        put(x, r.y + r.h - 1 - t);
      }
      for (let y = r.y; y < r.y + r.h; y++) {
        put(r.x + t, y);
        put(r.x + r.w - 1 - t, y);
      }
    }
}

/** pixelmatch after padding both images to the max size; parity = 1 - diff/(w*h). Diff clusters outlined in blue. */
export function compareImages(oldPng: Buffer, newPng: Buffer): ImageCompare {
  const a = PNG.sync.read(oldPng);
  const b = PNG.sync.read(newPng);
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const pa = pad(a, w, h);
  const pb = pad(b, w, h);
  const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(pa.data, pb.data, diff.data, w, h, { ...CAPTURE_SETTINGS.pixelmatch, diffColor: DIFF_COLOR });
  // pixelmatch paints diff pixels pure red; unchanged pixels are grey (r=g=b), anti-aliasing yellow
  const mask = new Uint8Array(w * h);
  if (diffPixels)
    for (let i = 0, p = 0; p < mask.length; i += 4, p++)
      if (diff.data[i] === DIFF_COLOR[0] && diff.data[i + 1] === DIFF_COLOR[1] && diff.data[i + 2] === DIFF_COLOR[2]) mask[p] = 1;
  const regions = diffRegions(mask, w, h, diffPixels);
  outline(diff, regions.slice(0, CAPTURE_SETTINGS.regions.max));
  return {
    parity: 1 - diffPixels / (w * h),
    diffPixels,
    width: w,
    height: h,
    oldSize: { width: a.width, height: a.height },
    newSize: { width: b.width, height: b.height },
    diffPng: PNG.sync.write(diff),
    regions,
    mask,
  };
}

export interface AttributedRegion extends DiffRegion {
  /** nearest component-like element on the old page (falls back to the new page when nothing on old covers it) */
  component: string;
  /** component chain, outermost first */
  componentPath: string[];
  /** smallest element of any kind covering the region centre (precise hint) */
  element?: string;
  /** component on the new page at the same spot, when it differs */
  newComponent?: string;
}

const overlap = (r: DiffRegion, b: ComponentBox) => {
  const x = Math.max(0, Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x));
  const y = Math.max(0, Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y));
  return x * y;
};

function owner(r: DiffRegion, boxes: ComponentBox[], componentOnly: boolean): ComponentBox | undefined {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const area = r.w * r.h;
  let best: ComponentBox | undefined;
  let bestScore = -Infinity;
  for (const b of boxes) {
    if (componentOnly && !b.component) continue;
    const ov = overlap(r, b);
    if (!ov) continue;
    const contains = cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
    // must cover most of the region (or its centre); among those prefer the tightest box
    const cover = ov / area;
    if (cover < 0.5 && !contains) continue;
    const score = cover * 2 - Math.log10(1 + (b.w * b.h) / Math.max(1, area));
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

/** Map diff regions to the component (selector) that owns them. */
export function attributeRegions(regions: DiffRegion[], oldBoxes: ComponentBox[], newBoxes: ComponentBox[] = []): AttributedRegion[] {
  return regions.map((r) => {
    const o = owner(r, oldBoxes, true);
    const n = owner(r, newBoxes, true);
    const el = owner(r, oldBoxes, false) ?? owner(r, newBoxes, false);
    const main = o ?? n;
    const out: AttributedRegion = { ...r, component: main?.label ?? "(page background / outside any element)", componentPath: main ? [...main.path, main.label] : [] };
    if (el && el.label !== main?.label) out.element = el.label;
    if (o && n && n.label !== o.label) out.newComponent = n.label;
    return out;
  });
}

/** diff pixels and their x-extent inside [x0,x1) × [y0,y1) */
function sliceStats(mask: Uint8Array, w: number, x0: number, x1: number, y0: number, y1: number) {
  let pixels = 0;
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++)
      if (mask[row + x]) {
        pixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  }
  return { pixels, minX, maxX, minY, maxY };
}

/**
 * Attribution that survives vertical shifts: clusters taller than `band` px (a shift turns everything below it into
 * one blob) are cut into bands, each band is attributed to its tightest component, and neighbouring bands with the
 * same owner are merged again. Largest first.
 */
export function attributeDiff(
  cmp: Pick<ImageCompare, "mask" | "width" | "height" | "regions" | "diffPixels">,
  oldBoxes: ComponentBox[],
  newBoxes: ComponentBox[],
  band = 900,
  max = CAPTURE_SETTINGS.regions.max,
): AttributedRegion[] {
  const { mask, width: w, diffPixels } = cmp;
  const pieces: DiffRegion[] = [];
  for (const r of cmp.regions) {
    if (r.h <= band) {
      pieces.push(r);
      continue;
    }
    for (let y = r.y; y < r.y + r.h; y += band) {
      const st = sliceStats(mask, w, r.x, r.x + r.w, y, Math.min(r.y + r.h, y + band));
      if (!st.pixels) continue;
      pieces.push({ x: st.minX, y: st.minY, w: st.maxX - st.minX + 1, h: st.maxY - st.minY + 1, pixels: st.pixels, share: diffPixels ? st.pixels / diffPixels : 0 });
    }
  }
  const att = attributeRegions(pieces, oldBoxes, newBoxes).sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: AttributedRegion[] = [];
  for (const a of att) {
    const prev = merged.find((m) => m.component === a.component && m.newComponent === a.newComponent && a.y <= m.y + m.h + band / 4);
    if (!prev) {
      merged.push({ ...a });
      continue;
    }
    const x = Math.min(prev.x, a.x);
    const y = Math.min(prev.y, a.y);
    prev.w = Math.max(prev.x + prev.w, a.x + a.w) - x;
    prev.h = Math.max(prev.y + prev.h, a.y + a.h) - y;
    prev.x = x;
    prev.y = y;
    prev.pixels += a.pixels;
    if (prev.element !== a.element) prev.element = undefined;
  }
  for (const m of merged) m.share = diffPixels ? Math.round((m.pixels / diffPixels) * 1e4) / 1e4 : 0;
  return merged.sort((a, b) => b.pixels - a.pixels || a.y - b.y).slice(0, max);
}

/** Topmost place where the pages differ (first rows with ≥ minPixels diff pixels), attributed to its tightest component. */
export function firstDivergence(
  cmp: Pick<ImageCompare, "mask" | "width" | "height" | "diffPixels">,
  oldBoxes: ComponentBox[],
  newBoxes: ComponentBox[],
  minPixels = 4,
): AttributedRegion | undefined {
  const { mask, width: w, height: h } = cmp;
  if (!cmp.diffPixels) return undefined;
  for (let y = 0; y < h; y += 4) {
    const st = sliceStats(mask, w, 0, w, y, Math.min(h, y + 4));
    if (st.pixels < minPixels) continue;
    const blk = sliceStats(mask, w, 0, w, y, Math.min(h, y + 48));
    const r: DiffRegion = { x: blk.minX, y: blk.minY, w: blk.maxX - blk.minX + 1, h: blk.maxY - blk.minY + 1, pixels: blk.pixels, share: blk.pixels / cmp.diffPixels };
    return attributeRegions([r], oldBoxes, newBoxes)[0];
  }
  return undefined;
}
