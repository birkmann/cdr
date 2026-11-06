import type {
  AttachmentInfo,
  ReasoningEffort,
  BrowseResponse,
  CreateGoalRequest,
  CriterionResult,
  GoalInfo,
  Phase,
  RunStatus,
  SessionSettingsRequest,
  SessionStatus,
  SessionTreeNode,
  UpdateGoalRequest,
  CreateSessionRequest,
  HarnessEvent,
  AvailableModels,
  ModelListEntry,
  PermissionDecision,
  PlanDecision,
  SendMessageRequest,
  SkillInfo,
  SessionInfo,
  TodoItem,
  CheckpointChange,
  SessionLogResponse,
  StorageInfo,
} from "@harness/protocol";

export type * from "@harness/protocol";

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface SessionDetails extends SessionInfo {
  /** Path prefix for the live preview of project files (append the file path). */
  previewBase: string;
  pending: HarnessEvent[];
  todos: TodoItem[];
  events?: HarnessEvent[];
}

export interface EventsOptions {
  /** Resume after this seq (0 = from the beginning). */
  after?: number;
  signal?: AbortSignal;
  /** Stop iterating after the first `done` event. */
  untilDone?: boolean;
  /** Reconnect automatically (default true). */
  reconnect?: boolean;
  /** Include internal context.* events. */
  internal?: boolean;
}

export class HarnessApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Parsed JSON error body (e.g. `conflicts` for a failed goal merge). */
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HarnessApiError";
  }
}

export interface HarnessClient {
  health(): Promise<{ ok: boolean; version: string }>;
  models(
    projectPath?: string,
    model?: string,
  ): Promise<{
    reasoningEfforts: Exclude<ReasoningEffort, "auto">[];
    models: ModelListEntry[];
    providers: { id: string; configured: boolean }[];
    workflows: string[];
  }>;
  createSession(req: CreateSessionRequest): Promise<SessionInfo>;
  /** All sessions, or only the direct subagents of `parent`. */
  listSessions(opts?: { parent?: string }): Promise<SessionInfo[]>;
  /** A session and its subagent sessions, recursively. */
  sessionTree(id: string): Promise<SessionTreeNode>;
  listGoals(opts?: { repo?: string }): Promise<GoalInfo[]>;
  createGoal(req: CreateGoalRequest): Promise<GoalInfo>;
  getGoal(id: string): Promise<GoalInfo>;
  updateGoal(id: string, req: UpdateGoalRequest): Promise<GoalInfo>;
  /** Starts the goal in the background; the returned goal has `sessionId` to subscribe to. */
  runGoal(id: string): Promise<GoalInfo>;
  pauseGoal(id: string): Promise<{ wasRunning: boolean }>;
  discardGoal(id: string): Promise<GoalInfo>;
  /** Merge into baseBranch. On conflict throws HarnessApiError 409 with `body.conflicts: string[]`. */
  mergeGoal(id: string): Promise<GoalInfo>;
  requestGoalChanges(id: string, feedback: string): Promise<GoalInfo>;
  deleteGoal(id: string): Promise<void>;
  /** Generate a commit message for the repository's staged changes (or all changes when none are staged). */
  commitMessage(
    projectPath: string,
    model?: string,
  ): Promise<{ message: string; scope: "staged" | "all"; model: string }>;
  /** AI-generated title and short summary of what a project folder is about. */
  projectSummary(
    projectPath: string,
    model?: string,
  ): Promise<{ title: string; summary: string; model: string }>;
  getSession(
    id: string,
    opts?: { events?: boolean; after?: number; internal?: boolean; signal?: AbortSignal },
  ): Promise<SessionDetails>;
  send(id: string, text: string, opts?: Omit<SendMessageRequest, "text">): Promise<void>;
  events(id: string, opts?: EventsOptions): AsyncIterable<HarnessEvent>;
  answerPermission(id: string, requestId: string, decision: PermissionDecision): Promise<void>;
  answerQuestion(id: string, questionId: string, answer: string): Promise<void>;
  decidePlan(
    id: string,
    planId: string,
    decision: PlanDecision,
    opts?: { markdown?: string; feedback?: string },
  ): Promise<void>;
  cancel(id: string): Promise<void>;
  continueJob(id: string): Promise<void>;
  /** Files restoring a checkpoint would change (compared with the workspace now). */
  previewCheckpoint(id: string, checkpointId: string): Promise<CheckpointChange[]>;
  /** Reset the workspace files to a checkpoint; the current state is checkpointed first (`backupId`). */
  restoreCheckpoint(id: string, checkpointId: string): Promise<{ backupId: string; changed: number }>;
  files(id: string, path?: string): Promise<{ files?: string[]; path?: string; content?: string }>;
  /** Where the server stores conversation history. */
  storage(): Promise<StorageInfo>;
  /** A conversation's stored event log (its JSONL file) and the project files it referenced. */
  sessionLog(id: string): Promise<SessionLogResponse>;
  diff(id: string): Promise<string>;
  updateSettings(id: string, settings: SessionSettingsRequest): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;
  browse(path?: string, opts?: { hidden?: boolean }): Promise<BrowseResponse>;
  availableModels(projectPath?: string): Promise<Record<string, AvailableModels>>;
  /** Skills that can be selected for a message in this project (built-in and user skills without one). */
  skills(projectPath?: string): Promise<SkillInfo[]>;
  /** URL for raw file bytes in the session's project (usable as <img src>). */
  rawUrl(id: string, path: string): string;
  /** Absolute URL of the live preview for a project file (needs `previewBase` from getSession). */
  previewUrl(previewBase: string, path: string): string;
}

