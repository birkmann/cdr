// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Fluid web layout (docs/responsive.md "Fluid CSS"), shared by the live renderer (SceneRenderer) and the exporter
// (export/fromDsl) so both reflow a page rendered at a width other than its design width the same way. A web page's
// root is the viewport; layers the converter marked fluid follow it. Flow children with width 'fill' stretch through
// flexbox already; absolute ones carry `layout.constraints` (Figma semantics) and are re-expressed against their
// parent's padding box here. At the design width every rule resolves to the captured px.
// The "viewport" is a length: `100vw` in an exported page, `100cqw` in the renderer (the screen root is the size
// container there, SceneRenderer.module.css `.fluid`), so a band spans the screen and not the browser window.
// Every style value is a string under a key that reads the same as a React style and as a CSS property
// (left / right / top / bottom / width / height / zoom), so both sides merge the same object.
import type { SceneElement, SceneLayout, SceneScreen } from "@harness/protocol";
import { CONTAINER_TYPES, directionOf, type Dir } from "./styles.js";
import { isRemoved } from "./hiddenLayers.js";

/** Do the screen's layers follow the viewport (web pages) or keep their design px (app screens)? */
export const isFluidScreen = (screen: Pick<SceneScreen, "platform">) => screen.platform === "web";

export interface FluidPage {
  /** design width of the screen (the root's box) */
  width?: number;
  height?: number;
  /** the viewport width as a CSS length: '100vw' (default, exported pages) or '100cqw' (renderer) */
  vw?: string;
}

/**
 * An element as its children's parent, at the design width: padding box (absolute children's containing block) and
 * content box widths (`padH`: padding box height); whether its width follows the viewport (`fluid`) and its centre
 * stays on the viewport's (`vc`). Only primitives, so a renderer can compare boxes by value (memoised children).
 * `has` = there is a parent element; `dir` / `flow` / `pl` / `pr` / `align` / `justify` / `grid` describe it;
 * `clipH` = the height its children are clipped to (root, `layout.clip`); `bleed` = a stretched full-bleed band.
 */
export interface FluidBox {
  pad: number | null;
  content: number | null;
  padH?: number | null;
  fluid?: boolean;
  vc?: boolean;
  bleed?: boolean;
  has?: boolean;
  dir?: Dir;
  flow?: number;
  pl?: number;
  pr?: number;
  align?: SceneLayout["align"];
  justify?: SceneLayout["justify"];
  grid?: boolean;
  clipH?: number;
}
export const NO_BOX: FluidBox = { pad: null, content: null };

export type FluidStyle = Record<string, string>;

export const pad4 = (p: SceneLayout["padding"]): [number, number, number, number] =>
  p === undefined
    ? [0, 0, 0, 0]
    : typeof p === "number"
      ? [p, p, p, p]
      : p.length === 2
        ? [p[0], p[1], p[0], p[1]]
        : [p[0], p[1], p[2], p[3]];
const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;
const near = (a: number, b: number) => Math.abs(a - b) <= 1;
/** `calc(<base> - <d>px)` (a negative `d` as `+`) */
const minus = (base: string, d: number) => `calc(${base} ${d < 0 ? "+" : "-"} ${px(Math.abs(d))})`;

/**
 * Fluid CSS for one element (merged over its elementStyle) and its box as the parent of its children. `parent` is
 * the box its own parent returned (NO_BOX for children rendered outside the flex flow, e.g. a navbar's lead icon).
 */
export function fluidLayout(
  dsl: SceneElement,
  parentDir: Dir,
  parent: FluidBox,
  page: FluidPage,
  isRoot = false,
): { style: FluidStyle; box: FluidBox } {
  const width = isRoot ? (page.width ?? null) : ownWidth(dsl, parentDir, parent);
  const t: { fluid: boolean; vc: boolean; bleed?: boolean } = isRoot
    ? { fluid: true, vc: true }
    : tracking(dsl, width, parent);
  let style: FluidStyle = {};
  if (!isRoot) {
    const bleed = t.vc && !t.fluid ? fullBleedStyle(dsl, width, parent, page) : spanStyle(dsl, width, parent);
    style = { ...fluidStyle(dsl, parent.pad, parent.padH), ...bleed };
    // a stretched band: its children that span it stretch too (the converter never visited it)
    if (bleed.width) {
      t.fluid = true;
      t.bleed = true;
    }
  }
  const l = dsl.layout ?? {};
  const pp = pad4(l.padding);
  const height = isRoot ? (page.height ?? null) : typeof l.height === "number" ? l.height : null;
  const clipH = isRoot ? page.height : l.clip && typeof l.height === "number" ? l.height : undefined;
  const box: FluidBox = {
    ...boxOf(dsl, width, height),
    ...t,
    has: true,
    dir: directionOf(dsl),
    flow: (dsl.children ?? []).filter((c) => c.layout?.position !== "absolute" && !isRemoved(c)).length,
    pl: pp[3],
    pr: pp[1],
    align: l.align,
    justify: l.justify,
    grid: !!l.grid,
    clipH,
  };
  for (const k of Object.keys(box) as (keyof FluidBox)[]) if (box[k] === undefined) delete box[k];
  return { style, box };
}

