import { describe, expect, it } from "vitest";
import {
  buildTokenSystem,
  contrast,
  deltaE,
  hexToOklch,
  normalizeSpec,
  oklchToHex,
  palette,
  prefixFrom,
  SEMANTIC_TOKENS,
  STEPS,
  THEMES,
  tokensCss,
  tokensJson,
  tokensJs,
  tokensScss,
  tailwindPreset,
  gridCss,
} from "@harness/design-system";

describe("colour maths", () => {
  it("round-trips sRGB through OKLCH and measures WCAG contrast", () => {
    for (const hex of ["#0f62fe", "#ffd400", "#111111", "#e60000", "#00c2ff", "#808080"])
      expect(deltaE(oklchToHex(hexToOklch(hex)), hex)).toBeLessThan(0.5);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(deltaE("#ff0000", "#ff0000")).toBe(0);
  });
});

describe("palettes", () => {
  it("has ten steps from light to dark and keeps the brand colour at its base step", () => {
    for (const brand of ["#0f62fe", "#0f5132", "#ffd400", "#e60000"]) {
      const { steps, baseStep } = palette(brand);
      expect(steps[baseStep]).toBe(brand);
      const ls = STEPS.map((s) => hexToOklch(steps[s]).l);
      for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeLessThan(ls[i - 1]!);
    }
  });
});

// colours that make contrast hard: yellow, near-black, grey, light cyan, saturated red, dark green
const HOSTILE = [
  "#ffd400",
  "#111111",
  "#808080",
  "#00c2ff",
  "#e60000",
  "#0f5132",
  "#0f62fe",
  "#ff69b4",
  "#c0ffee",
];

describe("themes", () => {
  it("define every semantic token in every theme", () => {
    const t = buildTokenSystem(normalizeSpec({ colors: { primary: "#0f62fe" } }));
    for (const n of THEMES)
      for (const k of SEMANTIC_TOKENS) expect(t.themes[n][k], `${n} ${k}`).toMatch(/^#|^transparent$/);
  });

  it.each(HOSTILE)("pass every contrast pair in all four themes for primary %s", (primary) => {
    const t = buildTokenSystem(normalizeSpec({ name: "X", colors: { primary } }));
    expect(t.contrast.filter((c) => !c.pass).map((c) => `${c.theme} ${c.fg}/${c.bg}=${c.ratio}`)).toEqual([]);
    expect(t.contrast.length).toBe(THEMES.length * 29);
  });

  it("keep the brand colour on the primary button where text reads on it", () => {
    const t = buildTokenSystem(normalizeSpec({ colors: { primary: "#0f62fe" } }));
    expect(t.themes.light["button-primary"]).toBe("#0f62fe");
    expect(t.themes.light["button-primary-text"]).toBe("#ffffff");
    const y = buildTokenSystem(normalizeSpec({ colors: { primary: "#ffd400" } }));
    expect(y.themes.light["button-primary"]).toBe("#ffd400");
    expect(y.themes.light["button-primary-text"]).toBe("#000000");
  });

  it("use a dark default theme for dark sources and scale spacing with density", () => {
    expect(buildTokenSystem(normalizeSpec({ theme: "dark" })).defaultTheme).toBe("darkest");
    const compact = buildTokenSystem(normalizeSpec({ density: "compact" }));
    const spacious = buildTokenSystem(normalizeSpec({ density: "spacious" }));
    expect(compact.spacing["spacing-05"]).toBe(14);
    expect(spacious.spacing["spacing-05"]).toBe(18);
  });

  it("keep fields rectangular for pill-shaped buttons", () => {
    const t = buildTokenSystem(normalizeSpec({ radius: { control: 999, container: 12 } }));
    expect(t.radii.control).toBe(999);
    expect(t.radii.field).toBe(8);
  });
});

describe("brand spec", () => {
  it("normalises colours, numbers and the prefix, and records overrides", () => {
    const s = normalizeSpec(
      { name: "Acme Outdoor GmbH", colors: { primary: "#0F5", secondary: "nope" }, controlHeight: 99 },
      { colors: { accent: "rgb(255, 0, 0)" }, density: "compact" },
    );
    expect(s.prefix).toBe("acme");
    expect(s.colors.primary).toBe("#00ff55");
    expect(s.colors.secondary).toBeUndefined();
    expect(s.colors.accent).toBe("#ff0000");
    expect(s.controlHeight).toBe(56);
    expect(s.sources?.["colors.accent"]).toBe("override");
    expect(s.sources?.density).toBe("override");
    expect(prefixFrom("1&1 Telecom")).toBe("telecom");
    expect(normalizeSpec({ prefix: "Bad Prefix!", name: "Zeta" }).prefix).toBe("badprefix");
  });
});

describe("token outputs", () => {
  const t = buildTokenSystem(normalizeSpec({ name: "Acme", colors: { primary: "#0f5132" } }));
  it("CSS has every token on :root and in every theme block", () => {
    const css = tokensCss(t);
    for (const k of SEMANTIC_TOKENS) expect(css).toContain(`--acme-${k}:`);
    for (const n of THEMES) expect(css).toContain(`[data-acme-theme="${n}"]`);
    expect(css).toContain("--acme-body-01-font-size:");
    expect(css).toContain("--acme-radius-field:");
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*--acme-duration-fast-01: 0ms/);
  });
  it("DTCG JSON, SCSS, JS and Tailwind agree", () => {
    const j = JSON.parse(tokensJson(t));
    expect(j.theme.light.interactive).toEqual({ $value: t.themes.light.interactive, $type: "color" });
    expect(j.palette.primary["80"].$value).toBe("#0f5132");
    expect(j.type["body-01"].$type).toBe("typography");
    expect(tokensScss(t)).toContain(`"interactive": ${t.themes.dark.interactive}`);
    const { js, dts } = tokensJs(t);
    expect(js).toContain('"defaultTheme": "light"');
    expect(dts).toContain("export type ThemeName");
    expect(tailwindPreset(t)).toContain('"interactive": "var(--acme-interactive)"');
    expect(gridCss(t)).toContain(".acme-col-lg-16");
  });
});
