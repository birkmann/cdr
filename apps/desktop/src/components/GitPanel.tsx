import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "@web/app-state";
import {
  git,
  github,
  type Branch,
  type FileStatus,
  type PullRequest,
  type Stash,
  type Worktree,
} from "../ipc";
import { basename, dirname, timeAgo, useStudio } from "../store";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { PublishDialog, PushTarget } from "./PublishDialog";
import { confirmDialog, promptDialog } from "./dialogs";
import { statusClass } from "./Explorer";
import {
  IBranch,
  IChevron,
  ICloud,
  IHistory,
  IMinus,
  IPlus,
  IPr,
  IRefresh,
  IStash,
  ISparkle,
  IUndo,
} from "./icons";
import { FileIcon } from "./FileIcon";

function Section({
  title,
  count,
  actions,
  children,
  defaultOpen = true,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="st-section">
      <div className="st-section-head">
        <button className="st-section-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <IChevron size={12} open={open} />
          <span>{title}</span>
          {count !== undefined && <span className="st-count">{count}</span>}
        </button>
        <div className="st-row tight st-section-actions">{actions}</div>
      </div>
      {open && <div className="st-section-body">{children}</div>}
    </section>
  );
}

export function GitPanel() {
  const st = useStudio();
  const root = st.workspace?.root;
  if (!root)
    return (
      <div className="st-panel">
        <div className="st-empty">
          <p>Open a folder to use source control.</p>
        </div>
      </div>
    );
  if (!st.isRepo)
    return (
      <div className="st-panel">
        <div className="st-panel-head">
          <span className="st-panel-title">Source control</span>
        </div>
        <div className="st-empty">
          <p>This folder is not a Git repository.</p>
          <button
            onClick={async () => {
              await st.attempt(() => git.init(root), "Initialized repository");
              await st.refreshGit();
            }}
          >
            Initialize repository
          </button>
        </div>
      </div>
    );
  return <RepoPanel root={root} />;
}

