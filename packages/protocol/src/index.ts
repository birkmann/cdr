/**
 * @harness/protocol – shared types between core, server, client and frontends.
 * No runtime dependencies. Event schema version: 1.
 */

export const PROTOCOL_VERSION = 1 as const;

/** CDR release version (kept in sync by `pnpm release:version`). */
export const HARNESS_VERSION = "0.1.0";

export type Phase = "plan" | "execute" | "verify" | "review" | "finish";
export type Risk = "low" | "medium" | "high";
export type PermissionDecision = "allow" | "deny" | "always";
export type PlanDecision = "approve" | "reject" | "edit";
export type RunStatus = "success" | "failed" | "cancelled";
export type SessionStatus = "idle" | "running" | "waiting" | "done" | "failed" | "cancelled";

export interface Finding {
  severity: "blocking" | "major" | "minor" | "nit";
  file?: string;
  line?: number;
  issue: string;
  suggestion?: string;
}

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "done";
}

/** Message format used internally (OpenAI chat-completions shaped). */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as produced by the model. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: ImagePart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; reasoning?: string }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** An image sent to the model (base64, no data: prefix). */
export interface ImagePart {
  mimeType: string;
  data: string;
  name?: string;
}

/** A file attached to a user message (base64 content). */
export interface Attachment {
  name: string;
  mimeType: string;
  data: string;
}

/** Metadata of a stored attachment (saved under <project>/.harness/attachments/). */
export interface AttachmentInfo {
  name: string;
  mimeType: string;
  size: number;
  /** Path relative to the project root. */
  path: string;
  kind: "image" | "text" | "binary";
}

/** Event bodies (without envelope). */
export type EventBody =
  | {
      type: "session.created";
      projectPath: string;
      workflow: string;
      title?: string;
      models?: Partial<Record<ModelRole, string>>;
      reasoningEffort?: ReasoningEffort;
      permissionMode?: "ask" | "auto" | "yolo";
      /** The project is a harness-managed sandbox workspace. */
      sandbox?: boolean;
      /** Set when this session is a subagent spawned by another session. */
      parentSessionId?: string;
      /** Set when this session runs an autonomous goal. */
      goalId?: string;
    }
  | {
      type: "session.settings";
      models?: Partial<Record<ModelRole, string>>;
      reasoningEffort?: ReasoningEffort;
      permissionMode?: "ask" | "auto" | "yolo";
      title?: string;
    }
  | {
      type: "run.start";
      runId: string;
      task: string;
      workflow: string;
      continuedFrom?: number;
      noPlan?: boolean;
      commit?: boolean;
    }
  | { type: "phase.start"; phase: Phase; round?: number; agent?: string }
  | { type: "phase.end"; phase: Phase; round?: number; ok?: boolean }
  | { type: "message.start"; id: string; role: "assistant" | "user"; agent?: string }
  | { type: "message.delta"; id: string; text: string }
  | { type: "reasoning.delta"; id: string; text: string }
  | { type: "message.end"; id: string; text: string; attachments?: AttachmentInfo[] }
  | { type: "tool.call"; id: string; name: string; args: unknown }
  | {
      type: "tool.result";
      id: string;
      name: string;
      ok: boolean;
      output: string;
      truncated?: boolean;
      diff?: string;
    }
  | { type: "permission.request"; id: string; tool: string; args: unknown; risk: Risk; reason?: string }
  | { type: "permission.resolved"; id: string; decision: PermissionDecision; auto?: boolean }
  | { type: "question"; id: string; text: string; options?: string[] }
  | { type: "question.answered"; id: string; answer: string }
  | { type: "plan.proposed"; id: string; markdown: string; path: string }
  | { type: "plan.decision"; id: string; decision: PlanDecision; markdown?: string; feedback?: string }
  | { type: "todo.update"; items: TodoItem[] }
  | {
      type: "verify.result";
      command: string;
      kind: string;
      exitCode: number;
      output: string;
      attempt: number;
    }
  | { type: "review.findings"; findings: Finding[]; summary?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cost?: number; model?: string }
  | { type: "context.append"; agent: string; message: ChatMessage }
  | { type: "context.replace"; agent: string; messages: ChatMessage[]; reason: string }
  | { type: "memory.saved"; scope: "project" | "user"; path: string; fact: string }
  /** The agent declared a file to preview (an HTML entry point), relative to the project root. */
  | { type: "preview.ready"; path: string; title?: string }
  | { type: "status"; status: SessionStatus }
  | { type: "log"; level: "debug" | "info" | "warn"; message: string }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "done"; status: RunStatus; summary?: string; reportPath?: string }
  // ---------------------------------------------------------------- subagents (in the parent's log)
  | {
      type: "agent.spawned";
      agentId: string;
      /** The child session (own event log). */
      sessionId: string;
      /** The parent's spawn_agent tool call. */
      parentToolCallId: string;
      task: string;
      role: string;
      isolation: "shared" | "worktree";
      worktree?: string;
      branch?: string;
    }
  | {
      type: "agent.status";
      agentId: string;
      status: SessionStatus;
      phase?: Phase;
      usage?: { inputTokens: number; outputTokens: number; cost?: number };
    }
  | { type: "agent.finished"; agentId: string; status: RunStatus; summary: string; diffStat?: string }
  // ---------------------------------------------------------------- goals (in the goal's session log)
  | { type: "goal.started"; goalId: string; title: string; worktree: string; branch: string; round: number }
  | {
      type: "goal.checkpoint";
      goalId: string;
      commit: string;
      step: string;
      summary: string;
      criteria: CriterionResult[];
    }
  | {
      type: "goal.paused";
      goalId: string;
      reason: "budget" | "permission" | "user" | "error";
      detail?: string;
    }
  | {
      type: "goal.finished";
      goalId: string;
      status: RunStatus;
      prUrl?: string;
      branch: string;
      summary: string;
    };

