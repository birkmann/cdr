import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  flowLint,
  isMediaPin,
  isValuePin,
  mediaWidths,
  REPAIR_RULES,
  sectionClasses,
} from "@harness/measure";

const CORPUS = new URL("./corpus/", import.meta.url);
const files = (kind: "cheat" | "honest") =>
  readdirSync(new URL(`${kind}/`, CORPUS))
    .filter((f) => f.endsWith(".css"))
    .map((f) => ({ name: f, css: readFileSync(new URL(`${kind}/${f}`, CORPUS), "utf8") }));

/** a proposed patch for the "hero" section: everything in it is added after the build */
const asPatch = (css: string) =>
  flowLint({
    css,
    baseline: null,
    scope: {
      ids: ["hero"],
      classes: ["hero-title", "hero-copy", "hero-media", "hero-grid", "hero-row", "hero-nav"],
    },
    mediaClasses: ["hero-media"],
    boundaries: [768, 1024],
  });

export const CHEATS = files("cheat");
export const HONEST = files("honest");

describe("flowLint: the cheat corpus (one way to fit the checked widths per file)", () => {
  it("has a file for every way the plan lists", () => {
    expect(CHEATS.length).toBeGreaterThanOrEqual(10);
  });
  for (const f of CHEATS)
    it(`${f.name} is flagged by exactly its rule`, () => {
      const rule = f.name.split(".")[0];
      const r = asPatch(f.css);
      expect(r.violations.length, JSON.stringify(r.violations)).toBeGreaterThan(0);
      expect([...new Set(r.violations.map((v) => v.rule))]).toEqual([rule]);
      expect(REPAIR_RULES).toContain(rule);
    });
});

describe("flowLint: the honest corpus (CSS that flows)", () => {
  for (const f of HONEST)
    it(`${f.name} is not flagged`, () => {
      expect(asPatch(f.css).violations).toEqual([]);
    });
});

describe("flowLint: the emitter's own stylesheet and what is added to it", () => {
  const base = `.hero-title { position: absolute; top: 12px; height: 40px; }
@media (min-width: 768px) and (max-width: 1023.98px) { .hero-copy { width: 50%; } }
.hero-copy { width: calc(10px + 1000 * max(100vw - 768px, 768px - 100vw)); }`;
  it("counts pins in the build's own rules but never reports them as added", () => {
    const r = flowLint({ css: base, boundaries: [768, 1024] });
    expect(r.counts).toEqual({ "value-pin": 1 });
    expect(r.violations.every((v) => !v.added)).toBe(true);
  });
  it("reports only the rules added after the build as added", () => {
    const r = flowLint({
      css: `${base}\n/* repair */\n.hero-copy { position: absolute; }`,
      baseline: base,
      scope: { ids: ["hero"], classes: ["hero-copy", "hero-title"] },
    });
    expect(r.added).toBe(1);
    expect(r.violations.filter((v) => v.added).map((v) => v.rule)).toEqual(["added-out-of-flow"]);
  });
  it("leaves out sections the emitter kept fitted", () => {
    const r = flowLint({ css: base, boundaries: [768, 1024], exempt: ["hero-copy"] });
    expect(r.counts).toEqual({});
  });
  it("reports CSS that does not parse", () => {
    expect(flowLint({ css: ".a { color: red", baseline: null }).violations[0]?.rule).toBe("parse");
  });
});

describe("media and value pins", () => {
  it("reads width conditions in both syntaxes", () => {
    expect(mediaWidths("(min-width: 768px) and (max-width: 1023.98px)")).toEqual({ min: 768, max: 1023.98 });
    expect(mediaWidths("(600px <= width < 610px)")).toEqual({ min: 600, max: 610 });
    expect(mediaWidths("(width: 90em)")).toEqual({ exact: 1440 });
    expect(mediaWidths("(prefers-reduced-motion: reduce)")).toBeNull();
  });
  it("is a pin only around one width, not at the variants' own boundaries", () => {
    expect(isMediaPin("(width: 1440px)")).toBe(true);
    expect(isMediaPin("(600px <= width < 610px)")).toBe(true);
    expect(isMediaPin("(min-width: 1024px)")).toBe(false);
    expect(isMediaPin("(min-width: 768px) and (max-width: 1023.98px)", [768, 1024])).toBe(false);
    expect(isMediaPin("(min-width: 1015px) and (max-width: 1023.98px)", [1015, 1024])).toBe(false);
    expect(isMediaPin("(min-width: 1015px) and (max-width: 1023.98px)", [768, 1024])).toBe(true);
  });
  it("is a value pin when a viewport term gets a large factor", () => {
    expect(isValuePin("clamp(0px, (100vw - 391.5px) * 1000, 1px)")).toBe(true);
    expect(isValuePin("calc(320px + 1000 * max(100vw - 1440px, 1440px - 100vw))")).toBe(true);
    expect(isValuePin("calc(12px + 0.333333 * (100vw - 768px))")).toBe(false);
    expect(isValuePin("clamp(28px, 2.4vw + 18px, 56px)")).toBe(false);
    expect(isValuePin("calc(1000 * 2px)")).toBe(false);
  });
});

describe("sectionClasses", () => {
  it("collects every copy's classes per section and the classes of media", () => {
    const html = `<!-- section:hero --><div class="a b"><img class="pic" src="x.png"><p class="t">Hi</p></div><!-- /section -->
<!-- section:hero --><div class="c"></div><!-- /section --><!-- section:foot --><p class="f">x</p><!-- /section -->`;
    const r = sectionClasses(html);
    expect([...r.sections.get("hero")!].sort()).toEqual(["a", "b", "c", "pic", "t"]);
    expect([...r.sections.get("foot")!]).toEqual(["f"]);
    expect([...r.media]).toEqual(["pic"]);
  });
});
