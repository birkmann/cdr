import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GoalInfo } from "@harness/protocol";
import {
  autopilotPaths,
  readBaseline,
  readGoalRecord,
  readRegistry,
  ruleFileFor,
  verifyGoals,
  writeBaseline,
  writeGoalRecord,
  writeJson,
  type AutopilotPaths,
  type CommandPort,
  type Finding,
  type FindingsFile,
  type GitPort,
  type GoalPort,
  type GoalRecord,
  type LaneInput,
  type LanePort,
  type LaneResult,
  type MatrixResult,
  type RuleEntry,
  type SitesFile,
  type VerifyDeps,
} from "@harness/autopilot";

const sites: SitesFile = {
  sites: [
    { id: "bvg", url: "https://www.bvg.de/de", framework: "nextjs" },
    { id: "ibm", url: "https://www.ibm.com/us-en", framework: "nextjs" },
  ],
  holdout: [{ id: "acme", fixture: "acme", framework: "nextjs" }],
};

const SIG = "mirror:visual.parity:CSS_MISSING";
const finding: Finding = {
  signature: SIG,
  stage: "mirror",
  code: "visual.parity",
  message: "m",
  sites: ["bvg"],
  rank: 1,
  status: "new",
  evidence: [],
};

const matrixOf = (gates: Record<string, boolean>, cycle = 1): MatrixResult => {
  const sites: MatrixResult["sites"] = {};
  for (const [key, pass] of Object.entries(gates)) {
    const [site, id] = key.split("/") as [string, string];
    const summary = (sites[site] ??= {
      mirror: {
        stage: "mirror",
        site,
        status: "passed",
        wallClockMs: 1,
        gates: [],
        issues: [],
        artifacts: {},
      },
    }).mirror!;
    summary.gates.push({ id, pass, hard: true });
  }
  return { cycle, commit: "c", sites };
};

const baseline = matrixOf({ "bvg/visual.parity": false, "ibm/visual.parity": true, "acme/links": true });
const good = matrixOf({ "bvg/visual.parity": true, "ibm/visual.parity": true, "acme/links": true });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DIFF = [
  "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
  "--- a/packages/x/src/a.ts",
  "+++ b/packages/x/src/a.ts",
  "@@ -1,1 +1,1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const BAD_DIFF = DIFF.replace("packages/x/src/a.ts", "autopilot/baseline.json").replace(
  /packages\/x\/src\/a\.ts/g,
  "autopilot/baseline.json",
);

interface World {
  paths: AutopilotPaths;
  deps: VerifyDeps;
  goals: Map<string, GoalInfo>;
  merged: string[];
  discarded: string[];
  fast: LaneInput[];
  slow: LaneInput[];
  logs: string[];
  commits: string[][];
  sync: string[];
}

interface Script {
  diff?: string;
  lane?: Partial<Record<"fast" | "slow", Partial<LaneResult>>>;
  commands?: Partial<Record<keyof CommandPort, boolean | ((cwd: string) => boolean)>>;
  ancestorOfBase?: boolean;
  syncConflict?: string[];
  mergeError?: string;
  rule?: boolean;
  costUsd?: number;
}

