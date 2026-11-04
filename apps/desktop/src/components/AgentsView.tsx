import { useMemo, useState } from "react";
import { useApp } from "@web/app-state";
import type { SessionInfo } from "@harness/client";
import { useStudio } from "../store";
import type { Approval } from "./approvals";
import { useWorkspaceSessions } from "./AgentPanel";
import { IChevron, IStop, IBranch } from "./icons";

function ago(iso?: string) {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

export function AgentsView({ approvals }: { approvals: Approval[] }) {
  const st = useStudio();
  const { client, refreshSessions } = useApp();
  const list = useWorkspaceSessions();
  const [filter, setFilter] = useState<"active" | "all">("active");
  const children = useMemo(() => {
    const m = new Map<string, SessionInfo[]>();
    for (const s of list)
      if (s.parentSessionId) m.set(s.parentSessionId, [...(m.get(s.parentSessionId) ?? []), s]);
    return m;
  }, [list]);
  const roots = list.filter((s) => !s.parentSessionId || !list.some((p) => p.id === s.parentSessionId));
  const isActive = (s: SessionInfo): boolean =>
    s.status === "running" || s.status === "waiting" || (children.get(s.id) ?? []).some(isActive);
  const shown = filter === "active" ? roots.filter(isActive) : roots;
  const running = list.filter((s) => s.status === "running" || s.status === "waiting").length;

  const answer = async (a: Approval, decision: "allow" | "deny" | "always") => {
    const ev = a.event;
    if (ev.type !== "permission.request" || !client) return;
    await st.attempt(() => client.answerPermission(a.session.id, ev.id, decision));
    void refreshSessions();
  };

  const node = (s: SessionInfo, depth: number): JSX.Element => {
    const kids = children.get(s.id) ?? [];
    return (
      <div key={s.id}>
        <div
          className={`st-agent-node ${st.sessionId === s.id ? "on" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <button
            className="st-agent-node-main"
            onClick={() => {
              st.setSessionId(s.id);
              st.setAgentPanel(true);
            }}
            title={s.projectPath}
          >
            <span className={`st-status-dot ${s.status}`} title={s.status} />
            <span className="st-ellipsis">{s.title ?? (depth ? "Subagent" : "Conversation")}</span>
            {s.goalId && <span className="badge">goal</span>}
            {st.workspace && s.projectPath !== st.workspace.root && (
              <span className="muted small st-ellipsis" title={s.projectPath}>
                <IBranch size={11} /> {s.projectPath.split("/").pop()}
              </span>
            )}
            <span className="muted small">{ago(s.updatedAt ?? s.createdAt)}</span>
          </button>
          {(s.status === "running" || s.status === "waiting") && !s.externalRun && (
            <button
              className="ghost icon tiny"
              title="Stop"
              aria-label="Stop agent"
              onClick={() => client && void st.attempt(() => client.cancel(s.id))}
            >
              <IStop size={12} />
            </button>
          )}
        </div>
        {kids.map((k) => node(k, depth + 1))}
      </div>
    );
  };

  return (
    <div className="st-panel">
      <div className="st-panel-head">
        <span className="st-panel-title">
          Agents {running > 0 && <span className="st-count">{running} active</span>}
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
                  <button
                    className="st-link"
                    onClick={() => (st.setSessionId(a.session.id), st.setAgentPanel(true))}
                  >
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
                      <button
                        className="ghost tiny"
                        onClick={() => (st.setSessionId(a.session.id), st.setAgentPanel(true))}
                      >
                        Open
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}
        <div className="st-agent-tree">
          {shown.map((s) => node(s, 0))}
          {!shown.length && (
            <div className="st-empty">
              <p>{filter === "active" ? "No agents are running." : "No conversations yet."}</p>
              <button onClick={() => (st.setSessionId(null), st.setAgentPanel(true))}>Start an agent</button>
              {filter === "active" && roots.length > 0 && (
                <button className="ghost" onClick={() => setFilter("all")}>
                  Show all {roots.length}
                </button>
              )}
            </div>
          )}
        </div>
        <details className="st-help">
          <summary>
            <IChevron size={11} /> How subagents work
          </summary>
          <p className="small muted">
            Build tasks can split work with the <code>spawn_agent</code> tool. Read-only helpers share this
            checkout. Writing helpers get their own Git worktree and branch under{" "}
            <code>.harness/worktrees</code>, so parallel edits never collide; the parent merges their
            branches. Each helper has its own log, budget, and approvals.
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
