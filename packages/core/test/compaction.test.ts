import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, HarnessEvent } from "@harness/protocol";
import { initialSessionState, reduceSession, compactionLine } from "@harness/client";
import {
  BRIEF_MARKER,
  Harness,
  MockProvider,
  compactMessages,
  contextLimit,
  contextTokens,
  pruneMessages,
  registerSecret,
} from "@harness/core";
import type { ProviderEvent, ProviderRequest } from "@harness/core";
import { MOCK_MODELS, tempProject } from "./helpers.js";

function harnessWith(mock: MockProvider, extra: object = {}) {
  return new Harness({
    providers: { mock },
    skipGlobalConfig: true,
    loadEnv: false,
    configOverrides: { ...MOCK_MODELS, ...extra },
  });
}

const isCompactionCall = (req: ProviderRequest) => req.messages[0].content.startsWith("You compress");

/** Reports a fixed (large) input size, like a real provider that counts tool specs and framing. */
class InflatedUsage extends MockProvider {
  constructor(
    private inputTokens: number,
    opts: ConstructorParameters<typeof MockProvider>[0],
  ) {
    super(opts);
  }
  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    for await (const ev of super.stream(req))
      yield ev.type === "usage" && !isCompactionCall(req) ? { ...ev, inputTokens: this.inputTokens } : ev;
  }
}

function toolHistory(n: number, size: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => [
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: `c${i}`, name: "read_file", arguments: JSON.stringify({ path: `f${i}.ts` }) }],
    },
    { role: "tool" as const, toolCallId: `c${i}`, name: "read_file", content: `file ${i} `.repeat(size) },
  ]).flat();
}

describe("context budget", () => {
  it("caps the model window with maxContext and prefers measured usage over estimates", () => {
    expect(contextLimit(200_000)).toBe(200_000);
    expect(contextLimit(200_000, 0)).toBe(200_000);
    expect(contextLimit(200_000, 48_000)).toBe(48_000);
    expect(contextLimit(32_000, 48_000)).toBe(32_000);
    const msgs: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "x".repeat(400) },
    ];
    expect(contextTokens(msgs)).toBeLessThan(200);
    expect(contextTokens(msgs, { tokens: 5000, count: 1 })).toBeGreaterThan(5000);
    // a measurement covering more messages than exist (after compaction) is ignored
    expect(contextTokens(msgs, { tokens: 5000, count: 9 })).toBeLessThan(200);
  });
});

describe("pruneMessages", () => {
  it("trims old tool output and images outside the recent tail and logs the originals", () => {
    const root = tempProject();
    const history = {
      file: join(root, ".harness/history/s-executor.log"),
      ref: ".harness/history/s-executor.log",
    };
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task", images: [{ mimeType: "image/png", data: "AAAA" }] },
      { role: "user", content: "look", images: [{ mimeType: "image/png", data: "BBBB" }] },
      { role: "assistant", content: "ok" },
      ...toolHistory(4, 1000),
    ];
    const out = pruneMessages(msgs, 2, history)!;
    expect(out).not.toBeNull();
    expect(out[1].role === "user" && out[1].images?.length).toBe(1); // task images kept
    expect(out[2].role === "user" && out[2].images).toBeUndefined();
    expect(out[2].content).toContain("image(s) removed");
    const tools = out.filter((m) => m.role === "tool");
    expect(tools[0].content.length).toBeLessThan(2300);
    expect(tools[0].content).toContain(history.ref);
    expect(tools.at(-1)!.content.length).toBeGreaterThan(5000); // recent tail untouched
    expect(readFileSync(history.file, "utf8")).toContain("file 0 file 0");
    expect(readFileSync(join(root, ".harness/history/.gitignore"), "utf8")).toBe("*\n");
    // idempotent
    expect(pruneMessages(out.slice(0, -2), 2)).toBeNull();
  });
});

