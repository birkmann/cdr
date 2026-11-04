import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { Harness, MockProvider, DEFAULT_CONFIG } from "@harness/core";

const load = (n: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../schema/${n}.schema.json`, import.meta.url)), "utf8"));

describe("JSON schemas", () => {
  it("every event emitted by a real session validates against events.schema.json", async () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(load("events"));
    const root = mkdtempSync(join(tmpdir(), "schema-"));
    writeFileSync(join(root, "a.txt"), "a\n");
    const mock = new MockProvider({
      handler: (req) => {
        const sys = req.messages[0].content;
        const last = req.messages.at(-1)!;
        if (sys.startsWith("You are the PLANNER")) return { text: "# Plan\n## Steps\n1. x" };
        if (sys.includes("REVIEWER"))
          return { text: '{"summary":"s","findings":[{"severity":"nit","issue":"i"}]}' };
        if (last.role === "user")
          return {
            reasoning: "hmm",
            text: "go",
            toolCalls: [
              { name: "patch_file", args: { path: "a.txt", search: "a", replace: "b" } },
              { name: "todo", args: { items: [{ text: "t", status: "done" }] } },
              { name: "ask_user", args: { question: "ok?", options: ["y"] } },
            ],
          };
        return { text: "done" };
      },
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: {
        providers: { mock: { type: "mock" } },
        models: { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" },
        verify: { test: "true" },
      } as never,
    });
    const s = h.createSession({
      projectPath: root,
      autoApprove: { plan: true, permissions: true, questions: "y" },
    });
    await s.run("task");
    const types = new Set<string>();
    for (const e of s.events) {
      const ok = validate(e);
      if (!ok) throw new Error(`${e.type}: ${ajv.errorsText(validate.errors)}`);
      types.add(e.type);
    }
    expect(types.size).toBeGreaterThan(15);
  });

  it("the default config validates against config.schema.json", () => {
    const ajv = new Ajv({ strict: false });
    expect(ajv.validate(load("config"), DEFAULT_CONFIG)).toBe(true);
    expect(
      ajv.validate(load("config"), { providers: {}, models: {}, permissions: { mode: "sometimes" } }),
    ).toBe(false);
  });
});

describe("JSON schemas: subagent and goal events", () => {
  it("validates agent.* and goal.* events and rejects bad ones", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(load("events"));
    const env = { v: 1, seq: 1, ts: "2026-11-04T00:00:00Z", sessionId: "s" };
    const ok = [
      {
        type: "agent.spawned",
        agentId: "a",
        sessionId: "c",
        parentToolCallId: "t",
        task: "x",
        role: "executor",
        isolation: "shared",
      },
      {
        type: "agent.status",
        agentId: "a",
        status: "running",
        phase: "execute",
        usage: { inputTokens: 1, outputTokens: 2 },
      },
      { type: "agent.finished", agentId: "a", status: "success", summary: "s", diffStat: "a | 1" },
      { type: "goal.started", goalId: "g", title: "t", worktree: "/w", branch: "b", round: 1 },
      {
        type: "goal.checkpoint",
        goalId: "g",
        commit: "c",
        step: "round 1",
        summary: "s",
        criteria: [{ criterion: "x", met: true }],
      },
      { type: "goal.paused", goalId: "g", reason: "budget" },
      { type: "goal.finished", goalId: "g", status: "success", branch: "b", summary: "s" },
      { type: "session.created", projectPath: "/p", workflow: "default", parentSessionId: "p", goalId: "g" },
    ];
    for (const e of ok) expect(validate({ ...env, ...e }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...env, type: "agent.spawned", agentId: "a", isolation: "nope" })).toBe(false);
    expect(validate({ ...env, type: "goal.paused", goalId: "g", reason: "bored" })).toBe(false);
  });
});
