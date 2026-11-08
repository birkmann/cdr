import type { HarnessEvent } from "@harness/protocol";
import type { AgentView, MessageView, TimelineItem, TokenUsage, ToolCallView } from "./index.js";

/**
 * A plain-language account of one turn (a user message and the work it caused): how the result came
 * about, where time and tokens went, and what could be improved. Built only from the session's events.
 */

/** What a step was doing: the model thinking, or one kind of tool use. */
export type StepCategory = "thinking" | "explore" | "build" | "check" | "run" | "other";
/** Stage kinds: step categories plus a final answer without tools. */
export type StageKind = StepCategory | "answer";

export const STEP_CATEGORIES: { id: StepCategory; label: string }[] = [
  { id: "thinking", label: "Model thinking & writing" },
  { id: "explore", label: "Exploring" },
  { id: "build", label: "Writing files" },
  { id: "check", label: "Checking" },
  { id: "run", label: "Running commands" },
  { id: "other", label: "Other tools" },
];

const TOOL_CATEGORY: Record<string, StepCategory> = {
  read_file: "explore",
  list_dir: "explore",
  glob: "explore",
  grep: "explore",
  load_skill: "explore",
  search_unsplash: "explore",
  recreate_capture: "explore",
  write_file: "build",
  patch_file: "build",
  use_unsplash_photo: "build",
  set_preview: "build",
  set_launch: "build",
  design_system: "build",
  recreate_build: "build",
  recreate_section: "build",
  recreate_components: "build",
  recreate_convert: "build",
  check_preview: "check",
  check_app: "check",
  run_verification: "check",
  recreate_measure: "check",
  bash: "run",
  run_app: "run",
  stop_app: "run",
};

const CHECK_COMMAND =
  /\b(test|tests|vitest|jest|pytest|lint|eslint|tsc|typecheck|clippy|cargo (test|check))\b/;

export function toolCategory(t: Pick<ToolCallView, "name" | "args">): StepCategory {
  if (t.name === "bash") {
    const cmd = String((t.args as { command?: unknown } | undefined)?.command ?? "");
    return CHECK_COMMAND.test(cmd) ? "check" : "run";
  }
  return TOOL_CATEGORY[t.name] ?? "other";
}

export interface ReportSegment {
  kind: "model" | "tool";
  category: StepCategory;
  label: string;
  /** ms from the start of the turn */
  start: number;
  end: number;
  ok?: boolean;
}

export interface ReportCall {
  /** 1-based position in the turn */
  index: number;
  messageId: string;
  agent?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  durationMs: number;
  /** tool call ids this model call requested */
  tools: string[];
  decisions: string[];
  /** the agent's context was compacted right before this call */
  compactedBefore: boolean;
}

export interface ReportStage {
  kind: StageKind;
  title: string;
  detail: string;
  startMs: number;
  endMs: number;
  calls: number[];
  decisions: string[];
  failures: number;
  tokens: number;
}

export interface ReportToolStat {
  name: string;
  category: StepCategory;
  count: number;
  failed: number;
  ms: number;
  /** estimated tokens of output the tool added to the context */
  outputTokens: number;
  /** estimated input tokens spent re-sending that output to later model calls */
  carriedTokens: number;
}

export interface ReportConsumer {
  toolId: string;
  label: string;
  outputTokens: number;
  carriedCalls: number;
  carriedTokens: number;
}

export interface ReportCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ReportFile {
  path: string;
  created: boolean;
  edits: number;
  failedEdits: number;
  reads: number;
}

export interface ReportInsight {
  level: "warn" | "tip" | "info";
  title: string;
  detail: string;
}

