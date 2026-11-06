// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Checks on the model-written prose slots of DESIGN.md (design-md--generator/PLAN.md §6.4) before a slot is accepted:
// the shape of the answer, its length against the ranges measured on the examples, and grounding — every hex, px
// value, font weight, font name and {token.ref} in the text exists in the facts (or the tokens the writer emits from
// them), quoted strings were captured on the site, peer brands come from the corpus and only in a contrast the facts
// computed, and no absence is claimed that the facts contradict. Pure.
import type { BrandFacts, ProseSlots, SlotName } from "@harness/protocol";
import peers from "./peers.js";

/* ------------------------------------------------------------------ ranges (examples, spec/format.md) */

/** Item / paragraph counts per list slot [min, max] (spec/format.md §5). */
export const COUNT_RANGES = {
  overview: [3, 4],
  keyCharacteristics: [6, 8],
  typePrinciples: [4, 6],
  substitutes: [2, 4],
  gridNotes: [3, 6],
  decorativeDepth: [2, 3],
  photographyGeometry: [3, 5],
  dos: [7, 9],
  donts: [7, 9],
  touchTargets: [2, 3],
  collapsing: [4, 5],
  imageBehavior: [3, 4],
  iteration: [5, 8],
  knownGaps: [5, 7],
  mockups: [1, 3],
  "seo.tags": [1, 2],
  "seo.highlights": [5, 5],
  "seo.opening": [3, 3],
  "seo.questions": [5, 5],
} as const satisfies Record<string, readonly [number, number]>;

type Range = readonly [number, number];
export interface TextRange {
  chars?: Range;
  words?: Range;
}

/** Length of one text (spec/format.md §5; chars where the spec has none). */
export const TEXT_RANGES = {
  description: { words: [60, 145] },
  "seo.title": { chars: [20, 60] },
  "seo.metaDescription": { chars: [130, 160] },
  "seo.tag": { chars: [3, 40] },
  "seo.highlight": { words: [15, 35] },
  /** the three paragraphs together */
  "seo.opening": { words: [190, 400] },
  "seo.question.title": { chars: [15, 120] },
  "seo.question.answer": { words: [20, 140] },
  paragraph: { words: [35, 160] },
  bullet: { chars: [20, 320] },
  colorRole: { chars: [15, 320] },
  component: { chars: [60, 900] },
  fontFamily: { chars: [60, 900] },
  note: { chars: [60, 700] },
} as const satisfies Record<string, TextRange>;

export const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** "60–145 words" / "130–160 characters" (for the prompts). */
export function describeRange(r: TextRange): string {
  const [a, b] = r.words ?? r.chars ?? [0, 0];
  return `${a}–${b} ${r.words ? "words" : "characters"}`;
}

/** Mockup ids the shadcn DESIGN.md extension knows (examples). */
export const MOCKUPS = ["marketing-hero", "media-grid", "code-editor-ide"] as const;

/** Question ids every seo block has (plus one brand-specific signature id). */
export const QUESTION_IDS = ["primary-color", "typography", "use-in-project", "known-gaps"] as const;

/* ------------------------------------------------------------------ lexicons (detection only) */

/** Brands a model tends to compare with; any of them named must be in the facts' peer contrasts. */
const KNOWN_BRANDS = [
  "Apple",
  "Airbnb",
  "Stripe",
  "Cal.com",
  "Google",
  "Microsoft",
  "Mercedes-Benz",
  "Mercedes",
  "Audi",
  "Porsche",
  "Tesla",
  "Volkswagen",
  "Volvo",
  "Nike",
  "Adidas",
  "Spotify",
  "Netflix",
  "Amazon",
  "Shopify",
  "Notion",
  "Figma",
  "Uber",
  "Samsung",
  "IBM",
  "Facebook",
  "Instagram",
  "Twitter",
  "Slack",
  "Dropbox",
  "Atlassian",
  "Lexus",
  "Hyundai",
  "Kia",
  "Nissan",
  "Ford",
  "Lamborghini",
  "Rolls-Royce",
  "Jaguar",
  "Land Rover",
  "Supabase",
  "Webflow",
  "Mailchimp",
  "Intercom",
  "HubSpot",
  "Salesforce",
  "Revolut",
  "Monzo",
  "Coinbase",
  "OpenAI",
  "Anthropic",
  "Raycast",
  "Superhuman",
  "Miro",
  "Canva",
  "Adobe",
  "Sony",
  "Peloton",
  "Patagonia",
  "IKEA",
  "Zalando",
  "Lufthansa",
  "BMW",
  "Toyota",
  "Honda",
  "Ferrari",
  "Bentley",
  "Vercel",
  "GitHub",
  "Astro",
];

