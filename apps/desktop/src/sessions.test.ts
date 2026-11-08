import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@harness/client";
import {
  SANDBOX_PROJECT,
  attentionByConversation,
  conversationOutput,
  conversationSections,
  focusProject,
  isDefaultBranch,
  orphanConversations,
  projectAgents,
  projectBadge,
  projectChoices,
  projectKey,
  projectRoot,
  rootConversation,
  switcherSections,
} from "./sessions";

// Midday, so "a few minutes ago" is always today.
const now = new Date(2026, 10, 6, 12, 0).getTime();
beforeAll(() => vi.useFakeTimers({ now, toFake: ["Date"] }));
afterAll(() => vi.useRealTimers());
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

function session(
  id: string,
  projectPath: string,
  hours: number,
  extra: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    id,
    projectPath,
    title: id,
    status: "idle",
    createdAt: ago(hours),
    updatedAt: ago(hours),
    ...extra,
  } as SessionInfo;
}

const snake = session("snake", "/home/u/.harness/sandboxes/snake-2f7a3b", 0.1, { sandbox: true });
const ibm = session("ibm.com", "/home/u/.harness/sandboxes/ibm-com-fb0b79", 0, { sandbox: true });
const old = session("pomodoro", "/home/u/.harness/sandboxes/pomodoro-58807a", 24 * 10, { sandbox: true });
const repo = session("fix tests", "/home/u/code/app", 0.5);
const worktree = session("helper", "/home/u/code/app/.harness/worktrees/x", 0.2);
const child = session("subagent", "/home/u/code/app", 0, { parentSessionId: "fix tests" });

const ids = (s: ReturnType<typeof switcherSections>) => s.map((x) => [x.label, x.items.map((i) => i.id)]);

describe("conversation switcher", () => {
  it("lists every conversation newest first when no folder is open, sandboxes and projects alike", () => {
    const s = switcherSections([old, snake, repo, ibm, child], undefined, "");
    expect(s[0].label).toBe("Today");
    expect(s[0].items.map((i) => i.id)).toEqual(["ibm.com", "snake", "fix tests"]);
    expect(s.at(-1)).toEqual({ label: "Older", items: [old] });
  });

  it("puts the open folder's conversations (with its worktrees) first and keeps the rest", () => {
    const s = switcherSections([snake, ibm, repo, worktree], "/home/u/code/app", "");
    expect(ids(s)).toEqual([
      ["In app", ["helper", "fix tests"]],
      ["Today", ["ibm.com", "snake"]],
    ]);
  });

  it("keeps other sandboxes reachable after opening one sandbox as the folder", () => {
    const s = switcherSections([snake, ibm], snake.projectPath, "");
    expect(ids(s)).toEqual([
      ["In snake-2f7a3b", ["snake"]],
      ["Today", ["ibm.com"]],
    ]);
  });

  it("searches titles and folder names", () => {
    expect(ids(switcherSections([snake, ibm, repo], undefined, "SNAKE"))).toEqual([["Today", ["snake"]]]);
    expect(ids(switcherSections([snake, ibm, repo], undefined, "ibm-com"))).toEqual([["Today", ["ibm.com"]]]);
    expect(switcherSections([snake], undefined, "nothing")).toEqual([]);
  });

  it("leaves out subagents and conversations whose folder is gone", () => {
    const gone = session("gone", "/tmp/deleted", 0, { projectMissing: true });
    expect(ids(switcherSections([child, gone, repo], undefined, ""))).toEqual([["Today", ["fix tests"]]]);
  });
});

describe("a conversation's output folder", () => {
  const s = { projectPath: "/repos/cdr-02" };
  it("is the folder of its published preview, relative to the project", () => {
    expect(conversationOutput(s, ".harness/chess-game/index.html")).toBe(".harness/chess-game");
    expect(conversationOutput(s, "/repos/cdr-02/games/snake/index.html")).toBe("games/snake");
    expect(conversationOutput(s, "./index.html")).toBe("");
  });
  it("ignores pages outside the project", () => {
    expect(conversationOutput(s, "/elsewhere/index.html")).toBeUndefined();
    expect(conversationOutput(s, "../other/index.html")).toBeUndefined();
  });
});

