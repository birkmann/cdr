// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// DSL element ⇄ vector geometry: outlines of elements in parent coordinates (for booleans / flatten / masks),
// vector elements from geometry, resize scaling, and freehand (pencil) smoothing.
import type { SceneElement, SceneVector } from "@harness/protocol";
import { newElementId } from "../dsl/tree.js";
import {
  elementMatrix,
  rebox,
  rectSubpath,
  scale,
  toPath,
  transformSubpaths,
  vectorFields,
  vectorSubpaths,
  type Anchor,
  type Bounds,
  type Subpath,
  type Vec2,
} from "./path.js";
import { booleanShapes, type Shape } from "./boolean.js";

export interface ElementBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Box of an element from its own layout (absolute + numeric size), or null when only the DOM knows it. */
export function layoutBox(el: SceneElement): ElementBox | null {
  const l = el.layout;
  if (!l || typeof l.width !== "number" || typeof l.height !== "number") return null;
  return {
    x: l.position === "absolute" ? (l.x ?? 0) : 0,
    y: l.position === "absolute" ? (l.y ?? 0) : 0,
    w: l.width,
    h: l.height,
  };
}

const radii4 = (
  r: number | [number, number, number, number] | undefined,
): [number, number, number, number] =>
  r === undefined ? [0, 0, 0, 0] : typeof r === "number" ? [r, r, r, r] : r;

/** Box of a child element in its parent's coordinates (static layout, or a DOM measurement). */
export type BoxOf = (el: SceneElement) => ElementBox | null;

/** Local (unrotated, 0..w × 0..h) outline of an element. A live boolean group gives its combined outline. */
export function localOutline(el: SceneElement, w: number, h: number, boxOf: BoxOf = layoutBox): Subpath[] {
  if (el.boolean) return booleanGroupSubpaths(el, boxOf);
  if (el.type === "vector" && el.vector) return vectorSubpaths(el.vector);
  const r = el.type === "avatar" ? 9999 : el.style?.radius;
  return [rectSubpath(0, 0, w, h, radii4(r))];
}

/** Outline of an element in its parent's coordinates (rotation / flip applied). */
export function elementShape(el: SceneElement, box: ElementBox, boxOf: BoxOf = layoutBox): Shape {
  const m = elementMatrix(
    box.x,
    box.y,
    box.w,
    box.h,
    el.layout?.rotation ?? 0,
    !!el.layout?.flipX,
    !!el.layout?.flipY,
  );
  return {
    subs: transformSubpaths(localOutline(el, box.w, box.h, boxOf), m),
    fillRule: el.boolean ? "nonzero" : el.vector?.fillRule,
  };
}

/**
 * Combined outline of a live boolean group (PLAN 7.3) in the group's own coordinates (= its children's parent
 * space): the visible operands in paint order, nested groups resolved recursively. Operands without a box are skipped.
 */
export function booleanGroupSubpaths(el: SceneElement, boxOf: BoxOf = layoutBox): Subpath[] {
  if (!el.boolean) return [];
  const shapes: Shape[] = [];
  for (const c of el.children ?? []) {
    if (c.meta?.hidden === true) continue;
    const b = boxOf(c);
    if (b) shapes.push(elementShape(c, b, boxOf));
  }
  return booleanShapes(el.boolean.op, shapes);
}

/** Paint of a boolean group's result: own vector paint, else own fill / border, else the bottom operand's paint. */
export function booleanGroupPaint(
  el: SceneElement,
): Pick<SceneVector, "fill" | "stroke" | "strokeWidth" | "strokeCap" | "strokeJoin" | "dash"> {
  if (el.vector) {
    const { fill, stroke, strokeWidth, strokeCap, strokeJoin, dash } = el.vector;
    return { fill, stroke, strokeWidth, strokeCap, strokeJoin, dash };
  }
  const s = el.style;
  if (s?.background || s?.border) {
    return {
      fill: s.background ?? null,
      ...(s.border
        ? {
            stroke: s.border.color,
            strokeWidth: s.border.width,
            ...(s.border.style === "dashed" ? { dash: [s.border.width * 3, s.border.width * 2] } : {}),
          }
        : {}),
    };
  }
  const first = (el.children ?? []).find((c) => c.meta?.hidden !== true);
  return first ? paintOf(first) : { fill: "$surfaceAlt" };
}