/** Typefaces a model tends to name; any of them named must be in the facts (families, stacks, substitutes). */
const KNOWN_FONTS = [
  "Inter",
  "Roboto Mono",
  "Roboto Condensed",
  "Roboto",
  "Helvetica Neue",
  "Helvetica",
  "Arial",
  "Verdana",
  "Tahoma",
  "Georgia",
  "Times New Roman",
  "Futura",
  "Avenir",
  "Gotham",
  "Proxima Nova",
  "Graphik",
  "Neue Haas",
  "Akzidenz",
  "Univers",
  "Frutiger",
  "DIN",
  "Söhne",
  "Geist Mono",
  "Geist",
  "SF Pro",
  "SF Mono",
  "San Francisco",
  "Segoe UI",
  "Noto Sans",
  "Open Sans",
  "Source Sans",
  "Source Code Pro",
  "IBM Plex",
  "Montserrat",
  "Lato",
  "Poppins",
  "Saira",
  "DM Sans",
  "Manrope",
  "Work Sans",
  "Nunito",
  "Raleway",
  "Playfair",
  "Merriweather",
  "Oswald",
  "Barlow",
  "Space Grotesk",
  "Space Mono",
  "Archivo",
  "Rubik",
  "Karla",
  "PT Sans",
  "Ubuntu",
  "Mulish",
  "Figtree",
  "Sora",
  "Lexend",
  "Plus Jakarta Sans",
  "Public Sans",
  "Libre Franklin",
  "Hanken Grotesk",
  "Instrument Sans",
  "JetBrains Mono",
  "Fira Sans",
  "Fira Code",
  "Bebas Neue",
  "Menlo",
  "Consolas",
  "Courier New",
];

/** The peer corpus (peers.ts, built from design-md--generator/examples). */
function corpusNames(): string[] {
  const raw: unknown = peers;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { peers?: unknown }).peers)
      ? (raw as { peers: unknown[] }).peers
      : raw && typeof raw === "object"
        ? Object.values(raw as Record<string, unknown>)
        : [];
  const out: string[] = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const { name, slug } = p as { name?: unknown; slug?: unknown };
    if (typeof name === "string" && name.trim()) out.push(name.trim());
    if (typeof slug === "string" && slug.trim()) out.push(slug.trim());
  }
  return out;
}

/* ------------------------------------------------------------------ what the facts allow */

interface Allowed {
  hex: Set<string>;
  px: number[];
  weights: Set<number>;
  absentWeights: Set<number>;
  fonts: string[];
  refs: Record<"colors" | "typography" | "rounded" | "spacing" | "component", Set<string>>;
  texts: string[];
  /** lower-cased peer names / slugs the facts compare with */
  peers: Set<string>;
  /** names that are the brand itself */
  self: string[];
}

const norm = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[\s\u00a0]+/g, " ")
    .trim()
    .toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function normHex(h: string): string {
  const x = h.toLowerCase().replace(/^#/, "");
  return `#${x.length === 3 || x.length === 4 ? [...x].map((c) => c + c).join("") : x}`;
}

const HEX_RE = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z])/gi;
const PX_RE = /(?<![\w.])(-?\d+(?:\.\d+)?)\s?px\b/gi;

