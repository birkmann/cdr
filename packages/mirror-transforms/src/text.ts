/**
 * Small, pure string helpers shared by all adapters (slugs, ids, text normalisation for verify).
 */

const TRANSLIT: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  Ä: "Ae",
  Ö: "Oe",
  Ü: "Ue",
  ß: "ss",
  ẞ: "SS",
  æ: "ae",
  Æ: "Ae",
  œ: "oe",
  Œ: "Oe",
  ø: "o",
  Ø: "O",
  å: "a",
  Å: "A",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "Th",
  ı: "i",
};

/** Transliterate German umlauts & common ligatures, then strip remaining combining diacritics. */
export function transliterate(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) out += TRANSLIT[ch] ?? ch;
  return out.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * URL slug like pathauto: "Fünf Tipps für's Frühstück!" -> "fuenf-tipps-fuers-fruehstueck".
 * Lowercase ASCII, words separated by single "-", no leading/trailing dashes.
 */
export function slugify(s: string): string {
  return transliterate(s)
    .toLowerCase()
    .replace(/['’`´]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Split an identifier or phrase into words: "field_foo-bar Baz", "fooBar", "HTMLParser" all work. */
function words(s: string): string[] {
  return transliterate(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** "landing_page" -> "landingPage", "teaser-list" -> "teaserList", "Über uns" -> "ueberUns" */
export function toCamelCase(s: string): string {
  const ws = words(s);
  if (!ws.length) return "";
  return ws[0].toLowerCase() + ws.slice(1).map(cap).join("");
}

/** "teaser_list" -> "TeaserList", "hero" -> "Hero" */
export function toPascalCase(s: string): string {
  return words(s).map(cap).join("");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  shy: "\u00ad",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
};

/** Decode the HTML entities that commonly survive in extracted text (named subset + all numeric). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

/**
 * Normalise text for comparisons (verify content diff): decode entities, Unicode NFC, drop
 * zero-width chars and soft hyphens, map NBSP/exotic spaces to " ", collapse whitespace, trim.
 * Case and punctuation are preserved.
 */
export function normalizeText(s: string): string {
  return decodeEntities(s)
    .normalize("NFC")
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "")
    .replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, " ")
    .trim();
}
