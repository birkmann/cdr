import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SiteConfig, Workspace, type LlmClient, type LlmRequest } from "@harness/mirror-core";
import { applyOverrides, readOverrides } from "@harness/mirror-design";
import type { ParityDossier } from "@harness/mirror-verify";
import type { AutofixContext, AutofixTask } from "../../src/types.js";
import { checkPatch, familyPatches, variantFamily, mergeAssetsOverride, parityFixHandler, ParityFixResponse, promptDossier, ruleProposals, shotOf, templateRoot, urlMetric } from "../../src/handlers/parity-fix.js";

const SECRET = "Pomegranatesymphony";
const GIF = "data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

function dossier(over: Partial<ParityDossier> & { classification: ParityDossier["classification"] }): ParityDossier {
  return {
    version: 1,
    path: "/about",
    viewport: "desktop",
    old: { base: "http://localhost:4401", status: 200 },
    new: { base: "http://localhost:4413", status: 200 },
    parity: { value: 0.78, diffPixels: 1000, height: { old: 6223, new: 6156, delta: -67 }, regions: [] },
    styleDiff: [],
    matchedRules: [],
    attributes: [],
    markup: { old: "", new: "" },
    assets: {
      stylesheets: { old: [], new: [], onlyOld: [], onlyNew: [], orderDiffers: false, noscriptOld: [], noscriptLoadedOnNew: [] },
      scripts: { old: 0, new: 0, onlyOld: [], onlyNew: [], orderDiffers: false },
      failedRequests: { old: [], new: [], onlyNew: [] },
      consoleErrors: { old: [], new: [], onlyNew: [] },
    },
    stabilise: { fonts: {}, nodes: { old: 1, new: 1, truncated: false } },
    ...over,
  };
}
const cls = (cause: ParityDossier["classification"]["cause"], subtype: string, lane: ParityDossier["classification"]["lane"] = "design"): ParityDossier["classification"] => ({ cause, subtype, confidence: "high", evidence: ["e"], lane, alternatives: [] });

const design = {
  manifest: { pages: { "/about": { contentType: "page", template: { slots: [{ component: "pageTitleV2", region: "pageHeader" }, { component: "body", region: "content" }] } } } },
  components: new Map<string, Record<string, any>>([
    ["pageTitleV2", { id: "pageTitleV2", kind: "chrome", template: '<header id="block-title" class="page-title">{{title}}</header>', props: [{ name: "title", type: "text" }] }],
    ["blockShare", { id: "blockShare", kind: "chrome", template: `<div class="page-header__social-share component-paragraph-field"><p class="block-title">${SECRET} share words</p></div>`, props: [] }],
    ["card", { id: "card", kind: "section", template: '<div class="card"><div class="card-item__body">\n  {{{body}}}\n</div></div>', props: [{ name: "body", type: "richText" }] }],
    ["siteFooter", { id: "siteFooter", kind: "chrome", template: `<footer><img src="/files/map.webp?itok=1" data-src="/files/map.webp?itok=1" class="b-lazy"></footer>`, props: [] }],
  ]),
};
const slots = { slots: design.manifest.pages["/about"].template.slots, source: "page" as const };

