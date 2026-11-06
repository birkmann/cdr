// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Complete a design system: the brand's foundations read from its screens (colours by role, type scale, radii,
// shadows, spacing → tokens, variables, text / colour / effect styles) and the standard components a system still
// lacks (catalog.ts ESSENTIAL_KINDS), generated in the brand's look from what the site already has (its buttons,
// inputs, cards, fonts, colours). Generated sets carry `origin: 'generated'`, a kind, a category and real properties.
// Pure; the store action lives in componentSets.ts / the design-system flow.
//
// How the brand is read: every screen is walked once (scan) with the colour each layer sits on, so text colours are
// judged against their real background (white copy on a blue band is not the body colour). Colours get roles from
// where they are used (control fills, large areas, copy); the type scale clusters the sizes of the desktop page; the
// control look (height, radius, label, outline style) comes from the site's own button-like layers.
import type {
  SceneComponentDef,
  SceneComponentKind,
  SceneDesignSystem,
  SceneEffectStyle,
  SceneElement,
  SceneLayout,
  ScenePaintStyle,
  SceneScreen,
  SceneShadow,
  SceneStyle,
  SceneTextStyle,
  SceneTokens,
  SceneVariableCollection,
} from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import { ESSENTIAL_KINDS, KIND_CATEGORY, KIND_LABELS, classifyComponent } from "./catalog.js";
import { axesOf, buildInstance, pickVariant, variantKeyOf } from "./instances.js";

/* ------------------------------------------------------------------ public types */

/** Text roles of the brand's type scale (each one a text style). */
export type TypeRole =
  "display" | "h1" | "h2" | "h3" | "h4" | "bodyL" | "body" | "small" | "caption" | "label" | "overline";

export interface BrandSummary {
  fonts: { body: string; display: string; webfonts: string[] };
  /** role → `size/weight` as read (or derived) */
  scale: Record<TypeRole, string>;
  radii: { control: number; card: number; image: number };
  spacing: number[];
  /** the control look derived from the site's buttons */
  controls: {
    height: number;
    radius: number;
    secondary: "outline" | "tonal";
    uppercase: boolean;
    labelWeight: number;
    iconLeading: boolean;
  };
  /** where each colour came from ('site' = used on the screens, 'derived' = made to fit) */
  colorSources: Record<string, "site" | "derived">;
}

export interface BrandFoundations {
  /** token overrides (primary, background, surface, text, fontFamily, radius…) */
  tokens: Partial<SceneDesignSystem["tokens"]>;
  /** shared styles derived from the screens (text scale, brand colours, elevations) */
  styles: NonNullable<SceneDesignSystem["styles"]>;
  /** number variables of the brand (spacing scale, radii) — one collection */
  variables?: SceneVariableCollection[];
  /** what was read, for docs / reports */
  summary?: BrandSummary;
}

export interface CompletionResult {
  ds: SceneDesignSystem;
  /** ids of the generated component sets */
  added: string[];
  foundations: BrandFoundations;
}

export interface CompletionOptions {
  /** id of a new component set (default `gen-<kind>`) */
  newId?: () => string;
  /** limit the kinds considered (default: ESSENTIAL_KINDS without the site-made shell / hero) */
  kinds?: string[];
  /** generate these kinds even when the system has one (true = every kind considered) */
  force?: boolean | string[];
  /** write the foundations' tokens over the system's (default true) */
  applyTokens?: boolean;
  /** reuse the site's own photos in cards / teasers / images (default true) */
  sitePhotos?: boolean;
}

/** Kinds that come from the site itself (its header, footer, hero, navigation) and are never generated. */
export const SITE_KINDS: readonly SceneComponentKind[] = ["header", "footer", "hero", "navigation"];

/* ------------------------------------------------------------------ colour maths */

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, RGBA> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

function rgba(c: string | undefined | null): RGBA | null {
  if (!c || typeof c !== "string") return null;
  const s = c.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s]!;
  const pa = (v: string | undefined) =>
    v === undefined ? 1 : v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v);
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4)
      h = h
        .split("")
        .map((x) => x + x)
        .join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: pa(m[4]) };
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) return { r: +m[1]! * 255, g: +m[2]! * 255, b: +m[3]! * 255, a: pa(m[4]) };
  return null;
}

