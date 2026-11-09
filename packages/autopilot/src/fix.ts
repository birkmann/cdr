/**
 * The fixers (§5.1): one goal per finding group, in its own worktree on `cdr/goal-autopilot-<signature>`, with a
 * generated task that carries the full evidence, the related rules and every earlier attempt with its reject reason.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { redact } from "@harness/core";
import type { CreateGoalRequest, GoalInfo } from "@harness/protocol";
import {
  isFixable,
  markFixing,
  mergeFindings,
  rankFindings,
  readJson,
  readRegistry,
  writeJson,
  writeRegistry,
} from "./registry.js";
import { readRules, relatedRules, ruleFileFor, signatureSlug } from "./rules.js";
import type {
  AutopilotPaths,
  Budgets,
  Finding,
  FindingsFile,
  FixAttempt,
  Registry,
  RegistryEntry,
  RuleEntry,
  SitesFile,
} from "./types.js";
import { DEFAULT_AUTOPILOT_CONFIG } from "./types.js";

/** Default for one cycle of fixers (§6.2). */
export const CYCLE_FIX_BUDGET_USD = 60;
export const DEFAULT_FIX_MAX = 5;

const EVIDENCE_FILE_LIMIT = 8_000;
const EVIDENCE_TOTAL_LIMIT = 60_000;
const LOG_LINES = 60;

/** What fixers and verification need from goals; `cli-loop.ts` backs it with `packages/core/src/goals.ts`. */
export interface GoalPort {
  create(req: CreateGoalRequest): GoalInfo;
  save(goal: GoalInfo): GoalInfo;
  get(id: string): GoalInfo | null;
  /** Create the goal's worktree on its branch, before the run, so evidence can be copied into it. */
  prepare(goal: GoalInfo): GoalInfo;
  run(id: string, signal?: AbortSignal): Promise<GoalInfo>;
  merge(id: string): GoalInfo;
  discard(id: string): GoalInfo;
}

export interface GoalRecord {
  goalId: string;
  signature: string;
  cycle: number;
  branch: string;
  finding: Finding;
  verdict?: "accepted" | "discarded";
  reason?: string;
  diffSummary?: string;
  /** Where the verdict was reached: `policy`, `guard`, `fast`, `slow`, `merge`, `accepted`. */
  decidedAt?: string;
  costUsd?: number;
}

export const goalsDir = (paths: AutopilotPaths): string => join(paths.state, "goals");
const goalFile = (paths: AutopilotPaths, id: string): string => join(goalsDir(paths), `${id}.json`);

export function writeGoalRecord(paths: AutopilotPaths, record: GoalRecord): void {
  writeJson(goalFile(paths, record.goalId), record);
}

export function readGoalRecord(paths: AutopilotPaths, id: string): GoalRecord | null {
  return readJson<GoalRecord | null>(goalFile(paths, id), null);
}

export function listGoalRecords(paths: AutopilotPaths, cycle?: number): GoalRecord[] {
  const dir = goalsDir(paths);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson<GoalRecord | null>(join(dir, name), null))
    .filter((r): r is GoalRecord => !!r && (cycle === undefined || r.cycle === cycle))
    .sort((a, b) => a.cycle - b.cycle || a.signature.localeCompare(b.signature));
}

export const findingsFile = (paths: AutopilotPaths, cycle: number): string =>
  join(paths.cycleDir(cycle), "findings.json");

export function readFindings(paths: AutopilotPaths, cycle: number): FindingsFile {
  return readJson<FindingsFile>(findingsFile(paths, cycle), { cycle, findings: [] });
}

/** The branch of §5.1, numbered when an earlier fix of the same signature left its branch behind. */
export function fixerBranch(signature: string, exists: (branch: string) => boolean): string {
  const wanted = `cdr/goal-autopilot-${signatureSlug(signature)}`;
  let branch = wanted;
  for (let i = 2; exists(branch); i++) branch = `${wanted}-${i}`;
  return branch;
}

