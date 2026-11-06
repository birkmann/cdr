// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import {
  componentBase,
  deltaE,
  hueName,
  nameColors,
  nameRadii,
  nameSpacing,
  nameTypes,
  oneToken,
  sameColor,
  toHex,
  variantSuffix,
  type ColorUse,
  type TypeCluster,
} from "../src/brandmd/naming.js";

const colorUse = (hex: string, roles: Record<string, number>, o: Partial<ColorUse> = {}): ColorUse => ({
  hex,
  roles,
  area: 0,
  count: 1,
  chars: 0,
  pages: ["p"],
  kinds: [],
  ...o,
});

describe("colour maths", () => {
  it("parses colours to hex, painting translucent ones over the ground", () => {
    expect(toHex("rgb(28, 105, 212)")).toBe("#1c69d4");
    expect(toHex("rgba(0, 0, 0, 0.5)", "#ffffff")).toBe("#808080");
    expect(toHex("transparent")).toBeNull();
    expect(toHex("rgba(0, 0, 0, 0)")).toBeNull();
  });

  it("measures ΔE2000 (same colour below 2)", () => {
    expect(deltaE("#1c69d4", "#1c69d4")).toBe(0);
    expect(sameColor("#1c69d4", "#1d6ad5")).toBe(true);
    expect(sameColor("#1c69d4", "#0653b6")).toBe(false);
    // near-white greys are < 2 apart, but two background greys stay two tokens
    expect(sameColor("#ffffff", "#fafafa")).toBe(true);
    expect(oneToken({ hex: "#ffffff", background: true }, { hex: "#fafafa", background: true })).toBe(false);
    expect(oneToken({ hex: "#ffffff", background: true }, { hex: "#fefefe", background: false })).toBe(true);
  });

  it("names hues", () => {
    expect(hueName("#e22718")).toBe("red");
    expect(hueName("#1c69d4")).toBe("blue");
    expect(hueName("#0b1f3a")).toBe("navy");
    expect(hueName("#777777")).toBe("grey");
  });
});

