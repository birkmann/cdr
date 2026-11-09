import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  autopilotPaths,
  blockingFindings,
  readState,
  resumeState,
  runLoop,
  writeState,
  type AutopilotPaths,
  type Finding,
  type FindingsFile,
  type LoopDeps,
  type LoopOptions,
  type LoopState,
  type MatrixResult,
  type RuleProblem,
  type SitesFile,
  type StageSummary,
} from "@harness/autopilot";

const sites: SitesFile = {
  sites: [
    { id: "bvg", url: "https://www.bvg.de/de", framework: "nextjs" },
    { id: "ibm", url: "https://www.ibm.com/us-en", framework: "nextjs" },
  ],
  holdout: [{ id: "acme", fixture: "acme", framework: "nextjs" }],
};
const siteIds = ["bvg", "ibm"];

const summary = (site: string, pass: boolean, over: Partial<StageSummary> = {}, cost = 1): StageSummary => ({
  stage: "mirror",
  site,
  status: pass ? "passed" : "failed",
  wallClockMs: 10,
  gates: [{ id: "visual.parity", pass, hard: true }],
  issues: [],
  usage: { calls: 1, cachedCalls: 0, costUsd: cost },
  artifacts: {},
  ...over,
});

function matrix(cycle: number, pass: boolean, ids = siteIds, cost = 1): MatrixResult {
  return {
    cycle,
    commit: "c",
    sites: Object.fromEntries(ids.map((id) => [id, { mirror: summary(id, pass, {}, cost) }])),
  };
}

const blocker: Finding = {
  signature: "mirror:visual.parity:X",
  stage: "mirror",
  code: "visual.parity",
  message: "m",
  sites: ["bvg"],
  rank: 1,
  status: "new",
  evidence: [],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): AutopilotPaths {
  const root = mkdtempSync(join(tmpdir(), "autopilot-loop-"));
  dirs.push(root);
  const paths = autopilotPaths(root);
  mkdirSync(paths.committed, { recursive: true });
  return paths;
}

interface Script {
  /** Greenness of each cycle's matrix, by cycle number; missing means green. */
  green?: Record<number, boolean>;
  findingsFor?: (cycle: number, greenRun: boolean) => Finding[];
  fixedGoals?: number;
  fixCostUsd?: number;
  runCostUsd?: number;
  problems?: RuleProblem[];
  throwAt?: string;
  onStep?: (step: string, cycle: number) => void;
  matrixFor?: (cycle: number, pass: boolean, input: { sites: { id: string }[] }) => MatrixResult;
}

function makeDeps(paths: AutopilotPaths, script: Script = {}) {
  const calls: string[] = [];
  const runInputs: {
    keepCache: boolean;
    sites: string[];
    coverageTarget: number;
    budgetUsd: number;
    stages?: string[];
  }[] = [];
  const log: string[] = [];
  const reports: number[] = [];
  const hit = (step: string, cycle: number) => {
    calls.push(`${step}:${cycle}`);
    script.onStep?.(step, cycle);
    if (script.throwAt === `${step}:${cycle}`) throw new Error(`boom at ${step}`);
  };
  const isGreen = (cycle: number) => script.green?.[cycle] ?? true;
  const deps: LoopDeps = {
    paths,
    sites,
    log: (line) => log.push(line),
    head: () => "head-commit",
    freeze: async ({ cycle }) => hit("freeze", cycle),
    run: async ({ cycle, keepCache, sites: toRun, coverageTarget, budgetUsd, stages }) => {
      hit("run", cycle);
      runInputs.push({
        keepCache,
        sites: toRun.map((s) => s.id),
        coverageTarget,
        budgetUsd,
        ...(stages ? { stages } : {}),
      });
      return (
        script.matrixFor?.(cycle, isGreen(cycle), { sites: toRun }) ??
        matrix(
          cycle,
          isGreen(cycle),
          toRun.map((s) => s.id),
          script.runCostUsd ?? 1,
        )
      );
    },
    inspect: async ({ cycle }): Promise<FindingsFile> => {
      hit("inspect", cycle);
      return {
        cycle,
        findings: script.findingsFor?.(cycle, isGreen(cycle)) ?? (isGreen(cycle) ? [] : [blocker]),
      };
    },
    fix: async ({ cycle }) => {
      hit("fix", cycle);
      const count = script.fixedGoals ?? 1;
      return {
        spentUsd: script.fixCostUsd ?? 2,
        records: Array.from({ length: count }, (_, i) => ({
          goalId: `goal-${cycle}-${i}`,
          signature: "s",
          cycle,
          branch: "b",
          finding: blocker,
        })),
      };
    },
    verify: async ({ cycle }) => {
      hit("verify", cycle);
      return { verdicts: [], pending: [], spentUsd: 0 };
    },
    rules: async () => {
      hit("rules", 0);
      return script.problems ?? [];
    },
    lints: async () => [],
    report: async (cycle) => void reports.push(cycle),
  };
  return { deps, calls, runInputs, log, reports };
}

