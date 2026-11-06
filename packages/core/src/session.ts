import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type {
  CancelAllResponse,
  DeleteSessionResponse,
  Attachment,
  AttachmentInfo,
  ChatMessage,
  EventBody,
  ImagePart,
  SessionSettingsRequest,
  HarnessConfig,
  HarnessEvent,
  ModelRole,
  ReasoningEffort,
  Phase,
  PermissionDecision,
  PlanDecision,
  Risk,
  SessionInfo,
  SessionOrigin,
  SessionStatus,
  SessionTreeNode,
  TodoItem,
} from "@harness/protocol";
import { PROTOCOL_VERSION } from "@harness/protocol";
import {
  harnessHome,
  loadConfig,
  loadDotEnv,
  outputBaseDir,
  parseModelRef,
  resolveModelRef,
} from "./config.js";
import { processAttachments } from "./attachments.js";
import {
  SANDBOX_PROMPT,
  bwrapAvailable,
  createSandboxDir,
  isWorkspaceContainer,
  sandboxesDir,
} from "./sandbox.js";
import { branchExists, git, repoRoot } from "./git.js";
import { ProviderRegistry, modelConnectionProblem, type Provider } from "./providers/index.js";
import { collect } from "./providers/types.js";
import { recreateTools } from "./recreate/tools.js";
import { SessionStore, rebuildMessages, summarize } from "./session-store.js";
import { branchCut, branchEventsToMerge, planDeletion } from "./conversation.js";
import { Budget, runAgent, type AgentHooks, type AgentHost, type AgentResult } from "./loop.js";
import { PermissionPolicy } from "./permissions.js";
import { VerifyRunner } from "./verify.js";
import { buildSystemPrompt, outputPrompt, type HistoryLog } from "./context.js";
import {
  discoverSkills,
  listSkillFiles,
  matchSkills,
  renderSkill,
  selectSkills,
  delegatedSkills,
  skillsIndex,
  type Skill,
} from "./skills.js";
import { bashTool, builtinTools } from "./tools/builtin.js";
import type { Tool } from "./tools/types.js";
import { resolveInProject } from "./tools/paths.js";
import { UNSPLASH_SECRET_ENV } from "./tools/unsplash.js";
import { configHooks } from "./hooks.js";
import { connectMcpServers, type McpClient } from "./mcp.js";
import { acquireProjectLock, projectLockOwner, sessionHasProjectLock } from "./lock.js";
import { CheckpointStore, type CheckpointChange } from "./checkpoints.js";
import { runWorkflow, type RunOptions, type RunResult } from "./workflow.js";
import { AgentManager, maxAgentDepth, setActiveRunCounter, type SessionFactory } from "./agents.js";
import { spawnAgentTool, waitAgentsTool } from "./tools/agents.js";
import {
  abortError,
  newId,
  redactValue,
  registerSecret,
  sessionId as makeSessionId,
  slugify,
} from "./util.js";

type Listener = (e: HarnessEvent) => void;

interface Pending {
  kind: "permission" | "question" | "plan";
  resolve: (value: any) => void;
  event: HarnessEvent;
}

export interface AutoApprove {
  /** Answer every permission request with "allow". */
  permissions?: boolean;
  /** Approve plans without asking. */
  plan?: boolean;
  /** Fixed answer for ask_user (otherwise the question waits for a UI). */
  questions?: string;
}

export interface SessionOptions {
  id: string;
  projectRoot: string;
  config: HarnessConfig;
  workflow: string;
  store: SessionStore;
  providers: ProviderRegistry;
  events?: HarnessEvent[];
  autoApprove?: AutoApprove;
  persist?: boolean;
  /** Harness-managed sandbox workspace (adds sandbox guidance to prompts). */
  sandbox?: boolean;
  /** Output folder for chats when the config sets no `outputDir` (the terminal app passes ~/Documents/CDR). */
  defaultOutputDir?: string;
  /** Creates child sessions for spawn_agent (provided by the Harness). */
  spawnSession?: SessionFactory;
  /** Every agent of this session gets the read-only tool set and runs skip the per-project lock. */
  readOnly?: boolean;
  /** Restrict the tools of every agent in this session to these names. */
  toolNames?: string[];
  /** Subagent nesting depth (0 = top-level session). */
  depth?: number;
  parentSessionId?: string;
  goalId?: string;
}

export interface ChatResult {
  status: AgentResult["status"];
  text: string;
  error?: string;
}

const SUBAGENT_PROMPT = `# Subagent
You are a subagent: another agent delegated the task below to you. You do not see its conversation, only this task. Work autonomously, keep to the task's scope, and do not ask the user questions unless you cannot proceed. Your final message is returned verbatim to the agent that spawned you: make it a concise, self-contained report of what you found or changed (files, commands run, results).`;

const READ_ONLY_SUBAGENT_PROMPT = `You run read-only in a checkout shared with other agents: you can read, search and run read-only commands, but you cannot edit files.`;

/** Runs (conversations and subagents) in progress in this process. */
let activeRuns = 0;

/** Number of agent runs in progress in this process, across every Harness. */
export function activeRunCount(): number {
  return activeRuns;
}
setActiveRunCounter(activeRunCount);

export class Session {
  readonly id: string;
  /** Last time this session was created, loaded, asked for or wrote an event (ms since epoch). */
  lastUsedAt = Date.now();
  readonly projectRoot: string;
  readonly config: HarnessConfig;
  workflow: string;
  readonly events: HarnessEvent[];
  readonly todos: TodoItem[] = [];
  readonly policy: PermissionPolicy;
  readonly snapshots = new Map<string, string>();
  private checkpoints?: CheckpointStore;
  autoApprove: AutoApprove;
  status: SessionStatus = "idle";
  readonly isSandbox: boolean;
  private readonly defaultOutputDir?: string;
  budget: Budget;
  readonly depth: number;
  readonly readOnly: boolean;
  readonly parentSessionId?: string;
  readonly goalId?: string;
  private readonly toolRestriction?: string[];
  private readonly agentManager?: AgentManager;

  private seq: number;
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<string, Pending>();
  private abort = new AbortController();
  private running = false;
  /** A checkpoint preview is staging the shadow index (restores hold `running` instead). */
  private checkpointBusy = false;
  /** Skills the user selected for the current turn (injected into every agent of the turn). */
  private selectedSkills: Skill[] = [];
  private tailOffset = 0;
  private observedExternalRun = false;
  private tailTimer?: ReturnType<typeof setInterval>;
  private mcp?: { clients: McpClient[]; tools: Tool[] };
  private readonly store: SessionStore;
  private readonly providers: ProviderRegistry;
  private readonly persist: boolean;
  private _verify?: VerifyRunner;

  constructor(o: SessionOptions) {
    this.id = o.id;
    this.projectRoot = o.projectRoot;
    this.config = o.config;
    this.workflow = o.workflow;
    this.store = o.store;
    this.providers = o.providers;
    this.events = o.events ?? [];
    this.seq = this.events[this.events.length - 1]?.seq ?? 0;
    this.autoApprove = o.autoApprove ?? {};
    this.policy = new PermissionPolicy(o.config);
    this.budget = new Budget(o.config.limits);
    this.persist = o.persist ?? true;
    const s = summarize(this.id, this.events);
    this.status = this.events.length ? s.status : "idle";
    const todos = [...this.events].reverse().find((e) => e.type === "todo.update");
    if (todos?.type === "todo.update") this.todos.push(...todos.items.map((item) => ({ ...item })));
    this.isSandbox = !!o.sandbox;
    this.defaultOutputDir = o.defaultOutputDir;
    this.depth = o.depth ?? 0;
    this.readOnly = !!o.readOnly;
    this.toolRestriction = o.toolNames?.length ? [...o.toolNames] : undefined;
    this.parentSessionId = o.parentSessionId;
    this.goalId = o.goalId;
    if (o.spawnSession) this.agentManager = new AgentManager(this, o.spawnSession);
    for (const name of this.secretEnv) registerSecret(process.env[name]);
  }

