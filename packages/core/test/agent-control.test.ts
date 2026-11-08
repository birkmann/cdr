import { describe, expect, it } from "vitest";
import { appendFileSync, existsSync } from "node:fs";
import type { HarnessEvent } from "@harness/protocol";
import {
  Harness,
  MockProvider,
  activeRunCount,
  branchExists,
  git,
  summarize,
  type MockHandler,
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

const isChild = (req: Parameters<MockHandler>[0]) => req.messages[0].content.includes("You are a subagent");
const ofType = <T extends HarnessEvent["type"]>(events: HarnessEvent[], type: T) =>
  events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);

/** A parent that spawns one worktree child writing `file`, then finishes. */
function worktreeSpawner(file: string) {
  return new MockProvider({
    handler: (req) => {
      const last = req.messages.at(-1)!;
      if (isChild(req)) {
        if (last.role === "user")
          return { toolCalls: [{ name: "write_file", args: { path: file, content: "child\n" } }] };
        return { text: "wrote it" };
      }
      if (last.role === "user")
        return {
          toolCalls: [{ name: "spawn_agent", args: { task: `Create ${file}`, isolation: "worktree" } }],
        };
      return { text: "ok" };
    },
  });
}

describe("session info for agent control", () => {
  it("sums usage, records the origin and the run start, and marks interrupted runs", async () => {
    const root = tempProject({ "a.txt": "x\n" });
    const h = harnessWith(new MockProvider({ handler: () => ({ text: "hi" }) }));
    const s = h.createSession({ projectPath: root, origin: "desktop" });
    let during: ReturnType<typeof s.info> | undefined;
    s.subscribe((e) => {
      if (e.type === "message.delta" && !during) during = s.info();
    });
    await s.chat("one");
    await s.chat("two");
    const info = s.info();
    expect(info.origin).toBe("desktop");
    const calls = ofType(s.events, "usage");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(info.usage?.outputTokens).toBe(calls.reduce((n, e) => n + e.outputTokens, 0));
    expect(info.runStartedAt).toBeUndefined();
    expect(info.interrupted).toBeUndefined();
    if (during) {
      expect(during.status).toBe("running");
      expect(during.runStartedAt).toBeTruthy();
      expect(during.interrupted).toBeUndefined();
    }

    // A log that ends mid-run with no live owner was interrupted.
    const last = s.events[s.events.length - 1];
    appendFileSync(
      h.store.path(s.id),
      JSON.stringify({ ...last, seq: last.seq + 1, type: "status", status: "running" }) + "\n",
    );
    const stored = h.store.info(s.id);
    expect(stored.status).toBe("idle");
    expect(stored.interrupted).toBe(true);
    expect(stored.externalRun).toBe(false);
    expect(summarize(s.id, h.store.read(s.id)).interrupted).toBe(true);

    // A fresh harness loads it as interrupted and lets the job be continued.
    const h2 = harnessWith(new MockProvider({ handler: () => ({ text: "continued" }) }));
    const reloaded = h2.getSession(s.id);
    expect(reloaded.wasInterrupted).toBe(true);
    expect(reloaded.info().interrupted).toBe(true);
    await reloaded.continueJob();
    expect(reloaded.wasInterrupted).toBe(false);
    expect(reloaded.info().interrupted).toBeUndefined();
  });

  it("does not record an origin for subagents", async () => {
    const root = tempProject({ "a.txt": "x\n" });
    const h = harnessWith(
      new MockProvider({
        handler: (req) => {
          if (isChild(req)) return { text: "child" };
          if (req.messages.at(-1)!.role === "user")
            return { toolCalls: [{ name: "spawn_agent", args: { task: "look" } }] };
          return { text: "done" };
        },
      }),
    );
    const s = h.createSession({ projectPath: root, origin: "cli" });
    await s.chat("go");
    const child = ofType(s.events, "agent.spawned")[0];
    expect(h.store.info(child.sessionId).origin).toBeUndefined();
    expect(h.store.info(child.sessionId).parentSessionId).toBe(s.id);
  });
});

