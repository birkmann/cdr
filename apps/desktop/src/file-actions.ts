import { basename, dirname } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { confirmDialog } from "./components/dialogs";
import { inFolder } from "./sessions";
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
async function switchFolder(st: FileStore, path: string, opts?: { keepSession?: boolean }): Promise<boolean> {
  if (path === st.workspace?.root) return false;
  requireSavedFiles(st);
  await st.openWorkspace(path, opts);
  return true;
}

export async function openFolder(st: FileStore) {
  await st.attempt(async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: "Open folder" });
    if (typeof selected !== "string") return;
    await switchFolder(st, selected);
  });
}

type SessionStore = FileStore & Pick<ReturnType<typeof useStudio>, "setSide" | "revealInExplorer">;

/**
 * Open a conversation's folder (for example its sandbox) in the explorer, keeping that conversation selected.
 * `reveal` (relative to the folder) is expanded and selected, such as the folder its preview was published from.
 */
export async function openSessionFolder(st: SessionStore, path: string, reveal?: string) {
  await st.attempt(async () => {
    await switchFolder(st, path, { keepSession: true });
    st.setSide("files");
    if (reveal) st.revealInExplorer(reveal);
  });
}

/** A project file's path as the open workspace names it, when the project is a folder inside the workspace. */
export function pathInWorkspace(root: string, workspaceRoot: string | undefined, path: string): string {
  return workspaceRoot && root.startsWith(workspaceRoot + "/")
    ? `${root.slice(workspaceRoot.length + 1)}/${path}`
    : path;
}

type ViewStore = FileStore & Pick<ReturnType<typeof useStudio>, "setMode">;

/**
 * Show the code view of a project, opening that project first when another one is open.
 * The view changes even if the folder cannot (modified files), so those files stay in reach;
 * the result says whether `project` is what is now open, which tabs of that project depend on.
 */
export async function enterCodeView(st: ViewStore, project?: string | null): Promise<boolean> {
  let ok = true;
  if (project && !(st.workspace && inFolder({ projectPath: project }, st.workspace.root))) {
    ok = false;
    await st.attempt(async () => {
      await switchFolder(st, project, { keepSession: true });
      ok = true;
    });
  }
  st.setMode("code");
  return ok;
}

/** Show a file of a project in an editor tab of the code view, opening the project if needed. */
export async function openFileInCode(st: ViewStore, root: string, path: string, line?: number) {
  const inWorkspace = pathInWorkspace(root, st.workspace?.root, path);
  if (await enterCodeView(st, root)) st.openTab({ kind: "file", path: inWorkspace, line });
}

/** Move a conversation's preview to an editor tab of the code view, opening its project if needed. */
export async function openPreviewInCode(st: ViewStore, root: string, sessionId: string) {
  if (await enterCodeView(st, root)) st.openTab({ kind: "preview", sessionId });
}
