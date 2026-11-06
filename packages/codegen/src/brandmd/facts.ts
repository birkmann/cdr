// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Brand guide (DESIGN.md) — the measured facts behind a brand's DESIGN.md (design-md--generator/PLAN.md §6.2), written
// as brand.json. Input: the completed design system and the captured screens (each width of each page; `screen.capture`
// holds the importer's BrandCapture — states, sections, grids, media queries, images, custom properties — and is missing
// on older documents, which then degrade to what the DOM trees show and say so in `gaps`).
//
// How it reads the site: every page's desktop screen is walked once with the colour each layer sits on (copy judged
// against its real ground, as brandKit does), the element kinds around it (heading tags, header / footer / button,
// the component set an instance belongs to) and its box. Colours are clustered at ΔE2000 < 2 (the most used hex
// stays) and named by role in naming.ts; `primary` is the fill of the captured CTA controls counted across pages (never
// by painted area), its active / hover / disabled colours come from the captured states. Type runs are clustered by
// (family, size, weight, line height, tracking, transform) weighted by characters; radii, spacing, section rhythm,
// grids per width, breakpoints (the most used @media widths, with what changes between the captured widths), shadows,
// the band sequence, component keys and props as token refs, images by role and the contrasts to the example corpus
// (peers.json) follow. Every value is `site` when measured and `derived` otherwise. Pure.
import type {
  SceneDesignSystem,
  SceneElement,
  SceneScreen,
  SceneShadow,
  SceneTokens,
} from "@harness/protocol";
import { concreteColor, resolveTokens } from "@harness/scene";
import { fallbackStackFor, familyList } from "@harness/scene";
import { TEXT_STYLE_IDS, brandFoundations, kindOfSet, scanScreens, type TypeRole } from "@harness/extract";
import { BREAKPOINT_AXIS } from "@harness/extract";
import { axesOf, parseVariantKey } from "@harness/extract";
import peers from "./peers.js";
import type {
  BrandCapture,
  BrandFacts,
  BreakpointFact,
  CapturedControl,
  ColorFact,
  ComponentFact,
  FontFact,
  PeerBrand,
  ScaleStep,
  StateStyle,
  TypeFact,
  VisionNotes,
} from "@harness/protocol";
import {
  PILL,
  alphaOf,
  componentBase,
  contrast,
  groupOfKind,
  isChromatic,
  isDark,
  keyNamer,
  nameColors,
  nameRadii,
  nameSpacing,
  nameTypes,
  hueName,
  oneToken,
  sameColor,
  toHex,
  variantSuffix,
  type ColorHints,
  type ColorUse,
  type RadiusUse,
  type TypeCluster,
} from "./naming.js";

export interface BrandFactsInput {
  ds: SceneDesignSystem;
  screens: SceneScreen[];
  url?: string;
  name?: string;
  capturedAt?: string;
  vision?: VisionNotes;
}

