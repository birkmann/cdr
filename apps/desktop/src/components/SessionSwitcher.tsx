import { useMemo, useState } from "react";
import type { SessionInfo } from "@harness/client";
import { relativeTime, useApp } from "@web/app-state";
import { Popover } from "@web/components/Pickers";
import { basename, useStudio } from "../store";
import { IChat, IHistory, IPlus } from "./icons";
import { switcherSections, updatedAt } from "../sessions";

/** Where a conversation's files live, for the second line of a row. */
function place(s: SessionInfo) {
  return (
    <>
      {s.sandbox ? <span className="st-sw-badge">sandbox</span> : null}
      <span className="st-ellipsis">{basename(s.projectPath)}</span>
    </>
  );
}

export function SessionSwitcher({
  current,
  value,
  onPick,
  newHint,
  compact,
}: {
  current?: SessionInfo;
  /** The conversation shown, or null for a new one. */
  value: string | null;
  onPick(id: string | null): void;
  /** Shortcut shown beside "New conversation". */
  newHint?: string;
  /** Show only a history icon (the conversation header already shows the title). */
  compact?: boolean;
}) {
  const st = useStudio();
  const { sessions } = useApp();
  const [query, setQuery] = useState("");
  const root = st.workspace?.root;
  const sections = useMemo(() => switcherSections(sessions, root, query), [sessions, root, query]);
  const total = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <Popover
      className={`st-session-menu ${compact ? "st-session-icon" : ""}`}
      align={compact ? "right" : "left"}
      title="Conversation history"
      label={
        compact ? (
          <IHistory size={15} aria-label="Conversation history" />
        ) : (
          <span className="st-title-btn">
            <IChat size={14} />
            <span className="st-ellipsis">
              {value ? (current?.title ?? "Conversation") : "New conversation"}
            </span>
          </span>
        )
      }
    >
      {(close) => {
        const pick = (id: string | null) => {
          close();
          setQuery("");
          onPick(id);
        };
        return (
          <div className="st-menu wide st-switcher" role="dialog" aria-label="Conversation history">
            <button onClick={() => pick(null)}>
              <span>
                <IPlus size={12} /> New conversation
              </span>
              {newHint && <kbd>{newHint}</kbd>}
            </button>
            <input
              className="st-input"
              autoFocus
              placeholder="Search conversations"
              aria-label="Search conversations"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && sections[0]?.items[0]) pick(sections[0].items[0].id);
              }}
            />
            <div className="st-menu-scroll">
              {sections.map((sec) => (
                <div key={sec.label} role="group" aria-label={sec.label}>
                  <div className="st-menu-label">{sec.label}</div>
                  {sec.items.map((s) => (
                    <button
                      key={s.id}
                      className={`st-sw-row ${s.id === value ? "on" : ""}`}
                      title={s.projectPath}
                      aria-current={s.id === value ? "true" : undefined}
                      onClick={() => pick(s.id)}
                    >
                      <span className="st-sw-main">
                        <span className="st-ellipsis st-sw-title">{s.title ?? "Untitled"}</span>
                        <span className="st-sw-meta">
                          {place(s)}
                          <span className="st-sw-time">{relativeTime(updatedAt(s))}</span>
                        </span>
                      </span>
                      <span className={`st-status-dot ${s.status}`} title={s.status} />
                    </button>
                  ))}
                </div>
              ))}
              {total === 0 && (
                <div className="st-sw-empty">
                  {query ? "No conversations match." : "No conversations yet."}
                </div>
              )}
            </div>
          </div>
        );
      }}
    </Popover>
  );
}
