/**
 * The loop (§3): `freeze → run → inspect → fix → verify → rules`, repeated. Every step is recorded in `state.json`
 * before the next one starts, so a crash or a Ctrl+C resumes where it stopped. The loop stops when the matrix has been
 * green for `stable` consecutive cycles, when the budget is spent, or after `maxCycles`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { failingHardGates } from "./decide.js";
import { matrixCost, checkReproducibility, writeReproducibility } from "./diff.js";
import { findingsFile, type GoalRecord, CYCLE_FIX_BUDGET_USD, DEFAULT_FIX_MAX } from "./fix.js";
import { findingsMarkdown } from "./inspect.js";
import { appsOf, lintFindings, runLints, type LintResult } from "./lints.js";
import { ratchetCoverage } from "./ratchet.js";
import { mergeFindings, readJson, readRegistry, writeJson, writeRegistry } from "./registry.js";
import { readRules, type RuleProblem } from "./rules.js";
import {
  hasBaseline,
  readBaseline,
  readCycleMatrix,
  writeBaseline,
  writeMatrix,
  type VerifyResult,
} from "./verify.js";
import type {
  AutopilotConfig,
  AutopilotPaths,
  Finding,
  FindingsFile,
  LoopState,
  MatrixResult,
  SiteConfig,
  SitesFile,
  StageName,
} from "./types.js";
import { DEFAULT_AUTOPILOT_CONFIG } from "./types.js";

export const stateFile = (paths: AutopilotPaths): string => join(paths.state, "state.json");

export function readState(paths: AutopilotPaths): LoopState | null {
  return readJson<LoopState | null>(stateFile(paths), null);
}

export function writeState(paths: AutopilotPaths, state: LoopState): void {
  writeJson(stateFile(paths), state);
}

export interface RunInput {
  cycle: number;
  sites: SiteConfig[];
  stages?: StageName[];
  keepCache: boolean;
  coverageTarget: number;
  /** What is left of the budget; a runner should not start more model work than this. */
  budgetUsd: number;
  signal?: AbortSignal;
}

export interface FixStepInput {
  cycle: number;
  max: number;
  budgetUsd: number;
  signal?: AbortSignal;
}

export interface VerifyStepInput {
  cycle: number;
  budgetUsd: number;
  signal?: AbortSignal;
}

/** Everything the loop does, injected so a test can substitute any part. `cli-loop.ts` wires the real ones. */
export interface LoopDeps {
  paths: AutopilotPaths;
  sites: SitesFile;
  freeze(input: { cycle: number; sites: SiteConfig[]; signal?: AbortSignal }): Promise<void>;
  run(input: RunInput): Promise<MatrixResult>;
  /** The collector: findings of the cycle, unlabelled or labelled. The loop merges them into the registry. */
  inspect(input: { cycle: number; matrix: MatrixResult; signal?: AbortSignal }): Promise<FindingsFile>;
  fix(input: FixStepInput): Promise<{ records: GoalRecord[]; spentUsd: number }>;
  verify(input: VerifyStepInput): Promise<VerifyResult>;
  /** Default: `checkRules` on the checkout. */
  rules(): Promise<RuleProblem[]>;
  lints?(matrix: MatrixResult): Promise<LintResult[]>;
  /** Writes the cycle's REPORT.md and index.html; a stop must always leave a report (§7). */
  report?(cycle: number, state: LoopState): Promise<void>;
  head?(): string;
  log(line: string): void;
}

export interface LoopOptions {
  maxCycles: number;
  budgetUsd: number;
  untilGreen: boolean;
  stable: number;
  fixMax?: number;
  sites?: SiteConfig[];
  stages?: StageName[];
  coverage?: AutopilotConfig["coverage"];
  /** Ctrl+C: pause between steps. */
  pauseSignal?: AbortSignal;
  /** Second Ctrl+C: cancel the running step; a resume runs it again. */
  cancelSignal?: AbortSignal;
}

function initialState(coverageTarget: number): LoopState {
  return {
    cycle: 1,
    step: "freeze",
    status: "running",
    spentUsd: 0,
    greenStreak: 0,
    coverageTarget,
    goals: [],
  };
}

/**
 * The state a new invocation starts from. A paused, budget-stopped or crashed run continues with its spending. A run
 * that finished starts the next cycle with a fresh budget, so a nightly `--max-cycles 1` is not eaten by last night's
 * spending; only `green` also forgets its streak, since a new run has to prove stability from blank.
 */
