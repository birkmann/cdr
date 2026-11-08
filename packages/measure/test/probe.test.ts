// The layout probe in a real browser: one small page per fact it reports, and a page tuned to the checked widths.
// Skips without Chrome, like the other browser tests.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CdpCaptureDriver, findChrome } from "@harness/capture";
import {
  flowLint,
  LAYOUT_CHECK_JS,
  layoutCheck,
  sweepPlan,
  sweepWidths,
  type LayoutFacts,
} from "@harness/measure";

const chrome = findChrome();
const dir = mkdtempSync(join(tmpdir(), "probe-"));
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const page = (name: string, body: string, css = "") => {
  const file = join(dir, `${name}.html`);
  writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/20px sans-serif} ${css}</style></head><body>${body}</body></html>`,
  );
  return pathToFileURL(file).href;
};

describe.skipIf(!chrome)("LAYOUT_CHECK_JS in a browser", () => {
  const driver = new CdpCaptureDriver();
  afterAll(async () => {
    await (driver as unknown as { close?: () => Promise<void> }).close?.();
  });
  const facts = async (url: string, width = 600) =>
    (await driver.shoot(url, [width], { guard: false, probe: LAYOUT_CHECK_JS, factsOnly: true }))[0]!
      .probe as LayoutFacts;

  it("reports text over text, text over an image and a control without text over text, by key", async () => {
    const f = await facts(
      page(
        "overlaps",
        `<div style="position:relative;height:300px">
          <p style="position:absolute;top:0;left:0;margin:0">Summit tent</p>
          <p style="position:absolute;top:4px;left:20px;margin:0">Learn more</p>
          <img src="${PNG}" style="position:absolute;top:100px;left:0;width:200px;height:60px">
          <p style="position:absolute;top:110px;left:10px;margin:0">Over the picture</p>
          <p style="position:absolute;top:200px;left:0;margin:0">Under a button</p>
          <button aria-label="Close" style="position:absolute;top:196px;left:0;width:120px;height:28px"></button>
        </div>`,
      ),
    );
    const kinds = Object.fromEntries((f.pairs ?? []).map((p) => [p.key, p.kind]));
    expect(kinds).toEqual({
      "t:learn more × t:summit tent": "text",
      "media × t:over the picture": "media",
      "c:close × t:under a button": "control",
    });
    expect(f.overlapCount).toBe(1);
    expect(f.outOfFlow).toEqual(expect.arrayContaining(["t:summit tent", "t:learn more"]));
    expect(f.docHeight).toBeGreaterThanOrEqual(300);
  });

  it("reports text a box cuts off, but not ellipsis, a closed panel or text in a slider track", async () => {
    const f = await facts(
      page(
        "clipped",
        `<div style="height:20px;overflow:hidden"><p style="margin:0">One line<br>A second line the box has no room for</p></div>
         <div style="width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">An ellipsis does this on purpose</div>
         <div style="height:0;overflow:hidden"><p>Inside a closed panel</p></div>
         <div style="overflow-x:auto;display:flex;width:300px"><p style="flex:0 0 280px;margin:0">Slide one</p><p style="flex:0 0 280px;margin:0">Slide two runs past the edge</p></div>`,
      ),
    );
    expect(f.clipped).toHaveLength(1);
    expect(f.clipped![0]).toMatch(/^t:one line a second line/);
    expect(f.offscreenKeys).toEqual([]);
    expect(f.pairs).toEqual([]);
  });

  it("does not report text over the picture that is its own box's background", async () => {
    const f = await facts(
      page(
        "hero",
        `<section style="height:300px;background:url(${PNG}) center/cover"><h1 style="margin:0;padding:40px">Gear for every trail</h1></section>`,
      ),
    );
    expect(f.pairs).toEqual([]);
    expect(f.outOfFlow).toEqual([]);
  });

  it("keys a text by its block: runs split over inline elements on one page match the joined text on the other", async () => {
    const hero = (title: string) =>
      `<section style="position:relative;height:300px"><img src="${PNG}" style="position:absolute;inset:0;width:100%;height:100%">
        <h2 style="position:absolute;top:100px;left:20px;margin:0;font-size:32px">${title}</h2></section>`;
    const [split, joined] = await Promise.all([
      facts(page("split", hero("Der neue<br><span>BMW iX4</span>"))),
      facts(page("joined", hero("DER NEUE BMW iX4"), "h2{text-transform:uppercase}")),
    ]);
    expect(new Set(split.pairs!.map((p) => p.key))).toEqual(new Set(["media × t:der neue bmw ix4"]));
    // the recreation's text over the picture is the live page's: no pair, no text out of flow the live page keeps in flow
    const r = layoutCheck(600, { probe: joined }, { probe: split }, undefined, 1);
    expect(r.pairs).toEqual([]);
    expect(r.outOfFlow ?? []).toEqual([]);
  });

  it("reports the height of every section of a recreation as shown at the width", async () => {
    const f = await facts(
      page(
        "sections",
        `<div data-section="hero" style="height:120px">a</div><div data-section="hero" style="display:none;height:999px"></div><div data-section="footer" style="height:40px">b</div>`,
      ),
    );
    expect(f.sections).toEqual({ hero: 120, footer: 40 });
  });
});

describe.skipIf(!chrome)("a page tuned to the widths a gate checks (sites/pinned)", () => {
  const driver = new CdpCaptureDriver();
  afterAll(async () => {
    await (driver as unknown as { close?: () => Promise<void> }).close?.();
  });
  const site = (f: string) =>
    pathToFileURL(fileURLToPath(new URL(`./sites/pinned/${f}`, import.meta.url))).href;
  const old = sweepWidths([390, 768, 1440]);
  const plan = sweepPlan({
    captured: [390, 768, 1440],
    measured: [320, 579, 1104, 1920],
    boundaries: [768, 1024],
    seed: "p:0",
  });
  const sweep = async (f: string, ws: number[]) =>
    new Map(
      (await driver.shoot(site(f), ws, { guard: false, probe: LAYOUT_CHECK_JS, factsOnly: true })).map(
        (s) => [s.width, s],
      ),
    );

  it("passes at the widths the old gate checked, fails the dense sweep; the honest card passes both", async () => {
    const ws = [...new Set([...old, ...plan.all])].sort((a, b) => a - b);
    const [pinned, honest] = await Promise.all([sweep("index.html", ws), sweep("honest.html", ws)]);
    const fails = (m: typeof pinned, at: number[]) =>
      at.filter((w) => !layoutCheck(w, m.get(w)!, { probe: honest.get(w)!.probe }, undefined, 1).pass);
    // at the five old widths the coordinates were corrected: nothing to see
    expect(fails(pinned, old)).toEqual([]);
    // wherever its text takes more lines than at those widths, the link sits on it
    const bad = fails(pinned, plan.all);
    expect(bad.length).toBeGreaterThan(10);
    expect(bad.some((w) => w > 400 && w < 700)).toBe(true);
    expect(fails(honest, ws)).toEqual([]);
  });

  it("is flagged by the flow lint: media queries around single widths", () => {
    const css = readFileSync(new URL("./sites/pinned/index.html", import.meta.url), "utf8").match(
      /<style>([\s\S]*?)<\/style>/,
    )![1]!;
    expect(flowLint({ css }).counts["media-pin"]).toBe(2);
  });
});
