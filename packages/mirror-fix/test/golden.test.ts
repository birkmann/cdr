/**
 * Golden harness for the W1-C handlers (docs/DEEPSEEK_ONLY_PLAN.md §5.2): __fixtures__/<handler>/<case>.input.json →
 * expected decision. Offline: the fixtures are consistent with the handler validators. Live (opt-in, costs < $0.01):
 * `CMP_LIVE_LLM=1 pnpm vitest run packages/autofix/src/__tests__/golden.test.ts` sends each input with the handler's
 * prompt to DeepSeek (LLM_PROVIDERS=deepseek) and checks the answer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLlmClient, createTempWorkspace, llmSpentUsd, loadEnv, testSiteConfig, type LlmClient } from "@harness/mirror-core";
import { checkVariantDecision } from "../src/handlers/design-variant.js";
import { checkDecisions } from "../src/handlers/mapping-review.js";
import { SeoChoice } from "../src/handlers/seo-rule.js";
import { loadPrompt } from "../src/handlers/common.js";
import type { MappingDoc } from "../src/validators/mapping.js";

const FX = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(FX + p, "utf8"));

const mr = { doc: YAML.parse(readFileSync(FX + "mapping-review/gap-and-type.mapping.yaml", "utf8")) as MappingDoc, input: json("mapping-review/gap-and-type.input.json"), expected: json("mapping-review/gap-and-type.expected.json") };
const dv = { input: json("design-variant/card-grid-wrapper.input.json"), expected: json("design-variant/card-grid-wrapper.expected.json") };
const sr = { input: json("seo-rule/per-type.input.json"), expected: json("seo-rule/per-type.expected.json") };
const gaps = () => new Set<string>(mr.input.findings.filter((f: { rule: string }) => f.rule === "MAP_COVERAGE_GAP").map((f: { path: string }) => f.path));

function expectMapping(d: { decisions: { path: string; decision: string; value?: unknown }[] }) {
  for (const e of mr.expected.decisions as { path: string; decision: string; value?: unknown }[]) {
    const hit = d.decisions.find((x) => x.path === e.path && x.decision === e.decision);
    expect(hit, `${e.decision} ${e.path}`).toBeTruthy();
    if (e.value !== undefined) expect(hit!.value).toEqual(e.value);
  }
}

describe("golden fixtures are consistent with the validators (offline)", () => {
  it("mapping-review", () => {
    const d = checkDecisions({ decisions: mr.expected.decisions.map((x: object) => ({ ...x, reason: "golden" })) }, mr.doc, gaps());
    expectMapping(d);
    expect(() => checkDecisions({ decisions: [{ path: "contentTypes.nope.fields.body.type", decision: "set", value: "richText", reason: "x" }] }, mr.doc, gaps())).toThrow(/path must be/);
  });
  it("design-variant", () => {
    const d = checkVariantDecision({ decision: dv.expected.decision, name: "Featured Card Grid", reason: "golden", props: [{ prop: "heading", ccmField: "title" }] }, dv.input.unboundProps, dv.input.ccmFields);
    expect(d.decision).toBe("variant");
    expect(() => checkVariantDecision({ decision: "variant", name: "X Y", reason: "r", props: [{ prop: "heading", ccmField: "nope" }] }, dv.input.unboundProps, dv.input.ccmFields)).toThrow(/not a field/);
  });
  it("seo-rule", () => {
    expect(SeoChoice.parse({ rules: [{ tag: "og:type", kind: "perType", reason: "golden" }] }).rules[0].kind).toBe("perType");
  });
  it("no fixture input carries page text (only skeletons / classes)", () => {
    const strings = (x: unknown): string[] => (typeof x === "string" ? [x] : x && typeof x === "object" ? Object.values(x).flatMap(strings) : []);
    for (const s of strings([dv.input, sr.input, mr.input])) expect(s).not.toMatch(/>\s*[^<{…\s][^<]*</);
  });
});

const live = process.env.CMP_LIVE_LLM === "1";

describe.skipIf(!live)("golden — live DeepSeek (CMP_LIVE_LLM=1)", () => {
  let llm: LlmClient;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    loadEnv();
    process.env.LLM_PROVIDERS = "deepseek";
    const t = await createTempWorkspace("golden-live");
    cleanup = t.cleanup;
    const c = createLlmClient(t.ws, testSiteConfig({ site: "golden-live", llm: { sendContent: false, stepModels: {}, budgetUsd: 0.05 } }));
    if (!c) throw new Error("no DEEPSEEK_API_KEY in .env");
    llm = c;
  });
  afterAll(async () => {
    console.log(`golden live spend: $${llmSpentUsd().toFixed(5)}`);
    await cleanup?.();
  });

  const ask = async <T>(handler: string, user: unknown, validate: (x: unknown) => T, schemaId: string, extra = ""): Promise<T> => {
    const res = await llm.complete({ step: `autofix-${handler}`, json: true, temperature: 0, maxTokens: 4000, effort: "low", schemaId, validate, messages: [{ role: "system", content: loadPrompt(handler).text + extra }, { role: "user", content: JSON.stringify(user, null, 1) }] });
    return (res.parsed ?? validate(JSON.parse(res.content))) as T;
  };

  it("mapping-review: skips the unused gap, makes body richText", async () => {
    expectMapping(await ask("mapping-review", mr.input, (x) => checkDecisions(x, mr.doc, gaps()), "mapping-review@1"));
  }, 180_000);

  it("design-variant: extra wrapper = variant, heading → title", async () => {
    const d = await ask("design-variant", dv.input, (x) => checkVariantDecision(x, dv.input.unboundProps, dv.input.ccmFields), "design-variant@1");
    expect(d.decision).toBe(dv.expected.decision);
    for (const [prop, f] of Object.entries(dv.expected.props as Record<string, string>)) expect(d.props.find((p) => p.prop === prop)?.ccmField).toBe(f);
  }, 180_000);

  it("seo-rule: one value per content type → perType", async () => {
    const d = await ask("seo-rule", sr.input, (x) => SeoChoice.parse(x), "seo-rule@1");
    for (const [tag, kinds] of Object.entries(sr.expected.kinds as Record<string, string[]>)) expect(kinds).toContain(d.rules.find((r) => r.tag === tag)?.kind);
  }, 180_000);
});
