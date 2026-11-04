import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  CreateGoalRequest,
  CriterionResult,
  EventBody,
  GoalBudget,
  GoalInfo,
  GoalPolicy,
  HarnessConfig,
  RunStatus,
  UpdateGoalRequest,
} from "@harness/protocol";
import { harnessHome } from "./config.js";
import type { Harness, Session } from "./session.js";
import {
  branchExists,
  commitAll,
  createWorktree,
  currentBranch,
  git,
  hasHead,
  isGitRepo,
  mergeBranch,
  removeWorktree,
  repoRoot,
} from "./git.js";
import { sessionHasProjectLock } from "./lock.js";
import { slugify } from "./util.js";

export const DEFAULT_GOAL_ROUNDS = 4;
const AUTONOMOUS_ANSWER =
  "No human is available during this autonomous goal. Decide yourself using the goal and its acceptance criteria.";

export class GoalError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "conflict",
    message: string,
    readonly conflicts?: string[],
  ) {
    super(message);
    this.name = "GoalError";
  }
}

const ID_RE = /^goal-[A-Za-z0-9_-]+$/;
const PERMISSION_MODES = ["ask", "auto", "yolo"];

function validateBudget(b: unknown): GoalBudget {
  if (b === undefined || b === null) return {};
  if (typeof b !== "object" || Array.isArray(b)) throw new GoalError("invalid", "budget must be an object");
  const out: GoalBudget = {};
  for (const k of ["maxCost", "maxTokens", "timeoutMs", "maxRounds"] as const) {
    const v = (b as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw new GoalError("invalid", `budget.${k} must be a non-negative number`);
    out[k] = v;
  }
  return out;
}

function validatePolicy(p: unknown): GoalPolicy {
  if (p === undefined || p === null) return {};
  if (typeof p !== "object" || Array.isArray(p)) throw new GoalError("invalid", "policy must be an object");
  const policy = p as GoalPolicy;
  if (policy.permissionMode !== undefined && !PERMISSION_MODES.includes(policy.permissionMode))
    throw new GoalError("invalid", "policy.permissionMode must be ask, auto or yolo");
  const list = (v: unknown, name: string) => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
      throw new GoalError("invalid", `${name} must be an array of strings`);
    return v as string[];
  };
  const allow = list(policy.bash?.allow, "policy.bash.allow");
  const deny = list(policy.bash?.deny, "policy.bash.deny");
  return {
    ...(policy.permissionMode ? { permissionMode: policy.permissionMode } : {}),
    ...(allow || deny ? { bash: { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } } : {}),
  };
}

function validateFields(req: UpdateGoalRequest, current?: GoalInfo): Partial<GoalInfo> {
  const out: Partial<GoalInfo> = {};
  if (req.title !== undefined) {
    if (typeof req.title !== "string" || !req.title.trim())
      throw new GoalError("invalid", "title is required");
    out.title = req.title.trim();
  }
  if (req.description !== undefined) {
    if (typeof req.description !== "string") throw new GoalError("invalid", "description must be a string");
    out.description = req.description;
  }
  if (req.acceptance !== undefined) {
    if (!Array.isArray(req.acceptance) || req.acceptance.some((c) => typeof c !== "string" || !c.trim()))
      throw new GoalError("invalid", "acceptance must be an array of non-empty strings");
    out.acceptance = req.acceptance.map((c) => c.trim());
  }
  if (req.baseBranch !== undefined) {
    if (typeof req.baseBranch !== "string" || !req.baseBranch.trim())
      throw new GoalError("invalid", "baseBranch must be a branch name");
    out.baseBranch = req.baseBranch.trim();
  }
  if (req.budget !== undefined) out.budget = validateBudget(req.budget);
  if (req.policy !== undefined) out.policy = validatePolicy(req.policy);
  if (req.models !== undefined) {
    if (typeof req.models !== "object" || req.models === null || Array.isArray(req.models))
      throw new GoalError("invalid", "models must be an object");
    out.models = req.models;
  }
  if (req.deliverable !== undefined) {
    if (!["pull-request", "branch", "patch"].includes(req.deliverable))
      throw new GoalError("invalid", "deliverable must be pull-request, branch or patch");
    out.deliverable = req.deliverable;
  }
  if (req.schedule !== undefined) {
    const s = req.schedule as unknown;
    if (
      s !== null &&
      !(
        typeof s === "object" &&
        (typeof (s as { at?: unknown }).at === "string" || typeof (s as { cron?: unknown }).cron === "string")
      )
    )
      throw new GoalError("invalid", 'schedule must be null, {"at": "<ISO time>"} or {"cron": "<expr>"}');
    out.schedule = req.schedule;
  }
  const schedule = out.schedule !== undefined ? out.schedule : current?.schedule;
  const mode = (out.policy ?? current?.policy)?.permissionMode;
  if (schedule && mode === "yolo")
    throw new GoalError("invalid", "yolo permission mode is refused for scheduled goals");
  return out;
}

