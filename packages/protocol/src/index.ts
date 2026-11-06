/**
 * @harness/protocol – shared types between core, server, client and frontends.
 * No runtime dependencies. Event schema version: 1.
 */

export * from "./scene.js";
export * from "./brand.js";

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
  /** A short line naming a decision the model made while thinking (written by the summarizer model). */
  | { type: "reasoning.summary"; id: string; text: string }
  | {
      type: "message.end";
      id: string;
      text: string;
      attachments?: AttachmentInfo[];
      /** Skills the user selected for this message (user messages only). */
      skills?: string[];
    }
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
  /** An agent's working context was shrunk (old tool output trimmed, or history condensed into a brief). */
  | {
      type: "context.compacted";
      agent: string;
      /** "prune": old tool output/images trimmed only; "brief": older history replaced by an execution brief. */
      method: "prune" | "brief";
      /** Estimated context tokens before and after. */
      tokensBefore: number;
      tokensAfter: number;
      /** How many times this agent's context has been compacted so far in this run. */
      count: number;
      /** Project-relative file holding the raw history that was removed (searchable by the agent). */
      historyPath?: string;
    }
  /** A fact was added to memory; `replaced` is the fact it superseded, if any. */
  | { type: "memory.saved"; scope: "project" | "user"; path: string; fact: string; replaced?: string }
  /** A fact was removed from memory (the `forget` tool). */
  | { type: "memory.removed"; scope: "project" | "user"; path: string; fact: string }
  /** A skill was injected into the prompt: its triggers matched the task, or the user selected it. */
  | {
      type: "skill.activated";
      name: string;
      description: string;
      source: "project" | "config" | "user" | "builtin";
      /** Why it was injected (default "matched"). */
      reason?: "matched" | "selected";
      /** The skill's Markdown instructions as the model received them. */
      content: string;
      /** Reference files inside the skill folder, readable with load_skill. */
      files?: string[];
    }
  /** The agent declared a file to preview (an HTML entry point), relative to the project root. */
  | { type: "preview.ready"; path: string; title?: string }
  | { type: "status"; status: SessionStatus }
  | { type: "log"; level: "debug" | "info" | "warn"; message: string }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "done"; status: RunStatus; summary?: string; reportPath?: string }
  // ---------------------------------------------------------------- workspace checkpoints
  /** A snapshot of the workspace files (taken before each turn, and before a restore). */
  | {
      type: "checkpoint.created";
      id: string;
      /** "turn": before a user turn; "restore": the state just before a checkpoint was restored. */
      reason: "turn" | "restore";
      /** Snapshot commit in the project's checkpoint store. */
      commit: string;
      /** Files in the snapshot. */
      files: number;
      /** The user message whose turn this checkpoint precedes ("turn" checkpoints; older logs omit it
       * and emit the checkpoint just before that message instead). */
      messageId?: string;
    }
  /** The workspace files were reset to checkpoint `id`; `backupId` holds the state before (to undo). */
  | {
      type: "checkpoint.restored";
      id: string;
      backupId: string;
      /** Changed files (at most 200 listed); `changed` is the full count. */
      files: CheckpointChange[];
      changed: number;
    }
  | { type: "checkpoint.failed"; reason: "turn" | "restore"; message: string }
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
    }
  // ---------------------------------------------------------------- 1:1 recreation
  | {
      type: "recreate.started";
      runId: string;
      url: string;
      finalUrl?: string;
      widths: number[];
      targets: RecreateTarget[];
      /** the consent recorded earlier (a resumed run); a new run's consent arrives as recreate.consent */
      consent?: RecreateConsent;
      /** run folder relative to the project root */
      dir: string;
    }
  | {
      type: "recreate.stage";
      runId: string;
      stage: RecreateStage;
      status: "running" | "done" | "failed" | "skipped";
      ms?: number;
      detail?: string;
      /** parts the budgets dropped (resumable) */
      skipped?: string[];
    }
  | {
      type: "recreate.section";
      runId: string;
      index: number;
      total: number;
      id: string;
      kind: string;
      label: string;
      status: "building" | "checking" | "ok" | "below-threshold" | "repaired";
      /** worst pixel mismatch of the section's band over the widths */
      pixel?: number;
      /** visible strings of the band missing / extra */
      text?: number;
      /** the section's band on the live page per captured width (px from the top of the full-page shot) */
      bands?: { width: number; y: number; h: number }[];
    }
  | {
      /** a screenshot of the live page, written to the run folder while it is captured (shown while waiting) */
      type: "recreate.shot";
      runId: string;
      /** peek: the first screen right after load; live: a full-page reference shot */
      kind: "peek" | "live";
      width: number;
      height: number;
      /** image relative to the project root */
      path: string;
    }
  | {
      type: "recreate.measured";
      runId: string;
      target: RecreateTarget;
      widths: RecreateWidthResult[];
      interactions?: string;
      gates: { name: string; pass: boolean; detail?: string }[];
      comparePath?: string;
    }
  | {
      type: "recreate.components";
      runId: string;
      sets: RecreateSetSummary[];
      lint: { pass: boolean; issues: string[] };
    }
  | {
      type: "recreate.consent";
      runId: string;
      url: string;
      consent: RecreateConsent;
    }
  | {
      type: "recreate.finished";
      runId: string;
      status: RunStatus;
      outputs: { target: RecreateTarget; path: string }[];
      comparePath?: string;
      summary?: string;
    };

