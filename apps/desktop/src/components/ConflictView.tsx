import { useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { git, type ConflictFile } from "../ipc";
import { useStudio } from "../store";
import { baseExtensions, languageFor } from "../editor/setup";
import { resolveMarkers } from "./conflict-markers";
import { confirmDialog } from "./dialogs";

export function ConflictView({ path }: { path: string }) {
  const st = useStudio();
  const root = st.workspace!.root;
  const [file, setFile] = useState<ConflictFile | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    void git
      .conflict(root, path)
      .then(setFile)
      .catch((e) => st.toast((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, path]);
  useEffect(() => {
    if (!file || !host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: file.merged,
        extensions: baseExtensions(() => {}, [languageFor(path) ?? []]),
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, [file, path]);
  const set = (text: string) =>
    view.current?.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: text } });
  const text = () => view.current?.state.doc.toString() ?? "";
  const remaining = () => (text().match(/^<<<<<<< /gm) ?? []).length;
  return (
    <div className="st-conflict">
      <div className="st-diffview-head">
        <div>
          <strong>{path}</strong> <span className="muted small">merge conflict</span>
        </div>
        <div className="st-row tight">
          <button
            className="ghost tiny"
            onClick={() => set(resolveMarkers(text(), "ours"))}
            title="Keep the current branch's version of every conflict"
          >
            Accept current
          </button>
          <button
            className="ghost tiny"
            onClick={() => set(resolveMarkers(text(), "theirs"))}
            title="Keep the incoming version of every conflict"
          >
            Accept incoming
          </button>
          <button className="ghost tiny" onClick={() => set(resolveMarkers(text(), "both"))}>
            Accept both
          </button>
          <button
            className="ghost tiny"
            onClick={() =>
              st.askAgent(
                `Resolve the merge conflict in @${path}. Keep the intent of both sides, remove all conflict markers, and verify the build. Do not commit.`,
              )
            }
          >
            Ask agent
          </button>
          <button
            className="tiny"
            onClick={async () => {
              const n = remaining();
              if (n && !(await confirmDialog(`${n} conflict markers remain. Mark as resolved anyway?`)))
                return;
              await st.attempt(() => git.resolve(root, path, text()), `${path} resolved`);
              await st.refreshGit();
              st.closeTab(`conflict:${path}`);
            }}
          >
            Mark resolved
          </button>
        </div>
      </div>
      {file && (file.ours !== undefined || file.theirs !== undefined) && (
        <div className="st-conflict-sides">
          <details>
            <summary>Current (ours)</summary>
            <pre>{file.ours ?? "(deleted)"}</pre>
          </details>
          <details>
            <summary>Incoming (theirs)</summary>
            <pre>{file.theirs ?? "(deleted)"}</pre>
          </details>
          {file.base !== undefined && (
            <details>
              <summary>Common ancestor</summary>
              <pre>{file.base}</pre>
            </details>
          )}
        </div>
      )}
      <div ref={host} className="st-code-host" />
    </div>
  );
}
