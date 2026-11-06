// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Tokens → CSS custom properties, `$token` resolution and text-style presets shared by the renderer and toHtml.
import { DEFAULT_TOKENS, type SceneTokens } from "@harness/protocol";
import { fontStack } from "./fontStack.js";
import { alpha, isCssColor, isDark, onColor, shade } from "./color.js";

/** Token names that may be referenced as `$name` in colour fields. */
export const COLOR_TOKEN_KEYS = [
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
] as const;
export type ColorTokenKey = (typeof COLOR_TOKEN_KEYS)[number];

/** Aliases the model tends to use → canonical token. */
const TOKEN_ALIASES: Record<string, ColorTokenKey> = {
  bg: "background",
  page: "background",
  "background-color": "background",
  card: "surface",
  sheet: "surface",
  "surface-alt": "surfaceAlt",
  surface2: "surfaceAlt",
  surfacealt: "surfaceAlt",
  muted: "textMuted",
  "text-muted": "textMuted",
  textmuted: "textMuted",
  secondarytext: "textMuted",
  foreground: "text",
  fg: "text",
  brand: "primary",
  error: "danger",
  destructive: "danger",
  red: "danger",
  green: "success",
  amber: "warning",
  orange: "warning",
  divider: "border",
  outline: "border",
  stroke: "border",
  line: "border",
  onprimary: "background",
  "on-primary": "background",
};

export const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).replace(/_/g, "-");

