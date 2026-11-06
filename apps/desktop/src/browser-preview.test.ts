import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@harness/client";
import { isHtmlPath, previewTarget } from "./browser-preview";

const session = (id: string, projectPath: string, updatedAt: string, extra: Partial<SessionInfo> = {}) =>
  ({
    id,
    projectPath,
    workflow: "chat",
    status: "idle",
    createdAt: updatedAt,
    updatedAt,
    lastSeq: 0,
    ...extra,
  }) as SessionInfo;

describe("browser preview", () => {
  it("recognises HTML files", () => {
    expect(isHtmlPath("index.html")).toBe(true);
    expect(isHtmlPath("a/page.HTM")).toBe(true);
    expect(isHtmlPath("app.js")).toBe(false);
  });

  it("prefers the current conversation, then the latest one in the folder", () => {
    const sessions = [
      session("old", "/w", "2026-01-01"),
      session("new", "/w", "2026-02-01"),
      session("other", "/elsewhere", "2026-03-01"),
    ];
    expect(previewTarget(sessions, "/w", "index.html")).toEqual({ sessionId: "new", path: "index.html" });
    expect(previewTarget(sessions, "/w", "index.html", "old")).toEqual({
      sessionId: "old",
      path: "index.html",
    });
  });

  it("maps paths into a worktree conversation and skips ones that cannot serve the file", () => {
    const sessions = [
      session("tree", "/w/.worktrees/a", "2026-02-01"),
      session("sub", "/w", "2026-01-01", { parentSessionId: "x" }),
      session("gone", "/w", "2026-03-01", { projectMissing: true }),
    ];
    expect(previewTarget(sessions, "/w/", ".worktrees/a/site/index.html")).toEqual({
      sessionId: "tree",
      path: "site/index.html",
    });
    expect(previewTarget(sessions, "/w", "index.html")).toBeUndefined();
  });
});
