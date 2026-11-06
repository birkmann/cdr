// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Prompts for the model-written slots of DESIGN.md (design-md--generator/PLAN.md §6.3): one request per slot group,
// each with only the facts that group needs (wrapped as data), the format rules of its slots (ranges measured on the
// examples, validate.ts) and a short style sample from examples/bmw.design.md. The model describes; it never writes
// page copy, quotes only captured strings and takes every value from the facts. Pure.
import { DATA_GUARD_RULE, wrapData } from "@harness/scene";
import type { BrandFacts, SlotName } from "@harness/protocol";
import { COUNT_RANGES, describeRange, MOCKUPS, QUESTION_IDS, TEXT_RANGES } from "./validate.js";

/** A chat message of a prose request (provider-neutral). */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type GroupId =
  "overview" | "seo" | "colors" | "typography" | "layout" | "components" | "rules" | "responsive" | "gaps";

export interface SlotGroup {
  id: GroupId;
  /** progress label */
  title: string;
  slots: SlotName[];
  /** answer budget (tokens) */
  numPredict: number;
}

/** The slot groups (PLAN.md §6.3 table); every ProseSlots key is in exactly one. */
export const SLOT_GROUPS: SlotGroup[] = [
  {
    id: "overview",
    title: "overview",
    slots: ["description", "overview", "keyCharacteristics", "mockups"],
    numPredict: 3000,
  },
  { id: "seo", title: "SEO block and FAQ", slots: ["seo"], numPredict: 3500 },
  { id: "colors", title: "colour roles", slots: ["colorRoles"], numPredict: 4000 },
  {
    id: "typography",
    title: "typography",
    slots: ["fontFamily", "typePrinciples", "substitutes"],
    numPredict: 2000,
  },
  {
    id: "layout",
    title: "layout, depth and shapes",
    slots: [
      "whitespace",
      "gridNotes",
      "elevationNote",
      "decorativeDepth",
      "radiusNote",
      "photographyGeometry",
    ],
    numPredict: 3000,
  },
  { id: "components", title: "components", slots: ["components"], numPredict: 6000 },
  {
    id: "rules",
    title: "do's, don'ts and iteration guide",
    slots: ["dos", "donts", "iteration"],
    numPredict: 3000,
  },
  {
    id: "responsive",
    title: "responsive behaviour",
    slots: ["touchTargets", "collapsing", "imageBehavior"],
    numPredict: 2000,
  },
  { id: "gaps", title: "known gaps", slots: ["knownGaps"], numPredict: 1500 },
];

/** Component paragraphs per request (bigger systems go in batches). */
export const COMPONENT_BATCH = 12;

/* ------------------------------------------------------------------ the system prompt */

/** From examples/bmw.design.md: the voice to reproduce (its values belong to BMW and must not be reused). */
export const STYLE_SAMPLE = `- Overview: "The brand action color, **BMW corporate blue** (\`{colors.primary}\` — #1c69d4), works alone across every primary CTA — buttons are **rectangular, 0px corner**, with white type."
- Key characteristic: "Section rhythm holds at \`{spacing.section}\` (80px) for every major band."
- Colour role: "The single brand action color. All primary CTAs and the active nav link. Press shifts to \`{colors.primary-active}\` (#0653b6)."
- Typography principle: "The **700/300 contrast** is the editorial signature. Weight 500 is absent from the system."
- Elevation: "The system never uses a drop shadow. Depth comes entirely from color-block contrast and photography."
- Do: "Use \`{colors.primary}\` for every primary CTA — it is the only action colour."
- Don't: "Don't round buttons; \`{rounded.none}\` (0px) is the dialect."`;

export const PROSE_SYSTEM = `You are a design analyst. You write one part of a brand's DESIGN.md — the design-system reference engineers and AI coding tools build from — using only facts measured on the brand's live website.

Voice: factual, specific and confident, present tense, like a senior designer's audit. No marketing adjectives ("stunning", "elevate", "seamless", "world-class"), no hedging ("seems", "appears", "likely"), no filler. Short sentences; **bold** for the one key phrase of a paragraph is fine.

Rules:
1. Every value comes from the facts. Write a value together with its token, e.g. \`{colors.primary}\` (#0a0a0a), \`{spacing.section}\` (96px), \`{rounded.md}\` (8px). Never write a hex colour, px value, font weight or font name that is not in the facts; never round or estimate a value.
2. Token references use only the keys under "tokens": {colors.<key>}, {typography.<key>}, {rounded.<key>}, {spacing.<key>}, {component.<key>}. Put them in backticks.
3. Double quotes are only for UI text, and only for a string that appears exactly in the facts' "texts" (or a component's "texts"). Never invent, translate or rewrite UI text. Code (CSS, font stacks) goes in backticks, not quotes.
4. Compare with another brand only through the "peers" facts: name only brands listed there, and state the contrast the fact states (its metric and direction). No other brand names.
5. State absences the facts show (weights in weights.absent, no shadows when elevation.shadows is empty, no dark bands when no band is dark). Never claim an absence the facts contradict.
6. You describe the design system. You never write marketing copy or page copy for the brand.
7. English. Answer only with one JSON object of the requested shape, no prose around it.

Style sample (another brand — copy the voice, never its values):
${STYLE_SAMPLE}

${DATA_GUARD_RULE}`;

