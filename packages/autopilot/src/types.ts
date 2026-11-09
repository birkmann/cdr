/**
 * The contract between the autopilot's stages, collector, registry and loop.
 * See docs/plans/autopilot-self-improving-pipeline.md; section numbers below refer to it.
 */

export type StageName = "freeze" | "mirror" | "design-system" | "replica" | "final";
export const STAGE_ORDER: StageName[] = ["freeze", "mirror", "design-system", "replica", "final"];

export type StageStatus = "passed" | "failed" | "crashed" | "skipped";

/** One check of a stage. `hard` gates decide green; advisory ones are only reported (§1). */
export interface Gate {
  /** Stable id without site or viewport, such as `visual.parity` or `appbuild`. */
  id: string;
  pass: boolean;
  hard: boolean;
  value?: number | string | boolean;
  threshold?: number | string | boolean;
  viewport?: string;
}

/** A problem a stage reports, turned into a finding by the collector (§4.2). */
export interface StageIssue {
  /** Upper-case code from §4.2, or a verify check id such as `visual.parity`. */
  code: string;
  /** More specific than the code: a `ParityCause`, `tsc`, `stylesheet`. Goes into the signature. */
  cause?: string;
  message: string;
  severity: "error" | "warning" | "info";
  /** Absolute paths: dossiers, bug bundles, crops, logs. */
  evidence?: string[];
}

export interface ModelUsage {
  calls: number;
  cachedCalls: number;
  costUsd: number;
}

/** Written as `<stageDir>/summary.json` by every stage (§3.4). */
export interface StageSummary {
  stage: StageName;
  site: string;
  status: StageStatus;
  wallClockMs: number;
  gates: Gate[];
  issues: StageIssue[];
  usage?: ModelUsage;
  /** Named outputs later stages read, absolute paths: `mirrorApp`, `designSystem`, `replicaApp`, `scene`, `verifyDir`. */
  artifacts: Record<string, string>;
}

export interface SiteConfig {
  id: string;
  /** Absent for a fixture site. */
  url?: string;
  /** Local fixture name for holdout and tests (§3.2). */
  fixture?: string;
  framework: "nextjs";
  viewports?: string[];
  freeze?: { wayback?: boolean };
}

export interface SitesFile {
  sites: SiteConfig[];
  holdout: SiteConfig[];
}

export interface Budgets {
  designSystemMs: number;
  replicaMs: number;
  /** A fixer goal. */
  fixerUsd: number;
  fixerMs: number;
}

export interface AutopilotConfig {
  budgets: Budgets;
  parallel: number;
  freeze: { maxAgeDays: number; wayback: boolean };
  coverage: { start: number; step: number; max: number };
}

export const DEFAULT_AUTOPILOT_CONFIG: AutopilotConfig = {
  budgets: { designSystemMs: 15 * 60_000, replicaMs: 20 * 60_000, fixerUsd: 10, fixerMs: 45 * 60_000 },
  parallel: 2,
  freeze: { maxAgeDays: 7, wayback: false },
  coverage: { start: 0.5, step: 0.1, max: 0.9 },
};

/** Where things live. Every path is absolute; build it with `autopilotPaths` (paths.ts). */
export interface AutopilotPaths {
  /** The repository root (the accepted checkout, or a goal's worktree). */
  root: string;
  /** `<root>/autopilot`, committed: sites.yaml, rules.json, rules/, registry.json, baseline.json, lints/. */
  committed: string;
  /** `<root>/.harness/autopilot`, ignored: state.json, cycles/, snapshots/, goals/. */
  state: string;
  snapshots: string;
  cycleDir(cycle: number): string;
  siteDir(cycle: number, site: string): string;
  projectDir(cycle: number, site: string): string;
  stageDir(cycle: number, site: string, stage: StageName): string;
}

/** A frozen capture and its running replay server (§2.1). */
export interface SnapshotRef {
  site: string;
  /** `.harness/autopilot/snapshots/<site>/<timestamp>`. */
  dir: string;
  /** The URL the original resolved to, after redirects. */
  finalUrl: string;
  /** `http://127.0.0.1:<port>/…` for the page; absent until a replay server is started. */
  replayUrl?: string;
  capturedAt: string;
  source: "live" | "wayback" | "fixture";
}

export interface PortPool {
  acquire(): Promise<number>;
  release(port: number): void;
}

/** What a stage needs. Stages take everything from here so tests can substitute any part. */
export interface StageContext {
  site: SiteConfig;
  cycle: number;
  paths: AutopilotPaths;
  config: AutopilotConfig;
  /** The site's project folder: an empty project with its own `.harness/config.json`. */
  projectDir: string;
  /** Where this stage writes `summary.json`, `log.txt`, `events.jsonl`, `errors.json`. */
  stageDir: string;
  snapshot?: SnapshotRef;
  /** The summaries of the earlier stages of this site, in order. */
  previous: Partial<Record<StageName, StageSummary>>;
  ports: PortPool;
  signal: AbortSignal;
  log(line: string): void;
  /** One line of `events.jsonl`. */
  event(body: unknown): void;
  /** `--keep-cache`: reuse model answers, so a repeat run makes no live call (§6.1). */
  keepCache: boolean;
}

export interface StageRunner {
  name: StageName;
  run(ctx: StageContext): Promise<StageSummary>;
}

export type FindingStatus = "new" | "recurring" | "regressed" | "fixed";

/** Rank order of §4.4: lower is more urgent. */
export type FindingRank = 0 | 1 | 2 | 3;

export interface Finding {
  /** `<stage>:<code>[:<cause>][:<normalised-message-hash>]` (§4.1). */
  signature: string;
  stage: StageName | "health" | "reproducibility";
  code: string;
  cause?: string;
  message: string;
  sites: string[];
  rank: FindingRank;
  status: FindingStatus;
  evidence: string[];
  /** The rule this finding violates, when it matches one (§5.4). */
  rule?: string;
}

export interface FindingsFile {
  cycle: number;
  findings: Finding[];
}

export type RegistryStatus =
  "open" | { fixing: string } | { fixed: number } | "regressed" | "accepted-advisory" | "NEEDS_HUMAN";

export interface FixAttempt {
  goalId: string;
  cycle: number;
  verdict: "accepted" | "discarded";
  reason: string;
  diffSummary?: string;
}

export interface RegistryEntry {
  signature: string;
  firstCycle: number;
  lastCycle: number;
  sites: string[];
  count: number;
  status: RegistryStatus;
  rule?: string;
  attempts: FixAttempt[];
}

export interface Registry {
  entries: Record<string, RegistryEntry>;
}

export interface RuleEntry {
  signature: string;
  file: string;
  seen: string[];
  fixedCycle?: number;
  goalId?: string;
  symptom: string;
  rootCause: string;
  invariant: string;
  guards: Array<{ kind: "test"; file: string; name: string } | { kind: "lint"; file: string }>;
}

/** Gates per site per stage: `baseline.json` and the result of a slow lane (§5.2). */
export interface MatrixResult {
  cycle: number;
  commit: string;
  sites: Record<string, Partial<Record<StageName, StageSummary>>>;
}

export interface LoopState {
  cycle: number;
  step: "freeze" | "run" | "inspect" | "fix" | "verify" | "rules" | "done";
  status: "running" | "paused" | "green" | "budget" | "max-cycles";
  spentUsd: number;
  greenStreak: number;
  coverageTarget: number;
  goals: string[];
  /** Why the loop stopped, when it did. */
  reason?: string;
  /** What the last matrix run cost, the estimate for the budget stop before the next one. */
  lastRunCostUsd?: number;
}