export function createClient(opts: ClientOptions): HarnessClient {
  const base = opts.baseUrl.replace(/\/$/, "");
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const headers = (json = false): Record<string, string> => ({
    authorization: `Bearer ${opts.token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  });
  const call = async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const res = await f(`${base}${path}`, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (!res.ok) throw new HarnessApiError(res.status, data.error ?? `HTTP ${res.status}`, data);
    return data as T;
  };
  const enc = encodeURIComponent;

  return {
    health: () => call("GET", "/health"),
    models: (projectPath, model) => {
      const params = new URLSearchParams();
      if (projectPath) params.set("projectPath", projectPath);
      if (model) params.set("model", model);
      return call("GET", `/models?${params}`);
    },
    createSession: (req) => call("POST", "/sessions", req),
    listSessions: async (o) =>
      (
        await call<{ sessions: SessionInfo[] }>(
          "GET",
          `/sessions${o?.parent ? `?parent=${enc(o.parent)}` : ""}`,
        )
      ).sessions,
    sessionTree: (id) => call("GET", `/sessions/${enc(id)}/tree`),
    listGoals: async (o) =>
      (await call<{ goals: GoalInfo[] }>("GET", `/goals${o?.repo ? `?repo=${enc(o.repo)}` : ""}`)).goals,
    createGoal: (req) => call("POST", "/goals", req),
    getGoal: (id) => call("GET", `/goals/${enc(id)}`),
    updateGoal: (id, req) => call("PUT", `/goals/${enc(id)}`, req),
    runGoal: (id) => call("POST", `/goals/${enc(id)}/run`, {}),
    pauseGoal: async (id) => {
      const r = await call<{ wasRunning: boolean }>("POST", `/goals/${enc(id)}/pause`, {});
      return { wasRunning: r.wasRunning };
    },
    discardGoal: (id) => call("POST", `/goals/${enc(id)}/discard`, {}),
    mergeGoal: (id) => call("POST", `/goals/${enc(id)}/merge`, {}),
    requestGoalChanges: (id, feedback) => call("POST", `/goals/${enc(id)}/changes`, { feedback }),
    commitMessage: (projectPath, model) => call("POST", "/commit-message", { projectPath, model }),
    projectSummary: (projectPath, model) => call("POST", "/project-summary", { projectPath, model }),
    deleteGoal: async (id) => {
      await call("DELETE", `/goals/${enc(id)}`);
    },
    getSession: (id, o) => {
      const params = new URLSearchParams();
      if (o?.events === false) params.set("events", "false");
      if (o?.after !== undefined) params.set("after", String(o.after));
      if (o?.internal === false) params.set("internal", "false");
      return call("GET", `/sessions/${enc(id)}?${params}`, undefined, o?.signal);
    },
    send: async (id, text, o) => {
      await call("POST", `/sessions/${enc(id)}/messages`, { text, ...o });
    },
    answerPermission: async (id, rid, decision) => {
      await call("POST", `/sessions/${enc(id)}/permissions/${enc(rid)}`, { decision });
    },
    answerQuestion: async (id, qid, answer) => {
      await call("POST", `/sessions/${enc(id)}/answers/${enc(qid)}`, { answer });
    },
    decidePlan: async (id, pid, decision, o) => {
      await call("POST", `/sessions/${enc(id)}/plans/${enc(pid)}`, { decision, ...o });
    },
    cancel: async (id) => {
      await call("POST", `/sessions/${enc(id)}/cancel`, {});
    },
    continueJob: async (id) => {
      await call("POST", `/sessions/${enc(id)}/continue`, {});
    },
    previewCheckpoint: async (id, cp) =>
      (await call<{ files: CheckpointChange[] }>("GET", `/sessions/${enc(id)}/checkpoints/${enc(cp)}`)).files,
    restoreCheckpoint: (id, cp) => call("POST", `/sessions/${enc(id)}/checkpoints/${enc(cp)}/restore`, {}),
    files: (id, path) => call("GET", `/sessions/${enc(id)}/files${path ? `?path=${enc(path)}` : ""}`),
    storage: () => call("GET", "/storage"),
    sessionLog: (id) => call("GET", `/sessions/${enc(id)}/log`),
    diff: async (id) => (await call<{ diff: string }>("GET", `/sessions/${enc(id)}/diff`)).diff,
    updateSettings: (id, settings) => call("POST", `/sessions/${enc(id)}/settings`, settings),
    deleteSession: async (id) => {
      await call("DELETE", `/sessions/${enc(id)}`);
    },
    browse: (path, o) =>
      call("GET", `/browse?${path ? `path=${enc(path)}&` : ""}${o?.hidden ? "hidden=true" : ""}`),
    availableModels: async (projectPath) =>
      (
        await call<{ available: Record<string, AvailableModels> }>(
          "GET",
          `/models?remote=true${projectPath ? `&projectPath=${enc(projectPath)}` : ""}`,
        )
      ).available,
    skills: async (projectPath) =>
      (
        await call<{ skills: SkillInfo[] }>(
          "GET",
          `/skills${projectPath ? `?projectPath=${enc(projectPath)}` : ""}`,
        )
      ).skills,
    previewUrl: (previewBase, path) => `${base}${previewBase}${path.split("/").map(enc).join("/")}`,
    rawUrl: (id, path) => `${base}/sessions/${enc(id)}/raw?path=${enc(path)}&token=${enc(opts.token)}`,
    events: (id, o = {}) => streamEvents(f, `${base}/sessions/${enc(id)}/events`, opts.token, o),
  };
}

async function* streamEvents(
  f: typeof fetch,
  url: string,
  token: string,
  o: EventsOptions,
): AsyncIterable<HarnessEvent> {
  let last = o.after ?? 0;
  let attempt = 0;
  while (!o.signal?.aborted) {
    try {
      const res = await f(`${url}?after=${last}${o.internal ? "&internal=true" : ""}`, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        signal: o.signal,
      });
      if (res.status === 401 || res.status === 404)
        throw new HarnessApiError(res.status, `events: HTTP ${res.status}`);
      if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
      attempt = 0;
      for await (const msg of parseSSE(res.body)) {
        if (!msg.data) continue;
        const e = JSON.parse(msg.data) as HarnessEvent;
        if (e.seq <= last) continue;
        last = e.seq;
        yield e;
        if (o.untilDone && e.type === "done") return;
      }
    } catch (e) {
      if (o.signal?.aborted) return;
      if (e instanceof HarnessApiError) throw e;
    }
    if (o.reconnect === false) return;
    await new Promise((r) => setTimeout(r, Math.min(10_000, 250 * 2 ** attempt++)));
  }
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<{ event?: string; data: string; id?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n"), id };
          event = id = undefined;
          data = [];
        } else if (!line.startsWith(":")) {
          const i = line.indexOf(":");
          const field = i < 0 ? line : line.slice(0, i);
          let v = i < 0 ? "" : line.slice(i + 1);
          if (v.startsWith(" ")) v = v.slice(1);
          if (field === "data") data.push(v);
          else if (field === "event") event = v;
          else if (field === "id") id = v;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ------------------------------------------------------------------ headless state reducer

export interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  output?: string;
  diff?: string;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  /** Short decision lines summarising the reasoning so far (reasoning.summary). */
  decisions?: string[];
  agent?: string;
  streaming: boolean;
  attachments?: AttachmentInfo[];
  /** Skills the user selected for this message. */
  skills?: string[];
  /** Workspace checkpoint taken right before this user message's turn (restorable). */
  checkpoint?: string;
}

export type TimelineItem =
  { kind: "message"; id: string } | { kind: "tool"; id: string } | { kind: "event"; event: HarnessEvent };

/** A subagent spawned by this session (from agent.* events). */
export interface AgentView {
  agentId: string;
  /** Child session id (subscribe to it for the full log). */
  sessionId: string;
  parentToolCallId: string;
  task: string;
  role: string;
  isolation: "shared" | "worktree";
  worktree?: string;
  branch?: string;
  /** Latest child status (from agent.status; "done"/"failed"/"cancelled" after agent.finished). */
  status: SessionStatus;
  phase?: Phase;
  usage?: { inputTokens: number; outputTokens: number; cost?: number };
  /** Set by agent.finished. */
  result?: RunStatus;
  summary?: string;
  diffStat?: string;
}

export interface GoalCheckpointView {
  commit: string;
  step: string;
  summary: string;
  criteria: CriterionResult[];
  seq: number;
}

/** Goal progress in a goal's session (from goal.* events). */
export interface GoalView {
  goalId: string;
  title: string;
  worktree: string;
  branch: string;
  round: number;
  status: "running" | "paused" | "finished";
  paused?: { reason: "budget" | "permission" | "user" | "error"; detail?: string };
  /** Set by goal.finished. */
  result?: RunStatus;
  prUrl?: string;
  summary?: string;
  checkpoints: GoalCheckpointView[];
  /** Latest acceptance-criteria evaluation. */
  criteria: CriterionResult[];
}

/** One recreation run as the UIs show it: stages, section rows, numbers, outputs. */
export interface RecreateRunView {
  runId: string;
  url: string;
  dir?: string;
  targets: string[];
  consent?: { by: "user" | "auto"; at: string; mode: string };
  stages: Record<
    string,
    {
      status: "running" | "done" | "failed" | "skipped";
      ms?: number;
      detail?: string;
      skipped?: string[];
      /** when the stage started (the running event's timestamp), for a live elapsed time */
      startedAt?: string;
    }
  >;
  sections: Array<{
    index: number;
    total: number;
    id: string;
    kind: string;
    label: string;
    status: "building" | "checking" | "ok" | "below-threshold" | "repaired";
    pixel?: number;
    /** the band on the live page per captured width (kept from the first event that carried it) */
    bands?: { width: number; y: number; h: number }[];
  }>;
  /** screenshots of the live page taken so far (peeks first, then full-page shots), newest last */
  shots: Array<{ kind: "peek" | "live"; width: number; height: number; path: string; seq: number }>;
  measured: Record<string, Extract<HarnessEvent, { type: "recreate.measured" }>>;
  components?: Extract<HarnessEvent, { type: "recreate.components" }>;
  status: "running" | "success" | "failed" | "cancelled";
  outputs: { target: string; path: string }[];
  comparePath?: string;
  summary?: string;
}

export interface SessionState {
  externalRun?: boolean;
  workflow?: string;
  reasoningEffort?: ReasoningEffort;
  status: SessionInfo["status"];
  lastSeq: number;
  messages: Record<string, MessageView>;
  tools: Record<string, ToolCallView>;
  timeline: TimelineItem[];
  pendingPermissions: Extract<HarnessEvent, { type: "permission.request" }>[];
  pendingQuestions: Extract<HarnessEvent, { type: "question" }>[];
  pendingPlan?: Extract<HarnessEvent, { type: "plan.proposed" }>;
  todos: TodoItem[];
  phase?: string;
  usage: { inputTokens: number; outputTokens: number; cost: number };
  /** Context compactions in this session: how many, and the token sizes around the latest one. */
  compaction?: { count: number; tokensBefore: number; tokensAfter: number };
  done?: Extract<HarnessEvent, { type: "done" }>;
  errors: string[];
  projectPath?: string;
  title?: string;
  models?: Partial<Record<"executor" | "planner" | "reviewer" | "summarizer", string>>;
  permissionMode?: "ask" | "auto" | "yolo";
  sandbox?: boolean;
  /** Latest file the agent asked to preview. */
  preview?: { path: string; title?: string; seq: number };
  /** Subagents by agentId. */
  agents: Record<string, AgentView>;
  /** Present when this session runs a goal. */
  goal?: GoalView;
  parentSessionId?: string;
  goalId?: string;
  /** Wall-clock timing of each turn, keyed by the id of the user message that started it (ISO timestamps). */
  turnTimes: Record<string, { start: string; end?: string }>;
  /** User message id of the latest turn. */
  currentTurn?: string;
  /** 1:1 recreation runs by run id. */
  recreate?: { runs: Record<string, RecreateRunView> };
  /** Turn checkpoint not yet attached to its user message. */
  pendingCheckpoint?: string;
}

export const initialSessionState = (): SessionState => ({
  status: "idle",
  lastSeq: 0,
  messages: {},
  tools: {},
  timeline: [],
  pendingPermissions: [],
  pendingQuestions: [],
  todos: [],
  usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  errors: [],
  agents: {},
  turnTimes: {},
});

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** One-line description of a context compaction, shared by all frontends. */
export function compactionLine(e: Extract<HarnessEvent, { type: "context.compacted" }>): string {
  const what = e.method === "prune" ? "old tool output trimmed" : "earlier work condensed into a brief";
  return `Context compacted (${what}): ~${kTokens(e.tokensBefore)} → ~${kTokens(e.tokensAfter)} tokens${e.count > 1 ? ` · ${e.count}× so far` : ""}`;
}

/** Pure reducer that turns the event stream into UI state. Shared by all frontends. */
export function reduceSession(state: SessionState, e: HarnessEvent): SessionState {
  if (e.seq <= state.lastSeq) return state;
  const s: SessionState = { ...state, lastSeq: e.seq };
  const turn = s.currentTurn ? s.turnTimes?.[s.currentTurn] : undefined;
  if (e.type === "message.start" && e.role === "user") {
    s.currentTurn = e.id;
    s.turnTimes = { ...s.turnTimes, [e.id]: { start: e.ts } };
  } else if (turn && s.currentTurn) {
    if (e.type === "done") s.turnTimes = { ...s.turnTimes, [s.currentTurn]: { ...turn, end: e.ts } };
    // Work resumed in the same turn (e.g. "continue the job"): it is running again.
    else if (e.type === "status" && e.status === "running" && turn.end)
      s.turnTimes = { ...s.turnTimes, [s.currentTurn]: { start: turn.start } };
  }
  switch (e.type) {
    case "session.created":
      s.projectPath = e.projectPath;
      s.workflow = e.workflow;
      s.title = e.title;
      s.models = e.models;
      s.permissionMode = e.permissionMode;
      s.reasoningEffort = e.reasoningEffort;
      s.sandbox = e.sandbox;
      s.parentSessionId = e.parentSessionId;
      s.goalId = e.goalId;
      break;
    case "preview.ready":
      s.preview = { path: e.path, title: e.title, seq: e.seq };
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "session.settings":
      if (e.title) s.title = e.title;
      if (e.models) s.models = { ...(s.models ?? {}), ...e.models };
      if (e.permissionMode) s.permissionMode = e.permissionMode;
      if (e.reasoningEffort !== undefined) s.reasoningEffort = e.reasoningEffort;
      break;
    case "status":
      if (e.status === "running" && !["running", "waiting"].includes(s.status)) {
        s.done = undefined;
        s.workflow = undefined;
        s.errors = [];
        s.phase = undefined;
        s.pendingPermissions = [];
        s.pendingQuestions = [];
        s.pendingPlan = undefined;
        s.messages = Object.fromEntries(
          Object.entries(s.messages).map(([id, m]) => [id, { ...m, streaming: false }]),
        );
      }
      s.status = e.status;
      break;
    case "run.start":
      s.workflow = e.workflow;
      s.done = undefined;
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "message.start":
      s.messages = {
        ...s.messages,
        [e.id]: {
          id: e.id,
          role: e.role,
          text: "",
          agent: e.agent,
          streaming: true,
          ...(e.role === "user" && s.pendingCheckpoint ? { checkpoint: s.pendingCheckpoint } : {}),
        },
      };
      if (e.role === "user") s.pendingCheckpoint = undefined;
      s.timeline = [...s.timeline, { kind: "message", id: e.id }];
      break;
    case "message.delta": {
      const m = s.messages[e.id];
      if (m) s.messages = { ...s.messages, [e.id]: { ...m, text: m.text + e.text } };
      break;
    }
    case "reasoning.delta": {
      const m = s.messages[e.id];
      if (m) s.messages = { ...s.messages, [e.id]: { ...m, reasoning: (m.reasoning ?? "") + e.text } };
      break;
    }
    case "reasoning.summary": {
      const m = s.messages[e.id];
      if (m) s.messages = { ...s.messages, [e.id]: { ...m, decisions: [...(m.decisions ?? []), e.text] } };
      break;
    }
    case "message.end": {
      const m = s.messages[e.id];
      if (m)
        s.messages = {
          ...s.messages,
          [e.id]: {
            ...m,
            text: e.text,
            streaming: false,
            ...(e.attachments ? { attachments: e.attachments } : {}),
            ...(e.skills ? { skills: e.skills } : {}),
          },
        };
      break;
    }
    case "tool.call":
      s.tools = { ...s.tools, [e.id]: { id: e.id, name: e.name, args: e.args, status: "running" } };
      s.timeline = [...s.timeline, { kind: "tool", id: e.id }];
      break;
    case "tool.result": {
      const t = s.tools[e.id] ?? { id: e.id, name: e.name, args: undefined, status: "running" as const };
      s.tools = {
        ...s.tools,
        [e.id]: { ...t, status: e.ok ? "ok" : "error", output: e.output, diff: e.diff },
      };
      break;
    }
    case "permission.request":
      s.pendingPermissions = [...s.pendingPermissions, e];
      break;
    case "permission.resolved":
      s.pendingPermissions = s.pendingPermissions.filter((p) => p.id !== e.id);
      if (s.goal?.paused?.reason === "permission" && !s.pendingPermissions.length)
        s.goal = { ...s.goal, paused: undefined };
      break;
    case "question":
      s.pendingQuestions = [...s.pendingQuestions, e];
      break;
    case "question.answered":
      s.pendingQuestions = s.pendingQuestions.filter((q) => q.id !== e.id);
      break;
    case "plan.proposed":
      s.pendingPlan = e;
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "plan.decision":
      if (s.pendingPlan?.id === e.id) s.pendingPlan = undefined;
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "todo.update":
      s.todos = e.items;
      break;
    case "phase.start":
      s.phase = e.phase;
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "verify.result":
    case "review.findings":
    case "memory.saved":
    case "memory.removed":
    case "skill.activated":
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "context.compacted":
      s.compaction = {
        count: (s.compaction?.count ?? 0) + 1,
        tokensBefore: e.tokensBefore,
        tokensAfter: e.tokensAfter,
      };
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "log":
      if (e.level === "warn") s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "usage":
      s.usage = {
        inputTokens: s.usage.inputTokens + e.inputTokens,
        outputTokens: s.usage.outputTokens + e.outputTokens,
        cost: s.usage.cost + (e.cost ?? 0),
      };
      break;
    case "error":
      s.errors = [...s.errors, e.message];
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "agent.spawned":
      s.agents = {
        ...(s.agents ?? {}),
        [e.agentId]: {
          agentId: e.agentId,
          sessionId: e.sessionId,
          parentToolCallId: e.parentToolCallId,
          task: e.task,
          role: e.role,
          isolation: e.isolation,
          worktree: e.worktree,
          branch: e.branch,
          status: "running",
        },
      };
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "agent.status": {
      const a = s.agents?.[e.agentId];
      if (a)
        s.agents = {
          ...s.agents,
          [e.agentId]: {
            ...a,
            status: a.result ? a.status : e.status,
            phase: e.phase ?? a.phase,
            usage: e.usage ?? a.usage,
          },
        };
      break;
    }
    case "agent.finished": {
      const a = s.agents?.[e.agentId];
      if (a)
        s.agents = {
          ...s.agents,
          [e.agentId]: {
            ...a,
            status: e.status === "success" ? "done" : e.status === "cancelled" ? "cancelled" : "failed",
            result: e.status,
            summary: e.summary,
            diffStat: e.diffStat,
          },
        };
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    }
    case "goal.started":
      s.goal = {
        checkpoints: [],
        criteria: [],
        ...(s.goal?.goalId === e.goalId ? s.goal : {}),
        goalId: e.goalId,
        title: e.title,
        worktree: e.worktree,
        branch: e.branch,
        round: e.round,
        status: "running",
        paused: undefined,
        result: undefined,
      };
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "goal.checkpoint":
      if (s.goal)
        s.goal = {
          ...s.goal,
          checkpoints: [
            ...s.goal.checkpoints,
            { commit: e.commit, step: e.step, summary: e.summary, criteria: e.criteria, seq: e.seq },
          ],
          criteria: e.criteria,
        };
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "goal.paused":
      if (s.goal)
        s.goal = {
          ...s.goal,
          // A permission wait is not a stop: the run continues once answered.
          status: e.reason === "permission" ? s.goal.status : "paused",
          paused: { reason: e.reason, detail: e.detail },
        };
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "goal.finished":
      if (s.goal)
        s.goal = {
          ...s.goal,
          status: "finished",
          result: e.status,
          prUrl: e.prUrl,
          summary: e.summary,
          branch: e.branch,
        };
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "recreate.started":
    case "recreate.stage":
    case "recreate.section":
    case "recreate.shot":
    case "recreate.measured":
    case "recreate.components":
    case "recreate.consent":
    case "recreate.finished":
      s.recreate = reduceRecreate(s.recreate, e);
      if (e.type === "recreate.started" || e.type === "recreate.finished")
        s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "checkpoint.created":
      if (e.reason !== "turn") break;
      if (e.messageId) {
        // Taken right after its user message (current logs).
        const m = s.messages[e.messageId];
        if (m) s.messages = { ...s.messages, [e.messageId]: { ...m, checkpoint: e.id } };
      } else s.pendingCheckpoint = e.id; // older logs: emitted just before the user message
      break;
    case "checkpoint.restored":
    case "checkpoint.failed":
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
    case "done":
      s.pendingCheckpoint = undefined;
      s.done = e;
      s.pendingPermissions = [];
      s.pendingQuestions = [];
      s.pendingPlan = undefined;
      s.timeline = [...s.timeline, { kind: "event", event: e }];
      break;
  }
  return s;
}

type RecreateEvent = Extract<HarnessEvent, { type: `recreate.${string}` }>;

/** Recreate events → run views. A run spans several tool calls (each emits started / finished), merged by run id. */
export function reduceRecreate(
  state: SessionState["recreate"],
  e: RecreateEvent,
): NonNullable<SessionState["recreate"]> {
  const runs = { ...(state?.runs ?? {}) };
  const prev: RecreateRunView = runs[e.runId] ?? {
    runId: e.runId,
    url: "",
    targets: [],
    stages: {},
    sections: [],
    shots: [],
    measured: {},
    status: "running",
    outputs: [],
  };
  const r: RecreateRunView = { ...prev };
  switch (e.type) {
    case "recreate.started":
      r.url = e.url;
      r.dir = e.dir;
      r.targets = e.targets;
      r.status = "running";
      break;
    case "recreate.consent":
      r.consent = e.consent;
      break;
    case "recreate.stage":
      r.stages = {
        ...r.stages,
        [e.stage]: {
          status: e.status,
          ms: e.ms,
          detail: e.detail,
          skipped: e.skipped,
          startedAt: e.status === "running" ? e.ts : r.stages[e.stage]?.startedAt,
        },
      };
      // a re-built page starts its section rows over
      if (e.stage === "build" && e.status === "running") r.sections = [];
      break;
    case "recreate.section": {
      const row = {
        index: e.index,
        total: e.total,
        id: e.id,
        kind: e.kind,
        label: e.label,
        status: e.status,
        pixel: e.pixel,
        bands: e.bands ?? r.sections.find((x) => x.id === e.id)?.bands,
      };
      r.sections = [...r.sections.filter((x) => x.id !== e.id), row].sort((a, b) => a.index - b.index);
      break;
    }
    case "recreate.shot":
      // the same file again (a re-capture) replaces its entry; seq busts the browser cache
      r.shots = [
        ...(r.shots ?? []).filter((x) => x.path !== e.path),
        { kind: e.kind, width: e.width, height: e.height, path: e.path, seq: e.seq },
      ];
      break;
    case "recreate.measured":
      r.measured = { ...r.measured, [e.target]: e };
      if (e.comparePath) r.comparePath = e.comparePath;
      break;
    case "recreate.components":
      r.components = e;
      break;
    case "recreate.finished":
      r.status = e.status;
      r.outputs = e.outputs;
      if (e.comparePath) r.comparePath = e.comparePath;
      r.summary = e.summary;
      break;
  }
  runs[e.runId] = r;
  return { runs };
}