/* ------------------------------------------------------------------ facts per group */

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The token keys the writer emits (what refs may point at), with their values. */
export function tokensView(facts: BrandFacts) {
  return {
    colors: Object.fromEntries(facts.colors.map((c) => [c.key, c.hex])),
    typography: Object.fromEntries(
      facts.typography.map((t) => [t.key, `${t.family} ${t.fontSize}px / ${t.fontWeight}`]),
    ),
    rounded: Object.fromEntries(facts.rounded.map((s) => [s.key, `${s.value}px`])),
    spacing: Object.fromEntries(facts.spacing.map((s) => [s.key, `${s.value}px`])),
    component: facts.components.map((c) => c.key),
  };
}

/** Short visible strings the prose may quote. */
export function textSample(facts: BrandFacts, n = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of facts.texts) {
    const s = t.replace(/\s+/g, " ").trim();
    if (s.length < 2 || s.length > 60 || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

const colorsBrief = (facts: BrandFacts, n = 14) =>
  [...facts.colors]
    .sort((a, b) => b.area - a.area || b.count - a.count)
    .slice(0, n)
    .map((c) => ({
      key: c.key,
      hex: c.hex,
      group: c.group,
      roles: c.roles.slice(0, 5),
      area: round(c.area),
    }));

const typeBrief = (facts: BrandFacts) =>
  facts.typography.map((t) => ({
    key: t.key,
    family: t.family,
    fontSize: t.fontSize,
    fontWeight: t.fontWeight,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    ...(t.textTransform ? { textTransform: t.textTransform } : {}),
    use: t.use.slice(0, 4),
  }));

const fontsBrief = (facts: BrandFacts) =>
  facts.fonts.map((f) => ({
    family: f.family,
    weights: f.weights,
    styles: f.styles,
    licensed: f.licensed,
    substitutes: f.substitutes.slice(0, 3).map((s) => s.family),
  }));

const elevationBrief = (facts: BrandFacts) => ({
  shadows: facts.elevation.shadows.slice(0, 6),
  shadowStyles: facts.elevation.shadows.length,
  gradients: facts.elevation.gradients.slice(0, 4),
});

function summary(facts: BrandFacts) {
  return {
    name: facts.name,
    website: facts.website,
    pages: facts.pages.map((p) => ({ url: p.url, ...(p.title ? { title: p.title } : {}), widths: p.widths })),
    counts: {
      colors: facts.colors.length,
      typography: facts.typography.length,
      rounded: facts.rounded.length,
      spacing: facts.spacing.length,
      components: facts.components.length,
    },
    fonts: fontsBrief(facts),
    weights: facts.weights,
    tracking: facts.tracking,
    radiusByKind: facts.radiusByKind,
    baseUnit: facts.baseUnit,
    sectionRhythm: facts.sectionRhythm,
    ...(facts.cardPadding != null ? { cardPadding: facts.cardPadding } : {}),
    ...(facts.containerMax != null ? { containerMax: facts.containerMax } : {}),
    elevation: elevationBrief(facts),
    bands: facts.bands,
    grids: facts.grids,
    images: facts.images,
    peers: facts.peers,
  };
}

const componentBrief = (c: BrandFacts["components"][number]) => ({
  key: c.key,
  base: c.base,
  kind: c.kind,
  group: c.group,
  props: c.props,
  texts: c.texts.slice(0, 6).map((t) => clip(t, 80)),
  layout: c.layout,
  source: c.source,
});

/** The facts one group sees. `keys`: the component keys of a components batch. */
export function groupFacts(group: GroupId, facts: BrandFacts, keys?: string[]): Record<string, unknown> {
  const tokens = tokensView(facts);
  switch (group) {
    case "overview":
      return {
        ...summary(facts),
        colors: colorsBrief(facts),
        typography: typeBrief(facts),
        componentKinds: [...new Set(facts.components.map((c) => c.kind))],
        ...(facts.vision ? { vision: facts.vision } : {}),
        texts: textSample(facts),
        tokens,
      };
    case "seo":
      return {
        ...summary(facts),
        colors: colorsBrief(facts),
        typography: typeBrief(facts),
        components: facts.components.map((c) => c.key),
        gaps: facts.gaps,
        ...(facts.vision ? { vision: facts.vision } : {}),
        texts: textSample(facts),
        tokens,
      };
    case "colors":
      return {
        name: facts.name,
        colors: facts.colors.map((c) => ({
          key: c.key,
          label: c.label,
          hex: c.hex,
          group: c.group,
          roles: c.roles,
          area: round(c.area),
          count: c.count,
          pages: c.pages.length,
          kinds: c.kinds.slice(0, 8),
          source: c.source,
          ...(c.cssVar ? { cssVar: c.cssVar } : {}),
        })),
        bands: facts.bands,
        components: facts.components.map((c) => ({ key: c.key, props: c.props })),
        tokens,
      };
    case "typography":
      return {
        name: facts.name,
        typography: facts.typography.map((t) => ({
          ...typeBrief({ ...facts, typography: [t] })[0],
          fontFamily: t.fontFamily,
          chars: t.chars,
          ...(t.mobileSize != null ? { mobileSize: t.mobileSize } : {}),
        })),
        fonts: fontsBrief(facts),
        weights: facts.weights,
        tracking: facts.tracking,
        peers: facts.peers,
        texts: textSample(facts, 20),
        tokens,
      };
    case "layout":
      return {
        name: facts.name,
        spacing: facts.spacing,
        baseUnit: facts.baseUnit,
        sectionRhythm: facts.sectionRhythm,
        ...(facts.cardPadding != null ? { cardPadding: facts.cardPadding } : {}),
        ...(facts.containerMax != null ? { containerMax: facts.containerMax } : {}),
        rounded: facts.rounded,
        radiusByKind: facts.radiusByKind,
        grids: facts.grids,
        bands: facts.bands,
        elevation: elevationBrief(facts),
        images: facts.images,
        ...(facts.vision
          ? { vision: { photography: facts.vision.photography, mood: facts.vision.mood } }
          : {}),
        colors: colorsBrief(facts, 10),
        peers: facts.peers,
        tokens,
      };
    case "components": {
      const pick = new Set(keys ?? facts.components.map((c) => c.key));
      return {
        name: facts.name,
        components: facts.components.filter((c) => pick.has(c.key)).map(componentBrief),
        radiusByKind: facts.radiusByKind,
        tokens,
      };
    }
    case "rules":
      return {
        ...summary(facts),
        colors: colorsBrief(facts),
        typography: typeBrief(facts),
        components: facts.components.map((c) => ({ key: c.key, props: c.props })),
        tokens,
      };
    case "responsive":
      return {
        name: facts.name,
        pages: facts.pages,
        breakpoints: facts.breakpoints,
        grids: facts.grids,
        typography: facts.typography.map((t) => ({
          key: t.key,
          fontSize: t.fontSize,
          ...(t.mobileSize != null ? { mobileSize: t.mobileSize } : {}),
        })),
        components: facts.components
          .filter((c) => c.layout.length || c.props.height || c.props.padding)
          .map((c) => ({ key: c.key, kind: c.kind, props: c.props, layout: c.layout })),
        images: facts.images,
        ...(facts.containerMax != null ? { containerMax: facts.containerMax } : {}),
        tokens,
      };
    case "gaps":
      return {
        name: facts.name,
        gaps: facts.gaps,
        pages: facts.pages,
        fonts: fontsBrief(facts),
        states: facts.components.filter((c) => c.source === "state").map((c) => c.key),
        semanticColors: facts.colors.filter((c) => c.group === "semantic").map((c) => c.key),
        tokens,
      };
  }
}

/* ------------------------------------------------------------------ format rules per group */

const r = (k: keyof typeof COUNT_RANGES) => {
  const [a, b] = COUNT_RANGES[k];
  return a === b ? `exactly ${a}` : `${a}–${b}`;
};
const c = (k: keyof typeof TEXT_RANGES) => describeRange(TEXT_RANGES[k]);

/** What the group answers: the JSON shape and the format of each slot. */
export function groupInstructions(group: GroupId, facts: BrandFacts, keys?: string[]): string {
  switch (group) {
    case "overview":
      return `Write the Overview of the DESIGN.md.
JSON: {"description": string, "overview": string[], "keyCharacteristics": string[], "mockups": string[]}
- "description": one paragraph (${c("description")}) for the front matter: the canvas, the primary colour with its hex, the typeface and its weights, the signature layout.
- "overview": ${r("overview")} paragraphs (${c("paragraph")} each): the atmosphere (canvas, dark bands), the type system, the action colour and its scope, the signature layout and depth. Use "vision" for mood and photography, the "peers" contrasts for one comparison.
- "keyCharacteristics": ${r("keyCharacteristics")} bullets (${c("bullet")} each), each one measurable trait with its token and value.
- "mockups": ${r("mockups")} of ${MOCKUPS.map((m) => `"${m}"`).join(", ")} that fit the component kinds (marketing-hero for a hero band, media-grid for photo/card grids, code-editor-ide only for code samples).`;
    case "seo":
      return `Write the "seo" block of the front matter.
JSON: {"seo": {"title": string, "metaDescription": string, "tags": string[], "highlights": string[], "opening": string, "questions": [{"id": string, "title": string, "answer": string}]}}
- "title": ${c("seo.title")}, "<Brand> Design Tokens: <two signature traits>".
- "metaDescription": ${c("seo.metaDescription")}: the primary hex, the typeface and weights, the radius, the component count.
- "tags": ${r("seo.tags")} industry categories ("Automotive", "E-commerce & Retail", "Developer Tools & IDEs" …).
- "highlights": ${r("seo.highlights")} bullets (${c("seo.highlight")} each): single action colour, type signature, radius dialect, depth strategy, one scoped accent or rhythm.
- "opening": ${r("seo.opening")} paragraphs separated by a blank line ("\\n\\n"), ${c("seo.opening")} together: (1) what the system is, with its key values and one peer contrast from "peers"; (2) what the file holds — use the exact "counts"; (3) how to use it with AI coding tools and what restraint it encodes.
- "questions": exactly 5, ids ${QUESTION_IDS.slice(0, 2)
        .map((x) => `"${x}"`)
        .join(
          ", ",
        )}, one brand-specific signature id (kebab-case, e.g. "rectangular-buttons"), ${QUESTION_IDS.slice(2)
        .map((x) => `"${x}"`)
        .join(
          ", ",
        )}. "title" is the question (${c("seo.question.title")}), "answer" ${c("seo.question.answer")}. The known-gaps answer uses "gaps" only.`;
    case "colors":
      return `Write one role sentence for every colour token.
JSON: {"colorRoles": {"<color key>": string}} with every key of "colors" (${facts.colors.length} keys), nothing else.
- Each value ${c("colorRole")}: its role and where it is used (from "roles", "kinds", "area", "pages"), its states, and its scope when it is narrow ("only on …"). The heading with name, token and hex is written separately — start with the role, e.g. "The single brand action colour. All primary CTAs …".`;
    case "typography":
      return `Write the typography prose.
JSON: {"fontFamily": string, "typePrinciples": string[], "substitutes": string[]}
- "fontFamily": the "### Font Family" text (${c("fontFamily")}): the families and how the weights split between display, body and UI roles ("<family> (<weight>) → <roles>"), the fallback stack in backticks.
- "typePrinciples": ${r("typePrinciples")} bullets (${c("bullet")} each): weight contrast, absent weights, tracking (sign and values), uppercase use, size steps.
- "substitutes": ${r("substitutes")} bullets (${c("bullet")} each): for a licensed family, the open substitutes from "fonts[].substitutes" only (best first) and how to set them; for a public family, say it is available as served.`;
    case "layout":
      return `Write the layout, depth and shape prose.
JSON: {"whitespace": string, "gridNotes": string[], "elevationNote": string, "decorativeDepth": string[], "radiusNote": string, "photographyGeometry": string[]}
- "whitespace": the "### Whitespace Philosophy" paragraph (${c("note")}): section rhythm, card padding, density; a peer contrast only from "peers".
- "gridNotes": ${r("gridNotes")} bullets (${c("bullet")} each): container width, columns per width from "grids".
- "elevationNote": the paragraph under the elevation table (${c("note")}): how depth is made — shadows (from "elevation"), surfaces, photography.
- "decorativeDepth": ${r("decorativeDepth")} bullets (${c("bullet")} each): gradients, stripes, photographic depth — only what the facts show.
- "radiusNote": the paragraph under the radius table (${c("note")}): the dominant radius per kind ("radiusByKind") and the exceptions.
- "photographyGeometry": ${r("photographyGeometry")} bullets (${c("bullet")} each): aspect ratios and roles from "images", crop and framing from "vision".`;
    case "components":
      return `Write one paragraph for each component.
JSON: {"components": {"<component key>": string}} with exactly these keys: ${(keys ?? facts.components.map((x) => x.key)).join(", ")}.
- Each value ${c("component")}: what it is and where it sits, its properties as tokens with values (background, text colour, type, radius, padding, height from "props"), its layout facts, the content it holds (quote only its "texts"), its variants and states (other keys with the same "base").`;
    case "rules":
      return `Write the rules.
JSON: {"dos": string[], "donts": string[], "iteration": string[]}
- "dos": ${r("dos")} bullets (${c("bullet")} each), imperative ("Use …", "Keep …"), each tied to a token and its value.
- "donts": ${r("donts")} bullets (${c("bullet")} each), starting "Don't …", each naming what breaks the system (an absent weight, a radius that is not used, a second action colour, a shadow where there is none …).
- "iteration": ${r("iteration")} numbered-guide rules (${c("bullet")} each, without the number) for building new screens in this system: start from tokens, reuse components, keep the rhythm.`;
    case "responsive":
      return `Write the responsive behaviour prose.
JSON: {"touchTargets": string[], "collapsing": string[], "imageBehavior": string[]}
- "touchTargets": ${r("touchTargets")} bullets (${c("bullet")} each): control heights and padding from the components' props.
- "collapsing": ${r("collapsing")} bullets (${c("bullet")} each): how navigation, grids and type change between the captured widths (grids "columnsByWidth", typography "mobileSize", breakpoints).
- "imageBehavior": ${r("imageBehavior")} bullets (${c("bullet")} each): how images crop and scale across widths (from "images" and the components' layout).`;
    case "gaps":
      return `Write the "## Known Gaps" bullets.
JSON: {"knownGaps": string[]}
- ${r("knownGaps")} bullets (${c("bullet")} each, fewer when "gaps" is short): what the capture could not see, from "gaps" only — licensed fonts, states not reached, overlays covering content, pages not captured. No other claims.`;
  }
}

/** The chat messages for one group (or one components batch). */
export function proseMessages(group: GroupId, facts: BrandFacts, keys?: string[]): ChatMessage[] {
  return [
    { role: "system", content: PROSE_SYSTEM },
    {
      role: "user",
      content: `Brand: ${facts.name} (${facts.website}).\n\n${groupInstructions(group, facts, keys)}\n\nFacts:\n${wrapData(`brand facts ${group}`, groupFacts(group, facts, keys))}`,
    },
  ];
}

/** The follow-up after a rejected answer: what was wrong, which slots to send again. */
export function retryMessage(slots: SlotName[], errors: string[]): string {
  const list = errors
    .slice(0, 30)
    .map((e) => `- ${e}`)
    .join("\n");
  const more = errors.length > 30 ? `\n- … and ${errors.length - 30} more of the same kind` : "";
  const short = errors.some((e) => /too short/.test(e))
    ? " Where a text is too short, write it longer than the minimum (a few words to spare): add a concrete detail from the facts, do not pad."
    : "";
  return `Your answer was rejected by the checks:\n${list}${more}\n\nFix every point using only values, keys and texts from the facts (drop a claim rather than guess).${short} Answer again with the same JSON shape, holding only ${slots.map((s) => `"${s}"`).join(", ")}.`;
}

/* ------------------------------------------------------------------ vision notes */

export const VISION_NOTES_PROMPT = `You are a design analyst. You see screenshots of the first viewport ("the fold") of one brand's website, captured at different widths. Describe what a brand guide notes about its atmosphere and imagery.

Answer only with JSON: {"mood": string[], "photography": string[], "notes": string[]}
- "mood": 2–4 short phrases on the atmosphere: light or dark canvas, warm or cool, dense or airy, restrained or loud.
- "photography": 2–4 short phrases on the imagery: subject, lighting, crop and framing, colour temperature, full-bleed or contained, studio or environment. Empty when there is no photography.
- "notes": 0–4 short phrases on anything else a designer should know: an overlay or cookie layer covering content, video, illustration instead of photos.
Each phrase at most 120 characters, English, plain description.
Never transcribe or quote text from the screenshots, and never state hex codes, font names or pixel values — those are measured elsewhere.`;
