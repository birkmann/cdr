// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// True vector SVG for DSL elements: vectors become <path>, frames <g> (+ background rect / clip), text <text>,
// images <image>. Shared attribute mapping (`vectorAttrs`) is also used by the live renderer and the code export.
import type { SceneElement, SceneTokens, SceneVector } from "@harness/protocol";
import { concreteColor } from "../dsl/tokens.js";
import { elementMatrix, fmt, rectSubpath, toPath, type Mat } from "./path.js";
import { booleanGroupVector } from "./booleanGroups.js";
import { regionFillPath } from "./regions.js";

/** SVG presentation attributes for a vector (colour refs resolved by `color`). Keys use SVG (kebab) names. */
export function vectorAttrs(
  v: SceneVector,
  color: (c: string) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = { d: v.path || "M0 0" };
  const fill = v.fill === null || v.fill === undefined ? undefined : color(v.fill);
  out.fill = fill ?? "none";
  if (v.fillRule === "evenodd") out["fill-rule"] = "evenodd";
  const stroke = v.stroke ? color(v.stroke) : undefined;
  if (stroke && (v.strokeWidth ?? 1) > 0) {
    out.stroke = stroke;
    out["stroke-width"] = fmt(v.strokeWidth ?? 1);
    if (v.strokeCap && v.strokeCap !== "butt") out["stroke-linecap"] = v.strokeCap;
    if (v.strokeJoin && v.strokeJoin !== "miter") out["stroke-linejoin"] = v.strokeJoin;
    if (v.dash?.length) out["stroke-dasharray"] = v.dash.map(fmt).join(" ");
  }
  return out;
}

/**
 * Paint layers of a vector: normally one path; with paint-bucket regions (`fillRegions`, PLAN 7.2) a fill-only path
 * of the filled faces under a stroke-only path of the whole geometry.
 */
export function vectorPaintLayers(
  v: SceneVector,
  color: (c: string) => string | undefined,
): Record<string, string>[] {
  const a = vectorAttrs(v, color);
  const fillD = regionFillPath(v);
  if (fillD === null) return [a];
  const layers: Record<string, string>[] = [];
  if (fillD && a.fill !== "none") layers.push({ d: fillD, fill: a.fill, "fill-rule": "evenodd" });
  if (a.stroke) {
    const stroke: Record<string, string> = { ...a, fill: "none" };
    delete stroke["fill-rule"];
    layers.push(stroke);
  }
  return layers;
}

