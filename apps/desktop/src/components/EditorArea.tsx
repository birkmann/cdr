import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useApp } from "@web/app-state";
import { basename, MAX_GROUPS, tabKey, useStudio, type Group, type Tab } from "../store";
import {
  IX,
  IFile,
  IHistory,
  ICommit,
  IGoal,
  IWarn,
  IPlay,
  ISplit,
  IEye,
  ICode,
  IChat,
  IExternal,
} from "./icons";
import { isHtmlPath } from "../browser-preview";
import { useOpenInBrowser } from "./open-in-browser";
import { isMarkdownPath } from "../markdown-path";
import { dragKind, readTabDrag, startTabDrag, useActiveDrag } from "./dnd";
import { Welcome } from "./Welcome";
import { ChatTab } from "./AgentPanel";
import { CodeEditor } from "./CodeEditor";
import { DiffView } from "./DiffView";
import { confirmDialog } from "./dialogs";
import { FileIcon } from "./FileIcon";

const HistoryView = lazy(() => import("./History").then((m) => ({ default: m.HistoryView })));
const CommitDetail = lazy(() => import("./History").then((m) => ({ default: m.CommitDetail })));
const ConflictView = lazy(() => import("./ConflictView").then((m) => ({ default: m.ConflictView })));
const GoalPage = lazy(() => import("./GoalPage").then((m) => ({ default: m.GoalPage })));
const MarkdownPreview = lazy(() => import("./MarkdownPreview").then((m) => ({ default: m.MarkdownPreview })));
const SessionPreview = lazy(() => import("./SessionPreview").then((m) => ({ default: m.SessionPreview })));

function tabLabel(
  t: Tab,
  sessionTitle?: (id: string) => string | undefined,
): { label: string; icon: JSX.Element; title: string } {
  switch (t.kind) {
    case "file":
      return { label: basename(t.path), icon: <FileIcon path={t.path} size={15} />, title: t.path };
    case "diff":
      return {
        label: `${basename(t.path)} (${t.staged ? "staged" : "changes"})`,
        icon: <FileIcon path={t.path} size={15} />,
        title: t.path,
      };
    case "commit":
      return { label: `Commit ${t.id.slice(0, 7)}`, icon: <ICommit size={13} />, title: t.id };
    case "history":
      return { label: "History", icon: <IHistory size={13} />, title: "Git history" };
    case "goal":
      return { label: "Goal", icon: <IGoal size={13} />, title: t.id };
    case "conflict":
      return { label: `${basename(t.path)} (conflict)`, icon: <IWarn size={13} />, title: t.path };
    case "preview": {
      const name = sessionTitle?.(t.sessionId);
      return {
        label: name ? `Preview · ${name}` : "Preview",
        icon: <IPlay size={13} />,
        title: `Live preview${name ? ` of “${name}”` : ""}`,
      };
    }
    case "chat": {
      const name = t.sessionId ? (sessionTitle?.(t.sessionId) ?? "Conversation") : "New conversation";
      return { label: name, icon: <IChat size={13} />, title: name };
    }
    default:
      return { label: "Welcome", icon: <IFile size={13} />, title: "Welcome" };
  }
}

/** Where a drag over a group's body would drop: into the group, or into a new/other group beside it. */
type Zone = "center" | "right" | "left";

export function EditorArea({ onClone }: { onClone(): void; onPalette(): void }) {
  const st = useStudio();
  const drag = useActiveDrag();
  const groups: Group[] = Array.from({ length: st.groupCount }, (_, g) => g);
  return (
    <div className={`st-editor-groups ${st.groupCount > 1 ? "split" : ""}`}>
      {groups.map((g) => (
        <EditorGroup key={g} group={g} dragging={drag === "tab"} onClone={onClone} />
      ))}
    </div>
  );
}

