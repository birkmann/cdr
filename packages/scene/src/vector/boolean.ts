// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Boolean operations, flatten and outline stroke on vector geometry. Curves are flattened to polygons (0.25 px
// chord error by default) and combined with `polygon-clipping` (Martinez–Rueda sweep line, MIT); results are
// polygonal paths.
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from "polygon-clipping";
import type { SceneBooleanOp } from "@harness/protocol";
import { flatten, ringArea, type Subpath, type Vec2 } from "./path.js";

// the ESM build only has a default export (the typings declare named ones)
const { difference, intersection, union, xor } = polygonClipping;

export type BooleanOp = SceneBooleanOp;
export const BOOLEAN_LABELS: Record<BooleanOp, string> = {
  union: "Union",
  subtract: "Subtract",
  intersect: "Intersect",
  exclude: "Exclude",
};

export interface Shape {
  subs: Subpath[];
  fillRule?: "nonzero" | "evenodd";
}

const closeRing = (pts: Vec2[]): Ring => {
  const r: Ring = pts.map((p) => [p[0], p[1]]);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]))
    r.push([r[0][0], r[0][1]]);
  return r;
};

/** Filled area of a shape as a multipolygon (open subpaths are closed, like SVG fills them). */
export function shapeToPolygons(shape: Shape, tol = 0.25): MultiPolygon {
  const rings = flatten(shape.subs, tol)
    .map((f) => f.pts)
    .filter((p) => p.length >= 3);
  if (!rings.length) return [];
  const polys: Polygon[] = rings.map((r) => [closeRing(r)]);
  if (shape.fillRule === "evenodd") return polys.length === 1 ? [polys[0]] : xor(polys[0], ...polys.slice(1));
  // nonzero: rings wound like the largest one add area, rings wound the other way cut holes
  let largest = 0;
  for (let i = 1; i < rings.length; i++)
    if (Math.abs(ringArea(rings[i])) > Math.abs(ringArea(rings[largest]))) largest = i;
  const sign = Math.sign(ringArea(rings[largest])) || 1;
  const add: Polygon[] = [],
    cut: Polygon[] = [];
  rings.forEach((r, i) => (Math.sign(ringArea(r)) === sign || i === largest ? add : cut).push(polys[i]));
  const base = add.length === 1 ? [add[0]] : union(add[0], ...add.slice(1));
  return cut.length ? difference(base, ...cut) : base;
}

export function polygonsToSubpaths(mp: MultiPolygon): Subpath[] {
  const out: Subpath[] = [];
  for (const poly of mp)
    for (const ring of poly) {
      const pts = ring
        .slice(0, -1)
        .filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
      if (pts.length >= 3)
        out.push({ closed: true, points: simplifyCollinear(pts).map(([x, y]) => ({ x, y, corner: true })) });
    }
  return out;
}

/** Drop points that lie on the straight line between their neighbours (flattening artefacts on straight edges). */
function simplifyCollinear(pts: Ring): Ring {
  if (pts.length < 4) return pts;
  const out: Ring = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n],
      b = pts[i],
      c = pts[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    if (Math.abs(cross) / len > 1e-3) out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

/** Boolean of shapes in paint order (bottom first). Subtract removes every upper shape from the bottom one. */
export function booleanShapes(op: BooleanOp, shapes: Shape[], tol = 0.25): Subpath[] {
  const polys = shapes.map((s) => shapeToPolygons(s, tol)).filter((p) => p.length > 0);
  if (!polys.length) return [];
  if (polys.length === 1) return polygonsToSubpaths(polys[0]);
  const [first, ...rest] = polys;
  let mp: MultiPolygon;
  switch (op) {
    case "union":
      mp = union(first, ...rest);
      break;
    case "subtract":
      mp = difference(first, ...rest);
      break;
    case "intersect":
      mp = intersection(first, ...rest);
      break;
    case "exclude":
      mp = xor(first, ...rest);
      break;
  }
  return polygonsToSubpaths(mp);
}

/* ------------------------------------------------------------------ */
/* outline stroke                                                      */
/* ------------------------------------------------------------------ */

export interface StrokeOpts {
  width: number;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  miterLimit?: number;
  dash?: number[];
}

const circle = (c: Vec2, r: number, n = 20): Polygon => {
  const ring: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  ring.push(ring[0]);
  return [ring];
};

/** Split a polyline by a dash pattern (alternating on / off lengths). */
export function dashPolyline(pts: Vec2[], dash: number[]): Vec2[][] {
  const pattern = dash.filter((d) => d > 0);
  if (!pattern.length || pts.length < 2) return [pts];
  const full = pattern.length % 2 ? [...pattern, ...pattern] : pattern;
  const out: Vec2[][] = [];
  let idx = 0,
    left = full[0],
    on = true;
  let cur: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (seg > left) {
      const t = left / seg;
      const m: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (on) {
        cur.push(m);
        out.push(cur);
      }
      cur = [m];
      seg -= left;
      a = m;
      idx = (idx + 1) % full.length;
      left = full[idx];
      on = !on;
    }
    left -= seg;
    if (on) cur.push(b);
    else cur = [b];
  }
  if (on && cur.length > 1) out.push(cur);
  return out;
}

