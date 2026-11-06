// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// CSS declarations → Tailwind utility classes, losslessly. Exact equivalents map to idiomatic utilities (`flex`,
// `gap-[12px]`, `bg-primary`); everything else becomes an arbitrary property (`[mask-image:url(/assets/m.svg)]`).
// Values Tailwind cannot carry (quotes, brackets, `&`, data URLs…) and declarations that would fight an earlier
// overlapping one (`border` then `border-top`: utility order is Tailwind's, not ours) go to `inline` (a style prop),
// which keeps the IR's cascade order exactly. Used with preflight off: the page reset is the HTML export's.
import type { StyleMap } from "./ir.js";
import { resolveVars, type VarMap } from "./tokens.js";

export interface TwOptions {
  /** colour tokens known to tailwind.config (`primary`, `text-muted`…) */
  colorNames: Set<string>;
  /** keep var() in arbitrary values; false → literals */
  cssVars: boolean;
  vars: VarMap;
}

export interface TwSplit {
  classes: string[];
  /** declarations for a `style` prop (unsafe for a class name, or overriding an earlier overlapping declaration) */
  inline: StyleMap;
}

/** Arbitrary-value escaping: literal underscores → `\_`, whitespace → `_`, `"` → `'`. */
export const arb = (v: string) => v.trim().replace(/"/g, "'").replace(/_/g, "\\_").replace(/\s+/g, "_");

/** Can `v` live inside `[…]` of a class name in a JSX string attribute (and Tailwind's scanner)? */
export function twSafe(v: string): boolean {
  if (v.length > 600 || /[[\]`\\&{}<>;\n\r]|data:/i.test(v)) return false;
  if (v.includes('"') && v.includes("'")) return false;
  let depth = 0;
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0 && v.replace(/[^']/g, "").length % 2 === 0 && v.replace(/[^"]/g, "").length % 2 === 0;
}
const PROP_RE = /^(--[\w-]+|-?[a-z][a-z0-9-]*)$/;

// exact keyword equivalents only (`items-start` is flex-start, so `align-items: start` stays arbitrary)
const KEYWORDS: Record<string, Record<string, string>> = {
  display: {
    flex: "flex",
    "inline-flex": "inline-flex",
    block: "block",
    "inline-block": "inline-block",
    inline: "inline",
    grid: "grid",
    "inline-grid": "inline-grid",
    none: "hidden",
    contents: "contents",
  },
  "flex-direction": {
    row: "flex-row",
    column: "flex-col",
    "row-reverse": "flex-row-reverse",
    "column-reverse": "flex-col-reverse",
  },
  "flex-wrap": { wrap: "flex-wrap", nowrap: "flex-nowrap", "wrap-reverse": "flex-wrap-reverse" },
  "align-items": {
    "flex-start": "items-start",
    center: "items-center",
    "flex-end": "items-end",
    stretch: "items-stretch",
    baseline: "items-baseline",
  },
  "align-self": {
    "flex-start": "self-start",
    center: "self-center",
    "flex-end": "self-end",
    stretch: "self-stretch",
    baseline: "self-baseline",
    auto: "self-auto",
  },
  "justify-content": {
    "flex-start": "justify-start",
    center: "justify-center",
    "flex-end": "justify-end",
    "space-between": "justify-between",
    "space-around": "justify-around",
    "space-evenly": "justify-evenly",
  },
  position: {
    relative: "relative",
    absolute: "absolute",
    fixed: "fixed",
    sticky: "sticky",
    static: "static",
  },
  overflow: {
    hidden: "overflow-hidden",
    auto: "overflow-auto",
    scroll: "overflow-scroll",
    visible: "overflow-visible",
    clip: "overflow-clip",
  },
  "overflow-x": {
    hidden: "overflow-x-hidden",
    auto: "overflow-x-auto",
    scroll: "overflow-x-scroll",
    visible: "overflow-x-visible",
    clip: "overflow-x-clip",
  },
  "overflow-y": {
    hidden: "overflow-y-hidden",
    auto: "overflow-y-auto",
    scroll: "overflow-y-scroll",
    visible: "overflow-y-visible",
    clip: "overflow-y-clip",
  },
  "text-align": {
    left: "text-left",
    center: "text-center",
    right: "text-right",
    justify: "text-justify",
    start: "text-start",
    end: "text-end",
  },
  "text-transform": {
    uppercase: "uppercase",
    lowercase: "lowercase",
    capitalize: "capitalize",
    none: "normal-case",
  },
  "white-space": {
    nowrap: "whitespace-nowrap",
    normal: "whitespace-normal",
    "pre-wrap": "whitespace-pre-wrap",
    pre: "whitespace-pre",
    "pre-line": "whitespace-pre-line",
  },
  "text-overflow": { ellipsis: "text-ellipsis", clip: "text-clip" },
  "overflow-wrap": { "break-word": "break-words" },
  cursor: {
    pointer: "cursor-pointer",
    default: "cursor-default",
    text: "cursor-text",
    "not-allowed": "cursor-not-allowed",
  },
  "object-fit": {
    cover: "object-cover",
    contain: "object-contain",
    fill: "object-fill",
    none: "object-none",
    "scale-down": "object-scale-down",
  },
  "pointer-events": { none: "pointer-events-none", auto: "pointer-events-auto" },
  "box-sizing": { "border-box": "box-border", "content-box": "box-content" },
  "font-style": { italic: "italic", normal: "not-italic" },
  "font-weight": {
    "100": "font-thin",
    "200": "font-extralight",
    "300": "font-light",
    "400": "font-normal",
    "500": "font-medium",
    "600": "font-semibold",
    "700": "font-bold",
    "800": "font-extrabold",
    "900": "font-black",
  },
  visibility: { hidden: "invisible", visible: "visible", collapse: "collapse" },
  isolation: { isolate: "isolate", auto: "isolation-auto" },
  "flex-grow": { "1": "grow", "0": "grow-0" },
  "flex-shrink": { "1": "shrink", "0": "shrink-0" },
  flex: {
    "1": "flex-1",
    "1 1 0%": "flex-1",
    "1 1 auto": "flex-auto",
    none: "flex-none",
    "0 0 auto": "flex-none",
    "0 1 auto": "flex-initial",
  },
  fill: { none: "fill-none" },
  stroke: { none: "stroke-none" },
};

// simple values only (a length / number): `w-[12px]`, `leading-[1.45]`; anything with spaces or functions is arbitrary
const SIZE_PREFIX: Record<string, string> = {
  width: "w",
  height: "h",
  "min-width": "min-w",
  "min-height": "min-h",
  "max-width": "max-w",
  "max-height": "max-h",
  gap: "gap",
  "row-gap": "gap-y",
  "column-gap": "gap-x",
  top: "top",
  left: "left",
  right: "right",
  bottom: "bottom",
  inset: "inset",
  "padding-top": "pt",
  "padding-right": "pr",
  "padding-bottom": "pb",
  "padding-left": "pl",
  "margin-top": "mt",
  "margin-right": "mr",
  "margin-bottom": "mb",
  "margin-left": "ml",
  "flex-basis": "basis",
  "font-size": "text",
  "line-height": "leading",
  "letter-spacing": "tracking",
  "z-index": "z",
  opacity: "opacity",
  "border-radius": "rounded",
};
const LENGTH = /^-?(\d+\.?\d*|\.\d+)(px|%|em|rem|vw|vh|svh|lvh|dvh|ch|ex)$/;
const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/;
const UNITLESS = new Set(["line-height", "z-index", "opacity"]);

const COLOR_PREFIX: Record<string, string> = {
  background: "bg",
  "background-color": "bg",
  color: "text",
  "border-color": "border",
  fill: "fill",
  stroke: "stroke",
};
const LITERAL_COLOR = /^(#[0-9a-f]{3,8}|(rgba?|hsla?)\([\d\s.,%/+-]*\)|transparent|currentcolor)$/i;
const RADIUS: Record<string, string> = {
  "var(--t-radius)": "rounded",
  "var(--t-radius-sm)": "rounded-sm",
  "var(--t-radius-lg)": "rounded-lg",
  "9999px": "rounded-full",
};
const SHADOW: Record<string, string> = {
  "var(--t-shadow-sm)": "shadow-sm",
  "var(--t-shadow-md)": "shadow-md",
  "var(--t-shadow-lg)": "shadow-lg",
  "var(--t-shadow-glow)": "shadow-glow",
};

function sizeClass(prefix: string, prop: string, v: string): string | null {
  if (v === "100%" && /^(w|h|min-w|min-h|max-w|max-h|basis)$/.test(prefix)) return `${prefix}-full`;
  if (v === "auto" && /^(w|h|basis|mt|mr|mb|ml|inset|top|left|right|bottom)$/.test(prefix))
    return `${prefix}-auto`;
  if (v === "fit-content" && /^(w|h|min-w|max-w)$/.test(prefix)) return `${prefix}-fit`;
  if (UNITLESS.has(prop) ? !NUMBER.test(v) && !LENGTH.test(v) : !LENGTH.test(v) && !/^0$/.test(v))
    return null;
  if (prefix === "text" && v === "0") return null;
  return `${prefix}-[${v}]`;
}

/** One declaration → one class, or null when only an arbitrary property / inline style can say it exactly. */
function utility(prop: string, v: string, o: TwOptions): string | null {
  const kw = KEYWORDS[prop]?.[v];
  if (kw) return kw;
  if (prop === "border-radius" && RADIUS[v]) return RADIUS[v];
  if (prop === "box-shadow" && SHADOW[v]) return SHADOW[v];
  if (prop === "font-family" && v === "var(--t-font)") return "font-sans";
  if (prop === "font-family" && v === "var(--t-font-mono)") return "font-mono";
  const color = COLOR_PREFIX[prop];
  if (color) {
    const tok = /^var\(--t-([a-z0-9-]+)\)$/.exec(v);
    if (tok?.[1] && o.colorNames.has(tok[1])) return `${color}-${tok[1]}`;
    const lit = o.cssVars ? v : resolveVars(v, o.vars);
    return LITERAL_COLOR.test(lit) ? `${color}-[${lit.replace(/\s+/g, "_")}]` : null;
  }
  if (prop === "padding" || prop === "margin") return boxClasses(prop === "padding" ? "p" : "m", v);
  const size = SIZE_PREFIX[prop];
  return size ? sizeClass(size, prop, v) : null;
}

/** `padding: 8px 16px` → `py-[8px] px-[16px]` (simple lengths / auto margins only). */
function boxClasses(kind: "p" | "m", v: string): string | null {
  const p = v.split(/\s+/);
  const ok = (x: string) => LENGTH.test(x) || x === "0" || (kind === "m" && x === "auto");
  if (!p.every(ok) || p.length > 4) return null;
  const [t, r = t, b = t, l = r] = p as [string, string?, string?, string?];
  const one = (pre: string, x: string) => (x === "auto" ? `${pre}-auto` : `${pre}-[${x}]`);
  if (t === r && r === b && b === l) return one(kind, t);
  if (t === b && r === l) return `${one(`${kind}y`, t)} ${one(`${kind}x`, r)}`;
  return [one(`${kind}t`, t), one(`${kind}r`, r), one(`${kind}b`, b), one(`${kind}l`, l)].join(" ");
}

/* ------------------------------------------------------------------ overlap (shorthand ↔ longhand) */

const SIDES = ["top", "right", "bottom", "left"];
const SHORTHANDS: Record<string, string[]> = {
  margin: SIDES.map((s) => `margin-${s}`),
  padding: SIDES.map((s) => `padding-${s}`),
  inset: SIDES,
  "margin-inline": ["margin-left", "margin-right"],
  "margin-block": ["margin-top", "margin-bottom"],
  "margin-inline-start": ["margin-left"],
  "margin-inline-end": ["margin-right"],
  "margin-block-start": ["margin-top"],
  "margin-block-end": ["margin-bottom"],
  "padding-inline": ["padding-left", "padding-right"],
  "padding-block": ["padding-top", "padding-bottom"],
  "padding-inline-start": ["padding-left"],
  "padding-inline-end": ["padding-right"],
  "padding-block-start": ["padding-top"],
  "padding-block-end": ["padding-bottom"],
  "inset-inline": ["left", "right"],
  "inset-block": ["top", "bottom"],
  "inset-inline-start": ["left"],
  "inset-inline-end": ["right"],
  "inset-block-start": ["top"],
  "inset-block-end": ["bottom"],
  border: [...SIDES.map((s) => `border-${s}`), "border-image"],
  ...Object.fromEntries(
    SIDES.map((s) => [`border-${s}`, [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]]),
  ),
  "border-width": SIDES.map((s) => `border-${s}-width`),
  "border-style": SIDES.map((s) => `border-${s}-style`),
  "border-color": SIDES.map((s) => `border-${s}-color`),
  "border-radius": [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
  ],
  background: [
    "background-color",
    "background-image",
    "background-position",
    "background-size",
    "background-repeat",
    "background-attachment",
    "background-origin",
    "background-clip",
  ],
  "background-position": ["background-position-x", "background-position-y"],
  flex: ["flex-grow", "flex-shrink", "flex-basis"],
  "flex-flow": ["flex-direction", "flex-wrap"],
  font: [
    "font-style",
    "font-variant",
    "font-weight",
    "font-stretch",
    "font-size",
    "line-height",
    "font-family",
  ],
  gap: ["row-gap", "column-gap"],
  "grid-gap": ["row-gap", "column-gap"],
  overflow: ["overflow-x", "overflow-y"],
  "text-decoration": [
    "text-decoration-line",
    "text-decoration-style",
    "text-decoration-color",
    "text-decoration-thickness",
  ],
  outline: ["outline-width", "outline-style", "outline-color"],
  "list-style": ["list-style-type", "list-style-position", "list-style-image"],
  mask: [
    "mask-image",
    "mask-position",
    "mask-size",
    "mask-repeat",
    "mask-origin",
    "mask-clip",
    "mask-composite",
    "mask-mode",
  ],
  "mask-position": ["mask-position-x", "mask-position-y"],
  "place-items": ["align-items", "justify-items"],
  "place-content": ["align-content", "justify-content"],
  "place-self": ["align-self", "justify-self"],
  grid: ["grid-template", "grid-auto-rows", "grid-auto-columns", "grid-auto-flow"],
  "grid-template": ["grid-template-rows", "grid-template-columns", "grid-template-areas"],
  "grid-area": ["grid-row", "grid-column"],
  "grid-row": ["grid-row-start", "grid-row-end"],
  "grid-column": ["grid-column-start", "grid-column-end"],
  transition: [
    "transition-property",
    "transition-duration",
    "transition-timing-function",
    "transition-delay",
  ],
  animation: [
    "animation-name",
    "animation-duration",
    "animation-timing-function",
    "animation-delay",
    "animation-iteration-count",
    "animation-direction",
    "animation-fill-mode",
    "animation-play-state",
  ],
  columns: ["column-width", "column-count"],
  "text-stroke": ["text-stroke-width", "text-stroke-color"],
  "text-emphasis": ["text-emphasis-style", "text-emphasis-color"],
};

/** Longhands a property sets (`-webkit-mask-image` and `mask-image` are one property in Chromium). */
export function longhands(prop: string): Set<string> {
  const out = new Set<string>();
  const add = (p: string) => {
    const sub = SHORTHANDS[p];
    if (sub) sub.forEach(add);
    else out.add(p);
  };
  add(prop.replace(/^-webkit-/, ""));
  return out;
}
const overlaps = (a: Set<string>, b: Set<string>) => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/* ------------------------------------------------------------------ entry points */

/**
 * Classes + inline style for a StyleMap. Every declaration survives: as a utility, an arbitrary property, or inline.
 * `pseudo` mode (for `before:` / `after:`) never inlines: it returns null when a declaration cannot be a class.
 */
export function splitTailwind(style: StyleMap, o: TwOptions): TwSplit {
  const classes: string[] = [];
  const inline: StyleMap = {};
  const seen: Array<Set<string>> = [];
  for (const [prop, raw] of Object.entries(style)) {
    const v = raw.trim();
    const lh = longhands(prop);
    const clash = seen.some((s) => overlaps(s, lh));
    seen.push(lh);
    const cls = clash ? null : classFor(prop, v, o);
    if (cls) classes.push(...cls.split(" "));
    else inline[prop] = o.cssVars || prop.startsWith("--") ? v : resolveVars(v, o.vars);
  }
  return { classes, inline };
}

/** Class for one declaration (utility or arbitrary property), null when it cannot be one. */
export function classFor(prop: string, value: string, o: TwOptions): string | null {
  const v = value.trim();
  if (!PROP_RE.test(prop) || !v || /!important/i.test(v)) return null;
  const u = utility(prop, v, o);
  if (u) return u;
  const val = o.cssVars || prop.startsWith("--") ? v : resolveVars(v, o.vars);
  return twSafe(val) ? `[${prop}:${arb(val)}]` : null;
}

/** Classes for a pseudo element (`before:` / `after:`); null when any declaration cannot be a class. */
export function pseudoTailwind(style: StyleMap, which: "before" | "after", o: TwOptions): string[] | null {
  const out: string[] = [];
  const seen: Array<Set<string>> = [];
  // the variant always writes `content: var(--tw-content)`: content must be set through the content utility
  if (style.content === undefined) return null;
  for (const [prop, raw] of Object.entries(style)) {
    const v = raw.trim();
    const lh = longhands(prop);
    if (seen.some((s) => overlaps(s, lh))) return null;
    seen.push(lh);
    if (prop === "content") {
      if (v === "none") {
        out.push(`${which}:content-none`);
        continue;
      }
      if (!twSafe(v) || /^(var|attr|counter)\(/.test(v)) return null;
      out.push(`${which}:content-[${arb(v)}]`);
      continue;
    }
    const c = classFor(prop, v, o);
    if (!c) return null;
    out.push(...c.split(" ").map((x) => `${which}:${x}`));
  }
  return out;
}

/** Classes only (unsafe / overriding declarations dropped) — kept for callers that cannot carry a style prop. */
export function toTailwind(style: StyleMap, o: TwOptions): string[] {
  return splitTailwind(style, o).classes;
}

/** The mapping tables, for reading generated classes back as CSS (reactStyles.ts: css-modules / vanilla output). */
export const TAILWIND_TABLES = {
  keywords: KEYWORDS,
  sizePrefix: SIZE_PREFIX,
  colorPrefix: COLOR_PREFIX,
  literalColor: LITERAL_COLOR,
  radius: RADIUS,
  shadow: SHADOW,
} as const;
