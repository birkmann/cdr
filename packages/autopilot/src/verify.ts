/**
 * Verify lanes and the accept rule (§5.2). Each candidate is checked in order of cost: the policy check of §5.5, the
 * rule and guard, the regression test on base and branch, build/test/lint, the fast lane, the slow lane. Any failure
 * discards the branch and records the attempt. Candidates go one at a time, each on top of the previous merge.
 */
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git as runGit } from "@harness/core";
import type { GoalInfo } from "@harness/protocol";
import { decideCandidate, type CandidateDecision } from "./decide.js";
import {
  listGoalRecords,
  readFindings,
  readGoalRecord,
  scrubHoldout,
  writeGoalRecord,
  type GoalPort,
  type GoalRecord,
} from "./fix.js";
import { checkPolicy, summarizeDiff } from "./policy.js";
import { readJson, readRegistry, recordAttempt, registryFile, writeJson, writeRegistry } from "./registry.js";
import {
  checkRules,
  readRules,
  renderRuleMarkdown,
  ruleFileFor,
  ruleForSignature,
  rulesFile,
  unionRulesJson,
  writeRules,
} from "./rules.js";
import { autopilotPaths } from "./paths.js";
import type {
  AutopilotPaths,
  FindingsFile,
  MatrixResult,
  RuleEntry,
  SiteConfig,
  SitesFile,
  StageName,
} from "./types.js";
import { STAGE_ORDER } from "./types.js";

export interface CommandResult {
  ok: boolean;
  output: string;
}

/** Everything verify runs as a process. Tests and the fixture end-to-end substitute their own. */
export interface CommandPort {
  install(cwd: string): Promise<CommandResult>;
  build(cwd: string): Promise<CommandResult>;
  test(cwd: string): Promise<CommandResult>;
  lint(cwd: string): Promise<CommandResult>;
  /** Run one named test; must fail when the test fails. */
  testOne(cwd: string, file: string, name: string): Promise<CommandResult>;
}

export interface GitPort {
  currentBranch(): string | null;
  branchExists(branch: string): boolean;
  head(ref: string): string | null;
  /** `base...branch`: what the branch changed since it left base. */
  diff(base: string, branch: string): string;
  isAncestor(ancestor: string, descendant: string): boolean;
  /** Merge `base` into the goal's worktree. Conflicts only in `autopilot/rules.json` are resolved as a union. */
  syncWithBase(worktree: string, base: string): { ok: boolean; conflicts?: string[]; error?: string };
  /** A throwaway checkout of `ref` for the regression test on base; removed afterwards. */
  withCheckout<T>(ref: string, work: (dir: string) => Promise<T>): Promise<T>;
  /** Commit only these repository-relative paths in the main checkout, if they changed. */
  commitPaths(paths: string[], message: string): string | null;
}

export interface LaneInput {
  goal: GoalInfo;
  record: GoalRecord;
  worktree: string;
  sites: SiteConfig[];
  /** Absent: every stage. */
  stages?: StageName[];
  cycle: number;
  signal?: AbortSignal;
}

export interface LaneResult {
  matrix: MatrixResult;
  findings: FindingsFile;
  costUsd?: number;
}

export interface LanePort {
  fast(input: LaneInput): Promise<LaneResult>;
  slow(input: LaneInput): Promise<LaneResult>;
}

export interface VerifyDeps {
  paths: AutopilotPaths;
  sites: SitesFile;
  goals: GoalPort;
  git: GitPort;
  commands: CommandPort;
  lanes: LanePort;
  log(line: string): void;
  /** `loop --sites`: the slow lane runs these and the holdout, not every site of `sites.yaml`. */
  matrixSites?: SiteConfig[];
}

export interface VerifyOptions {
  cycle: number;
  /** One goal; otherwise every goal of the cycle that has no verdict yet. */
  goalId?: string;
  /** The fixer's own check: policy and fast lane, no merge, no discard, nothing recorded. */
  fastOnly?: boolean;
  budgetUsd?: number;
  signal?: AbortSignal;
}

export interface Verdict {
  goalId: string;
  signature: string;
  verdict: "accepted" | "discarded";
  reason: string;
  decidedAt: string;
}

export interface VerifyResult {
  verdicts: Verdict[];
  /** Goals not judged yet: budget stop or still running. */
  pending: string[];
  spentUsd: number;
  /** `fastOnly`: the fast lane's outcome. */
  fast?: { ok: boolean; reason: string };
}

export const baselineFile = (paths: AutopilotPaths): string => join(paths.committed, "baseline.json");

export const emptyBaseline = (): MatrixResult => ({ cycle: 0, commit: "", sites: {} });

