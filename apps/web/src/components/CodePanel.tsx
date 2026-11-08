import { useEffect, useMemo, useRef, useState } from "react";
import type { UseSessionResult } from "@harness/react";
import { useApp } from "../app-state";
import { DiffLines, parseDiff, type FileDiff } from "./Diff";
import { highlight, langForPath } from "./Markdown";
import {
  IconChevronRight,
  IconExternal,
  IconFile,
  IconFolder,
  IconMonitor,
  IconPhone,
  IconRefresh,
  IconTablet,
  IconX,
} from "./icons";
import { History } from "./History";
import {
  ComparePanel,
  RecreateBuildView,
  recreateBuild,
  recreatePreviewPath,
  recreateProgress,
  recreateRuns,
} from "./RecreateCard";

export type Tab = "preview" | "changes" | "files" | "tasks" | "history" | "compare" | "document";

/** An uploaded file shown full-size in the side column, next to the chat. */
export interface OpenDocument {
  path: string;
  name: string;
  mimeType: string;
}

type Device = "desktop" | "tablet" | "mobile";
const DEVICES: Record<Device, { label: string; width?: number; next: Device; Icon: typeof IconMonitor }> = {
  desktop: { label: "Desktop", next: "tablet", Icon: IconMonitor },
  tablet: { label: "Tablet", width: 768, next: "mobile", Icon: IconTablet },
  mobile: { label: "Mobile", width: 390, next: "desktop", Icon: IconPhone },
};
const DEVICE_KEY = "harness.previewDevice";
function storedDevice(): Device {
  try {
    const v = localStorage.getItem(DEVICE_KEY);
    if (v && v in DEVICES) return v as Device;
  } catch {
    /* storage unavailable */
  }
  return "desktop";
}

export function CodePanel({
  s,
  sessionId,
  tab,
  setTab,
  compareRun,
  setCompareRun,
  doc,
  closeDoc,
  previewHost,
}: {
  s: UseSessionResult;
  sessionId: string;
  tab: Tab;
  setTab(t: Tab): void;
  compareRun?: string;
  setCompareRun?(runId: string): void;
  doc?: OpenDocument;
  closeDoc?(): void;
  /** When set, the preview opens elsewhere (e.g. an editor tab in the desktop app) instead of in this panel. */
  previewHost?: PreviewHost;
}) {
  const editCount = useEditCount(s);
  const runs = recreateRuns(s);
  return (
    <aside className="code-panel">
      <div className="tabs">
        {doc && (
          <button
            className={tab === "document" ? "active" : ""}
            onClick={() => setTab("document")}
            title={doc.name}
          >
            <span className="tab-doc-name">{doc.name}</span>
          </button>
        )}
        <button
          className={tab === "preview" && !previewHost ? "active" : ""}
          onClick={() => (previewHost ? previewHost.open() : setTab("preview"))}
          draggable={!!previewHost?.dragStart}
          onDragStart={previewHost?.dragStart}
          title={
            previewHost?.dragStart
              ? "Open the preview in the editor (or drag it where you want it)"
              : previewHost
                ? "Open the preview beside the chat"
                : undefined
          }
        >
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
        <button
          className={tab === "history" ? "active" : ""}
          onClick={() => setTab("history")}
          title="Where this conversation is stored, and its raw log"
        >
          History
        </button>
        {(runs.length > 0 || tab === "compare") && (
          <button className={tab === "compare" ? "active" : ""} onClick={() => setTab("compare")}>
            Compare
            {runs.some((r) => r.comparePath) ? <span className="count live">●</span> : null}
          </button>
        )}
      </div>
      <div className="panel-body">
        {tab === "document" && doc && (
          <DocumentViewer key={doc.path} sessionId={sessionId} doc={doc} onClose={() => closeDoc?.()} />
        )}
        {tab === "preview" && !previewHost && <Preview s={s} sessionId={sessionId} refreshKey={editCount} />}
        {tab === "changes" && <Changes s={s} sessionId={sessionId} refreshKey={`${editCount}-${s.status}`} />}
        {tab === "files" && (
          <Files sessionId={sessionId} refreshKey={`${editCount}-${s.status}-${s.preview?.seq ?? 0}`} />
        )}
        {tab === "tasks" && <Tasks s={s} />}
        {tab === "history" && (
          <History sessionId={sessionId} refreshKey={`${s.status}-${editCount}-${s.preview?.seq ?? 0}`} />
        )}
        {tab === "compare" && (
          <ComparePanel
            s={s}
            sessionId={sessionId}
            runId={compareRun}
            setRunId={(id) => setCompareRun?.(id)}
          />
        )}
      </div>
    </aside>
  );
}

