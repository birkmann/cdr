import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@harness/client";
import {
  buildTree,
  descendants,
  elapsed,
  formatUsage,
  originLabel,
  sandboxFolderRemovable,
  splitActive,
} from "./agents";

const s = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  projectPath: "/p",
  workflow: "default",
  status: "idle",
  createdAt: "2026-11-06T10:00:00.000Z",
  lastSeq: 1,
  ...o,
});

describe("agents view helpers", () => {
  it("lists every active agent regardless of folder, with finished helpers of an active parent", () => {
    const list = [
      s("a", { status: "running", projectPath: "/elsewhere", runStartedAt: "2026-11-06T10:05:00.000Z" }),
      s("a1", { parentSessionId: "a", status: "done" }),
      s("a2", { parentSessionId: "a", status: "running" }),
      s("b", { status: "waiting", sandbox: true, runStartedAt: "2026-11-06T10:01:00.000Z" }),
      s("c", { status: "idle" }),
      s("c1", { parentSessionId: "c", status: "done" }),
    ];
    const { active, rest } = splitActive(list);
    expect(active.map((x) => x.id).sort()).toEqual(["a", "a1", "a2", "b"]);
    expect(rest.map((x) => x.id)).toEqual(["c", "c1"]);
    const tree = buildTree(active);
    expect(tree.roots.map((x) => x.id)).toEqual(["b", "a"]);
    expect(tree.children.get("a")?.map((x) => x.id)).toEqual(["a1", "a2"]);
  });

  it("labels where a conversation came from", () => {
    expect(originLabel(s("x", { parentSessionId: "p" }))).toBe("subagent");
    expect(originLabel(s("x", { goalId: "g" }))).toBe("goal");
    expect(originLabel(s("x", { forkedFrom: { sessionId: "p", seq: 3, messageId: "m" } }))).toBe("branch");
    expect(originLabel(s("x", { forkedFrom: { sessionId: "p", seq: 3 } }))).toBe("copy");
    expect(originLabel(s("x", { origin: "cli" }))).toBe("terminal");
    expect(originLabel(s("x", { origin: "desktop" }))).toBe("app");
    expect(originLabel(s("x"))).toBeUndefined();
  });

  it("formats usage and elapsed time", () => {
    expect(formatUsage(undefined)).toBe("");
    expect(formatUsage({ inputTokens: 900, outputTokens: 50 })).toBe("950 tok");
    expect(formatUsage({ inputTokens: 12_000, outputTokens: 345, cost: 0.0421 })).toBe("12.3k tok · $0.04");
    expect(formatUsage({ inputTokens: 2_500_000, outputTokens: 0, cost: 0.004 })).toBe("2.5M tok · $0.004");
    const t0 = Date.parse("2026-11-06T10:00:00.000Z");
    expect(elapsed("2026-11-06T10:00:00.000Z", t0 + 45_000)).toBe("45s");
    expect(elapsed("2026-11-06T10:00:00.000Z", t0 + 192_000)).toBe("3m 12s");
    expect(elapsed("2026-11-06T10:00:00.000Z", t0 + 3_840_000)).toBe("1h 04m");
  });

  it("offers to remove a sandbox folder only when no other conversation uses it", () => {
    const list = [
      s("a", { sandbox: true, projectPath: "/sb/a" }),
      s("a1", { parentSessionId: "a", projectPath: "/sb/a" }),
      s("b", { sandbox: true, projectPath: "/sb/b" }),
      s("b2", { projectPath: "/sb/b" }),
      s("c", { projectPath: "/project" }),
    ];
    expect(descendants("a", list)).toEqual(["a", "a1"]);
    expect(sandboxFolderRemovable(list[0], list)).toBe(true);
    expect(sandboxFolderRemovable(list[2], list)).toBe(false);
    expect(sandboxFolderRemovable(list[4], list)).toBe(false);
  });
});