const hexOf = (c: RGBA) =>
  "#" +
  [c.r, c.g, c.b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
/** `c` painted over the opaque `under`. */
const over = (c: RGBA, under: RGBA): RGBA => ({
  r: c.r * c.a + under.r * (1 - c.a),
  g: c.g * c.a + under.g * (1 - c.a),
  b: c.b * c.a + under.b * (1 - c.a),
  a: 1,
});
const lin = (v: number) => {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const lumOf = (c: RGBA) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const contrastOf = (a: RGBA, b: RGBA) => {
  const x = lumOf(a),
    y = lumOf(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** perceptual-ish distance ("redmean"), 0..~765 */
function dist(a: RGBA, b: RGBA): number {
  const rm = (a.r + b.r) / 2,
    dr = a.r - b.r,
    dg = a.g - b.g,
    db = a.b - b.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}
function hslOf(c: RGBA): { h: number; s: number; l: number } {
  const r = c.r / 255,
    g = c.g / 255,
    b = c.b / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}
function fromHsl(h: number, s: number, l: number): RGBA {
  h = ((h % 360) + 360) % 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
    p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return { r: f(h / 360 + 1 / 3) * 255, g: f(h / 360) * 255, b: f(h / 360 - 1 / 3) * 255, a: 1 };
}
const mixC = (a: RGBA, b: RGBA, t: number): RGBA => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
  a: 1,
});
/** a colour that reads as a brand hue (not grey, not near-white / near-black) */
const chromatic = (c: RGBA) => {
  const { s, l } = hslOf(c);
  return s >= 0.28 && l > 0.12 && l < 0.88 && lumOf(c) < 0.8;
};
const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };

/* ------------------------------------------------------------------ scan */

interface TextEntry {
  size: number;
  weight: number;
  lh: number;
  ls: number;
  upper: boolean;
  family: string;
  chars: number;
  color: RGBA;
  bg: RGBA;
  desktop: boolean;
}
interface FillEntry {
  color: RGBA;
  area: number;
  control: boolean;
}
interface Control {
  label: string;
  h: number;
  w: number;
  radius: number;
  fill: RGBA | null;
  outline: RGBA | null;
  outlineW: number;
  fs: number;
  fw: number;
  upper: boolean;
  ls: number;
  labelColor: RGBA | null;
  icon: "leading" | "trailing" | null;
  under: RGBA;
  family: string;
}
interface Field {
  h: number;
  radius: number;
  border: RGBA;
  borderW: number;
  bg: RGBA;
  fs: number;
}
interface CardLike {
  radius: number;
  shadow: boolean;
  border: boolean;
  bg: RGBA;
  under: RGBA;
}
interface Photo {
  src: string;
  w: number;
  h: number;
  alt?: string;
}

interface Scan {
  pageBg: RGBA;
  texts: TextEntry[];
  fills: FillEntry[];
  controls: Control[];
  fields: Field[];
  cards: CardLike[];
  borders: Map<string, { c: RGBA; n: number }>;
  shadows: Map<string, { list: SceneShadow[]; n: number }>;
  spacing: number[];
  imageRadii: number[];
  photos: Photo[];
  families: Map<string, number>;
}

const firstFamily = (f: string | undefined) =>
  (f ?? "")
    .split(",")[0]!
    .trim()
    .replace(/^["']|["']$/g, "");
const isIconFont = (f: string) => /icon|symbol|awesome|glyph|material/i.test(f);
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const radiusOf = (r: SceneStyle["radius"]) => (Array.isArray(r) ? Math.max(...r) : num(r));
const padOf = (p: SceneLayout["padding"]): [number, number, number, number] =>
  p === undefined
    ? [0, 0, 0, 0]
    : typeof p === "number"
      ? [p, p, p, p]
      : p.length === 2
        ? [p[0], p[1], p[0], p[1]]
        : p;
const textsBelow = (el: SceneElement): SceneElement[] => {
  const out: SceneElement[] = [];
  const w = (e: SceneElement) => {
    if (e.meta?.hidden) return;
    if (e.type === "text" && e.text?.trim()) out.push(e);
    e.children?.forEach(w);
  };
  w(el);
  return out;
};
const hasIconBelow = (el: SceneElement): boolean =>
  (el.children ?? []).some((c) => c.type === "icon" || c.type === "vector" || !!c.svg || hasIconBelow(c));
const isUpper = (s: SceneStyle | undefined, text?: string) =>
  !!(
    s?.uppercase ||
    s?.textTransform === "uppercase" ||
    (text && text.length > 3 && text === text.toUpperCase() && /\p{Lu}/u.test(text))
  );

export function scanScreens(screens: SceneScreen[]): Scan {
  const responsive = screens.filter((s) => s.responsive);
  const pool = responsive.length ? responsive : screens;
  // the desktop page sets the type scale (the system's sizes); colours come from every page
  const desktop = [...pool].sort(
    (a, b) => Math.abs(a.width - 1280) - Math.abs(b.width - 1280) || b.width - a.width,
  )[0];
  const bgCount = new Map<string, { c: RGBA; n: number }>();
  for (const s of pool) {
    const c = rgba(s.root.style?.background ?? s.tokens?.background);
    if (c && c.a > 0.5) {
      const k = hexOf(c);
      bgCount.set(k, { c: over(c, WHITE), n: (bgCount.get(k)?.n ?? 0) + 1 });
    }
  }
  const pageBg = [...bgCount.values()].sort((a, b) => b.n - a.n)[0]?.c ?? WHITE;
  const sc: Scan = {
    pageBg,
    texts: [],
    fills: [],
    controls: [],
    fields: [],
    cards: [],
    borders: new Map(),
    shadows: new Map(),
    spacing: [],
    imageRadii: [],
    photos: [],
    families: new Map(),
  };
  const seenPhoto = new Set<string>();
  const addBorder = (c: RGBA | null, under: RGBA) => {
    if (!c || c.a < 0.1) return;
    const f = over(c, under);
    const k = hexOf(f);
    const e = sc.borders.get(k);
    if (e) e.n++;
    else sc.borders.set(k, { c: f, n: 1 });
  };

  for (const screen of screens) {
    const isDesktop = screen === desktop;
    const rootBg = rgba(screen.root.style?.background);
    const start = rootBg && rootBg.a > 0.5 ? over(rootBg, WHITE) : pageBg;
    const walk = (el: SceneElement, under: RGBA, pw: number, inControl: boolean) => {
      if (el.meta?.hidden) return;
      const st = el.style ?? {},
        ly = el.layout ?? {};
      const w =
        typeof ly.width === "number"
          ? ly.width
          : ly.width === "fill"
            ? pw
            : typeof ly.width === "string" && ly.width.endsWith("%")
              ? (pw * parseFloat(ly.width)) / 100
              : 0;
      const h = typeof ly.height === "number" ? ly.height : 0;
      const solid = st.fills?.find((f) => f.type === "solid") as { color: string } | undefined;
      const bgc = rgba(st.background) ?? rgba(solid?.color);
      const opaque = !!bgc && bgc.a >= 0.5;
      const here = opaque ? over(bgc!, under) : under;
      const radius = radiusOf(st.radius);
      const shadows = (st.shadows ?? []).filter((x) => x && !x.inset && (x.blur > 0 || num(x.spread) > 0));
      const inset = (st.shadows ?? []).find((x) => x?.inset && num(x.spread) > 0 && !x.blur);
      const sides = st.borders
        ? (["top", "right", "bottom", "left"] as const).filter((k) => num(st.borders![k]?.width) > 0)
        : [];
      const borderC =
        st.border && st.border.width > 0
          ? rgba(st.border.color)
          : sides.length >= 3
            ? rgba(st.borders![sides[0]!]!.color)
            : inset
              ? rgba(inset.color)
              : null;
      const borderW =
        st.border?.width ??
        (sides.length ? num(st.borders![sides[0]!]!.width) : inset ? num(inset.spread) : 0);

      if (opaque && w * h > 0)
        sc.fills.push({ color: here, area: Math.min(w * h, 1_200_000), control: false });
      if (borderC && borderW <= 2.5) addBorder(borderC, under);
      // elevation shadows only: soft ones on boxes (not text glows / dark halos behind copy)
      if (shadows.length && el.type !== "text" && shadows.every((x) => (rgba(x.color)?.a ?? 1) <= 0.45)) {
        const k = JSON.stringify(shadows);
        const e = sc.shadows.get(k);
        if (e) e.n++;
        else sc.shadows.set(k, { list: shadows, n: 1 });
      }
      if (isDesktop && (el.children?.length ?? 0) > 1 && ly.direction) {
        if (num(ly.gap) > 0 && num(ly.gap) <= 160) sc.spacing.push(Math.round(num(ly.gap)));
        for (const p of padOf(ly.padding)) if (p >= 2 && p <= 160) sc.spacing.push(Math.round(p));
      }

      if (el.type === "text" && el.text?.trim()) {
        const fam = firstFamily(st.fontFamily);
        const color = rgba(st.color);
        if (!isIconFont(fam) && color && st.fontSize) {
          const fg = over(color, here);
          const lh = st.lineHeightPx ? st.lineHeightPx / st.fontSize : num(st.lineHeight, 0);
          sc.texts.push({
            size: st.fontSize,
            weight: num(st.fontWeight, 400),
            lh,
            ls: num(st.letterSpacing),
            upper: isUpper(st),
            family: fam,
            chars: el.text.trim().length,
            color: fg,
            bg: here,
            desktop: isDesktop,
          });
          if (fam) sc.families.set(fam, (sc.families.get(fam) ?? 0) + el.text.length);
        }
      }

      if (el.type === "image" || el.type === "video") {
        if (radius >= 0 && w > 80) sc.imageRadii.push(radius);
        const src = el.image?.src;
        const key = el.image?.alt?.trim() || src;
        if (
          src &&
          /^(data:image\/(png|jpe?g|webp)|https?:)/.test(src) &&
          src.length <= 140_000 &&
          w >= 150 &&
          h >= 90 &&
          !seenPhoto.has(key!) &&
          !seenPhoto.has(src)
        ) {
          seenPhoto.add(src);
          seenPhoto.add(key!);
          sc.photos.push({ src, w, h, alt: el.image?.alt });
        }
      }

      // button-like layers: a button, or a small framed / filled box around one short label (or one icon)
      let control = false;
      if (
        !inControl &&
        h >= 18 &&
        h <= 72 &&
        w > 0 &&
        w < 560 &&
        w >= h * 0.9 &&
        (el.children?.length ?? 0) <= 4
      ) {
        const labels = textsBelow(el);
        const label = labels.map((t) => t.text!.trim()).join(" ");
        const named =
          el.type === "button" || /button|btn|cta|pointer|link/i.test(el.name ?? "") || !!el.interaction;
        const framed = (opaque && dist(here, under) > 12) || (!!borderC && borderW > 0);
        if (
          (named || framed) &&
          ((label.length >= 2 && label.length <= 40 && labels.length <= 2) || (!label && hasIconBelow(el)))
        ) {
          control = true;
          const t = labels[0];
          const ts = t?.style ?? {};
          const kids = el.children ?? [];
          const ti = kids.findIndex((c) => textsBelow(c).length > 0);
          const ii = kids.findIndex((c) => c.type === "icon" || c.type === "vector" || !!c.svg);
          sc.controls.push({
            label,
            h,
            w,
            radius,
            fill: framed && opaque && dist(here, under) > 12 ? here : null,
            outline: borderC && borderW > 0 ? over(borderC, under) : null,
            outlineW: borderW,
            fs: num(ts.fontSize, 0),
            fw: num(ts.fontWeight, 400),
            upper: isUpper(ts, t?.text),
            ls: num(ts.letterSpacing),
            labelColor: rgba(ts.color) ? over(rgba(ts.color)!, here) : null,
            icon: ii >= 0 && ti >= 0 ? (ii < ti ? "leading" : "trailing") : null,
            under,
            family: firstFamily(ts.fontFamily),
          });
          if (opaque) sc.fills.push({ color: here, area: w * h, control: true });
        }
      }
      // text fields: an input, or a bordered box (≥ 3 sides) holding a placeholder
      if (
        !control &&
        (el.type === "input" ||
          /input|field|search|textfeld|eingabe/i.test(el.name ?? "") ||
          (borderC && borderW > 0)) &&
        h >= 34 &&
        h <= 68 &&
        w >= 160
      ) {
        const t = textsBelow(el)[0];
        if (el.type === "input" || (t && borderC))
          sc.fields.push({
            h,
            radius,
            border: borderC ? over(borderC, under) : mixC(under, { r: 0, g: 0, b: 0, a: 1 }, 0.3),
            borderW: borderW || 1,
            bg: here,
            fs: num(t?.style?.fontSize, 16),
          });
      }
      // cards: framed / elevated boxes with content
      if (
        !control &&
        w * h >= 24_000 &&
        w < pw * 0.9 &&
        (radius > 0 || shadows.length || borderC) &&
        (el.children?.length ?? 0) > 0
      ) {
        sc.cards.push({ radius, shadow: shadows.length > 0, border: !!borderC, bg: here, under });
      }
      const [, pr, , pl] = padOf(ly.padding);
      const inner = Math.max(0, (w || pw) - pl - pr);
      for (const c of el.children ?? []) walk(c, here, inner, inControl || control);
    };
    walk(screen.root, start, screen.width, false);
  }
  return sc;
}

/* ------------------------------------------------------------------ foundations */

const median = (xs: number[], d = 0) => {
  if (!xs.length) return d;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r2 = (v: number) => Math.round(v * 100) / 100;
function dominant<K>(entries: Iterable<[K, number]>): K | undefined {
  let best: K | undefined,
    n = -Infinity;
  for (const [k, v] of entries)
    if (v > n) {
      n = v;
      best = k;
    }
  return best;
}
function tally<T>(
  items: T[],
  key: (t: T) => string,
  weight: (t: T) => number = () => 1,
): Map<string, { item: T; n: number }> {
  const m = new Map<string, { item: T; n: number }>();
  for (const it of items) {
    const k = key(it);
    const e = m.get(k);
    if (e) e.n += weight(it);
    else m.set(k, { item: it, n: weight(it) });
  }
  return m;
}

interface TypeSpec {
  size: number;
  weight: number;
  lh: number;
  ls: number;
  upper: boolean;
  family: string;
  source: "site" | "derived";
}

interface Look {
  ctrl: {
    h: number;
    padX: number;
    radius: number;
    pill: boolean;
    fs: number;
    fw: number;
    upper: boolean;
    ls: number;
    iconLeading: boolean;
    family: string;
  };
  onPrimary: string;
  secondary: "outline" | "tonal";
  outlineColor: string;
  /** label colour of outlined buttons */
  outlineInk: string;
  outlineW: number;
  /** colour for primary-coloured copy / marks on the page background (primary itself, or the text colour when primary is too light) */
  ink: string;
  link: string;
  /** dark surface for toasts / tooltips and the copy on it */
  dark: string;
  onDark: string;
  field: { h: number; radius: number; border: string; borderW: number; bg: string };
  card: { radius: number; shadow: boolean; border: boolean; flat: boolean };
  small: { radius: number; upper: boolean; fw: number };
  imageRadius: number;
  focus: string;
}

interface Analysis {
  foundations: BrandFoundations;
  look: Look;
  type: Record<TypeRole, TypeSpec>;
  space: { xs: number; sm: number; md: number; lg: number; xl: number; xxl: number; xxxl: number };
  photos: Photo[];
  tokens: SceneTokens;
}

export const TEXT_STYLE_IDS: Record<TypeRole, string> = {
  display: "bk-text-display",
  h1: "bk-text-h1",
  h2: "bk-text-h2",
  h3: "bk-text-h3",
  h4: "bk-text-h4",
  bodyL: "bk-text-body-l",
  body: "bk-text-body",
  small: "bk-text-small",
  caption: "bk-text-caption",
  label: "bk-text-label",
  overline: "bk-text-overline",
};
const TEXT_STYLE_NAMES: Record<TypeRole, string> = {
  display: "Display",
  h1: "Heading/H1",
  h2: "Heading/H2",
  h3: "Heading/H3",
  h4: "Heading/H4",
  bodyL: "Body/Large",
  body: "Body/Regular",
  small: "Body/Small",
  caption: "Caption",
  label: "Label/Button",
  overline: "Label/Overline",
};
export const EFFECT_STYLE_IDS = {
  e1: "bk-elevation-1",
  e2: "bk-elevation-2",
  e3: "bk-elevation-3",
  focus: "bk-focus-ring",
} as const;
export const BRAND_COLLECTION_ID = "coll-brand-foundations";
const BRAND_MODE = "mode-brand-default";
const VAR = {
  control: "var-bk-radius-control",
  card: "var-bk-radius-card",
  image: "var-bk-radius-image",
} as const;

function typeScale(
  sc: Scan,
  controls: Control[],
  bodyFamily: string,
  pageBg: RGBA,
): Record<TypeRole, TypeSpec> {
  const texts = sc.texts.filter((t) => t.desktop).length ? sc.texts.filter((t) => t.desktop) : sc.texts;
  const bySize = new Map<number, TextEntry[]>();
  for (const t of texts) {
    const k = Math.round(t.size);
    if (k >= 8) bySize.set(k, [...(bySize.get(k) ?? []), t]);
  }
  const chars = (xs: TextEntry[]) => xs.reduce((a, t) => a + t.chars, 0);
  const total = chars(texts) || 1;
  const famOf = (xs: TextEntry[]) =>
    dominant(
      [
        ...tally(
          xs,
          (t) => t.family,
          (t) => t.chars,
        ),
      ].map(([k, v]) => [k, v.n] as [string, number]),
    ) || bodyFamily;
  const spec = (
    size: number,
    xs: TextEntry[],
    o: { regular?: boolean; bold?: boolean; weight?: number } = {},
  ): TypeSpec => {
    const pool =
      o.regular && xs.some((t) => t.weight <= 500)
        ? xs.filter((t) => t.weight <= 500)
        : o.bold && chars(xs.filter((t) => t.weight >= 600)) >= chars(xs) * 0.3
          ? xs.filter((t) => t.weight >= 600)
          : xs;
    const fallback = o.regular && pool === xs ? (o.weight ?? 400) : undefined;
    const dom = () =>
      Number(
        dominant(
          [
            ...tally(
              pool,
              (t) => String(t.weight),
              (t) => t.chars,
            ),
          ].map(([k, v]) => [k, v.n] as [string, number]),
        ) ?? 400,
      );
    const weight = fallback ?? (o.regular ? dom() : (o.weight ?? dom()));
    const same = pool.filter((t) => t.weight === weight);
    const lhs = same.map((t) => t.lh).filter((x) => x > 0.8 && x < 2.2);
    const up = same.filter((t) => t.upper).reduce((a, t) => a + t.chars, 0) > chars(same) / 2;
    return {
      size,
      weight,
      lh: r2(median(lhs, 1.4)),
      ls: r2(
        median(
          same.map((t) => t.ls),
          0,
        ),
      ),
      upper: up,
      family: famOf(same.length ? same : pool),
      source: "site",
    };
  };
  // body: the regular size most copy on the page itself is set in (footers / dark bands count less)
  const onPage = (t: TextEntry) => (contrastOf(t.bg, pageBg) < 1.25 ? 1 : 0.3);
  const bodyCands = [...bySize]
    .filter(([s]) => s >= 13 && s <= 20)
    .map(
      ([s, xs]) =>
        [s, xs.filter((t) => t.weight <= 500).reduce((a, t) => a + t.chars * onPage(t), 0)] as [
          number,
          number,
        ],
    );
  const bodySize = dominant(bodyCands.filter(([, n]) => n > 0)) ?? 16;
  const body = bySize.has(bodySize)
    ? spec(bodySize, bySize.get(bodySize)!, { regular: true })
    : { size: 16, weight: 400, lh: 1.5, ls: 0, upper: false, family: bodyFamily, source: "derived" as const };
  if (body.lh < 1.3) body.lh = 1.5;
  // headings: sizes well above the body, near sizes merged (23 / 24 px are one step)
  const big = [...bySize]
    .filter(([s, xs]) => s >= Math.max(20, body.size * 1.3) && (chars(xs) >= 6 || xs.length >= 2))
    .sort((a, b) => b[0] - a[0]);
  const steps: Array<[number, TextEntry[]]> = [];
  for (const [s, xs] of big) {
    const last = steps[steps.length - 1];
    if (last && last[0] / s < 1.09) {
      if (chars(xs) > chars(last[1])) last[0] = s;
      last[1] = [...last[1], ...xs];
    } else steps.push([s, xs]);
  }
  const heads = steps.map(([s, xs]) => spec(s, xs, { bold: true }));
  const derive = (size: number, like: TypeSpec | undefined, lh: number): TypeSpec => ({
    size: Math.round(size),
    weight: like?.weight ?? 700,
    lh,
    ls: like?.ls ?? 0,
    upper: false,
    family: like?.family ?? bodyFamily,
    source: "derived",
  });
  let display = heads[0] && heads[0].size >= 48 ? heads.shift()! : undefined;
  const h1 = heads.shift() ?? derive(body.size * 2.25, display, 1.15);
  const h2 = heads.shift() ?? derive(h1.size / 1.25, h1, 1.2);
  const h3 = heads.shift() ?? derive(Math.max(body.size * 1.35, h2.size / 1.2), h2, 1.25);
  const boldMid = [...bySize]
    .filter(([s]) => s > body.size && s < h3.size)
    .map(([s, xs]) => [s, chars(xs.filter((t) => t.weight >= 600))] as [number, number])
    .filter(([, n]) => n > 0);
  const h4Size = heads[0]?.size ?? dominant(boldMid);
  const h4 =
    heads[0] ??
    (h4Size
      ? spec(
          h4Size,
          bySize.get(h4Size)!.filter((t) => t.weight >= 600),
        )
      : derive(Math.max(body.size + 2, h3.size / 1.2), h3, 1.3));
  display ??= { ...derive(Math.max(h1.size * 1.25, h1.size + 8), h1, 1.1), upper: h1.upper };
  // keep the scale strictly descending
  const chain = [display, h1, h2, h3, h4];
  for (let i = 1; i < chain.length; i++)
    if (chain[i]!.size >= chain[i - 1]!.size) chain[i]!.size = Math.round(chain[i - 1]!.size / 1.15);
  for (const t of chain) {
    if (t.lh <= 0.8 || t.lh > 1.6) t.lh = t.size >= 40 ? 1.1 : 1.2;
  }
  // body large / small / caption
  const regularIn = (lo: number, hi: number) =>
    [...bySize]
      .filter(([s]) => s > lo && s <= hi)
      .map(([s, xs]) => [s, chars(xs.filter((t) => t.weight <= 500))] as [number, number])
      .filter(([, n]) => n > 0);
  const blSize = dominant(regularIn(body.size, body.size * 1.5));
  const bodyL = blSize
    ? spec(blSize, bySize.get(blSize)!, { regular: true })
    : { ...body, size: body.size + 2, source: "derived" as const };
  if (bodyL.lh < 1.25) bodyL.lh = r2(Math.max(body.lh - 0.05, 1.35));
  const below = [...bySize]
    .filter(([s, xs]) => s < body.size && s >= 11 && chars(xs) >= total * 0.02)
    .sort((a, b) => b[0] - a[0]);
  const small = below[0]
    ? spec(below[0][0], below[0][1], { regular: true, weight: body.weight })
    : { ...body, size: body.size - 2, source: "derived" as const };
  const capC = below.slice(1).filter(([s]) => s >= 10);
  const capSize = dominant(capC.map(([s, xs]) => [s, chars(xs)] as [number, number]));
  const caption = capSize
    ? spec(capSize, bySize.get(capSize)!)
    : { ...small, size: Math.max(11, small.size - 2), source: "derived" as const };
  for (const t of [small, caption]) if (t.lh < 1.2 || t.lh > 1.8) t.lh = 1.4;
  // button label: what the site's controls are set in
  const ctl = controls.filter((c) => c.fs > 0 && c.h >= 30);
  const label: TypeSpec = ctl.length
    ? {
        size: Math.round(median(ctl.map((c) => c.fs))),
        weight: Number(
          dominant([...tally(ctl, (c) => String(c.fw))].map(([k, v]) => [k, v.n] as [string, number])),
        ),
        lh: 1.2,
        ls: r2(median(ctl.map((c) => c.ls))),
        upper: ctl.filter((c) => c.upper).length > ctl.length / 2,
        family: ctl[0]!.family || body.family,
        source: "site",
      }
    : {
        size: body.size,
        weight: Math.max(600, h4.weight),
        lh: 1.2,
        ls: 0,
        upper: false,
        family: body.family,
        source: "derived",
      };
  // overline: small uppercase copy, else a derived one
  const ups = texts.filter((t) => t.upper && t.size <= body.size && t.size >= 10);
  const upSize = dominant(
    [
      ...tally(
        ups,
        (t) => String(Math.round(t.size)),
        (t) => t.chars,
      ),
    ].map(([k, v]) => [Number(k), v.n] as [number, number]),
  );
  const overline: TypeSpec = upSize
    ? {
        ...spec(
          upSize,
          ups.filter((t) => Math.round(t.size) === upSize),
        ),
        upper: true,
      }
    : {
        size: Math.max(11, caption.size),
        weight: Math.max(600, label.weight),
        lh: 1.3,
        ls: 0.08,
        upper: true,
        family: body.family,
        source: "derived",
      };
  return { display, h1, h2, h3, h4, bodyL, body, small, caption, label, overline };
}

function analyse(screens: SceneScreen[], ds: SceneDesignSystem): Analysis {
  const sc = scanScreens(screens);
  const base: SceneTokens = { ...DEFAULT_TOKENS, ...ds.tokens };
  const src: Record<string, "site" | "derived"> = {};
  const bg = sc.pageBg;
  const light = lumOf(bg) > 0.4;
  const onPage = (t: TextEntry) => dist(t.bg, bg) < 14 && contrastOf(t.color, t.bg) >= 2;
  const pageTexts = sc.texts.filter(onPage);

  // copy colours
  const textTally = [
    ...tally(
      pageTexts.length ? pageTexts : sc.texts,
      (t) => hexOf(t.color),
      (t) => t.chars,
    ).values(),
  ].sort((a, b) => b.n - a.n);
  const text =
    textTally.find((t) => contrastOf(t.item.color, bg) >= 4.5)?.item.color ??
    (light ? { r: 24, g: 24, b: 27, a: 1 } : WHITE);
  src.text = textTally.length ? "site" : "derived";
  const mutedHit = textTally.find((t) => {
    const c = t.item.color;
    const k = contrastOf(c, bg);
    return dist(c, text) > 40 && k >= 3 && k < contrastOf(text, bg) && hslOf(c).s < 0.3;
  });
  let textMuted = mutedHit?.item.color ?? mixC(text, bg, 0.38);
  for (let t = 0.34; !mutedHit && contrastOf(textMuted, bg) < 4.5 && t > 0.1; t -= 0.04)
    textMuted = mixC(text, bg, t);
  src.textMuted = mutedHit ? "site" : "derived";

  // brand colours: control fills, large areas and coloured copy, as shares
  type Cand = { c: RGBA; ctrl: number; area: number; txt: number };
  const cands: Cand[] = [];
  const candOf = (c: RGBA) => {
    let e = cands.find((x) => dist(x.c, c) < 28);
    if (!e) {
      e = { c, ctrl: 0, area: 0, txt: 0 };
      cands.push(e);
    }
    return e;
  };
  for (const f of sc.fills)
    if (chromatic(f.color)) {
      const e = candOf(f.color);
      if (f.control) e.ctrl += 1;
      else e.area += f.area;
    }
  for (const t of sc.texts)
    if (chromatic(t.color) && contrastOf(t.color, t.bg) >= 2) candOf(t.color).txt += t.chars;
  const sum = (k: "ctrl" | "area" | "txt") => cands.reduce((a, c) => a + c[k], 0) || 1;
  const S = { ctrl: sum("ctrl"), area: sum("area"), txt: sum("txt") };
  const score = (c: Cand) => (0.45 * c.ctrl) / S.ctrl + (0.4 * c.area) / S.area + (0.15 * c.txt) / S.txt;
  const ranked = [...cands].sort((a, b) => score(b) - score(a));
  const primaryC = ranked[0]?.c ?? rgba(base.primary) ?? { r: 37, g: 99, b: 235, a: 1 };
  src.primary = ranked[0] ? "site" : "derived";
  const others = ranked.slice(1).filter((c) => dist(c.c, primaryC) > 60);
  // secondary: a second brand hue that matters, else the dark neutral of the large bands (footers, stages), else the copy colour
  const darkFill = [
    ...tally(
      sc.fills.filter((f) => !chromatic(f.color) && lumOf(f.color) < 0.12 && f.area > 40_000),
      (f) => hexOf(f.color),
      (f) => f.area,
    ).values(),
  ].sort((a, b) => b.n - a.n)[0]?.item.color;
  const secondHue = others.find((c) => score(c) >= 0.15);
  const secondaryC = secondHue?.c ?? darkFill ?? text;
  src.secondary = secondHue || darkFill ? "site" : "derived";
  // accent: the link / highlight hue, else a deeper primary
  const accentHit = others.find(
    (c) => c !== secondHue && dist(c.c, secondaryC) > 60 && (c.txt > 0 || c.ctrl > 0),
  );
  const accentC =
    accentHit?.c ??
    (lumOf(primaryC) > 0.4 ? mixC(primaryC, { r: 0, g: 0, b: 0, a: 1 }, 0.35) : mixC(primaryC, WHITE, 0.25));
  src.accent = accentHit ? "site" : "derived";

  // surfaces: what cards sit on, and the tinted band colour
  const cardBg = [
    ...tally(
      sc.cards.filter((c) => lumOf(c.bg) > 0.6 === light),
      (c) => hexOf(c.bg),
    ).values(),
  ].sort((a, b) => b.n - a.n)[0]?.item.bg;
  const surface = cardBg ?? (light ? WHITE : mixC(bg, WHITE, 0.06));
  const tint = [
    ...tally(
      sc.fills.filter(
        (f) =>
          (light ? lumOf(f.color) > 0.72 : lumOf(f.color) < 0.2) &&
          dist(f.color, bg) > 6 &&
          dist(f.color, surface) > 6 &&
          Math.max(f.color.r, f.color.g, f.color.b) - Math.min(f.color.r, f.color.g, f.color.b) < 48,
      ),
      (f) => hexOf(f.color),
      (f) => f.area,
    ).values(),
  ].sort((a, b) => b.n - a.n)[0]?.item.color;
  const surfaceAlt = tint ?? mixC(surface, light ? { r: 0, g: 0, b: 0, a: 1 } : WHITE, 0.04);
  src.surface = cardBg ? "site" : "derived";
  src.surfaceAlt = tint ? "site" : "derived";
  const borderHit = [...sc.borders.values()]
    .filter((b) => contrastOf(b.c, bg) < 2.2 && contrastOf(b.c, bg) >= 1.18)
    .sort((a, b) => b.n - a.n)[0]?.c;
  const border = borderHit ?? mixC(text, bg, 0.84);
  src.border = borderHit ? "site" : "derived";

  // feedback colours: the site's own reds / greens / ambers when it has them, else made to sit with the primary
  const pSat = Math.min(0.85, Math.max(0.5, hslOf(primaryC).s));
  const usedHues = [...sc.fills.map((f) => f.color), ...sc.texts.map((t) => t.color)].filter(
    (c) => hslOf(c).s > 0.45,
  );
  const find = (h: number, w: number, lMax: number) =>
    usedHues.find(
      (c) => hueGap(hslOf(c).h, h) <= w && hslOf(c).l <= lMax && hslOf(c).l > 0.15 && dist(c, primaryC) > 50,
    );
  const success = find(140, 30, 0.45) ?? fromHsl(148, pSat * 0.85, 0.34);
  const warning = find(38, 14, 0.6) ?? fromHsl(36, 0.92, 0.48);
  const danger = find(356, 14, 0.5) ?? fromHsl(356, Math.max(0.65, pSat), 0.44);
  src.success = success === find(140, 30, 0.45) ? "site" : "derived";

  const bodyFamily =
    (dominant([...sc.families].filter(([f]) => !isIconFont(f))) ?? firstFamily(base.fontFamily)) || "Inter";
  // controls: the site's labelled buttons (32–64 px), the primary-coloured ones first
  const textCtrls = sc.controls.filter((c) => c.label && c.h >= 30 && c.h <= 64);
  const filled = textCtrls.filter((c) => c.fill && (chromatic(c.fill) || lumOf(c.fill) < 0.1));
  const prim = filled.filter((c) => dist(c.fill!, primaryC) < 40).length
    ? filled.filter((c) => dist(c.fill!, primaryC) < 40)
    : textCtrls.some((c) => c.fill || c.outline)
      ? textCtrls.filter((c) => c.fill || c.outline)
      : textCtrls;

  const type = typeScale(sc, prim, bodyFamily, bg);
  const fontFamily = type.body.family || bodyFamily;
  const h = Math.max(
    36,
    Math.min(
      56,
      2 *
        Math.round(
          median(
            prim.map((c) => c.h),
            44,
          ) / 2,
        ),
    ),
  );
  const rad = median(
    prim.map((c) => c.radius),
    Math.min(8, base.radius),
  );
  const pill =
    rad >=
    median(
      prim.map((c) => c.h),
      h,
    ) /
      2 -
      2;
  const fs = type.label.size;
  const estPad = prim
    .map((c) => (c.w - c.label.length * c.fs * (c.fw >= 600 ? 0.6 : 0.55)) / 2)
    .filter((p) => p > 4);
  const padX = Math.max(pill ? 20 : 14, Math.min(32, 4 * Math.round(median(estPad, h * 0.45) / 4)));
  const withIcon = textCtrls.filter((c) => c.icon);
  const iconLeading = withIcon.filter((c) => c.icon === "leading").length > withIcon.length / 2;
  const outlines = textCtrls.filter((c) => !c.fill && c.outline && dist(c.under, bg) < 20);
  const outlineRaw = dominant(
    [...tally(outlines, (c) => hexOf(c.outline!))].map(([k, v]) => [k, v.n] as [string, number]),
  );
  const near = (c: RGBA, d = 30) =>
    dist(c, text) < d
      ? "$text"
      : dist(c, primaryC) < d
        ? "$primary"
        : dist(c, secondaryC) < d
          ? "$secondary"
          : null;
  const primaryReadable = contrastOf(primaryC, bg) >= 3;
  const ink = primaryReadable ? "$primary" : "$text";
  const outC = outlineRaw ? rgba(outlineRaw)! : null;
  // an outline has to read as a control edge (≥ 3:1); a white outline on a dark stage becomes the ink colour
  const outlineColor =
    outC && contrastOf(outC, bg) >= 3
      ? (near(outC) ?? hexOf(outC))
      : outC && contrastOf(outC, bg) >= 1.6 && dist(outC, text) < 120
        ? "$text"
        : ink;
  const labelOnPrimary = prim
    .filter((c) => c.fill && dist(c.fill, primaryC) < 40 && c.labelColor)
    .map((c) => c.labelColor!);
  const onP = labelOnPrimary[0];
  const onPrimary =
    onP && contrastOf(onP, primaryC) >= 3
      ? dist(onP, bg) < 20
        ? "$background"
        : dist(onP, text) < 20
          ? "$text"
          : hexOf(onP)
      : contrastOf(text, primaryC) > contrastOf(bg, primaryC)
        ? "$text"
        : "$background";
  const small = sc.controls.filter((c) => c.label && c.h >= 16 && c.h < 30);
  const smallRad = median(
    small.map((c) => c.radius),
    pill ? 999 : Math.min(rad, 4),
  );
  const fields = sc.fields;
  const fieldBorderRaw = fields.length
    ? dominant([...tally(fields, (f) => hexOf(f.border))].map(([k, v]) => [k, v.n] as [string, number]))
    : undefined;
  const fieldBorder =
    fieldBorderRaw && contrastOf(rgba(fieldBorderRaw)!, bg) >= 1.8
      ? fieldBorderRaw
      : hexOf(mixC(text, bg, 0.55));
  const cardR = median(
    sc.cards.map((c) => c.radius).filter((r) => r < 64),
    pill ? 16 : Math.max(rad, 4),
  );
  const look: Look = {
    ctrl: {
      h,
      padX,
      radius: pill ? 999 : Math.round(rad),
      pill,
      fs,
      fw: type.label.weight,
      upper: type.label.upper,
      ls: type.label.ls,
      iconLeading,
      family: type.label.family,
    },
    onPrimary,
    secondary: outlines.length ? "outline" : "tonal",
    outlineColor,
    outlineInk: outlineColor === "$primary" || outlineColor === "$secondary" ? outlineColor : "$text",
    outlineW: Math.max(
      1,
      Math.min(
        2,
        Math.round(
          median(
            outlines.map((c) => c.outlineW),
            1,
          ),
        ),
      ),
    ),
    ink,
    link: accentHit && contrastOf(accentC, bg) >= 3 ? "$accent" : ink,
    dark: lumOf(secondaryC) < 0.08 ? "$secondary" : "$text",
    onDark: "$background",
    field: {
      h: Math.max(
        40,
        Math.min(
          56,
          2 *
            Math.round(
              median(
                fields.map((f) => f.h),
                h,
              ) / 2,
            ),
        ),
      ),
      radius: fields.length ? Math.round(median(fields.map((f) => f.radius))) : pill ? 999 : Math.round(rad),
      border: fieldBorder,
      borderW: Math.max(
        1,
        Math.round(
          median(
            fields.map((f) => f.borderW),
            1,
          ),
        ),
      ),
      bg: "$background",
    },
    card: {
      radius: Math.round(cardR),
      shadow: sc.cards.filter((c) => c.shadow).length >= Math.max(2, sc.cards.length * 0.25),
      border: sc.cards.filter((c) => c.border).length >= Math.max(2, sc.cards.length * 0.25),
      flat: false,
    },
    small: {
      radius: smallRad >= 12 ? 999 : Math.round(smallRad),
      upper: small.filter((c) => c.upper).length > small.length / 2,
      fw: Math.max(600, type.label.weight),
    },
    imageRadius: Math.round(
      median(
        sc.imageRadii.filter((r) => r < 64),
        cardR,
      ),
    ),
    focus: primaryReadable ? "$primary" : "$text",
  };
  look.card.flat = !look.card.shadow && !look.card.border;

  // spacing: the base grid and the steps the site uses
  const sp = sc.spacing;
  const on8 = sp.filter((v) => v >= 8 && v % 8 === 0).length,
    on4 = sp.filter((v) => v >= 4 && v % 4 === 0).length;
  const unit = on4 && on8 / on4 >= 0.55 ? 8 : 4;
  const step = (std: number) => {
    const hits = [
      ...tally(
        sp.filter((v) => v >= std * 0.85 && v <= std * 1.15 && v % (unit === 8 ? 4 : 2) === 0),
        (v) => String(v),
      ),
    ].sort((a, b) => b[1].n - a[1].n)[0];
    return hits && hits[1].n >= 3 ? Number(hits[0]) : std;
  };
  const space = {
    xs: step(4),
    sm: step(8),
    md: step(16),
    lg: step(24),
    xl: step(32),
    xxl: step(48),
    xxxl: step(64),
  };
  for (const [k, v] of Object.entries({
    sm: space.xs,
    md: space.sm,
    lg: space.md,
    xl: space.lg,
    xxl: space.xl,
    xxxl: space.xxl,
  }) as [keyof typeof space, number][])
    if (space[k] <= v) space[k] = v + unit;

  const tokens: SceneTokens = {
    theme: light ? "light" : "dark",
    primary: hexOf(primaryC),
    secondary: hexOf(secondaryC),
    accent: hexOf(accentC),
    background: hexOf(bg),
    surface: hexOf(surface),
    surfaceAlt: hexOf(surfaceAlt),
    text: hexOf(text),
    textMuted: hexOf(textMuted),
    border: hexOf(border),
    success: hexOf(success),
    warning: hexOf(warning),
    danger: hexOf(danger),
    radius: look.ctrl.pill ? Math.min(look.card.radius, 24) : look.ctrl.radius,
    spacing: unit,
    fontFamily,
    fontMono: base.fontMono,
  };

  // elevations: the site's shadows, softest first; missing levels made in the same colour
  const shadowList = [...sc.shadows.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 6)
    .map((s) => s.list);
  const strength = (l: SceneShadow[]) => Math.max(...l.map((x) => x.y + x.blur / 2 + num(x.spread)));
  const levels: SceneShadow[][] = [];
  for (const l of [...shadowList].sort((a, b) => strength(a) - strength(b)))
    if (!levels.some((x) => Math.abs(strength(x) - strength(l)) < 4)) levels.push(l);
  const shadowInk = (() => {
    const c = rgba(levels[0]?.[0]?.color);
    return c ? { r: c.r, g: c.g, b: c.b, a: 1 } : text;
  })();
  const sh = (a: number) =>
    `rgba(${Math.round(shadowInk.r)}, ${Math.round(shadowInk.g)}, ${Math.round(shadowInk.b)}, ${a})`;
  const synth: SceneShadow[][] = [
    [
      { x: 0, y: 1, blur: 2, color: sh(0.08) },
      { x: 0, y: 2, blur: 8, spread: -2, color: sh(0.1) },
    ],
    [
      { x: 0, y: 4, blur: 12, spread: -2, color: sh(0.12) },
      { x: 0, y: 2, blur: 4, color: sh(0.06) },
    ],
    [
      { x: 0, y: 16, blur: 40, spread: -8, color: sh(0.22) },
      { x: 0, y: 4, blur: 12, spread: -2, color: sh(0.1) },
    ],
  ];
  const elev = [0, 1, 2].map((i) =>
    levels.length >= 3 ? levels[Math.round((i * (levels.length - 1)) / 2)]! : (levels[i] ?? synth[i]!),
  );
  if (levels.length < 3 && levels.length)
    for (let i = levels.length; i < 3; i++)
      if (strength(elev[i]!) <= strength(elev[i - 1]!)) elev[i] = synth[i]!;

  const textStyles: SceneTextStyle[] = (Object.keys(TEXT_STYLE_IDS) as TypeRole[]).map((role) => {
    const t = type[role];
    return {
      id: TEXT_STYLE_IDS[role],
      name: TEXT_STYLE_NAMES[role],
      fontFamily: t.family || fontFamily,
      fontSize: t.size,
      fontWeight: t.weight,
      lineHeight: t.lh,
      ...(t.ls ? { letterSpacing: t.ls } : {}),
      ...(t.upper ? { uppercase: true } : {}),
    };
  });
  const paint: ScenePaintStyle[] = [
    ["primary", "Brand/Primary", "$primary"],
    ["secondary", "Brand/Secondary", "$secondary"],
    ["accent", "Brand/Accent", "$accent"],
    ["on-primary", "Brand/On primary", look.onPrimary],
    ["background", "Neutral/Background", "$background"],
    ["surface", "Neutral/Surface", "$surface"],
    ["surface-alt", "Neutral/Surface alt", "$surfaceAlt"],
    ["border", "Neutral/Border", "$border"],
    ["text", "Text/Primary", "$text"],
    ["text-muted", "Text/Muted", "$textMuted"],
    ["success", "Feedback/Success", "$success"],
    ["warning", "Feedback/Warning", "$warning"],
    ["danger", "Feedback/Error", "$danger"],
  ].map(([id, name, color]) => ({ id: `bk-paint-${id}`, name: name!, color: color! }));
  const effect: SceneEffectStyle[] = [
    { id: EFFECT_STYLE_IDS.e1, name: "Elevation/1", shadows: elev[0], description: "Cards, raised controls" },
    { id: EFFECT_STYLE_IDS.e2, name: "Elevation/2", shadows: elev[1], description: "Menus, popovers, hover" },
    { id: EFFECT_STYLE_IDS.e3, name: "Elevation/3", shadows: elev[2], description: "Dialogs, toasts" },
    {
      id: EFFECT_STYLE_IDS.focus,
      name: "Focus ring",
      shadows: [
        { x: 0, y: 0, blur: 0, spread: 2, color: "$background" },
        { x: 0, y: 0, blur: 0, spread: 4, color: look.focus },
      ],
      description: "Keyboard focus",
    },
  ];
  const variables: SceneVariableCollection[] = [
    {
      id: BRAND_COLLECTION_ID,
      name: "Brand foundations",
      defaultModeId: BRAND_MODE,
      modes: [{ id: BRAND_MODE, name: "Default" }],
      variables: [
        ...(Object.entries(space) as [string, number][]).map(([k, v]) => ({
          id: `var-bk-space-${k}`,
          name: `space/${k.replace("xxx", "3x").replace("xx", "2x")}`,
          type: "number" as const,
          values: { [BRAND_MODE]: v },
          scopes: ["gap"],
        })),
        {
          id: VAR.control,
          name: "radius/control",
          type: "number",
          values: { [BRAND_MODE]: look.ctrl.radius },
          scopes: ["radius"],
          description: "Buttons, inputs, chips",
        },
        {
          id: VAR.card,
          name: "radius/card",
          type: "number",
          values: { [BRAND_MODE]: look.card.radius },
          scopes: ["radius"],
          description: "Cards, panels, dialogs",
        },
        {
          id: VAR.image,
          name: "radius/image",
          type: "number",
          values: { [BRAND_MODE]: look.imageRadius },
          scopes: ["radius"],
        },
      ],
    },
  ];
  const webfonts = [
    ...new Set(
      sc.texts
        .map((t) => t.family)
        .filter(
          (f) =>
            f &&
            !/^(arial|helvetica|sans-serif|serif|system-ui|roboto|-apple-system|times new roman)$/i.test(f),
        ),
    ),
  ];
  const summary: BrandSummary = {
    fonts: { body: fontFamily, display: type.display.family || fontFamily, webfonts },
    scale: Object.fromEntries(
      (Object.keys(type) as TypeRole[]).map((r) => [
        r,
        `${type[r].size}/${type[r].weight}${type[r].upper ? " UP" : ""}${type[r].source === "derived" ? " (derived)" : ""}`,
      ]),
    ) as Record<TypeRole, string>,
    radii: { control: look.ctrl.radius, card: look.card.radius, image: look.imageRadius },
    spacing: Object.values(space),
    controls: {
      height: look.ctrl.h,
      radius: look.ctrl.radius,
      secondary: look.secondary,
      uppercase: look.ctrl.upper,
      labelWeight: look.ctrl.fw,
      iconLeading: look.ctrl.iconLeading,
    },
    colorSources: src,
  };
  const photos = [...sc.photos]
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .filter((p) => p.w / p.h > 0.9 && p.w / p.h < 2.6)
    .slice(0, 6);
  return {
    foundations: { tokens, styles: { text: textStyles, paint, effect }, variables, summary },
    look,
    type,
    space,
    photos,
    tokens,
  };
}

/** Foundations of a brand, read from its (imported) screens. */
export function brandFoundations(screens: SceneScreen[], ds: SceneDesignSystem): BrandFoundations {
  return analyse(screens, ds).foundations;
}

/* ------------------------------------------------------------------ applying foundations */

/** Styles merged by id (ours replace an earlier run's); a name the system already uses keeps the system's style. */
function mergeStyles(
  ds: SceneDesignSystem,
  add: NonNullable<SceneDesignSystem["styles"]>,
): NonNullable<SceneDesignSystem["styles"]> {
  const cur = { text: ds.styles?.text ?? [], paint: ds.styles?.paint ?? [], effect: ds.styles?.effect ?? [] };
  const merge = <T extends { id: string; name: string }>(list: T[], extra: T[]): T[] => {
    const out = [...list];
    for (const s of extra) {
      const i = out.findIndex((x) => x.id === s.id);
      if (i >= 0) out[i] = s;
      else if (!out.some((x) => x.name === s.name)) out.push(s);
    }
    return out;
  };
  return {
    text: merge(cur.text, add.text),
    paint: merge(cur.paint, add.paint),
    effect: merge(cur.effect, add.effect),
  };
}

/* ------------------------------------------------------------------ kinds the system has */

const ROLE_WORDS: Array<[RegExp, SceneComponentKind]> = [
  [/^(icon[- ]?button)$/, "icon-button"],
  [/^(button|btn|cta)$/, "button"],
  [/^(icon|glyph|pictogram)$/, "icon"],
  [/^(card|tile)$/, "card"],
  [/^teaser$/, "teaser"],
  [/^(link|anchor)$/, "link"],
  [/^(input|field|textfield)$/, "input"],
  [/^textarea$/, "textarea"],
  [/^(select|dropdown)$/, "select"],
  [/^search$/, "search"],
  [/^(checkbox)$/, "checkbox"],
  [/^radio$/, "radio"],
  [/^(toggle|switch)$/, "toggle"],
  [/^form$/, "form"],
  [/^(tag|chip)$/, "tag"],
  [/^badge$/, "badge"],
  [/^(picture|figure|image|img|photo)$/, "image"],
  [/^avatar$/, "avatar"],
  [/^header$/, "header"],
  [/^footer$/, "footer"],
  [/^(nav|navigation|navbar)$/, "navigation"],
  [/^menu$/, "menu"],
  [/^logo$/, "logo"],
  [/^tabs?$/, "tabs"],
  [/^accordion$/, "accordion"],
  [/^breadcrumbs?$/, "breadcrumb"],
  [/^pagination$/, "pagination"],
  [/^(carousel|slider)$/, "carousel"],
  [/^(quote|blockquote|testimonial)$/, "quote"],
  [/^table$/, "table"],
  [/^(divider|separator|rule)$/, "divider"],
  [/^(modal|dialog)$/, "modal"],
  [/^(tooltip|popover)$/, "tooltip"],
  [/^(toast|snackbar)$/, "toast"],
  [/^(alert|notice|banner)$/, "alert"],
  [/^progress$/, "progress"],
  [/^(stat|kpi|metric)$/, "stat"],
  [/^hero$/, "hero"],
  [/^video$/, "video"],
  [/^(lightbox|gallery viewer)$/, "lightbox"],
  [/^(list|bullet list)$/, "list"],
  [/^(content block|block|section)$/, "section"],
];

/**
 * The kind a component name's head noun (its last word: ChevronRightIcon → icon, WebinarTag → tag) states outright, when
 * that kind sits in another category than `current` (a name that only refines the kind — PlayButton for an icon button —
 * changes nothing). Null: the name says nothing more.
 */
export function headNounKind(
  name: string,
  current: SceneComponentKind | undefined,
): SceneComponentKind | null {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s/_-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w && !/^\d+$/.test(w));
  const head = words[words.length - 1];
  if (!head) return null;
  const hit = ROLE_WORDS.find(([re]) => re.test(head))?.[1];
  if (!hit || hit === current || (current && KIND_CATEGORY[hit] === KIND_CATEGORY[current])) return null;
  // (a badge that links — "LineButton" for a U5 plate — stays a badge)
  if (
    (current === "badge" || current === "tag") &&
    (hit === "button" || hit === "link" || hit === "icon-button")
  )
    return null;
  return hit;
}

/** Kind of a set from its name ("Footer / Link", "Icon / location pin", "Rac Input Wrapper") — head nouns first. */
export function inferKindFromName(def: SceneComponentDef): SceneComponentKind {
  const segs = def.name
    .split("/")
    .map((s) =>
      s
        .trim()
        .replace(/\s+\d+$/, "")
        .toLowerCase(),
    )
    .filter(Boolean);
  const tryWords = (seg: string): SceneComponentKind | null => {
    if (/^list item$/.test(seg) || /\blist item$/.test(seg)) return "list-item";
    if (/\bicon button$/.test(seg)) return "icon-button";
    const words = seg.split(/[\s_-]+/);
    for (let i = words.length - 1; i >= 0; i--)
      for (const [re, k] of ROLE_WORDS) if (re.test(words[i]!)) return k;
    return null;
  };
  const last = segs[segs.length - 1],
    first = segs[0];
  let kind: SceneComponentKind =
    (last ? tryWords(last) : null) ?? (first && first !== last ? tryWords(first) : null) ?? "other";
  if (kind === "button") {
    const main = def.variants[def.defaultVariant] ?? Object.values(def.variants)[0];
    if (main && !textsBelow(main).length) kind = "icon-button";
  }
  return kind;
}

/** The kind a set counts as: its own, else the catalog's classification, else its name. */
/** Kinds a system needs as configurable controls (a style axis), not as the site's one-off looks. */
const CONTROL_KINDS = new Set<SceneComponentKind>([
  "button",
  "icon-button",
  "link",
  "input",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "toggle",
  "search",
  "badge",
  "tag",
  "alert",
  "tabs",
]);

export function kindOfSet(def: SceneComponentDef, ds: SceneDesignSystem): SceneComponentKind {
  // the kind it was given, else what its name says outright ("Footer link"), else what its structure looks like
  if (def.kind) return def.kind;
  const named = inferKindFromName(def);
  return named !== "other" ? named : classifyComponent(def, ds).kind;
}

/* ------------------------------------------------------------------ generation helpers */

interface Gen {
  a: Analysis;
  look: Look;
  t: SceneTokens;
  ds: SceneDesignSystem;
  bodyFamily: string;
  photo: (i: number) => SceneElement["image"];
  /** the set a kind is built from (generated in this run, else the system's own) */
  setOf: (kind: SceneComponentKind) => SceneComponentDef | undefined;
}

type Part = Omit<SceneComponentDef, "id" | "name" | "kind" | "category" | "origin">;

/** Concrete text values of a role (what the text style writes), plus the family when it is not the token font. */
function textValues(g: Gen, role: TypeRole): SceneStyle {
  const t = g.a.type[role];
  const s: SceneStyle = {
    fontSize: t.size,
    fontWeight: t.weight as SceneStyle["fontWeight"],
    lineHeight: t.lh,
  };
  if (t.ls) s.letterSpacing = t.ls;
  if (t.upper) s.uppercase = true;
  if (t.family && t.family !== g.t.fontFamily) s.fontFamily = t.family;
  return s;
}

function txt(
  g: Gen,
  id: string,
  role: TypeRole,
  text: string,
  o: { name?: string; color?: string; style?: SceneStyle; layout?: SceneLayout } = {},
): SceneElement {
  return {
    id,
    type: "text",
    name: o.name ?? id.charAt(0).toUpperCase() + id.slice(1),
    text,
    styleRefs: { text: TEXT_STYLE_IDS[role] },
    style: { ...textValues(g, role), color: o.color ?? "$text", ...o.style },
    ...(o.layout ? { layout: o.layout } : {}),
  };
}
const icon = (
  id: string,
  name: string,
  size: number,
  color: string,
  extra: Partial<SceneElement> = {},
): SceneElement => ({
  id,
  type: "icon",
  name: extra.name ?? "Icon",
  icon: name,
  layout: { width: size, height: size },
  style: { color },
  ...extra,
});
const frame = (
  id: string,
  name: string,
  layout: SceneLayout,
  children: SceneElement[],
  style?: SceneStyle,
  extra: Partial<SceneElement> = {},
): SceneElement => ({ id, type: "frame", name, layout, ...(style ? { style } : {}), children, ...extra });
const elev = (g: Gen, level: 1 | 2 | 3): Pick<SceneElement, "styleRefs"> & { shadows: SceneShadow[] } => {
  const id = EFFECT_STYLE_IDS[`e${level}` as const];
  return { styleRefs: { effect: id }, shadows: g.ds.styles?.effect.find((e) => e.id === id)?.shadows ?? [] };
};
const cardRadius = (g: Gen, max = 999) => Math.min(g.look.card.radius, max);
const boxRadius = (g: Gen) => (g.look.ctrl.pill ? 6 : Math.min(g.look.ctrl.radius, 4));

/** Every combination of the axes' values, keyed like the instances module keys variants. */
function variantsOf(
  axes: Record<string, string[]>,
  build: (v: Record<string, string>) => SceneElement,
): Record<string, SceneElement> {
  let combos: Record<string, string>[] = [{}];
  for (const [axis, values] of Object.entries(axes))
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [axis]: v })));
  const out: Record<string, SceneElement> = {};
  for (const c of combos) out[variantKeyOf(c, axes)] = build(c);
  return out;
}