export interface TurnReport {
  status: "success" | "stopped" | "running";
  stopReason?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs: number;
  models: string[];
  totals: {
    modelCalls: number;
    toolCalls: number;
    failedTools: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
  tokens: Record<"reply" | "thinking" | "compaction" | "other" | "subagents", TokenUsage>;
  /** wall time per category (tools by category, model calls as "thinking"), plus unaccounted time */
  time: Record<StepCategory, number> & { idle: number };
  segments: ReportSegment[];
  calls: ReportCall[];
  stages: ReportStage[];
  tools: ReportToolStat[];
  consumers: ReportConsumer[];
  files: ReportFile[];
  checks: ReportCheck[];
  skills: string[];
  insights: ReportInsight[];
}

export interface TurnReportInput {
  /** The turn's timeline items after its user message. */
  items: TimelineItem[];
  messages: Record<string, MessageView>;
  tools: Record<string, ToolCallView>;
  overhead?: { compaction: TokenUsage; other: TokenUsage };
  agents?: Record<string, AgentView>;
  times?: { start: string; end?: string };
  /** Current time for a turn still running (ms). */
  now?: number;
}

/** Timeline items of the turn started by user message `userId` (up to the next user message). */
export function turnItems(
  timeline: TimelineItem[],
  messages: Record<string, MessageView>,
  userId: string,
): TimelineItem[] {
  const at = timeline.findIndex((i) => i.kind === "message" && i.id === userId);
  if (at < 0) return [];
  const out: TimelineItem[] = [];
  for (const item of timeline.slice(at + 1)) {
    if (item.kind === "message" && messages[item.id]?.role === "user") break;
    out.push(item);
  }
  return out;
}

const zero = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 });
const total = (u: TokenUsage) => u.inputTokens + u.outputTokens;
const plus = (a: TokenUsage, b?: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: a.inputTokens + (b?.inputTokens ?? 0),
  outputTokens: a.outputTokens + (b?.outputTokens ?? 0),
  cost: a.cost + (b?.cost ?? 0),
  calls: a.calls + (b?.calls ?? (b ? 1 : 0)),
});
/** Rough token count of tool output (about four characters per token). */
export const estimateTextTokens = (text: string | undefined) => Math.ceil((text?.length ?? 0) / 4);

const time = (ts: string | undefined) => {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(cost: number): string {
  return cost >= 1 ? `$${cost.toFixed(2)}` : cost >= 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(4)}`;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function argOf(t: ToolCallView, key: string): string {
  const v = (t.args as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? v : "";
}

/** A short human label for one tool call. */
export function toolLabel(t: ToolCallView): string {
  const path = argOf(t, "path");
  const command = argOf(t, "command");
  switch (t.name) {
    case "read_file":
      return `Read ${path}`;
    case "write_file":
      return `Wrote ${path}`;
    case "patch_file":
      return `Edited ${path}`;
    case "bash":
      return `Ran \`${command.length > 60 ? `${command.slice(0, 57)}…` : command}\``;
    case "grep":
    case "glob":
      return `Searched ${argOf(t, "pattern")}`;
    case "list_dir":
      return `Listed ${path || "."}`;
    case "check_preview":
      return `Checked the preview${path ? ` of ${path}` : ""}`;
    case "check_app":
      return `Play-tested \`${command.length > 60 ? `${command.slice(0, 57)}…` : command}\``;
    case "load_skill":
      return `Loaded skill ${argOf(t, "name")}`;
    case "search_unsplash":
      return `Searched photos for “${argOf(t, "query")}”`;
    default:
      return path ? `${t.name} ${path}` : t.name;
  }
}

function names(list: string[], max = 3): string {
  const unique = [...new Set(list.filter(Boolean))];
  return unique.length <= max
    ? unique.join(", ")
    : `${unique.slice(0, max).join(", ")} +${unique.length - max}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "read 3 files, 2 searches; 6 edits to index.html (1 failed)" for a set of tool calls. */
function describeTools(list: ToolCallView[]): string {
  const by = new Map<string, ToolCallView[]>();
  for (const t of list) by.set(t.name, [...(by.get(t.name) ?? []), t]);
  const parts: string[] = [];
  for (const [name, ts] of by) {
    const paths = ts.map((t) => argOf(t, "path"));
    const failed = ts.filter((t) => t.status === "error").length;
    const n = ts.length;
    let part: string;
    switch (name) {
      case "read_file":
        part = `read ${names(paths)}`;
        break;
      case "write_file":
        part = `wrote ${names(paths)}`;
        break;
      case "patch_file":
        part = `${plural(n, "edit")} to ${names(paths)}`;
        break;
      case "grep":
      case "glob":
        part = plural(n, "search", "searches");
        break;
      case "list_dir":
        part = `listed ${plural(n, "folder")}`;
        break;
      case "load_skill":
        part = `loaded skill ${names(ts.map((t) => argOf(t, "name")))}`;
        break;
      case "check_preview":
        part = plural(n, "preview check");
        break;
      case "check_app":
        part = plural(n, "play-test");
        break;
      case "run_verification":
        part = plural(n, "verification run");
        break;
      case "bash":
        part = n === 1 ? `ran \`${argOf(ts[0], "command").slice(0, 50)}\`` : `ran ${n} commands`;
        break;
      case "search_unsplash":
        part = plural(n, "photo search", "photo searches");
        break;
      case "use_unsplash_photo":
        part = `picked ${plural(n, "photo")}`;
        break;
      case "set_preview":
        part = `opened the preview of ${names(paths)}`;
        break;
      case "set_launch":
        part = "set how to start the program";
        break;
      case "todo":
        part = "updated the checklist";
        break;
      case "spawn_agent":
        part = `started ${plural(n, "subagent")}`;
        break;
      default:
        part = n === 1 ? name : `${name} ×${n}`;
    }
    parts.push(failed ? `${part} (${failed} failed)` : part);
  }
  return parts.join(", ");
}

