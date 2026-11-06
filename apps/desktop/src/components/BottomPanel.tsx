import { useEffect, useRef, useState } from "react";
import { harness, lsp, on, type Diagnostic } from "../ipc";
import { useStudio, type BottomView } from "../store";
import { TerminalView } from "./Terminal";
import { IPlus, IX, IWarn } from "./icons";

interface Term {
  id: number;
  title: string;
  command?: string;
  /** Folder inside the workspace to start in (default: the workspace root). */
  cwd?: string;
  exited?: boolean;
}

let nextTerm = 1;
/** Commands asked for while the panel was closed; it opens and starts them on mount. */
let queued: RunRequest[] = [];

function newTerm(command?: string, cwd?: string, title?: string): Term {
  return {
    id: nextTerm++,
    title: title?.slice(0, 24) || (command ? command.split(" ")[0] : "shell"),
    command,
    cwd,
  };
}

export function BottomPanel() {
  const st = useStudio();
  const [terms, setTerms] = useState<Term[]>(() => {
    const start = queued.map((r) => newTerm(r.command, r.cwd, r.title));
    queued = [];
    return start;
  });
  const [activeTerm, setActiveTerm] = useState<number | null>(() => terms.at(-1)?.id ?? null);
  const root = st.workspace?.root;
  const view = st.bottom ?? "terminal";

  const seenRoot = useRef(root);
  useEffect(() => {
    if (seenRoot.current === root) return;
    seenRoot.current = root;
    setTerms([]);
    setActiveTerm(null);
  }, [root]);
  useEffect(() => {
    if (view === "terminal" && root && terms.length === 0) addTerm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, root, terms.length]);
  // Other components can run a command in a new terminal.
  useEffect(() => {
    const h = () => {
      st.setBottom("terminal");
      for (const r of queued.splice(0)) addTerm(r.command, r.cwd, r.title);
    };
    window.addEventListener("studio:run-in-terminal", h);
    return () => window.removeEventListener("studio:run-in-terminal", h);
  });

  function addTerm(command?: string, cwd?: string, title?: string) {
    const t = newTerm(command, cwd, title);
    setTerms((ts) => [...ts, t]);
    setActiveTerm(t.id);
  }
  const closeTerm = (id: number) => {
    setTerms((ts) => {
      const next = ts.filter((t) => t.id !== id);
      if (activeTerm === id) setActiveTerm(next.at(-1)?.id ?? null);
      return next;
    });
  };

  const tab = (v: BottomView, label: string, extra?: React.ReactNode) => (
    <button className={`st-ptab ${view === v ? "on" : ""}`} onClick={() => st.setBottom(v)}>
      {label}
      {extra}
    </button>
  );
  const problems = useProblems(root);
  return (
    <div className="st-bottom-inner">
      <div className="st-bottom-bar">
        {tab("terminal", "Terminal")}
        {tab(
          "problems",
          "Problems",
          problems.length > 0 && <span className="st-count">{problems.length}</span>,
        )}
        {tab("output", "Harness log")}
        <div className="st-grow" />
        {view === "terminal" && (
          <>
            {terms.map((t) => (
              <span
                key={t.id}
                className={`st-term-tab ${t.id === activeTerm ? "on" : ""} ${t.exited ? "exited" : ""}`}
              >
                <button
                  className="ghost tiny"
                  onClick={() => setActiveTerm(t.id)}
                  title={t.command ?? t.title}
                >
                  {t.title}
                </button>
                <button
                  className="ghost icon tiny"
                  aria-label={`Close ${t.title}`}
                  onClick={() => closeTerm(t.id)}
                >
                  <IX size={11} />
                </button>
              </span>
            ))}
            <button
              className="ghost icon tiny"
              title="New terminal"
              aria-label="New terminal"
              disabled={!root}
              onClick={() => addTerm()}
            >
              <IPlus size={14} />
            </button>
          </>
        )}
        <button
          className="ghost icon tiny"
          title="Close panel"
          aria-label="Close panel"
          onClick={() => st.setBottom(null)}
        >
          <IX size={14} />
        </button>
      </div>
      <div className="st-bottom-body">
        {view === "terminal" &&
          (root ? (
            terms.map((t) => (
              <TerminalView
                key={t.id}
                root={t.cwd ?? root}
                command={t.command}
                visible={t.id === activeTerm}
                onExit={() => setTerms((ts) => ts.map((x) => (x.id === t.id ? { ...x, exited: true } : x)))}
                onTitle={(title) =>
                  setTerms((ts) => ts.map((x) => (x.id === t.id ? { ...x, title: title.slice(0, 24) } : x)))
                }
              />
            ))
          ) : (
            <div className="st-empty">Open a folder to use the terminal.</div>
          ))}
        {view === "problems" && <Problems items={problems} />}
        {view === "output" && <HarnessLog />}
      </div>
    </div>
  );
}

function useProblems(root?: string): Diagnostic[] {
  const [items, setItems] = useState<Diagnostic[]>([]);
  useEffect(() => {
    if (!root) return setItems([]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      void lsp
        .diagnostics(root)
        .then(setItems)
        .catch(() => {});
    load();
    const un = on<{ root: string }>("lsp://diagnostics", (d) => {
      if (d.root !== root) return;
      clearTimeout(timer);
      timer = setTimeout(load, 200);
    });
    return () => {
      un();
      clearTimeout(timer);
    };
  }, [root]);
  return items;
}

function Problems({ items }: { items: Diagnostic[] }) {
  const st = useStudio();
  if (!items.length)
    return (
      <div className="st-empty">
        No problems detected. Language servers start when you open a TypeScript, JavaScript, Rust, Python, or
        Go file and the server is installed.
      </div>
    );
  const sorted = [...items].sort(
    (a, b) => sev(a) - sev(b) || a.path.localeCompare(b.path) || a.line - b.line,
  );
  return (
    <div className="st-problems">
      <div className="st-row tight st-problems-bar">
        <button
          className="ghost tiny"
          onClick={() =>
            st.askAgent(
              `Fix these problems:\n${sorted
                .filter((d) => d.severity === "error")
                .slice(0, 40)
                .map((d) => `- ${d.path}:${d.line}:${d.column} ${d.message}`)
                .join("\n")}`,
            )
          }
        >
          Ask agent to fix errors
        </button>
      </div>
      {sorted.map((d, i) => (
        <button
          key={i}
          className={`st-problem ${d.severity}`}
          onClick={() => st.openTab({ kind: "file", path: d.path, line: d.line, column: d.column })}
        >
          <IWarn size={13} />
          <span className="st-ellipsis">{d.message}</span>
          <span className="muted small">
            {d.source ? `${d.source} · ` : ""}
            {d.path}:{d.line}:{d.column}
          </span>
        </button>
      ))}
    </div>
  );
}
const sev = (d: Diagnostic) => ({ error: 0, warning: 1, info: 2, hint: 3 })[d.severity];

function HarnessLog() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const load = () =>
      void harness
        .logs()
        .then(setLines)
        .catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  return <pre className="st-log">{lines.join("\n") || "No output yet."}</pre>;
}

interface RunRequest {
  command: string;
  cwd?: string;
  title?: string;
}

/** Open a new terminal running a command (used by tasks, actions and the chat's launch buttons). */
export function runInTerminal(command: string, opts?: { cwd?: string; title?: string }) {
  queued.push({ command, ...opts });
  window.dispatchEvent(new CustomEvent("studio:run-in-terminal"));
}
