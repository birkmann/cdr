// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Shared DSL → CSS mapping used by the live renderer (React) and the static exporter (toHtml).
import type { CSSProperties } from "../css.js";
import type {
  SceneElement,
  SceneFill,
  SceneFilter,
  SceneGradient,
  SceneLayout,
  SceneLength,
  SceneMaskImage,
  SceneShadow,
  SceneSize,
  SceneStyle,
  SceneTextRun,
  SceneTokens,
} from "@harness/protocol";
import { sanitizeSvg } from "./svg.js";
import { concreteColor, cssColor, textPreset } from "./tokens.js";
import { onColor } from "./color.js";
import { fontStack } from "./fontStack.js";
import { localOutline } from "../vector/shapes.js";
import {
  elementMatrix,
  fmt,
  invert,
  multiply,
  pathBounds,
  rectSubpath,
  toPath,
  transformSubpaths,
  translate,
  type Bounds,
  type Mat,
} from "../vector/path.js";

export type Dir = "row" | "column";
export interface StyleCtx {
  tokens: SceneTokens;
  platform: "app" | "web";
  /** flex direction of the parent (decides what "fill" means) */
  parentDir: Dir;
  interactive: boolean;
}

/** Types that lay out children with flexbox. */
export const CONTAINER_TYPES = new Set<SceneElement["type"]>([
  "frame",
  "card",
  "list",
  "navbar",
  "tabbar",
  "statusbar",
  "button",
  "badge",
  "input",
]);
export const isContainer = (el: SceneElement) => CONTAINER_TYPES.has(el.type);

/** Effective flex direction of an element (component defaults apply when layout.direction is absent). */
export function directionOf(el: SceneElement): Dir {
  if (el.layout?.direction) return el.layout.direction;
  switch (el.type) {
    case "navbar":
    case "tabbar":
    case "statusbar":
    case "button":
    case "badge":
    case "input":
      return "row";
    default:
      return "column";
  }
}

