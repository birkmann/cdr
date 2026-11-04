import { useEffect, useMemo, useRef, useState } from "react";
import { fs, type SearchMatch } from "../ipc";
import { useStudio } from "../store";
import { IChevron, IFile } from "./icons";
import { confirmDialog } from "./dialogs";
import { FileIcon } from "./FileIcon";

export function SearchPanel() {
  const st = useStudio();
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [opts, setOpts] = useState({ regex: false, caseSensitive: false, wholeWord: false, include: "" });
  const [result, setResult] = useState<{
    matches: SearchMatch[];
    truncated: boolean;
    filesSearched: number;
  } | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const seq = useRef(0);
  const root = st.workspace?.root;

  useEffect(() => {
    if (!root || !query) {
      setResult(null);
      setError(undefined);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await fs.search(root, query, opts);
        if (n === seq.current) {
          setResult(r);
          setError(undefined);
        }
      } catch (e) {
        if (n === seq.current) setError((e as Error).message);
      } finally {
        if (n === seq.current) setBusy(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [root, query, opts, st.fsVersion]);

  const groups = useMemo(() => {
    const m = new Map<string, SearchMatch[]>();
    for (const x of result?.matches ?? []) m.set(x.path, [...(m.get(x.path) ?? []), x]);
    return [...m.entries()];
  }, [result]);

  if (!root)
    return (
      <div className="st-panel">
        <div className="st-empty">
          <p>Open a folder to search.</p>
        </div>
      </div>
    );

  const toggle = (k: keyof typeof opts) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  return (
    <div className="st-panel">
      <div className="st-panel-head">
        <span className="st-panel-title">Search</span>
      </div>
      <div className="st-search-form">
        <div className="st-search-row">
          <button
            className="ghost icon tiny"
            aria-label="Toggle replace"
            onClick={() => setShowReplace((v) => !v)}
          >
            <IChevron size={12} open={showReplace} />
          </button>
          <div className="st-input-group">
            <input
              className="st-input"
              autoFocus
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search text"
            />
            <button
              className={`st-opt ${opts.caseSensitive ? "on" : ""}`}
              title="Match case"
              onClick={() => toggle("caseSensitive")}
            >
              Aa
            </button>
            <button
              className={`st-opt ${opts.wholeWord ? "on" : ""}`}
              title="Match whole word"
              onClick={() => toggle("wholeWord")}
            >
              ab
            </button>
            <button
              className={`st-opt ${opts.regex ? "on" : ""}`}
              title="Use regular expression"
              onClick={() => toggle("regex")}
            >
              .*
            </button>
          </div>
        </div>
        {showReplace && (
          <div className="st-search-row">
            <span className="st-tree-gap" />
            <div className="st-input-group">
              <input
                className="st-input"
                placeholder="Replace"
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                aria-label="Replacement"
              />
              <button
                className="st-opt"
                title="Replace all"
                disabled={!result?.matches.length}
                onClick={async () => {
                  const paths = groups.map(([p]) => p);
                  if (
                    !(await confirmDialog(
                      `Replace ${result!.matches.length} matches in ${paths.length} files?`,
                    ))
                  )
                    return;
                  const n = await st.attempt(() => fs.replace(root, query, replace, opts, paths));
                  if (n !== undefined) st.toast(`Replaced ${n} matches`, "success");
                }}
              >
                All
              </button>
            </div>
          </div>
        )}
        <input
          className="st-input small"
          placeholder="Files to include, e.g. src/**, *.ts"
          value={opts.include}
          onChange={(e) => setOpts((o) => ({ ...o, include: e.target.value }))}
          aria-label="Files to include"
        />
      </div>
      <div className="st-search-summary muted small">
        {busy ? (
          "Searching…"
        ) : error ? (
          <span className="st-error">{error}</span>
        ) : result ? (
          `${result.matches.length}${result.truncated ? "+" : ""} results in ${groups.length} files`
        ) : (
          ""
        )}
      </div>
      <div className="st-tree">
        {groups.map(([path, ms]) => (
          <div key={path}>
            <button
              className="st-tree-row"
              onClick={() =>
                setCollapsed((c) => {
                  const n = new Set(c);
                  if (n.has(path)) n.delete(path);
                  else n.add(path);
                  return n;
                })
              }
            >
              <IChevron size={12} open={!collapsed.has(path)} />
              <FileIcon path={path} />
              <span className="st-ellipsis">{path}</span>
              <span className="st-count">{ms.length}</span>
            </button>
            {!collapsed.has(path) &&
              ms.map((m, i) => (
                <button
                  key={i}
                  className="st-tree-row st-match"
                  style={{ paddingLeft: 34 }}
                  onClick={() => st.openTab({ kind: "file", path, line: m.line, column: m.column })}
                  title={`${path}:${m.line}`}
                >
                  <span className="st-ellipsis">{highlight(m)}</span>
                </button>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function highlight(m: SearchMatch) {
  const chars = [...m.text];
  const start = m.column - 1;
  const from = Math.max(0, start - 30);
  const pre = chars.slice(from, start).join("");
  const hit = chars.slice(start, start + m.length).join("");
  const post = chars.slice(start + m.length, start + m.length + 120).join("");
  return (
    <>
      {from > 0 ? "…" : ""}
      {pre.trimStart()}
      <mark>{hit}</mark>
      {post}
    </>
  );
}
