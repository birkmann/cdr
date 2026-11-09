import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { preferCaptureWidths, pseudoTexts } from "@harness/recreate";
import { recordedDesignSystem } from "./design-system-helpers.js";

type Built = Awaited<ReturnType<typeof recordedDesignSystem>>;
let built: Built;
const read = (p: string) => readFileSync(join(built.out, p), "utf8");
beforeAll(async () => {
  built = await recordedDesignSystem();
}, 120_000);

describe("the page's semantics in the composites", () => {
  it("finds the texts the page draws through pseudo-elements", () => {
    const file = fileURLToPath(
      new URL("../../capture/test/sites/acme/recorded/1440.snapshot.json", import.meta.url),
    );
    expect(pseudoTexts([JSON.parse(readFileSync(file, "utf8"))])).toEqual(["✓"]);
  });

  it("draws a pseudo-element's text through the stylesheet, not as a text of the document", () => {
    const item = read("packages/site/src/components/ListItem/ListItem.tsx");
    expect(item).toContain('data-pseudo-text="✓"');
    expect(item).not.toMatch(/>✓</);
    expect(read("packages/site/src/styles/composites.css")).toContain("[data-pseudo-text]::before");
  });

  it("keeps the address of a link around a mark and a name", () => {
    expect(read("packages/site/src/components/Link/Link.tsx")).toMatch(/<a\b[^>]*href=/);
  });

  it("puts a slider's previous arrow before its track, as in the document", () => {
    const carousel = read("packages/site/src/components/Carousel/Carousel.tsx");
    const body = carousel.slice(carousel.indexOf("return ("));
    expect(body.indexOf("<FilledLightButton")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("<FilledLightButton")).toBeLessThan(body.indexOf("<MediaCarousel"));
  });

  it("does not ship a scale-to-fit: flow lint reads the emitted CSS", () => {
    expect(read("design-system/composites.raw.css")).not.toMatch(/\bzoom\s*:/);
  });
});

describe("capturing a page for its replica", () => {
  const plans = [
    { width: 390, minWidth: 0, alt: [] as number[] },
    { width: 768, minWidth: 768, alt: [] as number[] },
    { width: 1440, minWidth: 1024, alt: [] as number[] },
  ];

  it("measures the compared widths at the ranges they fall in, the plan stays complete", () => {
    const p = preferCaptureWidths(plans, [375, 768, 1440]);
    expect(p.map((x) => [x.width, x.minWidth])).toEqual([
      [375, 0],
      [768, 768],
      [1440, 1024],
    ]);
    expect(p[0]!.alt).toEqual([390]);
  });

  it("keeps ranges with no preferred width and uses the first preferred width of a range", () => {
    const p = preferCaptureWidths(plans, [320, 375]);
    expect(p[0]!.width).toBe(320);
    expect(p[1]!.width).toBe(768);
  });
});
