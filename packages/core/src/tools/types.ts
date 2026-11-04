import type { EventBody, HarnessConfig, Risk, RunStatus, TodoItem } from "@harness/protocol";
import type { ToolSpec } from "../providers/types.js";
import type { VerifyRunner } from "../verify.js";

export interface ToolResult {
  ok: boolean;
  output: string;
  diff?: string;
  /** Files changed by this call (relative to project root). */
  edited?: string[];
}

export interface ToolContext {
  projectRoot: string;
  config: HarnessConfig;
  signal: AbortSignal;
  emit(e: EventBody): void;
  ask(question: string, options?: string[]): Promise<string>;
  todos: TodoItem[];
  verify?: VerifyRunner;
  /** Environment variable names that must not leak into shell commands. */
  secretEnv: string[];
  /** Id of the tool call being executed (set by the agent loop). */
  toolCallId?: string;
  /** Subagent support, provided by the Session when spawning is allowed. */
  agents?: AgentSpawner;
}

export interface SpawnAgentRequest {
  task: string;
  /** Model role ("executor" | "planner" | "reviewer") or an explicit "provider/model". */
  role?: string;
  isolation?: "shared" | "worktree";
  /** Further restrict the child's tools to these names. */
  tools?: string[];
  budget?: { maxTurns?: number; maxTokens?: number; maxCost?: number; timeoutMs?: number };
}

export interface AgentHandle {
  agentId: string;
  sessionId: string;
  worktree?: string;
  branch?: string;
}

export interface AgentOutcome extends AgentHandle {
  status: RunStatus;
  /** The child's final message. */
  summary: string;
  diffStat?: string;
  usage: { inputTokens: number; outputTokens: number; cost: number };
}

export interface AgentSpawner {
  /** Start a child session. Throws an Error with a model-readable message when limits forbid it. */
  spawn(req: SpawnAgentRequest, toolCallId: string): Promise<AgentHandle>;
  /** Wait for the given agents (default: every agent not collected yet). */
  wait(agentIds?: string[]): Promise<AgentOutcome[]>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Tool never mutates anything – allowed in the plan/review phases and without asking. */
  readOnly: boolean;
  /** Optional per-call risk assessment (defaults: readOnly → low, otherwise medium). */
  risk?(args: any, ctx: ToolContext): Risk;
  execute(args: any, ctx: ToolContext): Promise<ToolResult>;
}

export function toSpec(t: Tool): ToolSpec {
  return { name: t.name, description: t.description, parameters: t.parameters };
}

export class ToolError extends Error {}

/** Minimal JSON-schema validation (required + primitive types) with model-friendly errors. */
export function validateArgs(tool: Tool, args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return `Arguments for ${tool.name} must be a JSON object.`;
  const schema = tool.parameters as {
    properties?: Record<string, { type?: string | string[] }>;
    required?: string[];
  };
  const a = args as Record<string, unknown>;
  for (const r of schema.required ?? []) {
    if (a[r] === undefined || a[r] === null) return `Missing required argument "${r}" for ${tool.name}.`;
  }
  for (const [k, v] of Object.entries(a)) {
    const prop = schema.properties?.[k];
    if (!prop) continue;
    const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
    if (!types.length || v === null) continue;
    const actual = Array.isArray(v)
      ? "array"
      : typeof v === "number" && Number.isInteger(v)
        ? "integer"
        : typeof v;
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) return `Argument "${k}" for ${tool.name} must be ${types.join("|")}, got ${actual}.`;
  }
  return null;
}