export function readBaseline(paths: AutopilotPaths): MatrixResult {
  return readJson<MatrixResult>(baselineFile(paths), emptyBaseline());
}

export function writeBaseline(paths: AutopilotPaths, baseline: MatrixResult): void {
  writeJson(baselineFile(paths), baseline);
}

export const hasBaseline = (baseline: MatrixResult): boolean => Object.keys(baseline.sites).length > 0;

export function matrixFile(paths: AutopilotPaths, cycle: number): string {
  return join(paths.cycleDir(cycle), "matrix.json");
}

export function readCycleMatrix(paths: AutopilotPaths, cycle: number): MatrixResult | null {
  return readJson<MatrixResult | null>(matrixFile(paths, cycle), null);
}

export function writeMatrix(paths: AutopilotPaths, matrix: MatrixResult): void {
  writeJson(matrixFile(paths, matrix.cycle), matrix);
}

/** The rule entry and guards a fix must leave behind (§5.1 criterion 5), read from the candidate's worktree. */
export function ruleProblems(worktree: string, signature: string): { rule?: RuleEntry; problems: string[] } {
  const paths = autopilotPaths(worktree);
  const rules = readRules(paths);
  const rule = ruleForSignature(rules, signature);
  if (!rule) return { problems: [`autopilot/rules.json has no entry for ${signature}`] };
  const problems = checkRules(worktree, [rule]).map((p) => `${p.code}: ${p.detail}`);
  if (!rule.guards?.some((g) => g.kind === "test")) problems.push("the rule names no regression test");
  if (!rule.rootCause?.trim()) problems.push("the rule states no root cause");
  return { rule, problems };
}

function affectedStages(record: GoalRecord): StageName[] | undefined {
  const stage = record.finding.stage;
  return (STAGE_ORDER as string[]).includes(stage) ? [stage as StageName] : undefined;
}

function fastLaneSites(record: GoalRecord, sites: SitesFile): SiteConfig[] {
  const origin = sites.sites.find((site) => record.finding.sites.includes(site.id));
  const fixture = sites.holdout.find((site) => site.fixture);
  return [origin, fixture].filter((site): site is SiteConfig => !!site);
}

/** The regression test must fail on base and pass on the branch (§5.1 criterion 1). */
async function regressionTest(
  rule: RuleEntry,
  goal: GoalInfo,
  worktree: string,
  deps: Pick<VerifyDeps, "git" | "commands">,
): Promise<string | null> {
  const guard = rule.guards.find((g) => g.kind === "test");
  if (guard?.kind !== "test") return "the rule names no regression test";
  const onBranch = await deps.commands.testOne(worktree, guard.file, guard.name);
  if (!onBranch.ok) return `the regression test fails on the branch: ${tail(onBranch.output)}`;
  return deps.git.withCheckout(goal.baseBranch, async (dir) => {
    const target = join(dir, guard.file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(worktree, guard.file), target);
    const installed = await deps.commands.install(dir);
    if (!installed.ok) return `install failed on the base checkout: ${tail(installed.output)}`;
    const onBase = await deps.commands.testOne(dir, guard.file, guard.name);
    return onBase.ok
      ? `the regression test also passes on ${goal.baseBranch}: it does not guard this bug`
      : null;
  });
}

const tail = (text: string, limit = 800): string => (text.length <= limit ? text : `…${text.slice(-limit)}`);

interface Judged {
  verdict: "accepted" | "discarded";
  reason: string;
  decidedAt: string;
  rule?: RuleEntry;
  matrix?: MatrixResult;
  diffSummary?: string;
  costUsd: number;
}

const discarded = (decidedAt: string, reason: string, costUsd = 0, diffSummary?: string): Judged => ({
  verdict: "discarded",
  reason,
  decidedAt,
  costUsd,
  ...(diffSummary ? { diffSummary } : {}),
});

function laneVerdict(
  lane: "fast" | "slow",
  result: LaneResult,
  baseline: MatrixResult,
  record: GoalRecord,
  baselineFindings: FindingsFile,
): CandidateDecision {
  return decideCandidate({
    baseline,
    candidate: result.matrix,
    findings: result.findings,
    baselineFindings,
    target: { signature: record.signature, sites: record.finding.sites },
    scope: lane === "fast" ? { candidateOnly: true } : undefined,
  });
}

