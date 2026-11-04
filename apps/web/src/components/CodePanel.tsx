import { useEffect, useMemo, useRef, useState } from "react";
import type { UseSessionResult } from "@harness/react";
import { useApp } from "../app-state";
import { DiffLines, parseDiff, type FileDiff } from "./Diff";
import { highlight, langForPath } from "./Markdown";
import { IconChevronRight, IconExternal, IconFile, IconFolder, IconRefresh, IconX } from "./icons";

export type Tab = "preview" | "changes" | "files" | "tasks";

export function CodePanel({
  s,
  sessionId,
  tab,
  setTab,
}: {
  s: UseSessionResult;
  sessionId: string;
  tab: Tab;
  setTab(t: Tab): void;
}) {
  const editCount = useMemo(() => Object.values(s.tools).filter((t) => t.diff).length, [s.tools]);
  return (
    <aside className="code-panel">
      <div className="tabs">
        <button className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")}>
          Preview{s.preview ? <span className="count live">●</span> : null}
        </button>
        <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
          Changes{editCount ? <span className="count">{editCount}</span> : null}
        </button>
        <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
          Files
        </button>
        <button className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>
          Tasks
          {s.todos.length ? (
            <span className="count">{s.todos.filter((t) => t.status !== "done").length}</span>
          ) : null}
        </button>
      </div>
      <div className="panel-body">
        {tab === "preview" && <Preview s={s} sessionId={sessionId} refreshKey={editCount} />}
        {tab === "changes" && <Changes s={s} sessionId={sessionId} refreshKey={`${editCount}-${s.status}`} />}
        {tab === "files" && (
          <Files sessionId={sessionId} refreshKey={`${editCount}-${s.status}-${s.preview?.seq ?? 0}`} />
        )}
        {tab === "tasks" && <Tasks s={s} />}
      </div>
    </aside>
  );
}

