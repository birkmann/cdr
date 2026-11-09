// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
/**
 * DOM snapshot (domCapture.js) → Design DSL. Pure (no DOM), shared by the app import and `pnpm import:url`.
 *
 *   painted boxes (background, image / gradient layers, borders, radius, shadows, opacity, filters, clip) → frame
 *   button, [role=button], painted <a>                                  → button (look comes from the snapshot, not the variant)
 *   wrappers that paint nothing (and are no landmark)                    → collapsed, children promoted with their paint order
 *   inline text of one block (spans, links, <br>)                        → one text element (rich-text runs when styles differ)
 *     … that reflows like the source (lines start / centre / end on the content box) at the content width, else one per line
 *   img / CSS cover-contain photos                                       → image (embedded data URL, fit + object-position)
 *   inline svg                                                           → icon with the SVG markup (computed paint inlined)
 *   video / canvas / iframe / unresolvable svg                           → image of the driver's screenshot of that box
 *   input / textarea / select                                            → frame "Input" + text (value or placeholder colour)
 * Every element is placed absolutely at its captured rect (fidelity first); afterwards frames whose children line up
 * like a flex row / column (constant gap, common start / centre / end) are turned into auto layout.
 */
import type {
  SceneEasing,
  SceneElement,
  SceneFill,
  SceneInteraction,
  SceneLayout,
  SceneFilter,
  SceneGradient,
  SceneLength,
  SceneOverlaySettings,
  SceneRunStyle,
  SceneScreen,
  SceneShadow,
  SceneStroke,
  SceneStyle,
  SceneTextRun,
  SceneTokens,
} from "@harness/protocol";
import { isDark, parseColor } from "../../dsl/color.js";
import { findElement, findParent } from "../../dsl/tree.js";
import type { BrandCapture } from "@harness/protocol";
import type {
  SnapBgLayer,
  SnapElement,
  SnapFont,
  SnapLayout,
  SnapLine,
  SnapMotion,
  SnapNode,
  SnapRect,
  SnapState,
  SnapText,
  Snapshot,
} from "@harness/capture";
import { nameFromText, Warnings } from "../shared.js";
import { dataUrlBytes, projectFontFromBytes, type ProjectFont } from "../../lib/projectFonts.js";

export interface UrlImportOptions {
  /** screen name (default: page title) */
  name?: string;
  /** infer auto layout where the geometry allows it (default true) */
  autoLayout?: boolean;
  /** id prefix for generated elements */
  idPrefix?: string;
  /** mark what stretches with the viewport (width 'fill', constraints; default true) */
  fluid?: boolean;
  /** snapshot element ids that stay their own element (never collapsed into the parent): controls that get an interaction */
  keep?: Iterable<number>;
  /**
   * flow first (default true): boxes the page lays out in flow stay in flow (side margins, wrapping flex rows taken from
   * the page's CSS, single-line text that may wrap, boxes as tall as their content); false keeps the fitted geometry
   * (every box where it was measured, only what lines up exactly in auto layout)
   */
  flow?: boolean;
}

export interface UrlImportStats {
  elements: number;
  text: number;
  images: number;
  icons: number;
  rasters: number;
  autoLayout: number;
  collapsed: number;
}

export interface UrlImportResult {
  screen: SceneScreen;
  /** webfont faces of the page as project fonts (family names match style.fontFamily) */
  fonts: ProjectFont[];
  warnings: string[];
  designSystemHints: Partial<SceneTokens>;
  stats: UrlImportStats;
  /** snapshot element id → id of the DSL element it became (absent: collapsed into its parent, dropped off-page) */
  idOf: Map<number, string>;
}

export class UrlImportError extends Error {}

/** One converted element plus what its parent needs to place and order it. */
interface Item {
  el: SceneElement;
  /** page-space box */
  abs: SnapRect;
  /** paint layer: -1 negative z, 0 blocks, 0.5 inline content, 1 positioned (z auto / 0), 2 positive z */
  tier: number;
  z: number;
  /** paint order inside a collapsed wrapper's layer (keeps static < inline < positioned within it) */
  sub?: number;
  order: number;
  /**
   * z-indexed layers inside this item's frame that belong to an outer stacking context (the frames in between form
   * none): lifted out of `owner` as soon as a sibling would otherwise be painted on the wrong side of them
   */
  zl?: { it: Item; owner: SceneElement }[];
}

interface Ctx {
  snap: Snapshot;
  warn: Warnings;
  stats: UrlImportStats;
  next: number;
  order: number;
  prefix: string;
  fontUse: Map<string, number>;
  colorUse: Map<string, number>;
  buttonBg: Map<string, number>;
  /** element → measured box size (auto-layout pass) */
  sizes: WeakMap<SceneElement, { w: number; h: number; rows?: number }>;
  /** an element's place in its CSS grid (`grid-column` / `grid-row` as the page gives them) */
  gridPlace?: WeakMap<SceneElement, { column?: string; row?: string }>;
  /** a text's CSS line height where its lines are measured further apart (see paragraphItems) */
  cssLine?: WeakMap<SceneElement, number>;
  /** a text's last line, in its own box: where it ends (x1) and its row (y, h) */
  lastLine?: WeakMap<SceneElement, { x1: number; y: number; h: number }>;
  /** layers that stay absolute inside auto layout (positioned in the page, background photos, list bullets) */
  outOfFlow: WeakSet<SceneElement>;
  keep: Set<number>;
  idOf: Map<number, string>;
  /** fixed / sticky boxes that stay in place while the page scrolls (pinnedBoxes) */
  pinned: Set<number>;
  /** elements of `position: sticky` boxes */
  sticky: WeakSet<SceneElement>;
  /** slider arrows (SnapElement.carousel) to link to their scrolling frame once the tree is built */
  controls: SnapElement[];
  /** boxes inside a scrolling frame (SnapElement.scroller): past the page edge is scrolled out of view, not off-page */
  scrolled: Set<number>;
  /** content box of the nearest block container: the width the lines of an inline box (a positioned <sup>) wrap in */
  lineBox?: SnapRect;
  /** the box being converted is a flex / grid item (its parent lays it out): kept as a group when it holds several layers */
  inFlex?: boolean;
  /** the page's own layout of a frame's source box (CSS padding: whether its height is its content's) */
  css: WeakMap<SceneElement, NonNullable<SnapElement["layout"]>>;
  /** frames that hug their content, with the height they had (restored where their parent does not flow them in a column) */
  hugFrom?: WeakMap<SceneElement, { height: number; padding: SceneLayout["padding"] }>;
  /** flow first (UrlImportOptions.flow) */
  flow: boolean;
  /** a child's top in its parent before auto layout dropped it (equal lines of a row / grid) */
  lineTop?: WeakMap<SceneElement, number>;
  /** the margins of an element's source box (and of the wrappers collapsed into it), top right bottom left */
  marginOf: WeakMap<SceneElement, number[]>;
  /** the CSS display of an element's source box (block-level boxes fill their container's width) */
  displayOf: WeakMap<SceneElement, string>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
/**
 * A gap / padding / margin measured a few hundredths off a half pixel (3.97, 3.99 for the page's 4 px) is that half
 * pixel: copies of one card then carry the same numbers
 */
const snap = (n: number) => {
  const h = Math.round(n * 2) / 2;
  return Math.abs(n - h) <= 0.05 ? h : r2(n);
};
const LANDMARK: Record<string, string> = {
  header: "Header",
  nav: "Nav",
  main: "Main",
  footer: "Footer",
  section: "Section",
  article: "Article",
  aside: "Aside",
  form: "Form",
  dialog: "Dialog",
  ul: "List",
  ol: "List",
  li: "List item",
  figure: "Figure",
  table: "Table",
};
const KEEP_TAGS = new Set([
  "header",
  "nav",
  "main",
  "footer",
  "section",
  "article",
  "aside",
  "form",
  "dialog",
]);
const bump = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/* ------------------------------------------------------------------ CSS value parsing */

const NUM = /-?\d*\.?\d+(?:e-?\d+)?/i;
const num = (v: string | undefined) => {
  const m = v ? NUM.exec(v) : null;
  return m ? parseFloat(m[0]) : 0;
};

/** split at top-level commas / whitespace */
export function splitTop(v: string, sep: "," | " " = ","): string[] {
  const out: string[] = [];
  let depth = 0,
    cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && (sep === "," ? ch === "," : /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const isTransparent = (c: string | undefined) =>
  !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);

/** "rgba(0, 0, 0, 0.2) 0px 2px 4px 0px, … inset" → shadows */
export function parseShadows(v: string | undefined): SceneShadow[] {
  if (!v || v === "none") return [];
  const out: SceneShadow[] = [];
  for (const part of splitTop(v)) {
    const color =
      /(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}|color\([^)]*\))/i.exec(part)?.[1] ?? "rgba(0,0,0,0.25)";
    if (isTransparent(color)) continue;
    const lens = part.replace(color, " ").replace(/inset/, " ").trim().split(/\s+/).filter(Boolean).map(num);
    const [x = 0, y = 0, blur = 0, spread = 0] = lens;
    out.push({
      x,
      y,
      blur,
      ...(spread ? { spread } : {}),
      color,
      ...(/\binset\b/.test(part) ? { inset: true } : {}),
    });
  }
  return out;
}

const pos = (v: string, len?: number): number | undefined => {
  if (v.endsWith("%")) return parseFloat(v) / 100;
  if (v.endsWith("px") && len) return parseFloat(v) / len;
  return undefined;
};

const SIDE_ANGLE: Record<string, number> = {
  "to top": 0,
  "to right": 90,
  "to bottom": 180,
  "to left": 270,
  "to top right": 45,
  "to right top": 45,
  "to bottom right": 135,
  "to right bottom": 135,
  "to bottom left": 225,
  "to left bottom": 225,
  "to top left": 315,
  "to left top": 315,
};

/** CSS gradient → SceneGradient (null when it does not parse; callers keep the raw CSS then). */
export function parseGradient(v: string, box?: { w: number; h: number }): SceneGradient | null {
  const m = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s.exec(v.trim());
  if (!m) return null;
  const kind = m[2] as "linear" | "radial" | "conic";
  const parts = splitTop(m[3]!);
  const g: SceneGradient = { kind, stops: [] };
  if (m[1]) g.repeating = true;
  const first = parts[0] ?? "";
  const prelude =
    /^(to\s|-?[\d.]+(deg|turn|rad|grad)\b|circle|ellipse|closest|farthest|from\s|at\s)/.test(first) ||
    (kind !== "linear" && (/\bat\b/.test(first) || /^-?[\d.]+(px|%|em)/.test(first)));
  if (prelude) {
    // gradient line / shape prelude
    if (kind === "linear") {
      if (/deg$/.test(first)) g.angle = num(first);
      else if (/turn$/.test(first)) g.angle = num(first) * 360;
      else if (/rad$/.test(first)) g.angle = (num(first) * 180) / Math.PI;
      else if (SIDE_ANGLE[first] !== undefined) {
        g.angle = SIDE_ANGLE[first];
        // corner directions: perpendicular to the diagonal between the two neighbouring corners (depends on the aspect)
        if (box && box.w > 0 && box.h > 0 && /\s(left|right)$|\s(top|bottom)$/.test(first.slice(3))) {
          const a = (Math.atan2(box.h, box.w) * 180) / Math.PI;
          const top = first.includes("top"),
            right = first.includes("right");
          g.angle = r2(top ? (right ? a : 360 - a) : right ? 180 - a : 180 + a);
        }
      } else return null;
    } else if (kind === "radial") {
      const [shapeSize, at] = first.split(/\s+at\s+/);
      const ss = (shapeSize ?? "").trim();
      if (/circle/.test(ss)) g.shape = "circle";
      const kw = /(closest-side|closest-corner|farthest-side|farthest-corner)/.exec(ss)?.[1];
      if (kw) g.size = kw as SceneGradient["size"];
      else {
        const lens = ss
          .replace(/circle|ellipse/, "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (lens.length) g.size = [lenOf(lens[0]!), lenOf(lens[1] ?? lens[0]!)];
      }
      if (at) {
        const a = at.trim().split(/\s+/);
        g.at = [posLen(a[0] ?? "50%"), posLen(a[1] ?? a[0] ?? "50%")];
      }
    } else {
      const from = /from\s+(-?[\d.]+)deg/.exec(first);
      if (from) g.angle = parseFloat(from[1]!);
      const at = /at\s+(.*)$/.exec(first);
      if (at) {
        const a = at[1]!.trim().split(/\s+/);
        g.at = [posLen(a[0] ?? "50%"), posLen(a[1] ?? a[0] ?? "50%")];
      }
    }
    parts.shift();
  }
  const len =
    kind === "linear" && box
      ? Math.abs(box.w * Math.sin(((g.angle ?? 180) * Math.PI) / 180)) +
        Math.abs(box.h * Math.cos(((g.angle ?? 180) * Math.PI) / 180))
      : undefined;
  for (const p of parts) {
    const color = /^(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}|color\([^)]*\)|transparent|[a-z]+)/i.exec(
      p.trim(),
    )?.[1];
    if (!color) {
      // colour hint (a bare position): ignored
      if (/^[\d.]+(%|px)$/.test(p.trim())) continue;
      return null;
    }
    const rest = p.trim().slice(color.length).trim().split(/\s+/).filter(Boolean);
    if (!rest.length) g.stops.push({ color });
    for (const r of rest) {
      const at = pos(r, len);
      g.stops.push(at === undefined ? { color } : { color, pos: r2(at) });
    }
  }
  if (g.stops.length < 2) return null;
  return g;
}
const lenOf = (v: string): SceneLength => (v.endsWith("%") ? (`${parseFloat(v)}%` as SceneLength) : num(v));
const POS_KW: Record<string, string> = {
  left: "0%",
  top: "0%",
  center: "50%",
  right: "100%",
  bottom: "100%",
};
const posLen = (v: string): SceneLength => lenOf(POS_KW[v] ?? v);

/** "50% 50%" / "0px 100%" → [x, y] */
export function parsePosition(v: string | undefined): [SceneLength, SceneLength] | undefined {
  if (!v) return undefined;
  const p = splitTop(v.trim(), " ");
  if (p.some((x) => /calc|var/.test(x))) return undefined;
  if (p.length === 1) return [posLen(p[0]!), "50%"];
  if (p.length === 2) return [posLen(p[0]!), posLen(p[1]!)];
  return undefined;
}

