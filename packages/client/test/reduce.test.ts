import { describe, expect, it } from "vitest";
import type { EventBody, HarnessEvent } from "@harness/protocol";
import { initialSessionState, reduceSession } from "@harness/client";

function play(bodies: EventBody[]) {
  let seq = 0;
  return bodies.reduce(
    (s, b) => reduceSession(s, { v: 1, seq: ++seq, ts: "", sessionId: "s1", ...b } as HarnessEvent),
    initialSessionState(),
  );
}

describe("reduceSession: subagents and goals", () => {
  it("tracks agents by id", () => {
    const s = play([
      { type: "session.created", projectPath: "/p", workflow: "default", parentSessionId: "p0" },
      {
        type: "agent.spawned",
        agentId: "a1",
        sessionId: "c1",
        parentToolCallId: "call_1",
        task: "research",
        role: "executor",
        isolation: "worktree",
        worktree: "/p/.harness/worktrees/x",
        branch: "morrow/x/research",
      },
      {
        type: "agent.status",
        agentId: "a1",
        status: "waiting",
        phase: "execute",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      { type: "agent.status", agentId: "unknown", status: "running" },
      { type: "agent.finished", agentId: "a1", status: "success", summary: "found it", diffStat: " a | 1 +" },
      { type: "agent.status", agentId: "a1", status: "idle" },
    ]);
    expect(s.parentSessionId).toBe("p0");
    expect(Object.keys(s.agents)).toEqual(["a1"]);
    expect(s.agents.a1).toMatchObject({
      sessionId: "c1",
      task: "research",
      isolation: "worktree",
      branch: "morrow/x/research",
      status: "done",
      result: "success",
      phase: "execute",
      usage: { inputTokens: 5, outputTokens: 2 },
      summary: "found it",
      diffStat: " a | 1 +",
    });
    expect(
      s.timeline.filter((t) => t.kind === "event").map((t) => (t as { event: HarnessEvent }).event.type),
    ).toEqual(["agent.spawned", "agent.finished"]);
  });

  it("tracks goal progress, checkpoints and criteria", () => {
    const criteria = [{ criterion: "tests pass", met: false, evidence: "1 failing" }];
    const s1 = play([
      { type: "session.created", projectPath: "/w", workflow: "autonomous", goalId: "goal-1" },
      {
        type: "goal.started",
        goalId: "goal-1",
        title: "T",
        worktree: "/w",
        branch: "morrow/goal-t",
        round: 1,
      },
      { type: "goal.checkpoint", goalId: "goal-1", commit: "abc", step: "round 1", summary: "s", criteria },
      { type: "goal.paused", goalId: "goal-1", reason: "permission", detail: "bash" },
    ]);
    expect(s1.goalId).toBe("goal-1");
    expect(s1.goal).toMatchObject({
      round: 1,
      status: "running",
      paused: { reason: "permission" },
      criteria,
    });
    expect(s1.goal?.checkpoints).toEqual([
      { commit: "abc", step: "round 1", summary: "s", criteria, seq: 3 },
    ]);

    const met = [{ criterion: "tests pass", met: true }];
    const s2 = play([
      { type: "goal.started", goalId: "goal-1", title: "T", worktree: "/w", branch: "b", round: 1 },
      { type: "goal.checkpoint", goalId: "goal-1", commit: "abc", step: "round 1", summary: "s", criteria },
      { type: "goal.paused", goalId: "goal-1", reason: "budget" },
      { type: "goal.started", goalId: "goal-1", title: "T", worktree: "/w", branch: "b", round: 2 },
      {
        type: "goal.checkpoint",
        goalId: "goal-1",
        commit: "def",
        step: "round 2",
        summary: "s2",
        criteria: met,
      },
      { type: "goal.finished", goalId: "goal-1", status: "success", branch: "b", summary: "all met" },
    ]);
    expect(s2.goal).toMatchObject({
      round: 2,
      status: "finished",
      result: "success",
      summary: "all met",
      criteria: met,
    });
    expect(s2.goal?.paused).toBeUndefined();
    expect(s2.goal?.checkpoints.map((c) => c.commit)).toEqual(["abc", "def"]);
  });
});
