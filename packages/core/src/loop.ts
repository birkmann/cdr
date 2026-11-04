import type {
  ChatMessage,
  EventBody,
  HarnessConfig,
  PermissionDecision,
  Risk,
  TodoItem,
  ToolCall,
} from "@harness/protocol";
import type { Provider } from "./providers/types.js";
import type { AgentSpawner, Tool, ToolContext, ToolResult } from "./tools/types.js";
import { toSpec, validateArgs, ToolError } from "./tools/types.js";
import type { PermissionPolicy } from "./permissions.js";
import type { VerifyRunner } from "./verify.js";
import { compactMessages, needsCompaction } from "./context.js";
import { isAbortError, newId, redact, safeJsonParse, truncateMiddle } from "./util.js";

export interface AgentHost {
  projectRoot: string;
  config: HarnessConfig;
  signal: AbortSignal;
  emit(e: EventBody): void;
  requestPermission(tool: string, args: unknown, risk: Risk, reason?: string): Promise<PermissionDecision>;
  ask(question: string, options?: string[]): Promise<string>;
  todos: TodoItem[];
  secretEnv: string[];
  /** Budget bookkeeping shared across all agents of a run. */
  budget: Budget;
  /** Subagent spawner (spawn_agent / wait_agents). */
  agents?: AgentSpawner;
}

export class Budget {
  inputTokens = 0;
  outputTokens = 0;
  cost = 0;
  turns = 0;
  readonly startedAt = Date.now();
  private inputWaits = 0;
  private pausedAt = 0;
  private pausedMs = 0;
  constructor(readonly limits: HarnessConfig["limits"] = {}) {}
  /** Exclude human response time, counting overlapping prompts only once. */
  pauseForInput(): () => void {
    if (this.inputWaits++ === 0) this.pausedAt = Date.now();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (--this.inputWaits === 0) this.pausedMs += Date.now() - this.pausedAt;
    };
  }
  get activeElapsedMs(): number {
    return (this.inputWaits ? this.pausedAt : Date.now()) - this.startedAt - this.pausedMs;
  }
  add(input: number, output: number, cost: number) {
    this.inputTokens += input;
    this.outputTokens += output;
    this.cost += cost;
  }
  exceeded(): string | null {
    const l = this.limits ?? {};
    if (l.maxTokens && this.inputTokens + this.outputTokens > l.maxTokens)
      return `CDR's configured token limit reached (${this.inputTokens + this.outputTokens} > ${l.maxTokens}; limits.maxTokens). This per-run input + output limit is separate from your provider account balance. Increase limits.maxTokens or set it to 0 to disable.`;
    if (l.maxCost && this.cost > l.maxCost)
      return `CDR's configured cost limit reached ($${this.cost.toFixed(4)} > $${l.maxCost}; limits.maxCost). This uses configured model prices, not your provider account balance. Increase limits.maxCost or set it to 0 to disable.`;
    if (l.timeoutMs && this.activeElapsedMs > l.timeoutMs)
      return `active-time timeout (${l.timeoutMs} ms; time waiting for input excluded)`;
    return null;
  }
}

export interface AgentHooks {
  /** Return a string to deny the call with that message. */
  beforeTool?(call: ToolCall, args: unknown): Promise<string | void> | string | void;
  /** Return extra text appended to the tool result shown to the model. */
  afterTool?(call: ToolCall, args: unknown, result: ToolResult): Promise<string | void> | string | void;
  /** Called when the model stops calling tools. Return a message to continue the loop instead of stopping. */
  onStop?(finalText: string, turn: number): Promise<string | void> | string | void;
}

export interface RunAgentOptions {
  host: AgentHost;
  agent: string;
  provider: Provider;
  model: string;
  modelRef: string;
  /** Messages including system prompt. The loop appends to a copy. */
  messages: ChatMessage[];
  /** Messages in `messages` that are new and must be recorded (context.append). Defaults to all. */
  recordFrom?: number;
  tools: Tool[];
  maxTurns?: number;
  temperature?: number;
  hooks?: AgentHooks[];
  verify?: VerifyRunner;
  /** Provider/model used for compaction summaries. */
  summarizer?: { provider: Provider; model: string };
  policy: PermissionPolicy;
  pricing?: { inputPrice?: number; outputPrice?: number };
}

