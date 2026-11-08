/** Colour maths without dependencies: sRGB ↔ OKLab/OKLCH, WCAG contrast, ΔE (OKLab distance × 100). */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/** #rgb, #rrggbb, #rrggbbaa (alpha ignored), rgb()/rgba() → 0..1 channels; undefined when unreadable. */
export function parseColor(input: string): Rgb | undefined {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return undefined;
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
    };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return { r: +m[1]! / 255, g: +m[2]! / 255, b: +m[3]! / 255 };
  return undefined;
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (v: number) =>
    Math.round(clamp(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Normalised #rrggbb, or undefined. */
export const normHex = (c: string | undefined) => {
  const p = c ? parseColor(c) : undefined;
  return p ? toHex(p) : undefined;
};

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToOklab({ r, g, b }: Rgb): [number, number, number] {
  const lr = toLinear(r),
    lg = toLinear(g),
    lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function rgbToOklch(c: Rgb): Oklch {
  const [L, a, b] = rgbToOklab(c);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { l: L, c: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

const inGamut = ([r, g, b]: number[]) => [r, g, b].every((v) => v! >= -1e-4 && v! <= 1 + 1e-4);

/** OKLCH → sRGB, reducing chroma until the colour fits the gamut (keeps lightness and hue). */
export function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  let lo = 0,
    hi = c;
  let lin = oklabToLinear(l, c * Math.cos(rad), c * Math.sin(rad));
  if (!inGamut(lin)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const t = oklabToLinear(l, mid * Math.cos(rad), mid * Math.sin(rad));
      if (inGamut(t)) {
        lo = mid;
        lin = t;
      } else hi = mid;
    }
    lin = oklabToLinear(l, lo * Math.cos(rad), lo * Math.sin(rad));
  }
  return { r: clamp(fromLinear(lin[0])), g: clamp(fromLinear(lin[1])), b: clamp(fromLinear(lin[2])) };
}

export const hexToOklch = (hex: string) => rgbToOklch(parseColor(hex) ?? { r: 0, g: 0, b: 0 });
export const oklchToHex = (c: Oklch) => toHex(oklchToRgb(c));

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const c = parseColor(hex) ?? { r: 0, g: 0, b: 0 };
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** WCAG contrast ratio (1–21). */
export function contrast(a: string, b: string): number {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Perceptual distance: OKLab Euclidean × 100 (≈ ΔE; 2 is barely visible, 10 clearly different). */
export function deltaE(a: string, b: string): number {
  const p = rgbToOklab(parseColor(a) ?? { r: 0, g: 0, b: 0 });
  const q = rgbToOklab(parseColor(b) ?? { r: 0, g: 0, b: 0 });
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100;
}

/** Mix two colours in OKLab (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const p = rgbToOklab(parseColor(a) ?? { r: 0, g: 0, b: 0 });
  const q = rgbToOklab(parseColor(b) ?? { r: 0, g: 0, b: 0 });
  const L = p[0] + (q[0] - p[0]) * t,
    A = p[1] + (q[1] - p[1]) * t,
    B = p[2] + (q[2] - p[2]) * t;
  const c = Math.hypot(A, B);
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return oklchToHex({ l: L, c, h: h < 0 ? h + 360 : h });
}

/** Black or white, whichever reads better on `bg`. */
export const onColor = (bg: string) =>
  contrast(bg, "#ffffff") >= contrast(bg, "#000000") ? "#ffffff" : "#000000";
