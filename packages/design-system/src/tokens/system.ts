import type { BrandSpec } from "../spec.js";
import { contrast, hexToOklch, mix, oklchToHex, onColor, type Oklch } from "./color.js";

/* ------------------------------------------------------------------ palettes */

export const STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;
export type Step = (typeof STEPS)[number];
export type Palette = Record<Step, string>;

/** OKLCH lightness per step (10 lightest … 100 darkest), close to Carbon's ramp. */
const TARGET_L = [0.965, 0.905, 0.825, 0.735, 0.645, 0.555, 0.47, 0.39, 0.305, 0.215];

/**
 * A ten-step palette around `base`. The base keeps its exact value at the step whose lightness is nearest; the
 * other steps follow the target ramp, pulled towards the base near it so the ramp stays monotonic and even.
 */
export function palette(base: string, o: { maxChroma?: number } = {}): { steps: Palette; baseStep: Step } {
  const b = hexToOklch(base);
  let k = 0;
  for (let i = 1; i < TARGET_L.length; i++)
    if (Math.abs(TARGET_L[i]! - b.l) < Math.abs(TARGET_L[k]! - b.l)) k = i;
  const shift = b.l - TARGET_L[k]!;
  const chroma = Math.min(b.c, o.maxChroma ?? 1);
  const steps = {} as Palette;
  TARGET_L.forEach((t, i) => {
    const dist = Math.abs(i - k);
    const l = t + shift * Math.max(0, 1 - dist / 3);
    // chroma eases off towards white and black, as real tonal ramps do
    const c = chroma * Math.max(0.18, 1 - Math.abs(l - b.l) * 1.15);
    const step = STEPS[i]!;
    steps[step] = i === k && !o.maxChroma ? base.toLowerCase() : oklchToHex({ l, c, h: b.h } as Oklch);
  });
  return { steps, baseStep: STEPS[k]! };
}

const STATUS_DEFAULTS = {
  red: { l: 0.56, c: 0.2, h: 25 },
  green: { l: 0.58, c: 0.15, h: 150 },
  yellow: { l: 0.84, c: 0.16, h: 88 },
  blue: { l: 0.56, c: 0.18, h: 258 },
} as const;

/* ------------------------------------------------------------------ semantic tokens */

export const THEMES = ["light", "light-alt", "dark", "darkest"] as const;
export type ThemeName = (typeof THEMES)[number];
export const THEME_LABELS: Record<ThemeName, string> = {
  light: "Light",
  "light-alt": "Light alt",
  dark: "Dark",
  darkest: "Darkest",
};

export const SEMANTIC_TOKENS = [
  "background",
  "background-hover",
  "background-active",
  "background-inverse",
  "background-brand",
  "layer-01",
  "layer-01-hover",
  "layer-01-active",
  "layer-02",
  "layer-02-hover",
  "layer-02-active",
  "layer-03",
  "layer-accent-01",
  "field-01",
  "field-02",
  "field-hover",
  "border-subtle-01",
  "border-strong-01",
  "border-interactive",
  "border-disabled",
  "text-primary",
  "text-secondary",
  "text-placeholder",
  "text-helper",
  "text-error",
  "text-on-color",
  "text-inverse",
  "text-disabled",
  "link-primary",
  "link-primary-hover",
  "link-visited",
  "icon-primary",
  "icon-secondary",
  "icon-on-color",
  "icon-disabled",
  "interactive",
  "button-primary",
  "button-primary-hover",
  "button-primary-active",
  "button-primary-text",
  "button-secondary",
  "button-secondary-hover",
  "button-secondary-active",
  "button-secondary-text",
  "button-secondary-border",
  "button-tertiary",
  "button-tertiary-hover",
  "button-tertiary-text",
  "button-danger",
  "button-danger-hover",
  "button-danger-active",
  "button-danger-text",
  "button-disabled",
  "support-error",
  "support-success",
  "support-warning",
  "support-info",
  "support-error-subtle",
  "support-success-subtle",
  "support-warning-subtle",
  "support-info-subtle",
  "focus",
  "focus-inset",
  "overlay",
  "skeleton",
  "highlight",
  "toggle-off",
  "shadow",
] as const;
export type SemanticToken = (typeof SEMANTIC_TOKENS)[number];
export type Theme = Record<SemanticToken, string>;

