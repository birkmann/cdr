import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "@web/app-state";
import { mirrorSnapshotRun } from "@web/recreate";
import { useStudio } from "../store";
import { previewTarget } from "../browser-preview";

/**
 * Opens a workspace HTML file in the system browser through the harness preview server. The page reloads
 * itself whenever files in its folder change, so agent edits show up live.
 */
export function useOpenInBrowser(): (path: string) => Promise<void> {
  const st = useStudio();
  const { client, sessions } = useApp();
  return async (path) => {
    const root = st.workspace?.root;
    if (!client || !root) return;
    const target = previewTarget(sessions, root, path, st.sessionId);
    if (!target) {
      st.toast("Start a conversation in this folder to preview its pages in the browser.", "info");
      return;
    }
    await st.attempt(async () => {
      const run = mirrorSnapshotRun(target.path);
      const app = run ? await client.recreateApp(target.sessionId, run).catch(() => undefined) : undefined;
      if (app) return openUrl(app.url);
      const d = await client.getSession(target.sessionId, { events: false });
      await openUrl(`${client.previewUrl(d.previewBase, target.path)}?live=1`);
    });
  };
}
