import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CDRMark } from "@web/components/Brand";
import { app, type RecentRepo } from "../ipc";
import { timeAgo, useStudio } from "../store";
import { IFolder, IDown, IX } from "./icons";

export function Welcome({ compact = false, onClone }: { compact?: boolean; onClone(): void }) {
  const st = useStudio();
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  useEffect(() => {
    void app
      .recent()
      .then(setRecent)
      .catch(() => {});
  }, [st.workspace]);
  const openFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Open folder" });
    if (typeof dir === "string") await st.attempt(() => st.openWorkspace(dir));
  };
  if (compact)
    return (
      <div className="st-panel">
        <div className="st-panel-head">
          <span className="st-panel-title">Explorer</span>
        </div>
        <div className="st-empty">
          <p>No folder is open.</p>
          <button onClick={() => void openFolder()}>Open folder</button>
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
            <button className="st-link" onClick={() => void openFolder()}>
              <IFolder size={16} /> Open folder… <kbd>Ctrl O</kbd>
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
                <strong>Everything else</strong>: <kbd>Ctrl P</kbd> opens files, <kbd>Ctrl Shift P</kbd> runs
                commands, <kbd>Ctrl J</kbd> opens a terminal.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
