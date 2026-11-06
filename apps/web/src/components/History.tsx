import { useEffect, useMemo, useState } from "react";
import type { SessionLogResponse } from "@harness/client";
import { relativeTime, useApp } from "../app-state";
import {
  argsSummary,
  buildTranscript,
  entryText,
  groupDeltas,
  parseLog,
  type LogRecord,
  type RecordRow,
  type TranscriptEntry,
} from "../history-log";
import { FileViewer } from "./CodePanel";
import { highlight, Markdown } from "./Markdown";
import { IconCheck, IconChevronRight, IconCopy, IconFile, IconRefresh } from "./icons";

const PAGE = 200;
type View = "transcript" | "records" | "raw";
const VIEWS: { id: View; label: string }[] = [
  { id: "transcript", label: "Transcript" },
  { id: "records", label: "Records" },
  { id: "raw", label: "Raw" },
];

/** Where this conversation is stored on disk, what files it used, and its event log. */
export function History({ sessionId, refreshKey }: { sessionId: string; refreshKey: string }) {
  const { client } = useApp();
  const [log, setLog] = useState<SessionLogResponse>();
  const [err, setErr] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [view, setView] = useState<View>("transcript");
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .sessionLog(sessionId)
      .then((r) => {
        if (cancelled) return;
        setLog(r);
        setErr(undefined);
      })
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, refreshKey, nonce]);

  const records = useMemo<LogRecord[]>(() => (log ? parseLog(log.content, log.records) : []), [log]);
  const transcript = useMemo(() => buildTranscript(records), [records]);
  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of records) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  }, [records]);
  const q = query.toLowerCase();
  const rows = useMemo(
    () =>
      groupDeltas(
        records.filter((r) => (!type || r.type === type) && (!q || r.raw.toLowerCase().includes(q))),
      ),
    [records, type, q],
  );
  const entries = useMemo(
    () => (q ? transcript.filter((e) => entryText(e).toLowerCase().includes(q)) : transcript),
    [transcript, q],
  );
  const toggle = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  if (openFile) return <FileViewer sessionId={sessionId} path={openFile} onClose={() => setOpenFile(null)} />;
  if (err)
    return (
      <div className="pad">
        <p className="error">Couldn't load this conversation's log: {err}</p>
        <button className="secondary" onClick={() => setNonce((n) => n + 1)}>
          <IconRefresh size={14} /> Try again
        </button>
      </div>
    );
  if (!log) return <div className="muted pad">Loading the conversation log…</div>;

  const download = () => {
    const url = URL.createObjectURL(new Blob([log.content], { type: "application/x-ndjson" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionId}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };
  // Records read newest first (the end is what people look for); the transcript reads top to bottom.
  const shownRows = rows.slice(-limit).reverse();
  const shownEntries = entries.slice(-limit);
  const hidden =
    view === "transcript" ? entries.length - shownEntries.length : rows.length - shownRows.length;
  const more = hidden > 0 && (
    <div className="pad">
      <button className="secondary" onClick={() => setLimit((l) => l + PAGE)}>
        Show {Math.min(PAGE, hidden)} earlier {view === "transcript" ? "entries" : "rows"}
      </button>
    </div>
  );
  return (
    <div className="chatlog">
      <section className="chatlog-section">
        <div className="group-head">Stored at</div>
        <div className="chatlog-path">
          <code title={log.path}>{log.path}</code>
          <CopyButton text={log.path} label="Copy file path" />
        </div>
        <p className="muted small chatlog-meta">
          {formatBytes(log.bytes)} · {log.records.toLocaleString()} records · updated{" "}
          {relativeTime(log.modifiedAt)}
          {log.truncated && <> · showing the most recent {formatBytes(log.content.length)}</>}
        </p>
        <div className="chatlog-actions">
          <button className="secondary" onClick={download}>
            Download {log.truncated ? "shown records" : ".jsonl"}
          </button>
          <button className="ghost" onClick={() => setNonce((n) => n + 1)}>
            <IconRefresh size={14} /> Refresh
          </button>
        </div>
      </section>

      <section className="chatlog-section">
        <div className="group-head">Files used ({log.files.length})</div>
        {log.files.length === 0 && (
          <p className="muted small pad-x">This conversation hasn't referenced any project files.</p>
        )}
        {log.files.map((f) => (
          <button
            key={f.path}
            className="tree-row chatlog-file"
            disabled={!f.viewable}
            title={f.viewable ? `Open ${f.path}` : "Missing, or outside what this conversation may show"}
            onClick={() => setOpenFile(f.path)}
          >
            <IconFile size={14} />
            <span className="chatlog-file-path">{f.path}</span>
            <span className="chatlog-uses">{f.uses.join(", ")}</span>
          </button>
        ))}
      </section>

      <section className="chatlog-section">
        <div className="group-head">Conversation log</div>
        <div className="panel-toolbar chatlog-toolbar">
          <div className="chatlog-views" role="tablist" aria-label="Log view">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                role="tab"
                aria-selected={view === v.id}
                className={`ghost ${view === v.id ? "on" : ""}`}
                onClick={() => {
                  setView(v.id);
                  setLimit(PAGE);
                }}
              >
                {v.label}
              </button>
            ))}
          </div>
          {view !== "transcript" && (
            <select
              aria-label="Filter by event type"
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setLimit(PAGE);
              }}
            >
              <option value="">All types ({records.length})</option>
              {types.map(([t, n]) => (
                <option key={t} value={t}>
                  {t} ({n})
                </option>
              ))}
            </select>
          )}
          <input
            aria-label="Search the conversation log"
            placeholder="Search…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
          />
        </div>
        {view === "transcript" && (
          <>
            {log.truncated && !hidden && (
              <p className="muted small pad-x">Earlier history isn't loaded: this log is larger than 4 MB.</p>
            )}
            {more}
            <div className="chatlog-transcript">
              {shownEntries.map((e) => (
                <TranscriptItem
                  key={e.key}
                  entry={e}
                  open={expanded.has(e.key)}
                  toggle={() => toggle(e.key)}
                />
              ))}
            </div>
            {!entries.length && <p className="muted center">{q ? "Nothing matches." : "No messages yet."}</p>}
          </>
        )}
        {view === "records" && (
          <>
            <div className="chatlog-records">
              {shownRows.map((row) => (
                <RecordRowView
                  key={row.key}
                  row={row}
                  open={expanded.has(row.key)}
                  toggle={() => toggle(row.key)}
                />
              ))}
            </div>
            {!rows.length && <p className="muted center">No matching records.</p>}
            {more}
          </>
        )}
        {view === "raw" && (
          <>
            <pre className="chatlog-raw">
              {shownRows
                .flatMap((row) => [...row.records].reverse())
                .map((r) => r.raw)
                .join("\n")}
            </pre>
            {more}
          </>
        )}
      </section>
    </div>
  );
}

