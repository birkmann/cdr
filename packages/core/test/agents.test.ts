import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent } from "@harness/protocol";
import { Harness, MockProvider, git, sessionHasProjectLock, type MockHandler } from "@harness/core";
import { MOCK_MODELS, tempProject } from "./helpers.js";

function harnessWith(mock: MockProvider, extra: object = {}) {
  return new Harness({
    providers: { mock },
    skipGlobalConfig: true,
    loadEnv: false,
    configOverrides: { ...MOCK_MODELS, ...extra },
  });
}

const isChild = (req: Parameters<MockHandler>[0]) => req.messages[0].content.includes("You are a subagent");
const ofType = <T extends HarnessEvent["type"]>(events: HarnessEvent[], type: T) =>
  events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);

describe("spawn_agent", () => {
  it("runs a shared read-only child without the project lock and returns its final text", async () => {
    const root = tempProject({ "a.txt": "the number is 42\n" });
    let childTools: string[] = [];
    let parentId = "";
    let lockHeldByParent = false;
    const mock = new MockProvider({
      handler: (req) => {
        const last = req.messages.at(-1)!;
        if (isChild(req)) {
          childTools = (req.tools ?? []).map((t) => t.name);
          lockHeldByParent = sessionHasProjectLock(root, parentId);
          if (last.role === "user") return { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] };
          return { text: "The answer is 42." };
        }
        if (last.role === "user")
          return {
            toolCalls: [
              { name: "spawn_agent", args: { task: "Find the number in a.txt", isolation: "shared" } },
            ],
          };
        return { text: "Parent done." };
      },
    });
    const h = harnessWith(mock);
    const s = h.createSession({ projectPath: root, permissionMode: "ask" });
    parentId = s.id;
    const r = await s.chat("delegate research");
    expect(r.status).toBe("completed");
    // read-only tool set, no spawning, no writes
    expect(childTools).toContain("read_file");
    expect(childTools).toContain("grep");
    expect(childTools).not.toContain("write_file");
    expect(childTools).not.toContain("patch_file");
    expect(childTools).not.toContain("spawn_agent");
    // the parent still holds the lock while the child runs (the child never took it)
    expect(lockHeldByParent).toBe(true);

    const result = ofType(s.events, "tool.result").find((e) => e.name === "spawn_agent")!;
    expect(result.ok).toBe(true);
    expect(result.output).toContain("The answer is 42.");
    // no permission prompt for spawning in ask mode
    expect(ofType(s.events, "permission.request")).toHaveLength(0);

    const spawned = ofType(s.events, "agent.spawned");
    expect(spawned).toHaveLength(1);
    const call = ofType(s.events, "tool.call").find((e) => e.name === "spawn_agent")!;
    expect(spawned[0]).toMatchObject({ isolation: "shared", role: "executor", parentToolCallId: call.id });
    expect(ofType(s.events, "agent.status").length).toBeGreaterThan(0);
    expect(ofType(s.events, "agent.finished")[0]).toMatchObject({
      agentId: spawned[0].agentId,
      status: "success",
      summary: "The answer is 42.",
    });

    const child = h.getSession(spawned[0].sessionId);
    expect(child.info().parentSessionId).toBe(s.id);
    expect(child.events.some((e) => e.type === "done" && e.status === "success")).toBe(true);
    expect(h.listSessions({ parent: s.id }).map((x) => x.id)).toEqual([child.id]);
    const tree = h.sessionTree(s.id);
    expect(tree.session.id).toBe(s.id);
    expect(tree.children.map((c) => c.session.id)).toEqual([child.id]);
  });

  it("runs a worktree child on its own branch; edits land in the worktree", async () => {
    const root = tempProject({ "a.txt": "one\n" }, { git: true });
    let childRoot = "";
    const mock = new MockProvider({
      handler: (req) => {
        const last = req.messages.at(-1)!;
        if (isChild(req)) {
          childRoot = /Working directory: (.*)/.exec(req.messages[0].content)?.[1] ?? "";
          if (last.role === "user")
            return { toolCalls: [{ name: "write_file", args: { path: "b.txt", content: "from child\n" } }] };
          return { text: "Wrote b.txt" };
        }
        if (last.role === "user")
          return {
            toolCalls: [{ name: "spawn_agent", args: { task: "Create b.txt", isolation: "worktree" } }],
          };
        return { text: "ok" };
      },
    });
    const h = harnessWith(mock);
    const s = h.createSession({ projectPath: root, permissionMode: "auto" });
    await s.chat("delegate a write");
    const spawned = ofType(s.events, "agent.spawned")[0];
    expect(spawned.isolation).toBe("worktree");
    expect(spawned.branch).toMatch(/^cdr\/[a-z0-9]+\/create-b-txt$/);
    expect(spawned.worktree).toContain(join(".harness", "worktrees"));
    expect(existsSync(join(spawned.worktree!, "b.txt"))).toBe(true);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    if (childRoot) expect(childRoot).toContain(".harness");
    // committed on the child's branch
    expect(git(root, ["show", `${spawned.branch}:b.txt`]).out).toBe("from child\n");
    const finished = ofType(s.events, "agent.finished")[0];
    expect(finished.status).toBe("success");
    expect(finished.diffStat).toContain("b.txt");
    const result = ofType(s.events, "tool.result").find((e) => e.name === "spawn_agent")!;
    expect(result.output).toContain(`Branch: ${spawned.branch}`);
    expect(result.output).toContain("Wrote b.txt");
    // the main checkout stays clean apart from the excluded .harness/
    expect(git(root, ["status", "--porcelain"]).out.trim()).toBe("");
    expect(h.getSession(spawned.sessionId).projectRoot).toBe(spawned.worktree);
  });

  it("enforces depth and concurrency limits", async () => {
    // maxDepth 1: the parent can spawn, the child cannot.
    const root = tempProject({ "a.txt": "x\n" });
    let childTools: string[] = [];
    const mock = new MockProvider({
      handler: async (req) => {
        const last = req.messages.at(-1)!;
        if (isChild(req)) {
          childTools = (req.tools ?? []).map((t) => t.name);
          await new Promise((r) => setTimeout(r, 30));
          return { text: "child done" };
        }
        if (last.role === "user")
          return {
            toolCalls: [
              { name: "spawn_agent", args: { task: "first", wait: false } },
              { name: "spawn_agent", args: { task: "second", wait: false } },
              { name: "wait_agents", args: {} },
            ],
          };
        return { text: "parent done" };
      },
    });
    const h = harnessWith(mock, { agents: { maxConcurrent: 1, maxDepth: 1 } });
    const s = h.createSession({ projectPath: root, permissionMode: "auto" });
    await s.chat("go");
    const results = ofType(s.events, "tool.result");
    const spawns = results.filter((e) => e.name === "spawn_agent");
    expect(spawns[0].ok).toBe(true);
    expect(spawns[1].ok).toBe(false);
    expect(spawns[1].output).toContain("at most 1 subagents");
    const waited = results.find((e) => e.name === "wait_agents")!;
    expect(waited.ok).toBe(true);
    expect(waited.output).toContain("child done");
    expect(childTools).not.toContain("spawn_agent");
    expect(childTools).not.toContain("wait_agents");

    // maxDepth 0: no spawn tool at all
    const mock2 = new MockProvider({
      handler: (req) => {
        expect((req.tools ?? []).map((t) => t.name)).not.toContain("spawn_agent");
        return { text: "no agents" };
      },
    });
    const s2 = harnessWith(mock2, { agents: { maxDepth: 0 } }).createSession({ projectPath: root });
    await s2.chat("hi");
  });

  it("cancelling the parent cancels its children", async () => {
    const root = tempProject({ "a.txt": "x\n" });
    let n = 0;
    const mock = new MockProvider({
      handler: async (req) => {
        const last = req.messages.at(-1)!;
        if (isChild(req)) {
          await new Promise((r) => setTimeout(r, 20));
          return { toolCalls: [{ name: "read_file", args: { path: "a.txt", offset: ++n } }] };
        }
        if (last.role === "user")
          return { toolCalls: [{ name: "spawn_agent", args: { task: "loop forever" } }] };
        return { text: "parent done" };
      },
    });
    const h = harnessWith(mock);
    const s = h.createSession({ projectPath: root, permissionMode: "auto" });
    s.subscribe((e) => {
      if (e.type === "agent.spawned") setTimeout(() => s.cancel(), 100);
    });
    const r = await s.chat("go");
    expect(r.status).toBe("cancelled");
    const finished = ofType(s.events, "agent.finished")[0];
    expect(finished.status).toBe("cancelled");
    const child = h.getSession(ofType(s.events, "agent.spawned")[0].sessionId);
    expect(child.status).toBe("cancelled");
    expect(child.isRunning).toBe(false);
  });

  it("caps child budgets by the parent's remaining budget", async () => {
    const root = tempProject({ "a.txt": "x\n" });
    let childLimits: unknown;
    const h = harnessWith(
      new MockProvider({
        handler: (req) => {
          const last = req.messages.at(-1)!;
          if (isChild(req)) return { text: "child" };
          if (last.role === "user")
            return {
              toolCalls: [{ name: "spawn_agent", args: { task: "t", budget: { maxTokens: 10_000_000 } } }],
            };
          return { text: "done" };
        },
      }),
      { limits: { maxTokens: 50_000 } },
    );
    const s = h.createSession({ projectPath: root, permissionMode: "auto" });
    s.subscribe((e) => {
      if (e.type === "agent.spawned") childLimits = h.getSession(e.sessionId).config.limits;
    });
    await s.chat("go");
    expect((childLimits as { maxTokens: number }).maxTokens).toBeLessThan(50_000);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("x\n");
  });
});
