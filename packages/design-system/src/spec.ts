import { normHex } from "./tokens/color.js";

/** Where a value of the brand reading came from. */
export type SpecSource = "site" | "image" | "vision" | "override" | "default";

/**
 * The brand reading: small, readable and editable (`brand.json`). Everything the generator needs and nothing more;
 * the token system and every package are derived from it deterministically.
 */
export interface BrandSpec {
  /** Display name, e.g. "Acme Outdoor". */
  name: string;
  /** Tag / CSS variable prefix, lowercase letters and digits, e.g. "acme" → <acme-button>, --acme-… */
  prefix: string;
  colors: {
    primary: string;
    secondary?: string;
    accent?: string;
    /** colour the neutral greys lean towards (default: a trace of the primary) */
    neutralTint?: string;
    success?: string;
    warning?: string;
    danger?: string;
    info?: string;
    /** what the source used as page background, surfaces and copy (informational; themes are derived) */
    background?: string;
    surface?: string;
    text?: string;
  };
  /** The source's own theme; becomes the default theme. */
  theme: "light" | "dark";
  fonts: { sans: string; mono?: string; display?: string };
  radius: { control: number; container: number };
  /** Height of a medium control in px (32–56). */
  controlHeight: number;
  density: "compact" | "normal" | "spacious";
  buttons: { secondary: "outline" | "tonal"; uppercase: boolean };
  elevation: "none" | "soft" | "strong";
  /** Type sizes read from the source (px), by role, when known. */
  typeScale?: Partial<Record<"display" | "h1" | "h2" | "h3" | "h4" | "body" | "small", number>>;
  /** Where each value came from (key paths like "colors.primary"). */
  sources?: Record<string, SpecSource>;
  /** Free notes of the reading (shown in DESIGN.md). */
  notes?: string[];
}

export type BrandOverrides = Partial<Omit<BrandSpec, "colors" | "fonts" | "radius" | "buttons">> & {
  colors?: Partial<BrandSpec["colors"]>;
  fonts?: Partial<BrandSpec["fonts"]>;
  radius?: Partial<BrandSpec["radius"]>;
  buttons?: Partial<BrandSpec["buttons"]>;
};

export const DEFAULT_SPEC: BrandSpec = {
  name: "Design System",
  prefix: "ds",
  colors: { primary: "#0f62fe" },
  theme: "light",
  fonts: { sans: "Inter", mono: "JetBrains Mono" },
  radius: { control: 4, container: 8 },
  controlHeight: 40,
  density: "normal",
  buttons: { secondary: "outline", uppercase: false },
  elevation: "soft",
};

/** "Acme Outdoor GmbH" → "acme" (2–12 chars, starts with a letter, not a reserved custom-element prefix). */
export function prefixFrom(name: string): string {
  const word =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .split(/[\s_-]+/)
      .find((w) => /^[a-z][a-z0-9]{1,}/.test(w)) ?? "ds";
  const p = word.replace(/[^a-z0-9]/g, "").slice(0, 12);
  return /^(xml|annotation|color|font|missing)/.test(p) || p.length < 2 ? `${p}ds`.slice(0, 12) : p;
}

const num = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;

const font = (v: unknown) =>
  typeof v === "string" && v.trim()
    ? v
        .split(",")[0]!
        .trim()
        .replace(/^["']|["']$/g, "")
        .slice(0, 60)
    : undefined;

/** Merge overrides into a spec and normalise every value (valid hex, sane numbers, a valid prefix). */
export function normalizeSpec(base: Partial<BrandSpec>, overrides: BrandOverrides = {}): BrandSpec {
  const sources: Record<string, SpecSource> = { ...(base.sources ?? {}) };
  const mark = (obj: Record<string, unknown> | undefined, path: string) => {
    for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) sources[`${path}${k}`] = "override";
  };
  mark(overrides.colors, "colors.");
  mark(overrides.fonts, "fonts.");
  mark(overrides.radius, "radius.");
  mark(overrides.buttons, "buttons.");
  for (const k of ["theme", "controlHeight", "density", "elevation", "name", "prefix"] as const)
    if (overrides[k] !== undefined) sources[k] = "override";

  const colorsIn = { ...DEFAULT_SPEC.colors, ...base.colors, ...overrides.colors };
  const colors: BrandSpec["colors"] = { primary: normHex(colorsIn.primary) ?? DEFAULT_SPEC.colors.primary };
  for (const k of [
    "secondary",
    "accent",
    "neutralTint",
    "success",
    "warning",
    "danger",
    "info",
    "background",
    "surface",
    "text",
  ] as const) {
    const h = normHex(colorsIn[k]);
    if (h) colors[k] = h;
  }
  const name = (overrides.name ?? base.name ?? DEFAULT_SPEC.name).trim().slice(0, 60) || DEFAULT_SPEC.name;
  const rawPrefix = (overrides.prefix ?? base.prefix ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const prefix = /^[a-z][a-z0-9]{1,11}$/.test(rawPrefix) ? rawPrefix : prefixFrom(name);
  const fontsIn = { ...DEFAULT_SPEC.fonts, ...base.fonts, ...overrides.fonts };
  const radiusIn = { ...DEFAULT_SPEC.radius, ...base.radius, ...overrides.radius };
  const buttonsIn = { ...DEFAULT_SPEC.buttons, ...base.buttons, ...overrides.buttons };
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
    allowed.includes(v as T) ? (v as T) : d;
  const spec: BrandSpec = {
    name,
    prefix,
    colors,
    theme: pick(overrides.theme ?? base.theme, ["light", "dark"], "light"),
    fonts: {
      sans: font(fontsIn.sans) ?? DEFAULT_SPEC.fonts.sans,
      mono: font(fontsIn.mono) ?? DEFAULT_SPEC.fonts.mono,
      ...(font(fontsIn.display) ? { display: font(fontsIn.display) } : {}),
    },
    radius: {
      control: num(radiusIn.control, 0, 999, DEFAULT_SPEC.radius.control),
      container: num(radiusIn.container, 0, 32, DEFAULT_SPEC.radius.container),
    },
    controlHeight: num(overrides.controlHeight ?? base.controlHeight, 32, 56, DEFAULT_SPEC.controlHeight),
    density: pick(overrides.density ?? base.density, ["compact", "normal", "spacious"], "normal"),
    buttons: {
      secondary: pick(buttonsIn.secondary, ["outline", "tonal"], "outline"),
      uppercase: !!buttonsIn.uppercase,
    },
    elevation: pick(overrides.elevation ?? base.elevation, ["none", "soft", "strong"], "soft"),
    ...(base.typeScale || overrides.typeScale
      ? { typeScale: { ...base.typeScale, ...overrides.typeScale } }
      : {}),
    sources,
    ...(base.notes?.length || overrides.notes?.length
      ? { notes: [...(base.notes ?? []), ...(overrides.notes ?? [])] }
      : {}),
  };
  return spec;
}
