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
        branch: "cdr/x/research",
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
      branch: "cdr/x/research",
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
        branch: "cdr/goal-t",
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

describe("reduceSession: turn timing", () => {
  it("records when each turn started and finished", () => {
    const ev = (ts: string, b: EventBody, seq: number) =>
      ({ v: 1, seq, ts, sessionId: "s1", ...b }) as HarnessEvent;
    const events = [
      ev("2026-11-05T10:00:00.000Z", { type: "message.start", id: "u1", role: "user" }, 1),
      ev("2026-11-05T10:00:01.000Z", { type: "status", status: "running" }, 2),
      ev("2026-11-05T10:03:12.000Z", { type: "done", status: "success" }, 3),
      ev("2026-11-05T10:05:00.000Z", { type: "message.start", id: "u2", role: "user" }, 4),
    ];
    let s = initialSessionState();
    for (const e of events.slice(0, 3)) s = reduceSession(s, e);
    expect(s.turnTimes.u1).toEqual({ start: "2026-11-05T10:00:00.000Z", end: "2026-11-05T10:03:12.000Z" });
    s = reduceSession(s, events[3]);
    expect(s.currentTurn).toBe("u2");
    expect(s.turnTimes.u2).toEqual({ start: "2026-11-05T10:05:00.000Z" });
    expect(s.turnTimes.u1.end).toBe("2026-11-05T10:03:12.000Z");
  });
});

describe("reduceSession: checkpoints", () => {
  it("attaches a turn checkpoint to the user message it precedes and lists restores", () => {
    const s = play([
      { type: "checkpoint.created", id: "cp_1", reason: "turn", commit: "abc", files: 3 },
      { type: "message.start", id: "m1", role: "user" },
      { type: "message.end", id: "m1", text: "hi" },
      { type: "done", status: "success" },
      { type: "message.start", id: "m2", role: "user" },
      { type: "checkpoint.created", id: "cp_2", reason: "restore", commit: "def", files: 3 },
      {
        type: "checkpoint.restored",
        id: "cp_1",
        backupId: "cp_2",
        files: [{ path: "a.txt", status: "modified" }],
        changed: 1,
      },
    ]);
    expect(s.messages.m1.checkpoint).toBe("cp_1");
    expect(s.messages.m2.checkpoint).toBeUndefined();
    expect(s.timeline.at(-1)).toMatchObject({ kind: "event", event: { type: "checkpoint.restored" } });
  });

  it("attaches a checkpoint emitted after its user message (messageId) to that message only", () => {
    const s = play([
      { type: "message.start", id: "m1", role: "user" },
      { type: "message.end", id: "m1", text: "hi" },
      { type: "checkpoint.created", id: "cp_1", reason: "turn", commit: "abc", files: 3, messageId: "m1" },
      { type: "done", status: "success" },
      { type: "message.start", id: "m2", role: "user" },
      { type: "message.end", id: "m2", text: "again" },
    ]);
    expect(s.messages.m1.checkpoint).toBe("cp_1");
    expect(s.messages.m2.checkpoint).toBeUndefined();
  });
});

describe("reduceSession: recreate shots", () => {
  it("keeps the live page's screenshots per run, a re-taken file replacing its entry", () => {
    const shot = (kind: "peek" | "live", width: number): EventBody => ({
      type: "recreate.shot",
      runId: "r1",
      kind,
      width,
      height: 900,
      path: `.harness/recreate/r1/capture/${kind === "peek" ? `peek/${width}.jpg` : `live/${width}.png`}`,
    });
    const s = play([
      {
        type: "recreate.started",
        runId: "r1",
        url: "https://acme.example/",
        widths: [],
        targets: ["static"],
        dir: ".harness/recreate/r1",
      },
      shot("peek", 1440),
      shot("live", 390),
      shot("live", 1440),
      shot("live", 390),
    ]);
    const run = s.recreate!.runs.r1;
    expect(run.shots.map((x) => [x.kind, x.width, x.seq])).toEqual([
      ["peek", 1440, 2],
      ["live", 1440, 4],
      ["live", 390, 5],
    ]);
    // the timeline stays unchanged: shots belong to the preview, not to the chat
    expect(s.timeline.filter((t) => t.kind === "event" && t.event.type === "recreate.shot")).toEqual([]);
  });
});
