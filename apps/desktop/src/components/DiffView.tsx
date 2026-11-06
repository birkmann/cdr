import { useEffect, useState } from "react";
import { git, type DiffLine, type FileDiff, type Hunk } from "../ipc";
import { setDiffMode, splitRows, useDiffMode, type DiffMode } from "../diff-split";
import { useStudio } from "../store";
import { IFile, IMinus, IPlus, IUndo } from "./icons";
import { confirmDialog } from "./dialogs";

const sign = (l: DiffLine) => (l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ");

/** One side of a split row; an empty side is shaded as filler. */
function SplitCells({ line, no, old }: { line?: DiffLine; no?: number; old?: boolean }) {
  const edge = old ? " old" : "";
  if (!line) return <td className={`filler${edge}`} colSpan={3} />;
  return (
    <>
      <td className={`ln ${line.kind}`}>{no ?? ""}</td>
      <td className={`sign ${line.kind}`}>{sign(line)}</td>
      <td className={`code ${line.kind}${edge}`}>{line.text}</td>
    </>
  );
}

export function HunkView({
  hunk,
  actions,
  mode = "unified",
}: {
  hunk: Hunk;
  actions?: React.ReactNode;
  mode?: DiffMode;
}) {
  return (
    <div className="st-hunk">
      <div className="st-hunk-head">
        <code>{hunk.header}</code>
        <div className="st-row tight">{actions}</div>
      </div>
      {mode === "split" ? (
        <table className="st-diff-table split">
          <colgroup>
            <col className="ln" />
            <col className="sign" />
            <col />
            <col className="ln" />
            <col className="sign" />
            <col />
          </colgroup>
          <tbody>
            {splitRows(hunk.lines).map((r, i) => (
              <tr key={i}>
                <SplitCells line={r.left} no={r.left?.oldNo} old />
                <SplitCells line={r.right} no={r.right?.newNo} />
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="st-diff-table">
          <tbody>
            {hunk.lines.map((l, i) => (
              <tr key={i} className={l.kind}>
                <td className="ln">{l.oldNo ?? ""}</td>
                <td className="ln">{l.newNo ?? ""}</td>
                <td className="sign">{sign(l)}</td>
                <td className="code">{l.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Switches every diff between unified and side-by-side layout. */
export function DiffModeToggle() {
  const mode = useDiffMode();
  return (
    <div className="st-seg" role="group" aria-label="Diff layout">
      <button
        className={mode === "unified" ? "on" : ""}
        aria-pressed={mode === "unified"}
        onClick={() => setDiffMode("unified")}
        title="Unified diff"
      >
        Unified
      </button>
      <button
        className={mode === "split" ? "on" : ""}
        aria-pressed={mode === "split"}
        onClick={() => setDiffMode("split")}
        title="Side-by-side diff"
      >
        Split
      </button>
    </div>
  );
}

export function FileDiffView({
  diff,
  renderActions,
}: {
  diff: FileDiff;
  renderActions?: (h: Hunk, i: number) => React.ReactNode;
}) {
  const mode = useDiffMode();
  if (diff.binary) return <div className="st-empty">Binary file changed.</div>;
  if (!diff.hunks.length) return <div className="st-empty">No changes.</div>;
  return (
    <div className="st-diff">
      {diff.hunks.map((h, i) => (
        <HunkView key={`${i}:${h.header}`} hunk={h} mode={mode} actions={renderActions?.(h, i)} />
      ))}
    </div>
  );
}

/** Working-tree or staged changes of one file, with hunk staging. */
export function DiffView({ path, staged }: { path: string; staged: boolean }) {
  const st = useStudio();
  const root = st.workspace!.root;
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      setDiff(await git.diffFile(root, path, staged));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, path, staged, st.status]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await st.attempt(fn);
    setBusy(false);
    await st.refreshGit();
    await load();
  };
  const f = st.status?.files.find((x) => x.path === path);
  const stats = diff?.hunks.reduce(
    (a, h) => {
      for (const l of h.lines) {
        if (l.kind === "add") a.add++;
        if (l.kind === "del") a.del++;
      }
      return a;
    },
    { add: 0, del: 0 },
  );
  return (
    <div className="st-diffview">
      <div className="st-diffview-head">
        <div className="st-ellipsis">
          <strong>{path}</strong> <span className="muted small">{staged ? "staged" : "working tree"}</span>
          {stats && (
            <span className="small">
              {" "}
              <span className="st-add">+{stats.add}</span> <span className="st-del">−{stats.del}</span>
            </span>
          )}
        </div>
        <div className="st-row tight">
          <DiffModeToggle />
          <button
            className="ghost tiny"
            onClick={() => st.openTab({ kind: "file", path })}
            disabled={f?.worktree === "deleted"}
          >
            <IFile size={13} /> Open file
          </button>
          {staged ? (
            <button
              className="ghost tiny"
              disabled={busy}
              onClick={() => void run(() => git.unstage(root, [path]))}
            >
              <IMinus size={13} /> Unstage file
            </button>
          ) : (
            <>
              <button
                className="ghost tiny danger"
                disabled={busy}
                onClick={async () =>
                  (await confirmDialog(`Discard all changes to ${path}?`, { danger: true, ok: "Discard" })) &&
                  void run(() => git.discard(root, [path]))
                }
              >
                <IUndo size={13} /> Discard file
              </button>
              <button
                className="ghost tiny"
                disabled={busy}
                onClick={() => void run(() => git.stage(root, [path]))}
              >
                <IPlus size={13} /> Stage file
              </button>
            </>
          )}
        </div>
      </div>
      {error && <div className="st-empty st-error">{error}</div>}
      {diff && (
        <FileDiffView
          diff={diff}
          renderActions={(_, i) =>
            f?.worktree === "untracked" ? null : staged ? (
              <button
                className="ghost tiny"
                disabled={busy}
                onClick={() => void run(() => git.unstageHunk(root, path, i))}
              >
                Unstage hunk
              </button>
            ) : (
              <>
                <button
                  className="ghost tiny danger"
                  disabled={busy}
                  onClick={() => void run(() => git.discardHunk(root, path, i))}
                  title="Reject this change"
                >
                  Discard
                </button>
                <button
                  className="ghost tiny"
                  disabled={busy}
                  onClick={() => void run(() => git.stageHunk(root, path, i))}
                  title="Accept this change"
                >
                  Stage hunk
                </button>
              </>
            )
          }
        />
      )}
    </div>
  );
}