/** A materialized nested instance of the set of `kind` (props it does not have become an override of its first text). */
const findIcon = (el: SceneElement): SceneElement | undefined =>
  el.type === "icon" && el.icon ? el : el.children?.map(findIcon).find(Boolean);

function nested(
  g: Gen,
  kind: SceneComponentKind,
  id: string,
  o: {
    variant?: Record<string, string>;
    props?: Record<string, string | boolean>;
    root?: SceneElement["layout"];
    glyph?: string;
  } = {},
): SceneElement | null {
  const def = g.setOf(kind);
  if (!def) return null;
  const main = def.variants[pickVariant(def, o.variant)];
  if (!main) return null;
  const known = new Set((def.properties ?? []).map((p) => p.name));
  const props: Record<string, string | boolean> = {};
  const overrides: NonNullable<NonNullable<SceneElement["instance"]>["overrides"]> = {};
  for (const [k, v] of Object.entries(o.props ?? {})) {
    if (known.has(k)) props[k] = v;
    else if (k === "Label" && typeof v === "string") {
      const t = textsBelow(main)[0];
      if (t) overrides[t.id === main.id ? "#root" : t.id] = { text: v };
    }
  }
  if (o.root) overrides["#root"] = { ...(overrides["#root"] ?? {}), layout: o.root };
  if (o.glyph) {
    const ic = findIcon(main);
    if (ic) overrides[ic.id === main.id ? "#root" : ic.id] = { ...(overrides[ic.id] ?? {}), icon: o.glyph };
  }
  const variant = o.variant
    ? Object.fromEntries(
        Object.entries(o.variant).filter(
          ([a]) => def.variantAxes?.[a] ?? Object.keys(def.variants).some((k) => k.includes(`${a}=`)),
        ),
      )
    : undefined;
  const inst: SceneElement = {
    id,
    type: main.type,
    name: def.name,
    instance: {
      componentId: def.id,
      ...(variant && Object.keys(variant).length ? { variant } : {}),
      ...(Object.keys(props).length ? { props } : {}),
      ...(Object.keys(overrides).length ? { overrides } : {}),
    },
  };
  return buildInstance(inst, g.ds);
}
const keep = (xs: Array<SceneElement | null | undefined | false>): SceneElement[] =>
  xs.filter((x): x is SceneElement => !!x);

