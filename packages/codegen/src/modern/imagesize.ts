// Pixel size of an encoded image from its header (PNG, JPEG, GIF, WebP, AVIF): `srcset` width descriptors and the
// width / height attributes that keep the layout from shifting while it loads.
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const u32 = (o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  const u16 = (o: number) => (b[o]! << 8) | b[o + 1]!;
  const le16 = (o: number) => b[o]! | (b[o + 1]! << 8);
  const le24 = (o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
  if (b.length < 24) return null;
  // SVG: its width / height, else its viewBox
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 2048)));
  if (/<svg\b/i.test(head)) {
    const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? "";
    const num = (k: string) => {
      const m = new RegExp(`\\s${k}="([\\d.]+)(px)?"`).exec(tag);
      return m ? Number(m[1]) : NaN;
    };
    const vb = /viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(tag);
    const w = num("width") || (vb ? Number(vb[1]) : NaN),
      h = num("height") || (vb ? Number(vb[2]) : NaN);
    return w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : { w: 0, h: 0 };
  }
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: u32(16), h: u32(20) };
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: le16(6), h: le16(8) };
  // WebP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (kind === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { w: le24(24) + 1, h: le24(27) + 1 };
    return null;
  }
  // JPEG: the first SOFn marker
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const m = b[o + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { w: u16(o + 7), h: u16(o + 5) };
      o += 2 + u16(o + 2);
    }
    return null;
  }
  // AVIF / HEIF: the ispe box
  for (let o = 4; o + 16 < Math.min(b.length, 4096); o++)
    if (b[o] === 0x69 && b[o + 1] === 0x73 && b[o + 2] === 0x70 && b[o + 3] === 0x65)
      return { w: u32(o + 8), h: u32(o + 12) };
  return null;
}
