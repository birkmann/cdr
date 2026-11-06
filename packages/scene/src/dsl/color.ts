// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Tiny colour helpers for the DSL renderer (shade/alpha/on-colour). Kept dependency-free so toHtml can use them too.
type RGB = [number, number, number];
type HSL = [number, number, number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const isHexColor = (v: string) =>
  /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3}([0-9a-fA-F]{2})?)?$/.test(v.trim());
// CSS Color 4 functions too: a captured page's computed colours come back as `color(srgb …)` (color-mix(), color()),
// `oklch(…)` / `lab(…)` (wide-gamut values) — a valid colour the renderer and the exports must keep, not drop
export const isCssColor = (v: string) =>
  isHexColor(v) ||
  /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/.test(v.trim()) ||
  /^(transparent|white|black)$/i.test(v.trim());

export function hexToRgb(hex: string): RGB | null {
  let h = hex.trim().replace("#", "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Parse #hex / rgb() / rgba(); returns null for anything else (tokens, gradients). */
export function parseColor(v: string): { rgb: RGB; a: number } | null {
  const s = v.trim();
  if (isHexColor(s)) {
    const rgb = hexToRgb(s);
    const h = s.replace("#", "");
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return rgb ? { rgb, a } : null;
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] !== undefined ? Number(m[4]) : 1 };
  // space syntax: rgb(0 0 0 / 0.4), color(srgb 0 0 0 / 0.4) (channels 0..1) — what getComputedStyle returns
  const a = (x: string | undefined) =>
    x === undefined ? 1 : x.endsWith("%") ? Number(x.slice(0, -1)) / 100 : Number(x);
  const sp = s.match(/^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/);
  if (sp) return { rgb: [Number(sp[1]), Number(sp[2]), Number(sp[3])], a: a(sp[4]) };
  const c = s.match(/^color\(\s*srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/);
  if (c) return { rgb: [Number(c[1]) * 255, Number(c[2]) * 255, Number(c[3]) * 255], a: a(c[4]) };
  return null;
}

const rgbToHex = ([r, g, b]: RGB) =>
  "#" +
  [r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

function rgbToHsl([r, g, b]: RGB): HSL {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: HSL): RGB {
  h = ((h % 360) + 360) % 360;
  s = clamp01(s);
  l = clamp01(l);
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hk = h / 360;
  return [f(hk + 1 / 3) * 255, f(hk) * 255, f(hk - 1 / 3) * 255];
}

/** `color` with alpha `a` (falls back to the input for non-parsable colours). */
export function alpha(color: string, a: number): string {
  const p = parseColor(color);
  if (!p) return color;
  return `rgba(${p.rgb.map(Math.round).join(", ")}, ${clamp01(a)})`;
}

/** Lighten (+) or darken (−) by a lightness delta in 0..1. */
export function shade(color: string, delta: number): string {
  const p = parseColor(color);
  if (!p) return color;
  const [h, s, l] = rgbToHsl(p.rgb);
  return rgbToHex(hslToRgb([h, s, clamp01(l + delta)]));
}

export function withLightness(color: string, l: number, satMul = 1): string {
  const p = parseColor(color);
  if (!p) return color;
  const [h, s] = rgbToHsl(p.rgb);
  return rgbToHex(hslToRgb([h, clamp01(s * satMul), l]));
}

export function rotateHue(color: string, deg: number, satMul = 1): string {
  const p = parseColor(color);
  if (!p) return color;
  const [h, s, l] = rgbToHsl(p.rgb);
  return rgbToHex(hslToRgb([h + deg, clamp01(s * satMul), l]));
}

export function mix(a: string, b: string, t: number): string {
  const A = parseColor(a),
    B = parseColor(b);
  if (!A || !B) return a;
  return rgbToHex([
    A.rgb[0] + (B.rgb[0] - A.rgb[0]) * t,
    A.rgb[1] + (B.rgb[1] - A.rgb[1]) * t,
    A.rgb[2] + (B.rgb[2] - A.rgb[2]) * t,
  ]);
}

export function luminance(color: string): number {
  const p = parseColor(color);
  if (!p) return 0.5;
  const [r, g, b] = p.rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Readable foreground for text placed on `color`. */
export const onColor = (color: string) => (luminance(color) > 0.45 ? "#111114" : "#ffffff");
export const isDark = (color: string) => luminance(color) < 0.3;
