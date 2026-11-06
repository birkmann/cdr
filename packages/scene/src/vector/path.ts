// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Vector path model + math (pure, no DOM). A path is a list of subpaths; each subpath is a list of anchors with
// optional absolute bezier handles (`in` = control point before the anchor, `out` = after it). This is the editable
// form of `SceneVector.points` (one subpath) and the canonical form every SVG path `d` is parsed into (all commands,
// relative or absolute, arcs and quadratics become cubic anchors).
import type { SceneMirror, SceneVector } from "@harness/protocol";

export type Vec2 = [number, number];
export interface Pt {
  x: number;
  y: number;
}
export interface Anchor {
  x: number;
  y: number;
  in?: Vec2;
  out?: Vec2;
  corner?: boolean;
  mirror?: SceneMirror;
}
export interface Subpath {
  points: Anchor[];
  closed: boolean;
}
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

const EPS = 1e-9;
export const fmt = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

/* ------------------------------------------------------------------ */
/* parse                                                               */
/* ------------------------------------------------------------------ */

const NUM_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

/** Scanner aware of arc flags, which may be packed without separators ("a5 5 0 015 5"). */
function tokenize(d: string): Array<string | number> {
  const out: Array<string | number> = [];
  let i = 0;
  let cmd = "";
  let argIndex = 0;
  while (i < d.length) {
    const ch = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      out.push(ch);
      cmd = ch;
      argIndex = 0;
      i++;
      continue;
    }
    if (/[\s,]/.test(ch)) {
      i++;
      continue;
    }
    if (
      (cmd === "a" || cmd === "A") &&
      (argIndex % 7 === 3 || argIndex % 7 === 4) &&
      (ch === "0" || ch === "1")
    ) {
      out.push(ch === "1" ? 1 : 0);
      argIndex++;
      i++;
      continue;
    }
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(d);
    if (!m) {
      i++;
      continue;
    }
    out.push(Number(m[0]));
    argIndex++;
    i = NUM_RE.lastIndex;
  }
  return out;
}

/** Endpoint arc → cubic segments (SVG implementation notes F.6). Returns control triples [c1, c2, end]. */
export function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phiDeg: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Array<[Vec2, Vec2, Vec2]> {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2))
    return [
      [
        [x1, y1],
        [x2, y2],
        [x2, y2],
      ],
    ];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi),
    sin = Math.sin(phi);
  const dx = (x1 - x2) / 2,
    dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy,
    y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cxp = (k * rx * y1p) / ry,
    cyp = (-k * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-7));
  const step = dt / n;
  const alpha = (4 / 3) * Math.tan(step / 4);
  const out: Array<[Vec2, Vec2, Vec2]> = [];
  const pt = (t: number): Vec2 => {
    const ex = rx * Math.cos(t),
      ey = ry * Math.sin(t);
    return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy];
  };
  const der = (t: number): Vec2 => {
    const ex = -rx * Math.sin(t),
      ey = ry * Math.cos(t);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  for (let i = 0; i < n; i++) {
    const a = t1 + i * step,
      b = a + step;
    const p0 = pt(a),
      p3 = i === n - 1 ? ([x2, y2] as Vec2) : pt(b);
    const d0 = der(a),
      d1 = der(b);
    out.push([
      [p0[0] + alpha * d0[0], p0[1] + alpha * d0[1]],
      [p3[0] - alpha * d1[0], p3[1] - alpha * d1[1]],
      p3,
    ]);
  }
  return out;
}