/** React prop names for `vectorAttrs` keys. */
export const SVG_REACT_PROPS: Record<string, string> = {
  "fill-rule": "fillRule",
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-dasharray": "strokeDasharray",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrs = (a: Record<string, string>) =>
  Object.entries(a)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
const matrix = (m: Mat) => `matrix(${m.map(fmt).join(" ")})`;
const isIdentity = (m: Mat) =>
  m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

export interface SvgExportOptions {
  /** size of elements whose layout has no numeric size (DOM-measured), keyed by element id */
  measure?: (id: string) => { x: number; y: number; w: number; h: number } | undefined;
}

/** Standalone SVG document for an element subtree (the element itself sits at the origin, rotation kept). */
export function elementToSvg(el: SceneElement, tokens: SceneTokens, opts: SvgExportOptions = {}): string {
  const box = sizeOf(el, opts);
  const color = (c: string) => concreteColor(c, tokens, c.startsWith("$") ? "#000000" : c);
  const m = elementMatrix(
    0,
    0,
    box.w,
    box.h,
    el.layout?.rotation ?? 0,
    !!el.layout?.flipX,
    !!el.layout?.flipY,
  );
  // viewBox = rotated box (+ half the stroke so outer strokes are not cut)
  const pad = el.type === "vector" && el.vector?.stroke ? (el.vector.strokeWidth ?? 1) / 2 : 0;
  const corners = [
    [-pad, -pad],
    [box.w + pad, -pad],
    [box.w + pad, box.h + pad],
    [-pad, box.h + pad],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const x0 = Math.min(...corners.map((c) => c[0])),
    x1 = Math.max(...corners.map((c) => c[0]));
  const y0 = Math.min(...corners.map((c) => c[1])),
    y1 = Math.max(...corners.map((c) => c[1]));
  const w = x1 - x0,
    h = y1 - y0;
  const body = renderEl(el, color, opts, true);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}" height="${fmt(h)}" viewBox="${fmt(x0)} ${fmt(y0)} ${fmt(w)} ${fmt(h)}" fill="none">${body}</svg>`;
}

function sizeOf(el: SceneElement, opts: SvgExportOptions) {
  const l = el.layout ?? {};
  const measured = opts.measure?.(el.id);
  return {
    x: l.position === "absolute" ? (l.x ?? 0) : (measured?.x ?? 0),
    y: l.position === "absolute" ? (l.y ?? 0) : (measured?.y ?? 0),
    w: typeof l.width === "number" ? l.width : (measured?.w ?? 0),
    h: typeof l.height === "number" ? l.height : (measured?.h ?? 0),
  };
}

let clipSeq = 0;

function renderEl(
  el: SceneElement,
  color: (c: string) => string,
  opts: SvgExportOptions,
  isRoot = false,
): string {
  if (el.meta?.hidden === true) return "";
  const b = sizeOf(el, opts);
  const m = elementMatrix(
    isRoot ? 0 : b.x,
    isRoot ? 0 : b.y,
    b.w,
    b.h,
    el.layout?.rotation ?? 0,
    !!el.layout?.flipX,
    !!el.layout?.flipY,
  );
  const g: Record<string, string> = {};
  if (!isIdentity(m)) g.transform = matrix(m);
  const op = el.style?.opacity;
  if (op !== undefined && op < 1) g.opacity = fmt(op);
  if (el.mask) return ""; // masks are applied by the renderer; the standalone SVG draws masked content unmasked
  let inner = "";
  // a live boolean group draws its computed result (PLAN 7.3)
  switch (el.boolean ? "vector" : el.type) {
    case "vector": {
      const v = el.boolean
        ? booleanGroupVector(el, (c) => {
            const cb = sizeOf(c, opts);
            return cb.w > 0 || cb.h > 0 ? cb : null;
          })
        : el.vector;
      if (v?.path)
        inner = vectorPaintLayers(v, color)
          .map((l) => `<path${attrs(l)}/>`)
          .join("");
      break;
    }
    case "text": {
      const size = el.style?.fontSize ?? 16;
      inner = `<text x="0" y="${fmt(size * 0.95)}" font-size="${fmt(size)}" font-family="Inter, sans-serif"${el.style?.fontWeight ? ` font-weight="${el.style.fontWeight}"` : ""} fill="${esc(color(el.style?.color ?? "$text"))}">${esc(el.text ?? "")}</text>`;
      break;
    }
    case "image":
      if (el.image?.src)
        inner = `<image href="${esc(el.image.src)}" width="${fmt(b.w)}" height="${fmt(b.h)}" preserveAspectRatio="${el.style?.fit === "contain" ? "xMidYMid meet" : "xMidYMid slice"}"/>`;
      break;
    default: {
      const bg = el.style?.background ?? el.style?.gradient?.from;
      const r = el.style?.radius;
      const radii: [number, number, number, number] =
        r === undefined ? [0, 0, 0, 0] : typeof r === "number" ? [r, r, r, r] : r;
      const outline = toPath([rectSubpath(0, 0, b.w, b.h, radii)]);
      if (bg) inner += `<path d="${outline}" fill="${esc(color(bg))}"/>`;
      const kids = (el.children ?? []).map((c) => renderEl(c, color, opts)).join("");
      if (kids) {
        if (el.layout?.clip) {
          const id = `clip${++clipSeq}`;
          inner += `<clipPath id="${id}"><path d="${outline}"/></clipPath><g clip-path="url(#${id})">${kids}</g>`;
        } else inner += kids;
      }
      if (el.style?.border && el.style.border.width > 0)
        inner += `<path d="${outline}" fill="none" stroke="${esc(color(el.style.border.color))}" stroke-width="${fmt(el.style.border.width)}"${el.style.border.style === "dashed" ? ` stroke-dasharray="${fmt(el.style.border.width * 3)} ${fmt(el.style.border.width * 2)}"` : ""}/>`;
    }
  }
  if (!inner) return "";
  return Object.keys(g).length ? `<g${attrs(g)}>${inner}</g>` : inner;
}