function RepoPanel({ root }: { root: string }) {
  const st = useStudio();
  const s = st.status;
  const files = s?.files ?? [];
  const conflicts = files.filter((f) => f.conflicted);
  const staged = files.filter((f) => !f.conflicted && f.index !== "unmodified" && f.index !== "untracked");
  const unstaged = files.filter((f) => !f.conflicted && f.worktree !== "unmodified");
  const [message, setMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [amend, setAmend] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const after = async () => {
    await st.refreshGit();
  };
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    await st.attempt(fn, ok);
    await after();
  };

  const [generating, setGenerating] = useState(false);
  const { client, settings } = useApp();
  const generate = async () => {
    if (!client || generating) return;
    setGenerating(true);
    try {
      const r = await client.commitMessage(root, settings.model || undefined);
      setMessage(r.message);
      setCommitError(null);
    } catch (e) {
      setCommitError(`Could not generate a commit message: ${(e as Error).message}`);
    } finally {
      setGenerating(false);
    }
  };

  const commit = async () => {
    if (!message.trim()) {
      setCommitError("Write a commit message first.");
      messageRef.current?.focus();
      return;
    }
    setCommitError(null);
    setBusy(true);
    try {
      if (!staged.length && !amend) {
        if (!unstaged.length) throw new Error("There is nothing to commit.");
        await git.stage(
          root,
          unstaged.map((f) => f.path),
        );
      }
      const c = await git.commit(root, { message: message.trim(), amend });
      st.toast(`Committed ${c.shortId}: ${c.subject}`, "success");
      setMessage("");
      setAmend(false);
    } catch (e) {
      setCommitError((e as Error).message);
    } finally {
      setBusy(false);
      await after();
    }
  };

  const fileMenu = (f: FileStatus, stagedList: boolean, x: number, y: number) => {
    const items: MenuItem[] = [
      {
        label: "Open changes",
        onClick: () => st.openTab({ kind: "diff", path: f.path, staged: stagedList }),
      },
      {
        label: "Open file",
        disabled: f.worktree === "deleted",
        onClick: () => st.openTab({ kind: "file", path: f.path }),
      },
      { separator: true, label: "" },
      stagedList
        ? { label: "Unstage", onClick: () => void run(() => git.unstage(root, [f.path])) }
        : { label: "Stage", onClick: () => void run(() => git.stage(root, [f.path])) },
      {
        label: f.worktree === "untracked" ? "Delete file" : "Discard changes",
        danger: true,
        disabled: stagedList,
        onClick: async () => {
          if (
            await confirmDialog(`Discard changes to ${f.path}? This cannot be undone.`, {
              danger: true,
              ok: "Discard",
            })
          )
            void run(() => git.discard(root, [f.path]));
        },
      },
      { separator: true, label: "" },
      {
        label: "Ask agent to review this change",
        onClick: () => st.askAgent(`Review my uncommitted changes in @${f.path} and point out problems.`),
      },
      { label: "File history", onClick: () => st.openTab({ kind: "history" }) },
    ];
    setMenu({ x, y, items });
  };

  const row = (f: FileStatus, stagedList: boolean) => (
    <div
      key={(stagedList ? "s:" : "w:") + f.path}
      className={`st-change ${statusClass(f)} ${st.active === `diff:${stagedList ? "s" : "w"}:${f.path}` ? "on" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        fileMenu(f, stagedList, e.clientX, e.clientY);
      }}
    >
      <button
        className="st-change-main"
        title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
        onClick={() =>
          f.conflicted
            ? st.openTab({ kind: "conflict", path: f.path })
            : st.openTab({ kind: "diff", path: f.path, staged: stagedList })
        }
      >
        <FileIcon path={f.path} />
        <span className="st-ellipsis">{basename(f.path)}</span>
        <span className="muted small st-ellipsis">{dirname(f.path)}</span>
      </button>
      <div className="st-change-actions">
        {!stagedList && !f.conflicted && (
          <button
            className="ghost icon tiny"
            title={f.worktree === "untracked" ? "Delete file" : "Discard changes"}
            aria-label="Discard"
            onClick={async () => {
              if (
                await confirmDialog(`Discard changes to ${f.path}? This cannot be undone.`, {
                  danger: true,
                  ok: "Discard",
                })
              )
                void run(() => git.discard(root, [f.path]));
            }}
          >
            <IUndo size={13} />
          </button>
        )}
        {f.conflicted ? (
          <button className="ghost tiny" onClick={() => st.openTab({ kind: "conflict", path: f.path })}>
            Resolve
          </button>
        ) : stagedList ? (
          <button
            className="ghost icon tiny"
            title="Unstage"
            aria-label="Unstage"
            onClick={() => void run(() => git.unstage(root, [f.path]))}
          >
            <IMinus size={13} />
          </button>
        ) : (
          <button
            className="ghost icon tiny"
            title="Stage"
            aria-label="Stage"
            onClick={() => void run(() => git.stage(root, [f.path]))}
          >
            <IPlus size={13} />
          </button>
        )}
      </div>
      <span className="st-change-letter">{changeLetter(f, stagedList)}</span>
    </div>
  );

  return (
    <div className="st-panel">
      <div className="st-panel-head">
        <span className="st-panel-title">Source control</span>
        <div className="st-row tight">
          <button
            className="ghost icon tiny"
            title="History"
            aria-label="History"
            onClick={() => st.openTab({ kind: "history" })}
          >
            <IHistory size={15} />
          </button>
          <button
            className="ghost icon tiny"
            title="Refresh"
            aria-label="Refresh"
            onClick={() => void after()}
          >
            <IRefresh size={15} />
          </button>
        </div>
      </div>
      <div className="st-panel-scroll">
        {(s?.mergeInProgress || s?.rebaseInProgress) && (
          <div className="st-banner warn">
            <strong>{s.mergeInProgress ? "Merge in progress" : "Rebase in progress"}</strong>
            <span>
              {conflicts.length ? `${conflicts.length} conflicted files` : "All conflicts resolved"}
            </span>
            <div className="st-row">
              {s.rebaseInProgress && (
                <button
                  disabled={conflicts.length > 0}
                  onClick={() =>
                    void run(async () => {
                      const r = await git.continueRebase(root);
                      if (!r.ok) throw new Error(r.message);
                    }, "Rebase continued")
                  }
                >
                  Continue
                </button>
              )}
              {s.mergeInProgress && (
                <button disabled={conflicts.length > 0} onClick={() => setMessage((m) => m || "Merge")}>
                  Commit merge below
                </button>
              )}
              <button
                className="ghost danger"
                onClick={async () =>
                  (await confirmDialog("Abort and restore the previous state?", {
                    danger: true,
                    ok: "Abort",
                  })) && void run(() => git.abort(root), "Aborted")
                }
              >
                Abort
              </button>
              {conflicts.length > 0 && (
                <button
                  className="ghost"
                  onClick={() =>
                    st.askAgent(
                      `Resolve the merge conflicts in: ${conflicts.map((c) => "@" + c.path).join(" ")}. Keep both sides' intent, remove all conflict markers, and make the build pass. Do not commit.`,
                    )
                  }
                >
                  Ask agent to resolve
                </button>
              )}
            </div>
          </div>
        )}
        <div className="st-commit">
          <div className="st-commit-input">
            <textarea
              ref={messageRef}
              className={`st-input${commitError ? " invalid" : ""}`}
              rows={Math.min(8, Math.max(3, message.split("\n").length))}
              placeholder={`Message (Ctrl+Enter to commit on ${s?.branch ?? "HEAD"})`}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                if (commitError) setCommitError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void commit();
                }
              }}
              aria-label="Commit message"
              aria-invalid={commitError ? true : undefined}
              aria-describedby={commitError ? "st-commit-error" : undefined}
            />
            <button
              className="ghost icon tiny st-generate"
              disabled={generating || (!staged.length && !unstaged.length)}
              title={
                staged.length ? "Generate commit message from staged changes" : "Generate commit message"
              }
              aria-label="Generate commit message"
              onClick={() => void generate()}
            >
              {generating ? <span className="st-spin small" /> : <ISparkle size={15} />}
            </button>
          </div>
          {commitError && (
            <div id="st-commit-error" className="st-field-error" role="alert">
              {commitError}
            </div>
          )}
          <div className="st-row">
            <button
              className="st-grow"
              disabled={busy || (!staged.length && !unstaged.length && !amend)}
              onClick={() => void commit()}
            >
              {busy
                ? "Committing…"
                : amend
                  ? "Amend last commit"
                  : staged.length
                    ? `Commit ${staged.length} staged`
                    : `Commit all ${unstaged.length}`}
            </button>
          </div>
          <label className="st-check small">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend
            previous commit
          </label>
          <PushTarget onPublish={() => setPublishing(true)} />
          {publishing && <PublishDialog onClose={() => setPublishing(false)} />}
        </div>
        {conflicts.length > 0 && (
          <Section title="Merge conflicts" count={conflicts.length}>
            {conflicts.map((f) => row(f, false))}
          </Section>
        )}
        <Section
          title="Staged changes"
          count={staged.length}
          actions={
            staged.length > 0 && (
              <button
                className="ghost icon tiny"
                title="Unstage all"
                aria-label="Unstage all"
                onClick={() =>
                  void run(() =>
                    git.unstage(
                      root,
                      staged.map((f) => f.path),
                    ),
                  )
                }
              >
                <IMinus size={13} />
              </button>
            )
          }
        >
          {staged.length ? (
            staged.map((f) => row(f, true))
          ) : (
            <p className="st-hint">Stage files or hunks to commit them.</p>
          )}
        </Section>
        <Section
          title="Changes"
          count={unstaged.length}
          actions={
            unstaged.length > 0 && (
              <>
                <button
                  className="ghost icon tiny"
                  title="Discard all changes"
                  aria-label="Discard all"
                  onClick={async () => {
                    if (
                      await confirmDialog(
                        unstaged.length === 1
                          ? `Discard the change to ${unstaged[0].path}? This cannot be undone.`
                          : `Discard all ${unstaged.length} changes, including new files? This cannot be undone.`,
                        { danger: true, ok: "Discard all" },
                      )
                    )
                      void run(() =>
                        git.discard(
                          root,
                          unstaged.map((f) => f.path),
                        ),
                      );
                  }}
                >
                  <IUndo size={13} />
                </button>
                <button
                  className="ghost icon tiny"
                  title="Stage all"
                  aria-label="Stage all"
                  onClick={() =>
                    void run(() =>
                      git.stage(
                        root,
                        unstaged.map((f) => f.path),
                      ),
                    )
                  }
                >
                  <IPlus size={13} />
                </button>
              </>
            )
          }
        >
          {unstaged.length ? (
            unstaged.map((f) => row(f, false))
          ) : (
            <p className="st-hint">No changes in the working tree.</p>
          )}
        </Section>
        <BranchesSection root={root} />
        <StashSection root={root} canStash={files.length > 0} />
        <PullRequestsSection root={root} />
        <WorktreesSection root={root} />
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function changeLetter(f: FileStatus, staged: boolean): string {
  const k = staged ? f.index : f.worktree;
  return (
    (
      {
        modified: "M",
        added: "A",
        deleted: "D",
        renamed: "R",
        copied: "C",
        untracked: "U",
        typeChanged: "T",
        unmerged: "!",
      } as Record<string, string>
    )[k] ?? ""
  );
}

