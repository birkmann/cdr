// Ported from the earlier project's apps/web/src/ai/eval/visionScore.ts (`lab` only).
// sRGB (0..255) → CIE L*a*b* (D65), for colour clustering in naming.ts. Pure.
const lin = (c: number) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

export function lab(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r),
    G = lin(g),
    B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047,
    Y = R * 0.2126 + G * 0.7152 + B * 0.0722,
    Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const fx = fLab(X),
    fy = fLab(Y),
    fz = fLab(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
