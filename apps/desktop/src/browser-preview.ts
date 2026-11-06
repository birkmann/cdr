import type { SessionInfo } from "@harness/client";
import { updatedAt } from "./sessions";

/** HTML files can be opened in the browser as a live preview. */
export const isHtmlPath = (path: string) => /\.html?$/i.test(path);

/**
 * The conversation whose preview server can show a workspace file, and the file's path inside that
 * conversation's folder. Prefers the current conversation, then the most recently active one; a conversation
 * in a subfolder (an agent worktree) only serves files inside it.
 */
export function previewTarget(
  sessions: SessionInfo[],
  root: string,
  path: string,
  current?: string | null,
): { sessionId: string; path: string } | undefined {
  const abs = `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const serving = sessions
    .filter(
      (s) =>
        !s.projectMissing && !s.parentSessionId && abs.startsWith(s.projectPath.replace(/\/+$/, "") + "/"),
    )
    .sort(
      (a, b) =>
        Number(b.id === current) - Number(a.id === current) || updatedAt(b).localeCompare(updatedAt(a)),
    );
  const s = serving[0];
  return s && { sessionId: s.id, path: abs.slice(s.projectPath.replace(/\/+$/, "").length + 1) };
}