function Preview({
  s,
  sessionId,
  refreshKey,
}: {
  s: UseSessionResult;
  sessionId: string;
  refreshKey: number;
}) {
  const { client } = useApp();
  const [base, setBase] = useState<string>();
  const [path, setPath] = useState<string>("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [nonce, setNonce] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [updates, setUpdates] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState(false);
  const busy = s.status === "running" || s.status === "waiting";
  // Finding an HTML file does not mean its stylesheet/scripts have been built yet.
  // A published preview is the agent's readiness signal; otherwise wait for the turn.
  const preparing = busy && !s.preview;
  // Shell builds can replace the selected HTML without producing a file-tool diff.
  const changes = Object.values(s.tools).filter(
    (t) => t.status === "ok" && ["write_file", "patch_file", "bash"].includes(t.name),
  ).length;
  const publication = s.preview?.seq ?? 0;
  const observed = useRef({ changes, publication });
  const dirty = useRef(false);
  const pendingPath = useRef<string>();
  const refresh = () => {
    if (pendingPath.current) {
      setPath(pendingPath.current);
      pendingPath.current = undefined;
    }
    dirty.current = false;
    setUpdates(false);
    setUpdated(false);
    setLoading(true);
    setNonce((n) => n + 1);
  };
  useEffect(() => {
    let cancelled = false;
    client
      ?.getSession(sessionId, { events: false })
      .then((d) => {
        if (!cancelled) setBase(d.previewBase);
      })
      .catch(() => {
        if (!cancelled) setBase(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  // Follow the agent's latest set_preview; otherwise offer HTML files found in the project.
  useEffect(() => {
    if (!s.preview) return;
    if (autoRefresh || !path) setPath(s.preview.path);
    else pendingPath.current = s.preview.path;
  }, [s.preview?.seq]);
  useEffect(() => {
    let cancelled = false;
    client
      ?.files(sessionId)
      .then((r) => {
        if (cancelled) return;
        const html = (r.files ?? []).filter((f) => /\.html?$/i.test(f) && !f.startsWith(".harness/"));
        html.sort(
          (a, b) => Number(/index\.html?$/.test(b)) - Number(/index\.html?$/.test(a)) || a.length - b.length,
        );
        setCandidates(html);
        if (!preparing) setPath((p) => p || html[0] || "");
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey, publication, s.status, preparing]);
  useEffect(() => {
    const published = publication !== observed.current.publication;
    if (changes !== observed.current.changes || published) dirty.current = true;
    observed.current = { changes, publication };
    if (dirty.current && autoRefresh && (published || !busy)) refresh();
    else setUpdates(dirty.current);
  }, [changes, publication, s.status, autoRefresh]);
  useEffect(() => {
    setLoading(true);
    setUpdated(false);
  }, [path]);
  const url = client && base && path && !preparing ? client.previewUrl(base, path) : "";
  return (
    <div className="preview">
      <div className="panel-toolbar">
        <select
          value={path}
          disabled={preparing}
          onChange={(e) => setPath(e.target.value)}
          aria-label="Preview file"
        >
          {!candidates.includes(path) && path && <option value={path}>{path}</option>}
          {!path && <option value="">{preparing ? "Building preview…" : "No HTML files yet"}</option>}
          {candidates.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          className="ghost preview-reload"
          onClick={refresh}
          disabled={!url}
          title="Reload"
          aria-label="Reload preview"
        >
          <IconRefresh size={15} /> Reload
        </button>
        {url && (
          <a className="ghost-link" href={url} target="_blank" rel="noreferrer" title="Open in a new tab">
            <IconExternal size={15} />
          </a>
        )}
      </div>
      {url && (
        <div className={`preview-update-bar${updates ? " has-updates" : ""}`}>
          <span role="status" aria-live="polite">
            {updates
              ? autoRefresh && ["running", "waiting"].includes(s.status)
                ? "Changes in progress — preview will refresh when ready."
                : "A newer version is ready. Refresh to see the changes."
              : busy
                ? "Build in progress — showing the last preview."
                : loading
                  ? "Loading preview…"
                  : updated
                    ? "Preview refreshed — showing the latest version."
                    : "Preview loaded."}
          </span>
          {updates && (
            <button className="secondary tiny" onClick={refresh}>
              Refresh preview
            </button>
          )}
          <label>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />{" "}
            Auto-refresh
          </label>
        </div>
      )}
      {preparing ? (
        <div className="preview-preparing" role="status">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <strong>Building your preview</strong>
          <p>The page will appear here when it’s ready, with its styles and scripts.</p>
        </div>
      ) : url ? (
        <iframe
          key={`${url}#${nonce}`}
          className="preview-frame"
          src={url}
          title="Live preview"
          onLoad={() => {
            setLoading(false);
            setUpdated(nonce > 0);
          }}
          // opaque origin: the generated code cannot read the app's token or storage
          sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups allow-downloads"
          allow="autoplay; fullscreen; gamepad"
        />
      ) : (
        <div className="muted pad">
          {s.workflow === "plan-only" && s.done?.status === "success"
            ? "Plan ready — no app has been built yet. Choose Build in the terminal or Plan & build in the web composer to implement it."
            : "When the agent builds a page, game or UI, its preview appears here — whether you started in the terminal or the web app."}
        </div>
      )}
    </div>
  );
}

function Changes({
  s,
  sessionId,
  refreshKey,
}: {
  s: UseSessionResult;
  sessionId: string;
  refreshKey: string;
}) {
  const { client } = useApp();
  const [gitDiff, setGitDiff] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const load = () =>
    client
      ?.diff(sessionId)
      .then(setGitDiff)
      .catch(() => setGitDiff(""));
  useEffect(() => {
    void load();
  }, [refreshKey, sessionId]);
  const toolDiff = useMemo(
    () =>
      Object.values(s.tools)
        .map((t) => t.diff)
        .filter(Boolean)
        .join("\n"),
    [s.tools],
  );
  const files: FileDiff[] = parseDiff(gitDiff || toolDiff);
  const source = gitDiff ? "git working tree vs HEAD" : toolDiff ? "edits made in this chat" : "";
  return (
    <div className="changes">
      <div className="panel-toolbar">
        <span className="muted small">{source || "No changes yet"}</span>
        <button
          className="ghost icon"
          onClick={() => void load()}
          title="Refresh"
          aria-label="Refresh changes"
        >
          <IconRefresh size={15} />
        </button>
      </div>
      {files.map((f) => {
        const isOpen = open[f.path] ?? files.length <= 3;
        return (
          <div className="diff-file" key={f.path}>
            <button
              className="diff-file-head mono"
              onClick={() => setOpen((o) => ({ ...o, [f.path]: !isOpen }))}
            >
              <IconChevronRight size={13} className={`chev ${isOpen ? "open" : ""}`} />
              <span className="path">{f.path}</span>
              {f.isNew && <span className="badge">new</span>}
              <span className="tool-stats">
                <span className="add">+{f.add}</span> <span className="del">−{f.del}</span>
              </span>
            </button>
            {isOpen && <DiffLines lines={f.lines} />}
          </div>
        );
      })}
    </div>
  );
}

interface TreeNode {
  name: string;
  path: string;
  children?: Map<string, TreeNode>;
}

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const parts = f.split("/");
    let n = root;
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!n.children!.has(p))
        n.children!.set(p, { name: p, path, children: i < parts.length - 1 ? new Map() : undefined });
      n = n.children!.get(p)!;
    });
  }
  return root;
}

function Files({ sessionId, refreshKey }: { sessionId: string; refreshKey: string }) {
  const { client } = useApp();
  const [files, setFiles] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    client
      ?.files(sessionId)
      .then((r) => setFiles(r.files ?? []))
      .catch(() => setFiles([]));
  }, [sessionId, refreshKey]);
  const shown = filter ? files.filter((f) => f.toLowerCase().includes(filter.toLowerCase())) : files;
  const tree = useMemo(() => buildTree(shown), [shown]);
  if (openFile) return <FileViewer sessionId={sessionId} path={openFile} onClose={() => setOpenFile(null)} />;
  const render = (n: TreeNode, depth: number): React.ReactNode[] =>
    [...n.children!.values()]
      .sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name))
      .flatMap((c) => {
        const isDir = !!c.children;
        const isOpen = filter ? true : expanded.has(c.path);
        const row = (
          <button
            key={c.path}
            className="tree-row"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() =>
              isDir
                ? setExpanded((e) => {
                    const n2 = new Set(e);
                    if (n2.has(c.path)) n2.delete(c.path);
                    else n2.add(c.path);
                    return n2;
                  })
                : setOpenFile(c.path)
            }
          >
            {isDir ? (
              <IconChevronRight size={12} className={`chev ${isOpen ? "open" : ""}`} />
            ) : (
              <span className="chev-space" />
            )}
            {isDir ? <IconFolder size={14} /> : <IconFile size={14} />}
            <span>{c.name}</span>
          </button>
        );
        return isDir && isOpen ? [row, ...render(c, depth + 1)] : [row];
      });
  return (
    <div className="files">
      <div className="panel-toolbar">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter workspace files"
          placeholder={`Filter ${files.length} workspace files…`}
        />
      </div>
      <div className="tree">
        {render(tree, 0)}
        {!shown.length && (
          <p className="muted center">{filter ? "No matching files." : "No files in this workspace yet."}</p>
        )}
      </div>
    </div>
  );
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico)$/i;

