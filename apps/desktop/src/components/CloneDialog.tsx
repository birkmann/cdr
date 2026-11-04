import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useDialog } from "@web/components/CommandPalette";
import { app, git, github, on, type GitProgress, type GithubRepo } from "../ipc";
import { useStudio } from "../store";
import { fuzzyFilter } from "./fuzzy";
import { IX } from "./icons";

export function repoNameFromUrl(url: string): string {
  const clean = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return clean.split(/[/:]/).filter(Boolean).pop() ?? "repository";
}

export function CloneDialog({ onClose }: { onClose(): void }) {
  const st = useStudio();
  const ref = useDialog(onClose);
  const [tab, setTab] = useState<"github" | "url">("url");
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [filter, setFilter] = useState("");
  const [progress, setProgress] = useState<GitProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void app.info().then((i) => setParent(i.defaultCloneDir));
    void github
      .status()
      .then((u) => {
        setSignedIn(!!u);
        if (u) {
          setTab("github");
          return github.repos().then(setRepos);
        }
      })
      .catch(() => setSignedIn(false));
    return on<GitProgress>("git://progress", (p) => p.op === "clone" && setProgress(p));
  }, []);
  useEffect(() => {
    if (!nameEdited) setName(url ? repoNameFromUrl(url) : "");
  }, [url, nameEdited]);
  const shown = useMemo(
    () => (repos ? fuzzyFilter(repos, filter, (r) => r.fullName, 200) : []),
    [repos, filter],
  );

  const clone = async () => {
    setBusy(true);
    setError(undefined);
    setProgress(null);
    const dest = `${parent.replace(/\/+$/, "")}/${name}`;
    try {
      const path = await git.clone(url.trim(), dest);
      onClose();
      await st.openWorkspace(path);
      st.toast(`Cloned ${name}`, "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="st-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="st-modal st-clone" ref={ref} role="dialog" aria-label="Clone repository">
        <div className="st-row">
          <h2 className="st-grow">Clone a repository</h2>
          <button className="ghost icon" aria-label="Close" onClick={onClose} disabled={busy}>
            <IX size={16} />
          </button>
        </div>
        <div className="st-seg">
          <button className={tab === "github" ? "on" : ""} onClick={() => setTab("github")}>
            GitHub
          </button>
          <button className={tab === "url" ? "on" : ""} onClick={() => setTab("url")}>
            URL
          </button>
        </div>
        {tab === "github" &&
          (signedIn === false ? (
            <p className="muted small">
              Sign in to GitHub in Settings to pick from your repositories, or paste a URL.
            </p>
          ) : (
            <>
              <input
                className="st-input"
                placeholder="Filter your repositories, or type owner/name to search GitHub"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && filter.includes("/")) {
                    const r = await st.attempt(() => github.search(filter));
                    if (r)
                      setRepos((cur) => [
                        ...r,
                        ...(cur ?? []).filter((x) => !r.some((y) => y.fullName === x.fullName)),
                      ]);
                  }
                }}
              />
              <div className="st-repo-list">
                {!repos && <p className="muted small">Loading repositories…</p>}
                {shown.map((r) => (
                  <button
                    key={r.fullName}
                    className={url === r.cloneUrl ? "on" : ""}
                    onClick={() => {
                      setUrl(r.cloneUrl);
                      setNameEdited(false);
                    }}
                    onDoubleClick={() => void clone()}
                  >
                    <strong className="st-ellipsis">{r.fullName}</strong>
                    {r.private && <span className="badge">private</span>}
                    {r.fork && <span className="badge">fork</span>}
                    <span className="muted small st-ellipsis">{r.description}</span>
                  </button>
                ))}
              </div>
            </>
          ))}
        <label className="st-field">
          Repository URL
          <input
            className="st-input"
            placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git"
            value={url}
            autoFocus={tab === "url"}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <div className="st-row">
          <label className="st-field st-grow">
            Folder
            <div className="st-row">
              <input className="st-input" value={parent} onChange={(e) => setParent(e.target.value)} />
              <button
                className="ghost"
                onClick={async () => {
                  const d = await openDialog({ directory: true, title: "Clone into", defaultPath: parent });
                  if (typeof d === "string") setParent(d);
                }}
              >
                Choose…
              </button>
            </div>
          </label>
          <label className="st-field">
            Name
            <input
              className="st-input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
            />
          </label>
        </div>
        {(busy || progress) && (
          <div className="st-progress">
            <div className="st-progress-bar">
              <span style={{ width: `${progress?.percent ?? 5}%` }} />
            </div>
            <span className="muted small">{progress?.phase ?? "Starting…"}</span>
          </div>
        )}
        {error && <pre className="st-error st-log">{error}</pre>}
        <div className="st-row end">
          {busy ? (
            <button className="ghost" onClick={() => void git.cancel("clone")}>
              Cancel
            </button>
          ) : (
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          )}
          <button
            disabled={busy || !url.trim() || !name.trim() || !parent.trim()}
            onClick={() => void clone()}
          >
            {busy ? "Cloning…" : "Clone"}
          </button>
        </div>
      </div>
    </div>
  );
}
