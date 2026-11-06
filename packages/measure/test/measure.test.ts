import { describe, expect, it } from "vitest";
import { encodePng, type RgbImage } from "@harness/capture";
import {
  bandMismatch,
  comparePage,
  interactionChecks,
  liveExpectations,
  maskRects,
  measure,
  parseVerdict,
  pixelDiff,
  textCompare,
  layoutCheck,
  sweepWidths,
} from "@harness/measure";

const solid = (w: number, h: number, rgb: [number, number, number]): RgbImage => {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(rgb, i * 3);
  return { width: w, height: h, data };
};
const paint = (
  img: RgbImage,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: [number, number, number],
) => {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) img.data.set(rgb, (y * img.width + x) * 3);
  return img;
};

describe("pixelDiff", () => {
  it("counts identical images as 0 and a changed block as mismatch in its band", () => {
    const a = solid(100, 400, [255, 255, 255]);
    expect(pixelDiff(a, a).report.mismatch).toBe(0);
    const b = paint(solid(100, 400, [255, 255, 255]), 0, 250, 100, 50, [200, 0, 0]);
    const { report } = pixelDiff(a, b);
    // the block's first and last rows find a matching pixel one row away: shifted, not wrong (48 of 50 rows count)
    expect(report.mismatch).toBeCloseTo(4800 / 40000, 3);
    expect(report.bands[0].mismatch).toBe(0);
    expect(report.bands[1].mismatch).toBeCloseTo(0.24, 3);
    // band granularity: rows inside one band report that band's share
    expect(bandMismatch(report, 250, 300)).toBeCloseTo(0.24, 3);
  });

  it("treats a 1px shift as shifted, not wrong, and missing rows as mismatch", () => {
    const a = paint(solid(50, 50, [255, 255, 255]), 10, 10, 20, 20, [0, 0, 0]);
    const b = paint(solid(50, 50, [255, 255, 255]), 11, 10, 20, 20, [0, 0, 0]);
    const r = pixelDiff(a, b).report;
    expect(r.mismatch).toBe(0);
    expect(r.shifted).toBeGreaterThan(0);
    expect(pixelDiff(solid(10, 20, [0, 0, 0]), solid(10, 10, [0, 0, 0])).report.mismatch).toBeCloseTo(0.5, 3);
  });

  it("excludes live-content bands from the totals", () => {
    const a = solid(10, 400, [255, 255, 255]);
    const b = paint(solid(10, 400, [255, 255, 255]), 0, 0, 10, 200, [0, 0, 0]);
    expect(pixelDiff(a, b, { exclude: [[0, 200]] }).report.mismatch).toBe(0);
  });
});

describe("textCompare", () => {
  it("separates the output's own misses from live content drift", () => {
    const live = ["Gear for every trail", "Breaking: new store opens"];
    const out = ["Gear for every trail", "Old headline"];
    const captured = ["Gear for every trail", "Old headline"];
    const r = textCompare(live, out, captured);
    expect(r.missing).toEqual(["Breaking: new store opens"]);
    expect(r.drift?.count).toBe(2);
    expect(r.real).toEqual({ missing: [], extra: [] });
  });
});

describe("interactions", () => {
  it("passes or fails as live", () => {
    const live = { menu: true, submenu: true, carousels: 1, pinnedHeader: true };
    expect(
      interactionChecks(
        {
          menu: { opened: true },
          submenu: { opened: true },
          carousels: [{ moved: true }],
          pinned: { stays: true },
        },
        live,
      ).every((c) => c.result === "pass"),
    ).toBe(true);
    const failed = interactionChecks(
      { menu: null, submenu: null, carousels: [{ moved: false }], pinned: null },
      live,
    );
    expect(failed.map((c) => `${c.name}:${c.result}`)).toEqual([
      "menu:fail",
      "submenu:fail",
      "carousel:fail",
      "pinned:fail",
    ]);
    // nothing on the live page, nothing to check
    expect(interactionChecks({}, { menu: false, submenu: false, carousels: 0, pinnedHeader: false })).toEqual(
      [],
    );
  });

  it("reads what the live page has from a snapshot", () => {
    const snap = {
      page: { width: 390 },
      states: [{ kind: "menu" }],
      root: {
        children: [{ layout: { position: "sticky" }, rect: { y: 0, w: 390 } }, { carousel: { dir: 1 } }],
      },
    };
    expect(liveExpectations(snap)).toEqual({ menu: true, submenu: false, carousels: 1, pinnedHeader: true });
  });
});

describe("measure + gates + compare page", () => {
  it("evaluates pixel / text / layout / interaction gates per width", () => {
    const live = encodePng(solid(100, 300, [255, 255, 255]));
    const bad = encodePng(paint(solid(100, 330, [255, 255, 255]), 0, 0, 100, 60, [0, 0, 0]));
    const { report, images } = measure({
      target: "static",
      live: [{ width: 100, png: live, texts: ["Hello world"] }],
      out: [{ width: 100, png: bad, texts: ["Hello"], overflowPx: 12, probe: { menu: null } }],
      expectations: { 100: { menu: true, submenu: false, carousels: 0, pinnedHeader: false } },
    });
    expect(report.pass).toBe(false);
    expect(Object.fromEntries(report.gates.map((g) => [g.name, g.pass]))).toEqual({
      pixel: false,
      text: false,
      layout: false,
      interactions: false,
    });
    expect(images[0].diff.length).toBeGreaterThan(0);
    const html = comparePage([report], { title: "Acme", sourceUrl: "https://acme.example/" });
    expect(html).toContain("../measure/static/100/diff.png");
    expect(html).toContain("✗ pixel");
  });
});