/** Lets a host app show the preview outside the chat's side panel. */
export interface PreviewHost {
  /**
   * `automatic` is set when a preview arrived, as opposed to the user asking for it. `live` tells a page the agent
   * published just now from one that was already in the conversation's history when it was shown.
   */
  open(automatic?: boolean, live?: boolean): void;
  /** Drag source for the Preview tab and preview cards, so the preview can be dropped where it should open. */
  dragStart?(e: React.DragEvent): void;
}

/** Number of file edits in a session; the preview reloads when it changes. */
export function useEditCount(s: UseSessionResult): number {
  return useMemo(() => Object.values(s.tools).filter((t) => t.diff).length, [s.tools]);
}

/** Quiet time after the agent's last file change before a running session's preview reloads. */
const SETTLE_MS = 1200;

/** Runs whose recreation has been placed over the screenshot (kept across tab switches: no second reveal). */
const revealedRuns = new Set<string>();

export function Preview({
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
  const [device, setDevice] = useState<Device>(storedDevice);
  const cycleDevice = () => {
    const next = DEVICES[device].next;
    setDevice(next);
    try {
      localStorage.setItem(DEVICE_KEY, next);
    } catch {
      /* storage unavailable */
    }
  };
  const view = DEVICES[device];
  const nextView = DEVICES[view.next];
  const busy = s.status === "running" || s.status === "waiting";
  // Finding an HTML file does not mean its stylesheet/scripts have been built yet.
  // A published preview is the agent's readiness signal; otherwise wait for the turn.
  // A 1:1 recreation started from the composer builds its page without set_preview: follow its output.
  const recreated = recreatePreviewPath(s);
  const preparing = busy && !s.preview && !recreated;
  // Shell builds can replace the selected HTML without producing a file-tool diff.
  const changes = Object.values(s.tools).filter(
    (t) => t.status === "ok" && ["write_file", "patch_file", "bash"].includes(t.name),
  ).length;
  const publication = (s.preview?.seq ?? 0) + recreateProgress(s);
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
    const next = s.preview?.path ?? recreated;
    if (!next) return;
    if (autoRefresh || !path) setPath(next);
    else pendingPath.current = next;
  }, [s.preview?.seq, recreated]);
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
  // While the agent works, reload once its writes have settled (like a preview opened in a browser tab),
  // instead of waiting for the whole turn to end.
  const settle = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const published = publication !== observed.current.publication;
    if (changes !== observed.current.changes || published) dirty.current = true;
    observed.current = { changes, publication };
    clearTimeout(settle.current);
    if (dirty.current && autoRefresh && (published || !busy)) refresh();
    else {
      setUpdates(dirty.current);
      if (dirty.current && autoRefresh)
        settle.current = setTimeout(() => {
          if (dirty.current) refresh();
        }, SETTLE_MS);
    }
  }, [changes, publication, s.status, autoRefresh]);
  useEffect(() => () => clearTimeout(settle.current), []);
  useEffect(() => {
    setLoading(true);
    setUpdated(false);
  }, [path]);
  const url = client && base && path && !preparing ? client.previewUrl(base, path) : "";
  // An iframe shows a refused or missing file as a blank page: ask first, and explain instead.
  const [failed, setFailed] = useState<number>();
  useEffect(() => {
    setFailed(undefined);
    if (!url) return;
    let cancelled = false;
    fetch(url, { method: "HEAD", cache: "no-store" })
      .then((r) => {
        if (!cancelled && !r.ok) setFailed(r.status);
      })
      .catch(() => {
        /* unreachable server: the iframe shows the browser's own error */
      });
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);
  // a running 1:1 recreation: the live page's screenshot, replaced section by section by the coded page; the
  // regular preview takes over once the whole page is in place
  const [, setRevealed] = useState(0);
  const candidate = recreateBuild(s, view.width ?? 1440);
  const build = candidate && !revealedRuns.has(candidate.run.runId) ? candidate : undefined;
  const buildShot =
    build && client && base ? `${client.previewUrl(base, build.shot.path)}?v=${build.shot.seq}` : "";
  const buildPage = build?.page && client && base ? client.previewUrl(base, build.page) : undefined;
  const onRevealed = (runId: string) => {
    revealedRuns.add(runId);
    setRevealed((n) => n + 1);
    refresh();
  };
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
        <button
          className="ghost preview-device"
          onClick={cycleDevice}
          title={`Viewport: ${view.label}${view.width ? ` (${view.width}px)` : ""} — switch to ${nextView.label}`}
          aria-label={`Preview viewport: ${view.label}. Switch to ${nextView.label}`}
        >
          <view.Icon size={15} /> {view.label}
        </button>
        {url && (
          <a
            className="ghost-link"
            href={`${url}?live=1`}
            target="_blank"
            rel="noreferrer"
            title="Open in a new tab (reloads live as files change)"
          >
            <IconExternal size={15} />
          </a>
        )}
      </div>
      {url && !buildShot && !failed && (
        <div className={`preview-update-bar${updates ? " has-updates" : ""}`}>
          <span role="status" aria-live="polite">
            {updates
              ? autoRefresh && ["running", "waiting"].includes(s.status)
                ? "Changes in progress — preview will refresh in a moment."
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
      {build && buildShot ? (
        <RecreateBuildView
          key={`${build.run.runId}:${build.shot.width}`}
          run={build.run}
          shot={build.shot}
          shotSrc={buildShot}
          pageSrc={buildPage}
          activity={build.activity}
          onRevealed={onRevealed}
        />
      ) : preparing ? (
        <div className="preview-preparing" role="status">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <strong>Building your preview</strong>
          <p>The page will appear here when it’s ready, with its styles and scripts.</p>
        </div>
      ) : url && failed ? (
        <div className="preview-failed" role="alert">
          <strong>This page can’t be shown</strong>
          <p>
            <code>{path}</code>{" "}
            {failed === 404
              ? "is missing, or sits in a hidden folder this conversation hasn’t published a preview from."
              : failed === 403
                ? "is outside the files this conversation can show."
                : `could not be loaded (HTTP ${failed}).`}
          </p>
          <button className="secondary tiny" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : url ? (
        <div className={`preview-stage ${device}`}>
          <iframe
            key={`${url}#${nonce}`}
            className="preview-frame"
            style={view.width ? { width: view.width } : undefined}
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
        </div>
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

export function FileViewer({
  sessionId,
  path,
  onClose,
}: {
  sessionId: string;
  path: string;
  onClose(): void;
}) {
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

const PDF_EXT = /\.pdf$/i;
const isPdfDoc = (d: OpenDocument) => d.mimeType === "application/pdf" || PDF_EXT.test(d.name);
const isImageDoc = (d: OpenDocument) => d.mimeType.startsWith("image/") || IMAGE_EXT.test(d.name);
const isTextDoc = (d: OpenDocument) =>
  d.mimeType.startsWith("text/") ||
  ["application/json", "application/xml"].includes(d.mimeType) ||
  /\.(txt|md|csv|json|xml|ya?ml|log|tsx?|jsx?|css|html?)$/i.test(d.name);

/** An uploaded attachment, full-size: PDFs in the browser's PDF viewer, images zoomable, text as text. */
export function DocumentViewer({
  sessionId,
  doc,
  onClose,
}: {
  sessionId: string;
  doc: OpenDocument;
  onClose(): void;
}) {
  const { client } = useApp();
  const url = client?.rawUrl(sessionId, doc.path);
  const pdf = isPdfDoc(doc);
  const image = !pdf && isImageDoc(doc);
  const text = !pdf && !image && isTextDoc(doc);
  const [content, setContent] = useState<string | null>(null);
  const [err, setErr] = useState<string>();
  const [fit, setFit] = useState(true);
  useEffect(() => {
    if (!text || !url) return;
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Could not load ${doc.name} (${r.status})`))))
      .then((c) => live && setContent(c))
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [url, text]);
  return (
    <div className="viewer document-viewer">
      <div className="panel-toolbar">
        <code className="small path" title={doc.path}>
          {doc.name}
        </code>
        <span className="toolbar-actions">
          {image && (
            <button className="ghost tiny" onClick={() => setFit((f) => !f)}>
              {fit ? "Actual size" : "Fit"}
            </button>
          )}
          {url && (
            <a
              className="ghost icon"
              href={url}
              target="_blank"
              rel="noreferrer"
              title="Open in a new tab"
              aria-label="Open in a new tab"
            >
              <IconExternal size={15} />
            </a>
          )}
          <button className="ghost icon" onClick={onClose} aria-label="Close document">
            <IconX size={15} />
          </button>
        </span>
      </div>
      {err && <div className="error pad">{err}</div>}
      {url && pdf && <iframe className="document-frame" src={url} title={doc.name} />}
      {url && image && (
        <div className={`document-image ${fit ? "fit" : ""}`}>
          <img src={url} alt={doc.name} />
        </div>
      )}
      {text && content !== null && <pre className="document-text">{content}</pre>}
      {url && !pdf && !image && !text && (
        <div className="pad muted">
          No preview for this file type.{" "}
          <a href={url} download={doc.name}>
            Download {doc.name}
          </a>
        </div>
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