  /** Subagent manager; undefined when this session cannot spawn (no factory or at max depth). */
  get agents(): AgentManager | undefined {
    return this.agentManager && this.depth < maxAgentDepth(this.config) ? this.agentManager : undefined;
  }

  /** Live subagent sessions spawned by this session. */
  childSessions(): Session[] {
    return this.agentManager?.childSessions() ?? [];
  }

  /** Replace the run limits used by the next run (goal budgets). */
  setLimits(limits: HarnessConfig["limits"]): void {
    this.config.limits = { ...limits };
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get isRunning(): boolean {
    return this.running || this.isExternalRun;
  }

  get isExternalRun(): boolean {
    return !this.running && sessionHasProjectLock(this.projectRoot, this.id);
  }

  /** Merge another process's output without writing it back or replaying old events. */
  syncFromStore(): void {
    if (this.running || !this.persist || !this.store.exists(this.id)) return;
    const batch = this.store.readAfter(this.id, this.tailOffset, this.seq);
    this.tailOffset = batch.offset;
    for (const event of batch.events) {
      if (event.seq <= this.seq) continue;
      this.seq = event.seq;
      this.events.push(event);
      if (event.type === "status") this.status = event.status;
      if (event.type === "todo.update") this.todos.splice(0, this.todos.length, ...event.items);
      if (event.type === "session.settings" || event.type === "session.created") {
        if (event.models) this.config.models = { ...this.config.models, ...event.models };
        if (event.permissionMode) this.policy.mode = event.permissionMode;
        if (event.reasoningEffort !== undefined) this.config.reasoningEffort = event.reasoningEffort;
      }
      for (const listener of [...this.listeners]) {
        try {
          listener(event);
        } catch {
          /* Isolate broken subscribers. */
        }
      }
    }
    // An already-loaded snapshot may end in a live terminal run. The lock distinguishes
    // it from a process that died, for which the persisted "running" status is stale.
    const external = this.isExternalRun;
    if (external) {
      const status = [...this.events].reverse().find((e) => e.type === "status");
      if (status?.type === "status") this.status = status.status;
    } else if (this.observedExternalRun && ["running", "waiting"].includes(this.status)) this.status = "idle";
    this.observedExternalRun = external;
  }

  get secretEnv(): string[] {
    return [
      ...UNSPLASH_SECRET_ENV,
      ...Object.values(this.config.providers)
        .map((p) => p.apiKeyEnv)
        .filter((x): x is string => !!x),
    ];
  }

  get verifyRunner(): VerifyRunner {
    this._verify ??= new VerifyRunner(this.projectRoot, this.config, (e) => this.emit(e), this.secretEnv);
    return this._verify;
  }

  info(): SessionInfo {
    const { runStartedAt, interrupted: _i, ...s } = summarize(this.id, this.events, true);
    const runner = this.running ? undefined : projectLockOwner(this.projectRoot, this.id);
    const active = this.status === "running" || this.status === "waiting";
    return {
      ...s,
      status: this.status,
      model: this.config.models.executor,
      reasoningEffort: this.config.reasoningEffort ?? "auto",
      permissionMode: this.policy.mode,
      externalRun: !!runner,
      ...(runner ? { runner } : {}),
      ...(active && runStartedAt ? { runStartedAt } : {}),
      ...(this.wasInterrupted ? { interrupted: true } : {}),
    };
  }

  /** The log ends in an active run that no live process owns: it was cut off by a crash or quit. */
  get wasInterrupted(): boolean {
    if (this.running) return false;
    const last = [...this.events].reverse().find((e) => e.type === "status");
    return (
      last?.type === "status" &&
      (last.status === "running" || last.status === "waiting") &&
      !this.isExternalRun
    );
  }

  // ------------------------------------------------------------------ events

  emit(body: EventBody): HarnessEvent {
    if (!this.running) {
      this.syncFromStore();
      if (this.isExternalRun)
        throw new Error("This session is running in another process. Use that terminal to control it.");
    }
    const event = redactValue({
      v: PROTOCOL_VERSION,
      seq: ++this.seq,
      ts: new Date().toISOString(),
      sessionId: this.id,
      ...body,
    }) as HarnessEvent;
    this.events.push(event);
    this.lastUsedAt = Date.now();
    if (this.persist) this.store.append(event);
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        /* a broken listener must not break the run */
      }
    }
    return event;
  }

  /** Subscribe to events. Replays stored events with seq > afterSeq first (for SSE reconnects). */
  /** Live subscribers (open event streams, terminals). */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Whether this process runs the session right now (not another process). */
  get isRunningHere(): boolean {
    return this.running;
  }

  subscribe(listener: Listener, afterSeq?: number): () => void {
    this.syncFromStore();
    if (afterSeq !== undefined) for (const e of this.events) if (e.seq > afterSeq) listener(e);
    this.listeners.add(listener);
    if (!this.tailTimer) {
      this.tailTimer = setInterval(() => {
        try {
          this.syncFromStore();
        } catch {
          /* Retry after a transient filesystem error. */
        }
      }, 250);
      this.tailTimer.unref();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.tailTimer) {
        clearInterval(this.tailTimer);
        this.tailTimer = undefined;
      }
    };
  }

  private setStatus(s: SessionStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit({ type: "status", status: s });
  }

  // ------------------------------------------------------------------ interactions

  pendingRequests(): HarnessEvent[] {
    return [...this.pending.values()].map((p) => p.event);
  }

  private wait<T>(kind: Pending["kind"], event: HarnessEvent, id: string): Promise<T> {
    const resumeBudget = this.budget.pauseForInput();
    const signal = this.signal;
    let onAbort: (() => void) | undefined;
    return new Promise<T>((resolvePromise, reject) => {
      if (signal.aborted) return reject(abortError());
      this.pending.set(id, { kind, resolve: resolvePromise, event });
      onAbort = () => {
        if (this.pending.delete(id)) reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.setStatus("waiting");
    }).finally(() => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      resumeBudget();
      if (this.running && this.pending.size === 0) this.setStatus("running");
    });
  }

  async requestPermission(
    tool: string,
    args: unknown,
    risk: Risk,
    reason?: string,
  ): Promise<PermissionDecision> {
    const id = newId("perm_");
    const ev = this.emit({ type: "permission.request", id, tool, args, risk, reason });
    if (this.autoApprove.permissions) {
      this.emit({ type: "permission.resolved", id, decision: "allow", auto: true });
      return "allow";
    }
    return this.wait<PermissionDecision>("permission", ev, id);
  }

  resolvePermission(id: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(id);
    if (!p || p.kind !== "permission") return false;
    if (!["allow", "deny", "always"].includes(decision)) throw new Error(`Invalid decision "${decision}"`);
    this.pending.delete(id);
    this.emit({ type: "permission.resolved", id, decision });
    p.resolve(decision);
    return true;
  }

  async ask(text: string, options?: string[]): Promise<string> {
    const id = newId("q_");
    const ev = this.emit({ type: "question", id, text, options });
    if (this.autoApprove.questions !== undefined) {
      this.emit({ type: "question.answered", id, answer: this.autoApprove.questions });
      return this.autoApprove.questions;
    }
    return this.wait<string>("question", ev, id);
  }

  answerQuestion(id: string, answer: string): boolean {
    const p = this.pending.get(id);
    if (!p || p.kind !== "question") return false;
    this.pending.delete(id);
    this.emit({ type: "question.answered", id, answer });
    p.resolve(answer);
    return true;
  }

  async requestPlanDecision(
    markdown: string,
    path: string,
  ): Promise<{ decision: PlanDecision; markdown?: string; feedback?: string }> {
    const id = newId("plan_");
    const ev = this.emit({ type: "plan.proposed", id, markdown, path });
    if (this.autoApprove.plan) {
      this.emit({ type: "plan.decision", id, decision: "approve" });
      return { decision: "approve" };
    }
    return this.wait("plan", ev, id);
  }

  decidePlan(id: string, decision: PlanDecision, markdown?: string, feedback?: string): boolean {
    const p = this.pending.get(id);
    if (!p || p.kind !== "plan") return false;
    if (!["approve", "reject", "edit"].includes(decision)) throw new Error(`Invalid decision "${decision}"`);
    this.pending.delete(id);
    this.emit({ type: "plan.decision", id, decision, markdown, feedback });
    p.resolve({ decision, markdown, feedback });
    return true;
  }

  cancel(): void {
    if (!this.running) return;
    this.abort.abort();
  }

  // ------------------------------------------------------------------ checkpoints

  /** Whether turns of this session snapshot the workspace (top-level, writable, real project folders). */
  get checkpointsEnabled(): boolean {
    return (
      this.config.checkpoints?.enabled !== false &&
      !this.readOnly &&
      this.depth === 0 &&
      !isWorkspaceContainer(this.projectRoot)
    );
  }

  private checkpointStore(): CheckpointStore {
    this.checkpoints ??= new CheckpointStore(this.projectRoot, join(dirname(this.store.dir), "checkpoints"));
    return this.checkpoints;
  }

  /** Snapshot the workspace; a failure is reported as an event and never blocks the turn. */
  private async takeCheckpoint(reason: "turn" | "restore", messageId?: string): Promise<string | undefined> {
    if (!this.checkpointsEnabled) return undefined;
    const id = newId("cp_");
    try {
      const cp = await this.checkpointStore().create(
        `${this.id}/${id}`,
        `${reason === "turn" ? "Before turn" : "Before restore"} · session ${this.id}`,
      );
      this.emit({
        type: "checkpoint.created",
        id,
        reason,
        commit: cp.commit,
        files: cp.files,
        ...(messageId ? { messageId } : {}),
      });
      return id;
    } catch (e) {
      this.emit({ type: "checkpoint.failed", reason, message: (e as Error).message });
      return undefined;
    }
  }

  private checkpointCommit(id: string): string {
    const e = this.events.find((e) => e.type === "checkpoint.created" && e.id === id);
    if (e?.type !== "checkpoint.created") throw new Error(`No checkpoint ${id} in this session`);
    return e.commit;
  }

  /** Files restoring checkpoint `id` would change, compared with the workspace now. */
  async previewCheckpoint(id: string): Promise<CheckpointChange[]> {
    this.syncFromStore();
    // Staging the preview would contend with a running turn's checkpoint for the shadow index.lock.
    if (this.isRunning) throw new Error("Stop the session before previewing a checkpoint");
    if (!this.checkpointsEnabled) throw new Error("Checkpoints are disabled for this session");
    const commit = this.checkpointCommit(id);
    if (this.checkpointBusy) throw new Error("A checkpoint operation is already in progress");
    this.checkpointBusy = true;
    try {
      const store = this.checkpointStore();
      if (!(await store.exists(commit))) throw new Error("This checkpoint is no longer available");
      return await store.preview(commit);
    } finally {
      this.checkpointBusy = false;
    }
  }

  /**
   * Reset the workspace files to checkpoint `id`. The current state is checkpointed first, so the
   * restore can be undone by restoring the `backupId` of the emitted `checkpoint.restored` event.
   */
  async restoreCheckpoint(id: string): Promise<{ backupId: string; files: CheckpointChange[] }> {
    this.syncFromStore();
    if (this.isRunning) throw new Error("Stop the session before restoring a checkpoint");
    if (!this.checkpointsEnabled) throw new Error("Checkpoints are disabled for this session");
    if (this.checkpointBusy) throw new Error("A checkpoint operation is already in progress");
    const commit = this.checkpointCommit(id);
    const store = this.checkpointStore();
    // Take `running` before the first await so a chat or second restore cannot start in between; it
    // also keeps emit() from mistaking our own project lock for another process's run.
    this.running = true;
    let release: (() => void) | undefined;
    try {
      if (!(await store.exists(commit))) throw new Error("This checkpoint is no longer available");
      release = acquireProjectLock(this.projectRoot, this.id);
      const backupId = await this.takeCheckpoint("restore");
      if (!backupId)
        throw new Error("Could not save the current files before restoring; nothing was changed");
      const files = await store.restore(commit, this.checkpointCommit(backupId));
      this.emit({
        type: "checkpoint.restored",
        id,
        backupId,
        files: files.slice(0, 200),
        changed: files.length,
      });
      return { backupId, files };
    } finally {
      release?.();
      this.running = false;
    }
  }

  // ------------------------------------------------------------------ editing the conversation

  /**
   * Delete a message from the transcript and from every agent's context. A user message takes its whole
   * exchange with it; an assistant reply takes its tool calls and their results.
   */
  deleteMessage(messageId: string): { ids: string[] } {
    this.syncFromStore();
    if (this.isRunning) throw new Error("Stop the session before deleting messages");
    const plan = planDeletion(this.events, messageId);
    this.emit(plan.deleted);
    for (const [agent, messages] of Object.entries(plan.contexts))
      this.emit({ type: "context.replace", agent, messages, reason: "messages deleted" });
    // The failed or stopped run is gone, so there is nothing left to continue.
    if (plan.removesLastDone && (this.status === "failed" || this.status === "cancelled"))
      this.setStatus("idle");
    return { ids: plan.deleted.ids };
  }

  /** Append the messages a branch added since it was cut (or last merged) to this conversation. */
  mergeBranch(branch: Session): { messages: number } {
    this.syncFromStore();
    branch.syncFromStore();
    if (this.isRunning) throw new Error("Stop this conversation before merging into it");
    if (branch.isRunning) throw new Error("Stop the branch before merging it");
    const forked = [...branch.events].reverse().find((e) => e.type === "session.forked");
    if (forked?.type !== "session.forked" || forked.fromSessionId !== this.id)
      throw new Error("That conversation is not a branch of this one");
    const lastMerge = [...this.events]
      .reverse()
      .find((e) => e.type === "branch.merged" && e.branchSessionId === branch.id);
    const afterSeq = Math.max(
      // The branch's own events start right after its session.forked marker.
      forked.seq,
      lastMerge?.type === "branch.merged" ? lastMerge.toSeq : 0,
    );
    const title = branch.info().title;
    const merge = branchEventsToMerge(branch.events, afterSeq, title ? `"${title}"` : branch.id);
    if (!merge.messages) throw new Error("The branch has no new messages to merge");
    this.emit({
      type: "branch.merged",
      branchSessionId: branch.id,
      ...(title ? { branchTitle: title } : {}),
      fromSeq: afterSeq,
      toSeq: merge.toSeq,
      messages: merge.messages,
    });
    for (const body of merge.bodies) this.emit(body);
    return { messages: merge.messages };
  }

  /** Context for the model after the user restored a checkpoint since the last message. */
  private restoreNote(): string {
    let restored: Extract<HarnessEvent, { type: "checkpoint.restored" }> | undefined;
    for (const e of this.events) {
      if (e.type === "checkpoint.restored") restored = e;
      if (e.type === "message.start" && e.role === "user") restored = undefined;
    }
    if (!restored?.changed) return "";
    const list = restored.files.map((f) => `- ${f.path}`).join("\n");
    return `[The user restored the workspace files to an earlier checkpoint. ${restored.changed} file(s) changed since your last turn and earlier edits may be undone, so re-read files before editing them:\n${list}${restored.changed > restored.files.length ? "\n- …" : ""}]\n\n`;
  }

  // ------------------------------------------------------------------ running

  /** Run work that is not an agent run (e.g. `recreateInSession`) as this session's run: lock, status, cancel(). */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.startTurn();
      return fn();
    });
  }

  /**
   * Turn setup after the user message is in the log: snapshot the workspace (files are untouched until
   * the agent runs, so taking it after the message is equivalent) and connect MCP servers. Emitting
   * the message first keeps the slow `git add` from delaying it (session titles derive from it).
   */
  private async startTurn(messageId?: string): Promise<void> {
    await this.takeCheckpoint("turn", messageId);
    await this.ensureMcp();
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.syncFromStore();
    if (this.isRunning) throw new Error("Session is already running");
    if (this.checkpointBusy) throw new Error("A checkpoint operation is in progress");
    this.running = true;
    activeRuns++;
    this.abort = new AbortController();
    this.budget = new Budget(this.config.limits);
    let release: (() => void) | undefined;
    try {
      // Read-only subagents share their parent's checkout and must not take its lock.
      if (!this.readOnly) release = acquireProjectLock(this.projectRoot, this.id);
      this.setStatus("running");
      return await fn();
    } finally {
      // Children never outlive their parent's run.
      await this.agentManager?.shutdown().catch(() => undefined);
      release?.();
      this.running = false;
      activeRuns--;
      for (const p of this.pending.values())
        p.resolve(p.kind === "permission" ? "deny" : p.kind === "plan" ? { decision: "reject" } : "");
      this.pending.clear();
    }
  }

  private async ensureMcp(): Promise<void> {
    if (this.mcp) return;
    const servers = this.config.mcpServers ?? {};
    if (!Object.keys(servers).length) {
      this.mcp = { clients: [], tools: [] };
      return;
    }
    this.mcp = await connectMcpServers(servers, (name, err) =>
      this.emit({ type: "log", level: "warn", message: `MCP server ${name} failed: ${err.message}` }),
    );
    if (this.mcp.tools.length)
      this.emit({
        type: "log",
        level: "info",
        message: `MCP tools: ${this.mcp.tools.map((t) => t.name).join(", ")}`,
      });
  }

  close(): void {
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.tailTimer = undefined;
    for (const c of this.mcp?.clients ?? []) c.close();
    this.mcp = undefined;
  }

  private host(chat = false): AgentHost {
    return {
      projectRoot: this.projectRoot,
      outputDir: chat ? this.chatOutputDir() : undefined,
      config: this.config,
      signal: this.signal,
      emit: (e) => this.emit(e),
      requestPermission: (t, a, r, reason) => this.requestPermission(t, a, r, reason),
      ask: (q, o) => this.ask(q, o),
      todos: this.todos,
      secretEnv: this.secretEnv,
      budget: this.budget,
      agents: this.agents,
      permissionMode: () => this.policy.mode,
      autoApprovesPermissions: () => !!this.autoApprove.permissions,
      complete: (role, messages, o) => this.complete(role, messages, o),
      historyLog: (agent) => this.historyLog(agent),
    };
  }

  /**
   * Folder for the files a chat creates, so Chat mode does not add files to the user's repository. Not used in
   * sandboxes (the whole folder belongs to the chat), by subagents or by read-only sessions. One subfolder per
   * chat, named after its first message so it is easy to find in ~/Documents/CDR.
   */
  chatOutputDir(): string | undefined {
    if (this.isSandbox || this.readOnly || this.parentSessionId) return undefined;
    const base =
      this.config.outputDir === false ? undefined : (outputBaseDir(this.config) ?? this.defaultOutputDir);
    if (!base) return undefined;
    // Duplicates and branches keep writing to the folder of the conversation they came from.
    const origin = this.events.find((e) => e.type === "session.forked");
    const id = origin?.type === "session.forked" ? origin.fromSessionId : this.id;
    return join(base, `${(this.outputSlug ??= this.firstMessageSlug()) ?? "chat"}-${id.slice(-6)}`);
  }

  private outputSlug?: string;

  /** Slug of the first user message (undefined before it ends, or when it has no Latin letters or digits). */
  private firstMessageSlug(): string | undefined {
    let userId: string | undefined;
    for (const e of this.events) {
      if (e.type === "message.start" && e.role === "user") userId ??= e.id;
      else if (e.type === "message.end" && e.id === userId) {
        // slugify falls back to "task" for text such as Chinese or emoji; "chat" names those folders.
        return /[a-z0-9]/i.test(e.text) ? slugify(e.text, 32) : "chat";
      }
    }
    return undefined;
  }

  /** Raw history removed by compaction, kept inside the project so the agent's grep/read_file can reach it. */
  private historyLog(agent: string): HistoryLog | undefined {
    if (this.readOnly) return undefined;
    const ref = `.harness/history/${this.id}-${agent.replace(/[^\w.-]+/g, "_")}.log`;
    return { file: join(this.projectRoot, ref), ref };
  }

  /** One model call outside the agent loop (recreate naming / vision / repair), usage counted. */
  async complete(
    roleOrRef: string,
    messages: ChatMessage[],
    o: { maxTokens?: number } = {},
  ): Promise<string> {
    const m = this.model(roleOrRef);
    const res = await collect(
      m.provider.stream({ model: m.model, messages, signal: this.signal, maxTokens: o.maxTokens ?? 8000 }),
    );
    const cost =
      ((m.pricing?.inputPrice ?? 0) * res.usage.input + (m.pricing?.outputPrice ?? 0) * res.usage.output) /
      1_000_000;
    this.budget.add(res.usage.input, res.usage.output, cost);
    this.emit({
      type: "usage",
      inputTokens: res.usage.input,
      outputTokens: res.usage.output,
      cost: cost || undefined,
      model: m.ref,
      purpose: "other",
    });
    return res.text;
  }

  allTools(): Tool[] {
    return [
      ...builtinTools(),
      ...recreateTools(this.config.recreate?.enabled !== false),
      ...(this.agents ? [spawnAgentTool, waitAgentsTool] : []),
      ...(this.mcp?.tools ?? []),
    ];
  }

  readProjectFile(rel: string): string | null {
    try {
      const abs = resolveInProject(this.projectRoot, rel);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    } catch {
      return null;
    }
  }

  private snapshotHook(): AgentHooks {
    return {
      beforeTool: (call, args: any) => {
        if ((call.name === "write_file" || call.name === "patch_file") && typeof args?.path === "string") {
          const key = args.path.replace(/^\.\//, "");
          if (!this.snapshots.has(key)) this.snapshots.set(key, this.readProjectFile(key) ?? "");
        }
      },
    };
  }

  private model(roleOrRef: ModelRole | string): {
    provider: Provider;
    model: string;
    ref: string;
    pricing?: { inputPrice?: number; outputPrice?: number };
  } {
    const ref = resolveModelRef(this.config, roleOrRef);
    const r = this.providers.resolve(ref);
    const pc = this.config.providers[ref.slice(0, ref.indexOf("/"))];
    return { ...r, pricing: pc?.models?.[r.model] };
  }

  /** Used by the workflow engine to run one phase agent. */
  async runPhaseAgent(o: {
    agent: string;
    phase: Phase | "chat";
    role: ModelRole | string;
    user: string;
    toolNames?: string[];
    readOnly?: boolean;
    continueFrom?: ChatMessage[];
    extraSystem?: string;
    includeRepoMap?: boolean;
    images?: ImagePart[];
  }): Promise<AgentResult> {
    const m = this.model(o.role);
    o = { ...o, readOnly: o.readOnly || this.readOnly };
    let tools = this.allTools();
    if (this.toolRestriction) {
      const allowed = new Set(this.toolRestriction);
      tools = tools.filter((t) => allowed.has(t.name));
    }
    if (o.readOnly)
      tools = tools
        .map((t) => (t.name === "bash" ? bashTool({ readOnlyMode: true }) : t))
        .filter((t) => t.readOnly);
    if (o.toolNames) {
      const allowed = new Set(o.toolNames);
      tools = tools.filter(
        (t) => allowed.has(t.name) || (t.name.startsWith("mcp__") && (!o.readOnly || t.readOnly)),
      );
    }
    // A continued conversation keeps its system prompt, so selected skills travel with the user message.
    const content =
      o.continueFrom && this.selectedSkills.length
        ? [...this.selectedSkills.map(renderSkill), o.user].join("\n\n")
        : o.user;
    const userMsg: ChatMessage = o.images?.length
      ? { role: "user", content, images: o.images }
      : { role: "user", content };
    const messages: ChatMessage[] = o.continueFrom
      ? [...o.continueFrom, userMsg]
      : [
          {
            role: "system",
            content: buildSystemPrompt({
              projectRoot: this.projectRoot,
              phase: o.phase,
              config: this.config,
              extra:
                [
                  o.extraSystem,
                  this.isSandbox ? SANDBOX_PROMPT : "",
                  o.phase === "chat" ? outputPrompt(this.chatOutputDir()) : "",
                  this.skillPrompt(o.user, tools),
                ]
                  .filter(Boolean)
                  .join("\n\n") || undefined,
              includeRepoMap: o.includeRepoMap,
            }),
          },
          userMsg,
        ];
    const hooks: AgentHooks[] = [this.snapshotHook()];
    if (!o.readOnly)
      hooks.push(
        configHooks({
          config: this.config,
          projectRoot: this.projectRoot,
          signal: this.signal,
          secretEnv: this.secretEnv,
          emit: (e) => this.emit(e),
        }),
      );
    let summarizer:
      | {
          provider: Provider;
          model: string;
          ref?: string;
          pricing?: { inputPrice?: number; outputPrice?: number };
        }
      | undefined;
    try {
      const s = this.model("summarizer");
      summarizer = { provider: s.provider, model: s.model, ref: s.ref, pricing: s.pricing };
    } catch {
      summarizer = undefined;
    }
    return runAgent({
      host: this.host(o.phase === "chat"),
      agent: o.agent,
      provider: m.provider,
      model: m.model,
      modelRef: m.ref,
      messages,
      recordFrom: o.continueFrom ? o.continueFrom.length : 0,
      tools,
      hooks,
      verify: this.verifyRunner,
      summarizer,
      policy: this.policy,
      pricing: m.pricing,
    });
  }

  /**
   * Skills section of a fresh system prompt: the index of available skills (when the agent can call
   * load_skill) plus the full text of skills whose triggers match the task in this session.
   */
  private skillPrompt(task: string, tools: Tool[]): string {
    let skills;
    try {
      skills = discoverSkills(this.projectRoot, this.config);
    } catch (e) {
      this.emit({ type: "log", level: "warn", message: `Skills unavailable: ${(e as Error).message}` });
      return "";
    }
    if (!skills.length && !this.selectedSkills.length) return "";
    const selected = this.selectedSkills;
    const matched = matchSkills(skills, task, { sandbox: this.isSandbox }).filter(
      (s) => !selected.some((x) => x.name === s.name),
    );
    const active = [...selected, ...matched];
    const canLoad = tools.some((t) => t.name === "load_skill");
    for (const s of matched) {
      this.emit({ type: "log", level: "info", message: `Skill ${s.name} activated` });
      const files = listSkillFiles(s);
      this.emit({
        type: "skill.activated",
        name: s.name,
        description: s.description,
        source: s.source,
        content: s.body,
        ...(files.length ? { files } : {}),
      });
    }
    return [
      canLoad
        ? skillsIndex(
            skills,
            active.map((s) => s.name),
          )
        : "",
      ...active.map(renderSkill),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private emitUserMessage(text: string, attachments?: AttachmentInfo[], skills?: Skill[]): string {
    const id = newId("msg_");
    this.emit({ type: "message.start", id, role: "user" });
    this.emit({
      type: "message.end",
      id,
      text,
      ...(attachments?.length ? { attachments } : {}),
      ...(skills?.length ? { skills: skills.map((s) => s.name) } : {}),
    });
    return id;
  }

  /** Resolve skills selected for a message by name; throws on unknown names. */
  resolveSkills(names: string[] | undefined): Skill[] {
    if (!names?.length) return [];
    const { selected, unknown } = selectSkills(discoverSkills(this.projectRoot, this.config), names);
    if (unknown.length)
      throw new Error(`Unknown skill${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    return selected;
  }

  /** Selected skills stay in effect (system prompt or user message of every agent) until the turn ends. */
  private activateSelected(skills: Skill[]): void {
    // A selected redirect skill (grill-me → grilling) brings the skills it hands off to.
    let delegated: Skill[] = [];
    if (skills.length)
      try {
        delegated = delegatedSkills(skills, discoverSkills(this.projectRoot, this.config));
      } catch {
        /* skills unavailable: keep the selection as is */
      }
    this.selectedSkills = [...skills, ...delegated];
    for (const s of this.selectedSkills) {
      const files = listSkillFiles(s);
      this.emit({
        type: "skill.activated",
        name: s.name,
        description: s.description,
        source: s.source,
        reason: skills.includes(s) ? "selected" : "matched",
        content: s.body,
        ...(files.length ? { files } : {}),
      });
    }
  }

  /** Sandboxes: if the agent built a web page but never published it, show it anyway. */
  private autoPreview(): void {
    if (!this.isSandbox) return;
    if (this.events.some((e) => e.type === "preview.ready")) return;
    const entry = ["index.html", "dist/index.html", "build/index.html", "public/index.html"].find((p) =>
      existsSync(join(this.projectRoot, p)),
    );
    if (entry) this.emit({ type: "preview.ready", path: entry });
  }

  /** Change models / permission mode / title of this session (recorded as an event, re-applied on resume). */
  updateSettings(o: SessionSettingsRequest): void {
    this.syncFromStore();
    if (this.isExternalRun)
      throw new Error("This session is running in another process. Use that terminal to control it.");
    if (this.isRunning && (o.models || o.reasoningEffort !== undefined))
      throw new Error("Cannot change model or thinking effort while running");
    if (o.reasoningEffort !== undefined) validateReasoningEffort(o.reasoningEffort);
    if (o.reasoningEffort !== undefined || o.models)
      validateModelEffort(
        o.reasoningEffort ?? this.config.reasoningEffort,
        o.models?.executor ?? this.config.models.executor,
        this.providers,
      );
    if (o.models) {
      for (const [role, ref] of Object.entries(o.models)) {
        if (!ref) continue;
        const { provider } = parseModelRef(ref);
        if (!this.config.providers[provider])
          throw new Error(`Unknown provider "${provider}" in ${role}=${ref}`);
      }
      this.config.models = { ...this.config.models, ...o.models };
    }
    if (o.permissionMode) {
      if (!["ask", "auto", "yolo"].includes(o.permissionMode)) throw new Error(`Invalid permission mode`);
      this.policy.mode = o.permissionMode;
    }
    if (o.reasoningEffort !== undefined) this.config.reasoningEffort = o.reasoningEffort;
    this.emit({ type: "session.settings", ...o });
  }

  /**
   * Why the models these roles use cannot run yet (e.g. no API key), or undefined when they can.
   * Checked before a turn starts so the user is told to connect a model instead of seeing a run fail.
   */
  modelProblem(roles: ModelRole[] = ["executor"]): string | undefined {
    for (const role of roles) {
      const problem = modelConnectionProblem(
        this.config,
        this.providers,
        this.config.models[role] ?? this.config.models.executor,
      );
      if (problem) return problem;
    }
    return undefined;
  }

  /** Interactive chat turn with the executor, continuing the session's conversation. */
  async chat(
    text: string,
    attachments?: Attachment[],
    opts: { skills?: string[] } = {},
  ): Promise<ChatResult> {
    const skills = this.resolveSkills(opts.skills);
    return this.exclusive(async () => {
      const history = rebuildMessages(this.events, "chat");
      const note = history.length ? this.restoreNote() : "";
      const att = processAttachments(this.projectRoot, this.id, attachments);
      const messageId = this.emitUserMessage(text, att.infos, skills);
      let r: AgentResult;
      try {
        await this.startTurn(messageId);
        this.activateSelected(skills);
        r = await this.runPhaseAgent({
          agent: "chat",
          phase: "chat",
          role: "executor",
          user: note + text + att.text,
          images: att.images,
          continueFrom: history.length ? history : undefined,
        });
      } catch (e) {
        // e.g. a provider without its API key: end the turn instead of leaving the session "running"
        if (this.signal.aborted)
          r = { status: "cancelled", finalText: "", messages: [], turns: 0, edited: [], diffs: [] };
        else {
          const message = (e as Error).message;
          this.emit({ type: "error", message, recoverable: true });
          r = {
            status: "error",
            finalText: "",
            messages: [],
            turns: 0,
            edited: [],
            diffs: [],
            error: message,
          };
        }
      } finally {
        this.selectedSkills = [];
      }
      const status = r.status === "completed" ? "success" : r.status === "cancelled" ? "cancelled" : "failed";
      this.autoPreview();
      this.emit({ type: "done", status, summary: r.finalText.slice(0, 2000) });
      this.setStatus(status === "success" ? "idle" : status === "cancelled" ? "cancelled" : "failed");
      return { status: r.status, text: r.finalText };
    });
  }

  /** Subagent run: one chat-style agent with the given model role; its final text goes back to the parent. */
  async runSubagent(task: string, role: ModelRole | string = "executor"): Promise<ChatResult> {
    return this.exclusive(async () => {
      const messageId = this.emitUserMessage(task);
      let r: AgentResult;
      try {
        await this.startTurn(messageId);
        r = await this.runPhaseAgent({
          agent: "chat",
          phase: "chat",
          role,
          user: task,
          extraSystem: [SUBAGENT_PROMPT, this.readOnly ? READ_ONLY_SUBAGENT_PROMPT : ""]
            .filter(Boolean)
            .join("\n\n"),
        });
      } catch (e) {
        const message = (e as Error).message;
        this.emit({ type: "error", message, recoverable: false });
        r = { status: "error", finalText: "", messages: [], turns: 0, edited: [], diffs: [], error: message };
      }
      if (this.signal.aborted && r.status !== "completed") r = { ...r, status: "cancelled" };
      const status = r.status === "completed" ? "success" : r.status === "cancelled" ? "cancelled" : "failed";
      this.emit({ type: "done", status, summary: r.finalText.slice(0, 4000) || r.error });
      this.setStatus(status === "success" ? "done" : status === "cancelled" ? "cancelled" : "failed");
      return { status: r.status, text: r.finalText, error: r.error };
    });
  }

  /** Run a task through a workflow (plan → execute → verify → review → finish by default). */
  continueJob(): Promise<RunResult | ChatResult> {
    if (this.running) throw new Error("Session is already running");
    if (this.status !== "failed" && this.status !== "cancelled" && !this.wasInterrupted)
      throw new Error("There is no failed, stopped or interrupted job to continue");
    const latestUser = [...this.events]
      .reverse()
      .find((e) => e.type === "message.start" && e.role === "user");
    const run = [...this.events].reverse().find((e) => e.type === "run.start");
    if (run?.type !== "run.start" || (latestUser && latestUser.seq > run.seq))
      return this.chat(
        "Continue the interrupted request. Inspect the current files, preserve completed work, and finish the remaining work. Address the previous failure before retrying.",
      );
    // Follow the explicit chain so repeated retries retain the original approved plan.
    let origin = run;
    while (origin.continuedFrom) {
      const parent = this.events.find((e) => e.seq === origin.continuedFrom);
      if (parent?.type !== "run.start" || parent.seq >= origin.seq) break;
      origin = parent;
    }
    const events = this.events.filter((e) => e.seq >= origin.seq);
    let plan: string | undefined, planPath: string | undefined;
    for (const event of events) {
      if (event.type === "plan.proposed") {
        plan = undefined;
        planPath = undefined;
      }
      if (event.type !== "plan.decision" || !["approve", "edit"].includes(event.decision)) continue;
      const proposed = events.find((e) => e.type === "plan.proposed" && e.id === event.id);
      if (proposed?.type === "plan.proposed") {
        plan = event.decision === "edit" ? event.markdown : proposed.markdown;
        planPath = proposed.path;
      }
    }
    let contextStart = 0;
    events.forEach((e, i) => {
      if (
        (e.type === "context.append" && e.agent === "executor" && e.message.role === "system") ||
        (e.type === "context.replace" && e.agent === "executor")
      )
        contextStart = i;
    });
    const edited = new Set<string>(),
      diffs: string[] = [];
    for (const event of events) {
      if (event.type !== "tool.result" || !event.ok || !event.diff) continue;
      diffs.push(event.diff);
      const call = events.find((e) => e.type === "tool.call" && e.id === event.id);
      if (call?.type === "tool.call" && typeof (call.args as { path?: unknown })?.path === "string")
        edited.add((call.args as { path: string }).path);
    }
    const errors = events
      .filter((e) => e.type === "error" || (e.type === "verify.result" && e.exitCode !== 0))
      .slice(-4);
    const context = [
      `Previous failure or verification output:\n${JSON.stringify(errors).slice(-12000)}`,
      `Saved task checklist:\n${JSON.stringify(this.todos)}`,
      `Previously edited files:\n${[...edited].join("\n") || "Inspect the workspace and tool history."}`,
    ].join("\n\n");
    return this.run(run.task, {
      workflow: run.workflow,
      noPlan: origin.noPlan,
      commit: origin.commit,
      continuation: {
        fromSeq: run.seq,
        plan,
        planPath,
        context,
        edited: [...edited],
        diffs,
        messages: rebuildMessages(events.slice(contextStart), "executor"),
      },
    });
  }

  async run(
    task: string,
    opts: RunOptions & { attachments?: Attachment[]; skills?: string[] } = {},
  ): Promise<RunResult> {
    const skills = this.resolveSkills(opts.skills);
    return this.exclusive(async () => {
      const att = processAttachments(this.projectRoot, this.id, opts.attachments);
      const messageId = this.emitUserMessage(task, att.infos, skills);
      let result: RunResult;
      try {
        await this.startTurn(messageId);
        this.activateSelected(skills);
        result = await runWorkflow(this, task + att.text, { ...opts, images: att.images });
      } catch (e) {
        if (this.signal.aborted) result = { status: "cancelled", summary: "Cancelled.", edited: [] };
        else {
          this.emit({ type: "error", message: (e as Error).message, recoverable: false });
          result = { status: "failed", summary: `Failed: ${(e as Error).message}`, edited: [] };
        }
      } finally {
        this.selectedSkills = [];
      }
      this.autoPreview();
      this.emit({
        type: "done",
        status: result.status,
        summary: result.summary.slice(0, 4000),
        reportPath: result.reportPath,
      });
      this.setStatus(
        result.status === "success" ? "done" : result.status === "cancelled" ? "cancelled" : "failed",
      );
      return result;
    });
  }
}

export interface HarnessOptions {
  /** Directory for session JSONL files (default ~/.harness/sessions). */
  sessionsDir?: string;
  /** Inject provider instances by provider id (tests, embedding). */
  providers?: Record<string, Provider>;
  configOverrides?: Partial<HarnessConfig>;
  skipGlobalConfig?: boolean;
  /** Load .env from the project directory (default true). */
  loadEnv?: boolean;
  /** Where chats put the files they create when the config sets no `outputDir` (the terminal app: ~/Documents/CDR). */
  defaultOutputDir?: string;
}

export interface CreateSessionOptions {
  reasoningEffort?: ReasoningEffort;
  /** Existing project folder; omit together with `sandbox` to create a sandbox workspace. */
  projectPath?: string;
  /** Create a fresh sandbox workspace (folder name hint). */
  sandbox?: boolean | { name?: string };
  workflow?: string;
  models?: Partial<Record<ModelRole, string>>;
  permissionMode?: "ask" | "auto" | "yolo";
  title?: string;
  autoApprove?: AutoApprove;
  id?: string;
  /** Subagent: the spawning session. */
  parentSessionId?: string;
  /** Goal run: the goal id. */
  goalId?: string;
  /** Read-only tools for every agent; runs skip the per-project lock (shared subagents). */
  readOnly?: boolean;
  /** Restrict tools to these names. */
  toolNames?: string[];
  /** Subagent nesting depth (default 0). */
  depth?: number;
  /** Extra config overrides (limits, permissions.bash, …) applied on top of the project config. */
  configOverrides?: Partial<HarnessConfig>;
  /** Which app or tool started the conversation (recorded on session.created). */
  origin?: SessionOrigin;
}

function sandboxOverrides(): Partial<HarnessConfig> {
  return bwrapAvailable() ? { sandbox: "bwrap", sandboxNetwork: true } : {};
}

/** Entry point used by the CLI (in-process) and the server. */
export class Harness {
  readonly store: SessionStore;
  private readonly live = new Map<string, Session>();
  private readonly factory: SessionFactory = (o) => this.createSession(o);
  constructor(private readonly opts: HarnessOptions = {}) {
    this.store = new SessionStore(opts.sessionsDir);
  }

  /** Nesting depth of a stored session (number of parentSessionId hops). */
  private depthOf(info: SessionInfo): number {
    let depth = 0;
    let parent = info.parentSessionId;
    const seen = new Set<string>([info.id]);
    while (parent && !seen.has(parent) && depth < 16) {
      seen.add(parent);
      depth++;
      try {
        parent = this.live.get(parent)?.parentSessionId ?? this.store.info(parent).parentSessionId;
      } catch {
        break;
      }
    }
    return depth;
  }

  config(projectPath: string, extra?: Partial<HarnessConfig>): HarnessConfig {
    const root = realpathSync(resolve(projectPath));
    if (this.opts.loadEnv !== false) {
      loadDotEnv(root); // project .env wins (first loaded, never overridden)
      loadDotEnv(harnessHome()); // then the global ~/.harness/.env
    }
    return loadConfig({
      projectPath: root,
      skipGlobal: this.opts.skipGlobalConfig,
      overrides: mergeOverrides(this.opts.configOverrides, extra),
    });
  }

  createSession(o: CreateSessionOptions): Session {
    if (o.reasoningEffort !== undefined) validateReasoningEffort(o.reasoningEffort);
    const sandbox = !!o.sandbox || !o.projectPath || isWorkspaceContainer(o.projectPath);
    const projectRoot = sandbox
      ? createSandboxDir(typeof o.sandbox === "object" ? o.sandbox.name : o.title)
      : resolve(o.projectPath!);
    if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory())
      throw new Error(`Project path does not exist: ${projectRoot}`);
    const root = realpathSync(projectRoot);
    const overrides: Partial<HarnessConfig> = { ...(o.configOverrides ?? {}) };
    if (o.models) overrides.models = o.models;
    if (o.reasoningEffort !== undefined) overrides.reasoningEffort = o.reasoningEffort;
    // Sandboxes are throwaway folders: edit freely by default, confine shell commands when possible.
    const mode = o.permissionMode ?? (sandbox ? "auto" : undefined);
    if (mode) overrides.permissions = { ...(overrides.permissions ?? {}), mode };
    if (sandbox) Object.assign(overrides, sandboxOverrides());
    const config = this.config(root, overrides);
    const id = o.id ?? makeSessionId();
    const workflow = o.workflow ?? config.workflow ?? "default";
    const providers = new ProviderRegistry(config, this.opts.providers);
    validateModelEffort(config.reasoningEffort, config.models.executor, providers);
    const session = new Session({
      id,
      projectRoot: root,
      config,
      workflow,
      store: this.store,
      providers,
      autoApprove: o.autoApprove,
      sandbox,
      defaultOutputDir: this.opts.defaultOutputDir,
      spawnSession: this.factory,
      readOnly: o.readOnly,
      toolNames: o.toolNames,
      depth: o.depth,
      parentSessionId: o.parentSessionId,
      goalId: o.goalId,
    });
    session.emit({
      type: "session.created",
      projectPath: root,
      workflow,
      title: o.title,
      reasoningEffort: config.reasoningEffort ?? "auto",
      ...(o.models ? { models: o.models } : {}),
      ...(mode ? { permissionMode: mode } : {}),
      ...(sandbox ? { sandbox: true } : {}),
      ...(o.parentSessionId ? { parentSessionId: o.parentSessionId } : {}),
      ...(o.goalId ? { goalId: o.goalId } : {}),
      ...(o.origin && !o.parentSessionId && !o.goalId ? { origin: o.origin } : {}),
    });
    this.live.set(id, session);
    return session;
  }

  /** Get a live session or resume one from its event log. */
  getSession(
    id: string,
    o: { autoApprove?: AutoApprove; permissionMode?: "ask" | "auto" | "yolo" } = {},
  ): Session {
    const live = this.live.get(id);
    if (live) {
      live.lastUsedAt = Date.now();
      live.syncFromStore();
      return live;
    }
    const events = this.store.read(id);
    const info = summarize(id, events);
    if (!info.projectPath || !existsSync(info.projectPath))
      throw new Error(`Project for session ${id} no longer exists: ${info.projectPath}`);
    // Re-apply model / permission choices recorded in the log.
    let models: Partial<Record<ModelRole, string>> = {};
    let mode: "ask" | "auto" | "yolo" | undefined;
    let reasoningEffort: ReasoningEffort | undefined;
    for (const e of events) {
      if (e.type === "session.created" || e.type === "session.settings") {
        if (e.models) models = { ...models, ...e.models };
        if (e.permissionMode) mode = e.permissionMode;
        if (e.reasoningEffort !== undefined) reasoningEffort = e.reasoningEffort;
      }
    }
    mode = o.permissionMode ?? mode;
    const config = this.config(info.projectPath, {
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(Object.keys(models).length ? { models } : {}),
      ...(mode ? { permissions: { mode } } : {}),
      ...(info.sandbox ? sandboxOverrides() : {}),
    });
    const session = new Session({
      id,
      projectRoot: info.projectPath,
      config,
      workflow: info.workflow,
      store: this.store,
      providers: new ProviderRegistry(config, this.opts.providers),
      events,
      autoApprove: o.autoApprove,
      sandbox: info.sandbox,
      defaultOutputDir: this.opts.defaultOutputDir,
      spawnSession: this.factory,
      depth: this.depthOf(info),
      parentSessionId: info.parentSessionId,
      goalId: info.goalId,
    });
    this.live.set(id, session);
    session.syncFromStore();
    return session;
  }

  /**
   * Delete a conversation with its subagents: their logs, the subagents' worktrees, and their branches once
   * merged (unmerged branches and worktrees with uncommitted changes are kept and reported). With
   * `folder`, also remove the sandbox folder and its checkpoints when no other conversation uses it.
   * Refuses while the conversation or one of its subagents is running.
   */
  deleteSession(id: string, o: { folder?: boolean } = {}): DeleteSessionResponse {
    const all = this.store.list();
    const byId = new Map(all.map((s) => [s.id, s]));
    const ids = [id];
    for (let i = 0; i < ids.length; i++)
      for (const s of all) if (s.parentSessionId === ids[i] && !ids.includes(s.id)) ids.push(s.id);
    for (const sid of ids) {
      const running = this.live.get(sid)?.isRunning || byId.get(sid)?.externalRun;
      if (running)
        throw new Error(
          sid === id
            ? "Session is running; cancel it first"
            : "A subagent of this session is running; cancel it first",
        );
    }
    const out: DeleteSessionResponse = { ok: true, sessions: [], worktrees: [], branches: [], kept: [] };

    // Worktrees and branches recorded by the subagents these sessions spawned (deepest first, so a
    // worktree is still there while the subagents it spawned are cleaned up).
    for (const sid of [...ids].reverse()) {
      let events: HarnessEvent[] = [];
      try {
        events = this.store.read(sid);
      } catch {
        continue;
      }
      const from = byId.get(sid)?.projectPath;
      const repo = from && existsSync(from) ? repoRoot(from) : null;
      for (const e of events) {
        if (e.type !== "agent.spawned" || !e.worktree) continue;
        if (!repo) {
          out.kept.push(`${e.worktree} (repository not found)`);
          continue;
        }
        if (existsSync(e.worktree)) {
          // Not forced: a worktree with uncommitted changes is kept.
          const r = git(repo, ["worktree", "remove", e.worktree]);
          if (r.ok) out.worktrees.push(e.worktree);
          else out.kept.push(`${e.worktree} (${(r.err || r.out).trim() || "could not remove"})`);
        }
        git(repo, ["worktree", "prune"]);
        if (e.branch && branchExists(repo, e.branch)) {
          // `-d` refuses a branch whose commits are not merged into HEAD.
          const d = git(repo, ["branch", "-d", e.branch]);
          if (d.ok) out.branches.push(e.branch);
          else out.kept.push(`branch ${e.branch} (not merged)`);
        }
      }
    }

    const info = byId.get(id);
    if (o.folder && info?.sandbox && info.projectPath) {
      const folder = info.projectPath;
      const base = realpathOr(sandboxesDir());
      const real = realpathOr(folder);
      const inside = real.startsWith(base + sep) && real !== base;
      const shared = all.some(
        (s) => !ids.includes(s.id) && (s.projectPath === folder || s.projectPath.startsWith(folder + sep)),
      );
      if (!inside) out.kept.push(`${folder} (not a sandbox folder)`);
      else if (shared) out.kept.push(`${folder} (another conversation uses it)`);
      else {
        rmSync(real, { recursive: true, force: true });
        const key = createHash("sha1").update(resolve(folder)).digest("hex").slice(0, 16);
        rmSync(join(dirname(this.store.dir), "checkpoints", key), { recursive: true, force: true });
        out.folder = folder;
      }
    }

    for (const sid of [...ids].reverse()) {
      const live = this.live.get(sid);
      live?.close();
      this.live.delete(sid);
      this.store.delete(sid);
      out.sessions.push(sid);
    }
    return out;
  }

  /** Stop every run this process owns. Runs owned by another process are listed, not stopped. */
  cancelAll(): CancelAllResponse {
    const cancelled: string[] = [];
    for (const s of this.live.values())
      if (s.isRunningHere) {
        s.cancel();
        cancelled.push(s.id);
      }
    const external = this.store
      .list()
      .filter((s) => s.externalRun && !cancelled.includes(s.id))
      .map((s) => s.id);
    return { cancelled, external };
  }

  /**
   * Release conversations nobody is using: not running, no open event stream, untouched for `idleMs`.
   * Their events leave memory and their MCP servers are closed; the next request loads them again.
   */
  unloadIdle(idleMs: number, keep: (s: Session) => boolean = () => false): string[] {
    const now = Date.now();
    const unloaded: string[] = [];
    for (const [id, s] of this.live) {
      if (s.isRunningHere || s.listenerCount > 0 || now - s.lastUsedAt < idleMs || keep(s)) continue;
      s.close();
      this.live.delete(id);
      unloaded.push(id);
    }
    return unloaded;
  }

  /**
   * Copy a conversation into a new session: all of it (a duplicate), or up to a message (a branch, which
   * keeps that message's exchange). Both share the project folder; the copy records where it came from.
   */
  forkSession(id: string, o: { messageId?: string; title?: string } = {}): Session {
    const source = this.getSession(id);
    if (source.isRunning) throw new Error("Stop the session before duplicating or branching it");
    const events = source.events;
    const uptoSeq = o.messageId ? branchCut(events, o.messageId) : events[events.length - 1]?.seq;
    if (uptoSeq === undefined) throw new Error("The conversation is empty");
    const base = source.info().title ?? "Conversation";
    const newId = makeSessionId();
    this.store.fork(id, newId, uptoSeq);
    const copy = this.getSession(newId);
    copy.emit({
      type: "session.forked",
      fromSessionId: id,
      fromSeq: uptoSeq,
      ...(o.messageId ? { messageId: o.messageId } : {}),
    });
    copy.updateSettings({ title: o.title?.trim() || `${base} (${o.messageId ? "branch" : "copy"})` });
    // A branch cut mid-run must not look like it is still running.
    const status = [...copy.events].reverse().find((e) => e.type === "status");
    if (status?.type === "status" && (status.status === "running" || status.status === "waiting"))
      copy.emit({ type: "status", status: "idle" });
    return copy;
  }

  /** Merge a branch back into the conversation it came from; returns that conversation. */
  mergeBranch(branchId: string): { target: Session; messages: number } {
    const branch = this.getSession(branchId);
    const forked = [...branch.events].reverse().find((e) => e.type === "session.forked");
    if (forked?.type !== "session.forked") throw new Error("This conversation is not a branch");
    if (!this.store.exists(forked.fromSessionId))
      throw new Error("The conversation this branch came from was deleted");
    const target = this.getSession(forked.fromSessionId);
    return { target, ...target.mergeBranch(branch) };
  }

  listSessions(filter: { parent?: string; goalId?: string } = {}): SessionInfo[] {
    const stored = this.store
      .list()
      .filter(
        (s) =>
          (filter.parent === undefined || s.parentSessionId === filter.parent) &&
          (filter.goalId === undefined || s.goalId === filter.goalId),
      );
    return stored.map((s) => {
      const live = this.live.get(s.id);
      if (live) {
        live.syncFromStore();
        return live.info();
      }
      return existsSync(s.projectPath) ? s : { ...s, projectMissing: true };
    });
  }

  /** A session and its subagents, recursively. */
  sessionTree(id: string): SessionTreeNode {
    const all = this.listSessions();
    const byParent = new Map<string, SessionInfo[]>();
    for (const s of all)
      if (s.parentSessionId) byParent.set(s.parentSessionId, [...(byParent.get(s.parentSessionId) ?? []), s]);
    const root = all.find((s) => s.id === id) ?? this.getSession(id).info();
    const seen = new Set<string>();
    const build = (info: SessionInfo): SessionTreeNode => {
      seen.add(info.id);
      return {
        session: info,
        children: (byParent.get(info.id) ?? [])
          .filter((c) => !seen.has(c.id))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map(build),
      };
    };
    return build(root);
  }

  liveSessions(): Session[] {
    return [...this.live.values()];
  }

  /**
   * Why a new session with these options could not reach its model (e.g. missing API key), or undefined.
   * Sandboxes are checked against the global config, before any sandbox folder is created.
   */
  modelProblem(
    o: { projectPath?: string; models?: Partial<Record<ModelRole, string>> } = {},
  ): string | undefined {
    const config = this.config(
      o.projectPath ?? (existsSync(harnessHome()) ? harnessHome() : homedir()),
      o.models ? { models: o.models } : undefined,
    );
    return modelConnectionProblem(
      config,
      new ProviderRegistry(config, this.opts.providers),
      config.models.executor,
    );
  }

  providerRegistry(projectPath: string): { registry: ProviderRegistry; config: HarnessConfig } {
    const config = this.config(projectPath);
    return { registry: new ProviderRegistry(config, this.opts.providers), config };
  }

  closeAll(): void {
    for (const s of this.live.values()) {
      s.cancel();
      s.close();
    }
  }
}

function mergeOverrides(
  a?: Partial<HarnessConfig>,
  b?: Partial<HarnessConfig>,
): Partial<HarnessConfig> | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    ...a,
    ...b,
    models: { ...(a.models ?? {}), ...(b.models ?? {}) },
    permissions: { ...(a.permissions ?? {}), ...(b.permissions ?? {}) },
  };
}

function validateReasoningEffort(value: unknown): void {
  if (!["auto", "none", "low", "medium", "high", "max"].includes(value as string))
    throw new Error("Invalid thinking effort");
}

function validateModelEffort(
  effort: ReasoningEffort | undefined,
  ref: string | undefined,
  registry: ProviderRegistry,
): void {
  if (!effort || effort === "auto") return;
  validateReasoningEffort(effort);
  if (!ref) throw new Error("Choose a model before setting thinking effort");
  const { provider, model } = registry.resolve(ref);
  if (!provider.capabilities(model).reasoningEfforts?.includes(effort))
    throw new Error(
      `Thinking effort "${effort}" is not supported by ${ref}. Choose Default or a supported level.`,
    );
}

/** The canonical path when it exists, else the resolved one. */
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
