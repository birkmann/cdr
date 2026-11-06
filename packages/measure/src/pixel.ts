// Pixel fidelity: per-pixel diff of the output against the live page, at CSS-pixel resolution, in Node (no browser).
// Ported from the earlier project's scripts/lib/pixel-diff.mjs: pixels compared like pixelmatch (YIQ colour distance,
// threshold 0.1 of the maximum); a mismatch whose colour is found within ±`shift` px in the other image counts as
// "shifted" (anti-aliasing, sub-pixel offsets) rather than wrong. Reported per horizontal band.
import type { RgbImage } from "@harness/capture";

export interface Band {
  y: number;
  h: number;
  /** share of mismatched pixels */
  mismatch: number;
  shifted: number;
  meanDelta: number;
  /** rows only one image has */
  missing: boolean;
  /** excluded from the totals (live content) */
  excluded?: boolean;
}

export interface PixelReport {
  width: number;
  height: number;
  refHeight: number;
  outHeight: number;
  threshold: number;
  shift: number;
  band: number;
  mismatch: number;
  shifted: number;
  meanDelta: number;
  bands: Band[];
}

export interface PixelDiffOptions {
  band?: number;
  threshold?: number;
  shift?: number;
  /** page-space row ranges left out of the totals (bands marked live content) */
  exclude?: [number, number][];
}

/** Nearest-neighbour resample to `width` (keeps proportions); the same image when it already is that wide. */
export function resampleToWidth(img: RgbImage, width: number): RgbImage {
  if (img.width === width) return img;
  const k = img.width / width;
  const height = Math.max(1, Math.round(img.height / k));
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y * k));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x * k));
      const s = (sy * img.width + sx) * 3,
        o = (y * width + x) * 3;
      data[o] = img.data[s];
      data[o + 1] = img.data[s + 1];
      data[o + 2] = img.data[s + 2];
    }
  }
  return { width, height, data };
}

/**
 * Diff `out` (the recreation) against `ref` (the live page). Rows only one image has count as mismatched.
 * → report + diff image (red = mismatch, amber = shifted by ≤ `shift` px, faded reference elsewhere).
 */
export function pixelDiff(
  refIn: RgbImage,
  outIn: RgbImage,
  o: PixelDiffOptions = {},
): { report: PixelReport; diff: RgbImage } {
  const band = o.band ?? 200,
    threshold = o.threshold ?? 0.1,
    shift = o.shift ?? 1;
  const W = refIn.width;
  const ref = refIn,
    out = resampleToWidth(outIn, W);
  const refH = ref.height,
    outH = out.height;
  const H = Math.max(refH, outH);
  const maxDelta = 35215 * threshold * threshold;
  const px = (img: RgbImage, x: number, y: number) => (y * img.width + x) * 3;
  const delta = (a: Uint8Array, i: number, b: Uint8Array, j: number) => {
    const r1 = a[i],
      g1 = a[i + 1],
      b1 = a[i + 2],
      r2 = b[j],
      g2 = b[j + 1],
      b2 = b[j + 2];
    if (r1 === r2 && g1 === g2 && b1 === b2) return 0;
    const dr = r1 - r2,
      dg = g1 - g2,
      db = b1 - b2;
    const yy = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
    const ii = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
    const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
    return 0.5053 * yy * yy + 0.299 * ii * ii + 0.1957 * q * q;
  };
  const excluded = (y0: number, h: number) =>
    (o.exclude ?? []).some(([a, b]) => Math.min(b, y0 + h) - Math.max(a, y0) >= h / 2);
  const diff = new Uint8Array(W * H * 3);
  const bands: Band[] = [];
  let totalBad = 0,
    totalShift = 0,
    totalDelta = 0,
    counted = 0;
  for (let y0 = 0; y0 < H; y0 += band) {
    const h = Math.min(band, H - y0);
    let bad = 0,
      shifted = 0,
      sum = 0;
    for (let y = y0; y < y0 + h; y++) {
      const missing = y >= refH || y >= outH;
      for (let x = 0; x < W; x++) {
        const oi = (y * W + x) * 3;
        const i = missing ? 0 : px(ref, x, y);
        const d = missing ? Infinity : delta(ref.data, i, out.data, px(out, x, y));
        sum += missing ? 1 : Math.sqrt(Math.min(d, 35215) / 35215);
        let kind = 0;
        if (d > maxDelta) {
          kind = 2;
          if (!missing && shift > 0) {
            search: for (let dy = -shift; dy <= shift; dy++) {
              const yb = y + dy;
              if (yb < 0 || yb >= refH || yb >= outH) continue;
              for (let dx = -shift; dx <= shift; dx++) {
                const xb = x + dx;
                if ((!dx && !dy) || xb < 0 || xb >= W) continue;
                if (
                  delta(ref.data, i, out.data, px(out, xb, yb)) <= maxDelta ||
                  delta(ref.data, px(ref, xb, yb), out.data, px(out, x, y)) <= maxDelta
                ) {
                  kind = 1;
                  break search;
                }
              }
            }
          }
        }
        if (kind === 2) {
          bad++;
          diff[oi] = 230;
          diff[oi + 1] = 20;
          diff[oi + 2] = 40;
        } else if (kind === 1) {
          shifted++;
          diff[oi] = 255;
          diff[oi + 1] = 170;
          diff[oi + 2] = 0;
        } else {
          const l = missing
            ? 255
            : 255 - (255 - (ref.data[i] * 0.299 + ref.data[i + 1] * 0.587 + ref.data[i + 2] * 0.114)) * 0.18;
          diff[oi] = diff[oi + 1] = diff[oi + 2] = l;
        }
      }
    }
    const n = W * h;
    const ex = excluded(y0, h);
    if (!ex) {
      totalBad += bad;
      totalShift += shifted;
      totalDelta += sum;
      counted += n;
    }
    bands.push({
      y: y0,
      h,
      mismatch: bad / n,
      shifted: shifted / n,
      meanDelta: sum / n,
      missing: y0 + h > Math.min(refH, outH),
      ...(ex ? { excluded: true } : {}),
    });
  }
  const n = Math.max(1, counted);
  return {
    report: {
      width: W,
      height: H,
      refHeight: refH,
      outHeight: outH,
      threshold,
      shift,
      band,
      mismatch: totalBad / n,
      shifted: totalShift / n,
      meanDelta: totalDelta / n,
      bands,
    },
    diff: { width: W, height: H, data: diff },
  };
}

/** Mismatch of the rows `y0 … y1` from a full report, at band granularity (each band counts with its overlap). */
export function bandMismatch(r: PixelReport, y0: number, y1: number): number {
  let bad = 0,
    n = 0;
  for (const b of r.bands) {
    const lo = Math.max(b.y, y0),
      hi = Math.min(b.y + b.h, y1);
    if (hi <= lo) continue;
    bad += b.mismatch * (hi - lo);
    n += hi - lo;
  }
  return n ? bad / n : 0;
}
