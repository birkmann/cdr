// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Brand guide (DESIGN.md) — the shared contract of the brandmd modules (design-md--generator/PLAN.md):
// capture extras the importer stores per screen (BrandCapture), the measured facts (BrandFacts, written as brand.json),
// the model-written prose slots (ProseSlots), the peer corpus from design-md--generator/examples (PeerBrand) and the
// result of a generation run. Types only.

/* ------------------------------------------------------------------ capture (importer → SceneScreen.capture) */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Computed-style values that change between a control's states (only the ones that differ from `base` are set). */
export interface StateStyle {
  backgroundColor?: string;
  color?: string;
  borderColor?: string;
  borderWidth?: number;
  outline?: string;
  boxShadow?: string;
  textDecoration?: string;
  opacity?: number;
  /** read from the browser with the pseudo-class forced over CDP (the stylesheet scan could not reach it) */
  forced?: boolean;
}

/** One distinct interactive control (deduped by tag + class + computed look), with its captured states. */
export interface CapturedControl {
  /** dedupe signature (stable across widths for the same control look) */
  key: string;
  kind: "button" | "link" | "input" | "select" | "chip" | "tab" | "icon-button" | "other";
  /** visible label of the first instance */
  text?: string;
  /** box of the first instance (CSS px, page coordinates) */
  box: Box;
  /** how many elements share this look */
  count: number;
  base: StateStyle & {
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    letterSpacing: number;
    lineHeight: number;
    textTransform?: string;
    borderRadius: number;
    paddingTop: number;
    paddingRight: number;
    paddingBottom: number;
    paddingLeft: number;
    height: number;
  };
  hover?: StateStyle;
  focus?: StateStyle;
  active?: StateStyle;
  disabled?: boolean;
  selected?: boolean;
  /** a state the capture tried but could not reach (no change, script-driven, covered) */
  unreached?: Array<"hover" | "focus" | "active">;
}

export interface CapturedImage {
  src: string;
  naturalW: number;
  naturalH: number;
  box: Box;
  alt?: string;
  /** best candidate of srcset / <picture> (largest width) */
  best?: string;
  objectFit?: string;
  /** index into `sections` */
  section?: number;
  /** css background-image instead of <img> */
  background?: boolean;
}

export interface CapturedIcon {
  svg: string;
  w: number;
  h: number;
  count: number;
}

export interface CapturedSection {
  box: Box;
  /** resolved background colour (#hex or rgba) */
  background?: string;
  backgroundImage?: boolean;
  paddingTop: number;
  paddingBottom: number;
  /** luminance of the background < 0.4 (or a photo with light text) */
  dark: boolean;
}

export interface CapturedGrid {
  box: Box;
  columns: number;
  gap: number;
  itemW: number;
  count: number;
  section?: number;
}

export interface BrandMarks {
  title?: string;
  siteName?: string;
  themeColor?: string;
  /** header logo: inline SVG markup (sanitised later) or an image URL */
  logo?: { svg?: string; src?: string; alt?: string; box: Box };
  /** a second logo (footer / dark band), when it differs */
  logoAlt?: { svg?: string; src?: string; alt?: string; box: Box };
  icons: Array<{ rel: string; href: string; sizes?: string; type?: string }>;
  ogImage?: string;
  manifest?: string;
}

/** What the importer reads for the brand guide on top of the DOM tree. One per captured screen (width). */
export interface BrandCapture {
  /** requested URL and the URL after redirects */
  url: string;
  finalUrl: string;
  width: number;
  /** custom properties declared on :root / html / body (name → value as authored) */
  customProperties: Record<string, string>;
  /** @media width conditions found in the style sheets, with the number of rules inside */
  mediaQueries: Array<{ query: string; minWidth?: number; maxWidth?: number; rules: number }>;
  marks: BrandMarks;
  images: CapturedImage[];
  icons: CapturedIcon[];
  sections: CapturedSection[];
  grids: CapturedGrid[];
  controls: CapturedControl[];
  /** webfont files as served (@font-face src) */
  fontFiles: Array<{
    family: string;
    weight: string;
    style: string;
    url: string;
    format?: string;
    unicodeRange?: string;
  }>;
  /** area still covered by a consent / overlay layer after dismissal (null when clear) */
  overlay?: Box | null;
  /** visible text strings of the page (for quote validation) */
  texts: string[];
}

