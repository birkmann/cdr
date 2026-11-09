/**
 * Parity diagnosis dossier (docs/DEEPSEEK_ONLY_PLAN.md §5.6.1) — deterministic, TEXT ONLY.
 *
 * For one failing shot (URL × viewport) both pages are loaded with the verify capture routine, their element trees
 * are snapshotted (tag, id, classes, data-* keys, a few attributes, bbox, a compact style signature, own text LENGTH —
 * never the text), and walked in document order to find the first divergence. For that element and its ancestors up
 * to the component root we diff the computed style, look up the matched CSS rules on both sides (CDP
 * `CSS.getMatchedStylesForNode`), diff attributes, skeletonise the component subtree, list the page's stylesheet /
 * script sets, console errors and failed requests. A rule-based classifier labels the likely cause:
 * MARKUP | CSS_MISSING | CSS_ORDER | ASSET | SCRIPT | CONTENT | DYNAMIC (+ UNKNOWN when nothing explains it).
 *
 * The instability self-test captures the ORIGINAL twice; regions/elements that differ between the two captures are
 * DYNAMIC — the only evidence a mask may ever be proposed with.
 *
 * Privacy (guard rail 3): the dossier never contains page text — text nodes become "…" / a length, alt/title/aria/
 * placeholder/value/content attributes are dropped, data-* values only when they look like ids. Unit-tested.
 */
import { launchChromium } from "@harness/mirror-core";
import type { Browser, CDPSession, Page } from "playwright";
import { captureScreenshot, compareImages, componentClassRe, loadForCaptureInfo, newCaptureContext, priorityClassRe, type CaptureContextOptions, type DiffRegion, type LoadInfo, type ViewportSpec } from "./capture.js";

// ------------------------------------------------------------------ snapshot (page side)

/** One element of the snapshot (compact keys: the snapshot of a big page has ~5–10k nodes). */
export interface SnapNode {
  i: number;
  /** parent index (-1 = body child) */
  p: number;
  d: number;
  tag: string;
  id?: string;
  cls: string[];
  /** data-* keys (values only when id-like) */
  data?: Record<string, string>;
  /** selected attributes: src, data-src, srcset (length), href, type, role, style (inline style text), width/height */
  a?: Record<string, string>;
  x: number;
  y: number;
  w: number;
  h: number;
  /** "none" | "hidden" | "transparent" when not rendered visibly */
  vis?: string;
  /** own (direct) text length, trimmed */
  t: number;
  /** total text length of the subtree */
  tt: number;
  /** component-like element (landmark, data-component, component class) */
  comp?: 1;
  /** inside a masked region */
  m?: 1;
  /** compact visual style signature (font, colour, decoration, display…) */
  sh: string;
  /** img: natural size + whether the current source is a data: URI */
  img?: { nw: number; nh: number; cur: string; done: boolean };
  ch: number[];
}

export interface PageSnapshot {
  nodes: SnapNode[];
  truncated: boolean;
  height: number;
  /** href (path) of linked sheets, "inline:<hash>" for <style> elements (+ their first selectors) */
  stylesheets: { href: string; media?: string; disabled?: boolean; rules?: number; owner: string; selectors?: string[] }[];
  /** stylesheet hrefs declared only inside <noscript> (not loaded with JS on) */
  noscriptStylesheets: string[];
  scripts: { src: string; async?: boolean; defer?: boolean; type?: string; placement: "head" | "body" }[];
  inlineScripts: number;
}

/** keep in sync with the classifier: computed properties diffed for the divergent chain */
export const STYLE_PROPS = [
  "display",
  "position",
  "top",
  "left",
  "right",
  "bottom",
  "float",
  "clear",
  "box-sizing",
  "width",
  "height",
  "min-height",
  "max-height",
  "min-width",
  "max-width",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-bottom-width",
  "border-left-width",
  "border-right-width",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "text-align",
  "text-decoration-line",
  "text-decoration-style",
  "white-space",
  "vertical-align",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "justify-content",
  "grid-template-columns",
  "column-gap",
  "row-gap",
  "overflow-x",
  "overflow-y",
  "transform",
  "visibility",
  "opacity",
  "z-index",
  "color",
  "background-color",
  "background-image",
  "object-fit",
  "aspect-ratio",
];

const SNAPSHOT_JS = `(cfg) => {
  var re = new RegExp(cfg.componentClass);
  var nodes = [];
  var els = [];
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1, BASE: 1, TITLE: 1, HEAD: 1 };
  var idLike = /^[\\w:.\\/#-]{1,60}$/;
  var masked = function (el) {
    for (var i = 0; i < cfg.mask.length; i++) { try { if (el.closest(cfg.mask[i])) return true; } catch (e) {} }
    return false;
  };
  var shortUrl = function (v) {
    if (!v) return v;
    if (v.indexOf("data:") === 0) return v.slice(0, v.indexOf(",") > 0 ? Math.min(v.indexOf(","), 40) : 30) + ",…";
    try { var u = new URL(v, location.href); if (u.origin === location.origin) v = u.pathname + (u.search.length > 40 ? "?…" : u.search); } catch (e) {}
    return v.length > 160 ? v.slice(0, 160) + "…" : v;
  };
  var isComp = function (el, cls) {
    if (el.getAttribute("data-component") || el.getAttribute("data-cmp-component")) return true;
    if (/^(HEADER|FOOTER|NAV|MAIN|ASIDE|SECTION|ARTICLE|FORM)$/.test(el.tagName)) return true;
    for (var i = 0; i < cls.length; i++) if (re.test(cls[i])) return true;
    return false;
  };
  var walk = function (el, parent, depth) {
    if (nodes.length >= cfg.max || depth > 60) return -1;
    if (SKIP[el.tagName]) return -1;
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var cls = (typeof el.className === "string" ? el.className : (el.getAttribute("class") || "")).split(/\\s+/).filter(Boolean);
    var t = 0;
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) t += c.nodeValue.trim().length;
    var n = { i: nodes.length, p: parent, d: depth, tag: el.tagName.toLowerCase(), cls: cls, x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), t: t, tt: 0, ch: [] };
    if (el.id) n.id = el.id;
    var data = null, a = null;
    for (var k = 0; k < el.attributes.length; k++) {
      var at = el.attributes[k], name = at.name, v = at.value;
      if (name.indexOf("data-") === 0) {
        if (name === "data-src" || name === "data-srcset") continue;
        data = data || {};
        data[name] = idLike.test(v) ? v : (v ? "…" : "");
      }
    }
    var pick = function (name, val) { if (val === null || val === undefined) return; a = a || {}; a[name] = val; };
    pick("src", el.getAttribute("src") !== null ? shortUrl(el.getAttribute("src")) : null);
    pick("data-src", el.getAttribute("data-src") !== null ? shortUrl(el.getAttribute("data-src")) : null);
    if (el.getAttribute("srcset") !== null) pick("srcset", "[" + el.getAttribute("srcset").split(",").length + " candidates]");
    if (el.getAttribute("data-srcset") !== null) pick("data-srcset", "[" + el.getAttribute("data-srcset").split(",").length + " candidates]");
    if (el.tagName === "A" || el.tagName === "LINK") pick("href", el.getAttribute("href") !== null ? shortUrl(el.getAttribute("href")) : null);
    pick("type", el.getAttribute("type"));
    pick("role", el.getAttribute("role"));
    pick("loading", el.getAttribute("loading"));
    if (el.getAttribute("style") !== null) pick("style", el.getAttribute("style").replace(/url\\([^)]*\\)/g, "url(…)").slice(0, 240));
    if (el.getAttribute("width") !== null) pick("width", el.getAttribute("width").slice(0, 12));
    if (el.getAttribute("height") !== null) pick("height", el.getAttribute("height").slice(0, 12));
    if (el.getAttribute("hidden") !== null) pick("hidden", "");
    if (data) n.data = data;
    if (a) n.a = a;
    if (cs.display === "none") n.vis = "none";
    else if (cs.visibility === "hidden") n.vis = "hidden";
    else if (parseFloat(cs.opacity) < 0.01) n.vis = "transparent";
    if (isComp(el, cls)) n.comp = 1;
    if (cfg.mask.length && masked(el)) n.m = 1;
    n.sh = [cs.display, cs.position, cs.fontFamily.split(",")[0].replace(/["']/g, "").trim(), cs.fontSize, cs.fontWeight, cs.fontStyle, cs.lineHeight, cs.color, cs.backgroundColor, cs.textDecorationLine, cs.textTransform, cs.opacity, cs.visibility].join("|");
    if (el.tagName === "IMG") n.img = { nw: el.naturalWidth, nh: el.naturalHeight, cur: shortUrl(el.currentSrc || ""), done: !!el.complete };
    nodes.push(n);
    els.push(el);
    if (el.tagName !== "svg" && el.tagName !== "SVG" && el.tagName !== "SELECT" && el.tagName !== "IFRAME") {
      for (var ch = el.firstElementChild; ch; ch = ch.nextElementSibling) {
        var ci = walk(ch, n.i, depth + 1);
        if (ci >= 0) n.ch.push(ci);
      }
    }
    return n.i;
  };
  var top = [];
  if (document.body) for (var c0 = document.body.firstElementChild; c0; c0 = c0.nextElementSibling) { var ti = walk(c0, -1, 0); if (ti >= 0) top.push(ti); }
  for (var q = nodes.length - 1; q >= 0; q--) { nodes[q].tt += nodes[q].t; if (nodes[q].p >= 0) nodes[nodes[q].p].tt += nodes[q].tt; }
  window.__cmpDiagNodes = els;
  var sheets = [];
  for (var s = 0; s < document.styleSheets.length; s++) {
    var sh = document.styleSheets[s], owner = sh.ownerNode ? sh.ownerNode.tagName.toLowerCase() : "?";
    var rules, list = null; try { list = sh.cssRules; rules = list.length; } catch (e) { rules = undefined; }
    if (owner === "style" && sh.ownerNode.hasAttribute("data-cmp-freeze")) continue;
    var href = sh.href ? shortUrl(sh.href) : null, sels;
    if (!href) {
      // inline <style>: keyed by a hash of its CSSOM text (same CSS → same key on both sides); selectors only, no values
      var txt = "", h = 5381;
      sels = [];
      if (list) for (var q = 0; q < list.length; q++) { txt += list[q].cssText; if (sels.length < 6 && list[q].selectorText) sels.push(list[q].selectorText.slice(0, 80)); }
      for (var c = 0; c < txt.length; c++) h = ((h << 5) + h + txt.charCodeAt(c)) >>> 0;
      href = "inline:" + h.toString(16);
    }
    sheets.push({ href: href, media: sh.media && sh.media.mediaText ? sh.media.mediaText : undefined, disabled: sh.disabled || undefined, rules: rules, owner: owner, selectors: sels });
  }
  var noscript = [];
  document.querySelectorAll("noscript").forEach(function (ns) {
    var m, rx = /href=["']([^"']+\\.css[^"']*)["']/g, txt = ns.textContent || "";
    while ((m = rx.exec(txt))) noscript.push(shortUrl(m[1]));
  });
  var scripts = [], inline = 0;
  document.querySelectorAll("script").forEach(function (sc) {
    if (!sc.src) { inline++; return; }
    scripts.push({ src: shortUrl(sc.getAttribute("src")), async: sc.async || undefined, defer: sc.defer || undefined, type: sc.type || undefined, placement: sc.closest("head") ? "head" : "body" });
  });
  return { nodes: nodes, top: top, truncated: nodes.length >= cfg.max, height: document.documentElement.scrollHeight, stylesheets: sheets, noscriptStylesheets: noscript, scripts: scripts, inlineScripts: inline };
}`;

