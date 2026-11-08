import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from "node:fs";
import { join } from "node:path";
import type { ChatMessage, HarnessEvent, SessionInfo, SessionStatus } from "@harness/protocol";
import { harnessHome } from "./config.js";
import { projectLockOwner } from "./lock.js";

/** Append-only JSONL event log, one file per session. */
export class SessionStore {
  readonly dir: string;
  constructor(dir?: string) {
    this.dir = dir ?? join(harnessHome(), "sessions");
    mkdirSync(this.dir, { recursive: true });
  }

  path(id: string): string {
    if (!/^[\w.-]+$/.test(id)) throw new Error(`Invalid session id "${id}"`);
    return join(this.dir, `${id}.jsonl`);
  }

  exists(id: string): boolean {
    return existsSync(this.path(id));
  }

  append(event: HarnessEvent): void {
    appendFileSync(this.path(event.sessionId), JSON.stringify(event) + "\n");
  }

  read(id: string): HarnessEvent[] {
    const p = this.path(id);
    if (!existsSync(p)) throw new Error(`Session "${id}" not found`);
    const out: HarnessEvent[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* tolerate a torn last line */
      }
    }
    return out;
  }

  /** Tail complete JSONL records only; keep a partial UTF-8 record for the next read. */
  readAfter(id: string, offset: number, afterSeq: number): { events: HarnessEvent[]; offset: number } {
    const fd = openSync(this.path(id), "r");
    try {
      const size = fstatSync(fd).size;
      if (size < offset) offset = 0;
      if (size === offset) return { events: [], offset };
      const buffer = Buffer.alloc(size - offset);
      let length = 0;
      while (length < buffer.length) {
        const n = readSync(fd, buffer, length, buffer.length - length, offset + length);
        if (!n) break;
        length += n;
      }
      const end = buffer.subarray(0, length).lastIndexOf(10) + 1;
      const events: HarnessEvent[] = [];
      for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as HarnessEvent;
          if (event.sessionId === id && event.seq > afterSeq) events.push(event);
        } catch {
          /* Match read(): tolerate damaged records without losing later ones. */
        }
      }
      return { events, offset: offset + end };
    } finally {
      closeSync(fd);
    }
  }

  private readonly infoCache = new Map<string, { mtime: number; size: number; info: SessionInfo }>();

  info(id: string): SessionInfo {
    const st = statSync(this.path(id));
    const c = this.infoCache.get(id);
    const info =
      c && c.mtime === st.mtimeMs && c.size === st.size ? c.info : summarize(id, this.read(id), true);
    this.infoCache.set(id, { mtime: st.mtimeMs, size: st.size, info });
    const runner = projectLockOwner(info.projectPath, id);
    const active = ["running", "waiting"].includes(info.status);
    if (runner) return { ...info, externalRun: true, runner };
    // Not owned by a live process: a run the log still shows as active was interrupted.
    const { runStartedAt: _started, ...rest } = info;
    return {
      ...rest,
      externalRun: false,
      status: active ? "idle" : info.status,
      ...(active ? { interrupted: true } : {}),
    };
  }

  list(): SessionInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .map(({ f }) => {
        try {
          return this.info(f.slice(0, -6));
        } catch {
          return null;
        }
      })
      .filter((x): x is SessionInfo => x !== null);
  }

  delete(id: string): void {
    rmSync(this.path(id), { force: true });
  }

  /** Copy a session's events (optionally up to a seq) into a new session id. */
  fork(id: string, newId: string, uptoSeq?: number): void {
    const events = this.read(id).filter((e) => uptoSeq === undefined || e.seq <= uptoSeq);
    writeFileSync(
      this.path(newId),
      events.map((e) => JSON.stringify({ ...e, sessionId: newId })).join("\n") + "\n",
    );
  }
}

