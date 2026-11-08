// Minimal PNG codec (no image dependency): decode 8-bit (and 16-bit) PNGs of any colour type, non-interlaced or
// Adam7, into packed RGB (alpha composited on white); encode packed RGB as a PNG with per-row adaptive filters.
// Ported from the earlier project's scripts/lib/vision/png.mjs.
import { crc32, deflateSync, inflateSync } from "node:zlib";

/** Packed RGB, 3 bytes per pixel, rows top to bottom. */
export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
  /** decoded images only: the highest alpha of any pixel (255 for images without alpha) */
  maxAlpha?: number;
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const isPng = (buf: Uint8Array) => buf.length > 8 && Buffer.from(buf.subarray(0, 8)).equals(SIG);

export function decodePng(input: Uint8Array): RgbImage {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isPng(buf)) throw new Error("not a PNG file");
  let pos = 8;
  let ihdr: { width: number; height: number; depth: number; color: number; interlace: number } | null = null;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR")
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        color: body[9],
        interlace: body[12],
      };
    else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (!ihdr) throw new Error("PNG without IHDR");
  const { width, height, depth, color, interlace } = ihdr;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!channels) throw new Error(`unsupported PNG colour type ${color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 3);
  let maxAlpha = 0;
  const bitsPP = channels * depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const sample = (row: Uint8Array, x: number, c: number) => {
    if (depth === 8) return row[x * channels + c];
    if (depth === 16) return row[(x * channels + c) * 2];
    // sub-byte (grey / palette only): one sample per pixel
    const bit = x * depth;
    const v = (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return color === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const put = (row: Uint8Array, x: number, ox: number, oy: number) => {
    let r: number,
      g: number,
      b: number,
      a = 255;
    if (color === 3) {
      const i = sample(row, x, 0);
      r = palette![i * 3];
      g = palette![i * 3 + 1];
      b = palette![i * 3 + 2];
      if (trns && i < trns.length) a = trns[i];
    } else if (color === 0 || color === 4) {
      r = g = b = sample(row, x, 0);
      if (color === 4) a = sample(row, x, 1);
    } else {
      r = sample(row, x, 0);
      g = sample(row, x, 1);
      b = sample(row, x, 2);
      if (color === 6) a = sample(row, x, 3);
    }
    const o = (oy * width + ox) * 3;
    if (a > maxAlpha) maxAlpha = a;
    if (a === 255) {
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    } else {
      const k = a / 255;
      out[o] = Math.round(r * k + 255 * (1 - k));
      out[o + 1] = Math.round(g * k + 255 * (1 - k));
      out[o + 2] = Math.round(b * k + 255 * (1 - k));
    }
  };
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  let off = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx),
      ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * bitsPP) / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const filter = raw[off];
      const row = new Uint8Array(raw.buffer, raw.byteOffset + off + 1, stride).slice();
      off += 1 + stride;
      unfilter(filter, row, prev, bpp);
      for (let x = 0; x < pw; x++) put(row, x, x0 + x * dx, y0 + y * dy);
      prev = row;
    }
  }
  return { width, height, data: out, maxAlpha };
}

/** A PNG with no visible pixel (every alpha at most 2 of 255); false for anything that does not decode. */
export function isBlankPng(input: Uint8Array): boolean {
  try {
    return (decodePng(input).maxAlpha ?? 255) <= 2;
  } catch {
    return false;
  }
}

function unfilter(f: number, row: Uint8Array, prev: Uint8Array, bpp: number) {
  const n = row.length;
  if (f === 0) return;
  if (f === 1) {
    for (let i = bpp; i < n; i++) row[i] = (row[i] + row[i - bpp]) & 255;
    return;
  }
  if (f === 2) {
    for (let i = 0; i < n; i++) row[i] = (row[i] + prev[i]) & 255;
    return;
  }
  if (f === 3) {
    for (let i = 0; i < n; i++) row[i] = (row[i] + (((i >= bpp ? row[i - bpp] : 0) + prev[i]) >> 1)) & 255;
    return;
  }
  if (f === 4) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? row[i - bpp] : 0,
        b = prev[i],
        c = i >= bpp ? prev[i - bpp] : 0;
      row[i] = (row[i] + paeth(a, b, c)) & 255;
    }
    return;
  }
  throw new Error(`bad PNG filter ${f}`);
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** Encode packed RGB as an 8-bit RGB PNG (per-row minimum-sum filter choice). */
export function encodePng({ width, height, data }: RgbImage): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  let prev: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    let best = 0,
      bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0,
          b = prev[i],
          c = i >= 3 ? prev[i - 3] : 0;
        const v =
          (row[i] - (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) &
          255;
        o[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    raw.set(cand[best], y * (stride + 1) + 1);
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rows `y0 … y0 + h` of an image (clamped), as a new image. */
export function cropRows(img: RgbImage, y0: number, h: number): RgbImage {
  const top = Math.max(0, Math.min(img.height, Math.round(y0)));
  const bottom = Math.max(top, Math.min(img.height, Math.round(y0 + h)));
  const stride = img.width * 3;
  return { width: img.width, height: bottom - top, data: img.data.slice(top * stride, bottom * stride) };
}