/** Merge design-system tokens with screen overrides and fill gaps from defaults. */
export function resolveTokens(
  base: Partial<SceneTokens> | undefined,
  overrides?: Partial<SceneTokens>,
): SceneTokens {
  const t: SceneTokens = {
    ...DEFAULT_TOKENS,
    ...stripUndefined(base ?? {}),
    ...stripUndefined(overrides ?? {}),
  };
  // derive optional colours when missing so every `$token` has a value
  t.secondary ??= shade(t.primary, isDark(t.background) ? 0.12 : -0.12);
  t.accent ??= t.secondary;
  t.surfaceAlt ??= shade(t.surface, isDark(t.background) ? 0.05 : -0.04);
  t.success ??= DEFAULT_TOKENS.success;
  t.warning ??= DEFAULT_TOKENS.warning;
  t.danger ??= DEFAULT_TOKENS.danger;
  t.fontMono ??= DEFAULT_TOKENS.fontMono;
  return t;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o))
    if (v !== undefined && v !== null && v !== "") (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Canonical token key for `$name` / `name`, or null if unknown. */
export function tokenKeyOf(ref: string): ColorTokenKey | null {
  const raw = ref.replace(/^\$/, "").trim();
  if ((COLOR_TOKEN_KEYS as readonly string[]).includes(raw)) return raw as ColorTokenKey;
  const alias = TOKEN_ALIASES[raw.toLowerCase()] ?? TOKEN_ALIASES[raw.toLowerCase().replace(/[-_\s]/g, "")];
  return alias ?? null;
}

export const isTokenRef = (v: string) => v.trim().startsWith("$");

/**
 * Resolve a DSL colour to CSS. `$primary` → `var(--t-primary)`; literals pass through; unknown tokens → `fallback`.
 * Supports an alpha suffix: `$primary/20` → 20% primary (computed from the concrete token value).
 */
export function cssColor(
  value: string | undefined,
  tokens: SceneTokens,
  fallback?: string,
): string | undefined {
  if (!value) return fallback;
  const v = value.trim();
  if (isTokenRef(v)) {
    const [name, pct] = v.split("/");
    const key = tokenKeyOf(name ?? "");
    if (!key) return fallback;
    if (pct !== undefined) {
      const a = Number(pct);
      const concrete = tokens[key] ?? DEFAULT_TOKENS.primary;
      return Number.isFinite(a) ? alpha(concrete, a > 1 ? a / 100 : a) : `var(--t-${kebab(key)})`;
    }
    return `var(--t-${kebab(key)})`;
  }
  if (isCssColor(v) || v.includes("gradient(") || v === "transparent" || v === "none") return v;
  return fallback;
}

/** Concrete (non-var) value of a colour, for maths like on-colour / shades. */
export function concreteColor(value: string | undefined, tokens: SceneTokens, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  if (isTokenRef(v)) {
    const key = tokenKeyOf(v.split("/")[0] ?? "");
    return key ? (tokens[key] ?? fallback) : fallback;
  }
  return isCssColor(v) ? v : fallback;
}

/** Custom properties for a screen root. Includes derived shades so hover/soft states need no JS. */
export function tokensToCssVars(t: SceneTokens): Record<string, string> {
  const dark = isDark(t.background);
  const vars: Record<string, string> = {};
  for (const key of COLOR_TOKEN_KEYS) {
    const v = t[key];
    if (v) vars[`--t-${kebab(key)}`] = v;
  }
  vars["--t-primary-fg"] = onColor(t.primary);
  vars["--t-primary-hover"] = shade(t.primary, dark ? 0.06 : -0.06);
  vars["--t-primary-soft"] = alpha(t.primary, dark ? 0.18 : 0.12);
  vars["--t-primary-strong"] = shade(t.primary, dark ? 0.14 : -0.16);
  vars["--t-surface-hover"] = shade(t.surface, dark ? 0.04 : -0.03);
  vars["--t-danger-fg"] = onColor(t.danger ?? DEFAULT_TOKENS.danger!);
  vars["--t-radius"] = `${t.radius}px`;
  vars["--t-radius-sm"] = `${Math.round(t.radius * 0.6)}px`;
  vars["--t-radius-lg"] = `${Math.round(t.radius * 1.5)}px`;
  vars["--t-spacing"] = `${t.spacing}px`;
  vars["--t-font"] = fontStack(t.fontFamily);
  vars["--t-font-mono"] = `'${t.fontMono ?? "JetBrains Mono"}', ui-monospace, SFMono-Regular, monospace`;
  vars["--t-shadow-sm"] = dark ? "0 1px 2px rgba(0,0,0,.4)" : "0 1px 2px rgba(16,24,40,.08)";
  vars["--t-shadow-md"] = dark ? "0 6px 20px -6px rgba(0,0,0,.55)" : "0 6px 20px -8px rgba(16,24,40,.18)";
  vars["--t-shadow-lg"] = dark ? "0 16px 40px -12px rgba(0,0,0,.7)" : "0 16px 40px -14px rgba(16,24,40,.25)";
  vars["--t-shadow-glow"] = `0 8px 28px -10px ${alpha(t.primary, 0.6)}`;
  vars["--t-scheme"] = dark ? "dark" : "light";
  return vars;
}

/* ------------------------------------------------------------------ */
/* Text styles                                                         */
/* ------------------------------------------------------------------ */

export type TextStyleName = NonNullable<import("@harness/protocol").SceneStyle["textStyle"]>;
export interface TextPreset {
  size: number;
  weight: 400 | 500 | 600 | 700 | 800;
  lineHeight: number;
  letterSpacing: number;
}

const APP_TEXT: Record<TextStyleName, TextPreset> = {
  display: { size: 34, weight: 700, lineHeight: 1.1, letterSpacing: -0.025 },
  headline: { size: 24, weight: 600, lineHeight: 1.2, letterSpacing: -0.015 },
  title: { size: 17, weight: 600, lineHeight: 1.3, letterSpacing: -0.01 },
  body: { size: 15, weight: 400, lineHeight: 1.45, letterSpacing: 0 },
  label: { size: 13, weight: 500, lineHeight: 1.3, letterSpacing: 0 },
  caption: { size: 12, weight: 400, lineHeight: 1.35, letterSpacing: 0 },
};
const WEB_TEXT: Record<TextStyleName, TextPreset> = {
  display: { size: 44, weight: 700, lineHeight: 1.08, letterSpacing: -0.03 },
  headline: { size: 28, weight: 600, lineHeight: 1.2, letterSpacing: -0.02 },
  title: { size: 18, weight: 600, lineHeight: 1.3, letterSpacing: -0.01 },
  body: { size: 15, weight: 400, lineHeight: 1.5, letterSpacing: 0 },
  label: { size: 13, weight: 500, lineHeight: 1.3, letterSpacing: 0 },
  caption: { size: 12, weight: 400, lineHeight: 1.4, letterSpacing: 0 },
};

export const textPreset = (name: TextStyleName | undefined, platform: "app" | "web"): TextPreset =>
  (platform === "web" ? WEB_TEXT : APP_TEXT)[name ?? "body"];