/** The facts minus what the site's users or the vision model wrote (texts, vision): the measured part. */
function measured(facts: BrandFacts): string {
  const { texts: _t, vision: _v, ...rest } = facts;
  return JSON.stringify(rest);
}

const cache = new WeakMap<BrandFacts, Allowed>();

function allowedOf(facts: BrandFacts): Allowed {
  const hit = cache.get(facts);
  if (hit) return hit;
  const json = measured(facts);
  const hex = new Set<string>([...json.matchAll(HEX_RE)].map((m) => normHex(m[0])));
  for (const c of facts.colors) hex.add(normHex(c.hex));
  const px = new Set<number>([0, 1]);
  for (const m of json.matchAll(PX_RE)) px.add(Number(m[1]));
  for (const t of facts.typography) {
    px.add(t.fontSize);
    px.add(t.letterSpacing);
    if (t.mobileSize != null) px.add(t.mobileSize);
  }
  for (const s of [...facts.rounded, ...facts.spacing]) px.add(s.value);
  for (const v of Object.values(facts.radiusByKind)) px.add(v);
  for (const v of [facts.baseUnit, facts.sectionRhythm, facts.cardPadding, facts.containerMax])
    if (typeof v === "number") px.add(v);
  for (const b of facts.breakpoints) {
    if (b.min != null) px.add(b.min);
    if (b.max != null) px.add(b.max);
  }
  for (const p of facts.pages) for (const w of p.widths) px.add(w);
  for (const g of facts.grids)
    for (const w of Object.keys(g.columnsByWidth)) if (Number.isFinite(Number(w))) px.add(Number(w));
  const weights = new Set<number>([
    ...facts.weights.used,
    ...facts.typography.map((t) => t.fontWeight),
    ...facts.fonts.flatMap((f) => f.weights),
  ]);
  const absentWeights = new Set(facts.weights.absent.filter((w) => !weights.has(w)));
  const fonts = new Set<string>();
  for (const f of facts.fonts) {
    fonts.add(f.family);
    for (const s of f.substitutes) fonts.add(s.family);
  }
  for (const t of facts.typography) {
    fonts.add(t.family);
    for (const part of t.fontFamily.split(",")) {
      const n = part.trim().replace(/^['"]|['"]$/g, "");
      if (n) fonts.add(n);
    }
  }
  const peers = new Set<string>();
  for (const p of facts.peers) for (const name of p.peers) peers.add(name.toLowerCase());
  const self = [facts.name, ...facts.name.split(/\s+/)].filter((s) => s.length > 1);
  const a: Allowed = {
    hex,
    px: [...px].filter(Number.isFinite),
    weights,
    absentWeights,
    fonts: [...fonts].map((f) => f.toLowerCase()),
    refs: {
      colors: new Set(facts.colors.map((c) => c.key)),
      typography: new Set(facts.typography.map((t) => t.key)),
      rounded: new Set(facts.rounded.map((s) => s.key)),
      spacing: new Set(facts.spacing.map((s) => s.key)),
      component: new Set(facts.components.map((c) => c.key)),
    },
    texts: [...facts.texts, ...facts.components.flatMap((c) => c.texts)].map(norm).filter(Boolean),
    peers,
    self,
  };
  cache.set(facts, a);
  return a;
}

/* ------------------------------------------------------------------ grounding of one text */

const ABSENCE =
  /\b(absent|missing|unused|not used|never|no|none|without|skips?|skipped|avoids?|lacks?|don['’]?t|do not)\b/i;

const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
const stripCode = (text: string) => text.replace(/`[^`]*`/g, " ");

/** Hexes in the text that the facts do not have. */
function checkHex(text: string, a: Allowed, where: string, errors: string[]) {
  for (const m of text.matchAll(HEX_RE))
    if (!a.hex.has(normHex(m[0]))) errors.push(`${where}: colour ${m[0]} is not a measured colour`);
}

function checkPx(text: string, a: Allowed, where: string, errors: string[]) {
  for (const m of text.matchAll(PX_RE)) {
    const v = Number(m[1]);
    if (!a.px.some((x) => Math.abs(x - v) < 0.051)) errors.push(`${where}: ${m[0]} is not a measured value`);
  }
}

const WEIGHT_RES = [
  /\bweights?\s*(?:of|at|:|=)?\s*((?:[1-9]00)(?:\s*(?:,|\/|and|or|&|–|-|to)\s*[1-9]00)*)\b/gi,
  /(?<![\w.#])([1-9]00)\s*(?=(?:weight|\((?:thin|extra ?light|light|book|regular|normal|medium|semi ?bold|bold|extra ?bold|heavy|black)\)))/gi,
  /(?<![\w.#])([1-9]00\s*\/\s*[1-9]00(?:\s*\/\s*[1-9]00)*)(?![\w.]|\s?px)/g,
];

function weightsIn(sentence: string): number[] {
  const out = new Set<number>();
  for (const re of WEIGHT_RES)
    for (const m of sentence.matchAll(re))
      for (const n of (m[1] ?? "").match(/[1-9]00/g) ?? []) out.add(Number(n));
  return [...out];
}

function checkWeights(text: string, a: Allowed, where: string, errors: string[]) {
  for (const s of sentencesOf(text)) {
    for (const w of weightsIn(s)) {
      if (a.weights.has(w)) {
        // "weight 700 is absent" while 700 is used
        if (
          new RegExp(
            `\\b${w}\\b[^.;,]{0,30}\\b(absent|missing|unused|not used|never used|skipped)\\b|\\b(no|never|without)\\b[^.;,]{0,20}\\bweight\\s*${w}\\b`,
            "i",
          ).test(s)
        ) {
          errors.push(`${where}: weight ${w} is used on the site, it is not absent`);
        }
        continue;
      }
      // (a don't names what the brand never does: an absent weight is its point)
      if (a.absentWeights.has(w)) {
        if (!ABSENCE.test(s) && !/^donts\b/.test(where))
          errors.push(`${where}: weight ${w} is not used on the site (it is absent)`);
        continue;
      }
      errors.push(`${where}: weight ${w} is not a measured weight`);
    }
  }
}

function checkFonts(text: string, a: Allowed, where: string, errors: string[]) {
  const seen = new Set<string>();
  for (const f of KNOWN_FONTS) {
    if (seen.has(f)) continue;
    if (!new RegExp(`(?<![\\w-])${escapeRe(f)}(?![\\w-])`).test(text)) continue;
    // "Helvetica" inside an allowed "Helvetica Neue", or "Inter" as an allowed family
    const lf = f.toLowerCase();
    if (a.fonts.some((x) => x === lf || x.includes(lf))) continue;
    // a longer known name already reported ("Roboto Mono" covers "Roboto")
    if ([...seen].some((s) => s.includes(f))) continue;
    seen.add(f);
    errors.push(`${where}: font "${f}" is not in the facts (families, stacks, substitutes)`);
  }
}

const REF_RE = /\{([a-z]+)\.([A-Za-z0-9_-]+)\}/g;

function checkRefs(text: string, a: Allowed, where: string, errors: string[]) {
  for (const m of text.matchAll(REF_RE)) {
    // the examples' Iteration Guide placeholder ("reference {token.refs}")
    if (m[0] === "{token.refs}") continue;
    const ns = m[1] === "components" ? "component" : m[1]!;
    const set = (a.refs as Record<string, Set<string>>)[ns];
    if (!set)
      errors.push(
        `${where}: ${m[0]} is not a token reference (use colors, typography, rounded, spacing, component)`,
      );
    else if (!set.has(m[2]!)) errors.push(`${where}: ${m[0]} does not exist`);
  }
}

const QUOTE_RE = /„([^“”„\n]{1,160})[“”]|“([^”\n]{1,160})”|"([^"\n]{1,160})"/g;

function checkQuotes(text: string, a: Allowed, where: string, errors: string[]) {
  for (const m of stripCode(text).matchAll(QUOTE_RE)) {
    const q = norm((m[1] ?? m[2] ?? m[3] ?? "").replace(/^[\s.,:;›»→…-]+|[\s.,:;›»→…-]+$/g, ""));
    if (!q) continue;
    if (!a.texts.some((t) => t === q || t.includes(q)))
      errors.push(`${where}: the quote "${q}" is not text captured on the site`);
  }
}

/** Words a sentence about a peer contrast must use, by the contrast's metric. */
const METRIC_WORDS: Array<[RegExp, RegExp]> = [
  [/radius|round|corner/i, /radius|radii|round|corner|square|pill|sharp|rectangular|circular/i],
  [/weight/i, /weight|bold|light|heavy|\b[1-9]00\b/i],
  [/shadow|elevation/i, /shadow|elevation|depth|flat/i],
  [/canvas|dark|light|background/i, /canvas|dark|light|background|surface|white|black/i],
  [/accent|colou?r|palette/i, /accent|colou?r|palette|hue/i],
  [/rhythm|spacing|section|padding/i, /rhythm|spacing|section|padding|whitespace|dense|air/i],
  [/font|type|family/i, /font|type|family|serif|sans/i],
  [/track|letter/i, /track|letter-spacing/i],
];

const CLAIM_STOP = new Set([
  "where",
  "while",
  "than",
  "with",
  "peer",
  "peers",
  "median",
  "brand",
  "brands",
  "other",
  "others",
  "more",
  "less",
  "their",
  "there",
  "this",
  "that",
  "from",
  "only",
]);

function claimFits(sentence: string, metric: string, claim: string): boolean {
  const words = METRIC_WORDS.filter(([m]) => m.test(metric)).map(([, w]) => w);
  if (words.some((w) => w.test(sentence))) return true;
  // unknown metric: the sentence shares a word of the metric or the computed claim
  const own = `${metric} ${claim}`
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 3 && !CLAIM_STOP.has(w));
  return own.some((w) => sentence.toLowerCase().includes(w));
}

function checkPeers(text: string, facts: BrandFacts, a: Allowed, where: string, errors: string[]) {
  const names = [...new Set([...KNOWN_BRANDS, ...corpusNames().filter((n) => /[A-Z]/.test(n))])];
  // quoted UI text and code are checked elsewhere; a brand the site itself names ("Google Play") is content, not a peer;
  // a typeface named after a brand ("IBM Plex Sans", a measured substitute) is a font, checked by the font rule
  const fontNames = [
    ...new Set([
      ...KNOWN_FONTS,
      ...facts.fonts.flatMap((f) => [f.family, ...f.substitutes.map((x) => x.family)]),
    ]),
  ]
    .filter(Boolean)
    .sort((x, y) => y.length - x.length);
  const fontRe = fontNames.length
    ? new RegExp(`(?<![\\w-])(${fontNames.map(escapeRe).join("|")})(?![\\w-])`, "g")
    : null;
  for (const s of sentencesOf(stripCode(text).replace(QUOTE_RE, " ")).map((x) =>
    fontRe ? x.replace(fontRe, " ") : x,
  )) {
    for (const name of names) {
      if (a.self.some((x) => x.toLowerCase() === name.toLowerCase())) continue;
      const re = new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])${name === "Google" ? "(?! Fonts)" : ""}`);
      if (!re.test(s) || facts.texts.some((t) => re.test(t))) continue;
      const lname = name.toLowerCase();
      if (!a.peers.has(lname)) {
        errors.push(`${where}: ${name} is not one of the peers the facts compare with`);
        continue;
      }
      const entries = facts.peers.filter((p) => p.peers.some((x) => x.toLowerCase() === lname));
      if (!entries.some((p) => claimFits(s, p.metric, p.claim)))
        errors.push(
          `${where}: the comparison with ${name} does not match a computed contrast (${entries.map((p) => p.metric).join(", ")})`,
        );
    }
  }
}