export interface AgentResult {
  status: "completed" | "max_turns" | "budget" | "cancelled" | "error";
  finalText: string;
  messages: ChatMessage[];
  turns: number;
  edited: string[];
  diffs: { path: string; diff: string }[];
  error?: string;
}

export async function runAgent(o: RunAgentOptions): Promise<AgentResult> {
  const { host } = o;
  const messages = [...o.messages];
  for (const m of messages.slice(o.recordFrom ?? 0))
    host.emit({ type: "context.append", agent: o.agent, message: m });
  const toolMap = new Map(o.tools.map((t) => [t.name, t]));
  const specs = o.tools.map(toSpec);
  const maxTurns = o.maxTurns ?? host.config.limits?.maxTurns ?? 60;
  const maxOut = host.config.context?.maxToolOutput ?? 20_000;
  const edited = new Set<string>();
  const diffs: { path: string; diff: string }[] = [];
  const recent: string[] = [];
  let finalText = "";
  let turn = 0;

  const ctx: ToolContext = {
    projectRoot: host.projectRoot,
    config: host.config,
    signal: host.signal,
    emit: (e) => host.emit(e),
    ask: (q, opts) => host.ask(q, opts),
    todos: host.todos,
    verify: o.verify,
    secretEnv: host.secretEnv,
    agents: host.agents,
  };
  const push = (m: ChatMessage) => {
    messages.push(m);
    host.emit({ type: "context.append", agent: o.agent, message: m });
  };
  const result = (status: AgentResult["status"], error?: string): AgentResult => ({
    status,
    finalText,
    messages,
    turns: turn,
    edited: [...edited],
    diffs,
    error,
  });

  try {
    while (true) {
      if (host.signal.aborted) return result("cancelled");
      if (turn >= maxTurns) {
        host.emit({
          type: "error",
          message: `${o.agent}: reached max turns (${maxTurns})`,
          recoverable: false,
        });
        return result("max_turns", `max turns (${maxTurns}) reached`);
      }
      const over = host.budget.exceeded();
      if (over) {
        host.emit({ type: "error", message: `${o.agent}: ${over}`, recoverable: false });
        return result("budget", over);
      }
      turn++;
      host.budget.turns++;

      // Compaction before calling the model.
      const caps = o.provider.capabilities(o.model);
      if (needsCompaction(messages, caps.contextWindow, host.config.context?.compactAt ?? 0.7)) {
        const s = o.summarizer ?? { provider: o.provider, model: o.model };
        const c = await compactMessages(messages, {
          ...s,
          keepRecent: host.config.context?.keepRecent ?? 6,
          reasoningEffort: host.config.reasoningEffort,
          signal: host.signal,
        });
        if (c) {
          messages.splice(0, messages.length, ...c.messages);
          host.emit({ type: "context.replace", agent: o.agent, messages: c.messages, reason: "compaction" });
          host.emit({ type: "log", level: "info", message: `${o.agent}: context compacted` });
        }
      }

      const msgId = newId("msg_");
      host.emit({ type: "message.start", id: msgId, role: "assistant", agent: o.agent });
      let text = "";
      let reasoning = "";
      const calls: ToolCall[] = [];
      let inTok = 0;
      let outTok = 0;
      for await (const ev of o.provider.stream({
        model: o.model,
        reasoningEffort: host.config.reasoningEffort,
        messages,
        tools: specs.length ? specs : undefined,
        temperature: o.temperature ?? host.config.temperature,
        signal: host.signal,
      })) {
        if (ev.type === "text") {
          text += ev.text;
          host.emit({ type: "message.delta", id: msgId, text: ev.text });
        } else if (ev.type === "reasoning") {
          reasoning += ev.text;
          host.emit({ type: "reasoning.delta", id: msgId, text: ev.text });
        } else if (ev.type === "tool_call") calls.push(ev.call);
        else if (ev.type === "usage") {
          inTok += ev.inputTokens;
          outTok += ev.outputTokens;
        }
      }
      host.emit({ type: "message.end", id: msgId, text });
      const cost =
        ((o.pricing?.inputPrice ?? 0) * inTok + (o.pricing?.outputPrice ?? 0) * outTok) / 1_000_000;
      host.budget.add(inTok, outTok, cost);
      host.emit({
        type: "usage",
        inputTokens: inTok,
        outputTokens: outTok,
        cost: cost || undefined,
        model: o.modelRef,
      });

      push({
        role: "assistant",
        content: text,
        ...(calls.length ? { toolCalls: calls } : {}),
        ...(reasoning && calls.length ? { reasoning } : {}),
      });
      finalText = text;

      if (!calls.length) {
        let cont: string | void = undefined;
        for (const h of o.hooks ?? []) {
          cont = (await h.onStop?.(text, turn)) ?? cont;
        }
        if (cont) {
          push({ role: "user", content: cont });
          continue;
        }
        return result("completed");
      }

      for (const call of calls) {
        if (host.signal.aborted) {
          push({ role: "tool", toolCallId: call.id, name: call.name, content: "Cancelled by user." });
          continue;
        }
        const out = await executeCall(call);
        push({ role: "tool", toolCallId: call.id, name: call.name, content: out });
      }
    }
  } catch (e) {
    if (isAbortError(e) || host.signal.aborted) return result("cancelled");
    const msg = redact((e as Error).message ?? String(e));
    host.emit({ type: "error", message: `${o.agent}: ${msg}`, recoverable: false });
    return result("error", msg);
  }

  async function executeCall(call: ToolCall): Promise<string> {
    const parsed = safeJsonParse(call.arguments || "{}");
    const args = parsed.ok ? parsed.value : undefined;
    host.emit({ type: "tool.call", id: call.id, name: call.name, args: args ?? call.arguments });
    const fail = (output: string) => {
      host.emit({ type: "tool.result", id: call.id, name: call.name, ok: false, output });
      return output;
    };
    if (!parsed.ok) return fail(`Invalid JSON arguments: ${parsed.error}. Send a valid JSON object.`);
    const tool = toolMap.get(call.name);
    if (!tool)
      return fail(`Unknown tool "${call.name}". Available tools: ${[...toolMap.keys()].join(", ")}.`);
    const invalid = validateArgs(tool, args);
    if (invalid) return fail(`${invalid}\nExpected schema: ${JSON.stringify(tool.parameters)}`);

    // Repetition guard: identical call three times in a row.
    const sig = `${call.name}:${call.arguments}`;
    recent.push(sig);
    if (recent.length > 3) recent.shift();
    const repeated = recent.length === 3 && recent.every((s) => s === sig);

    for (const h of o.hooks ?? []) {
      const deny = await h.beforeTool?.(call, args);
      if (deny) return fail(deny);
    }
    const callCtx: ToolContext = { ...ctx, toolCallId: call.id };
    const check = o.policy.check(tool, args, callCtx);
    if (check.decision === "deny") return fail(`Permission denied: ${check.reason ?? "blocked by policy"}`);
    if (check.decision === "ask") {
      const decision = await host.requestPermission(tool.name, args, check.risk, check.reason);
      o.policy.record(tool.name, args, decision);
      if (decision === "deny")
        return fail(
          "The user denied this action. Do not retry it; choose a different approach or ask the user.",
        );
    }

    let res: ToolResult;
    try {
      res = await tool.execute(args, callCtx);
    } catch (e) {
      if (isAbortError(e)) throw e;
      const msg = e instanceof ToolError ? e.message : `Tool error: ${(e as Error).message}`;
      return fail(msg);
    }
    for (const f of res.edited ?? []) edited.add(f);
    if (res.diff) diffs.push({ path: res.edited?.[0] ?? "?", diff: res.diff });
    let extra = "";
    for (const h of o.hooks ?? []) {
      const x = await h.afterTool?.(call, args, res);
      if (x) extra += `\n\n${x}`;
    }
    const t = truncateMiddle(redact(res.output + extra), maxOut);
    host.emit({
      type: "tool.result",
      id: call.id,
      name: call.name,
      ok: res.ok,
      output: t.text,
      truncated: t.truncated || undefined,
      diff: res.diff ? redact(res.diff) : undefined,
    });
    let content = t.text;
    if (repeated)
      content += "\n\n[harness] You have made this exact call three times in a row. Change your approach.";
    return content;
  }
}
