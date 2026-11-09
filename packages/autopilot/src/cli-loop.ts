/**
 * The self-improving half of the CLI (`fix`, `verify`, `loop`, `rules`, `diff`, `clean`): the real ports behind
 * `fix.ts`, `verify.ts` and `loop.ts`, and the flag handling of each command.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  git as runGit,
  GoalStore,
  Harness,
  createWorktree,
  discardGoal,
  mergeGoal,
  repoRoot,
  runGoal,
} from "@harness/core";
import type { GoalInfo } from "@harness/protocol";
import type { AutopilotCliContext } from "./cli.js";
import { cleanCycles } from "./clean.js";
import { readMatrix as readCollectedMatrix } from "./collect.js";
import { compareCycles, matrixCost, renderDiff } from "./diff.js";
import {
  CYCLE_FIX_BUDGET_USD,
  DEFAULT_FIX_MAX,
  findingsFile,
  readFindings,
  runFix,
  type FixDeps,
  type GoalPort,
} from "./fix.js";
import { inspectCycle } from "./inspect.js";
import { runLoop, type LoopDeps } from "./loop.js";
import { autopilotPaths } from "./paths.js";
import { needsHumanReport, readJson, readRegistry } from "./registry.js";
import { writeReports } from "./report.js";
import { checkRules, readRules } from "./rules.js";
import { runMatrix } from "./runner.js";
import { loadSites, selectSites } from "./sites.js";
import { latestCycle } from "./status.js";
import { createFreezeStage } from "./stages/freeze.js";
import {
  DEFAULT_AUTOPILOT_CONFIG,
  STAGE_ORDER,
  type AutopilotConfig,
  type AutopilotPaths,
  type FindingsFile,
  type StageName,
} from "./types.js";
import {
  pnpmCommands,
  realGit,
  verifyGoals,
  type LaneInput,
  type LanePort,
  type LaneResult,
  type VerifyDeps,
} from "./verify.js";

export type AutopilotCommand = (argv: string[], ctx: AutopilotCliContext) => Promise<number>;

/** The goals the fixers run on: the same store and worktrees as `cdr goal`. */
export function coreGoals(harness: Harness, store: GoalStore): GoalPort {
  return {
    create: (req) => store.create(req),
    save: (goal) => store.save(goal),
    get: (id) => store.get(id),
    prepare: (goal: GoalInfo) => {
      const worktree = join(goal.repo, ".harness", "worktrees", goal.id);
      const created = createWorktree(goal.repo, worktree, goal.branch!, goal.baseBranch);
      if (!created.ok) throw new Error(`could not create a worktree for ${goal.id}: ${created.error}`);
      return store.save({ ...goal, worktree });
    },
    run: (id, signal) => runGoal(harness, id, { signal, store }),
    merge: (id) => mergeGoal(id, store),
    discard: (id) => discardGoal(id, store),
  };
}

/** The pipeline the candidate branch would ship, run from its own worktree's build. */
function runCli(
  worktree: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(worktree, "packages/cli/dist/bin.js"), "autopilot", ...args],
      {
        cwd: worktree,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-100_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, output });
    });
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
  });
}

/** Snapshots are shared: a candidate is judged against exactly what the accepted code ran on. */
function linkSnapshots(main: AutopilotPaths, candidate: AutopilotPaths): void {
  if (existsSync(candidate.snapshots) || !existsSync(main.snapshots)) return;
  mkdirSync(dirname(candidate.snapshots), { recursive: true });
  symlinkSync(main.snapshots, candidate.snapshots);
}

