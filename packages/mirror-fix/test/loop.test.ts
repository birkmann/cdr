import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempWorkspace, estimateCostUsd, silentLogger, testSiteConfig, type LlmClient, type StepReport, type Workspace } from "@harness/mirror-core";
import { collectTasks, readGates } from "../src/collect.js";
import { runAutofix, type AutofixOptions } from "../src/loop.js";
import type { StepRunner } from "../src/rerun.js";
import { AUTOFIX_CODES, type Candidate, type Handler } from "../src/types.js";

/**
 * Fake world: mapping/value.json holds a number (the "data"); the fake "transform" step turns it into
 * reports/transform.json (gate ccm.valid = value >= 0) and the fake "verify" step writes verify/visual.json
 * (gate parity = value !== 13). The handler's primary metric = value.
 */
let ws: Workspace;
let baseDir: string;
let cleanup: () => Promise<void>;
const site = () => testSiteConfig({ site: ws.site });

async function setValue(v: number) {
  await ws.writeJson("mapping/value.json", { value: v });
}
async function value(): Promise<number> {
  return (await ws.readJson<{ value: number }>("mapping/value.json")).value;
}
function report(step: string, extra: Partial<StepReport> = {}): StepReport {
  const now = new Date().toISOString();
  return { step, site: ws.site, startedAt: now, finishedAt: now, ok: true, dryRun: false, stats: {}, issues: [], outputs: [], ...extra };
}
async function seedTask(code = "FAKE_CODE", ref = "/x", severity: "error" | "info" = "error", actionable = true) {
  await ws.writeJson("reports/transform.json", report("transform", { gates: { "ccm.valid": { pass: true } }, issues: [{ severity, code, message: `fake ${code}`, ref, actionable }] }));
}

interface FakeRunnerOpts {
  throwOn?: string;
  // only throw while the candidate value is set (the rollback re-run succeeds)
  throwValue?: number;
  /** called for every step */
  onRun?: (step: string) => void;
}
function fakeRunner(o: FakeRunnerOpts = {}): StepRunner & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    async run(step) {
      runs.push(step);
      o.onRun?.(step);
      const cur = await value();
      if (o.throwOn === step && (o.throwValue === undefined || o.throwValue === cur)) throw new Error(`boom in ${step}`);
      const v = await value();
      if (step === "transform") {
        const r = report("transform", { ok: v >= 0, gates: { "ccm.valid": { pass: v >= 0 } }, issues: v >= 5 ? [] : [{ severity: "error", code: "FAKE_CODE", message: "fake FAKE_CODE", ref: "/x", actionable: true }] });
        await ws.writeJson("reports/transform.json", r);
        return r;
      }
      if (step === "verify") {
        await ws.writeJson("verify/visual.json", { check: "visual", ok: v !== 13, stats: {}, issues: [], gates: { parity: { pass: v !== 13 } }, details: {} });
        return report("verify", { gates: { "visual.parity": { pass: v !== 13 } } });
      }
      return report(step);
    },
  };
}

function handler(cands: (n: number) => Candidate[], extra: Partial<Handler> = {}): Handler & { calls: number } {
  const h: Handler & { calls: number } = {
    id: "fake",
    codes: ["FAKE_CODE"],
    priority: 1,
    calls: 0,
    async measure() {
      return { primary: await value(), gates: {} };
    },
    async propose(): Promise<Candidate[]> {
      return cands(h.calls++);
    },
    ...extra,
  };
  return h;
}
const cand = (v: number, title = `set ${v}`, rerun: Candidate["rerun"] = ["transform"], extra: Partial<Candidate> = {}): Candidate => ({
  title,
  origin: "rule",
  files: [{ path: "mapping/value.json", content: JSON.stringify({ value: v }) }],
  rerun,
  ...extra,
});

function opts(h: Handler[], runner: StepRunner, extra: Partial<AutofixOptions> = {}): AutofixOptions {
  return { site: site(), ws, repoRoot: baseDir, log: silentLogger, handlers: h, runner, ...extra };
}

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[relative(dir, p)] = `${(await stat(p)).size}:${(await readFile(p, "utf8")).slice(0, 2000)}`;
    }
  };
  await walk(dir);
  return out;
}