async function judge(
  record: GoalRecord,
  goal: GoalInfo,
  options: VerifyOptions,
  deps: VerifyDeps,
  budgetLeft: () => number,
): Promise<Judged | { pendingCostUsd: number }> {
  const { git, commands, lanes, paths, sites } = deps;
  const worktree = goal.worktree;
  if (!goal.branch || !worktree || !existsSync(worktree))
    return discarded("start", `the goal has no worktree (status ${goal.status})`);

  const base = goal.baseBranch;
  const diff = git.diff(base, goal.branch);
  if (!diff.trim()) return discarded("policy", "the goal changed nothing");
  const diffSummary = summarizeDiff(diff);

  const policy = checkPolicy(diff, sites);
  if (!policy.ok) return discarded("policy", `policy check failed:\n${policy.reason}`, 0, diffSummary);

  // On top of the previous merge: everything below judges the code that would actually land.
  if (!git.isAncestor(base, goal.branch)) {
    const synced = git.syncWithBase(worktree, base);
    if (!synced.ok)
      return discarded(
        "merge",
        `conflict with an earlier merge: ${synced.conflicts?.join(", ") ?? synced.error ?? "unknown"}`,
        0,
        diffSummary,
      );
  }

  const { rule, problems } = ruleProblems(worktree, record.signature);
  if (problems.length || !rule)
    return discarded("guard", `the rule or its guard is missing: ${problems.join("; ")}`, 0, diffSummary);

  const installed = await commands.install(worktree);
  if (!installed.ok) return discarded("build", `install failed: ${tail(installed.output)}`, 0, diffSummary);

  const regression = await regressionTest(rule, goal, worktree, deps);
  if (regression) return discarded("guard", regression, 0, diffSummary);

  for (const step of ["build", "test", "lint"] as const) {
    const result = await commands[step](worktree);
    if (!result.ok) return discarded("build", `pnpm ${step} failed: ${tail(result.output)}`, 0, diffSummary);
  }

  const baseline = readBaseline(paths);
  const baselineFindings = readFindings(paths, record.cycle);

  if (budgetLeft() <= 0) return { pendingCostUsd: 0 };
  const fast = await lanes.fast({
    goal,
    record,
    worktree,
    sites: fastLaneSites(record, sites),
    stages: affectedStages(record),
    cycle: options.cycle,
    signal: options.signal,
  });
  let costUsd = fast.costUsd ?? 0;
  const fastDecision = laneVerdict("fast", fast, baseline, record, baselineFindings);
  if (!fastDecision.accepted)
    return discarded("fast", `fast lane: ${fastDecision.reason}`, costUsd, diffSummary);

  if (budgetLeft() - costUsd <= 0) return { pendingCostUsd: costUsd };
  const slow = await lanes.slow({
    goal,
    record,
    worktree,
    sites: [...(deps.matrixSites ?? sites.sites), ...sites.holdout],
    cycle: options.cycle,
    signal: options.signal,
  });
  costUsd += slow.costUsd ?? 0;
  const slowDecision = laneVerdict("slow", slow, baseline, record, baselineFindings);
  if (!slowDecision.accepted)
    return discarded("slow", `slow lane: ${slowDecision.reason}`, costUsd, diffSummary);

  return {
    verdict: "accepted",
    reason: slowDecision.reason,
    decidedAt: "accepted",
    rule,
    matrix: slow.matrix,
    diffSummary,
    costUsd,
  };
}

/** Fill in what only the accepting side knows, in `rules.json` and the rule file's second line. */
function stampRule(paths: AutopilotPaths, rule: RuleEntry, record: GoalRecord): void {
  const stamped: RuleEntry = {
    ...rule,
    seen: rule.seen.length
      ? rule.seen
      : record.finding.sites.map((site) => `${site} (cycle ${record.cycle})`),
    fixedCycle: record.cycle,
    goalId: record.goalId,
  };
  const rules = readRules(paths).filter((r) => r.signature !== rule.signature);
  writeRules(paths, [...rules, stamped]);
  const file = join(paths.root, rule.file);
  if (existsSync(file)) {
    const header = renderRuleMarkdown(stamped).split("\n")[1] ?? "";
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines.length > 1 && !lines[1]!.startsWith("#")) lines[1] = header;
    else lines.splice(1, 0, header);
    writeFileSync(file, lines.join("\n"));
  }
}

function deliver(record: GoalRecord, judged: Judged, deps: VerifyDeps): Judged {
  const { goals, paths } = deps;
  if (judged.verdict === "accepted") {
    try {
      goals.merge(record.goalId);
    } catch (error) {
      return {
        ...judged,
        verdict: "discarded",
        decidedAt: "merge",
        reason: `merge failed: ${(error as Error).message}`,
      };
    }
    if (judged.matrix)
      writeBaseline(paths, { ...judged.matrix, cycle: record.cycle, commit: deps.git.head("HEAD") ?? "" });
    if (judged.rule) stampRule(paths, judged.rule, record);
  }
  return judged;
}