function world(script: Script = {}, goalIds = ["goal-a"]): World {
  const root = mkdtempSync(join(tmpdir(), "autopilot-verify-"));
  dirs.push(root);
  const paths = autopilotPaths(root);
  mkdirSync(paths.committed, { recursive: true });
  writeBaseline(paths, baseline);
  writeJson(join(paths.cycleDir(1), "findings.json"), { cycle: 1, findings: [finding] });

  const goals = new Map<string, GoalInfo>();
  const merged: string[] = [];
  const discarded: string[] = [];
  const fast: LaneInput[] = [];
  const slow: LaneInput[] = [];
  const logs: string[] = [];
  const commits: string[][] = [];
  const sync: string[] = [];

  for (const id of goalIds) {
    const worktree = join(root, "wt", id);
    mkdirSync(worktree, { recursive: true });
    if (script.rule !== false) writeRuleFiles(worktree);
    goals.set(id, {
      id,
      title: `autopilot ${SIG}`,
      description: "",
      acceptance: [],
      repo: root,
      baseBranch: "main",
      branch: `cdr/${id}`,
      worktree,
      budget: {},
      policy: {},
      deliverable: "branch",
      status: "review",
      checkpoints: 1,
      createdAt: "",
      updatedAt: "",
      usage: { inputTokens: 0, outputTokens: 0, cost: 1 },
    });
    writeGoalRecord(paths, { goalId: id, signature: SIG, cycle: 1, branch: `cdr/${id}`, finding });
  }

  const goalPort: GoalPort = {
    create: () => {
      throw new Error("unused");
    },
    save: (g) => g,
    get: (id) => goals.get(id) ?? null,
    prepare: (g) => g,
    run: () => {
      throw new Error("unused");
    },
    merge: (id) => {
      if (script.mergeError) throw new Error(script.mergeError);
      merged.push(id);
      return goals.get(id)!;
    },
    discard: (id) => {
      discarded.push(id);
      return goals.get(id)!;
    },
  };

  const git: GitPort = {
    currentBranch: () => "main",
    branchExists: () => false,
    head: () => "abc123",
    diff: () => script.diff ?? DIFF,
    isAncestor: () => script.ancestorOfBase ?? true,
    syncWithBase: (worktree) => {
      sync.push(worktree);
      return script.syncConflict ? { ok: false, conflicts: script.syncConflict } : { ok: true };
    },
    withCheckout: async (_ref, work) => {
      const dir = mkdtempSync(join(tmpdir(), "autopilot-verify-base-"));
      dirs.push(dir);
      return work(dir);
    },
    commitPaths: (p) => (commits.push(p), "commit-1"),
  };

  // Default: the test fails on base (a checkout dir other than the worktree) and passes on the branch.
  const outcome = (cwd: string, step: keyof CommandPort, dflt: boolean): boolean => {
    const value = script.commands?.[step];
    if (typeof value === "function") return value(cwd);
    return value ?? dflt;
  };
  const worktrees = () => [...goals.values()].map((g) => g.worktree);
  const commands: CommandPort = {
    install: async (cwd) => ({ ok: outcome(cwd, "install", true), output: "install output" }),
    build: async (cwd) => ({ ok: outcome(cwd, "build", true), output: "build output" }),
    test: async (cwd) => ({ ok: outcome(cwd, "test", true), output: "test output" }),
    lint: async (cwd) => ({ ok: outcome(cwd, "lint", true), output: "lint output" }),
    testOne: async (cwd) => ({ ok: outcome(cwd, "testOne", worktrees().includes(cwd)), output: "one test" }),
  };

  const lane =
    (kind: "fast" | "slow", seen: LaneInput[]) =>
    async (input: LaneInput): Promise<LaneResult> => {
      seen.push(input);
      const matrix =
        kind === "fast"
          ? {
              ...good,
              sites: Object.fromEntries(
                Object.entries(good.sites).filter(([s]) => input.sites.some((i) => i.id === s)),
              ),
            }
          : good;
      return {
        matrix,
        findings: { cycle: 1, findings: [] },
        costUsd: script.costUsd ?? 1,
        ...script.lane?.[kind],
      };
    };
  const lanes: LanePort = { fast: lane("fast", fast), slow: lane("slow", slow) };

  return {
    paths,
    deps: { paths, sites, goals: goalPort, git, commands, lanes, log: (l) => logs.push(l) },
    goals,
    merged,
    discarded,
    fast,
    slow,
    logs,
    commits,
    sync,
  };
}

function writeRuleFiles(worktree: string): void {
  const test = "packages/x/test/a.test.ts";
  const ruleFile = ruleFileFor(SIG);
  const rule: RuleEntry = {
    signature: SIG,
    file: ruleFile,
    seen: [],
    symptom: "s",
    rootCause: "because",
    invariant: "i",
    guards: [{ kind: "test", file: test, name: "the regression" }],
  };
  for (const [path, content] of [
    [test, `it("the regression", () => {});\n`],
    [ruleFile, `# ${SIG}\nSeen: x\n## Symptom\ns\n`],
    ["autopilot/rules.json", JSON.stringify({ rules: [rule] })],
  ] as const) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), content);
  }
}

const finds = (...f: Finding[]): FindingsFile => ({ cycle: 1, findings: f });
const verify = (w: World, extra: Partial<Parameters<typeof verifyGoals>[0]> = {}) =>
  verifyGoals({ cycle: 1, ...extra }, w.deps);

