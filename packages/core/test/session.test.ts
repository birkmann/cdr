import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent } from "@harness/protocol";
import {
  Harness,
  MockProvider,
  lastUser,
  rebuildMessages,
  compactMessages,
  extractSteps,
  parseReview,
} from "@harness/core";
import { MOCK_MODELS, tempProject } from "./helpers.js";

function harnessWith(mock: MockProvider, extra: object = {}) {
  return new Harness({
    providers: { mock },
    skipGlobalConfig: true,
    loadEnv: false,
    configOverrides: { ...MOCK_MODELS, ...extra },
  });
}

const types = (events: HarnessEvent[]) =>
  events.map((e) => e.type).filter((t) => !t.startsWith("context.") && t !== "message.delta");

describe("agent loop via Session.chat", () => {
  it("edits a file through tool calls and records events", async () => {
    const root = tempProject({ "a.txt": "hello world\n" });
    const mock = new MockProvider({
      replies: [
        { text: "Reading.", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
        { toolCalls: [{ name: "patch_file", args: { path: "a.txt", search: "world", replace: "harness" } }] },
        { text: "Changed world to harness." },
      ],
    });
    const h = harnessWith(mock);
    const s = h.createSession({ projectPath: root, permissionMode: "auto" });
    const r = await s.chat("change world to harness");
    expect(r.status).toBe("completed");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello harness\n");
    expect(mock.calls).toHaveLength(3);
    // system prompt contains env + repo map; second call contains tool result
    expect(mock.calls[0].messages[0].content).toContain("# Repository map");
    expect(mock.calls[1].messages.at(-1)).toMatchObject({ role: "tool", content: "1\thello world" });
    const t = types(s.events);
    expect(t[0]).toBe("session.created");
    expect(t).toContain("tool.call");
    expect(t).toContain("tool.result");
    expect(t.at(-2)).toBe("done");
    const result = s.events.find((e) => e.type === "tool.result" && e.name === "patch_file");
    expect(result && result.type === "tool.result" && result.diff).toContain("+hello harness");
    // persisted
    expect(h.store.read(s.id).length).toBe(s.events.length);
  });

  it("asks for permission and respects deny", async () => {
    const root = tempProject();
    const mock = new MockProvider({
      replies: [
        { toolCalls: [{ name: "write_file", args: { path: "x.txt", content: "x" } }] },
        { text: "ok, not writing" },
      ],
    });
    const s = harnessWith(mock).createSession({ projectPath: root, permissionMode: "ask" });
    s.subscribe((e) => {
      if (e.type === "permission.request") setTimeout(() => s.resolvePermission(e.id, "deny"), 5);
    });
    await s.chat("write x");
    expect(existsSync(join(root, "x.txt"))).toBe(false);
    expect(mock.calls[1].messages.at(-1)?.content).toContain("denied");
    expect(s.events.some((e) => e.type === "permission.resolved" && e.decision === "deny")).toBe(true);
  });

  it("returns errors for bad tool calls without crashing", async () => {
    const root = tempProject();
    const mock = new MockProvider({
      replies: [
        {
          toolCalls: [
            { name: "nope", args: {} },
            { name: "read_file", args: {} },
          ],
        },
        { text: "giving up" },
      ],
    });
    const s = harnessWith(mock).createSession({ projectPath: root, permissionMode: "auto" });
    await s.chat("x");
    const toolMsgs = mock.calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(toolMsgs[0]).toContain('Unknown tool "nope"');
    expect(toolMsgs[1]).toContain('Missing required argument "path"');
  });

  it("stops at max turns", async () => {
    const root = tempProject({ "a.txt": "a" });
    const mock = new MockProvider({
      handler: () => ({ toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] }),
    });
    const s = harnessWith(mock, { limits: { maxTurns: 4 } }).createSession({ projectPath: root });
    const r = await s.chat("loop forever");
    expect(r.status).toBe("max_turns");
    expect(mock.calls).toHaveLength(4);
    // repetition guard fired
    expect(mock.calls[3].messages.at(-1)?.content).toContain("three times in a row");
  });

  it("can be cancelled while waiting for permission", async () => {
    const root = tempProject();
    const mock = new MockProvider({
      replies: [{ toolCalls: [{ name: "write_file", args: { path: "x.txt", content: "x" } }] }],
    });
    const s = harnessWith(mock).createSession({ projectPath: root });
    s.subscribe((e) => {
      if (e.type === "permission.request") setTimeout(() => s.cancel(), 5);
    });
    const r = await s.chat("write");
    expect(r.status).toBe("cancelled");
    expect(s.status).toBe("cancelled");
    expect(s.isRunning).toBe(false);
  });

  it("resumes a conversation from the JSONL log", async () => {
    const root = tempProject();
    const sessionsDir = join(tempProject(), "sessions");
    const mock = new MockProvider({ handler: (req) => ({ text: `echo: ${lastUser(req.messages)}` }) });
    const h1 = new Harness({
      sessionsDir,
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s1 = h1.createSession({ projectPath: root });
    await s1.chat("first");
    const h2 = new Harness({
      sessionsDir,
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s2 = h2.getSession(s1.id);
    expect(rebuildMessages(s2.events, "chat").map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    await s2.chat("second");
    const last = mock.calls.at(-1)!.messages;
    expect(last.map((m) => m.content)).toEqual([expect.any(String), "first", "echo: first", "second"]);
    expect(h2.listSessions()[0].id).toBe(s1.id);
    const forked = h2.forkSession(s1.id);
    expect(rebuildMessages(forked.events, "chat")).toHaveLength(5);
  });

  it("loads AGENTS.md rules and memory into the system prompt", async () => {
    const root = tempProject({
      "AGENTS.md": "Always use tabs.",
      ".harness/memory/MEMORY.md": "- The API lives in src/api",
    });
    const mock = new MockProvider({ replies: [{ text: "ok" }] });
    await harnessWith(mock).createSession({ projectPath: root }).chat("hi");
    const sys = mock.calls[0].messages[0].content;
    expect(sys).toContain("Always use tabs.");
    expect(sys).toContain("The API lives in src/api");
  });

  it("redacts secrets in events and tool output", async () => {
    const root = tempProject({ "cfg.txt": "token=sk-abcdefghijklmnopqrstuvwxyz123\n" });
    const mock = new MockProvider({
      replies: [{ toolCalls: [{ name: "read_file", args: { path: "cfg.txt" } }] }, { text: "ok" }],
    });
    const s = harnessWith(mock).createSession({ projectPath: root });
    await s.chat("read");
    expect(JSON.stringify(s.events)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123");
    expect(mock.calls[1].messages.at(-1)?.content).toContain("[REDACTED]");
  });

  it("runs afterEdit hooks and feeds output back", async () => {
    const root = tempProject();
    const mock = new MockProvider({
      replies: [
        { toolCalls: [{ name: "write_file", args: { path: "a.txt", content: "a" } }] },
        { text: "done" },
      ],
    });
    const s = harnessWith(mock, { hooks: { afterEdit: "echo HOOK_RAN" } }).createSession({
      projectPath: root,
      permissionMode: "auto",
    });
    await s.chat("go");
    expect(mock.calls[1].messages.at(-1)?.content).toContain("HOOK_RAN");
  });

  it("onStop hook forces continuation until it passes", async () => {
    const root = tempProject();
    const mock = new MockProvider({
      replies: [
        { text: "I'm done" },
        { toolCalls: [{ name: "write_file", args: { path: "ok.txt", content: "y" } }] },
        { text: "fixed" },
      ],
    });
    const s = harnessWith(mock, {
      hooks: { onStop: "test -f ok.txt || (echo missing ok.txt; exit 1)" },
    }).createSession({ projectPath: root, permissionMode: "auto" });
    const r = await s.chat("go");
    expect(r.text).toBe("fixed");
    expect(mock.calls[1].messages.at(-1)?.content).toContain("missing ok.txt");
  });
});

describe("compaction", () => {
  it("summarises old messages and keeps tool pairs intact", async () => {
    const mock = new MockProvider({ replies: [{ text: "- read a.ts, it exports foo" }] });
    const msgs = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "task" },
      ...Array.from({ length: 6 }, (_, i) => [
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: `c${i}`, name: "read_file", arguments: "{}" }],
        },
        { role: "tool" as const, toolCallId: `c${i}`, name: "read_file", content: "x".repeat(1000) },
      ]).flat(),
    ];
    const r = await compactMessages(msgs, {
      provider: mock,
      model: "m",
      keepRecent: 3,
      reasoningEffort: "none",
    });
    expect(mock.calls[0].reasoningEffort).toBe("none");
    expect(r).not.toBeNull();
    const out = r!.messages;
    expect(out[0].content).toBe("sys");
    expect(out[1].content).toBe("task");
    expect(out[2].content).toContain("it exports foo");
    // first kept message after the summary must not be an orphan tool result
    const firstKept = out.findIndex(
      (m, i) => i > 2 && m.role !== "user" && !(m.role === "assistant" && m.content.startsWith("Understood")),
    );
    expect(out[firstKept].role).toBe("assistant");
  });

  it("is triggered automatically by the loop when the context is nearly full", async () => {
    const root = tempProject({ "big.txt": "y".repeat(3000) });
    let n = 0;
    const mock = new MockProvider({
      contextWindow: 2000,
      handler: (req) => {
        if (req.messages[0].content.startsWith("You compress")) return { text: "SUMMARY" };
        n++;
        return n < 4 ? { toolCalls: [{ name: "read_file", args: { path: "big.txt" } }] } : { text: "done" };
      },
    });
    const s = harnessWith(mock, {
      context: { compactAt: 0.7, keepRecent: 2, maxToolOutput: 2000, repoMapDepth: 1 },
    }).createSession({ projectPath: root });
    await s.chat("read big");
    expect(s.events.some((e) => e.type === "context.replace")).toBe(true);
    expect(mock.calls.some((c) => c.messages.some((m) => m.content.includes("SUMMARY")))).toBe(true);
  });
});

describe("workflow", () => {
  it("parses plan steps and review JSON", () => {
    expect(
      extractSteps("# Plan\n## Steps\n1. Do a\n   more about a\n2. Do b\n## Files to touch\n- x"),
    ).toEqual(["Do a\nmore about a", "Do b"]);
    const r = parseReview(
      'Here:\n```json\n{"summary":"ok","findings":[{"severity":"blocking","file":"a.ts","line":3,"issue":"bug"},{"severity":"weird","issue":"x"}]}\n```',
    );
    expect(r.findings).toEqual([
      { severity: "blocking", file: "a.ts", line: 3, issue: "bug", suggestion: undefined },
      { severity: "minor", file: undefined, line: undefined, issue: "x", suggestion: undefined },
    ]);
    expect(parseReview("no json here").parsed).toBe(false);
  });

  it("runs plan → approval → execute → verify (retry) → review (blocking → fix) → finish", async () => {
    const root = tempProject({ "check.sh": "grep -q fixed out.txt\n", "AGENTS.md": "rules" }, { git: true });
    const mock = new MockProvider({
      handler: (req) => {
        const sys = req.messages[0].content;
        const last = req.messages.at(-1)!;
        if (sys.startsWith("You are the PLANNER")) {
          if (last.role === "user") return { toolCalls: [{ name: "list_dir", args: {} }] };
          return {
            text: "# Plan: write out.txt\n## Steps\n1. write out.txt\n## Verification\n- bash check.sh",
          };
        }
        if (sys.includes("code REVIEWER")) {
          expect(last.content).toContain("+fixed");
          return {
            text: '```json\n{"summary":"needs marker","findings":[{"severity":"blocking","file":"out.txt","issue":"missing reviewed marker"}]}\n```',
          };
        }
        // executor
        if (last.role === "user" && last.content.startsWith("Task:")) {
          expect(last.content).toContain("Approved plan");
          return { toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "broken\n" } }] };
        }
        if (last.role === "user" && last.content.startsWith("Verification FAILED")) {
          return { toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "fixed\n" } }] };
        }
        if (last.role === "user" && last.content.includes("blocking problems")) {
          return {
            toolCalls: [
              { name: "patch_file", args: { path: "out.txt", search: "fixed", replace: "fixed reviewed" } },
            ],
          };
        }
        return { text: "Implemented." };
      },
    });
    const s = harnessWith(mock, { verify: { test: "bash check.sh", maxAttempts: 3 } }).createSession({
      projectPath: root,
      permissionMode: "auto",
    });
    let planEvent: HarnessEvent | undefined;
    s.subscribe((e) => {
      if (e.type === "plan.proposed") {
        planEvent = e;
        setTimeout(() => s.decidePlan(e.id, "approve"), 5);
      }
    });
    const r = await s.run("create out.txt");
    if (r.status !== "success")
      console.log(
        r.summary,
        s.events.filter((e) => e.type === "error" || e.type === "verify.result" || e.type === "log"),
      );
    expect(planEvent).toBeDefined();
    expect(r.status).toBe("success");
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("fixed reviewed\n");
    const verify = s.events.filter((e) => e.type === "verify.result");
    expect(verify.map((v) => v.type === "verify.result" && v.exitCode)).toEqual([1, 0, 0]);
    expect(existsSync(r.planPath!)).toBe(true);
    const report = readFileSync(r.reportPath!, "utf8");
    expect(report).toContain("**Status:** success");
    expect(report).toContain("out.txt");
    const phases = s.events
      .filter((e) => e.type === "phase.start")
      .map((e) => e.type === "phase.start" && e.phase);
    expect(phases).toEqual([
      "plan",
      "execute",
      "verify",
      "execute",
      "verify",
      "review",
      "execute",
      "verify",
      "finish",
    ]);
    expect(s.status).toBe("done");
  });

  it("re-plans on rejection with feedback and stops on plain rejection", async () => {
    const root = tempProject();
    let plans = 0;
    const mock = new MockProvider({ handler: () => ({ text: `# Plan v${++plans}\n## Steps\n1. x` }) });
    const s = harnessWith(mock).createSession({ projectPath: root });
    s.subscribe((e) => {
      if (e.type === "plan.proposed")
        setTimeout(
          () =>
            plans === 1
              ? s.decidePlan(e.id, "reject", undefined, "smaller please")
              : s.decidePlan(e.id, "reject"),
          5,
        );
    });
    const r = await s.run("task");
    expect(plans).toBe(2);
    expect(mock.calls[1].messages.at(-1)?.content).toContain("smaller please");
    expect(r.status).toBe("cancelled");
  });

  it("fails after max verify attempts", async () => {
    const root = tempProject();
    const mock = new MockProvider({ handler: () => ({ text: "tried" }) });
    const s = harnessWith(mock, { verify: { test: "exit 1", maxAttempts: 2 } }).createSession({
      projectPath: root,
      workflow: "quick-fix",
    });
    const r = await s.run("impossible");
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("verification failed after 2");
  });

  it("plan phase cannot write files", async () => {
    const root = tempProject();
    const mock = new MockProvider({
      handler: (req) => {
        const names = (req.tools ?? []).map((t) => t.name);
        expect(names).not.toContain("write_file");
        expect(names).not.toContain("patch_file");
        expect(names).toContain("read_file");
        return { text: "# Plan\n## Steps\n1. a" };
      },
    });
    const s = harnessWith(mock).createSession({ projectPath: root, workflow: "plan-only" });
    const r = await s.run("plan it");
    expect(r.status).toBe("success");
    expect(r.plan).toContain("# Plan");
  });

  it("fresh context per plan step", async () => {
    const root = tempProject();
    const seen: string[] = [];
    const mock = new MockProvider({
      handler: (req) => {
        if (req.messages[0].content.startsWith("You are the PLANNER"))
          return { text: "# Plan\n## Steps\n1. make a.txt\n2. make b.txt\n## Verification\n- none" };
        seen.push(`${req.messages.length}:${req.messages[1].content.match(/implement ONLY step (\d)/)?.[1]}`);
        return { text: "ok" };
      },
    });
    const h = harnessWith(mock, {
      workflows: {
        stepwise: {
          name: "stepwise",
          freshContextPerStep: true,
          phases: [{ phase: "plan", gate: false }, { phase: "execute" }, { phase: "finish" }],
        },
      },
    });
    const s = h.createSession({ projectPath: root, workflow: "stepwise" });
    await s.run("two files");
    expect(seen).toEqual(["2:1", "2:2"]);
  });

  it("commits on a branch when requested", async () => {
    const root = tempProject({ "a.txt": "a\n" }, { git: true });
    writeFileSync(join(root, ".gitignore"), ".harness/\n");
    const mock = new MockProvider({
      replies: [
        { toolCalls: [{ name: "write_file", args: { path: "a.txt", content: "b\n" } }] },
        { text: "done" },
      ],
    });
    const s = harnessWith(mock).createSession({
      projectPath: root,
      workflow: "quick-fix",
      permissionMode: "auto",
    });
    const r = await s.run("change a", { commit: true });
    expect(r.branch).toBe("harness/change-a");
  });

  it("enforces a per-project lock", async () => {
    const root = tempProject();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const mock = new MockProvider({ handler: async () => (await gate, { text: "ok" }) });
    const h = harnessWith(mock);
    const a = h.createSession({ projectPath: root });
    const b = h.createSession({ projectPath: root });
    const pa = a.chat("one");
    await new Promise((r) => setTimeout(r, 20));
    await expect(b.chat("two")).rejects.toThrow(/busy/);
    release();
    await pa;
    await expect(b.chat("two")).resolves.toMatchObject({ status: "completed" });
  });
});