/** Paint of an element when it becomes a vector (booleans / flatten keep the bottom operand's look). */
export function paintOf(
  el: SceneElement,
): Pick<SceneVector, "fill" | "stroke" | "strokeWidth" | "strokeCap" | "strokeJoin" | "dash"> {
  if (el.boolean) return booleanGroupPaint(el);
  if (el.type === "vector" && el.vector) {
    const { fill, stroke, strokeWidth, strokeCap, strokeJoin, dash } = el.vector;
    return { fill, stroke, strokeWidth, strokeCap, strokeJoin, dash };
  }
  const s = el.style ?? {};
  const fill =
    s.background ?? s.gradient?.from ?? (el.type === "text" ? (s.color ?? "$text") : "$surfaceAlt");
  return {
    fill,
    ...(s.border
      ? {
          stroke: s.border.color,
          strokeWidth: s.border.width,
          ...(s.border.style === "dashed" ? { dash: [s.border.width * 3, s.border.width * 2] } : {}),
        }
      : {}),
  };
}

/** A new absolute vector element from geometry in parent coordinates. */
export function vectorElement(
  subs: Subpath[],
  paint: Partial<SceneVector>,
  opts: { name?: string; fillRule?: SceneVector["fillRule"]; style?: SceneElement["style"] } = {},
): SceneElement {
  const { box, local } = rebox(subs);
  const vector: SceneVector = { ...vectorFields(local), ...paint };
  if (opts.fillRule) vector.fillRule = opts.fillRule;
  for (const k of Object.keys(vector) as Array<keyof SceneVector>)
    if (vector[k] === undefined) delete vector[k];
  return {
    id: newElementId("vector"),
    type: "vector",
    name: opts.name ?? "Vector",
    layout: {
      position: "absolute",
      x: round(box.x),
      y: round(box.y),
      width: round(box.w),
      height: round(box.h),
    },
    ...(opts.style ? { style: opts.style } : {}),
    vector: offsetFraction(vector, box),
  };
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Rounding the box to 0.01 would shift the path by up to 0.005; negligible, but keep the geometry exact. */
function offsetFraction(v: SceneVector, box: Bounds): SceneVector {
  const dx = box.x - round(box.x),
    dy = box.y - round(box.y);
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return v;
  const subs = transformSubpaths(vectorSubpaths(v), [1, 0, 0, 1, dx, dy]);
  return { ...v, ...vectorFields(subs) };
}

/** Scale a vector's geometry (element resized from w0×h0 to w1×h1). */
export function scaleVector(v: SceneVector, sx: number, sy: number): SceneVector {
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || (sx === 1 && sy === 1)) return v;
  const subs = transformSubpaths(vectorSubpaths(v), scale(sx, sy));
  const out: SceneVector = { ...v, ...vectorFields(subs) };
  if (!out.points) delete out.points;
  if (out.closed === undefined) delete out.closed;
  return out;
}

/* ------------------------------------------------------------------ */
/* pencil                                                              */
/* ------------------------------------------------------------------ */

/** Ramer–Douglas–Peucker polyline simplification. */
export function simplifyPolyline(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a],
      [bx, by] = pts[b];
    const dx = bx - ax,
      dy = by - ay;
    const len = Math.hypot(dx, dy);
    let best = -1,
      bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d =
        len < 1e-9 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Smooth open path through `pts` (Catmull-Rom → cubic bezier anchors with mirrored handles). */
export function smoothThrough(pts: Vec2[], closed = false): Subpath {
  const n = pts.length;
  const at = (i: number): Vec2 => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const points: Anchor[] = pts.map(([x, y], i) => {
    if (n < 3 || (!closed && (i === 0 || i === n - 1))) {
      const a: Anchor = { x, y };
      if (n >= 3 && !closed) {
        // end handles point a third of the way toward the neighbour
        const o = i === 0 ? at(1) : at(n - 2);
        const h: Vec2 = [x + (o[0] - x) / 3, y + (o[1] - y) / 3];
        if (i === 0) a.out = h;
        else a.in = h;
      }
      return a;
    }
    const p0 = at(i - 1),
      p2 = at(i + 1);
    const tx = (p2[0] - p0[0]) / 6,
      ty = (p2[1] - p0[1]) / 6;
    return { x, y, in: [x - tx, y - ty], out: [x + tx, y + ty] };
  });
  return { closed, points };
}