function EditorGroup({ group, dragging, onClone }: { group: Group; dragging: boolean; onClone(): void }) {
  const st = useStudio();
  const { sessions } = useApp();
  const sessionTitle = (id: string) => sessions.find((s) => s.id === id)?.title;
  const tabs = st.tabs.filter((t) => st.tabGroup(t.key) === group);
  const active = tabs.find((t) => t.key === st.activeIn[group]) ?? tabs[0];
  const [over, setOver] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  // Keep the active tab visible in a narrow group's tab strip.
  useEffect(() => {
    strip.current?.querySelector(".st-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.key, st.groupCount]);
  const [zone, setZone] = useState<Zone | null>(null);
  /** Markdown tabs currently shown rendered instead of as source. */
  const [rendered, setRendered] = useState<ReadonlySet<string>>(new Set());
  const markdown = active?.kind === "file" && isMarkdownPath(active.path);
  const html = active?.kind === "file" && isHtmlPath(active.path) ? active.path : undefined;
  const openInBrowser = useOpenInBrowser();
  const showRendered = markdown && rendered.has(active.key);
  const toggleRendered = () => {
    if (!active) return;
    setRendered((r) => {
      const next = new Set(r);
      if (!next.delete(active.key)) next.add(active.key);
      return next;
    });
  };

  /** Drops an editor-tab drag into `target`, before `before` if given. */
  const drop = (e: React.DragEvent, target: Group, before?: string) => {
    const d = readTabDrag(e);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    if ("key" in d) st.moveTab(d.key, target, before);
    else {
      // Both are queued state updates: the tab opens, then moves into place.
      st.openTab(d.open, { group: target });
      if (before) st.moveTab(tabKey(d.open), target, before);
    }
  };
  const split = st.groupCount > 1;
  const canSplit = st.groupCount < MAX_GROUPS;
  /** Drops onto the edges split off a new group on that side while there is room for one. */
  const zoneFor = (e: React.DragEvent): Zone => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (canSplit && x > 0.7) return "right";
    if (canSplit && x < 0.3) return "left";
    return "center";
  };
  const dropZone = (e: React.DragEvent, z: Zone) => {
    if (z === "center") return drop(e, group);
    const d = readTabDrag(e);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const at = z === "right" ? group + 1 : group;
    if ("key" in d) st.splitTab(d.key, at);
    else {
      st.openTab(d.open, { group });
      st.splitTab(tabKey(d.open), at);
    }
  };

  return (
    <div
      className={`st-editor ${split && st.focusedGroup === group ? "focused" : ""}`}
      onMouseDownCapture={() => st.focusGroup(group)}
    >
      <div
        ref={strip}
        className="st-tabs"
        role="tablist"
        onDragOver={(e) => {
          if (dragKind(e) !== "tab") return;
          e.preventDefault();
        }}
        onDrop={(e) => drop(e, group)}
      >
        {tabs.map((t) => {
          const { label, icon, title } = tabLabel(t, sessionTitle);
          const dirty = t.kind === "file" && st.isDirty(t.path);
          return (
            <div
              key={t.key}
              role="tab"
              aria-selected={t.key === active?.key}
              className={`st-tab ${t.key === active?.key ? "on" : ""} ${over === t.key ? "drop-before" : ""}`}
              title={title}
              draggable
              onDragStart={(e) => startTabDrag(e, { key: t.key })}
              onDragOver={(e) => {
                if (dragKind(e) !== "tab") return;
                e.preventDefault();
                setOver(t.key);
              }}
              onDragLeave={() => setOver((o) => (o === t.key ? null : o))}
              onDrop={(e) => {
                setOver(null);
                drop(e, group, t.key);
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  close(t);
                }
              }}
              onClick={() => st.setActive(t.key)}
            >
              {icon}
              <span className="st-ellipsis">{label}</span>
              <button
                className={`st-tab-close ${dirty ? "dirty" : ""}`}
                aria-label={`Close ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  close(t);
                }}
              >
                {dirty ? <span className="st-dirty-dot" /> : <IX size={12} />}
              </button>
            </div>
          );
        })}
        <div className="st-tabs-fill" />
        {markdown && (
          <button
            className={`ghost icon tiny st-split-btn ${showRendered ? "on" : ""}`}
            title={showRendered ? "Show source" : "Show rendered Markdown"}
            aria-label={showRendered ? "Show source" : "Show rendered Markdown"}
            aria-pressed={showRendered}
            onClick={toggleRendered}
          >
            {showRendered ? <ICode size={15} /> : <IEye size={15} />}
          </button>
        )}
        {html && (
          <button
            className="ghost icon tiny st-split-btn"
            title="Open in browser (live preview: reloads as files change)"
            aria-label="Open in browser"
            onClick={() => void openInBrowser(html)}
          >
            <IExternal size={15} />
          </button>
        )}
        {canSplit && active && active.kind !== "welcome" && tabs.length > 1 && (
          <button
            className="ghost icon tiny st-split-btn"
            title="Split editor right (or drag a tab to an editor's edge)"
            aria-label="Split editor right"
            onClick={() => st.splitTab(active.key, group + 1)}
          >
            <ISplit size={15} />
          </button>
        )}
      </div>
      <div className="st-editor-body">
        <Suspense fallback={<div className="st-empty">Loading…</div>}>
          {!active || active.kind === "welcome" ? (
            <Welcome onClone={onClone} />
          ) : active.kind === "preview" ? (
            <SessionPreview key={active.sessionId} sessionId={active.sessionId} />
          ) : active.kind === "chat" ? (
            <ChatTab tab={active} group={group} />
          ) : !st.workspace ? (
            <Welcome onClone={onClone} />
          ) : active.kind === "file" && showRendered ? (
            <MarkdownPreview key={active.path} path={active.path} />
          ) : active.kind === "file" ? (
            <CodeEditor key={active.path} path={active.path} line={active.line} column={active.column} />
          ) : active.kind === "diff" ? (
            <DiffView key={active.key} path={active.path} staged={active.staged} />
          ) : active.kind === "history" ? (
            <HistoryView />
          ) : active.kind === "commit" ? (
            <div className="st-scroll-page">
              <CommitDetail id={active.id} />
            </div>
          ) : active.kind === "conflict" ? (
            <ConflictView key={active.path} path={active.path} />
          ) : active.kind === "goal" ? (
            <GoalPage key={active.id} id={active.id} />
          ) : null}
        </Suspense>
        {dragging && (
          <div
            className="st-drop-overlay"
            onDragOver={(e) => {
              if (dragKind(e) !== "tab") return;
              e.preventDefault();
              setZone(zoneFor(e));
            }}
            onDragLeave={() => setZone(null)}
            onDrop={(e) => {
              const z = zoneFor(e);
              setZone(null);
              dropZone(e, z);
            }}
          >
            {zone && (
              <div className={`st-drop-hint ${zone}`}>
                <span>{zone === "right" ? "Split right" : zone === "left" ? "Split left" : "Open here"}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  async function close(t: Tab) {
    if (t.kind === "file" && st.isDirty(t.path)) {
      const save = await confirmDialog(
        `${t.path} has unsaved changes. Save before closing? Cancel discards the changes.`,
        {
          ok: "Save",
        },
      );
      if (save) void st.saveBuffer(t.path).then(() => st.closeTab(t.key));
      else {
        const b = st.buffers.get(t.path);
        if (b) b.content = b.saved;
        st.buffers.delete(t.path);
        st.closeTab(t.key);
      }
      return;
    }
    if (t.kind === "file") st.buffers.delete(t.path);
    st.closeTab(t.key);
  }
}