export function resumeState(previous: LoopState | null, coverageTarget: number): LoopState {
  if (!previous) return initialState(coverageTarget);
  if (previous.status === "green")
    return {
      ...previous,
      cycle: previous.cycle + 1,
      status: "running",
      step: "freeze",
      spentUsd: 0,
      greenStreak: 0,
      goals: [],
      reason: undefined,
    };
  if (previous.status === "max-cycles")
    return { ...previous, status: "running", spentUsd: 0, goals: [], reason: undefined };
  return { ...previous, status: "running", reason: undefined };
}

/** Findings that keep the matrix from green: everything but advisory ones, and nothing only the holdout showed. */
export function blockingFindings(file: FindingsFile, siteIds: string[]): Finding[] {
  const matrix = new Set(siteIds);
  return file.findings.filter(
    (finding) =>
      finding.status !== "fixed" && finding.rank < 3 && finding.sites.some((site) => matrix.has(site)),
  );
}

/** The matrix sites of a result. A first run also carries the holdout, for the baseline. */
function matrixOnly(matrix: MatrixResult, siteIds: string[]): MatrixResult {
  return {
    ...matrix,
    sites: Object.fromEntries(Object.entries(matrix.sites).filter(([site]) => siteIds.includes(site))),
  };
}

export interface LoopResult {
  state: LoopState;
  /** Exit code of `autopilot loop`: 0 only for a good verdict (§3.3). */
  exitCode: number;
}