/** Parse SVG path data into subpaths (every segment becomes a cubic or a straight line). */
export function parsePath(d: string): Subpath[] {
  const toks = tokenize(d);
  const subs: Subpath[] = [];
  let cur: Subpath | null = null;
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0;
  let prevCtrl: Vec2 | null = null;
  let prevQuad: Vec2 | null = null;
  let i = 0;
  let cmd = "";
  const num = () => {
    const v = toks[i];
    if (typeof v !== "number") throw new Error("bad path");
    i++;
    return v;
  };
  const flag = () => num() !== 0;
  const start = () => {
    if (!cur) {
      cur = { points: [{ x, y }], closed: false };
      subs.push(cur);
    }
    return cur;
  };
  const lineTo = (nx: number, ny: number) => {
    const s = start();
    s.points.push({ x: nx, y: ny });
    x = nx;
    y = ny;
  };
  const cubicTo = (c1: Vec2, c2: Vec2, nx: number, ny: number) => {
    const s = start();
    const last = s.points[s.points.length - 1];
    last.out = c1;
    s.points.push({ x: nx, y: ny, in: c2 });
    x = nx;
    y = ny;
  };
  try {
    while (i < toks.length) {
      const t = toks[i];
      if (typeof t === "string") {
        cmd = t;
        i++;
      } else if (!cmd) throw new Error("bad path");
      const rel = cmd === cmd.toLowerCase();
      const ox = rel ? x : 0,
        oy = rel ? y : 0;
      let ctrl: Vec2 | null = null;
      let quad: Vec2 | null = null;
      switch (cmd.toUpperCase()) {
        case "M": {
          const nx = num() + ox,
            ny = num() + oy;
          x = nx;
          y = ny;
          sx = nx;
          sy = ny;
          cur = { points: [{ x, y }], closed: false };
          subs.push(cur);
          cmd = rel ? "l" : "L";
          break;
        }
        case "L":
          lineTo(num() + ox, num() + oy);
          break;
        case "H":
          lineTo(num() + (rel ? x : 0), y);
          break;
        case "V":
          lineTo(x, num() + (rel ? y : 0));
          break;
        case "C": {
          const c1: Vec2 = [num() + ox, num() + oy],
            c2: Vec2 = [num() + ox, num() + oy];
          cubicTo(c1, c2, num() + ox, num() + oy);
          ctrl = c2;
          break;
        }
        case "S": {
          const c1: Vec2 = prevCtrl ? [2 * x - prevCtrl[0], 2 * y - prevCtrl[1]] : [x, y];
          const c2: Vec2 = [num() + ox, num() + oy];
          cubicTo(c1, c2, num() + ox, num() + oy);
          ctrl = c2;
          break;
        }
        case "Q": {
          const q: Vec2 = [num() + ox, num() + oy];
          const nx = num() + ox,
            ny = num() + oy;
          cubicTo(
            [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)],
            [nx + (2 / 3) * (q[0] - nx), ny + (2 / 3) * (q[1] - ny)],
            nx,
            ny,
          );
          quad = q;
          break;
        }
        case "T": {
          const q: Vec2 = prevQuad ? [2 * x - prevQuad[0], 2 * y - prevQuad[1]] : [x, y];
          const nx = num() + ox,
            ny = num() + oy;
          cubicTo(
            [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)],
            [nx + (2 / 3) * (q[0] - nx), ny + (2 / 3) * (q[1] - ny)],
            nx,
            ny,
          );
          quad = q;
          break;
        }
        case "A": {
          const rx = num(),
            ry = num(),
            rot = num(),
            large = flag(),
            sweep = flag();
          const nx = num() + ox,
            ny = num() + oy;
          const segs = arcToCubics(x, y, rx, ry, rot, large, sweep, nx, ny);
          for (const [c1, c2, e] of segs) cubicTo(c1, c2, e[0], e[1]);
          x = nx;
          y = ny;
          break;
        }
        case "Z": {
          if (cur) {
            const c = cur as Subpath;
            c.closed = true;
            // a closing segment that ends on the start point folds into the first anchor
            const first = c.points[0],
              last = c.points[c.points.length - 1];
            if (
              c.points.length > 1 &&
              Math.abs(first.x - last.x) < 1e-6 &&
              Math.abs(first.y - last.y) < 1e-6
            ) {
              if (last.in) first.in = last.in;
              c.points.pop();
            }
          }
          x = sx;
          y = sy;
          cur = null;
          break;
        }
        default:
          throw new Error("bad path");
      }
      prevCtrl = ctrl;
      prevQuad = quad;
    }
  } catch {
    // keep what parsed so far (SVG renderers do the same)
  }
  return subs.filter((s) => s.points.length > 0);
}

/* ------------------------------------------------------------------ */
/* serialize                                                           */
/* ------------------------------------------------------------------ */

const isLine = (a: Anchor, b: Anchor) => !a.out && !b.in;

