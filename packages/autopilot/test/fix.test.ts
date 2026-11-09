import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateGoalRequest, GoalInfo } from "@harness/protocol";
import {
  acceptanceCriteria,
  autopilotPaths,
  fixerBranch,
  listGoalRecords,
  mergeFindings,
  readRegistry,
  recordAttempt,
  runFix,
  scrubHoldout,
  selectGroups,
  withoutHoldout,
  writeJson,
  writeRegistry,
  writeRules,
  type AutopilotPaths,
  type Finding,
  type FindingsFile,
  type FixDeps,
  type GoalPort,
  type Registry,
  type RuleEntry,
  type SitesFile,
} from "@harness/autopilot";

const sites: SitesFile = {
  sites: [
    { id: "bvg", url: "https://www.bvg.de/de", framework: "nextjs" },
    { id: "ibm", url: "https://www.ibm.com/us-en", framework: "nextjs" },
  ],
  holdout: [
    { id: "acme", fixture: "acme", framework: "nextjs" },
    { id: "deutschebahn", url: "https://www.deutschebahn.com/de", framework: "nextjs" },
  ],
};

const finding = (signature: string, over: Partial<Finding> = {}): Finding => ({
  signature,
  stage: "mirror",
  code: "visual.parity",
  message: "visual.parity 0.91 on mobile",
  sites: ["bvg"],
  rank: 1,
  status: "new",
  evidence: [],
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(findings: Finding[], registry?: Registry): AutopilotPaths {
  const root = mkdtempSync(join(tmpdir(), "autopilot-fix-"));
  dirs.push(root);
  const paths = autopilotPaths(root);
  mkdirSync(paths.committed, { recursive: true });
  writeJson(join(paths.cycleDir(1), "findings.json"), { cycle: 1, findings });
  if (registry) writeRegistry(paths, registry);
  return paths;
}

interface Fake {
  goals: GoalPort;
  created: CreateGoalRequest[];
  saved: Map<string, GoalInfo>;
  ran: string[];
}

function fakeGoals(root: string, over: { status?: GoalInfo["status"]; cost?: number } = {}): Fake {
  const saved = new Map<string, GoalInfo>();
  const created: CreateGoalRequest[] = [];
  const ran: string[] = [];
  let n = 0;
  const goals: GoalPort = {
    create: (req) => {
      created.push(req);
      const goal: GoalInfo = {
        id: `goal-${++n}`,
        title: req.title!,
        description: req.description ?? "",
        acceptance: req.acceptance ?? [],
        repo: root,
        baseBranch: req.baseBranch ?? "main",
        budget: req.budget ?? {},
        policy: req.policy ?? {},
        deliverable: "branch",
        status: "draft",
        checkpoints: 0,
        createdAt: "",
        updatedAt: "",
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      };
      saved.set(goal.id, goal);
      return goal;
    },
    save: (goal) => (saved.set(goal.id, goal), goal),
    get: (id) => saved.get(id) ?? null,
    prepare: (goal) => {
      const worktree = join(root, ".harness/worktrees", goal.id);
      mkdirSync(worktree, { recursive: true });
      return { ...goal, worktree };
    },
    run: async (id) => {
      ran.push(id);
      const goal = {
        ...saved.get(id)!,
        status: over.status ?? "review",
        usage: { inputTokens: 1, outputTokens: 1, cost: over.cost ?? 2 },
      } as GoalInfo;
      saved.set(id, goal);
      return goal;
    },
    merge: () => {
      throw new Error("not used");
    },
    discard: () => {
      throw new Error("not used");
    },
  };
  return { goals, created, saved, ran };
}

const deps = (paths: AutopilotPaths, goals: GoalPort, log: string[] = []): FixDeps => ({
  paths,
  sites,
  goals,
  branchExists: () => false,
  baseBranch: () => "main",
  log: (line) => log.push(line),
});

const SIG = "mirror:visual.parity:CSS_MISSING";
const findingsOf = (...f: Finding[]): FindingsFile => ({ cycle: 1, findings: f });

describe("selectGroups", () => {
  it("orders by rank, then sites, and caps at max", () => {
    const file = findingsOf(
      finding("a", { rank: 2 }),
      finding("b", { rank: 0 }),
      finding("c", { rank: 1, sites: ["bvg", "ibm"] }),
      finding("d", { rank: 1 }),
    );
    expect(selectGroups(file, { entries: {} }, sites, 3).map((f) => f.signature)).toEqual(["b", "c", "d"]);
  });

  it("skips fixed findings and signatures a person owns", () => {
    let registry = mergeFindings({ entries: {} }, findingsOf(finding("x"), finding("y")));
    recordAttempt(registry, "x", { goalId: "g", cycle: 1, verdict: "discarded", reason: "a" });
    recordAttempt(registry, "x", { goalId: "g2", cycle: 2, verdict: "discarded", reason: "b" });
    recordAttempt(registry, "x", { goalId: "g3", cycle: 3, verdict: "discarded", reason: "c" });
    registry = {
      entries: { ...registry.entries, y: { ...registry.entries.y!, status: "accepted-advisory" } },
    };
    const file = findingsOf(finding("x"), finding("y"), finding("z", { status: "fixed" }), finding("w"));
    expect(selectGroups(file, registry, sites, 5).map((f) => f.signature)).toEqual(["w"]);
  });

  it("never hands a holdout-only finding to a fixer, and strips the holdout from a shared one", () => {
    const file = findingsOf(
      finding("only-holdout", { sites: ["acme", "deutschebahn"] }),
      finding("shared", {
        sites: ["bvg", "acme"],
        message: "failed on www.deutschebahn.com and acme",
        evidence: ["/x/cycles/1/bvg/mirror/a.txt", "/x/cycles/1/acme/mirror/b.txt"],
      }),
    );
    const [shared, ...rest] = selectGroups(file, { entries: {} }, sites, 5);
    expect(rest).toEqual([]);
    expect(shared).toMatchObject({
      signature: "shared",
      sites: ["bvg"],
      evidence: ["/x/cycles/1/bvg/mirror/a.txt"],
    });
    expect(shared!.message).not.toMatch(/acme|deutschebahn/);
  });
});

describe("withoutHoldout and scrubHoldout", () => {
  it("removes ids and hostnames but not longer words containing them", () => {
    expect(scrubHoldout("acme failed, see deutschebahn.com, not acmecorp", sites)).toBe(
      "holdout failed, see holdout, not acmecorp",
    );
  });

  it("returns null when nothing is left", () => {
    expect(withoutHoldout(finding("x", { sites: ["acme"] }), sites)).toBeNull();
  });
});

describe("fixerBranch", () => {
  it("names the branch after the signature and numbers it when taken", () => {
    expect(fixerBranch(SIG, () => false)).toBe("cdr/goal-autopilot-mirror-visual.parity-CSS_MISSING");
    const taken = new Set(["cdr/goal-autopilot-mirror-visual.parity-CSS_MISSING"]);
    expect(fixerBranch(SIG, (b) => taken.has(b))).toBe(
      "cdr/goal-autopilot-mirror-visual.parity-CSS_MISSING-2",
    );
  });
});

describe("acceptanceCriteria", () => {
  it("states every criterion of the plan and names the rule file", () => {
    const criteria = acceptanceCriteria({ signature: SIG }).join("\n");
    for (const needle of [
      "fails on the base branch",
      "pnpm build",
      "no hostname, site id",
      "No gate threshold",
      "autopilot/rules/mirror-visual.parity-CSS_MISSING.md",
      "root cause",
    ])
      expect(criteria).toContain(needle);
  });
});

describe("runFix", () => {
  it("creates one goal per group with the budget, branch, evidence, rules and earlier attempts", async () => {
    const root = setup([]);
    dirs.pop();
    const dossier = join(root.root, "dossier.txt");
    const crop = join(root.root, "crop.png");
    const bundle = join(root.root, "bundle");
    mkdirSync(bundle);
    writeFileSync(dossier, "cause CSS_MISSING: a noscript stylesheet");
    writeFileSync(crop, "PNG");
    writeFileSync(join(bundle, "README.md"), "reproduce with the inputs here");
    writeFileSync(join(bundle, "input.json"), '{"a":1}');
    const stageDir = root.stageDir(1, "bvg", "mirror");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "log.txt"), Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));

    const f = finding(SIG, { evidence: [dossier, crop, bundle], status: "recurring" });
    writeJson(join(root.cycleDir(1), "findings.json"), { cycle: 1, findings: [f] });
    const registry = mergeFindings({ entries: {} }, findingsOf(f));
    recordAttempt(registry, SIG, {
      goalId: "goal-old",
      cycle: 1,
      verdict: "discarded",
      reason: "gate links.ok regressed on acme",
      diffSummary: "packages/x/src/a.ts +1 -0",
    });
    writeRegistry(root, registry);
    const rule: RuleEntry = {
      signature: "mirror:visual.parity:ASSET",
      file: "autopilot/rules/x.md",
      seen: [],
      symptom: "visual.parity low",
      rootCause: "r",
      invariant: "assets load",
      guards: [{ kind: "test", file: "packages/x/test/a.test.ts", name: "assets" }],
    };
    writeRules(root, [rule]);

    const fake = fakeGoals(root.root);
    const result = await runFix({ cycle: 1, budgetUsd: 20, model: "provider/fast" }, deps(root, fake.goals));

    expect(fake.created).toHaveLength(1);
    const req = fake.created[0]!;
    expect(req.title).toBe(`autopilot ${SIG}`);
    expect(req.budget).toEqual({ maxCost: 10, timeoutMs: 45 * 60_000, maxRounds: 1 });
    expect(req.policy).toEqual({ permissionMode: "auto" });
    expect(req.models).toEqual({
      executor: "provider/fast",
      planner: "provider/fast",
      reviewer: "provider/fast",
    });
    expect(req.acceptance).toEqual(acceptanceCriteria({ signature: SIG }));

    const goal = fake.saved.get("goal-1")!;
    expect(goal.branch).toBe("cdr/goal-autopilot-mirror-visual.parity-CSS_MISSING");
    const task = goal.description;
    expect(task).toContain("cause CSS_MISSING: a noscript stylesheet");
    expect(task).toContain("reproduce with the inputs here");
    expect(task).toContain('{"a":1}');
    expect(task).toContain(".harness/autopilot-evidence/");
    expect(task).toContain("last 60 lines of the stage log");
    expect(task).toContain("line 99");
    expect(task).not.toContain("line 39\n");
    expect(task).toContain("assets load");
    expect(task).toContain("goal-old");
    expect(task).toContain("packages/x/src/a.ts +1 -0");
    expect(task).toContain("autopilot-fix");
    // an earlier reason that named the holdout does not reach the fixer
    expect(task).not.toMatch(/\bacme\b/);

    expect(existsSync(join(goal.worktree!, ".harness/autopilot-evidence/00-dossier.txt"))).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.spentUsd).toBe(2);
    expect(listGoalRecords(root, 1)[0]).toMatchObject({ signature: SIG, costUsd: 2, branch: goal.branch });
    expect(readRegistry(root).entries[SIG]!.status).toEqual({ fixing: "goal-1" });
    dirs.push(root.root);
  });

  it("keeps a secret in evidence out of the task", async () => {
    const root = setup([]);
    const dossier = join(root.root, "dossier.txt");
    writeFileSync(dossier, "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    writeJson(join(root.cycleDir(1), "findings.json"), {
      cycle: 1,
      findings: [finding(SIG, { evidence: [dossier] })],
    });
    const fake = fakeGoals(root.root);
    await runFix({ cycle: 1 }, deps(root, fake.goals));
    expect(fake.saved.get("goal-1")!.description).not.toContain("sk-ant-api03");
  });

  it("gives each goal only what is left of the budget and stops when it is spent", async () => {
    const findings = ["a", "b", "c"].map((s) => finding(s, { rank: 1 }));
    const paths = setup(findings);
    const fake = fakeGoals(paths.root, { cost: 6 });
    const result = await runFix({ cycle: 1, budgetUsd: 12, max: 3 }, deps(paths, fake.goals));
    expect(fake.created.map((c) => c.budget?.maxCost)).toEqual([10, 6]);
    expect(result.deferred).toEqual(["c"]);
    expect(result.spentUsd).toBe(12);
  });

  it("defers what is over the group cap", async () => {
    const paths = setup(["a", "b", "c"].map((s) => finding(s)));
    const fake = fakeGoals(paths.root);
    const result = await runFix({ cycle: 1, max: 2 }, deps(paths, fake.goals));
    expect(fake.created).toHaveLength(2);
    expect(result.deferred).toEqual(["c"]);
  });

  it("on resume skips signatures that already have a goal this cycle", async () => {
    const paths = setup([finding("a"), finding("b")]);
    const first = fakeGoals(paths.root);
    await runFix({ cycle: 1, max: 1 }, deps(paths, first.goals));
    const second = fakeGoals(paths.root);
    const result = await runFix({ cycle: 1, max: 5 }, deps(paths, second.goals));
    expect(second.created.map((c) => c.title)).toEqual(["autopilot b"]);
    expect(result.records.map((r) => r.signature).sort()).toEqual(["a", "b"]);
  });

  it("writes tasks instead of starting goals on a dry run", async () => {
    const paths = setup([finding(SIG)]);
    const fake = fakeGoals(paths.root);
    const result = await runFix({ cycle: 1, dryRun: true }, deps(paths, fake.goals));
    expect(fake.created).toEqual([]);
    expect(result.records).toEqual([]);
    expect(result.drafts).toHaveLength(1);
    const draft = readFileSync(result.drafts[0]!, "utf8");
    expect(draft).toContain(SIG);
    expect(draft).toContain("## Acceptance criteria");
    expect(readRegistry(paths).entries[SIG]).toBeUndefined();
  });

  it("does not start a fixer on a detached HEAD", async () => {
    const paths = setup([finding(SIG)]);
    const fake = fakeGoals(paths.root);
    await expect(
      runFix({ cycle: 1 }, { ...deps(paths, fake.goals), baseBranch: () => null }),
    ).rejects.toThrow(/detached/);
  });
});
