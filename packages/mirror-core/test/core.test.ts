import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSiteConfig, loadSiteConfigWithRaw, resolveSiteConfigPath, SiteConfigError } from "../src/config.js";
import { loadEnv, redactSecrets } from "../src/env.js";
import { createLogger } from "../src/logger.js";
import { emptyReport, failingGates, readReports, reportPassed, runStep, writeReport } from "../src/report.js";
import { IdMap } from "../src/idmap.js";
import { logEffort, readEffort, summarizeEffort } from "../src/effort.js";
import { parseTasks, taskId, writeTasks } from "../src/tasks.js";
import { createTempWorkspace, testStepContext } from "../src/testing.js";
import { SAFE_ID_MAX, safeId, Workspace } from "../src/workspace.js";

let ws: Workspace;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ ws, cleanup } = await createTempWorkspace("core"));
});
afterEach(() => cleanup());

describe("loadSiteConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cmp-sites-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("loads sites/<site>.yaml and applies defaults", async () => {
    await writeFile(join(dir, "demo.yaml"), "site: demo\nbaseUrl: http://localhost:4400\nurls: [/, /about]\n");
    const c = await loadSiteConfig("demo", { sitesDir: dir });
    expect(c.site).toBe("demo");
    expect(c.urls).toEqual(["/", "/about"]);
    expect(c.source.adapter).toBe("drupal");
    expect(c.crawl.viewports).toHaveLength(3);
    expect(c.llm.sendContent).toBe(false);
    const { raw } = await loadSiteConfigWithRaw("demo", { sitesDir: dir });
    expect(raw.crawl).toBeUndefined();
  });

  it("accepts an explicit path", async () => {
    const p = join(dir, "x.yml");
    await writeFile(p, "site: x\nbaseUrl: https://example.com\n");
    expect((await loadSiteConfig(p)).site).toBe("x");
    expect(resolveSiteConfigPath("fixture", { sitesDir: dir })).toBe(join(dir, "fixture.yaml"));
  });

  it("throws readable errors for missing / invalid configs", async () => {
    await expect(loadSiteConfig("nope", { sitesDir: dir })).rejects.toThrow(/not found/);
    await writeFile(join(dir, "bad.yaml"), "site: bad\nbaseUrl: not-a-url\nparity: { tier: 7 }\n");
    const err = await loadSiteConfig("bad", { sitesDir: dir }).catch((e) => e);
    expect(err).toBeInstanceOf(SiteConfigError);
    expect(err.message).toMatch(/baseUrl/);
    expect(err.message).toMatch(/parity/);
    await writeFile(join(dir, "list.yaml"), "- a\n- b\n");
    await expect(loadSiteConfig("list", { sitesDir: dir })).rejects.toThrow(/mapping/);
  });

});

describe("loadEnv / redaction", () => {
  it("loads without overriding existing vars and reports only names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmp-env-"));
    const p = join(dir, ".env");
    await writeFile(p, "A_KEY=secretvalue123\nB=two\nC=\n");
    const env: NodeJS.ProcessEnv = { B: "already" };
    const r = loadEnv({ path: p, env });
    expect(r.loaded).toBe(true);
    expect(r.keys.sort()).toEqual(["A_KEY", "C"]);
    expect(r.skipped).toEqual(["B"]);
    expect(env.B).toBe("already");
    expect(env.A_KEY).toBe("secretvalue123");
    expect(JSON.stringify(r)).not.toContain("secretvalue123");
    expect(loadEnv({ path: join(dir, "missing"), env }).loaded).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("redacts secret-looking env values", () => {
    expect(redactSecrets("token=abcdef123 ok", { MY_TOKEN: "abcdef123", OTHER: "ok" })).toBe("token=*** ok");
  });
});

