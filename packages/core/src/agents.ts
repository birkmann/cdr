import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig, Phase, RunStatus, SessionStatus } from "@harness/protocol";
import type { CreateSessionOptions, Session } from "./session.js";
import type { AgentHandle, AgentOutcome, AgentSpawner, SpawnAgentRequest } from "./tools/types.js";
import { resolveModelRef, parseModelRef } from "./config.js";
import { branchExists, commitAll, createWorktree, diffStat, git, repoRoot } from "./git.js";
import { newId, slugify } from "./util.js";

export const DEFAULT_MAX_CONCURRENT_AGENTS = 3;
export const DEFAULT_MAX_AGENT_DEPTH = 2;

/** Factory the Harness gives each Session so it can create child sessions. */
export type SessionFactory = (o: CreateSessionOptions) => Session;

interface Child {
  handle: AgentHandle;
  session: Session;
  promise: Promise<AgentOutcome>;
  running: boolean;
  collected: boolean;
}

export function maxAgentDepth(config: HarnessConfig): number {
  return config.agents?.maxDepth ?? DEFAULT_MAX_AGENT_DEPTH;
}

/**
 * Subagents of one parent session: child sessions with their own logs, created through the Harness.
 * Emits agent.spawned / agent.status / agent.finished into the parent's log.
 */
export class AgentManager implements AgentSpawner {
  private readonly children = new Map<string, Child>();

  constructor(
    private readonly parent: Session,
    private readonly factory: SessionFactory,
  ) {}

  /** Live child sessions (e.g. so a terminal can answer their prompts). */
  childSessions(): Session[] {
    return [...this.children.values()].map((c) => c.session);
  }

  get runningCount(): number {
    return [...this.children.values()].filter((c) => c.running).length;
  }

  private safeEmit(body: Parameters<Session["emit"]>[0]): void {
    try {
      this.parent.emit(body);
    } catch {
      /* the parent's log must never break a child */
    }
  }

  /** Child limits: requested values capped by what the parent has left. Throws when nothing is left. */
  private childLimits(req: SpawnAgentRequest["budget"] = {}): NonNullable<HarnessConfig["limits"]> {
    const pb = this.parent.budget;
    const pl = pb.limits ?? {};
    const remaining = {
      maxTokens: pl.maxTokens ? pl.maxTokens - (pb.inputTokens + pb.outputTokens) : undefined,
      maxCost: pl.maxCost ? pl.maxCost - pb.cost : undefined,
      timeoutMs: pl.timeoutMs ? pl.timeoutMs - pb.activeElapsedMs : undefined,
    };
    for (const [k, v] of Object.entries(remaining))
      if (v !== undefined && v <= 0) throw new Error(`the parent's budget is exhausted (${k})`);
    const cap = (a: number | undefined, b: number | undefined) =>
      a && a > 0 && b !== undefined ? Math.min(a, b) : a && a > 0 ? a : b;
    const out: NonNullable<HarnessConfig["limits"]> = {};
    const maxTurns = req.maxTurns && req.maxTurns > 0 ? req.maxTurns : pl.maxTurns;
    if (maxTurns) out.maxTurns = maxTurns;
    const maxTokens = cap(req.maxTokens, remaining.maxTokens);
    if (maxTokens) out.maxTokens = Math.floor(maxTokens);
    const maxCost = cap(req.maxCost, remaining.maxCost);
    if (maxCost) out.maxCost = maxCost;
    const timeoutMs = cap(req.timeoutMs, remaining.timeoutMs);
    if (timeoutMs) out.timeoutMs = Math.floor(timeoutMs);
    return out;
  }

  private prepareWorktree(task: string): {
    projectPath: string;
    worktree: string;
    branch: string;
    base: string;
  } {
    const root = this.parent.projectRoot;
    const repo = repoRoot(root);
    if (!repo) throw new Error('isolation "worktree" needs a git repository; use "shared"');
    const base = git(root, ["rev-parse", "HEAD"]);
    if (!base.ok) throw new Error('isolation "worktree" needs at least one commit; use "shared"');
    const prefix = git(root, ["rev-parse", "--show-prefix"]).out.trim();
    const parentShort = slugify(this.parent.id).slice(-6) || "agent";
    const childSlug = slugify(task, 30) || "task";
    let branch = `cdr/${parentShort}/${childSlug}`;
    let worktree = join(repo, ".harness", "worktrees", `${parentShort}-${childSlug}`);
    for (let i = 2; branchExists(repo, branch) || existsSync(worktree); i++) {
      branch = `cdr/${parentShort}/${childSlug}-${i}`;
      worktree = join(repo, ".harness", "worktrees", `${parentShort}-${childSlug}-${i}`);
    }
    const w = createWorktree(repo, worktree, branch, base.out.trim());
    if (!w.ok) throw new Error(`could not create worktree: ${w.error}`);
    return {
      projectPath: prefix ? join(worktree, prefix) : worktree,
      worktree,
      branch,
      base: base.out.trim(),
    };
  }