export interface ContrastCheck {
  theme: ThemeName;
  fg: SemanticToken;
  bg: SemanticToken;
  ratio: number;
  min: number;
  pass: boolean;
}

/** The pairs every theme must pass (fg, bg, minimum ratio). */
export const CONTRAST_PAIRS: Array<[SemanticToken, SemanticToken, number]> = [
  ["text-primary", "background", 4.5],
  ["text-primary", "layer-01", 4.5],
  ["text-primary", "field-01", 4.5],
  ["text-secondary", "background", 4.5],
  ["text-secondary", "layer-01", 4.5],
  ["text-helper", "background", 4.5],
  ["text-error", "background", 4.5],
  ["link-primary", "background", 4.5],
  ["link-primary", "layer-01", 4.5],
  ["button-primary-text", "button-primary", 4.5],
  ["button-primary-text", "button-primary-hover", 4.5],
  ["button-secondary-text", "button-secondary", 4.5],
  ["button-tertiary-text", "background", 4.5],
  ["button-danger-text", "button-danger", 4.5],
  ["text-on-color", "interactive", 4.5],
  ["text-on-color", "background-brand", 4.5],
  ["text-inverse", "background-inverse", 4.5],
  ["focus", "background", 3],
  ["border-strong-01", "background", 3],
  ["border-interactive", "background", 3],
  ["support-error", "background", 3],
  ["support-success", "background", 3],
  ["support-info", "background", 3],
  ["icon-primary", "background", 4.5],
  ["icon-secondary", "background", 3],
  ["text-primary", "support-error-subtle", 4.5],
  ["text-primary", "support-success-subtle", 4.5],
  ["text-primary", "support-warning-subtle", 4.5],
  ["text-primary", "support-info-subtle", 4.5],
];

export interface TypeToken {
  size: number;
  weight: number;
  lineHeight: number;
  letterSpacing: number;
  family: "sans" | "mono" | "display";
}

export interface TokenSystem {
  spec: BrandSpec;
  palettes: Record<string, Palette>;
  /** step of each palette that holds the brand colour as given */
  baseSteps: Record<string, Step>;
  themes: Record<ThemeName, Theme>;
  defaultTheme: ThemeName;
  fonts: { sans: string; mono: string; display: string };
  type: Record<string, TypeToken>;
  spacing: Record<string, number>;
  sizes: Record<"sm" | "md" | "lg", number>;
  radii: Record<"control" | "field" | "container" | "pill", number>;
  shadows: Record<"01" | "02" | "03", string>;
  motion: { durations: Record<string, number>; easings: Record<string, string> };
  breakpoints: Record<"sm" | "md" | "lg" | "xlg" | "max", { width: number; columns: number }>;
  contrast: ContrastCheck[];
}

const FALLBACK_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FALLBACK_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** A font stack: the family (quoted when it has spaces) and system fallbacks. */
export function fontStack(family: string, mono = false): string {
  const fam = /[\s]/.test(family) ? `"${family}"` : family;
  return `${fam}, ${mono ? FALLBACK_MONO : FALLBACK_SANS}`;
}

