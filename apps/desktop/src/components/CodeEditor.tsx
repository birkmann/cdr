import { useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { git, on, type Diagnostic, type FileDiff } from "../ipc";
import { useStudio } from "../store";
import {
  baseExtensions,
  languageFor,
  setDiagnostics,
  setLineChanges,
  toCmDiagnostics,
  type LineChange,
} from "../editor/setup";
import { didChange, didClose, didOpen, didSave } from "../editor/lsp";

export function lineChanges(d: FileDiff): LineChange[] {
  const out: LineChange[] = [];
  for (const h of d.hunks) {
    const adds = h.lines.filter((l) => l.kind === "add");
    const dels = h.lines.filter((l) => l.kind === "del").length;
    if (!adds.length && dels) out.push({ line: Math.max(1, h.newStart), kind: "deleted" });
    for (const l of adds) if (l.newNo) out.push({ line: l.newNo, kind: dels ? "modified" : "added" });
  }
  return out;
}

export function CodeEditor({ path, line, column }: { path: string; line?: number; column?: number }) {
  const st = useStudio();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "binary" | "large" | "error">("loading");
  const [error, setError] = useState<string>();
  const root = st.workspace?.root ?? "";
  const lang = useRef(new Compartment());
  const changeTimer = useRef<ReturnType<typeof setTimeout>>();
  const stRef = useRef(st);
  stRef.current = st;

  const save = async () => {
    const v = view.current;
    if (!v) return;
    const s = stRef.current;
    s.updateBuffer(path, v.state.doc.toString());
    await s.attempt(() => s.saveBuffer(path));
    void didSave(root, path, v.state.doc.toString());
    void refreshGutter();
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const refreshGutter = async () => {
    const v = view.current;
    if (!v || !stRef.current.isRepo) return;
    try {
      const d = await git.diffFile(root, path, false);
      view.current?.dispatch({ effects: setLineChanges.of(lineChanges(d)) });
    } catch {
      view.current?.dispatch({ effects: setLineChanges.of([]) });
    }
  };

  // Create the editor for this file.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void (async () => {
      try {
        const b = await st.loadBuffer(path);
        if (cancelled) return;
        if (b.binary) return setState("binary");
        if (b.tooLarge) return setState("large");
        const language = languageFor(path);
        const v = new EditorView({
          parent: host.current!,
          state: EditorState.create({
            doc: b.content,
            extensions: baseExtensions(
              () => void saveRef.current(),
              [
                lang.current.of(language ?? []),
                EditorView.updateListener.of((u) => {
                  if (!u.docChanged) return;
                  const text = u.state.doc.toString();
                  stRef.current.updateBuffer(path, text);
                  clearTimeout(changeTimer.current);
                  changeTimer.current = setTimeout(() => void didChange(root, path, text), 300);
                }),
              ],
            ),
          }),
        });
        view.current = v;
        setState("ready");
        void didOpen(root, path, b.content);
        void refreshGutter();
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(changeTimer.current);
      view.current?.destroy();
      view.current = null;
      void didClose(root, path);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, path]);

  // Reload when the file changed on disk and the buffer has no unsaved edits.
  useEffect(() => {
    const v = view.current;
    const b = st.buffers.get(path);
    if (!v || !b) return;
    const cur = v.state.doc.toString();
    if (b.content !== cur && b.content === b.saved) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: b.content } });
      void refreshGutter();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.bufferVersion]);

  useEffect(() => {
    void refreshGutter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.status]);

  // Jump to a requested position.
  useEffect(() => {
    const v = view.current;
    if (!v || !line || state !== "ready") return;
    const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
    const pos = Math.min(l.from + Math.max(0, (column ?? 1) - 1), l.to);
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    v.focus();
  }, [line, column, state]);

  // Diagnostics pushed by language servers.
  useEffect(
    () =>
      on<{ root: string; path: string; diagnostics: Diagnostic[] }>("lsp://diagnostics", (d) => {
        const v = view.current;
        if (!v || d.root !== root || d.path !== path) return;
        v.dispatch(setDiagnostics(v.state, toCmDiagnostics(v.state, d.diagnostics)));
      }),
    [root, path],
  );

  return (
    <div className="st-code">
      {state === "binary" && <div className="st-empty">This is a binary file and cannot be shown.</div>}
      {state === "large" && <div className="st-empty">This file is too large to open in the editor.</div>}
      {state === "error" && <div className="st-empty st-error">{error}</div>}
      <div
        ref={host}
        className="st-code-host"
        style={{ display: state === "ready" || state === "loading" ? undefined : "none" }}
      />
    </div>
  );
}