  async spawn(req: SpawnAgentRequest, toolCallId: string): Promise<AgentHandle> {
    const parent = this.parent;
    const maxDepth = maxAgentDepth(parent.config);
    if (parent.depth >= maxDepth) throw new Error(`maximum subagent depth (${maxDepth}) reached`);
    const maxConcurrent = parent.config.agents?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_AGENTS;
    if (this.runningCount >= maxConcurrent)
      throw new Error(
        `at most ${maxConcurrent} subagents may run at once; collect one with wait_agents first`,
      );
    if (parent.signal.aborted) throw new Error("the parent run was cancelled");
    const task = req.task.trim();
    const isolation = req.isolation ?? "shared";
    const role = req.role?.trim() || "executor";
    const ref = resolveModelRef(parent.config, role);
    if (!parent.config.providers[parseModelRef(ref).provider])
      throw new Error(`unknown provider in model "${ref}"`);
    const limits = this.childLimits(req.budget);

    const wt = isolation === "worktree" ? this.prepareWorktree(task) : undefined;
    const child = this.factory({
      projectPath: wt?.projectPath ?? parent.projectRoot,
      workflow: parent.workflow,
      models: { ...parent.config.models },
      reasoningEffort: parent.config.reasoningEffort,
      permissionMode: parent.policy.mode,
      autoApprove: parent.autoApprove,
      title: `${role}: ${task.split("\n")[0].slice(0, 60)}`,
      parentSessionId: parent.id,
      readOnly: isolation === "shared",
      toolNames: req.tools,
      depth: parent.depth + 1,
      configOverrides: {
        limits,
        sandbox: parent.config.sandbox,
        sandboxNetwork: parent.config.sandboxNetwork,
        ...(parent.config.permissions ? { permissions: structuredClone(parent.config.permissions) } : {}),
        ...(parent.config.agents ? { agents: { ...parent.config.agents } } : {}),
      },
    });
    const agentId = newId("agent_");
    const handle: AgentHandle = {
      agentId,
      sessionId: child.id,
      ...(wt ? { worktree: wt.worktree, branch: wt.branch } : {}),
    };
    this.safeEmit({
      type: "agent.spawned",
      agentId,
      sessionId: child.id,
      parentToolCallId: toolCallId,
      task,
      role,
      isolation,
      ...(wt ? { worktree: wt.worktree, branch: wt.branch } : {}),
    });

    // Mirror the child's progress into the parent's log (status changes immediately, usage at most 1/s).
    let lastStatus: SessionStatus | undefined;
    let phase: Phase | undefined;
    let lastUsageAt = 0;
    const usage = () => ({
      inputTokens: child.budget.inputTokens,
      outputTokens: child.budget.outputTokens,
      ...(child.budget.cost ? { cost: child.budget.cost } : {}),
    });
    const status = (s: SessionStatus) =>
      this.safeEmit({
        type: "agent.status",
        agentId,
        status: s,
        ...(phase ? { phase } : {}),
        usage: usage(),
      });
    const unsubscribe = child.subscribe((e) => {
      if (e.type === "status" && e.status !== lastStatus) {
        lastStatus = e.status;
        status(e.status);
      } else if (e.type === "phase.start" && e.phase !== phase) {
        phase = e.phase;
        status(lastStatus ?? "running");
      } else if (e.type === "usage" && Date.now() - lastUsageAt > 1000) {
        lastUsageAt = Date.now();
        status(lastStatus ?? "running");
      }
    });

    const onAbort = () => child.cancel();
    parent.signal.addEventListener("abort", onAbort, { once: true });
    const record: Child = { handle, session: child, running: true, collected: false, promise: undefined! };
    const run = child.runSubagent(task, role);
    record.promise = run
      .then(
        (r) => ({
          status: (r.status === "completed"
            ? "success"
            : r.status === "cancelled"
              ? "cancelled"
              : "failed") as RunStatus,
          summary: r.text.trim() || (r.error ? `Failed: ${r.error}` : ""),
        }),
        (e: Error) => ({
          status: (child.signal.aborted ? "cancelled" : "failed") as RunStatus,
          summary: `Failed: ${e.message}`,
        }),
      )
      .then(({ status: runStatus, summary }) => {
        parent.signal.removeEventListener("abort", onAbort);
        unsubscribe();
        let stat: string | undefined;
        if (wt) {
          const c = commitAll(wt.worktree, `cdr subagent: ${task.split("\n")[0].slice(0, 60)}`);
          if (!c.ok) summary += `\n\n(commit in worktree failed: ${c.error})`;
          stat = diffStat(wt.worktree, wt.base) || undefined;
        }
        const u = {
          inputTokens: child.budget.inputTokens,
          outputTokens: child.budget.outputTokens,
          cost: child.budget.cost,
        };
        // Children spend from the parent's budget.
        parent.budget.add(u.inputTokens, u.outputTokens, u.cost);
        status(child.status);
        this.safeEmit({
          type: "agent.finished",
          agentId,
          status: runStatus,
          summary: summary.slice(0, 4000),
          ...(stat ? { diffStat: stat } : {}),
        });
        record.running = false;
        return { ...handle, status: runStatus, summary, ...(stat ? { diffStat: stat } : {}), usage: u };
      });
    this.children.set(agentId, record);
    return handle;
  }

  async wait(agentIds?: string[]): Promise<AgentOutcome[]> {
    const records = agentIds
      ? agentIds.map((id) => {
          const r = this.children.get(id);
          if (!r)
            throw new Error(
              `Unknown agent id "${id}". Known: ${[...this.children.keys()].join(", ") || "none"}`,
            );
          return r;
        })
      : [...this.children.values()].filter((r) => !r.collected);
    const outcomes = await Promise.all(records.map((r) => r.promise));
    for (const r of records) r.collected = true;
    return outcomes;
  }

  /** Cancel and await every running child (end of the parent's run). */
  async shutdown(): Promise<void> {
    const running = [...this.children.values()].filter((c) => c.running);
    for (const c of running) c.session.cancel();
    await Promise.all(running.map((c) => c.promise.catch(() => undefined)));
  }
}
