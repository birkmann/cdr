import { useEffect, useMemo, useRef, useState } from "react";
import { git, type Commit, type CommitFile, type FileDiff, type GraphRow } from "../ipc";
import { timeAgo, useStudio } from "../store";
import { FileDiffView } from "./DiffView";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Splitter, usePanelSize } from "./Splitter";
import { confirmDialog, promptDialog } from "./dialogs";
import { FileIcon } from "./FileIcon";

const ROW = 30;
const LANE = 14;
const COLORS = ["#8ab4ff", "#efae8c", "#89dfa7", "#f4ce78", "#c9a7ff", "#7fd7d7", "#ff9d9d", "#b6c46a"];

function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const x = (l: number) => 10 + l * LANE;
  const mid = ROW / 2;
  return (
    <svg width={width} height={ROW} className="st-graph" aria-hidden="true">
      {row.lanesIn.map((l) => (
        <line
          key={`in${l}`}
          x1={x(l)}
          y1={0}
          x2={x(l)}
          y2={mid}
          stroke={COLORS[l % COLORS.length]}
          strokeWidth={2}
        />
      ))}
      {row.edges.map((e, i) =>
        e.fromLane === e.toLane ? (
          <line
            key={i}
            x1={x(e.fromLane)}
            y1={mid}
            x2={x(e.toLane)}
            y2={ROW}
            stroke={COLORS[e.toLane % COLORS.length]}
            strokeWidth={2}
          />
        ) : (
          <path
            key={i}
            d={`M${x(e.fromLane)} ${mid} C ${x(e.fromLane)} ${ROW}, ${x(e.toLane)} ${mid}, ${x(e.toLane)} ${ROW}`}
            fill="none"
            stroke={COLORS[(e.kind === "mergeParent" ? e.toLane : e.fromLane) % COLORS.length]}
            strokeWidth={2}
          />
        ),
      )}
      <circle
        cx={x(row.lane)}
        cy={mid}
        r={4.5}
        fill={COLORS[row.lane % COLORS.length]}
        stroke="var(--bg)"
        strokeWidth={2}
      />
    </svg>
  );
}