/* ------------------------------------------------------------------ small helpers */

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const median = (xs: number[], d = 0) => {
  if (!xs.length) return d;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
function mode<T>(xs: T[], weight: (x: T) => number = () => 1): T | undefined {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + weight(x));
  let best: T | undefined,
    n = -Infinity;
  for (const [k, v] of m)
    if (v > n) {
      n = v;
      best = k;
    }
  return best;
}
/** a measured value in the middle (upper median: never an average of two values the site does not use) */
const middle = (xs: number[], d: number) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]! : d);
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const clean = (f: string) => f.replace(/["']/g, "").trim();
const isIconFont = (f: string) => /icon|symbol|awesome|glyph|material/i.test(f);
const GENERIC_FAMILY =
  /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|inherit|initial)$/i;
const isMono = (family: string) =>
  /mono|code|courier|consolas|menlo/i.test(family) || fallbackStackFor(family).includes("monospace");
const padOf = (p: unknown): [number, number, number, number] =>
  typeof p === "number"
    ? [p, p, p, p]
    : Array.isArray(p)
      ? p.length === 2
        ? [p[0], p[1], p[0], p[1]]
        : [p[0], p[1], p[2], p[3]]
      : [0, 0, 0, 0];
const originOf = (u: string | undefined) => {
  if (!u) return undefined;
  try {
    return new URL(/^https?:/.test(u) ? u : `https://${u}`).origin;
  } catch {
    return undefined;
  }
};
const isOverlay = (s: SceneScreen) => typeof s.root.meta?.overlayOf === "string";

/* ------------------------------------------------------------------ walking a screen */

interface Run {
  text: string;
  family: string;
  stack: string;
  size: number;
  weight: number;
  lh: number;
  ls: number;
  transform?: TypeFact["textTransform"];
  color: string;
  bg: string;
  uses: string[];
}
interface Box {
  kind?: string;
  setId?: string;
  bg?: string;
  under: string;
  w: number;
  h: number;
  radius: number;
  border?: { color: string; width: number };
  shadows: SceneShadow[];
  gradient?: { css: string; stops: string[]; area: number };
  image: boolean;
  pad: [number, number, number, number];
  maxWidth?: number;
  band: boolean;
  card: boolean;
  control: boolean;
  depth: number;
}
interface InstanceSeen {
  count: number;
  under: string;
  w: number;
  h: number;
  sticky: boolean;
}
interface Walked {
  runs: Run[];
  boxes: Box[];
  inst: Map<string, InstanceSeen>;
  pageBg: string;
}

const KIND_USES: Record<string, string> = {
  header: "nav",
  navigation: "nav",
  menu: "nav",
  footer: "footer",
  button: "button",
  "icon-button": "button",
  hero: "hero",
  card: "card",
  teaser: "card",
  "list-item": "card",
  link: "link",
  tabs: "tab",
  tag: "tag",
  badge: "tag",
};
const TAG_USES: Record<string, string[]> = {
  header: ["nav"],
  nav: ["nav"],
  footer: ["footer"],
  button: ["button"],
  a: ["link"],
  h1: ["h1", "heading"],
  h2: ["h2", "heading"],
  h3: ["h3", "heading"],
  h4: ["h4", "heading"],
  h5: ["h5", "heading"],
  h6: ["h6", "heading"],
};

function shadowCss(list: SceneShadow[]): string {
  return list
    .map(
      (s) =>
        `${s.inset ? "inset " : ""}${r1(s.x)}px ${r1(s.y)}px ${r1(s.blur)}px${num(s.spread) ? ` ${r1(num(s.spread))}px` : ""} ${s.color}`,
    )
    .join(", ");
}

function walkScreen(screen: SceneScreen, tokens: SceneTokens, setKind: Map<string, string>): Walked {
  const out: Walked = { runs: [], boxes: [], inst: new Map(), pageBg: "#ffffff" };
  const col = (v: string | undefined, under: string) =>
    v ? toHex(concreteColor(v, tokens, ""), under) : null;
  const W = screen.width;
  out.pageBg =
    col(screen.root.style?.background, "#ffffff") ??
    col(screen.tokens?.background ?? tokens.background, "#ffffff") ??
    "#ffffff";
  const walk = (el: SceneElement, under: string, pw: number, uses: string[], depth: number) => {
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
    const kind = el.instance ? setKind.get(el.instance.componentId) : undefined;
    const tag = typeof el.meta?.tag === "string" ? el.meta.tag : "";
    const here = uniq([
      ...uses,
      ...(TAG_USES[tag] ?? []),
      ...(el.type === "button" ? ["button"] : []),
      ...(kind && KIND_USES[kind] ? [KIND_USES[kind]!] : []),
    ]);
    const solid = st.fills?.find((f) => f.type === "solid") as { color: string } | undefined;
    const rawBg = st.background && st.background !== "transparent" ? st.background : solid?.color;
    const bgC = rawBg ? concreteColor(rawBg, tokens, "") : "";
    const opaque = !!bgC && alphaOf(bgC) >= 0.5;
    const ground = opaque ? (toHex(bgC, under) ?? under) : under;
    const radius = Array.isArray(st.radius) ? Math.max(...st.radius) : num(st.radius);
    const sides = st.borders
      ? (["top", "right", "bottom", "left"] as const).filter((k) => num(st.borders![k]?.width) > 0)
      : [];
    const inset = (st.shadows ?? []).find((x) => x?.inset && num(x.spread) > 0 && !x.blur);
    const bColor =
      st.border && st.border.width > 0
        ? st.border.color
        : sides.length >= 3
          ? st.borders![sides[0]!]!.color
          : inset?.color;
    const bWidth =
      st.border?.width ?? (sides.length >= 3 ? num(st.borders![sides[0]!]!.width) : num(inset?.spread));
    const borderHex = bColor ? col(bColor, ground) : null;
    const shadows = (st.shadows ?? []).filter(
      (x) =>
        x &&
        !x.inset &&
        (x.blur > 0 || num(x.spread) > 0) &&
        alphaOf(concreteColor(x.color, tokens, "")) <= 0.45,
    );
    const gFill = st.fills?.find((f) => f.type === "gradient") as
      { stops: Array<{ color: string }>; kind?: string; angle?: number } | undefined;
    const gStops = gFill
      ? gFill.stops.map((s) => col(s.color, ground)).filter((x): x is string => !!x)
      : st.gradient
        ? [col(st.gradient.from, ground), col(st.gradient.to, ground)].filter((x): x is string => !!x)
        : [];
    const gradient =
      gStops.length >= 2 && alphaOf(gFill?.stops[0]?.color ?? st.gradient?.from) >= 0.9
        ? {
            css: `${gFill?.kind ?? "linear"}-gradient(${num(gFill?.angle ?? st.gradient?.angle, 180)}deg, ${gStops.join(", ")})`,
            stops: gStops,
            area: w * h,
          }
        : undefined;
    const image = el.type === "image" || el.type === "video" || !!st.fills?.some((f) => f.type === "image");
    const kids = el.children?.length ?? 0;
    const control =
      kind === "button" ||
      kind === "icon-button" ||
      ((tag === "button" || el.type === "button") && h >= 18 && h <= 72);
    const card =
      !control &&
      (kind === "card" ||
        kind === "teaser" ||
        kind === "list-item" ||
        (w * h >= 24_000 && w < pw * 0.9 && (radius > 0 || shadows.length > 0 || !!borderHex) && kids > 0));
    const band = w >= W * 0.9 && h >= 120 && depth <= 4 && (opaque || image);
    if (
      opaque ||
      borderHex ||
      shadows.length ||
      radius > 0 ||
      kind ||
      image ||
      gradient ||
      card ||
      control ||
      typeof ly.maxWidth === "number"
    ) {
      out.boxes.push({
        kind,
        setId: el.instance?.componentId,
        bg: opaque ? ground : undefined,
        under,
        w,
        h,
        radius,
        ...(borderHex && bWidth > 0 ? { border: { color: borderHex, width: bWidth } } : {}),
        shadows,
        gradient,
        image,
        pad: padOf(ly.padding),
        maxWidth: typeof ly.maxWidth === "number" ? ly.maxWidth : undefined,
        band,
        card,
        control,
        depth,
      });
    }
    if (el.instance) {
      const id = el.instance.componentId;
      const seen = out.inst.get(id);
      if (seen) seen.count++;
      else
        out.inst.set(id, {
          count: 1,
          under: ground,
          w,
          h,
          sticky: ly.scrollBehavior === "sticky" || ly.scrollBehavior === "fixed",
        });
    }
    if (el.type === "text" && el.text?.trim() && st.fontSize) {
      const stack = st.fontFamily ?? tokens.fontFamily;
      const family = clean(familyList(stack)[0] ?? tokens.fontFamily);
      const color = col(st.color ?? "$text", ground);
      if (color && family && !isIconFont(family)) {
        const lh = st.lineHeightPx ? st.lineHeightPx / st.fontSize : num(st.lineHeight, 1.2);
        const tt =
          st.textTransform && st.textTransform !== "none"
            ? st.textTransform
            : st.uppercase
              ? "uppercase"
              : undefined;
        out.runs.push({
          text: el.text.trim(),
          family,
          stack,
          size: st.fontSize,
          weight: num(st.fontWeight, 400),
          lh,
          ls: num(st.letterSpacing) * st.fontSize,
          transform: tt,
          color,
          bg: ground,
          uses: here,
        });
      }
    }
    const [, pr, , pl] = padOf(ly.padding);
    for (const c of el.children ?? []) walk(c, ground, Math.max(0, (w || pw) - pl - pr), here, depth + 1);
  };
  walk(screen.root, out.pageBg, W, [], 0);
  return out;
}

/* ------------------------------------------------------------------ pages */

interface Page {
  url: string;
  title?: string;
  screens: SceneScreen[];
  desktop: SceneScreen;
  mobile: SceneScreen;
  walked: Walked;
  tokens: SceneTokens;
  cap?: BrandCapture;
}

function pagesOf(
  screens: SceneScreen[],
  ds: SceneDesignSystem,
  setKind: Map<string, string>,
  url?: string,
): Page[] {
  const groups = new Map<string, SceneScreen[]>();
  for (const s of screens.filter((x) => !isOverlay(x))) {
    const k =
      s.responsive?.group ??
      s.capture?.finalUrl ??
      (typeof s.root.meta?.source === "string" ? s.root.meta.source : "") ??
      s.id;
    groups.set(k || s.id, [...(groups.get(k || s.id) ?? []), s]);
  }
  return [...groups.values()].map((list) => {
    const sorted = [...list].sort((a, b) => a.width - b.width);
    const desktop = [...list].sort(
      (a, b) => Math.abs(a.width - 1280) - Math.abs(b.width - 1280) || b.width - a.width,
    )[0]!;
    const tokens = resolveTokens(ds.tokens, desktop.tokens);
    const cap = desktop.capture ?? sorted.find((s) => s.capture)?.capture;
    const src = typeof desktop.root.meta?.source === "string" ? desktop.root.meta.source : undefined;
    return {
      url: cap?.finalUrl ?? cap?.url ?? src ?? url ?? desktop.name,
      title: cap?.marks.title ?? desktop.name,
      screens: sorted,
      desktop,
      mobile: sorted[0]!,
      walked: walkScreen(desktop, tokens, setKind),
      tokens,
      cap,
    };
  });
}

const capOf = (p: Page, s: SceneScreen) => s.capture ?? (s === p.desktop ? p.cap : undefined);

/* ------------------------------------------------------------------ primary from the CTA controls */

interface Cta {
  primary?: string;
  active?: string;
  hover?: string;
  disabled?: string;
  onPrimary?: string;
  control?: CapturedControl & { page: string; width: number };
  source: "site" | "derived";
}

function ctaColors(pages: Page[], fallback: { primary: string; source: "site" | "derived" }): Cta {
  type C = CapturedControl & { page: string; width: number; fill: string };
  const all: C[] = [];
  for (const p of pages) {
    const cap = p.desktop.capture ?? p.cap;
    if (!cap) continue;
    for (const c of cap.controls) {
      const fill = alphaOf(c.base.backgroundColor) >= 0.9 ? toHex(c.base.backgroundColor) : null;
      if (
        !fill ||
        !c.text?.trim() ||
        c.base.height < 24 ||
        c.disabled ||
        sameColor(fill, p.walked.pageBg) ||
        !["button", "link", "chip", "other"].includes(c.kind)
      )
        continue;
      all.push({ ...c, page: p.url, width: cap.width, fill });
    }
  }
  const groups: Array<{ fill: string; n: number; items: C[] }> = [];
  for (const c of [...all].sort((a, b) => b.count - a.count)) {
    const g = groups.find((x) => sameColor(x.fill, c.fill));
    if (g) {
      g.n += c.count;
      g.items.push(c);
    } else groups.push({ fill: c.fill, n: c.count, items: [c] });
  }
  const byCount = (a: { n: number; fill: string }, b: { n: number; fill: string }) =>
    b.n - a.n || (a.fill < b.fill ? -1 : 1);
  const win =
    groups.filter((g) => isChromatic(g.fill)).sort(byCount)[0] ??
    groups.filter((g) => isDark(g.fill)).sort(byCount)[0];
  if (win) {
    const items = win.items;
    const top = (f: (c: C) => string | null | undefined) =>
      mode(
        items.map(f).filter((x): x is string => !!x),
        () => 1,
      );
    const fromState = (s: StateStyle | undefined) =>
      s?.backgroundColor && alphaOf(s.backgroundColor) >= 0.9 ? toHex(s.backgroundColor) : null;
    const disabled = pages
      .flatMap((p) => (p.desktop.capture ?? p.cap)?.controls ?? [])
      .filter((c) => c.disabled && c.kind === "button")
      .map((c) => toHex(c.base.backgroundColor))
      .find((x): x is string => !!x);
    return {
      primary: win.fill,
      active: top((c) => fromState(c.active)),
      hover: top((c) => fromState(c.hover)),
      disabled,
      onPrimary: top((c) => toHex(c.base.color, win.fill)),
      control: items.sort((a, b) => b.count - a.count)[0],
      source: "site",
    };
  }
  // no captured controls: the site's own button-like layers (brandKit's scan), by count
  const scanned = pages.flatMap((p) => scanScreens([p.desktop]).controls).filter((c) => c.fill && c.label);
  const sGroups: Array<{ fill: string; n: number; label?: string }> = [];
  for (const c of scanned) {
    const fill = toHex(`rgba(${c.fill!.r}, ${c.fill!.g}, ${c.fill!.b}, 1)`)!;
    if (!isChromatic(fill) && !isDark(fill)) continue;
    const g = sGroups.find((x) => sameColor(x.fill, fill));
    const label = c.labelColor
      ? (toHex(`rgba(${c.labelColor.r}, ${c.labelColor.g}, ${c.labelColor.b}, 1)`) ?? undefined)
      : undefined;
    if (g) g.n++;
    else sGroups.push({ fill, n: 1, label });
  }
  const sWin = sGroups.filter((g) => isChromatic(g.fill)).sort(byCount)[0] ?? sGroups.sort(byCount)[0];
  if (sWin) return { primary: sWin.fill, onPrimary: sWin.label, source: "site" };
  return { primary: toHex(fallback.primary) ?? undefined, source: fallback.source };
}

/* ------------------------------------------------------------------ colours */

function collectColors(pages: Page[], cta: Cta, totalArea: number): ColorUse[] {
  type Raw = {
    hex: string;
    roles: Map<string, number>;
    area: number;
    count: number;
    chars: number;
    pages: Set<string>;
    kinds: Set<string>;
    stop?: number;
  };
  const raw = new Map<string, Raw>();
  const add = (
    hex: string | null | undefined,
    role: string,
    weight: number,
    o: { area?: number; count?: number; chars?: number; page?: string; kind?: string; stop?: number } = {},
  ) => {
    if (!hex) return;
    const r: Raw = raw.get(hex) ?? {
      hex,
      roles: new Map(),
      area: 0,
      count: 0,
      chars: 0,
      pages: new Set(),
      kinds: new Set(),
    };
    raw.set(hex, r);
    r.roles.set(role, (r.roles.get(role) ?? 0) + weight);
    r.area += o.area ?? 0;
    r.count += o.count ?? 0;
    r.chars += o.chars ?? 0;
    if (o.page) r.pages.add(o.page);
    if (o.kind) r.kinds.add(o.kind);
    if (o.stop !== undefined) r.stop = Math.min(r.stop ?? o.stop, o.stop);
  };
  const primary = cta.primary;
  const bodySize = median(
    pages.flatMap((p) => p.walked.runs.filter((r) => r.weight <= 500).map((r) => r.size)),
    16,
  );
  // the page's main gradient (largest painted one) gives the gradient stops
  const mainGradient = pages
    .flatMap((p) => p.walked.boxes.filter((b) => b.gradient))
    .sort((a, b) => b.gradient!.area - a.gradient!.area)[0]?.gradient;
  for (const p of pages) {
    const page = p.url;
    const sections = p.desktop.capture?.sections ?? p.cap?.sections;
    add(p.walked.pageBg, "page-bg", 1, { count: 1, page });
    for (const s of sections ?? [])
      add(toHex(s.background, p.walked.pageBg), "band-bg", (s.box.w * s.box.h) / totalArea, {
        area: (s.box.w * s.box.h) / totalArea,
        count: 1,
        page,
      });
    for (const b of p.walked.boxes) {
      const area = Math.min(b.w * b.h, 4_000_000) / totalArea;
      if (b.bg) {
        const role =
          b.band && !sections?.length ? "band-bg" : b.card ? "card-bg" : b.control ? "control-fill" : "fill";
        add(b.bg, role, role === "band-bg" || role === "fill" ? area : 1, {
          area,
          count: 1,
          page,
          kind: b.kind,
        });
      }
      if (b.border && b.border.width <= 2.5)
        add(b.border.color, "border", 1, { count: 1, page, kind: b.kind });
    }
    for (const r of p.walked.runs) {
      const chars = r.text.length;
      const onPrimary = primary && sameColor(r.bg, primary);
      const role = onPrimary
        ? "on-primary-text"
        : isDark(r.bg)
          ? "on-dark-text"
          : isChromatic(r.bg)
            ? "on-accent-text"
            : r.uses.includes("heading") || r.size >= Math.max(24, bodySize * 1.3)
              ? "heading"
              : r.uses.includes("nav")
                ? "nav-text"
                : r.uses.includes("footer")
                  ? "footer-text"
                  : r.uses.includes("button")
                    ? "button-text"
                    : r.uses.includes("link") && isChromatic(r.color)
                      ? "link"
                      : "body-text";
      add(r.color, role, chars, { chars, count: 1, page });
    }
    for (const c of capOf(p, p.desktop)?.controls ?? []) {
      const base = toHex(c.base.backgroundColor, p.walked.pageBg);
      const kind = c.kind === "chip" ? "tag" : c.kind === "tab" ? "tabs" : c.kind;
      if (base && alphaOf(c.base.backgroundColor) >= 0.5)
        add(base, c.disabled ? "state:disabled" : "control-fill", c.count, { count: c.count, page, kind });
      const textOn = base && alphaOf(c.base.backgroundColor) >= 0.5 ? base : p.walked.pageBg;
      const tc = toHex(c.base.color, textOn);
      if (tc)
        add(
          tc,
          primary && sameColor(textOn, primary)
            ? "on-primary-text"
            : c.kind === "link" && isChromatic(tc)
              ? "link"
              : isDark(textOn)
                ? "on-dark-text"
                : "button-text",
          c.count,
          { count: c.count, page, kind },
        );
      if (c.base.borderColor && num(c.base.borderWidth) > 0)
        add(toHex(c.base.borderColor, textOn), "border", c.count, { count: c.count, page, kind });
      for (const st of ["hover", "active", "focus"] as const) {
        const s = c[st];
        if (!s) continue;
        for (const v of [s.backgroundColor, s.color, s.borderColor])
          if (v && alphaOf(v) >= 0.5)
            add(toHex(v, textOn), `state:${st}`, c.count, { count: c.count, page, kind });
      }
    }
  }
  if (mainGradient) mainGradient.stops.forEach((h, i) => add(h, "gradient", 1, { count: 1, stop: i }));
  if (cta.onPrimary) add(cta.onPrimary, "on-primary-text", 1);
  // custom properties: the site's own names for colours, semantic ones, and what is declared but never painted
  const props = new Map<string, string>();
  for (const p of pages)
    for (const s of p.screens)
      for (const [k, v] of Object.entries(s.capture?.customProperties ?? {}))
        if (!props.has(k)) props.set(k, v);
  const semanticOf = (name: string) =>
    /success|valid|positive|confirm/i.test(name)
      ? "success"
      : /warn|caution/i.test(name)
        ? "warning"
        : /error|danger|invalid|negative|destructive|alert/i.test(name)
          ? "error"
          : null;
  const declared: Array<[string, string]> = [];
  for (const [name, value] of props) {
    const hex = /^(#|rgb|hsl|color\()/i.test(value.trim()) ? toHex(value) : null;
    if (!hex) continue;
    declared.push([name, hex]);
    const sem = semanticOf(name);
    // a status colour is a hue: a grey under --alert-text is copy colour, not the warning colour
    if (sem && isChromatic(hex)) add(hex, `semantic:${sem}`, 1);
  }
  // cluster (ΔE2000 < 2; the most used colour of a cluster keeps its hex)
  const weight = (r: Raw) => r.count + r.area * 1000 + r.chars / 20 + (r.roles.has("page-bg") ? 1000 : 0);
  const clusters: Raw[] = [];
  for (const r of [...raw.values()].sort((a, b) => weight(b) - weight(a) || (a.hex < b.hex ? -1 : 1))) {
    const isBg = (x: Raw) => ["page-bg", "band-bg", "card-bg"].some((k) => x.roles.has(k));
    const c = clusters.find((x) =>
      oneToken({ hex: x.hex, background: isBg(x) }, { hex: r.hex, background: isBg(r) }),
    );
    if (!c) {
      clusters.push({ ...r, roles: new Map(r.roles), pages: new Set(r.pages), kinds: new Set(r.kinds) });
      continue;
    }
    for (const [k, v] of r.roles) c.roles.set(k, (c.roles.get(k) ?? 0) + v);
    c.area += r.area;
    c.count += r.count;
    c.chars += r.chars;
    r.pages.forEach((x) => c.pages.add(x));
    r.kinds.forEach((x) => c.kinds.add(x));
    if (r.stop !== undefined) c.stop = Math.min(c.stop ?? r.stop, r.stop);
  }
  return clusters.map((c) => {
    const seen = c.count > 0 || c.area > 0 || c.chars > 0;
    const cssVar = declared
      .filter(([, h]) => sameColor(h, c.hex))
      .map(([n]) => n)
      .sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
    const roles = Object.fromEntries(c.roles);
    if (!seen) roles.declared = 1;
    return {
      hex: c.hex,
      roles,
      area: c.area,
      count: c.count,
      chars: c.chars,
      pages: [...c.pages].sort(),
      kinds: [...c.kinds].sort(),
      ...(cssVar ? { cssVar } : {}),
      ...(c.stop !== undefined ? { stop: c.stop } : {}),
    };
  });
}

/* ------------------------------------------------------------------ typography and fonts */

const TRANSFORMS = new Set(["uppercase", "lowercase", "capitalize"]);

function clusterRuns(runs: Run[]): TypeCluster[] {
  const m = new Map<string, TypeCluster & { stacks: Map<string, number> }>();
  for (const r of runs) {
    const key = [
      r.family.toLowerCase(),
      Math.round(r.size * 2) / 2,
      r.weight,
      r2(r.lh),
      r1(r.ls),
      r.transform ?? "",
    ].join("|");
    const c: TypeCluster & { stacks: Map<string, number> } = m.get(key) ?? {
      family: r.family,
      stack: r.stack,
      size: Math.round(r.size * 2) / 2,
      weight: r.weight,
      lineHeight: r2(r.lh),
      letterSpacing: r1(r.ls),
      ...(r.transform ? { textTransform: r.transform } : {}),
      chars: 0,
      uses: {},
      mono: isMono(r.family),
      strings: [],
      stacks: new Map(),
    };
    m.set(key, c);
    const n = r.text.length;
    c.chars += n;
    c.stacks.set(r.stack, (c.stacks.get(r.stack) ?? 0) + n);
    const plain = !r.uses.some((u) => ["heading", "nav", "footer", "button"].includes(u));
    for (const u of plain ? [...r.uses, "body"] : r.uses) c.uses[u] = (c.uses[u] ?? 0) + n;
    if (c.strings.length < 12 && r.text.length >= 2 && !c.strings.includes(r.text)) c.strings.push(r.text);
  }
  return [...m.values()].map(({ stacks, ...c }) => ({
    ...c,
    stack: mode([...stacks.keys()], (k) => stacks.get(k)!) ?? c.stack,
  }));
}

/** CSS font-family value for DESIGN.md: the authored list (quoted where needed) ending in a generic keyword. */
function stackString(stack: string, family: string, full: boolean): string {
  const generic = (familyList(fallbackStackFor(family)).pop() ?? "sans-serif").toLowerCase();
  const q = (f: string) =>
    GENERIC_FAMILY.test(f) || (/^[A-Za-z-]+$/.test(f) && !/\s/.test(f) && f !== family) ? f : `'${f}'`;
  if (!full) return `'${family}', ${GENERIC_FAMILY.test(generic) ? generic : "sans-serif"}`;
  const list = familyList(stack).filter((f) => !isIconFont(f));
  const out = uniq([family, ...list.filter((f) => f.toLowerCase() !== family.toLowerCase())]);
  if (!out.some((f) => /^(serif|sans-serif|monospace|cursive|fantasy)$/i.test(f)))
    out.push(GENERIC_FAMILY.test(generic) ? generic : "sans-serif");
  return out.map(q).join(", ");
}

/** Open families (Google Fonts) the brand guide can call public; anything else served is treated as licensed. */
const OPEN_FAMILIES = new Set([
  "inter",
  "inter tight",
  "roboto",
  "roboto flex",
  "roboto condensed",
  "roboto mono",
  "roboto serif",
  "open sans",
  "lato",
  "montserrat",
  "poppins",
  "source sans 3",
  "source sans pro",
  "source serif 4",
  "source code pro",
  "noto sans",
  "noto serif",
  "ibm plex sans",
  "ibm plex sans condensed",
  "ibm plex mono",
  "ibm plex serif",
  "work sans",
  "dm sans",
  "dm serif display",
  "manrope",
  "nunito",
  "nunito sans",
  "raleway",
  "rubik",
  "karla",
  "mulish",
  "figtree",
  "sora",
  "lexend",
  "outfit",
  "urbanist",
  "plus jakarta sans",
  "public sans",
  "libre franklin",
  "hanken grotesk",
  "instrument sans",
  "instrument serif",
  "space grotesk",
  "space mono",
  "jetbrains mono",
  "fira sans",
  "fira code",
  "barlow",
  "barlow condensed",
  "archivo",
  "archivo narrow",
  "oswald",
  "bebas neue",
  "anton",
  "saira",
  "saira condensed",
  "saira extra condensed",
  "jost",
  "playfair display",
  "merriweather",
  "lora",
  "literata",
  "fraunces",
  "eb garamond",
  "cormorant garamond",
  "libre baskerville",
  "crimson pro",
  "pt sans",
  "pt serif",
  "ubuntu",
  "cabin",
  "quicksand",
  "josefin sans",
  "titillium web",
  "exo 2",
  "geist",
  "geist mono",
  "onest",
  "albert sans",
]);

/** Open candidates with approximate published metrics: x-height and cap height (em), width class (1 compressed … 9 extended). */
const SUBSTITUTES: Array<{ family: string; cls: string; xh: number; cap: number; width: number }> = [
  { family: "Inter", cls: "grotesk", xh: 0.546, cap: 0.727, width: 5.5 },
  { family: "Roboto", cls: "grotesk", xh: 0.528, cap: 0.711, width: 5 },
  { family: "Arimo", cls: "grotesk", xh: 0.519, cap: 0.716, width: 5 },
  { family: "IBM Plex Sans", cls: "grotesk", xh: 0.516, cap: 0.698, width: 5 },
  { family: "Work Sans", cls: "grotesk", xh: 0.5, cap: 0.66, width: 5.5 },
  { family: "Hanken Grotesk", cls: "grotesk", xh: 0.5, cap: 0.7, width: 5 },
  { family: "Barlow", cls: "grotesk", xh: 0.5, cap: 0.7, width: 4 },
  { family: "Space Grotesk", cls: "grotesk", xh: 0.49, cap: 0.7, width: 6 },
  { family: "Montserrat", cls: "geometric", xh: 0.52, cap: 0.7, width: 7 },
  { family: "Poppins", cls: "geometric", xh: 0.55, cap: 0.7, width: 6 },
  { family: "Jost", cls: "geometric", xh: 0.46, cap: 0.68, width: 5 },
  { family: "DM Sans", cls: "geometric", xh: 0.5, cap: 0.7, width: 5 },
  { family: "Outfit", cls: "geometric", xh: 0.5, cap: 0.7, width: 5 },
  { family: "Open Sans", cls: "humanist", xh: 0.535, cap: 0.714, width: 6 },
  { family: "Source Sans 3", cls: "humanist", xh: 0.486, cap: 0.66, width: 4.5 },
  { family: "Lato", cls: "humanist", xh: 0.506, cap: 0.717, width: 5 },
  { family: "Nunito Sans", cls: "humanist", xh: 0.48, cap: 0.7, width: 5 },
  { family: "Roboto Condensed", cls: "condensed", xh: 0.528, cap: 0.711, width: 3 },
  { family: "IBM Plex Sans Condensed", cls: "condensed", xh: 0.516, cap: 0.698, width: 3 },
  { family: "Barlow Condensed", cls: "condensed", xh: 0.5, cap: 0.7, width: 3 },
  { family: "Saira Extra Condensed", cls: "compressed", xh: 0.53, cap: 0.7, width: 2 },
  { family: "Oswald", cls: "compressed", xh: 0.58, cap: 0.81, width: 2 },
  { family: "Literata", cls: "serif", xh: 0.47, cap: 0.68, width: 5 },
  { family: "Source Serif 4", cls: "serif", xh: 0.475, cap: 0.67, width: 5 },
  { family: "Playfair Display", cls: "serif", xh: 0.51, cap: 0.71, width: 5 },
  { family: "EB Garamond", cls: "serif", xh: 0.4, cap: 0.65, width: 4 },
  { family: "JetBrains Mono", cls: "mono", xh: 0.55, cap: 0.73, width: 6 },
  { family: "IBM Plex Mono", cls: "mono", xh: 0.516, cap: 0.698, width: 6 },
  { family: "Roboto Mono", cls: "mono", xh: 0.528, cap: 0.711, width: 6 },
];

/** Licensed families with approximate published metrics (the rest are classified by name and get their class's average). */
const KNOWN_METRICS: Array<[RegExp, { cls: string; xh: number; cap: number; width: number }]> = [
  [/helvetica|haas|arial/, { cls: "grotesk", xh: 0.523, cap: 0.717, width: 5 }],
  [/sf pro|san francisco|-apple-system/, { cls: "grotesk", xh: 0.53, cap: 0.705, width: 5 }],
  [/futura/, { cls: "geometric", xh: 0.47, cap: 0.7, width: 5 }],
  [/avenir/, { cls: "geometric", xh: 0.47, cap: 0.71, width: 5 }],
  [/gotham/, { cls: "geometric", xh: 0.51, cap: 0.7, width: 7 }],
  [/proxima/, { cls: "geometric", xh: 0.52, cap: 0.68, width: 5 }],
  [/segoe/, { cls: "humanist", xh: 0.5, cap: 0.7, width: 5 }],
  [/frutiger|myriad/, { cls: "humanist", xh: 0.5, cap: 0.7, width: 5 }],
];

const classOf = (family: string): string => {
  const fb = fallbackStackFor(family);
  return fb.includes("monospace")
    ? "mono"
    : fb.includes("Saira Extra Condensed")
      ? "compressed"
      : /Condensed/.test(fb)
        ? "condensed"
        : /serif/.test(fb.replace("sans-serif", ""))
          ? "serif"
          : fb.startsWith("Futura")
            ? "geometric"
            : "grotesk";
};

/** Open substitutes ranked by metric distance (x-height, cap height, width) within the family's class. */
function substitutesFor(family: string): Array<{ family: string; score: number }> {
  const known = KNOWN_METRICS.find(([re]) => re.test(family.toLowerCase()))?.[1];
  const cls = known?.cls ?? classOf(family);
  const peersOf = SUBSTITUTES.filter((s) => s.cls === cls);
  const avg = (k: "xh" | "cap" | "width") =>
    median(
      peersOf.map((s) => s[k]),
      k === "width" ? 5 : 0.5,
    );
  const t = known ?? { cls, xh: avg("xh"), cap: avg("cap"), width: avg("width") };
  return SUBSTITUTES.filter((s) => s.family.toLowerCase() !== family.toLowerCase())
    .map((s) => ({
      family: s.family,
      score: r2(
        Math.max(
          0,
          1 -
            (Math.abs(s.xh - t.xh) * 4 +
              Math.abs(s.cap - t.cap) * 3 +
              Math.abs(s.width - t.width) * 0.08 +
              (s.cls === cls ? 0 : 0.45)),
        ),
      ),
    }))
    .sort((a, b) => b.score - a.score || (a.family < b.family ? -1 : 1))
    .slice(0, 3);
}

/* ------------------------------------------------------------------ components */

interface Look {
  bg?: string | "transparent";
  text?: string;
  size?: number;
  weight?: number;
  family?: string;
  radius: number;
  pad: [number, number, number, number];
  h: number;
  w: number;
  border?: { color: string; width: number };
  shadow?: string;
  texts: string[];
}

const MAIN_TEXT_FIRST = new Set([
  "button",
  "icon-button",
  "link",
  "input",
  "search",
  "select",
  "textarea",
  "tag",
  "badge",
  "tabs",
  "navigation",
  "header",
  "menu",
  "breadcrumb",
  "pagination",
  "footer",
]);

function lookOf(root: SceneElement, kind: string, tokens: SceneTokens, ground: string): Look {
  const st = root.style ?? {},
    ly = root.layout ?? {};
  const col = (v: string | undefined, under: string) =>
    v ? toHex(concreteColor(v, tokens, ""), under) : null;
  const solid = st.fills?.find((f) => f.type === "solid") as { color: string } | undefined;
  const raw = st.background && st.background !== "transparent" ? st.background : solid?.color;
  const bgC = raw ? concreteColor(raw, tokens, "") : "";
  const bg = bgC && alphaOf(bgC) >= 0.5 ? (toHex(bgC, ground) ?? undefined) : "transparent";
  const fillUnder = bg && bg !== "transparent" ? bg : ground;
  const texts: Array<{ el: SceneElement; color: string; under: string }> = [];
  const walk = (el: SceneElement, under: string) => {
    if (el.meta?.hidden) return;
    const s = el.style ?? {};
    const b =
      s.background && alphaOf(concreteColor(s.background, tokens, "")) >= 0.5
        ? (col(s.background, under) ?? under)
        : under;
    if (el.type === "text" && el.text?.trim() && s.fontSize) {
      const c = col(s.color ?? "$text", b);
      if (c) texts.push({ el, color: c, under: b });
    }
    for (const c of el.children ?? []) walk(c, b);
  };
  walk(root, fillUnder);
  const main = MAIN_TEXT_FIRST.has(kind)
    ? texts[0]
    : [...texts].sort((a, b) => num(b.el.style?.fontSize) - num(a.el.style?.fontSize))[0];
  const ms = main?.el.style;
  const sides = st.borders
    ? (["top", "right", "bottom", "left"] as const).filter((k) => num(st.borders![k]?.width) > 0)
    : [];
  const bColor =
    st.border && st.border.width > 0
      ? st.border.color
      : sides.length >= 3
        ? st.borders![sides[0]!]!.color
        : undefined;
  const border = bColor
    ? { color: col(bColor, fillUnder) ?? "", width: st.border?.width ?? num(st.borders?.[sides[0]!]?.width) }
    : undefined;
  const shadows = (st.shadows ?? []).filter((x) => !x.inset && (x.blur > 0 || num(x.spread) > 0));
  return {
    bg,
    text: main?.color,
    size: ms?.fontSize,
    weight: num(ms?.fontWeight, 400),
    family: ms ? clean(familyList(ms.fontFamily ?? tokens.fontFamily)[0] ?? "") : undefined,
    radius: Array.isArray(st.radius) ? Math.max(...st.radius) : num(st.radius),
    pad: padOf(ly.padding),
    h: typeof ly.height === "number" ? ly.height : 0,
    w: typeof ly.width === "number" ? ly.width : 0,
    ...(border?.color ? { border } : {}),
    ...(shadows.length ? { shadow: shadowCss(shadows) } : {}),
    texts: texts.map((t) => t.el.text!.trim()),
  };
}

const BG_PREF = [
  "canvas",
  "surface-card",
  "surface-soft",
  "surface-strong",
  "surface-dark",
  "surface-dark-elevated",
  "primary",
  "primary-active",
  "primary-hover",
  "primary-disabled",
];
const TEXT_PREF = [
  "ink",
  "body",
  "body-strong",
  "muted",
  "muted-soft",
  "on-primary",
  "on-dark",
  "on-dark-soft",
  "link",
  "primary",
];

interface Resolver {
  color: (hex: string | undefined, as: "bg" | "text", ground?: string) => string | undefined;
  type: (size: number | undefined, weight: number | undefined, family?: string) => string | undefined;
  radius: (r: number, h: number, w: number) => string;
  space: (v: number) => string;
  padding: (p: [number, number, number, number], vertical?: boolean) => string | undefined;
}

function resolver(
  colors: ColorFact[],
  type: TypeFact[],
  rounded: ScaleStep[],
  spacing: ScaleStep[],
): Resolver {
  const color: Resolver["color"] = (hex, as, ground) => {
    if (!hex) return undefined;
    // transparent is read as black by the linter, and a colour without a token is no ref: both are left out
    if (hex === "transparent") return undefined;
    const exact = colors.filter((c) => c.hex === hex);
    const hits = exact.length ? exact : colors.filter((c) => sameColor(c.hex, hex));
    if (!hits.length) return undefined;
    const pref =
      as === "bg"
        ? BG_PREF
        : ground &&
            hits.some((c) => c.key === "on-primary") &&
            colors.some((c) => c.key.startsWith("primary") && sameColor(c.hex, ground))
          ? ["on-primary", ...TEXT_PREF]
          : ground && isDark(ground)
            ? ["on-dark", "on-dark-soft", ...TEXT_PREF]
            : TEXT_PREF;
    const rank = (k: string) => {
      const i = pref.indexOf(k);
      return i < 0 ? pref.length : i;
    };
    return `{colors.${[...hits].sort((a, b) => rank(a.key) - rank(b.key))[0]!.key}}`;
  };
  const typeRef: Resolver["type"] = (size, weight, family) => {
    if (!size) return undefined;
    const same = type.filter((t) => Math.abs(t.fontSize - size) <= 0.5 && t.fontWeight === (weight ?? 400));
    const hit =
      same.find((t) => !family || t.family.toLowerCase() === family.toLowerCase()) ??
      same[0] ??
      type
        .filter((t) => Math.abs(t.fontSize - size) <= 1 && t.fontWeight === (weight ?? 400))
        .sort((a, b) => Math.abs(a.fontSize - size) - Math.abs(b.fontSize - size))[0];
    return hit ? `{typography.${hit.key}}` : undefined;
  };
  const radius: Resolver["radius"] = (r, h, w) => {
    const circle = h > 0 && Math.abs(w - h) <= 2 && r >= h / 2 - 1;
    const pill = h > 0 && r >= h / 2 - 1;
    const shaped = circle
      ? (rounded.find((s) => s.key === "full") ?? rounded.find((s) => s.key === "pill"))
      : pill
        ? (rounded.find((s) => s.key === "pill") ?? rounded.find((s) => s.key === "full"))
        : undefined;
    if (shaped) return `{rounded.${shaped.key}}`;
    const hit = rounded
      .filter((s) => s.value !== PILL && Math.abs(s.value - r) <= 1)
      .sort((a, b) => Math.abs(a.value - r) - Math.abs(b.value - r))[0];
    return hit ? `{rounded.${hit.key}}` : `${r1(r)}px`;
  };
  const space: Resolver["space"] = (v) => {
    const hit = spacing.find((s) => Math.abs(s.value - v) <= 1);
    return hit ? `{spacing.${hit.key}}` : `${r1(v)}px`;
  };
  const padding: Resolver["padding"] = ([t, rt, b, l], vertical) => {
    if (vertical)
      return t > 0 && Math.abs(t - b) <= 1
        ? space(t)
        : t > 0 || b > 0
          ? `${r1(t)}px ${r1(rt)}px ${r1(b)}px ${r1(l)}px`
          : undefined;
    if (![t, rt, b, l].some((x) => x > 0)) return undefined;
    if (t === rt && rt === b && b === l) return space(t);
    return t === b && rt === l ? `${r1(t)}px ${r1(rt)}px` : `${r1(t)}px ${r1(rt)}px ${r1(b)}px ${r1(l)}px`;
  };
  return { color, type: typeRef, radius, space, padding };
}

const SECTION_KINDS = new Set([
  "header",
  "footer",
  "hero",
  "section",
  "navigation",
  "card",
  "teaser",
  "list-item",
  "modal",
]);
const CONTROL_KINDS = new Set([
  "button",
  "icon-button",
  "input",
  "search",
  "select",
  "textarea",
  "tag",
  "badge",
  "tabs",
  "header",
  "navigation",
  "link",
]);
const SKIP_KINDS = new Set(["icon", "text", "logo"]);
/** component entries taken from the sets (captured states and bands fill up to COMPONENT_CAP) */
const SET_BUDGET = 24;
/** all component entries (the examples hold 20–35) */
const COMPONENT_CAP = 34;
const FILL_ROLES =
  /^(primary|secondary|tertiary|outline|outlined|ghost|text|link|filled|solid|plain|default)$/i;

function buttonRole(
  bg: string | undefined,
  border: Look["border"],
  colors: ColorFact[],
): "primary" | "secondary" | "dark" | "text" {
  const primary = colors.find((c) => c.key === "primary")?.hex;
  if (bg && bg !== "transparent" && primary && sameColor(bg, primary)) return "primary";
  if (!bg || bg === "transparent") return border ? "secondary" : "text";
  return isDark(bg) ? "dark" : "secondary";
}

/* ------------------------------------------------------------------ main */

/** Every measured fact behind a brand's DESIGN.md (brand.json). */
export function brandFacts(input: BrandFactsInput): BrandFacts {
  const { ds } = input;
  const sets = ds.componentSets ?? [];
  const setKind = new Map(sets.map((d) => [d.id, kindOfSet(d, ds) as string]));
  const foundations = brandFoundations(
    input.screens.filter((s) => !isOverlay(s)),
    ds,
  );
  const pages = pagesOf(input.screens, ds, setKind, input.url);
  const gaps: string[] = [];
  const caps = input.screens.map((s) => s.capture).filter((c): c is BrandCapture => !!c);
  if (!pages.length) gaps.push("No captured screens: every value is derived from the design system tokens.");
  else if (!caps.length)
    gaps.push(
      "The screens carry no brand capture (older document): states, media queries, sections, grids, images and custom properties were not recorded; those values are derived from the DOM trees.",
    );
  const home = pages[0];
  const marks = (home?.cap ?? caps[0])?.marks;
  // the brand's name: site name, the logo's alt text ("BMW Logo" → BMW), a short title part, else the host's name
  // (a page title such as "Offizielle BMW DE Website: Premium Fahrzeuge" is not a name)
  const logoName = [marks?.logo?.alt, marks?.logoAlt?.alt]
    .map((a) =>
      a
        ?.replace(/\b(logo|logotype|home(page)?|startseite|zur startseite|to homepage)\b/gi, "")
        .replace(/[|–—:-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((a) => a && a.length <= 24);
  const titlePart = marks?.title
    ?.split(/\s+[|–—-]\s+|:\s+/)
    .map((x) => x.trim())
    .filter((x) => x && x.length <= 24)
    .sort((a, b) => a.length - b.length)[0];
  const hostLabel = (() => {
    try {
      const h = new URL(home?.cap?.finalUrl ?? home?.url ?? input.url ?? "").hostname
        .replace(/^www\./, "")
        .split(".")[0]!;
      return h.length <= 4 ? h.toUpperCase() : h[0]!.toUpperCase() + h.slice(1);
    } catch {
      return undefined;
    }
  })();
  const name = input.name ?? marks?.siteName ?? logoName ?? titlePart ?? hostLabel ?? ds.name;
  const website = originOf(input.url) ?? originOf(home?.cap?.finalUrl ?? home?.url) ?? input.url ?? "";
  const capturedAt = (
    input.capturedAt ??
    (typeof home?.desktop.root.meta?.capturedAt === "string" && home.desktop.root.meta.capturedAt
      ? home.desktop.root.meta.capturedAt
      : new Date().toISOString())
  ).slice(0, 10);
  const totalArea = pages.reduce((a, p) => a + p.desktop.width * p.desktop.height, 0) || 1;

  /* colours */
  const cta = ctaColors(pages, {
    primary: ds.tokens.primary,
    source: foundations.summary?.colorSources.primary ?? "derived",
  });
  const hints: ColorHints = {
    primary: cta.primary,
    primaryActive: cta.active,
    primaryHover: cta.hover,
    primaryDisabled: cta.disabled,
    onPrimary: cta.onPrimary,
    background: toHex(foundations.tokens.background ?? ds.tokens.background) ?? undefined,
    text: toHex(foundations.tokens.text ?? ds.tokens.text) ?? undefined,
  };
  const colors = nameColors(collectColors(pages, cta, totalArea), hints);
  if (cta.source === "derived") for (const c of colors) if (c.key === "primary") c.source = "derived";
  if (!colors.some((c) => ["success", "warning", "error"].includes(c.key)))
    gaps.push("No success / warning / error colours were seen or declared on the captured pages.");
  const declaredOnly = colors.filter(
    (c) =>
      (c.roles.length === 1 && c.roles[0] === "declared") || (c.roles.includes("declared") && c.count === 0),
  );
  if (declaredOnly.length)
    gaps.push(
      `Declared in the style sheets but not seen on the captured pages: ${declaredOnly.map((c) => c.cssVar ?? c.key).join(", ")}.`,
    );
  const props = new Map<string, string>();
  for (const c of caps)
    for (const [k, v] of Object.entries(c.customProperties)) if (!props.has(k)) props.set(k, v);
  const unusedVars = [...props]
    .filter(
      ([, v]) =>
        /^(#|rgb|hsl)/i.test(v.trim()) && toHex(v) && !colors.some((c) => sameColor(c.hex, toHex(v)!)),
    )
    .map(([k]) => k);
  if (unusedVars.length)
    gaps.push(
      `${unusedVars.length} colour custom ${unusedVars.length === 1 ? "property is" : "properties are"} declared but not used on the captured pages (${unusedVars.slice(0, 6).join(", ")}${unusedVars.length > 6 ? " …" : ""}).`,
    );

  /* typography */
  const runs = pages.flatMap((p) => p.walked.runs);
  const clusters = clusterRuns(runs);
  let button: TypeCluster | undefined;
  if (cta.control) {
    const b = cta.control.base;
    const family = clean(familyList(b.fontFamily)[0] ?? "");
    const lh = b.lineHeight > 4 ? b.lineHeight / b.fontSize : b.lineHeight || 1.2;
    const tt =
      b.textTransform && TRANSFORMS.has(b.textTransform)
        ? (b.textTransform as TypeCluster["textTransform"])
        : undefined;
    const chars = (cta.control.text?.length ?? 4) * cta.control.count;
    if (family)
      button = {
        family,
        stack: b.fontFamily,
        size: b.fontSize,
        weight: b.fontWeight,
        lineHeight: r2(lh),
        letterSpacing: r1(b.letterSpacing),
        ...(tt ? { textTransform: tt } : {}),
        chars,
        uses: { button: chars },
        mono: isMono(family),
        strings: cta.control.text ? [cta.control.text] : [],
      };
  }
  const named = nameTypes(clusters, { button });
  const mobileSizes = new Map<string, number[]>();
  for (const p of pages) {
    if (p.mobile === p.desktop) continue;
    for (const r of walkScreen(p.mobile, p.tokens, setKind).runs)
      mobileSizes.set(r.text, [...(mobileSizes.get(r.text) ?? []), r.size]);
  }
  let typography: TypeFact[] = named.map(({ key, cluster: c }, i) => {
    const m = median(
      c.strings.flatMap((s) => mobileSizes.get(s) ?? []),
      0,
    );
    const use = Object.entries(c.uses)
      .filter(([u]) => u !== "body" || Object.keys(c.uses).length === 1)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([u]) => u);
    const tags = use.filter((u) => /^h\d$/.test(u));
    return {
      key,
      fontFamily: stackString(c.stack, c.family, i === 0),
      family: c.family,
      fontSize: r1(c.size),
      fontWeight: c.weight,
      lineHeight: r2(c.lineHeight),
      letterSpacing: r1(c.letterSpacing),
      ...(c.textTransform ? { textTransform: c.textTransform } : {}),
      chars: c.chars,
      use: (tags.length ? use.filter((u) => u !== "heading") : use).slice(0, 3),
      ...(m && Math.abs(m - c.size) >= 1 ? { mobileSize: r1(m) } : {}),
      source: c.source ?? "site",
    };
  });
  if (!typography.length) {
    // nothing to measure: the system's text styles (brandKit) stand in, marked derived
    const ROLE_KEYS: Array<[TypeRole, string]> = [
      ["display", "display-xl"],
      ["h1", "display-lg"],
      ["h2", "display-md"],
      ["h3", "title-lg"],
      ["h4", "title-md"],
      ["bodyL", "lead"],
      ["body", "body-md"],
      ["small", "body-sm"],
      ["caption", "caption"],
      ["overline", "label-uppercase"],
      ["label", "button"],
    ];
    const styles = ds.styles?.text ?? foundations.styles.text;
    typography = ROLE_KEYS.map(
      ([role, key]) => [styles.find((s) => s.id === TEXT_STYLE_IDS[role]), key] as const,
    )
      .filter(([s]) => !!s)
      .map(([s, key], i) => {
        const family = clean(familyList(s!.fontFamily ?? ds.tokens.fontFamily)[0] ?? "sans-serif");
        return {
          key,
          fontFamily: stackString(s!.fontFamily ?? family, family, i === 0),
          family,
          fontSize: s!.fontSize,
          fontWeight: s!.fontWeight,
          lineHeight: r2(s!.lineHeight ?? 1.4),
          letterSpacing: r1((s!.letterSpacing ?? 0) * s!.fontSize),
          ...(s!.uppercase ? { textTransform: "uppercase" as const } : {}),
          chars: 0,
          use: [],
          source: "derived" as const,
        };
      });
    if (typography.length)
      gaps.push("No text was measured: the type scale comes from the design system’s text styles.");
  }
  const chars = new Map<number, number>();
  for (const r of runs) chars.set(r.weight, (chars.get(r.weight) ?? 0) + r.text.length);
  const totalChars = [...chars.values()].reduce((a, b) => a + b, 0) || 1;
  const used = [...chars]
    .filter(([, n]) => n / totalChars >= 0.01)
    .map(([w]) => w)
    .sort((a, b) => a - b);
  const weightsUsed = used.length ? used : uniq(typography.map((t) => t.fontWeight)).sort((a, b) => a - b);
  const absent = [100, 200, 300, 400, 500, 600, 700, 800, 900].filter(
    (w) =>
      weightsUsed.length &&
      w > weightsUsed[0]! &&
      w < weightsUsed[weightsUsed.length - 1]! &&
      !weightsUsed.includes(w),
  );
  const lsShare = (f: (r: Run) => boolean) =>
    runs.filter(f).reduce((a, r) => a + r.text.length, 0) /
    (runs.reduce((a, r) => a + r.text.length, 0) || 1);
  const neg = lsShare((r) => r.ls < -0.05),
    pos = lsShare((r) => r.ls > 0.05);
  const tracking: BrandFacts["tracking"] =
    neg < 0.05 && pos < 0.05
      ? "zero"
      : neg >= 0.05 && pos < 0.05
        ? "negative"
        : pos >= 0.05 && neg < 0.05
          ? "positive"
          : "mixed";

  /* fonts */
  const famChars = new Map<string, number>();
  for (const r of runs) famChars.set(r.family, (famChars.get(r.family) ?? 0) + r.text.length);
  const files = caps.flatMap((c) => c.fontFiles);
  const famNames = uniq([
    ...[...famChars]
      .sort((a, b) => b[1] - a[1])
      .filter(([f, n]) => n / totalChars >= 0.005 || typography.some((t) => t.family === f))
      .map(([f]) => f),
    ...typography.map((t) => t.family),
    ...files.map((f) => clean(f.family)),
  ]).filter((f) => f && !GENERIC_FAMILY.test(f) && !isIconFont(f));
  const seenFam = new Set<string>();
  const fonts: FontFact[] = famNames
    .filter((f) => {
      const k = f.toLowerCase();
      if (seenFam.has(k)) return false;
      seenFam.add(k);
      return true;
    })
    .map((family) => {
      const own = files.filter((f) => clean(f.family).toLowerCase() === family.toLowerCase());
      const dedup = uniq(
        own.map((f) =>
          JSON.stringify({
            url: f.url,
            weight: f.weight,
            style: f.style,
            ...(f.format ? { format: f.format } : {}),
          }),
        ),
      ).map((s) => JSON.parse(s) as FontFact["files"][number]);
      const served = own.flatMap((f) =>
        f.weight
          .split(/\s+/)
          .map(Number)
          .filter((n) => n >= 100 && n <= 1000),
      );
      const variable = own.some((f) => /\d+\s+\d+/.test(f.weight));
      const runW = runs.filter((r) => r.family.toLowerCase() === family.toLowerCase()).map((r) => r.weight);
      const weights = uniq(variable || !served.length ? (runW.length ? runW : served) : served).sort(
        (a, b) => a - b,
      );
      const licensed = !OPEN_FAMILIES.has(family.toLowerCase());
      return {
        family,
        weights,
        styles: uniq(own.map((f) => f.style || "normal")).sort().length
          ? uniq(own.map((f) => f.style || "normal")).sort()
          : ["normal"],
        files: dedup,
        licensed,
        substitutes: licensed ? substitutesFor(family) : [],
      };
    });
  for (const f of fonts.filter((x) => x.licensed && famChars.has(x.family)))
    gaps.push(
      `${f.family} is not a public web font (licensed to the site); the open substitutes are ranked by approximate metrics, not by a rendering test.`,
    );

  /* radii */
  const radiusUses: RadiusUse[] = [];
  const pushR = (value: number, kind: string, h: number, w: number, count = 1) => {
    const shape =
      h > 0 && value >= h / 2 - 1
        ? Math.abs(w - h) <= 2
          ? "circle"
          : "pill"
        : value >= 100
          ? "pill"
          : undefined;
    radiusUses.push({ value: shape ? PILL : r1(value), count, kinds: [kind], ...(shape ? { shape } : {}) });
  };
  for (const p of pages) {
    for (const b of p.walked.boxes) {
      const kind =
        b.kind ?? (b.control ? "button" : b.card ? "card" : b.image && b.w >= 80 ? "image" : undefined);
      if (kind && !SKIP_KINDS.has(kind) && (b.radius > 0 || b.bg || b.border || b.image))
        pushR(b.radius, kind, b.h, b.w);
    }
    for (const c of capOf(p, p.desktop)?.controls ?? [])
      pushR(
        c.base.borderRadius,
        c.kind === "chip" ? "tag" : c.kind === "tab" ? "tabs" : c.kind,
        c.base.height,
        c.box.w,
        c.count,
      );
  }
  const rounded = nameRadii(radiusUses);
  const radiusByKind: Record<string, number> = {};
  for (const kind of uniq(radiusUses.flatMap((u) => u.kinds)).sort()) {
    const mine = radiusUses.filter((u) => u.kinds.includes(kind));
    radiusByKind[kind] =
      mode(
        mine.map((u) => u.value),
        (v) => mine.filter((u) => u.value === v).reduce((a, u) => a + u.count, 0),
      ) ?? 0;
  }

  /* spacing, rhythm, container */
  const spaceValues = pages.flatMap((p) => scanScreens(p.screens).spacing);
  const baseUnit = foundations.tokens.spacing ?? ds.tokens.spacing ?? 8;
  const sectionPads = pages
    .flatMap((p) => (capOf(p, p.desktop)?.sections ?? []).flatMap((s) => [s.paddingTop, s.paddingBottom]))
    .filter((v) => v > 0 && v <= 240);
  const bandPads = pages
    .flatMap((p) => p.walked.boxes.filter((b) => b.band).flatMap((b) => [b.pad[0], b.pad[2]]))
    .filter((v) => v >= 24 && v <= 240);
  const sectionRhythm = Math.round(
    middle(
      sectionPads,
      middle(
        bandPads,
        middle(
          spaceValues.filter((v) => v >= 40),
          64,
        ),
      ),
    ),
  );
  if (!sectionPads.length)
    gaps.push(
      `Section rhythm (${sectionRhythm}px) is ${bandPads.length ? "read from the band frames" : "derived"}; no captured section boxes.`,
    );
  const spacing = nameSpacing(spaceValues, baseUnit, sectionRhythm);
  const cardPads = pages.flatMap((p) =>
    p.walked.boxes.filter((b) => b.card).flatMap((b) => b.pad.filter((v) => v > 0)),
  );
  const cardPadding = cardPads.length ? Math.round(median(cardPads)) : undefined;
  const maxWs = pages.flatMap((p) =>
    p.walked.boxes.map((b) => b.maxWidth).filter((v): v is number => !!v && v >= 600),
  );
  const widest = pages
    .flatMap((p) => p.screens.filter((s) => s.capture))
    .sort((a, b) => b.width - a.width)[0];
  const gridW =
    widest?.capture?.grids.map((g) => g.box.w).filter((w) => w >= 600 && w < widest.width - 16) ?? [];
  const containerMax = maxWs.length
    ? mode(maxWs.map(Math.round))
    : gridW.length
      ? Math.round(Math.max(...gridW))
      : undefined;

  /* grids per width */
  const gridMap = new Map<string, { name: string; columnsByWidth: Record<string, number>; count: number }>();
  for (const [pi, p] of pages.entries()) {
    for (const s of p.screens) {
      (s.capture?.grids ?? []).forEach((g, i) => {
        const key = `${pi}:${g.section ?? `#${i}`}:${g.count}`;
        const e = gridMap.get(key) ?? {
          name: `${pages.length > 1 ? `page ${pi + 1} · ` : ""}${g.section !== undefined ? `band ${g.section + 1}` : `grid ${i + 1}`} · ${g.count} items`,
          columnsByWidth: {},
          count: g.count,
        };
        e.columnsByWidth[String(s.width)] = g.columns;
        gridMap.set(key, e);
      });
    }
  }
  const gridList = [...gridMap.values()]
    .filter((g) => Object.values(g.columnsByWidth).some((c) => c >= 2))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
    .slice(0, 6);
  const grids = gridList.map(({ name, columnsByWidth }) => ({ name, columnsByWidth }));

  /* breakpoints */
  const bounds = new Map<number, number>();
  const seenMq = new Set<string>();
  for (const p of pages)
    for (const s of p.screens)
      for (const q of s.capture?.mediaQueries ?? []) {
        const k = `${p.url}|${q.query}`;
        if (seenMq.has(k)) continue;
        seenMq.add(k);
        for (const b of [q.minWidth, q.maxWidth !== undefined ? q.maxWidth + 1 : undefined])
          if (b !== undefined && b >= 320 && b <= 2560)
            bounds.set(Math.round(b), (bounds.get(Math.round(b)) ?? 0) + Math.max(1, q.rules));
      }
  const bClusters: Array<{ at: number; n: number }> = [];
  for (const [at, n] of [...bounds].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    const c = bClusters.find((x) => Math.abs(x.at - at) <= 8);
    if (c) c.n += n;
    else bClusters.push({ at, n });
  }
  const mqBounds = bClusters
    .filter((c, _i, a) => c.n >= a[0]!.n * 0.05)
    .slice(0, 4)
    .map((c) => c.at)
    .sort((a, b) => a - b);
  const widths = uniq(pages.flatMap((p) => p.screens.map((s) => s.responsive?.minWidth ?? s.width))).sort(
    (a, b) => a - b,
  );
  const edges = mqBounds.length ? mqBounds : widths.slice(1);
  if (!mqBounds.length && caps.length)
    gaps.push("No @media width rules were readable; breakpoints follow the captured widths.");
  const NAMES: Record<number, string[]> = {
    1: ["All"],
    2: ["Mobile", "Desktop"],
    3: ["Mobile", "Tablet", "Desktop"],
    4: ["Mobile", "Tablet", "Desktop", "Wide"],
    5: ["Mobile", "Tablet", "Laptop", "Desktop", "Wide"],
  };
  const ranges = [
    ...edges.map((at, i) => ({ min: i === 0 ? undefined : edges[i - 1], max: at - 1 })),
    { min: edges[edges.length - 1], max: undefined as number | undefined },
  ];
  const main = pages[0];
  const navCount = (s: SceneScreen) =>
    uniq(
      walkScreen(s, main!.tokens, setKind)
        .runs.filter((r) => r.uses.includes("nav") && r.size <= 20)
        .map((r) => r.text),
    ).length;
  const h1Of = (s: SceneScreen) => {
    const rs = walkScreen(s, main!.tokens, setKind).runs;
    const h = rs.filter((r) => r.uses.includes("h1"));
    return Math.max(0, ...(h.length ? h : rs).map((r) => r.size));
  };
  const deskNav = main ? navCount(main.desktop) : 0,
    deskH1 = main ? h1Of(main.desktop) : 0;
  const breakpoints: BreakpointFact[] = edges.length
    ? ranges.map((r, i) => {
        const s = main?.screens.find(
          (x) => (r.min === undefined || x.width >= r.min) && (r.max === undefined || x.width <= r.max),
        );
        const changes: string[] = [];
        if (s && main) {
          const n = navCount(s),
            h1 = h1Of(s);
          if (s !== main.desktop && deskNav >= 3 && n < Math.max(2, deskNav * 0.5))
            changes.push("nav collapses to a menu button");
          else if (n >= 3) changes.push(`full top nav (${n} links)`);
          if (h1 > 0)
            changes.push(h1 !== deskH1 && deskH1 > 0 ? `h1 ${r1(deskH1)}→${r1(h1)}px` : `h1 ${r1(h1)}px`);
          for (const g of gridList.slice(0, 2)) {
            const c = g.columnsByWidth[String(s.width)];
            if (c) changes.push(`${g.name}: ${c}-up`);
          }
        }
        return {
          name: (NAMES[ranges.length] ?? ranges.map((_x, j) => `Range ${j + 1}`))[i]!,
          ...(r.min !== undefined ? { min: r.min } : {}),
          ...(r.max !== undefined ? { max: r.max } : {}),
          changes,
        };
      })
    : [];

  /* elevation, gradients, bands */
  const shadowMap = new Map<string, { value: string; count: number; kinds: Set<string> }>();
  const gradients: string[] = [];
  for (const p of pages)
    for (const b of p.walked.boxes) {
      if (b.shadows.length) {
        const v = shadowCss(b.shadows);
        const e = shadowMap.get(v) ?? { value: v, count: 0, kinds: new Set<string>() };
        e.count++;
        e.kinds.add(b.kind ?? (b.card ? "card" : b.control ? "button" : "other"));
        shadowMap.set(v, e);
      }
      if (b.gradient && b.gradient.area >= totalArea * 0.002 && !gradients.includes(b.gradient.css))
        gradients.push(b.gradient.css);
    }
  const elevation = {
    shadows: [...shadowMap.values()]
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
      .slice(0, 6)
      .map((s) => ({ value: s.value, count: s.count, kinds: [...s.kinds].sort() })),
    gradients: gradients.slice(0, 4),
  };
  const canvas = colors.find((c) => c.key === "canvas")?.hex ?? "#ffffff";
  const bandOf = (bg: string | undefined, photo: boolean): "light" | "dark" | "photo" | "tint" =>
    photo
      ? "photo"
      : !bg || bg === canvas
        ? "light"
        : isChromatic(bg)
          ? "tint"
          : isDark(bg)
            ? "dark"
            : "light";
  const bands = pages
    .map((p) => {
      const sections = capOf(p, p.desktop)?.sections;
      const sequence = sections?.length
        ? sections.map((s) =>
            bandOf(toHex(s.background, canvas) ?? undefined, !!s.backgroundImage && !s.background),
          )
        : p.walked.boxes.filter((b) => b.band).map((b) => bandOf(b.bg, b.image && !b.bg));
      return { page: p.url, sequence };
    })
    .filter((b) => b.sequence.length);

  /* components */
  const R = resolver(colors, typography, rounded, spacing);
  const texts = uniq(
    caps.length ? caps.flatMap((c) => c.texts.map((t) => t.trim()).filter(Boolean)) : runs.map((r) => r.text),
  ).slice(0, 4000);
  const textSet = new Set(texts);
  const components: ComponentFact[] = [];
  const namer = keyNamer();
  const instIn = (id: string) => pages.filter((p) => p.walked.inst.has(id));
  const tokens = main?.tokens ?? resolveTokens(ds.tokens);
  const propsOf = (look: Look, kind: string, ground: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const assumed = look.bg === "transparent" && SECTION_KINDS.has(kind);
    const bg = assumed ? ground : look.bg;
    // a transparent part takes the colour it sits on, unless its text says otherwise (white copy over a dark band the
    // walk read as canvas): then it stays transparent, as the examples write it
    const bgRef = assumed && look.text && contrast(look.text, ground) < 3 ? null : R.color(bg, "bg");
    if (bgRef) out.backgroundColor = bgRef;
    const tRef = R.color(look.text, "text", bg && bg !== "transparent" ? bg : ground);
    if (tRef) out.textColor = tRef;
    const ty = R.type(look.size, look.weight, look.family);
    if (ty) out.typography = ty;
    if (!["header", "footer", "section", "navigation"].includes(kind) || look.radius > 0)
      out.rounded = R.radius(look.radius, look.h, look.w);
    const pad = R.padding(look.pad, ["hero", "section", "footer"].includes(kind));
    if (pad) out.padding = pad;
    if (look.h > 0 && CONTROL_KINDS.has(kind)) out.height = `${r1(look.h)}px`;
    return out;
  };
  const layoutOf = (look: Look, kind: string, seen: InstanceSeen | undefined, onPages: number): string[] => {
    const out: string[] = [];
    if (look.h > 0 && CONTROL_KINDS.has(kind)) out.push(`height ${r1(look.h)}px`);
    if (seen?.sticky) out.push("sticky");
    if (look.border)
      out.push(
        `border ${r1(look.border.width)}px ${R.color(look.border.color, "text") ?? look.border.color}`,
      );
    if (look.shadow) out.push(`shadow ${look.shadow}`);
    if (onPages) out.push(`on ${onPages} of ${pages.length} page${pages.length === 1 ? "" : "s"}`);
    return out;
  };
  // a site yields hundreds of sets; DESIGN.md documents its primitives (the examples hold 20–35 entries): the most used
  // sets first (instances over all pages; generated ones last), one set per component key, at most SET_BUDGET entries
  const usage = (id: string) => pages.reduce((n, p) => n + (p.walked.inst.get(id)?.count ?? 0), 0);
  const ranked = [...sets].sort(
    (a, b) =>
      (a.origin === "generated" ? 1 : 0) - (b.origin === "generated" ? 1 : 0) || usage(b.id) - usage(a.id),
  );
  const takenBases = new Set<string>();
  for (const def of ranked) {
    const kind = setKind.get(def.id) ?? "other";
    if (SKIP_KINDS.has(kind)) continue;
    if (components.length >= SET_BUDGET) break;
    // a one-off extracted part of no known kind is page content, not a system component
    if (def.origin !== "generated" && kind === "other" && usage(def.id) < 2) continue;
    const axes = axesOf(def);
    const bpOrder = axes[BREAKPOINT_AXIS] ?? [];
    const defaults = parseVariantKey(def.defaultVariant);
    const combos = new Map<string, string>();
    for (const vk of Object.keys(def.variants)) {
      const v = parseVariantKey(vk);
      const sig = Object.entries(v)
        .filter(([a]) => a !== BREAKPOINT_AXIS)
        .sort()
        .map(([a, x]) => `${a}=${x}`)
        .join(",");
      const cur = combos.get(sig);
      const rank = (k: string) => bpOrder.indexOf(parseVariantKey(k)[BREAKPOINT_AXIS] ?? "");
      if (!cur || rank(vk) > rank(cur)) combos.set(sig, vk);
    }
    const defSig = Object.entries(defaults)
      .filter(([a]) => a !== BREAKPOINT_AXIS)
      .sort()
      .map(([a, x]) => `${a}=${x}`)
      .join(",");
    const order = [...combos.keys()]
      .sort((a, b) => (a === defSig ? -1 : b === defSig ? 1 : a < b ? -1 : 1))
      .slice(0, 6);
    const seenPages = instIn(def.id);
    const seen = seenPages[0]?.walked.inst.get(def.id);
    const ground = seen?.under ?? canvas;
    // a variant's key: the set's key (a button's by the fill of its resting look), non-state values, then the state
    const STATES = new Set(["active", "hover", "focus", "disabled", "selected"]);
    const isState = (a: string, v: string) =>
      a !== BREAKPOINT_AXIS && STATES.has(variantSuffix(v, kind) ?? "");
    const restLook = (values: Record<string, string>, look: Look) => {
      const rest = Object.entries(values).filter(([a, v]) => a !== BREAKPOINT_AXIS && !isState(a, v));
      const hit = Object.keys(def.variants).find((k) => {
        const v = parseVariantKey(k);
        return (
          rest.every(([a, x]) => v[a] === x) &&
          Object.entries(v).every(([a, x]) => a === BREAKPOINT_AXIS || !isState(a, x) || x === defaults[a])
        );
      });
      return hit && def.variants[hit] ? lookOf(def.variants[hit]!, kind, tokens, ground) : look;
    };
    const setKey = kind === "button" ? "" : componentBase(def.name, kind);
    for (const sig of order) {
      const vk = combos.get(sig)!;
      const root = def.variants[vk];
      if (!root) continue;
      const look = lookOf(root, kind, tokens, ground);
      if (!look.h && seen?.h && sig === defSig) look.h = seen.h;
      if (!look.w && seen?.w && sig === defSig) look.w = seen.w;
      const values = parseVariantKey(vk);
      const changed = Object.entries(values).filter(([a, v]) => a !== BREAKPOINT_AXIS && v !== defaults[a]);
      const states = changed.filter(([a, v]) => isState(a, v)).map(([, v]) => variantSuffix(v, kind)!);
      const others = changed
        .filter(([a, v]) => !isState(a, v) && !(kind === "button" && FILL_ROLES.test(v)))
        .map(([, v]) => variantSuffix(v, kind))
        .filter((x): x is string => !!x);
      const rl = kind === "button" ? restLook(values, look) : look;
      const own =
        kind === "button"
          ? componentBase(def.name, kind, {
              button: buttonRole(rl.bg, rl.border, colors),
              onDark: isDark(ground) && !!rl.text && !isDark(rl.text),
            })
          : setKey;
      const baseKey = uniq([own, ...others]).join("-");
      // another (more used) set already documents this component: the whole set is a near-duplicate
      if (sig === order[0] && takenBases.has(baseKey)) break;
      if (sig === order[0]) takenBases.add(baseKey);
      const key = namer(uniq([baseKey, ...states]).join("-"));
      components.push({
        key,
        base: states.length ? baseKey : key,
        kind,
        group: groupOfKind(kind),
        setId: def.id,
        props: propsOf(look, kind, ground),
        texts:
          def.origin === "generated"
            ? []
            : uniq(look.texts.filter((t) => !textSet.size || textSet.has(t))).slice(0, 5),
        layout: layoutOf(look, kind, seen, seenPages.length),
        source: def.origin === "generated" ? "generated" : "extracted",
      });
    }
  }
  // captured states (and CTA / chips / tabs the sets do not cover)
  const has = (k: string) => components.some((c) => c.key === k);
  const ctrlLook = (c: CapturedControl, ground: string): Look => ({
    bg:
      alphaOf(c.base.backgroundColor) >= 0.5
        ? (toHex(c.base.backgroundColor, ground) ?? "transparent")
        : "transparent",
    text:
      toHex(
        c.base.color,
        alphaOf(c.base.backgroundColor) >= 0.5 ? (toHex(c.base.backgroundColor, ground) ?? ground) : ground,
      ) ?? undefined,
    size: c.base.fontSize,
    weight: c.base.fontWeight,
    family: clean(familyList(c.base.fontFamily)[0] ?? ""),
    radius: c.base.borderRadius,
    pad: [c.base.paddingTop, c.base.paddingRight, c.base.paddingBottom, c.base.paddingLeft],
    h: c.base.height,
    w: c.box.w,
    ...(c.base.borderColor && num(c.base.borderWidth) > 0
      ? { border: { color: toHex(c.base.borderColor, ground) ?? "", width: num(c.base.borderWidth) } }
      : {}),
    texts: c.text ? [c.text] : [],
  });
  const stateProps = (
    base: Record<string, string>,
    s: StateStyle | undefined,
    ground: string,
  ): Record<string, string> | null => {
    if (!s) return null;
    const out: Record<string, string> = {};
    const bg =
      s.backgroundColor && alphaOf(s.backgroundColor) >= 0.5 ? toHex(s.backgroundColor, ground) : null;
    const fg = s.color ? toHex(s.color, bg ?? ground) : null;
    if (!bg && !fg) return null;
    const bgRef = bg ? R.color(bg, "bg") : base.backgroundColor;
    if (bgRef) out.backgroundColor = bgRef;
    const t = fg ? R.color(fg, "text", bg ?? ground) : base.textColor;
    if (t) out.textColor = t;
    if (base.rounded) out.rounded = base.rounded;
    return out;
  };
  const addStates = (
    baseKey: string,
    kind: string,
    c: CapturedControl & { page?: string; width?: number },
    ground: string,
  ) => {
    const base = components.find((x) => x.key === baseKey);
    if (!base) return;
    for (const st of ["active", "hover", "focus"] as const) {
      const k = `${baseKey}-${st}`;
      if (has(k)) continue;
      const p = stateProps(base.props, c[st], ground);
      if (
        p &&
        JSON.stringify(p) !==
          JSON.stringify({
            ...(base.props.backgroundColor ? { backgroundColor: base.props.backgroundColor } : {}),
            ...(base.props.textColor ? { textColor: base.props.textColor } : {}),
            ...(base.props.rounded ? { rounded: base.props.rounded } : {}),
          })
      ) {
        components.push({
          key: namer(k),
          base: baseKey,
          kind,
          group: base.group,
          props: p,
          texts: [],
          layout: [],
          source: "state",
          ...(c.page ? { crop: { width: c.width ?? 0, box: c.box, page: c.page } } : {}),
        });
      }
    }
  };
  if (cta.control) {
    const c = cta.control;
    const ground = pages.find((p) => p.url === c.page)?.walked.pageBg ?? canvas;
    if (!has("button-primary"))
      components.push({
        key: namer("button-primary"),
        base: "button-primary",
        kind: "button",
        group: groupOfKind("button"),
        props: propsOf(ctrlLook(c, ground), "button", ground),
        texts: c.text && (!textSet.size || textSet.has(c.text.trim())) ? [c.text.trim()] : [],
        layout: [`height ${r1(c.base.height)}px`, `${c.count} on the page`],
        source: "state",
        crop: { width: c.width, box: c.box, page: c.page },
      });
    addStates("button-primary", "button", c, ground);
    if (cta.disabled && !has("button-primary-disabled")) {
      const base = components.find((x) => x.key === "button-primary")!;
      components.push({
        key: namer("button-primary-disabled"),
        base: "button-primary",
        kind: "button",
        group: base.group,
        props: {
          ...(R.color(cta.disabled, "bg") ? { backgroundColor: R.color(cta.disabled, "bg")! } : {}),
          ...(base.props.rounded ? { rounded: base.props.rounded } : {}),
        },
        texts: [],
        layout: [],
        source: "state",
      });
    }
    const unreached = c.unreached ?? [];
    if (unreached.length)
      gaps.push(
        `The primary button's ${unreached.join(" / ")} state${unreached.length > 1 ? "s were" : " was"} not reached by the capture (no change, script-driven or covered).`,
      );
    if (!c.active && !unreached.includes("active"))
      gaps.push("No pressed state was captured for the primary button.");
  }
  const CTRL_KIND: Record<string, string> = {
    chip: "tag",
    tab: "tabs",
    link: "link",
    input: "input",
    select: "select",
    "icon-button": "icon-button",
    button: "button",
  };
  for (const p of pages)
    for (const c of capOf(p, p.desktop)?.controls ?? []) {
      if (components.length >= COMPONENT_CAP) break;
      const kind = CTRL_KIND[c.kind];
      if (
        !kind ||
        (cta.control && c.key === cta.control.key) ||
        !(c.count >= 2 || c.hover || c.active || c.selected)
      )
        continue;
      const ground = p.walked.pageBg;
      const look = ctrlLook(c, ground);
      const baseKey =
        kind === "button"
          ? componentBase("", "button", {
              button: buttonRole(look.bg, look.border, colors),
              onDark: isDark(ground),
            })
          : componentBase("", kind);
      if (c.selected) {
        const k = `${baseKey}-active`;
        if (!has(k) && has(baseKey))
          components.push({
            key: namer(k),
            base: baseKey,
            kind,
            group: groupOfKind(kind),
            props: propsOf(look, kind, ground),
            texts: [],
            layout: [],
            source: "state",
            crop: { width: p.desktop.width, box: c.box, page: p.url },
          });
        continue;
      }
      if (!has(baseKey))
        components.push({
          key: namer(baseKey),
          base: baseKey,
          kind,
          group: groupOfKind(kind),
          props: propsOf(look, kind, ground),
          texts: c.text && (!textSet.size || textSet.has(c.text.trim())) ? [c.text.trim()] : [],
          layout: [`${c.count} on the page`],
          source: "state",
          crop: { width: p.desktop.width, box: c.box, page: p.url },
        });
      addStates(baseKey, kind, { ...c, page: p.url, width: p.desktop.width }, ground);
    }
  // bands the sets do not cover (a dark hero, a tinted promo band): their background, the copy on them, their padding
  const usedBg = new Set(components.map((c) => c.props.backgroundColor).filter(Boolean));
  const bandSeen: string[] = [];
  for (const p of pages) {
    const sections = capOf(p, p.desktop)?.sections;
    const list = sections?.length
      ? sections.map((s, i) => ({
          bg: toHex(s.background, canvas) ?? undefined,
          pad: [s.paddingTop, 0, s.paddingBottom, 0] as [number, number, number, number],
          top: i <= 1 && s.box.y < 900,
          h: s.box.h,
        }))
      : p.walked.boxes.filter((b) => b.band).map((b, i) => ({ bg: b.bg, pad: b.pad, top: i <= 1, h: b.h }));
    for (const band of list) {
      if (
        !band.bg ||
        band.bg === canvas ||
        band.h < 120 ||
        components.length >= COMPONENT_CAP ||
        bandSeen.some((h) => sameColor(h, band.bg!))
      )
        continue;
      const ref = R.color(band.bg, "bg");
      if (!ref || usedBg.has(ref)) continue;
      bandSeen.push(band.bg);
      const on = p.walked.runs.filter((r) => r.bg === band.bg);
      if (!on.length) continue;
      const big = [...on].sort((a, b) => b.size - a.size)[0]!;
      const kind = band.top ? "hero" : "section";
      const key = namer(
        `${componentBase("", kind)}-${isChromatic(band.bg) ? hueName(band.bg) : isDark(band.bg) ? "dark" : "soft"}`,
      );
      const props: Record<string, string> = { backgroundColor: ref };
      const t = R.color(big.color, "text", band.bg),
        ty = R.type(big.size, big.weight, big.family),
        pad = R.padding(band.pad, true);
      if (t) props.textColor = t;
      if (ty) props.typography = ty;
      if (pad) props.padding = pad;
      usedBg.add(ref);
      components.push({
        key,
        base: key,
        kind,
        group: groupOfKind(kind),
        props,
        texts: uniq(on.map((r) => r.text).filter((x) => !textSet.size || textSet.has(x))).slice(0, 5),
        layout: [
          `band ${Math.round(band.h)}px tall at ${p.desktop.width}px`,
          `on ${pages.filter((q) => q.walked.runs.some((r) => r.bg === band.bg)).length} of ${pages.length} pages`,
        ],
        source: "extracted",
      });
    }
  }
  const GROUPS = [
    "Top Navigation",
    "Buttons",
    "Cards & Containers",
    "Inputs & Forms",
    "Tabs / Tags",
    "Feedback",
    "Brand Signature",
    "CTA / Footer",
  ];
  components.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
  const kinds = new Set(components.filter((c) => c.source !== "generated").map((c) => c.kind));
  if (!["input", "search", "select", "textarea", "form"].some((k) => kinds.has(k)))
    gaps.push("No form or input was captured: input, focus and validation states are not documented.");

  /* images by role */
  const imgRoles = new Map<string, { count: number; aspects: string[] }>();
  const ASPECTS: Array<[number, string]> = [
    [21 / 9, "21:9"],
    [2, "2:1"],
    [16 / 9, "16:9"],
    [3 / 2, "3:2"],
    [4 / 3, "4:3"],
    [1, "1:1"],
    [4 / 5, "4:5"],
    [3 / 4, "3:4"],
    [9 / 16, "9:16"],
  ];
  const aspectOf = (w: number, h: number) => {
    const r = w / (h || 1);
    const hit = ASPECTS.sort((a, b) => Math.abs(a[0] - r) - Math.abs(b[0] - r))[0]!;
    return Math.abs(hit[0] - r) / r < 0.06 ? hit[1] : `${r2(r)}:1`;
  };
  for (const p of pages) {
    const cap = capOf(p, p.desktop);
    if (!cap) continue;
    const W = cap.width;
    const logo = cap.marks.logo?.src;
    const firstBand = cap.sections[0]?.box.h ?? 900;
    const gridSections = new Set(cap.grids.map((g) => g.section).filter((x) => x !== undefined));
    for (const im of cap.images) {
      if (im.box.w < 48 || im.box.h < 32 || (logo && im.src === logo)) continue;
      const role =
        im.box.y < Math.max(firstBand, 400) && im.box.w >= W * 0.6
          ? "hero"
          : im.background && im.box.w >= W * 0.9
            ? "band-background"
            : im.objectFit === "contain"
              ? "product"
              : im.section !== undefined && gridSections.has(im.section)
                ? im.box.w <= 400
                  ? "thumbnail"
                  : "card"
                : im.box.w >= W * 0.4
                  ? "editorial"
                  : im.box.w <= 200
                    ? "thumbnail"
                    : "card";
      const e = imgRoles.get(role) ?? { count: 0, aspects: [] };
      e.count++;
      e.aspects.push(aspectOf(im.box.w, im.box.h));
      imgRoles.set(role, e);
    }
  }
  const images = [...imgRoles]
    .map(([role, e]) => ({ role, count: e.count, aspect: mode(e.aspects) ?? "" }))
    .sort((a, b) => b.count - a.count || (a.role < b.role ? -1 : 1));

  /* gaps from the capture */
  for (const c of caps)
    if (c.overlay)
      gaps.push(
        `A consent / overlay layer still covered part of the page at ${c.width}px (${Math.round(c.overlay.w)}×${Math.round(c.overlay.h)}px).`,
      );
  if (pages.length === 1)
    gaps.push(
      "Only one page was captured: components that live on other pages (forms, filters, spec tables) may be missing.",
    );
  const hosts = uniq(pages.map((p) => originOf(p.url)).filter(Boolean));
  if (hosts.length > 1) gaps.push(`Pages came from ${hosts.length} origins (${hosts.join(", ")}).`);

  /* peers */
  const facts: BrandFacts = {
    version: 1,
    name,
    website,
    capturedAt,
    pages: pages.map((p) => ({
      url: p.url,
      ...(p.title ? { title: p.title } : {}),
      widths: p.screens.map((s) => s.width),
    })),
    colors,
    typography,
    fonts,
    weights: { used: weightsUsed, absent },
    tracking,
    rounded,
    radiusByKind,
    spacing,
    baseUnit,
    sectionRhythm,
    ...(cardPadding !== undefined ? { cardPadding } : {}),
    ...(containerMax !== undefined ? { containerMax } : {}),
    grids,
    breakpoints,
    elevation,
    bands,
    components,
    images,
    peers: [],
    gaps: uniq(gaps),
    texts,
    ...(input.vision ? { vision: input.vision } : {}),
  };
  facts.peers = peerContrasts(facts, peers as PeerBrand[]);
  return facts;
}

/* ------------------------------------------------------------------ peers */

/** Factual contrasts with the example corpus: radius dialect, display weight, weight count, shadows, canvas, accents, rhythm. */
export function peerContrasts(f: BrandFacts, corpus: PeerBrand[]): BrandFacts["peers"] {
  const list = corpus.filter((p) => p.name.toLowerCase() !== f.name.toLowerCase());
  if (!list.length) return [];
  const out: BrandFacts["peers"] = [];
  const names = (ps: PeerBrand[]) => ps.map((p) => p.name);
  const px = (v: number) => (v >= PILL ? "pill" : `${v}px`);
  const control = f.radiusByKind.button ?? f.radiusByKind.link ?? f.rounded[0]?.value;
  if (control !== undefined) {
    const m = median(list.map((p) => p.dominantRadius));
    const rounder = list.filter((p) => p.dominantRadius > control),
      squarer = list.filter((p) => p.dominantRadius < control);
    out.push({
      metric: "control-radius",
      value: px(control),
      peerMedian: px(m),
      peers: names(control < m ? rounder : squarer),
      claim:
        control === m
          ? `Control radius ${px(control)} matches the peer median.`
          : control < m
            ? `Control radius ${px(control)} is squarer than the peer median ${px(m)}.`
            : `Control radius ${px(control)} is rounder than the peer median ${px(m)}.`,
    });
  }
  const display = f.typography.find((t) => t.key.startsWith("display"))?.fontWeight;
  if (display) {
    const m = median(list.map((p) => p.displayWeight));
    out.push({
      metric: "display-weight",
      value: display,
      peerMedian: m,
      peers: names(list.filter((p) => (display > m ? p.displayWeight < display : p.displayWeight > display))),
      claim:
        display === m
          ? `Display weight ${display} matches the peer median.`
          : `Display weight ${display} is ${display > m ? "heavier" : "lighter"} than the peer median ${m}.`,
    });
  }
  if (f.weights.used.length) {
    const n = f.weights.used.length,
      m = median(list.map((p) => p.weights.length));
    out.push({
      metric: "weight-count",
      value: n,
      peerMedian: m,
      peers: names(list.filter((p) => p.weights.length !== n)),
      claim:
        n === m
          ? `${n} weights in use, like the peer median.`
          : `${n} weights in use against a peer median of ${m}.`,
    });
  }
  const shadows = f.elevation.shadows.length > 0;
  const withShadows = list.filter((p) => p.shadows);
  out.push({
    metric: "shadows",
    value: shadows ? "yes" : "none",
    peerMedian: `${withShadows.length} of ${list.length}`,
    peers: names(shadows ? list.filter((p) => !p.shadows) : withShadows),
    claim: shadows
      ? `Uses drop shadows; ${withShadows.length} of ${list.length} peers do.`
      : `No drop shadows; ${list.length - withShadows.length} of ${list.length} peers also go without.`,
  });
  const canvas = f.colors.find((c) => c.key === "canvas");
  if (canvas) {
    const darkCanvas = isDark(canvas.hex);
    const same = list.filter((p) => p.canvasDark === darkCanvas);
    out.push({
      metric: "canvas",
      value: darkCanvas ? "dark" : "light",
      peerMedian: `${list.filter((p) => p.canvasDark).length} of ${list.length} dark`,
      peers: names(same),
      claim: `${darkCanvas ? "Dark" : "Light"} canvas (${canvas.hex}), like ${same.length} of ${list.length} peers.`,
    });
  }
  const accents = f.colors.filter((c) => c.group === "accent").length,
    am = median(list.map((p) => p.accentCount));
  out.push({
    metric: "accent-count",
    value: accents,
    peerMedian: am,
    peers: names(list.filter((p) => (accents > am ? p.accentCount < accents : p.accentCount > accents))),
    claim:
      accents === am
        ? `${accents} accent colours, like the peer median.`
        : `${accents} accent colour${accents === 1 ? "" : "s"} against a peer median of ${am}.`,
  });
  if (f.sectionRhythm) {
    const m = median(list.map((p) => p.sectionRhythm));
    out.push({
      metric: "section-rhythm",
      value: `${f.sectionRhythm}px`,
      peerMedian: `${m}px`,
      peers: names(
        list.filter((p) =>
          f.sectionRhythm > m ? p.sectionRhythm < f.sectionRhythm : p.sectionRhythm > f.sectionRhythm,
        ),
      ),
      claim:
        f.sectionRhythm === m
          ? `Section rhythm ${f.sectionRhythm}px matches the peer median.`
          : `Section rhythm ${f.sectionRhythm}px is ${f.sectionRhythm > m ? "looser" : "tighter"} than the peer median ${m}px.`,
    });
  }
  return out;
}