describe("verifyGoals: accept", () => {
  it("merges, updates the baseline, records the attempt and commits the bookkeeping", async () => {
    const w = world();
    const result = await verify(w);
    expect(result.verdicts).toEqual([
      expect.objectContaining({
        goalId: "goal-a",
        signature: SIG,
        verdict: "accepted",
        decidedAt: "accepted",
      }),
    ]);
    expect(w.merged).toEqual(["goal-a"]);
    expect(w.discarded).toEqual([]);
    const after = readBaseline(w.paths);
    expect(after.commit).toBe("abc123");
    expect(after.sites.bvg!.mirror!.gates[0]).toMatchObject({ id: "visual.parity", pass: true });
    const entry = readRegistry(w.paths).entries[SIG]!;
    expect(entry.status).toEqual({ fixed: 1 });
    expect(entry.rule).toBe(ruleFileFor(SIG));
    expect(entry.attempts).toEqual([expect.objectContaining({ goalId: "goal-a", verdict: "accepted" })]);
    expect(readGoalRecord(w.paths, "goal-a")).toMatchObject({ verdict: "accepted", decidedAt: "accepted" });
    expect(w.commits[0]).toEqual(
      expect.arrayContaining(["autopilot/registry.json", "autopilot/baseline.json"]),
    );
  });

  it("runs the fast lane on the originating site and a fixture, the slow lane on the matrix and holdout", async () => {
    const w = world();
    await verify(w);
    expect(w.fast[0]!.sites.map((s) => s.id)).toEqual(["bvg", "acme"]);
    expect(w.fast[0]!.stages).toEqual(["mirror"]);
    expect(w.slow[0]!.sites.map((s) => s.id)).toEqual(["bvg", "ibm", "acme"]);
    expect(w.slow[0]!.stages).toBeUndefined();
  });

  it("stamps the rule the fixer left with the cycle and goal", async () => {
    const w = world();
    const ruleFile = ruleFileFor(SIG);
    mkdirSync(dirname(join(w.paths.root, ruleFile)), { recursive: true });
    writeFileSync(join(w.paths.root, ruleFile), `# ${SIG}\nSeen: x\n## Symptom\ns\n`);
    await verify(w);
    const rules = JSON.parse(readFileSync(join(w.paths.root, "autopilot/rules.json"), "utf8")) as {
      rules: RuleEntry[];
    };
    expect(rules.rules[0]).toMatchObject({ fixedCycle: 1, goalId: "goal-a", seen: ["bvg (cycle 1)"] });
    expect(readFileSync(join(w.paths.root, ruleFile), "utf8").split("\n")[1]).toBe(
      "Seen: bvg (cycle 1) · Fixed: cycle 1 · Goal: goal-a",
    );
  });
});

describe("verifyGoals: reject", () => {
  const rejected = async (w: World, decidedAt: string, reason: RegExp) => {
    const result = await verify(w);
    expect(result.verdicts[0]).toMatchObject({ verdict: "discarded", decidedAt });
    expect(result.verdicts[0]!.reason).toMatch(reason);
    expect(w.merged).toEqual([]);
    expect(w.discarded).toEqual(["goal-a"]);
    expect(readRegistry(w.paths).entries[SIG]!.attempts[0]).toMatchObject({ verdict: "discarded" });
    expect(readBaseline(w.paths).sites).toEqual(baseline.sites);
    return result;
  };

  it("runs the policy check first and discards a protected edit without building", async () => {
    let built = false;
    const w = world({
      diff: BAD_DIFF,
      commands: { build: () => ((built = true), true) },
    });
    await rejected(w, "policy", /PROTECTED_PATH/);
    expect(built).toBe(false);
    expect(w.fast).toEqual([]);
  });

  it("discards a goal that changed nothing", async () => {
    await rejected(world({ diff: "" }), "policy", /changed nothing/);
  });

  it("discards when the rule is missing", async () => {
    await rejected(world({ rule: false }), "guard", /no entry for/);
  });

  it("discards when the regression test passes on base", async () => {
    await rejected(world({ commands: { testOne: () => true } }), "guard", /also passes on main/);
  });

  it("discards when the regression test fails on the branch", async () => {
    await rejected(world({ commands: { testOne: () => false } }), "guard", /fails on the branch/);
  });

  it.each(["build", "test", "lint"] as const)("discards when pnpm %s fails", async (step) => {
    await rejected(world({ commands: { [step]: false } }), "build", new RegExp(`pnpm ${step} failed`));
  });

  it("discards on a fast-lane regression and skips the slow lane", async () => {
    const w = world({
      lane: { fast: { matrix: matrixOf({ "bvg/visual.parity": true, "acme/links": false }) } },
    });
    await rejected(w, "fast", /fast lane: gate acme\/mirror\/links regressed/);
    expect(w.slow).toEqual([]);
  });

  it("discards when the signature is still on the origin site in the fast lane", async () => {
    await rejected(world({ lane: { fast: { findings: finds(finding) } } }), "fast", /still present on bvg/);
  });

  it("discards a slow-lane regression on the holdout and keeps its name out of the registry", async () => {
    const w = world({
      lane: {
        slow: {
          matrix: matrixOf({ "bvg/visual.parity": true, "ibm/visual.parity": true, "acme/links": false }),
        },
      },
    });
    await rejected(w, "slow", /acme\/mirror\/links/);
    const attempt = readRegistry(w.paths).entries[SIG]!.attempts[0]!;
    expect(attempt.reason).not.toContain("acme");
    expect(attempt.reason).toContain("holdout");
    expect(readGoalRecord(w.paths, "goal-a")!.reason).toContain("acme");
  });

  it("discards a candidate that adds a new PIPELINE_BUG", async () => {
    const bug = { ...finding, signature: "mirror:PIPELINE_BUG:X", code: "PIPELINE_BUG" };
    await rejected(world({ lane: { slow: { findings: finds(bug) } } }), "slow", /PIPELINE_BUG/);
  });

  it("records a merge conflict with the base as a discard", async () => {
    await rejected(
      world({ ancestorOfBase: false, syncConflict: ["packages/x/src/a.ts"] }),
      "merge",
      /conflict with an earlier merge: packages\/x\/src\/a\.ts/,
    );
  });

  it("records a merge that fails at the end as a discard", async () => {
    const w = world({ mergeError: "dirty" });
    const result = await verify(w);
    expect(result.verdicts[0]).toMatchObject({ verdict: "discarded", decidedAt: "merge" });
    expect(w.discarded).toEqual(["goal-a"]);
  });
});