const STAGE_TITLE: Record<StageKind, string> = {
  thinking: "Planned",
  explore: "Explored",
  build: "Wrote the files",
  check: "Checked the result",
  run: "Ran commands",
  other: "Organised the work",
  answer: "Wrote the answer",
};
const STAGE_PRIORITY: StageKind[] = ["build", "check", "run", "explore", "other", "thinking", "answer"];

function callKind(tools: ToolCallView[], last: boolean): StageKind {
  if (!tools.length) return last ? "answer" : "thinking";
  const counts = new Map<StageKind, number>();
  for (const t of tools) counts.set(toolCategory(t), (counts.get(toolCategory(t)) ?? 0) + 1);
  return [...counts].sort(
    (a, b) => b[1] - a[1] || STAGE_PRIORITY.indexOf(a[0]) - STAGE_PRIORITY.indexOf(b[0]),
  )[0][0];
}

/** Whether a checking tool's output reports a clean result. */
function checkPassed(t: ToolCallView): boolean {
  if (t.status !== "ok") return false;
  const head = (t.output ?? "").slice(0, 400);
  if (/no problems|passed|all checks|0 errors/i.test(head)) return true;
  return !/\b(error|errors|fail|failed|failing|problem|problems|broken|overflow)\b/i.test(head);
}

