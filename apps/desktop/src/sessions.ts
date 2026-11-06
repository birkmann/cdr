import type { SessionInfo } from "@harness/client";
import { groupByDate } from "@web/session-groups";

export interface SwitcherSection {
  label: string;
  items: SessionInfo[];
}

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
export const updatedAt = (s: SessionInfo) => s.updatedAt ?? s.createdAt;

/** True when the conversation works in `root` or in an agent worktree inside it. */
export function inFolder(s: SessionInfo, root: string): boolean {
  return s.projectPath === root || s.projectPath.startsWith(root + "/");
}

/**
 * The conversation switcher's sections: conversations in the open folder first, then every other one by date.
 * Subagents are left out (they appear under their parent in the Agents view); a query matches title and folder.
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
