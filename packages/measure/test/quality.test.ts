import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AXE_VERSION,
  QUALITY_PROBE_JS,
  lighthouseGate,
  liveQuality,
  qualityGates,
  type QualityProbe,
} from "@harness/measure";

const snap = (w: number) =>
  JSON.parse(
    readFileSync(
      new URL(`../../capture/test/sites/motion/recorded/${w}.snapshot.json`, import.meta.url),
      "utf8",
    ),
  );

const good: QualityProbe = {
  axe: [
    {
      id: "region",
      impact: "moderate",
      help: "All page content should be contained by landmarks",
      nodes: 1,
      targets: ["div"],
    },
  ],
  nodes: 106,
  depth: 9,
  lang: "en",
  title: "Northwind",
  description: true,
  h1: 1,
  headingJumps: 0,
  main: 1,
  images: 9,
  imagesNoAlt: 0,
  imagesNoSize: 0,
  imagesEagerBelow: 0,
  duplicateSubtrees: 0,
  duplicateText: 0,
  cssBytes: 15000,
  mediaQueries: 12,
  videos: [{ autoplay: true, playing: true, toggle: true, src: "hero.mp4" }],
  sliders: [{ dots: true, dotMoves: true, keyMoves: true, autoplay: true, loops: true }],
};

describe("quality gates", () => {
  const live = liveQuality([snap(390), snap(768), snap(1440)]);

  it("reads what the live page has: its moving video, its sliders' dots, autoplay and loop, its hover looks", () => {
    expect(live.videos).toBe(1);
    expect(live.sliders[0]).toMatchObject({ dots: true, autoplay: 4000 });
    expect(live.hover.length).toBeGreaterThan(3);
  });

  it("passes a recreation that has all of it, and names what is missing", () => {
    const ok = qualityGates(good, live, {
      outHover: live.hover.map((h) => ({ key: "x", tag: h.tag, label: h.label, changes: [] })),
    });
    expect(ok.gates.every((g) => g.pass)).toBe(true);
    const bad = qualityGates(
      {
        ...good,
        axe: [
          {
            id: "button-name",
            impact: "critical",
            help: "Buttons must have discernible text",
            nodes: 3,
            targets: ["button"],
          },
        ],
        h1: 0,
        duplicateSubtrees: 4,
        duplicateText: 900,
        videos: [{ autoplay: false, playing: false, toggle: false, src: "" }],
        sliders: [{ dots: false, dotMoves: false, keyMoves: true, autoplay: false, loops: false }],
      },
      live,
      { outHover: [] },
    );
    const by = Object.fromEntries(bad.gates.map((g) => [g.name, g]));
    expect(by.a11y!.pass).toBe(false);
    expect(by.a11y!.detail).toMatch(/button-name \(3\)/);
    expect(by.markup!.detail).toMatch(/4 hidden copies of shown content/);
    expect(by.markup!.detail).toMatch(/0 h1/);
    expect(by.motion!.pass).toBe(false);
    expect(by.behaviour!.detail).toMatch(/dots missing/);
    expect(by.behaviour!.detail).toMatch(/no autoplay/);
    expect(by.hover!.pass).toBe(false);
  });

  it("does not let the live page's own accessibility failures excuse the recreation's", () => {
    const r = qualityGates(
      { ...good, axe: [{ id: "color-contrast", impact: "serious", help: "", nodes: 2, targets: [] }] },
      live,
      { liveAxe: [{ id: "color-contrast", impact: "serious", help: "", nodes: 9, targets: [] }] },
    );
    expect(r.gates.find((g) => g.name === "a11y")).toMatchObject({ pass: false });
  });

  it("embeds axe-core in its in-page probe", () => {
    expect(AXE_VERSION).toMatch(/^4\./);
    expect(QUALITY_PROBE_JS).toContain("axe.run(document");
    expect(QUALITY_PROBE_JS.length).toBeGreaterThan(400_000);
  });

  it("judges Lighthouse scores against thresholds, and never passes a run that could not score", () => {
    const s = (p: number) => [
      {
        formFactor: "mobile" as const,
        performance: p,
        accessibility: 100,
        bestPractices: 100,
        seo: 100,
        failing: [],
        metrics: {},
      },
    ];
    expect(lighthouseGate(s(97)).pass).toBe(true);
    expect(lighthouseGate(s(80))).toMatchObject({
      pass: false,
      detail: expect.stringMatching(/mobile performance 80 < 90/),
    });
    expect(lighthouseGate(s(80), { performance: 75 }).pass).toBe(true);
    expect(lighthouseGate(null).detail).toMatch(/skipped/);
    expect(lighthouseGate([]).pass).toBe(false);
  });
});
