/**
 * The self-improving loop end to end, on a throwaway git repository and a copy of a local fixture, under
 * CDR_AUTOPILOT_E2E=1. Real: git, goal worktrees and merge/discard (goals.ts), the runner, the collector, the registry,
 * policy, rules, regression test on base and branch, the lanes' logic, the loop. Scripted: the "pipeline" (a small
 * script in the throwaway repo that stands in for the mirror stage) and the fixers (no model is called).
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GoalStore, type Harness } from "@harness/core";
import type { GoalInfo } from "@harness/protocol";
import {
  autopilotPaths,
  checkRules,
  coreGoals,
  inspectCycle,
  loadSites,
  readBaseline,
  readRegistry,
  readRules,
  realGit,
  ruleFileFor,
  runFix,
  runLoop,
  runMatrix,
  verifyGoals,
  writeReports,
  type AutopilotPaths,
  type CommandPort,
  type FixDeps,
  type GoalPort,
  type LaneInput,
  type LanePort,
  type LaneResult,
  type LoopDeps,
  type RuleEntry,
  type SiteConfig,
  type StageRunner,
  type StageSummary,
  type VerifyDeps,
} from "@harness/autopilot";

const FIXTURE = fileURLToPath(new URL("../../mirror/test/fixtures/site", import.meta.url));

const run = (cwd: string, command: string, ...args: string[]) => {
  const r = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const git = (cwd: string, ...args: string[]) => run(cwd, "git", ...args);

const DEFECT = `  html = html.replace(/<title>.*?<\\/title>/s, ""); // the injected defect`;

/** The stand-in pipeline: copies a page, and carries the bug the first fixer has to remove. */
const PIPELINE = `export function mirror(input) {
  let html = input;
${DEFECT}
  return html;
}
`;

/** One run of the pipeline from a worktree's own code: page in, gates and a generated app out. */
const RUN = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mirror } from "./mirror.mjs";

const [fixture, out] = process.argv.slice(2);
const input = readFileSync(join(fixture, "index.html"), "utf8");
const output = mirror(input);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), "<!-- built " + new Date().toISOString() + " -->\\n" + output);
const title = (html) => /<title>(.*?)<\\/title>/s.exec(html)?.[1] ?? null;
const links = (html) => (html.match(/<a /g) ?? []).length;
const gates = [
  { id: "content.title", pass: title(output) === title(input), hard: true },
  { id: "links.internal", pass: links(output) === links(input), hard: true },
];
process.stdout.write(JSON.stringify(gates));
`;

const BASE_TEST = `import test from "node:test";
import assert from "node:assert";
import { mirror } from "../src/mirror.mjs";
test("copies the body", () => {
  assert.match(mirror("<p>x</p>"), /<p>x<\\/p>/);
});
`;

/** A real gate default, so a fixer lowering it is caught by the real policy check. */
const CONTRACTS = `export const parityConfig = z.object({
  screenshotThreshold: z.number().default(0.97),
});
`;

const SITES = `sites:
  shop:
    url: https://shop.example.test/
    framework: nextjs
holdout:
  - fixture: acme
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Repo {
  root: string;
  paths: AutopilotPaths;
  store: GoalStore;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A repository whose matrix fails on the injected defect, with copies of the fixture as its sites. */
function makeRepo(): Repo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-e2e-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-e2e-home-")));
  dirs.push(root, home);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "E2E");
  git(root, "config", "user.email", "e2e@example.test");
  write(root, ".gitignore", ".harness/\nnode_modules/\n");
  write(root, "package.json", '{"name":"e2e","private":true}\n');
  write(root, "autopilot/sites.yaml", SITES);
  write(root, "autopilot/rules.json", '{ "rules": [] }\n');
  write(root, "autopilot/registry.json", '{ "entries": {} }\n');
  write(root, "autopilot/baseline.json", '{ "cycle": 0, "commit": "", "sites": {} }\n');
  write(root, "packages/pipeline/src/mirror.mjs", PIPELINE);
  write(root, "packages/pipeline/src/run.mjs", RUN);
  write(root, "packages/pipeline/test/mirror.test.mjs", BASE_TEST);
  write(root, "packages/mirror-core/src/contracts.ts", CONTRACTS);
  // the matrix site and the holdout are two pages of the same local fixture
  cpSync(join(FIXTURE, "about-us/index.html"), join(root, "fixtures/shop/index.html"), { recursive: true });
  cpSync(join(FIXTURE, "index.html"), join(root, "fixtures/acme/index.html"), { recursive: true });
  git(root, "add", "-A");
  git(root, "commit", "-m", "the pipeline with its defect");
  return { root, paths: autopilotPaths(root), store: new GoalStore(home) };
}