describe("thinking effort", () => {
  it("persists choices, forwards them across turns, and restores them after restart", async () => {
    const mock = new MockProvider({ handler: () => ({ text: "Done" }) });
    mock.capabilities = () => ({
      tools: true,
      json: true,
      contextWindow: 100_000,
      reasoningEfforts: ["none", "low", "high", "max"],
    });
    const h = harnessWith(mock);
    const s = h.createSession({ projectPath: tempProject(), reasoningEffort: "low" });
    await s.chat("Hello");
    expect(mock.calls.at(-1)?.reasoningEffort).toBe("low");
    s.updateSettings({ reasoningEffort: "max" });
    await s.chat("Consider more carefully");
    expect(mock.calls.at(-1)?.reasoningEffort).toBe("max");
    const restored = harnessWith(mock).getSession(s.id);
    expect(restored.info().reasoningEffort).toBe("max");
    await restored.chat("Continue");
    expect(mock.calls.at(-1)?.reasoningEffort).toBe("max");
    restored.updateSettings({ reasoningEffort: "auto" });
    expect(harnessWith(mock).getSession(s.id).config.reasoningEffort).toBe("auto");
    expect(() => restored.updateSettings({ reasoningEffort: "medium" })).toThrow("not supported");
    expect(() => restored.updateSettings({ reasoningEffort: "invalid" as never })).toThrow("Invalid");
    expect(restored.info().reasoningEffort).toBe("auto");
  });

  it("rejects effort changes while a request is in flight", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const mock = new MockProvider({
      handler: async () => {
        await pending;
        return { text: "Done" };
      },
    });
    const s = harnessWith(mock).createSession({ projectPath: tempProject() });
    const run = s.chat("Work");
    expect(() => s.updateSettings({ reasoningEffort: "auto" })).toThrow("while running");
    finish();
    await run;
  });
});
