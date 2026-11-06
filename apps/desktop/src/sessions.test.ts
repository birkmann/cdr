import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@harness/client";
import { switcherSections } from "./sessions";

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
