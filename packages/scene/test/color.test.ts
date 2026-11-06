// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import { alpha, isCssColor, parseColor } from "@harness/scene";
import { cssColor } from "@harness/scene";
import { DEFAULT_TOKENS } from "@harness/protocol";

describe("CSS Color 4 values (computed styles of captured pages)", () => {
  it("are colours the renderer and the exports keep", () => {
    for (const c of [
      "color(srgb 0 0 0 / 0.4)",
      "oklch(0.7 0.1 200)",
      "lab(50% 40 59)",
      "hwb(12 50% 0%)",
      "color-mix(in srgb, red 40%, blue)",
      "rgb(0 0 0 / 40%)",
    ]) {
      expect(isCssColor(c)).toBe(true);
      expect(cssColor(c, DEFAULT_TOKENS)).toBe(c);
    }
    expect(isCssColor("url(x.png)")).toBe(false);
  });

  it("parse for colour maths (space syntax, srgb channels 0..1)", () => {
    expect(parseColor("color(srgb 0 0 0 / 0.4)")).toEqual({ rgb: [0, 0, 0], a: 0.4 });
    expect(parseColor("color(srgb 1 0.5 0)")).toEqual({ rgb: [255, 127.5, 0], a: 1 });
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ rgb: [10, 20, 30], a: 0.5 });
    expect(alpha("color(srgb 1 1 1 / 0.2)", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
  });
});
