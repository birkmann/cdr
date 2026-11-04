import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Budget, Harness, MockProvider, type ProviderEvent, type ProviderRequest } from "@harness/core";
import { MOCK_MODELS, tempProject } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("optional local usage limits", () => {
  it.each([undefined, 0, 400_000])("applies only an explicitly enabled token cap (%s)", async (limit) => {
    class HighUsageMock extends MockProvider {
      async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        for await (const event of super.stream(req)) {
          yield event.type === "usage"
            ? { type: "usage", inputTokens: 403_000, outputTokens: 27_685 }
            : event;
        }
      }
    }
    const mock = new HighUsageMock({
      replies: [
        { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
        { text: "Finished after the tool call." },
      ],
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: { ...MOCK_MODELS, limits: limit === undefined ? {} : { maxTokens: limit } },
    });
    const s = h.createSession({ projectPath: tempProject({ "a.txt": "hello" }) });
    expect(s.config.limits?.maxTokens).toBe(limit);
    const result = await s.chat("read the file");
    if (limit) {
      expect(result.status).toBe("budget");
      expect(mock.calls).toHaveLength(1);
      expect(s.budget.exceeded()).toContain("430685 > 400000");
      expect(s.budget.exceeded()).toContain("limits.maxTokens");
      expect(s.budget.exceeded()).toContain("separate from your provider account balance");
    } else {
      expect(result.status).toBe("completed");
      expect(mock.calls).toHaveLength(2);
      expect(s.budget.inputTokens + s.budget.outputTokens).toBe(861_370);
      expect(s.events.filter((e) => e.type === "error")).toHaveLength(0);
    }
  });

  it("identifies configured cost limits without claiming the provider balance is exhausted", () => {
    const budget = new Budget({ maxCost: 1 });
    budget.add(100, 100, 1.5);
    expect(budget.exceeded()).toContain("CDR's configured cost limit reached");
    expect(budget.exceeded()).toContain("limits.maxCost");
    expect(budget.exceeded()).toContain("not your provider account balance");
    const unlimited = new Budget({ maxCost: 0 });
    unlimited.add(100, 100, 1.5);
    expect(unlimited.exceeded()).toBeNull();
  });
});

describe("active run timeout", () => {
  it("excludes overlapping input waits once and keeps token limits active", () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const budget = new Budget({ timeoutMs: 1000, maxTokens: 10 });
    now += 200;
    const resumeA = budget.pauseForInput();
    now += 5000;
    const resumeB = budget.pauseForInput();
    resumeA();
    resumeA();
    now += 5000;
    expect(budget.activeElapsedMs).toBe(200);
    expect(budget.exceeded()).toBeNull();
    resumeB();
    now += 801;
    expect(budget.exceeded()).toContain("active-time timeout");
    budget.pauseForInput();
    budget.add(11, 0, 0);
    expect(budget.exceeded()).toContain("CDR's configured token limit reached");
  });

  it.each(["permission", "question", "plan"])(
    "continues after a long %s wait without timing out",
    async (kind) => {
      const root = tempProject();
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const mock = new MockProvider({
        handler: (req) => {
          now += 100;
          if (kind === "plan") {
            if (req.messages[0].content.startsWith("You are the PLANNER"))
              return { text: "# Plan\n## Steps\n1. Explain the approach" };
            if (req.messages[0].content.includes("REVIEWER"))
              return { text: '{"summary":"ok","findings":[]}' };
            return { text: "Completed." };
          }
          if (req.messages.at(-1)?.role === "user")
            return {
              toolCalls: [
                kind === "permission"
                  ? { name: "write_file", args: { path: "out.txt", content: "ok" } }
                  : { name: "ask_user", args: { question: "Which color?", options: ["Blue", "Green"] } },
              ],
            };
          return { text: "Completed." };
        },
      });
      const h = new Harness({
        providers: { mock },
        skipGlobalConfig: true,
        loadEnv: false,
        sessionsDir: join(root, ".sessions"),
        configOverrides: { ...MOCK_MODELS, limits: { timeoutMs: 1000 } },
      });
      const s = h.createSession({ projectPath: root, permissionMode: "ask" });
      let waited = false;
      s.subscribe((event) => {
        if (event.type !== "status" || event.status !== "waiting") return;
        waited = true;
        now += 2 * 60 * 60_000;
        expect(s.budget.exceeded()).toBeNull();
        const request = s.pendingRequests()[0];
        if (request.type === "permission.request") s.resolvePermission(request.id, "allow");
        else if (request.type === "question") s.answerQuestion(request.id, "Blue");
        else if (request.type === "plan.proposed") s.decidePlan(request.id, "approve");
      });
      const result = kind === "plan" ? await s.run("explain the approach") : await s.chat("help me");
      expect(waited).toBe(true);
      expect(result.status).toBe(kind === "plan" ? "success" : "completed");
      expect(s.budget.activeElapsedMs).toBeLessThan(1000);
      expect(s.pendingRequests()).toHaveLength(0);
    },
  );

  it("resumes budget accounting when a waiting request is cancelled", async () => {
    const root = tempProject();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const mock = new MockProvider({
      replies: [{ toolCalls: [{ name: "write_file", args: { path: "no.txt", content: "no" } }] }],
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      sessionsDir: join(root, ".sessions"),
      configOverrides: { ...MOCK_MODELS, limits: { timeoutMs: 1000 } },
    });
    const s = h.createSession({ projectPath: root });
    s.subscribe((event) => {
      if (event.type === "status" && event.status === "waiting") {
        now += 10_000;
        s.cancel();
      }
    });
    expect((await s.chat("write")).status).toBe("cancelled");
    expect(existsSync(join(root, "no.txt"))).toBe(false);
    expect(s.pendingRequests()).toHaveLength(0);
    expect(s.budget.activeElapsedMs).toBe(0);
    now += 1001;
    expect(s.budget.exceeded()).toContain("active-time timeout");
  });

  it("still stops the agent when active work exceeds its limit", async () => {
    const root = tempProject({ "a.txt": "hello" });
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const mock = new MockProvider({
      handler: () => {
        now += 2000;
        return { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] };
      },
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      sessionsDir: join(root, ".sessions"),
      configOverrides: { ...MOCK_MODELS, limits: { timeoutMs: 1000 } },
    });
    const s = h.createSession({ projectPath: root });
    expect((await s.chat("read")).status).toBe("budget");
    expect(mock.calls).toHaveLength(1);
    expect(s.events.some((e) => e.type === "error" && e.message.includes("active-time timeout"))).toBe(true);
  });
});