const ALIGN: Record<NonNullable<SceneLayout["align"]>, CSSProperties["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};
const JUSTIFY: Record<NonNullable<SceneLayout["justify"]>, CSSProperties["justifyContent"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};

/**
 * padding / margin shorthand. `min` clamps each side (padding: 0) — CSS drops a whole `padding` declaration with one
 * negative value, which would also lose the valid sides (imported boxes carry sub-pixel negatives like [-0.5, 0, 0, 1]).
 */
export function paddingCss(p: SceneLayout["padding"], min = -Infinity): string | undefined {
  if (p === undefined) return undefined;
  const v = (n: number) => `${fmt(Number.isFinite(n) ? Math.max(min, n) : 0)}px`;
  if (typeof p === "number") return v(p);
  return p.map(v).join(" ");
}

export function radiusCss(
  r: number | [number, number, number, number] | undefined,
  fallback?: string,
): string | undefined {
  if (r === undefined) return fallback;
  if (typeof r === "number") return `${r}px`;
  return r.map((v) => `${v}px`).join(" ");
}

const sizeCss = (s: SceneSize | undefined): string | undefined =>
  s === undefined
    ? undefined
    : typeof s === "number"
      ? `${s}px`
      : s === "hug"
        ? "fit-content"
        : s === "fill"
          ? undefined
          : s;

/** Width/height/grow/position. Sizing words depend on the parent's direction. */
export function sizingStyle(el: SceneElement, ctx: StyleCtx): CSSProperties {
  const l = el.layout ?? {};
  const out: CSSProperties = {};
  const row = ctx.parentDir === "row";
  // width
  if (l.width === "fill") {
    if (row) {
      out.flex = "1 1 0%";
      out.minWidth = 0;
    } else {
      out.alignSelf = "stretch";
      out.width = "auto";
    }
  } else if (l.width !== undefined) {
    out.width = sizeCss(l.width);
    if (row && typeof l.width === "number") out.flexShrink = 0;
  }
  // height
  if (l.height === "fill") {
    if (!row) {
      out.flex = "1 1 0%";
      out.minHeight = 0;
    } else {
      out.alignSelf = "stretch";
      out.height = "auto";
    }
  } else if (l.height !== undefined) {
    out.height = sizeCss(l.height);
    if (!row && typeof l.height === "number") out.flexShrink = 0;
  }
  if (l.grow !== undefined && l.grow > 0) {
    out.flexGrow = l.grow;
    out.flexBasis = 0;
    if (row) out.minWidth = 0;
    else out.minHeight = 0;
  }
  if (l.minWidth !== undefined) out.minWidth = l.minWidth;
  if (l.minHeight !== undefined) out.minHeight = l.minHeight;
  if (l.maxWidth !== undefined) out.maxWidth = l.maxWidth;
  if (l.maxHeight !== undefined) out.maxHeight = l.maxHeight;
  if (l.position === "absolute") {
    out.position = "absolute";
    if (l.x === undefined && l.right !== undefined) out.right = l.right;
    else out.left = l.x ?? 0;
    if (l.y === undefined && l.bottom !== undefined) out.bottom = l.bottom;
    else out.top = l.y ?? 0;
  }
  if (l.z !== undefined) out.zIndex = l.z;
  const margin = paddingCss(l.margin);
  if (margin !== undefined) out.margin = margin;
  if (l.alignSelf) out.alignSelf = l.alignSelf === "auto" ? "auto" : ALIGN[l.alignSelf];
  if (l.colSpan && l.colSpan > 1) out.gridColumn = `span ${Math.round(l.colSpan)}`;
  if (l.rowSpan && l.rowSpan > 1) out.gridRow = `span ${Math.round(l.rowSpan)}`;
  if (l.snapAlign && ctx.interactive) out.scrollSnapAlign = l.snapAlign;
  const transform = figMatrixCss(el) ?? transformCss(l);
  if (transform) out.transform = transform;
  return out;
}

/**
 * Imported skew / non-uniform scale (`meta.figMatrix` = "a,b,c,d", CSS order) as `matrix(a, b, c, d, 0, 0)` around
 * the box centre. Only while `layout.rotation` / `flipY` still match the matrix's closest rotation — once the layer is
 * rotated or flipped in the editor, the DSL rotation wins.
 */
export function figMatrixCss(el: SceneElement): string | undefined {
  const raw = el.meta?.figMatrix;
  if (typeof raw !== "string") return undefined;
  const m = raw.split(",").map(Number);
  if (m.length !== 4 || m.some((v) => !Number.isFinite(v))) return undefined;
  const [a, b, c, d] = m as [number, number, number, number];
  const det = a * d - b * c;
  const rot =
    det < 0 ? (Math.atan2(b + c, a - d) * 180) / Math.PI : (Math.atan2(b - c, a + d) * 180) / Math.PI;
  const norm = (v: number) => ((v % 360) + 360) % 360;
  const diff = Math.abs(norm(rot) - norm(el.layout?.rotation ?? 0));
  if (Math.min(diff, 360 - diff) > 0.5 || det < 0 !== !!el.layout?.flipY || el.layout?.flipX)
    return undefined;
  return `matrix(${[a, b, c, d].map((v) => String(Math.round(v * 1e5) / 1e5)).join(", ")}, 0, 0)`;
}

/** CSS transform for rotation (clockwise degrees, around the centre) and flips; undefined when untransformed. */
export function transformCss(
  l: Pick<SceneLayout, "rotation" | "flipX" | "flipY" | "scale"> | undefined,
): string | undefined {
  if (!l) return undefined;
  const parts: string[] = [];
  const r = l.rotation ? ((l.rotation % 360) + 360) % 360 : 0;
  if (r) parts.push(`rotate(${Math.round(r * 100) / 100}deg)`);
  const [sx, sy] =
    typeof l.scale === "number" ? [l.scale, l.scale] : Array.isArray(l.scale) ? l.scale : [1, 1];
  const fx = (l.flipX ? -1 : 1) * sx,
    fy = (l.flipY ? -1 : 1) * sy;
  if (fx !== 1 || fy !== 1) parts.push(fx === fy ? `scale(${fmt(fx)})` : `scale(${fmt(fx)}, ${fmt(fy)})`);
  return parts.length ? parts.join(" ") : undefined;
}

/* ------------------------------------------------------------------ */
/* Masks                                                               */
/* ------------------------------------------------------------------ */
// Figma: a mask layer clips every FOLLOWING sibling in the same parent up to the next mask, and is not painted
// itself. Its outline (or, for an image mask, its image's alpha) is the visible area, corner radius included.
// The live renderer masks each sibling with its own CSS mask (DOM order = paint order is kept, nothing is
// re-parented, and in-flow siblings work too); the static exporter wraps absolute siblings in one masked layer.

export interface MaskBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Target id → the mask that clips it (a mask ends the previous one's range; hidden masks clip nothing). */
export function maskTargets(children: readonly SceneElement[]): Map<string, SceneElement> {
  const out = new Map<string, SceneElement>();
  let current: SceneElement | null = null;
  for (const c of children) {
    if (c.mask) {
      current = c.meta?.hidden === true ? null : c;
      continue;
    }
    if (current) out.set(c.id, current);
  }
  return out;
}

const matrixOf = (el: SceneElement, b: MaskBox): Mat =>
  elementMatrix(b.x, b.y, b.w, b.h, el.layout?.rotation ?? 0, !!el.layout?.flipX, !!el.layout?.flipY);
const isTransformed = (el: SceneElement) =>
  !!(el.layout?.rotation && ((el.layout.rotation % 360) + 360) % 360) ||
  !!el.layout?.flipX ||
  !!el.layout?.flipY;
const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
const svgMatrix = (m: Mat) => `matrix(${m.map((v) => String(Math.round(v * 1e5) / 1e5)).join(" ")})`;
const HIDE_ALL = "linear-gradient(transparent, transparent)";

/**
 * CSS mask for `target` (border box at `tBox` in parent coordinates, before its own rotation / flip) clipped by
 * `mask` (box `mBox`, same coordinates). The mask image is drawn in the target's local (untransformed) space, so it
 * stays right when either layer is rotated; `mask-clip: no-clip` keeps overflowing content subject to the mask.
 */
export function maskStyleFor(
  mask: SceneElement,
  mBox: MaskBox,
  target: SceneElement,
  tBox: MaskBox,
): CSSProperties {
  const toLocal = multiply(
    invert(isTransformed(target) ? matrixOf(target, tBox) : translate(tBox.x, tBox.y)),
    matrixOf(mask, mBox),
  );
  const alpha = Math.max(0, Math.min(1, mask.style?.opacity ?? 1));
  const outline = localOutline(mask, mBox.w, mBox.h);
  let image: string | null = null,
    b: Bounds | null = null;
  const src = mask.type === "image" || mask.type === "avatar" ? mask.image?.src : undefined;
  if (src && mBox.w > 0 && mBox.h > 0) {
    // image mask: the image's alpha, fitted like ImageEl draws it and clipped to the element's outline
    b = pathBounds(transformSubpaths([rectSubpath(0, 0, mBox.w, mBox.h)], toLocal));
    if (b && /^data:/i.test(src)) {
      const fit = mask.style?.fit === "contain" ? "meet" : "slice";
      const m = multiply(translate(-b.x, -b.y), toLocal);
      image = svgUrl(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(b.w)}" height="${fmt(b.h)}" viewBox="0 0 ${fmt(b.w)} ${fmt(b.h)}"><g transform="${svgMatrix(m)}"><clipPath id="c"><path d="${toPath(outline)}"/></clipPath><image href="${src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}" width="${fmt(mBox.w)}" height="${fmt(mBox.h)}" preserveAspectRatio="xMidYMid ${fit}" clip-path="url(#c)"${alpha < 1 ? ` opacity="${fmt(alpha)}"` : ""}/></g></svg>`,
      );
    } else if (
      b &&
      Math.abs(toLocal[1]) < 1e-9 &&
      Math.abs(toLocal[2]) < 1e-9 &&
      toLocal[0] > 0 &&
      toLocal[3] > 0
    ) {
      // remote image (an SVG mask image cannot load it): the image itself, stretched to the box
      image = `url("${src.replace(/"/g, "%22")}")`;
    } else b = null;
  }
  if (!image) {
    const subs = transformSubpaths(outline, toLocal);
    b = pathBounds(subs);
    if (!b || b.w <= 0 || b.h <= 0) return { maskImage: HIDE_ALL, WebkitMaskImage: HIDE_ALL };
    const d = toPath(transformSubpaths(subs, translate(-b.x, -b.y)));
    image = svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(b.w)}" height="${fmt(b.h)}" viewBox="0 0 ${fmt(b.w)} ${fmt(b.h)}"><path d="${d}"${mask.vector?.fillRule === "evenodd" ? ' fill-rule="evenodd"' : ""}${alpha < 1 ? ` fill-opacity="${fmt(alpha)}"` : ""}/></svg>`,
    );
  }
  const pos = `${fmt(b!.x)}px ${fmt(b!.y)}px`,
    size = `${fmt(b!.w)}px ${fmt(b!.h)}px`;
  return {
    WebkitMaskImage: image,
    WebkitMaskPosition: pos,
    WebkitMaskSize: size,
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskOrigin: "border-box",
    maskImage: image,
    maskPosition: pos,
    maskSize: size,
    maskRepeat: "no-repeat",
    maskOrigin: "border-box",
    maskClip: "no-clip",
  } as CSSProperties;
}

/** Box of an element in its parent when it is known without layout (absolute; size only needed when transformed). */
export function staticMaskBox(el: SceneElement, needSize: boolean): MaskBox | null {
  const l = el.layout;
  if (l?.position !== "absolute") return null;
  const w = typeof l.width === "number" ? l.width : null,
    h = typeof l.height === "number" ? l.height : null;
  if ((w === null || h === null) && needSize) return null;
  return { x: l.x ?? 0, y: l.y ?? 0, w: w ?? 0, h: h ?? 0 };
}

const staticCache = new WeakMap<SceneElement, WeakMap<SceneElement, CSSProperties | null>>();

/**
 * Mask style for `target` when both boxes are known statically (memoised per element pair, so memoised elements
 * keep a stable style object); null when the renderer has to measure the laid-out boxes instead.
 */
export function staticMaskStyle(mask: SceneElement, target: SceneElement): CSSProperties | null {
  let byTarget = staticCache.get(mask);
  if (!byTarget) staticCache.set(mask, (byTarget = new WeakMap()));
  if (byTarget.has(target)) return byTarget.get(target)!;
  const mBox = staticMaskBox(mask, true);
  const tBox = staticMaskBox(target, isTransformed(target));
  const style = mBox && tBox ? maskStyleFor(mask, mBox, target, tBox) : null;
  byTarget.set(target, style);
  return style;
}

/**
 * Exporter form: one absolutely positioned layer over the parent's padding box, masked by `mask`'s shape. Null when
 * the mask has no static box (in-flow masks).
 */
