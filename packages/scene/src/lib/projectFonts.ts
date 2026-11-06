// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Project font assets: web fonts that travel with ONE project (imported by the user or brought along by an importer,
// e.g. the real typeface of a crawled site). Unlike device-wide uploads (lib/fonts.ts, IndexedDB 'cdr-fonts')
// they are part of the project document (`ProjectDocument.fonts`, store `projectFonts`): the font bytes are a
// `data:` URL, which lib/persistAssets.ts moves out of line like images, so they survive reload, export with the
// .frst.json and need no network. At runtime each face is registered with the FontFace API under its family name,
// so the DSL references it like any other family (`style.fontFamily: 'Transit'`, tokens.fontFamily).
import {
  fontFormatOf,
  parseFontFamilyName,
  parseFontFileName,
  setProjectFontFamilies,
  type FontFormat,
} from "./fonts.js";

export interface ProjectFont {
  /** stable per face: derived from family / weight / style / unicode-range (re-importing a face replaces it) */
  id: string;
  family: string;
  /** CSS font-weight: '400', '700' or a variable range '100 900' */
  weight: string;
  style: "normal" | "italic";
  stretch?: string;
  /** CSS unicode-range of a subset face (absent = whole font) */
  unicodeRange?: string;
  format: FontFormat;
  /** `data:font/woff2;base64,…` (a `cdr-asset:` reference while stored) */
  src: string;
  size: number;
  fileName?: string;
  /** where the file came from (crawled URL, original file path…) */
  sourceUrl?: string;
  /** licence / copyright hint shown in the font manager (proprietary fonts must not leave the device) */
  license?: string;
  origin?: "upload" | "import";
  addedAt: number;
}

export const FONT_MIME: Record<FontFormat, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  truetype: "font/ttf",
  opentype: "font/otf",
};
const EXT: Record<FontFormat, string> = { woff2: "woff2", woff: "woff", truetype: "ttf", opentype: "otf" };

/* ------------------------------------------------------------------ bytes ⇄ data URL */

type Bytes = ArrayBuffer | Uint8Array;

const u8 = (b: Bytes) => (b instanceof Uint8Array ? b : new Uint8Array(b));

