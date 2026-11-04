import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Popover } from "@web/components/Pickers";
import { CDRMark } from "@web/components/Brand";
import { app, git, type Branch, type RecentRepo } from "../ipc";
import { useStudio } from "../store";
import { IBranch, IDown, IPanelBottom, IPanelRight, ISearch, ISync, IUp, ICloud, IWarn } from "./icons";

export function TitleBar({
  onPalette,
  onClone,
  approvals,
}: {
  onPalette(): void;
  onClone(): void;
  approvals: number;
}) {
  const st = useStudio();
  return (
    <header className="st-titlebar">
      <div className="st-title-left">
        <CDRMark size={20} />
        <RepoMenu onClone={onClone} />
        {st.workspace && st.isRepo && <BranchMenu />}
        {st.workspace && st.isRepo && <SyncButton />}
      </div>
      <button
        className="st-title-search"
        onClick={onPalette}
        title="Search files and commands (Ctrl+P / Ctrl+Shift+P)"
      >
        <ISearch size={14} />
        <span>{st.workspace ? `Search ${st.workspace.name}` : "Search commands"}</span>
        <kbd>Ctrl P</kbd>
      </button>
      <div className="st-title-right">
        {approvals > 0 && (
          <button
            className="st-pill warn"
            onClick={() => st.setSide("agents")}
            title="Agents waiting for you"
          >
            <IWarn size={14} /> {approvals} waiting
          </button>
        )}
        <button
          className={`ghost icon ${st.bottom ? "on" : ""}`}
          onClick={() => st.setBottom(st.bottom ? null : "terminal")}
          title="Toggle panel (Ctrl+J)"
          aria-label="Toggle panel"
        >
          <IPanelBottom size={17} />
        </button>
        <button
          className={`ghost icon ${st.agentPanel ? "on" : ""}`}
          onClick={() => st.setAgentPanel(!st.agentPanel)}
          title="Toggle agent (Ctrl+L)"
          aria-label="Toggle agent panel"
        >
          <IPanelRight size={17} />
        </button>
      </div>
    </header>
  );
}

function RepoMenu({ onClone }: { onClone(): void }) {
  const st = useStudio();
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const openFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Open folder" });
    if (typeof dir === "string") await st.attempt(() => st.openWorkspace(dir));
  };
  return (
    <Popover
      className="st-repo-menu"
      label={
        <span
          className="st-title-btn"
          onMouseEnter={() =>
            void app
              .recent()
              .then(setRecent)
              .catch(() => {})
          }
        >
          <strong>{st.workspace?.name ?? "No folder"}</strong>
        </span>
      }
      title="Switch repository"
    >
      {(close) => (
        <div className="st-menu">
          <button onClick={() => (close(), void openFolder())}>Open folder…</button>
          <button onClick={() => (close(), onClone())}>Clone repository…</button>
          {st.workspace && <button onClick={() => (close(), st.closeWorkspace())}>Close folder</button>}
          {recent.length > 0 && <div className="st-menu-label">Recent</div>}
          {recent.slice(0, 12).map((r) => (
            <button
              key={r.path}
              disabled={!r.exists}
              title={r.path}
              onClick={() => (close(), void st.attempt(() => st.openWorkspace(r.path)))}
            >
              <span>{r.name}</span>
              <span className="muted small st-ellipsis">{r.path}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

function BranchMenu() {
  const st = useStudio();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [filter, setFilter] = useState("");
  const root = st.workspace!.root;
  const load = () =>
    void git
      .branches(root)
      .then(setBranches)
      .catch(() => {});
  const label = st.status?.detached ? `detached ${st.status.head ?? ""}` : (st.status?.branch ?? "…");
  const q = filter.trim().toLowerCase();
  const shown = branches.filter((b) => !q || b.name.toLowerCase().includes(q));
  const checkout = async (name: string) => {
    await st.attempt(() => git.checkout(root, name), `Switched to ${name}`);
    await st.refreshGit();
  };
  return (
    <Popover
      className="st-branch-menu"
      label={
        <span className="st-title-btn" onMouseDown={load} title="Switch branch">
          <IBranch size={14} />
          <span>{label}</span>
          {st.status?.mergeInProgress && <span className="badge">merging</span>}
          {st.status?.rebaseInProgress && <span className="badge">rebasing</span>}
        </span>
      }
    >
      {(close) => (
        <div className="st-menu wide">
          <input
            className="st-input"
            autoFocus
            placeholder="Find or create a branch…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key !== "Enter" || !filter.trim()) return;
              const exact = branches.find((b) => b.name === filter.trim());
              close();
              if (exact) await checkout(exact.name);
              else {
                await st.attempt(() => git.createBranch(root, filter.trim()), `Created ${filter.trim()}`);
                await st.refreshGit();
              }
              setFilter("");
            }}
          />
          {q && !branches.some((b) => b.name === filter.trim()) && (
            <button
              onClick={async () => {
                close();
                await st.attempt(() => git.createBranch(root, filter.trim()), `Created ${filter.trim()}`);
                await st.refreshGit();
                setFilter("");
              }}
            >
              Create branch “{filter.trim()}” from {st.status?.branch ?? "HEAD"}
            </button>
          )}
          <div className="st-menu-scroll">
            {shown.map((b) => (
              <button
                key={(b.isRemote ? "r:" : "l:") + b.name}
                className={b.isHead ? "on" : ""}
                onClick={() => (close(), void checkout(b.name))}
              >
                <span className="st-ellipsis">
                  {b.isRemote ? <ICloud size={12} /> : <IBranch size={12} />} {b.name}
                </span>
                <span className="muted small">{b.shortId}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

function SyncButton() {
  const st = useStudio();
  const [busy, setBusy] = useState<string | null>(null);
  const s = st.status;
  const root = st.workspace!.root;
  useEffect(() => setBusy(null), [root]);
  if (!s || s.detached) return null;
  const run = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    await st.attempt(fn, done);
    setBusy(null);
    await st.refreshGit();
  };
  let action: { label: string; icon: JSX.Element; fn: () => Promise<unknown>; done: string; title: string };
  if (!s.upstream)
    action = {
      label: "Publish branch",
      icon: <IUp size={14} />,
      fn: () => git.push(root, { setUpstream: true }),
      done: "Branch published",
      title: "Push this branch and track it on origin",
    };
  else if (s.behind > 0)
    action = {
      label: `Pull ${s.behind}`,
      icon: <IDown size={14} />,
      fn: async () => {
        const r = await git.pull(root);
        if (!r.ok)
          throw new Error(
            r.conflicts.length ? `Pull has conflicts in ${r.conflicts.length} files` : r.message,
          );
      },
      done: "Pulled",
      title: `Pull ${s.behind} commits from ${s.upstream}`,
    };
  else if (s.ahead > 0)
    action = {
      label: `Push ${s.ahead}`,
      icon: <IUp size={14} />,
      fn: () => git.push(root),
      done: "Pushed",
      title: `Push ${s.ahead} commits to ${s.upstream}`,
    };
  else
    action = {
      label: "Fetch",
      icon: <ISync size={14} />,
      fn: () => git.fetch(root),
      done: "Up to date",
      title: `Fetch from ${s.upstream}`,
    };
  return (
    <button
      className="st-title-btn"
      disabled={!!busy}
      title={action.title}
      onClick={() => void run(action.label, action.fn, action.done)}
    >
      {busy ? <span className="st-spin" /> : action.icon}
      <span>{busy ?? action.label}</span>
    </button>
  );
}