export function maskWrapperStyle(mask: SceneElement): CSSProperties | null {
  const box = staticMaskBox(mask, true);
  if (!box) return null;
  return {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    ...maskStyleFor(mask, box, WRAPPER, { x: 0, y: 0, w: 0, h: 0 }),
  };
}
const WRAPPER: SceneElement = { id: "__mask-wrapper", type: "frame" };

/**
 * Split children for the static exporter: the absolute siblings in a mask's range (up to the next mask) go into a
 * masked group; in-flow ones stay unmasked (a CSS mask layer needs a common containing block). Paint order otherwise.
 */
export type MaskedItem =
  | { kind: "el"; el: SceneElement }
  | { kind: "mask"; mask: SceneElement; style: CSSProperties; children: SceneElement[] };
export function maskGroups(children: SceneElement[]): MaskedItem[] {
  const out: MaskedItem[] = [];
  let group: Extract<MaskedItem, { kind: "mask" }> | null = null;
  for (const c of children) {
    if (c.mask) {
      out.push({ kind: "el", el: c });
      const style = c.meta?.hidden === true ? null : maskWrapperStyle(c);
      group = style ? { kind: "mask", mask: c, style, children: [] } : null;
      if (group) out.push(group);
      continue;
    }
    if (group && c.layout?.position === "absolute") group.children.push(c);
    else out.push({ kind: "el", el: c });
  }
  return out.filter((it) => it.kind === "el" || it.children.length);
}

/** Flex container properties for frame-like elements. */
export function layoutStyle(el: SceneElement, ctx: StyleCtx): CSSProperties {
  const l = el.layout ?? {};
  if (l.grid) return gridStyle(el, ctx);
  const out: CSSProperties = { display: "flex", flexDirection: directionOf(el) };
  if (l.gap !== undefined) out.gap = l.gap;
  const pad = paddingCss(l.padding, 0);
  if (pad !== undefined) out.padding = pad;
  if (l.align) out.alignItems = ALIGN[l.align];
  if (l.justify) out.justifyContent = JUSTIFY[l.justify];
  if (l.wrap) {
    out.flexWrap = "wrap";
    // wrapped rows pack like Figma's (the CSS default `stretch` spreads them over the container's height)
    out.alignContent = l.align === "center" ? "center" : l.align === "end" ? "flex-end" : "flex-start";
    // the DSL has one gap; Figma's spacing between wrapped rows is kept in meta.figCounterGap
    const cg = l.crossGap ?? el.meta?.figCounterGap;
    if (typeof cg === "number") out[directionOf(el) === "row" ? "rowGap" : "columnGap"] = cg;
  }
  if (l.scroll && l.scroll !== "none") {
    if (l.scroll === "vertical") {
      out.overflowY = ctx.interactive ? "auto" : "hidden";
      out.overflowX = "hidden";
    } else {
      out.overflowX = ctx.interactive ? "auto" : "hidden";
      out.overflowY = "hidden";
    }
    if (l.scroll === "horizontal") {
      out.flexWrap = "nowrap";
    }
    Object.assign(out, scrollerCss(l, ctx));
  } else if (l.clip) out.overflow = "hidden";
  if (el.children?.some((c) => c.layout?.position === "absolute")) out.position = "relative";
  return out;
}

/** an interactive scrolling frame's scrollbar / snapping (static renders clip and never scroll) */
function scrollerCss(l: SceneLayout, ctx: StyleCtx): CSSProperties {
  if (!ctx.interactive) return {};
  const out: CSSProperties = {};
  if (l.scrollbar === "hidden") out.scrollbarWidth = "none";
  if (l.snap) {
    out.scrollSnapType = `${l.scroll === "vertical" ? "y" : "x"} mandatory`;
    if (l.snapPadding)
      out[l.scroll === "vertical" ? "scrollPaddingTop" : "scrollPaddingLeft"] = l.snapPadding;
  }
  return out;
}

const TRACK =
  /^(auto|min-content|max-content|-?\d*\.?\d+(px|fr|%|em|rem)|(minmax|fit-content|repeat)\([\w\s.,%()-]+\))$/;
/** grid track list: a count → equal `minmax(0, 1fr)` columns; strings are CSS tracks (unsafe ones become 1fr) */
export function tracksCss(t: number | string[] | undefined): string | undefined {
  if (t === undefined) return undefined;
  if (typeof t === "number")
    return t >= 1 ? `repeat(${Math.min(48, Math.round(t))}, minmax(0, 1fr))` : undefined;
  const list = t
    .map((x) => (typeof x === "number" ? `${x}px` : String(x).trim()))
    .map((x) => (TRACK.test(x) ? x : "1fr"));
  return list.length ? list.join(" ") : undefined;
}

/** CSS grid container (layout.grid). Children size like column children (fill = stretch the cell). */
function gridStyle(el: SceneElement, ctx: StyleCtx): CSSProperties {
  const l = el.layout ?? {},
    g = l.grid!;
  const out: CSSProperties = { display: "grid", gridTemplateColumns: tracksCss(g.columns) };
  const rows = tracksCss(g.rows);
  if (rows) out.gridTemplateRows = rows;
  if (g.autoRows && TRACK.test(g.autoRows.trim())) out.gridAutoRows = g.autoRows.trim();
  if (g.flow) out.gridAutoFlow = g.flow;
  const cg = g.columnGap ?? l.gap,
    rg = g.rowGap ?? l.crossGap ?? l.gap;
  if (cg !== undefined) out.columnGap = cg;
  if (rg !== undefined) out.rowGap = rg;
  const pad = paddingCss(l.padding, 0);
  if (pad !== undefined) out.padding = pad;
  if (l.align) out.alignItems = ALIGN[l.align];
  if (l.justify) out.justifyContent = JUSTIFY[l.justify];
  if (l.scroll && l.scroll !== "none") {
    out.overflowY = l.scroll === "vertical" && ctx.interactive ? "auto" : "hidden";
    out.overflowX = l.scroll === "horizontal" && ctx.interactive ? "auto" : "hidden";
    Object.assign(out, scrollerCss(l, ctx));
  } else if (l.clip) out.overflow = "hidden";
  if (el.children?.some((c) => c.layout?.position === "absolute")) out.position = "relative";
  return out;
}

const SIDE = { top: "borderTop", right: "borderRight", bottom: "borderBottom", left: "borderLeft" } as const;
const SHADOWS: Record<string, string> = {
  sm: "var(--t-shadow-sm)",
  md: "var(--t-shadow-md)",
  lg: "var(--t-shadow-lg)",
  glow: "var(--t-shadow-glow)",
};

/** Figma layer blend modes (meta.figBlendMode) → CSS mix-blend-mode. */
const BLEND: Record<string, CSSProperties["mixBlendMode"]> = {
  DARKEN: "darken",
  MULTIPLY: "multiply",
  LINEAR_BURN: "plus-darker" as CSSProperties["mixBlendMode"],
  COLOR_BURN: "color-burn",
  LIGHTEN: "lighten",
  SCREEN: "screen",
  LINEAR_DODGE: "plus-lighter",
  COLOR_DODGE: "color-dodge",
  OVERLAY: "overlay",
  SOFT_LIGHT: "soft-light",
  HARD_LIGHT: "hard-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
};

