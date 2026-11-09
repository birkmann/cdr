/**
 * Drupal date formats are PHP `date()` patterns ("jS F Y" → "25th October 2026", "d/m/Y - H:i"). Intl cannot print
 * every one of them (English ordinal suffixes, Drupal's translated month names in title case), so dates the source
 * printed with such a pattern are bound with `format: { kind: "date", pattern, locales, case }` and rendered by this
 * formatter (the generated app carries the same implementation in src/lib/render/runtime.tsx: `formatPhpDate`).
 * Month/day names come from Intl for the locale tag; `case: "title"` upper-cases their first letter (Drupal's es
 * interface translation prints "Octubre", Intl "octubre"). Times are UTC (JSON:API timestamps are UTC).
 */

/** PHP date() patterns of Drupal core + common theme formats, tried in this order */
export const PHP_DATE_PATTERNS = [
  "jS F Y",
  "j F Y",
  "d F Y",
  "F j, Y",
  "F jS, Y",
  "jS M Y",
  "j M Y",
  "d M Y",
  "M j, Y",
  "M jS, Y",
  "l, F j, Y",
  "l, j F Y",
  "D, m/d/Y - H:i",
  "l, F j, Y - H:i",
  "m/d/Y - H:i",
  "d/m/Y - H:i",
  "d.m.Y - H:i",
  "m/d/Y",
  "d/m/Y",
  "d.m.Y",
  "j. F Y",
  "Y-m-d",
  "F Y",
  "jS F",
  "j F",
];

export type DateCase = "title";

const ordinal = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th"));
const pad = (n: number) => String(n).padStart(2, "0");
const upperFirst = (s: string) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);

function name(d: Date, tag: string, opt: Intl.DateTimeFormatOptions, cs?: DateCase): string {
  let s: string;
  try {
    s = new Intl.DateTimeFormat(tag, { ...opt, timeZone: "UTC" }).format(d);
  } catch {
    s = new Intl.DateTimeFormat("en", { ...opt, timeZone: "UTC" }).format(d);
  }
  return cs === "title" ? upperFirst(s) : s;
}

/** PHP date(pattern) of an ISO timestamp in UTC, names in the Intl locale `tag` */
export function formatPhpDate(iso: string, pattern: string, tag: string, cs?: DateCase): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      out += pattern[++i] ?? "";
      continue;
    }
    const day = d.getUTCDate();
    const h = d.getUTCHours();
    switch (ch) {
      case "d": out += pad(day); break;
      case "j": out += String(day); break;
      case "S": out += ordinal(day); break;
      case "D": out += name(d, tag, { weekday: "short" }, cs); break;
      case "l": out += name(d, tag, { weekday: "long" }, cs); break;
      case "F": out += name(d, tag, { month: "long" }, cs); break;
      case "M": out += name(d, tag, { month: "short" }, cs).replace(/\.$/, ""); break;
      case "m": out += pad(d.getUTCMonth() + 1); break;
      case "n": out += String(d.getUTCMonth() + 1); break;
      case "Y": out += String(d.getUTCFullYear()); break;
      case "y": out += String(d.getUTCFullYear()).slice(-2); break;
      case "H": out += pad(h); break;
      case "G": out += String(h); break;
      case "g": out += String(h % 12 || 12); break;
      case "h": out += pad(h % 12 || 12); break;
      case "i": out += pad(d.getUTCMinutes()); break;
      case "s": out += pad(d.getUTCSeconds()); break;
      case "a": out += h < 12 ? "am" : "pm"; break;
      case "A": out += h < 12 ? "AM" : "PM"; break;
      default: out += ch;
    }
  }
  return out;
}

const LOCALE_TAGS: Record<string, string[]> = { en: ["en-GB", "en-US"], de: ["de-DE", "de-CH", "de-AT"], fr: ["fr-FR", "fr-CH"], it: ["it-IT"], es: ["es-ES"], nl: ["nl-NL"], pt: ["pt-PT", "pt-BR"] };

/** the PHP pattern (+ Intl tag and name case) that prints `iso` exactly as `shown` in `locale`, if one of the known ones does */
export function detectPhpDate(iso: string, shown: string, locale: string, patterns: string[] = PHP_DATE_PATTERNS): { pattern: string; tag: string; case?: DateCase } | undefined {
  const s = shown.replace(/\s+/g, " ").trim();
  if (!s || !/\d/.test(s) || Number.isNaN(new Date(iso).getTime())) return undefined;
  const tags = [...new Set([locale, ...(LOCALE_TAGS[locale.split("-")[0]] ?? [])])];
  for (const pattern of patterns)
    for (const tag of tags)
      for (const cs of [undefined, "title"] as const) {
        if (formatPhpDate(iso, pattern, tag, cs) === s) return { pattern, tag, ...(cs ? { case: cs } : {}) };
      }
  return undefined;
}