describe("parity-fix rules (deterministic candidates)", () => {
  it("shotOf: url + viewport from task data or the message prefix", () => {
    const t: AutofixTask = { id: "VISUAL_DIFF:/about:desktop", code: "VISUAL_DIFF", ref: "/about", message: "desktop /about: parity 0.78 < 0.97", severity: "error", source: "verify:visual" };
    expect(shotOf(t)).toEqual({ path: "/about", viewport: "desktop" });
    expect(parityFixHandler.groupKey!(t)).toBe("parity:/about@desktop");
  });

  it("missing element → pages.json slotsInsert of the mined component with the same root, in its region", () => {
    const d = dossier({ classification: cls("MARKUP", "missing-element"), firstDivergence: { kind: "missing", element: "div.page-header__social-share.component-paragraph-field", signature: "x", componentPath: [], path: ["main.main-wrapper", "div.region.region-page-header", "div.page-header__social-share.component-paragraph-field"] } });
    const [r] = ruleProposals(d, design, slots, { path: "/about" });
    expect(r.patch).toEqual({ kind: "page", page: { path: "/about", override: { slotsInsert: [{ slot: { component: "blockShare", region: "pageHeader" }, after: "pageTitleV2" }] } } });
    expect(templateRoot(design.components.get("blockShare")!.template)).toEqual({ tag: "div", cls: ["page-header__social-share", "component-paragraph-field"] });
  });

  it("extra wrapper inside a prop container → propsPatch inline:true", () => {
    const d = dossier({ classification: cls("MARKUP", "extra-wrapper"), firstDivergence: { kind: "extra", element: "p", signature: "p", componentPath: [], path: ["div.card", "div.card-item__body", "p"] } });
    expect(ruleProposals(d, design, slots).map((r) => r.patch)).toEqual([{ kind: "component", component: { id: "card", override: { propsPatch: { set: { body: { inline: true } } } } } }]);
  });

  it("lazy src → assets.json keepRawLazySrc for the components holding that image", () => {
    const d = dossier({ classification: cls("ASSET", "lazy-src"), attributes: [{ node: "img.b-lazy", attr: "src", old: "data:image/gif;base64,…", new: "/files/map.webp?itok=1" }] });
    expect(ruleProposals(d, design, slots)[0].patch).toEqual({ kind: "assets", assets: { images: { keepRawLazySrc: ["siteFooter"] } } });
    // merged with an existing assets.json
    expect(mergeAssetsOverride({ images: { keepRawLazySrc: ["a"] }, stylesheets: { remove: ["x.css"] } }, { images: { keepRawLazySrc: ["siteFooter"] }, stylesheets: { remove: ["y.css"] } })).toEqual({ images: { keepRawLazySrc: ["a", "siteFooter"] }, stylesheets: { remove: ["x.css", "y.css"] } });
  });

  it("noscript stylesheet → remove it; CONTENT → no design candidate; DYNAMIC only with proof", () => {
    const d = dossier({ classification: cls("CSS_ORDER", "noscript-stylesheet-loaded") });
    d.assets.stylesheets.noscriptLoadedOnNew = ["/_design/styles/seckit.noscript_tag.css"];
    expect(ruleProposals(d, design, slots)[0].patch).toEqual({ kind: "assets", assets: { stylesheets: { remove: ["seckit.noscript_tag.css"] } } });
    expect(ruleProposals(dossier({ classification: cls("CONTENT", "richtext-inline-dropped:abbr", "content") }), design, slots)).toEqual([]);
    const dyn = dossier({ classification: cls("DYNAMIC", "unstable-on-original", "mask"), instability: { tested: true, parity: 0.99, regions: [], unstableElements: [".ticker"], divergenceUnstable: true, maskCandidates: [{ selector: ".ticker", proof: "original vs original" }] } });
    expect(ruleProposals(dyn, design, slots, { path: "/", sitePath: "sites/x.yaml" })[0].patch).toEqual({ kind: "mask", mask: { selector: ".ticker" } });
    expect(checkPatch({ kind: "mask", mask: { selector: ".other" } }, design, dyn)).toMatch(/without instability proof/);
  });

  it("inline <style> only on new → remove the asset-set entry whose CSS declares those selectors", () => {
    const d = dossier({ classification: cls("CSS_ORDER", "stylesheet-set-differs") });
    d.assets.stylesheets.onlyNew = ["inline:bb"];
    d.assets.stylesheets.inlineOnlyNew = [{ key: "inline:bb", rules: 1, selectors: ["body"] }];
    const r = ruleProposals(d, design, slots, { path: "/", inlineSources: (sel, rules) => (sel[0] === "body" && rules === 1 ? ["seckit-noscript-port.css"] : []) });
    expect(r.map((x) => x.patch)).toEqual([{ kind: "assets", assets: { stylesheets: { remove: ["seckit-noscript-port.css"] } } }]);
  });

  it("checkPatch rejects template finds that do not occur, unknown props and remote CSS", () => {
    const d = dossier({ classification: cls("MARKUP", "attribute-differs") });
    expect(checkPatch({ kind: "component", component: { id: "card", override: { templateReplace: [{ find: "<div class=\"nope\">", replace: "" }] } } }, design, d)).toMatch(/not in card/);
    expect(checkPatch({ kind: "component", component: { id: "card", override: { templateReplace: [{ find: "<a>…</a>", replace: "" }] } } }, design, d)).toMatch(/ellipsis/);
    expect(checkPatch({ kind: "component", component: { id: "card", override: { propsPatch: { set: { nope: { inline: true } } } } } }, design, d)).toMatch(/no prop/);
    expect(checkPatch({ kind: "siteCss", siteCss: "@import url(https://x/y.css);" }, design, d)).toMatch(/remote/);
    expect(checkPatch({ kind: "component", component: { id: "card", override: { templateReplace: [{ find: 'class="card-item__body"', replace: 'class="card-item__body x"' }] } } }, design, d)).toBeUndefined();
  });

  it("variant family: a component patch also applies to the siblings whose template has the same find (N5-05, W2-H)", () => {
    const d2 = {
      manifest: design.manifest,
      components: new Map<string, Record<string, any>>([
        ["siteFooter", { id: "siteFooter", kind: "chrome", pages: ["/"], template: '<footer><img src="/x.webp" class="b-lazy"></footer>', props: [] }],
        ["siteFooterV2", { id: "siteFooterV2", kind: "chrome", variantOf: "siteFooter", pages: ["/about"], template: '<footer class="v2"><img src="/x.webp" class="b-lazy"></footer>', props: [] }],
        ["siteFooterV3", { id: "siteFooterV3", kind: "chrome", variantOf: "siteFooter", pages: ["/news"], template: "<footer><p>no image</p></footer>", props: [] }],
        ["card", { id: "card", kind: "section", template: "<div></div>", props: [] }],
      ]),
    };
    expect(variantFamily(d2, "siteFooterV2")).toEqual({ base: "siteFooter", members: [{ id: "siteFooter", pages: ["/"] }, { id: "siteFooterV2", pages: ["/about"] }, { id: "siteFooterV3", pages: ["/news"] }] });
    const spec = { kind: "component" as const, component: { id: "siteFooter", override: { templateReplace: [{ find: 'class="b-lazy"', replace: 'class="b-lazy b-loaded"' }] } } };
    const d = dossier({ classification: cls("ASSET", "lazy-src") });
    // V3 has no such image: not patched; V2 gets the same override
    expect(familyPatches(spec, d2, d).map((x) => x.component!.id)).toEqual(["siteFooter", "siteFooterV2"]);
    expect(familyPatches({ kind: "siteCss", siteCss: "a{}" }, d2, d)).toHaveLength(1);
  });

  it("metric: Σ viewport scores of the URL, −1 for another viewport that fails", () => {
    const rows = [
      { viewport: "mobile", path: "/about", parity: 1, pass: true },
      { viewport: "desktop", path: "/about", parity: 0.78, pass: false, height: { delta: -67 }, bbox: { maxDelta: 67 } },
      { viewport: "mobile", path: "/", parity: 0.5, pass: false },
    ];
    const before = urlMetric(rows, { path: "/about", viewport: "desktop" }).primary;
    const fixed = urlMetric([{ ...rows[0] }, { viewport: "desktop", path: "/about", parity: 1, pass: true }], { path: "/about", viewport: "desktop" }).primary;
    const broke = urlMetric([{ ...rows[0], parity: 0.9, pass: false }, { viewport: "desktop", path: "/about", parity: 1, pass: true }], { path: "/about", viewport: "desktop" }).primary;
    expect(fixed).toBeGreaterThan(before);
    expect(broke).toBeLessThan(before);
  });

  it("LLM response schema: typed patches only, ≤ 3, kind must carry its field", () => {
    expect(ParityFixResponse.safeParse({ diagnosis: "x", patches: [{ title: "abc", kind: "assets", assets: { stylesheets: { remove: ["a.css"] } } }] }).success).toBe(true);
    expect(ParityFixResponse.safeParse({ diagnosis: "x", patches: [{ title: "abc", kind: "page" }] }).success).toBe(false);
    expect(ParityFixResponse.safeParse({ diagnosis: "x", patches: [{ title: "abc", kind: "assets", assets: { evil: 1 } }] }).success).toBe(false);
    const four = Array.from({ length: 4 }, () => ({ title: "abc", kind: "siteCss", siteCss: "a{}" }));
    expect(ParityFixResponse.safeParse({ diagnosis: "x", patches: four }).success).toBe(false);
  });
});