/** Theme-independent drop-shadow() equivalents of the shadow presets (filters have no spread). */
const DROP: Record<string, string> = {
  sm: "drop-shadow(0 1px 2px rgba(0,0,0,.3))",
  md: "drop-shadow(0 6px 10px rgba(0,0,0,.25))",
  lg: "drop-shadow(0 16px 20px rgba(0,0,0,.3))",
  glow: "drop-shadow(0 8px 14px color-mix(in srgb, var(--t-primary) 60%, transparent))",
};

interface FigShadow {
  type?: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number; a?: number };
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
}

/** Imported Figma shadows (meta.figEffects) while the preset still matches the one the importer derived from them. */
function figShadows(el: SceneElement, preset: string): FigShadow[] | null {
  const raw = el.meta?.figEffects;
  if (typeof raw !== "string") return null;
  let effects: FigShadow[];
  try {
    effects = JSON.parse(raw) as FigShadow[];
  } catch {
    return null;
  }
  if (!Array.isArray(effects)) return null;
  const shadows = effects.filter(
    (e) => e && e.visible !== false && (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"),
  );
  const drop = shadows.find((e) => e.type === "DROP_SHADOW");
  if (!drop) return null;
  const blur = drop.radius ?? 0;
  // convert.ts buckets the first drop shadow's blur into the preset; a different preset means it was edited
  if ((blur <= 4 ? "sm" : blur <= 14 ? "md" : "lg") !== preset) return null;
  return shadows;
}

const figRgba = (c: FigShadow["color"]) => {
  if (!c) return "rgba(0,0,0,.25)";
  const ch = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${fmt(c.a ?? 1)})`;
};

/**
 * Shadow for an element. Boxes with a fill cast a box-shadow (it follows the border radius); everything else casts
 * the shadow of its painted pixels like Figma does — `filter: drop-shadow()` for images, vectors and unfilled frames
 * (a transparent PNG's shadow follows its alpha), `text-shadow` for text. Exact values from meta.figEffects when present.
 */
export function shadowStyle(
  el: SceneElement,
  preset: NonNullable<SceneElement["style"]>["shadow"],
  filled: boolean,
): CSSProperties {
  if (!preset || preset === "none") return {};
  const fig = figShadows(el, preset);
  // only what the author drew as an opaque box keeps box-shadow; AI cards / buttons get their fill from componentStyle
  const media = el.type === "image" || el.type === "video" || el.type === "vector";
  const boxy =
    el.type !== "text" &&
    (media ? filled : filled || el.type !== "frame" || !!el.style?.border || !!el.style?.gradient);
  if (el.type === "text") {
    const drops = fig?.filter((e) => e.type === "DROP_SHADOW");
    return {
      textShadow: drops?.length
        ? drops
            .map(
              (e) =>
                `${fmt(e.offset?.x ?? 0)}px ${fmt(e.offset?.y ?? 0)}px ${fmt(e.radius ?? 0)}px ${figRgba(e.color)}`,
            )
            .join(", ")
        : "0 1px 2px rgba(0,0,0,.3)",
    };
  }
  if (boxy) {
    if (!fig) return { boxShadow: SHADOWS[preset] };
    return {
      boxShadow: fig
        .map(
          (e) =>
            `${e.type === "INNER_SHADOW" ? "inset " : ""}${fmt(e.offset?.x ?? 0)}px ${fmt(e.offset?.y ?? 0)}px ${fmt(e.radius ?? 0)}px ${fmt(e.spread ?? 0)}px ${figRgba(e.color)}`,
        )
        .join(", "),
    };
  }
  const drops = fig?.filter((e) => e.type === "DROP_SHADOW");
  if (drops?.length)
    return {
      filter: drops
        .map(
          (e) =>
            `drop-shadow(${fmt(e.offset?.x ?? 0)}px ${fmt(e.offset?.y ?? 0)}px ${fmt(e.radius ?? 0)}px ${figRgba(e.color)})`,
        )
        .join(" "),
    };
  return { filter: DROP[preset] };
}

/* ------------------------------------------------------------------ */
/* Wave 4: exact paints, shadows, filters                              */
/* ------------------------------------------------------------------ */

const num = (v: unknown, fb = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
/** SceneLength → CSS (numbers are px) */
export const lenCss = (v: SceneLength | "auto" | undefined, fb = "50%"): string =>
  v === undefined
    ? fb
    : typeof v === "number"
      ? `${fmt(v)}px`
      : /^-?\d*\.?\d+%$/.test(v) || v === "auto"
        ? v
        : fb;

/** CSS gradient function for a SceneGradient (stops without a position are spaced evenly by CSS). */
export function gradientCss(g: SceneGradient, tokens: SceneTokens): string {
  const stops = (g.stops ?? []).filter((s) => s && typeof s.color === "string");
  const list = (stops.length ? stops : [{ color: "transparent" }, { color: "transparent" }]).map(
    (s) =>
      `${cssColor(s.color, tokens, "transparent")}${s.pos !== undefined && Number.isFinite(s.pos) ? ` ${fmt(s.pos * 100)}%` : ""}`,
  );
  if (list.length === 1) list.push(list[0]!);
  const rep = g.repeating ? "repeating-" : "";
  const at = g.at ? ` at ${lenCss(g.at[0])} ${lenCss(g.at[1])}` : "";
  if (g.kind === "radial") {
    const size = Array.isArray(g.size) ? `${lenCss(g.size[0])} ${lenCss(g.size[1])}` : (g.size ?? "");
    const shape = Array.isArray(g.size) ? (g.shape === "circle" ? "" : "ellipse") : (g.shape ?? "");
    const head = `${shape}${shape && size ? " " : ""}${size}${at}`.trim();
    return `${rep}radial-gradient(${head ? `${head}, ` : ""}${list.join(", ")})`;
  }
  if (g.kind === "conic")
    return `${rep}conic-gradient(from ${fmt(num(g.angle))}deg${at}, ${list.join(", ")})`;
  return `${rep}linear-gradient(${fmt(num(g.angle, 180))}deg, ${list.join(", ")})`;
}

/** One background layer in shorthand form (`<image> <position> / <size> <repeat>`). */
export function fillLayerCss(f: SceneFill, tokens: SceneTokens): string | null {
  if (!f || typeof f !== "object") return null;
  if (f.type === "solid") {
    const c = cssColor(f.color, tokens);
    return c ? `linear-gradient(${c}, ${c})` : null;
  }
  if (f.type === "gradient") return gradientCss(f, tokens);
  if (f.type === "image") {
    if (typeof f.src !== "string" || !/^(https?:|data:image\/|blob:|\/)/i.test(f.src)) return null;
    const size = Array.isArray(f.size)
      ? `${lenCss(f.size[0], "auto")} ${lenCss(f.size[1], "auto")}`
      : (f.size ?? "cover");
    const pos = f.position ? `${lenCss(f.position[0])} ${lenCss(f.position[1])}` : "center";
    return `url("${f.src.replace(/"/g, "%22")}") ${pos} / ${size} ${f.repeat ?? "no-repeat"}`;
  }
  return null;
}

/** `background` shorthand for fills (+ legacy gradient as the bottom layer) over the solid colour. */
export function backgroundCss(s: SceneStyle, tokens: SceneTokens): string | undefined {
  const layers = (s.fills ?? []).map((f) => fillLayerCss(f, tokens)).filter((x): x is string => !!x);
  if (s.gradient)
    layers.push(
      `linear-gradient(${s.gradient.angle ?? 135}deg, ${cssColor(s.gradient.from, tokens, "var(--t-primary)")}, ${cssColor(s.gradient.to, tokens, "var(--t-secondary)")})`,
    );
  const color = cssColor(s.background, tokens);
  if (!layers.length) return color;
  if (color) layers[layers.length - 1] = `${layers[layers.length - 1]} ${color}`;
  return layers.join(", ");
}