const STYLE_JS = `(cfg) => {
  var out = [];
  var els = window.__cmpDiagNodes || [];
  for (var i = 0; i < cfg.idx.length; i++) {
    var el = els[cfg.idx[i]], o = {};
    if (el) { var cs = getComputedStyle(el); for (var k = 0; k < cfg.props.length; k++) { var v = cs.getPropertyValue(cfg.props[k]); o[cfg.props[k]] = v.replace(/url\\((["']?)data:[^)]*\\)/g, "url(data:…)").replace(/url\\((["']?)[^)"']*\\/([^/)"']+)\\1\\)/g, "url($2)").slice(0, 160); } }
    out.push(o);
  }
  return out;
}`;

// ------------------------------------------------------------------ capture of one side

export interface SideCapture {
  url: string;
  status: number;
  load: LoadInfo;
  snapshot: PageSnapshot;
  png: Buffer;
  consoleErrors: string[];
  failedRequests: { url: string; status: number | string; type: string }[];
  page: Page;
}

const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + "…" : s);
const ERROR_VOCAB = new Set(
  "pageerror is not defined a function cannot read set properties property of undefined null failed to load resource the server responded with status uncaught unexpected token in json at position reading invalid or missing failed: net:: blocked by client refused execute script because its mime type and strict checking enabled".split(" "),
);
/**
 * Console messages may quote page strings: keep only code-like tokens (Error names, identifiers with . _ ( ) $ or
 * camelCase, URLs/paths, numbers), the identifier before "is not defined / a function", and a small vocabulary of JS
 * error phrases; every other word becomes "…" (unit-tested: no page text in a dossier).
 */
