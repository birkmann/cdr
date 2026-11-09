/**
 * `@cmp/autofix` contract (docs/DEEPSEEK_ONLY_PLAN.md §4). SHARED BY THREE WORKSTREAMS — additive changes only, note
 * them in the plan's changelog.
 *
 * A handler turns one open task (an Issue with a stable code) into ranked candidate patches. Patches only touch DATA
 * files (mapping/*.yaml, mapping/profiles.yaml, design/overrides/**, sites/<site>.yaml crawl.mask proposals) — never
 * pipeline code. The loop (loop.ts) applies a candidate to the workspace, re-runs the minimal steps, compares metrics
 * and keeps or rolls back the patch.
 */
import type { Issue, LlmClient, Logger, SiteConfig, StepName, Workspace } from "@harness/mirror-core";

/** One TASKS.md item / actionable issue picked from reports/*.json and verify/*.json. */
export interface AutofixTask {
  /** stable id: `${code}:${ref ?? ""}` (+ viewport for visual tasks) */
  id: string;
  code: string;
  ref?: string;
  message: string;
  severity: Issue["severity"];
  /** report the issue came from, e.g. "transform", "verify:visual" */
  source: string;
  /** free-form extra data the producing check attached (url, viewport, ccmId …) */
  data?: Record<string, unknown>;
}

/** A file write. `path` is workspace-relative unless it starts with "sites/" or "packages/" (repo-relative). */
export interface FilePatch {
  path: string;
  /** full new content; null = delete the file */
  content: string | null;
}

/** Steps to re-run after applying a patch, in order. "build" = `next build` + restart of the app under test. */
export type RerunStep = StepName | "build";

export interface VerifyScope {
  checks: string[]; // e.g. ["visual"], ["content", "fidelity"]
  urls?: string[]; // limit to these paths (default: all site urls)
  viewports?: string[]; // limit to these viewport names (default: all)
}

export interface Candidate {
  /** short human-readable description, e.g. "profile slot eyebrow=.statement__eyebrow for statement_component" */
  title: string;
  /** why the model / rule believes this fixes the task (kept in the attempt log, shown in REPORT.md) */
  rationale?: string;
  files: FilePatch[];
  rerun: RerunStep[];
  /**
   * (W1-C, additive, requested by W1-B) extra step options per re-run step, merged over the CLI defaults, e.g.
   * `{ "design-extract": { applyOverridesOnly: true } }` (design fast path, no re-crawl / re-mining).
   */
  stepOptions?: Partial<Record<RerunStep, Record<string, unknown>>>;
  verify?: VerifyScope;
  /** "llm" when DeepSeek produced it, "rule" for deterministic candidates */
  origin: "llm" | "rule";
}

/**
 * Metrics the loop compares before/after a candidate. Higher-is-better values are normalised so that "improved" means
 * `after.primary > before.primary` and no gate in `after.gates` flips from pass to fail.
 */
export interface Metrics {
  /** the handler's target metric (e.g. covered-text ratio, parity of the failing shot) */
  primary: number;
  /** every gate of verify/summary.json + ccm.valid: id -> pass */
  gates: Record<string, boolean>;
  /** optional detail for the attempt log */
  detail?: Record<string, unknown>;
}

export interface AutofixContext {
  site: SiteConfig;
  ws: Workspace;
  /** repo root (sites/, packages/ are relative to it) */
  repoRoot: string;
  llm?: LlmClient;
  log: Logger;
  /** base URL of the app under test (e.g. http://localhost:4412) and of the original (replay) */
  newBaseUrl?: string;
  oldBaseUrl: string;
  dryRun: boolean;
  /** remaining LLM budget in USD (informational; the client enforces llm.budgetUsd) */
  budgetLeftUsd?: number;
  /** (W1-C, additive) port of the app under test that the loop (re)starts after "build" */
  appPort?: number;
}

export interface Handler {
  /** e.g. "profile-infer", "parity-fix", "mapping-review" */
  id: string;
  /** issue codes this handler takes */
  codes: string[];
  /** lower runs first (content before design before parity) */
  priority: number;
  /**
   * Optional grouping: tasks with the same group key are handled by ONE propose() call (e.g. all TEXT_MISSING of one
   * paragraph type). Default: one task per call.
   */
  groupKey?(task: AutofixTask): string;
  /** measure the handler's primary metric for these tasks (before and after each candidate) */
  measure(ctx: AutofixContext, tasks: AutofixTask[]): Promise<Metrics>;
  /** ranked candidates (best first); [] = nothing to propose -> NEEDS_HUMAN */
  propose(ctx: AutofixContext, tasks: AutofixTask[], previous: AttemptRecord[]): Promise<Candidate[]>;
  /**
   * (W1-C, additive) the text-only evidence a human needs when no candidate fixed the task; written to
   * autofix/dossiers/<handler>-<key>.json on AUTOFIX_NEEDS_HUMAN. Must not contain page text unless llm.sendContent.
   */
  dossier?(ctx: AutofixContext, tasks: AutofixTask[]): Promise<unknown>;
}

/** autofix/attempts/<seq>-<handler>.json */
export interface AttemptRecord {
  seq: number;
  handler: string;
  taskIds: string[];
  candidate: Omit<Candidate, "files"> & { files: { path: string; bytes: number | null }[] };
  before: Metrics;
  after?: Metrics;
  accepted: boolean;
  reason: string; // "improved 0.91 -> 0.98", "gate visual.bbox regressed", "rerun failed: …"
  llm?: { calls: number; promptTokens: number; completionTokens: number; estCostUsd: number; cached: number };
  /** (W1-C, additive) sha256 of the patch (paths + contents): identical candidates are never tried twice */
  patchSha?: string;
  /** (W1-C, additive) the loop's per-run backup of every touched file: autofix/attempts/<seq>-backup/ */
  backupDir?: string;
  startedAt: string;
  finishedAt: string;
}

/** Issue codes the loop emits itself. */
export const AUTOFIX_CODES = {
  NEEDS_HUMAN: "AUTOFIX_NEEDS_HUMAN",
  PIPELINE_BUG: "PIPELINE_BUG",
  BUDGET_EXHAUSTED: "AUTOFIX_BUDGET_EXHAUSTED",
  ACCEPTED: "AUTOFIX_ACCEPTED",
  /** (W1-C, additive) `patience` consecutive attempts without an accepted candidate */
  STALLED: "AUTOFIX_STALLED",
  /** (W1-C, additive) a candidate tried to write outside the data files the loop allows */
  PATCH_REFUSED: "AUTOFIX_PATCH_REFUSED",
  /** (W1-C, additive) "build" needs the app port, but a process the loop did not start is bound to it */
  APP_PORT_BUSY: "AUTOFIX_APP_PORT_BUSY",
} as const;