function checkAbsences(text: string, facts: BrandFacts, where: string, errors: string[]) {
  const s = text;
  // a blanket "no shadows" is false when the site has some; a claim scoped to parts that have none ("cards carry no
  // shadow") or qualified ("… except the floating icon button") is fine
  const shadowKinds = new Set(facts.elevation.shadows.flatMap((x) => x.kinds));
  const NOUNS: Array<[RegExp, string[]]> = [
    [/\bcards?\b|\btiles?\b|\bteasers?\b/i, ["card", "teaser", "list-item"]],
    [/\bbuttons?\b|\bctas?\b/i, ["button"]],
    [/\bnav(igation)?\b|\bheader\b|\btop[- ]nav\b/i, ["header", "navigation"]],
    [/\bfooter\b/i, ["footer"]],
    [/\binputs?\b|\bfields?\b|\bforms?\b/i, ["input", "select", "search", "textarea"]],
    [/\bbands?\b|\bsections?\b|\bhero\b/i, ["hero", "section"]],
  ];
  const blanket = (sentence: string) => {
    if (
      /\b(except|apart from|other than|only (on|in|for|under)|reserved for|but\b|save for|aside from)\b/i.test(
        sentence,
      )
    )
      return false;
    const scoped = NOUNS.filter(([re]) => re.test(sentence));
    return !scoped.length || scoped.some(([, kinds]) => kinds.some((k) => shadowKinds.has(k)));
  };
  const NO_SHADOW =
    /\b(no|never|zero|without)\b[^.;,]{0,30}\b(drop[- ]?)?shadows?\b|\bshadow(less|-free)\b|\bshadows? (are|is) (absent|never)/i;
  if (facts.elevation.shadows.length && sentencesOf(s).some((x) => NO_SHADOW.test(x) && blanket(x))) {
    errors.push(
      `${where}: claims no shadows, but the site has ${facts.elevation.shadows.length} shadow style(s) (${[...shadowKinds].join(", ")}): scope the claim to the parts without one`,
    );
  }
  if (
    facts.elevation.gradients.length &&
    /\b(no|never|zero|without)\b[^.;,]{0,30}\bgradients?\b|\bgradients? (are|is) (absent|never)/i.test(s)
  ) {
    errors.push(`${where}: claims no gradients, but the site has ${facts.elevation.gradients.length}`);
  }
  if (
    facts.typography.some((t) => t.textTransform === "uppercase") &&
    /\b(no|never|without)\b[^.;]{0,20}\b(uppercase|all[- ]caps)\b/i.test(s)
  ) {
    errors.push(`${where}: claims no uppercase, but uppercase type styles were measured`);
  }
  if (
    (facts.tracking === "negative" || facts.tracking === "mixed") &&
    /\b(no|never|without)\b[^.;]{0,20}\bnegative (letter-spacing|tracking)\b/i.test(s)
  ) {
    errors.push(`${where}: claims no negative tracking, but the measured tracking is ${facts.tracking}`);
  }
  if (
    facts.bands.some((b) => b.sequence.includes("dark")) &&
    /\bno dark (bands?|sections?|surfaces?)\b|\bnever (goes|turns) dark\b/i.test(s)
  ) {
    errors.push(`${where}: claims no dark bands, but dark bands were captured`);
  }
}

