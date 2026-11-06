/** Turn a stored JSONL event log into something people can read. */

export type LogRecord = {
  line: number;
  seq?: number;
  type: string;
  ts?: string;
  value: unknown;
  raw: string;
};

type Ev = { type?: string; seq?: number; ts?: string; [k: string]: unknown };

export function parseLog(content: string, totalRecords: number): LogRecord[] {
  const lines = content.split("\n").filter((l) => l.trim());
  const first = totalRecords - lines.length + 1;
  return lines.map((raw, i) => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    const e = value as Ev | undefined;
    return {
      line: first + i,
      seq: typeof e?.seq === "number" ? e.seq : undefined,
      type: typeof e?.type === "string" ? e.type : "(unreadable line)",
      ts: typeof e?.ts === "string" ? e.ts : undefined,
      value,
      raw,
    };
  });
}

const DELTAS = new Set(["message.delta", "reasoning.delta"]);

/** One row in the records view: a single record, or a run of streamed chunks of one message. */
export type RecordRow = { key: string; records: LogRecord[]; type: string; text?: string };

/** Merge consecutive `*.delta` records of the same message into one row whose text is the joined chunks. */
export function groupDeltas(records: LogRecord[]): RecordRow[] {
  const rows: RecordRow[] = [];
  for (const r of records) {
    const e = r.value as Ev | undefined;
    const last = rows.at(-1);
    if (DELTAS.has(r.type) && e) {
      const id = String(e.id ?? "");
      const prev = last?.records.at(-1)?.value as Ev | undefined;
      if (last && last.type === r.type && String(prev?.id ?? "") === id) {
        last.records.push(r);
        last.text += String(e.text ?? "");
        continue;
      }
      rows.push({ key: `l${r.line}`, records: [r], type: r.type, text: String(e.text ?? "") });
      continue;
    }
    rows.push({ key: `l${r.line}`, records: [r], type: r.type });
  }
  return rows;
}

export type TranscriptEntry =
  | {
      kind: "message";
      key: string;
      ts?: string;
      role: string;
      agent?: string;
      text: string;
      partial: boolean;
    }
  | { kind: "thinking"; key: string; ts?: string; text: string }
  | {
      kind: "tool";
      key: string;
      ts?: string;
      name: string;
      args: unknown;
      result?: { ok: boolean; output: string };
    }
  | { kind: "note"; key: string; ts?: string; label: string; text?: string; tone?: "error" | "ok" };

