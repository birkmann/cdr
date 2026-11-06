// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Family name → CSS font stack. Keeps the requested family first (uploaded / installed faces win), then the closest
// system face (Helvetica Neue on macOS, Arial on Windows) and the closest bundled variable font as offline fallback.
// Pure (no DOM) so the renderer, the static exporter and tests share it.

const GROTESK = `'Helvetica Neue', Helvetica, Arial, 'Inter', sans-serif`;
const SYSTEM = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif`;
const SERIF = `Georgia, 'Times New Roman', 'Fraunces', serif`;
/** condensed / unknown display serifs (e.g. Instrument Serif): Times runs much narrower than Georgia */
const NARROW_SERIF = `'Times New Roman', Times, 'Fraunces', serif`;
const SCRIPT = `'Snell Roundhand', 'Apple Chancery', 'Brush Script MT', 'Segoe Script', cursive`;
const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;
const GEOMETRIC = `Futura, 'Avenir Next', 'Outfit', 'Inter', sans-serif`;
const SANS = `'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif`;
/** condensed / narrow sans (DIN Condensed, Frutiger Cn, Transit, Roboto Condensed…): the bundled condensed face first so
 * every engine (Chromium, WebKit, the desktop webview) draws the same widths; Arial Narrow only when it can't load */
const CONDENSED = `'IBM Plex Sans Condensed', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif`;
/** compressed display grotesks (Knockout, Druk, Trade Gothic Bold Condensed No. 20…): letters about half as wide as a
 * grotesk's — the bundled compressed face, never a condensed text face (Plex Condensed runs ~40 % too wide) */
const COMPRESSED = `'Saira Extra Condensed', 'Arial Narrow', Impact, sans-serif`;
/** text serifs (Tiempos, Publico, Lyon…): the bundled text serif first (Georgia runs ~4 % narrower and lighter) */
const TEXT_SERIF = `'Literata', Georgia, 'Times New Roman', serif`;

/** [test on the lower-cased family, fallback stack]; first hit wins. */
const RULES: Array<[RegExp, string]> = [
  [
    /^(script|cursive|handwriting|handwritten|calligraph\w*|signature)$|script|brush|vibes|pinyon|allura|parisienne|snell|chancery|edwardian|tangerine|sacramento|great vibes|italianno|alex brush|mrs saint/,
    SCRIPT,
  ],
  [/mono|courier|menlo|consolas|monaco|code/, MONO],
  [
    /tiempos|publico|lyon|charter|source serif|literata|newsreader|pt serif|merriweather|freight text|guardian egyptian|chronicle|mercury|sentinel|noe text|domaine text|\btisa\b|utopia|minion|lora|crimson|spectral|roboto serif|noto serif|plex serif|libre baskerville|tinos|georgia pro/,
    TEXT_SERIF,
  ],
  [
    /^(serif)$|times|georgia|garamond|playfair|canela|tiempos|didot|bodoni|freight|caslon|baskerville|lora|merriweather|editorial new|ogg|reckless|domaine|gt sectra|libre|cormorant|fraunces|serif display|recoleta|minion|palatino|cambria|noto serif|pt serif|source serif|\beb /,
    SERIF,
  ],
  // any other "… Serif" family that is not a sans ("Instrument Serif", "Newsreader Serif"…)
  [/^(?!.*\bsans\b).*\bserif\b|condensed serif|compressed serif/, NARROW_SERIF],
  [
    /compressed|(extra|ultra|x)[- ]?(condensed|cond\b|narrow)|knockout|druk|tungsten|league gothic|alternate gothic|trade gothic.*(cond|no\.? ?\d)|bebas|\banton(io)?\b|oswald|compacta|impact|haettenschweiler|champion gothic|fjalla|ringside.*(comp|cond)|obviously.*(narrow|comp)|refrigerator/,
    COMPRESSED,
  ],
  [/condensed|narrow|compressed|\bcond\b|\bcn\b|transit/, CONDENSED],
  [/^(-apple-system|system-ui|ui-sans-serif|blinkmacsystemfont)$|^sf\b|sf pro|san francisco|segoe/, SYSTEM],
  [
    /futura|avenir|circular|gilroy|poppins|montserrat|product sans|walsheim|cera|brandon|gotham|proxima|sofia|nunito sans|outfit|sora|urbanist|lexend/,
    GEOMETRIC,
  ],
  [
    /helvetica|haas|nhaas|arial|aktiv|suisse|akzidenz|univers|montreal|grotesk|grotesque|swiss|unica|neue|nimbus|liberation sans|pretendard|basis grotesque|favorit|graphik|founders|untitled sans|roobert|aeonik|diatype|neue machina/,
    GROTESK,
  ],
];

