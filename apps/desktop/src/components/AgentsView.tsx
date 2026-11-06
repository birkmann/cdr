import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApp } from "@web/app-state";
import type { SessionInfo } from "@harness/client";
import { useStudio } from "../store";
import {
  ago,
  buildTree,
  descendants,
  elapsed,
  formatUsage,
  isActive,
  originLabel,
  originTitle,
  sandboxFolderRemovable,
  splitActive,
  type AgentTree,
} from "../agents";
import type { Approval } from "./approvals";
import { useWorkspaceSessions } from "./AgentPanel";
import { confirmDialog } from "./dialogs";
import { startTabDrag } from "./dnd";
import { IChevron, IStop, IBranch, IX, IWarn } from "./icons";

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function AgentsView({
  approvals,
  defaultFilter = "active",
}: {
  approvals: Approval[];
  defaultFilter?: "active" | "all";
}) {
  const st = useStudio();
  const { client, sessions, refreshSessions } = useApp();
  const workspace = useWorkspaceSessions();
  const [filter, setFilter] = useState<"active" | "all">(defaultFilter);
  const [now, setNow] = useState(() => Date.now());

  // Active agents come from every session, not only the open folder's, so the list matches the status bar.
  const { active } = useMemo(() => splitActive(sessions), [sessions]);
  const activeTree = useMemo(() => buildTree(active), [active]);
  const activeIds = useMemo(() => new Set(active.map((s) => s.id)), [active]);
  const history = useMemo(
    () => buildTree(workspace.filter((s) => !activeIds.has(s.id))),
    [workspace, activeIds],
  );
  const orphans = useMemo(
    () => sessions.filter((s) => s.projectMissing && !s.parentSessionId && !isActive(s)),
    [sessions],
  );
  const running = sessions.filter(isActive);
  const stoppable = running.filter((s) => !s.externalRun);
  const titleOf = (id?: string) => (id ? sessions.find((s) => s.id === id)?.title : undefined);

  // Tick elapsed times while something runs.
  useEffect(() => {
    if (!running.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running.length]);

  const answer = async (a: Approval, decision: "allow" | "deny" | "always") => {
    const ev = a.event;
    if (ev.type !== "permission.request" || !client) return;
    await st.attempt(() => client.answerPermission(a.session.id, ev.id, decision));
    void refreshSessions();
  };

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

  const open = (s: SessionInfo) => {
    st.setSessionId(s.id);
    st.setAgentPanel(true);
  };
  /** Open a conversation in an editor tab, so several can be watched side by side. */
  const openInTab = (s: SessionInfo) => st.openTab({ kind: "chat", sessionId: s.id });

  /**
   * One agent row. First line: status, title, origin and time. Second line (only when there is
   * something to say): where it works, and for running agents elapsed time, model and tokens.
   */
  const node = (
    tree: AgentTree,
    s: SessionInfo,
    depth: number,
    kind: "live" | "history" | "orphan",
  ): JSX.Element => {
    const kids = tree.children.get(s.id) ?? [];
    const live = kind === "live";
    const origin = originLabel(s);
    const activeNow = isActive(s);
    const elsewhere = kind !== "orphan" && (st.workspace ? s.projectPath !== st.workspace.root : !s.sandbox);
    const usage = formatUsage(s.usage);
    const title =
      s.title ??
      (depth
        ? "Subagent"
        : `Untitled · ${new Date(s.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
    const meta: { key: string; node: ReactNode; title?: string; className?: string }[] = [];
    if (kind === "orphan")
      meta.push({
        key: "path",
        node: `…/${s.projectPath.split("/").slice(-2).join("/")}`,
        title: s.projectPath,
      });
    else if (elsewhere)
      meta.push({
        key: "path",
        node: (
          <>
            <IBranch size={11} /> {base(s.projectPath)}
          </>
        ),
        title: s.projectPath,
      });
    if (live && s.status === "waiting")
      meta.unshift({ key: "wait", node: "waiting for you", className: "st-agent-waiting keep" });
    if (live && s.model)
      meta.push({ key: "model", node: s.model.split("/").pop(), title: s.model, className: "shrink" });
    if (live && usage) meta.push({ key: "usage", node: usage, className: "keep" });
    if (s.externalRun)
      meta.push({
        key: "ext",
        node: `runs in another process${s.runner ? ` (pid ${s.runner.pid})` : ""}`,
        title: "Stop it in the window or terminal that runs it",
      });
    const when =
      live && activeNow
        ? s.runStartedAt
          ? elapsed(s.runStartedAt, now)
          : s.status
        : ago(s.updatedAt ?? s.createdAt, now);
    return (
      <div key={s.id}>
        <div
          className={`st-agent-node ${st.sessionId === s.id ? "on" : ""} ${meta.length ? "two-line" : ""}`}
          style={{ paddingLeft: 10 + depth * 14 }}
        >
          <button
            className="st-agent-node-main"
            onClick={(e) => (e.ctrlKey || e.metaKey ? openInTab(s) : open(s))}
            onAuxClick={(e) => {
              if (e.button === 1) (e.preventDefault(), openInTab(s));
            }}
            title={`${s.projectPath}\nCtrl+click, middle-click or drag into the editor to open it in a tab`}
            draggable
            onDragStart={(e) => startTabDrag(e, { open: { kind: "chat", sessionId: s.id } })}
          >
            <span className={`st-status-dot ${s.status}`} title={s.status} />
            <span className="st-agent-text">
              <span className="st-agent-line">
                <span className="st-ellipsis st-agent-title">{title}</span>
                {origin && (
                  <span className="st-origin" title={originTitle(s, titleOf(s.parentSessionId))}>
                    {origin}
                  </span>
                )}
                {s.interrupted && (
                  <span
                    className="st-origin warn"
                    title="The app closed while this ran. Open it to continue."
                  >
                    interrupted
                  </span>
                )}
                {when && <span className="st-agent-when">{when}</span>}
              </span>
              {meta.length > 0 && (
                <span className="st-agent-meta">
                  {meta.map((m) => (
                    <span key={m.key} className={m.className} title={m.title}>
                      {m.node}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </button>
          {activeNow && s.externalRun && <span className="st-agent-action" />}
          {activeNow && !s.externalRun && (
            <button
              className="ghost icon tiny st-agent-stop"
              title="Stop this agent"
              aria-label="Stop agent"
              onClick={() => client && void st.attempt(() => client.cancel(s.id))}
            >
              <IStop size={12} />
            </button>
          )}
          {!activeNow && (live || s.parentSessionId) && <span className="st-agent-action" />}
          {!live && !s.parentSessionId && (
            <button
              className="ghost icon tiny st-agent-delete"
              title="Delete conversation"
              aria-label="Delete conversation"
              onClick={() => void remove(s)}
            >
              <IX size={12} />
            </button>
          )}
        </div>
        {kids.map((k) => node(tree, k, depth + 1, kind))}
      </div>
    );
  };

  return (
    <div className="st-panel">
      <div className="st-panel-head">
        <span className="st-panel-title">
          Agents {running.length > 0 && <span className="st-count">{running.length} active</span>}
        </span>
        <div className="st-seg">
          <button className={filter === "active" ? "on" : ""} onClick={() => setFilter("active")}>
            Active
          </button>
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
            All
          </button>
        </div>
      </div>
      <div className="st-panel-scroll">
        {approvals.length > 0 && (
          <section className="st-inbox">
            <div className="st-menu-label">Waiting for you</div>
            {approvals.map((a) => {
              const e = a.event;
              return (
                <div key={`${a.session.id}:${(e as { id: string }).id}`} className="st-approval">
                  <button className="st-link" onClick={() => open(a.session)}>
                    <strong className="st-ellipsis">{a.session.title ?? "Agent"}</strong>
                  </button>
                  {e.type === "permission.request" ? (
                    <>
                      <div className="small">
                        wants to use <code>{e.tool}</code>{" "}
                        <span className={`st-risk ${e.risk}`}>{e.risk} risk</span>
                      </div>
                      <pre className="st-approval-args">{summarizeArgs(e.args)}</pre>
                      <div className="st-row tight">
                        <button className="tiny" onClick={() => void answer(a, "allow")}>
                          Allow
                        </button>
                        <button className="ghost tiny" onClick={() => void answer(a, "always")}>
                          Always
                        </button>
                        <button className="ghost tiny danger" onClick={() => void answer(a, "deny")}>
                          Deny
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="small">
                      {e.type === "plan.proposed"
                        ? "proposed a plan for approval"
                        : e.type === "question"
                          ? `asks: ${e.text}`
                          : e.type}{" "}
                      <button className="ghost tiny" onClick={() => open(a.session)}>
                        Open
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        <section className="st-agent-section" aria-label="Running agents">
          <div className="st-agent-section-head">
            <span className="st-menu-label">Running</span>
            {stoppable.length > 0 && (
              <button
                className="ghost tiny danger"
                onClick={() => void stopAll()}
                title="Stop every running agent"
              >
                <IStop size={11} /> Stop all
              </button>
            )}
          </div>
          <div className="st-agent-tree">
            {activeTree.roots.map((s) => node(activeTree, s, 0, "live"))}
            {!activeTree.roots.length && (
              <p className="st-agent-none small muted">
                No agent is running. Conversations below are saved history: they use no CPU, memory or tokens.
              </p>
            )}
          </div>
        </section>

        {filter === "all" && (
          <section className="st-agent-section" aria-label="Conversations">
            <div className="st-agent-section-head">
              <span className="st-menu-label">
                Conversations {st.workspace ? `in ${base(st.workspace.root)}` : "in sandboxes"} (
                {history.roots.length})
              </span>
            </div>
            <div className="st-agent-tree">
              {history.roots.map((s) => node(history, s, 0, "history"))}
              {!history.roots.length && <p className="st-agent-none small muted">No conversations yet.</p>}
            </div>
          </section>
        )}

        {filter === "all" && orphans.length > 0 && (
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
            {(() => {
              const tree = buildTree(orphans);
              return tree.roots.map((s) => node(tree, s, 0, "orphan"));
            })()}
          </details>
        )}

        {filter === "active" && !activeTree.roots.length && history.roots.length > 0 && (
          <div className="st-empty">
            <button className="ghost" onClick={() => setFilter("all")}>
              Show {history.roots.length} saved conversation{history.roots.length === 1 ? "" : "s"}
            </button>
          </div>
        )}
        {!activeTree.roots.length && !history.roots.length && (
          <div className="st-empty">
            <button onClick={() => (st.setSessionId(null), st.setAgentPanel(true))}>Start an agent</button>
          </div>
        )}

        <details className="st-help">
          <summary>
            <IChevron size={11} /> Where agents come from
          </summary>
          <p className="small muted">
            Only rows under <strong>Running</strong> use resources. Every conversation is started by you (in
            this app, the web app or <code>cdr</code> in a terminal), by a goal, or by an agent that splits
            its work with <code>spawn_agent</code>. Read-only helpers share the checkout; writing helpers get
            their own Git worktree under <code>.harness/worktrees</code>, and the parent merges their
            branches. At most three helpers run per agent and eight agents per app window (
            <code>agents.maxConcurrent</code>, <code>agents.maxActive</code>). Deleting a conversation removes
            its helpers too.
          </p>
        </details>
      </div>
    </div>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  return JSON.stringify(args, null, 1).slice(0, 300);
}
