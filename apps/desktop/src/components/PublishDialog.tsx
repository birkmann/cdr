import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useDialog } from "@web/components/CommandPalette";
import { git, github, type Remote } from "../ipc";
import { openGithubSettings, useGithubUser } from "../github-account";
import { remoteLabel, remoteWebUrl, suggestRepoName } from "../publish";
import { basename, useStudio } from "../store";
import { ICloud, IGithub, IGlobe, ILock, IX } from "./icons";

const isSandbox = (root: string) => /[\\/]\.harness[\\/]sandboxes[\\/]/.test(root);

/** The open repository's remotes, reloaded when its git status changes. */
export function useRemotes(): Remote[] | undefined {
  const st = useStudio();
  const root = st.workspace?.root;
  const [remotes, setRemotes] = useState<Remote[]>();
  useEffect(() => {
    if (!root || !st.isRepo) return setRemotes(undefined);
    let live = true;
    git
      .remotes(root)
      .then((r) => live && setRemotes(r))
      .catch(() => live && setRemotes([]));
    return () => {
      live = false;
    };
  }, [root, st.isRepo, st.status?.upstream]);
  return remotes;
}

/** Create a GitHub repository for the open folder, add it as origin and push the current branch. */
export function PublishDialog({ onClose }: { onClose(): void }) {
  const st = useStudio();
  const ref = useDialog(onClose);
  const user = useGithubUser();
  const root = st.workspace!.root;
  const branch = st.status?.branch ?? "HEAD";
  const [name, setName] = useState(() => suggestRepoName(basename(root), isSandbox(root)));
  const [description, setDescription] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const publish = async () => {
    setError(undefined);
    try {
      setBusy("Creating repository…");
      const repo = await github.createRepo({ name: name.trim(), description, private: isPrivate });
      setBusy("Pushing…");
      await git.addRemote(root, "origin", repo.cloneUrl);
      await git.push(root, { setUpstream: true });
      await st.refreshGit();
      onClose();
      st.toast(`Published ${branch} to github.com/${repo.fullName}`, "success");
    } catch (e) {
      setError((e as Error).message);
      await st.refreshGit();
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div
      className="st-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="st-modal st-publish" ref={ref} role="dialog" aria-label="Publish to GitHub">
        <div className="st-row">
          <h2 className="st-grow">Publish to GitHub</h2>
          <button className="ghost icon" aria-label="Close" onClick={onClose} disabled={!!busy}>
            <IX size={16} />
          </button>
        </div>
        <p className="muted small">
          {basename(root)} is a local repository with no remote, so commits stay on this computer. Publishing
          creates a new repository on your GitHub account and pushes <strong>{branch}</strong> to it.
        </p>
        {user === undefined ? (
          <p className="muted small">Checking GitHub sign-in…</p>
        ) : user === null ? (
          <div className="st-publish-signin">
            <p>Sign in to GitHub first. Studio uses your account to create the repository and push.</p>
            <button onClick={openGithubSettings}>
              <IGithub size={14} /> Sign in to GitHub
            </button>
          </div>
        ) : (
          <>
            <label className="st-field">
              Repository
              <div className="st-prefixed">
                <span className="st-prefixed-label">
                  {user.avatarUrl && <img className="st-sb-avatar" src={user.avatarUrl} alt="" />}
                  {user.login}
                  <span className="muted">/</span>
                </span>
                <input
                  autoFocus
                  value={name}
                  maxLength={100}
                  spellCheck={false}
                  aria-label="Repository name"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && void publish()}
                />
              </div>
            </label>
            <label className="st-field">
              <span>
                Description <span className="muted">(optional)</span>
              </span>
              <input
                className="st-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <div className="st-field">
              Visibility
              <div className="st-choice-cards" role="radiogroup" aria-label="Visibility">
                {(
                  [
                    [true, "Private", "Only you and people you invite can see it.", ILock],
                    [false, "Public", "Anyone on the internet can see it.", IGlobe],
                  ] as const
                ).map(([priv, title, hint, Icon]) => (
                  <button
                    key={title}
                    role="radio"
                    aria-checked={isPrivate === priv}
                    className={isPrivate === priv ? "on" : ""}
                    onClick={() => setPrivate(priv)}
                  >
                    <Icon size={16} />
                    <span>
                      <strong>{title}</strong>
                      <span className="muted small">{hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            {!!st.status?.files.length && (
              <p className="muted small">
                Uncommitted changes are not pushed. Commit them first to include them.
              </p>
            )}
          </>
        )}
        {error && <p className="st-error small">{error}</p>}
        <div className="st-row end st-modal-actions">
          <button className="secondary" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button
            className="st-primary-btn"
            disabled={!user || !name.trim() || !!busy}
            onClick={() => void publish()}
          >
            {busy ?? `Publish ${isPrivate ? "private" : "public"} repository`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Where commits on this branch go: the tracked remote, the remote it would publish to, or nowhere yet. */
export function PushTarget({ onPublish }: { onPublish(): void }) {
  const st = useStudio();
  const remotes = useRemotes();
  const s = st.status;
  if (!s || !remotes) return null;
  const upstreamRemote = s.upstream ? remotes.find((r) => s.upstream!.startsWith(r.name + "/")) : undefined;
  const target = upstreamRemote ?? remotes.find((r) => r.name === "origin") ?? remotes[0];
  if (!target)
    return (
      <div className="st-push-target local">
        <span>
          <strong>Local only.</strong> Commits stay on this computer.
        </span>
        <button className="ghost small" onClick={onPublish}>
          <IGithub size={12} /> Publish to GitHub…
        </button>
      </div>
    );
  const web = remoteWebUrl(target.pushUrl);
  const label = remoteLabel(target.pushUrl);
  const owner = label.replace(/^github\.com\//, "");
  return (
    <div className="st-push-target" title={target.pushUrl.replace(/^(https?:\/\/)[^@/]+@/, "$1")}>
      {web ? <IGithub size={12} /> : <ICloud size={12} />}
      <span className="st-ellipsis st-grow">
        {s.upstream ? "Pushes to " : `${s.branch ?? "This branch"} is not published yet. Publish pushes to `}
        {web ? (
          <a
            href={web}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(web);
            }}
          >
            {owner}
          </a>
        ) : (
          label
        )}
      </span>
      {s.upstream && <span className="st-push-upstream">{s.upstream}</span>}
    </div>
  );
}
