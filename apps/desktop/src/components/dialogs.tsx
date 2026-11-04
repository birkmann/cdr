import { useEffect, useRef, useState } from "react";
import { IWarn } from "./icons";

/**
 * In-app replacements for window.confirm / window.prompt. The native ones are unreliable in
 * Tauri's webviews and cannot be automated; these are styled, keyboard-friendly and async.
 */
type Request =
  | { kind: "confirm"; message: string; danger: boolean; ok: string; resolve(v: boolean): void }
  | { kind: "prompt"; message: string; initial: string; resolve(v: string | null): void };

let enqueue: ((r: Request) => void) | null = null;

export function confirmDialog(
  message: string,
  opts: { danger?: boolean; ok?: string } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const req: Request = { kind: "confirm", message, danger: !!opts.danger, ok: opts.ok ?? "OK", resolve };
    if (enqueue) enqueue(req);
    else resolve(window.confirm(message));
  });
}

export function promptDialog(message: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const req: Request = { kind: "prompt", message, initial, resolve };
    if (enqueue) enqueue(req);
    else resolve(window.prompt(message, initial));
  });
}

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    enqueue = (r) => setQueue((q) => [...q, r]);
    return () => {
      enqueue = null;
    };
  }, []);
  const cur = queue[0];
  useEffect(() => {
    if (!cur) return;
    if (cur.kind === "prompt") {
      setText(cur.initial);
      requestAnimationFrame(() => input.current?.select());
    } else requestAnimationFrame(() => okBtn.current?.focus());
  }, [cur]);
  if (!cur) return null;
  const finish = (accept: boolean) => {
    if (cur.kind === "confirm") cur.resolve(accept);
    else cur.resolve(accept ? text : null);
    setQueue((q) => q.slice(1));
  };
  return (
    <div className="st-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(false)}>
      <div
        className="st-modal st-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={cur.message}
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(false);
          if (e.key === "Enter" && cur.kind === "prompt") finish(true);
        }}
      >
        <div className="st-dialog-body">
          {cur.kind === "confirm" && cur.danger && (
            <span className="st-dialog-icon" aria-hidden="true">
              <IWarn size={18} />
            </span>
          )}
          <p className="st-dialog-message">{cur.message}</p>
        </div>
        {cur.kind === "prompt" && (
          <input
            ref={input}
            className="st-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={cur.message}
          />
        )}
        <div className="st-row end">
          <button className="secondary" onClick={() => finish(false)}>
            Cancel
          </button>
          <button
            ref={okBtn}
            className={cur.kind === "confirm" && cur.danger ? "st-danger-btn" : "st-primary-btn"}
            onClick={() => finish(true)}
          >
            {cur.kind === "confirm" ? cur.ok : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
