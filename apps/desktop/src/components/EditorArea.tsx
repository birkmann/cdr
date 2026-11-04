import { lazy, Suspense } from "react";
import { basename, useStudio, type Tab } from "../store";
import { IX, IFile, IHistory, ICommit, IGoal, IBranch, IWarn } from "./icons";
import { Welcome } from "./Welcome";
import { CodeEditor } from "./CodeEditor";
import { DiffView } from "./DiffView";
import { confirmDialog } from "./dialogs";
import { FileIcon } from "./FileIcon";

const HistoryView = lazy(() => import("./History").then((m) => ({ default: m.HistoryView })));
const CommitDetail = lazy(() => import("./History").then((m) => ({ default: m.CommitDetail })));
const ConflictView = lazy(() => import("./ConflictView").then((m) => ({ default: m.ConflictView })));
const GoalPage = lazy(() => import("./GoalPage").then((m) => ({ default: m.GoalPage })));

function tabLabel(t: Tab): { label: string; icon: JSX.Element; title: string } {
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
    default:
      return { label: "Welcome", icon: <IFile size={13} />, title: "Welcome" };
  }
}

export function EditorArea({ onClone }: { onClone(): void; onPalette(): void }) {
  const st = useStudio();
  const active = st.tabs.find((t) => t.key === st.active) ?? st.tabs[0];
  return (
    <div className="st-editor">
      <div className="st-tabs" role="tablist">
        {st.tabs.map((t) => {
          const { label, icon, title } = tabLabel(t);
          const dirty = t.kind === "file" && st.isDirty(t.path);
          return (
            <div
              key={t.key}
              role="tab"
              aria-selected={t.key === active?.key}
              className={`st-tab ${t.key === active?.key ? "on" : ""}`}
              title={title}
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
      </div>
      <div className="st-editor-body">
        <Suspense fallback={<div className="st-empty">Loading…</div>}>
          {!active || active.kind === "welcome" ? (
            <Welcome onClone={onClone} />
          ) : !st.workspace ? (
            <Welcome onClone={onClone} />
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
