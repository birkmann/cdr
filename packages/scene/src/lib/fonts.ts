// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md). Only the font-file helpers are ported;
// the app's bundled / uploaded font loading stays in the earlier project.
import { inflateSync } from "node:zlib";

let projectFamilies: readonly string[] = [];

export type FontFormat = "truetype" | "opentype" | "woff" | "woff2";
export interface UploadedFontMeta {
  id: string;
  family: string;
  /** CSS font-weight ('400', '700' or a variable range '100 900') */
  weight: string;
  style: "normal" | "italic";
  fileName: string;
  format: FontFormat;
  size: number;
  addedAt: number;
}
interface UploadedFontRecord extends UploadedFontMeta {
  data: ArrayBuffer;
}

export const FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];
export const FONT_ACCEPT = FONT_EXTENSIONS.join(",");

export function fontFormatOf(fileName: string): FontFormat | null {
  const ext = fileName.toLowerCase().match(/\.(ttf|otf|woff2?|)$/)?.[1];
  return ext === "ttf"
    ? "truetype"
    : ext === "otf"
      ? "opentype"
      : ext === "woff"
        ? "woff"
        : ext === "woff2"
          ? "woff2"
          : null;
}

const WEIGHT_WORDS: Array<[RegExp, number]> = [
  [/(hairline|thin)/i, 100],
  [/(extra|ultra)[-_ ]?light/i, 200],
  [/light/i, 300],
  [/(semi|demi)[-_ ]?bold/i, 600],
  [/(extra|ultra)[-_ ]?bold/i, 800],
  [/(black|heavy)/i, 900],
  [/bold/i, 700],
  [/medium/i, 500],
  [/(regular|normal|book|roman)/i, 400],
];
const STYLE_TOKENS =
  /^(semi|demi|extra|ultra|thin|hairline|extralight|ultralight|light|regular|normal|book|roman|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique|variable|variablefont|vf|wght|ital|opsz|wdth|latin|ext|subset|webfont|web|\d{3})$/i;

/** "OpenSans-SemiBoldItalic.woff2" → { family: 'Open Sans', weight: '600', style: 'italic' } (best effort). */
export function parseFontFileName(fileName: string): {
  family: string;
  weight: string;
  style: "normal" | "italic";
} {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "");
  const style: "normal" | "italic" = /(italic|oblique)/i.test(base) ? "italic" : "normal";
  const variable = /(variable|\[wght|wght\]|[-_]vf\b|VariableFont)/i.test(base);
  let weight = variable ? "100 900" : "400";
  if (!variable) {
    const parts = base.split(/[-_ ]/).slice(1).join(" ") || base;
    for (const [re, w] of WEIGHT_WORDS)
      if (re.test(parts)) {
        weight = String(w);
        break;
      }
    const num = base.match(/(?:^|[-_ ])([1-9]00)(?:$|[-_ ])/);
    if (num) weight = num[1]!;
  }
  const words = base
    .replace(/\[[^\]]*\]/g, " ")
    .split(/[-_ ]+/)
    .flatMap((w) => w.replace(/([a-z])([A-Z])/g, "$1 $2").split(" "))
    .filter(Boolean);
  // drop trailing weight/style words ("Inter Bold Italic" → "Inter"), keep at least one word
  while (words.length > 1 && STYLE_TOKENS.test(words[words.length - 1]!)) words.pop();
  const mid = words.findIndex((w, i) => i > 0 && STYLE_TOKENS.test(w));
  const fam = (mid > 0 ? words.slice(0, mid) : words).join(" ").trim();
  return { family: fam || base || "Uploaded font", weight, style };
}

/** Read the family name (name id 16 typographic family, else 1) from an sfnt (TTF/OTF) or WOFF1 font. WOFF2 → null. */
export function parseFontFamilyName(buffer: ArrayBuffer): string | null {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 12) return null;
    const tag = view.getUint32(0);
    let nameTable: DataView | null = null;
    if (tag === 0x774f4646 /* wOFF */) {
      const numTables = view.getUint16(12);
      for (let i = 0; i < numTables; i++) {
        const o = 44 + i * 20;
        if (view.getUint32(o) !== 0x6e616d65 /* name */) continue;
        const offset = view.getUint32(o + 4),
          compLength = view.getUint32(o + 8),
          origLength = view.getUint32(o + 12);
        const raw = new Uint8Array(buffer, offset, compLength);
        const bytes = compLength !== origLength ? new Uint8Array(inflateSync(raw)) : raw.slice();
        nameTable = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
    } else if (tag === 0x00010000 || tag === 0x4f54544f /* OTTO */ || tag === 0x74727565 /* true */) {
      const numTables = view.getUint16(4);
      for (let i = 0; i < numTables; i++) {
        const o = 12 + i * 16;
        if (view.getUint32(o) !== 0x6e616d65) continue;
        nameTable = new DataView(buffer, view.getUint32(o + 8), view.getUint32(o + 12));
      }
    }
    if (!nameTable) return null;
    const count = nameTable.getUint16(2),
      strings = nameTable.getUint16(4);
    const found: Record<number, string> = {};
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      const platform = nameTable.getUint16(r),
        encoding = nameTable.getUint16(r + 2),
        nameId = nameTable.getUint16(r + 6);
      const len = nameTable.getUint16(r + 8),
        off = nameTable.getUint16(r + 10);
      if (nameId !== 1 && nameId !== 16) continue;
      if (found[nameId] && platform !== 3) continue;
      const start = strings + off;
      let s = "";
      if (platform === 3 || platform === 0 || (platform === 2 && encoding === 1)) {
        for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode(nameTable.getUint16(start + j));
      } else {
        for (let j = 0; j < len; j++) s += String.fromCharCode(nameTable.getUint8(start + j));
      }
      s = s.replace(/\0/g, "").trim();
      if (s) found[nameId] = s;
    }
    return found[16] ?? found[1] ?? null;
  } catch {
    return null;
  }
}

/** Called by lib/projectFonts.ts whenever the open project's fonts change. */
export function setProjectFontFamilies(families: readonly string[]): void {
  projectFamilies = [...families];
}
export const projectFontFamilyNames = (): readonly string[] => projectFamilies;