beforeEach(async () => {
  ({ ws, baseDir, cleanup } = await createTempWorkspace("af-site"));
  await setValue(1);
  await seedTask();
});
afterEach(async () => cleanup());

describe("collect", () => {
  it("collects tasks from reports + verify files with handler, viewport and stable ids; gates merged", async () => {
    await ws.writeJson("verify/visual.json", { check: "visual", ok: false, stats: {}, gates: { parity: { pass: false } }, details: {}, issues: [{ severity: "error", code: "VISUAL_DIFF", message: "mobile /about: parity 0.9 < 0.97", ref: "/about", actionable: true }] });
    const vis: Handler = { id: "vis", codes: ["VISUAL_DIFF"], priority: 50, measure: async () => ({ primary: 0, gates: {} }), propose: async () => [] };
    const tasks = await collectTasks(ws, { handlers: [handler(() => []), vis], viewports: ["mobile", "desktop"] });
    expect(tasks.map((t) => t.id)).toEqual(["FAKE_CODE:/x", "VISUAL_DIFF:/about:mobile"]);
    expect(tasks[1]).toMatchObject({ handler: "vis", source: "verify:visual", data: { viewport: "mobile", url: "/about" } });
    expect(await readGates(ws)).toMatchObject({ "ccm.valid": true, "visual.parity": false, "step.transform": true });
  });
});

