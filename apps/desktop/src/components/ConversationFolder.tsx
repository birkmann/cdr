import { useEffect, useMemo, useRef } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useApp } from "@web/app-state";
import { useSession } from "@harness/react";
import type { SessionInfo } from "@harness/client";
import { openSessionFolder } from "../file-actions";
import { conversationOutput, focusProject, type FocusProject } from "../sessions";
import { basename, useStudio } from "../store";
import { IFolder } from "./icons";

/** The conversation shown in the agent panel, with the folder it publishes its preview from. */
export function useActiveConversation(): {
  session?: SessionInfo;
  /** Folder of its latest preview, relative to its project ("" for the project's own top level). */
  outputDir?: string;
  previewPath?: string;
} {
  const st = useStudio();
  const { client, sessions } = useApp();
  const session = st.sessionId ? sessions.find((s) => s.id === st.sessionId) : undefined;
  const live = useSession(client, session && !session.projectMissing ? session.id : null);
  const previewPath = live.preview?.path;
  return {
    session,
    previewPath,
    outputDir: session && previewPath ? conversationOutput(session, previewPath) : undefined,
  };
}

/** The project the chat view is about (see `focusProject`). */
export function useFocusProject(): FocusProject {
  const st = useStudio();
  const { sessions } = useApp();
  const root = st.workspace?.root;
  return useMemo(
    () => focusProject(sessions, st.sessionId, st.draftFolder, root),
    [sessions, st.sessionId, st.draftFolder, root],
  );
}

/**
 * With no folder open, the explorer shows the selected conversation's folder (a sandbox, or the project it works
 * in) instead of an empty "No folder" screen. A folder the user opened is never replaced.
 */
export function useFollowConversationFolder() {
  const st = useStudio();
  const { sessions } = useApp();
  const session = st.sessionId ? sessions.find((s) => s.id === st.sessionId) : undefined;
  const opened = useRef<string>();
  const path = session && !session.projectMissing ? session.projectPath : undefined;
  useEffect(() => {
    if (!session || !path || st.workspace || opened.current === session.id) return;
    opened.current = session.id;
    void st.attempt(() => st.openWorkspace(path, { keepSession: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, path, !!st.workspace]);
}

/** Workspace-relative path of a folder in the conversation's project, when that project is inside `root`. */
function inWorkspace(session: SessionInfo, root: string | undefined, dir: string): string | undefined {
  if (!root) return undefined;
  if (session.projectPath === root) return dir;
  if (!session.projectPath.startsWith(root + "/")) return undefined;
  return [session.projectPath.slice(root.length + 1), dir].filter(Boolean).join("/");
}

/**
 * The top of the explorer while a conversation is selected: where its files are and its preview, one click away.
 * Expands the folder its preview was published from (such as `.harness/chess-game`) once per conversation.
 */
export function ConversationStrip() {
  const st = useStudio();
  const { session, outputDir } = useActiveConversation();
  const root = st.workspace?.root;
  const revealed = useRef<string>();
  const output = session && outputDir ? inWorkspace(session, root, outputDir) : undefined;
  useEffect(() => {
    if (!session || !output) return;
    const key = `${session.id}:${root}:${output}`;
    if (revealed.current === key) return;
    revealed.current = key;
    st.revealInExplorer(output);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, root, output]);
  if (!session || session.projectMissing) return null;
  const path = session.projectPath;
  const here = !!root && inWorkspace(session, root, "") !== undefined;
  const label = outputDir ? `${basename(path)}/${outputDir}` : basename(path);
  return (
    <section className="st-convo-files" aria-label="Selected conversation">
      <div className="st-menu-label">Conversation</div>
      <div className="st-convo-files-title st-ellipsis" title={session.title ?? "Untitled"}>
        {session.title ?? "Untitled"}
      </div>
      <button
        className="st-convo-files-name"
        title={here ? `Show ${label} in the explorer` : `${path}${outputDir ? `/${outputDir}` : ""}`}
        onClick={() =>
          here
            ? output !== undefined && st.revealInExplorer(output)
            : void openSessionFolder(st, path, outputDir || undefined)
        }
      >
        <IFolder size={14} />
        {session.sandbox && <span className="st-sw-badge">sandbox</span>}
        <span className="st-ellipsis">{label}</span>
      </button>
      <div className="st-convo-files-actions">
        <button onClick={() => st.openTab({ kind: "preview", sessionId: session.id })}>Open preview</button>
        {!here && (
          <button
            className="secondary"
            onClick={() => void openSessionFolder(st, path, outputDir || undefined)}
          >
            Show its files
          </button>
        )}
        <button
          className="ghost"
          onClick={() => void st.attempt(() => revealItemInDir(outputDir ? `${path}/${outputDir}` : path))}
        >
          Show in file manager
        </button>
      </div>
      {!here && root && (
        <p className="muted small">
          It works in another folder than the one open ({basename(root)}). Show its files to switch.
        </p>
      )}
    </section>
  );
}
