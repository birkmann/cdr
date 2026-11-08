import type { SessionInfo } from "@harness/client";
import { groupByDate } from "@web/session-groups";
import { buildTree, descendants, isActive, splitActive } from "./agents";

export interface SwitcherSection {
  label: string;
  items: SessionInfo[];
}

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
export const updatedAt = (s: SessionInfo) => s.updatedAt ?? s.createdAt;

/** True when the conversation works in `root` or in an agent worktree inside it. */
export function inFolder(s: Pick<SessionInfo, "projectPath">, root: string): boolean {
  return s.projectPath === root || s.projectPath.startsWith(root + "/");
}

/**
 * The conversation switcher's sections: conversations in the open folder first, then every other one by date.
 * Subagents are left out (they appear under their parent in the project column); a query matches title and folder.
 */
export function switcherSections(
  sessions: SessionInfo[],
  root: string | undefined,
  query: string,
): SwitcherSection[] {
  const q = query.trim().toLowerCase();
  const list = sessions
    .filter((s) => !s.parentSessionId && !s.projectMissing)
    .filter((s) => !q || `${s.title ?? ""} ${base(s.projectPath)}`.toLowerCase().includes(q))
    .sort((a, b) => updatedAt(b).localeCompare(updatedAt(a)));
  const here = root ? list.filter((s) => inFolder(s, root)) : [];
  const rest = root ? list.filter((s) => !inFolder(s, root)) : list;
  const sections: SwitcherSection[] = here.length ? [{ label: `In ${base(root!)}`, items: here }] : [];
  for (const [label, items] of groupByDate(rest)) sections.push({ label, items });
  return sections;
}

/**
 * The folder a conversation's preview page sits in, relative to its project ("" for the project's top level),
 * from the path it published (relative to the project, or absolute inside it). Undefined for a page outside it.
 */
export function conversationOutput(
  s: Pick<SessionInfo, "projectPath">,
  previewPath: string,
): string | undefined {
  const root = s.projectPath.replace(/\\/g, "/").replace(/\/$/, "");
  let path = previewPath.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) {
    if (!path.startsWith(root + "/")) return undefined;
    path = path.slice(root.length + 1);
  }
  const parts = path.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..")) return undefined;
  return parts.slice(0, -1).join("/");
}

const WORKTREE = /[\\/]\.harness[\\/]worktrees[\\/].*$/;

/** The project a folder belongs to: an agent's worktree counts as the checkout it was made from. */
export const projectRoot = (path: string) => path.replace(WORKTREE, "");

/** The value of the project filter that selects conversations without a project. */
export const SANDBOX_PROJECT = "sandbox";

/** What the project filter compares: the project's folder, or `SANDBOX_PROJECT`. */
export const projectKey = (s: Pick<SessionInfo, "projectPath" | "sandbox">) =>
  s.sandbox ? SANDBOX_PROJECT : projectRoot(s.projectPath);

/** Why a conversation does or does not need the user. */
export type Attention = "working" | "waiting" | "settled";

export interface ConversationSection {
  label: string;
  attention: Attention;
  items: SessionInfo[];
}