function BranchesSection({ root }: { root: string }) {
  const st = useStudio();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [showRemote, setShowRemote] = useState(false);
  const load = () =>
    void git
      .branches(root)
      .then(setBranches)
      .catch(() => {});
  useEffect(load, [root, st.status?.branch, st.status?.head]);
  const current = st.status?.branch;
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    await st.attempt(fn, ok);
    await st.refreshGit();
    load();
  };
  const mergeLike = (op: "merge" | "rebase", b: string) =>
    run(
      async () => {
        const r = op === "merge" ? await git.merge(root, b) : await git.rebase(root, b);
        if (!r.ok)
          throw new Error(
            r.conflicts.length
              ? `${op === "merge" ? "Merge" : "Rebase"} stopped with ${r.conflicts.length} conflicts. Resolve them in Source control.`
              : r.message,
          );
      },
      op === "merge" ? `Merged ${b} into ${current}` : `Rebased ${current} onto ${b}`,
    );
  const local = branches.filter((b) => !b.isRemote);
  const remote = branches.filter((b) => b.isRemote);
  const menuFor = (b: Branch, x: number, y: number) => {
    const items: MenuItem[] = [
      {
        label: "Checkout",
        disabled: b.isHead,
        onClick: () => void run(() => git.checkout(root, b.name), `Switched to ${b.name}`),
      },
      {
        label: `Merge into ${current ?? "current"}`,
        disabled: b.isHead || !current,
        onClick: () => void mergeLike("merge", b.name),
      },
      {
        label: `Rebase ${current ?? "current"} onto this`,
        disabled: b.isHead || !current,
        onClick: () => void mergeLike("rebase", b.name),
      },
      {
        label: "New branch from here…",
        onClick: async () => {
          const name = await promptDialog("New branch name", `${b.name.replace(/^origin\//, "")}-2`);
          if (name) void run(() => git.createBranch(root, name.trim(), b.name), `Created ${name}`);
        },
      },
      { label: "Show history", onClick: () => st.openTab({ kind: "history" }) },
    ];
    if (!b.isRemote)
      items.push(
        { separator: true, label: "" },
        {
          label: "Rename…",
          onClick: async () => {
            const name = await promptDialog("Rename branch", b.name);
            if (name && name !== b.name) void run(() => git.renameBranch(root, b.name, name.trim()));
          },
        },
        {
          label: "Delete",
          danger: true,
          disabled: b.isHead,
          onClick: async () => {
            if (!(await confirmDialog(`Delete branch ${b.name}?`, { danger: true, ok: "Delete" }))) return;
            void run(async () => {
              try {
                await git.deleteBranch(root, b.name, false);
              } catch (e) {
                if (
                  await confirmDialog(
                    `${(e as Error).message} Force delete ${b.name}? Unmerged commits will be lost.`,
                    {
                      danger: true,
                      ok: "Force delete",
                    },
                  )
                )
                  await git.deleteBranch(root, b.name, true);
                else throw e;
              }
            }, `Deleted ${b.name}`);
          },
        },
      );
    setMenu({ x, y, items });
  };
  const row = (b: Branch) => (
    <button
      key={(b.isRemote ? "r:" : "l:") + b.name}
      className={`st-branch ${b.isHead ? "on" : ""}`}
      onDoubleClick={() => !b.isHead && void run(() => git.checkout(root, b.name), `Switched to ${b.name}`)}
      onContextMenu={(e) => {
        e.preventDefault();
        menuFor(b, e.clientX, e.clientY);
      }}
      onClick={(e) => menuFor(b, e.clientX, e.clientY)}
      title={`${b.name} · ${b.lastSubject}`}
    >
      {b.isRemote ? <ICloud size={13} /> : <IBranch size={13} />}
      <span className="st-ellipsis">{b.name}</span>
      {(b.ahead ?? 0) > 0 && (
        <span className="st-count" title="ahead">
          ↑{b.ahead}
        </span>
      )}
      {(b.behind ?? 0) > 0 && (
        <span className="st-count" title="behind">
          ↓{b.behind}
        </span>
      )}
      <span className="muted small">{timeAgo(b.lastCommitTime)}</span>
    </button>
  );
  return (
    <Section
      title="Branches"
      count={local.length}
      defaultOpen={false}
      actions={
        <button
          className="ghost icon tiny"
          title="New branch"
          aria-label="New branch"
          onClick={async () => {
            const name = await promptDialog(`New branch from ${current ?? "HEAD"}`);
            if (name) void run(() => git.createBranch(root, name.trim()), `Created ${name}`);
          }}
        >
          <IPlus size={13} />
        </button>
      }
    >
      {local.map(row)}
      {remote.length > 0 && (
        <button className="st-hint-btn" onClick={() => setShowRemote((v) => !v)}>
          {showRemote ? "Hide" : "Show"} {remote.length} remote branches
        </button>
      )}
      {showRemote && remote.map(row)}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </Section>
  );
}