/** Filled outline of a stroke (centre-aligned), as polygons in the path's coordinates. */
export function outlineStroke(subs: Subpath[], opts: StrokeOpts, tol = 0.2): Subpath[] {
  const hw = Math.max(0.01, opts.width / 2);
  const cap = opts.cap ?? "butt",
    join = opts.join ?? "miter",
    miterLimit = opts.miterLimit ?? 4;
  const pieces: Polygon[] = [];
  for (const f of flatten(subs, tol)) {
    let lines: Array<{ pts: Vec2[]; closed: boolean }> = [{ pts: f.pts, closed: f.closed }];
    if (opts.dash?.some((d) => d > 0)) {
      const pts = f.closed && f.pts.length ? [...f.pts, f.pts[0]] : f.pts;
      lines = dashPolyline(pts, opts.dash).map((p) => ({ pts: p, closed: false }));
    }
    for (const line of lines) strokePolyline(line.pts, line.closed, hw, cap, join, miterLimit, pieces);
  }
  if (!pieces.length) return [];
  return polygonsToSubpaths(union(pieces[0], ...pieces.slice(1)));
}

function strokePolyline(
  raw: Vec2[],
  closed: boolean,
  hw: number,
  cap: string,
  join: string,
  miterLimit: number,
  out: Polygon[],
) {
  const pts = raw.filter((p, i) => i === 0 || Math.hypot(p[0] - raw[i - 1][0], p[1] - raw[i - 1][1]) > 1e-6);
  if (pts.length < 2) {
    if (pts.length === 1 && cap === "round") out.push(circle(pts[0], hw));
    return;
  }
  const n = pts.length;
  const segCount = closed ? n : n - 1;
  const normal = (a: Vec2, b: Vec2): Vec2 => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  for (let i = 0; i < segCount; i++) {
    let a = pts[i];
    let b = pts[(i + 1) % n];
    const [nx, ny] = normal(a, b);
    if (!closed && cap === "square") {
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        l = Math.hypot(dx, dy) || 1;
      if (i === 0) a = [a[0] - (dx / l) * hw, a[1] - (dy / l) * hw];
      if (i === segCount - 1) b = [b[0] + (dx / l) * hw, b[1] + (dy / l) * hw];
    }
    out.push([
      [
        [a[0] + nx * hw, a[1] + ny * hw],
        [b[0] + nx * hw, b[1] + ny * hw],
        [b[0] - nx * hw, b[1] - ny * hw],
        [a[0] - nx * hw, a[1] - ny * hw],
        [a[0] + nx * hw, a[1] + ny * hw],
      ],
    ]);
  }
  // joins at interior vertices (every vertex of a closed polyline)
  const first = closed ? 0 : 1,
    last = closed ? n - 1 : n - 2;
  for (let i = first; i <= last; i++) {
    const p = pts[i],
      prev = pts[(i - 1 + n) % n],
      next = pts[(i + 1) % n];
    const n1 = normal(prev, p),
      n2 = normal(p, next);
    const cross = (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]);
    if (Math.abs(cross) < 1e-9) continue;
    // outer side of the turn
    const s = cross > 0 ? -1 : 1;
    const o1: Vec2 = [p[0] + n1[0] * hw * s, p[1] + n1[1] * hw * s],
      o2: Vec2 = [p[0] + n2[0] * hw * s, p[1] + n2[1] * hw * s];
    if (join === "round") {
      out.push(circle(p, hw));
      continue;
    }
    const cosT = n1[0] * n2[0] + n1[1] * n2[1];
    const miterLen = 1 / Math.sqrt(Math.max(1e-9, (1 + cosT) / 2));
    if (join === "miter" && miterLen <= miterLimit) {
      const mx = n1[0] + n2[0],
        my = n1[1] + n2[1],
        ml = Math.hypot(mx, my) || 1;
      const tip: Vec2 = [p[0] + (mx / ml) * hw * miterLen * s, p[1] + (my / ml) * hw * miterLen * s];
      out.push([[p, o1, tip, o2, p]]);
    } else out.push([[p, o1, o2, p]]);
  }
  if (!closed && cap === "round") {
    out.push(circle(pts[0], hw));
    out.push(circle(pts[n - 1], hw));
  }
}
