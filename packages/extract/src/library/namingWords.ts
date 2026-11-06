// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// What the captured copy names that a component must not be named after: its products, brands, customers, people,
// places and events ("Maximo", "Trivago", "FlashSystem", "November"). Learned from the capture's own text statistics —
// a word written capitalised mid-sentence (or with inner capitals, or in capitals) and never in lower case — minus the
// common English words a component name is made of ("Newsletter", "Footer", "Search", "Card"). Pure.
import { foldWords, transliterate } from "./naming.js";

/** Folded like `foldWords` ("Fuer" → "fur"). */
const fold = (w: string) => w.toLowerCase().replace(/([aou])e/g, "$1");

/**
 * Common English words of component names and of page copy that are structure or role, not a product: they stay usable
 * even when the copy writes them capitalised ("Newsletter", "Tickets", "Cloud", "Case Study").
 */
const COMMON = new Set(
  `
a about access account action actions ad add address advice after alert all also alt an and announcement app apps
archive area article articles as at author award awards back badge banner bar based basket benefits best big block
blog board body book booking bottom box brand breadcrumb browse business button buy by call campaign card cards care
career careers carousel cart case categories category center centre chat check checkout chip choose client clients
close cloud collection column columns comment comments community company compare consulting contact content contents
cookie copy country course courses cover create cta customer customers dashboard data date day days deal deals
demo description design detail details developer developers dialog digital discover display document documentation
documents download downloads drawer dropdown edit editorial email energy enterprise entry event events explore faq
feature featured features feed field fields filter filters find first footer for form forms free from full gallery
get global go grid group guide guides headline header heading help hero highlight highlights history home hub icon
icons image images in industries industry info information insight insights intro introduction investor investors
item items job jobs join just key label landing language languages latest launch layout learn legal library line
link links list listing live load location locations login logo main manage map market marketing masthead media
member members menu message mobile modal more most my nav navigation network new news newsletter next note now of
offer offers on one online open option options or order our overview page pages pagination panel partner partners
people pick plan plans platform play policy popular portal post posts press preview price prices pricing primary
privacy product products profile program programs project projects promo promotion quick quote rating read recent
register related report reports request research resource resources result results review reviews right row sale
save schedule search secondary section sections security see select service services session settings share shop
show sidebar sign signup site size skip slide slider small social software solution solutions sort spotlight stage
start stat stats status step steps store stories story study subscribe success summary support system systems tab
table tabs tag tags team teaser technology terms testimonial testimonials text the this tile tiles time tip tips to
today tool tools top topic topics tour training trending trial try update updates us use user users video videos
view watch web webinar webinars welcome what where who why with work world you your
`
    .trim()
    .split(/\s+/)
    .map((w) => fold(w)),
);

/** The words of a text, keeping their case (letters and digits; other scripts transliterated). */
const tokens = (s: string) => transliterate(s).match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];

/** English function words: how much of the copy is English (a name word shared with other-language copy is copy). */
const EN_STOP = new Set([
  "the",
  "and",
  "of",
  "to",
  "in",
  "for",
  "with",
  "on",
  "is",
  "are",
  "your",
  "our",
  "you",
  "we",
  "how",
  "what",
  "from",
  "by",
  "at",
  "more",
  "this",
  "that",
  "it",
  "be",
  "can",
  "an",
  "or",
  "as",
]);

/**
 * The proper-noun tokens of the captured copy (folded like `foldWords`, an inner-capital word whole: "flashsystem"):
 * written capitalised after a sentence's first word, with inner capitals ("FlashSystem", "iPhone"), or in capitals
 * ("IBM") — and never in lower case anywhere in the copy, and not a common word. When the copy is not English, every
 * word of it that is not a common English word counts (an English component name holding it took it from the copy:
 * "trivago", "watsonx", "Zukunft").
 */
export function properTokens(texts: Iterable<string>): Set<string> {
  const proper = new Set<string>();
  const lower = new Set<string>();
  const all = new Set<string>();
  let words = 0,
    english = 0;
  for (const t of texts) {
    // (line breaks of the capture fall mid-sentence; "12. November": a date's dot ends no sentence)
    for (const sentence of t.replace(/\s+/g, " ").split(/(?<=\p{L}{2})[.!?]+(?=\s|$)|[:;•|·–—]+/u)) {
      tokens(sentence).forEach((w, i) => {
        words++;
        if (EN_STOP.has(w.toLowerCase())) english++;
        if (w.length < 3 || /^\d/.test(w)) return;
        const f = fold(w);
        all.add(f);
        if (/^[a-z][a-z0-9]*$/.test(w)) {
          lower.add(f);
          return;
        }
        const inner = /[a-z][A-Z]/.test(w);
        const caps = /^[A-Z][A-Z0-9]+$/.test(w);
        if (inner || caps || (i > 0 && /^[A-Z][a-z]/.test(w))) proper.add(f);
      });
    }
  }
  for (const w of [...proper]) if (lower.has(w)) proper.delete(w);
  if (words >= 40 && english / words < 0.04) for (const w of all) proper.add(w);
  for (const w of [...proper]) if (COMMON.has(w)) proper.delete(w);
  return proper;
}

/** The proper-noun token a name is made with (a word, or two adjacent words: Flash + System → "flashsystem"), or null. */
export function properTokenIn(name: string, proper: ReadonlySet<string>): string | null {
  if (!proper.size) return null;
  const w = foldWords(name);
  for (let i = 0; i < w.length; i++) {
    if (w[i]!.length >= 3 && proper.has(w[i]!)) return w[i]!;
    if (i + 1 < w.length && proper.has(w[i]! + w[i + 1]!)) return w[i]! + w[i + 1]!;
  }
  return null;
}
