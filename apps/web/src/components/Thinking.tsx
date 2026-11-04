import { useId, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { IconCheck, IconChevronRight, IconSparkle } from "./icons";

/** Reasoning is presentation of the message stream, never a separate agent state. */
export function Thinking({
  text,
  active,
  interrupted = false,
}: {
  text: string;
  active: boolean;
  interrupted?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [following, setFollowing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const label = active ? "Thinking" : interrupted ? "Thinking stopped" : "Thought process";
  const latest = text
    .trim()
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("```"))
    .at(-1);
  useLayoutEffect(() => {
    if (open && active && following && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text, open, active, following]);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !open || !active || !following) return;
    const resize = new ResizeObserver(() => {
      el.scrollTop = el.scrollHeight;
    });
    resize.observe(el);
    return () => resize.disconnect();
  }, [open, active, following]);
  return (
    <section className={`thinking${active ? " is-thinking" : ""}`} aria-label="Model thinking">
      <button
        className="thinking-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className="thinking-symbol" aria-hidden="true">
          {active || interrupted ? <IconSparkle size={16} /> : <IconCheck size={16} />}
        </span>
        <span className="thinking-label">{label}</span>
        {active && (
          <span className="thinking-live" role="status">
            In progress
            <span className="thinking-dots" aria-hidden="true">
              •••
            </span>
          </span>
        )}
        <span className="thinking-action">{open ? "Hide" : "Show"} details</span>
        <IconChevronRight size={14} className={open ? "chev open" : "chev"} />
      </button>
      {!open && active && <p className="thinking-preview">{latest || "Considering your request…"}</p>}
      <div id={id} hidden={!open}>
        <div
          className="thinking-body"
          ref={body}
          tabIndex={0}
          role="region"
          aria-label="Thought process details"
          onScroll={(event) => {
            const el = event.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight >= 32) setFollowing(false);
          }}
        >
          {text ? <Markdown text={text} /> : <p className="muted">Waiting for the model’s first thoughts…</p>}
        </div>
        {active && (
          <div className="thinking-foot">
            <span>{following ? "Following live thoughts" : "Scroll at your own pace"}</span>
            {!following && (
              <button className="ghost tiny" onClick={() => setFollowing(true)}>
                Jump to latest ↓
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