/** CSS shadow list. `text` drops spread / inset (text-shadow), `drop` emits drop-shadow() filter functions. */
export function shadowsCss(
  list: SceneShadow[],
  tokens: SceneTokens,
  kind: "box" | "text" | "drop",
): string | undefined {
  const ok = list.filter((x) => x && typeof x === "object" && !(kind !== "box" && x.inset));
  if (!ok.length) return undefined;
  const one = (x: SceneShadow) => {
    const c = cssColor(x.color, tokens, "rgba(0,0,0,.25)");
    const xy = `${fmt(num(x.x))}px ${fmt(num(x.y))}px ${fmt(Math.max(0, num(x.blur)))}px`;
    if (kind === "text") return `${xy} ${c}`;
    if (kind === "drop") return `drop-shadow(${xy} ${c})`;
    return `${x.inset ? "inset " : ""}${xy} ${fmt(num(x.spread))}px ${c}`;
  };
  return ok.map(one).join(kind === "drop" ? " " : ", ");
}

/** CSS filter functions for a SceneFilter (identity values are skipped). */
export function filterCss(f: SceneFilter | undefined): string | undefined {
  if (!f || typeof f !== "object") return undefined;
  const out: string[] = [];
  if (f.blur) out.push(`blur(${fmt(Math.max(0, f.blur))}px)`);
  for (const k of ["brightness", "contrast", "saturate"] as const)
    if (f[k] !== undefined && f[k] !== 1) out.push(`${k}(${fmt(Math.max(0, f[k]!))})`);
  for (const k of ["grayscale", "sepia", "invert"] as const)
    if (f[k]) out.push(`${k}(${fmt(Math.max(0, Math.min(1, f[k]!)))})`);
  if (f.hueRotate) out.push(`hue-rotate(${fmt(f.hueRotate)}deg)`);
  return out.length ? out.join(" ") : undefined;
}

const sizeOf = (v: SceneMaskImage["size"], fb: string) =>
  Array.isArray(v) ? `${lenCss(v[0], "auto")} ${lenCss(v[1], "auto")}` : (v ?? fb);

/** CSS mask declarations for style.maskImage (both prefixed and standard; WebKit still needs the prefix). */
export function maskImageCss(m: SceneMaskImage | undefined, tokens: SceneTokens): CSSProperties {
  if (!m || typeof m !== "object") return {};
  let image: string | null = null;
  if (m.gradient && Array.isArray(m.gradient.stops)) image = gradientCss(m.gradient, tokens);
  else if (m.svg) {
    const svg = sanitizeSvg(m.svg);
    if (svg) image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  } else if (typeof m.src === "string" && /^(https?:|data:image\/|blob:|\/)/i.test(m.src))
    image = `url("${m.src.replace(/"/g, "%22")}")`;
  if (!image) return {};
  const size = sizeOf(m.size, m.gradient ? "100% 100%" : "contain");
  const pos = m.position ? `${lenCss(m.position[0])} ${lenCss(m.position[1])}` : "center";
  const repeat = m.repeat ?? "no-repeat";
  const out: Record<string, string> = {
    WebkitMaskImage: image,
    WebkitMaskSize: size,
    WebkitMaskPosition: pos,
    WebkitMaskRepeat: repeat,
    maskImage: image,
    maskSize: size,
    maskPosition: pos,
    maskRepeat: repeat,
  };
  if (m.mode === "luminance") {
    out.maskMode = "luminance";
    out.WebkitMaskSourceType = "luminance";
  }
  return out as CSSProperties;
}