/* ------------------------------------------------------------------ facts (brand.json) */

export type Provenance = "site" | "derived";

export type ColorGroup = "brand" | "surface" | "hairline" | "text" | "semantic" | "accent" | "gradient";

export interface ColorFact {
  /** DESIGN.md key: primary, primary-active, canvas, ink, surface-dark, on-primary, m-red … */
  key: string;
  /** human name for the prose heading ("BMW Blue (Primary)") — the writer may refine it */
  label: string;
  hex: string;
  group: ColorGroup;
  /** where it is used: 'control-fill', 'band-bg', 'card-bg', 'heading', 'body-text', 'muted-text', 'border', 'icon', 'link', 'state:hover' … */
  roles: string[];
  /** share of painted page area (0..1, desktop) */
  area: number;
  /** number of elements using it */
  count: number;
  /** page URLs it appears on */
  pages: string[];
  /** component kinds it appears in */
  kinds: string[];
  source: Provenance;
  /** the site's own custom property, when one holds this value */
  cssVar?: string;
}

export interface TypeFact {
  /** DESIGN.md key: display-xl, display-lg, title-md, body-md, caption, label-uppercase, button, nav-link … */
  key: string;
  /** CSS font-family stack as written to DESIGN.md (full fallback stack on the first role, short after) */
  fontFamily: string;
  /** the family that renders (first loaded webfont of the stack) */
  family: string;
  fontSize: number;
  fontWeight: number;
  /** unitless */
  lineHeight: number;
  /** px */
  letterSpacing: number;
  textTransform?: "uppercase" | "lowercase" | "capitalize";
  /** characters set in this style (weight of evidence) */
  chars: number;
  /** where it is used: 'h1', 'hero', 'card-title', 'button', 'nav', 'footer' … */
  use: string[];
  /** size at the narrowest captured width, when it differs */
  mobileSize?: number;
  source: Provenance;
}

export interface FontFact {
  family: string;
  weights: number[];
  styles: string[];
  files: Array<{ url: string; weight: string; style: string; format?: string }>;
  /** not available from Google Fonts under that name */
  licensed: boolean;
  /** open substitutes ranked by metric similarity (best first) */
  substitutes: Array<{ family: string; score: number }>;
}

export interface ScaleStep {
  /** none, xs, sm, md, lg, xl, pill, full / xxs … xxl, section */
  key: string;
  value: number;
  count: number;
  kinds: string[];
}

export interface ComponentFact {
  /** DESIGN.md key: top-nav, button-primary, button-primary-active, model-card, footer … */
  key: string;
  /** base key the variant belongs to (button-primary for button-primary-active) */
  base: string;
  /** catalog kind (SceneComponentKind) or 'other' */
  kind: string;
  /** heading group in ## Components: Top Navigation, Buttons, Cards & Containers, Inputs & Forms, Tabs / Tags, Brand Signature, CTA / Footer … */
  group: string;
  /** the component set it comes from */
  setId?: string;
  /** DESIGN.md properties, values as token refs ("{colors.primary}") or literals ("14px 32px", transparent) */
  props: Record<string, string>;
  /** captured strings inside it (first few) */
  texts: string[];
  /** short layout facts: "4-up at 1280, 2-up at 768", "height 64px, sticky" */
  layout: string[];
  source: "extracted" | "generated" | "state";
  /** where to crop it from the live screenshot */
  crop?: { width: number; box: Box; page?: string };
}