function FileViewer({ sessionId, path, onClose }: { sessionId: string; path: string; onClose(): void }) {
  const { client } = useApp();
  const [content, setContent] = useState<string | null>(null);
  const [err, setErr] = useState<string>();
  const isImage = IMAGE_EXT.test(path);
  useEffect(() => {
    if (isImage) return;
    client
      ?.files(sessionId, path)
      .then((r) => setContent(r.content ?? ""))
      .catch((e) => setErr((e as Error).message));
  }, [path]);
  const html = useMemo(
    () => (content !== null ? highlight(content, langForPath(path)) : ""),
    [content, path],
  );
  const lines = content?.split("\n").length ?? 0;
  return (
    <div className="viewer">
      <div className="panel-toolbar">
        <code className="small path">{path}</code>
        <button className="ghost icon" onClick={onClose} aria-label="Close file">
          <IconX size={15} />
        </button>
      </div>
      {err && <div className="error pad">{err}</div>}
      {isImage && client ? (
        <div className="pad">
          <img className="viewer-img" src={client.rawUrl(sessionId, path)} alt={path} />
        </div>
      ) : (
        content !== null && (
          <div className="viewer-code">
            <pre className="gutter">{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</pre>
            <pre>
              <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
          </div>
        )
      )}
    </div>
  );
}

function Tasks({ s }: { s: UseSessionResult }) {
  const lastPlan = [...s.timeline]
    .reverse()
    .find((t) => t.kind === "event" && t.event.type === "plan.proposed");
  return (
    <div className="tasks pad">
      {s.todos.length === 0 && !lastPlan && (
        <div className="muted">The agent's checklist and plan appear here.</div>
      )}
      {s.todos.map((t) => (
        <div key={t.id} className={`todo ${t.status}`}>
          <span className="todo-box">
            {t.status === "done" ? "✓" : t.status === "in_progress" ? "▸" : ""}
          </span>
          {t.text}
        </div>
      ))}
      {lastPlan && lastPlan.kind === "event" && lastPlan.event.type === "plan.proposed" && (
        <>
          <div className="group-head">Plan</div>
          <pre className="plan-text">{lastPlan.event.markdown}</pre>
        </>
      )}
    </div>
  );
}
