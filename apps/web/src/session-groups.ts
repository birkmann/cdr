import type { SessionInfo } from "@harness/client";

/** Group conversations by when they were last updated (Today, Yesterday, Previous 7 days, Older). */
export function groupByDate(sessions: SessionInfo[]): [string, SessionInfo[]][] {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: Record<string, SessionInfo[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 days": [],
    Older: [],
  };
  for (const s of sessions) {
    const t = new Date(s.updatedAt || s.createdAt).getTime();
    const key =
      t >= startOfDay
        ? "Today"
        : t >= startOfDay - 86_400_000
          ? "Yesterday"
          : t >= startOfDay - 7 * 86_400_000
            ? "Previous 7 days"
            : "Older";
    groups[key].push(s);
  }
  return Object.entries(groups).filter(([, v]) => v.length);
}