describe("compactMessages", () => {
  it("skips the model call when pruning reaches the target", async () => {
    const mock = new MockProvider({ replies: [{ text: "SHOULD NOT BE USED" }] });
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...toolHistory(4, 1000),
    ];
    const r = await compactMessages(msgs, {
      provider: mock,
      model: "m",
      keepRecent: 2,
      targetTokens: 10_000,
    });
    expect(r?.method).toBe("prune");
    expect(mock.calls).toHaveLength(0);
  });

  it("writes an execution brief, updates the previous brief and keeps the raw history searchable", async () => {
    const root = tempProject();
    const history = {
      file: join(root, ".harness/history/s-executor.log"),
      ref: ".harness/history/s-executor.log",
    };
    const secret = "sk-test-compaction-secret-1234567890";
    registerSecret(secret);
    const mock = new MockProvider({
      handler: (_req, i) => ({ text: i === 0 ? "- Applied: a.ts exports foo" : "- Applied: a.ts, b.ts" }),
    });
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "the task" },
      ...toolHistory(4, 10),
      { role: "tool", toolCallId: "x", name: "bash", content: `token ${secret}` },
      ...toolHistory(2, 10),
    ];
    const first = await compactMessages(msgs, { provider: mock, model: "m", keepRecent: 2, history });
    expect(first?.method).toBe("brief");
    expect(first!.usage.input).toBeGreaterThan(0);
    const brief = first!.messages[2];
    expect(brief.content.startsWith(BRIEF_MARKER)).toBe(true);
    expect(brief.content).toContain("a.ts exports foo");
    expect(brief.content).toContain(history.ref);
    expect(mock.calls[0].messages[0].content).toContain("Remaining plan");
    expect(mock.calls[0].messages[1].content).toContain("# Original task\nthe task");
    const log = readFileSync(history.file, "utf8");
    expect(log).toContain("f0.ts");
    expect(log).not.toContain(secret);

    // Second compaction: the previous brief is passed for updating, not re-summarised as history.
    const second = await compactMessages([...first!.messages, ...toolHistory(4, 10)], {
      provider: mock,
      model: "m",
      keepRecent: 2,
      history,
    });
    const input = mock.calls[1].messages[1].content;
    expect(input).toContain("# Previous brief (update it)\n- Applied: a.ts exports foo");
    expect(input.split("# History since then")[1]).not.toContain(BRIEF_MARKER);
    expect(second!.messages.filter((m) => m.content.startsWith(BRIEF_MARKER))).toHaveLength(1);
    expect(second!.messages[2].content).toContain("a.ts, b.ts");
  });

  it("keeps loaded skill instructions verbatim across repeated compactions", async () => {
    const skill = "# Recreate a page 1:1\nStages: capture, build, measure. " + "rule ".repeat(800).trim();
    const mock = new MockProvider({ handler: () => ({ text: "- run r-123: build done, measure next" }) });
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "recreate https://example.com 1:1" },
      { role: "assistant", content: "", toolCalls: [{ id: "s", name: "load_skill", arguments: "{}" }] },
      { role: "tool", toolCallId: "s", name: "load_skill", content: skill },
      ...toolHistory(4, 1000),
    ];
    // pruning never trims the skill
    expect(pruneMessages(msgs, 2)!.find((m) => m.role === "tool" && m.name === "load_skill")!.content).toBe(
      skill,
    );
    const first = await compactMessages(msgs, { provider: mock, model: "m", keepRecent: 2 });
    expect(first!.messages[2].content).toContain(skill);
    expect(mock.calls[0].messages[0].content).toContain("run ids");
    const second = await compactMessages([...first!.messages, ...toolHistory(4, 10)], {
      provider: mock,
      model: "m",
      keepRecent: 2,
    });
    const brief = second!.messages[2].content;
    expect(brief.split(skill)).toHaveLength(2); // exactly once
    expect(mock.calls[1].messages[1].content).not.toContain("rule rule rule rule rule rule rule rule rule");
  });

  it("keeps the history when the compaction model returns nothing", async () => {
    const mock = new MockProvider({ replies: [{ text: "" }] });
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...toolHistory(4, 10),
    ];
    let usage: { input: number; output: number } | undefined;
    const r = await compactMessages(msgs, {
      provider: mock,
      model: "m",
      keepRecent: 2,
      onUsage: (u) => (usage = u),
    });
    expect(r).toBeNull();
    // the summariser call still counts towards the budget
    expect(usage?.input).toBeGreaterThan(0);
  });

  it("keeps parallel tool results with their assistant call and never ends on the synthetic ack", async () => {
    const mock = new MockProvider({ replies: [{ text: "- brief" }] });
    const parallel: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: "read_file", arguments: "{}" })),
      },
      ...Array.from({ length: 7 }, (_, i) => ({
        role: "tool" as const,
        toolCallId: `p${i}`,
        name: "read_file",
        content: `result ${i}`,
      })),
    ];
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...toolHistory(3, 10),
      ...parallel,
    ];
    const r = await compactMessages(msgs, { provider: mock, model: "m", keepRecent: 6 });
    expect(r?.method).toBe("brief");
    const out = r!.messages;
    expect(out.at(-1)!.role).toBe("tool");
    expect(out.slice(-8)).toEqual(parallel);
    expect(out[2].content.startsWith(BRIEF_MARKER)).toBe(true);
    expect(out.some((m) => m.role === "assistant" && m.content.startsWith("Understood"))).toBe(false);
    // the recent results were not folded into the brief
    expect(mock.calls[0].messages[1].content).not.toContain("result 3");

    // keepRecent 0: everything is summarised and the context ends on the brief (a user turn), not an ack
    const mock2 = new MockProvider({ replies: [{ text: "- brief" }] });
    const all = await compactMessages(msgs, { provider: mock2, model: "m", keepRecent: 0 });
    expect(all!.messages.at(-1)!.role).toBe("user");
  });

  it("falls back to pruning when the summariser fails and rethrows aborts", async () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...toolHistory(4, 1000),
    ];
    const failing = new MockProvider({
      handler: () => {
        throw new Error("summariser down");
      },
    });
    const errors: string[] = [];
    const r = await compactMessages(msgs, {
      provider: failing,
      model: "m",
      keepRecent: 2,
      onError: (e) => errors.push(e.message),
    });
    expect(errors).toEqual(["summariser down"]);
    expect(r?.method).toBe("prune");
    const ac = new AbortController();
    const aborting = new MockProvider({
      handler: () => {
        ac.abort();
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      },
    });
    await expect(
      compactMessages(msgs, { provider: aborting, model: "m", keepRecent: 2, signal: ac.signal }),
    ).rejects.toThrow("Aborted");
  });
});