function parseFilter(v: string | undefined): SceneFilter | undefined {
  if (!v || v === "none") return undefined;
  const f: SceneFilter = {};
  for (const m of v.matchAll(/([a-z-]+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const [, fn, arg] = m;
    const n = num(arg);
    const frac = arg!.trim().endsWith("%") ? n / 100 : n;
    switch (fn) {
      case "blur":
        f.blur = n;
        break;
      case "brightness":
        f.brightness = frac;
        break;
      case "contrast":
        f.contrast = frac;
        break;
      case "saturate":
        f.saturate = frac;
        break;
      case "grayscale":
        f.grayscale = frac;
        break;
      case "sepia":
        f.sepia = frac;
        break;
      case "invert":
        f.invert = frac;
        break;
      case "hue-rotate":
        f.hueRotate = n;
        break;
      default:
        break;
    }
  }
  return Object.keys(f).length ? f : undefined;
}

/** rotation (deg, clockwise) of a CSS matrix() transform; 0 when untransformed / translate-only */
export function rotationOf(t: string | undefined): number {
  if (!t || t === "none") return 0;
  const m = /^matrix\(([^)]*)\)$/.exec(t);
  if (!m) return 0;
  const [a = 1, b = 0] = m[1]!.split(",").map(Number);
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return Math.abs(deg) < 0.05 ? 0 : r2(deg);
}

/* ------------------------------------------------------------------ names */

const GENERIC_CLASS =
  /^(grid|row|col|cols?-\d+|container|wrapper|wrap|inner|outer|content|layout|layout-stack|flex|d-\w+|m[trblxy]?-\d+|p[trblxy]?-\d+|w-\d+|h-\d+|clearfix|js-.*|is-.*|has-.*|active|visible|hidden|notranslate|cmp-container|aem-.*|\w{1,2})$/i;
export function prettyClass(cls: string | undefined): string | null {
  if (!cls) return null;
  for (const c of cls.split(/\s+/)) {
    if (!c || GENERIC_CLASS.test(c)) continue;
    // CSS modules: Header_navbar__axVCt → navbar · _BdsButton_106a2_2 → BdsButton · BEM: cmp-list__item-link → list item link
    let base = c
      .replace(/_{2,3}[A-Za-z0-9-]{4,6}$/, "")
      .replace(/^_/, "")
      .replace(/_[a-z0-9]{5}_\d+$/, "");
    const mod = /^([A-Z]\w*?)_(\w+)$/.exec(base);
    if (mod) base = mod[2] === mod[1] ? mod[1]! : mod[2]!;
    // generated ids (AEM "container-9e7008e1f8", hashes) carry no meaning
    base = base
      .replace(/^(cmp|c|o|u|l|m)-/, "")
      .replace(/[-_]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(" ")
      .filter((w) => !/^(?=.*\d)[a-z0-9]{6,}$/i.test(w))
      .join(" ")
      .trim();
    if (base.length < 3 || /^\d/.test(base)) continue;
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  return null;
}

function nameOf(n: SnapElement, fallback?: string): string {
  const a = n.attrs ?? {};
  const label = a["aria-label"] ?? a.alt ?? (n.alt || undefined) ?? a.title;
  if (label) return nameFromText(label, 40);
  if (n.pseudo) return `::${n.pseudo}`;
  return (
    LANDMARK[n.tag] ??
    prettyClass(a.class) ??
    (a.id && !a.id.startsWith("__") && !/\d{3}/.test(a.id)
      ? nameFromText(a.id.replace(/[-_]+/g, " "), 32)
      : null) ??
    fallback ??
    n.tag
  );
}

/* ------------------------------------------------------------------ text */

interface RunIn {
  t: SnapText;
  href?: string;
}
type InlineItem = RunIn | { br: true };
const isBr = (i: InlineItem): i is { br: true } => "br" in i;

const weightOf = (w: number) =>
  Math.min(900, Math.max(100, Math.round(w / 100) * 100)) as NonNullable<SceneStyle["fontWeight"]>;

function decorationOf(f: SnapFont): SceneStyle["decoration"] | undefined {
  const d = f.decoration;
  if (!d || !/underline|line-through|overline/.test(d.line)) return undefined;
  const line = /underline/.test(d.line)
    ? "underline"
    : /line-through/.test(d.line)
      ? "line-through"
      : "overline";
  const out: NonNullable<SceneStyle["decoration"]> = { line };
  if (d.color && d.color !== f.color) out.color = d.color;
  if (/px$/.test(d.thickness)) out.thickness = num(d.thickness);
  if (/px$/.test(d.offset)) out.offset = num(d.offset);
  if (d.style && d.style !== "solid") out.style = d.style as NonNullable<SceneStyle["decoration"]>["style"];
  return out;
}

/** The drawn family followed by the page's own fallbacks after it ('Transit, Arial, sans-serif'), deduplicated. */
function familyList(f: SnapFont): string {
  const stack = splitTop(f.stack || "")
    .map((x) => x.replace(/["']/g, "").trim())
    .filter(Boolean);
  const i = stack.findIndex((x) => x.toLowerCase() === f.family.toLowerCase());
  if (i < 0) return f.family;
  const seen = new Set<string>();
  return stack
    .slice(i)
    .filter((x) => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(", ");
}

/** Typography of one run (font + line height in px). */
function fontStyle(f: SnapFont, lineHeightPx: number): SceneStyle {
  const s: SceneStyle = {
    fontFamily: familyList(f),
    fontSize: r2(f.size),
    fontWeight: weightOf(f.weight),
    lineHeightPx: r2(lineHeightPx),
    color: f.color,
  };
  if (f.textWrap) s.textWrap = f.textWrap;
  if (f.hyphens) s.hyphens = "auto";
  if (f.letterSpacing) s.letterSpacing = r2((f.letterSpacing / f.size) * 1000) / 1000;
  else s.letterSpacing = 0;
  if (f.italic) s.italic = true;
  if (f.transform && f.transform !== "none") s.textTransform = f.transform as SceneStyle["textTransform"];
  const deco = decorationOf(f);
  if (deco) s.decoration = deco;
  if (f.shadow) {
    const sh = parseShadows(f.shadow);
    if (sh.length) s.shadows = sh.map(({ spread: _s, inset: _i, ...x }) => x);
  }
  if (f.features) s.fontFeatures = f.features;
  if (f.stretch && /^\d+(\.\d+)?%$/.test(f.stretch) && f.stretch !== "100%") s.fontStretch = f.stretch;
  return s;
}
const runKey = (f: SnapFont, href?: string) =>
  [
    f.family,
    f.size,
    f.weight,
    f.italic,
    f.color,
    f.transform,
    f.decoration?.line,
    f.decoration?.color,
    f.letterSpacing,
    f.shadow,
    f.stretch,
    href ?? "",
  ].join("|");

interface Row {
  y: number;
  h: number;
  x0: number;
  x1: number;
  lines: { line: SnapLine; run: number }[];
}

/**
 * Lines of a text node drawn right to left (a mirrored / 180°-rotated box — a ligature icon turned into a "chevron up"
 * — or RTL script): the capture measures glyph by glyph and each glyph left of the previous one starts a "line" of its
 * own on the same row. Joined back into one line in DOM order (sorting them by x would reverse the text).
 */
export function joinMirroredLines(lines: SnapLine[]): SnapLine[] {
  if (lines.length < 2) return lines;
  const out: SnapLine[] = [];
  for (const l of lines) {
    const cur = out[out.length - 1];
    if (
      cur &&
      Math.abs(l.y - cur.y) < 0.5 &&
      Math.abs(l.h - cur.h) < 0.5 &&
      l.x + l.w <= cur.x + 2 &&
      l.x < cur.x
    ) {
      const x1 = cur.x + cur.w;
      out[out.length - 1] = {
        ...cur,
        text: cur.text + (cur.brk === "space" ? " " : "") + l.text,
        x: l.x,
        w: r2(x1 - l.x),
        brk: l.brk,
      };
    } else out.push(l);
  }
  return out.length === lines.length ? lines : out;
}

function rowsOf(runs: RunIn[]): Row[] {
  const all: { line: SnapLine; run: number }[] = [];
  runs.forEach((r, i) => r.t.lines.forEach((line) => all.push({ line, run: i })));
  const rows: Row[] = [];
  for (const it of all) {
    const l = it.line,
      mid = l.y + l.h / 2;
    // overlapping pieces are separate rows (stacked texts), except pieces of one run on one line: glyph boxes measured
    // one by one (a line-clamped line) overlap their neighbours
    let row = rows.find(
      (rw) =>
        mid >= rw.y - 1 &&
        mid <= rw.y + rw.h + 1 &&
        !rw.lines.some(
          (o) =>
            !(o.run === it.run && Math.abs(o.line.y - l.y) < 0.5) &&
            l.x < o.line.x + o.line.w - 1 &&
            l.x + l.w > o.line.x + 1,
        ),
    );
    if (!row) {
      row = { y: l.y, h: l.h, x0: l.x, x1: l.x + l.w, lines: [] };
      rows.push(row);
    }
    row.lines.push(it);
    row.x0 = Math.min(row.x0, l.x);
    row.x1 = Math.max(row.x1, l.x + l.w);
    const y1 = Math.max(row.y + row.h, l.y + l.h);
    row.y = Math.min(row.y, l.y);
    row.h = y1 - row.y;
  }
  rows.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  for (const rw of rows) rw.lines.sort((a, b) => a.line.x - b.line.x);
  return rows;
}

/** Split a row where inline boxes (icons, badges) sit between text pieces. */
function segmentsOf(rw: Row, runs: RunIn[]): Row[] {
  const out: Row[] = [];
  for (const it of rw.lines) {
    const last = out[out.length - 1];
    const em = runs[it.run]!.t.font.size;
    if (last && it.line.x - last.x1 <= 0.5 * em) {
      last.lines.push(it);
      last.x1 = Math.max(last.x1, it.line.x + it.line.w);
      const y1 = Math.max(last.y + last.h, it.line.y + it.line.h);
      last.y = Math.min(last.y, it.line.y);
      last.h = y1 - last.y;
    } else out.push({ y: it.line.y, h: it.line.h, x0: it.line.x, x1: it.line.x + it.line.w, lines: [it] });
  }
  return out;
}

type Part = { text: string; font: SnapFont; href?: string };

/** Text pieces of one row (spaces where the source shows a gap between pieces). */
function rowParts(rw: Row, runs: RunIn[], collapse: boolean): Part[] {
  const parts: Part[] = [];
  rw.lines.forEach((it, i) => {
    const prev = rw.lines[i - 1];
    const r = runs[it.run]!;
    let text = collapse ? it.line.text.replace(/[ \t\r\n]+/g, " ") : it.line.text;
    // a visible gap is a space: it belongs to the run whose source text has it (keeps link underlines off the space)
    if (prev && it.line.x - (prev.line.x + prev.line.w) > 0.12 * r.t.font.size) {
      if (it.run !== prev.run && /\s$/.test(runs[prev.run]!.t.text)) parts[parts.length - 1]!.text += " ";
      else text = ` ${text}`;
    } else if (
      prev &&
      prev.run === it.run &&
      prev.line.brk === "space" &&
      !/^\s/.test(text) &&
      !/\s$/.test(parts[parts.length - 1]!.text)
    )
      text = ` ${text}`;
    parts.push({ text, font: r.t.font, href: r.href });
  });
  return parts;
}

function contentBox(n: SnapElement): SnapRect {
  const b = n.layout?.borderWidth ?? [0, 0, 0, 0],
    p = n.layout?.padding ?? [0, 0, 0, 0];
  return {
    x: n.rect.x + b[3]! + p[3]!,
    y: n.rect.y + b[0]! + p[0]!,
    w: n.rect.w - b[1]! - b[3]! - p[1]! - p[3]!,
    h: n.rect.h - b[0]! - b[2]! - p[0]! - p[2]!,
  };
}

/** Build a text element from runs (rich text when they differ). `width` undefined = hug + no wrap. */
function textElement(
  ctx: Ctx,
  runs: { text: string; font: SnapFont; href?: string }[],
  lineHeightPx: number,
  box: SnapRect,
  align: string | undefined,
  width: number | undefined,
  rows: number,
): Item | null {
  // merge neighbours with the same style, normalise spaces at boundaries
  const merged: { text: string; font: SnapFont; href?: string }[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && runKey(last.font, last.href) === runKey(r.font, r.href)) last.text += r.text;
    else merged.push({ ...r });
  }
  for (let i = 1; i < merged.length; i++)
    if (merged[i - 1]!.text.endsWith(" ") && merged[i]!.text.startsWith(" "))
      merged[i]!.text = merged[i]!.text.slice(1);
  if (merged[0]) merged[0].text = merged[0].text.replace(/^[ ]+/, "");
  const lastRun = merged[merged.length - 1];
  if (lastRun) lastRun.text = lastRun.text.replace(/[ ]+$/, "");
  for (let i = 0; i < merged.length; i++) merged[i]!.text = merged[i]!.text.replace(/ *\n */g, "\n");
  const visible = merged.filter((r) => r.text.length);
  const text = visible.map((r) => r.text).join("");
  if (!text.trim()) return null;
  // dominant run = most characters
  const dom = [...visible].sort((a, b) => b.text.length - a.text.length)[0]!;
  const style = fontStyle(dom.font, lineHeightPx);
  // gradient text (`background-clip: text` over a transparent fill): the gradient, clipped to this text
  const g = dom.font.clipBg && !/url\(/.test(dom.font.clipBg) ? parseGradient(dom.font.clipBg, box) : null;
  if (g) {
    style.fills = [{ type: "gradient", ...g }];
    style.backgroundClip = "text";
  }
  // decorations propagate to every descendant span: the base only carries one all runs share
  const decoKey = (f: SnapFont) => JSON.stringify(decorationOf(f) ?? null);
  if (style.decoration && visible.some((r) => decoKey(r.font) !== decoKey(dom.font))) delete style.decoration;
  if (width !== undefined && align && align !== "start" && align !== "left" && align !== "-webkit-left")
    style.textAlign =
      align === "end" || align === "-webkit-right"
        ? "right"
        : align === "center" || align === "-webkit-center"
          ? "center"
          : align === "justify"
            ? "justify"
            : align === "right"
              ? "right"
              : undefined;
  if (!style.textAlign) delete style.textAlign;
  // a line that never wraps carries no wrap hints (`text-wrap: balance` would also switch `white-space: pre` back to wrapping)
  if (width === undefined) {
    style.whiteSpace = "pre";
    delete style.textWrap;
    delete style.hyphens;
  }
  const el: SceneElement = {
    id: nid(ctx),
    type: "text",
    name: nameFromText(text.replace(/­/g, ""), 32),
    text,
    style,
    layout: { position: "absolute", ...(width !== undefined ? { width: r2(width) } : {}) },
  };
  if (visible.length > 1 || visible[0]!.href) {
    const domKey = runKey(dom.font);
    el.runs = visible.map((r): SceneTextRun => {
      const run: SceneTextRun = { text: r.text };
      if (runKey(r.font) !== domKey || decoKey(r.font) !== JSON.stringify(style.decoration ?? null)) {
        const rs = fontStyle(r.font, lineHeightPx);
        const diff: SceneRunStyle = {};
        for (const k of [
          "color",
          "fontFamily",
          "fontSize",
          "fontWeight",
          "italic",
          "letterSpacing",
          "decoration",
          "textTransform",
          "fontFeatures",
          "fontStretch",
        ] as const) {
          if (JSON.stringify(rs[k]) !== JSON.stringify(style[k])) {
            const v = rs[k] ?? (k === "italic" ? false : k === "textTransform" ? "none" : undefined);
            if (v !== undefined) (diff as Record<string, unknown>)[k] = v;
          }
        }
        if (Object.keys(diff).length) run.style = diff;
      }
      if (r.href && /^(https?:|mailto:|tel:|#)/.test(r.href)) run.href = r.href;
      return run;
    });
  }
  for (const r of visible) {
    bump(ctx.fontUse, r.font.family, r.text.length);
    bump(ctx.colorUse, r.font.color, r.text.length);
  }
  ctx.stats.text++;
  ctx.sizes.set(el, { w: width ?? box.w, h: box.h, rows });
  return { el, abs: { ...box, w: width ?? box.w }, tier: 0.5, z: 0, order: ctx.order++ };
}

const ICON_FONT = /icon|glyph|symbol|awesome|material|fontello|icomoon/i;
const xml = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One icon-font glyph as an icon: an SVG drawing the glyph with the page's (embedded) icon font, colour = currentColor. */
function glyphIcon(ctx: Ctx, t: SnapText): Item {
  const l = t.lines[0]!,
    f = t.font;
  const word = t.text.trim();
  const asc = f.ascent ?? f.size * 0.8;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(l.w)}" height="${r2(l.h)}" viewBox="0 0 ${r2(l.w)} ${r2(l.h)}" overflow="visible"><text x="0" y="${r2(asc)}" font-family="${xml(f.family)}" font-size="${r2(f.size)}" font-weight="${f.weight}" fill="currentColor" style="font-feature-settings:'liga' 1;white-space:pre">${xml(word)}</text></svg>`;
  const el: SceneElement = {
    id: nid(ctx),
    type: "icon",
    name: `Icon · ${nameFromText(word.replace(/_/g, " "), 24)}`,
    svg,
    layout: { position: "absolute", width: r2(l.w), height: r2(l.h) },
    style: { color: f.color },
    meta: { glyph: word, iconFont: f.family },
  };
  bump(ctx.fontUse, f.family, 1);
  ctx.stats.icons++;
  ctx.sizes.set(el, { w: l.w, h: l.h });
  return { el, abs: { x: l.x, y: l.y, w: l.w, h: l.h }, tier: 0.5, z: 0, order: ctx.order++ };
}

/** First word of a row and its estimated width (glyph-by-glyph pieces of a row read as one string). */
function firstWord(rw: Row): { w: number } {
  const t = rw.lines
    .map((x) => x.line.text + (x.line.brk === "space" ? " " : ""))
    .join("")
    .trimStart();
  const word = t.split(/\s/)[0] ?? "";
  return { w: t.length ? ((rw.x1 - rw.x0) * word.length) / t.length : 0 };
}

/**
 * Line-clamped text (line-clamp / -webkit-line-clamp): the block clips and its content box holds exactly the rows that
 * show, while rows below it were captured (hidden) or the captured lines stop before the source text does. Returns the
 * visible row count and the clipped rest of the text not in any line (appended so the renderer's clamp ends the last
 * line with an ellipsis like the page), else null.
 */
function clampOf(
  items: InlineItem[],
  runs: RunIn[],
  block: SnapElement,
  cb: SnapRect,
  rows: Row[],
  LH: number,
): { lines: number; tail: string } | null {
  const ov = block.style?.overflow;
  if (!ov || ov[1] === "visible") return null;
  const lines = rows.filter((rw) => rw.y + rw.h / 2 < cb.y + cb.h).length;
  if (!lines || Math.abs(cb.h - lines * LH) > 1) return null;
  const last = runs[runs.length - 1]!;
  const shown = last.t.lines
    .map((l) => l.text)
    .join("")
    .replace(/\s+/g, "");
  const src = last.t.text;
  let i = 0,
    n = 0;
  while (i < src.length && n < shown.length) {
    if (!/\s/.test(src[i]!)) {
      if (src[i] !== shown[n]) return null;
      n++;
    }
    i++;
  }
  if (n < shown.length) return null;
  // the rest of this run plus the runs after it that have no captured line
  const after = items.slice(items.findIndex((x) => !isBr(x) && x.t === last.t) + 1);
  const rest = (src.slice(i) + after.map((x) => (isBr(x) ? " " : x.t.text)).join("")).replace(/\s+/g, " ");
  const tail = rest.trim() ? rest.replace(/ $/, "") : "";
  return lines < rows.length || tail ? { lines, tail } : null;
}

/**
 * Inline content of one block → text items. One reflowing paragraph at the content width when every line starts /
 * centres / ends on the content box like CSS put it (hard line breaks when the source wrapped earlier than the width
 * requires, e.g. text-wrap: balance); otherwise one element per rendered line piece (exact positions).
 */
const HEADINGS = new WeakMap<Ctx, Set<number>>();
function headingsOf(ctx: Ctx): Set<number> {
  let seen = HEADINGS.get(ctx);
  if (!seen) HEADINGS.set(ctx, (seen = new Set()));
  return seen;
}

function paragraphItems(ctx: Ctx, items: InlineItem[], block: SnapElement): Item[] {
  const out = paragraphItemsOf(ctx, items, block);
  // the element the page wrote the text in: `h2` stays `h2` whatever it looks like (one heading in spans is one heading)
  for (const it of out) {
    const h = block.heading;
    if (it.el.type !== "text" || !h) continue;
    const first = !headingsOf(ctx).has(h.id);
    if (first) headingsOf(ctx).add(h.id);
    it.el.meta = { ...it.el.meta, textTag: first ? h.tag : "p" };
  }
  return out;
}

function paragraphItemsOf(ctx: Ctx, items: InlineItem[], block: SnapElement): Item[] {
  const out: Item[] = [];
  const runs: RunIn[] = [];
  // <br>s after a run: two in a row leave a blank line (vw.com's "…so much more.<br><br>The 2027 …")
  const brAfter = new Map<number, number>();
  for (const it of items) {
    if (isBr(it)) {
      if (runs.length) brAfter.set(runs.length - 1, (brAfter.get(runs.length - 1) ?? 0) + 1);
      continue;
    }
    // invisible text stays out, gradient text (a transparent fill over a background clipped to it) does not
    if (!it.t.lines.length || (isTransparent(it.t.font.color) && !it.t.font.clipBg)) continue;
    if (it.t.marker) {
      const m = paragraphItems(ctx, [{ ...it, t: { ...it.t, marker: false } }], {
        ...block,
        layout: { display: "marker", position: "static" },
        rect: { x: it.t.lines[0]!.x, y: it.t.lines[0]!.y, w: it.t.lines[0]!.w, h: it.t.lines[0]!.h },
      });
      m.forEach((x) => {
        x.el.name = "Bullet";
      });
      out.push(...m);
      continue;
    }
    const lines = joinMirroredLines(it.t.lines);
    runs.push(lines === it.t.lines ? it : { ...it, t: { ...it.t, lines } });
  }
  // icon-font glyphs (ligature words / private-use code points drawn by an icon font) become icons
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (!ICON_FONT.test(r.t.font.family) || r.t.lines.length !== 1) continue;
    out.push(glyphIcon(ctx, r.t));
    runs.splice(i, 1);
  }
  if (!runs.length) return out;
  const rows = rowsOf(runs);
  const dom = [...runs].sort((a, b) => b.t.text.length - a.t.text.length)[0]!.t.font;
  const pitch = rows.length > 1 ? (rows[rows.length - 1]!.y - rows[0]!.y) / (rows.length - 1) : 0;
  // evenly spaced rows taller than every run's line height: the block's own line height (its strut) sets the line boxes
  // (a 14px span with line-height 21 in a block with line-height 24) — the measured pitch is what the page shows. A
  // bigger run inflating its line (mixed sizes) keeps the CSS line height: the other lines do not move.
  // (pitch measured between lines of one run: glyph boxes of different sizes are not comparable)
  const steps = runs
    .flatMap((r) => r.t.lines.slice(1).map((l, i) => l.y - r.t.lines[i]!.y))
    .filter((d) => d > 0.5);
  const tallest = Math.max(...runs.map((r) => r.t.font.lineHeight ?? 0));
  const strut =
    steps.length && steps.every((d) => Math.abs(d - steps[0]!) <= 0.6) && steps[0]! > tallest + 0.5
      ? steps[0]!
      : null;
  const LH = strut ?? dom.lineHeight ?? (pitch > 0 ? pitch : rows[0]!.h);
  const collapse = !/^(pre|pre-wrap|break-spaces)$/.test(dom.whiteSpace);
  // an inline box's own rect is its lines' extent (the longest one exactly as wide): its text wraps in the block around
  // it (vw.com's subtitle in a positioned <sup> broke a word early at a hair of font-metric difference)
  const cb = block.layout?.display === "inline" && ctx.lineBox ? ctx.lineBox : contentBox(block);
  const align = dom.align;
  // the first line box starts at the block's content top: deriving it from the glyph box assumes the half-leading splits
  // evenly, which Chromium rounds (20.8px lines around a 19px glyph start at the glyph top, not 0.9px above it)
  const centred = (rw: Row) => rw.y + rw.h / 2 - LH / 2;
  const flow = /^(block|list-item|inline-block|flow-root|table-cell)$/.test(block.layout?.display ?? "block");
  const lead = cb.y - centred(rows[0]!);
  const shift = flow && Math.abs(lead) <= 1 && rows[0]!.y >= cb.y - 0.5 ? lead : 0;
  const top = (rw: Row) => centred(rw) + shift;
  const segs = rows.map((rw) => segmentsOf(rw, runs));
  const pieces = segs.some((x) => x.length > 1);
  const tol = 1.5;
  const fits =
    !pieces &&
    cb.w > 0 &&
    rows.every((rw) => {
      if (align === "center" || align === "-webkit-center")
        return Math.abs((rw.x0 + rw.x1) / 2 - (cb.x + cb.w / 2)) <= tol;
      if (align === "right" || align === "end" || align === "-webkit-right")
        return Math.abs(rw.x1 - (cb.x + cb.w)) <= tol;
      return Math.abs(rw.x0 - cb.x) <= tol;
    });
  const clamp = fits && collapse ? clampOf(items, runs, block, cb, rows, LH) : null;
  // flow first: a single line in a block-level box with room left on it is a paragraph that happens to fit, and wraps
  // when the box narrows (a shrink-to-fit box, a button or an inline-block link, is exactly as wide as its line: it
  // keeps the line). Lines the page keeps from wrapping (nowrap, pre) stay single lines.
  const room =
    ctx.flow &&
    rows.length === 1 &&
    collapse &&
    !/nowrap/.test(block.layout?.whiteSpace ?? "") &&
    !/nowrap/.test(dom.whiteSpace ?? "") &&
    /^(block|list-item|flow-root|table-cell)$/.test(block.layout?.display ?? "block") &&
    cb.w - (rows[0]!.x1 - rows[0]!.x0) > Math.max(4, 0.5 * dom.size);
  if ((rows.length > 1 || clamp || room) && fits) {
    // forced breaks (<br>) and breaks the width does not explain (balanced / pretty wrapping) stay hard
    // (a clamped text flows by width: the ellipsis lands where the browser's wrapping puts it)
    let hard = false;
    const lastLineOf = (rw: Row) => rw.lines[rw.lines.length - 1]!;
    const forced = (rw: Row) => {
      const l = lastLineOf(rw);
      const r = runs[l.run]!;
      return brAfter.has(l.run) && r.t.lines[r.t.lines.length - 1] === l.line;
    };
    const breaks = (rw: Row) => brAfter.get(lastLineOf(rw).run) ?? 1;
    // flow first: only the page's own breaks (<br>) stay hard; lines that broke earlier than the width needs come
    // from balanced / pretty wrapping, which the text then asks for itself (it rewraps the same way at every width)
    let early = false;
    rows.slice(0, -1).forEach((rw, i) => {
      if (forced(rw) || clamp) return;
      if (
        !dom.textWrap &&
        lastLineOf(rw).line.brk !== "word" &&
        rw.x1 - rw.x0 + 0.3 * dom.size + firstWord(rows[i + 1]!).w < cb.w - 2
      ) {
        if (ctx.flow) early = true;
        else hard = true;
      }
    });
    const parts: Part[] = [];
    rows.forEach((rw, i) => {
      const ps = rowParts(rw, runs, collapse);
      if (i < rows.length - 1) {
        const l = lastLineOf(rw);
        const sep = forced(rw)
          ? "\n".repeat(breaks(rw))
          : hard
            ? l.line.brk === "word"
              ? "-\n"
              : "\n"
            : l.line.brk === "join"
              ? ""
              : l.line.brk === "word"
                ? // a word broken where the page hyphenates (or a soft hyphen): a soft hyphen; flow first: a word the
                  // page only broke to fit its box (overflow-wrap) is left whole, the box breaks it again
                  ctx.flow && dom.hyphens !== "auto" && !/\u00ad$/.test(l.line.text)
                  ? ""
                  : "\u00ad"
                : " ";
        ps[ps.length - 1]!.text += sep;
      }
      parts.push(...ps);
    });
    if (clamp) parts[parts.length - 1]!.text += clamp.tail;
    // reflow width: the content width, unless a soft break sits close to it (the next word may have missed the line by a
    // pixel in the source; a hair of font-metric difference would pull it up). Wrapping that does not depend on the width
    // (start / centre / end aligned, no balancing) then gets the tightest width holding the longest line, same anchor.
    let w = Math.ceil(cb.w * 100) / 100,
      x = cb.x;
    const longest = Math.max(...rows.map((rw) => rw.x1 - rw.x0));
    const fragile =
      !hard &&
      rows.slice(0, -1).some((rw, i) => {
        const brk = lastLineOf(rw).line.brk;
        if (forced(rw) || (brk && brk !== "space")) return false;
        // lower bound of the next word's width (proportional estimate, narrow letters) + a narrow space
        return rw.x1 - rw.x0 + 0.2 * dom.size + 0.6 * firstWord(rows[i + 1]!).w <= w;
      });
    // (flow first: the text keeps its box's width, so its margins are the page's at every width and it wraps there)
    if (!ctx.flow && fragile && !clamp && !dom.textWrap && align !== "justify" && longest + 2 < w) {
      w = longest + 2;
      x +=
        align === "center" || align === "-webkit-center"
          ? (cb.w - w) / 2
          : align === "right" || align === "end" || align === "-webkit-right"
            ? cb.w - w
            : 0;
    }
    const blank = rows.slice(0, -1).reduce((n, rw) => n + (forced(rw) ? breaks(rw) - 1 : 0), 0);
    const shown = clamp?.lines ?? rows.length + blank;
    const item = textElement(
      ctx,
      parts,
      LH,
      { x, y: top(rows[0]!), w: cb.w, h: shown * LH },
      align,
      w,
      shown,
    );
    // the page's own line height when the measured pitch is taller (an icon in a line pushes it apart: laid out
    // again as inline content, the icon does so itself, inlineRun)
    if (item && strut !== null && dom.lineHeight && dom.lineHeight < strut - 0.5)
      (ctx.cssLine ??= new WeakMap()).set(item.el, dom.lineHeight);
    // where its last line ends (an inline box can follow it there: inlineRun)
    if (item) {
      const lr = rows[rows.length - 1]!;
      (ctx.lastLine ??= new WeakMap()).set(item.el, { x1: lr.x1 - x, y: lr.y - top(rows[0]!), h: lr.h });
    }
    // narrowed to its longest line (start-aligned): the width it has in the page, for exports that follow the page to
    // other widths (export/responsive.ts measuredFluid: the narrowed width at the capture width only)
    if (item && w < Math.ceil(cb.w * 100) / 100 - 0.5 && x === cb.x)
      item.el.meta = {
        ...(item.el.meta ?? {}),
        narrowedBy: Math.round((Math.ceil(cb.w * 100) / 100 - w) * 100) / 100,
      };
    if (item && early)
      item.el.style = { ...item.el.style, textWrap: rows.length === 2 ? "balance" : "pretty" };
    // a word the page broke only to fit its box (overflow-wrap / word-break, no hyphen): the export lets it break too
    if (
      item &&
      ctx.flow &&
      dom.hyphens !== "auto" &&
      rows.slice(0, -1).some((rw) => {
        const l = lastLineOf(rw).line;
        return l.brk === "word" && !/\u00ad$/.test(l.text);
      })
    )
      item.el.meta = { ...(item.el.meta ?? {}), breaksWords: true };
    // the capture's hyphenation points are soft hyphens: break there only (WebKit's own hyphenation differs from
    // Chromium's) — unless the page hyphenates itself (`hyphens: auto`): then every browser hyphenates as it does on
    // the page, at every width
    if (item && item.el.text?.includes("\u00ad") && item.el.style?.hyphens !== "auto")
      item.el.style = { ...item.el.style, hyphens: "manual" };
    if (item && clamp) {
      item.el.style = { ...item.el.style, truncate: clamp.lines };
      delete item.el.style.textWrap;
    }
    if (item) out.push(item);
    return out;
  }
  // single line, or lines that do not reflow like the source: one element per line piece
  for (const rw of rows)
    for (const sg of segmentsOf(rw, runs)) {
      const lh = runs[sg.lines[0]!.run]!.t.font.lineHeight ?? (rows.length > 1 ? LH : sg.h);
      const parts = rowParts(sg, runs, collapse);
      // a word broken at a hyphenation point (hyphens: auto / a soft hyphen): the browser draws a hyphen at the line end
      // that is not in the DOM text ("Am Kup-" / "fergraben")
      const end = sg.lines[sg.lines.length - 1]!;
      const hyphen =
        end.line.brk === "word" &&
        (runs[end.run]!.t.font.hyphens === "auto" || /\u00ad$/.test(end.line.text)) &&
        parts.length > 0;
      if (hyphen) {
        const p = parts[parts.length - 1]!;
        p.text = p.text.replace(/\u00ad$/, "") + "-";
      }
      const y0 = sg.y + sg.h / 2 - lh / 2 + shift;
      const item = textElement(
        ctx,
        parts,
        lh,
        { x: sg.x0, y: y0, w: sg.x1 - sg.x0, h: lh },
        align,
        undefined,
        1,
      );
      if (item) (ctx.lastLine ??= new WeakMap()).set(item.el, { x1: sg.x1 - sg.x0, y: sg.y - y0, h: sg.h });
      // the drawn hyphen is no character of the page's text: exports draw it (fromDsl: `meta.softHyphen`)
      if (item) {
        if (rows.length > 1 || pieces)
          item.el.meta = { ...(item.el.meta ?? {}), line: true, ...(hyphen ? { softHyphen: true } : {}) };
        out.push(item);
      }
    }
  return out;
}

/* ------------------------------------------------------------------ boxes */

const nid = (ctx: Ctx) => `${ctx.prefix}${(ctx.next++).toString(36)}`;

/** A background "image" that is the page's own address (an empty `url()` resolved against it) or a directory: no picture. */
export function notAnImage(url: string, page?: string): boolean {
  if (/^data:/i.test(url)) return false;
  try {
    const u = new URL(url);
    if (page) {
      const p = new URL(page);
      if (u.origin === p.origin && u.pathname === p.pathname && u.search === p.search) return true;
    }
    return /^https?:$/.test(u.protocol) && u.pathname.endsWith("/") && !u.search;
  } catch {
    return false;
  }
}
const srcOf = (ctx: Ctx, url: string | null | undefined) =>
  url ? (ctx.snap.assets?.[url] ?? url) : undefined;

function bgImageLayer(ctx: Ctx, l: SnapBgLayer, box: SnapRect): SceneFill | null {
  if (!l.url) {
    const g = parseGradient(l.image, box);
    return g ? { type: "gradient", ...g } : null;
  }
  const src = srcOf(ctx, l.image);
  if (!src) return null;
  const sizeParts = splitTop(l.size, " ");
  const size: Extract<SceneFill, { type: "image" }>["size"] =
    l.size === "cover" || l.size === "contain"
      ? l.size
      : sizeParts.length && sizeParts.every((p) => p === "auto")
        ? "auto"
        : [
            sizeParts[0] === "auto" ? "auto" : lenOf(sizeParts[0] ?? "auto"),
            sizeParts[1] === undefined || sizeParts[1] === "auto" ? "auto" : lenOf(sizeParts[1]),
          ];
  const position = parsePosition(l.position);
  const rep = l.repeat.split(" ");
  const repeat =
    l.repeat === "repeat-x" || (rep[0] === "repeat" && rep[1] === "no-repeat")
      ? "repeat-x"
      : l.repeat === "repeat-y" || (rep[0] === "no-repeat" && rep[1] === "repeat")
        ? "repeat-y"
        : l.repeat === "repeat" || l.repeat === "repeat repeat"
          ? "repeat"
          : "no-repeat";
  return { type: "image", src, size, ...(position ? { position } : {}), repeat };
}

const sameStroke = (a: SceneStroke, b: SceneStroke) =>
  a.width === b.width && a.color === b.color && (a.style ?? "solid") === (b.style ?? "solid");
const strokeStyle = (s: string): SceneStroke["style"] =>
  s === "dashed" ? "dashed" : s === "dotted" ? "dotted" : "solid";

/** Box paint → SceneStyle (+ photo layers that become image children). */
function boxStyle(ctx: Ctx, n: SnapElement): { style: SceneStyle; photos: Item[]; raw: boolean } {
  const s = n.style ?? {};
  const style: SceneStyle = {};
  const photos: Item[] = [];
  let raw = false;
  if (s.bg && !s.bgClipText) style.background = s.bg;
  // (an empty `url()` the browser resolved to the page itself — `url("https://www.nestle.com/")` — is no picture: requested
  // as an image, the export's console fills with blocked loads)
  const layers = s.bgLayers?.filter((l) => !(l.url && notAnImage(l.image, ctx.snap.url)));
  if (layers?.length && !s.bgClipText) {
    const fills: SceneFill[] = [];
    const b = n.layout?.borderWidth ?? [0, 0, 0, 0];
    const inner = {
      x: n.rect.x + b[3]!,
      y: n.rect.y + b[0]!,
      w: n.rect.w - b[1]! - b[3]!,
      h: n.rect.h - b[0]! - b[2]!,
    };
    layers.forEach((l, i) => {
      const f = bgImageLayer(ctx, l, n.rect);
      if (!f) {
        if (!l.url && i === layers.length - 1 && !fills.length) {
          style.background = s.bg ? `${l.image}, ${s.bg}` : l.image;
          raw = true;
        } else ctx.warn.add("background layer not converted");
        return;
      }
      // a single cover / contain photo becomes an editable image layer under the content
      if (
        f.type === "image" &&
        layers.length === 1 &&
        (f.size === "cover" || f.size === "contain") &&
        f.repeat === "no-repeat" &&
        !/\.svg(\?|$)|^data:image\/svg/i.test(l.image) &&
        inner.w * inner.h >= 2500
      ) {
        const el: SceneElement = {
          id: nid(ctx),
          type: "image",
          name: "Background image",
          image: { src: f.src, alt: "" },
          layout: { position: "absolute", width: r2(inner.w), height: r2(inner.h) },
          style: {
            fit: f.size,
            radius: 0,
            ...(f.position && (f.position[0] !== "50%" || f.position[1] !== "50%")
              ? { objectPosition: f.position }
              : {}),
          },
        };
        if (s.radius) el.style!.radius = radiusOf(s.radius.map((r) => Math.max(0, r - Math.max(...b))));
        ctx.stats.images++;
        ctx.sizes.set(el, { w: inner.w, h: inner.h });
        ctx.outOfFlow.add(el);
        photos.push({ el, abs: inner, tier: -10, z: 0, order: ctx.order++ });
        return;
      }
      fills.push(f);
    });
    if (fills.length) style.fills = fills;
  }
  if (s.border) {
    const sides = s.border.map((b): SceneStroke | null =>
      b ? { width: r2(b.w), color: b.color, style: strokeStyle(b.style) } : null,
    );
    const [t, r, bt, l] = sides;
    if (t && r && bt && l && sameStroke(t, r) && sameStroke(t, bt) && sameStroke(t, l))
      style.border = { width: t.width, color: t.color, ...(t.style !== "solid" ? { style: t.style } : {}) };
    else {
      const borders: NonNullable<SceneStyle["borders"]> = {};
      (["top", "right", "bottom", "left"] as const).forEach((k, i) => {
        borders[k] = sides[i] ?? { width: 0, color: "transparent" };
      });
      style.borders = borders;
    }
  }
  if (s.radius) style.radius = radiusOf(s.radius);
  const shadows = parseShadows(s.shadow);
  if (shadows.length) style.shadows = shadows;
  if (s.opacity !== undefined && s.opacity < 1) style.opacity = r2(s.opacity);
  if (s.blend && s.blend !== "normal") style.blend = s.blend as SceneStyle["blend"];
  const filter = parseFilter(s.filter);
  if (filter) style.filter = filter;
  const backdrop = parseFilter(s.backdrop);
  if (backdrop) style.backdrop = backdrop;
  if (s.mask) {
    const m = maskOf(ctx, s.mask, n.rect);
    if (m) style.maskImage = m;
    else ctx.warn.add("mask image not converted");
  }
  if (s.outline && s.outline.w > 0)
    style.outline = {
      width: r2(s.outline.w),
      color: s.outline.color,
      ...(s.outline.style === "dashed" || s.outline.style === "dotted" ? { style: s.outline.style } : {}),
      ...(s.outline.offset ? { offset: r2(s.outline.offset) } : {}),
    };
  if (
    s.clipPath &&
    /^(inset|circle|ellipse|polygon|path)\(/.test(s.clipPath) &&
    !unrevealed(s.clipPath, n.rect)
  )
    style.clipPath = s.clipPath;
  return { style, photos, raw };
}

/**
 * A big box an `inset()` clip hides completely (a hero picture's reveal — `inset(0 100% 100% 0)` wiping it in — caught
 * before it played): the box as the reveal ends, unclipped. Small fully clipped boxes (screen-reader text) stay clipped.
 */
function unrevealed(clip: string, r: SnapRect): boolean {
  const m = /^inset\(([^)]*)\)/.exec(clip.trim());
  if (!m || r.w < 120 || r.h < 120) return false;
  const v = m[1]!
    .split(/\s+round\s+/)[0]!
    .trim()
    .split(/\s+/);
  const [t, rt = t, b = t, l = rt] = v;
  const px = (x: string | undefined, size: number) =>
    !x ? 0 : x.endsWith("%") ? (parseFloat(x) / 100) * size : parseFloat(x) || 0;
  return px(t, r.h) + px(b, r.h) >= r.h - 0.5 || px(l, r.w) + px(rt, r.w) >= r.w - 0.5;
}

function radiusOf(r: number[]): SceneStyle["radius"] {
  const v = r.map(r2) as [number, number, number, number];
  return v.every((x) => x === v[0]) ? v[0] : v;
}

/** CSS mask-image layer → style.maskImage (an SVG / image from the asset map, or a gradient). */
function maskOf(
  ctx: Ctx,
  m: NonNullable<NonNullable<SnapElement["style"]>["mask"]>,
  box: SnapRect,
): SceneStyle["maskImage"] | null {
  const out: NonNullable<SceneStyle["maskImage"]> = {};
  if (m.url) {
    const src = srcOf(ctx, m.image);
    if (!src) return null;
    const svg = /^data:image\/svg\+xml;base64,/.exec(src)
      ? (() => {
          try {
            return atob(src.slice(src.indexOf(",") + 1));
          } catch {
            return null;
          }
        })()
      : null;
    if (svg && /<svg[\s>]/.test(svg)) out.svg = svg;
    else out.src = src;
  } else {
    const g = parseGradient(m.image, box);
    if (!g) return null;
    out.gradient = g;
  }
  const sp = splitTop(m.size || "auto", " ");
  if (m.size === "cover" || m.size === "contain") out.size = m.size;
  else if (sp.length && !sp.every((x) => x === "auto"))
    out.size = [
      sp[0] === "auto" ? "auto" : lenOf(sp[0]!),
      sp[1] === undefined || sp[1] === "auto" ? "auto" : lenOf(sp[1]),
    ];
  else out.size = "auto";
  const pos = parsePosition(m.position);
  if (pos) out.position = pos;
  const r = (m.repeat || "").split(" ");
  out.repeat =
    m.repeat === "repeat-x"
      ? "repeat-x"
      : m.repeat === "repeat-y"
        ? "repeat-y"
        : r[0] === "repeat" || m.repeat === "repeat"
          ? "repeat"
          : "no-repeat";
  if (m.mode === "luminance") out.mode = "luminance";
  return out;
}

const paints = (st: SceneStyle) =>
  !!(st.background && !isTransparent(st.background)) ||
  !!st.fills?.length ||
  !!st.border ||
  !!st.borders ||
  !!st.shadows?.length ||
  st.opacity !== undefined ||
  !!st.blend ||
  !!st.filter ||
  !!st.backdrop ||
  !!st.maskImage ||
  !!st.outline ||
  !!st.clipPath;

function tierOf(n: SnapElement): { tier: number; z: number } {
  const p = n.layout?.position ?? "static";
  if (p === "static") return { tier: 0, z: 0 };
  const z = n.layout?.z ?? 0;
  return z > 0 ? { tier: 2, z } : z < 0 ? { tier: -1, z } : { tier: 1, z: 0 };
}

const isButtonLike = (n: SnapElement, st: SceneStyle) =>
  n.tag === "button" ||
  n.attrs?.role === "button" ||
  (n.tag === "a" && paints(st) && n.rect.h <= 120 && n.rect.w <= 600);

function imageItem(
  ctx: Ctx,
  n: SnapElement,
  src: string | undefined,
  name: string,
  fit: SceneStyle["fit"],
  objectPosition?: [SceneLength, SceneLength],
): Item {
  const tz = tierOf(n);
  const { style } = boxStyle(ctx, n);
  const el: SceneElement = {
    id: nid(ctx),
    type: "image",
    name,
    image: { src, alt: n.alt ?? n.attrs?.alt ?? "" },
    layout: { position: "absolute", width: r2(n.rect.w), height: r2(n.rect.h) },
    style: { ...style, fit, radius: style.radius ?? 0 },
  };
  if (objectPosition && (objectPosition[0] !== "50%" || objectPosition[1] !== "50%"))
    el.style!.objectPosition = objectPosition;
  // a <picture>'s sources: the widths it switches pictures at (exports switch there, not halfway between measurements)
  const switches = pictureSwitches(n.pictureMedia);
  if (switches.length) el.meta = { ...(el.meta ?? {}), pictureSwitches: switches.join(",") };
  delete el.style!.fills;
  ctx.stats.images++;
  ctx.sizes.set(el, { w: n.rect.w, h: n.rect.h });
  return { el, abs: n.rect, ...tz, order: ctx.order++ };
}

/** Widths where `<source media>` conditions start or stop matching: `(min-width: 768px)` → 768, `(max-width: 600px)` → 601. */
export function pictureSwitches(media: string[] | undefined): number[] {
  const out = new Set<number>();
  for (const q of media ?? [])
    for (const m of q.matchAll(/\(\s*(min|max)-width\s*:\s*(\d*\.?\d+)(px|em|rem)\s*\)/gi)) {
      const v = Number(m[2]) * (m[3] === "px" ? 1 : 16);
      out.add(m[1]!.toLowerCase() === "min" ? Math.ceil(v) : Math.floor(v) + 1);
    }
  return [...out].sort((a, b) => a - b);
}

/** Convert one element node into items for its parent (several when it collapses). */
/** Margins of a box and the wrappers collapsed around it: the larger one per side (adjoining margins collapse). */
function addMargin(ctx: Ctx, el: SceneElement, m: number[] | undefined) {
  if (!m?.some((v) => v)) return;
  const cur = ctx.marginOf.get(el);
  ctx.marginOf.set(el, cur ? cur.map((v, i) => Math.max(v, m[i] ?? 0)) : [...m]);
}

/**
 * CSS columns with a width: the computed width holds for this capture only (`33vw` is a length by then), so the frozen
 * value fits more columns further up the range. No more than the page shows at any measured width of this layout.
 */
function withColumnCap(ctx: Ctx, n: SnapElement): SnapElement {
  const cols = n.layout?.columns;
  if (!cols?.width || cols.count || !n.children) return n;
  const columns = (b: SnapElement) =>
    new Set(
      (b.children ?? []).flatMap((c) => (c.kind !== "text" && c.rect.w > 0 ? [Math.round(c.rect.x)] : [])),
    ).size;
  const count = Math.max(columns(n), ...altBoxes(ctx.snap, n.id).map(columns));
  return count > 0 ? { ...n, layout: { ...n.layout!, columns: { ...cols, count } } } : n;
}

function convertElement(ctx: Ctx, element: SnapElement): Item[] {
  const n = withColumnCap(ctx, element);
  const items = convertNode(ctx, n);
  // the box itself (its kind's element, a kept frame) or the one item a collapsed wrapper left: its margins and display
  if (items.length === 1) {
    // a padded link that collapsed into its text: the padding was room around that text, as its margin is
    const pad = ctx.flow && !n.kind && items[0]!.el.type === "text" ? n.layout?.padding : undefined;
    addMargin(
      ctx,
      items[0]!.el,
      pad ? [0, 1, 2, 3].map((i) => (n.layout?.margin?.[i] ?? 0) + (pad[i] ?? 0)) : n.layout?.margin,
    );
    // an icon enlarged by a transform: its measured box starts before the place it holds in its row
    const scale = /^matrix\(([\d.]+), 0, 0, \1,/.exec(n.style?.transform ?? "");
    if (ctx.flow && n.kind === "svg" && scale && Number(scale[1]) > 1) {
      const grown = (n.rect.w * (1 - 1 / Number(scale[1]))) / 2;
      const m = ctx.marginOf.get(items[0]!.el) ?? [0, 0, 0, 0];
      ctx.marginOf.set(items[0]!.el, [m[0]!, m[1]!, m[2]!, m[3]! - grown]);
    }
    // CSS columns of a wrapper that collapsed into its one box: that box's content flows down them (multiColumn)
    if (ctx.flow && n.layout?.columns && items[0]!.el.type === "frame") {
      const c = ctx.css.get(items[0]!.el);
      if (c && !c.columns) ctx.css.set(items[0]!.el, { ...c, columns: n.layout.columns });
    }
    // its place in a CSS grid (`grid-column` / `grid-row`): the outermost box's of those collapsed into it (the one
    // in the grid around it; an inner box's place is in a grid that collapsed away)
    if (n.layout?.gridColumn || n.layout?.gridRow)
      (ctx.gridPlace ??= new WeakMap()).set(items[0]!.el, {
        ...(n.layout.gridColumn ? { column: n.layout.gridColumn } : {}),
        ...(n.layout.gridRow ? { row: n.layout.gridRow } : {}),
      });
    else ctx.gridPlace?.delete(items[0]!.el);
    if (!ctx.displayOf.has(items[0]!.el) && n.layout?.display)
      ctx.displayOf.set(items[0]!.el, n.layout.display);
  }
  // the element of its own kind (img, svg, input…; the frame path records itself)
  if (n.kind && items.length === 1) ctx.idOf.set(n.id, items[0]!.el.id);
  // absolutely positioned in the page (or a marker / overlay inside one): stays absolute inside auto layout
  if (n.layout?.position === "absolute" || n.layout?.position === "fixed" || n.kind === "marker")
    for (const it of items) ctx.outOfFlow.add(it.el);
  // a header / bar pinned to the viewport keeps its place while the prototype scrolls (a collapsed wrapper: its layers)
  if (ctx.pinned.has(n.id))
    for (const it of items) it.el.layout = { ...it.el.layout, scrollBehavior: "fixed" };
  if (n.layout?.position === "sticky") for (const it of items) ctx.sticky.add(it.el);
  return items;
}

/** A closed `<details>`: Chrome still lays out what it hides, just below the box, where nothing paints it. */
function withoutClosedDetails(n: SnapElement): SnapElement {
  if (n.tag !== "details" || !n.children) return n;
  const bottom = n.rect.y + n.rect.h;
  const hidden = (c: SnapNode) => c.kind !== "text" && c.tag !== "summary" && c.rect.y >= bottom - 2;
  return n.children.some(hidden) ? { ...n, children: n.children.filter((c) => !hidden(c)) } : n;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SAFE_HREF = /^(https?:|mailto:|tel:|\/|#)/i;
const SR_ONLY_CSS =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

/** Markup of content the page has but does not draw, built here from text and links only (never the page's own HTML). */
export function hiddenMarkupOf(
  n: Pick<SnapElement, "tag" | "attrs" | "srText" | "hiddenLinks">,
): string | null {
  if (n.hiddenLinks?.length) {
    const links = n.hiddenLinks
      .filter((l) => SAFE_HREF.test(l.href))
      .map((l) => `<a href="${escapeHtml(l.href)}" tabindex="-1">${escapeHtml(l.text)}</a>`)
      .join("");
    return links ? `<nav aria-hidden="true" style="display:none">${links}</nav>` : null;
  }
  if (!n.srText) return null;
  const href = n.tag === "a" && n.attrs?.href && SAFE_HREF.test(n.attrs.href) ? n.attrs.href : undefined;
  const tag = href ? "a" : /^(h[1-6]|p)$/.test(n.tag) ? n.tag : "span";
  return `<${tag}${href ? ` href="${escapeHtml(href)}"` : ""} style="${SR_ONLY_CSS}">${escapeHtml(n.srText)}</${tag}>`;
}

function hiddenItem(ctx: Ctx, n: SnapElement, markup: string): Item {
  const el: SceneElement = {
    id: nid(ctx),
    type: "frame",
    name: n.hiddenLinks ? "Hidden navigation" : `Hidden · ${nameFromText(n.srText ?? "", 24)}`,
    layout: { position: "absolute", width: 1, height: 1 },
    meta: { tag: n.tag, hiddenMarkup: markup },
  };
  ctx.css.set(el, { display: "block", ...n.layout, position: "absolute" });
  ctx.sizes.set(el, { w: 1, h: 1 });
  const abs = { x: Math.max(0, n.rect.x), y: Math.max(0, n.rect.y), w: 1, h: 1 };
  return { el, abs, tier: 1, z: 0, order: ctx.order++ };
}

function convertNode(ctx: Ctx, element: SnapElement): Item[] {
  const n = withoutClosedDetails(element);
  if (n.srText || n.hiddenLinks) {
    const markup = hiddenMarkupOf(n);
    return markup ? [hiddenItem(ctx, n, markup)] : [];
  }
  const page = ctx.snap.page;
  if (
    !n.contents &&
    !ctx.scrolled.has(n.id) &&
    (n.rect.x + n.rect.w <= 0 ||
      n.rect.y + n.rect.h <= 0 ||
      n.rect.x >= page.width ||
      n.rect.y >= page.height + 4)
  ) {
    // off-page box (skip links, closed drawers); its children are usually off-page too
    if (!n.children?.length || n.style?.overflow) return [];
  }
  const tz = tierOf(n);
  switch (n.kind) {
    case "br":
      return [];
    case "img": {
      // (flow first: a picture drawn at its own proportions is "cover" — the same at the captured width, cropped
      // rather than stretched wherever its box takes other proportions)
      const ownRatio =
        !!n.natural?.w &&
        !!n.natural?.h &&
        n.rect.h > 0 &&
        Math.abs(n.natural.w / n.natural.h / (n.rect.w / n.rect.h) - 1) <= 0.02;
      const fit = (
        n.objectFit === "fill"
          ? ctx.flow && ownRatio
            ? "cover"
            : "fill"
          : n.objectFit === "contain"
            ? "contain"
            : n.objectFit === "none"
              ? "none"
              : n.objectFit === "scale-down"
                ? "scale-down"
                : "cover"
      ) as SceneStyle["fit"];
      const isIcon = n.rect.w <= 64 && n.rect.h <= 64;
      return [
        imageItem(
          ctx,
          n,
          srcOf(ctx, n.src),
          nameOf(n, isIcon ? "Icon" : "Image"),
          fit,
          parsePosition(n.objectPosition),
        ),
      ];
    }
    case "raster": {
      ctx.stats.rasters++;
      const what =
        n.tag === "video"
          ? "Video"
          : n.tag === "iframe"
            ? "Embed"
            : n.tag === "canvas"
              ? "Canvas"
              : n.tag === "svg"
                ? "Icon"
                : n.tag;
      // a box whose screenshot had no visible pixel paints nothing at rest: no image (it would sit over its siblings)
      if (n.blank && !n.src && !n.poster) return [];
      if (!n.src && !n.poster) {
        ctx.warn.add(`${what} could not be captured`);
        return [];
      }
      // a video becomes an editable image layer: the frame matched to the reference screenshot, else the poster, else the captured frame
      const poster =
        n.tag === "video" && n.videoTime === undefined && n.poster ? srcOf(ctx, n.poster) : undefined;
      // (a screenshot of the box is its exact frame there: flow first draws it "cover", so another box crops it
      // instead of stretching it)
      const it = imageItem(
        ctx,
        n,
        poster ?? n.src ?? srcOf(ctx, n.poster),
        n.tag === "video" ? `Video · ${nameOf(n, "frame")}` : nameOf(n, what),
        poster || !n.src ? (n.objectFit === "contain" ? "contain" : "cover") : ctx.flow ? "cover" : "fill",
      );
      it.el.meta = {
        ...(it.el.meta ?? {}),
        raster: n.tag,
        ...(n.tag === "video"
          ? { video: true, videoFrame: n.videoTime ?? (poster ? "poster" : "captured") }
          : {}),
      };
      return [it];
    }
    case "svg": {
      ctx.stats.icons++;
      const box = boxStyle(ctx, n).style;
      const pad = n.layout?.padding,
        bw = n.layout?.borderWidth;
      if (paints(box) || pad || bw) {
        // the <svg> box itself paints (badge background, padding): a frame around the icon
        const cb = contentBox(n);
        const icon: SnapElement = {
          ...n,
          rect: cb,
          style: { color: n.style?.color },
          layout: { display: "block", position: "static" },
        };
        const inner = convertElement(ctx, icon);
        ctx.stats.icons--;
        const el: SceneElement = {
          id: nid(ctx),
          type: "frame",
          name: nameOf(n, "Icon"),
          layout: { position: "absolute", width: r2(n.rect.w), height: r2(n.rect.h) },
          style: box,
        };
        // a rotated svg box turns as a whole: the wrapper carries the rotation, the icon sits in its untransformed content box
        const rot = rotationOf(n.style?.transform);
        let abs = n.rect;
        if (rot && n.size) {
          abs = {
            x: n.rect.x + n.rect.w / 2 - n.size.w / 2,
            y: n.rect.y + n.rect.h / 2 - n.size.h / 2,
            w: n.size.w,
            h: n.size.h,
          };
          el.layout = { ...el.layout, width: r2(abs.w), height: r2(abs.h), rotation: rot };
          const p = pad ?? [0, 0, 0, 0],
            b = bw ?? [0, 0, 0, 0];
          for (const it of inner)
            it.abs = {
              x: abs.x + p[3]! + b[3]!,
              y: abs.y + p[0]! + b[0]!,
              w: abs.w - p[1]! - p[3]! - b[1]! - b[3]!,
              h: abs.h - p[0]! - p[2]! - b[0]! - b[2]!,
            };
        }
        place(el, abs, borderOf(el), inner);
        ctx.sizes.set(el, { w: abs.w, h: abs.h });
        return [{ el, abs, ...tz, order: ctx.order++ }];
      }
      const el: SceneElement = {
        id: nid(ctx),
        type: "icon",
        name: nameOf(n, "Icon"),
        svg: n.svg ?? "",
        layout: { position: "absolute", width: r2(n.rect.w), height: r2(n.rect.h) },
        style: { color: n.color ?? n.style?.color },
      };
      const rot = rotationOf(n.style?.transform);
      let abs = n.rect;
      if (rot && n.size) {
        abs = {
          x: n.rect.x + n.rect.w / 2 - n.size.w / 2,
          y: n.rect.y + n.rect.h / 2 - n.size.h / 2,
          w: n.size.w,
          h: n.size.h,
        };
        el.layout = { ...el.layout, width: r2(n.size.w), height: r2(n.size.h), rotation: rot };
      }
      ctx.sizes.set(el, { w: abs.w, h: abs.h });
      return [{ el, abs, ...tz, order: ctx.order++ }];
    }
    case "input":
      return inputItems(ctx, n);
    case "marker": {
      const st: SceneStyle =
        n.shape === "circle"
          ? { border: { width: 1, color: n.color ?? "#000" }, radius: n.rect.w / 2 }
          : { background: n.color ?? "#000", radius: n.shape === "square" ? 0 : n.rect.w / 2 };
      const el: SceneElement = {
        id: nid(ctx),
        type: "frame",
        name: "Bullet",
        layout: { position: "absolute", width: n.rect.w, height: n.rect.h },
        style: st,
      };
      ctx.sizes.set(el, { w: n.rect.w, h: n.rect.h });
      return [{ el, abs: n.rect, tier: 0.5, z: 0, order: ctx.order++ }];
    }
    default:
      break;
  }

  const { style, photos } = boxStyle(ctx, n);
  const myOrder = ctx.order++;
  // laid out by a flex / grid parent: a wrapper holding several layers stays (its parent's flow needs it as one item)
  const flexItem = ctx.inFlex === true;
  const flexParent = /^(inline-)?(flex|grid)$/.test(n.layout?.display ?? "");
  // children: block-level elements converted recursively, inline content gathered into paragraphs
  const kids: Item[] = [...photos];
  const inline: InlineItem[] = [];
  const visit = (children: SnapNode[] | undefined, href: string | undefined, direct: boolean) => {
    for (const c of children ?? []) {
      if (c.kind === "text") {
        inline.push({ t: c, href });
        continue;
      }
      if (c.kind === "br") {
        inline.push({ br: true });
        continue;
      }
      const d = c.layout?.display ?? "block";
      const inlineWrapper =
        !c.kind &&
        (d === "inline" || c.contents) &&
        !(c.style && paints(boxStyle(ctx, c).style)) &&
        ((c.layout?.position ?? "static") === "static" ||
          // flow first: a relative inline box without a z-index (a footnote's <sup>) stays in its line, a run of it
          (ctx.flow && c.layout?.position === "relative" && !c.layout.z && d === "inline"));
      if (inlineWrapper) {
        visit(c.children, c.tag === "a" ? (c.attrs?.href ?? href) : href, direct && !!c.contents);
        continue;
      }
      const prev = ctx.inFlex;
      ctx.inFlex =
        direct &&
        flexParent &&
        (c.layout?.position ?? "static") !== "absolute" &&
        c.layout?.position !== "fixed";
      kids.push(...convertElement(ctx, c));
      ctx.inFlex = prev;
    }
  };
  const outerLines = ctx.lineBox;
  if (n.layout?.display !== "inline" || paints(style)) ctx.lineBox = contentBox(n);
  visit(n.children, n.tag === "a" ? n.attrs?.href : undefined, true);
  // the block's own text: laid out by the block (its display), placed by the block's margins once it is collapsed
  for (const it of paragraphItems(ctx, inline, n)) {
    if (n.layout?.display) ctx.displayOf.set(it.el, n.layout.display);
    kids.push(it);
  }
  ctx.lineBox = outerLines;
  resolveLayers(ctx, kids);

  const rot = rotationOf(n.style?.transform);
  const overflow = n.style?.overflow;
  // overflow clips to the rounded padding box: children reaching past the box or into a rounded corner need the clip
  // (flow first: a picture as wide as the box keeps its proportions as the width changes and can outgrow a box whose
  // height does not follow it — a viewport-tall stage around a video — so the clip stays wherever one fills the box)
  const clipNeeded =
    !!overflow &&
    kids.some(
      (k) =>
        k.abs.x < n.rect.x - 0.5 ||
        k.abs.y < n.rect.y - 0.5 ||
        k.abs.x + k.abs.w > n.rect.x + n.rect.w + 0.5 ||
        k.abs.y + k.abs.h > n.rect.y + n.rect.h + 0.5 ||
        cutByCorner(k.abs, n) ||
        (ctx.flow && k.abs.w >= n.rect.w - 1 && n.rect.w > 0 && holdsPicture(k.el)),
    );
  const button = !n.hidden && isButtonLike(n, style) && n.rect.w > 0 && n.rect.h > 0;
  // z-indexed layers (z ≠ 0) of a box that is no stacking context are painted in the nearest one. A negative one under
  // this box's own background leaves it right away; the others stay (editable with their box) until a sibling further
  // up would be painted on the wrong side of them (resolveLayers). A clipping box keeps them all: its clip still applies.
  const scope = n.tag !== "body" && !overflow && !n.style?.clipPath && !stackingContext(n);
  const lift = scope && paints(style) ? kids.filter((k) => k.tier === -1 && overlaps(k.abs, n.rect)) : [];
  // big wrappers holding several layers stay as groups (sections, cards, columns) so the result is editable by block
  const group =
    n.rect.w * n.rect.h >= 20000 &&
    n.rect.w >= 120 &&
    kids.length - lift.length >= 2 &&
    n.rect.y < page.height;
  // (a stacking context holding z-indexed layers stays a box: collapsed, its layers would climb over what it is under)
  // (not around a pinned layer: a fixed / sticky header is placed against the viewport by the export, not inside a box)
  const bounds =
    n.tag !== "body" &&
    stackingContext(n) &&
    kids.some((k) => k.z !== 0 || (k.el.layout?.z ?? 0) !== 0) &&
    !kids.some((k) => k.el.layout?.scrollBehavior !== undefined);
  // an out-of-flow landmark that draws nothing and holds nothing (an idle modal host: vw.com's viewport-sized fixed
  // <section>s) is no block of the page; kept, the export stacks it over the header and it eats the Menu tap
  const idleLayer =
    (n.layout?.position === "fixed" || n.layout?.position === "absolute") && !kids.length && !paints(style);
  // flow first: a box as tall as the viewport (or a share of it) stays a box: the export sizes it by the viewport
  const vh = ctx.flow ? viewportSized(ctx.snap, n) : null;
  const keep =
    !n.contents &&
    n.rect.w > 0 &&
    n.rect.h > 0 &&
    (paints(style) ||
      clipNeeded ||
      !!vh ||
      bounds ||
      !!rot ||
      (KEEP_TAGS.has(n.tag) && !idleLayer) ||
      button ||
      group ||
      n.tag === "body" ||
      ctx.keep.has(n.id) ||
      // flow first: a flex / grid box holding several layers is the layout they are in (a short list row too)
      (ctx.flow && flexParent && kids.length - lift.length >= 2) ||
      // flow first: so is a block holding several (a row of tags under a title): dissolved, its items would mix with
      // its siblings' in its parent, where no line or column holds them all
      (ctx.flow &&
        /^(block|flow-root|list-item)$/.test(n.layout?.display ?? "") &&
        (n.layout?.position ?? "static") === "static" &&
        kids.length - lift.length >= 2) ||
      !!n.scroller ||
      !!n.carousel ||
      (flexItem && kids.length - lift.length >= 2));

  if (!keep) {
    ctx.stats.collapsed++;
    // a collapsed positioned wrapper still lifts its content into its paint layer
    // (positioned z:auto: its static / inline content joins the positioned layer; a z-index wrapper is one stacking context)
    // (a raised wrapper's z-index goes onto its layers: a lower layer beside it, e.g. a hero's gradient scrim, must not
    // end up painted over them once the renderer stacks by z-index)
    if (tz.tier !== 0)
      for (const k of kids) {
        if (tz.z !== 0) {
          k.sub = k.tier + (k.sub ?? 0) / 100;
          k.tier = tz.tier;
          k.z = tz.z;
          if (tz.z > 0) k.el.layout = { ...k.el.layout, z: tz.z };
        } else if (k.tier >= 0 && k.tier <= 1) {
          k.sub = k.tier + (k.sub ?? 0) / 100;
          k.tier = tz.tier;
        }
      }
    // a collapsed stacking context still bounds the layers inside it
    if (!scope) for (const k of kids) delete k.zl;
    return kids;
  }
  for (const k of lift) {
    kids.splice(kids.indexOf(k), 1);
    ctx.outOfFlow.add(k.el);
  }

  const el: SceneElement = {
    id: nid(ctx),
    type: button ? "button" : "frame",
    name: button ? `Button · ${buttonLabel(n)}` : nameOf(n),
    layout: { position: "absolute", width: r2(n.rect.w), height: r2(n.rect.h) },
    style,
  };
  ctx.idOf.set(n.id, el.id);
  if (n.layout) ctx.css.set(el, n.layout);
  if (button) {
    el.variant = "ghost";
    el.style = { background: "transparent", radius: 0, ...style, shadows: style.shadows ?? [] };
    if (n.attrs?.href && /^(https?:|mailto:|tel:)/.test(n.attrs.href))
      el.interaction = { onTap: "open-url", url: n.attrs.href };
    if (style.background && !isTransparent(style.background)) bump(ctx.buttonBg, style.background);
  }
  if (clipNeeded) el.layout!.clip = true;
  // a raised layer stays raised when auto layout later orders its siblings by position (flex items honour z-index):
  // a menu's next level above the first level's rows that follow it in the page
  if (tz.z > 0) el.layout!.z = tz.z;
  // an opaque panel positioned out of the flow (drawer, dropdown, a menu level) paints over the static rows after it
  // in the page; exported, those rows are positioned boxes too (their own absolute layers), so it keeps that by z-index
  else if (
    tz.tier === 1 &&
    (n.layout?.position === "absolute" || n.layout?.position === "fixed") &&
    n.rect.w >= 40 &&
    n.rect.h >= 40 &&
    n.rect.w * n.rect.h >= 20000 &&
    !!style.background &&
    !isTransparent(style.background) &&
    alphaOf(style.background) >= 0.95
  )
    el.layout!.z = 1;
  // a stacking context of the page (a slider track moved by transform, isolation…) keeps the z-indexed layers inside it
  // (z-index 0 makes the exported box one too): else the slide raised to z 4 covers the slider's arrows outside the track
  if (el.layout!.z === undefined && bounds) el.layout!.z = 0;
  if (n.carousel) ctx.controls.push(n);
  let abs = n.rect;
  if (rot && n.size) {
    abs = {
      x: n.rect.x + n.rect.w / 2 - n.size.w / 2,
      y: n.rect.y + n.rect.h / 2 - n.size.h / 2,
      w: n.size.w,
      h: n.size.h,
    };
    el.layout = { ...el.layout, width: r2(n.size.w), height: r2(n.size.h), rotation: rot };
  }
  if (n.tag === "body") abs = { x: 0, y: 0, w: page.width, h: page.height };
  const meta: Record<string, string | number | boolean> = { tag: n.tag };
  if (n.layout?.display && n.layout.display !== "block") meta.display = n.layout.display;
  // its height is `share` × the viewport's + `px` (the export writes it in vh: as the page, it follows the viewport)
  if (vh) {
    meta.vhShare = vh.share;
    meta.vhPx = vh.px;
    if (vh.fixed) meta.vhFixed = true;
  }
  // a pinned box the page moves once it scrolls (domCapture scrollShifts): exports move it the same way
  if (n.scrollShift && Number.isFinite(n.scrollShift.dy)) {
    meta.scrollShift = n.scrollShift.dy;
    meta.scrollShiftMode = n.scrollShift.mode;
    if (n.scrollShift.after) meta.scrollShiftAfter = n.scrollShift.after;
  }
  el.meta = meta;
  // pending layers travel up with the frame: its own z-indexed children and what its children could not settle
  const zl = scope
    ? [
        ...kids.filter((k) => k.tier === -1 || k.tier === 2).map((it) => ({ it, owner: el })),
        ...kids.flatMap((k) => k.zl ?? []),
      ]
    : [];
  for (const k of kids) delete k.zl;
  // children sit in the padding box of the border the frame draws (a border the capture dropped — same colour as the
  // fill — takes no room in the design)
  place(el, abs, borderOf(el), kids);
  // CSS columns around one wrapper (a list's single item holding its groups): what flows down the columns is the
  // wrapper's content, so the wrapper lays it out in the columns (multiColumn)
  if (ctx.flow && n.layout?.columns) {
    const only = (el.children ?? []).filter((c) => !ctx.outOfFlow.has(c));
    const inner = only.length === 1 && only[0]!.type === "frame" ? only[0]! : null;
    const innerCss = inner ? ctx.css.get(inner) : undefined;
    if (inner && innerCss && !innerCss.columns)
      ctx.css.set(inner, { ...innerCss, columns: n.layout.columns });
  }
  // a captured button keeps its own (zero) padding: the renderer's ghost-button default (0 8px) would widen an 8 px
  // carousel dot to 16 px (border-box: padding wins over a smaller width)
  if (button && el.layout && el.layout.padding === undefined) el.layout.padding = 0;
  if (n.scroller) scrollingFrame(el, n.scroller);
  ctx.sizes.set(el, { w: abs.w, h: abs.h });
  return [...lift, { el, abs, ...tz, order: myOrder, ...(zl.length ? { zl } : {}) }];
}

/**
 * A carousel / scrolling pane: the frame scrolls along the captured axis (exports and the prototype; static renders
 * clip like the page did), without a scrollbar. Slide tracks and scroll-snapping scrollers rest on their slides: the
 * children of the first row of two or more items (the frame's own, or of the list inside it).
 */
function scrollingFrame(el: SceneElement, sc: NonNullable<SnapElement["scroller"]>) {
  el.layout = {
    ...el.layout,
    scroll: sc.axis === "x" ? "horizontal" : "vertical",
    scrollbar: "hidden",
    clip: true,
  };
  if (sc.kind !== "track" && !(sc.snap && /mandatory|proximity/.test(sc.snap))) return;
  let row: SceneElement | undefined = el;
  // the row's offset in the frame: slides rest where the first one starts (scroll-padding)
  let inset = 0;
  for (let d = 0; row && d < 3 && (row.children?.length ?? 0) < 2; d++) {
    row = row.children?.find((c) => c.type !== "text");
    inset += (sc.axis === "x" ? row?.layout?.x : row?.layout?.y) ?? 0;
  }
  if (!row || (row.children?.length ?? 0) < 2) return;
  const starts = row
    .children!.map((c) => (sc.axis === "x" ? c.layout?.x : c.layout?.y))
    .filter((v): v is number => typeof v === "number");
  if (starts.length) inset += Math.min(...starts);
  el.layout.snap = true;
  if (inset > 0.5) el.layout.snapPadding = r2(inset);
  for (const c of row.children!) c.layout = { ...c.layout, snapAlign: "start" };
}

/** ids of every box inside a scrolling frame */
function scrolledBoxes(snap: Snapshot): Set<number> {
  const out = new Set<number>();
  const visit = (n: SnapNode, inside: boolean) => {
    if (inside) out.add(n.id);
    if (n.kind !== "text") for (const c of n.children ?? []) visit(c, inside || !!n.scroller);
  };
  if (snap.root) visit(snap.root, false);
  return out;
}

/** Slider arrows (prev / next) scroll their carousel's frame by one slide. */
function linkControls(ctx: Ctx, root: SceneElement) {
  if (!ctx.controls.length) return;
  const byId = new Map<string, SceneElement>();
  const visit = (e: SceneElement) => {
    byId.set(e.id, e);
    e.children?.forEach(visit);
  };
  visit(root);
  for (const n of ctx.controls) {
    const el = byId.get(ctx.idOf.get(n.id) ?? "");
    const target = byId.get(ctx.idOf.get(n.carousel!.scroller) ?? "");
    if (!el || !target?.layout?.scroll) continue;
    // snapping sliders move one slide per click (Splide, Swiper…), free scrollers a page
    el.interaction = {
      onTap: "scroll-by",
      target: target.id,
      direction: n.carousel!.dir > 0 ? "next" : "prev",
      by: target.layout.snap ? "slide" : "page",
    };
    if (n.carousel!.disabled) el.meta = { ...el.meta, carouselDisabled: true };
  }
}

const overlaps = (a: SnapRect, b: SnapRect) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 &&
  Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
/** paint order of two items of one parent (the order place() sorts in) */
const paintCmp = (a: Item, b: Item) =>
  a.tier - b.tier || a.z - b.z || (a.sub ?? 0) - (b.sub ?? 0) || a.order - b.order;

/**
 * Lift pending z-indexed layers out of their frames where it matters: when a sibling `s` of the frame item `k` that
 * overlaps the layer is painted before `k` but belongs after the layer (or the other way round). The layer joins `kids`
 * with its own tier / z (page coordinates unchanged, out of flow); undecided layers stay pending on `k`.
 */
function resolveLayers(ctx: Ctx, kids: Item[]) {
  for (const k of [...kids]) {
    if (!k.zl?.length) continue;
    k.zl = k.zl.filter(({ it, owner }) => {
      const wrong = kids.some(
        (s) =>
          s !== k &&
          s !== it &&
          overlaps(s.abs, it.abs) &&
          Math.sign(paintCmp(s, k)) !== Math.sign(paintCmp(s, it)),
      );
      if (!wrong) return true;
      owner.children = owner.children?.filter((c) => c !== it.el);
      if (!owner.children?.length) delete owner.children;
      ctx.outOfFlow.add(it.el);
      kids.push(it);
      return false;
    });
    if (!k.zl.length) delete k.zl;
  }
}

/** Does the box start a stacking context (z-indexed descendants are painted inside it)? */
function stackingContext(n: SnapElement): boolean {
  const p = n.layout?.position ?? "static",
    s = n.style ?? {};
  // `stack` comes from the capture (computed style knows isolation, will-change, contain…); older snapshots: the basics
  return (
    !!n.layout?.stack ||
    p === "fixed" ||
    p === "sticky" ||
    (p !== "static" && n.layout?.z !== undefined) ||
    (s.opacity !== undefined && s.opacity < 1) ||
    (!!s.transform && s.transform !== "none") ||
    (!!s.filter && s.filter !== "none") ||
    (!!s.backdrop && s.backdrop !== "none") ||
    (!!s.blend && s.blend !== "normal") ||
    (!!s.clipPath && s.clipPath !== "none") ||
    !!s.mask
  );
}

/**
 * The share of the viewport's height a box's own height follows (`SnapElement.vh`: it grew with a taller viewport, and
 * no box in its flow grew as much — then it only holds one that does), with the px it adds: height = share × 100vh +
 * px. Null for boxes of a fixed or content height.
 */
export function viewportSized(
  snap: Snapshot,
  n: SnapElement,
): { share: number; px: number; fixed?: boolean } | null {
  const probe = snap.viewportProbe;
  if (!probe || n.vh === undefined || !n.rect || n.tag === "body" || n.tag === "html") return null;
  const share = n.vh / probe;
  if (share < 0.1 || share > 1.02) return null;
  const inFlow = (c: SnapNode): c is SnapElement =>
    c.kind !== "text" && !c.hidden && c.layout?.position !== "absolute" && c.layout?.position !== "fixed";
  const held = (c: SnapElement, depth: number): boolean =>
    (c.vh !== undefined && Math.abs(c.vh - n.vh!) <= 1) ||
    (!!c.contents && depth < 3 && (c.children ?? []).some((g) => inFlow(g) && held(g, depth + 1)));
  if ((n.children ?? []).some((c) => inFlow(c) && held(c, 0))) return null;
  const s = Math.abs(share - 1) <= 0.01 ? 1 : Math.round(share * 1000) / 1000;
  const px = n.rect.h - s * (snap.viewport?.height ?? 0);
  // content in its flow reaching past its bottom, here or at another width of the range: its height is set (it clips
  // or overflows there), no mere minimum
  const over = (box: SnapElement) =>
    !!box.rect &&
    (box.children ?? []).some(
      (c) => inFlow(c) && !!c.rect && c.rect.h > 0 && c.rect.y + c.rect.h > box.rect.y + box.rect.h + 1,
    );
  const fixed = over(n) || altBoxes(snap, n.id).some(over);
  return { share: s, px: Math.abs(px) < 1 ? 0 : Math.round(px * 100) / 100, ...(fixed ? { fixed } : {}) };
}

/** The boxes the alt walks (`Snapshot.alt`) name as the main walk's box `id`, one per walk that has it. */
function altBoxes(snap: Snapshot, id: number): SnapElement[] {
  const walks = (snap as { alt?: { root?: SnapElement }[] }).alt ?? [];
  let index = ALT_INDEX.get(snap);
  if (!index) {
    index = walks.map((w) => {
      const m = new Map<number, SnapElement>();
      const visit = (e: SnapElement) => {
        if (typeof e.base === "number") m.set(e.base, e);
        for (const c of e.children ?? []) if (c.kind !== "text") visit(c);
      };
      if (w.root) visit(w.root);
      return m;
    });
    ALT_INDEX.set(snap, index);
  }
  return index.flatMap((m) => {
    const e = m.get(id);
    return e ? [e] : [];
  });
}
const ALT_INDEX = new WeakMap<Snapshot, Map<number, SnapElement>[]>();

/** A picture or video, or a box holding one (a few levels down: a player's wrappers). */
function holdsPicture(el: SceneElement, depth = 0): boolean {
  if (el.type === "image" || el.type === "video") return true;
  return depth < 4 && (el.children ?? []).some((c) => holdsPicture(c, depth + 1));
}

/** Does `r` reach outside a rounded corner of `n`'s padding box (where overflow clipping cuts it)? */
function cutByCorner(r: SnapRect, n: SnapElement): boolean {
  const rad = n.style?.radius;
  if (!rad?.some((x) => x > 0.5)) return false;
  const [bt = 0, br = 0, bb = 0, bl = 0] = n.layout?.borderWidth ?? [];
  const x0 = n.rect.x + bl,
    y0 = n.rect.y + bt,
    x1 = n.rect.x + n.rect.w - br,
    y1 = n.rect.y + n.rect.h - bb;
  // top-left, top-right, bottom-right, bottom-left: inner radius, corner circle centre and the child's nearest point
  const corners: [number, number, number, number, number][] = [
    [rad[0]! - Math.max(bt, bl), 1, 1, x0, y0],
    [rad[1]! - Math.max(bt, br), -1, 1, x1, y0],
    [rad[2]! - Math.max(bb, br), -1, -1, x1, y1],
    [rad[3]! - Math.max(bb, bl), 1, -1, x0, y1],
  ];
  return corners.some(([ri, sx, sy, cx0, cy0]) => {
    if (ri <= 0.5) return false;
    const cx = cx0 + sx * ri,
      cy = cy0 + sy * ri;
    const px = sx > 0 ? Math.max(r.x, cx0) : Math.min(r.x + r.w, cx0),
      py = sy > 0 ? Math.max(r.y, cy0) : Math.min(r.y + r.h, cy0);
    // the child's extreme point towards the corner must lie in the corner square and beyond the arc
    return (px - cx) * sx < 0 && (py - cy) * sy < 0 && Math.hypot(px - cx, py - cy) > ri + 0.5;
  });
}

function buttonLabel(n: SnapElement): string {
  const texts: string[] = [];
  const walk = (c: SnapNode) => {
    if (c.kind === "text") {
      if (!ICON_FONT.test(c.font.family)) texts.push(c.text);
    } else for (const k of c.children ?? []) walk(k);
  };
  walk(n);
  const t = texts.join(" ").replace(/\s+/g, " ").trim();
  return nameFromText(t || n.attrs?.["aria-label"] || n.attrs?.title || "Button", 28);
}

function inputItems(ctx: Ctx, n: SnapElement): Item[] {
  const inp = n.input!;
  const { style } = boxStyle(ctx, n);
  const tz = tierOf(n);
  const label = inp.value || inp.placeholder;
  const el: SceneElement = {
    id: nid(ctx),
    type: inp.type === "button" ? "button" : "frame",
    name: `Input · ${nameFromText(label || inp.type, 24)}`,
    layout: { position: "absolute", width: r2(n.rect.w), height: r2(n.rect.h) },
    style,
    meta: { tag: n.tag, role: "input", inputType: inp.type },
  };
  if (inp.type === "button") {
    el.variant = "ghost";
    el.style = { background: "transparent", radius: 0, ...style, shadows: style.shadows ?? [] };
    el.name = `Button · ${nameFromText(label, 24)}`;
  }
  if (inp.placeholder) el.placeholder = inp.placeholder;
  const kids: Item[] = [];
  if (label) {
    const cb = contentBox(n);
    const f = { ...inp.font, color: inp.value ? inp.font.color : inp.placeholderColor };
    const LH = f.lineHeight ?? Math.round(f.size * 1.2);
    // (centred in the content box: a floating label's control keeps its value below the label with a top padding)
    const y = inp.multiline ? cb.y : cb.y + cb.h / 2 - LH / 2;
    const centered = inp.type === "button" || f.align === "center";
    const t = textElement(
      ctx,
      [{ text: label, font: f }],
      LH,
      { x: cb.x, y, w: cb.w, h: LH },
      centered ? "center" : f.align,
      inp.multiline || centered ? cb.w : undefined,
      1,
    );
    if (t) {
      t.el.name = inp.value ? "Value" : "Placeholder";
      if (!inp.multiline && !centered) {
        t.el.style!.whiteSpace = "pre";
        t.el.layout!.width = r2(cb.w);
        t.el.style!.truncate = true;
      }
      kids.push(t);
    }
  }
  place(el, n.rect, borderOf(el), kids);
  ctx.sizes.set(el, { w: n.rect.w, h: n.rect.h });
  return [{ el, abs: n.rect, ...tz, order: ctx.order++ }];
}

/** Sort children into paint order and position them relative to the parent's padding box. */
function place(parent: SceneElement, abs: SnapRect, border: number[] | undefined, kids: Item[]) {
  const bl = border?.[3] ?? 0,
    bt = border?.[0] ?? 0;
  kids.sort((a, b) => a.tier - b.tier || a.z - b.z || (a.sub ?? 0) - (b.sub ?? 0) || a.order - b.order);
  // a raised layer (layout z) must not cover what the page paints after it: later overlapping siblings get at least
  // its z, equal z keeps the child order (a card's opaque ::before backdrop raised as a panel, the form on it)
  kids.forEach((k, i) => {
    const under = Math.max(
      0,
      ...kids
        .slice(0, i)
        .filter((p) => overlaps(p.abs, k.abs))
        .map((p) => p.el.layout?.z ?? 0),
    );
    if (under > (k.el.layout?.z ?? 0)) k.el.layout = { ...k.el.layout, z: under };
  });
  parent.children = kids.map((k) => {
    k.el.layout = {
      ...k.el.layout,
      position: "absolute",
      x: r2(k.abs.x - abs.x - bl),
      y: r2(k.abs.y - abs.y - bt),
    };
    return k.el;
  });
  if (!parent.children.length) delete parent.children;
}

/* ------------------------------------------------------------------ auto layout */

type Box = { el: SceneElement; x: number; y: number; w: number; h: number; rows: number };
type Align = "start" | "center" | "end";
const TOL = 1;
/** px a flow may drift from the captured positions before a margin corrects it */
const DRIFT = 0.3;

/** Border widths [top, right, bottom, left] of a frame (auto-layout padding is measured inside them). */
function borderOf(el: SceneElement): [number, number, number, number] {
  const st = el.style;
  const w = st?.border?.width ?? 0;
  const sides = st?.border?.sides;
  const b: [number, number, number, number] = sides
    ? [
        sides.includes("top") ? w : 0,
        sides.includes("right") ? w : 0,
        sides.includes("bottom") ? w : 0,
        sides.includes("left") ? w : 0,
      ]
    : [w, w, w, w];
  if (st?.borders)
    (["top", "right", "bottom", "left"] as const).forEach((k, i) => {
      const s = st.borders![k];
      if (s) b[i] = s.width;
    });
  return b;
}

/**
 * Whether a negative margin `m` on `side` of `el` or of the first box down its first children (a list's -10px that
 * collapsed up through its wrappers) accounts for `el` starting that far before its parent (`marginOf`: the page's).
 */
function collapsedMargin(
  marginOf: ((e: SceneElement) => number[] | undefined) | undefined,
  el: SceneElement,
  side: 0 | 3,
  m: number,
): boolean {
  if (!marginOf) return false;
  for (let e: SceneElement | undefined = el, d = 0; e && d < 4; e = e.children?.[0], d++)
    if (Math.abs((marginOf(e)?.[side] ?? 0) - m) <= 1) return true;
  return false;
}

/**
 * One flex line along `dir`: the smallest gap between neighbours becomes the frame gap and larger ones per-child
 * margins; the cross-axis alignment shared by most children becomes `align`, the others get `alignSelf`.
 * Null when children overlap along the axis or a child matches none of start / centre / end.
 */
function flexLine(
  boxes: Box[],
  dir: "row" | "column",
  inner: { w: number; h: number },
  /** flow first: a child off the shared line keeps its offset from the start line as a margin (block children inset) */
  crossFree = false,
  /** a scrolling frame's row: its items run past its end (they scroll into view) */
  overflowMain = false,
  /**
   * flow first: the negative leading margin (≤ 0) the page's CSS gives a child along `dir` — a panel pulled up over the
   * picture before it overlaps it by exactly that, and keeps it as its margin
   */
  pull?: (b: Box) => number,
  /** flow first: the page's margins of an element (a collapsed negative margin explains a child starting early) */
  marginOf?: (e: SceneElement) => number[] | undefined,
) {
  const main = dir === "row" ? "x" : "y",
    cross = dir === "row" ? "y" : "x";
  const mlen = dir === "row" ? "w" : "h",
    clen = dir === "row" ? "h" : "w";
  const sorted = [...boxes].sort((a, b) => a[main] - b[main]);
  // where each child would start without its negative margin (only for an overlap the margin accounts for)
  const pulled = sorted.map((b, i) => {
    const m = i > 0 && pull ? Math.min(0, pull(b)) : 0;
    if (!m) return 0;
    const prev = sorted[i - 1]!;
    const overlap = prev[main] + prev[mlen] - b[main];
    return overlap > 0.75 && Math.abs(overlap + m) <= 1.5 ? m : 0;
  });
  const start = (i: number) => sorted[i]![main] - pulled[i]!;
  for (let i = 0; i + 1 < sorted.length; i++)
    if (sorted[i]![main] + sorted[i]![mlen] > start(i + 1) + 0.75) return null;
  const gaps = sorted.slice(1).map((_, i) => start(i + 1) - (sorted[i]![main] + sorted[i]![mlen]));
  const gap = gaps.length ? Math.max(0, Math.min(...gaps)) : 0;
  // extra space before a child becomes its margin once the flow would be off by more than DRIFT there (small surpluses
  // are not dropped one by one: they would add up along the line)
  let at = sorted[0]![main] + sorted[0]![mlen];
  const margins = gaps.map((_, i) => {
    const b = sorted[i + 1]!,
      extra = start(i + 1) - (at + gap);
    const m = extra > DRIFT ? snap(extra) : 0;
    at += gap + m + pulled[i + 1]! + b[mlen];
    return m + pulled[i + 1]!;
  });
  // (flow first: a text's glyph box can start a pixel or two above its line box: no overflow, no padding; a first
  // child a little above the box (a negative margin collapsed up through its wrappers: a list's -10px) keeps that
  // as its own negative margin)
  const first = sorted[0]![main];
  const glyph = crossFree && first < 0 && first >= -2 && sorted[0]!.el.type === "text";
  const lead =
    crossFree &&
    !glyph &&
    first < -0.5 &&
    -first <= 0.25 * sorted[0]![mlen] &&
    collapsedMargin(marginOf, sorted[0]!.el, dir === "row" ? 3 : 0, first)
      ? r2(first)
      : 0;
  const padStart = glyph || lead ? 0 : first;
  const mainTotal = dir === "row" ? inner.w : inner.h,
    crossTotal = dir === "row" ? inner.h : inner.w;
  const last = sorted[sorted.length - 1]!;
  const endSpace = mainTotal - (last[main] + last[mlen]);
  if (padStart < -0.5 || (endSpace < -0.5 && !overflowMain)) return null;
  // cross axis: the alignment most children share decides the paddings
  const near = (a: number, b: number) => Math.abs(a - b) <= TOL;
  const votes = (k: Align) =>
    sorted.filter((b, _, all) => {
      const v = k === "start" ? b[cross] : k === "end" ? b[cross] + b[clen] : b[cross] + b[clen] / 2;
      const ref =
        k === "start"
          ? all[0]![cross]
          : k === "end"
            ? all[0]![cross] + all[0]![clen]
            : all[0]![cross] + all[0]![clen] / 2;
      return near(v, ref);
    }).length;
  const mid0 = sorted[0]![cross] + sorted[0]![clen] / 2;
  // (children spanning the whole cross axis fit every alignment: start, which stays put if one of them later ends
  // up a little shorter — centred, everything would move by half of that)
  const span = sorted.every((b) => b[clen] >= crossTotal - 1.5);
  const order: Align[] =
    near(mid0, crossTotal / 2) && !span ? ["center", "start", "end"] : ["start", "center", "end"];
  let best: Align | null = null,
    n = 0;
  for (const k of order) {
    const v = votes(k);
    if (v > n) {
      best = k;
      n = v;
    }
  }
  if (!best) return null;
  const val = (b: Box, k: Align) =>
    k === "start" ? b[cross] : k === "end" ? b[cross] + b[clen] : b[cross] + b[clen] / 2;
  // the shared line sits midway between the children that share it (their offsets split, not one child's taken)
  const p0 = val(
    sorted.find((b) => near(val(b, best!), best === "center" ? mid0 : val(sorted[0]!, best!)))!,
    best,
  );
  const shared = sorted.map((b) => val(b, best!)).filter((v) => near(v, p0));
  const ref = (Math.min(...shared) + Math.max(...shared)) / 2;
  const cpad: [number, number] =
    best === "start"
      ? [ref, 0]
      : best === "end"
        ? [0, crossTotal - ref]
        : [Math.max(0, 2 * ref - crossTotal), Math.max(0, crossTotal - 2 * ref)];
  if (cpad[0] < -0.5 || cpad[1] < -0.5) return null;
  // a hair outside the box (subpixel layout) is no padding: CSS rejects a negative one outright
  cpad[0] = Math.max(0, cpad[0]);
  cpad[1] = Math.max(0, cpad[1]);
  // (flow first: the paddings are the room every child leaves, no more: one child's offset as the line's padding moves
  // the others with it in a box as tall as its content — a taller child would be aligned to its end below it)
  if (crossFree) {
    const room0 = Math.min(...sorted.map((b) => b[cross])),
      room1 = Math.min(...sorted.map((b) => crossTotal - b[cross] - b[clen]));
    if (best === "start" && room0 < cpad[0] - TOL) cpad[0] = Math.max(0, room0);
    if (best === "end" && room1 < cpad[1] - TOL) cpad[1] = Math.max(0, room1);
  }
  const centre = cpad[0] + (crossTotal - cpad[0] - cpad[1]) / 2;
  const selfAlign: (Align | null)[] = [];
  const crossMargins: number[] = [];
  for (const b of sorted) {
    // the alignment that reproduces the child best (a centred child can also sit within a pixel of the start line)
    const errs: [Align, number][] = [
      ["start", Math.abs(b[cross] - cpad[0])],
      ["center", Math.abs(b[cross] + b[clen] / 2 - centre)],
      ["end", Math.abs(b[cross] + b[clen] - (crossTotal - cpad[1]))],
    ];
    const [at, err] = errs.reduce((x, y) =>
      y[1] < x[1] - 0.01 || (Math.abs(y[1] - x[1]) <= 0.01 && y[0] === best) ? y : x,
    );
    if (err > TOL) {
      const off = b[cross] - cpad[0];
      if (!crossFree || off < -0.5) return null;
      selfAlign.push("start");
      crossMargins.push(snap(Math.max(0, off)));
      continue;
    }
    selfAlign.push(at === best ? null : at);
    crossMargins.push(0);
  }
  const justify: "start" | "center" =
    sorted.length <= 3 && padStart > 0.5 && near(endSpace, padStart) && !margins.some((m) => m)
      ? "center"
      : "start";
  return {
    dir,
    sorted,
    gap: snap(gap),
    margins,
    selfAlign,
    crossMargins,
    lead,
    padStart: justify === "center" ? 0 : snap(Math.max(0, padStart)),
    start: snap(Math.max(0, padStart)),
    align: best,
    cpad: cpad.map(snap) as [number, number],
    justify,
    endSpace: snap(endSpace),
  };
}

/** Rows of equal cells (cards, tiles, footer columns): a CSS grid with px tracks. */
function gridOf(boxes: Box[]) {
  if (boxes.length < 4) return null;
  const rows: Box[][] = [];
  for (const b of [...boxes].sort((p, q) => p.y - q.y || p.x - q.x)) {
    const row = rows.find((r) => Math.abs(r[0]!.y - b.y) <= TOL);
    if (row) row.push(b);
    else rows.push([b]);
  }
  if (rows.length < 2) return null;
  rows.forEach((r) => r.sort((p, q) => p.x - q.x));
  const first = rows[0]!;
  const cols = first.length;
  if (cols < 2 || rows.some((r) => r.length > cols)) return null;
  if (
    rows.some((r) => r.some((b, i) => Math.abs(b.x - first[i]!.x) > TOL || Math.abs(b.w - first[i]!.w) > TOL))
  )
    return null;
  const colGaps = first.slice(1).map((b, i) => b.x - (first[i]!.x + first[i]!.w));
  if (colGaps.some((g) => g < -0.5 || Math.abs(g - colGaps[0]!) > TOL)) return null;
  const rowH = rows.map((r) => Math.max(...r.map((b) => b.h)));
  const rowGaps = rows.slice(1).map((r, i) => r[0]!.y - (rows[i]![0]!.y + rowH[i]!));
  if (rowGaps.some((g) => g < -0.5 || Math.abs(g - rowGaps[0]!) > TOL)) return null;
  // every cell top-aligned in its row
  if (rows.some((r) => r.some((b) => Math.abs(b.y - r[0]!.y) > TOL))) return null;
  // one gap per axis (the mean) must put every track within DRIFT of where it was: per-gap slack adds up otherwise
  const mean = (g: number[]) => (g.length ? g.reduce((x, y) => x + y, 0) / g.length : 0);
  const columnGap = mean(colGaps),
    rowGap = mean(rowGaps);
  let x = first[0]!.x,
    y = rows[0]![0]!.y;
  if (
    first.some((b) => {
      const off = Math.abs(b.x - x);
      x += b.w + columnGap;
      return off > DRIFT;
    })
  )
    return null;
  if (
    rows.some((r, i) => {
      const off = Math.abs(r[0]!.y - y);
      y += rowH[i]! + rowGap;
      return off > DRIFT;
    })
  )
    return null;
  if (first[0]!.x < -0.5 || first[0]!.y < -0.5) return null;
  return {
    cells: rows.flat(),
    tracks: first.map((b) => `${r2(b.w)}px`),
    columnGap: snap(columnGap),
    rowGap: snap(rowGap),
    pad: [snap(Math.max(0, first[0]!.y)), snap(Math.max(0, first[0]!.x))] as [number, number],
  };
}

const unplace = (el: SceneElement) => {
  const { position: _p, x: _x, y: _y, ...rest } = el.layout ?? {};
  el.layout = { ...rest };
};

/**
 * Turn a frame's absolute children into auto layout when that reproduces every position (±1px): a flex row /
 * column (gap = smallest spacing, larger ones as margins, odd cross alignments as alignSelf) or a grid of equal
 * cells. Children that were absolutely positioned in the page (overlays, badges, background photos) stay absolute.
 */
function tryAutoLayout(ctx: Ctx, frame: SceneElement): boolean {
  const kids = frame.children;
  const size = ctx.sizes.get(frame);
  if (!kids?.length || !size || kids.length > 60) return false;
  const [bt, br, bb, bl] = borderOf(frame);
  const inner = { w: size.w - bl - br, h: size.h - bt - bb };
  const flow: Box[] = [];
  for (const k of kids) {
    const l = k.layout;
    const s = ctx.sizes.get(k);
    if (!l || l.position !== "absolute" || typeof l.x !== "number" || typeof l.y !== "number" || !s)
      return false;
    if (ctx.outOfFlow.has(k)) continue;
    if (l.rotation) return false;
    (ctx.lineTop ??= new WeakMap()).set(k, l.y);
    flow.push({
      el: k,
      x: l.x,
      y: l.y,
      w: typeof l.width === "number" ? l.width : s.w,
      h: s.h,
      rows: s.rows ?? 1,
    });
  }
  if (!flow.length) return false;
  // flow first: a multi-column box (CSS columns) flows its children down its columns, as the page does
  if (ctx.flow && multiColumn(ctx, frame, flow)) return true;
  // flow first: a CSS grid whose children the page places itself (grid-column: span 3 / 4 / 7) keeps that grid
  if (ctx.flow && cssGrid(ctx, frame, flow)) return true;
  // flow first: a text and the small boxes on its last line right after it (an info icon, a badge) are one run of
  // inline content: they wrap together
  if (ctx.flow && inlineRun(ctx, frame, flow)) return true;
  // out-of-flow layers painted before the flow stay underneath it, the others on top
  const firstFlow = kids.findIndex((k) => !ctx.outOfFlow.has(k));
  const under = kids.slice(0, firstFlow),
    over = kids.slice(firstFlow).filter((k) => ctx.outOfFlow.has(k));
  // (flow first: inline-block boxes wrap onto more lines as the page narrows: no fixed grid of their columns)
  if (ctx.flow && inlineBlocks(ctx, frame, flow) && cssWrapRow(ctx, frame, flow, inner, under, over))
    return true;
  const grid = gridOf(flow);
  if (grid) {
    frame.layout = {
      ...frame.layout,
      grid: { columns: grid.tracks, columnGap: grid.columnGap, rowGap: grid.rowGap },
      padding: [grid.pad[0], 0, 0, grid.pad[1]],
      align: "start",
      justify: "start",
    };
    grid.cells.forEach((b) => unplace(b.el));
    frame.children = [...under, ...grid.cells.map((b) => b.el), ...over];
    ctx.stats.autoLayout++;
    return true;
  }
  // flow first: a wrapping flex row is the page's own flex layout (its lines are no single row or column)
  if (ctx.flow && cssWrapRow(ctx, frame, flow, inner, under, over)) return true;
  // (flow first: a slide track is a row whose slides run past its end; they keep their widths and scroll into view)
  const track = ctx.flow && frame.layout?.scroll === "horizontal";
  // (flow first: a negative leading margin of the page's CSS pulls a child over the one before it)
  const pull = (side: 0 | 3) => (ctx.flow ? (b: Box) => ctx.marginOf.get(b.el)?.[side] ?? 0 : undefined);
  const mo = ctx.flow ? (e: SceneElement) => ctx.marginOf.get(e) : undefined;
  const res = track
    ? flexLine(flow, "row", inner, true, true)
    : (flexLine(flow, "row", inner, ctx.flow, false, pull(3), mo) ??
      flexLine(flow, "column", inner, ctx.flow, false, pull(0), mo));
  if (!res) return false;
  const { dir, sorted, gap, margins, selfAlign, crossMargins, align, cpad, endSpace, lead } = res;
  // a flex item the page lets grow (`flex-grow`) fills the room before its next sibling: equal items (teasers whose text
  // column takes what is left beside an image and an arrow) come out the same whatever their text measures
  const grows = new Set<number>();
  if (dir === "row")
    sorted.forEach((b, i) => {
      if (
        i < sorted.length - 1 &&
        (ctx.css.get(b.el)?.grow ?? 0) > 0 &&
        typeof b.el.layout?.width === "number"
      )
        grows.add(i);
    });
  // (a row centred between equal insets whose item grows has nothing left to centre: the insets are its padding)
  // (flow first: equal insets the page's CSS gives as the frame's padding are padding, not centring: the frame then
  // grows with its content instead of keeping it centred in a fixed box)
  const cssPad = ctx.css.get(frame)?.padding;
  const padded =
    ctx.flow &&
    res.justify === "center" &&
    !!cssPad &&
    Math.abs((dir === "row" ? cssPad[3]! : cssPad[0]!) - res.start) <= 1;
  const keepInsets = res.justify === "center" && (grows.size > 0 || padded);
  const justify = keepInsets ? "start" : res.justify,
    padStart = keepInsets ? res.start : res.padStart;
  const padding: [number, number, number, number] =
    dir === "row" ? [cpad[0], keepInsets ? endSpace : 0, cpad[1], padStart] : [padStart, cpad[1], 0, cpad[0]];
  frame.layout = { ...frame.layout, direction: dir, gap, padding, align, justify };
  // as tall as its content on the page (the space below the flow is its own bottom padding): it hugs its content, so
  // it grows / shrinks with it wherever the text wraps otherwise (another width, another browser's font metrics)
  const css = ctx.css.get(frame);
  // (the capture records padding only where a side has some: a captured box without it has none)
  const padBottom = css?.padding?.[2] ?? (css ? 0 : null);
  const below = dir === "column" ? endSpace : r2(inner.h - Math.max(...sorted.map((b) => b.y + b.h)));
  // the space below the flow is the frame's bottom padding, or that and the last child's bottom margin (flow first; a
  // box that clips its corners still grows with its content)
  const lastBottom = [...sorted].sort((a, b) => b.y + b.h - (a.y + a.h))[0];
  const lastMargin = (lastBottom && ctx.marginOf.get(lastBottom.el)?.[2]) || 0;
  const hugs =
    padBottom !== null &&
    (!frame.layout.clip || ctx.flow) &&
    !frame.layout.scroll &&
    typeof frame.layout.height === "number" &&
    (Math.abs(below - padBottom) <= 1 || (ctx.flow && Math.abs(below - padBottom - lastMargin) <= 1)) &&
    (dir === "column"
      ? justify === "start"
      : align === "start" &&
        sorted.every((b) => !b.el.layout?.alignSelf || b.el.layout.alignSelf === "start"));
  // flow first: a row as tall as its tallest child (with its margins) and the page's padding hugs it too, whatever
  // its alignment: a header bar, a logo link, a button, a list item
  const cp = css?.padding ?? (css ? [0, 0, 0, 0] : null);
  const tallest = Math.max(
    ...sorted.map((b) => b.h + (ctx.marginOf.get(b.el)?.[0] ?? 0) + (ctx.marginOf.get(b.el)?.[2] ?? 0)),
  );
  const rowHugs =
    !hugs &&
    ctx.flow &&
    dir === "row" &&
    !!cp &&
    !frame.layout.scroll &&
    typeof frame.layout.height === "number" &&
    Math.abs(inner.h - tallest - cp[0]! - cp[2]!) <= 1;
  if (hugs || rowHugs) {
    (ctx.hugFrom ??= new WeakMap()).set(frame, {
      height: frame.layout.height as number,
      padding: frame.layout.padding,
    });
    frame.layout.height = "hug";
    frame.layout.padding = rowHugs
      ? [snap(cp![0]!), padding[1], snap(cp![2]!), padding[3]]
      : [padding[0], padding[1], r2(Math.max(0, below)), padding[3]];
  } else if (
    ctx.flow &&
    (dir === "column" ? justify === "start" : align === "start") &&
    below > 1 &&
    typeof frame.layout.height === "number"
  )
    // a box keeping its height with room below its flow: an export that lets the box follow its content (its height
    // changes where text wraps) keeps that room below it (`meta.below`; an empty last box's margin on the page)
    frame.meta = { ...(frame.meta ?? {}), below: r2(below) };
  sorted.forEach((b, i) => {
    unplace(b.el);
    if (b.el.type === "text" && b.el.layout?.width === undefined) delete b.el.layout!.width;
    if (grows.has(i)) b.el.layout!.width = "fill";
    const m = i > 0 && !grows.has(i - 1) ? margins[i - 1]! : i === 0 ? lead : 0;
    // (a row hugging its child takes the page's top padding: a cross margin measured from the line's own padding
    // would count that padding twice, push the child down and grow the row)
    const cm = rowHugs
      ? Math.max(0, (crossMargins[i] ?? 0) - (snap(cp![0]!) - padding[0]))
      : (crossMargins[i] ?? 0);
    if (m || cm) b.el.layout!.margin = dir === "row" ? [cm, 0, 0, m] : [m, 0, 0, cm];
    // a row hugging its tallest child with that child's margins keeps them (or it would lose that room)
    if (rowHugs) {
      const own = ctx.marginOf.get(b.el);
      if (own && (own[0]! > 0 || own[2]! > 0)) {
        const cur = (b.el.layout!.margin as [number, number, number, number] | undefined) ?? [0, 0, 0, 0];
        b.el.layout!.margin = [
          snap(Math.max(cur[0], own[0]!)),
          cur[1],
          snap(Math.max(cur[2], own[2]!)),
          cur[3],
        ];
      }
    }
    // components default to stretching in columns (buttons, inputs): pin their cross alignment
    const self =
      selfAlign[i] ??
      (dir === "column" && b.el.type !== "text" && b.el.type !== "frame" && b.el.type !== "icon"
        ? align
        : null);
    if (self) b.el.layout!.alignSelf = self;
  });
  frame.children = [...under, ...sorted.map((b) => b.el), ...over];
  anchorOutOfFlow(ctx, frame, inner);
  ctx.stats.autoLayout++;
  return true;
}

/**
 * Layers the page positions itself (CSS absolute: an arrow in a card's corner, a badge) inside a frame now in flow:
 * placed from the edges they are nearer to (right / bottom when closer), as the page anchors them, so the same card
 * at another size keeps them in its corner.
 */
function anchorOutOfFlow(ctx: Ctx, frame: SceneElement, inner: { w: number; h: number }) {
  for (const k of frame.children ?? []) {
    const l = k.layout;
    if (
      !ctx.outOfFlow.has(k) ||
      l?.position !== "absolute" ||
      typeof l.x !== "number" ||
      typeof l.y !== "number"
    )
      continue;
    const s = ctx.sizes.get(k);
    const w = typeof l.width === "number" ? l.width : s?.w,
      h = typeof l.height === "number" ? l.height : s?.h;
    if (w === undefined || h === undefined) continue;
    const right = inner.w - l.x - w,
      bottom = inner.h - l.y - h;
    const next: SceneLayout = { ...l };
    if (right >= -0.5 && right < l.x - 0.5) {
      next.right = r2(right);
      delete next.x;
    }
    if (bottom >= -0.5 && bottom < l.y - 0.5) {
      next.bottom = r2(bottom);
      delete next.y;
    }
    k.layout = next;
  }
}

/**
 * A CSS grid of equal tracks (a 12-column page grid) whose children say where they go (`grid-column` / `grid-row`):
 * the grid as the page writes it — as many `minmax(0, 1fr)` columns, its gaps — and each child in the page's order
 * with its placement (`meta.gridColumn` / `gridRow`, fromDsl) and margins, so it reflows as the page's grid does. Only
 * when at least one child is placed (an auto-placed grid of equal cells is gridOf's).
 */
function cssGrid(ctx: Ctx, frame: SceneElement, flow: Box[]): boolean {
  const css = ctx.css.get(frame);
  if (!css || !/grid/.test(css.display) || !css.cols || flow.length < 2) return false;
  const tracks = css.cols
    .trim()
    .split(/\s+/)
    .map((t) => (/^-?\d*\.?\d+px$/.test(t) ? parseFloat(t) : NaN));
  if (tracks.some((t) => !Number.isFinite(t)) || Math.max(...tracks) - Math.min(...tracks) > 0.5)
    return false;
  const [rowGap, colGap] = css.gap ?? [0, 0];
  const pad = css.padding ?? [0, 0, 0, 0];
  if (
    !flow.some((b) => ctx.gridPlace?.get(b.el)?.column) &&
    !autoPlaced(ctx, frame, flow, tracks, colGap, pad[1] ?? 0, pad[3] ?? 0)
  )
    return false;
  // (numbered lines and spans only: named lines and areas need the page's template, which is not captured)
  const NUMERIC = /^(span \d+|-?\d+)( \/ (span \d+|-?\d+|auto))?$/;
  if (
    flow.some((b) => {
      const p = ctx.gridPlace?.get(b.el);
      return (!!p?.column && !NUMERIC.test(p.column)) || (!!p?.row && !NUMERIC.test(p.row));
    })
  )
    return false;
  for (const b of flow) {
    unplace(b.el);
    const place = ctx.gridPlace?.get(b.el);
    const mb = ctx.marginOf.get(b.el);
    const { width: _w, margin: _m, ...rest } = b.el.layout ?? {};
    b.el.layout = {
      ...rest,
      width: "fill",
      ...(mb?.some((v) => v) ? { margin: mb.map(r2) as [number, number, number, number] } : {}),
    };
    if (place)
      b.el.meta = {
        ...(b.el.meta ?? {}),
        ...(place.column ? { gridColumn: place.column } : {}),
        ...(place.row ? { gridRow: place.row } : {}),
      };
  }
  frame.layout = {
    ...frame.layout,
    grid: { columns: tracks.length, columnGap: r2(colGap), rowGap: r2(rowGap) },
    padding: [r2(pad[0] ?? 0), r2(pad[1] ?? 0), r2(pad[2] ?? 0), r2(pad[3] ?? 0)],
    // (the page's alignment: `normal` stretches each child to its row, as tall as the row's tallest)
    align: /center/.test(css.align ?? "")
      ? "center"
      : /end/.test(css.align ?? "")
        ? "end"
        : /start/.test(css.align ?? "")
          ? "start"
          : "stretch",
    justify: "start",
  };
  // stretched children follow their row, not a height of their own
  if (frame.layout.align === "stretch")
    for (const b of flow)
      if (typeof b.el.layout?.height === "number") {
        const { height: _h, ...rest } = b.el.layout;
        b.el.layout = rest;
      }
  if (typeof frame.layout.height === "number") frame.layout.height = "hug";
  ctx.stats.autoLayout++;
  return true;
}

/**
 * Children the page's grid places itself (no grid-column), one per cell in document order, row by row, each one track
 * wide, with the equal tracks filling the content box: then 1fr tracks put every child where it was, and they keep
 * doing so at other widths, where px tracks would run past the box or leave it half empty.
 */
function autoPlaced(
  ctx: Ctx,
  frame: SceneElement,
  flow: Box[],
  tracks: number[],
  colGap: number,
  padR: number,
  padL: number,
): boolean {
  const size = ctx.sizes.get(frame);
  const n = tracks.length,
    tw = tracks[0]!;
  if (!size || n < 2) return false;
  const [, br, , bl] = borderOf(frame);
  const content = size.w - bl - br - padL - padR;
  if (Math.abs(n * tw + (n - 1) * colGap - content) > 2) return false;
  const x0 = flow[0]!.x;
  let rowTop = flow[0]!.y,
    rowBottom = -Infinity;
  for (let i = 0; i < flow.length; i++) {
    const b = flow[i]!;
    if (Math.abs(b.w - tw) > 1 || Math.abs(b.x - (x0 + (i % n) * (tw + colGap))) > 1) return false;
    if (i % n === 0 && i > 0) {
      // a new row starts below the last one
      if (b.y < rowBottom - 1) return false;
      rowTop = b.y;
    } else if (Math.abs(b.y - rowTop) > TOL) return false;
    rowBottom = Math.max(i % n === 0 ? -Infinity : rowBottom, b.y + b.h);
  }
  return true;
}

/**
 * A box with CSS columns (`column-width` / `column-count`): its children flow down one column and on into the next,
 * which no flex line reproduces. They stay in the page's order with their own bottom margins, and the export writes
 * the page's columns (`meta.columnWidth` / `columnCount` / `columnGap`, fromDsl), so the browser fills the columns at
 * every width as the page does. The frame is as tall as its columns.
 */
function multiColumn(ctx: Ctx, frame: SceneElement, flow: Box[]): boolean {
  const cols = ctx.css.get(frame)?.columns;
  if (!cols || (!cols.width && !cols.count) || flow.length < 2 || frame.layout?.scroll) return false;
  for (const b of flow) {
    unplace(b.el);
    const mb = ctx.marginOf.get(b.el)?.[2] ?? 0;
    const { margin: _m, ...rest } = b.el.layout ?? {};
    b.el.layout = { ...rest, width: "fill", ...(mb > 0 ? { margin: [0, 0, r2(mb), 0] } : {}) };
  }
  // the columns are filled in reading order; the frame's children are in paint order
  const reading = [...flow].sort((a, b) => (Math.abs(a.x - b.x) < 2 ? a.y - b.y : a.x - b.x));
  const inFlow = new Set(flow.map((b) => b.el));
  let next = 0;
  frame.children = frame.children?.map((k) => (inFlow.has(k) ? reading[next++]!.el : k));
  const pad = ctx.css.get(frame)?.padding ?? [0, 0, 0, 0];
  frame.layout = {
    ...frame.layout,
    direction: "column",
    gap: 0,
    padding: [r2(pad[0] ?? 0), r2(pad[1] ?? 0), r2(pad[2] ?? 0), r2(pad[3] ?? 0)],
    align: "stretch",
    justify: "start",
  };
  if (typeof frame.layout.height === "number") frame.layout.height = "hug";
  frame.meta = {
    ...(frame.meta ?? {}),
    ...(cols.width ? { columnWidth: cols.width } : {}),
    ...(cols.count ? { columnCount: cols.count } : {}),
    columnGap: cols.gap,
  };
  ctx.stats.autoLayout++;
  return true;
}

/** A text's last line in its parent's space (`ctx.lastLine`), or null (a clamped text has no last line of its own). */
function lastLineOfBox(ctx: Ctx, t: Box): { x1: number; y: number; h: number } | null {
  const own = ctx.lastLine?.get(t.el);
  if (!own || t.el.style?.truncate) return null;
  return { x1: t.x + own.x1, y: t.y + own.y, h: own.h };
}

/** Small boxes (icon-sized: a few lines tall at most) on the line's row, each about where the line or the box before ends. */
function onLastLine(last: { x1: number; y: number; h: number }, boxes: Box[]): boolean {
  if (!boxes.length) return false;
  let end = last.x1;
  for (const b of boxes) {
    const cy = b.y + b.h / 2;
    if (b.el.type === "text" || b.h > 3 * last.h || b.w > 6 * last.h) return false;
    if (cy < last.y - 2 || cy > last.y + last.h + 2) return false;
    // (a little before it too: an icon button pulled back by a negative margin)
    if (b.x < end - Math.max(2, 0.5 * last.h) || b.x > end + last.h) return false;
    end = b.x + b.w;
  }
  return true;
}

/**
 * A block whose last text, with small boxes on its last line right after it, follows other content above it (two
 * paragraphs, then a line ending in an info icon: the page's anonymous inline run after them). That run becomes a
 * block of its own (`meta.inline`, laid out by inlineRun), and the block lays out its content again, the run now one
 * box of it. → whether it did.
 */
function inlineTail(ctx: Ctx, frame: SceneElement, flow: Box[]): boolean {
  const texts = flow.filter((b) => b.el.type === "text");
  if (texts.length < 2 || flow.length > 12) return false;
  const t = texts.reduce((a, b) => (b.y > a.y ? b : a));
  const last = lastLineOfBox(ctx, t);
  if (!last) return false;
  const boxes = flow
    .filter((b) => b !== t && b.y + b.h / 2 >= t.y && b.x >= t.x - 1)
    .sort((a, b) => a.x - b.x);
  if (!onLastLine(last, boxes)) return false;
  const run = [t, ...boxes];
  const rest = flow.filter((b) => !run.includes(b));
  // the rest is above the run (it comes before it in the page)
  if (rest.some((b) => b.y + b.h > t.y + 1)) return false;
  // (the run's block spans the block's content, as the boxes above it do: a centred line stays centred in it)
  const x = Math.min(...flow.map((b) => b.x)),
    y = Math.min(...run.map((b) => b.y)),
    w = Math.max(...flow.map((b) => b.x + b.w)) - x,
    h = Math.max(...run.map((b) => b.y + b.h)) - y;
  const wrap: SceneElement = {
    id: nid(ctx),
    type: "frame",
    name: `Text · ${t.el.name}`.slice(0, 60),
    layout: { position: "absolute", x: r2(x), y: r2(y), width: r2(w), height: r2(h) },
    style: {},
    children: run.map((b) => b.el),
  };
  for (const b of run) b.el.layout = { ...b.el.layout, x: r2(b.x - x), y: r2(b.y - y) };
  ctx.sizes.set(wrap, { w, h });
  ctx.css.set(wrap, { display: "block", position: "static" });
  const kids = frame.children ?? [];
  const at = kids.indexOf(t.el);
  frame.children = kids.flatMap((k, i) => (i === at ? [wrap] : run.some((b) => b.el === k) ? [] : [k]));
  // the run first (its own lines), then the block around it
  tryAutoLayout(ctx, wrap);
  tryAutoLayout(ctx, frame);
  return true;
}

/**
 * A block holding one text and, on its last line right after it, a few small boxes (an info icon, a footnote button, a
 * badge: the page's inline-block / inline-flex boxes in a line of text). Placed side by side or one under the other
 * they would sit wherever they were at the capture width; the export lays them out as inline content instead
 * (`meta.inline`: the block's children flow in its lines, fromDsl), so the boxes follow the text's last line at every
 * width. Children in order (the text, then the boxes left to right), the frame as tall as its lines.
 */
function inlineRun(ctx: Ctx, frame: SceneElement, flow: Box[]): boolean {
  const css = ctx.css.get(frame);
  if (!css || !/^(block|list-item|flow-root)$/.test(css.display ?? "block") || frame.layout?.scroll)
    return false;
  if (inlineTail(ctx, frame, flow)) return true;
  const texts = flow.filter((b) => b.el.type === "text");
  if (texts.length !== 1 || flow.length < 2 || flow.length > 4) return false;
  const t = texts[0]!;
  const last = lastLineOfBox(ctx, t);
  const boxes = flow.filter((b) => b !== t).sort((a, b) => a.x - b.x);
  if (!last || !onLastLine(last, boxes)) return false;
  const ordered = [t, ...boxes];
  for (const b of ordered) unplace(b.el);
  // the boxes keep the gap they had after the line (a space, a margin); the lines are as tall as their content, as on
  // the page (a box taller than the text makes its line taller there too)
  let x = last.x1;
  for (const b of boxes) {
    const gap = r2(Math.max(0, b.x - x));
    if (gap >= 1) b.el.layout = { ...b.el.layout, margin: [0, 0, 0, gap] };
    x = b.x + b.w;
  }
  t.el.layout = { ...t.el.layout, width: "fill" };
  const lh = ctx.cssLine?.get(t.el);
  if (lh) t.el.meta = { ...(t.el.meta ?? {}), cssLineHeight: lh };
  const kids = frame.children ?? [];
  const rest = kids.filter((k) => !ordered.some((b) => b.el === k));
  // (its own padding as the page gives it: what is around the lines)
  const pad = ctx.css.get(frame)?.padding ?? [0, 0, 0, 0];
  frame.layout = {
    ...frame.layout,
    direction: "column",
    gap: 0,
    padding: [r2(pad[0] ?? 0), r2(pad[1] ?? 0), r2(pad[2] ?? 0), r2(pad[3] ?? 0)],
    align: "stretch",
    justify: "start",
  };
  if (typeof frame.layout.height === "number") frame.layout.height = "hug";
  frame.children = [...ordered.map((b) => b.el), ...rest];
  frame.meta = { ...(frame.meta ?? {}), inline: true };
  ctx.stats.autoLayout++;
  return true;
}

function autoLayoutPass(ctx: Ctx, el: SceneElement) {
  for (const c of el.children ?? []) autoLayoutPass(ctx, c);
  // a scrolling frame keeps its slides where they were captured (flow layout would squeeze them into its width);
  // flow first: a horizontal slide track flows as a row of slides that keep their widths
  if (
    el.children?.length &&
    (el.type === "frame" || el.type === "button") &&
    el.layout?.position !== undefined &&
    (!el.layout.scroll || (ctx.flow && el.layout.scroll === "horizontal"))
  )
    tryAutoLayout(ctx, el);
  // a frame hugging its content grows only where its parent flows it in a column (the rest below moves with it): in a
  // row or grid its height is the row's (equal cards), placed in its parent it keeps its box (neighbours do not move)
  const column = el.layout?.direction === "column" && !el.layout.grid;
  // flow first: a row or grid whose boxes in each line are equally tall stretches them to the line (equal cards), so a
  // box as tall as its content stays that way: the line is as tall as its tallest box wherever text wraps
  const stretch = ctx.flow && !column && !el.layout?.wrap && equalLines(ctx, el);
  let stretched = false;
  // (flow first: in a row that centres its children, or as its only child, a box keeps its content's height)
  const flowKids = (el.children ?? []).filter((c) => c.layout?.position !== "absolute");
  const ownHeight =
    ctx.flow &&
    !el.layout?.grid &&
    el.layout?.direction === "row" &&
    (el.layout.align === "center" || !!el.layout.wrap || flowKids.length === 1);
  for (const c of el.children ?? []) {
    const was = ctx.hugFrom?.get(c);
    if (!was || c.layout?.height !== "hug" || (column && c.layout.position !== "absolute")) continue;
    if (
      !stretch &&
      ownHeight &&
      c.layout.position !== "absolute" &&
      (!c.layout.alignSelf || c.layout.alignSelf === "center")
    )
      continue;
    if (stretch && c.layout.position !== "absolute") {
      const { height: _h, alignSelf: _a, ...rest } = c.layout;
      c.layout = rest;
      stretched = true;
    } else if (ctx.flow)
      // flow first: it keeps its box, and the padding it hugged with (the page's: an export that lets it follow its
      // content again finds it there; with its height set it changes nothing)
      c.layout = { ...c.layout, height: was.height };
    else c.layout = { ...c.layout, height: was.height, padding: was.padding };
  }
  if (stretched) el.layout = { ...el.layout, align: "stretch" };
}

/** The flow children of a row / grid frame: in each line (same top) equally tall, and top-aligned. */
function equalLines(ctx: Ctx, el: SceneElement): boolean {
  const flow = (el.children ?? []).filter((c) => c.layout?.position !== "absolute");
  if (flow.length < 2 || (!el.layout?.grid && el.layout?.direction !== "row")) return false;
  // a row is one line; a grid's lines are its rows (children with the same top)
  const lines = new Map<number, number[]>();
  for (const c of flow) {
    const g = ctx.sizes.get(c);
    const y = ctx.lineTop?.get(c);
    if (!g || y === undefined) return false;
    const k = el.layout?.grid ? Math.round(y) : 0;
    lines.set(k, [...(lines.get(k) ?? []), g.h]);
  }
  return (
    [...lines.values()].some((hs) => hs.length >= 2) &&
    [...lines.values()].every((hs) => Math.max(...hs) - Math.min(...hs) <= 1)
  );
}

/**
 * A block whose children are all inline-level boxes (inline-block / inline-flex / inline-grid: link groups of a
 * footer) lays them out in lines as a wrapping flex row starting at its start edge would. → that row's CSS, its gap
 * between neighbours on a line read from the capture (the whitespace between them, the same everywhere ±1.5 px), or
 * undefined when it is no such block.
 */
function inlineBlocks(ctx: Ctx, frame: SceneElement, flow: Box[]): SnapLayout | undefined {
  const css = ctx.css.get(frame);
  if (!css || !/^(block|flow-root|list-item)$/.test(css.display) || flow.length < 2) return undefined;
  const disp = (b: Box) => ctx.css.get(b.el)?.display ?? ctx.displayOf.get(b.el) ?? "";
  if (!flow.every((b) => /^inline-(block|flex|grid)$/.test(disp(b)))) return undefined;
  const m = (b: Box) => ctx.marginOf.get(b.el) ?? [0, 0, 0, 0];
  const gaps: number[] = [];
  for (let i = 1; i < flow.length; i++) {
    const a = flow[i - 1]!,
      b = flow[i]!;
    if (b.x > a.x + a.w - 1) gaps.push(b.x - m(b)[3]! - (a.x + a.w + m(a)[1]!));
  }
  if (gaps.length && Math.max(...gaps) - Math.min(...gaps) > 1.5) return undefined;
  const gap = gaps.length ? Math.max(0, Math.min(...gaps)) : 0;
  return {
    ...css,
    display: "flex",
    wrap: "wrap",
    dir: "row",
    justify: "normal",
    align: "normal",
    gap: [0, gap],
  };
}

/**
 * A frame the page lays out as a wrapping flex row (`flex-wrap: wrap`): its lines rebuilt from the page's own gaps,
 * paddings and the children's margins, and kept when that reproduces every child's position (±1.5 px). The frame then
 * wraps its children at any width, as the page does.
 */
function cssWrapRow(
  ctx: Ctx,
  frame: SceneElement,
  painted: Box[],
  inner: { w: number; h: number },
  under: SceneElement[],
  over: SceneElement[],
): boolean {
  // the lines run in reading order; the frame's children are in paint order (boxes before text)
  const flow = [...painted].sort((a, b) =>
    Math.abs(a.y + a.h / 2 - b.y - b.h / 2) < Math.min(a.h, b.h) / 2 ? a.x - b.x : a.y - b.y,
  );
  const css = inlineBlocks(ctx, frame, flow) ?? ctx.css.get(frame);
  if (
    !css ||
    !/flex/.test(css.display) ||
    css.wrap !== "wrap" ||
    !/^row/.test(css.dir ?? "row") ||
    flow.length < 2
  )
    return false;
  if (css.dir === "row-reverse") return false;
  const jc = css.justify ?? "normal";
  const justify: NonNullable<SceneLayout["justify"]> = /^(normal|flex-start|start|left|stretch)$/.test(jc)
    ? "start"
    : /^(center)$/.test(jc)
      ? "center"
      : /^(flex-end|end|right)$/.test(jc)
        ? "end"
        : jc === "space-between"
          ? "between"
          : jc === "space-around"
            ? "around"
            : jc === "space-evenly"
              ? "evenly"
              : ("" as never);
  if (!justify) return false;
  const pad = css.padding ?? [0, 0, 0, 0];
  const [rowGap, colGap] = css.gap ?? [0, 0];
  const avail = inner.w - pad[1]! - pad[3]!;
  const m = (b: Box) => ctx.marginOf.get(b.el) ?? [0, 0, 0, 0];
  const lines: Box[][] = [];
  let x = 0;
  for (const b of flow) {
    const w = b.w + m(b)[1]! + m(b)[3]!;
    const line = lines[lines.length - 1];
    if (!line || (line.length && x + colGap + w > avail + 0.5)) {
      lines.push([b]);
      x = w;
    } else {
      line.push(b);
      x += colGap + w;
    }
  }
  const alignTo = css.align ?? "normal";
  const shifts = new Map<Box, number>();
  let top = pad[0]!;
  for (const line of lines) {
    const lh = Math.max(...line.map((b) => b.h + m(b)[0]! + m(b)[2]!));
    // the line's free room, spread as the page's justify-content spreads it
    const used = line.reduce((t, b) => t + b.w + m(b)[1]! + m(b)[3]!, 0) + colGap * (line.length - 1);
    const free = Math.max(0, avail - used);
    const k = line.length;
    const lead =
      justify === "center"
        ? free / 2
        : justify === "end"
          ? free
          : justify === "around"
            ? free / k / 2
            : justify === "evenly"
              ? free / (k + 1)
              : 0;
    const between =
      justify === "between"
        ? k > 1
          ? free / (k - 1)
          : 0
        : justify === "around"
          ? free / k
          : justify === "evenly"
            ? free / (k + 1)
            : 0;
    let at = pad[3]! + lead;
    for (const b of line) {
      const mb = m(b);
      const off = /center/.test(alignTo)
        ? (lh - b.h - mb[0]! - mb[2]!) / 2
        : /end/.test(alignTo)
          ? lh - b.h - mb[0]! - mb[2]!
          : 0;
      if (Math.abs(b.x - (at + mb[3]!)) > 1.5) return false;
      // (a little off its line vertically: a margin collapsed into it from inside, the list's -10px through its
      // wrappers; it keeps that shift, its line as tall as on the page)
      const dy = b.y - (top + mb[0]! + off);
      if (Math.abs(dy) > 1.5) {
        if (!ctx.flow || Math.abs(dy) > 0.25 * b.h) return false;
        shifts.set(b, dy);
      }
      at += mb[3]! + b.w + mb[1]! + colGap + between;
    }
    top += lh + rowGap;
  }
  const contentBottom = top - rowGap;
  frame.layout = {
    ...frame.layout,
    direction: "row",
    wrap: true,
    gap: snap(colGap),
    crossGap: snap(rowGap),
    padding: [pad[0]!, pad[1]!, pad[2]!, pad[3]!].map(snap) as [number, number, number, number],
    align: /center/.test(alignTo) ? "center" : /end/.test(alignTo) ? "end" : "start",
    justify,
  };
  for (const b of flow) {
    unplace(b.el);
    // an item that is a wrapping row itself (a navigation inside a bar): as wide as its content, shrinking to the
    // room left on its line, as a flex item does on the page
    const inner = ctx.css.get(b.el);
    if (
      inner &&
      /flex/.test(inner.display) &&
      inner.wrap === "wrap" &&
      (inner.shrink ?? 1) > 0 &&
      !inner.basis
    )
      b.el.layout = { ...b.el.layout, width: "hug" };
    const mb = [...m(b)];
    const dy = shifts.get(b) ?? 0;
    if (dy) {
      mb[0] = mb[0]! + dy;
      mb[2] = mb[2]! - dy;
    }
    if (mb.some((v) => v))
      b.el.layout = { ...b.el.layout, margin: mb.map(snap) as [number, number, number, number] };
    if (b.el.type === "text" && b.el.layout?.width === undefined) delete b.el.layout!.width;
  }
  frame.children = [...under, ...flow.map((b) => b.el), ...over];
  // as tall as its lines: it hugs them (more lines at a narrower width make it taller)
  if (
    typeof frame.layout.height === "number" &&
    Math.abs(inner.h - contentBottom - pad[2]!) <= 1 &&
    !frame.layout.scroll
  ) {
    (ctx.hugFrom ??= new WeakMap()).set(frame, {
      height: frame.layout.height,
      padding: frame.layout.padding,
    });
    frame.layout.height = "hug";
  }
  anchorOutOfFlow(ctx, frame, inner);
  ctx.stats.autoLayout++;
  return true;
}

/* ------------------------------------------------------------------ fluid intent */

/** captured horizontal box of a child in its parent's padding box (recorded before auto layout drops x) */
type Geo = { x: number; w: number; y: number };

function recordGeometry(ctx: Ctx, el: SceneElement, geo: WeakMap<SceneElement, Geo>) {
  for (const c of el.children ?? []) {
    const l = c.layout,
      s = ctx.sizes.get(c);
    if (l && typeof l.x === "number" && s)
      geo.set(c, {
        x: l.x,
        w: typeof l.width === "number" ? l.width : s.w,
        y: typeof l.y === "number" ? l.y : 0,
      });
    recordGeometry(ctx, c, geo);
  }
}

const pad4 = (p: SceneLayout["padding"]): [number, number, number, number] =>
  p === undefined
    ? [0, 0, 0, 0]
    : typeof p === "number"
      ? [p, p, p, p]
      : p.length === 2
        ? [p[0], p[1], p[0], p[1]]
        : [...p];

/**
 * What stretches when the page is wider than captured (docs/responsive.md "Converter output"). `frame` stretches with
 * the viewport. One rule, by the horizontal insets of a child (or of a row / grid's content block) in the frame:
 * spanning it, or equal insets up to a gutter (min(96, max(48, 7.5% of the page)), negatives = overhang) → fluid:
 * stretches with
 * the insets kept (flow child: width 'fill' + margins; absolute: constraints left-right; a row of several: its ends
 * pinned with justify 'between'; a grid of equal tracks: 1fr tracks, cells fill) and is visited in turn. Equal wider
 * insets → a centred max-width column (absolute: constraints center; row / grid: justify center). An absolute layer
 * hugging the right edge → constraints right. Every change keeps the captured pixels at the captured width.
 */
function fluidPass(ctx: Ctx, frame: SceneElement, geo: WeakMap<SceneElement, Geo>, pageW: number) {
  const size = ctx.sizes.get(frame);
  // a scrolling frame may stretch, its content (a row of slides wider than it) does not
  if (!size || !frame.children?.length || frame.layout?.scroll) return;
  const [bt, br, bb, bl] = borderOf(frame);
  // the width the renderer lays out (layout widths are rounded to 0.01): fills below must add up to it exactly
  const inner = r2(size.w) - bl - br;
  const l = frame.layout ?? {};
  const pad = pad4(l.padding);
  const row = !l.grid && l.direction === "row",
    col = !l.grid && l.direction === "column";
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const gutter = Math.min(96, Math.max(48, 0.075 * pageW));
  // spans, equal insets up to the gutter, or (wide content: list indents, uneven paddings) both insets within it
  const fluid = (L: number, R: number) =>
    (Math.abs(L) <= 1 && Math.abs(R) <= 1) ||
    (near(L, R) && Math.abs(L) <= gutter) ||
    (Math.abs(L) <= gutter && Math.abs(R) <= gutter && inner - L - R >= 0.5 * inner);
  let flow = frame.children.filter((c) => c.layout?.position !== "absolute");
  const fg = flow.map((c) => geo.get(c)!);
  const filled = new Set<SceneElement>();
  if (flow.length && fg.every(Boolean) && (row || l.grid)) {
    const x0 = Math.min(...fg.map((g) => g.x)),
      x1 = Math.max(...fg.map((g) => g.x + g.w));
    const L = x0,
      R = inner - x1;
    if (L > 1 && near(L, R) && L > gutter && (l.justify ?? "start") === "start" && near(L, pad[3]))
      frame.layout = { ...l, justify: "center", padding: [pad[0], 0, pad[2], 0] };
    else if (
      // inset on both sides, or flush with the frame (a grid spanning it keeps px tracks otherwise: they do not shrink)
      ((L > 1 && R > 1) || (Math.abs(L) <= 0.5 && Math.abs(R) <= 0.5)) &&
      fluid(L, R) &&
      l.grid &&
      new Set(fg.map((g) => Math.round(g.w))).size === 1 &&
      Array.isArray(l.grid.columns)
    ) {
      // equal tracks: 1fr tracks between the insets, cells fill them
      // the right inset from the tracks themselves, so 1fr resolves to exactly the captured track width
      const n = l.grid.columns.length,
        tw = parseFloat(l.grid.columns[0]!),
        cg = l.grid.columnGap ?? l.gap ?? 0;
      frame.layout = {
        ...l,
        grid: { ...l.grid, columns: n },
        justify: "start",
        padding: [pad[0], Math.max(0, inner - pad[3] - n * tw - (n - 1) * cg), pad[2], pad[3]],
      };
      for (const c of flow) {
        const { alignSelf: _a, ...rest } = c.layout ?? {};
        c.layout = { ...rest, width: "fill" };
        filled.add(c);
      }
    } else if (L > 1 && R > 1 && fluid(L, R) && row && !l.wrap && flow.length >= 2) {
      // ends pinned to the insets: two groups split at the widest gap, justify between
      const order = flow.map((c, i) => ({ c, g: fg[i]! })).sort((a, b) => a.g.x - b.g.x);
      let cut = 1,
        widest = -Infinity;
      for (let i = 1; i < order.length; i++) {
        const gap = order[i]!.g.x - (order[i - 1]!.g.x + order[i - 1]!.g.w);
        if (gap > widest) {
          widest = gap;
          cut = i;
        }
      }
      const inH = size.h - bt - bb - pad[0] - pad[2];
      const group = (part: typeof order): SceneElement => {
        if (part.length === 1) return part[0]!.c;
        const gx = part[0]!.g.x,
          gw = part[part.length - 1]!.g.x + part[part.length - 1]!.g.w - gx;
        const el: SceneElement = {
          id: nid(ctx),
          type: "frame",
          name: "Group",
          layout: {
            direction: "row",
            gap: l.gap ?? 0,
            align: l.align ?? "start",
            justify: "start",
            padding: 0,
            width: r2(gw),
            height: r2(inH),
          },
          style: {},
          children: part.map((x) => x.c),
        };
        const m = part[0]!.c.layout?.margin;
        if (m !== undefined) {
          const { margin: _m, ...rest } = part[0]!.c.layout!;
          part[0]!.c.layout = rest;
        }
        ctx.sizes.set(el, { w: gw, h: inH });
        geo.set(el, { x: gx, w: gw, y: pad[0] });
        return el;
      };
      const a = group(order.slice(0, cut)),
        b = group(order.slice(cut));
      if (b.layout?.margin !== undefined) {
        const { margin: _m, ...rest } = b.layout;
        b.layout = rest;
      }
      const first = frame.children.indexOf(flow[0]!);
      frame.children = [
        ...frame.children.slice(0, first).filter((c) => !flow.includes(c)),
        a,
        b,
        ...frame.children.slice(first).filter((c) => !flow.includes(c)),
      ];
      const last = order[order.length - 1]!.g;
      frame.layout = {
        ...l,
        justify: "between",
        padding: [pad[0], inner - last.x - last.w, pad[2], (l.justify ?? "start") === "start" ? pad[3] : L],
      };
      flow = [a, b];
    }
  }
  const p = pad4(frame.layout!.padding);
  const pin = (c: SceneElement, horizontal: "left-right" | "center" | "right") => {
    c.layout = { ...c.layout, constraints: { horizontal, vertical: "top" } };
  };
  const absKids = frame.children.filter(
    (c) => c.layout?.position === "absolute" && geo.has(c) && !c.layout?.rotation,
  );
  const covering = new Set<SceneElement>();
  // flow first: a placed layer covering its whole box (a backdrop, a gradient over a photo, a video layer) fills
  // that box at any width and height, as the page's `inset: 0` does, instead of keeping its measured size
  const innerH = size.h - bt - bb;
  for (const c of absKids) {
    const g = geo.get(c)!;
    const h = ctx.sizes.get(c)?.h ?? 0;
    if (
      !ctx.flow ||
      Math.abs(g.x) > 1 ||
      Math.abs(g.w - inner) > 1 ||
      Math.abs(g.y) > 1 ||
      Math.abs(h - innerH) > 1
    )
      continue;
    const { x: _x, y: _y, right: _r, bottom: _b, constraints: _c, ...rest } = c.layout ?? {};
    c.layout = { ...rest, x: 0, y: 0, width: "100%", height: "100%" };
    covering.add(c);
  }
  for (const c of absKids) {
    if (covering.has(c)) continue;
    const g = geo.get(c)!,
      L = g.x,
      R = inner - g.x - g.w;
    if (fluid(L, R)) pin(c, "left-right");
    else if (L > 1 && near(L, R)) pin(c, "center");
    else if (R >= -1 && R + 1 < L && R <= 0.25 * inner) pin(c, "right");
  }
  // a layer from the left edge up to (within a gutter of) right-pinned layers beside it fills the room between them
  // (fluid main column next to a fixed side column)
  const band = (c: SceneElement) => {
    const y = c.layout?.y ?? 0;
    return [y, y + (ctx.sizes.get(c)?.h ?? 0)] as const;
  };
  const pinnedRight = absKids.filter((c) => c.layout?.constraints?.horizontal === "right");
  for (const c of absKids) {
    const g = geo.get(c)!;
    if (c.layout?.constraints || g.x > gutter) continue;
    const [y0, y1] = band(c);
    if (
      pinnedRight.some((s) => {
        const [s0, s1] = band(s),
          sx = geo.get(s)!.x;
        return sx >= g.x + g.w - 1 && sx - (g.x + g.w) <= gutter && Math.min(y1, s1) - Math.max(y0, s0) > 0.5;
      })
    )
      pin(c, "left-right");
  }
  for (const c of frame.children) {
    const g = geo.get(c);
    if (!g || c.layout?.rotation) continue;
    const L = g.x,
      R = inner - g.x - g.w;
    const abs = c.layout?.position === "absolute";
    // flow first: a box the page caps with max-width (and centres with auto margins) that sits at its cap here
    // fills its parent up to the cap at any width, centred, as the page has it
    const capped = ctx.css.get(c)?.maxW;
    if (ctx.flow && !abs && capped && Math.abs(g.w - capped) <= 1 && (row || col) && near(L, R)) {
      const { alignSelf: _a, margin, ...rest } = c.layout ?? {};
      const m = pad4(margin);
      // a box that reaches past its parent on both sides (a full-bleed stage: negative margins): it keeps reaching
      // past it by as much, up to its cap
      const over = L < -1 ? snap(L - p[3]) : 0;
      c.layout = over
        ? {
            ...rest,
            width: "fill",
            maxWidth: r2(capped),
            margin: [m[0], over, m[2], over] as [number, number, number, number],
          }
        : {
            ...rest,
            width: "100%",
            maxWidth: r2(capped),
            ...(col ? { alignSelf: "center" as const } : {}),
            ...(m[0] || m[2] ? { margin: [m[0], 0, m[2], 0] as [number, number, number, number] } : {}),
          };
      if (row) frame.layout = { ...frame.layout, justify: "center" };
      fluidPass(ctx, c, geo, pageW);
      continue;
    }
    let stretch = filled.has(c) || (abs && c.layout?.constraints?.horizontal === "left-right");
    // (a single-line label hugs its text: nothing to reflow, the frame's alignment keeps it in place)
    if (
      !abs &&
      !stretch &&
      fluid(L, R) &&
      (col || (row && flow.length === 1)) &&
      !hMargin(c) &&
      !(c.type === "text" && c.layout?.width === undefined)
    ) {
      // fill the content box, the insets beyond the padding as margins
      // margins from where the flex layout put the fixed-width child (start / centre / end of the content box), so the
      // filled box lands on the same (sub)pixel
      const w = typeof c.layout?.width === "number" ? c.layout.width : g.w,
        content = inner - p[3] - p[1];
      const at = col
        ? c.layout?.alignSelf && c.layout.alignSelf !== "auto"
          ? c.layout.alignSelf
          : (l.align ?? "start")
        : (l.justify ?? "start");
      const ml = at === "center" ? (content - w) / 2 : at === "end" ? content - w : r2(L - p[3]),
        mr = content - ml - w;
      if (ml >= -0.5 && mr >= -0.5) {
        const { alignSelf: _a, margin, ...rest } = c.layout ?? {};
        const m = pad4(margin);
        const mm: [number, number, number, number] = [m[0], Math.max(0, mr), m[2], Math.max(0, ml)];
        // reflowing text in a centring row keeps its top (heights stay fixed: fewer lines must not drift off a bullet)
        const top = c.type === "text" && row && (l.align ?? "start") !== "start" && g.y - p[0] >= -0.5;
        if (top) mm[0] = r2(Math.max(0, g.y - p[0]));
        c.layout = {
          ...rest,
          width: "fill",
          ...(top ? { alignSelf: "start" as const } : {}),
          ...(mm.some((v) => Math.abs(v) > 0.01) ? { margin: mm } : {}),
        };
        stretch = true;
      }
    }
    if (stretch) fluidPass(ctx, c, geo, pageW);
  }
}

const hMargin = (c: SceneElement) => {
  const m = c.layout?.margin;
  return m !== undefined && pad4(m).some((v, i) => i % 2 === 1 && Math.abs(v) > 0.01);
};

/* ------------------------------------------------------------------ layer names */

const VAGUE =
  /^(div|span|a|p|i|ul|li|ol|section|article|aside|figure|frame|group|list|list item|inner|content|container|wrapper|grid|cmp|text|::before|::after)$/i;

/**
 * Groups whose name says nothing (div, Section, Container…) are named after their most prominent text — the largest
 * type inside, e.g. "Section · BVG-News", "Group · Kontakt" — so the Layers panel reads like the page.
 */
function nameGroups(el: SceneElement): string | null {
  let best: { size: number; text: string } | null = null;
  for (const c of el.children ?? []) {
    const t = c.type === "text" && c.text ? { size: c.style?.fontSize ?? 0, text: c.text } : null;
    const sub = c.type === "text" ? null : nameGroups(c);
    const cand = t ?? (sub ? { size: headingSize.get(c) ?? 0, text: sub } : null);
    if (cand && (!best || cand.size > best.size + 0.5)) best = cand;
  }
  if (
    (el.type === "frame" || el.type === "card") &&
    el.children?.length &&
    (!el.name || VAGUE.test(el.name.trim()) || /^(Container|Text)( layout flex)?$/i.test(el.name))
  ) {
    const base =
      el.name && /^(section|article|aside|list|list item|figure|text)$/i.test(el.name) ? el.name : "Group";
    if (best) el.name = `${base} · ${nameFromText(best.text.replace(/\u00ad/g, ""), 28)}`;
    else if (!el.name || /^(div|span|a|p|i)$/i.test(el.name)) el.name = base;
  }
  if (best) headingSize.set(el, best.size);
  return best?.text ?? null;
}
const headingSize = new WeakMap<SceneElement, number>();

/* ------------------------------------------------------------------ pinned headers */

/**
 * Boxes that stay put in the viewport while the page scrolls, as the prototype can play them back (`scrollBehavior:
 * 'fixed'`: the layer is moved by the scroll offset; static rendering is unchanged). The capture is taken at scroll 0,
 * so a box qualifies only where that equals what the site shows at any scroll position:
 *   position: fixed  — wholly inside the first viewport (one the capture left further down was never on screen there)
 *   position: sticky — at the very top of the page (stuck from the start; its `top` is not captured) inside a parent
 *                      that lasts to the last viewport (else it scrolls away with the parent)
 * and no taller than 40 % of the viewport: bars, headers, floating buttons — not fixed full-screen backgrounds, which the
 * player would lift above the content. Only the outermost such box counts.
 */
function pinnedBoxes(snap: Snapshot): Set<number> {
  const out = new Set<number>();
  const vh = snap.viewport?.height || 800;
  const walk = (n: SnapElement, parent: SnapElement | null) => {
    const p = n.layout?.position,
      r = n.rect;
    const bar = !n.hidden && r.w > 0 && r.h > 0 && r.h <= 0.4 * vh;
    if (bar && p === "fixed" && r.y >= -1 && r.y + r.h <= vh + 1) {
      out.add(n.id);
      return;
    }
    if (
      bar &&
      p === "sticky" &&
      Math.abs(r.y) <= 1 &&
      parent &&
      parent.rect.y + parent.rect.h >= snap.page.height - vh
    ) {
      out.add(n.id);
      return;
    }
    for (const c of n.children ?? []) if (c.kind !== "text") walk(c, n);
  };
  if (snap.root) walk(snap.root, null);
  return out;
}

/** A pinned layer inside a clipping frame (other than the page) would be cut off by it once moved: it scrolls instead. */
function unpinClipped(root: SceneElement) {
  const visit = (el: SceneElement, clipped: boolean) => {
    for (const c of el.children ?? []) {
      if (clipped && c.layout?.scrollBehavior) {
        const { scrollBehavior: _s, ...rest } = c.layout;
        c.layout = rest;
      }
      visit(c, clipped || !!c.layout?.clip);
    }
  };
  visit(root, false);
}

/* ------------------------------------------------------------------ entry */

export function snapshotToScreen(input: Snapshot, opts: UrlImportOptions = {}): UrlImportResult {
  if (!input || input.version !== 1 || !input.root)
    throw new UrlImportError("Not a page snapshot (version 1)");
  // flow first: boxes the capture moved to their stacking context only to paint them in order, while the page keeps
  // them in its flow (relative), go back to where the page lays them out
  const snap = opts.flow !== false ? unstack(input) : input;
  if (!snap.root) throw new UrlImportError("Not a page snapshot (version 1)");
  const ctx: Ctx = {
    snap,
    warn: new Warnings(),
    stats: { elements: 0, text: 0, images: 0, icons: 0, rasters: 0, autoLayout: 0, collapsed: 0 },
    next: 1,
    order: 0,
    prefix: opts.idPrefix ?? "u",
    fontUse: new Map(),
    colorUse: new Map(),
    buttonBg: new Map(),
    sizes: new WeakMap(),
    outOfFlow: new WeakSet(),
    keep: new Set(opts.keep ?? []),
    idOf: new Map(),
    pinned: pinnedBoxes(snap),
    sticky: new WeakSet(),
    controls: [],
    scrolled: scrolledBoxes(snap),
    css: new WeakMap(),
    flow: opts.flow !== false,
    marginOf: new WeakMap(),
    displayOf: new WeakMap(),
  };
  const W = Math.round(snap.page.width),
    H = Math.ceil(snap.page.height);
  const items = convertElement(ctx, {
    ...snap.root,
    tag: "body",
    layout: { ...(snap.root.layout ?? { display: "block", position: "static" }), position: "static" },
  });
  // the body frame is the page root
  let root: SceneElement;
  const body = items.length === 1 && items[0]!.el.meta?.tag === "body" ? items[0]!.el : null;
  if (body) root = body;
  else {
    root = { id: nid(ctx), type: "frame", name: "Page", layout: {}, style: {} };
    place(root, { x: 0, y: 0, w: W, h: H }, undefined, items);
  }
  root.name = "Page";
  root.layout = { width: W, height: H, clip: true };
  root.style = {
    ...root.style,
    background:
      root.style?.background && !isTransparent(root.style.background)
        ? root.style.background
        : snap.page.background,
  };
  ctx.sizes.set(root, { w: W, h: H });
  const geo = new WeakMap<SceneElement, Geo>();
  recordGeometry(ctx, root, geo);
  if (opts.autoLayout !== false) for (const c of root.children ?? []) autoLayoutPass(ctx, c);
  // flow first: the page's own blocks (header, main, footer) stack in its flow too, so the page is as tall as they are
  if (opts.autoLayout !== false && ctx.flow && root.children?.length) {
    root.layout = { ...root.layout, position: "absolute", x: 0, y: 0 };
    // a sticky bar lifted to the page by its z-index lies over the page's content: it is no block of the page's flow
    const span = (e: SceneElement) => {
      const y = typeof e.layout?.y === "number" ? e.layout.y : 0;
      return [y, y + (ctx.sizes.get(e)?.h ?? 0)] as const;
    };
    for (const k of root.children)
      if (
        ctx.sticky.has(k) &&
        root.children.some((o) => {
          if (o === k || ctx.outOfFlow.has(o)) return false;
          const [a0, a1] = span(k);
          const [b0, b1] = span(o);
          return a0 < b1 && b0 < a1;
        })
      )
        ctx.outOfFlow.add(k);
    tryAutoLayout(ctx, root);
    // the page keeps its measured height as a number (the measured widths' heights are read from it); the export
    // lets it follow its flowing content
    const { position: _p, x: _x, y: _y, ...rest } = root.layout!;
    root.layout = { ...rest, height: H };
  }
  if (opts.fluid !== false) fluidPass(ctx, root, geo, W);
  for (const c of root.children ?? []) nameGroups(c);
  unpinClipped(root);
  linkControls(ctx, root);

  let count = 0;
  const walk = (e: SceneElement) => {
    count++;
    e.children?.forEach(walk);
  };
  walk(root);
  ctx.stats.elements = count;

  const top = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
  const font = top(ctx.fontUse) ?? snap.page.font;
  const hints: Partial<SceneTokens> = {
    fontFamily: font,
    background: snap.page.background,
    theme: isDark(snap.page.background) ? "dark" : "light",
  };
  const text = top(ctx.colorUse);
  if (text) hints.text = text;
  // the brand colour: the most used chromatic button fill (white / grey nav buttons on a white page say nothing)
  const chroma = (c: string) => {
    const p = parseColor(c);
    return p && p.a > 0.5 ? (Math.max(...p.rgb) - Math.min(...p.rgb)) / 255 : 0;
  };
  const primary =
    top(new Map([...ctx.buttonBg].filter(([c]) => chroma(c) >= 0.2 && c !== snap.page.background))) ??
    top(ctx.buttonBg);
  if (primary) hints.primary = primary;
  const capture = brandCaptureOf(snap.brand, (m) => ctx.warn.add(m));
  const screen: SceneScreen = {
    version: 1,
    id: `url-${slug(snap.url)}`,
    name: opts.name ?? (snap.title || hostOf(snap.url)),
    platform: "web",
    width: W,
    height: H,
    tokens: hints,
    root,
    ...(snap.lang ? { lang: snap.lang } : {}),
    ...(capture ? { capture } : {}),
  };
  root.meta = {
    ...(root.meta ?? {}),
    source: snap.url,
    capturedAt: snap.capturedAt ?? "",
    ...(snap.viewport?.height ? { viewportHeight: snap.viewport.height } : {}),
  };
  const families = new Set([...ctx.fontUse.keys()].map((f) => f.toLowerCase()));
  const fonts: ProjectFont[] = [];
  for (const f of snap.embeddedFonts ?? []) {
    if (!families.has(f.family.toLowerCase())) continue;
    const bytes = dataUrlBytes(f.src);
    const pf = bytes
      ? projectFontFromBytes(bytes, {
          family: f.family,
          weight: f.weight,
          style: f.style,
          unicodeRange: f.unicodeRange,
          stretch: f.stretch,
          fileName: f.file,
          sourceUrl: f.sourceUrl,
          origin: "import",
        })
      : null;
    if (pf) fonts.push(pf);
    else ctx.warn.add(`font ${f.family} ${f.weight} could not be read`);
  }
  if (snap.truncated) ctx.warn.add("page too large: capture truncated");
  return {
    screen,
    fonts,
    warnings: ctx.warn.list(),
    designSystemHints: hints,
    stats: ctx.stats,
    idOf: ctx.idOf,
  };
}

/* ------------------------------------------------------------------ brand extras (Snapshot.brand → SceneScreen.capture) */

/** list caps of a stored capture (domCapture.js keeps to them; a snapshot from elsewhere is cut to them here) */
const BRAND_CAPS = {
  images: 300,
  icons: 200,
  iconSvg: 20_000,
  logoSvg: 100_000,
  controls: 150,
  texts: 3000,
  grids: 100,
  sections: 80,
  fontFiles: 200,
  media: 200,
  props: 1500,
  linkIcons: 20,
};

/**
 * The brand-guide extras of a capture (BrandCapture, brandmd/types.ts; read by domCapture.js with `opts.brand`) as the
 * screen stores them: shape checked, lists capped, oversized SVG markup dropped. Undefined when the snapshot has none
 * (older captures, menu / widget states) or reading them failed (`{ error }` → `warn`).
 */
export function brandCaptureOf(raw: unknown, warn?: (message: string) => void): BrandCapture | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Partial<BrandCapture> & { error?: unknown };
  if (typeof b.error === "string") {
    warn?.(`brand extras not captured: ${b.error}`);
    return undefined;
  }
  if (typeof b.url !== "string" || typeof b.finalUrl !== "string" || typeof b.width !== "number")
    return undefined;
  const list = <T>(v: unknown, n: number): T[] => (Array.isArray(v) ? (v.slice(0, n) as T[]) : []);
  const logo = (m: BrandCapture["marks"]["logo"]) => {
    if (!m || typeof m !== "object") return undefined;
    if (typeof m.svg !== "string" || m.svg.length <= BRAND_CAPS.logoSvg) return m;
    const { svg: _drop, ...rest } = m;
    return rest;
  };
  const {
    logo: l0,
    logoAlt: a0,
    icons: linkIcons,
    ...marks
  }: Partial<BrandCapture["marks"]> = b.marks && typeof b.marks === "object" ? b.marks : {};
  const props = Object.entries(
    b.customProperties && typeof b.customProperties === "object" ? b.customProperties : {},
  )
    .filter(([k, v]) => k.startsWith("--") && typeof v === "string")
    .slice(0, BRAND_CAPS.props);
  const markLogo = logo(l0),
    markAlt = logo(a0);
  return {
    url: b.url,
    finalUrl: b.finalUrl,
    width: b.width,
    customProperties: Object.fromEntries(props),
    mediaQueries: list(b.mediaQueries, BRAND_CAPS.media),
    marks: {
      ...marks,
      ...(markLogo ? { logo: markLogo } : {}),
      ...(markAlt ? { logoAlt: markAlt } : {}),
      icons: list(linkIcons, BRAND_CAPS.linkIcons),
    },
    images: list(b.images, BRAND_CAPS.images),
    icons: list<BrandCapture["icons"][number]>(b.icons, BRAND_CAPS.icons).filter(
      (i) => typeof i?.svg === "string" && i.svg.length <= BRAND_CAPS.iconSvg,
    ),
    sections: list(b.sections, BRAND_CAPS.sections),
    grids: list(b.grids, BRAND_CAPS.grids),
    controls: list(b.controls, BRAND_CAPS.controls),
    fontFiles: list(b.fontFiles, BRAND_CAPS.fontFiles),
    overlay: b.overlay && typeof b.overlay === "object" ? b.overlay : null,
    texts: list<unknown>(b.texts, BRAND_CAPS.texts).filter((t): t is string => typeof t === "string"),
  };
}

/* ------------------------------------------------------------------ menu overlay (Snapshot.states) */

export interface MenuOverlayResult extends UrlImportResult {
  /** DSL id (in `screen`) of the control that closes the menu again (the X), when it is part of the overlay */
  closeId?: string;
  /** a next level (state kind 'submenu'): DSL id of its back control */
  backId?: string;
  /** top-left corner of the overlay in the page's viewport (CSS px) */
  offset: { x: number; y: number };
  /** colour the site dims the page with behind the open menu, or 'none' */
  dim: string;
  /** blur (px) of the page behind the open menu (the dim layer's backdrop-filter) */
  blur?: number;
}

/** alpha of a computed colour (`rgba(…, a)` / `rgb(… / a)`; 1 when opaque or unparsed) */
const alphaOf = (c: string) => {
  const m = /,\s*([\d.]+)\s*\)$|\/\s*([\d.]+%?)\s*\)$/.exec(c);
  if (!m) return 1;
  const v = m[1] ?? m[2]!;
  return v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
};
const within = (a: SnapRect, b: SnapRect) =>
  a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
const viewportShare = (r: SnapRect, w: number, h: number) =>
  (Math.max(0, Math.min(r.x + r.w, w) - Math.max(r.x, 0)) *
    Math.max(0, Math.min(r.y + r.h, h) - Math.max(r.y, 0))) /
  (w * h);

/** A subtree without the box `id` (and its subtree). */
function withoutNode(n: SnapNode, id: number): SnapNode {
  if (n.kind === "text" || !n.children?.length) return n;
  return {
    ...n,
    children: n.children.filter((c) => c.kind === "text" || c.id !== id).map((c) => withoutNode(c, id)),
  };
}

/** A subtree moved by (dx, dy) (page coordinates of the cut-out). */
function shiftNode(n: SnapNode, dx: number, dy: number): SnapNode {
  const r = n.rect ? { ...n.rect, x: n.rect.x + dx, y: n.rect.y + dy } : undefined;
  if (n.kind === "text")
    return {
      ...n,
      ...(r ? { rect: r } : {}),
      lines: n.lines.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy })),
    };
  return { ...n, rect: r!, ...(n.children ? { children: n.children.map((c) => shiftNode(c, dx, dy)) } : {}) };
}

/**
 * The open menu of a captured page (`state`, one of `Snapshot.states`) as an overlay screen. With the panel known:
 * the panel (drawer, full-screen menu, dropdown) alone, cut out of the open-state page at its captured box: the page
 * variant stays visible around it in the prototype and only the panel comes in, like on the site. A translucent
 * full-viewport layer behind it (or the panel's own translucent fill when it is that layer) becomes `dim`. Without a
 * panel: the open-state page cropped to its first viewport. The state's snapshot carries no assets / webfonts: the
 * parent's are used. `closeId`: the close control, kept as its own element for a close-overlay tap.
 */
export function menuOverlayOf(
  parent: Snapshot,
  state: SnapState,
  opts: UrlImportOptions = {},
): MenuOverlayResult {
  const s = state.snapshot;
  if (!s?.root || s.version !== 1) throw new UrlImportError("The menu state has no page snapshot");
  const W = Math.round(s.page.width),
    vh = s.viewport?.height || parent.viewport.height || 800;
  const nodes = new Map<number, SnapElement>(),
    up = new Map<number, SnapElement>();
  const index = (n: SnapElement) => {
    nodes.set(n.id, n);
    for (const c of n.children ?? [])
      if (c.kind !== "text") {
        up.set(c.id, n);
        index(c);
      }
  };
  index(s.root);
  const ancestors = (n: SnapElement) => {
    const out: SnapElement[] = [];
    for (let p = up.get(n.id); p; p = up.get(p.id)) out.push(p);
    return out;
  };
  const opaque = (c: string | undefined) => !!c && !isTransparent(c) && alphaOf(c) >= 0.95;
  let panel = state.panel !== undefined ? nodes.get(state.panel) : undefined;
  // a panel that is one link of the menu (an aria-controls id clash between shadow roots: ibm.com's mega menu named
  // its last entry): the menu box around it, the nearest ancestor that paints or floats, up to a viewport in size
  const area = (n: SnapElement) => Math.max(0, n.rect.w) * Math.max(0, n.rect.h);
  if (
    panel &&
    area(panel) < 0.04 * W * vh &&
    (panel.tag === "a" ||
      panel.tag === "button" ||
      panel.attrs?.role === "button" ||
      panel.attrs?.role === "link")
  ) {
    for (const a of ancestors(panel)) {
      if (a === s.root || a.tag === "body" || area(a) > W * vh * 1.05) break;
      if (
        area(a) >= 0.04 * W * vh &&
        (opaque(a.style?.bg) || a.layout?.position === "fixed" || a.layout?.position === "absolute")
      ) {
        panel = a;
        break;
      }
    }
  }
  const close = state.close !== undefined ? nodes.get(state.close) : undefined;
  const base: Snapshot = { ...s, assets: parent.assets, embeddedFonts: parent.embeddedFonts };
  // `opts.keep`: the menu's entries that open a next level stay elements of their own (they get the swap)
  const keep = [
    ...(opts.keep ?? []),
    ...(close ? [close.id] : []),
    ...(state.back !== undefined ? [state.back] : []),
  ];
  const ids = (res: UrlImportResult) => ({
    closeId: close ? res.idOf.get(close.id) : undefined,
    backId: state.back !== undefined ? res.idOf.get(state.back) : undefined,
  });
  const translucent = (n: SnapElement) =>
    !!n.style?.bg &&
    !isTransparent(n.style.bg) &&
    alphaOf(n.style.bg) < 0.95 &&
    viewportShare(n.rect, W, vh) >= 0.8;

  if (!panel || panel.rect.w <= 0 || panel.rect.h <= 0) {
    // the open page as the visitor sees it: one viewport (layers below it are dropped as off-page)
    const h = Math.min(Math.ceil(s.page.height), vh);
    const res = snapshotToScreen(
      { ...base, page: { ...s.page, height: h }, root: { ...s.root, rect: { ...s.root.rect, h } } },
      { ...opts, keep },
    );
    return { ...res, ...ids(res), offset: { x: 0, y: 0 }, dim: "none" };
  }
  const inPanel = (n: SnapElement) => n === panel || ancestors(n).includes(panel);
  // the site's header turns into the open menu's own (× in place of the hamburger, the logo gone): with the close
  // control outside the panel, the nearest box holding both (a wide one: the header) is cut out, over both boxes
  const shared =
    close && !inPanel(close)
      ? ancestors(panel).find((a) => a !== s.root && a.tag !== "body" && ancestors(close).includes(a))
      : undefined;
  const host = shared && shared.rect.w >= 0.5 * W ? shared : undefined;
  const box = host ? union(panel.rect, host.rect) : panel.rect;
  const x0 = Math.max(0, box.x),
    y0 = Math.max(0, box.y);
  const w = r2(Math.min(W, box.x + box.w) - x0),
    h = r2(box.y + box.h - y0);
  const cut = host ?? panel;
  const inCut = (n: SnapElement) => n === cut || ancestors(n).includes(cut);
  const behind = ancestors(cut);
  let dim = "none",
    blur: number | undefined;
  // the dim layer's backdrop blur (vw.com blurs the page behind its menu by 10px)
  const dimOf = (n: SnapElement) => {
    dim = n.style!.bg!;
    const b = /blur\(\s*([\d.]+)px\s*\)/.exec(n.style?.backdrop ?? "");
    if (b && +b[1]! > 0) blur = +b[1]!;
  };
  let top: SnapElement = cut;
  // the backdrop a header-hosted menu brings along (a fixed layer inside the cut-out header reaching past the box,
  // ibm.com): the overlay's dim, not a layer cropped to the box
  const spills = (n: SnapElement) =>
    n.rect.y + n.rect.h > box.y + box.h + 1 ||
    n.rect.x < box.x - 1 ||
    n.rect.x + n.rect.w > box.x + box.w + 1;
  if (!host && translucent(panel)) {
    dimOf(panel);
    top = { ...panel, style: { ...panel.style, bg: undefined } };
  } else
    for (const n of nodes.values()) {
      const p = n.layout?.position;
      if (
        (p === "fixed" || p === "absolute") &&
        !behind.includes(n) &&
        translucent(n) &&
        n !== panel &&
        !ancestors(panel).includes(n)
      ) {
        if (!inCut(n)) {
          dimOf(n);
          break;
        }
        if (spills(n) && !n.children?.some((c) => c.kind !== "text")) {
          dimOf(n);
          top = withoutNode(top, n.id) as SnapElement;
          break;
        }
      }
    }
  // a panel that paints nothing itself is filled by the wrapper of its size around it
  let fill =
    top.style?.bg && !isTransparent(top.style.bg)
      ? undefined
      : behind.find(
          (a) => within(a.rect, box) && a.style?.bg && !isTransparent(a.style.bg) && !translucent(a),
        )?.style?.bg;
  // a sheet down to the bottom of the viewport stays one down to the bottom of a taller window
  if (!fill && y0 + h >= vh - 2 && opaque(panel.style?.bg)) fill = panel.style!.bg;
  // the close control when the capture painted it outside the panel's subtree but on top of it
  const extra = close && !inCut(close) && within(close.rect, box) ? [close] : [];
  const root: SnapElement = {
    id: s.root.id,
    tag: "body",
    rect: { x: 0, y: 0, w, h },
    layout: { display: "block", position: "static" },
    style: fill ? { bg: fill } : {},
    children: [top, ...extra].map((n) =>
      shiftNode(
        {
          ...n,
          layout: { display: "block", ...n.layout, position: n === top ? "static" : "absolute" },
        } as SnapElement,
        -x0,
        -y0,
      ),
    ),
  };
  const res = snapshotToScreen(
    {
      ...base,
      viewport: { width: w, height: vh },
      page: { ...s.page, width: w, height: h, background: "transparent" },
      root,
    },
    { ...opts, keep },
  );
  return { ...res, ...ids(res), offset: { x: r2(x0), y: r2(y0) }, dim, ...(blur ? { blur } : {}) };
}

const union = (a: SnapRect, b: SnapRect): SnapRect => {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/* ------------------------------------------------------------------ widget states (Snapshot.states, kind 'region') */

type RegionState = SnapState & { region: number; index: number };
const regionStatesOf = (snap: Snapshot): RegionState[] =>
  (snap.states ?? []).filter(
    (s): s is RegionState =>
      s.kind === "region" && s.region !== undefined && s.index !== undefined && !!s.snapshot?.root,
  );

/** Snapshot ids a page conversion keeps as elements of their own for its widget states: the regions and the controls. */
export function regionKeepIds(snap: Snapshot): number[] {
  const states = regionStatesOf(snap);
  if (!states.length) return [];
  return [
    ...states.map((s) => s.region),
    ...(snap.controls ?? []).flatMap((c) => (c.id !== undefined ? [c.id] : [])),
  ];
}

/** layout keys that place a box in its parent (the state frame takes them); the rest lay out its own children */
const PLACEMENT = [
  "position",
  "x",
  "y",
  "right",
  "bottom",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "margin",
  "alignSelf",
  "grow",
  "constraints",
  "z",
  "colSpan",
  "rowSpan",
  "scrollBehavior",
  "rotation",
  "flipX",
  "flipY",
  "scale",
] as const;

/** One widget state's region walk converted on its own, at the region's top-left (the controls in it kept). */
function regionVariant(parent: Snapshot, st: RegionState, prefix: string, flow?: boolean): UrlImportResult {
  const s = st.snapshot,
    r = s.root!;
  const w = r2(r.rect.w),
    h = r2(r.rect.h);
  const keep = (s.controls ?? []).flatMap((c) => (c.id !== undefined ? [c.id] : []));
  const root: SnapElement = {
    id: -1,
    tag: "body",
    rect: { x: 0, y: 0, w, h },
    layout: { display: "block", position: "static" },
    style: {},
    children: [
      shiftNode(
        { ...r, layout: { display: "block", ...r.layout, position: "static" } } as SnapElement,
        -r.rect.x,
        -r.rect.y,
      ),
    ],
  };
  return snapshotToScreen(
    {
      ...s,
      assets: parent.assets,
      embeddedFonts: parent.embeddedFonts,
      viewport: parent.viewport,
      page: { ...s.page, width: w, height: h, background: "transparent" },
      root,
    },
    { idPrefix: prefix, keep, ...(flow === false ? { flow: false } : {}) },
  );
}

/**
 * The capture re-parents a z-indexed box to its stacking context so the tree paints like the page (`SnapElement.from`).
 * The box then sits outside the box it is laid out in: in its flow (relative / static) its parent's boxes no longer
 * add up, and placed (absolute) it is placed at a fixed offset in the stacking context whatever the width, not in the
 * box it follows on the page. Flow first, such boxes go back to their DOM parent when they stay inside its box, before
 * the first sibling below / after them (the converter keeps their z-index and paints them in order there,
 * resolveLayers); fixed and sticky boxes and boxes reaching past their parent stay where the capture put them.
 * → a copy of `snap` when any moved.
 */
export function unstack(snap: Snapshot): Snapshot {
  const moved: { node: SnapElement; parent: SnapElement }[] = [];
  const byId = new Map<number, SnapElement>();
  let any = false;
  const scan = (n: SnapElement) => {
    byId.set(n.id, n);
    for (const c of n.children ?? []) {
      if (c.kind === "text") continue;
      if (c.from !== undefined && !OUT_OF_FLOW.has(c.layout?.position ?? "static")) any = true;
      scan(c);
    }
  };
  scan(snap.root!);
  if (!any) return snap;
  const root = structuredClone(snap.root!);
  byId.clear();
  const collect = (n: SnapElement) => {
    byId.set(n.id, n);
    for (const c of n.children ?? []) {
      if (c.kind === "text") continue;
      if (c.from !== undefined && !OUT_OF_FLOW.has(c.layout?.position ?? "static"))
        moved.push({ node: c, parent: n });
      collect(c);
    }
  };
  collect(root);
  const top = (c: SnapNode) => (c.kind === "text" ? c.lines[0]?.y : c.rect?.y);
  const left = (c: SnapNode) => (c.kind === "text" ? c.lines[0]?.x : c.rect?.x);
  for (const { node, parent } of moved) {
    const to = byId.get(node.from!);
    if (!to || to === node || !parent.children) continue;
    // (an ancestor of its old parent: the box would end up inside itself otherwise)
    if (contains(node, to)) continue;
    // only a box inside its DOM parent's box: one reaching past it (pulled up over the band before it by a negative
    // margin) is painted over boxes outside its parent, which only the stacking context can keep it above
    const r = node.rect,
      p = to.rect;
    if (!p || r.x < p.x - 1 || r.y < p.y - 1 || r.x + r.w > p.x + p.w + 1 || r.y + r.h > p.y + p.h + 1)
      continue;
    parent.children = parent.children.filter((c) => c !== node);
    const kids = (to.children ??= []);
    const y = node.rect.y,
      x = node.rect.x;
    const at = kids.findIndex((c) => {
      const cy = top(c),
        cx = left(c);
      return cy !== undefined && (cy > y + 0.5 || (Math.abs(cy - y) <= 0.5 && (cx ?? 0) > x + 0.5));
    });
    kids.splice(at < 0 ? kids.length : at, 0, node);
    delete node.from;
  }
  return { ...snap, root };
}
// (fixed and sticky boxes stay where the capture put them: the export pins them to the page, their DOM parent may be
// short; an absolute one goes back to be placed in the box it is placed in on the page)
const OUT_OF_FLOW = new Set(["fixed", "sticky"]);
function contains(n: SnapElement, target: SnapElement): boolean {
  if (n === target) return true;
  return (n.children ?? []).some((c) => c.kind !== "text" && contains(c, target));
}

/** The box of the node an alt walk names as main-walk node `base` (null when the walk has none). */
function baseRect(root: SnapNode, base: number): SnapRect | null {
  const n = root as SnapElement & { base?: number };
  if (n.base === base && n.rect) return n.rect;
  for (const c of n.children ?? []) {
    const r = baseRect(c, base);
    if (r) return r;
  }
  return null;
}

/** The captured box of snapshot node `id` (null when the walk has none). */
function snapRect(root: SnapNode | undefined, id: number): SnapRect | null {
  if (!root || typeof root !== "object") return null;
  if ((root as SnapElement).id === id && (root as SnapElement).rect) return (root as SnapElement).rect;
  for (const c of (root as SnapElement).children ?? []) {
    const r = snapRect(c, id);
    if (r) return r;
  }
  return null;
}

/**
 * The page's widgets in their other states (filtered lists, expanded cards, open accordions): each changed region
 * becomes a state frame (`states`) whose first child is the region as captured and one child per state, converted from
 * that state's region walk at the same place. The controls switch it as on the site: in the page each control shows its
 * state; inside a state the toggle that opened it goes back, another control shows its own state, and a choice without
 * a state of its own (the group's selected one) goes back. Expanding controls inside a chosen (filtered) state stay put:
 * only their unfiltered states were captured. Mutates `res.screen` (built with `keep: regionKeepIds(snap)`).
 */
export function applyRegionStates(
  snap: Snapshot,
  res: UrlImportResult,
  /** convert the states as the page was (UrlImportOptions.flow) */
  flow?: boolean,
): { warnings: string[]; fonts: ProjectFont[] } {
  const states = regionStatesOf(snap);
  const out = { warnings: [] as string[], fonts: [] as ProjectFont[] };
  if (!states.length) return out;
  const controls = snap.controls ?? [];
  const groups = new Map<number, RegionState[]>();
  for (const s of states) {
    if (!groups.has(s.region)) groups.set(s.region, []);
    groups.get(s.region)!.push(s);
  }
  let g = 0;
  for (const [region, list] of groups) {
    const prefix = `${res.screen.root.id}-w${g++}`;
    const base = findElement(res.screen.root, res.idOf.get(region) ?? "");
    const parent = base ? findParent(res.screen.root, base.id) : null;
    if (!base || !parent?.children) {
      out.warnings.push(`widget "${list[0]!.label ?? ""}": its region was not kept, its states are left out`);
      continue;
    }
    // a "region" that is most of the page (a hero's pause toggle changed an attribute on <main>) is no widget: its
    // states would be whole copies of the page, hidden behind it
    const pageH = Number(snap.page?.height) || 0;
    const viewH = Number(snap.viewport?.height) || 1000;
    // (its captured box: in flow its layout height may be its content's, "hug")
    const regionH =
      typeof base.layout?.height === "number"
        ? base.layout.height
        : (snapRect(snap.root ?? undefined, region)?.h ?? 0);
    if (pageH && regionH > viewH * 2 && regionH >= pageH * 0.6) {
      out.warnings.push(
        `widget "${list[0]!.label ?? ""}": its region is most of the page (${Math.round(regionH)} of ${Math.round(pageH)} px), its states are left out`,
      );
      continue;
    }
    const place: SceneLayout = {},
      own: SceneLayout = {};
    // (the region's geometry measured at other widths goes with its place: the state frame follows the page there)
    for (const [k, v] of Object.entries(base.layout ?? {}))
      ((PLACEMENT as readonly string[]).includes(k) || k === "fluid" ? place : own)[k as keyof SceneLayout] =
        v as never;
    const width: SceneLayout["width"] = typeof place.width === "number" ? place.width : "100%";
    // flow first: the states sit in the frame's flow, one shown at a time (the others `display: none`; the runtime
    // swaps them): the frame is as tall as the state shown, as the region on the page is. Fitted: they are layers over
    // each other at the frame's top-left, the frame as tall as the region was captured.
    const inFlow = flow !== false;
    const stateLayout = (l: SceneLayout, height: SceneLayout["height"]): SceneLayout => {
      if (!inFlow) return { ...l, ...at(height) };
      const { position: _p, x: _x, y: _y, right: _r, bottom: _b, constraints: _c, ...rest } = l;
      return { ...rest, width: "fill", ...(typeof height === "number" ? { height } : {}) };
    };
    if (inFlow && typeof place.height !== "number") {
      // (a region as tall as its content: the frame too)
    } else if (typeof place.height !== "number" && regionH > 0) {
      place.height = r2(regionH);
      // …and its height at the widths the page was walked at (the region's box there), so it follows the page
      const fluid = [...(place.fluid ?? [])];
      for (const a of snap.alt ?? []) {
        const at = Math.round(Number(a.page?.width ?? a.viewport?.width ?? 0));
        const r = a.root ? baseRect(a.root, region) : null;
        if (!at || !r || Math.abs(r.h - regionH) <= 0.5) continue;
        const i = fluid.findIndex((f) => f.at === at);
        if (i >= 0) fluid[i] = { ...fluid[i]!, height: r2(r.h) };
        else fluid.push({ at, height: r2(r.h) });
      }
      if (fluid.length) place.fluid = fluid.sort((x, y) => x.at - y.at);
    }
    const at = (height: SceneLayout["height"]): SceneLayout => ({
      position: "absolute",
      x: 0,
      y: 0,
      width,
      height,
    });
    // the region as captured fills the state frame (it is that region); the other states keep their own height
    const first: SceneElement = {
      ...base,
      layout: inFlow ? stateLayout(own, undefined) : { ...own, ...at(place.height) },
    };
    const variants = list.map((st, i) => {
      const v = regionVariant(snap, st, `${prefix}s${i}-`, flow);
      out.fonts.push(...v.fonts);
      const { clip: _c, ...rest } = v.screen.root.layout ?? {};
      v.screen.root = {
        ...v.screen.root,
        name: `State · ${st.label || i + 1}`,
        layout: stateLayout(rest, v.screen.height),
      };
      return { st, v };
    });
    const sw: SceneElement = {
      id: `${prefix}`,
      type: "frame",
      name: `States · ${base.name ?? "Widget"}`,
      layout: place,
      states: { active: first.id },
      children: [first, ...variants.map(({ v }) => v.screen.root)],
    };
    parent.children = parent.children.map((c) => (c === base ? sw : c));
    const stateOf = new Map(list.map((st, i) => [st.index, variants[i]!.v.screen.root.id]));
    // a rotator (every choice in the region has a state of its own: none is "the selected one"): the region as captured
    // is wherever autoplay had got to; the page opens on its first slide (vw.com's hero showed slide 3 of 4)
    const choices = controls.flatMap((c, k) =>
      c.kind === "select" &&
      c.option === undefined &&
      c.id !== undefined &&
      findElement(first, res.idOf.get(c.id) ?? "")
        ? [k]
        : [],
    );
    if (choices.length >= 2 && choices.every((k) => stateOf.has(k)))
      sw.states = { active: stateOf.get(Math.min(...choices))! };
    const setState = (el: SceneElement | null, state: string) => {
      if (el) el.interaction = { onTap: "set-state", target: sw.id, state };
    };
    const choice = (k: number) => controls[k]?.option !== undefined;
    // a drop-down's options (controls sharing its element): one choice list, each option showing its state (the
    // selected one, without a state of its own, the region as captured)
    const dropdowns = new Map<number, number[]>();
    controls.forEach((c, k) => {
      if (c.option !== undefined && c.id !== undefined) {
        if (!dropdowns.has(c.id)) dropdowns.set(c.id, []);
        dropdowns.get(c.id)!.push(k);
      }
    });
    const wireChoices = (el: SceneElement | null, ks: number[], current: string) => {
      if (!el || !ks.some((k) => stateOf.has(k))) return;
      el.interaction = {
        onTap: "set-state",
        target: sw.id,
        state: current,
        options: ks.map((k) => ({
          label: controls[k]!.label ?? String(k),
          state: stateOf.get(k) ?? first.id,
        })),
      };
    };
    // in the page: each control shows its state
    for (const st of list) {
      const id = controls[st.index]?.id;
      if (!choice(st.index))
        setState(
          id !== undefined ? findElement(first, res.idOf.get(id) ?? "") : null,
          stateOf.get(st.index)!,
        );
    }
    for (const [id, ks] of dropdowns) wireChoices(findElement(first, res.idOf.get(id) ?? ""), ks, first.id);
    // inside a state: back, another state, or nothing
    for (const { st, v } of variants) {
      const own = v.screen.root.id;
      (st.snapshot.controls ?? []).forEach((c, k) => {
        const el = c.id !== undefined ? findElement(v.screen.root, v.idOf.get(c.id) ?? "") : null;
        if (!el || choice(k)) return;
        const target = stateOf.get(k);
        if (k === st.index) {
          if (st.toggle) setState(el, first.id);
        } else if (target) {
          if (st.toggle || controls[k]?.kind !== "toggle") setState(el, target);
        } else if (controls[k]?.kind === "select") setState(el, first.id);
      });
      for (const ks of dropdowns.values()) {
        const id = st.snapshot.controls?.[ks[0]!]?.id;
        wireChoices(
          id !== undefined ? findElement(v.screen.root, v.idOf.get(id) ?? "") : null,
          ks,
          ks.includes(st.index) ? own : first.id,
        );
      }
    }
  }
  return out;
}

const CSS_EASE: Record<string, SceneEasing> = {
  linear: "linear",
  ease: { bezier: [0.25, 0.1, 0.25, 1] },
  "ease-in": "ease-in",
  "ease-out": "ease-out",
  "ease-in-out": "ease-in-out",
};

/** CSS timing function (computed; the first of a list) → SceneEasing: keywords as the same curve, cubic-bezier() as is, steps() → linear. */
export function easingOf(css: string | undefined): SceneEasing | undefined {
  const v = splitTop(css ?? "")[0]
    ?.trim()
    .toLowerCase();
  if (!v) return undefined;
  if (CSS_EASE[v]) return CSS_EASE[v];
  const b = /^cubic-bezier\(\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*\)$/.exec(v);
  if (b) return { bezier: [+b[1]!, +b[2]!, +b[3]!, +b[4]!] };
  return /^(steps|step-)/.test(v) ? "linear" : undefined;
}

/** The trigger's tap: open the menu overlay `target` where and the way the site's menu comes in (edge / fade, duration, curve). */
export function menuInteraction(
  target: string,
  m: Pick<MenuOverlayResult, "offset" | "dim" | "blur">,
  motion?: SnapMotion,
): SceneInteraction {
  const manual = m.offset.x > 0.5 || m.offset.y > 0.5;
  const overlay: SceneOverlaySettings = {
    position: manual ? "manual" : "top-left",
    ...(manual ? { offset: m.offset } : {}),
    background: m.dim,
    ...(m.blur && m.dim !== "none" ? { blur: m.blur } : {}),
    closeOnOutsideClick: true,
    ...(motion ? { enter: motion.enter } : {}),
  };
  const easing = easingOf(motion?.easing);
  return {
    onTap: "open-overlay",
    target,
    overlay,
    ...(motion ? { duration: motion.enter === "none" ? 0 : Math.max(0, Math.round(motion.duration)) } : {}),
    ...(easing ? { easing } : {}),
  };
}

/**
 * Name of the page a snapshot shows, shared by its breakpoint variants (`<Page> · <width>`), as `pnpm import:url`
 * names it: a site's home page → 'Startseite' (German page / .de host) or 'Home', else the title's first part.
 */
export function pageNameOfSnapshot(snap: Pick<Snapshot, "url" | "title" | "lang">): string {
  let u: URL;
  try {
    u = new URL(snap.url);
  } catch {
    return (snap.title ?? "").trim() || "Page";
  }
  const segs = u.pathname
    .split("/")
    .filter(Boolean)
    .filter((x) => !/^index\.\w+$/.test(x));
  if (segs.length === 0 || (segs.length === 1 && /^[a-z]{2}([-_][a-z]{2})?$/i.test(segs[0]!)))
    return /^de\b/i.test(snap.lang ?? "") || /^de\b/i.test(segs[0] ?? "") || u.hostname.endsWith(".de")
      ? "Startseite"
      : "Home";
  return (
    (snap.title ?? "")
      .split(/\s+[|–—·-]\s+/)
      .map((x) => x.trim())
      .find(Boolean) || u.hostname.replace(/^www\./, "")
  );
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "Imported page";
  }
};
const slug = (u: string) =>
  hostOf(u)
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();

export type { Snapshot, ImportedFont } from "@harness/capture";
