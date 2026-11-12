// Values measured at several widths → the simplest CSS that reproduces them: a constant, a line in the viewport or
// container width (`calc(a% + b px)`, `calc(a vw + b px)`), or a line between two plateaus (`clamp()`). Never a value
// that only holds at one width: the result is continuous between and beyond the measurements.

export interface Sample {
  /** the reference length the value follows (viewport width, or the containing block's width) */
  x: number;
  /** the measured value (px) */
  y: number;
}

export type Fit =
  | { kind: "const"; v: number }
  | { kind: "line"; a: number; b: number }
  /** a line held by a plateau on one side or both (`lo` at the narrow end, `hi` at the wide end; absent: no plateau) */
  | { kind: "clamp"; a: number; b: number; lo?: number; hi?: number };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** px tolerance for a value of this size: sub-pixel rounding of the browser, a little more for big values */
export const tol = (y: number) => Math.max(0.75, Math.abs(y) * 0.006);

export function evalFit(f: Fit, x: number): number {
  if (f.kind === "const") return f.v;
  const v = f.a * x + f.b;
  if (f.kind === "line") return v;
  const bounds = [f.lo, f.hi].filter((b): b is number => b !== undefined);
  const lo = Math.min(...bounds),
    hi = Math.max(...bounds);
  if (bounds.length === 2) return Math.min(Math.max(v, lo), hi);
  // one plateau: the line on one side of it
  const p = bounds[0]!;
  return (f.lo !== undefined) === f.a > 0 ? Math.max(v, p) : Math.min(v, p);
}

function lsq(pts: Sample[]): { a: number; b: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-9) return null;
  const a = (n * sxy - sx * sy) / d;
  return { a, b: (sy - a * sx) / n };
}

const fits = (f: Fit, pts: Sample[], slack = 1) =>
  pts.every((p) => Math.abs(evalFit(f, p.x) - p.y) <= tol(p.y) * slack);

/** Distinct x with one y each (repeated walks at one width agree; the median is kept). */
function dedupe(samples: Sample[]): Sample[] {
  const by = new Map<number, number[]>();
  for (const s of samples) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const k = Math.round(s.x * 10) / 10;
    by.set(k, [...(by.get(k) ?? []), s.y]);
  }
  return [...by]
    .map(([x, ys]) => ({ x, y: ys.sort((a, b) => a - b)[Math.floor(ys.length / 2)]! }))
    .sort((a, b) => a.x - b.x);
}

/**
 * The simplest fit through the samples: constant, line, or a line held between two plateaus. null when none holds
 * (the caller then keeps the value at the variant's own width).
 */
export function fitSamples(samples: Sample[], slack = 1): Fit | null {
  const pts = dedupe(samples);
  if (!pts.length) return null;
  const ys = pts.map((p) => p.y).sort((a, b) => a - b);
  const med = ys[Math.floor(ys.length / 2)]!;
  const c: Fit = { kind: "const", v: med };
  if (fits(c, pts, slack)) return c;
  if (pts.length === 1) return c;
  const l = lsq(pts);
  if (l && fits({ kind: "line", ...l }, pts, slack)) return { kind: "line", ...l };
  // a line between plateaus: try every split [0, i) low plateau, [i, j) line, [j, n) high plateau
  const n = pts.length;
  // the split with the fewest plateau points wins (a last sample on the line is no plateau)
  const splits: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 2; j <= n; j++) splits.push([i, j]);
  splits.sort((a, b) => a[0] + (n - a[1]) - (b[0] + (n - b[1])));
  for (const [i, j] of splits) {
    {
      const mid = pts.slice(i, j);
      const line = lsq(mid);
      if (!line || Math.abs(line.a) < 1e-6) continue;
      if (i === 0 && j === n) continue;
      const lo = i > 0 ? pts[0]!.y : undefined;
      const hi = j < n ? pts[n - 1]!.y : undefined;
      if (lo !== undefined && !pts.slice(0, i).every((p) => Math.abs(p.y - lo) <= tol(p.y) * slack)) continue;
      if (hi !== undefined && !pts.slice(j).every((p) => Math.abs(p.y - hi) <= tol(p.y) * slack)) continue;
      const f: Fit = {
        kind: "clamp",
        ...line,
        ...(lo !== undefined ? { lo } : {}),
        ...(hi !== undefined ? { hi } : {}),
      };
      if (fits(f, pts, slack)) return f;
    }
  }
  return null;
}

export type Unit = "vw" | "%" | "vh";

/** A fit as CSS: `16px`, `50%`, `calc(4.17vw + 12px)`, `clamp(24px, 3.2vw + 8px, 64px)`. */
export function fitCss(f: Fit, unit: Unit): string {
  if (f.kind === "const") return px(f.v);
  const lin = linCss(f.a, f.b, unit);
  if (f.kind === "line") return lin;
  const inner = lin.startsWith("calc(") ? lin.slice(5, -1) : lin;
  if (f.lo !== undefined && f.hi !== undefined)
    return `clamp(${px(Math.min(f.lo, f.hi))}, ${inner}, ${px(Math.max(f.lo, f.hi))})`;
  const p = (f.lo ?? f.hi)!;
  // a plateau at the narrow end of a rising line is its floor (max), at the wide end its ceiling (min)
  const floor = (f.lo !== undefined) === f.a > 0;
  return `${floor ? "max" : "min"}(${px(p)}, ${inner})`;
}

export function px(v: number): string {
  const n = r2(v);
  return n === 0 ? "0" : `${n}px`;
}

/** a share as written by hand: whole and half percents, thirds, sixths, eighths */
export function snapShare(k: number): number {
  for (const nice of [
    Math.round(k),
    Math.round(k * 2) / 2,
    ...[3, 6, 8, 12].map((d) => Math.round((k * d) / 100) * (100 / d)),
  ])
    if (Math.abs(k - nice) < 0.05) return r3(nice);
  return r3(k);
}

function linCss(a: number, b: number, unit: Unit): string {
  const k = unit === "%" ? snapShare(a * 100) : r3(a * 100);
  const B = r2(b);
  if (Math.abs(k) < 0.001) return px(b);
  const head = `${k}${unit}`;
  if (Math.abs(B) < 0.5) return head;
  return `calc(${head} ${B < 0 ? "-" : "+"} ${Math.abs(B)}px)`;
}

/** How costly a fit is to read (the simpler of two fits that both hold wins). */
export const fitCost = (f: Fit | null) => (!f ? 9 : f.kind === "const" ? 0 : f.kind === "line" ? 1 : 2);

/** Is this fit a whole-reference share (50 %, 100 %, 33.33 %): a column of its container */
export function isShare(f: Fit): boolean {
  return f.kind === "line" && Math.abs(f.b) < 1 && f.a > 0 && f.a <= 1.0001;
}
