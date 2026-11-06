// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import { brandFacts } from "@harness/codegen";
import { fixtureDs, fixtureScreens } from "./brandmd-fixture-northwind.js";

const facts = () => brandFacts({ ds: fixtureDs, screens: fixtureScreens(), url: "northwind.example" });
const color = (f: ReturnType<typeof facts>, key: string) => f.colors.find((c) => c.key === key);

describe("brandFacts (Northwind fixture)", () => {
  it("reads name, website, date and pages", () => {
    const f = facts();
    expect(f).toMatchObject({
      version: 1,
      name: "Northwind",
      website: "https://northwind.example",
      capturedAt: "2026-10-20",
    });
    expect(f.pages.map((p) => p.widths)).toEqual([[390, 1280], [1280]]);
  });

  it("takes primary from the CTA controls by count across pages, not from the larger red promo area", () => {
    const f = facts();
    expect(color(f, "primary")).toMatchObject({ hex: "#1c69d4", source: "site", cssVar: "--nw-primary" });
    // the red band paints more area than every blue button together; it stays an accent
    expect(color(f, "red")?.hex).toBe("#e22718");
    expect(color(f, "red")!.area).toBeGreaterThan(color(f, "primary")!.area);
  });

  it("takes the state colours from the captured controls", () => {
    const f = facts();
    expect(color(f, "primary-active")?.hex).toBe("#0653b6");
    expect(color(f, "primary-disabled")?.hex).toBe("#d6d6d6");
    expect(color(f, "primary-hover")).toBeUndefined();
    expect(color(f, "on-primary")?.hex).toBe("#ffffff");
    const active = f.components.find((c) => c.key === "button-primary-active")!;
    expect(active.props).toMatchObject({
      backgroundColor: "{colors.primary-active}",
      textColor: "{colors.on-primary}",
    });
    expect(f.components.find((c) => c.key === "button-primary-disabled")!.props.backgroundColor).toBe(
      "{colors.primary-disabled}",
    );
    expect(f.gaps.some((g) => /hover state was not reached/.test(g))).toBe(true);
  });

  it("names canvas, ink, body, the surface ladder, hairlines and on-dark", () => {
    const f = facts();
    const hex = Object.fromEntries(f.colors.map((c) => [c.key, c.hex]));
    expect(hex).toMatchObject({
      canvas: "#ffffff",
      ink: "#262626",
      body: "#3c3c3c",
      muted: "#6b6b6b",
      "surface-dark": "#1a2129",
      "surface-card": "#fafafa",
      "surface-soft": "#f7f7f7",
      hairline: "#e6e6e6",
      "hairline-strong": "#cccccc",
      "on-dark": "#ffffff",
      "on-dark-soft": "#bbbbbb",
      error: "#dc2626",
    });
    expect(new Set(f.colors.map((c) => c.key)).size).toBe(f.colors.length);
    // declared, never painted: semantic error kept (as declared), the unused teal only in the gaps
    expect(color(f, "error")!.roles).toContain("declared");
    expect(f.colors.some((c) => c.hex === "#0d9488")).toBe(false);
    expect(f.gaps.some((g) => g.includes("--nw-teal"))).toBe(true);
  });

  it("clusters the type runs and states which weights are absent", () => {
    const f = facts();
    expect(f.weights).toEqual({ used: [300, 400, 700], absent: [500, 600] });
    const t = Object.fromEntries(f.typography.map((x) => [x.key, x]));
    expect(t["display-xl"]).toMatchObject({
      fontSize: 64,
      fontWeight: 700,
      lineHeight: 1.05,
      mobileSize: 40,
      family: "Northwind Sans",
    });
    expect(t["display-xl"]!.fontFamily).toBe("'Northwind Sans', Helvetica, Arial, sans-serif");
    expect(t["display-lg"]!.fontFamily).toBe("'Northwind Sans', sans-serif");
    expect(t["body-md"]).toMatchObject({ fontSize: 16, fontWeight: 300 });
    expect(t.button).toMatchObject({ fontSize: 14, fontWeight: 700, letterSpacing: 0.5, lineHeight: 1 });
    expect(t["label-uppercase"]).toMatchObject({
      fontSize: 13,
      textTransform: "uppercase",
      letterSpacing: 1.5,
    });
    expect(t["nav-link"]).toMatchObject({ fontSize: 14, fontWeight: 400 });
    expect(f.fonts[0]).toMatchObject({ family: "Northwind Sans", weights: [300, 400, 700], licensed: true });
    expect(f.fonts[0]!.files).toHaveLength(3);
    expect(f.fonts[0]!.substitutes.length).toBeGreaterThan(0);
  });

  it("derives base unit, section rhythm, radii, grids and the band sequence", () => {
    const f = facts();
    expect(f.baseUnit).toBe(8);
    expect(f.sectionRhythm).toBe(80);
    expect(f.spacing.find((s) => s.key === "section")!.value).toBe(80);
    expect(f.rounded[0]).toMatchObject({ key: "none", value: 0 });
    expect(f.radiusByKind.button).toBe(0);
    expect(f.grids).toEqual([{ name: "page 1 · band 4 · 3 items", columnsByWidth: { 390: 1, 1280: 3 } }]);
    expect(f.bands[0]).toEqual({
      page: "https://northwind.example/en/index.html",
      sequence: ["light", "dark", "tint", "light", "light"],
    });
    expect(f.elevation.shadows).toEqual([]);
  });

  it("clusters @media widths into breakpoints and says what changes between the captured widths", () => {
    const f = facts();
    expect(f.breakpoints.map((b) => [b.name, b.min, b.max])).toEqual([
      ["Mobile", undefined, 767],
      ["Tablet", 768, 1023],
      ["Desktop", 1024, 1439],
      ["Wide", 1440, undefined],
    ]);
    const mobile = f.breakpoints[0]!.changes;
    expect(mobile).toContain("nav collapses to a menu button");
    expect(mobile).toContain("h1 64→40px");
    expect(mobile.some((c) => c.endsWith("1-up"))).toBe(true);
    expect(f.breakpoints[2]!.changes.some((c) => c.endsWith("3-up"))).toBe(true);
  });

  it("maps component sets, variants, states and bands to unique keys with token refs only", () => {
    const f = facts();
    const keys = f.components.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        "top-nav",
        "button-primary",
        "button-primary-active",
        "button-secondary",
        "model-card",
        "footer",
        "text-input",
        "category-tab",
        "category-tab-active",
        "hero-band-dark",
      ]),
    );
    expect(f.components.find((c) => c.key === "button-primary")!.props).toEqual({
      backgroundColor: "{colors.primary}",
      textColor: "{colors.on-primary}",
      typography: "{typography.button}",
      rounded: "{rounded.none}",
      padding: "14px 32px",
      height: "48px",
    });
    expect(f.components.find((c) => c.key === "model-card")!.props).toMatchObject({
      backgroundColor: "{colors.surface-card}",
      padding: "{spacing.lg}",
    });
    expect(f.components.find((c) => c.key === "footer")!.props.backgroundColor).toBe("{colors.surface-soft}");
    expect(f.components.find((c) => c.key === "hero-band-dark")!.props).toMatchObject({
      backgroundColor: "{colors.surface-dark}",
      textColor: "{colors.on-dark}",
      typography: "{typography.display-xl}",
      padding: "{spacing.section}",
    });
    expect(f.components.find((c) => c.key === "button-primary-active")!.base).toBe("button-primary");
    expect(f.components.find((c) => c.key === "text-input")!.source).toBe("generated");
    // no literal hex and no `transparent` in any prop
    for (const c of f.components)
      for (const v of Object.values(c.props)) expect(v).not.toMatch(/#[0-9a-f]{3,8}|transparent/i);
    // groups follow the ## Components order
    expect(f.components[0]!.group).toBe("Top Navigation");
    expect(f.components[f.components.length - 1]!.group).toBe("CTA / Footer");
  });

  it("sorts images by role, contrasts with the peer corpus and keeps the captured texts", () => {
    const f = facts();
    expect(f.images).toEqual(
      expect.arrayContaining([
        { role: "hero", count: 1, aspect: "2.13:1" },
        { role: "thumbnail", count: 3, aspect: "16:9" },
      ]),
    );
    const radius = f.peers.find((p) => p.metric === "control-radius")!;
    expect(radius.value).toBe("0px");
    expect(radius.claim).toMatch(/squarer than the peer median/);
    expect(f.peers.find((p) => p.metric === "shadows")!.value).toBe("none");
    expect(f.texts).toContain("Drive the future");
    expect(f.components.find((c) => c.key === "top-nav")!.texts).toEqual([
      "Models",
      "Electric",
      "Offers",
      "Dealers",
    ]);
  });

  it("is stable: the same input gives the same facts", () => {
    expect(JSON.stringify(facts())).toBe(JSON.stringify(facts()));
  });

  it("degrades without a brand capture (older documents) and says so", () => {
    const screens = fixtureScreens().map(({ capture: _c, ...s }) => s);
    const f = brandFacts({
      ds: fixtureDs,
      screens,
      url: "https://northwind.example",
      capturedAt: "2026-10-21",
    });
    expect(f.gaps[0]).toMatch(/no brand capture/);
    // primary still comes from the site's button-like layers (count), not from the red band's area
    expect(color(f, "primary")?.hex).toBe("#1c69d4");
    expect(color(f, "primary-active")).toBeUndefined();
    expect(f.breakpoints.map((b) => b.min ?? 0)).toEqual([0, 1024]);
    expect(f.typography.length).toBeGreaterThan(5);
    expect(f.sectionRhythm).toBe(80);
  });
});