/** Freehand stroke → smooth vector geometry (`tol` in the same units as the points). */
export function pencilPath(raw: Vec2[], tol = 1.5): Subpath | null {
  const pts = raw.filter((p, i) => i === 0 || Math.hypot(p[0] - raw[i - 1][0], p[1] - raw[i - 1][1]) > 0.01);
  if (pts.length < 2) return null;
  const simple = simplifyPolyline(pts, tol);
  if (simple.length === 2) return { closed: false, points: simple.map(([x, y]) => ({ x, y, corner: true })) };
  return smoothThrough(simple);
}

/** Path data for a vector's subpaths (helper for callers that hold subpaths). */
export const pathOf = (subs: Subpath[]) => toPath(subs);

/**
 * Re-box edited geometry. `local` is in the element's current local frame (0..w × 0..h of `layout`); returns the
 * new layout (position shifted so that, with the element's rotation / flips, nothing moves on screen) and the
 * geometry in the new local frame.
 */
export function rebaseVector(
  layout: SceneElement["layout"],
  w: number,
  h: number,
  local: Subpath[],
): { layout: NonNullable<SceneElement["layout"]>; fields: Pick<SceneVector, "path" | "points" | "closed"> } {
  const l = layout ?? {};
  const { box, local: rebased } = rebox(local);
  const out: NonNullable<SceneElement["layout"]> = { ...l, width: round(box.w), height: round(box.h) };
  if (l.position === "absolute") {
    // centre shift in local space → parent space through rotation / flips
    const m = elementMatrix(0, 0, w, h, l.rotation ?? 0, !!l.flipX, !!l.flipY);
    const sx = box.x + box.w / 2 - w / 2,
      sy = box.y + box.h / 2 - h / 2;
    const shiftX = m[0] * sx + m[2] * sy,
      shiftY = m[1] * sx + m[3] * sy;
    out.x = round((l.x ?? 0) + w / 2 + shiftX - box.w / 2);
    out.y = round((l.y ?? 0) + h / 2 + shiftY - box.h / 2);
    // keep sub-0.01 rounding out of the geometry
    const dx = (l.x ?? 0) + w / 2 + shiftX - box.w / 2 - out.x,
      dy = (l.y ?? 0) + h / 2 + shiftY - box.h / 2 - out.y;
    if (!l.rotation && !l.flipX && !l.flipY && (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9))
      return { layout: out, fields: vectorFields(transformSubpaths(rebased, [1, 0, 0, 1, dx, dy])) };
  }
  return { layout: out, fields: vectorFields(rebased) };
}

/** Uniformly scale an element subtree (positions, sizes, vector geometry, stroke widths, font sizes, radii). */
export function scaleTree(el: SceneElement, k: number): SceneElement {
  const l = el.layout;
  const sc = (v: number | undefined) => (v === undefined ? undefined : round(v * k));
  const out: SceneElement = { ...el };
  if (l) {
    out.layout = { ...l };
    if (l.x !== undefined) out.layout.x = sc(l.x);
    if (l.y !== undefined) out.layout.y = sc(l.y);
    if (typeof l.width === "number") out.layout.width = sc(l.width);
    if (typeof l.height === "number") out.layout.height = sc(l.height);
  }
  if (el.vector) {
    const v = scaleVector(el.vector, k, k);
    out.vector = {
      ...v,
      ...(v.strokeWidth !== undefined ? { strokeWidth: round(v.strokeWidth * k) } : {}),
      ...(v.dash ? { dash: v.dash.map((d) => round(d * k)) } : {}),
    };
  }
  if (el.style) {
    const st = { ...el.style };
    if (st.fontSize !== undefined) st.fontSize = sc(st.fontSize);
    if (typeof st.radius === "number") st.radius = sc(st.radius);
    else if (Array.isArray(st.radius))
      st.radius = st.radius.map((r) => round(r * k)) as [number, number, number, number];
    if (st.border) st.border = { ...st.border, width: round(st.border.width * k) };
    out.style = st;
  }
  if (el.children) out.children = el.children.map((c) => scaleTree(c, k));
  return out;
}