describe("compaction in the agent loop", () => {
  it("triggers from provider-reported usage, enforces maxContext and reports the result", async () => {
    const root = tempProject({ "a.txt": "small file\n" });
    let n = 0;
    // Messages stay tiny, but the provider reports 9K input tokens per call (e.g. large tool specs).
    const mock = new InflatedUsage(9_000, {
      contextWindow: 200_000,
      handler: (req) => {
        if (isCompactionCall(req)) return { text: "- Remaining: read a.txt again" };
        n++;
        return n < 6 ? { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] } : { text: "done" };
      },
    });
    const s = harnessWith(mock, {
      context: { maxContext: 10_000, compactAt: 0.8, keepRecent: 2, maxToolOutput: 2000, repoMapDepth: 1 },
    }).createSession({ projectPath: root });
    await s.chat("read a.txt a few times");
    const compacted = s.events.filter(
      (e): e is Extract<HarnessEvent, { type: "context.compacted" }> => e.type === "context.compacted",
    );
    expect(compacted.length).toBeGreaterThan(0);
    expect(compacted[0]).toMatchObject({ agent: "chat", method: "brief", count: 1 });
    expect(compacted[0].tokensBefore).toBeGreaterThan(8000);
    expect(compacted[0].historyPath).toMatch(/^\.harness\/history\/.+-chat\.log$/);
    expect(existsSync(join(root, compacted[0].historyPath!))).toBe(true);
    // the compaction call is counted in usage
    const usage = s.events.filter((e) => e.type === "usage");
    expect(usage.length).toBeGreaterThan(n);
    // never compacts twice in a row without new work in between
    const idx = s.events.map((e, i) => (e.type === "context.compacted" ? i : -1)).filter((i) => i >= 0);
    for (let i = 1; i < idx.length; i++)
      expect(s.events.slice(idx[i - 1], idx[i]).some((e) => e.type === "tool.result")).toBe(true);
  });

  it("keeps running with a warning when the summariser call throws", async () => {
    const root = tempProject({ "a.txt": "small file\n" });
    let n = 0;
    const mock = new InflatedUsage(9_000, {
      contextWindow: 200_000,
      handler: (req) => {
        if (isCompactionCall(req)) throw new Error("summariser unavailable");
        n++;
        return n < 6 ? { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] } : { text: "done" };
      },
    });
    const s = harnessWith(mock, {
      context: { maxContext: 10_000, compactAt: 0.8, keepRecent: 2, maxToolOutput: 2000, repoMapDepth: 1 },
    }).createSession({ projectPath: root });
    const r = await s.chat("read a.txt a few times");
    expect(r.status).toBe("completed");
    expect(r.text).toBe("done");
    expect(mock.calls.some(isCompactionCall)).toBe(true);
    expect(
      s.events.some(
        (e) => e.type === "log" && e.level === "warn" && e.message.includes("summariser unavailable"),
      ),
    ).toBe(true);
  });

  it("does not compact a small context under the default (window-only) budget", async () => {
    const root = tempProject({ "a.txt": "small\n" });
    const mock = new MockProvider({
      replies: [{ toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] }, { text: "done" }],
    });
    const s = harnessWith(mock).createSession({ projectPath: root });
    await s.chat("read");
    expect(s.events.some((e) => e.type === "context.compacted")).toBe(false);
    expect(mock.calls.some(isCompactionCall)).toBe(false);
  });

  it("is reduced into client state with a readable line", () => {
    const e = {
      seq: 1,
      ts: new Date().toISOString(),
      sessionId: "s",
      type: "context.compacted",
      agent: "executor",
      method: "brief",
      tokensBefore: 41_000,
      tokensAfter: 9_000,
      count: 2,
    } as HarnessEvent;
    const state = reduceSession(initialSessionState(), e);
    expect(state.compaction).toEqual({ count: 1, tokensBefore: 41_000, tokensAfter: 9_000 });
    expect(state.timeline).toHaveLength(1);
    expect(compactionLine(e as Extract<HarnessEvent, { type: "context.compacted" }>)).toBe(
      "Context compacted (earlier work condensed into a brief): ~41K → ~9K tokens · 2× so far",
    );
  });
});