/** Make `fg` readable on `bg`: walk its palette away from bg, then fall back to black / white. */
function readable(fg: string, bg: string, min: number, pal?: Palette): string {
  if (contrast(fg, bg) >= min) return fg;
  if (pal) {
    const bgDark = contrast(bg, "#ffffff") > contrast(bg, "#000000");
    const order = bgDark ? [...STEPS] : [...STEPS].reverse(); // towards white on dark, black on light
    let best = fg;
    for (const s of order) {
      const c = pal[s];
      if (contrast(c, bg) >= min) {
        // the passing step nearest to the original colour
        if (
          best === fg ||
          Math.abs(hexToOklch(c).l - hexToOklch(fg).l) < Math.abs(hexToOklch(best).l - hexToOklch(fg).l)
        )
          best = c;
      }
    }
    if (contrast(best, bg) >= min) return best;
  }
  return onColor(bg);
}

/** A filled surface (button, badge) and its text: keep the fill when black or white text reads; else move the fill. */
function filled(fill: string, pal: Palette, dark: boolean): { bg: string; text: string } {
  const text = onColor(fill);
  if (contrast(fill, text) >= 4.5) return { bg: fill, text };
  const order = dark ? [...STEPS] : [...STEPS];
  let best: { bg: string; text: string } | undefined;
  for (const s of order) {
    const c = pal[s];
    const t = onColor(c);
    if (contrast(c, t) >= 4.5) {
      const d = Math.abs(hexToOklch(c).l - hexToOklch(fill).l);
      if (!best || d < Math.abs(hexToOklch(best.bg).l - hexToOklch(fill).l)) best = { bg: c, text: t };
    }
  }
  return best ?? { bg: dark ? pal[20] : pal[80], text: dark ? "#000000" : "#ffffff" };
}

const alpha = (hex: string, a: number) =>
  `${hex}${Math.round(a * 255)
    .toString(16)
    .padStart(2, "0")}`;