describe("deleting a conversation", () => {
  it("removes its subagents, their worktrees and merged branches, and keeps unmerged branches", async () => {
    const root = tempProject({ "a.txt": "one\n" }, { git: true });
    const h = harnessWith(worktreeSpawner("b.txt"));
    const merged = h.createSession({ projectPath: root, permissionMode: "auto" });
    await merged.chat("delegate");
    const a = ofType(merged.events, "agent.spawned")[0];
    expect(existsSync(a.worktree!)).toBe(true);
    expect(git(root, ["merge", "-q", a.branch!]).ok).toBe(true);

    const r = h.deleteSession(merged.id);
    expect(r.sessions.sort()).toEqual([merged.id, a.sessionId].sort());
    expect(r.worktrees).toEqual([a.worktree]);
    expect(r.branches).toEqual([a.branch]);
    expect(r.kept).toEqual([]);
    expect(h.store.exists(a.sessionId)).toBe(false);
    expect(existsSync(a.worktree!)).toBe(false);
    expect(branchExists(root, a.branch!)).toBe(false);

    const h2 = harnessWith(worktreeSpawner("c.txt"));
    const unmerged = h2.createSession({ projectPath: root, permissionMode: "auto" });
    await unmerged.chat("delegate");
    const b = ofType(unmerged.events, "agent.spawned")[0];
    const r2 = h2.deleteSession(unmerged.id);
    expect(r2.worktrees).toEqual([b.worktree]);
    expect(r2.branches).toEqual([]);
    expect(r2.kept).toEqual([`branch ${b.branch} (not merged)`]);
    expect(branchExists(root, b.branch!)).toBe(true);
  });

  it("refuses while the conversation runs", async () => {
    const root = tempProject({ "a.txt": "x\n" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harnessWith(
      new MockProvider({
        handler: async () => {
          await gate;
          return { text: "done" };
        },
      }),
    );
    const s = h.createSession({ projectPath: root });
    const run = s.chat("wait");
    await new Promise((r) => setTimeout(r, 20));
    expect(() => h.deleteSession(s.id)).toThrow(/running/);
    release();
    await run;
    expect(h.deleteSession(s.id).sessions).toEqual([s.id]);
  });

  it("removes a sandbox folder only when asked and no other conversation uses it", async () => {
    const h = harnessWith(new MockProvider({ handler: () => ({ text: "hi" }) }));
    const a = h.createSession({ sandbox: true, title: "one" });
    const b = h.createSession({ sandbox: true, title: "two" });
    // A second conversation opened on the first sandbox folder.
    const c = h.createSession({ projectPath: a.projectRoot });
    expect(h.deleteSession(b.id).folder).toBeUndefined();
    expect(existsSync(b.projectRoot)).toBe(true);

    const d = h.createSession({ sandbox: true, title: "three" });
    const r = h.deleteSession(d.id, { folder: true });
    expect(r.folder).toBe(d.projectRoot);
    expect(existsSync(d.projectRoot)).toBe(false);

    const kept = h.deleteSession(a.id, { folder: true });
    expect(kept.folder).toBeUndefined();
    expect(kept.kept[0]).toContain("another conversation uses it");
    expect(existsSync(a.projectRoot)).toBe(true);

    // Never removes a folder that is not a sandbox.
    const project = tempProject({ "keep.txt": "x\n" });
    const e = h.createSession({ projectPath: project });
    expect(h.deleteSession(e.id, { folder: true }).folder).toBeUndefined();
    expect(existsSync(project)).toBe(true);
    void c;
  });
});

describe("stopping and unloading", () => {
  it("cancelAll stops every run of this process", async () => {
    const root1 = tempProject({ "a.txt": "x\n" });
    const root2 = tempProject({ "a.txt": "x\n" });
    const h = harnessWith(
      new MockProvider({
        handler: () => ({ toolCalls: [{ name: "bash", args: { command: "sleep 5" } }] }),
      }),
    );
    const a = h.createSession({ projectPath: root1, permissionMode: "yolo" });
    const b = h.createSession({ projectPath: root2, permissionMode: "yolo" });
    const runs = [a.chat("one"), b.chat("two")];
    await new Promise((r) => setTimeout(r, 100));
    expect(activeRunCount()).toBeGreaterThanOrEqual(2);
    const r = h.cancelAll();
    expect(r.cancelled.sort()).toEqual([a.id, b.id].sort());
    await Promise.all(runs);
    expect(a.status).toBe("cancelled");
    expect(b.status).toBe("cancelled");
    expect(activeRunCount()).toBe(0);
  });

  it("cancels a run whose provider call has not answered yet", async () => {
    const root = tempProject({ "a.txt": "x\n" });
    let release!: () => void;
    const stalled = new Promise<void>((r) => (release = r));
    const mock = new MockProvider({
      // A provider that ignores the abort signal and never answers until we let it.
      handler: async () => {
        await stalled;
        return { text: "too late" };
      },
    });
    const h = harnessWith(mock);
    const s = h.createSession({ projectPath: root, permissionMode: "yolo" });
    const run = s.chat("hold");
    // Wait until the model call is in flight, so the run is stuck inside the provider, not earlier.
    while (!mock.calls.length) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.status).toBe("running");
    const started = Date.now();
    s.cancel();
    const r = await run;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.status).toBe("cancelled");
    expect(s.status).toBe("cancelled");
    release();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("unloads idle conversations without listeners and reloads them on demand", async () => {
    const root = tempProject({ "a.txt": "x\n" });
    const h = harnessWith(new MockProvider({ handler: () => ({ text: "hi" }) }));
    const idle = h.createSession({ projectPath: root });
    await idle.chat("hello");
    const watched = h.createSession({ projectPath: root });
    const off = watched.subscribe(() => {});
    const kept = h.createSession({ projectPath: root, title: "kept" });
    idle.lastUsedAt = watched.lastUsedAt = kept.lastUsedAt = Date.now() - 60_000;

    const unloaded = h.unloadIdle(30_000, (s) => s.id === kept.id);
    expect(unloaded).toEqual([idle.id]);
    expect(h.liveSessions().map((s) => s.id)).not.toContain(idle.id);
    const again = h.getSession(idle.id);
    expect(again).not.toBe(idle);
    expect(again.info().title).toBe("hello");
    off();
  });
});

describe("subagent budgets and the machine-wide cap", () => {
  it("reserves budgets of running children so they cannot overspend the parent together", async () => {
    const root = tempProject({ "a.txt": "x\n" });
    const limits: number[] = [];
    let h!: Harness;
    h = harnessWith(
      new MockProvider({
        handler: async (req) => {
          const last = req.messages.at(-1)!;
          if (isChild(req)) {
            await new Promise((r) => setTimeout(r, 30));
            return { text: "child" };
          }
          if (last.role === "user")
            return {
              toolCalls: [
                { name: "spawn_agent", args: { task: "a", wait: false } },
                { name: "spawn_agent", args: { task: "b", wait: false } },
                { name: "spawn_agent", args: { task: "c", wait: false, budget: { maxCost: 100 } } },
                { name: "wait_agents", args: {} },
              ],
            };
          return { text: "done" };
        },
      }),
      { limits: { maxCost: 3 }, agents: { maxConcurrent: 3 } },
    );
    const s = h.createSession({ projectPath: root, permissionMode: "auto" });
    s.subscribe((e) => {
      if (e.type === "agent.spawned") limits.push(h.getSession(e.sessionId).config.limits?.maxCost ?? 0);
    });
    await s.chat("go");
    expect(limits).toHaveLength(3);
    // Equal shares for children without a budget; the third gets what is left, not its 100.
    expect(limits[0]).toBeCloseTo(1, 5);
    expect(limits[1]).toBeCloseTo(1, 5);
    expect(limits[0] + limits[1] + limits[2]).toBeLessThanOrEqual(3 + 1e-9);
  });

  it("refuses to spawn above agents.maxActive", async () => {
    const root = tempProject({ "a.txt": "x\n" });
    const h = harnessWith(
      new MockProvider({
        handler: (req) => {
          if (isChild(req)) return { text: "child" };
          if (req.messages.at(-1)!.role === "user")
            return { toolCalls: [{ name: "spawn_agent", args: { task: "look" } }] };
          return { text: "done" };
        },
      }),
      { agents: { maxActive: 1 } },
    );
    const s = h.createSession({ projectPath: root });
    await s.chat("go");
    const result = ofType(s.events, "tool.result").find((e) => e.name === "spawn_agent")!;
    expect(result.ok).toBe(false);
    expect(result.output).toContain("already running on this machine (limit 1)");
  });
});
