export interface FileDiff {
  path: string;
  lines: string[];
  add: number;
  del: number;
  isNew: boolean;
}

/** Split a (git or harness) unified diff into per-file chunks. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let inHeader = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const gitHeader = l.startsWith("diff --git ");
    const plainHeader = l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ");
    // "--- / +++" directly after a "diff --git" header (no hunks yet) belongs to the same file
    if (gitHeader || (plainHeader && !(cur && inHeader))) {
      cur = { path: "", lines: [], add: 0, del: 0, isNew: false };
      files.push(cur);
      inHeader = gitHeader;
    }
    if (l.startsWith("@@")) inHeader = false;
    if (!cur) continue;
    if (l.startsWith("+++ ")) {
      const p = l.slice(4).replace(/^b\//, "");
      if (p !== "/dev/null") cur.path = p;
    } else if (l.startsWith("--- ")) {
      if (l.includes("/dev/null")) cur.isNew = true;
      else if (!cur.path) cur.path = l.slice(4).replace(/^a\//, "");
    } else if (l.startsWith("diff --git ")) {
      cur.path = l.split(" b/").pop() ?? cur.path;
    } else if (
      l.startsWith("@@") ||
      l.startsWith("+") ||
      l.startsWith("-") ||
      l.startsWith(" ") ||
      l.startsWith("(")
    ) {
      cur.lines.push(l);
      if (l.startsWith("+")) cur.add++;
      else if (l.startsWith("-")) cur.del++;
    }
  }
  // merge repeated chunks of the same file (tool diffs) keeping the latest
  const byPath = new Map<string, FileDiff>();
  for (const f of files) if (f.path) byPath.set(f.path, f);
  return [...byPath.values()];
}

export function DiffLines({ lines }: { lines: string[] }) {
  let a = 0;
  let b = 0;
  const numbered = lines.some((l) => l.startsWith("@@"));
  return (
    <div className="diff">
      {lines.map((l, i) => {
        if (l.startsWith("@@")) {
          const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
          if (m) {
            a = Number(m[1]);
            b = Number(m[2]);
          }
          return (
            <div key={i} className="dl hunk">
              <span className="ln" />
              <span className="ln" />
              <span className="code">{l}</span>
            </div>
          );
        }
        const kind = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
        const la = numbered && kind !== "add" ? a++ : "";
        const lb = numbered && kind !== "del" ? b++ : "";
        return (
          <div key={i} className={`dl ${kind}`}>
            <span className="ln">{la}</span>
            <span className="ln">{lb}</span>
            <span className="code">{l.slice(1) || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Render a diff string (one or more files). */
export function DiffBlock({ diff, title }: { diff: string; title?: string }) {
  const files = parseDiff(diff);
  if (!files.length) {
    // raw +/- lines without headers
    const lines = diff.split("\n").filter(Boolean);
    return (
      <div className="diff-file">
        {title && <div className="diff-file-head mono">{title}</div>}
        <DiffLines lines={lines} />
      </div>
    );
  }
  return (
    <>
      {files.map((f) => (
        <div className="diff-file" key={f.path}>
          <div className="diff-file-head mono">
            {title ?? f.path}
            <span className="tool-stats">
              <span className="add">+{f.add}</span> <span className="del">−{f.del}</span>
            </span>
          </div>
          <DiffLines lines={f.lines} />
        </div>
      ))}
    </>
  );
}