const options = (over: Partial<LoopOptions> = {}): LoopOptions => ({
  maxCycles: 5,
  budgetUsd: 100,
  untilGreen: true,
  stable: 2,
  ...over,
});

describe("runLoop", () => {
  it("runs the steps in order and stops when green twice, the second with cached answers", async () => {
    const paths = repo();
    const { deps, calls, runInputs, reports } = makeDeps(paths);
    const result = await runLoop(options(), deps);
    expect(calls).toEqual(["freeze:1", "run:1", "inspect:1", "freeze:2", "run:2", "inspect:2"]);
    expect(runInputs.map((r) => r.keepCache)).toEqual([false, true]);
    expect(result.exitCode).toBe(0);
    expect(result.state).toMatchObject({ status: "green", step: "done", cycle: 2, greenStreak: 2 });
    expect(readState(paths)).toMatchObject({ status: "green", greenStreak: 2 });
    expect(reports.length).toBeGreaterThan(0);
  });

  it("fixes and verifies a failing cycle, then resets the streak until it is green twice", async () => {
    const paths = repo();
    const { deps, calls, runInputs } = makeDeps(paths, { green: { 2: false } });
    const result = await runLoop(options(), deps);
    expect(calls).toEqual([
      "freeze:1",
      "run:1",
      "inspect:1",
      "freeze:2",
      "run:2",
      "inspect:2",
      "fix:2",
      "verify:2",
      "rules:0",
      "freeze:3",
      "run:3",
      "inspect:3",
      "freeze:4",
      "run:4",
      "inspect:4",
    ]);
    // green, then red at cycle 2 (reset), then two greens
    expect(runInputs.map((r) => r.keepCache)).toEqual([false, true, false, true]);
    expect(result.state.greenStreak).toBe(2);
    expect(result.exitCode).toBe(0);
  });

  it("does not count a cycle as green while a blocking finding remains, even with every gate passing", async () => {
    const paths = repo();
    const { deps, calls } = makeDeps(paths, { findingsFor: (cycle) => (cycle === 1 ? [blocker] : []) });
    await runLoop(options(), deps);
    expect(calls.slice(0, 4)).toEqual(["freeze:1", "run:1", "inspect:1", "fix:1"]);
  });

  it("ignores advisory findings and findings only the holdout showed when judging green", async () => {
    const paths = repo();
    const advisory = { ...blocker, signature: "mirror:seo.title", rank: 3 as const };
    const holdout = { ...blocker, signature: "mirror:holdout-thing", sites: ["acme"] };
    const { deps, calls } = makeDeps(paths, { findingsFor: () => [advisory, holdout] });
    const result = await runLoop(options(), deps);
    expect(calls.filter((c) => c.startsWith("fix"))).toEqual([]);
    expect(result.state.status).toBe("green");
  });

  it("stops at max cycles with a non-zero exit and continues after, in the next cycle", async () => {
    const paths = repo();
    const { deps } = makeDeps(paths, { green: { 1: false } });
    const first = await runLoop(options({ maxCycles: 1 }), deps);
    expect(first.state).toMatchObject({ status: "max-cycles", cycle: 2, step: "freeze" });
    expect(first.exitCode).toBe(1);
    const second = makeDeps(paths);
    const result = await runLoop(options({ maxCycles: 1, untilGreen: false }), second.deps);
    expect(second.calls.slice(0, 1)).toEqual(["freeze:2"]);
    expect(result.state.status).toBe("max-cycles");
    expect(result.exitCode).toBe(0);
  });

  it("without --until-green keeps going for the requested cycles even while green", async () => {
    const paths = repo();
    const { deps, calls } = makeDeps(paths);
    const result = await runLoop(options({ untilGreen: false, maxCycles: 3 }), deps);
    expect(calls.filter((c) => c.startsWith("run"))).toHaveLength(3);
    expect(result.state.status).toBe("max-cycles");
  });

  it("stops when no finding can be fixed instead of re-running the matrix for nothing", async () => {
    const paths = repo();
    const { deps, calls } = makeDeps(paths, { green: { 1: false, 2: false }, fixedGoals: 0 });
    const result = await runLoop(options(), deps);
    expect(calls).toEqual(["freeze:1", "run:1", "inspect:1", "fix:1"]);
    expect(result.state.status).toBe("paused");
    expect(result.state.reason).toMatch(/NEEDS_HUMAN/);
    expect(result.exitCode).toBe(1);
  });
});