/* ------------------------------------------------------------------ components */

const SIZES = ["sm", "md", "lg"] as const;
function ctrlSize(g: Gen, size: string) {
  const c = g.look.ctrl;
  const h = size === "sm" ? Math.max(32, c.h - (c.h >= 48 ? 12 : 8)) : size === "lg" ? c.h + 8 : c.h;
  const fs = size === "sm" ? Math.max(12, c.fs - 2) : size === "lg" ? c.fs + 1 : c.fs;
  const pad = Math.round((size === "sm" ? c.padX * 0.75 : size === "lg" ? c.padX * 1.25 : c.padX) / 2) * 2;
  return { h, fs, pad, icon: size === "sm" ? 16 : size === "lg" ? 20 : 18 };
}
function buttonLook(g: Gen, variant: string): { bg: string; fg: string; border?: SceneStyle["border"] } {
  const L = g.look;
  if (variant === "primary") return { bg: "$primary", fg: L.onPrimary };
  if (variant === "secondary")
    return L.secondary === "outline"
      ? { bg: "transparent", fg: L.outlineInk, border: { width: L.outlineW, color: L.outlineColor } }
      : { bg: "$primary/14", fg: L.ink };
  return { bg: "transparent", fg: L.ink === "$primary" ? "$primary" : "$text" };
}

function buttonSet(g: Gen): Part {
  const L = g.look;
  const axes = { variant: ["primary", "secondary", "ghost"], size: [...SIZES] };
  const variants = variantsOf(axes, ({ variant, size }) => {
    const z = ctrlSize(g, size!),
      b = buttonLook(g, variant!);
    const label: SceneElement =
      size === "md"
        ? txt(g, "label", "label", "Jetzt entdecken", {
            name: "Label",
            color: b.fg,
            style: { noWrap: true, lineHeight: 1.2 },
          })
        : {
            id: "label",
            type: "text",
            name: "Label",
            text: "Jetzt entdecken",
            style: { ...textValues(g, "label"), fontSize: z.fs, lineHeight: 1.2, color: b.fg, noWrap: true },
          };
    const ic = icon("icon", "arrow-right", z.icon, b.fg);
    const pad = variant === "ghost" ? Math.max(8, Math.round(z.pad / 2)) : z.pad;
    return {
      id: "button",
      type: "button",
      name: "Button",
      variant: "ghost",
      layout: {
        direction: "row",
        gap: size === "sm" ? 6 : 8,
        align: "center",
        justify: "center",
        width: "hug",
        height: z.h,
        padding: [0, pad],
      },
      style: {
        background: b.bg,
        color: b.fg,
        radius: L.ctrl.radius,
        shadows: [],
        ...(b.border ? { border: b.border } : {}),
      },
      bindings: { "style.radius": VAR.control },
      children: L.ctrl.iconLeading ? [ic, label] : [label, ic],
    };
  });
  return {
    description: `Actions. Primary for the one main action of a view (${L.ctrl.pill ? "pill" : `${L.ctrl.radius} px corners`}, brand fill), secondary for alternatives, ghost for low-emphasis actions next to others. Keep labels short verbs.`,
    variantAxes: axes,
    variants,
    defaultVariant: "variant=primary,size=md",
    properties: [
      { name: "Label", type: "text", default: "Jetzt entdecken", target: "label" },
      { name: "Show icon", type: "boolean", default: true, target: "icon" },
    ],
  };
}

function iconButtonSet(g: Gen): Part {
  const axes = { variant: ["primary", "secondary", "ghost"], size: [...SIZES] };
  const variants = variantsOf(axes, ({ variant, size }) => {
    const z = ctrlSize(g, size!),
      b = buttonLook(g, variant!);
    return {
      id: "button",
      type: "button",
      name: "Icon button",
      variant: "ghost",
      layout: { direction: "row", align: "center", justify: "center", width: z.h, height: z.h, padding: 0 },
      style: {
        background: b.bg,
        color: b.fg,
        radius: g.look.ctrl.radius,
        shadows: [],
        ...(b.border ? { border: b.border } : {}),
      },
      children: [icon("icon", "arrow-right", z.icon + 2, b.fg)],
    };
  });
  return {
    description:
      "Square action with one icon (close, next, play, favourite). Always give it an accessible name in the export.",
    variantAxes: axes,
    variants,
    defaultVariant: "variant=secondary,size=md",
  };
}

function iconSet(_g: Gen): Part {
  const glyphs = [
    "arrow-right",
    "chevron-right",
    "chevron-down",
    "search",
    "x",
    "info",
    "check",
    "plus",
    "menu",
    "user",
    "heart",
    "calendar",
    "download",
    "map-pin",
    "phone",
    "mail",
  ];
  const axes = { glyph: glyphs };
  return {
    description:
      "Line icons (lucide) in the copy colour; 24 px on a 2 px stroke. Swap the glyph via the variant.",
    variantAxes: axes,
    variants: variantsOf(axes, ({ glyph }) => icon("icon", glyph!, 24, "$text", { name: "Icon" })),
    defaultVariant: "glyph=arrow-right",
  };
}

function linkSet(g: Gen): Part {
  const L = g.look;
  const axes = { style: ["inline", "standalone"], state: ["default", "hover"] };
  const variants = variantsOf(axes, ({ style, state }) => {
    const hover = state === "hover";
    if (style === "inline") {
      return txt(g, "label", "body", "Alle Angebote ansehen", {
        name: "Link",
        color: L.link,
        style: { decoration: { line: "underline", thickness: hover ? 2 : 1, offset: 3 } },
      });
    }
    const ic = icon("icon", L.ctrl.iconLeading ? "arrow-right" : "chevron-right", 18, L.link);
    const label = txt(g, "label", "body", "Alle Angebote ansehen", {
      name: "Label",
      color: L.link,
      style: {
        fontWeight: Math.max(600, g.a.type.label.weight) as SceneStyle["fontWeight"],
        noWrap: true,
        ...(hover ? { decoration: { line: "underline", thickness: 1, offset: 3 } } : {}),
      },
    });
    return frame(
      "link",
      "Link",
      { direction: "row", gap: 6, align: "center", width: "hug" },
      L.ctrl.iconLeading ? [ic, label] : [label, ic],
    );
  });
  return {
    description:
      "Navigation inside copy (inline) or after a block (standalone, with arrow). Not for actions — use a button.",
    variantAxes: axes,
    variants,
    defaultVariant: "style=standalone,state=default",
    properties: [{ name: "Label", type: "text", default: "Alle Angebote ansehen", target: "label" }],
  };
}

const TONES = {
  neutral: "$textMuted",
  brand: "$primary",
  info: "$accent",
  success: "$success",
  warning: "$warning",
  error: "$danger",
} as const;

function badgeSet(g: Gen): Part {
  const L = g.look;
  const axes = { tone: ["neutral", "brand", "success", "warning", "error"] };
  const variants = variantsOf(axes, ({ tone }) => {
    const c = TONES[tone as keyof typeof TONES];
    const bg = tone === "neutral" ? "$surfaceAlt" : tone === "brand" ? "$primary" : `${c}/14`;
    const fg =
      tone === "neutral" ? "$text" : tone === "brand" ? L.onPrimary : tone === "warning" ? "$text" : c;
    return frame(
      "badge",
      "Badge",
      { direction: "row", align: "center", gap: 4, padding: [3, 8], width: "hug", height: "hug" },
      [
        txt(g, "label", "caption", "Neu", {
          name: "Label",
          color: fg,
          style: {
            fontWeight: L.small.fw as SceneStyle["fontWeight"],
            lineHeight: 1.3,
            noWrap: true,
            ...(L.small.upper ? { uppercase: true, letterSpacing: 0.04 } : {}),
          },
        }),
      ],
      { background: bg, radius: L.small.radius },
    );
  });
  return {
    description:
      "Short status or category label on cards, rows and tables. Not interactive. One or two words.",
    variantAxes: axes,
    variants,
    defaultVariant: "tone=brand",
    properties: [{ name: "Label", type: "text", default: "Neu", target: "label" }],
  };
}

function tagSet(g: Gen): Part {
  const L = g.look;
  const axes = { state: ["default", "selected"] };
  const variants = variantsOf(axes, ({ state }) => {
    const sel = state === "selected";
    const fg = sel ? L.onPrimary : "$text";
    return frame(
      "tag",
      "Tag",
      { direction: "row", align: "center", gap: 6, padding: [0, 10, 0, 14], height: 32, width: "hug" },
      [
        txt(g, "label", "small", "Pflege", {
          name: "Label",
          color: fg,
          style: {
            noWrap: true,
            lineHeight: 1.2,
            fontWeight: (sel
              ? Math.max(600, g.a.type.small.weight)
              : g.a.type.small.weight) as SceneStyle["fontWeight"],
          },
        }),
        icon("remove", "x", 14, fg, { name: "Remove" }),
      ],
      {
        background: sel ? "$primary" : "$background",
        radius: L.ctrl.pill ? 999 : Math.min(L.ctrl.radius, 6),
        border: { width: 1, color: sel ? "$primary" : L.field.border },
      },
    );
  });
  return {
    description: "Filter chip: toggles a filter or shows a chosen value; the cross removes it.",
    variantAxes: axes,
    variants,
    defaultVariant: "state=default",
    properties: [
      { name: "Label", type: "text", default: "Pflege", target: "label" },
      { name: "Removable", type: "boolean", default: true, target: "remove" },
    ],
  };
}

/** A labelled field: label, control, helper / error line (shared by input, textarea, select). */
function fieldFrame(
  g: Gen,
  name: string,
  state: string,
  control: SceneElement,
  helper: string,
  error: string,
): SceneElement {
  const disabled = state === "disabled";
  return frame(
    "field",
    name,
    { direction: "column", gap: 6, width: "fill" },
    keep([
      txt(
        g,
        "label",
        "small",
        name === "Select" ? "Anliegen" : name === "Textarea" ? "Nachricht" : "E-Mail-Adresse",
        {
          name: "Label",
          style: { fontWeight: Math.max(500, g.a.type.label.weight) as SceneStyle["fontWeight"] },
        },
      ),
      control,
      state === "error"
        ? frame("errorRow", "Error", { direction: "row", gap: 6, align: "center" }, [
            icon("errorIcon", "circle-alert", 16, "$danger"),
            txt(g, "error", "small", error, { name: "Error", color: "$danger" }),
          ])
        : txt(g, "helper", "small", helper, { name: "Helper", color: "$textMuted" }),
    ]),
    disabled ? { opacity: 0.5 } : undefined,
  );
}
const fieldBorder = (g: Gen, state: string): SceneStyle["border"] =>
  state === "focus" || state === "open"
    ? { width: 2, color: g.look.focus }
    : state === "error"
      ? { width: 2, color: "$danger" }
      : { width: g.look.field.borderW, color: g.look.field.border };
const fieldPad = (g: Gen, state: string, x = 14): number =>
  x - (fieldBorder(g, state)!.width - g.look.field.borderW);

function inputSet(g: Gen): Part {
  const F = g.look.field;
  const axes = { state: ["default", "focus", "error", "disabled"] };
  const variants = variantsOf(axes, ({ state }) =>
    fieldFrame(
      g,
      "Input",
      state!,
      {
        id: "control",
        type: "input",
        name: "Control",
        text: "name@beispiel.de",
        layout: { width: "fill", height: F.h, padding: [0, fieldPad(g, state!, 16)] },
        style: {
          ...textValues(g, "body"),
          lineHeight: 1.2,
          color: "$text",
          background: state === "disabled" ? "$surfaceAlt" : F.bg,
          radius: Math.min(F.radius, F.h / 2),
          border: fieldBorder(g, state!),
        },
      },
      "Wir schicken dir eine Bestätigung.",
      "Bitte gib eine gültige E-Mail-Adresse ein.",
    ),
  );
  return {
    description:
      "Single-line text field with label and helper text; focus and error states. Use the error line for validation messages.",
    variantAxes: axes,
    variants,
    defaultVariant: "state=default",
    previewWidths: Object.fromEntries(Object.keys(variants).map((k) => [k, 360])),
    properties: [
      { name: "Label", type: "text", default: "E-Mail-Adresse", target: "label" },
      { name: "Placeholder", type: "text", default: "name@beispiel.de", target: "control" },
      { name: "Helper text", type: "text", default: "Wir schicken dir eine Bestätigung.", target: "helper" },
    ],
  };
}

function textareaSet(g: Gen): Part {
  const F = g.look.field;
  const axes = { state: ["default", "focus", "error", "disabled"] };
  const variants = variantsOf(axes, ({ state }) => {
    const p = fieldPad(g, state!, 14);
    const f = fieldFrame(
      g,
      "Textarea",
      state!,
      frame(
        "control",
        "Control",
        { direction: "column", width: "fill", height: 128, padding: [p - 2, p + 2] },
        [
          txt(g, "placeholder", "body", "Beschreibe dein Anliegen …", {
            name: "Placeholder",
            color: "$textMuted",
          }),
        ],
        {
          background: state === "disabled" ? "$surfaceAlt" : F.bg,
          radius: Math.min(F.radius, 16),
          border: fieldBorder(g, state!),
        },
      ),
      "Maximal 500 Zeichen.",
      "Bitte gib eine Nachricht ein.",
    );
    return f;
  });
  return {
    description: "Multi-line text field for messages and comments.",
    variantAxes: axes,
    variants,
    defaultVariant: "state=default",
    previewWidths: Object.fromEntries(Object.keys(variants).map((k) => [k, 420])),
    properties: [
      { name: "Label", type: "text", default: "Nachricht", target: "label" },
      { name: "Placeholder", type: "text", default: "Beschreibe dein Anliegen …", target: "placeholder" },
    ],
  };
}