export function HistoryView() {
  const st = useStudio();
  const root = st.workspace!.root;
  const [commits, setCommits] = useState<Commit[]>([]);
  const [graph, setGraph] = useState<GraphRow[]>([]);
  const [all, setAll] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const detail = usePanelSize("morrow.studio.history-detail", 380, 260, 900);
  const reqId = useRef(0);
  const PAGE = 300;

  const load = async (limit: number) => {
    const id = ++reqId.current;
    try {
      const r = await git.log(root, {
        rev: all ? "--all" : undefined,
        limit,
        search: search.trim() || undefined,
      });
      if (id !== reqId.current) return;
      setCommits(r.commits);
      setGraph(r.graph);
      setMore(r.commits.length >= limit);
    } catch (e) {
      st.toast((e as Error).message, "error");
    }
  };
  useEffect(() => {
    const t = setTimeout(() => void load(PAGE), search ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, all, search, st.status?.head]);

  const width = useMemo(() => Math.min(220, 20 + Math.max(1, ...graph.map((g) => g.width)) * LANE), [graph]);
  const showGraph = !search.trim();

  const menuFor = (c: Commit, x: number, y: number) => {
    const run = async (fn: () => Promise<unknown>, ok?: string) => {
      await st.attempt(fn, ok);
      await st.refreshGit();
    };
    setMenu({
      x,
      y,
      items: [
        { label: "Copy commit SHA", onClick: () => void navigator.clipboard.writeText(c.id) },
        {
          label: "Create branch from this commit…",
          onClick: async () => {
            const name = await promptDialog("New branch name");
            if (name) void run(() => git.createBranch(root, name.trim(), c.id), `Created ${name}`);
          },
        },
        {
          label: "Checkout this commit (detached)",
          onClick: async () =>
            (await confirmDialog("Check out this commit in detached HEAD state?")) &&
            void run(() => git.checkout(root, c.id)),
        },
        {
          label: "Cherry-pick onto current branch",
          onClick: () =>
            void run(async () => {
              const r = await git.cherryPick(root, c.id);
              if (!r.ok)
                throw new Error(
                  r.conflicts.length
                    ? "Cherry-pick has conflicts. Resolve them in Source control."
                    : r.message,
                );
            }, "Cherry-picked"),
        },
        { separator: true, label: "" },
        {
          label: "Ask agent to explain this commit",
          onClick: () =>
            st.askAgent(`Explain what commit ${c.id} ("${c.subject}") changes and why. Use git show.`),
        },
      ],
    });
  };

  return (
    <div className="st-history">
      <div className="st-history-list">
        <div className="st-history-toolbar">
          <input
            className="st-input"
            placeholder="Search messages, authors, or SHA"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search history"
          />
          <label className="st-check small">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All branches
          </label>
        </div>
        <div className="st-history-rows" role="list">
          {commits.map((c, i) => (
            <button
              key={c.id}
              role="listitem"
              className={`st-commit-row ${selected === c.id ? "on" : ""}`}
              style={{ height: ROW }}
              onClick={() => setSelected(c.id)}
              onDoubleClick={() => st.openTab({ kind: "commit", id: c.id })}
              onContextMenu={(e) => {
                e.preventDefault();
                menuFor(c, e.clientX, e.clientY);
              }}
            >
              {showGraph && graph[i] && <GraphCell row={graph[i]} width={width} />}
              <span className="st-commit-subject st-ellipsis">
                {c.refs.map((r) => (
                  <span key={r.name} className={`st-ref ${r.kind}`}>
                    {r.name}
                  </span>
                ))}
                {c.subject}
              </span>
              <span className="st-commit-meta muted small st-ellipsis">{c.authorName}</span>
              <span className="st-commit-meta muted small">{timeAgo(c.authorTime)}</span>
              <code className="muted small">{c.shortId}</code>
            </button>
          ))}
          {more && commits.length > 0 && (
            <button className="st-hint-btn" onClick={() => void load(commits.length + PAGE)}>
              Load more
            </button>
          )}
          {!commits.length && <div className="st-empty">No commits{search ? " match" : " yet"}.</div>}
        </div>
      </div>
      {selected && (
        <>
          <Splitter
            direction="vertical"
            size={detail.size}
            onChange={detail.set}
            onReset={detail.reset}
            invert
            label="Resize commit details"
          />
          <div className="st-history-detail" style={{ width: detail.size }}>
            <CommitDetail id={selected} />
          </div>
        </>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

export function CommitDetail({ id }: { id: string }) {
  const st = useStudio();
  const root = st.workspace!.root;
  const [data, setData] = useState<{ commit: Commit; files: CommitFile[] } | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  useEffect(() => {
    setData(null);
    setFile(null);
    void git
      .show(root, id)
      .then((d) => {
        setData(d);
        if (d.files.length === 1) setFile(d.files[0].path);
      })
      .catch((e) => st.toast((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, id]);
  useEffect(() => {
    setDiff(null);
    if (file)
      void git
        .commitFileDiff(root, id, file)
        .then(setDiff)
        .catch(() => {});
  }, [root, id, file]);
  if (!data) return <div className="st-empty">Loading…</div>;
  const c = data.commit;
  const totals = data.files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), {
    add: 0,
    del: 0,
  });
  return (
    <div className="st-commit-detail">
      <h3>{c.subject}</h3>
      {c.body.trim() && <pre className="st-commit-body">{c.body.trim()}</pre>}
      <p className="muted small">
        {c.authorName} &lt;{c.authorEmail}&gt; · {new Date(c.authorTime * 1000).toLocaleString()}
        <br />
        <code>{c.id}</code>
        {c.parents.length > 1 && ` · merge of ${c.parents.map((p) => p.slice(0, 7)).join(", ")}`}
      </p>
      <p className="small">
        {data.files.length} files · <span className="st-add">+{totals.add}</span>{" "}
        <span className="st-del">−{totals.del}</span>
      </p>
      <div className="st-commit-files">
        {data.files.map((f) => (
          <button
            key={f.path}
            className={`st-branch ${file === f.path ? "on" : ""}`}
            onClick={() => setFile(f.path)}
            title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
          >
            <span className={`st-kind ${f.kind}`}>{String(f.kind).slice(0, 1).toUpperCase()}</span>
            <FileIcon path={f.path} />
            <span className="st-ellipsis">{f.path}</span>
            <span className="small">
              <span className="st-add">+{f.additions}</span> <span className="st-del">−{f.deletions}</span>
            </span>
          </button>
        ))}
      </div>
      {file && diff && <FileDiffView diff={diff} />}
    </div>
  );
}