/**
 * Goals persist as `<repo>/.harness/goals/<id>.json`; `~/.harness/goals-index.json` lists the repos
 * that have goals so a server can list goals across repositories.
 */
export class GoalStore {
  constructor(private readonly home: string = harnessHome()) {}

  private get indexPath(): string {
    return join(this.home, "goals-index.json");
  }

  repos(): string[] {
    try {
      const data = JSON.parse(readFileSync(this.indexPath, "utf8")) as { repos?: unknown };
      return Array.isArray(data.repos) ? data.repos.filter((r): r is string => typeof r === "string") : [];
    } catch {
      return [];
    }
  }

  private addRepo(repo: string): void {
    const repos = this.repos();
    if (repos.includes(repo)) return;
    mkdirSync(this.home, { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify({ repos: [...repos, repo] }, null, 2) + "\n");
  }

  dir(repo: string): string {
    return join(repo, ".harness", "goals");
  }

  private file(repo: string, id: string): string {
    if (!ID_RE.test(id)) throw new GoalError("invalid", `Invalid goal id "${id}"`);
    return join(this.dir(repo), `${id}.json`);
  }

  private read(path: string): GoalInfo | null {
    try {
      return normalizeStatus(JSON.parse(readFileSync(path, "utf8")) as GoalInfo);
    } catch {
      return null;
    }
  }

  create(req: CreateGoalRequest): GoalInfo {
    if (!req || typeof req !== "object") throw new GoalError("invalid", "invalid goal");
    if (typeof req.repo !== "string" || !req.repo) throw new GoalError("invalid", "repo is required");
    const path = resolve(req.repo);
    if (!existsSync(path) || !statSync(path).isDirectory())
      throw new GoalError("invalid", `repo does not exist: ${path}`);
    if (!isGitRepo(path)) throw new GoalError("invalid", `repo is not a git repository: ${path}`);
    const repo = realpathSync(repoRoot(path) ?? path);
    if (!hasHead(repo)) throw new GoalError("invalid", "repo has no commits yet");
    const fields = validateFields({ ...req, title: req.title ?? "" });
    const baseBranch = fields.baseBranch ?? currentBranch(repo);
    if (!baseBranch || baseBranch === "HEAD")
      throw new GoalError("invalid", "baseBranch is required (the repository is on a detached HEAD)");
    if (!branchExists(repo, baseBranch)) throw new GoalError("invalid", `no such branch: ${baseBranch}`);
    const now = new Date().toISOString();
    const goal: GoalInfo = {
      id: `goal-${now.slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`,
      title: fields.title!,
      description: fields.description ?? "",
      acceptance: fields.acceptance ?? [],
      repo,
      baseBranch,
      budget: fields.budget ?? {},
      policy: fields.policy ?? {},
      ...(fields.models ? { models: fields.models } : {}),
      deliverable: fields.deliverable ?? "branch",
      ...(fields.schedule !== undefined ? { schedule: fields.schedule } : {}),
      status: fields.schedule ? "scheduled" : "draft",
      checkpoints: 0,
      createdAt: now,
      updatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    };
    this.save(goal);
    return goal;
  }

  save(goal: GoalInfo): GoalInfo {
    const next = { ...goal, updatedAt: new Date().toISOString() };
    mkdirSync(this.dir(goal.repo), { recursive: true });
    writeFileSync(this.file(goal.repo, goal.id), JSON.stringify(next, null, 2) + "\n");
    this.addRepo(goal.repo);
    return next;
  }

  get(id: string): GoalInfo | null {
    if (!ID_RE.test(id)) return null;
    for (const repo of this.repos()) {
      const p = join(this.dir(repo), `${id}.json`);
      if (existsSync(p)) return this.read(p);
    }
    return null;
  }

  require(id: string): GoalInfo {
    const g = this.get(id);
    if (!g) throw new GoalError("not_found", `Goal "${id}" not found`);
    return g;
  }

  list(repo?: string): GoalInfo[] {
    const repos = repo ? [realpathSafe(resolve(repo))] : this.repos();
    const out: GoalInfo[] = [];
    for (const r of repos) {
      const dir = this.dir(r);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const g = this.read(join(dir, f));
        if (g) out.push(g);
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Edit a goal that is not running and not finished. */
  update(id: string, req: UpdateGoalRequest): GoalInfo {
    const goal = this.require(id);
    if (goal.status === "running" || activeGoals.has(id))
      throw new GoalError("conflict", "goal is running; pause it first");
    if (["done", "discarded"].includes(goal.status))
      throw new GoalError("conflict", `goal is ${goal.status} and can no longer be edited`);
    const { repo: _repo, id: _id, ...rest } = req as UpdateGoalRequest & { repo?: string; id?: string };
    const fields = validateFields(rest, goal);
    if (fields.baseBranch && !branchExists(goal.repo, fields.baseBranch))
      throw new GoalError("invalid", `no such branch: ${fields.baseBranch}`);
    const next: GoalInfo = { ...goal, ...fields };
    if (next.status === "draft" && next.schedule) next.status = "scheduled";
    else if (next.status === "scheduled" && !next.schedule) next.status = "draft";
    return this.save(next);
  }

  delete(id: string): void {
    const goal = this.require(id);
    if (activeGoals.has(id)) throw new GoalError("conflict", "goal is running; pause it first");
    rmSync(this.file(goal.repo, id), { force: true });
  }
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ---------------------------------------------------------------- runner

interface ActiveGoal {
  abort: AbortController;
  session: Session;
  done: Promise<GoalInfo>;
}

const activeGoals = new Map<string, ActiveGoal>();

/** A goal persisted as running whose runner is gone (process died) needs attention. */
function normalizeStatus(goal: GoalInfo): GoalInfo {
  if (goal.status !== "running" || activeGoals.has(goal.id)) return goal;
  if (goal.worktree && goal.sessionId && sessionHasProjectLock(goal.worktree, goal.sessionId)) return goal;
  return { ...goal, status: "needs-attention" };
}

export function isGoalRunning(goalId: string): boolean {
  return activeGoals.has(goalId);
}

export interface RunGoalOptions {
  signal?: AbortSignal;
  /** Reviewer feedback for a "request changes" round. */
  feedback?: string;
  store?: GoalStore;
}

export interface StartedGoal {
  /** The goal as saved when the run started (status running, sessionId, branch, worktree set). */
  goal: GoalInfo;
  session: Session;
  /** Resolves with the final goal state (never rejects). */
  done: Promise<GoalInfo>;
}

function goalTask(goal: GoalInfo, unmet: CriterionResult[] | undefined, feedback?: string): string {
  const parts = [`Goal: ${goal.title}`];
  if (goal.description.trim()) parts.push(goal.description.trim());
  if (goal.acceptance.length)
    parts.push(
      `Acceptance criteria (all must be met):\n${goal.acceptance.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    );
  parts.push(
    `You work unattended in a dedicated git worktree on branch ${goal.branch}. Earlier rounds are committed on this branch. Do not push or open pull requests.`,
  );
  if (unmet?.length)
    parts.push(
      `Previous rounds left these acceptance criteria unmet. Focus on them; inspect the current files first:\n${unmet
        .map((c) => `- ${c.criterion}${c.evidence ? ` (reviewer: ${c.evidence})` : ""}`)
        .join("\n")}`,
    );
  if (feedback?.trim()) parts.push(`The person reviewing this goal requested changes:\n${feedback.trim()}`);
  return parts.join("\n\n");
}

function budgetExceeded(goal: GoalInfo): string | null {
  const b = goal.budget;
  const u = goal.usage;
  if (b.maxCost && u.cost >= b.maxCost)
    return `goal cost budget reached ($${u.cost.toFixed(4)} of $${b.maxCost})`;
  if (b.maxTokens && u.inputTokens + u.outputTokens >= b.maxTokens)
    return `goal token budget reached (${u.inputTokens + u.outputTokens} of ${b.maxTokens})`;
  if (b.timeoutMs && (u.elapsedMs ?? 0) >= b.timeoutMs)
    return `goal time budget reached (${u.elapsedMs} ms of ${b.timeoutMs} ms)`;
  return null;
}

function remainingLimits(goal: GoalInfo, base: HarnessConfig["limits"]): HarnessConfig["limits"] {
  const b = goal.budget;
  const u = goal.usage;
  const limits = { ...(base ?? {}) };
  if (b.maxCost) limits.maxCost = Math.max(b.maxCost - u.cost, Number.EPSILON);
  if (b.maxTokens) limits.maxTokens = Math.max(b.maxTokens - u.inputTokens - u.outputTokens, 1);
  if (b.timeoutMs) limits.timeoutMs = Math.max(b.timeoutMs - (u.elapsedMs ?? 0), 1);
  return limits;
}

function uniqueBranch(repo: string, wanted: string): string {
  let branch = wanted;
  for (let i = 2; branchExists(repo, branch); i++) branch = `${wanted}-${i}`;
  return branch;
}

/**
 * Start (or continue) an autonomous goal: worktree on `cdr/goal-<slug>` from baseBranch, a session with
 * goalId set, and rounds of the "autonomous" workflow until every criterion is met or a budget stops it.
 * Returns once the run has started; `done` resolves with the final goal state.
 */
export function startGoal(harness: Harness, goalId: string, opts: RunGoalOptions = {}): StartedGoal {
  const store = opts.store ?? new GoalStore();
  let goal = store.require(goalId);
  if (activeGoals.has(goalId) || goal.status === "running")
    throw new GoalError("conflict", "goal is already running");
  if (goal.status === "done" || goal.status === "discarded")
    throw new GoalError("conflict", `goal is ${goal.status}`);
  const mode = goal.policy.permissionMode ?? "auto";
  if (goal.schedule && mode === "yolo")
    throw new GoalError("invalid", "yolo permission mode is refused for scheduled goals");

  const branch = goal.branch ?? uniqueBranch(goal.repo, `cdr/goal-${slugify(goal.title, 40) || goal.id}`);
  const worktree = goal.worktree ?? join(goal.repo, ".harness", "worktrees", goal.id);
  if (!existsSync(worktree)) {
    const w = createWorktree(goal.repo, worktree, branch, goal.baseBranch);
    if (!w.ok) throw new GoalError("invalid", `could not create worktree: ${w.error}`);
  }

  const autoApprove = { plan: true, questions: AUTONOMOUS_ANSWER };
  let session: Session;
  if (goal.sessionId && harness.store.exists(goal.sessionId)) {
    session = harness.getSession(goal.sessionId, { permissionMode: mode });
    session.autoApprove = { ...session.autoApprove, ...autoApprove };
    session.policy.mode = mode;
  } else {
    session = harness.createSession({
      projectPath: worktree,
      workflow: "autonomous",
      ...(goal.models ? { models: goal.models } : {}),
      permissionMode: mode,
      goalId: goal.id,
      title: `Goal: ${goal.title}`,
      autoApprove,
    });
  }
  if (session.isRunning) throw new GoalError("conflict", "the goal's session is already running");
  if (goal.policy.bash)
    session.config.permissions = {
      ...(session.config.permissions ?? {}),
      bash: {
        allow: [...(session.config.permissions?.bash?.allow ?? []), ...(goal.policy.bash.allow ?? [])],
        deny: [...(session.config.permissions?.bash?.deny ?? []), ...(goal.policy.bash.deny ?? [])],
      },
    };

  goal = store.save({ ...goal, status: "running", branch, worktree, sessionId: session.id });
  const abort = new AbortController();
  const onExternalAbort = () => abort.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (opts.signal?.aborted) abort.abort();
  const onAbort = () => session.cancel();
  abort.signal.addEventListener("abort", onAbort);

  const done = runRounds(store, goal, session, abort.signal, opts.feedback).finally(() => {
    abort.signal.removeEventListener("abort", onAbort);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    activeGoals.delete(goalId);
  });
  activeGoals.set(goalId, { abort, session, done });
  return { goal, session, done };
}

/** Run a goal to completion (or pause). */
export function runGoal(harness: Harness, goalId: string, opts: RunGoalOptions = {}): Promise<GoalInfo> {
  return startGoal(harness, goalId, opts).done;
}

async function runRounds(
  store: GoalStore,
  initial: GoalInfo,
  session: Session,
  signal: AbortSignal,
  feedback: string | undefined,
): Promise<GoalInfo> {
  let goal: GoalInfo = { ...initial, usage: { ...initial.usage, elapsedMs: initial.usage.elapsedMs ?? 0 } };
  const emit = (body: EventBody) => {
    try {
      session.emit(body);
    } catch {
      /* the goal state is still saved */
    }
  };
  const save = (patch: Partial<GoalInfo>) => (goal = store.save({ ...goal, ...patch }));
  const pause = (reason: "budget" | "permission" | "user" | "error", detail?: string) => {
    emit({ type: "goal.paused", goalId: goal.id, reason, ...(detail ? { detail } : {}) });
    return save({
      status: reason === "error" ? "failed" : "needs-attention",
      ...(detail ? { lastSummary: detail } : {}),
    });
  };
  const finish = (status: RunStatus, summary: string) => {
    emit({
      type: "goal.finished",
      goalId: goal.id,
      status,
      branch: goal.branch!,
      summary: summary.slice(0, 4000),
    });
    return save({ status: status === "success" ? "review" : "failed", lastSummary: summary });
  };

  // Goal-level usage and permission prompts ("ask" mode turns a prompt into needs-attention until answered).
  const pendingPermissions = new Set<string>();
  const unsubscribe = session.subscribe((e) => {
    if (e.type === "usage") {
      goal.usage = {
        ...goal.usage,
        inputTokens: goal.usage.inputTokens + e.inputTokens,
        outputTokens: goal.usage.outputTokens + e.outputTokens,
        cost: goal.usage.cost + (e.cost ?? 0),
      };
    } else if (e.type === "permission.request") {
      pendingPermissions.add(e.id);
      queueMicrotask(() => {
        if (!pendingPermissions.has(e.id)) return;
        emit({
          type: "goal.paused",
          goalId: goal.id,
          reason: "permission",
          detail: `waiting for approval: ${e.tool}`,
        });
        save({ status: "needs-attention" });
      });
    } else if (e.type === "permission.resolved") {
      const wasWaiting = pendingPermissions.delete(e.id);
      if (wasWaiting && !pendingPermissions.size && goal.status === "needs-attention" && !signal.aborted)
        queueMicrotask(() => save({ status: "running" }));
    }
  });

  const baseLimits = { ...(session.config.limits ?? {}) };
  const maxRounds = goal.budget.maxRounds || DEFAULT_GOAL_ROUNDS;
  let unmet = goal.criteria?.filter((c) => !c.met);
  try {
    for (let i = 0; i < maxRounds; i++) {
      if (signal.aborted) return pause("user", "Paused by the user.");
      const over = budgetExceeded(goal);
      if (over) return pause("budget", over);
      const round = (goal.round ?? 0) + 1;
      session.setLimits(remainingLimits(goal, baseLimits));
      emit({
        type: "goal.started",
        goalId: goal.id,
        title: goal.title,
        worktree: goal.worktree!,
        branch: goal.branch!,
        round,
      });
      const task = goalTask(goal, unmet, feedback);
      feedback = undefined;
      const r = await session.run(task, { workflow: "autonomous", acceptance: goal.acceptance });
      goal.usage.elapsedMs = (goal.usage.elapsedMs ?? 0) + session.budget.activeElapsedMs;
      save({ round, lastSummary: r.summary });
      if (r.status === "cancelled" || signal.aborted) return pause("user", "Paused by the user.");
      if (r.status === "failed") {
        const exceeded = session.budget.exceeded() ?? budgetExceeded(goal);
        if (exceeded) return pause("budget", exceeded);
        // A failed verification is worth another round; anything else is an error.
        if (!(r.verify && !r.verify.ok && !r.verify.skipped)) {
          pause("error", r.summary);
          return finish("failed", r.summary);
        }
        unmet = [
          ...(r.criteria ?? goal.acceptance.map((criterion) => ({ criterion, met: false }))).filter(
            (c) => !c.met,
          ),
          {
            criterion: "verification (build/test/lint) passes",
            met: false,
            evidence: r.summary.slice(0, 500),
          },
        ];
        continue;
      }
      const criteria =
        r.criteria ??
        goal.acceptance.map((criterion) => ({
          criterion,
          met: false,
          evidence: "not evaluated by the reviewer",
        }));
      const c = commitAll(goal.worktree!, `cdr goal: ${goal.title} (round ${round})`.slice(0, 200));
      if (!c.ok) {
        pause("error", `checkpoint commit failed: ${c.error}`);
        return finish("failed", `checkpoint commit failed: ${c.error}`);
      }
      const commit = c.commit ?? git(goal.worktree!, ["rev-parse", "HEAD"]).out.trim();
      emit({
        type: "goal.checkpoint",
        goalId: goal.id,
        commit,
        step: `round ${round}`,
        summary: r.summary.slice(0, 2000),
        criteria,
      });
      save({ checkpoints: goal.checkpoints + 1, criteria });
      unmet = criteria.filter((x) => !x.met);
      if (!unmet.length) return finish("success", r.summary);
    }
    return pause(
      "budget",
      `maxRounds (${maxRounds}) reached with unmet criteria: ${(unmet ?? []).map((c) => c.criterion).join("; ") || "none"}`,
    );
  } catch (e) {
    const message = (e as Error).message;
    if (signal.aborted) return pause("user", "Paused by the user.");
    pause("error", message);
    return finish("failed", message);
  } finally {
    unsubscribe();
  }
}

/** Pause (cancel) a running goal. */
export function pauseGoal(goalId: string, store = new GoalStore()): { wasRunning: boolean; goal: GoalInfo } {
  const active = activeGoals.get(goalId);
  if (active) {
    active.abort.abort();
    return { wasRunning: true, goal: store.require(goalId) };
  }
  const goal = store.require(goalId);
  return { wasRunning: false, goal };
}

function assertIdle(goal: GoalInfo): void {
  if (activeGoals.has(goal.id) || goal.status === "running")
    throw new GoalError("conflict", "goal is running; pause it first");
}

/** Remove the goal's worktree and branch; status discarded. */
export function discardGoal(goalId: string, store = new GoalStore()): GoalInfo {
  const goal = store.require(goalId);
  assertIdle(goal);
  if (goal.status === "done") throw new GoalError("conflict", "goal is already merged");
  if (goal.worktree || goal.branch) {
    const r = removeWorktree(goal.repo, goal.worktree ?? "", { deleteBranch: goal.branch ?? false });
    if (!r.ok && goal.branch && branchExists(goal.repo, goal.branch))
      throw new GoalError("conflict", `could not discard: ${r.error}`);
  }
  return store.save({ ...goal, status: "discarded", worktree: undefined });
}

/**
 * Merge the goal branch into baseBranch in the main checkout (checking baseBranch out if needed), then
 * remove the worktree. The branch is kept. Status done.
 */
export function mergeGoal(goalId: string, store = new GoalStore()): GoalInfo {
  const goal = store.require(goalId);
  assertIdle(goal);
  if (!["review", "needs-attention", "failed"].includes(goal.status) || !goal.branch)
    throw new GoalError("conflict", `goal is ${goal.status}; nothing to merge`);
  if (!branchExists(goal.repo, goal.branch))
    throw new GoalError("conflict", `branch ${goal.branch} no longer exists`);
  if (goal.worktree && existsSync(goal.worktree)) {
    const c = commitAll(goal.worktree, `cdr goal: ${goal.title} (final changes)`.slice(0, 200));
    if (!c.ok) throw new GoalError("conflict", `could not commit remaining changes: ${c.error}`);
  }
  if (currentBranch(goal.repo) !== goal.baseBranch) {
    const co = git(goal.repo, ["checkout", goal.baseBranch]);
    if (!co.ok)
      throw new GoalError("conflict", `cannot check out ${goal.baseBranch}: ${(co.err || co.out).trim()}`);
  }
  const m = mergeBranch(goal.repo, goal.branch, `Merge goal: ${goal.title}`.slice(0, 200));
  if (!m.ok)
    throw new GoalError(
      "conflict",
      m.conflicts?.length ? `merge conflicts in: ${m.conflicts.join(", ")}` : `merge failed: ${m.error}`,
      m.conflicts,
    );
  if (goal.worktree) removeWorktree(goal.repo, goal.worktree);
  return store.save({ ...goal, status: "done", worktree: undefined });
}

/** Start another round with reviewer feedback. */
export function requestGoalChanges(
  harness: Harness,
  goalId: string,
  feedback: string,
  opts: Omit<RunGoalOptions, "feedback"> = {},
): StartedGoal {
  if (typeof feedback !== "string" || !feedback.trim())
    throw new GoalError("invalid", "feedback is required");
  const store = opts.store ?? new GoalStore();
  const goal = store.require(goalId);
  if (!["review", "needs-attention", "failed"].includes(goal.status))
    throw new GoalError("conflict", `goal is ${goal.status}; changes can be requested after a run`);
  return startGoal(harness, goalId, { ...opts, store, feedback });
}

/** Delete the goal file; removes its worktree but keeps the branch. */
export function deleteGoal(goalId: string, store = new GoalStore()): void {
  const goal = store.require(goalId);
  assertIdle(goal);
  if (goal.worktree && existsSync(goal.worktree)) removeWorktree(goal.repo, goal.worktree);
  store.delete(goalId);
}