function time(ts?: string) {
  return (
    ts && (
      <time className="muted small" dateTime={ts} title={ts}>
        {new Date(ts).toLocaleTimeString()}
      </time>
    )
  );
}

function TranscriptItem({
  entry: e,
  open,
  toggle,
}: {
  entry: TranscriptEntry;
  open: boolean;
  toggle(): void;
}) {
  if (e.kind === "message")
    return (
      <div className={`chatlog-msg ${e.role}`}>
        <div className="chatlog-msg-head">
          <strong>
            {e.role === "user" ? "You" : e.agent && e.agent !== "executor" ? e.agent : "Assistant"}
          </strong>
          {e.partial && <span className="muted small">(incomplete)</span>}
          {time(e.ts)}
        </div>
        {e.role === "user" ? <p className="chatlog-user-text">{e.text}</p> : <Markdown text={e.text} />}
      </div>
    );
  if (e.kind === "thinking")
    return (
      <div className="chatlog-fold">
        <button className="tree-row" aria-expanded={open} onClick={toggle}>
          <IconChevronRight size={12} className={`chev ${open ? "open" : ""}`} />
          <span className="chatlog-type muted">Thinking</span>
          {time(e.ts)}
        </button>
        {open && <pre className="chatlog-text">{e.text}</pre>}
      </div>
    );
  if (e.kind === "tool")
    return (
      <div className="chatlog-fold">
        <button className="tree-row" aria-expanded={open} onClick={toggle}>
          <IconChevronRight size={12} className={`chev ${open ? "open" : ""}`} />
          <span className={`chatlog-tool-status ${e.result ? (e.result.ok ? "ok" : "bad") : ""}`}>
            {e.result ? (e.result.ok ? "✓" : "✕") : "…"}
          </span>
          <span className="chatlog-type">
            {e.name} <span className="muted">{argsSummary(e.args)}</span>
          </span>
          {time(e.ts)}
        </button>
        {open && (
          <div className="chatlog-tool-body">
            {e.args !== undefined && <JsonBlock value={e.args} />}
            {e.result && <pre className="chatlog-text">{e.result.output || "(no output)"}</pre>}
          </div>
        )}
      </div>
    );
  return (
    <div className={`chatlog-note ${e.tone ?? ""}`}>
      <div className="chatlog-msg-head">
        <span>{e.label}</span>
        {time(e.ts)}
      </div>
      {e.text && <p className="chatlog-note-text">{e.text}</p>}
    </div>
  );
}

function RecordRowView({ row, open, toggle }: { row: RecordRow; open: boolean; toggle(): void }) {
  const first = row.records[0];
  const last = row.records.at(-1)!;
  const n = row.records.length;
  return (
    <div className="chatlog-record">
      <button className="tree-row" aria-expanded={open} onClick={toggle}>
        <IconChevronRight size={12} className={`chev ${open ? "open" : ""}`} />
        <span className="chatlog-seq">
          {n > 1 ? `${first.seq ?? first.line}–${last.seq ?? last.line}` : (first.seq ?? first.line)}
        </span>
        <span className="chatlog-type">
          {row.type}
          {n > 1 && <span className="muted"> × {n}</span>}
          {row.text !== undefined && (
            <span className="muted chatlog-preview"> {row.text.replace(/\s+/g, " ").slice(0, 120)}</span>
          )}
        </span>
        {time(last.ts)}
      </button>
      {open &&
        (row.text !== undefined ? (
          <div className="chatlog-json">
            <CopyButton text={row.text} label="Copy text" />
            <p className="muted small chatlog-chunks">
              {n} streamed {n === 1 ? "chunk" : "chunks"} of{" "}
              {String((first.value as { id?: string })?.id ?? "")}, joined:
            </p>
            <pre className="chatlog-text">{row.text}</pre>
          </div>
        ) : (
          <RecordJson record={first} />
        ))}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const html = useMemo(() => highlight(JSON.stringify(value, null, 2) ?? "", "json"), [value]);
  return (
    <pre className="chatlog-text">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

function RecordJson({ record }: { record: LogRecord }) {
  const html = useMemo(
    () => highlight(record.value === undefined ? record.raw : JSON.stringify(record.value, null, 2), "json"),
    [record],
  );
  return (
    <div className="chatlog-json">
      <CopyButton text={record.raw} label="Copy record" />
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="ghost icon"
      aria-label={label}
      title={label}
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => undefined);
      }}
    >
      {done ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
