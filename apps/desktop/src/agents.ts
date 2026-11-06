import type { SessionInfo, SessionUsage } from "@harness/client";

/** Running, or paused on the user. Everything else is history. */
export const isActive = (s: SessionInfo): boolean => s.status === "running" || s.status === "waiting";

/** Who started a conversation, as a short label. */
export function originLabel(s: SessionInfo): string | undefined {
  if (s.parentSessionId) return "subagent";
  if (s.goalId) return "goal";
  if (s.forkedFrom) return s.forkedFrom.messageId ? "branch" : "copy";
  switch (s.origin) {
    case "desktop":
      return "app";
    case "web":
      return "web";
    case "cli":
      return "terminal";
    case "api":
      return "API";
  }
  return undefined;
}

/** A longer explanation of the origin, for tooltips. */
export function originTitle(s: SessionInfo, parentTitle?: string): string {
  if (s.parentSessionId)
    return `Started by the agent of “${parentTitle ?? "another conversation"}” with spawn_agent`;
  if (s.goalId) return "Runs a goal (Goals view)";
  if (s.forkedFrom)
    return s.forkedFrom.messageId
      ? "Branched from another conversation"
      : "Duplicate of another conversation";
  switch (s.origin) {
    case "desktop":
      return "Started in CDR Studio";
    case "web":
      return "Started in the web app";
    case "cli":
      return "Started with cdr in a terminal";
    case "api":
      return "Started through the harness API";
  }
  return "Started by you";
}

/** "1.2k tok · $0.04" */
export function formatUsage(u?: SessionUsage): string {
  if (!u) return "";
  const tok = u.inputTokens + u.outputTokens;
  const t =
    tok >= 1_000_000
      ? `${(tok / 1_000_000).toFixed(1)}M`
      : tok >= 1000
        ? `${(tok / 1000).toFixed(1)}k`
        : `${tok}`;
  return `${t} tok${u.cost ? ` · $${u.cost < 0.01 ? u.cost.toFixed(3) : u.cost.toFixed(2)}` : ""}`;
}

/** "45s", "3m 12s", "1h 04m" since `iso`. */
export function elapsed(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** "now", "5m", "3h", "2d" since `iso`. */
export function ago(iso?: string, now = Date.now()): string {
  if (!iso) return "";
  const d = (now - new Date(iso).getTime()) / 1000;
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

export interface AgentTree {
  roots: SessionInfo[];
  children: Map<string, SessionInfo[]>;
}

/** Group sessions under their parents; a session whose parent is not in the list is a root. */
export function buildTree(list: SessionInfo[]): AgentTree {
  const ids = new Set(list.map((s) => s.id));
  const children = new Map<string, SessionInfo[]>();
  const roots: SessionInfo[] = [];
  for (const s of list) {
    if (s.parentSessionId && ids.has(s.parentSessionId))
      children.set(s.parentSessionId, [...(children.get(s.parentSessionId) ?? []), s]);
    else roots.push(s);
  }
  return { roots, children };
}

/**
 * Split sessions into the active part (every running or waiting agent wherever it works, plus the
 * finished subagents of an active parent) and the rest. The active part is not limited to the open
 * folder, so the Agents view always lists what the status bar counts.
 */
export function splitActive(sessions: SessionInfo[]): { active: SessionInfo[]; rest: SessionInfo[] } {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const underActive = (s: SessionInfo): boolean => {
    const seen = new Set<string>();
    for (let cur: SessionInfo | undefined = s; cur && !seen.has(cur.id);) {
      if (isActive(cur)) return true;
      seen.add(cur.id);
      cur = cur.parentSessionId ? byId.get(cur.parentSessionId) : undefined;
    }
    return false;
  };
  const active: SessionInfo[] = [];
  const rest: SessionInfo[] = [];
  for (const s of sessions) (underActive(s) ? active : rest).push(s);
  active.sort((a, b) => (a.runStartedAt ?? a.createdAt).localeCompare(b.runStartedAt ?? b.createdAt));
  return { active, rest };
}

/** Ids of a session and all its descendants in `sessions`. */
export function descendants(id: string, sessions: SessionInfo[]): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++)
    for (const s of sessions) if (s.parentSessionId === out[i] && !out.includes(s.id)) out.push(s.id);
  return out;
}

/** Whether removing `s`'s sandbox folder is possible: it is a sandbox no conversation outside its tree uses. */
export function sandboxFolderRemovable(s: SessionInfo, sessions: SessionInfo[]): boolean {
  if (!s.sandbox || !s.projectPath) return false;
  const tree = new Set(descendants(s.id, sessions));
  return !sessions.some(
    (o) =>
      !tree.has(o.id) && (o.projectPath === s.projectPath || o.projectPath.startsWith(s.projectPath + "/")),
  );
}