export function bytesToBase64(bytes: Bytes): string {
  const b = u8(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Bytes of a base64 / percent-encoded data URL (null for anything else, e.g. an unresolved asset reference). */
export function dataUrlBytes(src: string): Uint8Array<ArrayBuffer> | null {
  const m = /^data:[^,]*?(;base64)?,/.exec(src);
  if (!m) return null;
  const body = src.slice(m[0].length);
  if (!m[1]) return new TextEncoder().encode(decodeURIComponent(body));
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Format from the file's magic bytes (falls back to the file name). */
export function sniffFontFormat(bytes: Bytes, fileName = ""): FontFormat | null {
  const b = u8(bytes);
  if (b.length >= 4) {
    const tag = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!);
    if (tag === "wOF2") return "woff2";
    if (tag === "wOFF") return "woff";
    if (tag === "OTTO") return "opentype";
    if (tag === "true" || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)) return "truetype";
  }
  return fontFormatOf(fileName);
}

/* ------------------------------------------------------------------ building faces */

const WEIGHT_NUM = /^\d{1,4}(\.\d+)?$/;
const weightNum = (v: string) => WEIGHT_NUM.test(v) && Number(v) >= 1 && Number(v) <= 1000;
/**
 * A CSS font-weight from untrusted input (crawled stylesheets, stored projects): a number 1–1000, a range of two
 * ("100 900") or normal / bold / lighter / bolder, whitespace collapsed and lower-cased; anything else → null. Weights
 * end up in file paths (projectFontFileName) and @font-face rules, so nothing outside this grammar may pass.
 */
export function safeFontWeight(w: string | number | undefined | null): string | null {
  const v = String(w ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (/^(normal|bold|lighter|bolder)$/.test(v)) return v;
  const parts = v.split(" ");
  return parts.length <= 2 && parts.every(weightNum) ? v : null;
}
const normWeight = (w: string | number | undefined) => {
  const v = safeFontWeight(w ?? "400") ?? "400";
  return v === "normal" ? "400" : v === "bold" ? "700" : v;
};
const normRange = (r: string | undefined | null) => {
  const v = safeUnicodeRange(r);
  return !v || v === "U+0-10FFFF" ? undefined : v;
};

/** FNV-1a → short hex (ids only; not security relevant). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const projectFontKey = (f: Pick<ProjectFont, "family" | "weight" | "style" | "unicodeRange">) =>
  `${f.family.trim().toLowerCase()}|${normWeight(f.weight)}|${f.style}|${normRange(f.unicodeRange) ?? ""}`;

export interface FontFromBytesOptions {
  fileName?: string;
  /** family the design references (e.g. the CSS family of a crawled @font-face); default: the font's name table / file name */
  family?: string;
  weight?: string | number;
  style?: string;
  stretch?: string;
  unicodeRange?: string | null;
  sourceUrl?: string;
  license?: string | null;
  origin?: ProjectFont["origin"];
}

/** A project font from raw bytes (null when the bytes are not a font). */
export function projectFontFromBytes(bytes: Bytes, o: FontFromBytesOptions = {}): ProjectFont | null {
  const b = u8(bytes);
  const format = sniffFontFormat(b, o.fileName);
  if (!format || b.length < 12) return null;
  const fromName = o.fileName ? parseFontFileName(o.fileName) : null;
  const family = (
    o.family?.trim() ||
    parseFontFamilyName(b.slice().buffer as ArrayBuffer) ||
    fromName?.family ||
    "Imported font"
  )
    .trim()
    .replace(/^["']|["']$/g, "");
  const style: ProjectFont["style"] = /italic|oblique/i.test(o.style ?? fromName?.style ?? "")
    ? "italic"
    : "normal";
  const f: Omit<ProjectFont, "id"> = {
    family,
    weight: normWeight(o.weight ?? fromName?.weight),
    style,
    format,
    src: `data:${FONT_MIME[format]};base64,${bytesToBase64(b)}`,
    size: b.length,
    origin: o.origin ?? "upload",
    addedAt: Date.now(),
  };
  const range = normRange(o.unicodeRange);
  if (range) f.unicodeRange = range;
  const stretch = safeFontStretch(o.stretch);
  if (stretch && stretch !== "normal" && stretch !== "100%") f.stretch = stretch;
  if (o.fileName) f.fileName = o.fileName;
  if (o.sourceUrl) f.sourceUrl = o.sourceUrl;
  if (o.license) f.license = o.license;
  return { id: `pf-${fnv(projectFontKey(f as ProjectFont))}`, ...f };
}

export interface ProjectFontFilesResult {
  fonts: ProjectFont[];
  rejected: Array<{ fileName: string; reason: string }>;
}

/** Font files picked or dropped by the user → project fonts (family from the name table, weight/style from the name). */
export async function projectFontsFromFiles(files: File[]): Promise<ProjectFontFilesResult> {
  const out: ProjectFontFilesResult = { fonts: [], rejected: [] };
  for (const file of files) {
    if (!fontFormatOf(file.name)) {
      out.rejected.push({ fileName: file.name, reason: "not a .ttf, .otf, .woff or .woff2 file" });
      continue;
    }
    const f = projectFontFromBytes(await file.arrayBuffer(), { fileName: file.name });
    if (f) out.fonts.push(f);
    else out.rejected.push({ fileName: file.name, reason: "not a font file" });
  }
  return out;
}

/** `existing` with `incoming` added; a face with the same family/weight/style/range is replaced. */
export function mergeProjectFonts(
  existing: readonly ProjectFont[],
  incoming: readonly ProjectFont[],
): ProjectFont[] {
  const byKey = new Map(existing.map((f) => [projectFontKey(f), f]));
  for (const f of incoming) byKey.set(projectFontKey(f), f);
  return [...byKey.values()];
}

export const projectFontFamilies = (fonts: readonly ProjectFont[]): string[] => [
  ...new Set(fonts.map((f) => f.family)),
];

/** Loose shape check for documents read back from storage / .frst.json files. */
export function isProjectFont(v: unknown): v is ProjectFont {
  const f = v as ProjectFont;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof f.id === "string" &&
    typeof f.family === "string" &&
    typeof f.weight === "string" &&
    typeof f.src === "string" &&
    (f.style === "normal" || f.style === "italic")
  );
}

/* (runtime FontFace registration for the design canvas is not ported) */

/* ------------------------------------------------------------------ export */

/**
 * A CSS string literal for untrusted text (font family names): quotes, backslashes, newlines and `<` (the CSS may sit in
 * an HTML `<style>`) as hex escapes, so the value can neither end the string nor the rule nor the element.
 */
export const cssStr = (s: string) =>
  `'${s.replace(/[\\'"<>\n\r\f\0-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}'`;
/** A `unicode-range` value (`U+0000-00FF, U+0131`) or null. */
export function safeUnicodeRange(r: string | null | undefined): string | null {
  const v = (r ?? "").replace(/\s+/g, "").toUpperCase();
  return /^U\+[0-9A-F?]{1,6}(-[0-9A-F]{1,6})?(,U\+[0-9A-F?]{1,6}(-[0-9A-F]{1,6})?)*$/.test(v)
    ? v.replace(/,/g, ", ")
    : null;
}
/** A `font-stretch` value (keyword, percentage or a range of two percentages) or null. */
export function safeFontStretch(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return /^((ultra-|extra-|semi-)?(condensed|expanded)|normal)$/.test(t) ||
    /^\d{1,3}(\.\d+)?% ?(\d{1,3}(\.\d+)?%)?$/.test(t)
    ? t
    : null;
}
const safeStyle = (v: string | undefined) => (v === "italic" ? "italic" : "normal");
const SAFE_DATA_URL = /^data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]*$/;

const wanted = (families?: Iterable<string>) => {
  if (!families) return () => true;
  const set = new Set(
    [...families].map((f) =>
      f
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase(),
    ),
  );
  return (f: ProjectFont) => set.has(f.family.toLowerCase());
};

export interface FontFaceCssOptions {
  /** only these families (case-insensitive); default all */
  families?: Iterable<string>;
  /** URL written into `src` (default: the embedded data URL) */
  url?: (f: ProjectFont) => string;
}

/** `@font-face` rules for project fonts (self-contained by default: the bytes are inlined as data URLs). */
export function projectFontFaceCss(fonts: readonly ProjectFont[], o: FontFaceCssOptions = {}): string {
  const keep = wanted(o.families);
  return fonts
    .filter((f) => keep(f) && (o.url || f.src.startsWith("data:")))
    .map((f) =>
      [
        "@font-face {",
        `  font-family: ${cssStr(f.family)};`,
        `  src: url(${o.url ? cssStr(o.url(f)) : SAFE_DATA_URL.test(f.src) ? `"${f.src}"` : cssStr(f.src)}) format('${EXT[f.format] ? f.format : "woff2"}');`,
        `  font-weight: ${safeFontWeight(f.weight) ?? "400"};`,
        `  font-style: ${safeStyle(f.style)};`,
        ...(safeFontStretch(f.stretch) ? [`  font-stretch: ${safeFontStretch(f.stretch)};`] : []),
        ...(safeUnicodeRange(f.unicodeRange)
          ? [`  unicode-range: ${safeUnicodeRange(f.unicodeRange)};`]
          : []),
        "  font-display: swap;",
        "}",
      ].join("\n"),
    )
    .join("\n");
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "font";

/** Path a project font gets inside an export bundle (unique per face). */
export const projectFontFileName = (f: ProjectFont) =>
  `fonts/${slug(f.family)}-${slug(safeFontWeight(f.weight) ?? "400")}${f.style === "italic" ? "-italic" : ""}-${slug(f.id.slice(3, 9))}.${EXT[f.format] ?? "woff2"}`;

export interface ProjectFontFile {
  family: string;
  file: string;
  weight: string;
  style: string;
  format: FontFormat;
  unicodeRange?: string;
  data: Uint8Array;
}

/** Font files for an export bundle (families filter as in projectFontFaceCss). */
export function projectFontFiles(
  fonts: readonly ProjectFont[],
  families?: Iterable<string>,
): ProjectFontFile[] {
  const keep = wanted(families);
  const out: ProjectFontFile[] = [];
  for (const f of fonts) {
    if (!keep(f)) continue;
    const data = dataUrlBytes(f.src);
    if (data)
      out.push({
        family: f.family,
        file: projectFontFileName(f),
        weight: f.weight,
        style: f.style,
        format: f.format,
        ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
        data,
      });
  }
  return out;
}

/** Every `fontFamily` string anywhere in a value (DSL screens, design systems, text styles), first family of a stack. */
export function fontFamiliesIn(value: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 200) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === "fontFamily" && typeof x === "string") {
        const f = x
          .split(",")[0]!
          .trim()
          .replace(/^["']|["']$/g, "");
        if (f) out.add(f);
      } else visit(x, depth + 1);
    }
  };
  visit(value, 0);
  return out;
}