function selectSet(g: Gen): Part {
  const F = g.look.field;
  const axes = { state: ["default", "open", "disabled"] };
  const options = ["Allgemeine Anfrage", "Bestellung & Lieferung", "Reklamation"];
  const variants = variantsOf(axes, ({ state }) => {
    const open = state === "open";
    const control = frame(
      "control",
      "Control",
      {
        direction: "row",
        align: "center",
        justify: "between",
        gap: 8,
        width: "fill",
        height: F.h,
        padding: [0, fieldPad(g, state!, 14), 0, fieldPad(g, state!, 16)],
      },
      [
        txt(g, "value", "body", "Allgemeine Anfrage", {
          name: "Value",
          style: { noWrap: true, lineHeight: 1.2 },
        }),
        icon("chevron", open ? "chevron-up" : "chevron-down", 20, "$text"),
      ],
      {
        background: state === "disabled" ? "$surfaceAlt" : F.bg,
        radius: Math.min(F.radius, F.h / 2),
        border: fieldBorder(g, state!),
      },
    );
    const f = fieldFrame(g, "Select", state!, control, "Wähle das passende Thema.", "");
    if (open) {
      const e = elev(g, 2);
      const menu = frame(
        "menu",
        "Menu",
        { direction: "column", gap: 2, padding: 6, width: "fill" },
        options.map((o, i) =>
          frame(
            `opt${i}`,
            "Option",
            { direction: "row", align: "center", justify: "between", padding: [10, 12], width: "fill" },
            keep([
              txt(g, `optLabel${i}`, "body", o, {
                name: "Label",
                style: {
                  lineHeight: 1.3,
                  ...(i === 0
                    ? { fontWeight: Math.max(600, g.a.type.body.weight) as SceneStyle["fontWeight"] }
                    : {}),
                },
              }),
              i === 0 && icon(`check${i}`, "check", 18, g.look.ink),
            ]),
            i === 0 ? { background: "$surfaceAlt", radius: Math.min(g.look.ctrl.radius, 8) } : undefined,
          ),
        ),
        {
          background: "$surface",
          radius: Math.min(cardRadius(g), 12),
          border: { width: 1, color: "$border" },
          shadows: e.shadows,
        },
        { styleRefs: e.styleRefs },
      );
      f.children!.splice(2, 1, menu);
    }
    return f;
  });
  return {
    description: "Choose one option from a list. The open state shows the menu with the selected option.",
    variantAxes: axes,
    variants,
    defaultVariant: "state=default",
    previewWidths: Object.fromEntries(Object.keys(variants).map((k) => [k, 360])),
    properties: [
      { name: "Label", type: "text", default: "Anliegen", target: "label" },
      { name: "Value", type: "text", default: "Allgemeine Anfrage", target: "value" },
    ],
  };
}

function choiceRow(
  g: Gen,
  name: string,
  box: SceneElement,
  label: string,
  desc: string | null,
  disabled: boolean,
): SceneElement {
  return frame(
    "choice",
    name,
    { direction: "row", gap: 12, align: "start", width: "hug" },
    [
      box,
      frame(
        "text",
        "Text",
        { direction: "column", gap: 2, padding: [1, 0, 0, 0] },
        keep([
          txt(g, "label", "body", label, { name: "Label", style: { lineHeight: 1.35 } }),
          !!desc && txt(g, "description", "small", desc, { name: "Description", color: "$textMuted" }),
        ]),
      ),
    ],
    disabled ? { opacity: 0.45 } : undefined,
  );
}

function checkboxSet(g: Gen): Part {
  const axes = { state: ["unchecked", "checked", "disabled"] };
  const variants = variantsOf(axes, ({ state }) =>
    choiceRow(
      g,
      "Checkbox",
      {
        id: "box",
        type: "checkbox",
        name: "Box",
        value: state === "checked",
        layout: { width: 22, height: 22 },
        style: {
          radius: boxRadius(g),
          border: { width: 1.5, color: state === "checked" ? "$primary" : g.look.field.border },
          ...(state === "checked" ? {} : { background: "$background" }),
        },
      },
      "Newsletter abonnieren",
      "Angebote und Neuigkeiten per E-Mail.",
      state === "disabled",
    ),
  );
  return {
    description:
      "Independent yes / no choices, also several in a list. Label on the right; optional description.",
    variantAxes: axes,
    variants,
    defaultVariant: "state=unchecked",
    properties: [
      { name: "Label", type: "text", default: "Newsletter abonnieren", target: "label" },
      {
        name: "Description",
        type: "text",
        default: "Angebote und Neuigkeiten per E-Mail.",
        target: "description",
      },
    ],
  };
}

function radioSet(g: Gen): Part {
  const L = g.look;
  const filled = L.ink !== "$primary";
  const axes = { state: ["unselected", "selected", "disabled"] };
  const variants = variantsOf(axes, ({ state }) => {
    const on = state === "selected";
    const box = frame(
      "box",
      "Circle",
      { direction: "row", align: "center", justify: "center", width: 22, height: 22 },
      on
        ? [
            frame("dot", "Dot", { width: 10, height: 10 }, [], {
              background: filled ? L.onPrimary : "$primary",
              radius: 999,
            }),
          ]
        : [],
      {
        radius: 999,
        background: on && filled ? "$primary" : "$background",
        border: { width: on ? 2 : 1.5, color: on ? "$primary" : L.field.border },
      },
    );
    return choiceRow(g, "Radio", box, "Standardversand", "2–4 Werktage, kostenlos", state === "disabled");
  });
  return {
    description: "One choice out of a few, shown together. Use a select for long lists.",
    variantAxes: axes,
    variants,
    defaultVariant: "state=unselected",
    properties: [
      { name: "Label", type: "text", default: "Standardversand", target: "label" },
      { name: "Description", type: "text", default: "2–4 Werktage, kostenlos", target: "description" },
    ],
  };
}

function toggleSet(g: Gen): Part {
  const axes = { state: ["off", "on", "disabled"] };
  const variants = variantsOf(axes, ({ state }) =>
    frame(
      "toggle",
      "Toggle",
      { direction: "row", gap: 12, align: "center", width: "hug" },
      [
        { id: "switch", type: "toggle", name: "Switch", value: state === "on" },
        txt(g, "label", "body", "Push-Mitteilungen", { name: "Label", style: { lineHeight: 1.3 } }),
      ],
      state === "disabled" ? { opacity: 0.45 } : undefined,
    ),
  );
  return {
    description: "Switches a setting on or off immediately (no save button).",
    variantAxes: axes,
    variants,
    defaultVariant: "state=off",
    properties: [{ name: "Label", type: "text", default: "Push-Mitteilungen", target: "label" }],
  };
}

function searchSet(g: Gen): Part {
  const F = g.look.field;
  const axes = { state: ["default", "focus", "filled"] };
  const r = g.look.ctrl.pill ? 999 : Math.min(F.radius, 12);
  const variants = variantsOf(axes, ({ state }) => {
    const filled = state === "filled";
    const p = fieldPad(g, state === "focus" ? "focus" : "default", 6);
    const btn = nested(g, "icon-button", "submit", {
      variant: { variant: "primary", size: "sm" },
      glyph: "search",
    });
    return frame(
      "search",
      "Search",
      {
        direction: "row",
        align: "center",
        gap: 10,
        width: "fill",
        height: F.h + 4,
        padding: [0, p, 0, p + 10],
      },
      keep([
        icon("lead", "search", 20, "$textMuted"),
        filled
          ? txt(g, "value", "body", "Sonnencreme", {
              name: "Value",
              style: { noWrap: true, lineHeight: 1.2 },
              layout: { grow: 1 },
            })
          : txt(g, "query", "body", "Wonach suchst du?", {
              name: "Placeholder",
              color: "$textMuted",
              style: { noWrap: true, lineHeight: 1.2 },
              layout: { grow: 1 },
            }),
        filled && icon("clear", "x", 18, "$textMuted", { name: "Clear" }),
        btn,
      ]),
      { background: F.bg, radius: r, border: fieldBorder(g, state === "focus" ? "focus" : "default") },
    );
  });
  return {
    description: "Site or list search with submit; the filled state shows the query and a clear button.",
    variantAxes: axes,
    variants,
    defaultVariant: "state=default",
    previewWidths: Object.fromEntries(Object.keys(variants).map((k) => [k, 440])),
    properties: [{ name: "Placeholder", type: "text", default: "Wonach suchst du?", target: "query" }],
  };
}

function formSet(g: Gen): Part {
  const input = (id: string, label: string, ph: string, helper: string) =>
    nested(g, "input", id, {
      variant: { state: "default" },
      props: { Label: label, Placeholder: ph, "Helper text": helper },
    });
  const row = frame(
    "nameRow",
    "Name",
    { direction: "row", gap: 16, width: "fill" },
    keep([
      input("first", "Vorname", "Max", "Pflichtfeld"),
      input("last", "Nachname", "Mustermann", "Pflichtfeld"),
    ]),
  );
  const actions = frame(
    "actions",
    "Actions",
    { direction: "row", gap: 12, align: "center", padding: [8, 0, 0, 0] },
    keep([
      nested(g, "button", "submit", {
        variant: { variant: "primary", size: "md" },
        props: { Label: "Nachricht senden" },
      }),
      nested(g, "button", "cancel", {
        variant: { variant: "ghost", size: "md" },
        props: { Label: "Abbrechen" },
        glyph: "x",
      }),
    ]),
  );
  const e = g.look.card.shadow ? elev(g, 1) : null;
  const root = frame(
    "form",
    "Form",
    { direction: "column", gap: 20, padding: 32, width: "fill" },
    keep([
      frame("head", "Heading", { direction: "column", gap: 6, width: "fill" }, [
        txt(g, "title", "h3", "Kontakt aufnehmen"),
        txt(g, "description", "body", "Wir melden uns innerhalb von zwei Werktagen bei dir.", {
          name: "Description",
          color: "$textMuted",
        }),
      ]),
      row,
      input("email", "E-Mail-Adresse", "name@beispiel.de", "Für unsere Antwort."),
      nested(g, "select", "topic", { variant: { state: "default" } }),
      nested(g, "textarea", "message", { variant: { state: "default" } }),
      nested(g, "checkbox", "consent", {
        variant: { state: "unchecked" },
        props: {
          Label: "Ich akzeptiere die Datenschutzerklärung.",
          Description: "Deine Daten nutzen wir nur für diese Anfrage.",
        },
      }),
      actions,
    ]),
    {
      background: "$surface",
      radius: cardRadius(g, 24),
      ...(e ? { shadows: e.shadows } : { border: { width: 1, color: "$border" } }),
    },
    e ? { styleRefs: e.styleRefs } : {},
  );
  return {
    description:
      "Contact form composed of the system's inputs, select, textarea, checkbox and buttons (nested instances — they follow their mains).",
    variants: { default: root },
    defaultVariant: "default",
    previewWidths: { default: 600 },
    properties: [
      { name: "Title", type: "text", default: "Kontakt aufnehmen", target: "title" },
      {
        name: "Description",
        type: "text",
        default: "Wir melden uns innerhalb von zwei Werktagen bei dir.",
        target: "description",
      },
    ],
  };
}

const ALERT = {
  info: { icon: "info", title: "Hinweis", text: "Am Wochenende kann es zu längeren Wartezeiten kommen." },
  success: { icon: "circle-check", title: "Gespeichert", text: "Deine Änderungen wurden übernommen." },
  warning: { icon: "triangle-alert", title: "Achtung", text: "Dein Abo läuft in 7 Tagen aus." },
  error: { icon: "circle-x", title: "Fehler", text: "Die Zahlung konnte nicht abgeschlossen werden." },
} as const;

function alertSet(g: Gen): Part {
  const axes = { tone: ["info", "success", "warning", "error"] };
  const variants = variantsOf(axes, ({ tone }) => {
    const c = TONES[tone as keyof typeof TONES],
      a = ALERT[tone as keyof typeof ALERT];
    return frame(
      "alert",
      "Alert",
      { direction: "row", gap: 12, align: "start", padding: [16, 16, 16, 18], width: "fill" },
      [
        icon("icon", a.icon, 22, tone === "warning" ? "$text" : c),
        frame("content", "Content", { direction: "column", gap: 2, grow: 1, width: "fill" }, [
          txt(g, "title", "body", a.title, {
            style: {
              fontWeight: Math.max(600, g.a.type.h4.weight) as SceneStyle["fontWeight"],
              lineHeight: 1.35,
            },
          }),
          txt(g, "message", "small", a.text, { name: "Message" }),
        ]),
        icon("close", "x", 18, "$textMuted", { name: "Close" }),
      ],
      {
        background: `${c}/10`,
        radius: cardRadius(g, 12),
        border: { width: 1, color: `${c}/35` },
        borders: { left: { width: 4, color: c } },
      },
    );
  });
  return {
    description:
      "Inline message about the page or a section: info, success, warning, error. Keep the title to a few words.",
    variantAxes: axes,
    variants,
    defaultVariant: "tone=info",
    previewWidths: Object.fromEntries(Object.keys(variants).map((k) => [k, 520])),
    properties: [{ name: "Show close", type: "boolean", default: true, target: "close" }],
  };
}

function toastSet(g: Gen): Part {
  const L = g.look;
  const axes = { tone: ["info", "success", "error"] };
  const msg = {
    info: "Link in die Zwischenablage kopiert.",
    success: "Zum Warenkorb hinzugefügt.",
    error: "Verbindung unterbrochen.",
  } as const;
  const variants = variantsOf(axes, ({ tone }) => {
    const e = elev(g, 3);
    const c = TONES[tone as keyof typeof TONES];
    return frame(
      "toast",
      "Toast",
      { direction: "row", gap: 12, align: "center", padding: [12, 14, 12, 16], width: "hug", minWidth: 320 },
      [
        frame(
          "mark",
          "Status",
          { direction: "row", align: "center", justify: "center", width: 24, height: 24 },
          [icon("icon", tone === "success" ? "check" : tone === "error" ? "x" : "info", 14, "#ffffff")],
          { background: c, radius: 999 },
        ),
        txt(g, "message", "small", msg[tone as keyof typeof msg], {
          name: "Message",
          color: L.onDark,
          layout: { grow: 1 },
        }),
        txt(g, "action", "small", "Rückgängig", {
          name: "Action",
          color: L.onDark,
          style: {
            fontWeight: Math.max(600, g.a.type.label.weight) as SceneStyle["fontWeight"],
            decoration: { line: "underline", offset: 3 },
            noWrap: true,
          },
        }),
        icon("close", "x", 16, `${L.onDark}/70`, { name: "Close" }),
      ],
      { background: L.dark, radius: Math.min(cardRadius(g), 12), shadows: e.shadows },
      { styleRefs: e.styleRefs },
    );
  });
  return {
    description:
      "Short, temporary confirmation at the screen edge; one optional action. Disappears after a few seconds.",
    variantAxes: axes,
    variants,
    defaultVariant: "tone=success",
    properties: [
      { name: "Action", type: "text", default: "Rückgängig", target: "action" },
      { name: "Show close", type: "boolean", default: true, target: "close" },
    ],
  };
}

function modalSet(g: Gen): Part {
  const e = elev(g, 3);
  const close = nested(g, "icon-button", "close", { variant: { variant: "ghost", size: "sm" }, glyph: "x" });
  const root = frame(
    "modal",
    "Modal",
    { direction: "column", width: 520 },
    keep([
      frame(
        "header",
        "Header",
        {
          direction: "row",
          align: "center",
          justify: "between",
          gap: 16,
          padding: [20, 16, 8, 24],
          width: "fill",
        },
        keep([txt(g, "title", "h3", "Abo kündigen?"), close]),
      ),
      frame("body", "Body", { direction: "column", gap: 12, padding: [8, 24, 24, 24], width: "fill" }, [
        txt(
          g,
          "content",
          "body",
          "Dein Abo endet zum Ende des laufenden Monats. Bis dahin kannst du alle Vorteile weiter nutzen.",
          { name: "Content", color: "$textMuted" },
        ),
      ]),
      frame(
        "footer",
        "Footer",
        { direction: "row", justify: "end", gap: 12, padding: [16, 24], width: "fill" },
        keep([
          nested(g, "button", "secondary", {
            variant: { variant: "secondary", size: "md" },
            props: { Label: "Abbrechen" },
            glyph: "x",
          }),
          nested(g, "button", "primary", {
            variant: { variant: "primary", size: "md" },
            props: { Label: "Kündigen" },
          }),
        ]),
        { borders: { top: { width: 1, color: "$border" } } },
      ),
    ]),
    { background: "$surface", radius: cardRadius(g, 16), shadows: e.shadows },
    { styleRefs: e.styleRefs },
  );
  return {
    description:
      "Dialog that interrupts the flow for a decision; title, short text, at most two actions. Opens as an overlay over a dimmed page.",
    variants: { default: root },
    defaultVariant: "default",
    properties: [
      { name: "Title", type: "text", default: "Abo kündigen?", target: "title" },
      {
        name: "Content",
        type: "text",
        default:
          "Dein Abo endet zum Ende des laufenden Monats. Bis dahin kannst du alle Vorteile weiter nutzen.",
        target: "content",
      },
    ],
  };
}

function tooltipSet(g: Gen): Part {
  const L = g.look;
  const axes = { placement: ["top", "bottom"] };
  const variants = variantsOf(axes, ({ placement }) => {
    const bubble = frame(
      "bubble",
      "Bubble",
      { direction: "row", padding: [8, 12], width: "hug" },
      [
        txt(g, "text", "small", "Preise inkl. MwSt.", {
          name: "Text",
          color: L.onDark,
          style: { noWrap: true, lineHeight: 1.3 },
        }),
      ],
      { background: L.dark, radius: Math.min(L.ctrl.radius, 8) },
    );
    const arrow = frame(
      "arrow",
      "Arrow",
      { width: 10, height: 10, rotation: 45, margin: placement === "top" ? [-6, 0, 0, 0] : [0, 0, -6, 0] },
      [],
      { background: L.dark, radius: 1 },
    );
    return frame(
      "tooltip",
      "Tooltip",
      { direction: "column", align: "center", width: "hug" },
      placement === "top" ? [bubble, arrow] : [arrow, bubble],
    );
  });
  return {
    description:
      "Short hint on hover / focus of an element; never essential information. Placement = side of the element it points to from.",
    variantAxes: axes,
    variants,
    defaultVariant: "placement=top",
    properties: [{ name: "Text", type: "text", default: "Preise inkl. MwSt.", target: "text" }],
  };
}

function progressSet(g: Gen): Part {
  const L = g.look;
  const axes = { type: ["linear", "steps"] };
  const variants = variantsOf(axes, ({ type }) => {
    if (type === "linear") {
      return frame("progress", "Progress", { direction: "column", gap: 8, width: "fill" }, [
        frame("row", "Row", { direction: "row", justify: "between", width: "fill" }, [
          txt(g, "label", "small", "Upload läuft …", { name: "Label" }),
          txt(g, "value", "small", "60 %", { name: "Value", color: "$textMuted" }),
        ]),
        {
          id: "bar",
          type: "progress",
          name: "Bar",
          value: 60,
          layout: { width: "fill", height: 8 },
          style: {
            background: "$surfaceAlt",
            color: "$primary",
            radius: L.ctrl.pill ? 999 : Math.min(L.ctrl.radius, 4),
          },
        },
      ]);
    }
    const steps = ["Tarif", "Daten", "Zahlung", "Fertig"];
    const cells: SceneElement[] = [];
    steps.forEach((s, i) => {
      const done = i === 0,
        cur = i === 1;
      if (i)
        cells.push(
          frame(`line${i}`, "Connector", { width: "fill", height: 2, margin: [15, 0, 0, 0] }, [], {
            background: i <= 1 ? "$primary" : "$border",
          }),
        );
      cells.push(
        frame(`step${i}`, "Step", { direction: "column", align: "center", gap: 6, width: 72 }, [
          frame(
            `dot${i}`,
            "Marker",
            { direction: "row", align: "center", justify: "center", width: 32, height: 32 },
            [
              done
                ? icon(`chk${i}`, "check", 16, L.onPrimary)
                : txt(g, `n${i}`, "small", String(i + 1), {
                    name: "Number",
                    color: cur ? "$text" : "$textMuted",
                    style: { fontWeight: 700, lineHeight: 1 },
                  }),
            ],
            {
              radius: 999,
              background: done ? "$primary" : "$background",
              border: { width: 2, color: done || cur ? "$primary" : "$border" },
            },
          ),
          txt(g, `s${i}`, "caption", s, {
            name: "Step label",
            color: cur ? "$text" : "$textMuted",
            style: { textAlign: "center", ...(cur ? { fontWeight: 700 } : {}) },
          }),
        ]),
      );
    });
    return frame("progress", "Progress", { direction: "column", gap: 16, width: "fill" }, [
      txt(g, "stepsLabel", "small", "Schritt 2 von 4", { name: "Label", color: "$textMuted" }),
      frame("track", "Steps", { direction: "row", align: "start", width: "fill" }, cells),
    ]);
  });
  return {
    description: "Progress of a task (linear bar with percentage) or of a multi-step flow (steps).",
    variantAxes: axes,
    variants,
    defaultVariant: "type=linear",
    previewWidths: { "type=linear": 360, "type=steps": 480 },
    properties: [{ name: "Label", type: "text", default: "Upload läuft …", target: "label" }],
  };
}