/** Every grounding rule on one text. */
export function groundText(text: string, facts: BrandFacts, where: string): string[] {
  const a = allowedOf(facts);
  const errors: string[] = [];
  checkHex(text, a, where, errors);
  checkPx(text, a, where, errors);
  checkWeights(text, a, where, errors);
  checkFonts(text, a, where, errors);
  checkRefs(text, a, where, errors);
  checkQuotes(text, a, where, errors);
  checkPeers(text, facts, a, where, errors);
  checkAbsences(text, facts, where, errors);
  return [...new Set(errors)];
}

/* ------------------------------------------------------------------ shapes */

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function lengthErrors(s: string, range: TextRange, where: string, errors: string[]) {
  const n = range.words ? wordCount(s) : s.length;
  const [lo, hi] = range.words ?? range.chars ?? [0, Infinity];
  const unit = range.words ? "words" : "chars";
  if (n < lo) errors.push(`${where}: too short (${n} ${unit}, min ${lo})`);
  if (n > hi) errors.push(`${where}: too long (${n} ${unit}, max ${hi})`);
}

function textField(v: unknown, where: string, range: TextRange, errors: string[]): string | undefined {
  const s = str(v);
  if (s == null) {
    errors.push(`${where}: expected a non-empty string`);
    return undefined;
  }
  lengthErrors(s, range, where, errors);
  return s;
}