function buildTheme(name: ThemeName, p: Record<string, Palette>, base: Record<string, Step>): Theme {
  const g = p.gray!,
    pr = p.primary!,
    red = p.red!,
    green = p.green!,
    yellow = p.yellow!,
    blue = p.blue!;
  const dark = name === "dark" || name === "darkest";
  const brand = pr[base.primary!];
  const step = (s: number) => STEPS[Math.max(0, Math.min(9, s / 10 - 1))]!;
  const near = (s: Step, d: number) => step(Math.max(10, Math.min(100, s + d * 10)));

  // page and layers
  const bgs: Record<ThemeName, [string, string, string, string]> = {
    light: ["#ffffff", g[10], "#ffffff", g[10]],
    "light-alt": [g[10], "#ffffff", g[10], "#ffffff"],
    dark: [g[90], g[80], g[70], g[60]],
    darkest: [g[100], g[90], g[80], g[70]],
  };
  const [background, layer01, layer02, layer03] = bgs[name];
  const hover = (c: string) => mix(c, dark ? "#ffffff" : "#000000", dark ? 0.08 : 0.05);
  const active = (c: string) => mix(c, dark ? "#ffffff" : "#000000", dark ? 0.16 : 0.12);

  // the primary button keeps the brand colour where black or white text reads on it
  const prim = dark
    ? filled(contrast(brand, background) >= 3 ? brand : pr[40], pr, true)
    : filled(brand, pr, false);
  const primStep = (STEPS.find((s) => pr[s] === prim.bg) ?? base.primary!) as Step;
  const primHover = pr[near(primStep, dark ? -1 : 1)];
  const primActive = pr[near(primStep, dark ? -2 : 2)];
  const danger = filled(red[dark ? 50 : 60], red, dark);

  const t = {} as Theme;
  Object.assign(t, {
    background,
    "background-hover": hover(background),
    "background-active": active(background),
    "background-inverse": dark ? g[10] : g[80],
    "background-brand": prim.bg,
    "layer-01": layer01,
    "layer-01-hover": hover(layer01),
    "layer-01-active": active(layer01),
    "layer-02": layer02,
    "layer-02-hover": hover(layer02),
    "layer-02-active": active(layer02),
    "layer-03": layer03,
    "layer-accent-01": dark ? g[70] : g[20],
    "field-01": dark ? layer01 : layer01 === "#ffffff" ? g[10] : layer01,
    "field-02": dark ? g[70] : "#ffffff",
    "field-hover": hover(dark ? layer01 : g[10]),
    "border-subtle-01": dark ? g[70] : g[20],
    "border-strong-01": dark ? g[50] : g[50],
    "border-interactive": dark ? pr[40] : pr[base.primary! >= 50 ? base.primary! : 60],
    "border-disabled": dark ? g[70] : g[30],
    "text-primary": dark ? g[10] : g[100],
    "text-secondary": dark ? g[30] : g[70],
    "text-placeholder": dark ? g[50] : g[50],
    "text-helper": dark ? g[40] : g[60],
    "text-error": dark ? red[40] : red[60],
    "text-on-color": "#ffffff",
    "text-inverse": dark ? g[100] : "#ffffff",
    "text-disabled": dark ? g[60] : g[40],
    "link-primary": dark ? pr[40] : pr[base.primary! >= 60 ? base.primary! : 60],
    "link-primary-hover": dark ? pr[30] : pr[base.primary! >= 60 ? near(base.primary!, 1) : 70],
    "link-visited": dark ? mix(pr[40], "#a56eff", 0.5) : mix(pr[60], "#8a3ffc", 0.5),
    "icon-primary": dark ? g[10] : g[100],
    "icon-secondary": dark ? g[30] : g[70],
    "icon-on-color": "#ffffff",
    "icon-disabled": dark ? g[60] : g[40],
    interactive: dark ? pr[40] : prim.bg,
    "button-primary": prim.bg,
    "button-primary-hover": primHover,
    "button-primary-active": primActive,
    "button-primary-text": prim.text,
    "button-secondary": dark ? g[60] : g[80],
    "button-secondary-hover": dark ? g[50] : g[70],
    "button-secondary-active": dark ? g[40] : g[60],
    "button-secondary-text": "#ffffff",
    "button-secondary-border": "transparent",
    "button-tertiary": dark ? pr[30] : prim.bg,
    "button-tertiary-hover": dark ? pr[20] : primHover,
    "button-tertiary-text": dark ? pr[30] : prim.bg,
    "button-danger": danger.bg,
    "button-danger-hover": red[near((STEPS.find((s) => red[s] === danger.bg) ?? 60) as Step, dark ? -1 : 1)],
    "button-danger-active": red[near((STEPS.find((s) => red[s] === danger.bg) ?? 60) as Step, dark ? -2 : 2)],
    "button-danger-text": danger.text,
    "button-disabled": dark ? g[70] : g[30],
    "support-error": dark ? red[50] : red[60],
    "support-success": dark ? green[40] : green[60],
    "support-warning": yellow[30],
    "support-info": dark ? blue[50] : blue[70],
    "support-error-subtle": dark ? mix(red[90], g[90], 0.4) : red[10],
    "support-success-subtle": dark ? mix(green[90], g[90], 0.4) : green[10],
    "support-warning-subtle": dark ? mix(yellow[90], g[90], 0.4) : yellow[10],
    "support-info-subtle": dark ? mix(blue[90], g[90], 0.4) : blue[10],
    focus: dark ? "#ffffff" : prim.bg,
    "focus-inset": dark ? g[100] : "#ffffff",
    overlay: alpha(g[100], dark ? 0.7 : 0.5),
    skeleton: dark ? g[80] : g[20],
    highlight: dark ? pr[80] : pr[10],
    "toggle-off": dark ? g[60] : g[50],
    shadow: alpha("#000000", dark ? 0.8 : 0.3),
  });

  // contrast: move what fails, in the order a reader notices it
  for (const [fg, bg, min] of CONTRAST_PAIRS) {
    if (fg === "button-primary-text" || fg === "button-danger-text") continue; // chosen with their fills
    const pal =
      fg.startsWith("link") || fg === "border-interactive" || fg === "button-tertiary-text"
        ? pr
        : fg === "text-error" || fg === "support-error"
          ? red
          : fg === "support-success"
            ? green
            : fg === "support-info"
              ? blue
              : fg === "focus"
                ? pr
                : fg.startsWith("text-on-color") || fg === "text-inverse"
                  ? undefined
                  : g;
    t[fg] = readable(t[fg], t[bg], min, pal);
  }
  if (contrast(t["text-on-color"], t.interactive) < 4.5) t["text-on-color"] = onColor(t.interactive);
  if (contrast(t["text-on-color"], t["background-brand"]) < 4.5) t["background-brand"] = t.interactive;
  if (contrast(t["button-primary-text"], t["button-primary-hover"]) < 4.5)
    t["button-primary-hover"] = mix(
      t["button-primary"],
      t["button-primary-text"] === "#ffffff" ? "#000000" : "#ffffff",
      0.1,
    );
  t["button-tertiary"] = t["button-tertiary-text"];
  t["icon-on-color"] = t["text-on-color"];
  return t;
}