export interface BreakpointFact {
  name: string;
  min?: number;
  max?: number;
  changes: string[];
}

export interface BrandFacts {
  version: 1;
  name: string;
  website: string;
  /** ISO date of the capture */
  capturedAt: string;
  pages: Array<{ url: string; title?: string; widths: number[] }>;
  colors: ColorFact[];
  typography: TypeFact[];
  fonts: FontFact[];
  weights: { used: number[]; absent: number[] };
  tracking: "negative" | "zero" | "positive" | "mixed";
  rounded: ScaleStep[];
  /** dominant radius per component kind (px) */
  radiusByKind: Record<string, number>;
  spacing: ScaleStep[];
  baseUnit: number;
  /** median vertical padding of the page bands (px) */
  sectionRhythm: number;
  cardPadding?: number;
  containerMax?: number;
  grids: Array<{ name: string; columnsByWidth: Record<string, number> }>;
  breakpoints: BreakpointFact[];
  elevation: { shadows: Array<{ value: string; count: number; kinds: string[] }>; gradients: string[] };
  /** band sequence per page, top to bottom */
  bands: Array<{ page: string; sequence: Array<"light" | "dark" | "photo" | "tint"> }>;
  components: ComponentFact[];
  images: Array<{ role: string; count: number; aspect: string }>;
  /** factual contrasts against the example corpus (peers.json) */
  peers: Array<{
    metric: string;
    value: string | number;
    peerMedian: string | number;
    claim: string;
    peers: string[];
  }>;
  /** what the capture could not see */
  gaps: string[];
  /** every visible string captured (quotes in prose must come from here) */
  texts: string[];
  /** the vision model's notes on the fold screenshots */
  vision?: VisionNotes;
}

export interface VisionNotes {
  mood: string[];
  photography: string[];
  notes: string[];
  model?: string;
}

/* ------------------------------------------------------------------ prose (model-written slots) */

export interface ProseSlots {
  description: string;
  seo: {
    title: string;
    metaDescription: string;
    tags: string[];
    highlights: string[];
    /** 3 paragraphs */
    opening: string;
    /** ids: primary-color, typography, <signature>, use-in-project, known-gaps */
    questions: Array<{ id: string; title: string; answer: string }>;
  };
  mockups: string[];
  overview: string[];
  keyCharacteristics: string[];
  /** color key → one sentence on role and use */
  colorRoles: Record<string, string>;
  fontFamily: string;
  typePrinciples: string[];
  substitutes: string[];
  whitespace: string;
  gridNotes: string[];
  elevationNote: string;
  decorativeDepth: string[];
  radiusNote: string;
  photographyGeometry: string[];
  /** component key → one paragraph */
  components: Record<string, string>;
  dos: string[];
  donts: string[];
  touchTargets: string[];
  collapsing: string[];
  imageBehavior: string[];
  iteration: string[];
  knownGaps: string[];
}

export type SlotName = keyof ProseSlots;

export interface SlotReport {
  slot: SlotName;
  ok: boolean;
  attempts: number;
  errors: string[];
  ms: number;
  model?: string;
}

/* ------------------------------------------------------------------ peers (design-md--generator/examples → peers.json) */

export interface PeerBrand {
  slug: string;
  name: string;
  website: string;
  primary: string;
  canvas: string;
  ink: string;
  canvasDark: boolean;
  fontFamily: string;
  displayWeight: number;
  bodyWeight: number;
  weights: number[];
  /** most used radius on controls (px; 9999 = pill) */
  dominantRadius: number;
  shadows: boolean;
  accentCount: number;
  sectionRhythm: number;
  counts: { colors: number; typography: number; rounded: number; spacing: number; components: number };
}

/* ------------------------------------------------------------------ a generation run (stored on the design system) */

export interface BrandGuide {
  markdown: string;
  facts: BrandFacts;
  slots: SlotReport[];
  /** every slot written and validated */
  ok: boolean;
  model?: string;
  generatedAt: string;
}