/** Families shipped with the app (lib/fonts.ts) — they need no fallback mapping beyond Inter. */
const BUNDLED = new Set([
  "inter",
  "jetbrains mono",
  "manrope",
  "space grotesk",
  "ibm plex sans",
  "geist",
  "dm sans",
  "plus jakarta sans",
  "sora",
  "nunito",
  "outfit",
  "fraunces",
  "roboto",
  "ibm plex mono",
  "ibm plex sans condensed",
  "saira extra condensed",
  "literata",
]);

const clean = (f: string) => f.split(",")[0]!.replace(/["']/g, "").trim();

/** Helvetica Neue's macOS faces by PostScript name: [suffix, CSS weight] (Light = 300, as in Figma). */
const HN_FACES: Array<[string, number]> = [
  ["UltraLight", 100],
  ["Thin", 200],
  ["Light", 300],
  ["", 400],
  ["Medium", 500],
  ["Bold", 700],
];

/**
 * @font-face rules pinning system families whose weights the engines resolve differently: Chromium draws Helvetica
 * Neue 300 with Thin, WebKit (the desktop app's WKWebView) with Light — 4 % wider, so the same DSL wrapped differently
 * in the eval and the app. Declared, every weight / style maps to the same installed face in both; where the faces
 * are missing (Windows, Linux) the family is skipped like an absent system font. local() faces load synchronously.
 */
export const SYSTEM_FACES_CSS = HN_FACES.flatMap(([n, w]) =>
  (["normal", "italic"] as const).map(
    (st) =>
      `@font-face { font-family: 'Helvetica Neue'; src: local('HelveticaNeue${n || st === "italic" ? "-" : ""}${n}${st === "italic" ? "Italic" : ""}'); font-weight: ${w}; font-style: ${st}; }`,
  ),
).join("\n");

/** The fallback stack for a family (without the family itself). */
export function fallbackStackFor(family: string | undefined): string {
  if (!family) return SANS;
  const f = clean(family).toLowerCase();
  if (BUNDLED.has(f))
    return /mono/.test(f)
      ? MONO
      : f === "fraunces"
        ? SERIF
        : f === "literata"
          ? TEXT_SERIF.replace(/^[^,]+,\s*/, "")
          : f === "saira extra condensed"
            ? COMPRESSED.replace(/^[^,]+,\s*/, "")
            : /condensed/.test(f)
              ? CONDENSED.replace(/^[^,]+,\s*/, "")
              : SANS;
  if (f === "inter tight" || f === "inter display") return SANS;
  for (const [re, stack] of RULES) if (re.test(f)) return stack;
  return SANS;
}

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "script",
  "handwriting",
  "calligraphy",
  "signature",
  "grotesk",
  "grotesque",
  "sans",
  "-apple-system",
]);

/** CSS generic family keywords (never quoted) */
const CSS_GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
]);

/** Families of a CSS font-family list ('A, "B C", sans-serif' → ['A', 'B C', 'sans-serif']). */
export function familyList(value: string | undefined): string[] {
  if (!value) return [];
  return (value.match(/"[^"]*"|'[^']*'|[^,]+/g) ?? [])
    .map((x) => x.replace(/["']/g, "").trim())
    .filter(Boolean);
}

const TERMINAL = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "math",
  "emoji",
  "fangsong",
]);
const quoteFamily = (f: string) => (CSS_GENERIC.has(f.toLowerCase()) ? f : `'${f.replace(/'/g, "")}'`);

/**
 * Full CSS font-family value: requested family first, then its fallback stack. A CSS list keeps the author's own
 * fallbacks (before the computed ones; a trailing generic keyword goes last), duplicates removed.
 */
export function fontStack(family: string | undefined): string {
  if (!family || !clean(family)) return SANS;
  const list = familyList(family);
  const f = list[0] ?? clean(family);
  const fb = fallbackStackFor(f);
  if (list.length <= 1) return GENERIC.has(f.toLowerCase()) ? fb : `'${f.replace(/'/g, "")}', ${fb}`;
  const own = (
    GENERIC.has(f.toLowerCase()) && !CSS_GENERIC.has(f.toLowerCase()) ? list.slice(1) : list
  ).filter((x) => !TERMINAL.has(x.toLowerCase()));
  const generic = list.filter((x) => TERMINAL.has(x.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...own.map(quoteFamily), ...familyList(fb).map(quoteFamily), ...generic]) {
    const k = x.replace(/'/g, "").toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  // terminal generics (sans-serif, serif…) belong at the end
  const terminal = (x: string) => TERMINAL.has(x.toLowerCase());
  return [...out.filter((x) => !terminal(x)), ...out.filter(terminal)].join(", ");
}