/** Output of a recreation run: the static page, a converted project, design-system packages, tokens, brand guide. */
export type RecreateTarget =
  "static" | "react-vite" | "ds-react" | "ds-lit" | "ds-angular" | "tokens" | "design-md" | (string & {});

export type RecreateStage =
  | "consent"
  | "probe"
  | "capture"
  | "scene"
  | "build"
  | "measure"
  | "components"
  | "system"
  | "convert"
  | "ds-export"
  | "repair";

export interface RecreateConsent {
  /** who answered: the user, or the permission mode / --yes on their behalf */
  by: "user" | "auto";
  at: string;
  mode: "ask" | "auto" | "yolo" | "yes";
}

export interface RecreateWidthResult {
  width: number;
  pixel: number;
  textReal: number;
  textDrift: number;
  height: { live: number; out: number };
  hscroll: number;
}

export interface RecreateSetSummary {
  id: string;
  name: string;
  kind?: string;
  variants: number;
  props: string[];
  uses: number;
}

/** What a recreation run is asked to do (CLI flags, tool arguments, POST /recreate). */
export interface RecreateRequest {
  url: string;
  /** capture widths (default: the page's own layout ranges, else 390, 768, 1440) */
  widths?: number[];
  /** outputs (default ["static"]) */
  to?: RecreateTarget[];
  /** react-vite styling */
  style?: "tailwind" | "css-modules" | "vanilla";
  /** bounded repair of sections below their threshold by the model (opt-in; needs a configured model) */
  repair?: boolean;
  /** re-run from this stage of an existing run (`run` required) */
  from?: RecreateStage;
  run?: string;
  /** copy the outputs into this project folder when done */
  out?: string;
}

/** `recreate` section of the config. */
export interface RecreateConfig {
  /** false hides the tools, the command and the UI entry points (default true) */
  enabled?: boolean;
  /** run-dir: captured assets stay in the gitignored run folder; project: copied into the output; none: placeholders */
  assets?: "run-dir" | "project" | "none";
  /** embed: font files in the output (default; most sites refuse cross-origin font loads); reference: @font-face pointing at the site; system: fallback stacks */
  fonts?: "reference" | "embed" | "system";
  /** do not capture URLs robots.txt disallows for every crawler (default true) */
  respectRobots?: boolean;
  /** allow capturing localhost / private-network URLs (your own site; default false) */
  allowLocal?: boolean;
  budgets?: {
    totalMs?: number;
    menuMs?: number;
    submenuMs?: number;
    submenus?: number;
    regionMs?: number;
    altMs?: number;
    rasters?: number;
  };
  gates?: { pixel?: number; text?: number; heightPct?: number; responsivePixel?: number; singleUse?: number };
  /** model roles (or model refs) per stage */
  models?: { naming?: ModelRole | string; vision?: ModelRole | string; repair?: ModelRole | string };
  /** extra emitter modules (paths relative to the project root) */
  emitters?: string[];
  /** capture driver: cdp (local Chrome, default) or remote (POST to a capture service) */
  driver?: "cdp" | "remote";
  /** remote driver endpoint */
  remoteUrl?: string;
  /** capture sessions (device classes) run at once, each in its own browser (default 3) */
  captureParallel?: number;
}

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
  /** Accepts image input. */
  vision?: boolean;
  inputPrice?: number;
  outputPrice?: number;
  maxTokens?: number;
}

/** What a model can do, as reported by the provider or set in config. */
export type ModelCapability = "tools" | "vision" | "thinking" | "embedding";

/** A model a provider offers, with whatever metadata is known about it. */
export interface ModelDetail {
  id: string;
  capabilities?: ModelCapability[];
  contextWindow?: number;
}

