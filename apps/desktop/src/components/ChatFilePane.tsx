import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { baseExtensions, languageFor } from "../editor/setup";
import { openFileInCode, openPreviewInCode } from "../file-actions";
import { parentFolders } from "../file-refs";
import { fs, type DirEntry, type FileContent } from "../ipc";
import { isMarkdownPath } from "../markdown-path";
import { basename, useStudio } from "../store";
import { FileIcon } from "./FileIcon";
import { fuzzyFilter } from "./fuzzy";
import { IChevron, ICode, IEye, IFiles, IPlay, IRefresh, IWrap, IX } from "./icons";
import { MarkdownBody } from "./MarkdownPreview";
import { allowProject, useProjectFiles } from "./project-files";
import { SessionPreview } from "./SessionPreview";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const REFRESH_MS = 2500;

/**
 * What the chat view shows beside the conversation: its preview and the project's files, as tabs, with a narrow
 * folder tree. The files are read-only here.
 */
export function ChatFilePane({ root, previewSession }: { root: string; previewSession?: string }) {
  const st = useStudio();
  const { tabs, active, reveal } = st.chatFiles[root] ?? { tabs: [], active: null };
  const previewFront = !!previewSession && !!st.chatPreview?.front;
  const closeTab = (path: string) => {
    if (tabs.length === 1) {
      st.setFilePane(false);
      if (previewSession) st.openChatPreview(previewSession);
    }
    st.closeChatFile(root, path);
  };
  const closePreview = () => {
    if (!tabs.length) st.setFilePane(false);
    st.closeChatPreview();
  };
  const [rendered, setRendered] = useState<ReadonlySet<string>>(new Set());
  const [wrap, setWrap] = useState(false);
  const [version, setVersion] = useState(0);
  const markdown = !!active && isMarkdownPath(active);
  const showRendered = markdown && rendered.has(active);
  const crumbs = active ? active.split("/") : [];

  const toggleRendered = () => {
    if (!active) return;
    setRendered((r) => {
      const next = new Set(r);
      if (!next.delete(active)) next.add(active);
      return next;
    });
  };

  return (
    <div className="st-fp">
      <div className="st-fp-tabs">
        <div className="st-fp-tablist" role="tablist" aria-label="Open files">
          {previewSession && (
            <div className={`st-fp-tab ${previewFront ? "on" : ""}`} title="Preview">
              <button
                className="st-fp-tab-main"
                role="tab"
                aria-selected={previewFront}
                onClick={() => st.openChatPreview(previewSession)}
              >
                <IPlay size={12} />
                <span className="st-ellipsis">Preview</span>
              </button>
              <button
                className="ghost icon tiny"
                aria-label="Close preview"
                title="Close"
                onClick={closePreview}
              >
                <IX size={11} />
              </button>
            </div>
          )}
          {tabs.map((path) => (
            <div
              key={path}
              className={`st-fp-tab ${path === active && !previewFront ? "on" : ""}`}
              title={path}
            >
              <button
                className="st-fp-tab-main"
                role="tab"
                aria-selected={path === active && !previewFront}
                onClick={() => st.activateChatFile(root, path)}
              >
                <FileIcon path={path} size={14} />
                <span className="st-ellipsis">{basename(path)}</span>
              </button>
              <button
                className="ghost icon tiny"
                aria-label={`Close ${basename(path)}`}
                title="Close"
                onClick={() => closeTab(path)}
              >
                <IX size={11} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="ghost icon tiny"
          title="Close this pane and show the project"
          aria-label="Close file pane"
          onClick={st.closeChatPane}
        >
          <IX size={15} />
        </button>
      </div>
      <div className="st-fp-bar">
        <div className="st-fp-crumbs" title={previewFront ? "Preview" : (active ?? root)}>
          <span>{basename(root)}</span>
          {(previewFront ? ["Preview"] : crumbs).map((part, i, parts) => (
            <span key={`${i}:${part}`} className="st-row tight">
              <span>›</span>
              {i === parts.length - 1 ? <strong>{part}</strong> : <span>{part}</span>}
            </span>
          ))}
        </div>
        <div className="st-fp-tools">
          {previewFront ? (
            <button
              className="ghost icon tiny"
              title="Open the preview in the Code view"
              aria-label="Open preview in Code view"
              onClick={() => void openPreviewInCode(st, root, previewSession)}
            >
              <ICode size={15} />
            </button>
          ) : (
            active && (
              <button
                className="ghost icon tiny"
                title="Open in the Code view to edit"
                aria-label="Open in Code view"
                onClick={() => void openFileInCode(st, root, active)}
              >
                <ICode size={15} />
              </button>
            )
          )}
          {markdown && !previewFront && (
            <button
              className={`ghost icon tiny ${showRendered ? "on" : ""}`}
              title={showRendered ? "Show the source" : "Show rendered"}
              aria-label="Toggle rendered Markdown"
              aria-pressed={showRendered}
              onClick={toggleRendered}
            >
              <IEye size={15} />
            </button>
          )}
          {active && !showRendered && !previewFront && (
            <button
              className={`ghost icon tiny ${wrap ? "on" : ""}`}
              title="Wrap long lines"
              aria-label="Wrap long lines"
              aria-pressed={wrap}
              onClick={() => setWrap((w) => !w)}
            >
              <IWrap size={15} />
            </button>
          )}
          {!previewFront && (
            <button
              className="ghost icon tiny"
              title="Read the folder again"
              aria-label="Refresh files"
              onClick={() => setVersion((v) => v + 1)}
            >
              <IRefresh size={15} />
            </button>
          )}
          <button
            className={`ghost icon tiny st-fp-tree-toggle ${st.fileTree && !previewFront ? "on" : ""}`}
            title="Show the folder tree"
            aria-label="Toggle folder tree"
            aria-pressed={st.fileTree && !previewFront}
            onClick={() => {
              st.setFileTree(previewFront || !st.fileTree);
              if (previewFront) st.setFilePane(true);
            }}
          >
            <IFiles size={15} />
          </button>
        </div>
      </div>
      <div className="st-fp-body">
        {/* Stays mounted behind the file tabs, so looking at a file does not restart the page. */}
        {previewSession && (
          <div className="st-fp-preview" hidden={!previewFront}>
            <SessionPreview key={previewSession} sessionId={previewSession} />
          </div>
        )}
        {!previewFront && (
          <div className="st-fp-file">
            {active ? (
              <FileView
                key={`${root}:${active}`}
                root={root}
                path={active}
                rendered={showRendered}
                wrap={wrap}
                line={reveal?.path === active ? reveal : undefined}
                version={version}
              />
            ) : (
              <div className="st-empty">Click a file in the conversation or in the list to view it here.</div>
            )}
          </div>
        )}
        {st.fileTree && !previewFront && (
          <FileTree root={root} active={active} version={version} onOpen={(p) => st.openChatFile(root, p)} />
        )}
      </div>
    </div>
  );
}

function FileView({
  root,
  path,
  rendered,
  wrap,
  line,
  version,
}: {
  root: string;
  path: string;
  rendered: boolean;
  wrap: boolean;
  line?: { line: number; nonce: number };
  version: number;
}) {
  const st = useStudio();
  const [file, setFile] = useState<FileContent>();
  const [image, setImage] = useState<string>();
  const [error, setError] = useState<string>();
  const isImage = IMAGE.test(path);

  // Agents edit files while they are being read, and only the open folder has a watcher.
  useEffect(() => {
    let live = true;
    const load = () =>
      allowProject(root)
        .then((): Promise<FileContent | string> => (isImage ? fs.readImage(root, path) : fs.read(root, path)))
        .then((r) => {
          if (!live) return;
          setError(undefined);
          if (typeof r === "string") setImage(r);
          else setFile((cur) => (cur?.content === r.content && cur.binary === r.binary ? cur : r));
        })
        .catch((e: Error) => live && setError(e.message));
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [root, path, isImage, version]);

  if (error) return <div className="st-empty st-error">{error}</div>;
  if (isImage)
    return image ? (
      <div className="st-fp-image">
        <img src={image} alt={basename(path)} />
      </div>
    ) : (
      <div className="st-empty">Loading…</div>
    );
  if (!file) return <div className="st-empty">Loading…</div>;
  if (file.binary) return <div className="st-empty">This is a binary file and cannot be shown.</div>;
  if (file.tooLarge) return <div className="st-empty">This file is too large to show.</div>;
  if (rendered)
    return (
      <MarkdownBody
        root={root}
        path={path}
        text={file.content}
        onOpenFile={(target) => st.openChatFile(root, target)}
      />
    );
  return <ReadOnlyCode path={path} content={file.content} wrap={wrap} line={line} />;
}

function ReadOnlyCode({
  path,
  content,
  wrap,
  line,
}: {
  path: string;
  content: string;
  wrap: boolean;
  line?: { line: number; nonce: number };
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrapping = useRef(new Compartment());

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: content,
        extensions: baseExtensions(() => {}, [
          languageFor(path) ?? [],
          EditorState.readOnly.of(true),
          wrapping.current.of(wrap ? EditorView.lineWrapping : []),
        ]),
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== content)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } });
  }, [content]);

  useEffect(() => {
    view.current?.dispatch({
      effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  useEffect(() => {
    const v = view.current;
    if (!v || !line) return;
    const at = v.state.doc.line(Math.min(Math.max(1, line.line), v.state.doc.lines));
    v.dispatch({
      selection: { anchor: at.from },
      effects: EditorView.scrollIntoView(at.from, { y: "center" }),
    });
  }, [line?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="st-code">
      <div ref={host} className="st-code-host" />
    </div>
  );
}

function FileTree({
  root,
  active,
  version,
  onOpen,
}: {
  root: string;
  active: string | null;
  version: number;
  onOpen(path: string): void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const files = useProjectFiles(query ? root : undefined, version);
  const results = useMemo(() => fuzzyFilter(files, query, (f) => f, 60), [files, query]);

  useEffect(() => {
    if (active) setOpen((o) => new Set([...o, ...parentFolders(active)]));
  }, [active]);
  useEffect(() => setOpen(new Set(active ? parentFolders(active) : [])), [root]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (dir: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });

  return (
    <nav className="st-file-tree" aria-label="Project files">
      <div className="st-file-tree-search">
        <input
          className="st-input"
          placeholder="Search files"
          aria-label="Search files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
            if (e.key === "Enter" && results[0]) onOpen(results[0]);
          }}
        />
      </div>
      <div className="st-tree">
        {query ? (
          results.map((f) => (
            <button
              key={f}
              className={`st-tree-row st-tree-result ${f === active ? "on" : ""}`}
              title={f}
              onClick={() => onOpen(f)}
            >
              <FileIcon path={f} size={15} />
              <span className="st-ellipsis">{basename(f)}</span>
            </button>
          ))
        ) : (
          <TreeLevel
            root={root}
            dir=""
            depth={0}
            open={open}
            active={active}
            version={version}
            onToggle={toggle}
            onOpen={onOpen}
          />
        )}
      </div>
    </nav>
  );
}

function TreeLevel({
  root,
  dir,
  depth,
  open,
  active,
  version,
  onToggle,
  onOpen,
}: {
  root: string;
  dir: string;
  depth: number;
  open: ReadonlySet<string>;
  active: string | null;
  version: number;
  onToggle(dir: string): void;
  onOpen(path: string): void;
}) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  useEffect(() => {
    let live = true;
    void allowProject(root)
      .then(() => fs.listDir(root, dir))
      .then((list) => {
        if (!live) return;
        setEntries(
          [...list].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)),
        );
      })
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [root, dir, version]);
  return (
    <>
      {entries.map((e) => {
        const expanded = e.isDir && open.has(e.path);
        return (
          <div key={e.path}>
            <button
              className={`st-tree-row ${e.path === active ? "on" : ""}`}
              style={{ paddingLeft: 6 + depth * 12 }}
              title={e.path}
              aria-expanded={e.isDir ? expanded : undefined}
              onClick={() => (e.isDir ? onToggle(e.path) : onOpen(e.path))}
            >
              {e.isDir ? (
                <IChevron size={11} open={expanded} />
              ) : (
                <span style={{ width: 11, flex: "none" }} />
              )}
              <FileIcon path={e.path} dir={e.isDir} open={expanded} size={15} />
              <span className="st-ellipsis">{e.name}</span>
            </button>
            {expanded && (
              <TreeLevel
                root={root}
                dir={e.path}
                depth={depth + 1}
                open={open}
                active={active}
                version={version}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
