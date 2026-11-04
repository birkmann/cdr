import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
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
  SessionStatus,
  SessionTreeNode,
  TodoItem,
} from "@harness/protocol";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { harnessHome, loadConfig, loadDotEnv, parseModelRef, resolveModelRef } from "./config.js";
import { processAttachments } from "./attachments.js";
import { SANDBOX_PROMPT, bwrapAvailable, createSandboxDir, isWorkspaceContainer } from "./sandbox.js";
import { ProviderRegistry, type Provider } from "./providers/index.js";
import { SessionStore, rebuildMessages, summarize } from "./session-store.js";
import { Budget, runAgent, type AgentHooks, type AgentHost, type AgentResult } from "./loop.js";
import { PermissionPolicy } from "./permissions.js";
import { VerifyRunner } from "./verify.js";
import { buildSystemPrompt } from "./context.js";
import { bashTool, builtinTools } from "./tools/builtin.js";
import type { Tool } from "./tools/types.js";
import { resolveInProject } from "./tools/paths.js";
import { UNSPLASH_SECRET_ENV } from "./tools/unsplash.js";
import { configHooks } from "./hooks.js";
import { connectMcpServers, type McpClient } from "./mcp.js";
import { acquireProjectLock, sessionHasProjectLock } from "./lock.js";
import { runWorkflow, type RunOptions, type RunResult } from "./workflow.js";
import { AgentManager, maxAgentDepth, type SessionFactory } from "./agents.js";
import { spawnAgentTool, waitAgentsTool } from "./tools/agents.js";
import { abortError, newId, redactValue, registerSecret, sessionId as makeSessionId } from "./util.js";

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

export class Session {
  readonly id: string;
  readonly projectRoot: string;
  readonly config: HarnessConfig;
  workflow: string;
  readonly events: HarnessEvent[];
  readonly todos: TodoItem[] = [];
  readonly policy: PermissionPolicy;
  readonly snapshots = new Map<string, string>();
  autoApprove: AutoApprove;
  status: SessionStatus = "idle";
  readonly isSandbox: boolean;
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
    const s = summarize(this.id, this.events);
    return {
      ...s,
      status: this.status,
      model: this.config.models.executor,
      reasoningEffort: this.config.reasoningEffort ?? "auto",
      permissionMode: this.policy.mode,
      externalRun: this.isExternalRun,
    };
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

  // ------------------------------------------------------------------ running

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.syncFromStore();
    if (this.isRunning) throw new Error("Session is already running");
    this.running = true;
    this.abort = new AbortController();
    this.budget = new Budget(this.config.limits);
    let release: (() => void) | undefined;
    try {
      // Read-only subagents share their parent's checkout and must not take its lock.
      if (!this.readOnly) release = acquireProjectLock(this.projectRoot, this.id);
      this.setStatus("running");
      await this.ensureMcp();
      return await fn();
    } finally {
      // Children never outlive their parent's run.
      await this.agentManager?.shutdown().catch(() => undefined);
      release?.();
      this.running = false;
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

  private host(): AgentHost {
    return {
      projectRoot: this.projectRoot,
      config: this.config,
      signal: this.signal,
      emit: (e) => this.emit(e),
      requestPermission: (t, a, r, reason) => this.requestPermission(t, a, r, reason),
      ask: (q, o) => this.ask(q, o),
      todos: this.todos,
      secretEnv: this.secretEnv,
      budget: this.budget,
      agents: this.agents,
    };
  }

  allTools(): Tool[] {
    return [
      ...builtinTools(),
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
    const userMsg: ChatMessage = o.images?.length
      ? { role: "user", content: o.user, images: o.images }
      : { role: "user", content: o.user };
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
                [o.extraSystem, this.isSandbox ? SANDBOX_PROMPT : ""].filter(Boolean).join("\n\n") ||
                undefined,
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
    let summarizer: { provider: Provider; model: string } | undefined;
    try {
      const s = this.model("summarizer");
      summarizer = { provider: s.provider, model: s.model };
    } catch {
      summarizer = undefined;
    }
    return runAgent({
      host: this.host(),
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

  private emitUserMessage(text: string, attachments?: AttachmentInfo[]) {
    const id = newId("msg_");
    this.emit({ type: "message.start", id, role: "user" });
    this.emit({ type: "message.end", id, text, ...(attachments?.length ? { attachments } : {}) });
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

  /** Interactive chat turn with the executor, continuing the session's conversation. */
  async chat(text: string, attachments?: Attachment[]): Promise<ChatResult> {
    return this.exclusive(async () => {
      const history = rebuildMessages(this.events, "chat");
      const att = processAttachments(this.projectRoot, this.id, attachments);
      this.emitUserMessage(text, att.infos);
      const r = await this.runPhaseAgent({
        agent: "chat",
        phase: "chat",
        role: "executor",
        user: text + att.text,
        images: att.images,
        continueFrom: history.length ? history : undefined,
      });
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
      this.emitUserMessage(task);
      let r: AgentResult;
      try {
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
    if (this.status !== "failed" && this.status !== "cancelled")
      throw new Error("There is no failed or stopped job to continue");
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

  async run(task: string, opts: RunOptions & { attachments?: Attachment[] } = {}): Promise<RunResult> {
    return this.exclusive(async () => {
      const att = processAttachments(this.projectRoot, this.id, opts.attachments);
      this.emitUserMessage(task, att.infos);
      let result: RunResult;
      try {
        result = await runWorkflow(this, task + att.text, { ...opts, images: att.images });
      } catch (e) {
        if (this.signal.aborted) result = { status: "cancelled", summary: "Cancelled.", edited: [] };
        else {
          this.emit({ type: "error", message: (e as Error).message, recoverable: false });
          result = { status: "failed", summary: `Failed: ${(e as Error).message}`, edited: [] };
        }
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
      spawnSession: this.factory,
      depth: this.depthOf(info),
      parentSessionId: info.parentSessionId,
      goalId: info.goalId,
    });
    this.live.set(id, session);
    session.syncFromStore();
    return session;
  }

  /** Delete a session's log (refuses while it is running). */
  deleteSession(id: string): void {
    const live = this.live.get(id);
    if (live?.isRunning) throw new Error("Session is running; cancel it first");
    live?.close();
    this.live.delete(id);
    this.store.delete(id);
  }

  forkSession(id: string): Session {
    const newId = makeSessionId();
    this.store.fork(id, newId);
    return this.getSession(newId);
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