function StashSection({ root, canStash }: { root: string; canStash: boolean }) {
  const st = useStudio();
  const [stashes, setStashes] = useState<Stash[]>([]);
  const load = () =>
    void git
      .stashes(root)
      .then(setStashes)
      .catch(() => {});
  useEffect(load, [root, st.status]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    await st.attempt(fn, ok);
    await st.refreshGit();
    load();
  };
  return (
    <Section
      title="Stashes"
      count={stashes.length}
      defaultOpen={false}
      actions={
        <button
          className="ghost icon tiny"
          disabled={!canStash}
          title="Stash all changes"
          aria-label="Stash changes"
          onClick={async () => {
            const msg = await promptDialog("Stash message (optional)");
            if (msg === null) return;
            void run(() => git.stashPush(root, msg || undefined, true), "Changes stashed");
          }}
        >
          <IStash size={13} />
        </button>
      }
    >
      {stashes.length === 0 && <p className="st-hint">No stashes.</p>}
      {stashes.map((s) => (
        <div key={s.id} className="st-change">
          <span className="st-change-main st-ellipsis" title={s.message}>
            {s.message}
          </span>
          <div className="st-change-actions visible">
            <button
              className="ghost tiny"
              onClick={() => void run(() => git.stashPop(root, s.index), "Stash applied")}
            >
              Pop
            </button>
            <button
              className="ghost tiny danger"
              onClick={async () =>
                (await confirmDialog("Drop this stash?", { danger: true, ok: "Drop" })) &&
                void run(() => git.stashDrop(root, s.index))
              }
            >
              Drop
            </button>
          </div>
        </div>
      ))}
    </Section>
  );
}