/** Judge every candidate of the cycle, one at a time. */
export async function verifyGoals(options: VerifyOptions, deps: VerifyDeps): Promise<VerifyResult> {
  const { paths, goals, log, sites } = deps;
  const records = options.goalId
    ? [readGoalRecord(paths, options.goalId)].filter((r): r is GoalRecord => !!r)
    : listGoalRecords(paths, options.cycle)
        .filter((r) => !r.verdict)
        .sort((a, b) => a.finding.rank - b.finding.rank);
  const result: VerifyResult = { verdicts: [], pending: [], spentUsd: 0 };
  const budgetLeft = () => (options.budgetUsd ?? Number.POSITIVE_INFINITY) - result.spentUsd;
  if (options.goalId && !records.length) throw new Error(`no autopilot goal ${options.goalId}`);

  if (options.fastOnly) {
    const record = records[0];
    if (!record) throw new Error("no goal to check: give --goal");
    const goal = goals.get(record.goalId);
    if (!goal?.worktree || !goal.branch) throw new Error(`goal ${record.goalId} has no worktree`);
    const policy = checkPolicy(deps.git.diff(goal.baseBranch, goal.branch), sites);
    if (!policy.ok) {
      result.fast = { ok: false, reason: `policy check failed:\n${policy.reason}` };
      return result;
    }
    const lane = await deps.lanes.fast({
      goal,
      record,
      worktree: goal.worktree,
      sites: fastLaneSites(record, sites),
      stages: affectedStages(record),
      cycle: options.cycle,
      signal: options.signal,
    });
    const decision = laneVerdict(
      "fast",
      lane,
      readBaseline(paths),
      record,
      readFindings(paths, record.cycle),
    );
    result.fast = { ok: decision.accepted, reason: scrubHoldout(decision.reason, sites) };
    return result;
  }

  for (const record of records) {
    if (options.signal?.aborted) {
      result.pending.push(record.goalId);
      continue;
    }
    const goal = goals.get(record.goalId);
    if (!goal) {
      const reason = "the goal no longer exists";
      finalize(record, { verdict: "discarded", reason, decidedAt: "start", costUsd: 0 }, deps, result);
      continue;
    }
    if (goal.status === "running" || goal.status === "draft" || goal.status === "scheduled") {
      result.pending.push(record.goalId);
      continue;
    }
    if (goal.status === "done" || goal.status === "discarded") continue;
    const judged = await judge(record, goal, options, deps, budgetLeft);
    if ("pendingCostUsd" in judged) {
      result.spentUsd += judged.pendingCostUsd;
      result.pending.push(record.goalId);
      log(`${record.goalId}: budget reached, left for the next verify`);
      continue;
    }
    const delivered = deliver(record, judged, deps);
    result.spentUsd += judged.costUsd;
    if (delivered.verdict === "discarded") {
      try {
        goals.discard(record.goalId);
      } catch (error) {
        log(`${record.goalId}: could not discard: ${(error as Error).message}`);
      }
    }
    finalize(record, delivered, deps, result);
    // Before the next candidate: the next merge needs a clean rules.json, and this verdict must not be lost to a crash.
    commitBookkeeping(paths, deps.git, options.cycle, log);
  }
  return result;
}

function finalize(record: GoalRecord, judged: Judged, deps: VerifyDeps, result: VerifyResult): void {
  const { paths, sites, log } = deps;
  const registry = readRegistry(paths);
  // The committed registry and fixer tasks never name the holdout; the goal record under .harness keeps the detail.
  recordAttempt(
    registry,
    record.signature,
    {
      goalId: record.goalId,
      cycle: record.cycle,
      verdict: judged.verdict,
      reason: scrubHoldout(judged.reason, sites),
      ...(judged.diffSummary ? { diffSummary: judged.diffSummary } : {}),
    },
    judged.verdict === "accepted" ? ruleFileFor(record.signature) : undefined,
  );
  writeRegistry(paths, registry);
  writeGoalRecord(paths, {
    ...record,
    verdict: judged.verdict,
    reason: judged.reason,
    decidedAt: judged.decidedAt,
    ...(judged.diffSummary ? { diffSummary: judged.diffSummary } : {}),
    costUsd: (record.costUsd ?? 0) + judged.costUsd,
  });
  result.verdicts.push({
    goalId: record.goalId,
    signature: record.signature,
    verdict: judged.verdict,
    reason: judged.reason,
    decidedAt: judged.decidedAt,
  });
  log(`${record.goalId}: ${judged.verdict} at ${judged.decidedAt}: ${judged.reason.split("\n")[0]}`);
}

