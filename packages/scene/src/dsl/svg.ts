// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Inline SVG markup on DSL elements (`el.svg`: logos, brand / social glyphs). Everything that renders it goes through
// sanitizeSvg first: an allowlist of painting elements and attributes, no scripts, event handlers, foreignObject,
// animation or external references (only `#fragment` and data:image hrefs survive). Without a DOM parser the markup is
// tokenized and rebuilt from the same allowlist (regexSanitize).
import type { CSSProperties } from "../css.js";

const MAX_LEN = 256 * 1024;
const ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textpath",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "use",
  "symbol",
  "title",
  "desc",
  "style",
  "pattern",
  "image",
  "filter",
  "marker",
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "feflood",
  "fegaussianblur",
  "femerge",
  "femergenode",
  "feoffset",
  "fedropshadow",
  "fefunca",
  "fefuncb",
  "fefuncg",
  "fefuncr",
  "femorphology",
  "fetile",
  "feturbulence",
  "fedisplacementmap",
]);
const URL_ATTR = /^(href|xlink:href|src)$/i;
const SAFE_HREF = /^(#|data:image\/(png|jpe?g|gif|webp|avif);)/i;
const BAD_VALUE = /javascript:|vbscript:|data:text\/html|expression\s*\(/i;
const BAD_VALUES = new RegExp(BAD_VALUE.source, "gi");
const cleanCss = (css: string) => {
  let out = css.replace(/@import[^;]*;?/gi, "").replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, "none");
  // until stable: taking one match out must not join a new one ("javajavascript:script:")
  for (let i = 0; i < 8 && BAD_VALUE.test(out); i++) out = out.replace(BAD_VALUES, "");
  return BAD_VALUE.test(out) ? "" : out;
};

/** Sanitised `<svg>` markup, or null when there is no usable SVG. */
export function sanitizeSvg(markup: string | undefined | null): string | null {
  if (typeof markup !== "string") return null;
  const src = markup.trim();
  if (!src || src.length > MAX_LEN || !/<svg[\s>]/i.test(src)) return null;
  if (typeof DOMParser !== "undefined" && typeof XMLSerializer !== "undefined") {
    const doc = new DOMParser().parseFromString(src.slice(src.search(/<svg[\s>]/i)), "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length)
      return regexSanitize(src);
    clean(root);
    if (!root.getAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(root);
  }
  return regexSanitize(src);
}

function clean(node: Element): void {
  for (const attr of Array.from(node.attributes)) {
    const n = attr.name,
      v = attr.value;
    if (/^on/i.test(n) || BAD_VALUE.test(v) || (URL_ATTR.test(n) && !SAFE_HREF.test(v.trim())))
      node.removeAttribute(n);
    else if (n === "style") node.setAttribute("style", cleanCss(v));
    else if (/url\(/i.test(v) && !/url\(\s*['"]?#/i.test(v)) node.removeAttribute(n);
  }
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 8 || child.nodeType === 7 || child.nodeType === 10) {
      child.remove();
      continue;
    }
    if (child.nodeType !== 1) continue;
    const e = child as Element;
    if (!ELEMENTS.has(e.localName.toLowerCase())) {
      e.remove();
      continue;
    }
    if (e.localName.toLowerCase() === "style") {
      e.textContent = cleanCss(e.textContent ?? "");
      continue;
    }
    clean(e);
  }
}

/**
 * DOM-less fallback (node scripts, and markup the XML parser rejects): tokenize the tags and rebuild the drawing from
 * the allowlist — only ELEMENTS (anything else is dropped with its whole subtree), attribute names of plain syntax
 * without event handlers, values re-escaped. Nothing of the input reaches the output verbatim except text runs (which
 * cannot contain `<`), so parser differentials (`/` as attribute separator, unquoted values, HTML elements inside
 * `<desc>`, case) cannot smuggle markup through.
 */
function regexSanitize(src: string): string | null {
  const start = src.search(/<svg[\s>]/i);
  if (start < 0) return null;
  const s = src.slice(start);
  const out: string[] = [];
  // open elements: original name, lowercased name, whether it is emitted
  const stack: { name: string; lower: string; keep: boolean }[] = [];
  const dropping = () => stack.some((e) => !e.keep);
  const closeTo = (lower: string) => {
    const i = stack.map((e) => e.lower).lastIndexOf(lower);
    if (i < 0) return;
    while (stack.length > i) {
      const e = stack.pop()!;
      if (e.keep && !dropping()) out.push(`</${e.name}>`);
    }
  };
  let i = 0;
  let done = false;
  while (i < s.length && !done) {
    const lt = s.indexOf("<", i);
    const text = s.slice(i, lt < 0 ? s.length : lt);
    if (text && stack.length && !dropping()) out.push(text.replace(/>/g, "&gt;"));
    if (lt < 0) break;
    i = lt;
    if (s.startsWith("<!--", i)) {
      const e = s.indexOf("-->", i + 4);
      i = e < 0 ? s.length : e + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", i)) {
      const e = s.indexOf("]]>", i + 9);
      const body = s.slice(i + 9, e < 0 ? s.length : e);
      if (stack.length && !dropping()) out.push(escText(body));
      i = e < 0 ? s.length : e + 3;
      continue;
    }
    if (s[i + 1] === "!" || s[i + 1] === "?") {
      const e = s.indexOf(">", i);
      i = e < 0 ? s.length : e + 1;
      continue;
    }
    if (s[i + 1] === "/") {
      const m = /^<\/([^\t\n\f\r />]*)[^>]*(>|$)/.exec(s.slice(i));
      i += m ? m[0].length : 2;
      closeTo((m?.[1] ?? "").toLowerCase());
      if (!stack.length) done = true;
      continue;
    }
    if (!/[A-Za-z]/.test(s[i + 1] ?? "")) {
      if (stack.length && !dropping()) out.push("&lt;");
      i++;
      continue;
    }
    const tag = readTag(s, i + 1);
    if (!tag) break; // unterminated tag: drop the rest
    i = tag.end;
    const lower = tag.name.toLowerCase();
    if (!stack.length && lower !== "svg") return null;
    const keep = ELEMENTS.has(lower) && !dropping();
    if (keep)
      out.push(
        `<${tag.name}${cleanAttrs(tag.attrs, lower === "svg" && !stack.length)}${tag.selfClose ? "/>" : ">"}`,
      );
    if (tag.selfClose || HTML_VOID.has(lower)) {
      if (!stack.length) done = true;
      continue;
    }
    stack.push({ name: tag.name, lower, keep: ELEMENTS.has(lower) });
    if (lower === "style") {
      // raw text up to </style>; markup inside it is dropped, the CSS cleaned and re-escaped
      const m = /<\/style[\t\n\f\r />]/i.exec(s.slice(i));
      const end = m ? i + m.index : s.length;
      if (!dropping()) out.push(escText(cleanCss(styleText(s.slice(i, end)))));
      i = end;
    }
  }
  if (!stack.length && !done) return null;
  while (stack.length) {
    const e = stack.pop()!;
    if (e.keep && !dropping()) out.push(`</${e.name}>`);
  }
  return out.join("");
}

const HTML_WS = /[\t\n\f\r ]/;
const HTML_VOID = new Set(
  "area base br col embed hr img input keygen link meta param source track wbr".split(" "),
);
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const escText = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttrValue = (v: string) => escText(v).replace(/"/g, "&quot;");

/** One start tag from `s[at]` (just after `<`), HTML tokenizer rules: `/` and whitespace separate attributes. */
function readTag(
  s: string,
  at: number,
): { name: string; attrs: [string, string][]; selfClose: boolean; end: number } | null {
  let i = at;
  while (i < s.length && !HTML_WS.test(s[i]!) && s[i] !== "/" && s[i] !== ">") i++;
  const name = s.slice(at, i);
  const attrs: [string, string][] = [];
  let selfClose = false;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ">") return { name, attrs, selfClose, end: i + 1 };
    if (HTML_WS.test(c) || c === "/") {
      selfClose = c === "/" && s[i + 1] === ">";
      i++;
      continue;
    }
    selfClose = false;
    const n0 = i;
    i++; // a leading `=` belongs to the name
    while (i < s.length && !HTML_WS.test(s[i]!) && s[i] !== "/" && s[i] !== ">" && s[i] !== "=") i++;
    const attrName = s.slice(n0, i);
    let j = i;
    while (j < s.length && HTML_WS.test(s[j]!)) j++;
    let value = "";
    if (s[j] === "=") {
      j++;
      while (j < s.length && HTML_WS.test(s[j]!)) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, j + 1);
        if (e < 0) return null;
        value = s.slice(j + 1, e);
        j = e + 1;
      } else {
        const v0 = j;
        while (j < s.length && !HTML_WS.test(s[j]!) && s[j] !== ">") j++;
        value = s.slice(v0, j);
      }
      i = j;
    }
    attrs.push([attrName, decodeEntities(value)]);
  }
  return null;
}

const ATTR_NAME = /^(?:(xlink|xml):)?[A-Za-z_][\w.-]*$/;
/** Allowlisted attributes of one element, serialised (` name="value"`…), same rules as the DOM path's clean(). */
function cleanAttrs(attrs: [string, string][], root: boolean): string {
  const seen = new Set<string>();
  let out = "",
    ns = false;
  for (const [n, v] of attrs) {
    const lower = n.toLowerCase();
    if (seen.has(lower)) continue; // first one wins (HTML)
    seen.add(lower);
    let value = v;
    if (lower === "xmlns") {
      if (v !== SVG_NS) continue;
      ns = true;
    } else if (lower === "xmlns:xlink") {
      if (v !== XLINK_NS) continue;
    } else if (!ATTR_NAME.test(n) || lower === "xml:base" || /^on/.test(lower)) continue;
    else if (BAD_VALUE.test(v) || (URL_ATTR.test(lower) && !SAFE_HREF.test(v.trim()))) continue;
    else if (lower === "style") value = cleanCss(v);
    else if (/url\(/i.test(v) && !/url\(\s*['"]?#/i.test(v)) continue;
    out += ` ${n}="${escAttrValue(value)}"`;
  }
  if (root && !ns) out = ` xmlns="${SVG_NS}"${out}`;
  return out;
}

/** `<style>` content as CSS: CDATA sections literal, the rest entity-decoded, any markup dropped. */
const styleText = (raw: string) =>
  raw
    .split(/(<!\[CDATA\[[\s\S]*?(?:\]\]>|$))/)
    .map((part) =>
      part.startsWith("<![CDATA[")
        ? part.slice(9).replace(/\]\]>$/, "")
        : decodeEntities(part.replace(/<!--[\s\S]*?(-->|$)|<[^>]*>?/g, "")),
    )
    .join("");

/** viewBox of sanitised markup (for aspect-ratio hints), null when absent. */
export function svgViewBox(markup: string): [number, number, number, number] | null {
  const m = /<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/i.exec(markup);
  const v = m?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  return v && v.length === 4 && v.every(Number.isFinite) ? (v as [number, number, number, number]) : null;
}

/* ------------------------------------------------------------------ icon-font glyphs */

/** One line of SVG text that is the whole drawing (an icon font's ligature: `<text font-family="Material Icons">home</text>`). */
export interface SvgGlyphText {
  text: string;
  x: number;
  y: number;
  viewBox: [number, number, number, number];
  family: string;
  size: number;
  weight?: string;
  italic?: boolean;
  /** paint colour (absent = currentColor) */
  fill?: string;
  features?: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const codePoint = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd");
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) =>
    e[0] === "#"
      ? codePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : (ENTITIES[e.toLowerCase()] ?? m),
  );
const attrsOf = (tag: string) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)].map((m) => [
      m[1]!.toLowerCase(),
      decodeEntities(m[3] ?? m[4] ?? ""),
    ]),
  );