export function summarize(id: string, events: HarnessEvent[], preserveRunning = false): SessionInfo {
  let status: SessionStatus = "idle";
  let projectPath = "";
  let workflow = "default";
  let title: string | undefined;
  let model: string | undefined;
  let permissionMode: SessionInfo["permissionMode"];
  let reasoningEffort: SessionInfo["reasoningEffort"];
  let sandbox = false;
  let parentSessionId: string | undefined;
  let goalId: string | undefined;
  let forkedFrom: SessionInfo["forkedFrom"];
  let origin: SessionInfo["origin"];
  let runStartedAt: string | undefined;
  const usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
  const userMsgs = new Set<string>();
  const userTexts: { id: string; text: string }[] = [];
  const deleted = new Set<string>();
  for (const e of events) {
    switch (e.type) {
      case "session.created":
        projectPath = e.projectPath;
        workflow = e.workflow;
        title = e.title;
        model = e.models?.executor ?? model;
        permissionMode = e.permissionMode ?? permissionMode;
        reasoningEffort = e.reasoningEffort ?? reasoningEffort;
        sandbox = !!e.sandbox;
        parentSessionId = e.parentSessionId;
        goalId = e.goalId;
        origin = e.origin;
        break;
      case "session.settings":
        if (e.title) title = e.title;
        model = e.models?.executor ?? model;
        permissionMode = e.permissionMode ?? permissionMode;
        reasoningEffort = e.reasoningEffort ?? reasoningEffort;
        break;
      case "status":
        if (e.status === "running" && status !== "running" && status !== "waiting") runStartedAt = e.ts;
        status = e.status;
        break;
      case "usage":
        usage.inputTokens += e.inputTokens;
        usage.outputTokens += e.outputTokens;
        usage.cost += e.cost ?? 0;
        break;
      case "message.start":
        if (e.role === "user") userMsgs.add(e.id);
        break;
      case "message.end":
        if (userMsgs.has(e.id)) userTexts.push({ id: e.id, text: e.text });
        break;
      case "messages.deleted":
        for (const id of e.ids) deleted.add(id);
        break;
      case "session.forked":
        forkedFrom = {
          sessionId: e.fromSessionId,
          seq: e.fromSeq,
          ...(e.messageId ? { messageId: e.messageId } : {}),
        };
        break;
    }
  }
  // A session whose process died mid-run is not running any more.
  const active = status === "running" || status === "waiting";
  const interrupted = !preserveRunning && active;
  if (interrupted) status = "idle";
  const firstUser = userTexts.find((m) => !deleted.has(m.id))?.text;
  const derived = firstUser?.replace(/\s+/g, " ").trim();
  return {
    id,
    projectPath,
    workflow,
    title: title ?? (derived ? (derived.length > 80 ? derived.slice(0, 77) + "…" : derived) : undefined),
    status,
    createdAt: events[0]?.ts ?? "",
    updatedAt: events[events.length - 1]?.ts ?? "",
    lastSeq: events[events.length - 1]?.seq ?? 0,
    model,
    permissionMode,
    reasoningEffort,
    ...(sandbox ? { sandbox } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(goalId ? { goalId } : {}),
    ...(forkedFrom ? { forkedFrom } : {}),
    ...(origin ? { origin } : {}),
    ...(usage.inputTokens || usage.outputTokens || usage.cost
      ? {
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.cost ? { cost: usage.cost } : {}),
          },
        }
      : {}),
    ...(active && !interrupted && runStartedAt ? { runStartedAt } : {}),
    ...(interrupted ? { interrupted: true } : {}),
  };
}

const INTERRUPTED_RESULT =
  "[harness] This tool call was interrupted and returned no result. It may have partly run: check the current state before relying on it or retrying.";

/** Rebuild an agent's conversation from context events. */
export function rebuildMessages(events: HarnessEvent[], agent: string): ChatMessage[] {
  let messages: ChatMessage[] = [];
  for (const e of events) {
    if (e.type === "context.append" && e.agent === agent) messages.push(e.message);
    else if (e.type === "context.replace" && e.agent === agent) messages = [...e.messages];
  }
  return repairToolTurns(messages);
}

/**
 * Give every tool call a result right after its assistant turn, as providers require. A run stopped mid-call
 * leaves that turn unanswered in the log for good, so later turns can't hide it: each rebuild checks them all.
 */
function repairToolTurns(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") continue; // its call is gone; answered results are taken with their turn below
    out.push(m);
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const results = new Map<string, ChatMessage>();
    for (let next = messages[i + 1]; next?.role === "tool"; next = messages[++i + 1])
      results.set(next.toolCallId, next);
    for (const call of m.toolCalls)
      out.push(
        results.get(call.id) ?? {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: INTERRUPTED_RESULT,
        },
      );
  }
  return out;
}