const CLIP =
  /^(inset|circle|ellipse|polygon|xywh|rect)\([-\w\s.,%#]*\)$|^path\((['"])[MmLlHhVvCcSsQqTtAaZz0-9\s.,eE+-]*\2\)$/;
/** clip-path basic shapes only (no url() references) */
export const clipPathCss = (v: string | undefined) =>
  typeof v === "string" && CLIP.test(v.trim()) ? v.trim() : undefined;

const joinFilter = (a: CSSProperties["filter"], b: string | undefined) => (a && b ? `${a} ${b}` : (b ?? a));
const strokeCss = (b: { width: number; color: string; style?: string }, tokens: SceneTokens) =>
  `${fmt(Math.max(0, num(b.width)))}px ${b.style ?? "solid"} ${cssColor(b.color, tokens, "var(--t-border)")}`;

/** Background, border, radius, shadow, opacity. */
export function visualStyle(el: SceneElement, ctx: StyleCtx): CSSProperties {
  const s = el.style ?? {};
  const out: CSSProperties = {};
  if (s.fills?.length) {
    const bg = backgroundCss(s, ctx.tokens);
    if (bg) out.background = bg;
  } else {
    const bg = cssColor(s.background, ctx.tokens);
    if (bg) out.background = bg;
    if (s.gradient) {
      const from = cssColor(s.gradient.from, ctx.tokens, "var(--t-primary)");
      const to = cssColor(s.gradient.to, ctx.tokens, "var(--t-secondary)");
      out.background = `linear-gradient(${s.gradient.angle ?? 135}deg, ${from}, ${to})`;
    }
  }
  const radius = radiusCss(s.radius);
  if (radius) out.borderRadius = radius;
  if (s.border) {
    const b = strokeCss(s.border, ctx.tokens);
    if (s.border.sides?.length) {
      if (s.border.sides.length < 4) out.border = "none";
      for (const side of s.border.sides) out[SIDE[side]] = b;
    } else out.border = b;
  }
  if (s.borders && typeof s.borders === "object") {
    // a component's default border (cards, inputs) is replaced, not combined, once per-side borders are given
    if (!s.border) out.border = "none";
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const b = s.borders[side];
      if (b && typeof b === "object") out[SIDE[side]] = strokeCss(b, ctx.tokens);
    }
  }
  if (Array.isArray(s.shadows)) {
    // an explicit list (even empty) replaces the preset and any component default shadow
    const kind =
      el.type === "text" ? "text" : el.type === "vector" || (el.type === "icon" && !!el.svg) ? "drop" : "box";
    const v = shadowsCss(s.shadows, ctx.tokens, kind);
    if (v) {
      if (kind === "text") out.textShadow = v;
      else if (kind === "drop") out.filter = v;
      else out.boxShadow = v;
    } else if (kind === "box") out.boxShadow = "none";
  } else if (s.shadow && s.shadow !== "none")
    Object.assign(
      out,
      shadowStyle(
        el,
        s.shadow,
        !!(out.background && out.background !== "transparent" && out.background !== "none"),
      ),
    );
  if (s.opacity !== undefined) out.opacity = s.opacity;
  const blend = s.blend
    ? s.blend === "normal"
      ? undefined
      : (s.blend as CSSProperties["mixBlendMode"])
    : typeof el.meta?.figBlendMode === "string"
      ? BLEND[el.meta.figBlendMode]
      : undefined;
  if (blend) out.mixBlendMode = blend;
  // Figma blends pass through frames; CSS isolates blending inside any stacking context (a transformed / masked /
  // translucent ancestor), where luminosity would blend with nothing. Its common use — a photo turned grey over a
  // neutral page — is then kept by greyscaling the layer (a no-op for the blend itself where the backdrop is reachable).
  if (blend === "luminosity" && !s.blend) out.filter = `${out.filter ? `${out.filter} ` : ""}grayscale(1)`;
  const filter = filterCss(s.filter);
  if (filter) out.filter = joinFilter(out.filter, filter);
  const backdrop = joinFilter(s.blur ? `blur(${s.blur}px)` : undefined, filterCss(s.backdrop));
  if (backdrop) out.backdropFilter = backdrop;
  if (s.maskImage) Object.assign(out, maskImageCss(s.maskImage, ctx.tokens));
  const clip = clipPathCss(s.clipPath);
  if (clip) out.clipPath = clip;
  if (s.outline && typeof s.outline === "object") {
    out.outline = `${fmt(Math.max(0, num(s.outline.width)))}px ${s.outline.style ?? "solid"} ${cssColor(s.outline.color, ctx.tokens, "currentColor")}`;
    if (s.outline.offset !== undefined) out.outlineOffset = `${fmt(s.outline.offset)}px`;
  }
  if (s.backgroundClip) {
    out.backgroundClip = s.backgroundClip;
    if (s.backgroundClip === "text") {
      (out as Record<string, unknown>).WebkitBackgroundClip = "text";
      (out as Record<string, unknown>).WebkitTextFillColor = "transparent";
      out.color = "transparent";
    }
  }
  const color = cssColor(s.color, ctx.tokens);
  if (color && s.backgroundClip !== "text") out.color = color;
  // inherited by descendant text (a frame can set the family for a whole block)
  if (s.fontFamily) out.fontFamily = fontStack(s.fontFamily);
  return out;
}

/** Typography for text (and text-bearing components). */
export function typographyStyle(
  el: SceneElement,
  ctx: StyleCtx,
  presetName = el.style?.textStyle,
): CSSProperties {
  const s = el.style ?? {};
  const p = textPreset(presetName, ctx.platform);
  const out: CSSProperties = {
    fontSize: s.fontSize ?? p.size,
    fontWeight: s.fontWeight ?? p.weight,
    lineHeight: s.lineHeightPx !== undefined ? `${fmt(s.lineHeightPx)}px` : (s.lineHeight ?? p.lineHeight),
    letterSpacing: `${s.letterSpacing ?? p.letterSpacing}em`,
  };
  if (s.fontFamily) out.fontFamily = fontStack(s.fontFamily);
  if (s.textAlign) out.textAlign = s.textAlign;
  // imported-only text details (convert.ts): justified paragraphs, italic faces
  if (el.meta?.figTextAlign === "justify") out.textAlign = "justify";
  if (el.meta?.figItalic === true) out.fontStyle = "italic";
  Object.assign(out, textDetailCss(s, ctx.tokens));
  if (s.truncate === true || s.truncate === 1) {
    out.whiteSpace = "nowrap";
    out.overflow = "hidden";
    out.textOverflow = "ellipsis";
  } else if (typeof s.truncate === "number" && s.truncate > 1) {
    out.display = "-webkit-box";
    out.WebkitLineClamp = s.truncate;
    out.WebkitBoxOrient = "vertical";
    out.overflow = "hidden";
  }
  return out;
}

const FEATURES = /^\s*"[a-zA-Z0-9]{4}"(\s+(on|off|\d+))?(\s*,\s*"[a-zA-Z0-9]{4}"(\s+(on|off|\d+))?)*\s*$/;

/** Case, decoration, italic, white-space and font features (shared by text elements and rich-text runs). */
export function textDetailCss(s: Partial<SceneStyle>, tokens: SceneTokens): CSSProperties {
  const out: CSSProperties = {};
  if (s.italic !== undefined) out.fontStyle = s.italic ? "italic" : "normal";
  if (s.textTransform) out.textTransform = s.textTransform;
  else if (s.uppercase) out.textTransform = "uppercase";
  if (s.whiteSpace) out.whiteSpace = s.whiteSpace;
  else if (s.noWrap) out.whiteSpace = "pre";
  const d = s.decoration;
  if (d && typeof d === "object") {
    const line = d.line ?? "underline";
    out.textDecorationLine = line;
    if (line !== "none") {
      if (d.style) out.textDecorationStyle = d.style;
      const c = cssColor(d.color, tokens);
      if (c) out.textDecorationColor = c;
      if (d.thickness !== undefined) out.textDecorationThickness = `${fmt(Math.max(0, d.thickness))}px`;
      out.textUnderlineOffset = d.offset !== undefined ? `${fmt(d.offset)}px` : "0.18em";
    }
  } else if (s.underline) {
    out.textDecoration = "underline";
    out.textUnderlineOffset = "0.18em";
  }
  if (s.fontFeatures && FEATURES.test(s.fontFeatures)) out.fontFeatureSettings = s.fontFeatures.trim();
  if (s.fontStretch && /^\d+(\.\d+)?%$/.test(s.fontStretch.trim())) out.fontStretch = s.fontStretch.trim();
  if (s.textWrap) (out as Record<string, unknown>).textWrap = s.textWrap;
  if (s.hyphens) {
    out.hyphens = s.hyphens;
    (out as Record<string, unknown>).WebkitHyphens = s.hyphens;
  }
  return out;
}

/** Inline style of one rich-text run (only what the run overrides; the rest inherits from the text element). */
export function runStyle(run: SceneTextRun, tokens: SceneTokens): CSSProperties {
  const s = run.style ?? {};
  const out: CSSProperties = {};
  const c = cssColor(s.color, tokens);
  if (c) out.color = c;
  const bg = cssColor(s.background, tokens);
  if (bg) out.background = bg;
  if (s.fontFamily) out.fontFamily = fontStack(s.fontFamily);
  if (s.fontSize !== undefined) out.fontSize = s.fontSize;
  if (s.fontWeight !== undefined) out.fontWeight = s.fontWeight;
  if (s.letterSpacing !== undefined) out.letterSpacing = `${s.letterSpacing}em`;
  if (s.lineHeightPx !== undefined) out.lineHeight = `${fmt(s.lineHeightPx)}px`;
  else if (s.lineHeight !== undefined) out.lineHeight = s.lineHeight;
  if (s.opacity !== undefined) out.opacity = s.opacity;
  Object.assign(out, textDetailCss(s, tokens));
  // links look exactly as styled (no UA blue / underline): colour inherits, decoration only when the run asks for it
  if (run.href) {
    if (!out.color) out.color = "inherit";
    if (!s.decoration && !s.underline) out.textDecoration = "none";
  }
  return out;
}

/** The runs to render: only while they still spell `el.text` (an edit of the plain text drops stale styling). */
export function activeRuns(el: SceneElement): SceneTextRun[] | null {
  const runs = el.runs;
  if (!Array.isArray(runs) || !runs.length || el.type !== "text") return null;
  const joined = runs.map((r) => (r && typeof r.text === "string" ? r.text : "")).join("");
  return el.text === undefined || joined === el.text
    ? runs.filter((r) => r && typeof r.text === "string")
    : null;
}

/** Safe link target for a run (http(s), mailto, tel, #anchor); null otherwise. */
export const safeHref = (h: string | undefined): string | null =>
  typeof h === "string" && /^(https?:\/\/|mailto:|tel:|#)/i.test(h.trim()) ? h.trim() : null;

/* ------------------------------------------------------------------ */
/* Component defaults                                                  */
/* ------------------------------------------------------------------ */

const px = (n: number) => `${n}px`;

/** Base look of each component before the element's own layout/style apply. */
export function componentStyle(el: SceneElement, ctx: StyleCtx): CSSProperties {
  const t = ctx.tokens;
  const web = ctx.platform === "web";
  const row = ctx.parentDir === "row";
  const v = (el.variant ?? "").toLowerCase();
  switch (el.type) {
    case "frame":
      return {};
    case "card":
      return {
        background: "var(--t-surface)",
        border: "1px solid var(--t-border)",
        borderRadius: "var(--t-radius-lg)",
        padding: px(16),
        gap: px(12),
      };
    case "list":
      return {
        gap: 0,
        ...(v.includes("inset")
          ? {
              background: "var(--t-surface)",
              borderRadius: "var(--t-radius-lg)",
              border: "1px solid var(--t-border)",
              overflow: "hidden",
            }
          : {}),
      };
    case "navbar":
      return {
        alignItems: "center",
        gap: px(12),
        height: px(web ? 64 : 56),
        padding: web ? "0 32px" : "0 16px",
        flexShrink: 0,
        ...(row ? {} : { alignSelf: "stretch" }),
      };
    case "tabbar":
      return {
        alignItems: "flex-start",
        justifyContent: "space-around",
        height: px(84),
        padding: "10px 8px 0",
        borderTop: "1px solid var(--t-border)",
        background: "var(--t-surface)",
        flexShrink: 0,
        ...(row ? {} : { alignSelf: "stretch" }),
      };
    case "statusbar":
      return {
        alignItems: "center",
        justifyContent: "space-between",
        height: px(54),
        padding: "14px 24px 0 30px",
        flexShrink: 0,
        fontSize: 15,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        ...(row ? {} : { alignSelf: "stretch" }),
      };
    case "button": {
      const base: CSSProperties = {
        alignItems: "center",
        justifyContent: "center",
        gap: px(8),
        height: px(v.includes("sm") || v.includes("small") ? 36 : web ? 44 : 48),
        padding: v.includes("sm") ? "0 14px" : "0 20px",
        borderRadius: "var(--t-radius)",
        fontSize: v.includes("sm") ? 13 : 15,
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
        whiteSpace: "nowrap",
        cursor: ctx.interactive ? "pointer" : undefined,
        ...(row ? {} : { alignSelf: "stretch" }),
      };
      if (v.includes("pill") || v.includes("round")) base.borderRadius = 999;
      if (v.includes("icon")) {
        base.width = base.height;
        base.padding = 0;
      }
      const primary = concreteColor("$primary", t, t.primary);
      if (v.includes("secondary") || v.includes("tonal") || v.includes("soft"))
        return { ...base, background: "var(--t-primary-soft)", color: "var(--t-primary)" };
      if (v.includes("outline"))
        return {
          ...base,
          background: "transparent",
          border: "1px solid var(--t-border)",
          color: "var(--t-text)",
        };
      if (v.includes("ghost") || v.includes("text") || v.includes("link"))
        return { ...base, background: "transparent", color: "var(--t-primary)", padding: "0 8px" };
      if (v.includes("danger") || v.includes("destructive"))
        return { ...base, background: "var(--t-danger)", color: "var(--t-danger-fg)" };
      return {
        ...base,
        background: "var(--t-primary)",
        color: onColor(primary),
        boxShadow: "var(--t-shadow-glow)",
      };
    }
    case "input":
      return {
        alignItems: "center",
        gap: px(10),
        height: px(web ? 44 : 48),
        padding: "0 14px",
        background: "var(--t-surface-alt)",
        border: "1px solid var(--t-border)",
        borderRadius: v.includes("search") ? 999 : "var(--t-radius)",
        color: "var(--t-text)",
        fontSize: 15,
        ...(row ? { flex: "1 1 0%", minWidth: 0 } : { alignSelf: "stretch" }),
      };
    case "badge": {
      const base: CSSProperties = {
        alignItems: "center",
        gap: px(4),
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.3,
        whiteSpace: "nowrap",
        flexShrink: 0,
        width: "fit-content",
      };
      if (v.includes("success"))
        return {
          ...base,
          background: `color-mix(in srgb, var(--t-success) 18%, transparent)`,
          color: "var(--t-success)",
        };
      if (v.includes("warning"))
        return {
          ...base,
          background: `color-mix(in srgb, var(--t-warning) 20%, transparent)`,
          color: "var(--t-warning)",
        };
      if (v.includes("danger"))
        return {
          ...base,
          background: `color-mix(in srgb, var(--t-danger) 18%, transparent)`,
          color: "var(--t-danger)",
        };
      if (v.includes("neutral") || v.includes("muted") || v.includes("outline"))
        return { ...base, background: "var(--t-surface-alt)", color: "var(--t-text-muted)" };
      return { ...base, background: "var(--t-primary-soft)", color: "var(--t-primary)" };
    }
    case "avatar": {
      const size = typeof el.layout?.width === "number" ? el.layout.width : 40;
      return {
        width: px(size),
        height: px(size),
        borderRadius: "50%",
        flexShrink: 0,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        fontSize: Math.round(size * 0.38),
      };
    }
    case "icon": {
      const size = typeof el.layout?.width === "number" ? el.layout.width : 22;
      return {
        width: px(size),
        height: px(size),
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      };
    }
    case "divider":
      return row
        ? { width: px(1), alignSelf: "stretch", background: "var(--t-border)", flexShrink: 0 }
        : { height: px(1), alignSelf: "stretch", background: "var(--t-border)", flexShrink: 0 };
    case "spacer":
      return el.layout?.width !== undefined || el.layout?.height !== undefined
        ? { flexShrink: 0 }
        : { flex: "1 1 0%", minWidth: 0, minHeight: 0 };
    case "progress":
      return {
        height: px(8),
        borderRadius: 999,
        background: "var(--t-surface-alt)",
        overflow: "hidden",
        position: "relative",
        ...(row ? { flex: "1 1 0%", minWidth: 0 } : { alignSelf: "stretch" }),
      };
    case "slider":
      return {
        height: px(28),
        position: "relative",
        display: "flex",
        alignItems: "center",
        ...(row ? { flex: "1 1 0%", minWidth: 0 } : { alignSelf: "stretch" }),
      };
    case "toggle":
      return {
        width: px(51),
        height: px(31),
        borderRadius: 999,
        flexShrink: 0,
        position: "relative",
        cursor: ctx.interactive ? "pointer" : undefined,
      };
    case "checkbox":
      return {
        width: px(22),
        height: px(22),
        borderRadius: px(6),
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: ctx.interactive ? "pointer" : undefined,
      };
    case "chart":
      return {
        height: px(typeof el.layout?.height === "number" ? el.layout.height : 120),
        minHeight: 40,
        ...(row ? { flex: "1 1 0%", minWidth: 0 } : { alignSelf: "stretch" }),
      };
    case "map":
      return {
        height: px(typeof el.layout?.height === "number" ? el.layout.height : 200),
        borderRadius: "var(--t-radius-lg)",
        overflow: "hidden",
        position: "relative",
        ...(row ? { flex: "1 1 0%", minWidth: 0 } : { alignSelf: "stretch" }),
      };
    case "image":
    case "video": {
      const out: CSSProperties = {
        borderRadius: radiusCss(el.style?.radius, "var(--t-radius)"),
        overflow: "hidden",
        position: "relative",
        flexShrink: 0,
        display: "block",
      };
      if (el.layout?.height === undefined && el.layout?.width === undefined) out.alignSelf = "stretch";
      if (el.layout?.height === undefined && el.style?.aspect) out.aspectRatio = String(el.style.aspect);
      else if (el.layout?.height === undefined && el.layout?.width !== "fill")
        out.aspectRatio = row ? "1 / 1" : "16 / 10";
      return out;
    }
    case "text":
      return { minWidth: 0, color: "var(--t-text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
    case "vector":
      return { flexShrink: 0, overflow: "visible" };
    default:
      return {};
  }
}

/** Full inline style for an element (component defaults → layout → visual → typography → sizing). */
export function elementStyle(el: SceneElement, ctx: StyleCtx): CSSProperties {
  const base = componentStyle(el, ctx);
  const layout = isContainer(el) ? layoutStyle(el, ctx) : {};
  const visual = visualStyle(el, ctx);
  const textual = el.type === "text" || el.type === "button" || el.type === "badge" || el.type === "input";
  const type = textual
    ? el.type === "text" || hasTypography(el.style)
      ? typographyStyle(el, ctx, el.style?.textStyle ?? (el.type === "text" ? "body" : undefined))
      : {}
    : hasTypography(el.style)
      ? inheritedTypography(el.style!)
      : {};
  const sizing = sizingStyle(el, ctx);
  // non-text components only pick typography keys the author set explicitly
  const typo = el.type === "text" || !textual ? type : pickDefined(type, el.style);
  const out: CSSProperties = { ...base, ...layout, ...visual, ...typo, ...sizing };
  // padding on leaf elements (a text box with an accent border, a padded label)
  if (!isContainer(el) && el.layout?.padding !== undefined && (el.type === "text" || el.type === "icon"))
    out.padding = paddingCss(el.layout.padding, 0);
  if (el.type === "text") Object.assign(out, importedTextStyle(el, out));
  // a mask layer is not painted itself (it stays hit-testable on the canvas)
  if (el.mask) out.opacity = 0;
  return out;
}

/** Is the text box trimmed to cap height → baseline (Figma "vertical trim", meta.figLeadingTrim)? */
export const hasLeadingTrim = (el: SceneElement) =>
  el.type === "text" && el.meta?.figLeadingTrim === "CAP_HEIGHT";

/**
 * Imported text: vertical alignment inside a fixed-height box (meta.figAlignV) and the fallback margins for the
 * cap-height trim. The trim itself is `text-box: trim-both cap alphabetic` (SceneRenderer.module.css `.trim`); browsers
 * without text-box use `--trim-top` / `--trim-bottom` (em): Figma's box spans cap height → baseline, a CSS line box
 * spans the line height, so (with typical ascent .93 / descent .24) top = lh/2 + .345 − cap, bottom = lh/2 − .345.
 */
function importedTextStyle(el: SceneElement, base: CSSProperties): CSSProperties {
  const out: Record<string, string | number> = {};
  const v = el.meta?.figAlignV;
  if ((v === "CENTER" || v === "BOTTOM") && !el.style?.truncate) {
    out.display = "flex";
    out.flexDirection = "column";
    out.justifyContent = v === "CENTER" ? "center" : "flex-end";
  }
  if (hasLeadingTrim(el)) {
    const lh = typeof base.lineHeight === "number" && base.lineHeight < 4 ? base.lineHeight : 1.2;
    const capRaw = Number(el.meta?.figCapHeight);
    const cap = Number.isFinite(capRaw) && capRaw > 0.3 && capRaw < 1.2 ? capRaw : 0.7;
    out["--trim-top"] = `${fmt(-(lh / 2 + 0.345 - cap))}em`;
    out["--trim-bottom"] = `${fmt(-(lh / 2 - 0.345))}em`;
  }
  return out as CSSProperties;
}

const TYPO_KEYS = [
  "textStyle",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "lineHeight",
  "lineHeightPx",
  "letterSpacing",
  "textAlign",
  "uppercase",
  "textTransform",
  "italic",
  "underline",
  "decoration",
  "noWrap",
  "whiteSpace",
  "fontFeatures",
  "fontStretch",
  "textWrap",
  "hyphens",
] as const;
const hasTypography = (s: SceneStyle | undefined) =>
  !!s &&
  TYPO_KEYS.some(
    (k) =>
      (s[k] !== undefined && s[k] !== false && k !== "fontFamily") || (k === "fontFamily" && !!s.fontFamily),
  );

/**
 * Typography a frame passes down to its text (CSS inheritance): only keys the author set. Font family already comes
 * from visualStyle. Text elements re-apply their own preset sizes, so this mostly carries case / decoration / spacing.
 */
function inheritedTypography(s: SceneStyle): CSSProperties {
  const out: CSSProperties = {};
  if (s.fontSize !== undefined) out.fontSize = s.fontSize;
  if (s.fontWeight !== undefined) out.fontWeight = s.fontWeight;
  if (s.lineHeightPx !== undefined) out.lineHeight = `${fmt(s.lineHeightPx)}px`;
  else if (s.lineHeight !== undefined) out.lineHeight = s.lineHeight;
  if (s.letterSpacing !== undefined) out.letterSpacing = `${s.letterSpacing}em`;
  if (s.textAlign) out.textAlign = s.textAlign;
  if (s.hyphens) {
    out.hyphens = s.hyphens;
    (out as Record<string, unknown>).WebkitHyphens = s.hyphens;
  }
  if (s.textWrap) (out as Record<string, unknown>).textWrap = s.textWrap;
  return out;
}

function pickDefined(t: CSSProperties, s: SceneElement["style"]): CSSProperties {
  if (!s) return {};
  const out: CSSProperties = {};
  if (s.fontSize !== undefined || s.textStyle) out.fontSize = t.fontSize;
  if (s.fontWeight !== undefined || s.textStyle) out.fontWeight = t.fontWeight;
  if (s.textAlign) out.textAlign = t.textAlign;
  if (t.fontStyle) out.fontStyle = t.fontStyle;
  if (s.uppercase || s.textTransform) out.textTransform = t.textTransform;
  if (s.letterSpacing !== undefined) out.letterSpacing = t.letterSpacing;
  if (s.lineHeight !== undefined || s.lineHeightPx !== undefined) out.lineHeight = t.lineHeight;
  if (s.fontFamily) out.fontFamily = t.fontFamily;
  if (s.noWrap || s.whiteSpace) out.whiteSpace = t.whiteSpace;
  if (s.underline) {
    out.textDecoration = t.textDecoration;
    out.textUnderlineOffset = t.textUnderlineOffset;
  }
  if (s.decoration)
    for (const k of [
      "textDecorationLine",
      "textDecorationStyle",
      "textDecorationColor",
      "textDecorationThickness",
      "textUnderlineOffset",
    ] as const)
      if (t[k] !== undefined) (out as Record<string, unknown>)[k] = t[k];
  if (s.fontFeatures) out.fontFeatureSettings = t.fontFeatureSettings;
  if (s.fontStretch && t.fontStretch) out.fontStretch = t.fontStretch;
  if (s.textWrap) (out as Record<string, unknown>).textWrap = (t as Record<string, unknown>).textWrap;
  if (s.hyphens) {
    out.hyphens = t.hyphens;
    (out as Record<string, unknown>).WebkitHyphens = t.hyphens;
  }
  // never let an unset typography key shadow the same key from visualStyle (e.g. a frame's inherited fontFamily)
  for (const k of Object.keys(out) as (keyof CSSProperties)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Root style for the screen. */
export function rootStyle(width: number, height: number, tokens: SceneTokens): CSSProperties {
  return {
    position: "relative",
    width,
    height,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--t-background)",
    color: "var(--t-text)",
    fontFamily: "var(--t-font)",
    fontSize: 15,
    lineHeight: 1.45,
    colorScheme: tokens.theme,
  };
}