const numAttr = (v: string | undefined, fb: number) => {
  if (v === undefined) return fb;
  const n = Number(v.trim().replace(/px$/, ""));
  return Number.isFinite(n) ? n : NaN;
};

/**
 * The text of an SVG whose only content is a single plain `<text>` (icon-font glyphs from URL / HTML imports), else
 * null. WebKit — the desktop app's webview and Safari — never forms ligatures in SVG text, so `<text>home</text>` in an
 * icon font draws the word "home" there; renderers draw these as HTML text instead (svgGlyphStyle).
 */
export function svgGlyphText(markup: string | null | undefined): SvgGlyphText | null {
  if (!markup) return null;
  const m = /^\s*(<svg\b[^>]*>)\s*(<text\b[^>]*>)([^<]*)<\/text>\s*<\/svg>\s*$/i.exec(markup);
  if (!m) return null;
  const svg = attrsOf(m[1]!),
    t = attrsOf(m[2]!);
  const text = decodeEntities(m[3]!);
  if (
    !text.trim() ||
    t.transform ||
    t.dx ||
    t.dy ||
    t.rotate ||
    t.textlength ||
    t["text-anchor"] ||
    t["dominant-baseline"] ||
    /none/i.test(svg.preserveaspectratio ?? "")
  )
    return null;
  if (/text-anchor|dominant-baseline|alignment-baseline|transform|letter-spacing/i.test(t.style ?? ""))
    return null;
  const style = (k: string) =>
    new RegExp(`(?:^|;)\\s*${k}\\s*:\\s*([^;]+)`, "i").exec(t.style ?? "")?.[1]?.trim();
  const family = style("font-family") ?? t["font-family"];
  const size = numAttr(style("font-size") ?? t["font-size"], NaN);
  const x = numAttr(t.x, 0),
    y = numAttr(t.y, 0);
  const vb = (svg.viewbox ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBox: [number, number, number, number] | null =
    vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0
      ? (vb as [number, number, number, number])
      : numAttr(svg.width, NaN) > 0 && numAttr(svg.height, NaN) > 0
        ? [0, 0, numAttr(svg.width, NaN), numAttr(svg.height, NaN)]
        : null;
  if (!family || !(size > 0) || !Number.isFinite(x) || !Number.isFinite(y) || !viewBox) return null;
  const out: SvgGlyphText = { text, x, y, viewBox, family, size };
  const weight = style("font-weight") ?? t["font-weight"];
  if (weight) out.weight = weight;
  if (/italic|oblique/i.test(style("font-style") ?? t["font-style"] ?? "")) out.italic = true;
  const fill = style("fill") ?? t.fill;
  if (fill && !/^currentcolor$/i.test(fill) && fill !== "none") out.fill = fill;
  const features = style("font-feature-settings");
  if (features) out.features = features;
  return out;
}

/**
 * Absolute placement of an svgGlyphText inside a w × h box, as the SVG would draw it (viewBox scaled with the default
 * `xMidYMid meet`): pen start at x, alphabetic baseline at y. The span's bottom edge is trimmed to the baseline
 * (`text-box: trim-end text alphabetic`), so `bottom` puts the baseline exactly where the SVG has it.
 */
export function svgGlyphStyle(g: SvgGlyphText, w: number, h: number): CSSProperties {
  const [vx, vy, vw, vh] = g.viewBox;
  const k = Math.min(w / vw, h / vh);
  const ox = (w - vw * k) / 2 - vx * k,
    oy = (h - vh * k) / 2 - vy * k;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const out: CSSProperties = {
    position: "absolute",
    left: r(ox + g.x * k),
    bottom: r(h - (oy + g.y * k)),
    margin: 0,
    padding: 0,
    fontFamily: g.family,
    fontSize: r(g.size * k),
    fontWeight: g.weight as CSSProperties["fontWeight"],
    fontStyle: g.italic ? "italic" : "normal",
    lineHeight: "normal",
    letterSpacing: 0,
    whiteSpace: "pre",
    textTransform: "none",
    textDecoration: "none",
    fontFeatureSettings: g.features ?? '"liga" 1',
    fontVariantLigatures: "normal",
  };
  if (g.fill) out.color = g.fill;
  return out;
}