/** Summaries of the stages before `stage`, so the candidate re-runs only that stage from cached inputs (§5.2). */
function copyUpstream(
  main: AutopilotPaths,
  candidate: AutopilotPaths,
  cycle: number,
  site: string,
  stage: StageName,
): void {
  for (const upstream of STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage))) {
    const source = join(main.stageDir(cycle, site, upstream), "summary.json");
    if (!existsSync(source)) continue;
    const target = join(candidate.stageDir(cycle, site, upstream), "summary.json");
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function laneResult(candidate: AutopilotPaths, cycle: number): LaneResult {
  const matrix = readCollectedMatrix(candidate, cycle);
  if (!matrix) throw new Error(`the candidate wrote no matrix.json for cycle ${cycle}`);
  return { matrix, findings: readFindings(candidate, cycle), costUsd: matrixCost(matrix) };
}

/** The lanes of §5.2: the candidate's own CLI, in its worktree, over the shared snapshots. */
export function cliLanes(main: AutopilotPaths): LanePort {
  // A failing matrix exits 1 and still leaves its results; only a run with no results is an error (laneResult).
  const run = (args: string[], worktree: string, signal: AbortSignal | undefined) =>
    runCli(worktree, args, signal);

  const inspect = async (input: LaneInput) => {
    const candidate = autopilotPaths(input.worktree);
    await run(
      ["inspect", "--cwd", input.worktree, "--cycle", String(input.cycle)],
      input.worktree,
      input.signal,
    );
    if (!existsSync(findingsFile(candidate, input.cycle)))
      throw new Error(`the candidate wrote no findings.json for cycle ${input.cycle}`);
    return laneResult(candidate, input.cycle);
  };

  return {
    fast: async (input) => {
      const candidate = autopilotPaths(input.worktree);
      linkSnapshots(main, candidate);
      const stage = input.stages?.[0];
      const fixtures = input.sites.filter((site) => site.fixture).map((site) => site.id);
      const origins = input.sites.filter((site) => !site.fixture).map((site) => site.id);
      const base = ["run", "--cwd", input.worktree, "--cycle", String(input.cycle), "--keep-cache"];
      if (origins.length) {
        for (const site of origins) if (stage) copyUpstream(main, candidate, input.cycle, site, stage);
        await run(
          [...base, "--sites", origins.join(","), ...(stage ? ["--stages", stage] : [])],
          input.worktree,
          input.signal,
        );
      }
      if (fixtures.length) {
        // A fixture was not part of the cycle, so it runs from its first stage up to the affected one.
        const stages = stage ? STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage) + 1) : STAGE_ORDER;
        await run(
          [...base, "--sites", fixtures.join(","), "--stages", stages.join(",")],
          input.worktree,
          input.signal,
        );
      }
      return inspect(input);
    },
    slow: async (input) => {
      linkSnapshots(main, autopilotPaths(input.worktree));
      await run(
        [
          "run",
          "--cwd",
          input.worktree,
          "--cycle",
          String(input.cycle),
          "--sites",
          input.sites.map((s) => s.id).join(","),
        ],
        input.worktree,
        input.signal,
      );
      return inspect(input);
    },
  };
}

function autopilotConfig(paths: AutopilotPaths): AutopilotConfig {
  const block = readJson<{ autopilot?: Partial<AutopilotConfig> }>(
    join(paths.root, ".harness/config.json"),
    {},
  ).autopilot;
  return {
    ...DEFAULT_AUTOPILOT_CONFIG,
    ...block,
    budgets: { ...DEFAULT_AUTOPILOT_CONFIG.budgets, ...block?.budgets },
    freeze: { ...DEFAULT_AUTOPILOT_CONFIG.freeze, ...block?.freeze },
    coverage: { ...DEFAULT_AUTOPILOT_CONFIG.coverage, ...block?.coverage },
  };
}

// ---------------------------------------------------------------- flags

interface Parsed {
  values: Record<string, string>;
  booleans: Set<string>;
}

