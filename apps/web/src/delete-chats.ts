import type { HarnessClient, SessionInfo } from "@harness/client";
import { isAutomated } from "./app-state";

export interface DeleteAllPlan {
  /** Top-level chats to delete; each takes its subagents with it. */
  chats: SessionInfo[];
  /** Top-level chats left alone because they or one of their subagents is running. */
  running: number;
}

export interface DeleteAllResult {
  /** Every session removed, subagents included. */
  deleted: string[];
  /** Worktrees and branches that were kept, with the reason. */
  kept: string[];
  /** Chats that could not be deleted, with the reason. */
  failed: string[];
}

const isBusy = (s: SessionInfo) => s.status === "running" || s.status === "waiting" || !!s.externalRun;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Which chats "delete all" removes. The server refuses running sessions, so they are never offered. */
export function planDeleteAll(sessions: SessionInfo[]): DeleteAllPlan {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rootOf = (s: SessionInfo) => {
    const seen = new Set([s.id]);
    let cur = s;
    for (;;) {
      const parent = cur.parentSessionId ? byId.get(cur.parentSessionId) : undefined;
      if (!parent || seen.has(parent.id)) return cur.id;
      seen.add(parent.id);
      cur = parent;
    }
  };
  const busyRoots = new Set(sessions.filter(isBusy).map(rootOf));
  const chats = sessions.filter((s) => rootOf(s) === s.id && !busyRoots.has(s.id));
  return { chats, running: busyRoots.size };
}

/** The confirmation text. It counts automated runs because the lists can hide them. */
export function deleteAllPrompt({ chats, running }: DeleteAllPlan): { title: string; message: string } {
  const automated = chats.filter(isAutomated).length;
  const message = [
    "Their history is removed for good, with their subagents and finished subagent worktrees. Project files and sandbox folders are not touched.",
    automated > 0 && `This includes ${plural(automated, "automated run")}.`,
    running > 0 && `${plural(running, "running chat")} will be kept.`,
  ]
    .filter(Boolean)
    .join(" ");
  return { title: `Delete ${plural(chats.length, "chat")}?`, message };
}

/** Delete one at a time: each removal runs git in the chat's repository. One failure doesn't stop the rest. */
export async function deleteAllChats(
  client: Pick<HarnessClient, "deleteSession">,
  chats: SessionInfo[],
): Promise<DeleteAllResult> {
  const out: DeleteAllResult = { deleted: [], kept: [], failed: [] };
  for (const s of chats) {
    try {
      const r = await client.deleteSession(s.id);
      // An older harness answers `{ ok }` only.
      out.deleted.push(...(r.sessions ?? [s.id]));
      out.kept.push(...(r.kept ?? []));
    } catch (e) {
      out.failed.push(`${s.title ?? s.id}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** What to tell the user afterwards; undefined when everything went as asked. */
export function deleteAllNote({ kept, failed }: DeleteAllResult): string | undefined {
  const parts = [
    failed.length > 0 && `Could not delete ${plural(failed.length, "chat")}: ${failed.join("; ")}.`,
    kept.length > 0 && `Kept: ${kept.join("; ")}.`,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}