describe("createLogger", () => {
  it("respects levels and redacts", () => {
    const lines: string[] = [];
    process.env.CMP_TEST_SECRET_KEY = "supersecret999";
    const log = createLogger("demo", { level: "info", write: (l) => lines.push(l) });
    log.debug("hidden");
    log.info("hello", { k: "supersecret999" });
    log.warn("careful");
    delete process.env.CMP_TEST_SECRET_KEY;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\[demo\] hello/);
    expect(lines[0]).not.toContain("supersecret999");
    expect(lines[1]).toMatch(/WARN careful/);
  });
  it("emits JSON lines when asked", () => {
    const lines: string[] = [];
    createLogger("j", { json: true, write: (l) => lines.push(l) }).error("boom");
    expect(JSON.parse(lines[0])).toMatchObject({ level: "error", step: "j", msg: "boom" });
  });
});

describe("runStep / writeReport", () => {
  it("times the step, sets metadata and writes json+md", async () => {
    const ctx = testStepContext(ws, { dryRun: true });
    const r = await runStep(
      "analyze",
      async (c) => ({ ...emptyReport("whatever", c), stats: { types: 3 }, issues: [{ severity: "warning", code: "W", message: "w" }], outputs: ["analysis/x.json"], gates: { "a.b": { pass: true, value: 1 } } }),
      ctx,
    );
    expect(r.step).toBe("analyze");
    expect(r.site).toBe("core");
    expect(r.dryRun).toBe(true);
    expect(typeof r.stats.durationMs).toBe("number");
    expect(reportPassed(r)).toBe(true);
    const json = await ws.readJson<{ stats: { types: number } }>("reports/analyze.json");
    expect(json.stats.types).toBe(3);
    const md = await ws.readText("reports/analyze.md");
    expect(md).toMatch(/# Step `analyze`/);
    expect(md).toMatch(/\(dry-run\)/);
    expect(md).toMatch(/\| a\.b \| yes/);
  });

  it("catches exceptions into a failed report", async () => {
    const r = await runStep("load", async () => {
      throw new Error("kaputt");
    }, testStepContext(ws));
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: "STEP_FAILED", message: "kaputt", actionable: true });
    expect((await ws.readJson<{ ok: boolean }>("reports/load.json")).ok).toBe(false);
  });

  it("rejects non-report return values and can skip writing", async () => {
    const r = await runStep("x", async () => undefined as never, testStepContext(ws), { write: false });
    expect(r.issues[0].code).toBe("STEP_INVALID_REPORT");
    expect(await ws.exists("reports/x.json")).toBe(false);
  });

  it("failingGates / readReports", async () => {
    const ctx = testStepContext(ws);
    const rep = { ...emptyReport("verify", ctx), gates: { "visual.parity": { pass: false, value: 0.9, threshold: 0.97 }, ok: { pass: true } } };
    expect(failingGates(rep)).toEqual(["visual.parity"]);
    expect(reportPassed(rep)).toBe(false);
    await writeReport(ws, rep);
    await ws.writeText("reports/garbage.json", "{");
    const all = await readReports(ws);
    expect(all.map((r) => r.step)).toEqual(["verify"]);
  });
});

describe("IdMap", () => {
  it("loads empty, sets, saves sorted and reloads", async () => {
    const m = await IdMap.load(ws);
    expect(m.size()).toBe(0);
    m.set("contentful", IdMap.key("drupal:node:2", "en"), "b");
    m.set("contentful", "drupal:node:1", "a");
    m.set("strapi", "x", "1");
    expect(m.isDirty).toBe(true);
    await m.save();
    expect(m.isDirty).toBe(false);
    const raw = await ws.readText("idmap.json");
    expect(raw.indexOf("drupal:node:1")).toBeLessThan(raw.indexOf("drupal:node:2:en"));
    const m2 = await IdMap.load(ws);
    expect(m2.get("contentful", "drupal:node:2:en")).toBe("b");
    expect(m2.size("contentful")).toBe(2);
    expect(m2.targets()).toEqual(["contentful", "strapi"]);
    m2.set("contentful", "drupal:node:1", "a");
    expect(m2.isDirty).toBe(false);
    expect(m2.delete("contentful", "drupal:node:1")).toBe(true);
    expect(m2.has("contentful", "drupal:node:1")).toBe(false);
  });
});