function tabsSet(g: Gen): Part {
  const L = g.look;
  const labels = ["Übersicht", "Details", "Bewertungen", "Fragen"];
  const axes = { style: ["line", "segmented"] };
  const variants = variantsOf(axes, ({ style }) => {
    const seg = style === "segmented";
    const tabs = labels.map((l, i) => {
      const on = i === 0;
      const e = seg && on ? elev(g, 1) : null;
      return frame(
        `tab${i}`,
        "Tab",
        {
          direction: "row",
          align: "center",
          justify: "center",
          padding: seg ? [8, 16] : [12, 16],
          ...(seg ? {} : { margin: [0, 0, -1, 0] }),
        },
        [
          txt(g, i === 0 ? "active" : `label${i}`, "body", l, {
            name: "Label",
            color: on ? "$text" : "$textMuted",
            style: {
              noWrap: true,
              lineHeight: 1.3,
              ...(on ? { fontWeight: Math.max(600, g.a.type.label.weight) as SceneStyle["fontWeight"] } : {}),
            },
          }),
        ],
        seg
          ? on
            ? {
                background: "$surface",
                radius: L.ctrl.pill ? 999 : Math.min(L.ctrl.radius, 8),
                shadows: e!.shadows,
              }
            : undefined
          : on
            ? { borders: { bottom: { width: 3, color: "$primary" } } }
            : undefined,
        e ? { styleRefs: e.styleRefs } : {},
      );
    });
    return frame(
      "tabs",
      "Tabs",
      seg
        ? { direction: "row", gap: 2, padding: 4, width: "hug" }
        : { direction: "row", gap: 4, width: "fill" },
      tabs,
      seg
        ? { background: "$surfaceAlt", radius: L.ctrl.pill ? 999 : Math.min(L.ctrl.radius + 4, 12) }
        : { borders: { bottom: { width: 1, color: "$border" } } },
    );
  });
  return {
    description:
      "Switch between views of the same content. Line tabs for page sections, segmented for compact toggles between 2–4 views.",
    variantAxes: axes,
    variants,
    defaultVariant: "style=line",
    previewWidths: { "style=line": 520 },
    properties: [{ name: "Active tab", type: "text", default: "Übersicht", target: "active" }],
  };
}

function breadcrumbSet(g: Gen): Part {
  const items = ["Startseite", "Service", "Kontakt"];
  const kids: SceneElement[] = [];
  items.forEach((s, i) => {
    kids.push(
      txt(g, `item${i}`, "small", s, {
        name: "Item",
        color: g.look.link,
        style: { decoration: { line: "underline", offset: 3 }, noWrap: true },
      }),
    );
    kids.push(icon(`sep${i}`, "chevron-right", 14, "$textMuted", { name: "Separator" }));
  });
  kids.push(
    txt(g, "current", "small", "Kontaktformular", {
      name: "Current",
      color: "$textMuted",
      style: { noWrap: true },
    }),
  );
  return {
    description: "Where the page sits in the site hierarchy; the last item is the current page (not a link).",
    variants: {
      default: frame(
        "breadcrumb",
        "Breadcrumb",
        { direction: "row", align: "center", gap: 8, width: "hug" },
        kids,
      ),
    },
    defaultVariant: "default",
    properties: [{ name: "Current page", type: "text", default: "Kontaktformular", target: "current" }],
  };
}

function paginationSet(g: Gen): Part {
  const L = g.look;
  const axes = { type: ["numbered", "simple"] };
  const s = 40,
    r = L.ctrl.pill ? 999 : Math.min(L.ctrl.radius, 8);
  const cell = (id: string, label: string, on: boolean) =>
    frame(
      id,
      "Page",
      { direction: "row", align: "center", justify: "center", width: s, height: s },
      [
        txt(g, `${id}Label`, "body", label, {
          name: "Label",
          color: on ? L.onPrimary : "$text",
          style: { lineHeight: 1, ...(on ? { fontWeight: 700 } : {}) },
        }),
      ],
      on ? { background: "$primary", radius: r } : { radius: r },
    );
  const arrow = (id: string, glyph: string) =>
    frame(
      id,
      "Step",
      { direction: "row", align: "center", justify: "center", width: s, height: s },
      [icon(`${id}Icon`, glyph, 20, "$text")],
      { radius: r, border: { width: 1, color: "$border" } },
    );
  const variants = variantsOf(axes, ({ type }) =>
    type === "numbered"
      ? frame("pagination", "Pagination", { direction: "row", align: "center", gap: 4, width: "hug" }, [
          arrow("prev", "chevron-left"),
          cell("p1", "1", false),
          cell("p2", "2", true),
          cell("p3", "3", false),
          cell("gap", "…", false),
          cell("p12", "12", false),
          arrow("next", "chevron-right"),
        ])
      : frame(
          "pagination",
          "Pagination",
          { direction: "row", align: "center", justify: "between", gap: 24, width: "fill" },
          [
            frame("prev", "Previous", { direction: "row", gap: 6, align: "center" }, [
              icon("prevIcon", "chevron-left", 18, L.link),
              txt(g, "prevLabel", "body", "Zurück", {
                name: "Label",
                color: L.link,
                style: { fontWeight: Math.max(600, g.a.type.label.weight) as SceneStyle["fontWeight"] },
              }),
            ]),
            txt(g, "status", "small", "Seite 2 von 12", { name: "Status", color: "$textMuted" }),
            frame("next", "Next", { direction: "row", gap: 6, align: "center" }, [
              txt(g, "nextLabel", "body", "Weiter", {
                name: "Label",
                color: L.link,
                style: { fontWeight: Math.max(600, g.a.type.label.weight) as SceneStyle["fontWeight"] },
              }),
              icon("nextIcon", "chevron-right", 18, L.link),
            ]),
          ],
        ),
  );
  return {
    description:
      "Move between pages of a long list. Numbered for search results / archives, simple for step-through content.",
    variantAxes: axes,
    variants,
    defaultVariant: "type=numbered",
    previewWidths: { "type=simple": 480 },
  };
}

function accordionSet(g: Gen): Part {
  const axes = { state: ["open", "closed"] };
  const variants = variantsOf(axes, ({ state }) => {
    const open = state === "open";
    return frame(
      "accordion",
      "Accordion",
      { direction: "column", width: "fill" },
      keep([
        frame(
          "header",
          "Header",
          { direction: "row", align: "center", justify: "between", gap: 16, padding: [18, 0], width: "fill" },
          [
            txt(g, "title", "h4", "Wie kann ich mein Abo pausieren?", { name: "Title", layout: { grow: 1 } }),
            icon("chevron", open ? "chevron-up" : "chevron-down", 22, g.look.ink),
          ],
        ),
        open &&
          frame("panel", "Panel", { direction: "column", padding: [0, 40, 20, 0], width: "fill" }, [
            txt(
              g,
              "content",
              "body",
              "Im Kundenkonto unter „Mein Abo“ kannst du dein Abo bis zu drei Monate pausieren. Die Pause beginnt zum nächsten Monatsersten.",
              { name: "Content", color: "$textMuted" },
            ),
          ]),
      ]),
      { borders: { bottom: { width: 1, color: "$border" } } },
    );
  });
  return {
    description:
      "Question / answer or detail sections that expand in place (FAQ). Stack several; keep titles to one line.",
    variantAxes: axes,
    variants,
    defaultVariant: "state=open",
    previewWidths: { "state=open": 560, "state=closed": 560 },
    properties: [
      { name: "Title", type: "text", default: "Wie kann ich mein Abo pausieren?", target: "title" },
      {
        name: "Content",
        type: "text",
        default:
          "Im Kundenkonto unter „Mein Abo“ kannst du dein Abo bis zu drei Monate pausieren. Die Pause beginnt zum nächsten Monatsersten.",
        target: "content",
      },
    ],
  };
}

function cardStyle(g: Gen): { style: SceneStyle; extra: Partial<SceneElement> } {
  const L = g.look;
  const e = L.card.shadow ? elev(g, 1) : null;
  return {
    style: {
      background: L.card.flat ? "$surfaceAlt" : "$surface",
      radius: L.card.radius,
      ...(e ? { shadows: e.shadows } : {}),
      ...(L.card.border ? { border: { width: 1, color: "$border" } } : {}),
    },
    extra: { ...(e ? { styleRefs: e.styleRefs } : {}), bindings: { "style.radius": VAR.card } },
  };
}

function cardSet(g: Gen): Part {
  const L = g.look;
  const axes = { layout: ["vertical", "horizontal"] };
  const cs = cardStyle(g);
  const variants = variantsOf(axes, ({ layout }) => {
    const vertical = layout === "vertical";
    const cta = nested(g, "link", "cta", {
      variant: { style: "standalone", state: "default" },
      props: { Label: "Mehr erfahren" },
    });
    const media: SceneElement = {
      id: "media",
      type: "image",
      name: "Media",
      image: g.photo(0),
      layout: vertical ? { width: "fill", height: 200 } : { width: 240, height: "fill" },
      style: { fit: "cover", radius: 0 },
    };
    return frame(
      "card",
      "Card",
      {
        direction: vertical ? "column" : "row",
        width: "fill",
        clip: true,
        ...(vertical ? {} : { align: "stretch" }),
      },
      [
        media,
        frame(
          "content",
          "Content",
          {
            direction: "column",
            gap: 8,
            padding: L.card.radius >= 16 ? 24 : 20,
            width: "fill",
            ...(vertical ? {} : { grow: 1 }),
          },
          keep([
            txt(g, "eyebrow", "overline", "Ratgeber", { name: "Eyebrow", color: "$textMuted" }),
            txt(g, "title", "h4", "Gut vorbereitet in den Herbst"),
            txt(
              g,
              "text",
              "body",
              "Sieben Tipps, mit denen du entspannt durch die kalte Jahreszeit kommst.",
              { name: "Text", color: "$textMuted", style: { truncate: 3 } },
            ),
            cta && { ...cta, layout: { ...cta.layout, margin: [8, 0, 0, 0] } },
          ]),
        ),
      ],
      cs.style,
      cs.extra,
    );
  });
  return {
    description: `Content teaser in a grid: image, eyebrow, title, short text and a link. ${L.card.shadow ? "Raised (Elevation/1)" : L.card.border ? "Outlined" : "Flat on the tinted surface"} with ${L.card.radius} px corners, like the site's cards.`,
    variantAxes: axes,
    variants,
    defaultVariant: "layout=vertical",
    previewWidths: { "layout=vertical": 360, "layout=horizontal": 600 },
    properties: [
      { name: "Title", type: "text", default: "Gut vorbereitet in den Herbst", target: "title" },
      {
        name: "Text",
        type: "text",
        default: "Sieben Tipps, mit denen du entspannt durch die kalte Jahreszeit kommst.",
        target: "text",
      },
      { name: "Show image", type: "boolean", default: true, target: "media" },
      ...(g.setOf("link")
        ? [{ name: "Action", type: "instance-swap" as const, default: g.setOf("link")!.id, target: "cta" }]
        : []),
    ],
  };
}

function teaserSet(g: Gen): Part {
  const L = g.look;
  const axes = { layout: ["overlay", "split"] };
  const variants = variantsOf(axes, ({ layout }) => {
    const btn = nested(g, "button", "cta", {
      variant: { variant: "primary", size: "md" },
      props: { Label: "Jetzt entdecken" },
    });
    if (layout === "overlay") {
      const ph = g.photo(1);
      return frame(
        "teaser",
        "Teaser",
        { direction: "column", justify: "end", gap: 12, padding: 40, width: "fill", height: 440, clip: true },
        keep([
          txt(g, "eyebrow", "overline", "Neu", { name: "Eyebrow", color: "#ffffff" }),
          txt(g, "title", "h2", "Bereit für den nächsten Ausflug", {
            name: "Title",
            color: "#ffffff",
            style: { textWrap: "balance" },
            layout: { maxWidth: 560 },
          }),
          txt(g, "text", "bodyL", "Alles, was du für unterwegs brauchst — an einem Ort.", {
            name: "Text",
            color: "rgba(255,255,255,0.88)",
            layout: { maxWidth: 520 },
          }),
          btn && { ...btn, layout: { ...btn.layout, margin: [8, 0, 0, 0] } },
        ]),
        {
          background: "$secondary",
          radius: L.card.radius,
          fills: [
            {
              type: "gradient",
              angle: 180,
              stops: [
                { color: "rgba(0,0,0,0)", pos: 0.25 },
                { color: "rgba(0,0,0,0.7)", pos: 1 },
              ],
            },
            ...(ph?.src ? [{ type: "image" as const, src: ph.src }] : []),
          ],
        },
      );
    }
    return frame(
      "teaser",
      "Teaser",
      { direction: "row", width: "fill", align: "stretch", clip: true },
      keep([
        {
          id: "media",
          type: "image",
          name: "Media",
          image: g.photo(1),
          layout: { width: "fill", height: 380 },
          style: { fit: "cover", radius: 0 },
        },
        frame(
          "content",
          "Content",
          { direction: "column", justify: "center", gap: 12, padding: 48, width: "fill" },
          keep([
            txt(g, "eyebrow", "overline", "Neu", { name: "Eyebrow", color: L.ink }),
            txt(g, "title", "h2", "Bereit für den nächsten Ausflug", {
              name: "Title",
              style: { textWrap: "balance" },
            }),
            txt(g, "text", "bodyL", "Alles, was du für unterwegs brauchst — an einem Ort.", {
              name: "Text",
              color: "$textMuted",
            }),
            btn && { ...btn, layout: { ...btn.layout, margin: [8, 0, 0, 0] } },
          ]),
        ),
      ]),
      { background: "$surfaceAlt", radius: L.card.radius },
    );
  });
  return {
    description:
      "Large editorial promotion for one topic: full-bleed image with copy on top, or image beside copy. One per section.",
    variantAxes: axes,
    variants,
    defaultVariant: "layout=overlay",
    previewWidths: { "layout=overlay": 960, "layout=split": 960 },
    properties: [
      { name: "Eyebrow", type: "text", default: "Neu", target: "eyebrow" },
      { name: "Title", type: "text", default: "Bereit für den nächsten Ausflug", target: "title" },
      {
        name: "Text",
        type: "text",
        default: "Alles, was du für unterwegs brauchst — an einem Ort.",
        target: "text",
      },
    ],
  };
}

function listItemSet(g: Gen): Part {
  const L = g.look;
  const axes = { leading: ["none", "icon", "avatar"] };
  const variants = variantsOf(axes, ({ leading }) =>
    frame(
      "item",
      "List item",
      { direction: "row", align: "center", gap: 16, padding: [14, 4], width: "fill" },
      keep([
        leading === "icon" &&
          frame(
            "lead",
            "Leading",
            { direction: "row", align: "center", justify: "center", width: 44, height: 44 },
            [icon("leadIcon", "calendar", 22, L.ink)],
            { background: "$surfaceAlt", radius: L.ctrl.pill ? 999 : Math.min(L.ctrl.radius, 8) },
          ),
        leading === "avatar" && {
          id: "lead",
          type: "avatar",
          name: "Avatar",
          text: "Lena Weber",
          layout: { width: 44, height: 44 },
          style: { background: "$primary" },
        },
        frame("text", "Text", { direction: "column", gap: 2, grow: 1, width: "fill" }, [
          txt(g, "title", "body", "Termin vereinbaren", {
            name: "Title",
            style: {
              fontWeight: Math.max(600, g.a.type.h4.weight) as SceneStyle["fontWeight"],
              lineHeight: 1.35,
            },
          }),
          txt(g, "subtitle", "small", "Online in wenigen Minuten", { name: "Subtitle", color: "$textMuted" }),
        ]),
        icon("chevron", "chevron-right", 20, "$textMuted", { name: "Chevron" }),
      ]),
      { borders: { bottom: { width: 1, color: "$border" } } },
    ),
  );
  return {
    description:
      "Row in a list of links, settings or results: optional leading icon / avatar, title, subtitle, chevron.",
    variantAxes: axes,
    variants,
    defaultVariant: "leading=icon",
    previewWidths: Object.fromEntries(Object.keys(variants).map((k) => [k, 440])),
    properties: [
      { name: "Title", type: "text", default: "Termin vereinbaren", target: "title" },
      { name: "Subtitle", type: "text", default: "Online in wenigen Minuten", target: "subtitle" },
      { name: "Show chevron", type: "boolean", default: true, target: "chevron" },
    ],
  };
}

function carouselSet(g: Gen): Part {
  const L = g.look;
  const titles = ["Unterwegs mit der App", "Angebote für Familien", "Neu in der Stadt"];
  const slides = titles.map((t, i) =>
    frame(`slide${i}`, "Slide", { direction: "column", gap: 12, width: 340, snapAlign: "start" }, [
      {
        id: `img${i}`,
        type: "image",
        name: "Image",
        image: g.photo(i + 2),
        layout: { width: "fill", height: 220 },
        style: { fit: "cover", radius: g.look.imageRadius },
      },
      txt(g, `title${i}`, "h4", t, { name: "Title" }),
    ]),
  );
  const nav = (id: string, glyph: string) =>
    nested(g, "icon-button", id, { variant: { variant: "secondary", size: "sm" }, glyph });
  const dots = frame(
    "dots",
    "Dots",
    { direction: "row", gap: 6, align: "center" },
    [0, 1, 2].map((i) =>
      frame(`dot${i}`, "Dot", { width: i === 0 ? 24 : 8, height: 8 }, [], {
        background: i === 0 ? "$primary" : "$border",
        radius: 999,
      }),
    ),
  );
  const root = frame("carousel", "Carousel", { direction: "column", gap: 20, width: "fill" }, [
    frame(
      "track",
      "Track",
      { direction: "row", gap: 20, width: "fill", scroll: "horizontal", scrollbar: "hidden", snap: true },
      slides,
    ),
    frame(
      "controls",
      "Controls",
      { direction: "row", align: "center", justify: "between", width: "fill" },
      keep([
        dots,
        frame(
          "arrows",
          "Arrows",
          { direction: "row", gap: 8 },
          keep([nav("prev", "chevron-left"), nav("next", "chevron-right")]),
        ),
      ]),
    ),
  ]);
  void L;
  return {
    description:
      "Horizontally scrolling row of slides (snap), with dots and previous / next buttons. Use for 3–8 equal items.",
    variants: { default: root },
    defaultVariant: "default",
    previewWidths: { default: 900 },
  };
}

