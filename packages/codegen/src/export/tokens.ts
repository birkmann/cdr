// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Design tokens → CSS custom properties / W3C-style JSON / Tailwind config. Also resolves `var(--t-*)` to literals.
import type { SceneTokens } from "@harness/protocol";
import {
  resolveTokens,
  tokensToCssVars,
  COLOR_TOKEN_KEYS,
  kebab,
  cssStr,
  safeFontWeight,
  safeUnicodeRange,
} from "@harness/scene";

export type VarMap = Record<string, string>;

/** All `--t-*` custom properties for a design system. */
export function tokenVars(tokens: Partial<SceneTokens> | undefined): VarMap {
  return tokensToCssVars(resolveTokens(tokens));
}

/** Replace `var(--t-x)` / `var(--t-x, fallback)` with the literal value (recursively, for nested vars). */
export function resolveVars(value: string, vars: VarMap): string {
  let out = value;
  for (let i = 0; i < 4 && out.includes("var(--"); i++) {
    out = out.replace(
      /var\((--[a-zA-Z0-9-_]+)(?:\s*,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g,
      (m, name: string, fb?: string) => vars[name] ?? (fb !== undefined ? fb.trim() : m),
    );
  }
  return out;
}

export interface FontFace {
  family: string;
  file: string;
  weight?: string;
  style?: string;
  format?: string;
  unicodeRange?: string;
}

const FONT_FORMATS = new Set([
  "woff2",
  "woff",
  "truetype",
  "opentype",
  "embedded-opentype",
  "svg",
  "collection",
]);

/** `:root { --t-…: … }` (+ optional @font-face rules for bundled fonts). */
export function tokensCss(vars: VarMap, fonts: FontFace[] = []): string {
  const faces = fonts
    .map(
      (f) =>
        // family, file and the descriptors come from captured stylesheets / project fonts: escaped or validated
        `@font-face {\n  font-family: ${cssStr(f.family)};\n  src: url(${cssStr(f.file)}) format('${FONT_FORMATS.has(f.format ?? "") ? f.format : "woff2"}');\n  font-weight: ${safeFontWeight(f.weight ?? "100 900") ?? "400"};\n  font-style: ${/^(italic|oblique)$/.test(f.style ?? "") ? f.style : "normal"};\n${safeUnicodeRange(f.unicodeRange) ? `  unicode-range: ${safeUnicodeRange(f.unicodeRange)};\n` : ""}  font-display: swap;\n}\n`,
    )
    .join("");
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `/* Design tokens. Every colour, radius, shadow and font in styles.css points here. */\n${faces}${faces ? "\n" : ""}:root {\n${body}\n}\n`;
}

/** Design tokens as JSON (W3C design-tokens community format: `$value` / `$type`). */
export function tokensJson(tokens: Partial<SceneTokens> | undefined, name = "Design system"): string {
  const t = resolveTokens(tokens);
  const vars = tokensToCssVars(t);
  const color: Record<string, { $value: string; $type: "color" }> = {};
  for (const k of COLOR_TOKEN_KEYS) {
    const v = t[k];
    if (v) color[kebab(k)] = { $value: v, $type: "color" };
  }
  for (const k of [
    "primary-fg",
    "primary-hover",
    "primary-soft",
    "primary-strong",
    "surface-hover",
    "danger-fg",
  ]) {
    const v = vars[`--t-${k}`];
    if (v) color[k] = { $value: v, $type: "color" };
  }
  const doc = {
    $description: `${name} — design tokens`,
    theme: { $value: t.theme, $type: "string" },
    color,
    radius: { sm: dim(vars["--t-radius-sm"]), md: dim(vars["--t-radius"]), lg: dim(vars["--t-radius-lg"]) },
    spacing: { base: dim(vars["--t-spacing"]) },
    font: {
      sans: { $value: t.fontFamily, $type: "fontFamily" },
      mono: { $value: t.fontMono ?? "JetBrains Mono", $type: "fontFamily" },
    },
    shadow: {
      sm: str(vars["--t-shadow-sm"]),
      md: str(vars["--t-shadow-md"]),
      lg: str(vars["--t-shadow-lg"]),
      glow: str(vars["--t-shadow-glow"]),
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
const dim = (v: string | undefined) => ({ $value: v ?? "0px", $type: "dimension" as const });
const str = (v: string | undefined) => ({ $value: v ?? "none", $type: "shadow" as const });

/** Colour token names usable as Tailwind colours (`--t-text-muted` → `text-muted`). */
export function tailwindColorNames(vars: VarMap): string[] {
  return Object.keys(vars)
    .filter((k) => k.startsWith("--t-") && isColorVar(k, vars[k] ?? ""))
    .map((k) => k.slice(4));
}
const isColorVar = (k: string, v: string) =>
  !/radius|spacing|font|shadow|scheme/.test(k) && /^(#|rgb|hsl|color-mix|transparent)/.test(v.trim());

/** `tailwind.config.js` exposing the tokens (as CSS variables, or literal values when `cssVars` is off). */
export function tailwindConfig(vars: VarMap, cssVars: boolean): string {
  const val = (k: string) => (cssVars ? `var(${k})` : (vars[k] ?? ""));
  const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const colors = tailwindColorNames(vars)
    .map((n) => `        ${/^[a-z][a-z0-9]*$/.test(n) ? n : q(n)}: ${q(val(`--t-${n}`))},`)
    .join("\n");
  return `/** @type {import('tailwindcss').Config} — design tokens */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
${colors}
      },
      borderRadius: {
        DEFAULT: ${q(val("--t-radius"))},
        sm: ${q(val("--t-radius-sm"))},
        lg: ${q(val("--t-radius-lg"))},
      },
      spacing: {
        unit: ${q(val("--t-spacing"))},
      },
      fontFamily: {
        sans: [${q(val("--t-font"))}],
        mono: [${q(val("--t-font-mono"))}],
      },
      boxShadow: {
        sm: ${q(val("--t-shadow-sm"))},
        md: ${q(val("--t-shadow-md"))},
        lg: ${q(val("--t-shadow-lg"))},
        glow: ${q(val("--t-shadow-glow"))},
      },
    },
  },
  plugins: [],
}
`;
}