function listField(
  v: unknown,
  where: string,
  count: Range,
  chars: TextRange,
  errors: string[],
): string[] | undefined {
  if (!Array.isArray(v)) {
    errors.push(`${where}: expected an array of strings`);
    return undefined;
  }
  const out: string[] = [];
  v.forEach((x, i) => {
    const s = textField(x, `${where}[${i}]`, chars, errors);
    if (s != null) out.push(s);
  });
  if (v.length < count[0] || v.length > count[1])
    errors.push(
      `${where}: ${v.length} items, expected ${count[0] === count[1] ? count[0] : `${count[0]}–${count[1]}`}`,
    );
  return out;
}

function recordField(
  v: unknown,
  where: string,
  keys: string[],
  chars: TextRange,
  errors: string[],
  expect: string[] = keys,
): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    errors.push(`${where}: expected an object keyed by token key`);
    return undefined;
  }
  const out: Record<string, string> = {};
  const known = new Set(keys);
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!known.has(k)) {
      errors.push(`${where}: "${k}" is not a key in the facts`);
      continue;
    }
    const s = textField(x, `${where}.${k}`, chars, errors);
    if (s != null) out[k] = s;
  }
  const missing = expect.filter((k) => !(k in (v as Record<string, unknown>)));
  if (missing.length) errors.push(`${where}: missing ${missing.join(", ")}`);
  return out;
}