function segment(a: Anchor, b: Anchor): string {
  if (isLine(a, b)) return `L${fmt(b.x)} ${fmt(b.y)}`;
  const c1 = a.out ?? [a.x, a.y],
    c2 = b.in ?? [b.x, b.y];
  return `C${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(b.x)} ${fmt(b.y)}`;
}

/** Subpaths → SVG path data. */
export function toPath(subs: Subpath[]): string {
  const parts: string[] = [];
  for (const s of subs) {
    const p = s.points;
    if (!p.length) continue;
    parts.push(`M${fmt(p[0].x)} ${fmt(p[0].y)}`);
    for (let i = 1; i < p.length; i++) parts.push(segment(p[i - 1], p[i]));
    if (s.closed) {
      if (p.length > 1 && !isLine(p[p.length - 1], p[0])) parts.push(segment(p[p.length - 1], p[0]));
      parts.push("Z");
    }
  }
  return parts.join(" ");
}

/** Editable subpaths of a DSL vector: `points` when present (pen-drawn), else parsed from `path`. */
export function vectorSubpaths(v: Pick<SceneVector, "path" | "points" | "closed">): Subpath[] {
  if (v.points && v.points.length) return [{ points: v.points.map(cloneAnchor), closed: !!v.closed }];
  return parsePath(v.path ?? "");
}

/** Vector fields for edited subpaths (keeps `points` in sync when there is exactly one subpath). */
export function vectorFields(subs: Subpath[]): Pick<SceneVector, "path" | "points" | "closed"> {
  const path = toPath(subs);
  if (subs.length === 1) return { path, points: subs[0].points.map(roundAnchor), closed: subs[0].closed };
  return { path, points: undefined, closed: undefined };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r2v = (v: Vec2): Vec2 => [r2(v[0]), r2(v[1])];
export function roundAnchor(a: Anchor): Anchor {
  const out: Anchor = { x: r2(a.x), y: r2(a.y) };
  if (a.in) out.in = r2v(a.in);
  if (a.out) out.out = r2v(a.out);
  if (a.corner) out.corner = true;
  if (a.mirror) out.mirror = a.mirror;
  return out;
}
export function cloneAnchor(a: Anchor): Anchor {
  const out: Anchor = { x: a.x, y: a.y };
  if (a.in) out.in = [a.in[0], a.in[1]];
  if (a.out) out.out = [a.out[0], a.out[1]];
  if (a.corner) out.corner = true;
  if (a.mirror) out.mirror = a.mirror;
  return out;
}
export const cloneSubpaths = (subs: Subpath[]): Subpath[] =>
  subs.map((s) => ({ closed: s.closed, points: s.points.map(cloneAnchor) }));

/* ------------------------------------------------------------------ */
/* transforms                                                          */
/* ------------------------------------------------------------------ */

/** 2D affine matrix [a, b, c, d, e, f] (SVG order): x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const apply = (m: Mat, x: number, y: number): Vec2 => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
export const multiply = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < EPS) return IDENTITY;
  const a = m[3] / det,
    b = -m[1] / det,
    c = -m[2] / det,
    d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];
export const rotate = (deg: number): Mat => {
  const r = (deg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};

/**
 * Matrix taking element-local coordinates (0..w × 0..h) to parent coordinates for an element at (x, y) of size
 * w × h, rotated `rotation` degrees clockwise around its centre and flipped (CSS `rotate() scale()` order).
 */
export function elementMatrix(
  x: number,
  y: number,
  w: number,
  h: number,
  rotation = 0,
  flipX = false,
  flipY = false,
): Mat {
  const cx = x + w / 2,
    cy = y + h / 2;
  let m = translate(cx, cy);
  if (rotation) m = multiply(m, rotate(rotation));
  if (flipX || flipY) m = multiply(m, scale(flipX ? -1 : 1, flipY ? -1 : 1));
  return multiply(m, translate(-w / 2, -h / 2));
}

export function transformSubpaths(subs: Subpath[], m: Mat): Subpath[] {
  const t = (v: Vec2): Vec2 => apply(m, v[0], v[1]);
  return subs.map((s) => ({
    closed: s.closed,
    points: s.points.map((a) => {
      const [x, y] = apply(m, a.x, a.y);
      const out: Anchor = { x, y };
      if (a.in) out.in = t(a.in);
      if (a.out) out.out = t(a.out);
      if (a.corner) out.corner = true;
      if (a.mirror) out.mirror = a.mirror;
      return out;
    }),
  }));
}

/* ------------------------------------------------------------------ */
/* bezier math                                                         */
/* ------------------------------------------------------------------ */

export interface Cubic {
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
}

export function segmentCubic(a: Anchor, b: Anchor): Cubic {
  return { p0: [a.x, a.y], p1: a.out ?? [a.x, a.y], p2: b.in ?? [b.x, b.y], p3: [b.x, b.y] };
}

export function cubicAt(c: Cubic, t: number): Vec2 {
  const mt = 1 - t;
  const a = mt * mt * mt,
    b = 3 * mt * mt * t,
    d = 3 * mt * t * t,
    e = t * t * t;
  return [
    a * c.p0[0] + b * c.p1[0] + d * c.p2[0] + e * c.p3[0],
    a * c.p0[1] + b * c.p1[1] + d * c.p2[1] + e * c.p3[1],
  ];
}

/** Roots in (0, 1) of the derivative of one coordinate (extrema). */
function extremaT(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const out: number[] = [];
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) > EPS) out.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