describe("parity-fix propose() end to end (fake LLM, temp workspace)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "cmp-pf-"));
    dirs.push(dir);
    const ws = new Workspace("t", dir);
    const manifest = { components: [...design.components.keys()].map((id) => ({ id, file: `components/${id}.json`, kind: design.components.get(id)!.kind })), templates: [], pages: design.manifest.pages };
    await ws.writeJson("design/manifest.json", manifest);
    for (const [id, c] of design.components) await ws.writeJson(`design/components/${id}.json`, c);
    await ws.writeJson("design/base/manifest.json", manifest);
    for (const [id, c] of design.components) await ws.writeJson(`design/base/components/${id}.json`, c);
    await ws.writeJson("verify/visual.json", { details: { results: [{ viewport: "desktop", path: "/about", parity: 0.78, pass: false }] } });
    const d = dossier({
      classification: cls("MARKUP", "missing-element"),
      firstDivergence: { kind: "missing", element: "div.page-header__social-share.component-paragraph-field", signature: "x", componentPath: [], path: ["div.region.region-page-header", "div.page-header__social-share.component-paragraph-field"] },
      markup: { old: '<div class="page-header__social-share">…', new: "" },
    });
    await new Promise((r) => setTimeout(r, 20));
    await ws.writeJson("verify/diagnosis/desktop/about.json", d);
    const site = SiteConfig.parse({ site: "t", baseUrl: "http://localhost:4401", urls: ["/about"], crawl: { viewports: [{ name: "desktop", width: 1440, height: 900 }] } });
    return { ws, site };
  }

  it("round 1: rule candidates only (no LLM call); round 2 after the rules failed: DeepSeek patches, validated + filtered", async () => {
    const { ws, site } = await setup();
    const calls: LlmRequest[] = [];
    const llm: LlmClient = {
      async complete(req) {
        calls.push(req);
        const parsed = req.validate!({
          diagnosis: "share block missing in the page header",
          cause: "MARKUP",
          patches: [
            { title: "insert share after title", kind: "page", page: { path: "/about", override: { slotsInsert: [{ slot: { component: "blockShare", region: "pageHeader" }, before: "body" }] } } },
            { title: "bad find", kind: "component", component: { id: "card", override: { templateReplace: [{ find: "<nope>", replace: "" }] } } },
            { title: "mask it", kind: "mask", mask: { selector: ".page-header" } },
          ],
        });
        return { content: "{}", model: req.model ?? "x", parsed, promptTokens: 0, completionTokens: 0, durationMs: 0 };
      },
    };
    const ctx: AutofixContext = { site, ws, repoRoot: dir0(ws), llm, log: { info() {}, warn() {}, error() {}, debug() {} }, oldBaseUrl: "http://localhost:4401", newBaseUrl: "http://localhost:4413", dryRun: false };
    const task: AutofixTask = { id: "VISUAL_DIFF:/about:desktop", code: "VISUAL_DIFF", ref: "/about", message: "desktop /about: parity 0.78 < 0.97", severity: "error", source: "verify:visual", data: { viewport: "desktop", url: "/about" } };
    const r1 = await parityFixHandler.propose(ctx, [task], []);
    expect(calls).toHaveLength(0);
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ origin: "rule", rerun: ["design-extract", "frontend-generate", "build", "verify"], stepOptions: { "design-extract": { applyOverridesOnly: true } }, verify: { checks: ["visual"], urls: ["/about"], viewports: ["desktop"] } });
    expect(r1[0].files[0].path).toBe("design/overrides/pages.json");
    // the written override validates against the design schema and merges
    await ws.writeText(r1[0].files[0].path, r1[0].files[0].content!);
    const { overrides, issues } = await readOverrides(ws.path("design"));
    expect(issues).toEqual([]);
    const merged = applyOverrides({ manifest: { pages: design.manifest.pages }, components: [...design.components.values()], templates: [] }, overrides);
    expect((merged.manifest.pages as any)["/about"].template.slots.map((s: { component: string }) => s.component)).toEqual(["pageTitleV2", "blockShare", "body"]);

    const prev = [{ seq: 1, handler: "parity-fix", taskIds: [task.id], candidate: { title: r1[0].title, origin: "rule" as const, rerun: r1[0].rerun, files: [] }, before: { primary: 0, gates: {} }, accepted: false, reason: "not improved", startedAt: "", finishedAt: "" }];
    const r2 = await parityFixHandler.propose(ctx, [task], prev);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ step: "autofix-parity-fix", model: "deepseek-v4-pro", effort: "high", schemaId: "parity-fix@1", json: true });
    expect(r2.filter((c) => c.origin === "llm").map((c) => c.title)).toEqual(["insert share after title"]);
    // privacy: the prompt carries no page text (dossier + skeletons only)
    const prompt = calls[0].messages.map((m) => m.content).join("\n");
    expect(prompt).not.toContain(SECRET);
    expect(promptDossier(dossier({ classification: cls("UNKNOWN", "x") }))).not.toHaveProperty("assets");
  });
});

function dir0(ws: Workspace): string {
  return join(ws.root, "..", "..");
}
