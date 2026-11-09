/**
 * Regressions from the Umami P8 baseline (W2-D failure classes 7 + 8, W2-E finding):
 *  - gates that compared nothing (empty CCM, every page 404 on the new side) are `not-run` = fail, never pass;
 *  - POC URLs without a CCM entry (listing pages) still count as missing pages when the new site 404s them;
 *  - a non-200 new document is diagnosed PAGE_MISSING (routing), not ASSET/request-failed;
 *  - TEXT_DIFF names insertions as "extra on new page", not `"" → "…"` (which read as "old main text is empty").
 */
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiteConfig, Workspace, type Logger } from "@harness/mirror-core";
import { verifyStep, classify, type SnapNode } from "../src/index.js";
import { describeDiff } from "../src/checks/richtext.js";

const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const servers: Server[] = [];
const dirs: string[] = [];

function serve(handler: (path: string) => { status: number; html: string }): Promise<string> {
  const server = createServer((req, res) => {
    const r = handler(new URL(req.url ?? "/", "http://x").pathname);
    res.writeHead(r.status, { "content-type": "text/html; charset=utf-8" });
    res.end(r.html);
  });
  servers.push(server);
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

let oldUrl = "";
let deadUrl = "";
beforeAll(async () => {
  oldUrl = await serve((p) => (p === "/" || p === "/recipes" ? { status: 200, html: page(p === "/" ? "Home" : "Recipes", `<p>Listing ${p}</p><a href="/">home</a>`) } : { status: 404, html: "nope" }));
  deadUrl = await serve(() => ({ status: 404, html: page("Not found", "") }));
});
afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function emptyWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "cmp-verify-notrun-"));
  dirs.push(dir);
  const ws = new Workspace("t", join(dir, "ws"));
  await ws.init();
  await ws.writeJson(Workspace.SCHEMA_PATH, { contentTypes: [] });
  await ws.writeJson(Workspace.LOCALES_PATH, [{ code: "en", name: "English", default: true, pathPrefix: "" }]);
  return ws;
}

describe("gates that compared nothing", () => {
  it("empty CCM + every new page 404 → content/fidelity/seo/links are not-run (fail), POC listing URLs count as missing", async () => {
    const ws = await emptyWorkspace();
    const site = SiteConfig.parse({ site: "t", baseUrl: oldUrl, urls: ["/", "/recipes"], locales: [{ code: "en", default: true }], crawl: { viewports: [{ name: "desktop", width: 800, height: 600 }] } });
    const report = await verifyStep({ site, ws, dryRun: false, log, options: { newBaseUrl: deadUrl, checks: "content,fidelity,seo,links" } });
    const g = report.gates!;
    expect(report.ok).toBe(false);
    expect(g["content.missing"]).toEqual({ pass: false, value: "not-run", threshold: 0 });
    expect(g["content.missingTexts"]).toEqual({ pass: false, value: "not-run", threshold: 0 });
    expect(g["fidelity.similarity"]).toMatchObject({ pass: false, value: "not-run" });
    expect(g["seo.diffs"]).toMatchObject({ pass: false, value: "not-run" });
    expect(g["links.structureDiffs"]).toMatchObject({ pass: false, value: "not-run" });
    expect(g["links.broken"].pass).toBe(false);
    expect(report.issues.filter((i) => i.code === "CHECK_NOT_RUN").map((i) => i.ref).sort()).toEqual(["content", "fidelity", "links", "seo"]);
    // the listing URLs have no CCM entry but are POC URLs: reported as PAGE_MISSING
    expect(report.issues.filter((i) => i.code === "PAGE_MISSING").map((i) => i.ref).sort()).toEqual(["/", "/recipes"]);
    const summary = await ws.readJson<{ ok: boolean }>("verify/summary.json");
    expect(summary.ok).toBe(false);
  }, 60_000);
});

describe("diagnosis + messages", () => {
  const node = (tag: string, h: number): SnapNode => ({ i: 0, p: -1, d: 0, tag, cls: [], b: [0, 0, 800, h], ch: [], tt: 10 }) as unknown as SnapNode;
  const noAssets = {
    stylesheets: { old: [], new: [], onlyOld: [], onlyNew: [], orderDiffers: false, noscriptOld: [], noscriptLoadedOnNew: [] },
    scripts: { old: 0, new: 0, onlyOld: [], onlyNew: [], orderDiffers: false },
    failedRequests: { old: [], new: [{ url: "/en", status: 404, type: "document" }], onlyNew: [{ url: "/en", status: 404, type: "document" }] },
    consoleErrors: { old: [], new: [], onlyNew: [] },
  };
  it("a 404 new document is PAGE_MISSING (no design lane), not ASSET/request-failed", () => {
    const o = [node("main", 900)];
    const n = [node("main", 300)];
    const c = classify({ divergence: { kind: "missing", old: o[0], path: [], componentPath: [] } as never, oldNodes: o, newNodes: n, styleDiff: [], rules: [], assets: noAssets, attributes: [], status: { old: 200, new: 404 } });
    expect(c).toMatchObject({ cause: "PAGE_MISSING", subtype: "new-404", lane: "human" });
    // without the status the old behaviour is unchanged (classification by markup / assets)
    expect(classify({ divergence: undefined, oldNodes: o, newNodes: n, styleDiff: [], rules: [], assets: noAssets, attributes: [] }).cause).not.toBe("PAGE_MISSING");
  });
  it("TEXT_DIFF windows say extra/missing instead of an empty old text", () => {
    expect(describeDiff({ old: "", new: "Deep mediterranean quiche", at: 271 })).toBe('extra on new page at word 271: "Deep mediterranean quiche"');
    expect(describeDiff({ old: "Tags", new: "", at: 3 })).toBe('missing on new page at word 3: "Tags"');
    expect(describeDiff({ old: "small", new: "big", at: 2 })).toBe('"small" → "big" at word 2');
  });
});
