import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pageScreens } from "@harness/scene";
import { brandFoundations } from "@harness/extract";
import { DEFAULT_TOKENS } from "@harness/protocol";
import { encodePng, findChrome } from "@harness/capture";
import {
  imagePalette,
  nameFromUrl,
  normalizeSpec,
  parseVisionSpec,
  readImages,
  snap,
  specFromFoundations,
  specFromPalette,
} from "@harness/design-system";

const recorded = JSON.parse(
  readFileSync(new URL("../../capture/test/sites/acme/recorded/1440.snapshot.json", import.meta.url), "utf8"),
);

/** A PNG of horizontal colour bands (each [hex, share]). */
function bandsPng(bands: [string, number][], w = 200, h = 200): string {
  const data = new Uint8Array(w * h * 3);
  let y = 0;
  for (const [hex, share] of bands) {
    const rows = Math.round(h * share);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (let yy = y; yy < Math.min(h, y + rows); yy++)
      for (let x = 0; x < w; x++) data.set([r!, g!, b!], (yy * w + x) * 3);
    y += rows;
  }
  return encodePng({ width: w, height: h, data }).toString("base64");
}

describe("URL reading", () => {
  it("turns the brand foundations of a captured page into a spec", () => {
    const screens = pageScreens([{ width: 1440, minWidth: 0, snap: recorded }], undefined, {
      flow: false,
    }).screens;
    const f = brandFoundations(screens, {
      version: 1,
      name: "Acme",
      tokens: { ...DEFAULT_TOKENS },
      componentSets: [],
    });
    const spec = normalizeSpec(specFromFoundations(f, "Acme Outdoor"));
    expect(spec.colors.primary).toBe("#0f5132");
    expect(spec.fonts.sans).toBe("Acme Sans");
    expect(spec.radius.control).toBe(999);
    expect(spec.controlHeight).toBe(48);
    expect(spec.buttons.secondary).toBe("tonal");
    expect(spec.sources?.["colors.primary"]).toBe("site");
    // derived colours are not passed off as the site's
    expect(spec.colors.secondary).toBeUndefined();
    expect(spec.notes?.join(" ")).toMatch(/does not bundle/);
  });

  it("names a brand from its URL", () => {
    expect(nameFromUrl("https://www.acme-outdoor.com/de")).toBe("Acme Outdoor");
    expect(nameFromUrl("bvg.de")).toBe("Bvg");
  });
});

describe("image reading", () => {
  const palette = [
    { hex: "#ffffff", share: 0.6 },
    { hex: "#0043ce", share: 0.2 },
    { hex: "#161616", share: 0.15 },
    { hex: "#24a148", share: 0.05 },
  ];

  it("parses the vision reply and snaps its colours to the measured ones", () => {
    const reply =
      '```json\n{"name": "Northwind", "theme": "light", "colors": {"primary": "#0545d0", "text": "#151515", "background": "#fefefe", "success": "not a colour"}, "fonts": {"sans": "IBM Plex Sans"}, "radius": {"control": 0, "container": 0}, "controlHeight": 48, "density": "compact", "buttons": {"secondary": "outline", "uppercase": false}, "elevation": "none", "notes": ["flat, sharp corners"]}\n```';
    const s = parseVisionSpec(reply, palette)!;
    expect(s.colors?.primary).toBe("#0043ce");
    expect(s.colors?.text).toBe("#161616");
    expect(s.colors?.background).toBe("#ffffff");
    expect(s.colors).not.toHaveProperty("success");
    expect(s.density).toBe("compact");
    expect(s.sources?.["colors.primary"]).toBe("vision");
    expect(parseVisionSpec("no json here", palette)).toBeUndefined();
    expect(parseVisionSpec('{"colors": {}}', palette)).toBeUndefined();
    expect(snap("#ff00ff", palette)).toBe("#ff00ff");
  });

  it("falls back to the palette: the most colourful frequent colour is primary", () => {
    const s = specFromPalette(palette, "Northwind");
    expect(s.colors?.primary).toBe("#0043ce");
    expect(s.colors?.background).toBe("#ffffff");
    expect(s.theme).toBe("light");
  });

  it("uses the vision model when there is no browser, and fails clearly with neither", async () => {
    const images = [{ mimeType: "image/png", data: bandsPng([["#ffffff", 1]]) }];
    const r = await readImages(images, {
      complete: async () => '{"colors": {"primary": "#123456"}, "name": "Seen"}',
    });
    expect(r.method).toBe("vision");
    expect(r.spec.colors?.primary).toBe("#123456");
    expect(r.note).toMatch(/not measured/);
    await expect(readImages(images, { complete: async () => "NO_IMAGES" })).rejects.toThrow(/vision model/);
  });

  const chrome = findChrome();
  it.skipIf(!chrome)("measures the dominant colours of an image in Chrome", async () => {
    const data = bandsPng([
      ["#ffffff", 0.55],
      ["#0043ce", 0.3],
      ["#161616", 0.15],
    ]);
    const p = await imagePalette([{ mimeType: "image/png", data }], { chrome: chrome! });
    expect(p[0]!.hex).toBe("#ffffff");
    expect(p.map((c) => c.hex)).toEqual(expect.arrayContaining(["#0043ce", "#161616"]));
    expect(p[0]!.share).toBeGreaterThan(0.5);
    const spec = specFromPalette(p, "Bands");
    expect(spec.colors?.primary).toBe("#0043ce");
  });
});