const firstLine = (s: string | undefined, max = 140) => {
  const line = (s ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function buildTurnReport(input: TurnReportInput): TurnReport {
  const { items, messages, tools } = input;
  const calls: ReportCall[] = [];
  const toolList: ToolCallView[] = [];
  /** model call index (0-based) each tool belongs to */
  const toolCall = new Map<string, number>();
  /** model call count at each compaction (tool output before it stops being re-sent) */
  const compactions: number[] = [];
  const checks: ReportCheck[] = [];
  const skills: string[] = [];
  const subagents: string[] = [];
  const tokens = {
    reply: zero(),
    thinking: zero(),
    compaction: input.overhead?.compaction ?? zero(),
    other: input.overhead?.other ?? zero(),
    subagents: zero(),
  };
  const models = new Set<string>();
  let status: TurnReport["status"] = input.times?.end
    ? "success"
    : input.now !== undefined
      ? "running"
      : "success";
  let stopReason: string | undefined;
  let compactedPending = false;
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  const seen = (ts: string | undefined) => {
    const t = time(ts);
    if (t === undefined) return;
    firstTs = firstTs === undefined ? t : Math.min(firstTs, t);
    lastTs = lastTs === undefined ? t : Math.max(lastTs, t);
  };

  for (const item of items) {
    if (item.kind === "message") {
      const m = messages[item.id];
      if (!m || m.role !== "assistant") continue;
      seen(m.startedAt);
      seen(m.endedAt);
      if (m.usage) tokens.reply = plus(tokens.reply, m.usage);
      if (m.thinkingUsage) tokens.thinking = plus(tokens.thinking, m.thinkingUsage);
      if (m.usage?.model) models.add(m.usage.model);
      const s = time(m.startedAt);
      const e = time(m.endedAt);
      calls.push({
        index: calls.length + 1,
        messageId: m.id,
        agent: m.agent,
        model: m.usage?.model,
        inputTokens: m.usage?.inputTokens ?? 0,
        outputTokens: m.usage?.outputTokens ?? 0,
        thinkingTokens: m.thinkingUsage ? total(m.thinkingUsage) : 0,
        durationMs: s !== undefined && e !== undefined ? e - s : 0,
        tools: [],
        decisions: m.decisions ?? [],
        compactedBefore: compactedPending,
      });
      compactedPending = false;
    } else if (item.kind === "tool") {
      const t = tools[item.id];
      if (!t) continue;
      seen(t.startedAt);
      seen(t.endedAt);
      toolList.push(t);
      if (calls.length) {
        calls[calls.length - 1].tools.push(t.id);
        toolCall.set(t.id, calls.length - 1);
      }
      if (t.name === "check_preview" || t.name === "run_verification" || toolCategory(t) === "check")
        checks.push({ label: toolLabel(t), ok: checkPassed(t), detail: firstLine(t.output) });
    } else {
      const e: HarnessEvent = item.event;
      seen(e.ts);
      if (e.type === "context.compacted") {
        compactions.push(calls.length);
        compactedPending = true;
      } else if (e.type === "done") {
        status = e.status === "success" ? "success" : "stopped";
        if (e.status !== "success") stopReason = stopReason ?? e.summary ?? e.status;
      } else if (e.type === "error") stopReason = e.message;
      else if (e.type === "verify.result")
        checks.push({
          label: `Verification \`${e.command}\`${e.attempt > 1 ? ` (attempt ${e.attempt})` : ""}`,
          ok: e.exitCode === 0,
          detail: e.exitCode === 0 ? "passed" : firstLine(e.output),
        });
      else if (e.type === "review.findings") {
        const serious = e.findings.filter((f) => ["blocking", "major"].includes(f.severity)).length;
        checks.push({
          label: "Review",
          ok: serious === 0,
          detail:
            e.summary ?? `${plural(e.findings.length, "finding")}${serious ? `, ${serious} serious` : ""}`,
        });
      } else if (e.type === "skill.activated") skills.push(e.name);
      else if (e.type === "agent.spawned") subagents.push(e.agentId);
    }
  }
  for (const id of subagents) {
    const u = input.agents?.[id]?.usage;
    if (u) tokens.subagents = plus(tokens.subagents, { ...u, cost: u.cost ?? 0, calls: 1 });
  }

  const startAbs = time(input.times?.start) ?? firstTs ?? 0;
  const endAbs =
    time(input.times?.end) ??
    (status === "running" && input.now !== undefined ? input.now : lastTs) ??
    startAbs;
  const durationMs = Math.max(0, endAbs - startAbs);
  const rel = (ts: string | undefined, fallback: number) => {
    const t = time(ts);
    return t === undefined ? fallback : Math.max(0, t - startAbs);
  };

  // ---------------------------------------------------------------- time
  const segments: ReportSegment[] = [];
  const timeBy = { thinking: 0, explore: 0, build: 0, check: 0, run: 0, other: 0, idle: 0 };
  for (const c of calls) {
    const m = messages[c.messageId];
    const start = rel(m.startedAt, 0);
    const end = rel(m.endedAt, status === "running" ? durationMs : start);
    timeBy.thinking += end - start;
    if (end > start)
      segments.push({ kind: "model", category: "thinking", label: `Model call #${c.index}`, start, end });
  }
  for (const t of toolList) {
    const start = rel(t.startedAt, 0);
    const end = rel(t.endedAt, status === "running" ? durationMs : start);
    const cat = toolCategory(t);
    timeBy[cat] += end - start;
    segments.push({ kind: "tool", category: cat, label: toolLabel(t), start, end, ok: t.status !== "error" });
  }
  segments.sort((a, b) => a.start - b.start);
  const busy = timeBy.thinking + timeBy.explore + timeBy.build + timeBy.check + timeBy.run + timeBy.other;
  timeBy.idle = Math.max(0, durationMs - busy);

  // ---------------------------------------------------------------- tools and context carry
  const stats = new Map<string, ReportToolStat>();
  const consumers: ReportConsumer[] = [];
  for (const t of toolList) {
    const out = estimateTextTokens(t.output);
    const at = toolCall.get(t.id) ?? -1;
    // The output is re-sent with every later model call until the next compaction.
    const until = compactions.find((c) => c > at) ?? calls.length;
    const carriedCalls = Math.max(0, until - at - 1);
    const carried = out * carriedCalls;
    const st = stats.get(t.name) ?? {
      name: t.name,
      category: toolCategory(t),
      count: 0,
      failed: 0,
      ms: 0,
      outputTokens: 0,
      carriedTokens: 0,
    };
    st.count++;
    if (t.status === "error") st.failed++;
    const s = time(t.startedAt);
    const e = time(t.endedAt);
    if (s !== undefined && e !== undefined) st.ms += e - s;
    st.outputTokens += out;
    st.carriedTokens += carried;
    stats.set(t.name, st);
    consumers.push({
      toolId: t.id,
      label: `${toolLabel(t)}${at >= 0 ? ` (call #${at + 1})` : ""}`,
      outputTokens: out,
      carriedCalls,
      carriedTokens: carried,
    });
  }
  consumers.sort((a, b) => b.carriedTokens - a.carriedTokens || b.outputTokens - a.outputTokens);

  // ---------------------------------------------------------------- files
  const files = new Map<string, ReportFile>();
  const file = (path: string) => {
    const f = files.get(path) ?? { path, created: false, edits: 0, failedEdits: 0, reads: 0 };
    files.set(path, f);
    return f;
  };
  for (const t of toolList) {
    const path = argOf(t, "path");
    if (!path) continue;
    if (t.name === "write_file") {
      const f = file(path);
      if (t.status === "error") f.failedEdits++;
      // The first write of a file the agent never looked at is taken as creating it.
      else if (!f.created && !f.edits && !f.reads) f.created = true;
      else f.edits++;
    } else if (t.name === "patch_file") {
      const f = file(path);
      if (t.status === "error") f.failedEdits++;
      else f.edits++;
    } else if (t.name === "read_file") file(path).reads++;
  }
  const changed = [...files.values()].filter((f) => f.created || f.edits || f.failedEdits);

  // ---------------------------------------------------------------- stages
  type Draft = { kind: StageKind; calls: number[] };
  let drafts: Draft[] = [];
  calls.forEach((c, i) => {
    const kind = callKind(
      c.tools.map((id) => tools[id]).filter(Boolean),
      i === calls.length - 1 && status !== "running",
    );
    const last = drafts[drafts.length - 1];
    if (last?.kind === kind) last.calls.push(i);
    else drafts.push({ kind, calls: [i] });
  });
  // A single call between two stages of the same kind folds into them ("explore, read once more, explore").
  for (let i = 1; i < drafts.length - 1; i++) {
    if (
      drafts[i].calls.length === 1 &&
      drafts[i - 1].kind === drafts[i + 1].kind &&
      drafts[i].kind !== "answer"
    ) {
      drafts[i - 1].calls.push(...drafts[i].calls, ...drafts[i + 1].calls);
      drafts.splice(i, 2);
      i--;
    }
  }
  drafts = drafts.filter((d) => d.calls.length);
  const stages: ReportStage[] = drafts.map((d) => {
    const cs = d.calls.map((i) => calls[i]);
    const ts = cs.flatMap((c) => c.tools.map((id) => tools[id]).filter(Boolean));
    const first = messages[cs[0].messageId];
    const lastCall = cs[cs.length - 1];
    const lastTool = ts.length ? ts[ts.length - 1] : undefined;
    const startMs = rel(first.startedAt, 0);
    const endMs = Math.max(
      rel(messages[lastCall.messageId].endedAt, startMs),
      lastTool ? rel(lastTool.endedAt, startMs) : startMs,
    );
    const failures = ts.filter((t) => t.status === "error").length;
    return {
      kind: d.kind,
      title: STAGE_TITLE[d.kind],
      detail:
        describeTools(ts) ||
        (d.kind === "answer"
          ? "summarised the work"
          : `thought for ${plural(cs.length, "model call")} without tools`),
      startMs,
      endMs,
      calls: cs.map((c) => c.index),
      decisions: cs.flatMap((c) => c.decisions),
      failures,
      tokens: cs.reduce((n, c) => n + c.inputTokens + c.outputTokens + c.thinkingTokens, 0),
    };
  });

  const totals = {
    modelCalls: calls.length,
    toolCalls: toolList.length,
    failedTools: toolList.filter((t) => t.status === "error").length,
    inputTokens: Object.values(tokens).reduce((n, u) => n + u.inputTokens, 0),
    outputTokens: Object.values(tokens).reduce((n, u) => n + u.outputTokens, 0),
    cost: Object.values(tokens).reduce((n, u) => n + u.cost, 0),
  };

  const report: TurnReport = {
    status,
    stopReason,
    startedAt: input.times?.start,
    endedAt: input.times?.end,
    durationMs,
    models: [...models],
    totals,
    tokens,
    time: timeBy,
    segments,
    calls,
    stages,
    tools: [...stats.values()].sort((a, b) => b.ms - a.ms),
    consumers: consumers.slice(0, 8),
    files: changed,
    checks,
    skills: [...new Set(skills)],
    insights: [],
  };
  report.insights = insights(report, toolList);
  return report;
}

function insights(r: TurnReport, toolList: ToolCallView[]): ReportInsight[] {
  const out: ReportInsight[] = [];
  const all = r.totals.inputTokens + r.totals.outputTokens;
  const withUsage = r.calls.filter((c) => c.inputTokens || c.outputTokens);
  const avgCall = withUsage.length
    ? withUsage.reduce((n, c) => n + c.inputTokens + c.outputTokens, 0) / withUsage.length
    : 0;
  const timed = r.calls.filter((c) => c.durationMs > 0);
  const avgMs = timed.length ? timed.reduce((n, c) => n + c.durationMs, 0) / timed.length : 0;

  if (r.status === "stopped")
    out.push({
      level: "warn",
      title: "The run stopped before finishing",
      detail: r.stopReason ?? "It ended without success.",
    });

  if (r.totals.failedTools) {
    const failed = r.tools.filter((t) => t.failed).map((t) => `${t.name} ×${t.failed}`);
    out.push({
      level: r.totals.failedTools >= 3 ? "warn" : "tip",
      title: `${plural(r.totals.failedTools, "tool call")} failed`,
      detail:
        `${failed.join(", ")}. Each failure costs a model round trip` +
        (avgCall
          ? ` (about ${formatTokens(Math.round(avgCall))} tokens${avgMs ? ` and ${formatMs(avgMs)}` : ""} on average).`
          : "."),
    });
  }
  const patchFails = r.tools.find((t) => t.name === "patch_file")?.failed ?? 0;
  if (patchFails >= 2)
    out.push({
      level: "tip",
      title: "Edits often missed their target",
      detail: `patch_file failed ${patchFails} times. Showing the closest matching lines in the error, or having the agent re-read before patching, usually fixes this.`,
    });

  // Identical calls repeated within the turn.
  const repeats = new Map<string, { label: string; n: number }>();
  for (const t of toolList) {
    if (["todo", "wait_agents"].includes(t.name)) continue;
    const key = `${t.name}\n${JSON.stringify(t.args)}`;
    const r = repeats.get(key) ?? { label: toolLabel(t), n: 0 };
    r.n++;
    repeats.set(key, r);
  }
  const repeated = [...repeats.values()].filter((x) => x.n > 1).sort((a, b) => b.n - a.n);
  if (repeated.length)
    out.push({
      level: "tip",
      title: "Repeated the same tool call",
      detail: `${repeated
        .slice(0, 3)
        .map((x) => `${x.label} ×${x.n}`)
        .join(
          "; ",
        )}. Unchanged results only add context; the agent may be losing track of what it already saw.`,
    });

  // Reading files it had just written.
  const written = new Set<string>();
  const reread = new Map<string, number>();
  for (const t of toolList) {
    const path = argOf(t, "path");
    if (!path) continue;
    if ((t.name === "write_file" || t.name === "patch_file") && t.status === "ok") written.add(path);
    else if (t.name === "read_file" && written.has(path)) reread.set(path, (reread.get(path) ?? 0) + 1);
  }
  if ([...reread.values()].some((n) => n >= 2))
    out.push({
      level: "tip",
      title: "Re-read files it had just written",
      detail: `${[...reread]
        .filter(([, n]) => n >= 2)
        .map(([p, n]) => `${p} ×${n}`)
        .join(", ")}. Returning the changed region from the edit tool would save these reads.`,
    });

  const top = r.consumers[0];
  if (top && r.totals.inputTokens > 0 && top.carriedTokens > r.totals.inputTokens * 0.12)
    out.push({
      level: "tip",
      title: "One tool result took a large share of the input",
      detail: `${top.label} returned about ${formatTokens(top.outputTokens)} tokens and was re-sent with ${plural(top.carriedCalls, "later call")} (about ${formatTokens(top.carriedTokens)} input tokens, ${pct(top.carriedTokens, r.totals.inputTokens)}% of all input). Shorter tool output would cut this.`,
    });

  if (all > 0 && withUsage.length >= 5 && r.totals.inputTokens / all > 0.9) {
    const first = withUsage[0].inputTokens;
    const last = withUsage[withUsage.length - 1].inputTokens;
    out.push({
      level: "info",
      title: `${Math.min(99, pct(r.totals.inputTokens, all))}%${r.totals.outputTokens && pct(r.totals.inputTokens, all) >= 99 ? "+" : ""} of tokens were the model re-reading its context`,
      detail: `Context per call grew from ${formatTokens(first)} to ${formatTokens(last)} tokens over ${withUsage.length} calls. Prompt caching (where the provider supports it), fewer round trips or earlier compaction cut this most.`,
    });
  }

  const thinking = total(r.tokens.thinking);
  if (all > 0 && thinking / all > 0.1)
    out.push({
      level: "tip",
      title: `Thinking summaries used ${pct(thinking, all)}% of tokens`,
      detail: `The decision lines cost ${formatTokens(thinking)} tokens over ${plural(r.tokens.thinking.calls, "call")}. A cheaper summarizer model, or context.reasoningSummaries: false, saves them.`,
    });

  const withTools = r.calls.filter((c) => c.tools.length);
  const single = withTools.filter((c) => c.tools.length === 1).length;
  if (withTools.length >= 8 && single / withTools.length >= 0.7)
    out.push({
      level: "tip",
      title: "Mostly one tool per model call",
      detail: `${single} of ${withTools.length} calls ran a single tool. Asking the model to batch independent reads and edits would save round trips${avgMs ? ` (about ${formatMs(avgMs)} each)` : ""}.`,
    });

  // The last change should be followed by a check.
  const lastBuild = toolList.findLastIndex(
    (t) => toolCategory(t) === "build" && t.name !== "set_preview" && t.name !== "set_launch",
  );
  const lastCheck = toolList.findLastIndex((t) => toolCategory(t) === "check");
  if (lastBuild >= 0 && lastCheck < lastBuild && r.status !== "running")
    out.push({
      level: "tip",
      title: "The last changes were not checked",
      detail:
        lastCheck < 0
          ? "No preview check, test or verification ran in this turn."
          : `${toolLabel(toolList[lastBuild])} came after the last check.`,
    });

  const fixed = r.checks.findIndex((c) => !c.ok);
  if (fixed >= 0 && r.checks.slice(fixed + 1).some((c) => c.ok))
    out.push({
      level: "info",
      title: "Checks caught problems that were then fixed",
      detail: `${r.checks.filter((c) => !c.ok).length} of ${r.checks.length} checks reported problems; a later check passed.`,
    });
  else if (r.checks.length && r.checks[r.checks.length - 1] && !r.checks[r.checks.length - 1].ok)
    out.push({
      level: "warn",
      title: "The last check still reported problems",
      detail: `${r.checks[r.checks.length - 1].label}: ${r.checks[r.checks.length - 1].detail}`,
    });

  const slow = toolList
    .map((t) => ({ t, ms: (time(t.endedAt) ?? 0) - (time(t.startedAt) ?? 0) }))
    .filter((x) => x.ms > 45_000)
    .sort((a, b) => b.ms - a.ms);
  if (slow.length)
    out.push({
      level: "info",
      title: "Slow steps",
      detail: slow
        .slice(0, 3)
        .map((x) => `${toolLabel(x.t)} took ${formatMs(x.ms)}`)
        .join("; "),
    });
  const slowest = [...r.calls].sort((a, b) => b.durationMs - a.durationMs)[0];
  if (slowest && slowest.durationMs > 60_000 && r.durationMs > 0)
    out.push({
      level: "info",
      title: `Model call #${slowest.index} took ${formatMs(slowest.durationMs)}`,
      detail: `It wrote ${formatTokens(slowest.outputTokens)} output tokens${slowest.tools.length ? ` and requested ${plural(slowest.tools.length, "tool")}` : ""}. Large single writes are slow; splitting a big file into parts streams progress sooner.`,
    });
  if (r.durationMs > 0 && r.time.idle / r.durationMs > 0.25 && r.time.idle > 20_000)
    out.push({
      level: "info",
      title: `${formatMs(r.time.idle)} were outside model calls and tools`,
      detail: "Waiting for approvals or answers, context compaction and start-up overhead count here.",
    });

  const compactions = r.calls.filter((c) => c.compactedBefore).length;
  if (compactions)
    out.push({
      level: "info",
      title: `Context was compacted ${plural(compactions, "time")}`,
      detail: `Compaction cost ${formatTokens(total(r.tokens.compaction))} tokens. Details from before it may have been lost.`,
    });

  if (!out.length)
    out.push({
      level: "info",
      title: "A clean run",
      detail: "No failed calls, repeats or unusual costs were found.",
    });
  const order = { warn: 0, tip: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/** The report as Markdown (for an issue, a note, or an agent improving the harness). */
export function turnReportMarkdown(r: TurnReport, request?: string): string {
  const lines: string[] = ["# Run summary", ""];
  if (request) lines.push(`> ${request.split("\n")[0].slice(0, 200)}`, "");
  lines.push(
    `- **Result:** ${r.status === "success" ? "finished" : r.status === "running" ? "still running" : `stopped${r.stopReason ? ` (${r.stopReason})` : ""}`}`,
    `- **Time:** ${formatMs(r.durationMs)} · ${plural(r.totals.modelCalls, "model call")} · ${plural(r.totals.toolCalls, "tool call")}${r.totals.failedTools ? ` (${r.totals.failedTools} failed)` : ""}`,
    `- **Tokens:** ${formatTokens(r.totals.inputTokens)} in / ${formatTokens(r.totals.outputTokens)} out${r.totals.cost ? ` · ${formatCost(r.totals.cost)}` : ""}`,
  );
  if (r.models.length) lines.push(`- **Models:** ${r.models.join(", ")}`);
  if (r.skills.length) lines.push(`- **Skills:** ${r.skills.join(", ")}`);
  lines.push("", "## How it got there", "");
  r.stages.forEach((s, i) => {
    lines.push(
      `${i + 1}. **${s.title}** (${formatMs(s.endMs - s.startMs)}, calls ${s.calls[0]}${s.calls.length > 1 ? `–${s.calls[s.calls.length - 1]}` : ""}, ${formatTokens(s.tokens)} tokens): ${s.detail}`,
    );
    for (const d of s.decisions.slice(0, 5)) lines.push(`   - ${d}`);
  });
  if (r.files.length) {
    lines.push("", "## Files", "");
    for (const f of r.files)
      lines.push(
        `- ${f.path}: ${[f.created ? "created" : "", f.edits ? plural(f.edits, "edit") : "", f.failedEdits ? `${f.failedEdits} failed` : ""].filter(Boolean).join(", ")}`,
      );
  }
  if (r.checks.length) {
    lines.push("", "## Checks", "");
    for (const c of r.checks)
      lines.push(`- ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? `: ${c.detail}` : ""}`);
  }
  lines.push("", "## Where time went", "");
  for (const c of STEP_CATEGORIES)
    if (r.time[c.id])
      lines.push(`- ${c.label}: ${formatMs(r.time[c.id])} (${pct(r.time[c.id], r.durationMs)}%)`);
  if (r.time.idle)
    lines.push(`- Waiting & overhead: ${formatMs(r.time.idle)} (${pct(r.time.idle, r.durationMs)}%)`);
  lines.push("", "## Where tokens went", "");
  for (const [key, label] of TOKEN_ROWS) {
    const u = r.tokens[key];
    if (u.inputTokens || u.outputTokens)
      lines.push(
        `- ${label}: ${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens)} out (${plural(u.calls, "call")})`,
      );
  }
  if (r.consumers.some((c) => c.carriedTokens)) {
    lines.push("", "Largest tool results (estimated input tokens from re-sending them):", "");
    for (const c of r.consumers.filter((c) => c.carriedTokens).slice(0, 5))
      lines.push(
        `- ${c.label}: ~${formatTokens(c.outputTokens)} × ${c.carriedCalls} calls ≈ ${formatTokens(c.carriedTokens)}`,
      );
  }
  lines.push("", "## Improvements", "");
  for (const i of r.insights) lines.push(`- **${i.title}** — ${i.detail}`);
  return lines.join("\n") + "\n";
}

export const TOKEN_ROWS: ["reply" | "thinking" | "compaction" | "other" | "subagents", string][] = [
  ["reply", "Agent model calls"],
  ["thinking", "Thinking summaries"],
  ["compaction", "Context compaction"],
  ["other", "Other calls"],
  ["subagents", "Subagents"],
];
