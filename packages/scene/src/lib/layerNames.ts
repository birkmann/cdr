// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Layer names that say what a layer is: worth naming a component, prop or class-table key after. Imported pages name
// layers after their text ("Mehr erfahren"), their site's CSS classes ("Items center", "Bp:pt 4") or nothing in
// particular ("Group · Mizellen…", "Frame 12"); none of those name a part.

const GENERIC =
  /^(frame|group|div|span|container|wrapper|box|block|layer|rectangle|rect|element|item|inner|outer|content|contents|lucide|vector|svg|path|shape|section|stack|row|column|col|auto ?layout|instance|component|root|node|unnamed|untitled|layout)\s*\d*$/i;

/** First words of an imported site's CSS class turned layer name ("Items center", "Font header 6", "Bp:pt 4"; CSS-in-JS hashes "Sc jxm YRc" from sc-jxmYRc, "Css 1q2w3e"). */
const UTILITY_FIRST = new Set([
  "absolute",
  "relative",
  "fixed",
  "sticky",
  "static",
  "block",
  "inline",
  "hidden",
  "flex",
  "grid",
  "items",
  "justify",
  "content",
  "self",
  "place",
  "gap",
  "space",
  "cursor",
  "pointer",
  "rounded",
  "border",
  "bg",
  "text",
  "font",
  "leading",
  "tracking",
  "shadow",
  "opacity",
  "overflow",
  "z",
  "w",
  "h",
  "min",
  "max",
  "size",
  "p",
  "px",
  "py",
  "pt",
  "pr",
  "pb",
  "pl",
  "m",
  "mx",
  "my",
  "mt",
  "mr",
  "mb",
  "ml",
  "xpadding",
  "ypadding",
  "padding",
  "margin",
  "inset",
  "top",
  "left",
  "right",
  "bottom",
  "bp",
  "sm",
  "md",
  "lg",
  "xl",
  "col",
  "row",
  "order",
  "basis",
  "grow",
  "shrink",
  "object",
  "aspect",
  "transition",
  "duration",
  "ease",
  "transform",
  "translate",
  "scale",
  "rotate",
  "select",
  "visible",
  "invisible",
  "sr",
  "container",
  "wrapper",
  "js",
  "is",
  "has",
  "sc",
  "css",
  "jsx",
  "emotion",
  "u",
  "c",
  "l",
  "o",
  "t",
]);

/**
 * Namespace prefixes of CSS frameworks and widget libraries, as the importer spells their classes ("cds--card__content"
 * → "Cds card content", IBM Carbon; "swiper-slide" → "Swiper slide"): the site's markup, never a part's name. A capture's
 * own prefixes are learned on top (`classPrefixes`).
 */
export const FRAMEWORK_PREFIXES: ReadonlySet<string> = new Set([
  "cds",
  "bx",
  "c4d",
  "dds",
  "swiper",
  "owl",
  "slick",
  "splide",
  "glide",
  "flickity",
  "mdc",
  "mat",
  "mui",
  "chakra",
  "ant",
  "el",
  "wp",
  "et",
  "vc",
  "elementor",
  "fa",
  "bi",
  "mdi",
  "tw",
  "ng",
  "svelte",
  "jss",
  "aem",
  "cmp",
  "sc",
  "css",
  "emotion",
]);

/** "Cds card content": the importer's spelling of a CSS class (first letter up, the rest lower case, no punctuation). */
const CLASS_SHAPED = /^[A-Z][a-z0-9]*( [a-z0-9]+)*$/;
/** A short token without a vowel ("cds", "bx", "hdr"): an abbreviation, not a word. */
const noVowel = (w: string) => w.length >= 2 && w.length <= 4 && /^[a-z0-9]+$/.test(w) && !/[aeiouy]/.test(w);

/**
 * The CSS-class prefixes of a capture, from its own layer names: the first token of class-shaped names ("Cds card
 * content", "Cds tile", "Cds link list") that heads a large share of them, or that heads several and is an abbreviation
 * rather than a word. Feed it to `meaningfulLayerName` and the naming checks.
 */
export function classPrefixes(names: Iterable<string | undefined>): Set<string> {
  const heads = new Map<string, Set<string>>();
  let total = 0;
  for (const raw of names) {
    const n = raw?.split("·")[0]!.trim() ?? "";
    if (!CLASS_SHAPED.test(n) || !n.includes(" ")) continue;
    const first = n.split(" ")[0]!.toLowerCase();
    const seen = heads.get(first) ?? new Set<string>();
    if (!seen.has(n)) total++;
    seen.add(n);
    heads.set(first, seen);
  }
  const out = new Set<string>();
  for (const [w, seen] of heads) {
    if (GENERIC.test(w) || UTILITY_FIRST.has(w)) continue;
    if ((seen.size >= 3 && noVowel(w)) || (seen.size >= 4 && total >= 8 && seen.size / total >= 0.2))
      out.add(w);
  }
  return out;
}

/** A word that is the site's markup: a framework prefix, or one of the capture's own (`classPrefixes`). */
export function isClassToken(word: string, prefixes?: ReadonlySet<string>): boolean {
  const w = word.toLowerCase();
  return FRAMEWORK_PREFIXES.has(w) || !!prefixes?.has(w);
}

/**
 * The meaningful part of a layer name ("Button · Menü" → "Button"), or null when it is generic, a CSS class, too long,
 * truncated, or just the layer's own `text`. `prefixes`: the capture's own class prefixes (`classPrefixes`).
 */
export function meaningfulLayerName(
  name: string | undefined,
  text?: string,
  prefixes?: ReadonlySet<string>,
): string | null {
  if (!name) return null;
  const n = name.split("·")[0]!.trim();
  if (
    !n ||
    n.includes("…") ||
    n.split(/\s+/).length > 3 ||
    n.length > 28 ||
    GENERIC.test(n) ||
    /[:[\]&|/]/.test(n)
  )
    return null;
  // a custom element's tag name ("c4d-cta-block-item", "cds-masthead-logo"): the site's markup, not a part's name
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(n)) return null;
  const words = n.toLowerCase().split(/\s+/);
  if (UTILITY_FIRST.has(words[0]!) || words.some((w) => w.length === 1 && /[a-z]/.test(w))) return null;
  // a framework's class ("Cds card content", "Swiper slide"), or a class-shaped name led by an abbreviation ("Hdr nav")
  if (isClassToken(words[0]!, prefixes) || (CLASS_SHAPED.test(n) && noVowel(words[0]!))) return null;
  const letters = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  // the layer's own text, or a name made of its text ("Hautpflege BEGINNT HIER" over the span "BEGINNT HIER")
  if (
    text &&
    letters(text) &&
    (letters(text).startsWith(letters(n)) ||
      (letters(text).length >= 4 && letters(n).includes(letters(text).slice(0, 12))))
  )
    return null;
  return n;
}