describe("nameColors", () => {
  const uses = (): ColorUse[] => [
    colorUse("#ffffff", { "page-bg": 2, "band-bg": 0.4, "on-dark-text": 30 }, { area: 0.4, count: 20 }),
    colorUse("#f5f5f5", { "band-bg": 0.1 }, { area: 0.1, count: 2 }),
    colorUse("#fafafa", { "card-bg": 6 }, { area: 0.05, count: 6 }),
    colorUse("#101820", { "band-bg": 0.3 }, { area: 0.3, count: 2 }),
    colorUse("#1e2833", { "card-bg": 3 }, { area: 0.02, count: 3 }),
    colorUse("#111111", { heading: 400, "body-text": 20 }, { chars: 420, count: 12 }),
    colorUse("#444444", { "body-text": 2000 }, { chars: 2000, count: 30 }),
    colorUse("#888888", { "footer-text": 300, "body-text": 50 }, { chars: 350, count: 10 }),
    colorUse("#e5e5e5", { border: 12 }, { count: 12 }),
    colorUse("#c8c8c8", { border: 4 }, { count: 4 }),
    colorUse("#0a7d3c", { "control-fill": 9 }, { count: 9 }),
    colorUse("#06622f", { "state:active": 9 }, { count: 9 }),
    colorUse("#e22718", { fill: 0.2, "control-fill": 1 }, { area: 0.2, count: 2 }),
    colorUse("#9b9b9b", { "state:hover": 3 }, { count: 3 }),
  ];

  it("assigns canvas, ink, body, surfaces, hairlines and primary from roles", () => {
    const cs = nameColors(uses(), { primary: "#0a7d3c", primaryActive: "#06622f", onPrimary: "#ffffff" });
    const key = (k: string) => cs.find((c) => c.key === k)?.hex;
    expect(key("canvas")).toBe("#ffffff");
    expect(key("ink")).toBe("#111111");
    expect(key("body")).toBe("#444444");
    expect(key("muted")).toBe("#888888");
    expect(key("surface-dark")).toBe("#101820");
    expect(key("surface-dark-elevated")).toBe("#1e2833");
    expect(key("surface-card")).toBe("#fafafa");
    expect(key("surface-soft")).toBe("#f5f5f5");
    expect(key("hairline")).toBe("#e5e5e5");
    expect(key("hairline-strong")).toBe("#c8c8c8");
    expect(key("primary")).toBe("#0a7d3c");
    expect(key("primary-active")).toBe("#06622f");
    expect(key("on-primary")).toBe("#ffffff");
    expect(key("on-dark")).toBe("#ffffff");
    // the red promo fill is an accent, named by hue; nothing semantic was found, so nothing semantic is named
    expect(key("red")).toBe("#e22718");
    expect(cs.some((c) => ["success", "warning", "error"].includes(c.key))).toBe(false);
    expect(cs.find((c) => c.key === "canvas")!.group).toBe("surface");
    expect(cs.find((c) => c.key === "red")!.group).toBe("accent");
  });

  it("keeps keys unique and stable regardless of input order", () => {
    const a = nameColors(uses(), { primary: "#0a7d3c" });
    const b = nameColors([...uses()].reverse(), { primary: "#0a7d3c" });
    expect(new Set(a.map((c) => c.key)).size).toBe(a.length);
    expect(b.map((c) => `${c.key}=${c.hex}`).sort()).toEqual(a.map((c) => `${c.key}=${c.hex}`).sort());
  });

  it("names semantic colours only when the site has them, and derives a canvas when nothing was measured", () => {
    const cs = nameColors(
      [...uses(), colorUse("#d92d20", { "semantic:error": 1, declared: 1 }, { count: 0 })],
      {},
    );
    expect(cs.find((c) => c.key === "error")?.hex).toBe("#d92d20");
    const empty = nameColors([], { background: "#fefefe", text: "#222222" });
    expect(empty.find((c) => c.key === "canvas")).toMatchObject({ hex: "#fefefe", source: "derived" });
    expect(empty.find((c) => c.key === "ink")).toMatchObject({ hex: "#222222", source: "derived" });
  });

  it("takes surface-dark from the largest dark band on a light site, ink from headings", () => {
    const cs = nameColors(
      [
        colorUse("#ffffff", { "page-bg": 1 }),
        colorUse("#222831", { "band-bg": 0.05 }),
        colorUse("#000000", { "band-bg": 0.3 }),
        colorUse("#1a1a1a", { heading: 50, "body-text": 10 }),
        colorUse("#333333", { "body-text": 900 }),
      ],
      {},
    );
    expect(cs.find((c) => c.key === "surface-dark")?.hex).toBe("#000000");
    expect(cs.find((c) => c.key === "ink")?.hex).toBe("#1a1a1a");
    expect(cs.find((c) => c.key === "body")?.hex).toBe("#333333");
  });
});

describe("nameTypes", () => {
  const tc = (
    size: number,
    weight: number,
    chars: number,
    uses: Record<string, number> = {},
    o: Partial<TypeCluster> = {},
  ): TypeCluster => ({
    family: "Brand Sans",
    stack: "Brand Sans, sans-serif",
    size,
    weight,
    lineHeight: 1.4,
    letterSpacing: 0,
    chars,
    uses,
    mono: false,
    strings: [],
    ...o,
  });

  it("ranks headings by size into display / title steps and finds body, caption, label, button, nav, code", () => {
    const clusters = [
      tc(64, 700, 20, { h1: 20, heading: 20 }),
      tc(62, 700, 4, { h1: 4 }),
      tc(40, 700, 60, { h2: 60, heading: 60 }),
      tc(20, 700, 120, { heading: 120 }),
      tc(16, 300, 4000, { body: 4000 }),
      tc(14, 300, 800, { body: 800 }),
      tc(12, 400, 300, { body: 300 }),
      tc(13, 700, 90, { body: 90 }, { textTransform: "uppercase", letterSpacing: 1.5 }),
      tc(15, 400, 200, { nav: 200 }),
      tc(14, 700, 100, { button: 100 }),
      tc(13, 400, 150, { body: 150 }, { family: "Brand Mono", mono: true }),
    ];
    const keys = Object.fromEntries(
      nameTypes(clusters).map(({ key, cluster }) => [key, `${cluster.size}/${cluster.weight}`]),
    );
    expect(keys).toMatchObject({
      "display-xl": "64/700",
      "display-lg": "40/700",
      "title-lg": "20/700",
      "body-md": "16/300",
      "body-sm": "14/300",
      caption: "12/400",
      "label-uppercase": "13/700",
      button: "14/700",
      "nav-link": "15/400",
      code: "13/400",
    });
    // 62 px merges into the 64 px step (within 9 %)
    expect(Object.values(keys).filter((v) => v === "62/700")).toHaveLength(0);
  });

  it("prefers the captured CTA label for the button role and keeps keys unique", () => {
    const btn = tc(14, 600, 30, { button: 30 });
    const out = nameTypes([tc(16, 400, 1000, { body: 1000 }), tc(14, 700, 40, { button: 40 })], {
      button: btn,
    });
    expect(out.find((x) => x.key === "button")!.cluster).toBe(btn);
    expect(new Set(out.map((x) => x.key)).size).toBe(out.length);
  });
});

