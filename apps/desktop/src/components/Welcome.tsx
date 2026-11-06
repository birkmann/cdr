import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useApp } from "@web/app-state";
import { openFile, openFolder, openSessionFolder } from "../file-actions";
import { CDRMark } from "@web/components/Brand";
import { app, type RecentRepo } from "../ipc";
import { basename, timeAgo, useStudio } from "../store";
import { IFile, IFolder, IDown, IX } from "./icons";

export function Welcome({ compact = false, onClone }: { compact?: boolean; onClone(): void }) {
  const st = useStudio();
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  useEffect(() => {
    void app
      .recent()
      .then(setRecent)
      .catch(() => {});
  }, [st.workspace]);
  if (compact)
    return (
      <div className="st-panel">
        <div className="st-panel-head">
          <span className="st-panel-title">Explorer</span>
        </div>
        <ConversationFiles />
        <div className="st-empty st-empty-actions">
          <p>No folder is open.</p>
          <button onClick={() => void openFolder(st)}>Open folder</button>
          <button className="ghost" onClick={onClone}>
            Clone repository
          </button>
        </div>
      </div>
    );
  return (
    <div className="st-welcome">
      <div className="st-welcome-inner">
        <div className="st-welcome-brand">
          <CDRMark size={44} />
          <div>
            <h1>CDR Studio</h1>
            <p className="muted">Code. Build. Ship.</p>
          </div>
        </div>
        <div className="st-welcome-grid">
          <section>
            <h3>Start</h3>
            <button className="st-link" onClick={() => void openFile(st)}>
              <IFile size={16} /> Open file… <kbd>Ctrl O</kbd>
            </button>
            <button className="st-link" onClick={() => void openFolder(st)}>
              <IFolder size={16} /> Open folder… <kbd>Ctrl K Ctrl O</kbd>
            </button>
            <button className="st-link" onClick={onClone}>
              <IDown size={16} /> Clone repository…
            </button>
            <h3>Recent</h3>
            {recent.length === 0 && <p className="muted small">Folders you open appear here.</p>}
            {recent.slice(0, 10).map((r) => (
              <div key={r.path} className="st-recent">
                <button
                  className="st-link"
                  disabled={!r.exists}
                  title={r.path}
                  onClick={() => void st.attempt(() => st.openWorkspace(r.path))}
                >
                  <span>{r.name}</span>
                  <span className="muted small st-ellipsis">{r.path}</span>
                </button>
                <span className="muted small">{timeAgo(r.openedAt)}</span>
                <button
                  className="ghost icon tiny"
                  aria-label={`Remove ${r.name} from recent`}
                  title="Remove from recent"
                  onClick={async () => {
                    await app.forget(r.path);
                    setRecent((x) => x.filter((y) => y.path !== r.path));
                  }}
                >
                  <IX size={12} />
                </button>
              </div>
            ))}
          </section>
          <section>
            <h3>Work with agents</h3>
            <ul className="st-tips">
              <li>
                <strong>Chat or build</strong> in the agent panel on the right (<kbd>Ctrl L</kbd>). Modes:
                Chat, Plan & build, Quick fix, Plan only, Review.
              </li>
              <li>
                <strong>Subagents</strong>: agents can split work into parallel helpers in their own Git
                worktrees. Watch them in the Agents view (<kbd>Ctrl Shift A</kbd>).
              </li>
              <li>
                <strong>Goals</strong> run unattended with acceptance criteria and a budget, then wait for
                your review (<kbd>Ctrl Shift J</kbd>).
              </li>
              <li>
                <strong>Source control</strong>: stage hunks, commit, browse history, switch branches, push
                and open pull requests (<kbd>Ctrl Shift G</kbd>).
              </li>
              <li>
                <strong>Navigation</strong>: <kbd>Ctrl O</kbd> opens a file dialog, <kbd>Ctrl P</kbd> searches
                project files (Quick Open), <kbd>Ctrl Shift P</kbd> opens the command palette, and{" "}
                <kbd>Ctrl J</kbd> toggles the panel.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

/** With no folder open, point at the folder the selected conversation works in (usually its sandbox). */
function ConversationFiles() {
  const st = useStudio();
  const { sessions } = useApp();
  const session = st.sessionId ? sessions.find((s) => s.id === st.sessionId) : undefined;
  if (!session || session.projectMissing) return null;
  const path = session.projectPath;
  return (
    <section className="st-convo-files" aria-label="This conversation's files">
      <div className="st-menu-label">This conversation's files</div>
      <div className="st-convo-files-name">
        <IFolder size={14} />
        {session.sandbox && <span className="st-sw-badge">sandbox</span>}
        <span className="st-ellipsis">{basename(path)}</span>
      </div>
      <div className="muted small st-ellipsis" title={path}>
        {path}
      </div>
      <div className="st-convo-files-actions">
        <button onClick={() => void openSessionFolder(st, session.id, path)}>Browse files</button>
        <button className="ghost" onClick={() => void st.attempt(() => revealItemInDir(path))}>
          Show in file manager
        </button>
      </div>
    </section>
  );
}
