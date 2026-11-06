import { basename, dirname } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { confirmDialog } from "./components/dialogs";
import type { useStudio } from "./store";

type FileStore = Pick<
  ReturnType<typeof useStudio>,
  "workspace" | "buffers" | "openWorkspace" | "openTab" | "attempt"
>;

/** Return a workspace-relative path only when the selected file is inside that folder. */
function relativeFile(root: string, file: string): string | undefined {
  const prefix = root.replace(/\\/g, "/").replace(/\/$/, "") + "/";
  const path = file.replace(/\\/g, "/");
  const windows = /^[a-z]:/i.test(prefix) || prefix.startsWith("//");
  const inside = windows ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix);
  return inside ? path.slice(prefix.length) : undefined;
}

function requireSavedFiles(st: FileStore) {
  if ([...st.buffers.values()].some((b) => b.content !== b.saved))
    throw new Error("Save or close your modified files before switching folders.");
}

export async function openFile(st: FileStore) {
  await st.attempt(async () => {
    const selected = await openDialog({
      directory: false,
      multiple: false,
      title: "Open file",
      defaultPath: st.workspace?.root,
    });
    if (typeof selected !== "string") return;
    let path = st.workspace ? relativeFile(st.workspace.root, selected) : undefined;
    if (path === undefined) {
      const folder = await dirname(selected);
      requireSavedFiles(st);
      if (
        st.workspace &&
        !(await confirmDialog(`Open ${folder} to edit this file? This switches the current folder.`, {
          ok: "Open folder",
        }))
      )
        return;
      await st.openWorkspace(folder);
      path = await basename(selected);
    }
    st.openTab({ kind: "file", path });
  });
}

/** Switch the workspace to `path`, refusing while files have unsaved changes. Returns false if it did not switch. */
async function switchFolder(st: FileStore, path: string): Promise<boolean> {
  if (path === st.workspace?.root) return false;
  requireSavedFiles(st);
  await st.openWorkspace(path);
  return true;
}

export async function openFolder(st: FileStore) {
  await st.attempt(async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: "Open folder" });
    if (typeof selected !== "string") return;
    await switchFolder(st, selected);
  });
}

type SessionStore = FileStore & Pick<ReturnType<typeof useStudio>, "tabs" | "setSessionId" | "setSide">;

/**
 * Open a conversation's folder (for example its sandbox) in the explorer.
 * Opening a folder resets the conversation and tabs, so the conversation and its preview are restored.
 */
export async function openSessionFolder(st: SessionStore, sessionId: string, path: string) {
  await st.attempt(async () => {
    const preview = st.tabs.some((t) => t.kind === "preview" && t.sessionId === sessionId);
    if (await switchFolder(st, path)) {
      st.setSessionId(sessionId);
      if (preview) st.openTab({ kind: "preview", sessionId });
    }
    st.setSide("files");
  });
}