/** An absolute layer wholly above / below a clipping parent: never visible at any width (closed modals, off-canvas). */
export function clippedOut(c: SceneElement, parent: FluidBox): boolean {
  const l = c.layout;
  return (
    typeof parent.clipH === "number" &&
    l?.position === "absolute" &&
    typeof l.y === "number" &&
    typeof l.height === "number" &&
    !l.rotation &&
    !c.mask &&
    (l.y + l.height <= 0 || l.y >= parent.clipH)
  );
}

/** Below the design width the screen root is scaled down to the viewport (export/responsive.ts fitZoomCss). */
export const fitZoom = (page: FluidPage): string | undefined => {
  const w = Math.round(page.width ?? 0);
  return w > 0 ? `min(1, calc(${page.vw ?? "100vw"} / ${w}px))` : undefined;
};

/** Border-box width at the design width (null when it depends on content). */
function ownWidth(dsl: SceneElement, parentDir: Dir, parent: FluidBox): number | null {
  const w = dsl.layout?.width;
  if (typeof w === "number") return w;
  if (w !== "fill" || dsl.layout?.position === "absolute" || parent.content === null) return null;
  // the converter only fills the cross axis of a column (or a row's single flow child): the parent's content width
  const m = pad4(dsl.layout?.margin);
  return parentDir === "column" || parentDir === "row" ? parent.content - m[1] - m[3] : null;
}

function boxOf(dsl: SceneElement, width: number | null, height: number | null): FluidBox {
  if (width === null && height === null) return NO_BOX;
  const s = dsl.style ?? {};
  const side = (k: "left" | "right" | "top" | "bottom") => {
    const b = s.borders?.[k];
    if (b && typeof b === "object") return Math.max(0, b.width || 0);
    if (s.border && (!s.border.sides?.length || s.border.sides.includes(k)))
      return Math.max(0, s.border.width || 0);
    return !s.border && !s.borders && dsl.type === "card" ? 1 : 0;
  };
  const padH = height === null ? null : height - side("top") - side("bottom");
  if (width === null) return { pad: null, content: null, padH };
  const pad = width - side("left") - side("right");
  const p = dsl.layout?.grid || CONTAINER_TYPES.has(dsl.type) ? pad4(dsl.layout?.padding) : [0, 0, 0, 0];
  return { pad, content: pad - Math.max(0, p[1]) - Math.max(0, p[3]), padH };
}

/** Does the element's width follow the viewport (`fluid`), does its centre stay on the viewport's centre (`vc`)? */
function tracking(dsl: SceneElement, w: number | null, p: FluidBox): { fluid: boolean; vc: boolean } {
  const l = dsl.layout ?? {};
  const abs = l.position === "absolute";
  const fluid = !!p.fluid && (abs ? l.constraints?.horizontal === "left-right" : l.width === "fill");
  if (!p.vc || !p.has || p.pad === null) return { fluid, vc: false };
  if (abs) {
    const h = l.constraints?.horizontal;
    const centred = w !== null && l.x !== undefined && near(l.x + w / 2, p.pad / 2);
    return { fluid, vc: centred && (h === "left-right" || h === "center" || !p.fluid) };
  }
  const pl = p.pl ?? 0,
    pr = p.pr ?? 0,
    m = pad4(l.margin);
  if (p.grid || !near(pr, pl) || !near(m[1], m[3])) return { fluid, vc: false };
  const single = p.dir === "column" || p.flow === 1;
  if (!single) return { fluid, vc: false };
  if (l.width === "fill") return { fluid, vc: true };
  const how = p.dir === "column" ? (l.alignSelf ?? p.align) : p.justify;
  if (how === "center") return { fluid, vc: true };
  // a fixed parent keeps a start / end placed child where it was: centred iff it was centred
  if (p.fluid || w === null || (p.dir === "row" && how !== undefined && how !== "start" && how !== "end"))
    return { fluid, vc: false };
  const x = how === "end" ? p.pad - pr - m[1] - w : pl + m[3];
  return { fluid, vc: near(x + w / 2, p.pad / 2) };
}