/** Each segment of a subpath (closing segment included when closed). */
export function segments(s: Subpath): Array<{ a: Anchor; b: Anchor; i: number }> {
  const out: Array<{ a: Anchor; b: Anchor; i: number }> = [];
  const p = s.points;
  for (let i = 0; i < p.length - 1; i++) out.push({ a: p[i], b: p[i + 1], i });
  if (s.closed && p.length > 1) out.push({ a: p[p.length - 1], b: p[0], i: p.length - 1 });
  return out;
}

/** Tight geometric bounds (curve extrema, not control points). */
export function pathBounds(subs: Subpath[]): Bounds | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const s of subs) {
    for (const a of s.points) add(a.x, a.y);
    for (const { a, b } of segments(s)) {
      if (isLine(a, b)) continue;
      const c = segmentCubic(a, b);
      for (const t of [
        ...extremaT(c.p0[0], c.p1[0], c.p2[0], c.p3[0]),
        ...extremaT(c.p0[1], c.p1[1], c.p2[1], c.p3[1]),
      ]) {
        const [x, y] = cubicAt(c, t);
        add(x, y);
      }
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Split segment a→b at t (de Casteljau). Returns the patched a.out, the new anchor and the patched b.in. */
export function splitSegment(a: Anchor, b: Anchor, t: number): { aOut?: Vec2; mid: Anchor; bIn?: Vec2 } {
  if (isLine(a, b)) return { mid: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, corner: true } };
  const c = segmentCubic(a, b);
  const lerp = (p: Vec2, q: Vec2): Vec2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const p01 = lerp(c.p0, c.p1),
    p12 = lerp(c.p1, c.p2),
    p23 = lerp(c.p2, c.p3);
  const p012 = lerp(p01, p12),
    p123 = lerp(p12, p23);
  const m = lerp(p012, p123);
  return { aOut: p01, mid: { x: m[0], y: m[1], in: p012, out: p123 }, bIn: p23 };
}

/** Closest point on a segment (sampling + local refinement). */
export function nearestOnSegment(
  a: Anchor,
  b: Anchor,
  p: Pt,
): { t: number; x: number; y: number; dist: number } {
  if (isLine(a, b)) {
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const x = a.x + dx * t,
      y = a.y + dy * t;
    return { t, x, y, dist: Math.hypot(p.x - x, p.y - y) };
  }
  const c = segmentCubic(a, b);
  let best = { t: 0, d: Infinity };
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [x, y] = cubicAt(c, t);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < best.d) best = { t, d };
  }
  let step = 1 / N;
  for (let k = 0; k < 12; k++) {
    step /= 2;
    for (const t of [best.t - step, best.t + step]) {
      if (t < 0 || t > 1) continue;
      const [x, y] = cubicAt(c, t);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < best.d) best = { t, d };
    }
  }
  const [x, y] = cubicAt(c, best.t);
  return { t: best.t, x, y, dist: best.d };
}