/** The stand-in for the mirror stage. It runs the code of whichever checkout `paths` points at. */
const mirrorStage: StageRunner = {
  name: "mirror",
  run: async (ctx): Promise<StageSummary> => {
    const out = join(ctx.stageDir, "out");
    const stdout = run(
      ctx.paths.root,
      process.execPath,
      "packages/pipeline/src/run.mjs",
      join(ctx.paths.root, "fixtures", ctx.site.id),
      out,
    );
    const gates = JSON.parse(stdout) as StageSummary["gates"];
    return {
      stage: "mirror",
      site: ctx.site.id,
      status: gates.every((g) => g.pass) ? "passed" : "failed",
      wallClockMs: 1,
      gates,
      issues: [],
      artifacts: { mirrorApp: out },
    };
  },
};

function matrix(paths: AutopilotPaths, cycle: number, sites: SiteConfig[], keepCache: boolean) {
  return runMatrix({ paths, cycle, sites, stages: ["mirror"], runners: { mirror: mirrorStage }, keepCache });
}

/** The lanes: the candidate's own code, in its worktree, through the real runner and collector. */
function lanesFor(): LanePort {
  const lane = async (input: LaneInput): Promise<LaneResult> => {
    const paths = autopilotPaths(input.worktree);
    const result = await matrix(paths, input.cycle, input.sites, false);
    return { matrix: result, findings: inspectCycle(paths, input.cycle).file, costUsd: 0 };
  };
  return { fast: lane, slow: lane };
}

const commandsFor = (): CommandPort => {
  const node = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
    return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
  };
  const ok = async () => ({ ok: true, output: "" });
  return {
    install: ok,
    build: ok,
    lint: ok,
    test: async (cwd) => {
      const dir = "packages/pipeline/test";
      const files = readdirSync(join(cwd, dir)).filter((f) => f.endsWith(".test.mjs"));
      return node(cwd, "--test", ...files.map((f) => join(dir, f)));
    },
    testOne: async (cwd, file, name) => node(cwd, "--test", `--test-name-pattern=${name}`, file),
  };
};

type Fixer = (worktree: string, signature: string, goal: GoalInfo) => void;

/** `goals.ts` for real (worktrees, merge, discard), with the agent replaced by a script. */
function goalsWith(store: GoalStore, fixer: Fixer): GoalPort {
  const real = coreGoals(undefined as unknown as Harness, store);
  return {
    ...real,
    run: async (id) => {
      const goal = store.require(id);
      fixer(goal.worktree!, goal.title.replace(/^autopilot /, ""), goal);
      git(goal.worktree!, "add", "-A");
      git(goal.worktree!, "commit", "-m", `scripted fix of ${goal.title}`);
      return store.save({ ...goal, status: "review", usage: { ...goal.usage, cost: 1.5 } });
    },
  };
}

function addRule(worktree: string, signature: string): void {
  const file = ruleFileFor(signature);
  write(
    worktree,
    "packages/pipeline/test/title.test.mjs",
    `import test from "node:test";
import assert from "node:assert";
import { mirror } from "../src/mirror.mjs";
test("keeps the page title", () => {
  assert.match(mirror("<title>A</title><p>x</p>"), /<title>A<\\/title>/);
});
`,
  );
  write(
    worktree,
    file,
    `# ${signature}\nSeen: \n## Symptom\nThe mirrored page has no title.\n## Root cause\nThe copy step removed the title element.\n## Invariant\nA mirrored page keeps its title.\n## Guard\ntest: packages/pipeline/test/title.test.mjs "keeps the page title"\n`,
  );
  const rulesPath = join(worktree, "autopilot/rules.json");
  const { rules } = JSON.parse(readFileSync(rulesPath, "utf8")) as { rules: RuleEntry[] };
  rules.push({
    signature,
    file,
    seen: [],
    symptom: "The mirrored page has no title.",
    rootCause: "The copy step removed the title element.",
    invariant: "A mirrored page keeps its title.",
    guards: [{ kind: "test", file: "packages/pipeline/test/title.test.mjs", name: "keeps the page title" }],
  });
  writeFileSync(rulesPath, JSON.stringify({ rules }, null, 2) + "\n");
}