/** Result of checking one acceptance criterion (autonomous workflow review). */
export interface CriterionResult {
  criterion: string;
  met: boolean;
  evidence?: string;
}

export type EventType = EventBody["type"];

/** Envelope added by the session to every event. */
export interface EventEnvelope {
  v: typeof PROTOCOL_VERSION;
  /** Monotonic per session, starting at 1. Used as SSE id. */
  seq: number;
  ts: string;
  sessionId: string;
}

export type HarnessEvent = EventEnvelope & EventBody;
export type EventOf<T extends EventType> = EventEnvelope & Extract<EventBody, { type: T }>;

/** Events the UI never needs to render (internal bookkeeping for resume). */
export const INTERNAL_EVENT_TYPES: readonly EventType[] = ["context.append", "context.replace"];

// ---------------------------------------------------------------- config

export interface ProviderConfig {
  type: "openai-compatible" | "anthropic" | "mock";
  baseURL?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Per-model overrides (context window, tool support, pricing per 1M tokens). */
  models?: Record<string, ModelInfo>;
}

/** auto leaves provider defaults unchanged; none disables thinking where supported. */
export type ReasoningEffort = "auto" | "none" | "low" | "medium" | "high" | "max";

export interface ModelInfo {
  /** Supported reasoning_effort values for an OpenAI-compatible model. */
  reasoningEfforts?: Exclude<ReasoningEffort, "auto">[];
  contextWindow?: number;
  tools?: boolean;
  reasoning?: boolean;
  inputPrice?: number;
  outputPrice?: number;
  maxTokens?: number;
}

export type ModelRole = "executor" | "planner" | "reviewer" | "summarizer";