/* ------------------------------------------------------------------ type, spacing, motion */

function typeScale(spec: BrandSpec): Record<string, TypeToken> {
  const ratio = spec.density === "compact" ? 1.2 : 1.25;
  const body = Math.min(18, Math.max(14, spec.typeScale?.body ?? 16));
  const s = (n: number) => Math.round(body * ratio ** n);
  const read = spec.typeScale ?? {};
  const h = (role: keyof NonNullable<BrandSpec["typeScale"]>, fallback: number) =>
    Math.round(Math.min(96, Math.max(12, read[role] ?? fallback)));
  const lh = (size: number) => (size >= 32 ? 1.2 : size >= 20 ? 1.3 : 1.5);
  const tok = (size: number, weight: number, family: TypeToken["family"] = "sans", ls = 0): TypeToken => ({
    size,
    weight,
    lineHeight: lh(size),
    letterSpacing: size >= 32 ? -0.01 : ls,
    family,
  });
  const display = spec.fonts.display ? "display" : "sans";
  return {
    "label-01": tok(12, 400, "sans", 0.02),
    "helper-text-01": tok(12, 400),
    "body-compact-01": { ...tok(14, 400), lineHeight: 1.29 },
    "body-compact-02": { ...tok(body, 400), lineHeight: 1.375 },
    "body-01": tok(14, 400),
    "body-02": tok(body, 400),
    "code-01": tok(12, 400, "mono", 0.02),
    "code-02": tok(14, 400, "mono"),
    "heading-compact-01": { ...tok(14, 600), lineHeight: 1.29 },
    "heading-compact-02": { ...tok(body, 600), lineHeight: 1.375 },
    "heading-01": tok(14, 600),
    "heading-02": tok(body, 600),
    "heading-03": tok(h("h4", s(1)), 500, display),
    "heading-04": tok(h("h3", s(2)), 500, display),
    "heading-05": tok(h("h2", s(3)), 500, display),
    "heading-06": tok(h("h1", s(4)), 400, display),
    "display-01": tok(h("display", s(5)), 400, display),
    "display-02": tok(Math.round(h("display", s(5)) * 1.25), 300, display),
  };
}

const SPACING_BASE = [2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 160];