/**
 * A layer as wide as the page and centred on it (a full-bleed band inside a centred content column: CSS breakouts)
 * keeps reaching both viewport edges when the viewport is wider: `max(<design width>, 100vw)`, centred like before.
 */
function fullBleedStyle(dsl: SceneElement, w: number | null, p: FluidBox, page: FluidPage): FluidStyle {
  if (w === null || !page.width || w < page.width - 1 || !p.has) return {};
  const full = `max(${px(w)}, ${page.vw ?? "100vw"})`;
  if (dsl.layout?.position === "absolute") return { left: `calc(50% - ${full} / 2)`, width: full };
  // flow: only where flexbox itself centres it (an overflowing centred item overflows both sides evenly)
  const how = p.dir === "column" ? (dsl.layout?.alignSelf ?? p.align) : p.flow === 1 ? p.justify : undefined;
  return how === "center" ? { width: full } : {};
}

/**
 * Inside a full-bleed band: a child spanning it (±1 px, no side margins) stretches with it; an absolute one also when
 * it overhangs both edges (a gradient / shadow layer at −24 px) — its insets are kept like the converter's backgrounds.
 */
function spanStyle(dsl: SceneElement, w: number | null, p: FluidBox): FluidStyle {
  if (!p.bleed || w === null || p.pad === null || p.content === null || !p.has || dsl.layout?.rotation)
    return {};
  const l = dsl.layout ?? {};
  if (l.position === "absolute")
    return l.x !== undefined && l.x <= 1 && l.x + w >= p.pad - 1
      ? { left: px(l.x), right: px(p.pad - l.x - w), width: "auto" }
      : {};
  const m = pad4(l.margin);
  return near(w, p.content) && !m[1] && !m[3] && !p.grid && (p.dir === "column" || p.flow === 1)
    ? { width: "100%" }
    : {};
}

/**
 * CSS for an absolute layer's constraints inside a parent padding box `P` × `PH` px (at the design width). Horizontal:
 * `left-right` → left + right insets (width auto), `center` → offset from the centre, `right` → right inset,
 * `scale` → percentages. Vertical the same with top / bottom / height (`PH` unknown → stays top-pinned). A hug-sized
 * layer (text) keeps its own size, so `right` / `bottom` move its near edge with the parent's far edge instead.
 */
export function fluidStyle(dsl: SceneElement, P: number | null, PH: number | null = null): FluidStyle {
  const l = dsl.layout;
  if (!l || l.position !== "absolute" || !l.constraints) return {};
  const out: FluidStyle = {};
  const h = l.constraints.horizontal,
    v = l.constraints.vertical;
  const w = typeof l.width === "number" ? l.width : null,
    hh = typeof l.height === "number" ? l.height : null;
  if (h && h !== "left" && P !== null && l.x !== undefined) {
    const x = l.x;
    switch (h) {
      case "left-right":
        if (w !== null) Object.assign(out, { left: px(x), right: px(P - x - w), width: "auto" });
        break;
      case "right":
        Object.assign(
          out,
          w !== null ? { left: "auto", right: px(P - x - w) } : { left: minus("100%", P - x) },
        );
        break;
      case "center":
        out.left = minus("50%", P / 2 - x);
        break;
      case "scale":
        if (w !== null && P > 0)
          Object.assign(out, { left: `${(x / P) * 100}%`, width: `${(w / P) * 100}%` });
        break;
    }
  }
  if (v && v !== "top" && PH !== null && l.y !== undefined) {
    const y = l.y;
    switch (v) {
      case "top-bottom":
        if (hh !== null) Object.assign(out, { top: px(y), bottom: px(PH - y - hh), height: "auto" });
        break;
      case "bottom":
        Object.assign(
          out,
          hh !== null ? { top: "auto", bottom: px(PH - y - hh) } : { top: minus("100%", PH - y) },
        );
        break;
      case "center":
        out.top = minus("50%", PH / 2 - y);
        break;
      case "scale":
        if (hh !== null && PH > 0)
          Object.assign(out, { top: `${(y / PH) * 100}%`, height: `${(hh / PH) * 100}%` });
        break;
    }
  }
  return out;
}