describe("budget", () => {
  it("is a hard stop before the next step", async () => {
    const paths = repo();
    const { deps, calls } = makeDeps(paths, {
      green: { 1: false, 2: false, 3: false },
      runCostUsd: 1,
      fixCostUsd: 4,
    });
    const result = await runLoop(options({ budgetUsd: 6 }), deps);
    expect(result.state.status).toBe("budget");
    expect(result.exitCode).toBe(1);
    expect(calls).toEqual(["freeze:1", "run:1", "inspect:1", "fix:1"]);
    expect(result.state.spentUsd).toBe(7);
  });

  it("stops before a matrix run it cannot pay for, from what the last one cost", async () => {
    const paths = repo();
    const { deps, calls } = makeDeps(paths, { green: { 1: false, 2: false }, runCostUsd: 5, fixCostUsd: 0 });
    const result = await runLoop(options({ budgetUsd: 20 }), deps);
    expect(result.state.status).toBe("budget");
    expect(result.state.reason).toMatch(/matrix run costs/);
    expect(calls.filter((c) => c.startsWith("run"))).toHaveLength(1);
  });

  it("passes what is left to the runner and to the fixer step", async () => {
    const paths = repo();
    let fixBudget = 0;
    const { deps, runInputs } = makeDeps(paths, { green: { 1: false }, runCostUsd: 5 });
    const originalFix = deps.fix;
    deps.fix = async (input) => {
      fixBudget = input.budgetUsd;
      return originalFix(input);
    };
    await runLoop(options({ budgetUsd: 30, maxCycles: 1 }), deps);
    expect(runInputs[0]!.budgetUsd).toBe(30);
    // the first run also pays for the holdout: 3 sites at $5
    expect(fixBudget).toBe(15);
  });

  it("caps a cycle's fixers at the default cycle budget even with more left", async () => {
    const paths = repo();
    let fixBudget = 0;
    const { deps } = makeDeps(paths, { green: { 1: false } });
    const originalFix = deps.fix;
    deps.fix = async (input) => {
      fixBudget = input.budgetUsd;
      return originalFix(input);
    };
    await runLoop(options({ budgetUsd: 500, maxCycles: 1 }), deps);
    expect(fixBudget).toBe(60);
  });

  it("keeps spending across a resume and frees it after a finished run", () => {
    const paused: LoopState = {
      cycle: 3,
      step: "fix",
      status: "paused",
      spentUsd: 12,
      greenStreak: 1,
      coverageTarget: 0.6,
      goals: ["g"],
      reason: "x",
    };
    expect(resumeState(paused, 0.5)).toEqual({ ...paused, status: "running", reason: undefined });
    expect(resumeState({ ...paused, status: "budget" }, 0.5)).toMatchObject({
      spentUsd: 12,
      status: "running",
      step: "fix",
    });
    expect(resumeState({ ...paused, status: "max-cycles", step: "freeze" }, 0.5)).toMatchObject({
      cycle: 3,
      spentUsd: 0,
      greenStreak: 1,
    });
    expect(resumeState({ ...paused, status: "green", step: "done" }, 0.5)).toMatchObject({
      cycle: 4,
      step: "freeze",
      spentUsd: 0,
      greenStreak: 0,
    });
    expect(resumeState(null, 0.5)).toMatchObject({
      cycle: 1,
      step: "freeze",
      status: "running",
      coverageTarget: 0.5,
    });
  });
});