const paragraphs = (s: string) =>
  s
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

function seoField(v: unknown, errors: string[]): ProseSlots["seo"] | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    errors.push("seo: expected an object");
    return undefined;
  }
  const o = v as Record<string, unknown>;
  const title = textField(o.title, "seo.title", TEXT_RANGES["seo.title"], errors);
  const metaDescription = textField(
    o.metaDescription,
    "seo.metaDescription",
    TEXT_RANGES["seo.metaDescription"],
    errors,
  );
  const tags = listField(o.tags, "seo.tags", COUNT_RANGES["seo.tags"], TEXT_RANGES["seo.tag"], errors);
  const highlights = listField(
    o.highlights,
    "seo.highlights",
    COUNT_RANGES["seo.highlights"],
    TEXT_RANGES["seo.highlight"],
    errors,
  );
  const opening = str(o.opening) ?? undefined;
  if (opening == null) errors.push("seo.opening: expected a non-empty string");
  else {
    const ps = paragraphs(opening);
    const [lo, hi] = COUNT_RANGES["seo.opening"];
    if (ps.length < lo || ps.length > hi)
      errors.push(`seo.opening: ${ps.length} paragraphs, expected ${lo} (separate them with a blank line)`);
    lengthErrors(opening, TEXT_RANGES["seo.opening"], "seo.opening", errors);
  }
  let questions: ProseSlots["seo"]["questions"] | undefined;
  if (!Array.isArray(o.questions)) errors.push("seo.questions: expected an array");
  else {
    questions = [];
    o.questions.forEach((q, i) => {
      const x = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
      const id = str(x.id);
      if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
        errors.push(`seo.questions[${i}].id: expected a kebab-case id`);
      const t = textField(x.title, `seo.questions[${i}].title`, TEXT_RANGES["seo.question.title"], errors);
      const ans = textField(
        x.answer,
        `seo.questions[${i}].answer`,
        TEXT_RANGES["seo.question.answer"],
        errors,
      );
      if (id && t != null && ans != null) questions!.push({ id, title: t, answer: ans });
    });
    const [lo, hi] = COUNT_RANGES["seo.questions"];
    if (o.questions.length < lo || o.questions.length > hi)
      errors.push(`seo.questions: ${o.questions.length} questions, expected ${lo}`);
    const ids = questions.map((q) => q.id);
    const missing = QUESTION_IDS.filter((id) => !ids.includes(id));
    if (missing.length) errors.push(`seo.questions: missing the ids ${missing.join(", ")}`);
    if (new Set(ids).size !== ids.length) errors.push("seo.questions: ids must be unique");
  }
  if (title == null || metaDescription == null || !tags || !highlights || opening == null || !questions)
    return undefined;
  return { title, metaDescription, tags, highlights, opening, questions };
}