describe("verifyGoals: several candidates", () => {
  it("verifies one at a time, each on top of the previous merge", async () => {
    const w = world({ ancestorOfBase: false }, ["goal-a", "goal-b"]);
    await verify(w);
    expect(w.merged).toEqual(["goal-a", "goal-b"]);
    expect(w.sync).toHaveLength(2);
  });

  it("leaves goals without a verdict for the next run and does not touch finished ones", async () => {
    const w = world({}, ["goal-a", "goal-b"]);
    w.goals.set("goal-b", { ...w.goals.get("goal-b")!, status: "running" });
    const result = await verify(w);
    expect(result.pending).toEqual(["goal-b"]);
    w.goals.set("goal-b", { ...w.goals.get("goal-b")!, status: "done" });
    const again = await verify(w);
    expect(again.verdicts).toEqual([]);
    expect(w.merged).toEqual(["goal-a"]);
  });

  it("stops at the budget and leaves the rest pending", async () => {
    const w = world({ costUsd: 2, ancestorOfBase: true }, ["goal-a", "goal-b"]);
    const result = await verify(w, { budgetUsd: 3 });
    expect(result.verdicts.map((v) => v.goalId)).toEqual(["goal-a"]);
    expect(result.pending).toEqual(["goal-b"]);
    expect(result.spentUsd).toBe(4);
  });

  it("verifies only the goal asked for", async () => {
    const w = world({}, ["goal-a", "goal-b"]);
    const result = await verify(w, { goalId: "goal-b" });
    expect(result.verdicts.map((v) => v.goalId)).toEqual(["goal-b"]);
  });
});

describe("verifyGoals: fast only, for the fixer", () => {
  it("reports the fast lane and changes nothing", async () => {
    const w = world();
    const result = await verify(w, { fastOnly: true, goalId: "goal-a" });
    expect(result.fast).toEqual(expect.objectContaining({ ok: true }));
    expect(w.merged).toEqual([]);
    expect(w.discarded).toEqual([]);
    expect(readRegistry(w.paths).entries[SIG]).toBeUndefined();
    expect(readGoalRecord(w.paths, "goal-a")!.verdict).toBeUndefined();
  });

  it("reports a policy failure without running the lane", async () => {
    const w = world({ diff: BAD_DIFF });
    const result = await verify(w, { fastOnly: true, goalId: "goal-a" });
    expect(result.fast!.ok).toBe(false);
    expect(result.fast!.reason).toContain("PROTECTED_PATH");
    expect(w.fast).toEqual([]);
  });

  it("does not leak a holdout name through the verdict", async () => {
    const w = world({
      lane: { fast: { matrix: matrixOf({ "bvg/visual.parity": true, "acme/links": false }) } },
    });
    const result = await verify(w, { fastOnly: true, goalId: "goal-a" });
    expect(result.fast!.reason).not.toContain("acme");
  });

  it("throws for an unknown goal", async () => {
    await expect(verify(world(), { goalId: "goal-nope" })).rejects.toThrow(/no autopilot goal/);
  });
});

// Keep the fixture's helpers honest: a GoalRecord written by this test is a real GoalRecord.
describe("the test world", () => {
  it("writes real goal records", () => {
    const w = world();
    const record: GoalRecord | null = readGoalRecord(w.paths, "goal-a");
    expect(record?.signature).toBe(SIG);
  });
});
