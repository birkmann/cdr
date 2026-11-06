import { describe, expect, it } from "vitest";
import type { EventBody, HarnessEvent } from "@harness/protocol";
import { buildTurnReport, initialSessionState, reduceSession, turnItems, turnReportMarkdown } from "@harness/client";

/** Replays events one second apart. */
function play(bodies: EventBody[]) {
  let seq = 0;
  const t0 = Date.parse("2026-01-01T10:00:00Z");
  return bodies.reduce(
    (s, b) =>
      reduceSession(s, {
        v: 1,
        seq: ++seq,
        ts: new Date(t0 + seq * 1000).toISOString(),
        sessionId: "s1",
        ...b,
      } as HarnessEvent),
    initialSessionState(),
  );
}

const call = (id: string, name: string, args: unknown, ok = true, output = "done"): EventBody[] => [
  { type: "tool.call", id, name, args },
  { type: "tool.result", id, name, ok, output },
];

const reply = (id: string, text = "", tagged = true): EventBody[] => [
  { type: "message.start", id, role: "assistant", agent: "executor" },
  { type: "reasoning.delta", id, text: "thinking" },
  ...(tagged
    ? ([{ type: "usage", inputTokens: 50, outputTokens: 5, purpose: "thinking", messageId: id }] as EventBody[])
    : []),
  { type: "reasoning.summary", id, text: `decided ${id}` },
  { type: "message.end", id, text },
  tagged
    ? { type: "usage", inputTokens: 1000, outputTokens: 100, cost: 0.01, model: "m/x", purpose: "reply", messageId: id }
    : { type: "usage", inputTokens: 1000, outputTokens: 100, model: "m/x" },
];

function session(tagged = true) {
  return play([
    { type: "message.start", id: "u1", role: "user" },
    { type: "message.end", id: "u1", text: "Build a page" },
    { type: "status", status: "running" },
    ...reply("a1", "", tagged),
    ...call("t1", "read_file", { path: "README.md" }, true, "x".repeat(4000)),
    ...call("t2", "grep", { pattern: "foo" }),
    ...reply("a2", "", tagged),
    ...call("t3", "write_file", { path: "index.html", content: "<html>" }),
    ...reply("a3", "", tagged),
    ...call("t4", "patch_file", { path: "index.html" }, false, "old text not found"),
    ...call("t5", "patch_file", { path: "index.html" }),
    ...reply("a4", "", tagged),
    ...call("t6", "check_preview", { path: "index.html" }, true, "No problems found."),
    { type: "usage", inputTokens: 300, outputTokens: 30, purpose: "compaction" },
    { type: "context.compacted", agent: "executor", method: "brief", tokensBefore: 9000, tokensAfter: 2000, count: 1 },
    ...reply("a5", "All done.", tagged),
    { type: "done", status: "success" },
  ]);
}

describe("usage attribution", () => {
  it("credits tagged usage to its message and the turn", () => {
    const s = session();
    expect(s.messages.a1.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100, calls: 1, model: "m/x" });
    expect(s.messages.a1.thinkingUsage).toMatchObject({ inputTokens: 50, outputTokens: 5, calls: 1 });
    expect(s.turnOverhead.u1.compaction).toMatchObject({ inputTokens: 300, calls: 1 });
    expect(s.tools.t1.startedAt).toBeTruthy();
    expect(s.tools.t1.endedAt).toBeTruthy();
  });

  it("places untagged usage of older logs by position", () => {
    const s = session(false);
    expect(s.messages.a2.usage).toMatchObject({ inputTokens: 1000, calls: 1 });
    expect(s.turnOverhead.u1.compaction.calls).toBe(1);
  });
});

describe("buildTurnReport", () => {
  const s = session();
  const r = buildTurnReport({
    items: turnItems(s.timeline, s.messages, "u1"),
    messages: s.messages,
    tools: s.tools,
    overhead: s.turnOverhead.u1,
    times: s.turnTimes.u1,
  });

  it("counts calls, tools and tokens", () => {
    expect(r.status).toBe("success");
    expect(r.totals).toMatchObject({ modelCalls: 5, toolCalls: 6, failedTools: 1 });
    expect(r.tokens.reply.inputTokens).toBe(5000);
    expect(r.tokens.thinking.calls).toBe(5);
    expect(r.totals.inputTokens).toBe(5000 + 250 + 300);
    expect(r.durationMs).toBeGreaterThan(0);
    expect(r.time.thinking + r.time.explore + r.time.build + r.time.check + r.time.idle).toBe(r.durationMs);
  });

  it("tells the story in stages", () => {
    expect(r.stages.map((x) => x.kind)).toEqual(["explore", "build", "check", "answer"]);
    expect(r.stages[0].detail).toContain("read README.md");
    expect(r.stages[1].detail).toMatch(/wrote index\.html.*1 failed/);
    expect(r.stages[0].decisions).toEqual(["decided a1"]);
    expect(r.files).toEqual([{ path: "index.html", created: true, edits: 1, failedEdits: 1, reads: 0 }]);
    expect(r.checks).toEqual([{ label: "Checked the preview of index.html", ok: true, detail: "No problems found." }]);
  });

  it("estimates how much re-sent tool output cost, stopping at compaction", () => {
    const top = r.consumers[0];
    expect(top.toolId).toBe("t1");
    // ~1000 tokens, re-sent with calls 2–4 (the compaction before call 5 drops it)
    expect(top).toMatchObject({ outputTokens: 1000, carriedCalls: 3, carriedTokens: 3000 });
  });

  it("suggests improvements", () => {
    const titles = r.insights.map((i) => i.title);
    expect(titles).toContain("1 tool call failed");
    expect(titles).toContain("One tool result took a large share of the input");
    expect(titles).toContain("Context was compacted 1 time");
    expect(titles).not.toContain("The last changes were not checked");
    expect(turnReportMarkdown(r, "Build a page")).toMatch(/## How it got there[\s\S]*Explored/);
  });

  it("flags unchecked final edits and a stopped run", () => {
    const t = play([
      { type: "message.start", id: "u1", role: "user" },
      ...reply("a1"),
      ...call("t1", "write_file", { path: "a.ts" }),
      { type: "error", message: "executor: reached max turns (1)", recoverable: false },
      { type: "done", status: "failed" },
    ]);
    const rep = buildTurnReport({
      items: turnItems(t.timeline, t.messages, "u1"),
      messages: t.messages,
      tools: t.tools,
      times: t.turnTimes.u1,
    });
    expect(rep.status).toBe("stopped");
    expect(rep.insights[0]).toMatchObject({ level: "warn", detail: "executor: reached max turns (1)" });
    expect(rep.insights.map((i) => i.title)).toContain("The last changes were not checked");
  });
});