describe("effort log", () => {
  it("appends and summarises", async () => {
    await logEffort(ws, { step: "map", minutes: 30, note: "reviewed mapping" });
    await logEffort(ws, { step: "map", minutes: 15 });
    await logEffort(ws, { step: "verify", minutes: 45, who: "agent" });
    await expect(logEffort(ws, { step: "map", minutes: -1 })).rejects.toThrow();
    const entries = await readEffort(ws);
    expect(entries).toHaveLength(3);
    expect(summarizeEffort(entries)).toEqual({ byStep: { map: 45, verify: 45 }, totalMinutes: 90, count: 3 });
  });
});

describe("writeTasks", () => {
  const issues = [
    { severity: "error" as const, code: "UNMAPPED_FIELD", message: "field_x unmapped", ref: "node.article.field_x", actionable: true, step: "transform" },
    { severity: "warning" as const, code: "BROKEN_LINK", message: "404", ref: "/a", actionable: true, step: "verify" },
    { severity: "warning" as const, code: "BROKEN_LINK", message: "404 again", ref: "/a", actionable: true, step: "verify" },
    { severity: "info" as const, code: "NOTE", message: "not actionable" },
    { severity: "error" as const, code: "IMPLICIT", message: "errors default to actionable" },
  ];

  it("creates a deduplicated checklist with stable ids", async () => {
    const r = await writeTasks(ws, issues);
    expect(r).toMatchObject({ open: 3, reopened: 0, done: 0 });
    const md = await ws.readText("TASKS.md");
    expect(md).toContain(`<!-- task:${taskId(issues[0])} -->`);
    expect(md).toContain("(×2)");
    expect(md).not.toContain("not actionable");
    // stable: same input → identical file
    await writeTasks(ws, issues);
    expect(await ws.readText("TASKS.md")).toBe(md);
  });

  it("keeps ticks: resolved → Done, still reported → Reopened", async () => {
    await writeTasks(ws, issues);
    let md = await ws.readText("TASKS.md");
    const idFixed = taskId(issues[0]);
    const idClaimed = taskId(issues[1]);
    md = md.replace(new RegExp(`- \\[ \\](.*task:${idFixed})`), "- [x]$1").replace(new RegExp(`- \\[ \\](.*task:${idClaimed})`), "- [x]$1");
    await ws.writeText("TASKS.md", md);
    // next run: issue 0 is gone, issue 1 still reported
    const r = await writeTasks(ws, issues.slice(1));
    expect(r).toMatchObject({ open: 1, reopened: 1, done: 1 });
    const parsed = parseTasks(await ws.readText("TASKS.md"));
    expect(parsed.get(idFixed)?.checked).toBe(true);
    expect(parsed.get(idClaimed)?.checked).toBe(false);
    // the done item stays in history on later runs
    const r2 = await writeTasks(ws, []);
    expect(r2).toMatchObject({ open: 0, reopened: 0, done: 3 });
  });
});

describe("safeId", () => {
  it("keeps short ids unchanged", () => {
    expect(safeId("drupal:node:12")).toBe("drupal_node_12");
    expect(safeId("/")).toBe("root");
  });

  it("caps long ids with a stable hash suffix", () => {
    const base = "html:asset:https://assets.volkswagen.com/is/image/volkswagenag/VW2454_Raederwechsel_2026_Liegestuhl_16x9?";
    const a = safeId(base + "Zml0PWNyb3AsMSZmbXQ9d2VicC1hbHBoYSZxbHQ9Nzkmd2lkPTMyMCZoZWk9MTkyJmFsaWduPTAuMDAsMC4wMCZiZmM9b2ZmJmxheWVy".repeat(3));
    const b = safeId(base + "Zml0PWNyb3AsMSZmbXQ9d2VicC1hbHBoYSZxbHQ9Nzkmd2lkPTMyMCZoZWk9MTkyJmFsaWduPTAuMDAsMC4wMCZiZmM9b2ZmJmxheWVz".repeat(3));
    expect(a.length).toBeLessThanOrEqual(SAFE_ID_MAX);
    expect(a).toMatch(/^[a-zA-Z0-9._-]+_[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(safeId(base + "x".repeat(300))).toBe(safeId(base + "x".repeat(300)));
  });
});