export function scrubMsg(s: string): string {
  const keep = new Set<string>();
  for (const m of s.matchAll(/(\S+) is not (?:defined|a function)/g)) keep.add(m[1]);
  const out = s
    .replace(/(["'`])(?:(?!\1).){12,}\1/g, "$1…$1")
    .split(/\s+/)
    .map((w) => (keep.has(w) || /^[A-Z][A-Za-z]*(Error|Exception):?$/.test(w) || /[./_()$[\]=#@]|^\d|^[a-z]+[A-Z]|^https?:/.test(w) || ERROR_VOCAB.has(w.toLowerCase().replace(/[,.;:]$/, "")) || w === "…" ? w : "…"))
    .join(" ")
    .replace(/(… ){2,}/g, "… ");
  return clip(out, 220);
}
const shortPath = (u: string, origin?: string) => {
  try {
    const x = new URL(u);
    const q = x.search.length > 40 ? "?…" : x.search;
    return origin && x.origin === origin ? x.pathname + q : clip(x.origin + x.pathname + q, 160);
  } catch {
    return clip(u, 160);
  }
};

export interface DiagnoseOptions {
  oldUrl: string;
  newUrl: string;
  viewport: ViewportSpec;
  mask?: string[];
  capture?: CaptureContextOptions;
  /** bbox tolerance for the divergence walk (px, default 2) */
  tolerancePx?: number;
  /** capture the original twice (instability self-test, default true) */
  instability?: boolean;
  /** theme component class prefixes (site.parity.componentClassPrefixes) */
  componentClassPrefixes?: string[];
  maxNodes?: number;
  /** CDP matched CSS rules (default true) */
  matchedRules?: boolean;
}

async function captureSide(browser: Browser, url: string, o: DiagnoseOptions): Promise<SideCapture & { close(): Promise<void> }> {
  const ctx = await newCaptureContext(browser, o.viewport, o.capture ?? {});
  const page = await ctx.newPage();
  const origin = new URL(url).origin;
  const consoleErrors: string[] = [];
  const failedRequests: SideCapture["failedRequests"] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/BLOCKED_BY_CLIENT/i.test(m.text())) consoleErrors.push(scrubMsg(m.text()));
  });
  page.on("pageerror", (e) => consoleErrors.push(scrubMsg(`pageerror: ${e.message}`)));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "failed";
    if (!/BLOCKED_BY_CLIENT|blockedbyclient|ERR_ABORTED/i.test(f)) failedRequests.push({ url: shortPath(r.url(), origin), status: f, type: r.resourceType() });
  });
  page.on("response", (r) => {
    if (r.status() >= 400) failedRequests.push({ url: shortPath(r.url(), origin), status: r.status(), type: r.request().resourceType() });
  });
  const load = await loadForCaptureInfo(page, url, o.viewport);
  const cfg = { componentClass: componentClassRe(o.componentClassPrefixes), priorityClass: priorityClassRe(o.componentClassPrefixes), mask: o.mask ?? [], max: o.maxNodes ?? 12000 };
  const snapshot = (await page.evaluate(`(${SNAPSHOT_JS})(${JSON.stringify(cfg)})`)) as PageSnapshot & { top: number[] };
  const png = await captureScreenshot(page, url, o.viewport, { mask: o.mask, skipLoad: true });
  return { url, status: load.status, load, snapshot, png, consoleErrors: [...new Set(consoleErrors)].sort(), failedRequests: dedupeReq(failedRequests), page, close: () => ctx.close().catch(() => undefined) };
}

function dedupeReq(list: SideCapture["failedRequests"]) {
  const seen = new Set<string>();
  return list.filter((r) => (seen.has(r.url + r.status) ? false : (seen.add(r.url + r.status), true))).sort((a, b) => a.url.localeCompare(b.url));
}

// ------------------------------------------------------------------ matching + divergence (pure)

const STATE_CLASS = /^(js-|is-|has-|active$|show$|open$|in$|collapsed$|collapse$|lazy|loaded$|b-loaded$|b-error$|slick-(active|current|cloned|initialized|slider|list|track|slide|dotted|visible)|swiper-(slide-(active|next|prev|visible|duplicate)|initialized|horizontal|vertical|backface-hidden|pointer-events|watch-progress)|aos-|animate|fade$|visible$|hidden$)/;
/** matching signature: tag + stable id + stable classes (state classes set by scripts are ignored) */
export function signature(n: Pick<SnapNode, "tag" | "id" | "cls">): string {
  const id = n.id && !/^(edit-|[0-9a-f]{8,}|__|swiper-wrapper-|slick-slide)/i.test(n.id) && !/\d{4,}/.test(n.id) ? `#${n.id}` : "";
  const cls = n.cls.filter((c) => !STATE_CLASS.test(c) && c.length < 60).slice().sort().slice(0, 4);
  return n.tag + id + (cls.length ? "." + cls.join(".") : "");
}

/** Human label (selector-ish) for a node. */
export function nodeLabel(n: Pick<SnapNode, "tag" | "id" | "cls">): string {
  const cls = n.cls.filter((c) => !STATE_CLASS.test(c) && c.length < 60).slice(0, 3);
  return n.tag + (n.id && n.id.length < 48 ? `#${n.id}` : "") + (cls.length ? "." + cls.join(".") : "");
}

/** LCS alignment of two signature sequences → pairs (index or -1 on the side without a match), in document order. */
export function alignChildren(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  if (m * n > 250_000) {
    // very wide lists (logo walls): greedy by signature
    const out: Array<[number, number]> = [];
    let j = 0;
    for (let i = 0; i < m; i++) {
      let k = j;
      while (k < n && b[k] !== a[i] && k - j < 50) k++;
      if (k < n && b[k] === a[i]) {
        for (; j < k; j++) out.push([-1, j]);
        out.push([i, k]);
        j = k + 1;
      } else out.push([i, -1]);
    }
    for (; j < n; j++) out.push([-1, j]);
    return out;
  }
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push([i++, j++]);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push([i++, -1]);
    else out.push([-1, j++]);
  }
  for (; i < m; i++) out.push([i, -1]);
  for (; j < n; j++) out.push([-1, j]);
  // unmatched old+new neighbours with the same tag → treat as a changed pair (class change, not add+remove)
  const merged: Array<[number, number]> = [];
  for (let k = 0; k < out.length; k++) {
    const cur = out[k];
    const nx = out[k + 1];
    if (nx && cur[1] === -1 && nx[0] === -1 && a[cur[0]].split(/[#.]/)[0] === b[nx[1]].split(/[#.]/)[0]) {
      merged.push([cur[0], nx[1]]);
      k++;
    } else merged.push(cur);
  }
  return merged;
}

export interface BoxDelta {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}
const delta = (o: SnapNode, n: SnapNode): BoxDelta => ({ dx: n.x - o.x, dy: n.y - o.y, dw: n.w - o.w, dh: n.h - o.h });
const maxAbs = (d: BoxDelta) => Math.max(Math.abs(d.dx), Math.abs(d.dy), Math.abs(d.dw), Math.abs(d.dh));
const visible = (n: SnapNode) => !n.vis && n.w > 0 && n.h > 0;

export type DivergenceKind = "box" | "missing" | "extra" | "visibility" | "structure" | "style" | "text" | "attribute";

export interface Divergence {
  kind: DivergenceKind;
  /** old-side node (missing: the missing element; extra: the old parent) */
  old?: SnapNode;
  /** new-side node (extra: the extra element; missing: the new parent) */
  new?: SnapNode;
  delta?: BoxDelta;
  /** component-like ancestors (labels), outermost first */
  componentPath: string[];
  /** structural signature path from body */
  path: string[];
}

interface Ctx {
  o: SnapNode[];
  n: SnapNode[];
  tol: number;
  unstable: Set<number>;
  /** pixel-diff regions: the detail pass only reports elements that intersect one */
  regions?: { x: number; y: number; w: number; h: number }[];
}

const hits = (n: SnapNode, regions: Ctx["regions"], pad = 4) =>
  !regions || regions.some((r) => n.x - pad < r.x + r.w && n.x + n.w + pad > r.x && n.y - pad < r.y + r.h && n.y + n.h + pad > r.y);

const children = (nodes: SnapNode[], idx: number[]) => idx.map((i) => nodes[i]);

function chain(nodes: SnapNode[], n: SnapNode | undefined): SnapNode[] {
  const out: SnapNode[] = [];
  for (let c = n; c; c = c.p >= 0 ? nodes[c.p] : undefined) out.unshift(c);
  return out;
}

/** Topmost-first walk: first visible pair whose box differs > tol (then descend to the most specific cause). */
function boxWalk(cx: Ctx, oIdx: number[], nIdx: number[]): Divergence | undefined {
  const oc = children(cx.o, oIdx);
  const nc = children(cx.n, nIdx);
  const pairs = alignChildren(oc.map(signature), nc.map(signature));
  // candidates in document (y) order: a sibling that moved because an earlier sibling grew comes after it anyway.
  // A pair that only MOVED (same size) is a consequence, not a cause: remember the first one and keep looking for a
  // resized / missing / extra element; only when none exists is the first moved element reported (e.g. a margin change).
  let firstShift: Divergence | undefined;
  for (const [i, j] of pairs) {
    const o = i >= 0 ? oc[i] : undefined;
    const n = j >= 0 ? nc[j] : undefined;
    if (o && cx.unstable.has(o.i)) continue;
    if (o?.m || n?.m) continue;
    if (o && !n) {
      if (visible(o)) return { kind: "missing", old: o, componentPath: [], path: [] };
      continue;
    }
    if (n && !o) {
      if (visible(n)) return { kind: "extra", new: n, componentPath: [], path: [] };
      continue;
    }
    if (!o || !n) continue;
    if (visible(o) !== visible(n)) return { kind: "visibility", old: o, new: n, delta: delta(o, n), componentPath: [], path: [] };
    if (!visible(o)) continue;
    const d = delta(o, n);
    if (maxAbs(d) > cx.tol && Math.abs(d.dw) <= cx.tol && Math.abs(d.dh) <= cx.tol) {
      firstShift ??= { kind: "box", old: o, new: n, delta: d, componentPath: [], path: [] };
      continue;
    }
    if (maxAbs(d) > cx.tol) {
      const deeper = boxWalk(cx, o.ch, n.ch);
      if (deeper) return deeper;
      const sameStructure = o.ch.length === n.ch.length && o.ch.every((c, k) => signature(cx.o[c]) === signature(cx.n[n.ch[k]]));
      return { kind: !sameStructure ? "structure" : o.tt !== n.tt ? "text" : "box", old: o, new: n, delta: d, componentPath: [], path: [] };
    }
  }
  return firstShift;
}

/** Second pass when no box differs: first structural / text / style / attribute difference in document order. */
function detailWalk(cx: Ctx, oIdx: number[], nIdx: number[]): Divergence | undefined {
  const oc = children(cx.o, oIdx);
  const nc = children(cx.n, nIdx);
  const pairs = alignChildren(oc.map(signature), nc.map(signature));
  for (const [i, j] of pairs) {
    const o = i >= 0 ? oc[i] : undefined;
    const n = j >= 0 ? nc[j] : undefined;
    if ((o && cx.unstable.has(o.i)) || o?.m || n?.m) continue;
    if (o && !n) {
      if (visible(o) && hits(o, cx.regions)) return { kind: "missing", old: o, componentPath: [], path: [] };
      continue;
    }
    if (n && !o) {
      if (visible(n) && hits(n, cx.regions)) return { kind: "extra", new: n, componentPath: [], path: [] };
      continue;
    }
    if (!o || !n || !visible(o) || !hits(o, cx.regions)) continue;
    const deeper = detailWalk(cx, o.ch, n.ch);
    if (deeper) return deeper;
    if (o.t !== n.t) return { kind: "text", old: o, new: n, delta: delta(o, n), componentPath: [], path: [] };
    if (o.sh !== n.sh) return { kind: "style", old: o, new: n, delta: delta(o, n), componentPath: [], path: [] };
    if (attrDiff(o, n).length) return { kind: "attribute", old: o, new: n, delta: delta(o, n), componentPath: [], path: [] };
  }
  return undefined;
}

/**
 * First divergence: pass 1 = first visible element (document order, outermost first, then descending to the most
 * specific cause) whose box differs > tolerance or that exists on one side only; pass 2 (only when pixels differ but no
 * box does) = first structural / text-length / style-signature / attribute difference inside a pixel-diff region.
 * `regions` undefined = pass 2 unrestricted; [] = no pixel diff → pass 2 skipped.
 */
export function findDivergence(oldNodes: SnapNode[], newNodes: SnapNode[], opts: { tolerancePx?: number; unstable?: Set<number>; regions?: Ctx["regions"] } = {}): Divergence | undefined {
  const top = (nodes: SnapNode[]) => nodes.filter((x) => x.p === -1).map((x) => x.i);
  const cx: Ctx = { o: oldNodes, n: newNodes, tol: opts.tolerancePx ?? 2, unstable: opts.unstable ?? new Set(), regions: opts.regions };
  const d = boxWalk(cx, top(oldNodes), top(newNodes)) ?? (opts.regions && !opts.regions.length ? undefined : detailWalk(cx, top(oldNodes), top(newNodes)));
  if (!d) return undefined;
  const ch = d.old ? chain(oldNodes, d.old) : chain(newNodes, d.new);
  d.componentPath = ch.filter((x) => x.comp).map(nodeLabel);
  d.path = ch.map(nodeLabel);
  return d;
}

/** Attribute differences that are markup (not script state): src/data-src/srcset/href/type/role/width/height, classes, ids, data-* keys. */
export function attrDiff(o: SnapNode, n: SnapNode): { attr: string; old?: string; new?: string }[] {
  const out: { attr: string; old?: string; new?: string }[] = [];
  const keys = new Set([...Object.keys(o.a ?? {}), ...Object.keys(n.a ?? {})]);
  for (const k of [...keys].sort()) {
    const a = o.a?.[k];
    const b = n.a?.[k];
    if (a !== b) out.push({ attr: k, ...(a !== undefined ? { old: a } : {}), ...(b !== undefined ? { new: b } : {}) });
  }
  const oc = [...o.cls].sort().join(" ");
  const nc = [...n.cls].sort().join(" ");
  if (oc !== nc) out.push({ attr: "class", old: o.cls.join(" "), new: n.cls.join(" ") });
  if ((o.id ?? "") !== (n.id ?? "")) out.push({ attr: "id", ...(o.id ? { old: o.id } : {}), ...(n.id ? { new: n.id } : {}) });
  const dk = (x: SnapNode) => Object.keys(x.data ?? {}).sort().join(",");
  if (dk(o) !== dk(n)) out.push({ attr: "data-*", old: dk(o), new: dk(n) });
  return out;
}

/** Text-free skeleton of a subtree (indentation = depth; text → "…"). */
export function skeleton(nodes: SnapNode[], root: SnapNode | undefined, maxLines = 120): string {
  if (!root) return "";
  const lines: string[] = [];
  const rec = (n: SnapNode, depth: number) => {
    if (lines.length >= maxLines) return;
    const attrs = Object.entries(n.a ?? {})
      .filter(([k]) => k !== "style")
      .map(([k, v]) => ` ${k}="${v}"`)
      .join("");
    const data = Object.entries(n.data ?? {})
      .map(([k, v]) => ` ${k}${v ? `="${v}"` : ""}`)
      .join("");
    const style = n.a?.style ? ` style="${n.a.style}"` : "";
    const box = visible(n) ? ` [${n.w}×${n.h}]` : ` [${n.vis ?? "0×0"}]`;
    lines.push(`${"  ".repeat(depth)}<${n.tag}${n.id ? ` id="${n.id}"` : ""}${n.cls.length ? ` class="${n.cls.join(" ")}"` : ""}${attrs}${data}${style}>${n.t ? "…" : ""}${box}`);
    for (const c of n.ch) rec(nodes[c], depth + 1);
  };
  rec(root, 0);
  if (lines.length >= maxLines) lines.push(`… (subtree cut at ${maxLines} elements)`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ CSS rule origins (CDP)

const SHORTHAND: Record<string, string[]> = {
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  border: ["border-top-width", "border-bottom-width", "border-left-width", "border-right-width"],
  "border-width": ["border-top-width", "border-bottom-width", "border-left-width", "border-right-width"],
  "border-top": ["border-top-width"],
  "border-bottom": ["border-bottom-width"],
  font: ["font-family", "font-size", "font-weight", "font-style", "line-height"],
  background: ["background-color", "background-image"],
  inset: ["top", "left", "right", "bottom"],
  flex: ["flex-grow", "flex-shrink", "flex-basis"],
  "flex-flow": ["flex-direction", "flex-wrap"],
  overflow: ["overflow-x", "overflow-y"],
  gap: ["column-gap", "row-gap"],
  "text-decoration": ["text-decoration-line", "text-decoration-style"],
  "grid-template": ["grid-template-columns"],
};
const declares = (name: string, prop: string) => name === prop || (SHORTHAND[name]?.includes(prop) ?? false);

export interface RuleOrigin {
  selector: string;
  /** stylesheet (path on the side's origin) | "inline style" | "user-agent" */
  href: string;
  line?: number;
  origin: string;
  value: string;
  important?: boolean;
  inherited?: boolean;
  /** last matching declaration for the prop on this element (cascade order, !important first) */
  wins?: boolean;
}

interface CdpRule {
  rule: { selectorList: { text: string }; origin: string; styleSheetId?: string; style: { cssProperties: { name: string; value: string; important?: boolean; disabled?: boolean; parsedOk?: boolean }[]; range?: { startLine: number } } };
}

async function cdpFor(page: Page): Promise<{ s: CDPSession; sheets: Map<string, { url: string; line: number; inline: boolean }> }> {
  const s = await page.context().newCDPSession(page);
  const sheets = new Map<string, { url: string; line: number; inline: boolean }>();
  s.on("CSS.styleSheetAdded", (e: { header: { styleSheetId: string; sourceURL: string; startLine: number; isInline: boolean } }) => sheets.set(e.header.styleSheetId, { url: e.header.sourceURL, line: e.header.startLine, inline: e.header.isInline }));
  await s.send("DOM.enable");
  await s.send("DOM.getDocument", { depth: 0 });
  await s.send("CSS.enable");
  return { s, sheets };
}

async function matchedRulesFor(page: Page, cdp: Awaited<ReturnType<typeof cdpFor>>, idx: number, props: string[]): Promise<Record<string, RuleOrigin[]>> {
  const origin = new URL(page.url()).origin;
  const { s, sheets } = cdp;
  const ev = (await s.send("Runtime.evaluate", { expression: `window.__cmpDiagNodes && window.__cmpDiagNodes[${idx}]` })) as { result: { objectId?: string } };
  if (!ev.result.objectId) return {};
  const { nodeId } = (await s.send("DOM.requestNode", { objectId: ev.result.objectId })) as { nodeId: number };
  const m = (await s.send("CSS.getMatchedStylesForNode", { nodeId })) as {
    inlineStyle?: { cssProperties: { name: string; value: string; important?: boolean }[] };
    matchedCSSRules?: CdpRule[];
    inherited?: { inlineStyle?: { cssProperties: { name: string; value: string }[] }; matchedCSSRules?: CdpRule[] }[];
  };
  const out: Record<string, RuleOrigin[]> = {};
  const hrefOf = (r: CdpRule["rule"]) => {
    if (r.origin === "user-agent") return "user-agent";
    const sh = r.styleSheetId ? sheets.get(r.styleSheetId) : undefined;
    if (!sh) return "?";
    if (sh.inline || !sh.url) return `inline <style> of ${shortPath(sh.url || page.url(), origin)}`;
    return shortPath(sh.url, origin);
  };
  const cleanVal = (prop: string, v: string) => (prop === "content" ? "…" : clip(v.replace(/url\((["']?)data:[^)]*\)/g, "url(data:…)"), 100));
  const add = (prop: string, r: RuleOrigin) => (out[prop] ??= []).push(r);
  for (const prop of props) {
    for (const rm of m.matchedCSSRules ?? []) {
      for (const d of rm.rule.style.cssProperties) {
        if (d.disabled || d.parsedOk === false || !declares(d.name, prop)) continue;
        const sh = rm.rule.styleSheetId ? sheets.get(rm.rule.styleSheetId) : undefined;
        add(prop, { selector: clip(rm.rule.selectorList.text, 160), href: hrefOf(rm.rule), line: rm.rule.style.range ? rm.rule.style.range.startLine + 1 - (sh?.inline ? 0 : 0) : undefined, origin: rm.rule.origin, value: cleanVal(prop, d.value), ...(d.important ? { important: true } : {}) });
      }
    }
    for (const d of m.inlineStyle?.cssProperties ?? []) if (declares(d.name, prop) && d.value) add(prop, { selector: "style attribute", href: "inline style", origin: "inline", value: cleanVal(prop, d.value), ...(d.important ? { important: true } : {}) });
    // inherited props (font, line-height, colour…): nearest ancestor rule only
    if (!out[prop]?.length && /^(font|line-height|color|letter-spacing|text-|white-space|visibility)/.test(prop))
      for (const inh of m.inherited ?? []) {
        let found = false;
        for (const rm of inh.matchedCSSRules ?? [])
          for (const d of rm.rule.style.cssProperties)
            if (!d.disabled && d.parsedOk !== false && declares(d.name, prop)) {
              add(prop, { selector: clip(rm.rule.selectorList.text, 160), href: hrefOf(rm.rule), line: rm.rule.style.range ? rm.rule.style.range.startLine + 1 : undefined, origin: rm.rule.origin, value: cleanVal(prop, d.value), inherited: true });
              found = true;
            }
        if (found) break;
      }
    const list = out[prop];
    if (list?.length) {
      const imp = list.filter((r) => r.important && !r.inherited);
      const winner = imp.length ? imp[imp.length - 1] : [...list].reverse().find((r) => !r.inherited) ?? list[0];
      winner.wins = true;
      // keep the payload small: the winner + up to 5 others (closest to the winner in cascade order)
      if (list.length > 6) {
        const wi = list.indexOf(winner);
        out[prop] = list.slice(Math.max(0, wi - 5), wi + 1);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ classification (pure)

export type ParityCause = "MARKUP" | "CSS_MISSING" | "CSS_ORDER" | "ASSET" | "SCRIPT" | "CONTENT" | "DYNAMIC" | "PAGE_MISSING" | "UNKNOWN";

export interface Classification {
  cause: ParityCause;
  confidence: "high" | "medium" | "low";
  /** machine-readable sub-kind, e.g. "missing-element", "extra-wrapper", "lazy-src", "extra-stylesheet" */
  subtype?: string;
  evidence: string[];
  /** fix lane: "design" (overrides), "content" (CCM / profiles → content handler), "mask" (crawl.mask proposal) */
  lane: "design" | "content" | "mask" | "human";
  alternatives: { cause: ParityCause; why: string }[];
}

export interface StyleDiffEntry {
  node: string;
  /** 0 = divergent element, 1 = parent … */
  level: number;
  side: "pair" | "old-only" | "new-only";
  props: Record<string, { old?: string; new?: string }>;
}

export interface AssetSetDiff {
  stylesheets: {
    old: string[];
    new: string[];
    onlyOld: string[];
    onlyNew: string[];
    orderDiffers: boolean;
    noscriptOld: string[];
    noscriptLoadedOnNew: string[];
    /** inline <style> sheets present on one side only: hash key, rule count, first selectors (no declarations) */
    inlineOnlyOld?: { key: string; rules: number; selectors: string[] }[];
    inlineOnlyNew?: { key: string; rules: number; selectors: string[] }[];
  };
  scripts: { old: number; new: number; onlyOld: string[]; onlyNew: string[]; orderDiffers: boolean };
  failedRequests: { old: SideCapture["failedRequests"]; new: SideCapture["failedRequests"]; onlyNew: SideCapture["failedRequests"] };
  consoleErrors: { old: string[]; new: string[]; onlyNew: string[] };
}

/** Comparable key of a stylesheet/script URL: file name without query, de-hashed Drupal aggregates kept as is. */
export const assetKey = (u: string) => {
  const p = u.split("?")[0].split("#")[0];
  let k = p.split("/").filter(Boolean).pop() ?? p;
  try {
    k = decodeURIComponent(k);
  } catch {
    /* keep */
  }
  // the design port may add a content hash (mainTheme.aaf5871d.css ↔ mainTheme.css)
  return k.replace(/\.[0-9a-f]{8}(?=\.(css|js)$)/, "");
};

const IGNORED_SCRIPT = /\/_next\/|tracker-stub|googletagmanager|google_tag\/|\/gtag|gtm\.js|google-analytics|\/analytics\.js/;

export function diffAssetSets(o: Pick<SideCapture, "snapshot" | "failedRequests" | "consoleErrors">, n: Pick<SideCapture, "snapshot" | "failedRequests" | "consoleErrors">): AssetSetDiff {
  const css = (s: PageSnapshot) => s.stylesheets.filter((x) => !x.href.startsWith("inline#")).map((x) => x.href);
  const inlineInfo = (s: PageSnapshot, keys: string[]) => s.stylesheets.filter((x) => keys.includes(x.href) && x.href.startsWith("inline:")).map((x) => ({ key: x.href, rules: x.rules ?? 0, selectors: x.selectors ?? [] }));
  const oc = css(o.snapshot);
  const nc = css(n.snapshot);
  const ok = new Set(oc.map(assetKey));
  const nk = new Set(nc.map(assetKey));
  const onlyOld = oc.filter((h) => !nk.has(assetKey(h)));
  const onlyNew = nc.filter((h) => !ok.has(assetKey(h)));
  const common = (a: string[], keys: Set<string>) => a.map(assetKey).filter((k) => keys.has(k));
  const orderDiffers = common(oc, nk).join("|") !== common(nc, ok).join("|");
  const nsOld = o.snapshot.noscriptStylesheets;
  const nsKeys = new Set(nsOld.map(assetKey));
  // framework chunks of the generated app and tracker loaders (stubbed on purpose) are not part of the comparison
  const js = (s: PageSnapshot) => s.scripts.map((x) => x.src).filter((x) => !IGNORED_SCRIPT.test(x));
  const oj = js(o.snapshot);
  const nj = js(n.snapshot);
  const ojk = new Set(oj.map(assetKey));
  const njk = new Set(nj.map(assetKey));
  const reqKey = (r: { url: string; status: number | string }) => `${assetKey(r.url)}:${r.status}`;
  const oreq = new Set(o.failedRequests.map(reqKey));
  const oerr = new Set(o.consoleErrors.map((e) => e.replace(/:\d+(:\d+)?/g, "")));
  return {
    stylesheets: { old: oc, new: nc, onlyOld, onlyNew, orderDiffers, noscriptOld: nsOld, noscriptLoadedOnNew: nc.filter((h) => nsKeys.has(assetKey(h)) && !oc.some((x) => assetKey(x) === assetKey(h))), inlineOnlyOld: inlineInfo(o.snapshot, onlyOld), inlineOnlyNew: inlineInfo(n.snapshot, onlyNew) },
    scripts: { old: oj.length, new: nj.length, onlyOld: oj.filter((s) => !njk.has(assetKey(s))), onlyNew: nj.filter((s) => !ojk.has(assetKey(s))), orderDiffers: common(oj, njk).join("|") !== common(nj, ojk).join("|") },
    failedRequests: { old: o.failedRequests, new: n.failedRequests, onlyNew: n.failedRequests.filter((r) => !oreq.has(reqKey(r))) },
    consoleErrors: { old: o.consoleErrors, new: n.consoleErrors, onlyNew: n.consoleErrors.filter((e) => !oerr.has(e.replace(/:\d+(:\d+)?/g, ""))) },
  };
}

const RICH_TEXT = /^(text-formatted|field--type-text-long|field--type-text-with-summary|field--name-body|field--name-field-c-text|rich-?text|wysiwyg|body)/;
const INLINE_TAGS = new Set(["abbr", "b", "strong", "i", "em", "span", "sup", "sub", "a", "u", "small", "mark", "code", "br", "acronym", "cite", "q", "s"]);

export interface ClassifyInput {
  divergence?: Divergence;
  oldNodes: SnapNode[];
  newNodes: SnapNode[];
  styleDiff: StyleDiffEntry[];
  rules: { node: string; level: number; prop: string; old: RuleOrigin[]; new: RuleOrigin[] }[];
  assets: AssetSetDiff;
  attributes: { node: string; attr: string; old?: string; new?: string }[];
  /** divergent element lies in a region that differs between two captures of the original */
  dynamic?: { proven: boolean; parity: number; regions: number };
  parity?: number;
  /** HTTP status of the documents (0 = network error): a non-200 new document is a routing problem, not a design one */
  status?: { old: number; new: number };
}

/** Rule-based cause classifier (no LLM). First matching rule wins; the others are listed as alternatives. */
export function classify(x: ClassifyInput): Classification {
  const ev: string[] = [];
  const alt: Classification["alternatives"] = [];
  const d = x.divergence;
  const res = (cause: ParityCause, confidence: Classification["confidence"], subtype: string | undefined, lane: Classification["lane"], evidence: string[]): Classification => ({ cause, confidence, ...(subtype ? { subtype } : {}), evidence, lane, alternatives: alt });

  // PAGE_MISSING — the new document itself is not served (404/500/network): no CSS/asset/markup patch can fix that
  // (missing CCM entry / route → content track or pipeline), so it is never labelled ASSET/request-failed
  if (x.status && x.status.new !== 200 && x.status.old === 200)
    return res("PAGE_MISSING", "high", x.status.new ? `new-${x.status.new}` : "new-unreachable", "human", [`new document answered ${x.status.new || "no response"} (old ${x.status.old}): missing CCM entry or route`]);

  if (!d) {
    if (x.dynamic?.proven) return res("DYNAMIC", "medium", "no-structural-divergence", "mask", [`no element-level divergence; original vs original parity ${x.dynamic.parity} (${x.dynamic.regions} unstable region(s))`]);
    return res("UNKNOWN", "low", "no-divergence", "human", ["no element-level divergence found (pixel-only difference: fonts, anti-aliasing, image content)"]);
  }
  const el = d.old ?? d.new!;
  const anc = chain(d.old ? x.oldNodes : x.newNodes, el);
  const inRich = anc.some((a) => a.cls.some((c) => RICH_TEXT.test(c)));
  const label = nodeLabel(el);
  const ss = x.assets.stylesheets;

  const setDiff = ss.onlyNew.length || ss.onlyOld.length;
  const setWhy = `stylesheet set differs: only old [${ss.onlyOld.map(assetKey).join(", ")}], only new [${ss.onlyNew.map(assetKey).join(", ")}]`;
  // DYNAMIC — proven by the instability self-test (unless the app also loads a different stylesheet set)
  if (x.dynamic?.proven && !setDiff) return res("DYNAMIC", "high", "unstable-on-original", "mask", [`${label} differs between two captures of the original (parity ${x.dynamic.parity})`]);
  if (x.dynamic?.proven) alt.push({ cause: "DYNAMIC", why: `${label} also differs between two captures of the original (parity ${x.dynamic.parity})` });

  // ASSET — images / failed requests
  const isMedia = ["img", "picture", "source", "video", "iframe"].includes(el.tag);
  const srcDiff = x.attributes.find((a) => a.attr === "src" || a.attr === "data-src" || a.attr === "srcset");
  if (isMedia && (srcDiff || (d.old?.img && d.new?.img && (d.old.img.nw !== d.new.img.nw || d.old.img.cur !== d.new.img.cur)))) {
    const lazy = (srcDiff?.old?.startsWith("data:") && !srcDiff.new?.startsWith("data:")) || (srcDiff?.new?.startsWith("data:") && !srcDiff.old?.startsWith("data:"));
    ev.push(`${label}: ${srcDiff ? `${srcDiff.attr} old=${srcDiff.old ?? "(none)"} new=${srcDiff.new ?? "(none)"}` : `current source old=${d.old?.img?.cur} new=${d.new?.img?.cur}`}`);
    if (d.old?.img && d.new?.img) ev.push(`natural size old=${d.old.img.nw}×${d.old.img.nh} new=${d.new.img.nw}×${d.new.img.nh}`);
    if (d.delta) ev.push(`box Δ ${JSON.stringify(d.delta)}`);
    return res("ASSET", "high", lazy ? "lazy-src" : "src-differs", "design", ev);
  }
  const failedMedia = x.assets.failedRequests.onlyNew.filter((r) => /image|font|media|stylesheet/.test(r.type));
  if (failedMedia.length && (isMedia || failedMedia.some((r) => r.type === "font" || r.type === "stylesheet"))) {
    alt.push({ cause: "ASSET", why: `${failedMedia.length} request(s) fail only on new: ${failedMedia.slice(0, 3).map((r) => `${r.url} ${r.status}`).join(", ")}` });
    if (isMedia || failedMedia.some((r) => r.type === "stylesheet")) return res("ASSET", "medium", "request-failed", "design", [alt[alt.length - 1].why]);
  }

  // CSS_ORDER — the active stylesheet set differs (incl. noscript-only CSS loaded on new)
  if (ss.noscriptLoadedOnNew.length) {
    return res("CSS_ORDER", "high", "noscript-stylesheet-loaded", "design", [
      `new loads ${ss.noscriptLoadedOnNew.join(", ")}, which the original only declares inside <noscript> (never applied with JS on)`,
      ...(x.styleDiff.length ? [`differing computed props at ${x.styleDiff[0].node}: ${Object.keys(x.styleDiff[0].props).join(", ")}`] : []),
      ...(d.old?.a?.style !== d.new?.a?.style ? [`inline style (script-set) old="${d.old?.a?.style ?? ""}" new="${d.new?.a?.style ?? ""}"`] : []),
    ]);
  }

  // MARKUP / CONTENT — structure differs
  if (d.kind === "missing" || d.kind === "extra" || d.kind === "structure") {
    const parentNodes = d.kind === "extra" ? x.newNodes : x.oldNodes;
    const p = el.p >= 0 ? parentNodes[el.p] : undefined;
    const sub =
      d.kind === "extra" && ["p", "div", "span"].includes(el.tag) && el.ch.length <= 3 && el.tt > 0
        ? "extra-wrapper"
        : d.kind === "missing"
          ? "missing-element"
          : d.kind === "extra"
            ? "extra-element"
            : "children-differ";
    ev.push(`${d.kind === "missing" ? "only on old" : d.kind === "extra" ? "only on new" : "children differ"}: ${label}${p ? ` (parent ${nodeLabel(p)})` : ""}`);
    if (d.kind === "structure" && d.old && d.new)
      ev.push(`children old=[${d.old.ch.map((c) => signature(x.oldNodes[c])).join(", ")}] new=[${d.new.ch.map((c) => signature(x.newNodes[c])).join(", ")}]`);
    if (d.delta) ev.push(`box Δ ${JSON.stringify(d.delta)}`);
    // inline element inside rich text (abbr, sup …) lost/added → the CCM rich text does not carry it
    if (inRich && INLINE_TAGS.has(el.tag) && sub !== "extra-wrapper") {
      alt.push({ cause: "MARKUP", why: "template could also drop it, but the element sits inside a rich-text field" });
      return res("CONTENT", "medium", `richtext-inline-${d.kind === "missing" ? "dropped" : "added"}:${el.tag}`, "content", [...ev, "element lies inside a rich-text field: the CCM rich text (transform) must carry it; hand over to the content lane"]);
    }
    if (sub === "extra-wrapper" && inRich) ev.push("extra block wrapper inside a rich-text/prop container (implicit paragraph rendered as <p>?)");
    return res("MARKUP", "high", sub, "design", ev);
  }

  if (d.kind === "visibility") {
    ev.push(`${label}: rendered visibly on ${visible(d.old!) ? "old" : "new"} only (old ${d.old!.vis ?? "visible"}, new ${d.new!.vis ?? "visible"})`);
    const stateCls = x.attributes.find((a) => a.attr === "class");
    if (stateCls) ev.push(`class old="${stateCls.old}" new="${stateCls.new}"`);
  }

  // CONTENT — same structure, different text length
  if (d.kind === "text" || (d.old && d.new && d.old.tt !== d.new.tt && d.kind !== "visibility")) {
    const o = d.old!;
    const n = d.new!;
    return res("CONTENT", "high", "text-length-differs", "content", [`${label}: text length old=${o.tt} new=${n.tt} (own ${o.t}/${n.t}) with the same element structure`, ...(d.delta ? [`box Δ ${JSON.stringify(d.delta)}`] : [])]);
  }

  // CSS — compare the winning rule per differing property
  const missing: string[] = [];
  const differs: string[] = [];
  let inlineDiff = false;
  for (const r of x.rules) {
    const wo = r.old.find((q) => q.wins);
    const wn = r.new.find((q) => q.wins);
    if (wo?.href === "inline style" || wn?.href === "inline style") {
      if (wo?.value !== wn?.value) inlineDiff = true;
      continue;
    }
    if (wo && wo.origin !== "user-agent" && !r.new.some((q) => q.selector === wo.selector && assetKey(q.href) === assetKey(wo.href))) missing.push(`${r.node} ${r.prop}: old "${wo.selector}" (${wo.href}:${wo.line ?? "?"}) = ${wo.value} has no counterpart on new${wn ? ` (new winner "${wn.selector}" ${wn.href} = ${wn.value})` : ""}`);
    else if (wo && wn && (wo.selector !== wn.selector || wo.value !== wn.value)) differs.push(`${r.node} ${r.prop}: winner old "${wo.selector}" = ${wo.value} (${wo.href}) vs new "${wn.selector}" = ${wn.value} (${wn.href})`);
    else if (!wo && wn && wn.origin !== "user-agent") missing.push(`${r.node} ${r.prop}: new "${wn.selector}" (${wn.href}) = ${wn.value} has no counterpart on old (extra rule)`);
  }
  const elStyleOld = d.old?.a?.style;
  const elStyleNew = d.new?.a?.style;
  if (elStyleOld !== elStyleNew) inlineDiff = true;
  if (ss.onlyNew.length || ss.onlyOld.length || ss.orderDiffers)
    alt.push({ cause: "CSS_ORDER", why: `stylesheet set differs: only old [${ss.onlyOld.map(assetKey).join(", ")}], only new [${ss.onlyNew.map(assetKey).join(", ")}]${ss.orderDiffers ? ", order differs" : ""}` });
  if (missing.length) {
    if (ss.onlyOld.length) return res("CSS_ORDER", "medium", "stylesheet-missing", "design", [...missing.slice(0, 4), alt[alt.length - 1]?.why ?? ""]);
    return res("CSS_MISSING", "high", "rule-missing", "design", missing.slice(0, 6));
  }
  // SCRIPT — behaviour-set inline styles / state classes, errors only on new
  const scriptErr = x.assets.consoleErrors.onlyNew;
  const stateClass = x.attributes.find((a) => a.attr === "class" && a.old !== a.new);
  if (inlineDiff || scriptErr.length || (stateClass && d.kind === "visibility")) {
    const e2 = [
      ...(inlineDiff ? [`inline style set at runtime differs on ${label}: old="${elStyleOld ?? ""}" new="${elStyleNew ?? ""}"`] : []),
      ...(stateClass ? [`state classes old="${stateClass.old}" new="${stateClass.new}"`] : []),
      ...scriptErr.slice(0, 3).map((e) => `console error only on new: ${e}`),
      ...(x.assets.scripts.onlyOld.length ? [`scripts only on old: ${x.assets.scripts.onlyOld.slice(0, 4).map(assetKey).join(", ")}`] : []),
      ...(x.assets.scripts.orderDiffers ? ["script order differs"] : []),
    ];
    if (ss.onlyNew.length || ss.onlyOld.length) return res("CSS_ORDER", "medium", "stylesheet-set-differs", "design", [...e2, alt[alt.length - 1]?.why ?? ""]);
    return res("SCRIPT", inlineDiff || scriptErr.length ? "medium" : "low", inlineDiff ? "runtime-style-differs" : scriptErr.length ? "script-error" : "state-class-differs", "design", e2);
  }
  if (differs.length) return res(ss.orderDiffers ? "CSS_ORDER" : "CSS_MISSING", "medium", ss.orderDiffers ? "cascade-order" : "rule-value-differs", "design", differs.slice(0, 6));
  // nothing local explains the box change, but the app applies a different stylesheet set than the original
  if (setDiff) return res("CSS_ORDER", "medium", "stylesheet-set-differs", "design", [setWhy, `${label} ${d.kind} differs${d.delta ? ` (Δ ${JSON.stringify(d.delta)})` : ""} without a local style/markup cause`]);
  if (x.styleDiff.length) return res("CSS_MISSING", "low", "computed-style-differs", "design", x.styleDiff.slice(0, 3).map((s) => `${s.node}: ${Object.entries(s.props).map(([k, v]) => `${k} ${v.old} → ${v.new}`).join("; ")}`));
  if (x.attributes.length) return res("MARKUP", "low", "attribute-differs", "design", x.attributes.slice(0, 4).map((a) => `${a.node} ${a.attr}: old=${a.old ?? "(none)"} new=${a.new ?? "(none)"}`));
  return res("UNKNOWN", "low", d.kind, "human", [`${label} ${d.kind} differs; no style/markup/asset evidence`]);
}

// ------------------------------------------------------------------ dossier

export interface ParityDossier {
  version: 1;
  path: string;
  viewport: string;
  old: { base: string; status: number };
  new: { base: string; status: number };
  parity: { value: number; diffPixels: number; height: { old: number; new: number; delta: number }; regions: (DiffRegion & { component?: string })[] };
  firstDivergence?: {
    kind: DivergenceKind;
    element: string;
    signature: string;
    componentPath: string[];
    path: string[];
    old?: { box: [number, number, number, number]; vis?: string; textLength: number; children: string[] };
    new?: { box: [number, number, number, number]; vis?: string; textLength: number; children: string[] };
    delta?: BoxDelta;
  };
  styleDiff: StyleDiffEntry[];
  matchedRules: { node: string; level: number; prop: string; old: RuleOrigin[]; new: RuleOrigin[] }[];
  attributes: { node: string; attr: string; old?: string; new?: string }[];
  markup: { componentRoot?: string; old: string; new: string };
  assets: AssetSetDiff;
  stabilise: { old?: LoadInfo["freeze"]; new?: LoadInfo["freeze"]; fonts: { old?: string; new?: string }; nodes: { old: number; new: number; truncated: boolean } };
  instability?: { tested: boolean; parity?: number; diffPixels?: number; regions: DiffRegion[]; unstableElements: string[]; divergenceUnstable: boolean; maskCandidates: { selector: string; proof: string }[] };
  classification: Classification;
}

const box = (n: SnapNode): [number, number, number, number] => [n.x, n.y, n.w, n.h];

/** Nodes of `b` whose box differs from the signature-path-matched node of `a` (instability self-test). */
export function unstableNodes(a: SnapNode[], b: SnapNode[], tol = 2): Set<number> {
  const out = new Set<number>();
  const rec = (ai: number[], bi: number[]) => {
    const ac = ai.map((i) => a[i]);
    const bc = bi.map((i) => b[i]);
    for (const [i, j] of alignChildren(ac.map(signature), bc.map(signature))) {
      if (i < 0) continue;
      const x = ac[i];
      if (j < 0) {
        markAll(x);
        continue;
      }
      const y = bc[j];
      if (maxAbs(delta(x, y)) > tol || visible(x) !== visible(y) || x.tt !== y.tt) {
        out.add(x.i);
        // a moved container: children may be stable relative to it; recurse to find which ones change
      }
      rec(x.ch, y.ch);
    }
  };
  const markAll = (x: SnapNode) => {
    out.add(x.i);
    for (const c of x.ch) markAll(a[c]);
  };
  rec(a.filter((x) => x.p === -1).map((x) => x.i), b.filter((x) => x.p === -1).map((x) => x.i));
  return out;
}

const pathOf = (nodes: SnapNode[], n: SnapNode) => chain(nodes, n);

/**
 * Build the dossier for one shot. Opens its own browser contexts (verify capture routine, identical on both sides):
 * old, new and (instability) old again. ~3 page loads.
 */
export async function diagnoseShot(browser: Browser, o: DiagnoseOptions & { path: string }): Promise<ParityDossier> {
  const tol = o.tolerancePx ?? 2;
  const sides: Array<Awaited<ReturnType<typeof captureSide>>> = [];
  try {
    const old = await captureSide(browser, o.oldUrl, o);
    sides.push(old);
    const neu = await captureSide(browser, o.newUrl, o);
    sides.push(neu);
    let old2: Awaited<ReturnType<typeof captureSide>> | undefined;
    if (o.instability !== false) {
      old2 = await captureSide(browser, o.oldUrl, o);
      sides.push(old2);
    }
    const cmp = compareImages(old.png, neu.png);
    const oN = old.snapshot.nodes;
    const nN = neu.snapshot.nodes;
    // instability: element boxes + pixels of original vs original
    const unstable = old2 ? unstableNodes(oN, old2.snapshot.nodes, tol) : new Set<number>();
    const selfCmp = old2 ? compareImages(old.png, old2.png) : undefined;
    const regions = cmp.regions.map(({ x, y, w, h }) => ({ x, y, w, h }));
    const div = findDivergence(oN, nN, { tolerancePx: tol, unstable, regions });
    // was there a divergence only inside unstable elements? (walk again without the stability filter)
    const rawDiv = unstable.size ? findDivergence(oN, nN, { tolerancePx: tol, regions }) : div;
    const divergenceUnstable = !!rawDiv?.old && unstable.has(rawDiv.old.i) && (!div || div.old?.i !== rawDiv.old.i);
    const target = divergenceUnstable && (!div || !cmp.diffPixels) ? rawDiv : div;

    // chain: divergent element (or parent of extra/missing) + ancestors up to the component root (max 6)
    const pairChain: { node: string; level: number; o?: SnapNode; n?: SnapNode }[] = [];
    if (target) {
      let o0 = target.old;
      let n0 = target.new;
      if (target.kind === "missing") n0 = undefined;
      if (target.kind === "extra") o0 = undefined;
      const oc = o0 ? pathOf(oN, o0).reverse() : [];
      const nc = n0 ? pathOf(nN, n0).reverse() : [];
      for (let lvl = 0; lvl < 6; lvl++) {
        const a = oc[lvl];
        const b = nc[lvl];
        if (!a && !b) break;
        pairChain.push({ node: nodeLabel((a ?? b)!), level: lvl, o: a, n: b && (!a || signature(a) === signature(b)) ? b : b });
        if ((a ?? b)!.comp && lvl > 0) break;
      }
    }
    const [oStyles, nStyles] = await Promise.all([
      old.page.evaluate(`(${STYLE_JS})(${JSON.stringify({ idx: pairChain.filter((c) => c.o).map((c) => c.o!.i), props: STYLE_PROPS })})`) as Promise<Record<string, string>[]>,
      neu.page.evaluate(`(${STYLE_JS})(${JSON.stringify({ idx: pairChain.filter((c) => c.n).map((c) => c.n!.i), props: STYLE_PROPS })})`) as Promise<Record<string, string>[]>,
    ]);
    let oi = 0;
    let ni = 0;
    const styleDiff: StyleDiffEntry[] = [];
    const diffProps: { level: number; node: string; o?: SnapNode; n?: SnapNode; props: string[] }[] = [];
    for (const c of pairChain) {
      const so = c.o ? oStyles[oi++] : undefined;
      const sn = c.n ? nStyles[ni++] : undefined;
      const props: StyleDiffEntry["props"] = {};
      if (so && sn) {
        for (const k of STYLE_PROPS) if (so[k] !== sn[k]) props[k] = { old: so[k], new: sn[k] };
      }
      if (Object.keys(props).length || !so || !sn) styleDiff.push({ node: c.node, level: c.level, side: so && sn ? "pair" : so ? "old-only" : "new-only", props });
      if (Object.keys(props).length) diffProps.push({ level: c.level, node: c.node, o: c.o, n: c.n, props: Object.keys(props) });
    }
    // matched rules (CDP) for differing props: element + first 2 ancestors with differences
    const matchedRules: ParityDossier["matchedRules"] = [];
    if (o.matchedRules !== false && diffProps.length) {
      const [co, cn] = await Promise.all([cdpFor(old.page), cdpFor(neu.page)]);
      try {
        for (const dp of diffProps.slice(0, 3)) {
          const props = dp.props.filter((p) => !["width", "height", "top", "left", "right", "bottom"].includes(p) || dp.props.length <= 4).slice(0, 8);
          const ro = dp.o ? await matchedRulesFor(old.page, co, dp.o.i, props).catch(() => ({}) as Record<string, RuleOrigin[]>) : {};
          const rn = dp.n ? await matchedRulesFor(neu.page, cn, dp.n.i, props).catch(() => ({}) as Record<string, RuleOrigin[]>) : {};
          for (const p of props) if ((ro[p]?.length ?? 0) + (rn[p]?.length ?? 0)) matchedRules.push({ node: dp.node, level: dp.level, prop: p, old: ro[p] ?? [], new: rn[p] ?? [] });
        }
      } finally {
        await co.s.detach().catch(() => undefined);
        await cn.s.detach().catch(() => undefined);
      }
    }
    // attributes of the divergent pair (+ its parent for missing/extra)
    const attributes: ParityDossier["attributes"] = [];
    if (target?.old && target?.new) for (const a of attrDiff(target.old, target.new)) attributes.push({ node: nodeLabel(target.old), ...a });
    // component root for the skeleton: nearest component ancestor-or-self on each side
    const compRoot = (nodes: SnapNode[], n?: SnapNode) => {
      if (!n) return undefined;
      const ch = pathOf(nodes, n);
      for (let k = ch.length - 1; k >= 0; k--) if (ch[k].comp && (k < ch.length - 1 || ch[k].ch.length)) return ch[k];
      return ch[0];
    };
    const oAnchor = target?.old ?? (target?.new && target.new.p >= 0 ? matchOld(oN, nN, nN[target.new.p]) : undefined);
    const nAnchor = target?.new ?? (target?.old && target.old.p >= 0 ? matchNew(oN, nN, oN[target.old.p]) : undefined);
    const oRoot = compRoot(oN, oAnchor);
    const nRoot = compRoot(nN, nAnchor);
    const assets = diffAssetSets(old, neu);
    const dynProven = !!(old2 && divergenceUnstable && (!div || !cmp.diffPixels));
    const maskCandidates: { selector: string; proof: string }[] = [];
    if (old2 && divergenceUnstable && rawDiv?.old) {
      // the unstable element itself when it is addressable, else its component root
      const root = rawDiv.old.id || rawDiv.old.cls.some((k) => !/^(js-|is-|has-)/.test(k)) ? rawDiv.old : (compRoot(oN, rawDiv.old) ?? rawDiv.old);
      maskCandidates.push({ selector: maskSelector(root), proof: `original vs original: ${nodeLabel(rawDiv.old)} box/text differs between two captures (self-test parity ${round4(selfCmp?.parity ?? 1)}, ${selfCmp?.diffPixels ?? 0} px)` });
    }
    const classification = classify({
      divergence: target,
      oldNodes: oN,
      newNodes: nN,
      styleDiff,
      rules: matchedRules,
      assets,
      attributes,
      dynamic: old2 ? { proven: dynProven, parity: round4(selfCmp?.parity ?? 1), regions: selfCmp?.regions.length ?? 0 } : undefined,
      parity: cmp.parity,
      status: { old: old.status, new: neu.status },
    });
    const summary = (n?: SnapNode, nodes?: SnapNode[]) => (n && nodes ? { box: box(n), ...(n.vis ? { vis: n.vis } : {}), textLength: n.tt, children: n.ch.slice(0, 24).map((c) => signature(nodes[c])) } : undefined);
    const el = target?.old ?? target?.new;
    const dossier: ParityDossier = {
      version: 1,
      path: o.path,
      viewport: o.viewport.name,
      old: { base: new URL(o.oldUrl).origin, status: old.status },
      new: { base: new URL(o.newUrl).origin, status: neu.status },
      parity: { value: round4(cmp.parity), diffPixels: cmp.diffPixels, height: { old: cmp.oldSize.height, new: cmp.newSize.height, delta: cmp.newSize.height - cmp.oldSize.height }, regions: cmp.regions.slice(0, 6).map((r) => ({ ...r, component: ownerLabel(oN, r) })) },
      ...(target && el
        ? {
            firstDivergence: {
              kind: target.kind,
              element: nodeLabel(el),
              signature: signature(el),
              componentPath: target.componentPath,
              path: target.path,
              ...(target.old ? { old: summary(target.old, oN) } : {}),
              ...(target.new ? { new: summary(target.new, nN) } : {}),
              ...(target.delta ? { delta: target.delta } : {}),
            },
          }
        : {}),
      styleDiff,
      matchedRules,
      attributes,
      markup: { componentRoot: oRoot ? nodeLabel(oRoot) : nRoot ? nodeLabel(nRoot) : undefined, old: skeleton(oN, oRoot), new: skeleton(nN, nRoot) },
      assets,
      stabilise: { old: old.load.freeze, new: neu.load.freeze, fonts: { old: old.load.fonts, new: neu.load.fonts }, nodes: { old: oN.length, new: nN.length, truncated: old.snapshot.truncated || neu.snapshot.truncated } },
      ...(old2
        ? {
            instability: {
              tested: true,
              parity: round4(selfCmp?.parity ?? 1),
              diffPixels: selfCmp?.diffPixels ?? 0,
              regions: (selfCmp?.regions ?? []).slice(0, 6),
              unstableElements: [...unstable].slice(0, 12).map((i) => nodeLabel(oN[i])),
              divergenceUnstable,
              maskCandidates,
            },
          }
        : {}),
      classification,
    };
    return dossier;
  } finally {
    for (const s of sides) await s.close();
  }
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Headless Chromium for callers outside verify (handlers, bench) that have no playwright dependency of their own. */
export async function launchBrowser(): Promise<Browser> {
  return launchChromium({ headless: true });
}

function maskSelector(n: SnapNode): string {
  if (n.id && !/\d{4,}/.test(n.id)) return `#${n.id}`;
  const cls = n.cls.filter((c) => !STATE_CLASS.test(c)).slice(0, 2);
  return cls.length ? `.${cls.join(".")}` : n.tag;
}

/** tightest component on the old page covering a region centre */
function ownerLabel(nodes: SnapNode[], r: DiffRegion): string | undefined {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  let best: SnapNode | undefined;
  for (const n of nodes) if (n.comp && visible(n) && cx >= n.x && cx <= n.x + n.w && cy >= n.y && cy <= n.y + n.h && (!best || n.w * n.h <= best.w * best.h)) best = n;
  return best ? nodeLabel(best) : undefined;
}

/** counterpart of a new node on the old side (signature path) */
function matchOld(oN: SnapNode[], nN: SnapNode[], n: SnapNode): SnapNode | undefined {
  return matchPath(nN, oN, n);
}
function matchNew(oN: SnapNode[], nN: SnapNode[], o: SnapNode): SnapNode | undefined {
  return matchPath(oN, nN, o);
}
function matchPath(from: SnapNode[], to: SnapNode[], n: SnapNode): SnapNode | undefined {
  const sigs = chain(from, n).map((x) => {
    const sibs = (x.p >= 0 ? from[x.p].ch : from.filter((y) => y.p === -1).map((y) => y.i)).map((i) => from[i]);
    return { sig: signature(x), nth: sibs.filter((s) => signature(s) === signature(x)).indexOf(x) };
  });
  let cur: SnapNode[] = to.filter((y) => y.p === -1);
  let hit: SnapNode | undefined;
  for (const s of sigs) {
    hit = cur.filter((c) => signature(c) === s.sig)[s.nth];
    if (!hit) return undefined;
    cur = hit.ch.map((i) => to[i]);
  }
  return hit;
}

/** Strings a dossier may legitimately contain are structure only; used by tests and by the handler as a last guard. */
export function dossierText(d: ParityDossier): string {
  return JSON.stringify(d);
}