function parse(argv: string[], withValue: string[], switches: string[]): Parsed {
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split("=", 2) as [string, string | undefined];
    if (withValue.includes(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      values[flag] = value;
    } else if (switches.includes(flag)) {
      booleans.add(flag);
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }
  return { values, booleans };
}

function numberFlag(parsed: Parsed, flag: string, fallback: number): number {
  const raw = parsed.values[flag];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative number`);
  return value;
}

function cycleFlag(parsed: Parsed, paths: AutopilotPaths): number {
  const cycle = parsed.values["--cycle"] ? numberFlag(parsed, "--cycle", 0) : latestCycle(paths);
  if (!cycle) throw new Error("no cycle yet; run `cdr autopilot run` first");
  return cycle;
}

const rootOf = (cwd: string): string => repoRoot(cwd) ?? cwd;

function stagesFlag(parsed: Parsed): StageName[] | undefined {
  const raw = parsed.values["--stages"];
  if (!raw) return undefined;
  const stages = raw.split(",").map((s) => s.trim());
  for (const stage of stages)
    if (!STAGE_ORDER.includes(stage as StageName)) throw new Error(`--stages: unknown stage "${stage}"`);
  return stages as StageName[];
}

/**
 * A fixer works in a git worktree, so what it needs must be committed. A checkout with the pipeline still untracked
 * would give every fixer an empty repository.
 */
function assertCommitted(paths: AutopilotPaths): void {
  if (!runGit(paths.root, ["ls-files", "--error-unmatch", "packages/autopilot/package.json"]).ok)
    throw new Error(
      "packages/autopilot is not committed: fixer worktrees would not contain the pipeline. Commit it first.",
    );
}

// ---------------------------------------------------------------- commands

function fixDeps(paths: AutopilotPaths, ctx: AutopilotCliContext, goals: GoalPort): FixDeps {
  const git = realGit(paths.root);
  return {
    paths,
    sites: loadSites(paths),
    goals,
    branchExists: git.branchExists,
    baseBranch: git.currentBranch,
    log: (line) => ctx.out.write(`${line}\n`),
  };
}

function verifyDeps(paths: AutopilotPaths, ctx: AutopilotCliContext, goals: GoalPort): VerifyDeps {
  return {
    paths,
    sites: loadSites(paths),
    goals,
    git: realGit(paths.root),
    commands: pnpmCommands(),
    lanes: cliLanes(paths),
    log: (line) => ctx.out.write(`${line}\n`),
  };
}

const fix: AutopilotCommand = async (argv, ctx) => {
  const parsed = parse(argv, ["--cycle", "--max", "--budget-usd", "--model"], ["--dry-run"]);
  const paths = autopilotPaths(rootOf(ctx.cwd));
  const cycle = cycleFlag(parsed, paths);
  const dryRun = parsed.booleans.has("--dry-run");
  if (!dryRun) assertCommitted(paths);
  const config = autopilotConfig(paths);
  const goals = coreGoals(new Harness(), new GoalStore());
  const result = await runFix(
    {
      cycle,
      max: numberFlag(parsed, "--max", DEFAULT_FIX_MAX),
      budgetUsd: numberFlag(parsed, "--budget-usd", CYCLE_FIX_BUDGET_USD),
      ...(parsed.values["--model"] ? { model: parsed.values["--model"] } : {}),
      dryRun,
      budgets: config.budgets,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
    fixDeps(paths, ctx, goals),
  );
  ctx.out.write(
    dryRun
      ? `${result.drafts.length} task(s) drafted, nothing started\n`
      : `${result.records.length} goal(s), $${result.spentUsd.toFixed(2)} spent, ${result.deferred.length} left for later\n`,
  );
  return 0;
};

const verify: AutopilotCommand = async (argv, ctx) => {
  const parsed = parse(argv, ["--cycle", "--goal", "--budget-usd"], ["--fast"]);
  const paths = autopilotPaths(rootOf(ctx.cwd));
  const cycle = cycleFlag(parsed, paths);
  const budgetRaw = parsed.values["--budget-usd"];
  const result = await verifyGoals(
    {
      cycle,
      ...(parsed.values["--goal"] ? { goalId: parsed.values["--goal"] } : {}),
      fastOnly: parsed.booleans.has("--fast"),
      ...(budgetRaw ? { budgetUsd: numberFlag(parsed, "--budget-usd", 0) } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
    verifyDeps(paths, ctx, coreGoals(new Harness(), new GoalStore())),
  );
  if (result.fast) {
    ctx.out.write(`fast lane: ${result.fast.ok ? "ok" : "failed"}: ${result.fast.reason}\n`);
    return result.fast.ok ? 0 : 1;
  }
  const accepted = result.verdicts.filter((v) => v.verdict === "accepted").length;
  ctx.out.write(
    `${accepted} accepted, ${result.verdicts.length - accepted} discarded, ${result.pending.length} pending\n`,
  );
  return accepted === result.verdicts.length && !result.pending.length ? 0 : 1;
};

const loop: AutopilotCommand = async (argv, ctx) => {
  const parsed = parse(
    argv,
    ["--sites", "--stages", "--max-cycles", "--budget-usd", "--stable", "--fix-max", "--model"],
    ["--until-green"],
  );
  const paths = autopilotPaths(rootOf(ctx.cwd));
  assertCommitted(paths);
  const siteFile = loadSites(paths);
  const sites = selectSites(
    siteFile,
    parsed.values["--sites"]?.split(",").map((s) => s.trim()),
  );
  const stages = stagesFlag(parsed);
  const config = autopilotConfig(paths);
  const model = parsed.values["--model"];
  const goals = coreGoals(new Harness(), new GoalStore());
  const log = (line: string) => ctx.out.write(`${line}\n`);

  const pause = new AbortController();
  const cancel = new AbortController();
  let interrupts = 0;
  const onInterrupt = () => {
    interrupts++;
    if (interrupts === 1) {
      pause.abort();
      log("pausing after this step (Ctrl+C again to stop the step now)");
    } else {
      cancel.abort();
      log("stopping the running step; it runs again on resume");
    }
  };
  process.on("SIGINT", onInterrupt);
  ctx.signal?.addEventListener("abort", onInterrupt, { once: true });

  const deps: LoopDeps = {
    paths,
    sites: siteFile,
    log,
    head: () => realGit(paths.root).head("HEAD") ?? "",
    freeze: async ({ cycle, sites: toFreeze, signal }) => {
      await runMatrix({
        paths,
        cycle,
        sites: toFreeze,
        config,
        stages: ["freeze"],
        noMatrix: true,
        runners: { freeze: createFreezeStage({}) },
        ...(signal ? { signal } : {}),
        progress: log,
      });
    },
    run: ({ cycle, sites: toRun, stages: selected, keepCache, coverageTarget, signal }) =>
      runMatrix({
        paths,
        cycle,
        sites: toRun,
        config: { ...config, coverage: { ...config.coverage, start: coverageTarget } },
        ...(selected ? { stages: selected } : {}),
        keepCache,
        ...(signal ? { signal } : {}),
        progress: log,
      }),
    inspect: async ({ cycle }): Promise<FindingsFile> => inspectCycle(paths, cycle).file,
    fix: ({ cycle, max, budgetUsd, signal }) =>
      runFix(
        {
          cycle,
          max,
          budgetUsd,
          budgets: config.budgets,
          ...(model ? { model } : {}),
          ...(signal ? { signal } : {}),
        },
        fixDeps(paths, ctx, goals),
      ),
    verify: ({ cycle, budgetUsd, signal }) =>
      verifyGoals(
        { cycle, budgetUsd, ...(signal ? { signal } : {}) },
        { ...verifyDeps(paths, ctx, goals), matrixSites: sites },
      ),
    rules: async () => checkRules(paths.root, readRules(paths)),
    report: async (cycle) => {
      writeReports(paths, cycle, config);
    },
  };

  try {
    const result = await runLoop(
      {
        maxCycles: numberFlag(parsed, "--max-cycles", 20),
        budgetUsd: numberFlag(parsed, "--budget-usd", 200),
        untilGreen: parsed.booleans.has("--until-green"),
        stable: numberFlag(parsed, "--stable", 2),
        fixMax: numberFlag(parsed, "--fix-max", DEFAULT_FIX_MAX),
        sites,
        ...(stages ? { stages } : {}),
        coverage: config.coverage,
        pauseSignal: pause.signal,
        cancelSignal: cancel.signal,
      },
      deps,
    );
    const report = needsHumanReport(readRegistry(paths));
    if (report) ctx.out.write(`${report}\n`);
    ctx.out.write(
      `${result.state.status} at cycle ${result.state.cycle}, spent $${result.state.spentUsd.toFixed(2)}${result.state.reason ? `: ${result.state.reason}` : ""}\n`,
    );
    return result.exitCode;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
};

const rules: AutopilotCommand = async (argv, ctx) => {
  const parsed = parse(argv, [], ["--check"]);
  const paths = autopilotPaths(rootOf(ctx.cwd));
  const entries = readRules(paths);
  if (parsed.booleans.has("--check")) {
    const problems = checkRules(paths.root, entries);
    for (const problem of problems)
      ctx.out.write(`${problem.code} ${problem.signature}: ${problem.detail}\n`);
    ctx.out.write(`${entries.length} rule(s), ${problems.length} problem(s)\n`);
    return problems.length ? 1 : 0;
  }
  for (const rule of entries) {
    const guards = rule.guards.map((g) => (g.kind === "test" ? `${g.file} "${g.name}"` : g.file)).join(", ");
    ctx.out.write(`${rule.signature}\n  ${rule.invariant}\n  guard: ${guards}\n`);
  }
  if (!entries.length) ctx.out.write("no rules yet\n");
  return 0;
};

const diff: AutopilotCommand = async (argv, ctx) => {
  const parsed = parse(argv, ["--cycle", "--against"], []);
  const paths = autopilotPaths(rootOf(ctx.cwd));
  if (!parsed.values["--against"]) throw new Error("usage: cdr autopilot diff --cycle N --against M");
  const report = compareCycles(paths, numberFlag(parsed, "--against", 0), cycleFlag(parsed, paths));
  ctx.out.write(renderDiff(report));
  return report.regressions.length ? 1 : 0;
};

const clean: AutopilotCommand = async (argv, ctx) => {
  const parsed = parse(argv, ["--keep"], []);
  const paths = autopilotPaths(rootOf(ctx.cwd));
  const result = cleanCycles(paths, numberFlag(parsed, "--keep", 3));
  ctx.out.write(
    `kept ${result.kept.length} cycle(s), cleaned ${result.cleaned.length}, freed ${(result.bytesFreed / 1_048_576).toFixed(1)} MB\n`,
  );
  return 0;
};

const guarded =
  (command: AutopilotCommand): AutopilotCommand =>
  async (argv, ctx) => {
    try {
      return await command(argv, ctx);
    } catch (error) {
      ctx.out.write(`${(error as Error).message}\n`);
      return 1;
    }
  };

/** The self-improving half of the CLI: dispatched by `autopilotMain` in cli.ts. */
export const loopCommands: Record<string, AutopilotCommand> = {
  fix: guarded(fix),
  verify: guarded(verify),
  loop: guarded(loop),
  rules: guarded(rules),
  diff: guarded(diff),
  clean: guarded(clean),
};
