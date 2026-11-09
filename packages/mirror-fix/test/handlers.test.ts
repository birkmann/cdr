import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComponentOverride } from "@harness/mirror-design";
import { createTempWorkspace, silentLogger, testSiteConfig, type LlmClient, type LlmRequest, type Workspace } from "@harness/mirror-core";
import { designVariantHandler } from "../src/handlers/design-variant.js";
import { mappingReviewHandler } from "../src/handlers/mapping-review.js";
import { evidence, ruleFor, seoRuleHandler } from "../src/handlers/seo-rule.js";
import { sanitizeMessage, contentFree } from "../src/handlers/common.js";
import { ownerOf, selectHandlers } from "../src/registry.js";
import type { AutofixContext, AutofixTask } from "../src/types.js";
import { nearest, validateMapping, type MappingDoc } from "../src/validators/mapping.js";

let ws: Workspace;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ ws, cleanup } = await createTempWorkspace("h-site")));
afterEach(async () => cleanup());

function ctx(extra: Partial<AutofixContext> = {}): AutofixContext {
  return { site: testSiteConfig({ site: ws.site }), ws, repoRoot: ws.root, log: silentLogger, oldBaseUrl: "http://localhost:4400", dryRun: false, ...extra };
}
const task = (code: string, message: string, ref?: string): AutofixTask => ({ id: `${code}:${ref ?? ""}`, code, message, ref, severity: "error", source: "transform" });

/** fake LLM: records prompts, answers with `answer(req)` validated by the request's validator */
function fakeLlm(answer: (req: LlmRequest) => unknown): LlmClient & { reqs: LlmRequest[] } {
  const reqs: LlmRequest[] = [];
  return {
    reqs,
    async complete(req) {
      reqs.push(req);
      const a = answer(req);
      const parsed = req.validate ? req.validate(a) : a;
      return { content: JSON.stringify(a), parsed, model: "deepseek-flash", provider: "deepseek", promptTokens: 100, completionTokens: 50, durationMs: 1 };
    },
  };
}

describe("mapping validators", () => {
  const doc: MappingDoc = {
    contentTypes: {
      landingPage: { kind: "document", source: { drupal: "node.landing_page" }, fields: { sections: { source: "field_sections", type: "componentList", cardinality: 1, allowedTypes: ["sectionHeroo", "sectionText"] }, Bad_Field: { source: "field_x", type: "string" } } },
      sectionHero: { kind: "component", source: { drupal: "paragraph.hero" }, fields: {} },
      sectionText: { kind: "component", source: { drupal: "paragraph.text" }, fields: { body: { source: "field_body", type: "richText", cardinality: 1 } } },
      page: { kind: "document", source: { drupal: "node.page" }, fields: { tags: { source: "field_tags", type: "reference", cardinality: 1, allowedTypes: ["term:tagz"] } } },
    },
    ignored: [{ source: "node.page.field_metatag", reason: "meta" }],
  };
  const inv = {
    contentTypes: [
      { bundle: "landing_page", fields: [{ name: "field_sections", cardinality: -1 }] },
      { bundle: "page", fields: [{ name: "field_tags", cardinality: -1 }, { name: "field_metatag" }, { name: "field_new" }] },
      { bundle: "event", fields: [] },
    ],
    paragraphTypes: [{ type: "hero" }, { type: "text" }],
    vocabularies: [{ vid: "tags" }],
  };
  it("flags each rule, with unique deterministic fixes where possible", () => {
    const f = validateMapping(doc, inv);
    const by = (rule: string) => f.filter((x) => x.rule === rule).map((x) => [x.path, x.fix && "value" in x.fix ? x.fix.value : undefined]);
    expect(by("MAP_ALLOWED_TYPE_UNKNOWN")).toEqual([
      ["contentTypes.landingPage.fields.sections.allowedTypes.0", "sectionHero"],
      ["contentTypes.page.fields.tags.allowedTypes.0", "term:tags"],
    ]);
    expect(by("MAP_NOT_CAMEL_CASE")).toEqual([["contentTypes.landingPage.fields.Bad_Field", undefined]]);
    expect(by("MAP_FIELD_TYPE_UNKNOWN")).toEqual([["contentTypes.landingPage.fields.Bad_Field.type", undefined]]);
    expect(by("MAP_CARDINALITY")).toEqual(expect.arrayContaining([["contentTypes.landingPage.fields.sections.cardinality", -1], ["contentTypes.page.fields.tags.cardinality", -1]]));
    expect(by("MAP_COVERAGE_GAP").map((x) => x[0])).toEqual(["node.event", "node.page.field_new"]);
  });
  it("nearest() needs a unique close match", () => {
    expect(nearest("sectionHeroo", ["sectionHero", "sectionText"])).toBe("sectionHero");
    expect(nearest("sectionX", ["sectionA", "sectionB"])).toBeUndefined();
  });
});