export async function runLoop(options: LoopOptions, deps: LoopDeps): Promise<LoopResult> {
  const { paths, sites, log } = deps;
  const coverage = options.coverage ?? DEFAULT_AUTOPILOT_CONFIG.coverage;
  const state = resumeState(readState(paths), coverage.start);
  const matrixSites = options.sites ?? sites.sites;
  const siteIds = matrixSites.map((site) => site.id);
  const fixMax = options.fixMax ?? DEFAULT_FIX_MAX;
  const stable = Math.max(1, options.stable);
  const signal = options.cancelSignal;

  const persist = () => writeState(paths, state);
  let completed = 0;
  const stop = async (status: LoopState["status"], reason?: string) => {
    state.status = status;
    if (reason) state.reason = reason;
    persist();
    log(`stopped: ${status}${reason ? ` (${reason})` : ""}`);
    if (deps.report)
      await deps.report(state.cycle, state).catch((e: Error) => log(`report failed: ${e.message}`));
    const good = options.untilGreen
      ? status === "green"
      : status !== "paused" && status !== "budget" && state.greenStreak > 0;
    return { state, exitCode: good ? 0 : 1 };
  };

  const nextCycle = () => {
    completed++;
    state.cycle++;
    state.step = "freeze";
    state.goals = [];
    persist();
  };

  persist();
  log(
    `cycle ${state.cycle}, step ${state.step}, budget $${options.budgetUsd} (spent $${state.spentUsd.toFixed(2)})`,
  );

  for (;;) {
    if (options.pauseSignal?.aborted || signal?.aborted)
      return stop("paused", "stopped by the user; run loop again to continue");
    if (completed >= options.maxCycles) return stop("max-cycles");
    const remaining = options.budgetUsd - state.spentUsd;
    if (remaining <= 0) return stop("budget", `spent $${state.spentUsd.toFixed(2)} of $${options.budgetUsd}`);

    try {
      switch (state.step) {
        case "freeze": {
          log(`cycle ${state.cycle}: freeze`);
          await deps.freeze({ cycle: state.cycle, sites: matrixSites, signal });
          state.step = "run";
          break;
        }
        case "run": {
          // A second green cycle reuses cached answers: same snapshot, same answers, same output, or it is not stable.
          const keepCache = state.greenStreak > 0;
          const firstRun = !hasBaseline(readBaseline(paths));
          const estimate = state.lastRunCostUsd ?? 0;
          if (estimate > 0 && remaining < estimate)
            return stop(
              "budget",
              `a matrix run costs about $${estimate.toFixed(2)}, $${remaining.toFixed(2)} left`,
            );
          log(
            `cycle ${state.cycle}: run${keepCache ? " (reusing cached answers)" : ""}${firstRun ? " with the holdout, for the baseline" : ""}`,
          );
          const matrix = await deps.run({
            cycle: state.cycle,
            sites: firstRun ? [...matrixSites, ...sites.holdout] : matrixSites,
            ...(options.stages ? { stages: options.stages } : {}),
            keepCache,
            coverageTarget: state.coverageTarget,
            budgetUsd: remaining,
            signal,
          });
          const cost = matrixCost(matrix);
          state.spentUsd += cost;
          state.lastRunCostUsd = cost;
          writeMatrix(paths, matrix);
          if (firstRun) writeBaseline(paths, { ...matrix, commit: deps.head?.() ?? matrix.commit });
          state.step = "inspect";
          break;
        }
        case "inspect": {
          const matrix = readCycleMatrix(paths, state.cycle);
          if (!matrix) {
            state.step = "run";
            break;
          }
          log(`cycle ${state.cycle}: inspect`);
          const repeat = state.greenStreak > 0 ? readCycleMatrix(paths, state.cycle - 1) : null;
          const reproducibility = repeat ? checkReproducibility(repeat, matrix) : null;
          if (reproducibility) writeReproducibility(paths, state.cycle, reproducibility);
          const file = await deps.inspect({ cycle: state.cycle, matrix, signal });
          const rules = readRules(paths);
          const lintResults = deps.lints ? await deps.lints(matrix) : await runLints(paths, appsOf(matrix));
          const findings = [...file.findings, ...lintFindings(lintResults, rules)];

          const merged: FindingsFile = { cycle: state.cycle, findings };
          writeJson(findingsFile(paths, state.cycle), merged);
          if (merged.findings.length > file.findings.length)
            writeFileSync(
              join(paths.cycleDir(state.cycle), "FINDINGS.md"),
              findingsMarkdown(merged, paths.cycleDir(state.cycle)),
            );
          const ran = {
            sites: Object.keys(matrix.sites),
            stages: [
              ...new Set(Object.values(matrix.sites).flatMap((stages) => Object.keys(stages))),
              "health",
              ...(repeat ? ["reproducibility"] : []),
            ],
          };
          writeRegistry(paths, mergeFindings(readRegistry(paths), merged, { ran }));

          const judged = matrixOnly(matrix, siteIds);
          const failing = failingHardGates(judged);
          const blocking = blockingFindings(merged, siteIds);
          const ratchet = ratchetCoverage(state.coverageTarget, coverage, judged, siteIds);
          if (ratchet.raised) log(`coverage target raised to ${ratchet.target}`);
          state.coverageTarget = ratchet.target;

          if (reproducibility && !reproducibility.ok) log(`cycle ${state.cycle}: not reproducible`);
          const green =
            siteIds.every((id) => id in judged.sites) &&
            !failing.length &&
            !blocking.length &&
            (reproducibility?.ok ?? true);
          if (green) {
            state.greenStreak++;
            log(`cycle ${state.cycle}: green (${state.greenStreak} of ${stable})`);
            if (deps.report)
              await deps.report(state.cycle, state).catch((e: Error) => log(`report failed: ${e.message}`));
            if (options.untilGreen && state.greenStreak >= stable) {
              state.step = "done";
              return stop("green");
            }
            nextCycle();
            continue;
          }
          state.greenStreak = 0;
          log(
            `cycle ${state.cycle}: ${failing.length} hard gates failing, ${blocking.length} blocking findings`,
          );
          state.step = "fix";
          break;
        }
        case "fix": {
          log(`cycle ${state.cycle}: fix`);
          const fixed = await deps.fix({
            cycle: state.cycle,
            max: fixMax,
            budgetUsd: Math.min(remaining, CYCLE_FIX_BUDGET_USD),
            signal,
          });
          state.spentUsd += fixed.spentUsd;
          state.goals = fixed.records.map((record) => record.goalId);
          if (!state.goals.length) {
            persist();
            return stop("paused", "no finding can be taken by a fixer: read NEEDS_HUMAN in the registry");
          }
          state.step = "verify";
          break;
        }
        case "verify": {
          log(`cycle ${state.cycle}: verify ${state.goals.length} goal(s)`);
          const verified = await deps.verify({ cycle: state.cycle, budgetUsd: remaining, signal });
          state.spentUsd += verified.spentUsd;
          persist();
          if (
            verified.pending.length &&
            (options.budgetUsd - state.spentUsd <= 0 || options.pauseSignal?.aborted)
          )
            break;
          state.step = "rules";
          break;
        }
        case "rules": {
          const problems = await deps.rules();
          if (problems.length) {
            persist();
            const summary = problems.map((p) => `${p.signature}: ${p.code}`).join(", ");
            return stop("paused", `rules check failed, a merged rule has lost its guard: ${summary}`);
          }
          if (deps.report)
            await deps.report(state.cycle, state).catch((e: Error) => log(`report failed: ${e.message}`));
          nextCycle();
          continue;
        }
        case "done":
          return stop("green");
      }
    } catch (error) {
      if (signal?.aborted) return stop("paused", "cancelled during the step; it runs again on resume");
      const reason = `${state.step} failed: ${(error as Error).message}`;
      return stop("paused", reason);
    }
    persist();
  }
}