/** The top-level conversation a session belongs to (itself unless it is a subagent). */
export function rootConversation(s: SessionInfo, sessions: SessionInfo[]): SessionInfo {
  const byId = new Map(sessions.map((x) => [x.id, x]));
  const seen = new Set<string>();
  let cur = s;
  while (cur.parentSessionId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.parentSessionId);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

/** The attention of each top-level conversation with something running; a waiting subagent makes its parent wait. */
export function attentionByConversation(sessions: SessionInfo[]): Map<string, Attention> {
  const out = new Map<string, Attention>();
  for (const s of sessions) {
    if (!isActive(s)) continue;
    const root = rootConversation(s, sessions).id;
    if (s.status === "waiting") out.set(root, "waiting");
    else if (!out.has(root)) out.set(root, "working");
  }
  return out;
}

/**
 * The conversation list: what is running, what is blocked on the user, then everything else by date.
 * Running rows keep their place (they are ordered by start, not by their latest event).
 */
export function conversationSections(
  sessions: SessionInfo[],
  filter: { query?: string; project?: string | null } = {},
): ConversationSection[] {
  const q = filter.query?.trim().toLowerCase() ?? "";
  const attention = attentionByConversation(sessions);
  const list = sessions
    .filter((s) => !s.parentSessionId && !s.projectMissing)
    .filter((s) => !filter.project || projectKey(s) === filter.project)
    .filter((s) => !q || `${s.title ?? ""} ${base(projectRoot(s.projectPath))}`.toLowerCase().includes(q));
  const started = (s: SessionInfo) => s.runStartedAt ?? s.createdAt;
  const live = (a: Attention) =>
    list.filter((s) => attention.get(s.id) === a).sort((x, y) => started(x).localeCompare(started(y)));
  const sections: ConversationSection[] = [];
  const working = live("working");
  const waiting = live("waiting");
  if (working.length) sections.push({ label: "Working", attention: "working", items: working });
  if (waiting.length) sections.push({ label: "Waiting", attention: "waiting", items: waiting });
  const settled = list
    .filter((s) => !attention.has(s.id))
    .sort((a, b) => updatedAt(b).localeCompare(updatedAt(a)));
  for (const [label, items] of groupByDate(settled)) sections.push({ label, attention: "settled", items });
  return sections;
}

/** Conversations whose folder no longer exists: they can only be deleted. */
export function orphanConversations(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.filter((s) => s.projectMissing && !s.parentSessionId && !isActive(s));
}

export interface ProjectChoice {
  path: string;
  name: string;
}

/** The projects conversations work in, most recently active first (sandboxes are one separate filter). */
export function projectChoices(sessions: SessionInfo[]): ProjectChoice[] {
  const seen = new Set<string>();
  const out: ProjectChoice[] = [];
  const list = sessions
    .filter((s) => !s.parentSessionId && !s.projectMissing && !s.sandbox)
    .sort((a, b) => updatedAt(b).localeCompare(updatedAt(a)));
  for (const s of list) {
    const path = projectRoot(s.projectPath);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, name: base(path) });
  }
  return out;
}

export interface FocusProject {
  /** The conversation shown, which may be a subagent. */
  session?: SessionInfo;
  /** Its top-level conversation. */
  conversation?: SessionInfo;
  /** The project in focus; null when there is none (a new sandbox, or nothing open). */
  path: string | null;
  sandbox: boolean;
}

/**
 * The project the chat view is about: that of the conversation shown, else the folder the next
 * conversation will work in (`draftFolder`: null for a new sandbox, undefined when none was reported).
 */
export function focusProject(
  sessions: SessionInfo[],
  sessionId: string | null,
  draftFolder: string | null | undefined,
  workspaceRoot: string | undefined,
): FocusProject {
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  if (session) {
    const conversation = rootConversation(session, sessions);
    return {
      session,
      conversation,
      path: conversation.projectMissing ? null : projectRoot(conversation.projectPath),
      sandbox: !!conversation.sandbox,
    };
  }
  return { path: draftFolder === undefined ? (workspaceRoot ?? null) : draftFolder, sandbox: false };
}

export interface AgentRow {
  session: SessionInfo;
  depth: number;
}

/**
 * The project rail's agents: everything running in the project, and the helpers of the selected
 * conversation even after they finished. A selected conversation with no helpers is not listed.
 */
export function projectAgents(sessions: SessionInfo[], project: string, selected?: SessionInfo): AgentRow[] {
  const here = sessions.filter((s) => inFolder(s, project));
  const { active } = splitActive(here);
  const list = [...active];
  if (selected) {
    const tree = descendants(selected.id, here);
    if (tree.length > 1)
      for (const id of tree) if (!list.some((s) => s.id === id)) list.push(here.find((s) => s.id === id)!);
  }
  const { roots, children } = buildTree(list);
  const out: AgentRow[] = [];
  const add = (session: SessionInfo, depth: number) => {
    out.push({ session, depth });
    for (const kid of children.get(session.id) ?? []) add(kid, depth + 1);
  };
  for (const r of roots) add(r, 0);
  return out;
}

/** A project's chip: up to two initials and a colour that stays the same for that name. */
export function projectBadge(name: string): { initials: string; hue: number } {
  const words = name.split(/[^a-z0-9]+/i).filter(Boolean);
  const initials = (
    words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? name).slice(0, 2)
  ).toUpperCase();
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return { initials, hue: Math.abs(hash) % 360 };
}

/** Branches that say nothing worth showing on a conversation row. */
export const isDefaultBranch = (branch: string) => /^(main|master|trunk|develop)$/.test(branch);