describe("mapping-review handler", () => {
  const yaml = `# comment kept\nversion: 1\ncontentTypes:\n  article:\n    kind: document\n    source: { drupal: node.article }\n    fields:\n      tags: { source: field_tags, type: reference, cardinality: 1, allowedTypes: [ term:tags ] }\n      body: { source: body, type: text, cardinality: 1 }\nignored: []\n`;
  beforeEach(async () => {
    await ws.writeText("mapping/drupal.yaml", yaml);
    await ws.writeJson("analysis/inventory.json", { contentTypes: [{ bundle: "article", fields: [{ name: "field_tags" }, { name: "body" }, { name: "field_old", type: "string", usagePct: 0 }] }], vocabularies: [{ vid: "tags" }] });
    await ws.writeJson("reports/transform.json", { step: "transform", site: ws.site, startedAt: "", finishedAt: "", ok: false, dryRun: false, stats: {}, outputs: [], issues: [], gates: { "ccm.valid": { pass: false, value: 2, threshold: 0 } } });
  });
  const tasks = [
    task("CCM_FIELD_CARDINALITY", 'field "tags" has cardinality 1 but value is an array', "ccm/entries/article/drupal_node_1.en.json"),
    task("CCM_FIELD_TYPE", 'field "body": expected string, got object', "ccm/entries/article/drupal_node_1.en.json"),
  ];

  it("rule candidate from CCM errors; LLM candidate for what rules cannot settle; review.yaml; no content in the prompt", async () => {
    const llm = fakeLlm(() => ({ decisions: [{ path: "node.article.field_old", decision: "skip", reason: "unused (0 %)" }, { path: "contentTypes.article.fields.body.type", decision: "set", value: "richText", reason: "text_with_summary" }] }));
    const c = await mappingReviewHandler.propose(ctx({ llm }), tasks, []);
    expect(c.map((x) => [x.origin, x.rerun])).toEqual([
      ["rule", ["transform"]],
      ["llm", ["transform"]],
    ]);
    const rule = YAML.parse(c[0].files[0].content!);
    expect(rule.contentTypes.article.fields.tags.cardinality).toBe(-1);
    expect(c[0].files[0].content).toMatch(/^# comment kept/);
    const llmDoc = YAML.parse(c[1].files[0].content!);
    expect(llmDoc.contentTypes.article.fields.body.type).toBe("richText");
    expect(llmDoc.contentTypes.article.fields.tags.cardinality).toBe(-1); // rules included
    expect(llmDoc.ignored).toEqual([{ source: "node.article.field_old", reason: "unused (0 %) (autofix mapping-review, llm)" }]);
    const review = YAML.parse(c[1].files[1].content!);
    expect(review.review.map((r: { path: string; origin: string }) => `${r.origin}:${r.path}`)).toEqual(["llm:contentTypes.article.fields.body.type", "rule:contentTypes.article.fields.tags.cardinality", "llm:node.article.field_old"]);
    expect(llm.reqs[0]).toMatchObject({ step: "autofix-mapping-review", json: true, schemaId: "mapping-review@1", temperature: 0 });
    expect(JSON.stringify(llm.reqs[0].messages)).not.toMatch(/got object"/); // sanitized values
  });

  it("measure = -(validator findings + ccm errors)", async () => {
    const m = await mappingReviewHandler.measure(ctx(), tasks);
    expect(m.primary).toBe(-3); // 1 coverage gap + 2 ccm errors
  });

  it("invalid LLM decisions are rejected by the validator (no LLM candidate)", async () => {
    const llm = fakeLlm(() => ({ decisions: [{ path: "contentTypes.article.fields.body.type", decision: "set", value: "html", reason: "x" }] }));
    const c = await mappingReviewHandler.propose(ctx({ llm }), tasks, []);
    expect(c.map((x) => x.origin)).toEqual(["rule"]); // the validator threw (invalid value "html") → only the rule candidate
  });
});

describe("design-variant handler", () => {
  beforeEach(async () => {
    await ws.writeJson("design/components/sectionCardGrid.json", { id: "sectionCardGrid", kind: "section", ccmType: "sectionCardGrid", template: '<div class="cg"><h2>{{heading}}</h2></div>', props: [{ name: "heading", type: "text" }] });
    await ws.writeJson("design/components/sectionCardGridV2.json", { id: "sectionCardGridV2", kind: "section", ccmType: "sectionCardGrid", variantOf: "sectionCardGrid", template: '<div class="cg cg--x"><div class="i"><h2>{{heading}}</h2><p>Some page text</p></div></div>', props: [{ name: "heading", type: "text" }, { name: "title", type: "text" }] });
    await ws.writeJson("ccm/schema/content-types.json", { contentTypes: [{ id: "sectionCardGrid", fields: [{ id: "title", type: "text" }, { id: "items", type: "componentList" }] }] });
  });

  it("rule binds props named like CCM fields; LLM decides variant + naming from skeletons; overrides pass the W1-B schema", async () => {
    const llm = fakeLlm(() => ({ decision: "variant", name: "Featured Card Grid", reason: "extra wrapper only", props: [{ prop: "heading", ccmField: "title" }] }));
    const c = await designVariantHandler.propose(ctx({ llm }), [task("COMPONENT_VARIANT", "sectionCardGrid: 1 instance(s) on /about differ structurally from / — variant sectionCardGridV2", "sectionCardGridV2")], []);
    expect(c.map((x) => x.origin)).toEqual(["rule", "llm"]);
    const rule = ComponentOverride.parse(JSON.parse(c[0].files[0].content!));
    expect(rule.propsPatch?.set).toEqual({ title: { ccmField: "title" } });
    const o = ComponentOverride.parse(JSON.parse(c[1].files[0].content!));
    expect(o).toMatchObject({ name: "Featured Card Grid", variantOf: "sectionCardGrid", propsPatch: { set: { title: { ccmField: "title" }, heading: { ccmField: "title" } } } });
    expect(o.note).toMatch(/^design-variant: variant of sectionCardGrid/);
    expect(c[1].files[0].path).toBe("design/overrides/components/sectionCardGridV2.json");
    expect(c[1].stepOptions).toEqual({ "design-extract": { applyOverridesOnly: true } });
    const prompt = JSON.stringify(llm.reqs[0].messages);
    expect(prompt).not.toMatch(/Some page text/);
    expect(prompt).toContain("<p>…</p>");
  });

  it("measure counts undecided variants/props; an override note marks them decided", async () => {
    const t = [task("COMPONENT_VARIANT", "x", "sectionCardGridV2")];
    expect((await designVariantHandler.measure(ctx(), t)).primary).toBe(-3); // variant + 2 unbound props
    await ws.writeJson("design/overrides/components/sectionCardGridV2.json", { note: "design-variant: kept separate" });
    expect((await designVariantHandler.measure(ctx(), t)).primary).toBe(0);
  });

  it("TEMPLATE_UNKNOWN_COMPONENT → alias of the nearest mined component", async () => {
    const c = await designVariantHandler.propose(ctx(), [task("TEMPLATE_UNKNOWN_COMPONENT", "template landingPage: slot component sectionCardGrd not in design/components", "landingPage")], []);
    expect(c).toHaveLength(1);
    expect(ComponentOverride.parse(JSON.parse(c[0].files[0].content!))).toMatchObject({ id: "sectionCardGrd", create: true, variantOf: "sectionCardGrid", kind: "section" });
    expect(c[0].rerun).toEqual(["design-extract", "frontend-generate"]);
  });
});

describe("seo-rule handler", () => {
  beforeEach(async () => {
    const pg = (path: string, img: string | undefined, type: string, extra: Record<string, string> = {}) => ({ path, skipped: false, old: { title: `T ${path}`, og: { ...(img ? { "og:image": img } : {}), ...extra } }, new: { og: {} } });
    await ws.writeJson("verify/seo.json", {
      check: "seo",
      ok: false,
      gates: { diffs: { pass: false, value: 4 } },
      issues: [],
      details: { pages: [pg("/", "/a.jpg", "landingPage", { "og:type": "website" }), pg("/n/1", "/b.jpg", "article", { "og:type": "article" }), pg("/n/2", undefined, "article", { "og:type": "article" })] },
    });
    for (const [p, t, l] of [["/", "landingPage", "en"], ["/n/1", "article", "en"], ["/n/2", "article", "en"]]) await ws.writeJson(`ccm/entries/${t}/${p.replace(/\W/g, "_")}.${l}.json`, { path: p, type: t, locale: l });
  });

  it("deterministic rule where one kind explains every page; LLM gets value classes, never values", async () => {
    const { ev, values } = await evidence(ws, ["og:type"]);
    expect(ev[0].pages.map((p) => p.cls)).toEqual(["A", "B", "B"]);
    expect(ruleFor(ev[0], values.get("og:type")!)).toBeUndefined(); // neither const nor perLocale → model
    const llm = fakeLlm(() => ({ rules: [{ tag: "og:type", kind: "perType", reason: "one value per type" }] }));
    const tasks = [task("SEO_DIFF", '/n/1 og:type: "article" → undefined', "/n/1")];
    const c = await seoRuleHandler.propose(ctx({ llm, newBaseUrl: "http://localhost:4410" }), tasks, []);
    expect(c).toHaveLength(1);
    expect(YAML.parse(c[0].files[0].content!).rules["og:type"]).toEqual({ perType: { landingPage: "website", article: "article" } });
    expect(c[0]).toMatchObject({ rerun: ["frontend-generate", "build"], verify: { checks: ["seo"], urls: ["/n/1"] } });
    const prompt = JSON.stringify(llm.reqs[0].messages);
    expect(prompt).not.toMatch(/website|"article"/);
  });

  it("no candidates without an app under test", async () => {
    expect(await seoRuleHandler.propose(ctx(), [task("SEO_DIFF", '/ og:type: "x" → undefined', "/")], [])).toEqual([]);
  });
});

describe("registry + privacy helpers", () => {
  it("owner per code", () => {
    expect(ownerOf("SEO_DIFF")).toBe("seo-rule");
    expect(ownerOf("CCM_REF_NOT_ALLOWED")).toBe("mapping-review");
    expect(ownerOf("VISUAL_DIFF")).toBe("parity-fix");
    expect(ownerOf("CHECK_CRASHED")).toBe("pipeline-bug");
    expect(ownerOf("STYLE_ASSET_MISSING")).toBe("deterministic");
    expect(ownerOf("SOMETHING_ELSE")).toBe("human");
    expect(() => selectHandlers(["nope"])).toThrow(/unknown autofix handler/);
    expect(selectHandlers(["seo-rule"]).map((h) => h.id)).toEqual(["seo-rule"]);
  });
  it("messages lose values unless sendContent", () => {
    expect(sanitizeMessage('field "d": expected ISO date string, got "Hello world"', false)).toBe('field "d": expected ISO date string, got <value>');
    expect(contentFree('x: 1/2 instance(s) do not re-render exactly — e.g. 12: <p>Secret</p>', false)).toBe("x: 1/2 instance(s) do not re-render exactly");
  });
});