const holdoutIds = (sites: SitesFile): string[] => sites.holdout.map((site) => site.id);

/** Hostnames and ids of the holdout, as they could appear in a message or a path. */
function holdoutNames(sites: SitesFile): string[] {
  const names = new Set<string>(holdoutIds(sites));
  for (const site of sites.holdout) {
    if (!site.url) continue;
    try {
      const host = new URL(site.url).hostname;
      names.add(host);
      names.add(host.replace(/^www\./, ""));
    } catch {
      /* a malformed holdout url is the loader's problem */
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
}

/** Replace the holdout's names, so a fixer never learns them from a message or a reject reason (§7). */
export function scrubHoldout(text: string, sites: SitesFile): string {
  let out = text;
  for (const name of holdoutNames(sites)) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`,
      "g",
    );
    out = out.replace(pattern, "holdout");
  }
  return out;
}

const mentionsHoldout = (path: string, sites: SitesFile): boolean =>
  holdoutIds(sites).some((id) => path.includes(`/${id}/`));

/** What a fixer may see of a finding: its matrix sites and evidence, or nothing when only the holdout showed it. */
export function withoutHoldout(finding: Finding, sites: SitesFile): Finding | null {
  const ids = new Set(holdoutIds(sites));
  const visible = finding.sites.filter((site) => !ids.has(site));
  if (!visible.length) return null;
  return {
    ...finding,
    sites: visible,
    message: scrubHoldout(finding.message, sites),
    evidence: finding.evidence.filter((path) => !mentionsHoldout(path, sites)),
  };
}

/** The groups this cycle's fixers take, in the order of §4.4, capped by `max`. */
export function selectGroups(
  file: FindingsFile,
  registry: Registry,
  sites: SitesFile,
  max: number,
  isGoalActive?: (goalId: string) => boolean,
): Finding[] {
  const visible = file.findings
    .filter((finding) => finding.status !== "fixed")
    .filter((finding) => isFixable(registry.entries[finding.signature], isGoalActive))
    .map((finding) => withoutHoldout(finding, sites))
    .filter((finding): finding is Finding => !!finding);
  return rankFindings(visible, registry).slice(0, Math.max(0, max));
}

export function acceptanceCriteria(finding: Pick<Finding, "signature">): string[] {
  return [
    "A regression test under packages/<pkg>/test/ fails on the base branch and passes on this branch; autopilot runs it on both.",
    "pnpm build, pnpm test and pnpm lint are green.",
    "The fix is generic: no hostname, site id or URL of the matrix anywhere under packages/.",
    "No gate threshold, mask or skip changed.",
    `The rule file ${ruleFileFor(finding.signature)} and its autopilot/rules.json entry exist and name the guard (the regression test, plus an output lint when the symptom can come from another code path).`,
    "The final message states the root cause and the change in a few lines, for the report.",
    "No new model call on the hot path, unless the finding says a deterministic fix is impossible.",
  ];
}

function readExcerpt(path: string, limit: number): string {
  const text = readFileSync(path, "utf8");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonl",
  ".log",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".yaml",
  ".yml",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** Text of the evidence: dossiers and bug bundles (their README and inputs) inline, up to a total limit. */
function renderEvidence(finding: Finding, copied: Map<string, string>): string {
  const parts: string[] = [];
  let left = EVIDENCE_TOTAL_LIMIT;
  const addFile = (path: string, title: string) => {
    if (left <= 0) return;
    const body = readExcerpt(path, Math.min(EVIDENCE_FILE_LIMIT, left));
    left -= body.length;
    parts.push(`#### ${title}\n\n\`\`\`\n${body}\n\`\`\``);
  };
  for (const evidence of finding.evidence) {
    if (!existsSync(evidence)) {
      parts.push(`- ${evidence} (not on disk)`);
      continue;
    }
    const local = copied.get(evidence);
    if (statSync(evidence).isDirectory()) {
      const names = readdirSync(evidence).sort();
      parts.push(
        `#### Bundle ${evidence}${local ? ` (copied to ${local})` : ""}\n\nFiles: ${names.join(", ")}`,
      );
      for (const name of names.filter(
        (n) => /readme|input/i.test(n) && TEXT_EXTENSIONS.has(extname(n).toLowerCase()),
      ))
        addFile(join(evidence, name), `${basename(evidence)}/${name}`);
    } else if (IMAGE_EXTENSIONS.has(extname(evidence).toLowerCase())) {
      parts.push(`- Crop: ${local ?? evidence}`);
    } else if (TEXT_EXTENSIONS.has(extname(evidence).toLowerCase())) {
      addFile(evidence, local ?? evidence);
    } else {
      parts.push(`- ${local ?? evidence}`);
    }
  }
  return parts.join("\n\n");
}

function logExcerpts(paths: AutopilotPaths, cycle: number, finding: Finding): string {
  if (finding.stage === "health" || finding.stage === "reproducibility") return "";
  const out: string[] = [];
  for (const site of finding.sites) {
    const stageDir = paths.stageDir(cycle, site, finding.stage);
    const log = join(stageDir, "log.txt");
    if (existsSync(log)) {
      const lines = readFileSync(log, "utf8").trimEnd().split("\n");
      out.push(
        `#### ${site}: last ${Math.min(LOG_LINES, lines.length)} lines of the stage log\n\n\`\`\`\n${lines.slice(-LOG_LINES).join("\n")}\n\`\`\``,
      );
    }
    const errors = join(stageDir, "errors.json");
    if (existsSync(errors))
      out.push(
        `#### ${site}: errors.json\n\n\`\`\`json\n${readExcerpt(errors, EVIDENCE_FILE_LIMIT)}\n\`\`\``,
      );
  }
  return out.join("\n\n");
}

function renderAttempts(entry: RegistryEntry | undefined, sites: SitesFile): string {
  if (!entry?.attempts.length) return "None. This is the first attempt on this signature.";
  return entry.attempts
    .map((attempt: FixAttempt) =>
      [
        `- ${attempt.goalId} (cycle ${attempt.cycle}, ${attempt.verdict}): ${scrubHoldout(attempt.reason, sites)}`,
        attempt.diffSummary
          ? `  Changed: ${scrubHoldout(attempt.diffSummary, sites).replace(/\n/g, "; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

function renderRules(rules: RuleEntry[]): string {
  if (!rules.length) return "None match this finding.";
  return rules
    .map(
      (rule) =>
        `- ${rule.signature} (${rule.file})\n  Invariant: ${rule.invariant}\n  Guards: ${rule.guards
          .map((g) => (g.kind === "test" ? `${g.file} "${g.name}"` : g.file))
          .join(", ")}`,
    )
    .join("\n");
}

export interface TaskInput {
  finding: Finding;
  evidence: string;
  logs: string;
  rules: RuleEntry[];
  entry: RegistryEntry | undefined;
  sites: SitesFile;
  localEvidence: string[];
  /** The fixer's own goal, so it can run the fast lane on itself. */
  goalId: string;
}

/** The task a fixer gets. Secrets are redacted, and the holdout's names are removed on the way in. */
export function renderTask({
  finding,
  evidence,
  logs,
  rules,
  entry,
  sites,
  localEvidence,
  goalId,
}: TaskInput): string {
  const slug = signatureSlug(finding.signature);
  const text = [
    `Finding ${finding.signature}, rank ${finding.rank}, status ${finding.status}, on: ${finding.sites.join(", ")}.`,
    `Message: ${finding.message}`,
    finding.rule ? `It violates the rule ${finding.rule}.` : "",
    "## Before you start",
    "Load the skills autopilot-fix, diagnosing-bugs, tdd and implement with load_skill. autopilot-fix holds the method and points at the runbook of each stage. Run pnpm install and pnpm build first: this worktree starts without node_modules.",
    "## Scope",
    "You may edit packages/**, templates, skills and docs.",
    "You may never edit run outputs (.harness/**), autopilot/sites.yaml, autopilot/baseline.json, autopilot/registry.json, or thresholds in packages/protocol defaults or mirror-core contracts. A deterministic policy check discards the branch if you do, without further review.",
    "## Evidence",
    evidence || "No evidence files were recorded.",
    localEvidence.length
      ? `Copies you can open from this worktree:\n${localEvidence.map((p) => `- ${p}`).join("\n")}`
      : "",
    logs ? `## Stage logs\n\n${logs}` : "",
    "## Related rules",
    renderRules(rules),
    "## Earlier attempts on this signature",
    "Do not repeat what already failed. Each line is what a previous fixer tried and why it was rejected.",
    renderAttempts(entry, sites),
    "## The rule you must leave behind",
    `Write ${ruleFileFor(finding.signature)} in the format of docs/plans/autopilot-self-improving-pipeline.md §5.4 and add an entry with the same fields to the "rules" array of autopilot/rules.json:`,
    "```json",
    JSON.stringify(
      {
        signature: finding.signature,
        file: ruleFileFor(finding.signature),
        seen: [],
        symptom: "…",
        rootCause: "…",
        invariant: "…",
        guards: [{ kind: "test", file: "packages/<pkg>/test/<name>.test.ts", name: "<exact test name>" }],
      },
      null,
      2,
    ),
    "```",
    `Run "pnpm autopilot rules --check" before you finish. To see whether the finding is gone, run "pnpm autopilot verify --fast --goal ${goalId}" after pnpm build. Branch slug: ${slug}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return redact(scrubHoldout(text, sites));
}

/** Copy evidence into the worktree's ignored `.harness`: a fixer's tools are confined to its worktree. */
function copyEvidence(finding: Finding, worktree: string): Map<string, string> {
  const relativeDir = ".harness/autopilot-evidence";
  const copied = new Map<string, string>();
  let index = 0;
  for (const evidence of finding.evidence) {
    if (!existsSync(evidence) || statSync(evidence).isDirectory()) continue;
    const name = `${String(index++).padStart(2, "0")}-${basename(evidence)}`;
    mkdirSync(join(worktree, relativeDir), { recursive: true });
    copyFileSync(evidence, join(worktree, relativeDir, name));
    copied.set(evidence, `${relativeDir}/${name}`);
  }
  return copied;
}

export interface FixOptions {
  cycle: number;
  max?: number;
  /** Hard cap for this fix step, across all its goals. */
  budgetUsd?: number;
  model?: string;
  dryRun?: boolean;
  budgets?: Pick<Budgets, "fixerUsd" | "fixerMs">;
  signal?: AbortSignal;
}

export interface FixDeps {
  paths: AutopilotPaths;
  sites: SitesFile;
  goals: GoalPort;
  branchExists(branch: string): boolean;
  baseBranch(): string | null;
  log(line: string): void;
}

export interface FixResult {
  records: GoalRecord[];
  spentUsd: number;
  /** Signatures left for a later cycle: over `--max`, or no budget left. */
  deferred: string[];
  /** `--dry-run`: the task files written instead of goals. */
  drafts: string[];
}

/**
 * Start one goal per finding group, one after another. Each goal's cost budget is what is left of `budgetUsd`, so the
 * step cannot overspend. Signatures that already have a goal in this cycle are skipped, which makes a resume cheap.
 */
export async function runFix(options: FixOptions, deps: FixDeps): Promise<FixResult> {
  const { paths, sites, goals, log } = deps;
  const max = options.max ?? DEFAULT_FIX_MAX;
  const budgetUsd = options.budgetUsd ?? CYCLE_FIX_BUDGET_USD;
  const budgets = options.budgets ?? DEFAULT_AUTOPILOT_CONFIG.budgets;

  const file = readFindings(paths, options.cycle);
  // Idempotent for one cycle, so `inspect` then `fix` by hand behaves like the loop.
  const registry = mergeFindings(readRegistry(paths), file);
  const rules = readRules(paths);
  const existing = listGoalRecords(paths, options.cycle);
  const doneThisCycle = new Set(existing.map((record) => record.signature));
  const isGoalActive = (id: string) => goals.get(id)?.status === "running";
  const groups = selectGroups(file, registry, sites, max, isGoalActive);

  const result: FixResult = { records: [...existing], spentUsd: 0, deferred: [], drafts: [] };
  const baseBranch = deps.baseBranch();

  for (const finding of groups) {
    if (doneThisCycle.has(finding.signature)) continue;
    const task = (copied: Map<string, string>, goalId: string) =>
      renderTask({
        finding,
        evidence: renderEvidence(finding, copied),
        logs: logExcerpts(paths, options.cycle, finding),
        rules: relatedRules(rules, finding),
        entry: registry.entries[finding.signature],
        sites,
        localEvidence: [...copied.values()],
        goalId,
      });

    if (options.dryRun) {
      const draft = join(
        paths.cycleDir(options.cycle),
        "fix-drafts",
        `${signatureSlug(finding.signature)}.md`,
      );
      mkdirSync(join(paths.cycleDir(options.cycle), "fix-drafts"), { recursive: true });
      const body = [
        `# ${finding.signature}`,
        "",
        task(new Map(), "<goal id>"),
        "",
        "## Acceptance criteria",
        "",
        ...acceptanceCriteria(finding).map((c, i) => `${i + 1}. ${c}`),
        "",
      ].join("\n");
      writeFileSync(draft, body);
      result.drafts.push(draft);
      log(`dry run: ${finding.signature} → ${draft}`);
      continue;
    }

    const left = budgetUsd - result.spentUsd;
    if (options.signal?.aborted || left <= 0) {
      result.deferred.push(finding.signature);
      continue;
    }
    if (!baseBranch) throw new Error("cannot start fixers: the checkout is on a detached HEAD");

    const created = goals.create({
      repo: paths.root,
      title: `autopilot ${finding.signature}`,
      description: "",
      acceptance: acceptanceCriteria(finding),
      baseBranch,
      budget: { maxCost: Math.min(budgets.fixerUsd, left), timeoutMs: budgets.fixerMs, maxRounds: 1 },
      policy: { permissionMode: "auto" },
      ...(options.model
        ? { models: { executor: options.model, planner: options.model, reviewer: options.model } }
        : {}),
      deliverable: "branch",
    });
    const branch = fixerBranch(finding.signature, deps.branchExists);
    const prepared = goals.prepare(goals.save({ ...created, branch }));
    const copied = prepared.worktree ? copyEvidence(finding, prepared.worktree) : new Map<string, string>();
    const goal = goals.save({ ...prepared, description: task(copied, prepared.id) });

    markFixing(registry, finding.signature, goal.id);
    writeRegistry(paths, registry);
    const record: GoalRecord = {
      goalId: goal.id,
      signature: finding.signature,
      cycle: options.cycle,
      branch,
      finding,
    };
    writeGoalRecord(paths, record);
    log(`fixer ${goal.id}: ${finding.signature} on ${branch} (budget $${goal.budget.maxCost?.toFixed(2)})`);

    const finished = await goals.run(goal.id, options.signal);
    const cost = finished.usage.cost;
    result.spentUsd += cost;
    const saved: GoalRecord = { ...record, costUsd: cost };
    writeGoalRecord(paths, saved);
    result.records.push(saved);
    log(`fixer ${goal.id}: ${finished.status} ($${cost.toFixed(2)})`);
  }

  const chosen = new Set(groups.map((finding) => finding.signature));
  for (const finding of selectGroups(file, registry, sites, Number.MAX_SAFE_INTEGER, isGoalActive))
    if (!chosen.has(finding.signature)) result.deferred.push(finding.signature);
  return result;
}
