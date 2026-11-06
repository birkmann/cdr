import type { ChatMessage, EventBody, HarnessEvent } from "@harness/protocol";

/** Inclusive seq range of a session log. */
export type SeqRange = [number, number];

const inRange = (seq: number, [a, b]: SeqRange) => seq >= a && seq <= b;

/** Ranges of the log removed by earlier deletions. */
export function deletedRanges(events: HarnessEvent[]): SeqRange[] {
  return events.flatMap((e) => (e.type === "messages.deleted" ? e.ranges : []));
}

/** Ids of messages removed by earlier deletions. */
export function deletedMessageIds(events: HarnessEvent[]): Set<string> {
  return new Set(events.flatMap((e) => (e.type === "messages.deleted" ? e.ids : [])));
}

/**
 * The part of the log that belongs to a message: a user message owns its whole exchange (until the next
 * user message), an assistant reply owns itself, its tool calls and their results (until the next message).
 */
export function messageExtent(
  events: HarnessEvent[],
  messageId: string,
): { role: "user" | "assistant"; range: SeqRange } {
  if (deletedMessageIds(events).has(messageId)) throw new Error("This message was already deleted");
  const i = events.findIndex((e) => e.type === "message.start" && e.id === messageId);
  const start = events[i];
  if (start?.type !== "message.start") throw new Error(`No message ${messageId} in this conversation`);
  let end = events.length - 1;
  for (let j = i + 1; j < events.length; j++) {
    const e = events[j];
    if (e.type === "message.start" && (start.role === "assistant" || e.role === "user")) {
      end = j - 1;
      break;
    }
  }
  return { role: start.role, range: [start.seq, events[end].seq] };
}

interface Tagged {
  message: ChatMessage;
  /** Seq of the context.append that added it (undefined: rewritten by compaction, origin unknown). */
  seq?: number;
}

/** An agent's current context, each message tagged with the event that first recorded it. */
function taggedContext(events: HarnessEvent[], agent: string): Tagged[] {
  let list: Tagged[] = [];
  for (const e of events) {
    if (e.type === "context.append" && e.agent === agent) list.push({ message: e.message, seq: e.seq });
    else if (e.type === "context.replace" && e.agent === agent) {
      const exact = new Map<string, Tagged[]>();
      const byCall = new Map<string, number>();
      for (const t of list) {
        const key = JSON.stringify(t.message);
        exact.set(key, [...(exact.get(key) ?? []), t]);
        if (t.seq === undefined) continue;
        if (t.message.role === "tool") byCall.set(t.message.toolCallId, t.seq);
        if (t.message.role === "assistant")
          for (const c of t.message.toolCalls ?? []) byCall.set(c.id, t.seq);
      }
      list = e.messages.map((message) => {
        const same = exact.get(JSON.stringify(message))?.shift();
        if (same) return { message, seq: same.seq };
        // Compaction trims tool output; the call id still ties it to its turn.
        const call =
          message.role === "tool"
            ? message.toolCallId
            : message.role === "assistant"
              ? message.toolCalls?.[0]?.id
              : undefined;
        return { message, seq: call ? byCall.get(call) : undefined };
      });
    }
  }
  return list;
}

/** Drop tool results whose call is gone, so the context stays valid for every provider. */
function dropOrphanResults(messages: ChatMessage[]): ChatMessage[] {
  const calls = new Set(
    messages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [])),
  );
  return messages.filter((m) => m.role !== "tool" || calls.has(m.toolCallId));
}

export interface DeletionPlan {
  deleted: Extract<EventBody, { type: "messages.deleted" }>;
  /** New context per agent whose context changed. */
  contexts: Record<string, ChatMessage[]>;
  /** The deletion removes the latest run's `done` (its failure no longer applies). */
  removesLastDone: boolean;
}

/** What deleting `messageId` removes from the transcript and from each agent's context. */
export function planDeletion(events: HarnessEvent[], messageId: string): DeletionPlan {
  const { role, range } = messageExtent(events, messageId);
  const inside = events.filter((e) => inRange(e.seq, range));
  const ids = inside.flatMap((e) => (e.type === "message.start" ? [e.id] : []));
  const toolCallIds = inside.flatMap((e) => (e.type === "tool.call" ? [e.id] : []));
  const agents = new Set(
    events.flatMap((e) => (e.type === "context.append" || e.type === "context.replace" ? [e.agent] : [])),
  );
  const contexts: Record<string, ChatMessage[]> = {};
  for (const agent of agents) {
    const list = taggedContext(events, agent);
    // The system prompt always stays. An assistant reply only takes its own turn with it: a later agent's
    // opening prompt recorded during that reply (plan → execute) belongs to the exchange, not to the reply.
    const kept = list.filter(
      (t) =>
        t.seq === undefined ||
        !inRange(t.seq, range) ||
        t.message.role === "system" ||
        (role === "assistant" && t.message.role === "user"),
    );
    if (kept.length !== list.length) contexts[agent] = dropOrphanResults(kept.map((t) => t.message));
  }
  const lastDone = [...events].reverse().find((e) => e.type === "done");
  return {
    deleted: { type: "messages.deleted", ids, toolCallIds, ranges: [range] },
    contexts,
    removesLastDone: !!lastDone && inRange(lastDone.seq, range),
  };
}

/** Last seq a branch cut at `messageId` keeps (the message and what it owns, see messageExtent). */
export function branchCut(events: HarnessEvent[], messageId: string): number {
  return messageExtent(events, messageId).range[1];
}

/** Event types a merge brings from a branch into its origin. Status, usage, checkpoints and requests stay. */
const MERGED = new Set<EventBody["type"]>([
  "message.start",
  "message.delta",
  "message.end",
  "reasoning.delta",
  "reasoning.summary",
  "tool.call",
  "tool.result",
  "context.append",
  "plan.proposed",
  "plan.decision",
  "todo.update",
  "verify.result",
  "review.findings",
  "skill.activated",
  "memory.saved",
  "memory.removed",
  "preview.ready",
  "launch.ready",
  "phase.start",
  "agent.spawned",
  "agent.status",
  "agent.finished",
  "done",
]);

/**
 * The events a branch added after `afterSeq`, ready to emit into the session it came from: messages its
 * user deleted are left out, system prompts are skipped (the origin has its own), and the first user
 * message the model sees says where the exchange came from.
 */
export function branchEventsToMerge(
  branch: HarnessEvent[],
  afterSeq: number,
  label: string,
): { bodies: EventBody[]; messages: number; toSeq: number } {
  const removed = deletedRanges(branch);
  const bodies: EventBody[] = [];
  let messages = 0;
  let noted = false;
  for (const e of branch) {
    if (e.seq <= afterSeq || !MERGED.has(e.type) || removed.some((r) => inRange(e.seq, r))) continue;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { v, seq, ts, sessionId, ...rest } = e;
    let body = rest as EventBody;
    if (e.type === "context.append") {
      if (e.message.role === "system") continue;
      if (e.message.role === "user" && !noted) {
        noted = true;
        body = {
          type: "context.append",
          agent: e.agent,
          message: {
            ...e.message,
            content: `[This exchange happened in a branch of this conversation (${label}) and was merged back.]\n\n${e.message.content}`,
          },
        };
      }
    }
    // Count what the transcript shows: tool-calling turns without text are steps, not messages.
    if (e.type === "message.end" && e.text.trim()) messages++;
    bodies.push(body);
  }
  return { bodies, messages, toSeq: branch[branch.length - 1]?.seq ?? afterSeq };
}