function tableSet(g: Gen): Part {
  const cols = ["minmax(0, 1.6fr)", "minmax(0, 1fr)", "minmax(0, 1fr)", "minmax(0, 1fr)"];
  const head = ["Bestellung", "Datum", "Betrag", "Status"];
  const rows: Array<[string, string, string, "success" | "warning" | "neutral", string]> = [
    ["#24-10381", "12.10.2026", "49,00 €", "success", "Zugestellt"],
    ["#24-10377", "08.10.2026", "18,90 €", "warning", "Unterwegs"],
    ["#24-10342", "29.09.2026", "86,40 €", "neutral", "Storniert"],
  ];
  const cell = (id: string, s: string, role: TypeRole, color = "$text", bold = false) =>
    txt(g, id, role, s, {
      name: "Cell",
      color,
      style: {
        noWrap: true,
        ...(bold ? { fontWeight: Math.max(600, g.a.type.label.weight) as SceneStyle["fontWeight"] } : {}),
      },
    });
  const root = frame(
    "table",
    "Table",
    { direction: "column", width: "fill", clip: true },
    [
      frame(
        "head",
        "Header row",
        { grid: { columns: cols, columnGap: 16 }, padding: [12, 20], width: "fill", align: "center" },
        head.map((h, i) => cell(`h${i}`, h, "small", "$textMuted", true)),
        { background: "$surfaceAlt" },
      ),
      ...rows.map((r, ri) =>
        frame(
          `row${ri}`,
          "Row",
          { grid: { columns: cols, columnGap: 16 }, padding: [14, 20], width: "fill", align: "center" },
          keep([
            cell(`r${ri}c0`, r[0], "body", "$text", true),
            cell(`r${ri}c1`, r[1], "body", "$textMuted"),
            cell(`r${ri}c2`, r[2], "body"),
            frame(
              `r${ri}c3`,
              "Status",
              { direction: "row" },
              keep([nested(g, "badge", `r${ri}badge`, { variant: { tone: r[3] }, props: { Label: r[4] } })]),
            ),
          ]),
          { borders: { top: { width: 1, color: "$border" } } },
        ),
      ),
    ],
    { background: "$surface", radius: cardRadius(g, 12), border: { width: 1, color: "$border" } },
  );
  return {
    description:
      "Tabular data with a header row; status cells use the badge. For more than ~6 columns on mobile, switch to list items.",
    variants: { default: root },
    defaultVariant: "default",
    previewWidths: { default: 720 },
  };
}

function quoteSet(g: Gen): Part {
  const L = g.look;
  const axes = { style: ["plain", "highlight"] };
  const variants = variantsOf(axes, ({ style }) => {
    const hi = style === "highlight";
    return frame(
      "quote",
      "Quote",
      { direction: "column", gap: 20, width: "fill", ...(hi ? { padding: 40 } : {}) },
      [
        icon("mark", "quote", 36, L.ink, { name: "Quote mark" }),
        txt(
          g,
          "text",
          "h3",
          "„Seit ich die App nutze, plane ich jede Fahrt in Sekunden — und komme entspannter an.“",
          {
            name: "Quote",
            style: { fontWeight: g.a.type.bodyL.weight as SceneStyle["fontWeight"], textWrap: "pretty" },
          },
        ),
        frame("author", "Author", { direction: "row", align: "center", gap: 12 }, [
          {
            id: "avatar",
            type: "avatar",
            name: "Avatar",
            text: "Jana Krüger",
            layout: { width: 44, height: 44 },
            style: { background: "$primary" },
          },
          frame("who", "Who", { direction: "column", gap: 0 }, [
            txt(g, "name", "body", "Jana Krüger", {
              name: "Name",
              style: {
                fontWeight: Math.max(600, g.a.type.h4.weight) as SceneStyle["fontWeight"],
                lineHeight: 1.35,
              },
            }),
            txt(g, "role", "small", "Kundin seit 2019", { name: "Role", color: "$textMuted" }),
          ]),
        ]),
      ],
      hi
        ? {
            background: "$surfaceAlt",
            radius: L.card.radius,
            borders: { left: { width: 4, color: "$primary" } },
          }
        : undefined,
    );
  });
  return {
    description: "Customer or press quote with author. Highlight variant for a single quote in a section.",
    variantAxes: axes,
    variants,
    defaultVariant: "style=plain",
    previewWidths: { "style=plain": 560, "style=highlight": 560 },
    properties: [
      {
        name: "Quote",
        type: "text",
        default: "„Seit ich die App nutze, plane ich jede Fahrt in Sekunden — und komme entspannter an.“",
        target: "text",
      },
      { name: "Author", type: "text", default: "Jana Krüger", target: "name" },
      { name: "Role", type: "text", default: "Kundin seit 2019", target: "role" },
    ],
  };
}

function statSet(g: Gen): Part {
  const axes = { trend: ["up", "down", "neutral"] };
  const variants = variantsOf(axes, ({ trend }) => {
    const c = trend === "up" ? "$success" : trend === "down" ? "$danger" : "$textMuted";
    return frame("stat", "Stat", { direction: "column", gap: 4, width: "hug" }, [
      txt(g, "value", "h1", "1,2 Mio.", { name: "Value", color: g.look.ink, style: { noWrap: true } }),
      txt(g, "label", "body", "Fahrgäste pro Tag", { name: "Label", color: "$textMuted" }),
      frame("trend", "Trend", { direction: "row", gap: 4, align: "center", padding: [4, 0, 0, 0] }, [
        icon(
          "trendIcon",
          trend === "up" ? "trending-up" : trend === "down" ? "trending-down" : "minus",
          16,
          c,
        ),
        txt(
          g,
          "delta",
          "small",
          trend === "up" ? "+12 % zum Vorjahr" : trend === "down" ? "−4 % zum Vorjahr" : "wie im Vorjahr",
          { name: "Delta", color: c, style: { fontWeight: 600 } },
        ),
      ]),
    ]);
  });
  return {
    description: "One key figure with label and change. Place 3–4 in a row.",
    variantAxes: axes,
    variants,
    defaultVariant: "trend=up",
    properties: [
      { name: "Value", type: "text", default: "1,2 Mio.", target: "value" },
      { name: "Label", type: "text", default: "Fahrgäste pro Tag", target: "label" },
      { name: "Show trend", type: "boolean", default: true, target: "trend" },
    ],
  };
}

function imageSet(g: Gen): Part {
  const axes = { ratio: ["16x9", "4x3", "1x1"] };
  const variants = variantsOf(axes, ({ ratio }) => {
    const [w, h] = ratio!.split("x").map(Number) as [number, number];
    return frame("figure", "Image", { direction: "column", gap: 8, width: "fill" }, [
      {
        id: "image",
        type: "image",
        name: "Image",
        image: g.photo(3),
        layout: { width: "fill" },
        style: { aspect: r2(w / h), fit: "cover", radius: g.look.imageRadius },
      },
      frame("captionRow", "Caption", { direction: "row", width: "fill" }, [
        txt(g, "caption", "caption", "Foto: Pressestelle", { name: "Caption text", color: "$textMuted" }),
      ]),
    ]);
  });
  return {
    description: "Picture with optional caption, in the site's image corners. Set alt text on every image.",
    variantAxes: axes,
    variants,
    defaultVariant: "ratio=16x9",
    previewWidths: { "ratio=16x9": 480, "ratio=4x3": 400, "ratio=1x1": 320 },
    properties: [
      { name: "Caption", type: "text", default: "Foto: Pressestelle", target: "caption" },
      { name: "Show caption", type: "boolean", default: true, target: "captionRow" },
    ],
  };
}

function avatarSet(g: Gen): Part {
  const axes = { size: [...SIZES], type: ["initials", "image"] };
  const px = { sm: 32, md: 44, lg: 64 } as Record<string, number>;
  const variants = variantsOf(axes, ({ size, type }) => ({
    id: "avatar",
    type: "avatar",
    name: "Avatar",
    text: "Lena Weber",
    layout: { width: px[size!], height: px[size!] },
    style: { background: type === "image" ? "$surfaceAlt" : "$primary" },
    ...(type === "image" ? { image: { query: "portrait smiling person", alt: "Lena Weber" } } : {}),
  }));
  void g;
  return {
    description: "Person or account: photo, else initials on the brand colour.",
    variantAxes: axes,
    variants,
    defaultVariant: "size=md,type=initials",
    properties: [{ name: "Name", type: "text", default: "Lena Weber", target: "avatar" }],
  };
}

function dividerSet(g: Gen): Part {
  const axes = { style: ["line", "label"] };
  const line = (id: string) => frame(id, "Line", { width: "fill", height: 1 }, [], { background: "$border" });
  const variants = variantsOf(axes, ({ style }) =>
    style === "line"
      ? frame("divider", "Divider", { direction: "row", width: "fill", padding: [8, 0] }, [line("line")])
      : frame(
          "divider",
          "Divider",
          { direction: "row", align: "center", gap: 12, width: "fill", padding: [8, 0] },
          [
            line("lineA"),
            txt(g, "label", "caption", "oder", {
              name: "Label",
              color: "$textMuted",
              style: { noWrap: true },
            }),
            line("lineB"),
          ],
        ),
  );
  return {
    description: 'Separates groups of content; the label variant splits alternatives ("oder").',
    variantAxes: axes,
    variants,
    defaultVariant: "style=line",
    previewWidths: { "style=line": 400, "style=label": 400 },
  };
}

function menuSet(g: Gen): Part {
  const L = g.look;
  const e = elev(g, 2);
  const items: Array<[string, string]> = [
    ["user", "Mein Konto"],
    ["ticket", "Meine Tickets"],
    ["settings", "Einstellungen"],
    ["circle-help", "Hilfe & Kontakt"],
  ];
  const axes = { icons: ["on", "off"] };
  const variants = variantsOf(axes, ({ icons }) => {
    const row = (id: string, glyph: string, label: string, o: { on?: boolean; danger?: boolean } = {}) =>
      frame(
        id,
        "Item",
        { direction: "row", gap: 12, align: "center", padding: [10, 12], width: "fill" },
        keep([
          icons === "on" && icon(`${id}Icon`, glyph, 18, o.danger ? "$danger" : o.on ? L.ink : "$textMuted"),
          txt(g, `${id}Label`, "body", label, {
            name: "Label",
            color: o.danger ? "$danger" : "$text",
            style: {
              noWrap: true,
              lineHeight: 1.35,
              ...(o.on
                ? { fontWeight: Math.max(600, g.a.type.label.weight) as SceneStyle["fontWeight"] }
                : {}),
            },
            layout: { grow: 1 },
          }),
        ]),
        o.on ? { background: "$surfaceAlt", radius: Math.min(L.ctrl.radius, 8) } : undefined,
      );
    return frame(
      "menu",
      "Menu",
      { direction: "column", gap: 2, padding: 6, width: 260 },
      [
        ...items.map(([glyph, label], i) => row(`item${i}`, glyph, label, { on: i === 0 })),
        frame("divider", "Divider", { width: "fill", height: 1, margin: [4, 0] }, [], {
          background: "$border",
        }),
        row("logout", "log-out", "Abmelden", { danger: true }),
      ],
      {
        background: "$surface",
        radius: cardRadius(g, 12),
        border: { width: 1, color: "$border" },
        shadows: e.shadows,
      },
      { styleRefs: e.styleRefs },
    );
  });
  return {
    description:
      "Dropdown with actions or links that opens from a button (account, more actions, sort). Group with dividers; destructive actions last.",
    variantAxes: axes,
    variants,
    defaultVariant: "icons=on",
  };
}

function listSet(g: Gen): Part {
  const L = g.look;
  const lines = [
    "Fahrplanauskunft in Echtzeit",
    "Tickets direkt in der App kaufen",
    "Störungen auf deinen Linien als Push-Nachricht",
  ];
  const axes = { style: ["bullet", "numbered", "check"] };
  const variants = variantsOf(axes, ({ style }) =>
    frame(
      "list",
      "List",
      { direction: "column", gap: 10, width: "fill" },
      lines.map((l, i) => {
        const marker: SceneElement =
          style === "check"
            ? frame(
                `mark${i}`,
                "Marker",
                { direction: "row", align: "center", justify: "center", width: 22, height: 22, minWidth: 22 },
                [icon(`markIcon${i}`, "check", 14, L.onPrimary)],
                { background: "$primary", radius: 999 },
              )
            : style === "numbered"
              ? txt(g, `mark${i}`, "body", `${i + 1}.`, {
                  name: "Marker",
                  color: L.ink,
                  style: {
                    fontWeight: Math.max(600, g.a.type.label.weight) as SceneStyle["fontWeight"],
                    noWrap: true,
                  },
                  layout: { width: 22 },
                })
              : frame(
                  `mark${i}`,
                  "Marker",
                  {
                    direction: "row",
                    align: "center",
                    justify: "center",
                    width: 22,
                    height: 22,
                    minWidth: 22,
                  },
                  [frame(`dot${i}`, "Dot", { width: 7, height: 7 }, [], { background: L.ink, radius: 999 })],
                );
        return frame(`item${i}`, "Item", { direction: "row", gap: 10, align: "start", width: "fill" }, [
          marker,
          txt(g, i === 0 ? "text" : `text${i}`, "body", l, { name: "Text", layout: { grow: 1 } }),
        ]);
      }),
    ),
  );
  return {
    description:
      "Bulleted, numbered or checked list for short points in copy. Check lists for benefits, numbered lists for steps.",
    variantAxes: axes,
    variants,
    defaultVariant: "style=bullet",
    previewWidths: Object.fromEntries(Object.keys(variants).map((k) => [k, 420])),
    properties: [{ name: "First item", type: "text", default: lines[0]!, target: "text" }],
  };
}

function videoSet(g: Gen): Part {
  const L = g.look;
  const axes = { state: ["poster", "playing"] };
  const variants = variantsOf(axes, ({ state }) => {
    const ph = g.photo(4);
    const playing = state === "playing";
    const stage = frame(
      "stage",
      "Player",
      {
        direction: "column",
        justify: playing ? "end" : "center",
        align: playing ? "stretch" : "center",
        width: "fill",
        height: 315,
        clip: true,
        padding: playing ? 16 : 0,
      },
      playing
        ? [
            frame(
              "controls",
              "Controls",
              { direction: "row", gap: 12, align: "center", padding: [10, 14], width: "fill" },
              [
                icon("pause", "pause", 20, "#ffffff", { name: "Pause" }),
                frame(
                  "track",
                  "Progress",
                  { direction: "row", height: 4, width: "fill", grow: 1 },
                  [
                    frame("done", "Played", { width: "fill", height: 4, maxWidth: 220 }, [], {
                      background: "$primary",
                      radius: 999,
                    }),
                  ],
                  { background: "rgba(255,255,255,0.35)", radius: 999 },
                ),
                txt(g, "time", "small", "0:48 / 2:14", {
                  name: "Time",
                  color: "#ffffff",
                  style: { noWrap: true },
                }),
                icon("volume", "volume-2", 20, "#ffffff", { name: "Volume" }),
                icon("fullscreen", "maximize", 20, "#ffffff", { name: "Fullscreen" }),
              ],
              { background: "rgba(0,0,0,0.55)", radius: Math.min(L.ctrl.radius, 10) },
            ),
          ]
        : [
            frame(
              "play",
              "Play button",
              { direction: "row", align: "center", justify: "center", width: 72, height: 72 },
              [icon("playIcon", "play", 30, L.onPrimary)],
              { background: "$primary", radius: 999 },
            ),
          ],
      {
        background: "#000000",
        radius: g.look.imageRadius,
        fills: [
          {
            type: "gradient",
            angle: 180,
            stops: [
              { color: "rgba(0,0,0,0.05)", pos: 0 },
              { color: "rgba(0,0,0,0.45)", pos: 1 },
            ],
          },
          ...(ph?.src ? [{ type: "image" as const, src: ph.src }] : []),
        ],
      },
    );
    return frame("video", "Video", { direction: "column", gap: 10, width: "fill" }, [
      stage,
      frame("meta", "Caption", { direction: "row", gap: 8, align: "center", width: "fill" }, [
        txt(g, "caption", "small", "So funktioniert das Deutschlandticket", {
          name: "Caption text",
          color: "$text",
          style: { fontWeight: Math.max(600, g.a.type.label.weight) as SceneStyle["fontWeight"] },
          layout: { grow: 1 },
        }),
        txt(g, "duration", "caption", "2:14", {
          name: "Duration",
          color: "$textMuted",
          style: { noWrap: true },
        }),
      ]),
    ]);
  });
  return {
    description:
      "Embedded video: a poster image with a play button, then the player's controls. Always give a caption and subtitles.",
    variantAxes: axes,
    variants,
    defaultVariant: "state=poster",
    previewWidths: { "state=poster": 560, "state=playing": 560 },
    properties: [
      { name: "Caption", type: "text", default: "So funktioniert das Deutschlandticket", target: "caption" },
      { name: "Duration", type: "text", default: "2:14", target: "duration" },
    ],
  };
}

function lightboxSet(g: Gen): Part {
  const L = g.look;
  const axes = { thumbnails: ["on", "off"] };
  const nav = (id: string, glyph: string) =>
    nested(g, "icon-button", id, { variant: { variant: "secondary", size: "md" }, glyph });
  const onDark = (s: SceneElement | null) =>
    s && {
      ...s,
      style: {
        ...s.style,
        background: "rgba(255,255,255,0.12)",
        color: "#ffffff",
        border: { width: 0, color: "transparent" },
      },
    };
  const variants = variantsOf(axes, ({ thumbnails }) =>
    frame(
      "lightbox",
      "Lightbox",
      { direction: "column", gap: 16, padding: 24, width: 960 },
      keep([
        frame(
          "top",
          "Top bar",
          { direction: "row", align: "center", justify: "between", width: "fill" },
          keep([
            txt(g, "counter", "small", "3 / 12", {
              name: "Counter",
              color: "rgba(255,255,255,0.8)",
              style: { noWrap: true },
            }),
            onDark(
              nested(g, "icon-button", "close", { variant: { variant: "ghost", size: "md" }, glyph: "x" }),
            ),
          ]),
        ),
        frame(
          "stage",
          "Stage",
          { direction: "row", gap: 16, align: "center", width: "fill" },
          keep([
            onDark(nav("prev", "chevron-left")),
            {
              id: "image",
              type: "image",
              name: "Image",
              image: g.photo(5),
              layout: { width: "fill", height: 460, grow: 1 },
              style: { fit: "contain", radius: Math.min(g.look.imageRadius, 8) },
            },
            onDark(nav("next", "chevron-right")),
          ]),
        ),
        txt(g, "caption", "small", "Neue Straßenbahnen auf der Linie M10 — Foto: Pressestelle", {
          name: "Caption",
          color: "rgba(255,255,255,0.85)",
          style: { textAlign: "center" },
          layout: { width: "fill" },
        }),
        thumbnails === "on" &&
          frame(
            "thumbs",
            "Thumbnails",
            { direction: "row", gap: 8, justify: "center", width: "fill" },
            [0, 1, 2, 3, 4].map((i) => ({
              id: `thumb${i}`,
              type: "image" as const,
              name: "Thumbnail",
              image: g.photo(i + 2),
              layout: { width: 72, height: 48 },
              style: {
                fit: "cover" as const,
                radius: Math.min(L.ctrl.radius, 6),
                opacity: i === 2 ? 1 : 0.55,
                ...(i === 2 ? { border: { width: 2, color: "#ffffff" } } : {}),
              },
            })),
          ),
      ]),
      { background: "rgba(10,10,12,0.94)", radius: cardRadius(g, 16) },
    ),
  );
  return {
    description:
      "Full-screen viewer for images over a dimmed page: previous / next, counter, caption, optional thumbnail strip. Closes with Esc or the close button.",
    variantAxes: axes,
    variants,
    defaultVariant: "thumbnails=on",
    properties: [
      {
        name: "Caption",
        type: "text",
        default: "Neue Straßenbahnen auf der Linie M10 — Foto: Pressestelle",
        target: "caption",
      },
      { name: "Counter", type: "text", default: "3 / 12", target: "counter" },
    ],
  };
}