const removeDefect = (worktree: string) => {
  const file = join(worktree, "packages/pipeline/src/mirror.mjs");
  writeFileSync(file, readFileSync(file, "utf8").replace(`${DEFECT}\n`, ""));
};

const goodFixer: Fixer = (worktree, signature) => {
  removeDefect(worktree);
  addRule(worktree, signature);
};

/** Makes the check pass the dishonest way: the same fix, plus a lower threshold. */
const thresholdFixer: Fixer = (worktree, signature) => {
  removeDefect(worktree);
  addRule(worktree, signature);
  const file = join(worktree, "packages/mirror-core/src/contracts.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace("default(0.97)", "default(0.5)"));
};

/** Fixes the title but breaks pages that only the holdout has. */
const holdoutBreakingFixer: Fixer = (worktree, signature) => {
  removeDefect(worktree);
  addRule(worktree, signature);
  const file = join(worktree, "packages/pipeline/src/mirror.mjs");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      "  return html;",
      '  if (html.includes("Good food")) html = html.replace(/<a /g, "<b ");\n  return html;',
    ),
  );
};

function wire(
  repo: Repo,
  fixer: Fixer,
): { deps: LoopDeps; fixDeps: FixDeps; verifyDeps: VerifyDeps; logs: string[] } {
  const { paths } = repo;
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const sites = loadSites(paths);
  const goals = goalsWith(repo.store, fixer);
  const gitPort = realGit(paths.root);
  const fixDeps: FixDeps = {
    paths,
    sites,
    goals,
    branchExists: gitPort.branchExists,
    baseBranch: gitPort.currentBranch,
    log,
  };
  const verifyDeps: VerifyDeps = {
    paths,
    sites,
    goals,
    git: gitPort,
    commands: commandsFor(),
    lanes: lanesFor(),
    log,
  };
  const deps: LoopDeps = {
    paths,
    sites,
    log,
    head: () => gitPort.head("HEAD") ?? "",
    freeze: async () => undefined,
    run: ({ cycle, sites: toRun, keepCache }) => matrix(paths, cycle, toRun, keepCache),
    inspect: async ({ cycle }) => inspectCycle(paths, cycle).file,
    fix: ({ cycle, max, budgetUsd }) => runFix({ cycle, max, budgetUsd }, fixDeps),
    verify: ({ cycle, budgetUsd }) => verifyGoals({ cycle, budgetUsd }, verifyDeps),
    rules: async () => checkRules(paths.root, readRules(paths)),
    report: async (cycle) => void writeReports(paths, cycle),
  };
  return { deps, fixDeps, verifyDeps, logs };
}

const options = { budgetUsd: 50, untilGreen: true, stable: 2 };
const SIG = "mirror:content.title";