/** One provider's entry in `GET /models?remote=true`. `details` is absent for providers that list ids only. */
export interface AvailableModels {
  models: string[];
  details?: ModelDetail[];
  error?: string;
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
  context?: {
    /**
     * Absolute working-context budget in tokens. The agent compacts at `compactAt` × min(model context
     * window, maxContext). Default 64000; 0 uses the model's context window alone. Smaller budgets keep the
     * per-call cost of long jobs flat with little accuracy loss on frontier models.
     */
    maxContext?: number;
    /** Fraction of the context budget at which compaction starts (default 0.7). */
    compactAt?: number;
    /** Most recent messages kept verbatim when compacting (default 6). */
    keepRecent?: number;
    maxToolOutput?: number;
    repoMapDepth?: number;
    /** Summarise long thinking into short decision lines for the user (summarizer model). Default true. */
    reasoningSummaries?: boolean;
  };
  sandbox?: "none" | "bwrap";
  /** Allow network access inside the bwrap sandbox (package installs). */
  sandboxNetwork?: boolean;
  /**
   * Folder for files a chat creates (poems, notes, drafts), so Chat mode does not add files to the repository.
   * Each chat gets its own subfolder; edits to files that already exist in the project still go to the project.
   * Absolute or `~/` path. The terminal app defaults to `$CDR_OUTPUT_DIR` or `~/Documents/CDR`; other front ends
   * leave it unset. `false` turns it off, so new files go into the project.
   */
  outputDir?: string | false;
  /** Skills (SKILL.md folders) offered to agents. Built-in, ~/.harness/skills and <project>/.harness/skills are always searched. */
  skills?: {
    /** Set to false to disable skills entirely. */
    enabled?: boolean;
    /** Extra folders containing skill folders (relative to the project root, or absolute). */
    paths?: string[];
    /** Skill names to hide. */
    disabled?: string[];
  };
  mcpServers?: Record<string, McpServerConfig>;
  /** 1:1 recreation of live web pages */
  recreate?: RecreateConfig;
  /** Workspace checkpoints before every turn, restorable from the UIs (default enabled). */
  checkpoints?: {
    enabled?: boolean;
  };
  temperature?: number;
  /** Subagent limits (spawn_agent). */
  agents?: {
    /** Concurrently running subagents per parent session (default 3). */
    maxConcurrent?: number;
    /** Maximum nesting depth; a session at this depth cannot spawn (default 2). */
    maxDepth?: number;
  };
}

/** One file a checkpoint restore changes: back to its old content, deleted (it did not exist yet) or recreated. */
export interface CheckpointChange {
  path: string;
  status: "modified" | "deleted" | "added";
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
  /** Skill names (see GET /skills) whose instructions are given to the agent with this message. */
  skills?: string[];
  /** "chat" continues the conversation with the executor; "task" runs the full workflow. */
  mode?: "chat" | "task";
  workflow?: string;
  attachments?: Attachment[];
}

/** GET /skills?projectPath= – skills available in a project (built-in, user, config and project skills). */
export interface SkillInfo {
  name: string;
  description: string;
  source: "project" | "config" | "user" | "builtin";
  /** Only the user can start it; the agent does not see it in its skill index. */
  userOnly?: boolean;
  /** What to type after selecting the skill, e.g. "What would you like to learn about?". */
  argumentHint?: string;
}

export interface SessionSettingsRequest {
  reasoningEffort?: ReasoningEffort;
  models?: Partial<Record<ModelRole, string>>;
  permissionMode?: "ask" | "auto" | "yolo";
  title?: string;
}

/** GET /storage: where the server keeps conversation history. */
export interface StorageInfo {
  /** The harness home (CDR_HOME / HARNESS_HOME, default ~/.harness). */
  home: string;
  /** One `<session id>.jsonl` event log per conversation. */
  sessionsDir: string;
}

/** A project file a conversation referenced through a tool call or an attachment. */
export interface SessionLogFile {
  /** Project-relative path. */
  path: string;
  /** Tool names (or "attachment") that referenced it, in first-use order. */
  uses: string[];
  /** It still exists and this session may open it through GET /sessions/:id/files. */
  viewable: boolean;
}

/** GET /sessions/:id/log: the conversation's stored event log. */
export interface SessionLogResponse {
  /** Absolute path of the JSONL file. */
  path: string;
  bytes: number;
  modifiedAt: string;
  /** Number of records in the whole file. */
  records: number;
  /** Raw JSONL; when `truncated`, only the most recent complete records that fit. */
  content: string;
  truncated: boolean;
  files: SessionLogFile[];
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