describe("the conversation list", () => {
  const app = "/home/u/repos/app";
  const idle = session("idle", app, 1);
  const older = session("older", "/home/u/repos/site", 24 * 10);
  const box = session("box", "/home/u/.harness/sandboxes/box-1", 2, { sandbox: true });
  const running = session("running", app, 0, { status: "running", runStartedAt: ago(1) });
  const later = session("later", app, 0, { status: "running", runStartedAt: ago(0.5) });
  const asking = session("asking", app, 3, { status: "waiting", runStartedAt: ago(3) });
  const labels = (list: SessionInfo[], filter = {}) =>
    conversationSections(list, filter).map((s) => [s.label, s.attention, s.items.map((i) => i.id)]);

  it("orders by attention, then by date", () => {
    expect(labels([idle, older, box, running, asking, later])).toEqual([
      ["Working", "working", ["running", "later"]],
      ["Waiting", "waiting", ["asking"]],
      ["Today", "settled", ["idle", "box"]],
      ["Older", "settled", ["older"]],
    ]);
  });

  it("keeps running rows in place while their events arrive", () => {
    const busy = { ...running, updatedAt: ago(0) };
    const quiet = { ...later, updatedAt: ago(0.4) };
    expect(labels([quiet, busy])[0]![2]).toEqual(["running", "later"]);
  });

  it("makes a parent wait when its subagent waits", () => {
    const parent = session("parent", app, 1, { status: "running" });
    const sub = session("sub", `${app}/.harness/worktrees/x`, 0, {
      status: "waiting",
      parentSessionId: "parent",
    });
    expect(attentionByConversation([parent, sub]).get("parent")).toBe("waiting");
    expect(labels([parent, sub])).toEqual([["Waiting", "waiting", ["parent"]]]);
  });

  it("marks a finished parent of a running subagent as working", () => {
    const parent = session("parent", app, 1);
    const sub = session("sub", app, 0, { status: "running", parentSessionId: "parent" });
    expect(labels([parent, sub])).toEqual([["Working", "working", ["parent"]]]);
  });

  it("filters by project, sandboxes and text", () => {
    const all = [idle, older, box];
    expect(labels(all, { project: app }).flatMap((s) => s[2])).toEqual(["idle"]);
    expect(labels(all, { project: SANDBOX_PROJECT }).flatMap((s) => s[2])).toEqual(["box"]);
    expect(labels(all, { query: "SITE" }).flatMap((s) => s[2])).toEqual(["older"]);
  });

  it("counts a worktree as the project it was made from", () => {
    const goal = session("goal", `${app}/.harness/worktrees/goal-1`, 1, { goalId: "g" });
    expect(projectRoot(goal.projectPath)).toBe(app);
    expect(projectKey(goal)).toBe(app);
    expect(labels([goal], { project: app }).flatMap((s) => s[2])).toEqual(["goal"]);
  });

  it("lists deleted folders separately", () => {
    const gone = session("gone", "/gone", 1, { projectMissing: true });
    expect(labels([gone])).toEqual([]);
    expect(orphanConversations([gone, idle]).map((s) => s.id)).toEqual(["gone"]);
  });

  it("offers each project once, most recent first, without sandboxes", () => {
    const again = session("again", app, 5);
    expect(projectChoices([older, again, idle, box])).toEqual([
      { path: app, name: "app" },
      { path: "/home/u/repos/site", name: "site" },
    ]);
  });
});

describe("the project in focus", () => {
  const app = "/home/u/repos/app";
  const conv = session("conv", app, 1);
  const sub = session("sub", `${app}/.harness/worktrees/x`, 0, { parentSessionId: "conv" });

  it("follows the conversation shown, and a subagent's parent", () => {
    expect(focusProject([conv], "conv", undefined, "/other").path).toBe(app);
    const f = focusProject([conv, sub], "sub", undefined, "/other");
    expect(f.path).toBe(app);
    expect(f.conversation?.id).toBe("conv");
    expect(rootConversation(sub, [conv, sub]).id).toBe("conv");
  });

  it("uses the new conversation's folder, then the open workspace", () => {
    expect(focusProject([], null, "/picked", "/open").path).toBe("/picked");
    expect(focusProject([], null, undefined, "/open").path).toBe("/open");
    expect(focusProject([], null, null, "/open").path).toBeNull();
  });

  it("has no project for a deleted folder", () => {
    const gone = session("gone", "/gone", 1, { projectMissing: true });
    expect(focusProject([gone], "gone", undefined, "/open").path).toBeNull();
  });

  it("survives a cycle of parents", () => {
    const a = session("a", app, 1, { parentSessionId: "b" });
    const b = session("b", app, 1, { parentSessionId: "a" });
    expect(["a", "b"]).toContain(rootConversation(a, [a, b]).id);
  });
});

describe("the project rail's agents", () => {
  const app = "/home/u/repos/app";
  const shape = (rows: ReturnType<typeof projectAgents>) => rows.map((r) => [r.session.id, r.depth]);
  const parent = session("parent", app, 1, { status: "running" });
  const sub = session("sub", `${app}/.harness/worktrees/x`, 0, {
    status: "running",
    parentSessionId: "parent",
  });
  const elsewhere = session("elsewhere", "/home/u/repos/site", 0, { status: "running" });

  it("shows what runs in this project, with subagents under their parent", () => {
    expect(shape(projectAgents([parent, sub, elsewhere], app))).toEqual([
      ["parent", 0],
      ["sub", 1],
    ]);
  });

  it("keeps the helpers of the selected conversation after they finish", () => {
    const done = { ...parent, status: "done" as const };
    const doneSub = { ...sub, status: "done" as const };
    expect(shape(projectAgents([done, doneSub], app))).toEqual([]);
    expect(shape(projectAgents([done, doneSub], app, done))).toEqual([
      ["parent", 0],
      ["sub", 1],
    ]);
  });

  it("does not list a selected conversation that has no helpers", () => {
    const alone = session("alone", app, 1);
    expect(projectAgents([alone], app, alone)).toEqual([]);
  });

  it("does not repeat a selected conversation that is running", () => {
    expect(shape(projectAgents([parent, sub], app, parent))).toEqual([
      ["parent", 0],
      ["sub", 1],
    ]);
  });
});

describe("project chips and branches", () => {
  it("uses two initials and a stable colour", () => {
    expect(projectBadge("post-plan").initials).toBe("PP");
    expect(projectBadge("postplan").initials).toBe("PO");
    expect(projectBadge("a").initials).toBe("A");
    expect(projectBadge("postplan").hue).toBe(projectBadge("postplan").hue);
    expect(projectBadge("postplan").hue).toBeGreaterThanOrEqual(0);
    expect(projectBadge("postplan").hue).toBeLessThan(360);
  });

  it("recognises default branches", () => {
    expect(isDefaultBranch("main")).toBe(true);
    expect(isDefaultBranch("master")).toBe(true);
    expect(isDefaultBranch("feature/main")).toBe(false);
  });
});