/** Registry, baseline and stamped rules are committed files; only those paths go into this commit. */
function commitBookkeeping(
  paths: AutopilotPaths,
  git: GitPort,
  cycle: number,
  log: (line: string) => void,
): void {
  const relative = (file: string) => file.slice(paths.root.length + 1);
  const commit = git.commitPaths(
    [
      relative(registryFile(paths)),
      relative(baselineFile(paths)),
      relative(rulesFile(paths)),
      "autopilot/rules",
    ],
    `autopilot: record verdicts of cycle ${cycle}`,
  );
  if (commit) log(`bookkeeping committed: ${commit}`);
}

/** `git` for the real repository. */
export function realGit(root: string): GitPort {
  const git = (cwd: string, args: string[]) => runGit(cwd, args);
  const identity = (cwd: string): string[] => [
    ...(git(cwd, ["config", "user.name"]).out.trim() ? [] : ["-c", "user.name=CDR"]),
    ...(git(cwd, ["config", "user.email"]).out.trim() ? [] : ["-c", "user.email=cdr@localhost"]),
  ];
  return {
    currentBranch: () => {
      const r = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return r.ok ? r.out.trim() : null;
    },
    branchExists: (branch) => git(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).ok,
    head: (ref) => {
      const r = git(root, ["rev-parse", ref]);
      return r.ok ? r.out.trim() : null;
    },
    diff: (base, branch) => git(root, ["diff", `${base}...${branch}`]).out,
    isAncestor: (ancestor, descendant) => git(root, ["merge-base", "--is-ancestor", ancestor, descendant]).ok,
    syncWithBase: (worktree, base) => {
      const merged = git(worktree, [...identity(worktree), "merge", "--no-edit", base]);
      if (merged.ok) return { ok: true };
      const conflicts = git(worktree, ["diff", "--name-only", "--diff-filter=U"])
        .out.split("\n")
        .filter(Boolean);
      if (conflicts.length === 1 && conflicts[0] === "autopilot/rules.json") {
        const ours = git(worktree, ["show", ":2:autopilot/rules.json"]);
        const theirs = git(worktree, ["show", ":3:autopilot/rules.json"]);
        const union = ours.ok && theirs.ok ? unionRulesJson(ours.out, theirs.out) : null;
        if (union !== null) {
          writeFileSync(join(worktree, "autopilot/rules.json"), union);
          git(worktree, ["add", "autopilot/rules.json"]);
          if (git(worktree, [...identity(worktree), "commit", "--no-edit"]).ok) return { ok: true };
        }
      }
      git(worktree, ["merge", "--abort"]);
      return { ok: false, conflicts: conflicts.length ? conflicts : undefined, error: merged.err.trim() };
    },
    withCheckout: async (ref, work) => {
      const parent = mkdtempSync(join(tmpdir(), "cdr-autopilot-base-"));
      const dir = join(parent, "base");
      const added = git(root, ["worktree", "add", "--detach", dir, ref]);
      if (!added.ok) throw new Error(`could not check out ${ref}: ${added.err.trim()}`);
      try {
        return await work(dir);
      } finally {
        git(root, ["worktree", "remove", "--force", dir]);
        rmSync(parent, { recursive: true, force: true });
      }
    },
    commitPaths: (paths, message) => {
      const existing = paths.filter((p) => existsSync(join(root, p)));
      if (!existing.length) return null;
      git(root, ["add", "--", ...existing]);
      const staged = git(root, ["diff", "--cached", "--name-only", "--", ...existing]).out.trim();
      if (!staged) return null;
      const committed = git(root, [...identity(root), "commit", "-m", message, "--", ...existing]);
      if (!committed.ok) return null;
      return git(root, ["rev-parse", "HEAD"]).out.trim();
    },
  };
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-200_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}

/** The repository's own commands, in a worktree. */
export function pnpmCommands(timeoutMs = 45 * 60_000): CommandPort {
  const pnpm = (cwd: string, ...args: string[]) => run("pnpm", args, cwd, timeoutMs);
  return {
    install: (cwd) => pnpm(cwd, "install", "--frozen-lockfile", "--prefer-offline"),
    build: (cwd) => pnpm(cwd, "build"),
    test: (cwd) => pnpm(cwd, "test"),
    lint: (cwd) => pnpm(cwd, "lint"),
    testOne: (cwd, file, name) =>
      pnpm(cwd, "exec", "vitest", "run", file, "-t", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  };
}
