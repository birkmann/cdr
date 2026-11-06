// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Test fixture: a small BMW-like BrandFacts (values as in design-md--generator/examples/bmw.design.md).
import type { BrandFacts } from "@harness/protocol";

/** A small BMW-like fact set (values as in examples/bmw.design.md). */
export function sampleFacts(over: Partial<BrandFacts> = {}): BrandFacts {
  const color = (
    key: string,
    hex: string,
    group: BrandFacts["colors"][number]["group"],
    roles: string[],
    area = 0.01,
  ) => ({
    key,
    label: key,
    hex,
    group,
    roles,
    area,
    count: 10,
    pages: ["https://www.bmw.com/"],
    kinds: ["button"],
    source: "site" as const,
  });
  const type = (
    key: string,
    fontSize: number,
    fontWeight: number,
    use: string[],
    extra: Partial<BrandFacts["typography"][number]> = {},
  ) => ({
    key,
    fontFamily:
      key === "display-xl"
        ? "'BMW Type Next Latin', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        : "'BMW Type Next Latin', sans-serif",
    family: "BMW Type Next Latin",
    fontSize,
    fontWeight,
    lineHeight: 1.3,
    letterSpacing: 0,
    chars: 100,
    use,
    source: "site" as const,
    ...extra,
  });
  return {
    version: 1,
    name: "BMW",
    website: "https://www.bmw.com",
    capturedAt: "2026-10-27",
    pages: [{ url: "https://www.bmw.com/", title: "BMW.com", widths: [390, 1280] }],
    colors: [
      color("primary", "#1c69d4", "brand", ["control-fill", "link"], 0.02),
      color("primary-active", "#0653b6", "brand", ["state:active"]),
      color("canvas", "#ffffff", "surface", ["band-bg"], 0.7),
      color("surface-dark", "#1a2129", "surface", ["band-bg"], 0.15),
      color("ink", "#262626", "text", ["heading"]),
      color("hairline", "#e6e6e6", "hairline", ["border"]),
      color("on-primary", "#ffffff", "text", ["text-on:primary"]),
    ],
    typography: [
      type("display-xl", 64, 700, ["h1", "hero"], { mobileSize: 40 }),
      type("body-md", 16, 300, ["body"]),
      type("label-uppercase", 13, 700, ["link"], { letterSpacing: 1.5, textTransform: "uppercase" }),
      type("button", 14, 700, ["button"], { letterSpacing: 0.5 }),
    ],
    fonts: [
      {
        family: "BMW Type Next Latin",
        weights: [300, 400, 700],
        styles: ["normal"],
        files: [],
        licensed: true,
        substitutes: [
          { family: "Inter", score: 0.9 },
          { family: "Saira Condensed", score: 0.7 },
        ],
      },
    ],
    weights: { used: [300, 400, 700], absent: [500, 600] },
    tracking: "positive",
    rounded: [
      { key: "none", value: 0, count: 120, kinds: ["button", "card"] },
      { key: "full", value: 9999, count: 4, kinds: ["icon-button"] },
    ],
    radiusByKind: { button: 0, card: 0, "icon-button": 9999 },
    spacing: [
      { key: "xs", value: 8, count: 40, kinds: [] },
      { key: "md", value: 16, count: 60, kinds: [] },
      { key: "lg", value: 24, count: 30, kinds: [] },
      { key: "section", value: 80, count: 12, kinds: [] },
    ],
    baseUnit: 8,
    sectionRhythm: 80,
    cardPadding: 24,
    containerMax: 1440,
    grids: [{ name: "model cards", columnsByWidth: { 390: 1, 1280: 4 } }],
    breakpoints: [{ name: "tablet", min: 768, changes: ["nav collapses"] }],
    elevation: { shadows: [], gradients: [] },
    bands: [{ page: "https://www.bmw.com/", sequence: ["photo", "light", "dark", "light"] }],
    components: [
      {
        key: "button-primary",
        base: "button-primary",
        kind: "button",
        group: "Buttons",
        props: {
          backgroundColor: "{colors.primary}",
          textColor: "{colors.on-primary}",
          rounded: "{rounded.none}",
          padding: "14px 32px",
          height: "48px",
        },
        texts: ["Learn more"],
        layout: [],
        source: "extracted",
      },
      {
        key: "top-nav",
        base: "top-nav",
        kind: "header",
        group: "Top Navigation",
        props: { backgroundColor: "{colors.canvas}", height: "64px" },
        texts: ["Models", "Pre-Owned"],
        layout: ["sticky"],
        source: "extracted",
      },
    ],
    images: [{ role: "hero", count: 2, aspect: "16:9" }],
    peers: [
      {
        metric: "dominantRadius",
        value: 0,
        peerMedian: 9999,
        claim: "rectangular controls (0px) where the peers pill (median 9999px)",
        peers: ["Apple", "Astro"],
      },
    ],
    gaps: ["BMW Type Next Latin is licensed", "hover state of the model card not reached"],
    texts: ["Learn more", "Models", "Pre-Owned", "THE iX3", "Find a dealer"],
    ...over,
  };
}