/** Rebuild the conversation: whole messages, thinking, tool calls with their results, and key moments. */
export function buildTranscript(records: LogRecord[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const messages = new Map<string, Extract<TranscriptEntry, { kind: "message" }>>();
  const thinking = new Map<string, Extract<TranscriptEntry, { kind: "thinking" }>>();
  const tools = new Map<string, Extract<TranscriptEntry, { kind: "tool" }>>();
  const message = (id: string, ts?: string, role = "assistant") => {
    let m = messages.get(id);
    if (!m) {
      // The log may start mid-message when only its tail was loaded.
      m = { kind: "message", key: `m:${id}`, ts, role, text: "", partial: true };
      messages.set(id, m);
      out.push(m);
    }
    return m;
  };
  const note = (r: LogRecord, label: string, text?: string, tone?: "error" | "ok") =>
    out.push({ kind: "note", key: `l${r.line}`, ts: r.ts, label, text, tone });
  for (const r of records) {
    const e = r.value as Ev | undefined;
    if (!e) continue;
    const id = String(e.id ?? "");
    switch (r.type) {
      case "message.start": {
        const m = message(id, r.ts, String(e.role ?? "assistant"));
        m.role = String(e.role ?? m.role);
        if (typeof e.agent === "string") m.agent = e.agent;
        break;
      }
      case "message.delta":
        message(id, r.ts).text += String(e.text ?? "");
        break;
      case "message.end": {
        const m = message(id, r.ts);
        if (typeof e.text === "string") m.text = e.text;
        m.partial = false;
        const files = (e.attachments as { path?: string }[] | undefined)?.map((a) => a.path).filter(Boolean);
        if (files?.length) m.text += `\n\n📎 ${files.join(", ")}`;
        break;
      }
      case "reasoning.delta":
      case "reasoning.summary": {
        let t = thinking.get(id);
        if (!t) {
          t = { kind: "thinking", key: `r:${id}`, ts: r.ts, text: "" };
          thinking.set(id, t);
          out.push(t);
        }
        if (r.type === "reasoning.summary") t.text = String(e.text ?? "");
        else t.text += String(e.text ?? "");
        break;
      }
      case "tool.call": {
        const t: Extract<TranscriptEntry, { kind: "tool" }> = {
          kind: "tool",
          key: `t:${id}:${r.line}`,
          ts: r.ts,
          name: String(e.name ?? "tool"),
          args: e.args,
        };
        tools.set(id, t);
        out.push(t);
        break;
      }
      case "tool.result": {
        const t = tools.get(id);
        const result = { ok: !!e.ok, output: String(e.output ?? "") };
        if (t) t.result = result;
        else
          out.push({
            kind: "tool",
            key: `t:${id}:${r.line}`,
            ts: r.ts,
            name: String(e.name ?? "tool"),
            args: undefined,
            result,
          });
        break;
      }
      case "session.created":
        note(r, "Conversation started", typeof e.title === "string" ? e.title : undefined);
        break;
      case "question":
        note(r, "Question", String(e.text ?? ""));
        break;
      case "question.answered":
        note(r, "Answer", String(e.answer ?? ""));
        break;
      case "plan.proposed":
        note(r, "Plan proposed", String(e.markdown ?? ""));
        break;
      case "plan.decision":
        note(r, `Plan ${String(e.decision ?? "")}`, typeof e.feedback === "string" ? e.feedback : undefined);
        break;
      case "permission.request":
        note(
          r,
          `Permission requested: ${String(e.tool ?? "")}`,
          typeof e.reason === "string" ? e.reason : undefined,
        );
        break;
      case "permission.resolved":
        note(r, `Permission ${String(e.decision ?? "")}${e.auto ? " (automatic)" : ""}`);
        break;
      case "preview.ready":
        note(r, "Preview published", String(e.path ?? ""), "ok");
        break;
      case "skill.activated":
        note(r, `Skill: ${String(e.name ?? e.skill ?? "")}`);
        break;
      case "memory.saved":
        note(r, "Memory saved", String(e.fact ?? ""));
        break;
      case "context.compacted":
        note(r, "Context compacted");
        break;
      case "error":
        note(r, "Error", String(e.message ?? ""), "error");
        break;
      case "log":
        if (e.level === "warn") note(r, "Warning", String(e.message ?? ""), "error");
        break;
      case "done":
        note(
          r,
          `Run finished: ${String(e.status ?? "")}`,
          typeof e.summary === "string" ? e.summary : undefined,
          e.status === "success" ? "ok" : e.status === "failed" ? "error" : undefined,
        );
        break;
    }
  }
  return out;
}

export function entryText(e: TranscriptEntry): string {
  switch (e.kind) {
    case "message":
    case "thinking":
      return e.text;
    case "tool":
      return `${e.name} ${JSON.stringify(e.args ?? "")} ${e.result?.output ?? ""}`;
    case "note":
      return `${e.label} ${e.text ?? ""}`;
  }
}

/** A one-line summary of tool arguments, e.g. `path: index.html`. */
export function argsSummary(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return String(args);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as object)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}: ${s.length > 80 ? s.slice(0, 77).replace(/\s+/g, " ") + "…" : s.replace(/\s+/g, " ")}`);
    if (parts.length === 3) break;
  }
  return parts.join(" · ");
}
