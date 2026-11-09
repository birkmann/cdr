import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autopilotPaths,
  collectCycle,
  inspectCycle,
  processIssues,
  readMirrorRun,
  replayMissIssues,
  type AutopilotPaths,
  type StageSummary,
} from "@harness/autopilot";

let root: string;
let paths: AutopilotPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdr-autopilot-collect-"));
  paths = autopilotPaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function json(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

/** A finished mirror run of the acme fixture, the way the pipeline leaves it on disk (verify failed once, a crash bundle). */
function recordedMirrorRun(runDir: string): void {
  json(join(runDir, "manifest.json"), {
    id: "20261109-acme-abc",
    status: "failed",
    stages: {
      consent: { status: "done", ms: 5 },
      crawl: { status: "done", ms: 9000, skipped: ["menu toggle at mobile did not open"] },
      appbuild: { status: "done", ms: 45000 },
      verify: { status: "done", ms: 20000 },
      fix: { status: "done", ms: 12000 },
      report: { status: "failed", ms: 10, detail: "ENOSPC on /tmp/x" },
    },
    gates: [],
  });
  json(join(runDir, "reports/extract.json"), {
    gates: { "crawl.pagesComplete": { pass: true, value: 0, threshold: 0 } },
  });
  json(join(runDir, "reports/transform.json"), {
    gates: { "ccm.valid": { pass: true, value: 0, threshold: 0 } },
  });
  json(join(runDir, "verify/summary.json"), {
    gates: {
      "visual.parity": { pass: false, value: 0.91, threshold: 0.97 },
      "visual.bbox": { pass: true, value: 1, threshold: 4 },
      "visual.height": { pass: true, value: 0, threshold: 4 },
      "fidelity.similarity": { pass: true, value: 1, threshold: 0.99 },
      "links.broken": { pass: false, value: 2, threshold: 0 },
      "seo.title": { pass: false, value: "missing" },
    },
  });
  json(join(runDir, "verify/visual.json"), {
    check: "visual",
    issues: [
      { severity: "error", code: "VISUAL_DIFF", message: "mobile /: parity 0.91 < 0.97 (diff x)", ref: "/" },
      {
        severity: "info",
        code: "SOURCE_DRIFT",
        message: "tablet /: differs from the live page: the source changed",
        ref: "/",
      },
    ],
    details: {
      results: [
        {
          viewport: "mobile",
          path: "/",
          parity: 0.91,
          pass: false,
          parityPass: false,
          bboxPass: true,
          heightPass: true,
          baseline: "design/screenshots/mobile/index.png",
          current: "verify/visual/mobile/index.new.png",
          diff: "verify/visual/mobile/index.diff.png",
          height: { delta: 0 },
          bbox: { maxDelta: 1 },
          diagnosis: { file: "verify/diagnosis/mobile/index.json", cause: "CSS_MISSING", element: "header" },
        },
        {
          viewport: "desktop",
          path: "/",
          parity: 0.99,
          pass: true,
          parityPass: true,
          bboxPass: true,
          heightPass: true,
          height: { delta: 0 },
          bbox: { maxDelta: 0 },
        },
      ],
    },
  });
  json(join(runDir, "verify/diagnosis/mobile/index.json"), {
    classification: {
      cause: "CSS_MISSING",
      evidence: ["only on the old side: main.css", "header height differs"],
    },
    assets: {
      consoleErrors: { onlyNew: ["Uncaught ReferenceError: x is not defined"] },
      failedRequests: { onlyNew: [{ url: "/chunk.js", status: 404, type: "script" }] },
    },
  });
  json(join(runDir, "verify/links.json"), {
    check: "links",
    issues: [
      {
        severity: "error",
        code: "BROKEN_LINK",
        message: "internal link /kontakt returns 404",
        ref: "/kontakt",
      },
    ],
  });
  json(join(runDir, "verify/seo.json"), { check: "seo", issues: [] });
  json(join(runDir, "reports/autofix.json"), {
    issues: [
      {
        severity: "warning",
        code: "AUTOFIX_NEEDS_HUMAN",
        message:
          "parity-fix: 1 task(s) not fixed (no candidate) — dossier autofix/dossiers/parity-fix-1.json",
      },
      { severity: "warning", code: "AUTOFIX_BUDGET_EXHAUSTED", message: "LLM budget exhausted" },
    ],
  });
  json(join(runDir, "autofix/attempts/0001-parity-fix.json"), {
    seq: 1,
    handler: "parity-fix",
    accepted: false,
    reason: "no improvement",
  });
  json(join(runDir, "autofix/bugs/1/bug.json"), {
    n: 1,
    code: "CHECK_CRASHED",
    step: "verify",
    check: "links",
    message: "links: Cannot read properties",
  });
  writeFileSync(join(runDir, "autofix/bugs/1/README.md"), "# PIPELINE_BUG 1");
  json(join(runDir, "llm-log/a.json"), { step: "design", cached: true, ok: true, estCostUsd: 0 });
  json(join(runDir, "llm-log/b.json"), { step: "design", cached: false, ok: true, estCostUsd: 0.5 });
  json(join(runDir, "llm-log/c.json"), {
    step: "autofix",
    cached: false,
    ok: false,
    validationError: "bad json",
    estCostUsd: 0.25,
  });
}

function summary(stage: string, site: string, partial: Partial<StageSummary>): StageSummary {
  return {
    stage: stage as StageSummary["stage"],
    site,
    status: "passed",
    wallClockMs: 1000,
    gates: [],
    issues: [],
    artifacts: {},
    ...partial,
  };
}

function writeSummary(cycle: number, site: string, s: StageSummary): void {
  json(join(paths.stageDir(cycle, site, s.stage), "summary.json"), s);
}

describe("readMirrorRun on a recorded run", () => {
  it("reads gates per viewport, the dossier's cause and every source of the plan's table", () => {
    const run = join(root, "run");
    recordedMirrorRun(run);
    const d = readMirrorRun(run);
    expect(d.status).toBe("failed");
    const parity = d.gates.filter((g) => g.id === "visual.parity");
    expect(parity).toEqual([
      expect.objectContaining({ viewport: "mobile", pass: false, value: 0.91, threshold: 0.97, hard: true }),
      expect.objectContaining({ viewport: "desktop", pass: true, value: 0.99, hard: true }),
    ]);
    expect(d.gates.find((g) => g.id === "seo.title")).toMatchObject({ pass: false, hard: false });
    expect(d.gates.find((g) => g.id === "appbuild")).toMatchObject({ pass: true, hard: true });
    expect(d.gates.find((g) => g.id === "ccm.valid")).toMatchObject({ pass: true, hard: true });
    const issueCodes = d.issues.map((i) => i.code);
    expect(issueCodes).toEqual(
      expect.arrayContaining([
        "STAGE_FAILED",
        "STAGE_SKIPPED_PARTS",
        "visual.parity",
        "BROKEN_LINK",
        "links.broken",
        "seo.title",
        "AUTOFIX_NEEDS_HUMAN",
        "BUDGET_EXCEEDED",
        "PIPELINE_BUG",
        "NEW_PAGE_ERROR",
        "REQUEST_FAILED",
        "LLM_FAILED",
      ]),
    );
    expect(issueCodes).not.toContain("VISUAL_DIFF");
    const visual = d.issues.find((i) => i.code === "visual.parity")!;
    expect(visual.cause).toBe("CSS_MISSING");
    expect(visual.message).toContain("only on the old side");
    expect(visual.evidence).toContain(join(run, "verify/diagnosis/mobile/index.json"));
    expect(d.issues.find((i) => i.code === "PIPELINE_BUG")).toMatchObject({
      cause: "CHECK_CRASHED:links",
      evidence: expect.arrayContaining([join(run, "autofix/bugs/1/README.md")]),
    });
    expect(d.issues.find((i) => i.code === "AUTOFIX_NEEDS_HUMAN")!.evidence).toEqual([
      join(run, "autofix/dossiers/parity-fix-1.json"),
    ]);
    expect(d.usage).toEqual({ calls: 3, cachedCalls: 1, costUsd: 0.75 });
    expect(d.stageMs.appbuild).toBe(45000);
  });

  it("records source drift as information only", () => {
    const run = join(root, "run");
    recordedMirrorRun(run);
    const drift = readMirrorRun(run).issues.find((i) => i.code === "SOURCE_DRIFT");
    expect(drift?.severity).toBe("info");
  });

  it("fails a run that never reached verify", () => {
    const run = join(root, "run");
    json(join(run, "manifest.json"), {
      status: "failed",
      stages: { crawl: { status: "failed", detail: "blocked" } },
    });
    const d = readMirrorRun(run);
    expect(d.status).toBe("failed");
    expect(d.issues).toEqual([
      expect.objectContaining({ code: "STAGE_FAILED", cause: "crawl", severity: "error" }),
    ]);
  });
});

describe("collector", () => {
  it("groups one code path over sites under one signature, and never reports drift", () => {
    const run = join(root, "run");
    recordedMirrorRun(run);
    const d = readMirrorRun(run);
    for (const site of ["bvg", "ibm"])
      writeSummary(
        1,
        site,
        summary("mirror", site, {
          status: d.status,
          gates: d.gates,
          issues: d.issues,
          usage: d.usage,
          artifacts: { runDir: run },
        }),
      );
    const findings = collectCycle(paths, 1);
    const parity = findings.find((f) => f.signature === "mirror:visual.parity:CSS_MISSING")!;
    expect(parity.sites).toEqual(["bvg", "ibm"]);
    expect(parity.rank).toBe(1);
    expect(findings.find((f) => f.code === "SOURCE_DRIFT")).toBeUndefined();
    expect(findings.find((f) => f.signature === "mirror:PIPELINE_BUG:CHECK_CRASHED:links")).toMatchObject({
      rank: 0,
    });
    expect(findings.find((f) => f.signature === "mirror:seo.title")).toMatchObject({ rank: 3 });
    expect(findings.find((f) => f.stage === "health" && f.code === "BUDGET_EXCEEDED")).toMatchObject({
      signature: "health:BUDGET_EXCEEDED:autofix",
      rank: 2,
    });
    expect(findings.find((f) => f.stage === "health" && f.code === "LLM_FAILED")).toMatchObject({ rank: 2 });
  });

  it("turns a failing gate without an issue into a finding, and a crash into a chain blocker", () => {
    writeSummary(
      1,
      "vw",
      summary("design-system", "vw", {
        status: "failed",
        gates: [{ id: "npm.build", pass: false, hard: true, value: 1, threshold: 0 }],
      }),
    );
    writeSummary(
      1,
      "vw",
      summary("replica", "vw", {
        status: "crashed",
        issues: [{ code: "CRASHED", message: "boom at /x/y.js", severity: "error" }],
      }),
    );
    const f = collectCycle(paths, 1);
    expect(f.find((x) => x.signature === "design-system:npm.build")).toMatchObject({
      rank: 1,
      message: "npm.build: 1 (limit 0)",
    });
    expect(f.find((x) => x.code === "CRASHED")).toMatchObject({ stage: "replica", rank: 0 });
  });

  it("reads replay misses and process failures from a stage's folder", () => {
    writeSummary(1, "vw", summary("freeze", "vw", {}));
    const stageDir = paths.stageDir(1, "vw", "freeze");
    writeFileSync(
      join(stageDir, "replay-misses.jsonl"),
      [
        JSON.stringify({ url: "https://www.vw.de/a.css", kind: "stylesheet", method: "GET" }),
        JSON.stringify({ url: "https://www.vw.de/b.css", kind: "stylesheet", method: "GET" }),
        JSON.stringify({ url: "https://www.vw.de/link", kind: "probe", method: "HEAD" }),
      ].join("\n"),
    );
    writeFileSync(
      join(stageDir, "log.txt"),
      "[t] fine\n[t] FATAL ERROR: JavaScript heap out of memory\n[t] next exited with 0\n",
    );
    const findings = collectCycle(paths, 1);
    expect(findings.find((f) => f.signature === "freeze:REPLAY_404:stylesheet")).toMatchObject({ rank: 2 });
    expect(findings.find((f) => f.code === "REPLAY_404" && f.cause === "probe")).toBeUndefined();
    expect(findings.find((f) => f.code === "OUT_OF_MEMORY")).toMatchObject({ rank: 0 });
    expect(findings.find((f) => f.code === "PROCESS_EXIT")).toBeUndefined();
  });

  it("flags a stage far over its median", () => {
    for (let c = 1; c <= 3; c++) writeSummary(c, "bvg", summary("mirror", "bvg", { wallClockMs: 60_000 }));
    writeSummary(3, "ibm", summary("mirror", "ibm", { wallClockMs: 200_000 }));
    expect(collectCycle(paths, 3).find((f) => f.signature === "health:STAGE_SLOW:mirror")).toMatchObject({
      sites: ["ibm"],
      rank: 2,
    });
  });

  it("reports the differing files of a reproducibility run", () => {
    json(join(paths.siteDir(1, "bvg"), "reproducibility.json"), { differing: ["out/mirror/app/page.tsx"] });
    expect(
      collectCycle(paths, 1).find((f) => f.signature.startsWith("reproducibility:NONDETERMINISTIC")),
    ).toMatchObject({ rank: 1 });
  });

  it("detects process failures in a log", () => {
    expect(
      processIssues("Error: browserType.launch: Executable doesn't exist at /x\n", "/l").map((i) => i.code),
    ).toEqual(["BROWSER_LAUNCH_FAILED"]);
    expect(processIssues("next exited with 1\n", "/l").map((i) => i.code)).toEqual(["PROCESS_EXIT"]);
    expect(replayMissIssues(join(root, "absent"))).toEqual([]);
  });
});

describe("inspect", () => {
  const crash = (message: string): StageSummary["issues"][number] => ({
    code: "CRASHED",
    message,
    severity: "error",
  });

  it("labels new, recurring, regressed and fixed, and ranks chain blockers first", () => {
    json(join(paths.committed, "registry.json"), {
      entries: {
        "mirror:links.broken": {
          signature: "mirror:links.broken",
          firstCycle: 1,
          lastCycle: 1,
          sites: ["bvg"],
          count: 1,
          status: { fixed: 1 },
          attempts: [],
        },
      },
    });
    writeSummary(
      1,
      "bvg",
      summary("mirror", "bvg", { gates: [{ id: "visual.parity", pass: false, hard: true, value: 0.9 }] }),
    );
    inspectCycle(paths, 1);
    writeSummary(
      2,
      "bvg",
      summary("mirror", "bvg", {
        status: "failed",
        gates: [
          { id: "links.broken", pass: false, hard: true, value: 1 },
          { id: "seo.title", pass: false, hard: false },
        ],
        issues: [
          crash("x"),
          { code: "visual.parity", cause: "CSS_MISSING", message: "m", severity: "error" },
        ],
      }),
    );
    const r = inspectCycle(paths, 2);
    expect(r.counts).toMatchObject({ regressed: 1, fixed: 1 });
    const by = (s: string) => r.file.findings.find((f) => f.signature === s);
    expect(by("mirror:links.broken")!.status).toBe("regressed");
    expect(by("mirror:visual.parity:CSS_MISSING")!.status).toBe("new");
    expect(by("mirror:visual.parity")!.status).toBe("fixed");
    // chain blockers first
    expect(r.file.findings[0]!.code).toBe("CRASHED");
  });

  it("does not call something fixed when its stage did not run this cycle", () => {
    writeSummary(
      1,
      "bvg",
      summary("mirror", "bvg", { gates: [{ id: "visual.parity", pass: false, hard: true, value: 0.9 }] }),
    );
    inspectCycle(paths, 1);
    writeSummary(2, "bvg", summary("freeze", "bvg", {}));
    const r = inspectCycle(paths, 2);
    expect(r.counts.fixed).toBe(0);
  });

  it("marks a finding recurring on its next cycle without a registry, and exits clean when nothing is new", () => {
    const s = summary("mirror", "bvg", {
      gates: [{ id: "links.broken", pass: false, hard: true, value: 1 }],
    });
    writeSummary(1, "bvg", s);
    expect(inspectCycle(paths, 1).hasNew).toBe(true);
    writeSummary(2, "bvg", s);
    const r = inspectCycle(paths, 2);
    expect(r.file.findings[0]!.status).toBe("recurring");
    expect(r.hasNew).toBe(false);
  });

  it("writes findings.json and a FINDINGS.md in the plan's order with evidence paths", () => {
    const run = join(root, "run");
    recordedMirrorRun(run);
    const d = readMirrorRun(run);
    writeSummary(
      1,
      "bvg",
      summary("mirror", "bvg", {
        status: d.status,
        gates: d.gates,
        issues: d.issues,
        artifacts: { runDir: run },
      }),
    );
    inspectCycle(paths, 1);
    const md = readFileSync(join(paths.cycleDir(1), "FINDINGS.md"), "utf8");
    expect(md).toContain("## New");
    expect(md).toContain("`mirror:visual.parity:CSS_MISSING`");
    expect(md).toContain("verify/diagnosis/mobile/index.json");
  });
});