describe("radius and spacing scales", () => {
  it("names radii none … pill / full, one value per step", () => {
    const steps = nameRadii([
      { value: 0, count: 20, kinds: ["button"] },
      { value: 4, count: 6, kinds: ["tag"] },
      { value: 5, count: 2, kinds: ["tag"] },
      { value: 8, count: 3, kinds: ["card"] },
      { value: 13, count: 1, kinds: ["card"] },
      { value: 24, count: 2, kinds: ["button"], shape: "pill" },
      { value: 20, count: 4, kinds: ["icon-button"], shape: "circle" },
    ]);
    expect(steps.map((s) => `${s.key}:${s.value}`)).toEqual([
      "none:0",
      "sm:4",
      "md:8",
      "pill:9999",
      "full:9999",
    ]);
  });

  it("builds the spacing ladder from measured values with section = band rhythm", () => {
    const steps = nameSpacing([8, 8, 8, 16, 16, 16, 16, 24, 24, 24, 28, 28, 28, 28, 40, 40, 40], 8, 96);
    expect(steps.map((s) => s.key)).toEqual(["xxs", "xs", "sm", "md", "lg", "xl", "xxl", "section"]);
    expect(steps.find((s) => s.key === "lg")!.value).toBe(24);
    expect(steps.find((s) => s.key === "xl")!.value).toBe(28);
    expect(steps.find((s) => s.key === "section")!.value).toBe(96);
    expect(steps.find((s) => s.key === "sm")!.count).toBe(0);
    for (let i = 1; i < steps.length - 1; i++) expect(steps[i]!.value).toBeGreaterThan(steps[i - 1]!.value);
  });
});

describe("component keys", () => {
  it("maps kinds and brand names to keys", () => {
    expect(componentBase("Header", "header")).toBe("top-nav");
    expect(componentBase("Site footer", "footer")).toBe("footer");
    expect(componentBase("Model card", "card")).toBe("model-card");
    expect(componentBase("Card / Default", "card")).toBe("card");
    expect(componentBase("Configurator option tile", "other")).toBe("configurator-option-tile");
    expect(componentBase("Button", "button", { button: "primary" })).toBe("button-primary");
    expect(componentBase("Button", "button", { button: "secondary", onDark: true })).toBe(
      "button-secondary-on-dark",
    );
    expect(componentBase("Button", "button", { button: "text" })).toBe("button-text-link");
  });

  it("turns variant values into suffixes", () => {
    expect(variantSuffix("pressed", "button")).toBe("active");
    expect(variantSuffix("checked", "other")).toBe("selected");
    expect(variantSuffix("selected", "tabs")).toBe("active");
    expect(variantSuffix("small", "button")).toBe("sm");
    expect(variantSuffix("default", "button")).toBeNull();
    expect(variantSuffix("On Dark", "card")).toBe("on-dark");
  });
});