export interface VerifyConfig {
  build?: string;
  test?: string;
  lint?: string;
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface PermissionsConfig {
  mode?: "ask" | "auto" | "yolo";
  bash?: { allow?: string[]; deny?: string[] };
  tools?: Record<string, "allow" | "ask" | "deny">;
}

export interface HooksConfig {
  /** Shell command run after a successful write/patch; output is appended to the tool result. */
  afterEdit?: string;
  /** Shell command run when an agent run finishes. */
  onStop?: string;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface PhaseDef {
  phase: Phase;
  model?: ModelRole | string;
  tools?: string[];
  gate?: boolean;
  prompt?: string;
}

export interface WorkflowDef {
  name: string;
  description?: string;
  phases: PhaseDef[];
  /** Run each plan step in a fresh execute context. */
  freshContextPerStep?: boolean;
  commit?: boolean;
}

export interface HarnessConfig {
  reasoningEffort?: ReasoningEffort;
  providers: Record<string, ProviderConfig>;
  models: Partial<Record<ModelRole, string>>;
  verify?: VerifyConfig;
  permissions?: PermissionsConfig;
  hooks?: HooksConfig;
  workflow?: string;
  workflows?: Record<string, WorkflowDef>;
  limits?: {
    maxTurns?: number;
    /** Optional local per-run total of input + output tokens across all calls. Omitted or 0 disables it; not a provider balance or context-window limit. */
    maxTokens?: number;
    /** Optional local per-run cost estimate using configured model prices. Omitted or 0 disables it; not the provider account balance. */
    maxCost?: number;
    /** Active run time in milliseconds; excludes time waiting for human input. */
    timeoutMs?: number;
  };
  context?: { compactAt?: number; keepRecent?: number; maxToolOutput?: number; repoMapDepth?: number };
  sandbox?: "none" | "bwrap";
  /** Allow network access inside the bwrap sandbox (package installs). */
  sandboxNetwork?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  temperature?: number;
  /** Subagent limits (spawn_agent). */
  agents?: {
    /** Concurrently running subagents per parent session (default 3). */
    maxConcurrent?: number;
    /** Maximum nesting depth; a session at this depth cannot spawn (default 2). */
    maxDepth?: number;
  };
}

// ---------------------------------------------------------------- HTTP API

export interface CreateSessionRequest {
  reasoningEffort?: ReasoningEffort;
  /** Existing project folder. Omit (or set `sandbox`) to create a fresh sandbox workspace. */
  projectPath?: string;
  /** Create a new sandbox workspace under ~/.harness/sandboxes (name is a hint for the folder). */
  sandbox?: boolean | { name?: string };
  workflow?: string;
  models?: Partial<Record<ModelRole, string>>;
  permissionMode?: "ask" | "auto" | "yolo";
  title?: string;
}

export interface SessionInfo {
  /** A different process currently owns the running session. */
  externalRun?: boolean;
  reasoningEffort?: ReasoningEffort;
  id: string;
  projectPath: string;
  workflow: string;
  status: SessionStatus;
  createdAt: string;
  title?: string;
  lastSeq: number;
  updatedAt?: string;
  /** Executor model ref, if known. */
  model?: string;
  permissionMode?: "ask" | "auto" | "yolo";
  sandbox?: boolean;
  /** The project folder no longer exists (session can only be deleted). */
  projectMissing?: boolean;
  /** Parent session when this session is a subagent. */
  parentSessionId?: string;
  /** Goal this session runs. */
  goalId?: string;
}

/** GET /sessions/:id/tree */
export interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

// ---------------------------------------------------------------- goals

export interface GoalBudget {
  maxCost?: number;
  maxTokens?: number;
  /** Total active run time across rounds. */
  timeoutMs?: number;
  /** Rounds per run (default 4). */
  maxRounds?: number;
}

export interface GoalPolicy {
  /** Default "auto"; "yolo" is refused for scheduled goals. */
  permissionMode?: "ask" | "auto" | "yolo";
  bash?: { allow?: string[]; deny?: string[] };
}

export type GoalSchedule = null | { at: string } | { cron: string };

export interface GoalDef {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  /** Absolute path of the repository (main checkout). */
  repo: string;
  baseBranch: string;
  budget: GoalBudget;
  policy: GoalPolicy;
  models?: Partial<Record<ModelRole, string>>;
  deliverable: "pull-request" | "branch" | "patch";
  schedule?: GoalSchedule;
}

export type GoalStatus =
  "draft" | "scheduled" | "running" | "needs-attention" | "review" | "done" | "failed" | "discarded";

export interface GoalInfo extends GoalDef {
  status: GoalStatus;
  sessionId?: string;
  branch?: string;
  worktree?: string;
  /** Number of checkpoint commits made so far. */
  checkpoints: number;
  /** Rounds run so far (across runs). */
  round?: number;
  lastSummary?: string;
  /** Latest acceptance-criteria evaluation. */
  criteria?: CriterionResult[];
  createdAt: string;
  updatedAt: string;
  usage: { inputTokens: number; outputTokens: number; cost: number; elapsedMs?: number };
}

/** POST /goals – a GoalDef without id; only title and repo are required. */
export type CreateGoalRequest = Pick<GoalDef, "title" | "repo"> &
  Partial<Omit<GoalDef, "id" | "title" | "repo">>;

/** PUT /goals/:id – fields to change (repo and id are fixed). */
export type UpdateGoalRequest = Partial<Omit<GoalDef, "id" | "repo">>;

export interface SendMessageRequest {
  text: string;
  /** "chat" continues the conversation with the executor; "task" runs the full workflow. */
  mode?: "chat" | "task";
  workflow?: string;
  attachments?: Attachment[];
}

export interface SessionSettingsRequest {
  reasoningEffort?: ReasoningEffort;
  models?: Partial<Record<ModelRole, string>>;
  permissionMode?: "ask" | "auto" | "yolo";
  title?: string;
}

export interface BrowseResponse {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string; isGit: boolean }[];
}

export interface PermissionAnswer {
  decision: PermissionDecision;
}
export interface QuestionAnswer {
  answer: string;
}
export interface PlanAnswer {
  decision: PlanDecision;
  markdown?: string;
  feedback?: string;
}

export interface ModelListEntry {
  role?: ModelRole;
  id: string;
  provider: string;
  configured: boolean;
}

export function isInternalEvent(e: { type: string }): boolean {
  return (INTERNAL_EVENT_TYPES as readonly string[]).includes(e.type);
}
