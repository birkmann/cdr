import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@harness/client";
import { deleteAllChats, deleteAllNote, deleteAllPrompt, planDeleteAll } from "@web/delete-chats";

const s = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  projectPath: "/p",
  workflow: "default",
  status: "idle",
  createdAt: "2026-11-06T10:00:00.000Z",
  lastSeq: 1,
  ...o,
});

describe("delete all chats", () => {
  it("offers top-level chats only and leaves running trees alone", () => {
    const plan = planDeleteAll([
      s("idle"),
      s("idle-child", { parentSessionId: "idle" }),
      s("missing-folder", { projectMissing: true }),
      s("running", { status: "running" }),
      s("waiting", { status: "waiting" }),
      s("elsewhere", { externalRun: true }),
      s("parent-of-busy"),
      s("busy-child", { parentSessionId: "parent-of-busy", status: "running" }),
    ]);
    expect(plan.chats.map((c) => c.id)).toEqual(["idle", "missing-folder"]);
    expect(plan.running).toBe(4);
  });

  it("treats a subagent whose parent is gone as a chat of its own", () => {
    expect(planDeleteAll([s("stray", { parentSessionId: "gone" })]).chats.map((c) => c.id)).toEqual([
      "stray",
    ]);
  });

  it("says how many chats go, and mentions automated and running ones", () => {
    const { title, message } = deleteAllPrompt({
      chats: [s("a"), s("b", { goalId: "g" })],
      running: 1,
    });
    expect(title).toBe("Delete 2 chats?");
    expect(message).toContain("1 automated run.");
    expect(message).toContain("1 running chat will be kept.");
    expect(deleteAllPrompt({ chats: [s("a")], running: 0 }).message).not.toMatch(/automated|running/);
  });

  it("keeps going after a failure and reports it", async () => {
    const deleteSession = vi.fn(async (id: string) => {
      if (id === "b") throw new Error("Session is running; cancel it first");
      return {
        ok: true as const,
        sessions: [id, `${id}-child`],
        worktrees: [],
        branches: [],
        kept: ["branch x (not merged)"],
      };
    });
    const r = await deleteAllChats({ deleteSession }, [s("a"), s("b", { title: "Busy" }), s("c")]);
    expect(r.deleted).toEqual(["a", "a-child", "c", "c-child"]);
    expect(r.failed).toEqual(["Busy: Session is running; cancel it first"]);
    expect(deleteAllNote(r)).toContain("Could not delete 1 chat: Busy");
    expect(deleteAllNote(r)).toContain("Kept: branch x (not merged)");
    expect(deleteAllNote({ deleted: ["a"], kept: [], failed: [] })).toBeUndefined();
  });
});
