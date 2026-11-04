import { useCallback, useEffect, useState } from "react";
import { useApp } from "@web/app-state";
import type { GoalInfo } from "@harness/client";
import { on } from "../ipc";
import { useStudio } from "../store";
import { IPlus, IRefresh } from "./icons";

export function useGoals(repo?: string): { goals: GoalInfo[]; reload(): void; error?: string } {
  const { client } = useApp();
  const [goals, setGoals] = useState<GoalInfo[]>([]);
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    if (!client || !repo) return setGoals([]);
    void client
      .listGoals({ repo })
      .then((g) => {
        setGoals(g.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        setError(undefined);
      })
      .catch((e) => setError((e as Error).message));
  }, [client, repo]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 4000);
    const un = on("goals://changed", reload);
    const h = () => reload();
    window.addEventListener("studio:goals-changed", h);
    return () => {
      clearInterval(t);
      un();
      window.removeEventListener("studio:goals-changed", h);
    };
  }, [reload]);
  return { goals, reload, error };
}

export const GOAL_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  running: "Running",
  "needs-attention": "Needs attention",
  review: "Ready for review",
  done: "Merged",
  failed: "Failed",
  discarded: "Discarded",
};

export function scheduleLabel(g: GoalInfo): string {
  if (!g.schedule) return "";
  if ("cron" in g.schedule) return ` · ${g.schedule.cron}`;
  return ` · at ${new Date(g.schedule.at).toLocaleString()}`;
}

export function GoalsView() {
  const st = useStudio();
  const root = st.workspace?.root;
  const { goals, reload, error } = useGoals(root);
  const [showClosed, setShowClosed] = useState(false);
  useEffect(() => {
    const h = () => st.openTab({ kind: "goal", id: "new" });
    window.addEventListener("studio:new-goal", h);
    return () => window.removeEventListener("studio:new-goal", h);
  }, [st]);
  if (!root || !st.isRepo)
    return (
      <div className="st-panel">
        <div className="st-panel-head">
          <span className="st-panel-title">Goals</span>
        </div>
        <div className="st-empty">
          <p>Goals run in Git worktrees. Open a Git repository to define goals.</p>
        </div>
      </div>
    );
  const open = goals.filter((g) => !["done", "discarded"].includes(g.status));
  const closed = goals.filter((g) => ["done", "discarded"].includes(g.status));
  const row = (g: GoalInfo) => (
    <button
      key={g.id}
      className={`st-goal-row ${st.active === `goal:${g.id}` ? "on" : ""}`}
      onClick={() => st.openTab({ kind: "goal", id: g.id })}
    >
      <div className="st-row">
        <strong className="st-ellipsis st-grow">{g.title}</strong>
        <span className={`st-goal-status ${g.status}`}>{GOAL_STATUS_LABEL[g.status] ?? g.status}</span>
      </div>
      <div className="muted small st-ellipsis">
        {g.acceptance.length} criteria
        {g.criteria?.length ? ` · ${g.criteria.filter((c) => c.met).length} met` : ""}
        {g.checkpoints ? ` · ${g.checkpoints} checkpoints` : ""}
        {g.usage?.cost ? ` · $${g.usage.cost.toFixed(2)}` : ""}
        {scheduleLabel(g)}
      </div>
    </button>
  );
  return (
    <div className="st-panel">
      <div className="st-panel-head">
        <span className="st-panel-title">Goals</span>
        <div className="st-row tight">
          <button className="ghost icon tiny" title="Refresh" aria-label="Refresh goals" onClick={reload}>
            <IRefresh size={15} />
          </button>
          <button
            className="ghost icon tiny"
            title="New goal"
            aria-label="New goal"
            onClick={() => st.openTab({ kind: "goal", id: "new" })}
          >
            <IPlus size={15} />
          </button>
        </div>
      </div>
      <div className="st-panel-scroll">
        {error && <p className="st-hint st-error">{error}</p>}
        {open.map(row)}
        {!open.length && (
          <div className="st-empty">
            <p>
              A goal is a task with acceptance criteria and a budget. It runs unattended on its own branch and
              waits for your review.
            </p>
            <button onClick={() => st.openTab({ kind: "goal", id: "new" })}>New goal</button>
          </div>
        )}
        {closed.length > 0 && (
          <button className="st-hint-btn" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? "Hide" : "Show"} {closed.length} closed
          </button>
        )}
        {showClosed && closed.map(row)}
      </div>
    </div>
  );
}