describe("resume", () => {
  it("records every step, so a crash continues at the step that failed", async () => {
    const paths = repo();
    const first = makeDeps(paths, { green: { 1: false }, throwAt: "verify:1" });
    const stopped = await runLoop(options(), first.deps);
    expect(stopped.state).toMatchObject({ status: "paused", step: "verify", goals: ["goal-1-0"] });
    expect(stopped.state.reason).toContain("verify failed: boom");
    expect(stopped.exitCode).toBe(1);

    const second = makeDeps(paths, { green: { 1: false } });
    await runLoop(options({ maxCycles: 1 }), second.deps);
    expect(second.calls[0]).toBe("verify:1");
    expect(second.calls).not.toContain("freeze:1");
    expect(second.calls).not.toContain("fix:1");
    expect(second.calls).toContain("rules:0");
  });

  it("re-runs an interrupted run step rather than trusting a half-written matrix", async () => {
    const paths = repo();
    writeState(paths, {
      cycle: 1,
      step: "inspect",
      status: "running",
      spentUsd: 0,
      greenStreak: 0,
      coverageTarget: 0.5,
      goals: [],
    });
    const { deps, calls } = makeDeps(paths);
    await runLoop(options(), deps);
    expect(calls.slice(0, 2)).toEqual(["run:1", "inspect:1"]);
  });

  it("pauses between steps on Ctrl+C and leaves a resumable state", async () => {
    const paths = repo();
    const pause = new AbortController();
    const first = makeDeps(paths, { green: { 1: false }, onStep: (step) => step === "run" && pause.abort() });
    const paused = await runLoop(options({ pauseSignal: pause.signal }), first.deps);
    expect(paused.state).toMatchObject({ status: "paused", step: "inspect", cycle: 1 });
    expect(paused.state.reason).toMatch(/run loop again/);
    expect(first.calls).toEqual(["freeze:1", "run:1"]);
    expect(first.reports).toContain(1);

    const second = makeDeps(paths, { green: { 1: false } });
    await runLoop(options(), second.deps);
    expect(second.calls[0]).toBe("inspect:1");
  });

  it("marks a step cancelled with a second Ctrl+C as paused, and it runs again on resume", async () => {
    const paths = repo();
    const cancel = new AbortController();
    const first = makeDeps(paths, {
      onStep: (step) => {
        if (step === "run") {
          cancel.abort();
          throw new Error("aborted");
        }
      },
    });
    const paused = await runLoop(options({ cancelSignal: cancel.signal }), first.deps);
    expect(paused.state).toMatchObject({ status: "paused", step: "run" });
    expect(paused.state.reason).toMatch(/runs again on resume/);

    const second = makeDeps(paths);
    await runLoop(options(), second.deps);
    expect(second.calls[0]).toBe("run:1");
  });

  it("pauses with the reason when a merged rule lost its guard", async () => {
    const paths = repo();
    const problems: RuleProblem[] = [{ signature: "s", code: "TEST_NOT_FOUND", detail: "gone" }];
    const { deps } = makeDeps(paths, { green: { 1: false }, problems });
    const result = await runLoop(options(), deps);
    expect(result.state.status).toBe("paused");
    expect(result.state.reason).toMatch(/lost its guard.*TEST_NOT_FOUND/);
  });
});