/** Polyline approximation of every subpath (rings for closed subpaths). `tol` = max chord error in units. */
export function flatten(subs: Subpath[], tol = 0.25): Array<{ pts: Vec2[]; closed: boolean }> {
  return subs.map((s) => {
    const pts: Vec2[] = [];
    if (s.points.length) pts.push([s.points[0].x, s.points[0].y]);
    for (const { a, b } of segments(s)) {
      if (isLine(a, b)) {
        pts.push([b.x, b.y]);
        continue;
      }
      const c = segmentCubic(a, b);
      // control-polygon length bounds the curve length; subdivide accordingly
      const len =
        Math.hypot(c.p1[0] - c.p0[0], c.p1[1] - c.p0[1]) +
        Math.hypot(c.p2[0] - c.p1[0], c.p2[1] - c.p1[1]) +
        Math.hypot(c.p3[0] - c.p2[0], c.p3[1] - c.p2[1]);
      const n = Math.max(2, Math.min(256, Math.ceil(Math.sqrt(len / Math.max(tol, 0.01)) * 1.5)));
      for (let i = 1; i <= n; i++) pts.push(cubicAt(c, i / n));
    }
    if (s.closed && pts.length > 1) {
      const f = pts[0],
        l = pts[pts.length - 1];
      if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) pts.pop();
    }
    return { pts, closed: s.closed };
  });
}

/** Signed area of a ring (positive = clockwise in y-down screen coordinates). */
export function ringArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return -a / 2;
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

/** Bezier circle constant. */
export const KAPPA = 0.5522847498;

export function ellipseSubpath(x: number, y: number, w: number, h: number): Subpath {
  const rx = w / 2,
    ry = h / 2,
    cx = x + rx,
    cy = y + ry;
  const kx = rx * KAPPA,
    ky = ry * KAPPA;
  return {
    closed: true,
    points: [
      { x: cx, y: y, in: [cx - kx, y], out: [cx + kx, y] },
      { x: x + w, y: cy, in: [x + w, cy - ky], out: [x + w, cy + ky] },
      { x: cx, y: y + h, in: [cx + kx, y + h], out: [cx - kx, y + h] },
      { x: x, y: cy, in: [x, cy + ky], out: [x, cy - ky] },
    ],
  };
}

/** Rectangle with CSS-like corner radii [tl, tr, br, bl] (radii scaled down together when they overflow). */
export function rectSubpath(
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number] = [0, 0, 0, 0],
): Subpath {
  let [tl, tr, br, bl] = radii.map((r) => Math.max(0, r));
  const f = Math.min(
    1,
    w / Math.max(EPS, tl + tr),
    w / Math.max(EPS, bl + br),
    h / Math.max(EPS, tl + bl),
    h / Math.max(EPS, tr + br),
  );
  tl *= f;
  tr *= f;
  br *= f;
  bl *= f;
  const k = 1 - KAPPA;
  const pts: Anchor[] = [];
  const corner = (ax: number, ay: number) => pts.push({ x: ax, y: ay, corner: true });
  if (tl > 0) {
    pts.push({ x, y: y + tl, out: [x, y + tl * k] });
    pts.push({ x: x + tl, y, in: [x + tl * k, y] });
  } else corner(x, y);
  if (tr > 0) {
    pts.push({ x: x + w - tr, y, out: [x + w - tr * k, y] });
    pts.push({ x: x + w, y: y + tr, in: [x + w, y + tr * k] });
  } else corner(x + w, y);
  if (br > 0) {
    pts.push({ x: x + w, y: y + h - br, out: [x + w, y + h - br * k] });
    pts.push({ x: x + w - br, y: y + h, in: [x + w - br * k, y + h] });
  } else corner(x + w, y + h);
  if (bl > 0) {
    pts.push({ x: x + bl, y: y + h, out: [x + bl * k, y + h] });
    pts.push({ x, y: y + h - bl, in: [x, y + h - bl * k] });
  } else corner(x, y + h);
  return { closed: true, points: pts };
}

/* ------------------------------------------------------------------ */
/* editing helpers                                                     */
/* ------------------------------------------------------------------ */

/** Snap `p` to the nearest 45° direction from `from`. */
export function snap45(from: Pt, p: Pt): Pt {
  const dx = p.x - from.x,
    dy = p.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return { ...p };
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
}