function PullRequestsSection({ root }: { root: string }) {
  const st = useStudio();
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const load = () =>
    void github
      .pulls(root)
      .then((p) => (setPrs(p), setError(undefined)))
      .catch((e) => setError((e as Error).message));
  useEffect(load, [root]);
  const branch = st.status?.branch;
  const mine = useMemo(() => prs?.find((p) => p.head === branch), [prs, branch]);
  return (
    <Section
      title="Pull requests"
      count={prs?.length}
      defaultOpen={false}
      actions={
        <>
          <button
            className="ghost icon tiny"
            title="Refresh"
            aria-label="Refresh pull requests"
            onClick={load}
          >
            <IRefresh size={13} />
          </button>
          <button
            className="ghost icon tiny"
            title="Create pull request"
            aria-label="Create pull request"
            disabled={!branch}
            onClick={() => setCreating(true)}
          >
            <IPlus size={13} />
          </button>
        </>
      }
    >
      {error && <p className="st-hint">{error}</p>}
      {mine && (
        <p className="st-hint">
          This branch has{" "}
          <a href="#" onClick={(e) => (e.preventDefault(), void openUrl(mine.url))}>
            #{mine.number}
          </a>
          .
        </p>
      )}
      {prs?.map((p) => (
        <button
          key={p.number}
          className="st-branch"
          onClick={() => void openUrl(p.url)}
          title={`${p.head} → ${p.base}`}
        >
          <IPr size={13} />
          <span className="st-ellipsis">
            #{p.number} {p.title}
          </span>
          <span className={`st-checks ${p.checks}`} title={`Checks: ${p.checks}`} />
          {p.draft && <span className="badge">draft</span>}
        </button>
      ))}
      {prs && prs.length === 0 && !error && <p className="st-hint">No open pull requests.</p>}
      {creating && branch && (
        <CreatePrDialog root={root} head={branch} onClose={() => setCreating(false)} onCreated={load} />
      )}
    </Section>
  );
}

