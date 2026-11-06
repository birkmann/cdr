import { useEffect, useRef, useState } from "react";
import { basename, useApp, type ProjectSummary } from "../app-state";
import { IconChevronRight, IconFolder, IconRefresh, IconSparkle, IconTrash, IconX } from "./icons";

/** Count of conversations per project path. */
export function useProjectConversations(): Map<string, number> {
  const { sessions } = useApp();
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(s.projectPath, (counts.get(s.projectPath) ?? 0) + 1);
  return counts;
}

/**
 * Generate AI titles for projects that have none yet, or whose conversation count changed since the
 * last summary (so a project that started empty gets a better title once work happened in it).
 */
export function useProjectSummaries(projects: string[]) {
  const { client, settings, updateSettings, sessions, sessionsLoaded } = useApp();
  const counts = useProjectConversations();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const failed = useRef(new Set<string>());
  const missing = new Set(sessions.filter((s) => s.projectMissing).map((s) => s.projectPath));
  const summaries = settings.projectSummaries;
  // Queue + worker count live in refs so re-renders never restart or widen the throttle.
  const queue = useRef<string[]>([]);
  const queued = useRef(new Set<string>());
  const active = useRef(0);
  const latest = useRef({ client, model: settings.model, counts });
  latest.current = { client, model: settings.model, counts };

  const generate = async (path: string) => {
    const { client, model } = latest.current;
    if (!client) return;
    setPending((p) => new Set(p).add(path));
    try {
      const r = await client.projectSummary(path, model || undefined);
      const next: ProjectSummary = {
        title: r.title,
        summary: r.summary,
        at: new Date().toISOString(),
        conversations: latest.current.counts.get(path) ?? 0,
      };
      // Functional update: parallel generations don't clobber each other, and a project removed
      // while its summary was generating stays removed.
      updateSettings((s) =>
        s.hiddenProjects.includes(path) ? {} : { projectSummaries: { ...s.projectSummaries, [path]: next } },
      );
    } catch {
      failed.current.add(path);
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(path);
        return n;
      });
    }
  };

  // Two at a time keeps the model and the server responsive.
  const pump = () => {
    while (active.current < 2 && queue.current.length) {
      const path = queue.current.shift()!;
      active.current++;
      void generate(path).finally(() => {
        active.current--;
        queued.current.delete(path);
        pump();
      });
    }
  };

  // Until the session list has loaded, counts and missing folders are unknown: everything would look stale.
  const stale = sessionsLoaded
    ? projects.filter((p) => {
        if (missing.has(p) || failed.current.has(p) || pending.has(p) || queued.current.has(p)) return false;
        const s = summaries[p] as ProjectSummary | undefined;
        return !s || (s.conversations !== undefined && s.conversations !== (counts.get(p) ?? 0));
      })
    : [];
  const staleKey = stale.join("\n");
  useEffect(() => {
    if (!client || !stale.length) return;
    for (const p of stale) {
      queued.current.add(p);
      queue.current.push(p);
    }
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, staleKey]);

  return {
    summaries,
    pending,
    missing,
    regenerate: (path: string) => {
      failed.current.delete(path);
      void generate(path);
    },
  };
}

export function ProjectCard({
  path,
  summary,
  generating,
  missing,
  conversations,
  onOpen,
  onRegenerate,
  onRemove,
}: {
  path: string;
  summary?: ProjectSummary;
  generating: boolean;
  missing: boolean;
  conversations: number;
  onOpen(): void;
  onRegenerate(): void;
  onRemove(): void;
}) {
  const name = basename(path);
  const title = summary?.title || name;
  return (
    <div className="project-card">
      <button className="library-card" onClick={onOpen} disabled={missing} title={path}>
        <span className="library-icon">
          <IconFolder size={24} />
        </span>
        <strong>{title}</strong>
        <span className="project-summary muted small" aria-live="polite">
          {missing
            ? "This folder no longer exists on disk."
            : generating
              ? "Summarising what this project is about…"
              : summary?.summary || "No summary yet."}
        </span>
        <span className="muted small path">
          {summary?.title ? `${name} · ` : ""}
          {path}
        </span>
        <span className="card-bottom">
          {conversations} {conversations === 1 ? "conversation" : "conversations"}{" "}
          <IconChevronRight size={14} />
        </span>
      </button>
      <div className="project-actions">
        <button
          className="ghost icon"
          onClick={onRegenerate}
          disabled={generating || missing}
          aria-label={`Regenerate the AI summary of ${title}`}
          title="Regenerate AI title and summary"
        >
          {generating ? <IconSparkle size={14} /> : <IconRefresh size={14} />}
        </button>
        <button
          className="ghost icon danger-text"
          onClick={onRemove}
          aria-label={`Delete project ${title}`}
          title="Delete project"
        >
          <IconTrash size={14} />
        </button>
      </div>
    </div>
  );
}