/** Mirror handle `h` through anchor `a` (smooth point), keeping `len` when given. */
export function mirrorHandle(a: Pt, h: Vec2, len?: number): Vec2 {
  const dx = h[0] - a.x,
    dy = h[1] - a.y;
  const l = Math.hypot(dx, dy);
  if (len === undefined || l < EPS) return [a.x - dx, a.y - dy];
  return [a.x - (dx / l) * len, a.y - (dy / l) * len];
}

/** Toggle corner ↔ smooth: corner drops the handles; smooth adds handles along the neighbours' direction. */
export function toggleSmooth(s: Subpath, i: number): Subpath {
  const p = s.points;
  const a = p[i];
  const hasHandles = !!(a.in || a.out);
  const next = cloneSubpaths([s])[0];
  const t = next.points[i];
  if (hasHandles) {
    delete t.in;
    delete t.out;
    t.corner = true;
    return next;
  }
  const n = p.length;
  const prev = i > 0 ? p[i - 1] : s.closed ? p[n - 1] : null;
  const nxt = i < n - 1 ? p[i + 1] : s.closed ? p[0] : null;
  const dir: Vec2 =
    prev && nxt
      ? [nxt.x - prev.x, nxt.y - prev.y]
      : nxt
        ? [nxt.x - a.x, nxt.y - a.y]
        : prev
          ? [a.x - prev.x, a.y - prev.y]
          : [1, 0];
  const dl = Math.hypot(dir[0], dir[1]) || 1;
  const ux = dir[0] / dl,
    uy = dir[1] / dl;
  const lin = prev ? Math.hypot(a.x - prev.x, a.y - prev.y) / 3 : 0;
  const lout = nxt ? Math.hypot(nxt.x - a.x, nxt.y - a.y) / 3 : 0;
  if (prev) t.in = [a.x - ux * lin, a.y - uy * lin];
  if (nxt) t.out = [a.x + ux * lout, a.y + uy * lout];
  delete t.corner;
  return next;
}

/** Remove anchors (indices per subpath). Subpaths left with < 2 anchors disappear. */
export function deleteAnchors(subs: Subpath[], sel: Array<{ sub: number; i: number }>): Subpath[] {
  const drop = new Set(sel.map((s) => `${s.sub}:${s.i}`));
  return subs
    .map((s, si) => ({
      closed: s.closed,
      points: s.points.filter((_, i) => !drop.has(`${si}:${i}`)).map(cloneAnchor),
    }))
    .filter((s) => s.points.length >= 2)
    .map((s) => (s.points.length < 3 ? { ...s, closed: false } : s));
}

/** Insert a point on segment `seg` (index of its start anchor) of subpath `sub` at `t`. */
export function insertAnchor(
  subs: Subpath[],
  sub: number,
  seg: number,
  t: number,
): { subs: Subpath[]; index: number } {
  const next = cloneSubpaths(subs);
  const s = next[sub];
  const a = s.points[seg];
  const bi = (seg + 1) % s.points.length;
  const b = s.points[bi];
  const r = splitSegment(a, b, t);
  if (r.aOut) a.out = r.aOut;
  if (r.bIn) b.in = r.bIn;
  s.points.splice(seg + 1, 0, r.mid);
  return { subs: next, index: seg + 1 };
}

/**
 * Re-box geometry: given subpaths in parent coordinates, returns the element box (tight bounds, at least 1×1) and
 * the subpaths in that box's local coordinates.
 */
export function rebox(subs: Subpath[], minSize = 1): { box: Bounds; local: Subpath[] } {
  const b = pathBounds(subs) ?? { x: 0, y: 0, w: 0, h: 0 };
  const box = { x: b.x, y: b.y, w: Math.max(minSize, b.w), h: Math.max(minSize, b.h) };
  // centre degenerate axes (straight horizontal / vertical lines) inside the minimum box
  const ox = b.w < minSize ? (minSize - b.w) / 2 : 0;
  const oy = b.h < minSize ? (minSize - b.h) / 2 : 0;
  box.x -= ox;
  box.y -= oy;
  return { box, local: transformSubpaths(subs, translate(-box.x, -box.y)) };
}

/** Scale path data (element resize). */
export function scalePath(d: string, sx: number, sy: number): string {
  return toPath(transformSubpaths(parsePath(d), scale(sx, sy)));
}