export function CreatePrDialog({
  root,
  head,
  base: initialBase,
  title: initialTitle,
  body: initialBody,
  onClose,
  onCreated,
  pushBranch,
}: {
  root: string;
  head: string;
  /** Push this branch explicitly (it may not be checked out, e.g. a goal branch). */
  pushBranch?: string;
  base?: string;
  title?: string;
  body?: string;
  onClose(): void;
  onCreated?(url: string): void;
}) {
  const st = useStudio();
  const [base, setBase] = useState(initialBase ?? "main");
  const [title, setTitle] = useState(initialTitle ?? head.replace(/[-_/]+/g, " "));
  const [body, setBody] = useState(initialBody ?? "");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initialBase) return;
    void git.branches(root).then((bs) => {
      const names = bs.map((b) => b.name);
      setBase(
        names.includes("main")
          ? "main"
          : names.includes("master")
            ? "master"
            : (names.find((n) => n !== head) ?? "main"),
      );
    });
  }, [root, head, initialBase]);
  const create = async () => {
    setBusy(true);
    try {
      if (pushBranch) await git.push(root, { branch: pushBranch, setUpstream: true });
      else {
        const s = await git.status(root);
        if (!s.upstream || s.ahead > 0) await git.push(root, { setUpstream: !s.upstream });
      }
      const pr = await github.createPr(root, { head, base, title, body, draft });
      st.toast(`Opened pull request #${pr.number}`, "success");
      onCreated?.(pr.url);
      void openUrl(pr.url);
      onClose();
    } catch (e) {
      st.toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      void st.refreshGit();
    }
  };
  return (
    <div className="st-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-modal" role="dialog" aria-label="Create pull request">
        <h2>Create pull request</h2>
        <p className="muted small">
          {head} → {base}. The branch is pushed first if needed.
        </p>
        <label className="st-field">
          Base branch
          <input className="st-input" value={base} onChange={(e) => setBase(e.target.value)} />
        </label>
        <label className="st-field">
          Title
          <input className="st-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="st-field">
          Description
          <textarea className="st-input" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label className="st-check">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
        </label>
        <div className="st-row end">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button disabled={busy || !title.trim()} onClick={() => void create()}>
            {busy ? "Creating…" : "Create pull request"}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorktreesSection({ root }: { root: string }) {
  const st = useStudio();
  const [wts, setWts] = useState<Worktree[]>([]);
  useEffect(
    () =>
      void git
        .worktrees(root)
        .then(setWts)
        .catch(() => {}),
    [root, st.status],
  );
  const extra = wts.filter((w) => !w.isMain);
  if (!extra.length) return null;
  return (
    <Section title="Worktrees" count={extra.length} defaultOpen={false}>
      {extra.map((w) => (
        <button
          key={w.path}
          className="st-branch"
          title={w.path}
          onClick={() => void st.attempt(() => st.openWorkspace(w.path))}
        >
          <IBranch size={13} />
          <span className="st-ellipsis">{w.branch ?? w.head.slice(0, 8)}</span>
          <span className="muted small st-ellipsis">{w.path.replace(root + "/", "")}</span>
        </button>
      ))}
    </Section>
  );
}
