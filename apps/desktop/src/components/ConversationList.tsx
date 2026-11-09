import { useEffect, useMemo, useState } from "react";
import { useApp } from "@web/app-state";
import { Popover } from "@web/components/Pickers";
import { deleteAllChats, deleteAllNote, deleteAllPrompt, planDeleteAll } from "@web/delete-chats";
import type { SessionInfo } from "@harness/client";
import {
  ago,
  descendants,
  elapsed,
  isActive,
  originLabel,
  originTitle,
  sandboxFolderRemovable,
} from "../agents";
import {
  SANDBOX_PROJECT,
  conversationSections,
  isDefaultBranch,
  orphanConversations,
  projectBadge,
  projectChoices,
  projectRoot,
  rootConversation,
  type Attention,
} from "../sessions";
import { basename, useStudio } from "../store";
import type { Approval } from "./approvals";
import { confirmDialog } from "./dialogs";
import { IChevron, IPlus, ISearch, ISettings, IStop, IWarn, IX } from "./icons";
import { useProjectSummaries } from "./project-git";

function ProjectChip({ name, sandbox }: { name: string; sandbox?: boolean }) {
  if (sandbox) return <span className="st-sw-badge">sandbox</span>;
  const { initials, hue } = projectBadge(name);
  return (
    <span
      className="st-conv-chip"
      style={{ color: `hsl(${hue} 70% 58%)`, background: `hsl(${hue} 70% 58% / 0.16)` }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  return JSON.stringify(args, null, 1).slice(0, 300);
}

/** One request an agent is blocked on, answerable from the list. */
function ApprovalCard({ approval, showAgent }: { approval: Approval; showAgent: boolean }) {
  const st = useStudio();
  const { client, refreshSessions } = useApp();
  const e = approval.event;
  const answer = async (decision: "allow" | "deny" | "always") => {
    if (e.type !== "permission.request" || !client) return;
    await st.attempt(() => client.answerPermission(approval.session.id, e.id, decision));
    void refreshSessions();
  };
  const agent = showAgent && (
    <button className="st-link" onClick={() => st.setSessionId(approval.session.id)}>
      <strong className="st-ellipsis">{approval.session.title ?? "Subagent"}</strong>
    </button>
  );
  if (e.type !== "permission.request")
    return (
      <div className="st-approval">
        {agent}
        <div className="small">
          {e.type === "plan.proposed"
            ? "proposed a plan for approval"
            : e.type === "question"
              ? `asks: ${e.text}`
              : e.type}{" "}
          <button className="ghost tiny" onClick={() => st.setSessionId(approval.session.id)}>
            Open
          </button>
        </div>
      </div>
    );
  return (
    <div className="st-approval">
      {agent}
      <div className="small">
        wants to use <code>{e.tool}</code> <span className={`st-risk ${e.risk}`}>{e.risk} risk</span>
      </div>
      <pre className="st-approval-args">{summarizeArgs(e.args)}</pre>
      <div className="st-row tight">
        <button className="tiny" onClick={() => void answer("allow")}>
          Allow
        </button>
        <button className="ghost tiny" onClick={() => void answer("always")}>
          Always
        </button>
        <button className="ghost tiny danger" onClick={() => void answer("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

/** The chat view's left column: every conversation, ordered by what needs attention. */
export function ConversationList({ approvals, onSettings }: { approvals: Approval[]; onSettings(): void }) {
  const st = useStudio();
  const { client, sessions, refreshSessions } = useApp();
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const filter = st.projectFilter;
  const sections = useMemo(
    () => conversationSections(sessions, { query, project: filter }),
    [sessions, query, filter],
  );
  const projects = useMemo(() => projectChoices(sessions), [sessions]);
  const orphans = useMemo(() => orphanConversations(sessions), [sessions]);
  const deletePlan = useMemo(() => planDeleteAll(sessions), [sessions]);
  const [deleting, setDeleting] = useState(false);
  const running = sessions.filter(isActive);
  const stoppable = running.filter((s) => !s.externalRun);
  const selected = st.sessionId ? sessions.find((s) => s.id === st.sessionId) : undefined;
  const selectedRoot = selected ? rootConversation(selected, sessions).id : undefined;
  const titleOf = (id?: string) => (id ? sessions.find((s) => s.id === id)?.title : undefined);

  // Branches are worth showing, and asking git for, only where an agent is at work right now.
  const livePaths = useMemo(
    () => [
      ...new Set(
        sections
          .filter((s) => s.attention !== "settled")
          .flatMap((s) => s.items)
          .filter((s) => !s.sandbox)
          .map((s) => projectRoot(s.projectPath)),
      ),
    ],
    [sections],
  );
  const summaries = useProjectSummaries(livePaths);

  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running.length]);

  const approvalsOf = (id: string) =>
    approvals.filter((a) => rootConversation(a.session, sessions).id === id);

  const stopAll = async () => {
    if (!client) return;
    const ok = await confirmDialog(
      `Stop ${stoppable.length} running agent${stoppable.length === 1 ? "" : "s"}? Their subagents stop with them. Work done so far is kept and can be continued.`,
      { danger: true, ok: "Stop all" },
    );
    if (!ok) return;
    const r = await st.attempt(() => client.cancelAll());
    if (r?.external?.length)
      st.toast(
        `${r.external.length} run${r.external.length === 1 ? " belongs" : "s belong"} to another window or terminal; stop ${r.external.length === 1 ? "it" : "them"} there.`,
      );
    void refreshSessions();
  };

  const remove = async (s: SessionInfo) => {
    if (!client) return;
    const helpers = descendants(s.id, sessions).length - 1;
    const ok = await confirmDialog(
      `Delete “${s.title ?? "Conversation"}”? Its history${helpers ? ` and its ${helpers} subagent${helpers === 1 ? "" : "s"}` : ""} are removed, together with finished subagent worktrees and merged subagent branches. Project files are not touched.`,
      { danger: true, ok: "Delete" },
    );
    if (!ok) return;
    let folder = false;
    if (!s.projectMissing && sandboxFolderRemovable(s, sessions))
      folder = await confirmDialog(
        `Also delete the sandbox folder ${s.projectPath} and its checkpoints? Everything the agent built there is lost.`,
        { danger: true, ok: "Delete folder", cancel: "Keep folder" },
      );
    const r = await st.attempt(() => client.deleteSession(s.id, { folder }));
    if (!r) return;
    // An older harness answers `{ ok }` only.
    if (st.sessionId && (r.sessions ?? [s.id]).includes(st.sessionId)) st.setSessionId(null);
    for (const id of r.sessions ?? [s.id]) st.closeTab(`chat:${id}`);
    if (r.kept?.length) st.toast(`Kept: ${r.kept.join("; ")}`);
    void refreshSessions();
  };

  const removeOrphans = async () => {
    if (!client) return;
    const ok = await confirmDialog(
      `Delete ${orphans.length} conversation${orphans.length === 1 ? "" : "s"} whose folder no longer exists?`,
      { danger: true, ok: "Delete" },
    );
    if (!ok) return;
    for (const s of orphans) await st.attempt(() => client.deleteSession(s.id));
    void refreshSessions();
  };

  const deleteAll = async () => {
    if (!client) return;
    const { title, message } = deleteAllPrompt(deletePlan);
    if (!(await confirmDialog(`${title} ${message}`, { danger: true, ok: "Delete all" }))) return;
    setDeleting(true);
    const result = await deleteAllChats(client, deletePlan.chats);
    setDeleting(false);
    if (st.sessionId && result.deleted.includes(st.sessionId)) st.setSessionId(null);
    for (const id of result.deleted) st.closeTab(`chat:${id}`);
    const note = deleteAllNote(result);
    if (note) st.toast(note);
    void refreshSessions();
  };

  const startNew = () => {
    st.setSessionId(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".st-agent textarea")?.focus());
  };
  const openInTab = (s: SessionInfo) => st.openTab({ kind: "chat", sessionId: s.id });

  const row = (s: SessionInfo, attention: Attention | "orphan") => {
    const project = projectRoot(s.projectPath);
    const name = s.sandbox ? "No project" : basename(project);
    const live = attention === "working" || attention === "waiting";
    const origin = originLabel(s);
    const when = live && s.runStartedAt ? elapsed(s.runStartedAt, now) : ago(s.updatedAt ?? s.createdAt, now);
    const summary = live && !s.sandbox ? summaries[project] : undefined;
    const branch = summary?.status?.branch;
    const changes = summary?.status?.files.length ?? 0;
    const showBranch = !!branch && !isDefaultBranch(branch);
    const status = attention === "waiting" ? "waiting" : attention === "working" ? "running" : s.status;
    const pending = attention === "waiting" ? approvalsOf(s.id) : [];
    const title =
      s.title ??
      `Untitled · ${new Date(s.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    return (
      <div key={s.id} className="st-conv-item">
        <div className={`st-conv ${selectedRoot === s.id ? "on" : ""}`}>
          <button
            className="st-conv-main"
            aria-current={selectedRoot === s.id ? "true" : undefined}
            disabled={attention === "orphan"}
            title={`${s.projectPath}\nCtrl+click or middle-click to open it in an editor tab`}
            onClick={(e) => (e.ctrlKey || e.metaKey ? openInTab(s) : st.setSessionId(s.id))}
            onAuxClick={(e) => {
              if (e.button === 1) (e.preventDefault(), openInTab(s));
            }}
          >
            <span className="st-conv-top">
              <ProjectChip name={name} sandbox={s.sandbox} />
              {!s.sandbox && <span className="st-ellipsis st-conv-project">{name}</span>}
              {origin && origin !== "app" && (
                <span className="st-origin" title={originTitle(s, titleOf(s.parentSessionId))}>
                  {origin}
                </span>
              )}
              {s.interrupted && (
                <span className="st-origin warn" title="The app closed while this ran. Open it to continue.">
                  interrupted
                </span>
              )}
              <span className="st-conv-when">{when}</span>
            </span>
            <span className="st-conv-title">
              <span className={`st-status-dot ${status}`} title={status} />
              <span className="st-ellipsis">{title}</span>
            </span>
            {(attention === "waiting" || showBranch || (live && changes > 0) || s.externalRun) && (
              <span className="st-conv-meta">
                {attention === "waiting" && <span className="st-agent-waiting">waiting for you</span>}
                {showBranch && <span className="st-ellipsis">{branch}</span>}
                {live && changes > 0 && <span>{changes} changed</span>}
                {s.externalRun && (
                  <span title="Stop it in the window or terminal that runs it">runs in another process</span>
                )}
              </span>
            )}
          </button>
          {live && !s.externalRun && (
            <button
              className="ghost icon tiny st-conv-action visible"
              title="Stop this agent"
              aria-label="Stop agent"
              onClick={() => client && void st.attempt(() => client.cancel(s.id))}
            >
              <IStop size={12} />
            </button>
          )}
          {!live && (
            <button
              className="ghost icon tiny st-conv-action"
              title="Delete conversation"
              aria-label="Delete conversation"
              onClick={() => void remove(s)}
            >
              <IX size={12} />
            </button>
          )}
        </div>
        {pending.length > 0 && (
          <div className="st-conv-approvals">
            {pending.map((a) => (
              <ApprovalCard
                key={`${a.session.id}:${(a.event as { id: string }).id}`}
                approval={a}
                showAgent={a.session.id !== s.id}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  const filterLabel =
    filter === SANDBOX_PROJECT
      ? "Sandboxes"
      : filter
        ? (projects.find((p) => p.path === filter)?.name ?? basename(filter))
        : "All projects";
  const firstSettled = sections.findIndex((s) => s.attention === "settled");
  const total = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="st-conv-list">
      <div className="st-conv-head">
        <div className="st-conv-search-row">
          <ISearch size={14} />
          <input
            className="st-conv-search"
            placeholder="Search conversations"
            aria-label="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              if (e.key === "Enter" && sections[0]?.items[0]) st.setSessionId(sections[0].items[0].id);
            }}
          />
        </div>
        <div className="st-conv-tools">
          <Popover
            className="st-conv-filter"
            title="Show the conversations of one project"
            label={filterLabel}
          >
            {(close) => {
              const pick = (v: string | null) => (close(), st.setProjectFilter(v));
              return (
                <div className="st-menu">
                  <div className="st-menu-scroll">
                    <button className={!filter ? "on" : ""} onClick={() => pick(null)}>
                      <span>All projects</span>
                    </button>
                    {projects.map((p) => (
                      <button
                        key={p.path}
                        className={filter === p.path ? "on" : ""}
                        title={p.path}
                        onClick={() => pick(p.path)}
                      >
                        <span className="st-row">
                          <ProjectChip name={p.name} />
                          <span className="st-ellipsis">{p.name}</span>
                        </span>
                      </button>
                    ))}
                    <button
                      className={filter === SANDBOX_PROJECT ? "on" : ""}
                      onClick={() => pick(SANDBOX_PROJECT)}
                    >
                      <span>Sandboxes</span>
                    </button>
                  </div>
                </div>
              );
            }}
          </Popover>
          <button className="st-conv-new" title="New conversation (Ctrl+I)" onClick={startNew}>
            <IPlus size={14} /> New
          </button>
        </div>
      </div>
      <div className="st-conv-scroll">
        {sections.map((sec, i) => (
          <section key={sec.label} aria-label={sec.label}>
            {i === firstSettled && <div className="st-conv-group">Settled</div>}
            {sec.attention === "settled" ? (
              <div className="st-menu-label">{sec.label}</div>
            ) : (
              <div className="st-conv-group">
                <span>
                  {sec.label} <span className={`st-count ${sec.attention}`}>{sec.items.length}</span>
                </span>
                {sec.attention === "working" && stoppable.length > 0 && (
                  <button
                    className="ghost tiny danger"
                    onClick={() => void stopAll()}
                    title="Stop every running agent"
                  >
                    <IStop size={11} /> Stop all
                  </button>
                )}
              </div>
            )}
            {sec.items.map((s) => row(s, sec.attention))}
          </section>
        ))}
        {total === 0 && (
          <div className="st-sw-empty">
            {query || filter ? "No conversations match." : "No conversations yet. Start one in the middle."}
          </div>
        )}
        {orphans.length > 0 && !query && !filter && (
          <details className="st-agent-section st-agent-group">
            <summary className="st-agent-section-head">
              <span className="st-menu-label">
                <IChevron size={10} /> Folder deleted ({orphans.length})
              </span>
              <button
                className="ghost tiny danger"
                onClick={(e) => {
                  e.preventDefault();
                  void removeOrphans();
                }}
                title="Delete every conversation whose folder no longer exists"
              >
                <IX size={11} /> Delete all
              </button>
            </summary>
            <p className="st-agent-none small muted">
              <IWarn size={11} /> These conversations worked in folders that no longer exist. They can only be
              deleted.
            </p>
            {orphans.map((s) => row(s, "orphan"))}
          </details>
        )}
      </div>
      <div className="st-conv-foot">
        <button
          className="ghost icon tiny"
          title="Settings (Ctrl+,)"
          aria-label="Settings"
          onClick={onSettings}
        >
          <ISettings size={16} />
        </button>
        {deletePlan.chats.length > 0 && (
          <button
            className="ghost tiny danger"
            disabled={deleting}
            title="Delete every conversation that isn't running"
            onClick={() => void deleteAll()}
          >
            <IX size={11} /> {deleting ? "Deleting…" : "Delete all"}
          </button>
        )}
      </div>
    </div>
  );
}