/** Every string of a slot value, with where it sits (for grounding). */
function textsOfValue(slot: SlotName, value: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") out.push([path, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) if (k !== "id") walk(x, `${path}.${k}`);
  };
  walk(value, slot);
  return out;
}

/** Expected keys for record slots (all, unless a caller checks a subset). */
export interface SlotCheckOptions {
  expectKeys?: string[];
}

/** Shape + length + grounding of one slot. `value` is set only when there are no errors. */
export function validateSlot<K extends SlotName>(
  slot: K,
  value: unknown,
  facts: BrandFacts,
  o: SlotCheckOptions = {},
): { value?: ProseSlots[K]; errors: string[] } {
  const errors: string[] = [];
  const list = (k: keyof typeof COUNT_RANGES, chars: TextRange = TEXT_RANGES.bullet) =>
    listField(value, slot, COUNT_RANGES[k], chars, errors);
  let out: unknown;
  switch (slot) {
    case "description":
      out = textField(value, slot, TEXT_RANGES.description, errors);
      break;
    case "seo":
      out = seoField(value, errors);
      break;
    case "mockups": {
      const l = list("mockups", { chars: [3, 40] });
      const bad = (l ?? []).filter((m) => !(MOCKUPS as readonly string[]).includes(m));
      if (bad.length) errors.push(`mockups: unknown ${bad.join(", ")} (allowed: ${MOCKUPS.join(", ")})`);
      out = l;
      break;
    }
    case "overview":
      out = list("overview", TEXT_RANGES.paragraph);
      break;
    case "keyCharacteristics":
    case "typePrinciples":
    case "substitutes":
    case "gridNotes":
    case "decorativeDepth":
    case "photographyGeometry":
    case "dos":
    case "donts":
    case "touchTargets":
    case "collapsing":
    case "imageBehavior":
    case "iteration":
      out = list(slot as keyof typeof COUNT_RANGES);
      break;
    case "knownGaps": {
      // a capture with few gaps needs fewer bullets
      const [lo, hi] = COUNT_RANGES.knownGaps;
      out = listField(
        value,
        slot,
        [Math.min(lo, Math.max(1, facts.gaps.length)), hi],
        TEXT_RANGES.bullet,
        errors,
      );
      break;
    }
    case "colorRoles": {
      const keys = facts.colors.map((c) => c.key);
      out = recordField(value, slot, keys, TEXT_RANGES.colorRole, errors, o.expectKeys ?? keys);
      break;
    }
    case "components": {
      const keys = facts.components.map((c) => c.key);
      out = recordField(value, slot, keys, TEXT_RANGES.component, errors, o.expectKeys ?? keys);
      break;
    }
    case "fontFamily":
      out = textField(value, slot, TEXT_RANGES.fontFamily, errors);
      break;
    case "whitespace":
    case "elevationNote":
    case "radiusNote":
      out = textField(value, slot, TEXT_RANGES.note, errors);
      break;
    default:
      errors.push(`${String(slot)}: unknown slot`);
  }
  if (out !== undefined)
    for (const [where, text] of textsOfValue(slot, out)) errors.push(...groundText(text, facts, where));
  return errors.length || out === undefined
    ? { errors: errors.length ? errors : [`${slot}: no value`] }
    : { value: out as ProseSlots[K], errors };
}
