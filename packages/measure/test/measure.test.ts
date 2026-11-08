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
  sweepPlan,
  sweepWidths,
  type ContentPair,
  type LayoutFacts,
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
  it("screenshots the live page at the narrowest phone, the gaps between captures and wide screens", () => {
    expect(sweepWidths([390, 768, 1440])).toEqual([320, 579, 1104, 1920, 2560]);
    expect(sweepWidths([375, 1920])).toEqual([320, 1148, 2560]);
  });

  const captured = [390, 768, 1440];
  const measured = [
    320, 360, 375, 393, 412, 579, 767, 810, 820, 896, 1023, 1024, 1232, 1280, 1366, 1536, 1680, 1728, 1920,
  ];
  const plan = (seed: string) => sweepPlan({ captured, measured, boundaries: [768, 1024], seed });

  it("checks a dense grid, both sides of every variant boundary and rotating widths", () => {
    const p = plan("run:0");
    // every 24 px below 1024, every 48 px above, up to the widest measured width, and 2560
    expect(p.grid.slice(0, 4)).toEqual([320, 344, 368, 392]);
    expect(p.grid).toContain(1016);
    expect(p.grid).toContain(1040);
    expect(p.grid).toContain(1088);
    expect(p.grid.at(-2)).toBe(1920);
    expect(p.grid.at(-1)).toBe(2560);
    for (let i = 1; i < p.grid.length - 1; i++) expect(p.grid[i]! - p.grid[i - 1]!).toBeLessThanOrEqual(48);
    expect(p.grid.length).toBeGreaterThanOrEqual(45);
    expect(p.boundaries).toEqual([767, 1023, 1024]);
    expect(p.rotating).toHaveLength(6);
    for (const w of p.all) expect(captured).not.toContain(w);
    for (const w of p.rotating)
      for (const t of [...captured, ...measured]) expect(Math.abs(w - t)).toBeGreaterThanOrEqual(8);
    // the live page is probed at the grid and the boundaries; the rotating widths are judged against neighbours
    expect(p.live).toEqual([...new Set([...p.grid, ...p.boundaries])].sort((a, b) => a - b));
    for (const w of p.rotating) expect(p.live).not.toContain(w);
  });

  it("changes the rotating widths with every measurement, and only then", () => {
    expect(plan("run:0").rotating).toEqual(plan("run:0").rotating);
    expect(plan("run:1").rotating).not.toEqual(plan("run:0").rotating);
    expect(plan("run:1").grid).toEqual(plan("run:0").grid);
  });

  const facts = (o: Partial<LayoutFacts> = {}): LayoutFacts => ({
    blocks: 40,
    overlaps: [],
    overlapCount: 0,
    offscreen: [],
    offscreenCount: 0,
    offscreenKeys: [],
    pairs: [],
    clipped: [],
    clippedText: [],
    outOfFlow: [],
    docHeight: 3000,
    anchors: [],
    ...o,
  });
  const pair = (a: string, b: string, kind: ContentPair["kind"] = "text"): ContentPair => ({
    key: [`t:${a.toLowerCase()}`, b === "media" ? "media" : `t:${b.toLowerCase()}`].sort().join(" × "),
    kind,
    a,
    b,
  });

  it("passes an overlap the live page has too, and fails another one even when the counts match", () => {
    const same = pair("Sunrise at 3,000 m", "media", "media");
    const ok = layoutCheck(
      1104,
      { probe: facts({ pairs: [same], overlapCount: 1 }) },
      { probe: facts({ pairs: [same], overlapCount: 1 }) },
      undefined,
      0.05,
    );
    expect(ok.pass).toBe(true);
    const other = layoutCheck(
      488,
      { probe: facts({ pairs: [pair("Summit tent", "Learn more")], overlapCount: 1 }) },
      { probe: facts({ pairs: [pair("Gear for every trail", "Shop now")], overlapCount: 1 }) },
      undefined,
      0.05,
    );
    expect(other.pass).toBe(false);
    expect(other.issues[0]).toMatch(
      /1 overlapping pair the live page does not have: "Summit tent" × "Learn more"/,
    );
    expect(other.pairs?.map((p) => p.a)).toEqual(["Summit tent"]);
  });

  it("fails text cut off by its box unless the live page cuts the same text", () => {
    const cut = {
      clipped: ["t:sunrise at 3,000 m"],
      clippedText: [{ k: "t:sunrise at 3,000 m", text: "Sunrise at 3,000 m" }],
    };
    expect(layoutCheck(1088, { probe: facts(cut) }, { probe: facts() }, undefined, 0.05).issues[0]).toMatch(
      /1 text cut off by their box: "Sunrise at 3,000 m"/,
    );
    expect(layoutCheck(1088, { probe: facts(cut) }, { probe: facts(cut) }, undefined, 0.05).pass).toBe(true);
  });

  it("matches the pieces of a text the output splits by line with the live block holding them, the nearest one", () => {
    const live = facts({
      pairs: [pair("Der neue BMW iX3 M60 xDrive.", "media", "media")],
      anchors: [
        { k: "t:der neue bmw ix4", x: 24, y: 700 },
        { k: "t:der neue bmw ix3 m60 xdrive.", x: 24, y: 4787 },
      ],
    });
    const out = facts({
      pairs: [pair("Der neue", "media", "media"), pair("BMW iX3 M60 xDrive.", "media", "media")],
      outOfFlow: ["t:der neue"],
      anchors: [
        { k: "t:der neue", x: 137, y: 4787 },
        { k: "t:bmw ix3 m60 xdrive.", x: 61, y: 4827 },
      ],
    });
    const c = layoutCheck(
      390,
      { probe: out },
      { probe: { ...live, outOfFlow: ["t:der neue bmw ix3 m60 xdrive."] } },
      undefined,
      0.05,
    );
    expect(c.pairs).toEqual([]);
    expect(c.outOfFlow).toEqual([]);
    // the piece of a block the live page keeps in flow is out of flow here
    expect(layoutCheck(390, { probe: out }, { probe: live }, undefined, 0.05).outOfFlow).toEqual([
      "t:der neue",
    ]);
  });

  it("judges a width without live facts against its neighbours either side", () => {
    const p = pair("Summit tent", "Learn more");
    const c = layoutCheck(500, { probe: facts({ pairs: [p] }) }, null, undefined, 0.05, true, {
      neighbours: [{ probe: facts() }, { probe: facts({ pairs: [p] }) }],
    });
    expect(c.against).toBe("neighbours");
    expect(c.pass).toBe(true);
    const lone = layoutCheck(500, { probe: facts({ pairs: [p] }) }, null, undefined, 0.05);
    expect(lone.against).toBe("none");
    expect(lone.pass).toBe(false);
  });

  it("fails a page height off the live page's inside the measured spans, notes it outside", () => {
    const inside = layoutCheck(
      608,
      { probe: facts({ docHeight: 3530 }) },
      { probe: facts({ docHeight: 3240 }) },
      undefined,
      0.05,
      true,
      { heightPct: 5 },
    );
    expect(inside.pass).toBe(false);
    expect(inside.height).toEqual({ out: 3530, live: 3240, pct: 9 });
    const outside = layoutCheck(
      608,
      { probe: facts({ docHeight: 3530 }) },
      { probe: facts({ docHeight: 3240 }) },
      undefined,
      0.05,
      false,
      { heightPct: 5 },
    );
    expect(outside.pass).toBe(true);
    expect(outside.notes.join()).toMatch(/page height/);
    expect(
      layoutCheck(
        608,
        { probe: facts({ docHeight: 3300 }) },
        { probe: facts({ docHeight: 3240 }) },
        undefined,
        0.05,
        true,
        { heightPct: 5 },
      ).pass,
    ).toBe(true);
  });

  it("finds texts the output takes out of the flow while the live page keeps them in it", () => {
    const anchors = [{ k: "t:summit tent", x: 0, y: 10 }];
    const c = layoutCheck(
      768,
      { probe: facts({ outOfFlow: ["t:summit tent", "t:menu"], anchors }) },
      { probe: facts({ outOfFlow: ["t:menu"], anchors: [...anchors, { k: "t:menu", x: 0, y: 0 }] }) },
      undefined,
      0.05,
    );
    expect(c.outOfFlow).toEqual(["t:summit tent"]);
    expect(c.pass).toBe(true);
  });

  it("compares older facts (no keys) by count", () => {
    const old = (overlapCount: number, offscreenCount: number) => ({
      blocks: 40,
      overlaps: overlapCount ? [["The essentials to scale AI", "Take AI beyond experimentation"]] : [],
      overlapCount,
      offscreen: offscreenCount ? ["speed of business,"] : [],
      offscreenCount,
    });
    expect(
      layoutCheck(2560, { probe: old(0, 0), overflowPx: 0 }, { probe: old(0, 0) }, 0.02, 0.05).pass,
    ).toBe(true);
    const bad = layoutCheck(2048, { probe: old(3, 2), overflowPx: 40 }, { probe: old(0, 0) }, 0.2, 0.05);
    expect(bad.pass).toBe(false);
    expect(bad.issues.join(" | ")).toMatch(
      /overlapping text.*essentials.*outside the screen.*horizontal scroll.*pixel/,
    );
    // a live page that overlaps by design: as many on the output is fine; one more is not (no slack any more)
    expect(layoutCheck(1104, { probe: old(2, 0) }, { probe: old(2, 0) }, undefined, 0.05).pass).toBe(true);
    expect(layoutCheck(1104, { probe: old(3, 0) }, { probe: old(2, 0) }, undefined, 0.05).pass).toBe(false);
  });

  it("adds the responsive and flow gates to the report", () => {
    const png = encodePng(solid(50, 50, [255, 255, 255]));
    const { report } = measure({
      target: "static",
      live: [{ width: 50, png }],
      out: [{ width: 50, png }],
      sweep: {
        out: [
          {
            width: 1920,
            png,
            probe: facts({ pairs: [pair("a", "b")], overlapCount: 1, overlaps: [["a", "b"]] }),
          },
        ],
        live: [{ width: 1920, png, probe: facts() }],
        plan: { grid: [1920], boundaries: [], rotating: [] },
      },
      flow: {
        lint: {
          violations: [{ rule: "value-pin", added: false, detail: "x" }],
          counts: { "value-pin": 1 },
          rules: 3,
          added: 0,
        },
      },
    });
    const g = report.gates.find((x) => x.name === "responsive")!;
    expect(g.pass).toBe(false);
    expect(g.detail).toMatch(/1920px 1 overlapping pair/);
    expect(report.sweep?.[0]?.width).toBe(1920);
    expect(report.sweepPlan?.grid).toEqual([1920]);
    // counted, not failing: pins in the emitter's own CSS fail only when they gate
    const f = report.gates.find((x) => x.name === "flow")!;
    expect(f.pass).toBe(true);
    expect(f.detail).toMatch(/value-pin 1/);
    const gated = measure({
      target: "static",
      live: [{ width: 50, png }],
      out: [{ width: 50, png }],
      flow: {
        lint: {
          violations: [{ rule: "value-pin", added: false, detail: "x" }],
          counts: { "value-pin": 1 },
          rules: 3,
          added: 0,
        },
        gating: ["value-pin"],
      },
    });
    expect(gated.report.flow?.pass).toBe(false);
  });
});