describe("reproducibility and the baseline", () => {
  function appMatrix(paths: AutopilotPaths, cycle: number, content: string, pass = true): MatrixResult {
    const dir = join(paths.root, "apps", String(cycle));
    const file = join(dir, "src/page.ts");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return {
      cycle,
      commit: "c",
      sites: Object.fromEntries(
        siteIds.map((id) => [id, { mirror: summary(id, pass, { artifacts: { mirrorApp: dir } }) }]),
      ),
    };
  }

  it("passes when only timestamps differ, and fails with NONDETERMINISTIC evidence otherwise", async () => {
    const same = repo();
    const a = makeDeps(same, {
      matrixFor: (cycle) =>
        appMatrix(
          same,
          cycle,
          `// built ${cycle === 1 ? "2026-11-09T10:00:00Z" : "2026-11-09T11:30:00Z"}\nexport {};`,
        ),
    });
    const ok = await runLoop(options(), a.deps);
    expect(ok.state).toMatchObject({ status: "green", greenStreak: 2 });

    const differs = repo();
    const b = makeDeps(differs, {
      matrixFor: (cycle) => appMatrix(differs, cycle, `export const n = ${cycle};`),
      findingsFor: (cycle) =>
        cycle === 2
          ? [
              {
                ...blocker,
                signature: "reproducibility:NONDETERMINISTIC",
                stage: "reproducibility",
                code: "NONDETERMINISTIC",
                sites: siteIds,
              },
            ]
          : [],
      fixedGoals: 0,
    });
    const result = await runLoop(options(), b.deps);
    expect(result.state.status).toBe("paused");
    expect(result.state.greenStreak).toBe(0);
    const written = JSON.parse(
      readFileSync(join(differs.siteDir(2, "bvg"), "reproducibility.json"), "utf8"),
    ) as { differing: string[] };
    expect(written.differing).toEqual(["mirror/mirrorApp/src/page.ts"]);
    expect(b.log.some((line) => line.includes("not reproducible"))).toBe(true);
  });

  it("the second run of a streak compares gates too", async () => {
    const paths = repo();
    const { deps, log } = makeDeps(paths, {
      matrixFor: (cycle) => {
        const m = matrix(cycle, true);
        if (cycle === 2) m.sites.bvg!.mirror!.gates.push({ id: "only.now", pass: true, hard: false });
        return m;
      },
      fixedGoals: 0,
    });
    await runLoop(options(), deps);
    expect(log.some((line) => line.includes("not reproducible"))).toBe(true);
  });

  it("does not check reproducibility on a first green cycle", async () => {
    const paths = repo();
    const { deps } = makeDeps(paths);
    await runLoop(options({ stable: 1 }), deps);
    expect(existsSync(join(paths.siteDir(1, "bvg"), "reproducibility.json"))).toBe(false);
  });

  it("includes the holdout in the first run, for the baseline, and never again", async () => {
    const paths = repo();
    const { deps, runInputs } = makeDeps(paths);
    await runLoop(options(), deps);
    expect(runInputs[0]!.sites).toEqual(["bvg", "ibm", "acme"]);
    expect(runInputs[1]!.sites).toEqual(["bvg", "ibm"]);
    const baseline = JSON.parse(readFileSync(join(paths.committed, "baseline.json"), "utf8")) as MatrixResult;
    expect(Object.keys(baseline.sites)).toEqual(["bvg", "ibm", "acme"]);
    expect(baseline.commit).toBe("head-commit");
  });

  it("does not let a bad holdout result keep the matrix from green", async () => {
    const paths = repo();
    const { deps } = makeDeps(paths, {
      matrixFor: (cycle, _pass, input) => {
        const m = matrix(
          cycle,
          true,
          input.sites.map((s) => s.id),
        );
        if (m.sites.acme) m.sites.acme.mirror = summary("acme", false);
        return m;
      },
    });
    const result = await runLoop(options(), deps);
    expect(result.state.status).toBe("green");
  });

  it("raises the coverage target after a cycle every site passed it and passes it to the next run", async () => {
    const paths = repo();
    const { deps, runInputs } = makeDeps(paths, {
      matrixFor: (cycle) => {
        const m = matrix(cycle, true);
        for (const id of siteIds)
          m.sites[id]!.mirror!.gates.push({ id: "ds.coverage", pass: true, hard: true, value: 0.7 });
        return m;
      },
    });
    const result = await runLoop(options(), deps);
    expect(runInputs.map((r) => r.coverageTarget)).toEqual([0.5, 0.6]);
    expect(result.state.coverageTarget).toBe(0.7);
  });

  it("does not raise it when a site is short of the target", async () => {
    const paths = repo();
    const { deps, runInputs } = makeDeps(paths, {
      matrixFor: (cycle) => {
        const m = matrix(cycle, true);
        for (const id of siteIds)
          m.sites[id]!.mirror!.gates.push({ id: "ds.coverage", pass: id === "bvg", hard: false, value: 0.5 });
        return m;
      },
    });
    await runLoop(options({ untilGreen: false, maxCycles: 2 }), deps);
    expect(runInputs.map((r) => r.coverageTarget)).toEqual([0.5, 0.5]);
  });

  it("merges findings into the registry and skips a fixed one", async () => {
    const paths = repo();
    const fixed: Finding = { ...blocker, signature: "mirror:old", status: "fixed" };
    const { deps } = makeDeps(paths, { green: { 1: false }, findingsFor: () => [blocker, fixed] });
    await runLoop(options({ maxCycles: 1 }), deps);
    const registry = JSON.parse(readFileSync(join(paths.committed, "registry.json"), "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(registry.entries)).toEqual([blocker.signature]);
  });

  it("adds lint findings to the cycle", async () => {
    const paths = repo();
    const { deps, calls } = makeDeps(paths);
    deps.lints = async (m) =>
      m.cycle === 1
        ? [{ lint: "x", app: { site: "bvg", stage: "mirror", dir: "/a" }, issues: [{ message: "bad" }] }]
        : [];
    const result = await runLoop(options({ maxCycles: 1 }), deps);
    expect(calls).toContain("fix:1");
    expect(result.state.greenStreak).toBe(0);
    const written = JSON.parse(
      readFileSync(join(paths.cycleDir(1), "findings.json"), "utf8"),
    ) as FindingsFile;
    expect(written.findings.map((f) => f.signature)).toEqual(["mirror:LINT:x"]);
  });
});

describe("blockingFindings", () => {
  it("keeps hard findings of matrix sites only", () => {
    const file: FindingsFile = {
      cycle: 1,
      findings: [
        blocker,
        { ...blocker, signature: "advisory", rank: 3 },
        { ...blocker, signature: "fixed", status: "fixed" },
        { ...blocker, signature: "holdout", sites: ["acme"] },
      ],
    };
    expect(blockingFindings(file, siteIds).map((f) => f.signature)).toEqual([blocker.signature]);
  });
});
