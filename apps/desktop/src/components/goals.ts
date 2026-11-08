import { useCallback, useEffect, useState } from "react";
import { useApp } from "@web/app-state";
import type { GoalInfo } from "@harness/client";
import { on } from "../ipc";

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