describe.skipIf(!process.env.CDR_AUTOPILOT_E2E)("autopilot end to end", () => {
  it("fixes an injected defect in one cycle, merges it with its guard, and then proves it stable", async () => {
    const repo = makeRepo();
    const { deps, logs } = wire(repo, goodFixer);

    const first = await runLoop({ ...options, maxCycles: 1 }, deps);
    expect(first.state).toMatchObject({ status: "max-cycles", cycle: 2, step: "freeze", greenStreak: 0 });

    // the fix landed on main, with its guard
    const code = readFileSync(join(repo.root, "packages/pipeline/src/mirror.mjs"), "utf8");
    expect(code).not.toContain("injected defect");
    expect(existsSync(join(repo.root, "packages/pipeline/test/title.test.mjs"))).toBe(true);
    expect(git(repo.root, "log", "--format=%s", "-3")).toContain(`Merge goal: autopilot ${SIG}`);

    const rules = readRules(repo.paths);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ signature: SIG, fixedCycle: 1 });
    expect(rules[0]!.goalId).toMatch(/^goal-/);
    expect(rules[0]!.seen).toEqual(["shop (cycle 1)"]);
    expect(checkRules(repo.root, rules)).toEqual([]);
    expect(readFileSync(join(repo.root, ruleFileFor(SIG)), "utf8").split("\n")[1]).toMatch(
      /Fixed: cycle 1 · Goal: goal-/,
    );

    const entry = readRegistry(repo.paths).entries[SIG]!;
    expect(entry.status).toEqual({ fixed: 1 });
    expect(entry.rule).toBe(ruleFileFor(SIG));
    expect(entry.attempts).toEqual([expect.objectContaining({ verdict: "accepted" })]);

    // the baseline moved to the accepted result, holdout included
    const baseline = readBaseline(repo.paths);
    expect(baseline.commit).toBe(git(repo.root, "rev-parse", "HEAD~1").trim());
    expect(baseline.sites.shop!.mirror!.gates.find((g) => g.id === "content.title")!.pass).toBe(true);
    expect(baseline.sites.acme!.mirror!.gates.find((g) => g.id === "content.title")!.pass).toBe(true);

    // the verdicts are committed, and nothing is left dirty
    expect(git(repo.root, "log", "--format=%s", "-1").trim()).toBe("autopilot: record verdicts of cycle 1");
    expect(git(repo.root, "status", "--porcelain").trim()).toBe("");

    // the worktree is gone, the branch is kept
    expect(git(repo.root, "branch", "--list", "cdr/goal-autopilot-*")).toContain(
      "cdr/goal-autopilot-mirror-content.title",
    );
    expect(git(repo.root, "worktree", "list").trim().split("\n")).toHaveLength(1);

    // the fixer's task named the finding and the evidence, and the holdout stayed hidden
    const [goal] = repo.store.list(repo.root);
    expect(goal!.description).toContain(SIG);
    expect(goal!.description).toContain("content.title");
    expect(goal!.description).not.toMatch(/\bacme\b/);
    expect(logs.some((l) => l.includes("accepted at accepted"))).toBe(true);

    // from now on the matrix is green, twice, the second reproducing the first apart from the timestamps
    const proof = wire(repo, () => {
      throw new Error("no fixer should run on a green matrix");
    });
    const stable = await runLoop({ ...options, maxCycles: 5 }, proof.deps);
    expect(stable.state).toMatchObject({ status: "green", greenStreak: 2 });
    expect(stable.exitCode).toBe(0);
    expect(existsSync(join(repo.paths.siteDir(3, "shop"), "reproducibility.json"))).toBe(false);
  });

  it("discards a fixer that lowers a threshold, and tells the next fixer why", async () => {
    const repo = makeRepo();
    const headBefore = () => git(repo.root, "rev-parse", "HEAD").trim();
    const { deps } = wire(repo, thresholdFixer);

    const result = await runLoop({ ...options, maxCycles: 1 }, deps);
    expect(result.state.status).toBe("max-cycles");

    const entry = readRegistry(repo.paths).entries[SIG]!;
    expect(entry.status).toBe("open");
    expect(entry.attempts).toHaveLength(1);
    expect(entry.attempts[0]).toMatchObject({ verdict: "discarded" });
    expect(entry.attempts[0]!.reason).toContain("GATE_DEFAULT");
    expect(entry.attempts[0]!.reason).toContain("screenshotThreshold");
    expect(entry.attempts[0]!.diffSummary).toContain("packages/mirror-core/src/contracts.ts");

    // nothing of it reached main
    expect(readFileSync(join(repo.root, "packages/pipeline/src/mirror.mjs"), "utf8")).toContain(
      "injected defect",
    );
    expect(readFileSync(join(repo.root, "packages/mirror-core/src/contracts.ts"), "utf8")).toContain(
      "default(0.97)",
    );
    expect(readRules(repo.paths)).toEqual([]);
    expect(git(repo.root, "branch", "--list", "cdr/goal-autopilot-*").trim()).toBe("");
    expect(git(repo.root, "worktree", "list").trim().split("\n")).toHaveLength(1);
    expect(headBefore()).toBe(git(repo.root, "rev-parse", "HEAD").trim());
    expect(git(repo.root, "log", "--format=%s", "-1").trim()).toBe("autopilot: record verdicts of cycle 1");

    // the next cycle's fixer sees the attempt and its reason (a retry within one cycle is a resume, and is skipped)
    const previous = JSON.parse(readFileSync(join(repo.paths.cycleDir(1), "findings.json"), "utf8")) as {
      findings: unknown[];
    };
    mkdirSync(repo.paths.cycleDir(2), { recursive: true });
    writeFileSync(
      join(repo.paths.cycleDir(2), "findings.json"),
      JSON.stringify({ cycle: 2, findings: previous.findings }),
    );
    const next = wire(repo, goodFixer);
    await runFix({ cycle: 2, budgetUsd: 10 }, next.fixDeps);
    const goals = repo.store.list(repo.root);
    expect(goals).toHaveLength(2);
    const retry = goals.find((g) => g.status === "review")!;
    expect(retry.description).toContain("Earlier attempts on this signature");
    expect(retry.description).toContain("GATE_DEFAULT");
    expect(retry.description).toContain("screenshotThreshold");
    // a second attempt on a branch name that is free again
    expect(retry.branch).toBe("cdr/goal-autopilot-mirror-content.title");
  });

  it("discards a fixer that breaks only the holdout, and does not name the holdout in the reason", async () => {
    const repo = makeRepo();
    const { deps } = wire(repo, holdoutBreakingFixer);
    await runLoop({ ...options, maxCycles: 1 }, deps);

    const entry = readRegistry(repo.paths).entries[SIG]!;
    expect(entry.attempts[0]).toMatchObject({ verdict: "discarded" });
    expect(entry.attempts[0]!.reason).toMatch(/links\.internal/);
    expect(entry.attempts[0]!.reason).not.toMatch(/\bacme\b/);
    expect(readFileSync(join(repo.root, "packages/pipeline/src/mirror.mjs"), "utf8")).toContain(
      "injected defect",
    );
  });

  it("merges two fixes of one cycle one at a time, the second on top of the first", async () => {
    const repo = makeRepo();
    const { deps, verifyDeps, fixDeps } = wire(repo, goodFixer);
    await deps.freeze({ cycle: 1, sites: [] });
    const result = await deps.run({
      cycle: 1,
      sites: [...fixDeps.sites.sites, ...fixDeps.sites.holdout],
      keepCache: false,
      coverageTarget: 0.5,
      budgetUsd: 10,
    });
    expect(result.sites.shop).toBeDefined();
    write(repo.root, "autopilot/baseline.json", JSON.stringify(result));
    git(repo.root, "add", "-A");
    git(repo.root, "commit", "-m", "baseline");

    // Two separate findings that each add a rule entry to rules.json, the classic conflict.
    const second: Fixer = (worktree) => {
      write(worktree, "packages/pipeline/src/extra.mjs", "export const other = 1;\n");
      write(
        worktree,
        "packages/pipeline/test/extra.test.mjs",
        `import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
test("the extra module exists", () => {
  assert.ok(readFileSync(new URL("../src/extra.mjs", import.meta.url)));
});
`,
      );
      const signature = "mirror:OTHER:signature";
      write(worktree, ruleFileFor(signature), `# ${signature}\n\n## Root cause\nr\n`);
      const rulesPath = join(worktree, "autopilot/rules.json");
      const { rules } = JSON.parse(readFileSync(rulesPath, "utf8")) as { rules: RuleEntry[] };
      rules.push({
        signature,
        file: ruleFileFor(signature),
        seen: [],
        symptom: "s",
        rootCause: "r",
        invariant: "i",
        guards: [
          { kind: "test", file: "packages/pipeline/test/extra.test.mjs", name: "the extra module exists" },
        ],
      });
      writeFileSync(rulesPath, JSON.stringify({ rules }, null, 2) + "\n");
    };

    // Write findings with one signature each and start two goals with separate scripted fixers.
    const findingsPath = join(repo.paths.cycleDir(1), "findings.json");
    const findings = {
      cycle: 1,
      findings: [
        {
          signature: SIG,
          stage: "mirror",
          code: "content.title",
          message: "no title",
          sites: ["shop"],
          rank: 1,
          status: "new",
          evidence: [],
        },
        {
          signature: "mirror:OTHER:signature",
          stage: "mirror",
          code: "OTHER",
          message: "other",
          sites: ["shop"],
          rank: 1,
          status: "new",
          evidence: [],
        },
      ],
    };
    writeFileSync(findingsPath, JSON.stringify(findings));

    const dispatch: Fixer = (worktree, signature, goal) =>
      signature === SIG ? goodFixer(worktree, signature, goal) : second(worktree, signature, goal);
    const combined = wire(repo, dispatch);
    await runFix({ cycle: 1, budgetUsd: 10 }, combined.fixDeps);
    const verified = await verifyGoals({ cycle: 1 }, { ...verifyDeps, goals: combined.verifyDeps.goals });

    expect(verified.verdicts.map((v) => [v.signature, v.verdict, v.reason])).toEqual([
      [SIG, "accepted", expect.any(String)],
      ["mirror:OTHER:signature", "accepted", expect.any(String)],
    ]);
    // both rule entries survived, despite both goals editing rules.json from the same base
    expect(
      readRules(repo.paths)
        .map((r) => r.signature)
        .sort(),
    ).toEqual(["mirror:OTHER:signature", SIG].sort());
    expect(existsSync(join(repo.root, "packages/pipeline/src/extra.mjs"))).toBe(true);
    expect(checkRules(repo.root, readRules(repo.paths))).toEqual([]);
  });
});