/** Page blocks built from the system's own parts: text beside an image, a call to action, a feature row, an FAQ. */
function sectionSet(g: Gen): Part {
  const L = g.look;
  const axes = { layout: ["media-text", "text-media", "cta", "features", "faq"] };
  const head = (title: string, text: string, o: { color?: string; muted?: string; center?: boolean } = {}) =>
    frame(
      "head",
      "Heading",
      { direction: "column", gap: 12, width: "fill", ...(o.center ? { align: "center" } : {}) },
      [
        txt(g, "eyebrow", "overline", "Service", { name: "Eyebrow", color: o.color ?? L.ink }),
        txt(g, "title", "h2", title, {
          name: "Title",
          color: o.color ?? "$text",
          style: { textWrap: "balance", ...(o.center ? { textAlign: "center" } : {}) },
          layout: { maxWidth: 720 },
        }),
        txt(g, "text", "bodyL", text, {
          name: "Text",
          color: o.muted ?? "$textMuted",
          style: o.center ? { textAlign: "center" } : {},
          layout: { maxWidth: 640 },
        }),
      ],
    );
  const variants = variantsOf(axes, ({ layout }) => {
    if (layout === "media-text" || layout === "text-media") {
      const media: SceneElement = {
        id: "media",
        type: "image",
        name: "Media",
        image: g.photo(6),
        layout: { width: "fill", height: 400 },
        style: { fit: "cover", radius: g.look.imageRadius },
      };
      const copy = frame(
        "copy",
        "Copy",
        { direction: "column", justify: "center", gap: 24, width: "fill" },
        keep([
          head(
            "Unterwegs mit gutem Gefühl",
            "Alle Verbindungen, Tickets und Störungsmeldungen an einem Ort — für Bus, Bahn und Fähre.",
          ),
          nested(g, "list", "points", { variant: { style: "check" } }),
          nested(g, "button", "cta", {
            variant: { variant: "primary", size: "md" },
            props: { Label: "Mehr erfahren" },
          }),
        ]),
      );
      return frame(
        "section",
        "Content block",
        { direction: "row", gap: 64, align: "center", padding: [64, 48], width: "fill" },
        layout === "media-text" ? [media, copy] : [copy, media],
        { background: "$background" },
      );
    }
    if (layout === "cta") {
      return frame(
        "section",
        "Content block",
        { direction: "row", gap: 32, align: "center", justify: "between", padding: [56, 48], width: "fill" },
        keep([
          frame("copy", "Copy", { direction: "column", gap: 8, width: "fill", grow: 1 }, [
            txt(g, "title", "h2", "Bereit für die nächste Fahrt?", {
              name: "Title",
              color: L.onPrimary,
              style: { textWrap: "balance" },
            }),
            txt(g, "text", "bodyL", "Lade die App und kauf dein Ticket in weniger als einer Minute.", {
              name: "Text",
              color: L.onPrimary,
            }),
          ]),
          frame(
            "actions",
            "Actions",
            { direction: "row", gap: 12, align: "center", width: "hug" },
            keep([
              nested(g, "button", "primary", {
                variant: { variant: "secondary", size: "lg" },
                props: { Label: "App laden" },
              }),
            ]),
          ),
        ]),
        { background: "$primary", radius: L.card.radius },
      );
    }
    if (layout === "features") {
      const feats: Array<[string, string, string]> = [
        ["clock", "Immer pünktlich informiert", "Abfahrten in Echtzeit für jede Haltestelle."],
        ["ticket", "Tickets in Sekunden", "Bezahlen mit Karte, PayPal oder Apple Pay."],
        ["accessibility", "Barrierefrei unterwegs", "Aufzüge und Rampen auf deiner Route."],
      ];
      return frame(
        "section",
        "Content block",
        { direction: "column", gap: 40, padding: [64, 48], width: "fill" },
        [
          head("Alles für deinen Weg", "Drei Dinge, die die Fahrt einfacher machen.", { center: true }),
          frame(
            "grid",
            "Features",
            { direction: "row", gap: 24, width: "fill", align: "start" },
            feats.map(([glyph, t, s], i) =>
              frame(
                `feat${i}`,
                "Feature",
                { direction: "column", gap: 12, width: "fill", padding: 24 },
                [
                  frame(
                    `featIcon${i}`,
                    "Icon",
                    { direction: "row", align: "center", justify: "center", width: 48, height: 48 },
                    [icon(`featGlyph${i}`, glyph, 24, L.ink)],
                    { background: "$primary/14", radius: L.ctrl.pill ? 999 : Math.min(L.ctrl.radius, 12) },
                  ),
                  txt(g, `featTitle${i}`, "h4", t, { name: "Title" }),
                  txt(g, `featText${i}`, "body", s, { name: "Text", color: "$textMuted" }),
                ],
                cardStyle(g).style,
              ),
            ),
          ),
        ],
        { background: "$surfaceAlt" },
      );
    }
    const qs = [
      "Wie kann ich mein Abo pausieren?",
      "Wo bekomme ich ein Ersatzticket?",
      "Gilt mein Ticket auch im Regionalverkehr?",
    ];
    return frame(
      "section",
      "Content block",
      { direction: "row", gap: 64, align: "start", padding: [64, 48], width: "fill" },
      keep([
        frame("intro", "Intro", { direction: "column", gap: 16, width: 360, minWidth: 360 }, [
          head("Häufige Fragen", "Nicht dabei? Unser Kundenservice hilft dir weiter."),
        ]),
        frame(
          "items",
          "Questions",
          { direction: "column", width: "fill", grow: 1 },
          keep(
            qs.map((q, i) =>
              nested(g, "accordion", `q${i}`, {
                variant: { state: i === 0 ? "open" : "closed" },
                props: { Title: q },
              }),
            ),
          ),
        ),
      ]),
      { background: "$background" },
    );
  });
  return {
    description:
      "Page blocks made of the system's parts: image and copy side by side (either order), a call-to-action band, a row of three features, an FAQ with accordions. Stack them to compose pages.",
    variantAxes: axes,
    variants,
    defaultVariant: "layout=media-text",
    previewWidths: Object.fromEntries(Object.keys(variants).map((k) => [k, 1200])),
    properties: [{ name: "Title", type: "text", default: "Unterwegs mit gutem Gefühl", target: "title" }],
  };
}

/** Generators in dependency order (a form nests inputs and buttons, a card a link…). */
const GENERATORS: Array<[SceneComponentKind, (g: Gen) => Part]> = [
  ["icon", iconSet],
  ["button", buttonSet],
  ["icon-button", iconButtonSet],
  ["link", linkSet],
  ["badge", badgeSet],
  ["tag", tagSet],
  ["input", inputSet],
  ["textarea", textareaSet],
  ["select", selectSet],
  ["checkbox", checkboxSet],
  ["radio", radioSet],
  ["toggle", toggleSet],
  ["search", searchSet],
  ["form", formSet],
  ["alert", alertSet],
  ["toast", toastSet],
  ["modal", modalSet],
  ["tooltip", tooltipSet],
  ["progress", progressSet],
  ["tabs", tabsSet],
  ["breadcrumb", breadcrumbSet],
  ["pagination", paginationSet],
  ["accordion", accordionSet],
  ["card", cardSet],
  ["teaser", teaserSet],
  ["list-item", listItemSet],
  ["carousel", carouselSet],
  ["table", tableSet],
  ["quote", quoteSet],
  ["stat", statSet],
  ["image", imageSet],
  ["avatar", avatarSet],
  ["divider", dividerSet],
  ["menu", menuSet],
  ["list", listSet],
  ["video", videoSet],
  ["lightbox", lightboxSet],
  ["section", sectionSet],
];
/** Kinds this module can generate. */
export const GENERATED_KINDS: readonly SceneComponentKind[] = GENERATORS.map(([k]) => k);

/* ------------------------------------------------------------------ completion */

/**
 * Kinds a site's own sets only stand in for when they are systemic (a style axis to choose from, or made by hand): the
 * controls, and the generic blocks a site shows as one-offs — its page sections, mega-menu panels, nav lists. The system
 * still gets its Content block, dropdown Menu and List.
 */
const SYSTEMIC_KINDS = new Set<SceneComponentKind>([...CONTROL_KINDS, "section", "menu", "list"]);
const NON_STYLE_AXES = new Set(["breakpoint", "size", "state"]);
/** axis values that only name a colour (extract.ts toneWord: hues, light / mid / dark shades) */
const COLOUR_WORDS =
  /^((light|mid|dark)-)?(red|orange|yellow|lime|green|teal|cyan|sky|blue|violet|purple|pink|light|grey|gray|dark|white|black|outline)$/;

/** Names of generated sets whose kind label alone would be vague. */
const GENERATED_NAMES: Partial<Record<SceneComponentKind, string>> = {
  menu: "Dropdown menu",
  section: "Content block",
};

/** The design system with the brand's foundations applied and every missing essential component generated. */
export function completeDesignSystem(
  ds: SceneDesignSystem,
  screens: SceneScreen[],
  o: CompletionOptions = {},
): CompletionResult {
  const a = analyse(screens, ds);
  const foundations = a.foundations;
  const tokens: SceneTokens =
    o.applyTokens === false
      ? { ...DEFAULT_TOKENS, ...ds.tokens }
      : ({ ...DEFAULT_TOKENS, ...ds.tokens, ...foundations.tokens } as SceneTokens);
  let work: SceneDesignSystem = {
    ...ds,
    tokens,
    styles: mergeStyles(ds, foundations.styles),
    variables: [
      ...(ds.variables ?? []).filter((c) => c.id !== BRAND_COLLECTION_ID),
      ...(foundations.variables ?? []),
    ],
  };
  // the full set: every essential a system has, whether the site shows it or not (a table, a lightbox, a quote)
  const considered = new Set<string>(
    (o.kinds ?? ESSENTIAL_KINDS).filter((k) => !SITE_KINDS.includes(k as SceneComponentKind)),
  );
  const forced = new Set<string>(o.force === true ? [...considered] : Array.isArray(o.force) ? o.force : []);
  // a control kind (button, input, tag…) counts as present only as a real system component: one with a style axis to
  // choose from (variant=primary|secondary…), or made by hand / generated. The site's single looks ("Button / Outline
  // light") stay as they are, and the system still gets its brand Button that composed parts (the form) can use
  // (breakpoint, size, state, or colour looks alone — "tone=yellow|light" — are no style to choose from: the brand's
  // Button with primary / secondary / ghost is still made)
  const systemic = (d: SceneComponentDef) =>
    d.origin !== "extracted" ||
    Object.entries(axesOf(d)).some(
      ([k, v]) => !NON_STYLE_AXES.has(k) && !v.every((x) => COLOUR_WORDS.test(x)),
    );
  const present = new Set(
    (work.componentSets ?? [])
      .filter((d) => !SYSTEMIC_KINDS.has(kindOfSet(d, work)) || systemic(d))
      .map((d) => kindOfSet(d, work)),
  );
  const generatedNow = new Map<SceneComponentKind, SceneComponentDef>();
  const usePhotos = o.sitePhotos !== false && a.photos.length > 0;
  const queries = [
    "city street",
    "people outdoors",
    "landscape travel",
    "lifestyle",
    "architecture",
    "nature",
  ];
  const g: Gen = {
    a,
    look: a.look,
    t: tokens,
    ds: work,
    bodyFamily: tokens.fontFamily,
    photo: (i) =>
      usePhotos
        ? { src: a.photos[i % a.photos.length]!.src, alt: a.photos[i % a.photos.length]!.alt ?? "" }
        : { query: queries[i % queries.length], alt: "" },
    setOf: (kind) =>
      generatedNow.get(kind) ??
      (work.componentSets ?? []).find(
        (d) => kindOfSet(d, work) === kind && (!SYSTEMIC_KINDS.has(kind) || systemic(d)),
      ),
  };
  const added: string[] = [];
  const taken = new Set((work.componentSets ?? []).map((d) => d.id));
  const names = new Set((work.componentSets ?? []).map((d) => d.name));
  for (const [kind, gen] of GENERATORS) {
    if (!considered.has(kind) || (present.has(kind) && !forced.has(kind))) continue;
    g.ds = work;
    const part = gen(g);
    let id = o.newId?.() ?? `gen-${kind}`;
    for (let i = 2; taken.has(id); i++) id = `gen-${kind}-${i}`;
    // a site set may already hold the plain name ("Badge"): the system's generic one is the "Base badge"
    const label = GENERATED_NAMES[kind] ?? KIND_LABELS[kind];
    let name = names.has(label) ? `Base ${label.toLowerCase()}` : label;
    for (let i = 2; names.has(name); i++) name = `Base ${label.toLowerCase()} ${i}`;
    taken.add(id);
    names.add(name);
    const def: SceneComponentDef = {
      id,
      name,
      kind,
      category: KIND_CATEGORY[kind],
      origin: "generated",
      ...part,
    };
    work = { ...work, componentSets: [...(work.componentSets ?? []), def] };
    generatedNow.set(kind, def);
    added.push(id);
  }
  return { ds: work, added, foundations };
}

/* ------------------------------------------------------------------ specimen */

/** A web screen showing the system's foundations: colours, type scale, radii, elevations, spacing. */
export function foundationsScreen(ds: SceneDesignSystem, width = 1280): SceneScreen {
  const t = { ...DEFAULT_TOKENS, ...ds.tokens };
  const label = (id: string, s: string, o: SceneStyle = {}): SceneElement => ({
    id,
    type: "text",
    text: s,
    style: { fontSize: 12, color: "$textMuted", lineHeight: 1.4, ...o },
  });
  const heading = (id: string, s: string): SceneElement => ({
    id,
    type: "text",
    text: s,
    style: { fontSize: 13, fontWeight: 700, uppercase: true, letterSpacing: 0.08, color: "$text" },
  });
  const swatches = (
    [
      "primary",
      "secondary",
      "accent",
      "background",
      "surface",
      "surfaceAlt",
      "text",
      "textMuted",
      "border",
      "success",
      "warning",
      "danger",
    ] as const
  ).map((k) =>
    frame(`sw-${k}`, k, { direction: "column", gap: 8, width: 132 }, [
      frame(`chip-${k}`, "Chip", { width: 132, height: 80 }, [], {
        background: `$${k}`,
        radius: 10,
        border: { width: 1, color: "rgba(0,0,0,0.08)" },
      }),
      label(`swn-${k}`, k, { fontWeight: 600, color: "$text" }),
      label(`swv-${k}`, String(t[k] ?? "")),
    ]),
  );
  const styles = ds.styles ?? { text: [], paint: [], effect: [] };
  const type = styles.text
    .filter((s) => s.id.startsWith("bk-text-"))
    .map((s) =>
      frame(
        `ty-${s.id}`,
        s.name,
        { direction: "row", gap: 24, align: "baseline", width: "fill", padding: [10, 0] },
        [
          label(
            `tyn-${s.id}`,
            `${s.name}\n${s.fontFamily ?? t.fontFamily} · ${s.fontSize}/${s.fontWeight} · ${s.lineHeight ?? ""}${s.uppercase ? " · UPPER" : ""}`,
          ),
          {
            id: `tys-${s.id}`,
            type: "text",
            text:
              s.fontSize >= 28
                ? "Mobilität für alle"
                : "Die schnellste Verbindung durch die Stadt — jeden Tag.",
            styleRefs: { text: s.id },
            style: {
              fontSize: s.fontSize,
              fontWeight: s.fontWeight as SceneStyle["fontWeight"],
              lineHeight: s.lineHeight,
              letterSpacing: s.letterSpacing,
              uppercase: s.uppercase,
              ...(s.fontFamily && s.fontFamily !== t.fontFamily ? { fontFamily: s.fontFamily } : {}),
              color: "$text",
              noWrap: true,
            },
            layout: { grow: 1 },
          },
        ],
        { borders: { bottom: { width: 1, color: "$border" } } },
      ),
    );
  for (const f of type) f.children![0]!.layout = { width: 260 };
  const coll = ds.variables?.find((c) => c.id === BRAND_COLLECTION_ID);
  const v = (name: string) => Number(coll?.variables.find((x) => x.name === name)?.values[BRAND_MODE] ?? 0);
  const radii = [
    ["control", v("radius/control")],
    ["card", v("radius/card")],
    ["image", v("radius/image")],
  ].map(([n, r]) =>
    frame(`rad-${n}`, String(n), { direction: "column", gap: 8, align: "center" }, [
      frame(`radb-${n}`, "Box", { width: 96, height: 64 }, [], {
        background: "$surfaceAlt",
        border: { width: 1.5, color: "$primary" },
        radius: Math.min(Number(r), 32),
      }),
      label(`radl-${n}`, `${n} · ${Number(r) >= 999 ? "pill" : `${r}px`}`),
    ]),
  );
  const elevs = styles.effect
    .filter((e) => e.id.startsWith("bk-"))
    .map((e) =>
      frame(`el-${e.id}`, e.name, { direction: "column", gap: 10, align: "center" }, [
        frame(`elb-${e.id}`, "Box", { width: 120, height: 72 }, [], {
          background: "$surface",
          radius: 10,
          shadows: e.shadows,
        }),
        label(`ell-${e.id}`, e.name),
      ]),
    );
  const spaces = (coll?.variables ?? [])
    .filter((x) => x.name.startsWith("space/"))
    .map((x) =>
      frame(`sp-${x.id}`, x.name, { direction: "column", gap: 6, align: "center" }, [
        frame(`spb-${x.id}`, "Bar", { width: Number(x.values[BRAND_MODE]), height: 24 }, [], {
          background: "$primary",
          radius: 2,
        }),
        label(`spl-${x.id}`, `${x.name.slice(6)} ${x.values[BRAND_MODE]}`),
      ]),
    );
  const section = (id: string, title: string, body: SceneElement): SceneElement =>
    frame(id, title, { direction: "column", gap: 16, width: "fill" }, [heading(`${id}-h`, title), body]);
  const root = frame(
    "root",
    "Foundations",
    { direction: "column", gap: 0, width: "fill", height: "fill" },
    [
      frame(
        "content",
        "content",
        { direction: "column", gap: 40, padding: 48, width: "fill" },
        [
          {
            id: "title",
            type: "text",
            text: `${ds.name} — Foundations`,
            style: { fontSize: 32, fontWeight: 700, color: "$text" },
          },
          section(
            "colors",
            "Colours",
            frame("sw", "Swatches", { direction: "row", wrap: true, gap: 16, width: "fill" }, swatches),
          ),
          section("type", "Type scale", frame("ty", "Scale", { direction: "column", width: "fill" }, type)),
          frame("misc", "Misc", { direction: "row", gap: 64, width: "fill", align: "start" }, [
            section("radii", "Radii", frame("rad", "Radii", { direction: "row", gap: 24 }, radii)),
            section(
              "elev",
              "Elevation",
              frame("el", "Elevations", { direction: "row", gap: 32, padding: [8, 8, 24, 8] }, elevs),
            ),
          ]),
          section(
            "space",
            "Spacing",
            frame("sp", "Spacing", { direction: "row", gap: 24, align: "end" }, spaces),
          ),
        ],
        { background: "$background" },
      ),
    ],
    { background: "$background" },
  );
  return {
    version: 1,
    id: "foundations",
    name: "Foundations",
    platform: "web",
    width,
    height: 2400,
    tokens: t,
    root,
  };
}

export type { SceneComponentDef };