/** Confirm removing a project; optionally delete its conversations too. Files on disk are never touched. */
export function RemoveProjectDialog({
  path,
  title,
  onClose,
}: {
  path: string;
  title: string;
  onClose(): void;
}) {
  const { client, sessions, forgetProject, refreshSessions } = useApp();
  const chats = sessions.filter((s) => s.projectPath === path);
  const [deleteChats, setDeleteChats] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      if (deleteChats) {
        if (!client) throw new Error("Not connected to the server, so no conversations were deleted.");
        const results = await Promise.allSettled(chats.map((s) => client.deleteSession(s.id)));
        const failed = results.filter((r) => r.status === "rejected").length;
        await refreshSessions();
        if (failed) {
          setError(`${failed} of ${chats.length} conversations could not be deleted. Try again.`);
          setBusy(false);
          return;
        }
      }
      forgetProject(path);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal remove-project" role="dialog" aria-modal="true" aria-label={`Delete ${title}`}>
        <div className="modal-head">
          <h3>Delete “{title}”?</h3>
          <button className="ghost icon" onClick={onClose} disabled={busy} aria-label="Close">
            <IconX />
          </button>
        </div>
        <div className="pad">
          <p>
            The project is removed from CDR. <strong>Your folder and its files stay on disk</strong> at{" "}
            <code>{path}</code>. Choosing the folder again brings the project back.
          </p>
          {chats.length > 0 && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={deleteChats}
                onChange={(e) => setDeleteChats(e.target.checked)}
              />
              Also delete its {chats.length} {chats.length === 1 ? "conversation" : "conversations"} (cannot
              be undone)
            </label>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
        <div className="modal-foot">
          <span />
          <span className="row">
            <button className="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="danger" onClick={() => void confirm()} disabled={busy} autoFocus>
              {busy ? "Deleting…" : "Delete project"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** What projects are, and when to use one (or not). Collapsible, remembered per browser. */
export function ProjectsGuide() {
  const KEY = "harness.projectsGuide.open";
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== "0";
    } catch {
      return true;
    }
  });
  return (
    <details
      className="projects-guide"
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        try {
          localStorage.setItem(KEY, next ? "1" : "0");
        } catch {
          /* private mode */
        }
      }}
    >
      <summary>About projects</summary>
      <p className="guide-lead">
        A project is a folder on your computer that CDR works inside. Every conversation started in a project
        reads and changes the files in that folder, and nothing outside it.
      </p>
      <div className="guide-grid">
        <section>
          <h4>What you get</h4>
          <ul>
            <li>
              File tools are confined to the folder, so the agent can't wander into the rest of your disk.
            </li>
            <li>
              Instructions in <code>AGENTS.md</code> or <code>CLAUDE.md</code> are loaded into every chat.
            </li>
            <li>
              Facts the agent remembers are kept in <code>.harness/memory</code> and reused next time.
            </li>
            <li>
              Project skills, config, checkpoints you can restore, and AI commit messages for git repos.
            </li>
          </ul>
        </section>
        <section>
          <h4>When to use one</h4>
          <ul>
            <li>You're working on existing code: fixing bugs, adding features, refactoring, reviewing.</li>
            <li>The work spans several conversations and should share context and rules.</li>
            <li>You want the results in a real folder you keep, version and run yourself.</li>
          </ul>
        </section>
        <section>
          <h4>When not to</h4>
          <ul>
            <li>
              Quick experiments, demos or throwaway prototypes: use <strong>New sandbox</strong>, a fresh
              folder created for you.
            </li>
            <li>Questions that need no files: just start a new chat.</li>
            <li>
              Very broad folders such as your home directory: the agent sees far too much. Pick the specific
              project folder.
            </li>
          </ul>
        </section>
      </div>
      <p className="muted small">
        Titles and summaries on the cards are written by AI from each folder's README, manifest files and
        conversation titles. Deleting a project only removes it from this list; your files are never touched.
      </p>
    </details>
  );
}