describe("runAutofix", () => {
  it("accepts an improving candidate: patch kept, attempt + backup logged", async () => {
    const h = handler(() => [cand(7)]);
    const runner = fakeRunner();
    const r = await runAutofix(opts([h], runner));
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ accepted: true, handler: "fake", reason: "improved 1 -> 7", taskIds: ["FAKE_CODE:/x"] });
    expect(await value()).toBe(7);
    expect(runner.runs).toEqual(["transform"]);
    expect(await ws.exists("autofix/attempts/0001-fake.json")).toBe(true);
    const idx = await ws.readJson<{ files: { existed: boolean; file: string }[] }>("autofix/attempts/0001-backup/index.json");
    expect(JSON.parse(await ws.readText(idx.files[0].file))).toEqual({ value: 1 });
    expect(r.report.issues.some((i) => i.code === AUTOFIX_CODES.ACCEPTED)).toBe(true);
    expect(r.report.stats).toMatchObject({ attempts: 1, accepted: 1, openTasksAfter: 0 });
  });

  it("rejects a non-improving candidate and rolls back data, reports and verify files", async () => {
    await ws.writeJson("verify/visual.json", { check: "visual", ok: true, stats: {}, issues: [], gates: { parity: { pass: true } }, details: { marker: "before" } });
    const before = await ws.readText("reports/transform.json");
    const h = handler((n) => (n === 0 ? [cand(0)] : []));
    const runner = fakeRunner();
    const r = await runAutofix(opts([h], runner, { candidatesPerTask: 1 }));
    expect(r.attempts[0]).toMatchObject({ accepted: false });
    expect(r.attempts[0].reason).toMatch(/no improvement \(primary 1 -> 0\)/);
    expect(await value()).toBe(1);
    expect(await ws.readText("reports/transform.json")).toBe(before);
    expect((await ws.readJson<{ details: { marker: string } }>("verify/visual.json")).details.marker).toBe("before");
    // rollback re-ran the producing step (transform), verify was restored from the snapshot instead
    expect(runner.runs).toEqual(["transform", "transform"]);
    const nh = r.report.issues.find((i) => i.code === AUTOFIX_CODES.NEEDS_HUMAN)!;
    expect(nh.message).toMatch(/dossier autofix\/dossiers\/fake_FAKE_CODE_x\.json/);
    expect(await ws.exists("autofix/dossiers/fake_FAKE_CODE_x.json")).toBe(true);
  });

  it("rejects an improvement that regresses another gate (pass → fail) and rolls back", async () => {
    await ws.writeJson("verify/visual.json", { check: "visual", ok: true, stats: {}, issues: [], gates: { parity: { pass: true } }, details: {} });
    const h = handler((n) => (n === 0 ? [cand(13, "breaks visual", ["transform", "verify"]), cand(6)] : []));
    const r = await runAutofix(opts([h], fakeRunner()));
    expect(r.attempts.map((a) => a.accepted)).toEqual([false, true]);
    expect(r.attempts[0].reason).toMatch(/gate visual\.parity regressed/);
    expect(await value()).toBe(6);
    expect((await ws.readJson<{ gates: { parity: { pass: boolean } } }>("verify/visual.json")).gates.parity.pass).toBe(true);
  });

  it("stops at the LLM budget with AUTOFIX_BUDGET_EXHAUSTED", async () => {
    let calls = 0;
    const llm: LlmClient = {
      async complete() {
        calls++;
        return { content: "{}", model: "deepseek-flash", provider: "deepseek", promptTokens: 1_000_000, completionTokens: 0, durationMs: 1 };
      },
    };
    let k = 0;
    const h = handler(() => [], {
      async propose(ctx) {
        await ctx.llm!.complete({ step: "autofix-fake", messages: [{ role: "user", content: "x" }] });
        return [cand(-100 - k++)]; // never improves
      },
    });
    const r = await runAutofix(opts([h], fakeRunner(), { llm, budgetUsd: 0.2, candidatesPerTask: 5 }));
    expect(calls).toBe(1); // ~$0.28 > $0.20 after the first call → no second propose
    expect(r.stopReason).toBe("budget exhausted");
    expect(r.report.issues.some((i) => i.code === AUTOFIX_CODES.BUDGET_EXHAUSTED)).toBe(true);
    expect(r.attempts[0].llm).toMatchObject({ calls: 1, estCostUsd: estimateCostUsd("deepseek", 1_000_000, 0) });
  });

  it("stops after `patience` attempts without an accepted candidate", async () => {
    let k = 0;
    const h = handler(() => [cand(-1 - k++), cand(-50 - k++)]);
    const r = await runAutofix(opts([h], fakeRunner(), { patience: 3, candidatesPerTask: 10 }));
    expect(r.attempts).toHaveLength(3);
    expect(r.stopReason).toMatch(/patience 3/);
    expect(r.report.issues.some((i) => i.code === AUTOFIX_CODES.STALLED)).toBe(true);
  });

  it("respects maxIterations and never retries an identical patch", async () => {
    const h = handler(() => [cand(0), cand(0)]);
    const r = await runAutofix(opts([h], fakeRunner(), { maxIterations: 5, candidatesPerTask: 3 }));
    expect(r.attempts).toHaveLength(1); // duplicate patch skipped, second propose round returns only tried patches
    expect(r.report.issues.find((i) => i.code === AUTOFIX_CODES.NEEDS_HUMAN)?.message).toMatch(/tried before/);
    const r2 = await runAutofix(opts([handler((n) => [cand(-n - 1)])], fakeRunner(), { maxIterations: 2, candidatesPerTask: 9, patience: 9 }));
    expect(r2.attempts).toHaveLength(2);
    expect(r2.stopReason).toMatch(/maxIterations 2/);
    expect(r2.attempts.map((a) => a.seq)).toEqual([2, 3]); // seq continues across runs
  });

  it("files PIPELINE_BUG bundles for crash issues and for a rerun that throws", async () => {
    await ws.writeJson("verify/links.json", { check: "links", ok: false, stats: { crashed: true }, issues: [{ severity: "error", code: "CHECK_CRASHED", message: "links: Cannot read properties of undefined", actionable: true }], gates: { run: { pass: false } }, details: { error: "TypeError: x\n    at linkCheck (links.ts:1:1)" } });
    await ws.writeJson("raw/html/crawl.json", { pages: [{ path: "/x", id: "x", status: 200 }] });
    await ws.writeText("raw/html/pages/x.raw.html", "<html><head><title>Secret title</title></head><body><main class=\"m\"><h1>Private body text</h1><img alt=\"Alt words\" src=\"/a.png\"></main><script>var t='x'</script></body></html>");
    const h = handler((n) => (n === 0 ? [cand(9)] : []));
    const r = await runAutofix(opts([h], fakeRunner({ throwOn: "transform", throwValue: 9 }), { candidatesPerTask: 1 }));
    const bugs = r.report.issues.filter((i) => i.code === AUTOFIX_CODES.PIPELINE_BUG);
    expect(bugs).toHaveLength(2);
    const readme1 = await ws.readText("autofix/bugs/1/README.md");
    expect(readme1).toMatch(/CHECK_CRASHED in `verify` \(check `links`\)/);
    expect(readme1).toMatch(/at linkCheck/);
    expect(await ws.exists("autofix/bugs/1/inputs/verify/links.json")).toBe(true);
    const readme2 = await ws.readText("autofix/bugs/2/README.md");
    expect(readme2).toMatch(/RERUN_CRASHED in `transform`/);
    expect(readme2).toMatch(/boom in transform/);
    expect(JSON.parse(await ws.readText("autofix/bugs/2/candidate.json")).title).toBe("set 9");
    expect(await value()).toBe(1); // rolled back
    // same failure again → same bundle (signature), no new directory
    const again = await runAutofix(opts([handler(() => [])], fakeRunner()));
    expect(again.report.issues.filter((i) => i.code === AUTOFIX_CODES.PIPELINE_BUG).map((i) => i.ref)).toEqual(["autofix/bugs/1"]);
    expect((await ws.list("autofix/bugs", "bug.json")).length).toBe(2);
  });

  it("skeletonises the page snippet of a bug bundle (no page text)", async () => {
    await ws.writeJson("reports/verify.json", report("verify", { ok: false, issues: [{ severity: "error", code: "NEW_PAGE_ERROR", message: "mobile /x: new site returned 500", ref: "/x", actionable: true }] }));
    await ws.writeJson("raw/html/crawl.json", { pages: [{ path: "/x", id: "x", status: 200 }] });
    await ws.writeText("raw/html/pages/x.raw.html", "<html><body><main class=\"m\"><h1>Private body text</h1><img alt=\"Alt words\" src=\"/a.png\"></main><script>var secret='x'</script></body></html>");
    await runAutofix(opts([handler(() => [])], fakeRunner()));
    const snip = await ws.readText("autofix/bugs/1/snippet.html");
    expect(snip).toContain('<main class="m"><h1>…</h1><img alt="…" src="/a.png"></main>');
    expect(snip).not.toMatch(/Private|Alt words|secret/);
  });

  it("refuses patches outside the data files (ccm/, reports/, code)", async () => {
    const bad: Candidate = { title: "edit ccm", origin: "llm", files: [{ path: "ccm/entries/x.json", content: "{}" }], rerun: ["transform"] };
    const code: Candidate = { title: "edit code", origin: "llm", files: [{ path: "packages/core/src/llm.ts", content: "x" }], rerun: [] };
    const r = await runAutofix(opts([handler((n) => (n === 0 ? [bad, code] : []))], fakeRunner(), { candidatesPerTask: 2 }));
    expect(r.attempts.map((a) => a.reason)).toEqual([expect.stringMatching(/patch refused: generated/), expect.stringMatching(/patch refused: repo path not writable/)]);
    expect(await ws.exists("ccm/entries/x.json")).toBe(false);
    expect(r.report.issues.filter((i) => i.code === AUTOFIX_CODES.PATCH_REFUSED)).toHaveLength(2);
  });

  it("advisory (info) tasks without candidates are skipped silently", async () => {
    await seedTask("FAKE_INFO", "/y", "info", false);
    const h = handler(() => [], { codes: ["FAKE_INFO"] });
    const r = await runAutofix(opts([h], fakeRunner()));
    expect(h.calls).toBe(1);
    expect(r.report.issues).toEqual([]);
  });

  it("dry-run proposes only and writes nothing", async () => {
    const h = handler(() => [cand(7)]);
    const runner = fakeRunner();
    const before = await tree(ws.root);
    const r = await runAutofix(opts([h], runner, { dryRun: true }));
    expect(r.proposals).toEqual([{ group: "fake:FAKE_CODE:/x", handler: "fake", taskIds: ["FAKE_CODE:/x"], candidates: [{ title: "set 7", origin: "rule", files: ["mapping/value.json"], rerun: ["transform"] }] }]);
    expect(runner.runs).toEqual([]);
    expect(await tree(ws.root)).toEqual(before);
  });
  it("re-runs the stale downstream steps once after accepted content fixes, then re-collects (W2-I)", async () => {
    // a workspace that already went through design / app / verify
    for (const st of ["design-extract", "frontend-generate", "verify"]) await ws.writeJson(`reports/${st}.json`, report(st));
    const h = handler(() => [cand(7)]);
    const runner = fakeRunner();
    const r = await runAutofix(opts([h], runner, { newBaseUrl: "http://localhost:4999", appPort: 4999 }));
    expect(r.attempts.map((a) => a.accepted)).toEqual([true]);
    expect(runner.runs).toEqual(["transform", "design-extract", "frontend-generate", "build", "verify"]);
    expect(r.report.issues.find((i) => i.code === "AUTOFIX_DOWNSTREAM_RERUN")?.message).toContain("design-extract → frontend-generate → build → verify");
  });

  it("propagates before a downstream group is measured, not between content groups", async () => {
    for (const st of ["design-extract", "frontend-generate", "verify"]) await ws.writeJson(`reports/${st}.json`, report(st));
    await ws.writeJson("verify/visual.json", { check: "visual", ok: false, stats: {}, gates: {}, details: {}, issues: [{ severity: "error", code: "VIS_CODE", message: "mobile /a: parity 0.5", ref: "/a", actionable: true }] });
    const order: string[] = [];
    const content = handler(() => [cand(7)]);
    const vis: Handler = { id: "vis", codes: ["VIS_CODE"], priority: 50, measure: async () => (order.push("vis.measure"), { primary: 0, gates: {} }), propose: async () => [] };
    const runner = fakeRunner({ onRun: (s) => order.push(s) });
    await runAutofix(opts([content, vis], runner, { newBaseUrl: "http://localhost:4999", appPort: 4999 }));
    // the fresh verify no longer reports VIS_CODE → the stale visual task is never measured / proposed on
    expect(order).toEqual(["transform", "design-extract", "frontend-generate", "build", "verify"]);
  });

  it("without downstream reports (content-only workspace) nothing is propagated", async () => {
    const runner = fakeRunner();
    await runAutofix(opts([handler(() => [cand(7)])], runner, { newBaseUrl: "http://localhost:4999", appPort: 4999 }));
    expect(runner.runs).toEqual(["transform"]);
  });

  it("revisits a finished group when a later handler creates new tasks for it (W2-I)", async () => {
    // transform: FAKE_CODE while value < 5; LATE_CODE /a always, and LATE_CODE /b once value >= 5
    const runner: StepRunner & { runs: string[] } = {
      runs: [],
      async run(step) {
        this.runs.push(step);
        const v = await value();
        const issues = [{ severity: "error" as const, code: "LATE_CODE", message: "late a", ref: "/a", actionable: true }];
        if (v >= 5) issues.push({ severity: "error", code: "LATE_CODE", message: "late b", ref: "/b", actionable: true });
        else issues.push({ severity: "error", code: "FAKE_CODE", message: "fake", ref: "/x", actionable: true });
        const r = report("transform", { gates: { "ccm.valid": { pass: true } }, issues });
        await ws.writeJson("reports/transform.json", r);
        return r;
      },
    };
    await runner.run("transform");
    runner.runs.length = 0;
    // "early" runs first (priority 0), one group for all its tasks, proposes nothing → NEEDS_HUMAN
    const early = handler(() => [], { id: "early", codes: ["LATE_CODE"], priority: 0, groupKey: () => "all" });
    const fake = handler(() => [cand(7)]);
    const r = await runAutofix(opts([early, fake], runner));
    expect(early.calls).toBe(2);
    const human = r.report.issues.filter((i) => i.code === AUTOFIX_CODES.NEEDS_HUMAN);
    expect(human).toHaveLength(1);
    expect(human[0].message).toContain("2 task(s)");
  });
  it("does not propagate before a group whose source step was just re-run (design tasks after a design fix)", async () => {
    for (const st of ["design-extract", "frontend-generate", "verify"]) await ws.writeJson(`reports/${st}.json`, report(st));
    // two design groups: the first accepted fix re-ran design-extract + frontend-generate; build/verify are pending
    await ws.writeJson("reports/design-extract.json", report("design-extract", { issues: ["/a", "/b"].map((ref) => ({ severity: "error" as const, code: "DES_CODE", message: `d ${ref}`, ref, actionable: true })) }));
    const order: string[] = [];
    let n = 0;
    const des = handler(() => [cand(2 + n++, `d${n}`, ["design-extract", "frontend-generate"])], { id: "des", codes: ["DES_CODE"], measure: async () => ({ primary: await value(), gates: {} }) });
    const runner = fakeRunner({ onRun: (st) => order.push(st) });
    await runAutofix(opts([des], runner, { newBaseUrl: "http://localhost:4999", appPort: 4999, codes: ["DES_CODE"] }));
    // both design groups are tried back to back; build → verify once at the end
    expect(order.filter((x) => x === "design-extract").length).toBeGreaterThanOrEqual(2);
    expect(order.filter((x) => x === "build")).toHaveLength(1);
    expect(order.slice(-2)).toEqual(["build", "verify"]);
  });
  it("after a design fast-path fix, re-runs the full design-extract before the next design group (its mined issues)", async () => {
    for (const st of ["design-extract", "frontend-generate", "verify"]) await ws.writeJson(`reports/${st}.json`, report(st));
    await ws.writeJson("reports/design-extract.json", report("design-extract", { issues: ["/a", "/b"].map((ref) => ({ severity: "error" as const, code: "DES_CODE", message: `d ${ref}`, ref, actionable: true })) }));
    const order: string[] = [];
    let n = 0;
    const fast = { "design-extract": { applyOverridesOnly: true } };
    const des = handler(() => [cand(2 + n++, `d${n}`, ["design-extract", "frontend-generate"], { stepOptions: fast })], { id: "des", codes: ["DES_CODE"] });
    const runner = fakeRunner({ onRun: (st) => order.push(st) });
    await runAutofix(opts([des], runner, { newBaseUrl: "http://localhost:4999", appPort: 4999, codes: ["DES_CODE"], maxIterations: 2 }));
    // fix 1 (fast) → full design-extract (pending) → fix 2 (fast) → end: design-extract, frontend-generate, build, verify
    expect(order).toEqual(["design-extract", "frontend-generate", "design-extract", "design-extract", "frontend-generate", "design-extract", "frontend-generate", "build", "verify"]);
  });

  it("does not re-propose a group exhausted in an earlier run (no new model calls on a replay)", async () => {
    const h = handler(() => [cand(0, "a"), cand(-1, "b"), cand(1, "c")]);
    await runAutofix(opts([h], fakeRunner()));
    expect(h.calls).toBe(1);
    const h2 = handler(() => [cand(0, "d")]);
    const r2 = await runAutofix(opts([h2], fakeRunner()));
    expect(h2.calls).toBe(0);
    expect(r2.report.issues.find((i) => i.code === AUTOFIX_CODES.NEEDS_HUMAN)?.message).toContain("exhausted in an earlier run");
  });
  it("a failed rollback rebuild leaves the app source as before the candidate and stops with PIPELINE_BUG", async () => {
    const { mkdir, writeFile, readFile: rf } = await import("node:fs/promises");
    const app = join(baseDir, `apps/${ws.site}-web`);
    await mkdir(join(app, "src/lib"), { recursive: true });
    await writeFile(join(app, "src/lib/page.tsx"), "v1");
    const runner: StepRunner = {
      async run(step) {
        if (step === "frontend-generate") {
          await writeFile(join(app, "src/lib/page.tsx"), "v2 (half-updated)");
          await writeFile(join(app, "src/lib/new.tsx"), "new");
          return report(step);
        }
        if (step === "build") return report("build", { ok: false, issues: [{ severity: "error", code: "BUILD_FAILED", message: "next build failed: boom", actionable: true }] });
        return report(step);
      },
    };
    const r = await runAutofix(opts([handler(() => [cand(7, "x", ["frontend-generate", "build"])])], runner, { appPort: 4999 }));
    expect(r.attempts[0].reason).toContain("ROLLBACK RERUN FAILED");
    expect(r.stopReason).toContain("fatal");
    expect(r.report.issues.some((i) => i.code === AUTOFIX_CODES.PIPELINE_BUG)).toBe(true);
    expect(await rf(join(app, "src/lib/page.tsx"), "utf8")).toBe("v1");
    await expect(rf(join(app, "src/lib/new.tsx"), "utf8")).rejects.toThrow();
    expect(await value()).toBe(1);
  });
});