export function buildTokenSystem(spec: BrandSpec): TokenSystem {
  const primary = spec.colors.primary;
  const pPrim = palette(primary);
  const palettes: Record<string, Palette> = { primary: pPrim.steps };
  const baseSteps: Record<string, Step> = { primary: pPrim.baseStep };
  for (const k of ["secondary", "accent"] as const) {
    const c = spec.colors[k];
    if (c) {
      const p = palette(c);
      palettes[k] = p.steps;
      baseSteps[k] = p.baseStep;
    }
  }
  // greys lean slightly towards the brand (or the given tint)
  const tint = hexToOklch(spec.colors.neutralTint ?? primary);
  palettes.gray = palette(
    oklchToHex({ l: 0.555, c: Math.min(tint.c, spec.colors.neutralTint ? 0.03 : 0.012), h: tint.h }),
    {
      maxChroma: spec.colors.neutralTint ? 0.03 : 0.012,
    },
  ).steps;
  const status: Record<"red" | "green" | "yellow" | "blue", string | undefined> = {
    red: spec.colors.danger,
    green: spec.colors.success,
    yellow: spec.colors.warning,
    blue: spec.colors.info,
  };
  for (const [k, given] of Object.entries(status)) {
    const d = STATUS_DEFAULTS[k as keyof typeof STATUS_DEFAULTS];
    const p = palette(given ?? oklchToHex(d));
    palettes[k] = p.steps;
    baseSteps[k] = p.baseStep;
  }
  const themes = Object.fromEntries(THEMES.map((n) => [n, buildTheme(n, palettes, baseSteps)])) as Record<
    ThemeName,
    Theme
  >;
  const contrastChecks: ContrastCheck[] = [];
  for (const n of THEMES)
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      const ratio = Math.round(contrast(themes[n][fg], themes[n][bg]) * 100) / 100;
      contrastChecks.push({ theme: n, fg, bg, ratio, min, pass: ratio >= min });
    }
  const factor = spec.density === "compact" ? 0.875 : spec.density === "spacious" ? 1.125 : 1;
  const spacing = Object.fromEntries(
    SPACING_BASE.map((v, i) => [
      `spacing-${String(i + 1).padStart(2, "0")}`,
      Math.max(1, Math.round(v * factor)),
    ]),
  );
  const md = spec.controlHeight;
  const shadowSets = {
    none: ["none", "none", "none"],
    soft: ["0 1px 2px var(--SHADOW)", "0 2px 6px var(--SHADOW)", "0 8px 24px var(--SHADOW)"],
    strong: ["0 2px 4px var(--SHADOW)", "0 4px 12px var(--SHADOW)", "0 12px 32px var(--SHADOW)"],
  }[spec.elevation];
  return {
    spec,
    palettes,
    baseSteps,
    themes,
    defaultTheme: spec.theme === "dark" ? "darkest" : "light",
    fonts: {
      sans: spec.fonts.sans,
      mono: spec.fonts.mono ?? "JetBrains Mono",
      display: spec.fonts.display ?? spec.fonts.sans,
    },
    type: typeScale(spec),
    spacing,
    sizes: { sm: Math.max(24, md - 8), md, lg: md + 8 },
    // fields stay rectangular-ish even for pill-shaped buttons (a fully rounded text field clips its text)
    radii: {
      control: spec.radius.control,
      field: Math.min(spec.radius.control, 8),
      container: spec.radius.container,
      pill: 999,
    },
    shadows: { "01": shadowSets[0]!, "02": shadowSets[1]!, "03": shadowSets[2]! },
    motion: {
      durations: {
        "fast-01": 70,
        "fast-02": 110,
        "moderate-01": 150,
        "moderate-02": 240,
        "slow-01": 400,
        "slow-02": 700,
      },
      easings: {
        "standard-productive": "cubic-bezier(0.2, 0, 0.38, 0.9)",
        "entrance-productive": "cubic-bezier(0, 0, 0.38, 0.9)",
        "exit-productive": "cubic-bezier(0.2, 0, 1, 0.9)",
        "standard-expressive": "cubic-bezier(0.4, 0.14, 0.3, 1)",
        "entrance-expressive": "cubic-bezier(0, 0, 0.3, 1)",
        "exit-expressive": "cubic-bezier(0.4, 0.14, 1, 1)",
      },
    },
    breakpoints: {
      sm: { width: 320, columns: 4 },
      md: { width: 672, columns: 8 },
      lg: { width: 1056, columns: 16 },
      xlg: { width: 1312, columns: 16 },
      max: { width: 1584, columns: 16 },
    },
    contrast: contrastChecks,
  };
}
