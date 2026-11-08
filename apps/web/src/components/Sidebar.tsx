import { useMemo, useState } from "react";
import type { SessionInfo } from "@harness/client";
import { basename, isAutomated, useApp } from "../app-state";
import { CDRMark } from "./Brand";
import { groupByDate } from "../session-groups";
import { alertDialog, confirmDialog } from "./Dialogs";
import {
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
  IconFolder,
  IconCode,
  IconPanel,
  IconTerminal,
} from "./icons";

export function Sidebar({
  onSettings,
  onNavigate,
  onSearch,
  onToggle,
}: {
  onSettings(): void;
  onNavigate?(): void;
  onSearch(): void;
  onToggle(): void;
}) {
  const { sessions, route, navigate, client, refreshSessions, connection, settings, updateSettings } =
    useApp();
  const [q, setQ] = useState("");
  const openId = route.name === "chat" ? route.id : undefined;
  const automated = useMemo(() => sessions.filter(isAutomated).length, [sessions]);
  const sorted = useMemo(
    () =>
      [...sessions]
        // the open conversation stays listed even when it is an automated one
        .filter((s) => settings.showAutomated || s.id === openId || !isAutomated(s))
        .filter((s) => !q || `${s.title ?? ""} ${s.projectPath}`.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)),
    [sessions, q, settings.showAutomated, openId],
  );
  const del = async (s: SessionInfo) => {
    const ok = await confirmDialog(
      "The chat history is removed with its subagents and their finished worktrees. Files in the project are not touched.",
      {
        title: `Delete “${s.title ?? s.id}”?`,
        ok: "Delete chat",
        danger: true,
      },
    );
    if (!ok) return;
    try {
      await client?.deleteSession(s.id);
      if (route.name === "chat" && route.id === s.id) navigate({ name: "home" });
      await refreshSessions();
    } catch (e) {
      void alertDialog((e as Error).message, { title: "Could not delete the chat" });
    }
  };
  return (
    <nav className="sidebar" aria-label="Chats">
      <div className="sidebar-brand">
        <button className="brand" onClick={() => navigate({ name: "home" })}>
          <CDRMark size={28} /> CDR
        </button>
        <button
          className="ghost icon"
          onClick={onToggle}
          aria-label="Collapse sidebar"
          title="Collapse sidebar (Ctrl+B)"
        >
          <IconPanel size={17} />
        </button>
      </div>
      <button
        className="new-chat"
        aria-label="New chat"
        onClick={() => {
          navigate({ name: "home" });
          onNavigate?.();
        }}
      >
        <IconPlus size={16} /> New chat <kbd>⌘ ⇧ O</kbd>
      </button>
      <div className="sidebar-nav">
        <button className="nav-link" onClick={onSearch}>
          <IconSearch /> Search <kbd>⌘ K</kbd>
        </button>
        <button
          className={`nav-link ${route.name === "projects" ? "active" : ""}`}
          onClick={() => {
            navigate({ name: "projects" });
            onNavigate?.();
          }}
        >
          <IconFolder /> Projects
        </button>
        <button
          className={`nav-link ${route.name === "artifacts" ? "active" : ""}`}
          onClick={() => {
            navigate({ name: "artifacts" });
            onNavigate?.();
          }}
        >
          <IconCode /> Creations
        </button>
        <button
          className={`nav-link ${route.name === "chats" ? "active" : ""}`}
          onClick={() => {
            navigate({ name: "chats" });
            onNavigate?.();
          }}
        >
          <IconTerminal /> All conversations
        </button>
      </div>
      <div className="history-heading">
        Recents
        {automated > 0 && (
          <button
            className={`ghost tiny automated-toggle ${settings.showAutomated ? "on" : ""}`}
            aria-pressed={settings.showAutomated}
            onClick={() => updateSettings((s) => ({ showAutomated: !s.showAutomated }))}
            title={
              settings.showAutomated
                ? "Hide goal runs and software-factory agents"
                : "Show goal runs and software-factory agents"
            }
          >
            {settings.showAutomated ? "Hide" : "Show"} automated · {automated}
          </button>
        )}
      </div>
      <label className="search">
        <IconSearch size={14} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter recent chats"
          aria-label="Search chats"
        />
      </label>
      <div className="history">
        {sorted.length === 0 && (
          <div className="muted small pad">{q ? "No matches." : "Your chats appear here."}</div>
        )}
        {groupByDate(sorted).map(([label, items]) => (
          <div key={label}>
            <div className="history-group">{label}</div>
            {items.map((s) => (
              <div
                key={s.id}
                className={`history-item ${route.name === "chat" && route.id === s.id ? "active" : ""}`}
              >
                <button
                  className={`history-link ${s.projectMissing ? "missing" : ""}`}
                  disabled={s.projectMissing}
                  onClick={() => {
                    navigate({ name: "chat", id: s.id });
                    onNavigate?.();
                  }}
                  title={`${s.title ?? s.id}\n${s.projectPath}`}
                >
                  <span className={`dot ${s.status}`} />
                  <span className="history-text">
                    <span className="history-title">{s.title ?? "Untitled"}</span>
                    <span className="history-sub">
                      {s.projectMissing
                        ? "folder deleted"
                        : s.sandbox
                          ? `sandbox · ${basename(s.projectPath)}`
                          : basename(s.projectPath)}
                    </span>
                  </span>
                </button>
                <button
                  className="ghost icon history-del"
                  onClick={() => void del(s)}
                  aria-label="Delete chat"
                  title="Delete chat"
                >
                  <IconTrash size={14} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <button className="ghost settings-btn" aria-label="Settings" onClick={onSettings}>
          <span className="avatar">{(settings.name || "You").slice(0, 1).toUpperCase()}</span>
          <span className="account-name">
            {settings.name || "Your workspace"}
            <small>CDR · local</small>
          </span>
          <IconSettings size={15} />
        </button>
        <span className={`conn ${connection}`} title={`Server: ${connection}`} />
      </div>
    </nav>
  );
}
