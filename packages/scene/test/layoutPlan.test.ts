// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import {
  devicePlan,
  layoutRanges,
  layoutSwitches,
  planCaptures,
  planSessions,
  type LayoutSwitch,
} from "@harness/scene";

// what fig-server measured on a real site (POST /api/import/url/layout), trimmed
const bvg: LayoutSwitch[] = [
  { px: 360, rules: 6, structural: 0.03, shifted: 0.56 },
  { px: 410, rules: 1, structural: 0, shifted: 0.0076 },
  { px: 480, rules: 71, structural: 0, shifted: 5.65 },
  { px: 481, rules: 1, structural: 0, shifted: 0 },
  { px: 640, rules: 3, structural: 0, shifted: 0 },
  { px: 768, rules: 209, structural: 1.49, shifted: 5.53 },
  { px: 801, rules: 3, structural: 0, shifted: 0.0088 },
  { px: 960, rules: 157, structural: 0.93, shifted: 1.12 },
  { px: 961, rules: 2, structural: 0, shifted: 0.31 },
  { px: 1025, rules: 1, structural: 0.027, shifted: 0 },
  { px: 1200, rules: 64, structural: 0.55, shifted: 2.83 },
  { px: 1440, rules: 11, structural: 0, shifted: 0 },
  { px: 1472, rules: 1, structural: 0, shifted: 0 },
];

describe("layout ranges of a page", () => {
  it("keeps the switches that change the layout: rules that never apply, tiny moves and phones below 360 px drop out", () => {
    // 961 is the other side of 960 (max-width: 960px / min-width: 960px): one switch, the bigger one
    expect(layoutSwitches(bvg)).toEqual([480, 768, 960, 1025, 1200]);
  });

  it("a small change of formatting counts (the header nav collapsing into the menu button)", () => {
    expect(
      layoutSwitches([
        { px: 1025, structural: 0.027 },
        { px: 1100, structural: 0.001, shifted: 0.01 },
      ]),
    ).toEqual([1025]);
  });

  it("a script switch (no CSS, its nodes re-created) counts by the structure that changed", () => {
    // audi.de: the header becomes the desktop one at about 1505 px through JavaScript
    expect(
      layoutSwitches([
        { px: 1505, rules: 0, source: "script", structural: 0, shifted: 0, tokens: 0.02 },
        { px: 1700, source: "script", tokens: 0.001 },
      ]),
    ).toEqual([1505]);
  });

  it("caps the ranges, dropping the least important switches", () => {
    expect(layoutSwitches(bvg, 3)).toEqual([768, 960]);
    expect(layoutSwitches([])).toEqual([]);
  });

  it("ranges run from 0 to the first switch, between switches, and from the last one on", () => {
    expect(layoutRanges([768, 1200])).toEqual([
      { min: 0, max: 768 },
      { min: 768, max: 1200 },
      { min: 1200, max: null },
    ]);
  });

  it("captures one width per range: the default widths, else the most common device width inside, measured at the range ends and common device widths", () => {
    expect(planCaptures([480, 768, 960, 1025, 1200])).toEqual([
      { width: 390, minWidth: 0, alt: [320, 360, 375, 393, 412, 479] },
      { width: 600, minWidth: 480, alt: [480, 767] },
      { width: 768, minWidth: 768, alt: [810, 820, 959] },
      { width: 1024, minWidth: 960, alt: [960] },
      { width: 1180, minWidth: 1025, alt: [1025] },
      { width: 1440, minWidth: 1200, alt: [1200, 1280, 1366, 1536, 1680, 1728, 1920] },
    ]);
  });

  it("one capture per device class walks the page at the other variants and every measured width of its class", () => {
    expect(
      planSessions(planCaptures([480, 768, 960, 1025, 1200])).map((s) => [
        s.width,
        s.alt,
        s.variants.map((v) => v.width),
      ]),
    ).toEqual([
      [390, [320, 360, 375, 393, 412, 479], [390]],
      // the other variants first, then the measured widths
      [768, [600, 480, 767, 810, 820, 959], [600, 768]],
      // more walks than one capture has time for: the desktop class is captured twice, side by side
      [1024, [1180, 960, 1025], [1024, 1180]],
      [1440, [1200, 1280, 1366, 1536, 1680, 1728, 1920], [1440]],
    ]);
    // one capture per class while it fits
    expect(planSessions(planCaptures([480, 768, 960, 1025, 1200]), 20).map((s) => s.width)).toEqual([
      390, 768, 1440,
    ]);
  });

  it("without switches the default widths split the page; two captures in one range share it", () => {
    expect(planCaptures([])).toEqual([
      { width: 390, minWidth: 0, alt: [320, 360, 375, 393, 412, 579, 767] },
      { width: 768, minWidth: 768, alt: [810, 820, 992, 1024, 1215, 1280, 1366, 1439] },
      { width: 1440, minWidth: 1440, alt: [1536, 1680, 1728, 1920] },
    ]);
  });

  it("a range without a common width is captured in its middle", () => {
    expect(planCaptures([1300, 1320]).map((p) => p.width)).toEqual([390, 768, 1310, 1440]);
  });

  it("one variant per device: each from the site switch nearest it, measured inside its own layout range only", () => {
    // ten-ish ranges become phone (0+), tablet (768+) and desktop (1025+); 480–767 stays phone, 960–1024 tablet
    expect(devicePlan([480, 768, 960, 1025, 1200])).toEqual([
      { width: 390, minWidth: 0, alt: [320, 360, 375, 393, 412, 479] },
      { width: 768, minWidth: 768, alt: [810, 820, 959] },
      { width: 1440, minWidth: 1025, alt: [1200, 1280, 1366, 1536, 1680, 1728, 1920] },
    ]);
    expect(
      planSessions(devicePlan([480, 768, 960, 1025, 1200])).map((ss) => [ss.width, ss.variants.length]),
    ).toEqual([
      [390, 1],
      [768, 1],
      [1440, 1],
    ]);
  });

  it("devices sharing a layout range split it at their own widths, as without switches", () => {
    expect(devicePlan([])).toEqual(planCaptures([]));
    // phone and tablet share 0–899; 900–1279 has no device width and starts in the tablet class
    expect(devicePlan([900, 1280]).map((p) => [p.width, p.minWidth])).toEqual([
      [390, 0],
      [768, 768],
      [1440, 1280],
    ]);
    expect(devicePlan([1100]).map((p) => p.minWidth)).toEqual([0, 768, 1100]);
  });
});