describe("parseVerdict", () => {
  it("accepts fenced JSON and rejects junk", () => {
    expect(
      parseVerdict(
        '```json\n{"verdict":"close","differences":[{"band":0,"issue":"logo smaller","severity":"major"}]}\n```',
      ),
    ).toEqual({
      verdict: "close",
      differences: [{ band: 0, issue: "logo smaller", severity: "major" }],
    });
    expect(parseVerdict("looks fine")).toBeNull();
    expect(parseVerdict('{"verdict":"great"}')).toBeNull();
  });
});

describe("measuring rules from the bvg.de run", () => {
  it("ignores glyph-only strings and soft hyphens the capture inserted", () => {
    const r = textCompare(
      ["Mollstr./​Prenzlauer Allee", "Infos"],
      ["◄►", "Mollstr./​­Prenzlauer Allee", "Infos"],
    );
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it("does not expect a header that slides away on scroll to stay pinned", () => {
    const snap = {
      page: { width: 390 },
      root: {
        children: [
          { layout: { position: "fixed" }, rect: { y: 0, w: 390 }, scrollShift: { dy: -60, mode: "step" } },
        ],
      },
    };
    expect(liveExpectations(snap).pinnedHeader).toBe(false);
  });
});

describe("measuring rules from the ibmix.de run", () => {
  it("paints moving media out of both shots: a hero video's other frame is no mismatch", () => {
    const live = solid(100, 300, [255, 255, 255]);
    const out = paint(solid(100, 300, [255, 255, 255]), 0, 0, 100, 100, [200, 30, 90]);
    const plain = measure({
      target: "static",
      live: [{ width: 100, png: encodePng(live) }],
      out: [{ width: 100, png: encodePng(out) }],
    });
    expect(plain.report.widths[0].pixel).toBeGreaterThan(0.3);
    const masked = measure({
      target: "static",
      live: [{ width: 100, png: encodePng(live) }],
      out: [{ width: 100, png: encodePng(out) }],
      mask: { 100: [{ x: 0, y: 0, w: 100, h: 100 }] },
    });
    expect(masked.report.widths[0].pixel).toBe(0);
    // the images written for the compare page keep their pixels
    expect(maskRects(live, undefined)).toBe(live);
  });

  it("does not expect a pinned header from an off-canvas drawer or a full-screen panel", () => {
    const snap = (rect: { x: number; y: number; w: number; h: number }) => ({
      page: { width: 390 },
      viewport: { width: 390, height: 844 },
      root: {
        tag: "body",
        rect: { x: 0, y: 0, w: 390, h: 4000 },
        children: [{ tag: "nav", layout: { position: "fixed" }, rect }],
      },
    });
    expect(liveExpectations(snap({ x: 390, y: 0, w: 390, h: 844 })).pinnedHeader).toBe(false);
    expect(liveExpectations(snap({ x: 0, y: 0, w: 390, h: 844 })).pinnedHeader).toBe(false);
    expect(liveExpectations(snap({ x: 0, y: 0, w: 390, h: 56 })).pinnedHeader).toBe(true);
  });
});

describe("responsive gate", () => {
  it("sweeps the narrowest phone, the gaps between captures and wide screens", () => {
    expect(sweepWidths([390, 768, 1440])).toEqual([320, 579, 1104, 1920, 2560]);
    expect(sweepWidths([375, 1920])).toEqual([320, 1148, 2560]);
  });

  it("fails overlapping or off-screen text the live page does not have, and sideways scroll", () => {
    const facts = (overlapCount: number, offscreenCount: number) => ({
      blocks: 40,
      overlaps: overlapCount ? [["The essentials to scale AI", "Take AI beyond experimentation"]] : [],
      overlapCount,
      offscreen: offscreenCount ? ["speed of business,"] : [],
      offscreenCount,
    });
    expect(
      layoutCheck(2560, { probe: facts(0, 0), overflowPx: 0 }, { probe: facts(0, 0) }, 0.02, 0.05).pass,
    ).toBe(true);
    const bad = layoutCheck(2048, { probe: facts(3, 2), overflowPx: 40 }, { probe: facts(0, 0) }, 0.2, 0.05);
    expect(bad.pass).toBe(false);
    expect(bad.issues.join(" | ")).toMatch(
      /overlapping text.*essentials.*outside the screen.*horizontal scroll.*pixel/,
    );
    // a live page that overlaps by design: as many on the output is fine
    expect(layoutCheck(1104, { probe: facts(2, 0) }, { probe: facts(2, 0) }, undefined, 0.05).pass).toBe(
      true,
    );
  });

  it("adds the responsive gate to the report when a sweep is measured", () => {
    const png = encodePng(solid(50, 50, [255, 255, 255]));
    const ok = { blocks: 1, overlaps: [], overlapCount: 0, offscreen: [], offscreenCount: 0 };
    const { report } = measure({
      target: "static",
      live: [{ width: 50, png }],
      out: [{ width: 50, png }],
      sweep: {
        out: [{ width: 1920, png, probe: { ...ok, overlapCount: 4, overlaps: [["a", "b"]] } }],
        live: [{ width: 1920, png, probe: ok }],
      },
    });
    const g = report.gates.find((x) => x.name === "responsive")!;
    expect(g.pass).toBe(false);
    expect(g.detail).toMatch(/1920px 4 overlapping/);
    expect(report.sweep?.[0].width).toBe(1920);
  });
});
