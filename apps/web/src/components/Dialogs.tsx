import { useEffect, useState } from "react";
import { useDialog } from "./CommandPalette";
import { IconAlert } from "./icons";

/**
 * In-app replacements for window.confirm / window.alert: styled like the rest of the UI,
 * keyboard-friendly (Esc cancels, Tab is trapped) and async. Mount <DialogHost /> once.
 */
type Options = { title?: string; ok?: string; cancel?: string; danger?: boolean };
type Request = Options & { kind: "confirm" | "alert"; message: string; resolve(v: boolean): void };

let enqueue: ((r: Request) => void) | null = null;

function open(kind: Request["kind"], message: string, opts: Options): Promise<boolean> {
  return new Promise((resolve) => {
    const req: Request = { ...opts, kind, message, resolve };
    if (enqueue) enqueue(req);
    else if (kind === "confirm") resolve(window.confirm(message));
    else {
      window.alert(message);
      resolve(true);
    }
  });
}

export const confirmDialog = (message: string, opts: Options = {}) => open("confirm", message, opts);
export const alertDialog = (message: string, opts: Options = {}) =>
  open("alert", message, opts).then(() => undefined);

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  useEffect(() => {
    enqueue = (r) => setQueue((q) => [...q, r]);
    return () => {
      enqueue = null;
    };
  }, []);
  const cur = queue[0];
  if (!cur) return null;
  const finish = (v: boolean) => {
    cur.resolve(v);
    setQueue((q) => q.slice(1));
  };
  return <Dialog key={queue.length + cur.message} req={cur} finish={finish} />;
}

function Dialog({ req, finish }: { req: Request; finish(v: boolean): void }) {
  const ref = useDialog(() => finish(false));
  const title = req.title ?? (req.kind === "alert" ? "Something went wrong" : "Are you sure?");
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(false)}>
      <div
        ref={ref}
        className="modal app-dialog"
        role={req.kind === "alert" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h3>
            {(req.danger || req.kind === "alert") && (
              <span className="app-dialog-icon" aria-hidden="true">
                <IconAlert size={17} />
              </span>
            )}
            {title}
          </h3>
        </div>
        <p className="app-dialog-message">{req.message}</p>
        <div className="modal-foot">
          <span />
          <span className="row">
            {req.kind === "confirm" && (
              <button className="secondary" onClick={() => finish(false)}>
                {req.cancel ?? "Cancel"}
              </button>
            )}
            <button className={req.danger ? "danger" : undefined} onClick={() => finish(true)}>
              {req.ok ?? "OK"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
