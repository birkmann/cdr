import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { fs, type DirEntry, type FileStatus } from "../ipc";
import { basename, dirname, useStudio } from "../store";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { IChevron, IFile, IFolder, IPlus, IRefresh } from "./icons";
import { Welcome } from "./Welcome";
import { confirmDialog } from "./dialogs";
import { FileIcon } from "./FileIcon";
import { ConversationStrip } from "./ConversationFolder";

type Pending = { parent: string; kind: "file" | "dir" } | { rename: string } | null;

export function statusClass(f?: FileStatus): string {
  if (!f) return "";
  if (f.conflicted) return "conflict";
  if (f.worktree === "untracked") return "untracked";
  if (f.index === "added") return "added";
  if (f.worktree === "deleted" || f.index === "deleted") return "deleted";
  return "modified";
}

export function Explorer({ onClone }: { onClone(): void }) {
  const st = useStudio();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [entries, setEntries] = useState<Map<string, DirEntry[]>>(new Map());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const root = st.workspace?.root;

  const load = useCallback(
    async (dir: string) => {
      if (!root) return;
      try {
        const list = await fs.listDir(root, dir);
        setEntries((m) => new Map(m).set(dir, list));
      } catch (e) {
        st.toast((e as Error).message, "error");
      }
    },
    [root, st],
  );

  useEffect(() => {
    setEntries(new Map());
    setExpanded(new Set([""]));
  }, [root]);

  // "Reveal": expand every folder down to the path, select it and scroll it into view once it is listed.
  const scrollTo = useRef<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const path = st.reveal?.path.replace(/^\/+|\/+$/g, "");
    if (!root || !path) return;
    const parts = path.split("/");
    setExpanded((s) => {
      const n = new Set(s);
      for (let i = 1; i <= parts.length; i++) n.add(parts.slice(0, i).join("/"));
      return n;
    });
    setSelected(path);
    scrollTo.current = path;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.reveal?.nonce, root]);
  useEffect(() => {
    const path = scrollTo.current;
    if (!path) return;
    const row = treeRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (!row) return;
    scrollTo.current = null;
    row.scrollIntoView({ block: "center" });
  }, [entries]);

  // Reload expanded folders when files change.
  useEffect(() => {
    if (!root) return;
    for (const d of expanded) void load(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, st.fsVersion, expanded]);

  const statusByPath = useMemo(() => {
    const m = new Map<string, FileStatus>();
    const dirs = new Map<string, string>();
    for (const f of st.status?.files ?? []) {
      m.set(f.path, f);
      let d = dirname(f.path);
      while (d) {
        if (!dirs.has(d)) dirs.set(d, statusClass(f));
        d = dirname(d);
      }
    }
    return { files: m, dirs };
  }, [st.status]);

  if (!root) return <Welcome compact onClone={onClone} />;

  const toggle = (dir: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(dir)) n.delete(dir);
      else n.add(dir);
      return n;
    });

  const commitPending = async (name: string) => {
    const p = pending;
    setPending(null);
    if (!p || !name.trim()) return;
    if ("rename" in p) {
      const to = (dirname(p.rename) ? dirname(p.rename) + "/" : "") + name.trim();
      if (to !== p.rename) await st.attempt(() => fs.rename(root, p.rename, to));
      return;
    }
    const path = (p.parent ? p.parent + "/" : "") + name.trim();
    const ok = await st.attempt(() => fs.create(root, path, p.kind === "dir"));
    if (ok !== undefined && p.kind === "file") st.openTab({ kind: "file", path });
    void load(p.parent);
  };

  const menuFor = (e: DirEntry | null, x: number, y: number) => {
    const dir = e ? (e.isDir ? e.path : dirname(e.path)) : "";
    const items: MenuItem[] = [
      { label: "New file…", onClick: () => (expand(dir), setPending({ parent: dir, kind: "file" })) },
      { label: "New folder…", onClick: () => (expand(dir), setPending({ parent: dir, kind: "dir" })) },
    ];
    if (e) {
      items.push(
        { separator: true, label: "" },
        { label: "Rename…", onClick: () => setPending({ rename: e.path }) },
        { label: "Copy relative path", onClick: () => void navigator.clipboard.writeText(e.path) },
        { label: "Copy path", onClick: () => void navigator.clipboard.writeText(`${root}/${e.path}`) },
        { separator: true, label: "" },
        { label: "Ask agent about this", onClick: () => st.askAgent(`@${e.path} `) },
      );
      const f = statusByPath.files.get(e.path);
      if (f && !e.isDir)
        items.push({
          label: "Open changes",
          onClick: () => st.openTab({ kind: "diff", path: e.path, staged: false }),
        });
      items.push(
        { separator: true, label: "" },
        {
          label: "Delete",
          danger: true,
          onClick: async () => {
            if (
              !(await confirmDialog(
                `Delete ${e.path}${e.isDir ? " and everything in it" : ""}? This cannot be undone.`,
                {
                  danger: true,
                  ok: "Delete",
                },
              ))
            )
              return;
            await st.attempt(() => fs.remove(root, e.path), `Deleted ${e.name}`);
            st.closeTab(`file:${e.path}`);
          },
        },
      );
    }
    setMenu({ x, y, items });
  };
  const expand = (dir: string) => setExpanded((s) => new Set(s).add(dir));

  const renderDir = (dir: string, depth: number): JSX.Element[] => {
    const list = entries.get(dir) ?? [];
    const out: JSX.Element[] = [];
    if (pending && "parent" in pending && pending.parent === dir)
      out.push(
        <NameInput
          key="__new"
          depth={depth}
          isDir={pending.kind === "dir"}
          initial=""
          onDone={commitPending}
        />,
      );
    for (const e of list) {
      if (pending && "rename" in pending && pending.rename === e.path) {
        out.push(
          <NameInput key={e.path} depth={depth} isDir={e.isDir} initial={e.name} onDone={commitPending} />,
        );
        continue;
      }
      const open = expanded.has(e.path);
      const cls = e.isDir ? statusByPath.dirs.get(e.path) : statusClass(statusByPath.files.get(e.path));
      const isActive = st.active === `file:${e.path}`;
      out.push(
        <button
          key={e.path}
          className={`st-tree-row ${cls ?? ""} ${isActive || selected === e.path ? "on" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          title={e.path}
          data-path={e.path}
          onClick={() => {
            setSelected(e.path);
            if (e.isDir) toggle(e.path);
            else st.openTab({ kind: "file", path: e.path });
          }}
          onContextMenu={(ev) => {
            ev.preventDefault();
            setSelected(e.path);
            menuFor(e, ev.clientX, ev.clientY);
          }}
        >
          {e.isDir ? <IChevron size={12} open={open} /> : <span className="st-tree-gap" />}
          <FileIcon path={e.path} dir={e.isDir} open={open} />
          <span className="st-ellipsis">{e.name}</span>
          {!e.isDir && statusByPath.files.get(e.path) && (
            <span className="st-tree-status">{letter(statusByPath.files.get(e.path)!)}</span>
          )}
        </button>,
      );
      if (e.isDir && open) out.push(...renderDir(e.path, depth + 1));
    }
    return out;
  };

  return (
    <div className="st-panel">
      <div className="st-panel-head">
        <span className="st-panel-title">{st.workspace!.name}</span>
        <div className="st-row tight">
          <button
            className="ghost icon tiny"
            title="New file"
            aria-label="New file"
            onClick={() => setPending({ parent: "", kind: "file" })}
          >
            <IPlus size={15} />
          </button>
          <button
            className="ghost icon tiny"
            title="New folder"
            aria-label="New folder"
            onClick={() => setPending({ parent: "", kind: "dir" })}
          >
            <IFolder size={15} />
          </button>
          <button
            className="ghost icon tiny"
            title="Refresh"
            aria-label="Refresh"
            onClick={() => {
              for (const d of expanded) void load(d);
              void st.refreshGit();
            }}
          >
            <IRefresh size={15} />
          </button>
          <button
            className="ghost icon tiny"
            title="Collapse folders"
            aria-label="Collapse folders"
            onClick={() => setExpanded(new Set([""]))}
          >
            <IChevron size={15} />
          </button>
        </div>
      </div>
      <ConversationStrip />
      <div
        ref={treeRef}
        className="st-tree"
        role="tree"
        onContextMenu={(ev) => {
          if (ev.target !== ev.currentTarget) return;
          ev.preventDefault();
          menuFor(null, ev.clientX, ev.clientY);
        }}
      >
        {renderDir("", 0)}
        {(entries.get("") ?? []).length === 0 && !pending && (
          <div className="st-empty">
            <p>This folder is empty.</p>
            <button onClick={() => setPending({ parent: "", kind: "file" })}>New file</button>
            <button
              className="ghost"
              onClick={async () => {
                const dir = await openDialog({ directory: true, title: "Open folder" });
                if (typeof dir === "string") await st.attempt(() => st.openWorkspace(dir));
              }}
            >
              Open another folder
            </button>
          </div>
        )}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function letter(f: FileStatus): string {
  if (f.conflicted) return "!";
  if (f.worktree === "untracked") return "U";
  if (f.index === "added") return "A";
  if (f.worktree === "deleted" || f.index === "deleted") return "D";
  if (f.index === "renamed") return "R";
  return "M";
}

function NameInput({
  depth,
  isDir,
  initial,
  onDone,
}: {
  depth: number;
  isDir: boolean;
  initial: string;
  onDone(name: string): void;
}) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (name: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <div className="st-tree-row editing" style={{ paddingLeft: 8 + depth * 12 }}>
      <span className="st-tree-gap" />
      <FileIcon path={initial || (isDir ? "folder" : "file")} dir={isDir} />
      <input
        className="st-input inline"
        autoFocus
        value={v}
        aria-label={isDir ? "Folder name" : "File name"}
        onFocus={(e) => {
          const dot = initial.lastIndexOf(".");
          e.currentTarget.setSelectionRange(0, dot > 0 && !isDir ? dot : initial.length);
        }}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(v);
          if (e.key === "Escape") finish("");
        }}
        onBlur={() => finish(v)}
      />
    </div>
  );
}

export { basename };
