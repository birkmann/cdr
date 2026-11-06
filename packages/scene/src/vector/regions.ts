// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Paint bucket regions (PLAN 7.2): the faces of the arrangement formed by a vector's closed subpaths. A face is named
// by the sorted indices of the closed subpaths that contain it ('0', '0+2' …); `SceneVector.fillRegions` lists the
// filled faces. Without `fillRegions` the whole path is filled by its fill rule, exactly as before.
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from "polygon-clipping";
import type { SceneVector } from "@harness/protocol";
import { flatten, ringArea, toPath, vectorSubpaths, type Pt, type Subpath, type Vec2 } from "./path.js";
import { polygonsToSubpaths } from "./boolean.js";

const { difference, intersection, union } = polygonClipping;

const TOL = 0.15;
const MIN_AREA = 0.01;

export interface Region {
  key: string;
  set: number[];
  poly: MultiPolygon;
}
interface RingInfo {
  index: number;
  pts: Vec2[];
  poly: Polygon;
  sign: number;
}

const closeRing = (pts: Vec2[]): Ring => {
  const r: Ring = pts.map((p) => [p[0], p[1]]);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]))
    r.push([r[0][0], r[0][1]]);
  return r;
};

/** Closed subpaths (≥ 3 points) as flattened rings, keyed by their subpath index. */
function rings(subs: Subpath[]): RingInfo[] {
  const flat = flatten(subs, TOL);
  const out: RingInfo[] = [];
  subs.forEach((s, i) => {
    const pts = flat[i]?.pts ?? [];
    if (!s.closed || pts.length < 3) return;
    const a = ringArea(pts);
    if (Math.abs(a) < MIN_AREA) return;
    out.push({ index: i, pts, poly: [closeRing(pts)], sign: Math.sign(a) || 1 });
  });
  return out;
}

function mpArea(mp: MultiPolygon): number {
  let a = 0;
  for (const poly of mp)
    poly.forEach((ring, i) => {
      const v = Math.abs(ringArea(ring.map((p): Vec2 => [p[0], p[1]])));
      a += i === 0 ? v : -v;
    });
  return a;
}

export const regionKey = (set: number[]) => [...set].sort((a, b) => a - b).join("+");

/** Every face of the arrangement (faces with the same containment set share one key). */
export function regionFaces(subs: Subpath[]): Region[] {
  let acc: Array<{ set: number[]; poly: MultiPolygon }> = [];
  for (const r of rings(subs)) {
    const next: typeof acc = [];
    let rest: MultiPolygon = [r.poly];
    for (const f of acc) {
      const inside = intersection(f.poly, r.poly);
      const outside = difference(f.poly, r.poly);
      if (mpArea(inside) > MIN_AREA) next.push({ set: [...f.set, r.index], poly: inside });
      if (mpArea(outside) > MIN_AREA) next.push({ set: f.set, poly: outside });
      if (rest.length) rest = difference(rest, f.poly);
    }
    if (mpArea(rest) > MIN_AREA) next.push({ set: [r.index], poly: rest });
    acc = next;
  }
  const byKey = new Map<string, Region>();
  for (const f of acc) {
    const key = regionKey(f.set);
    const prev = byKey.get(key);
    if (prev) prev.poly = union(prev.poly, f.poly);
    else byKey.set(key, { key, set: [...f.set].sort((a, b) => a - b), poly: f.poly });
  }
  return [...byKey.values()];
}

function inRing(pts: Vec2[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i],
      [xj, yj] = pts[j];
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Key of the face under `p` (element-local coordinates), or null outside every closed subpath. */
export function regionKeyAt(subs: Subpath[], p: Pt): string | null {
  const set = rings(subs)
    .filter((r) => inRing(r.pts, p))
    .map((r) => r.index);
  return set.length ? regionKey(set) : null;
}

/** Whether a face is painted by the plain fill rule (no `fillRegions`). */
export function filledByRule(subs: Subpath[], set: number[], rule: SceneVector["fillRule"]): boolean {
  if (rule === "evenodd") return set.length % 2 === 1;
  const signs = new Map(rings(subs).map((r) => [r.index, r.sign]));
  return set.reduce((w, i) => w + (signs.get(i) ?? 0), 0) !== 0;
}

/** Keys of the faces painted right now. */
export function filledRegionKeys(v: SceneVector, subs: Subpath[] = vectorSubpaths(v)): string[] {
  if (v.fillRegions) return [...v.fillRegions];
  if (v.fill === null || v.fill === undefined) return [];
  return regionFaces(subs)
    .filter((f) => filledByRule(subs, f.set, v.fillRule))
    .map((f) => f.key);
}

/** Default colour a region gets when the vector has no fill yet. */
export const BUCKET_FILL = "$primary";

/**
 * Paint bucket click on the face `key`: fill it when empty, unfill it when filled. Returns the new vector (or null
 * when `key` names no face). An empty result drops the fill; the full default set goes back to the plain fill.
 */
export function toggleRegion(v: SceneVector, key: string): SceneVector | null {
  const subs = vectorSubpaths(v);
  const faces = regionFaces(subs);
  if (!faces.some((f) => f.key === key)) return null;
  const current = new Set(filledRegionKeys(v, subs));
  if (current.has(key)) current.delete(key);
  else current.add(key);
  const next: SceneVector = { ...v };
  const keys = faces.map((f) => f.key).filter((k) => current.has(k));
  if (!keys.length) {
    next.fill = null;
    delete next.fillRegions;
    return next;
  }
  if (next.fill === null || next.fill === undefined) next.fill = BUCKET_FILL;
  const byRule = faces.filter((f) => filledByRule(subs, f.set, v.fillRule)).map((f) => f.key);
  if (
    v.fill !== null &&
    v.fill !== undefined &&
    byRule.length === keys.length &&
    byRule.every((k) => current.has(k))
  )
    delete next.fillRegions;
  else next.fillRegions = keys;
  return next;
}

/** Subpaths of one face (for the hover highlight), or null. */
export function regionSubpaths(subs: Subpath[], key: string): Subpath[] | null {
  const f = regionFaces(subs).find((r) => r.key === key);
  return f ? polygonsToSubpaths(f.poly) : null;
}

const fillCache = new WeakMap<SceneVector, string>();

/** Path data of the filled faces (even-odd), memoised per vector object. Null when `fillRegions` is not set. */
export function regionFillPath(v: SceneVector): string | null {
  if (!v.fillRegions) return null;
  const hit = fillCache.get(v);
  if (hit !== undefined) return hit;
  const want = new Set(v.fillRegions);
  let d = "";
  try {
    const polys = regionFaces(vectorSubpaths(v))
      .filter((f) => want.has(f.key))
      .map((f) => f.poly);
    if (polys.length)
      d = toPath(polygonsToSubpaths(polys.length === 1 ? polys[0] : union(polys[0], ...polys.slice(1))));
  } catch {
    d = "";
  }
  fillCache.set(v, d);
  return d;
}
