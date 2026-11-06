// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Brand guide (DESIGN.md) — the YAML the front matter needs, written the way the examples write it
// (design-md--generator/spec/format.md §2): plain scalars where they are safe (`alpha`, `64px`, `14px 32px`,
// `700`), double quotes for hexes, refs (`"{colors.primary}"`), URLs and prose, literal blocks (`|`) for multi-paragraph
// text. Emitting only; the checks parse it with design-md--generator/cli/lint.mjs. Pure.

/** Double-quoted YAML scalar (JSON escaping is valid YAML). */
export const quoted = (s: string) => JSON.stringify(s);

const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

/** Plain scalar when YAML reads it back as the same string (or number), else double-quoted. */
export function scalar(v: string | number): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : quoted(String(v));
  const s = v;
  if (!s || s !== s.trim() || RESERVED.test(s) || /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) || /[\n\t"]/.test(s))
    return quoted(s);
  if (/^[-?:,[\]{}#&*!|>'%@`]/.test(s) || /:\s|\s#|:$/.test(s)) return quoted(s);
  return s;
}

/** Number as the examples write it: `1.05`, `1.0`, `700` (`decimal` keeps one decimal on whole numbers). */
export const decimal = (v: number, d = 2) => {
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return Number.isInteger(r) ? r.toFixed(1) : String(r);
};

/** `key: |` literal block, each line indented by `indent` + 2 spaces. */
export function block(key: string, text: string, indent = 0): string[] {
  const pad = " ".repeat(indent);
  return [
    `${pad}${key}: |`,
    ...text
      .replace(/\r\n?/g, "\n")
      .trim()
      .split("\n")
      .map((l) => (l.trim() ? `${pad}  ${l.trimEnd()}` : "")),
  ];
}

/** `key:` + `- item` list (items quoted, like the examples' seo lists). */
export function list(key: string, items: string[], indent = 0, quote = true): string[] {
  const pad = " ".repeat(indent);
  return [`${pad}${key}:`, ...items.map((x) => `${pad}  - ${quote ? quoted(x) : scalar(x)}`)];
}
