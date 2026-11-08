import { CdpCaptureDriver, type CaptureOptions } from "@harness/capture";
import { brandFoundations, type BrandFoundations } from "@harness/extract";
import { DEFAULT_TOKENS, type SceneDesignSystem } from "@harness/protocol";
import { pageScreens } from "@harness/scene";
import type { BrandSpec, SpecSource } from "../spec.js";

/** "52/700" → 52 */
const sizeOf = (s: string | undefined) => {
  const n = s ? parseFloat(s) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** A brand spec from the foundations `@harness/extract` reads off captured screens (pure). */
export function specFromFoundations(f: BrandFoundations, name: string): Partial<BrandSpec> {
  const t = f.tokens;
  const s = f.summary;
  const sources: Record<string, SpecSource> = {};
  const colorSource = (k: string) => (s?.colorSources?.[k] === "derived" ? "default" : "site");
  const colors: BrandSpec["colors"] = { primary: t.primary ?? DEFAULT_TOKENS.primary };
  sources["colors.primary"] = colorSource("primary");
  // secondary / accent the reader derived (not seen on the site) are left to the generator
  for (const [k, from] of [
    ["secondary", "secondary"],
    ["accent", "accent"],
  ] as const)
    if (t[from] && s?.colorSources?.[from] !== "derived") {
      colors[k] = t[from]!;
      sources[`colors.${k}`] = "site";
    }
  for (const [k, from] of [
    ["success", "success"],
    ["warning", "warning"],
    ["danger", "danger"],
    ["background", "background"],
    ["surface", "surface"],
    ["text", "text"],
  ] as const)
    if (t[from] && s?.colorSources?.[from] !== "derived") {
      colors[k] = t[from] as string;
      sources[`colors.${k}`] = "site";
    }
  const controlRadius = s?.controls.radius ?? s?.radii.control ?? t.radius;
  const spec: Partial<BrandSpec> = {
    name,
    colors,
    theme: t.theme === "dark" ? "dark" : "light",
    fonts: {
      sans: s?.fonts.body ?? t.fontFamily ?? "Inter",
      ...(s?.fonts.display && s.fonts.display !== s.fonts.body ? { display: s.fonts.display } : {}),
    },
    radius: { control: controlRadius ?? 4, container: s?.radii.card ?? t.radius ?? 8 },
    controlHeight: s?.controls.height ?? 40,
    density:
      (s?.spacing?.[0] ?? 8) <= 4 && (s?.controls.height ?? 40) <= 36
        ? "compact"
        : (s?.controls.height ?? 40) >= 52
          ? "spacious"
          : "normal",
    buttons: { secondary: s?.controls.secondary ?? "outline", uppercase: !!s?.controls.uppercase },
    elevation: "soft",
    typeScale: {
      display: sizeOf(s?.scale.display),
      h1: sizeOf(s?.scale.h1),
      h2: sizeOf(s?.scale.h2),
      h3: sizeOf(s?.scale.h3),
      h4: sizeOf(s?.scale.h4),
      body: sizeOf(s?.scale.body),
      small: sizeOf(s?.scale.small),
    },
    sources: {
      ...sources,
      theme: "site",
      "fonts.sans": s?.fonts.body ? "site" : "default",
      "radius.control": controlRadius !== undefined ? "site" : "default",
      "radius.container": s?.radii.card !== undefined ? "site" : "default",
      controlHeight: s?.controls.height ? "site" : "default",
      "buttons.secondary": s?.controls ? "site" : "default",
    },
    notes: [
      ...(s?.fonts.webfonts?.length
        ? [
            `Webfonts on the site: ${s.fonts.webfonts.join(", ")}. The design system names them but does not bundle the files; add licensed font files yourself.`,
          ]
        : []),
    ],
  };
  return spec;
}

/** A readable brand name from a URL ("https://www.acme-outdoor.com/de" → "Acme Outdoor"). */
export function nameFromUrl(url: string): string {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
    const word = host.split(".")[0] ?? host;
    return word
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join(" ");
  } catch {
    return "Design System";
  }
}

export interface UrlReading {
  spec: Partial<BrandSpec>;
  finalUrl: string;
  /** full-page screenshot of the live page at 1440 px (PNG), for the visual check */
  shot?: Buffer;
  skipped: string[];
}

/** Capture the page at one desktop width and read its brand (styles only: no copy, photos or font files). */
export async function readUrl(
  url: string,
  o: {
    name?: string;
    signal?: AbortSignal;
    chrome?: string;
    guard?: CaptureOptions["guard"];
    respectRobots?: boolean;
  } = {},
): Promise<UrlReading> {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const driver = new CdpCaptureDriver();
  const res = await driver.capture(
    target,
    { width: 1440 },
    {
      signal: o.signal,
      chrome: o.chrome,
      guard: o.guard,
      respectRobots: o.respectRobots ?? true,
      shotWidths: [1440],
      dpr: 1,
      budgets: { totalMs: 90_000, menuMs: 0, submenuMs: 0, submenus: 0, altMs: 0, rasters: 0 },
    },
  );
  // Brand colours are ranked by painted area, which only the fitted geometry measures.
  const screens = pageScreens([{ width: 1440, minWidth: 0, snap: res.snapshot as never }], undefined, {
    flow: false,
  }).screens;
  const name = o.name?.trim() || nameFromUrl(res.finalUrl || target);
  const ds: SceneDesignSystem = { version: 1, name, tokens: { ...DEFAULT_TOKENS }, componentSets: [] };
  const f = brandFoundations(screens, ds);
  const spec = specFromFoundations(f, name);
  spec.notes = [`Read from ${res.finalUrl || target} (desktop, 1440 px).`, ...(spec.notes ?? [])];
  const shot = res.shots.find((s) => s.width === 1440)?.png;
  return { spec, finalUrl: res.finalUrl || target, ...(shot ? { shot } : {}), skipped: res.skipped };
}
