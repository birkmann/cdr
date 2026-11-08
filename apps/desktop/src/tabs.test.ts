import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, INITIAL_TABS, MAX_GROUPS, parseLayout, tabOps, type Tabs } from "./store";

const keys = (s: Tabs, g: number) => s.tabs.filter((t) => (s.groups[t.key] ?? 0) === g).map((t) => t.key);
const file = (path: string) => ({ kind: "file" as const, path });

describe("editor tabs", () => {
  it("opens a preview tab in place of the welcome tab", () => {
    const s = tabOps.open(INITIAL_TABS, { kind: "preview", sessionId: "s1" });
    expect(keys(s, 0)).toEqual(["preview:s1"]);
    expect(s.activeIn).toEqual(["preview:s1"]);
  });

  it("opens the new conversation's preview beside a visible preview of another one", () => {
    let s = tabOps.open(INITIAL_TABS, { kind: "preview", sessionId: "s1" });
    s = tabOps.open(s, file("a"));
    s = tabOps.activate(s, "preview:s1");
    s = tabOps.followPreview(s, "s2");
    expect(keys(s, 0)).toEqual(["preview:s1", "preview:s2", "file:a"]);
    expect(s.activeIn).toEqual(["preview:s2"]);
    // Switching back activates the existing tab instead of opening another.
    s = tabOps.followPreview(s, "s1");
    expect(keys(s, 0)).toEqual(["preview:s1", "preview:s2", "file:a"]);
    expect(s.activeIn).toEqual(["preview:s1"]);
  });

  it("keeps conversations and previews across a folder switch", () => {
    let s = tabOps.open(INITIAL_TABS, { kind: "chat", sessionId: "s1" });
    s = tabOps.open(s, file("a"));
    s = tabOps.split(s, "file:a", 1);
    s = tabOps.open(s, { kind: "preview", sessionId: "s1" });
    s = tabOps.open(s, file("b"));
    const kept = tabOps.keepConversations(s);
    expect(kept.tabs.map((t) => t.key)).toEqual(["chat:s1", "preview:s1"]);
    expect(kept.activeIn).toEqual(["chat:s1", "preview:s1"]);
    expect(tabOps.keepConversations(tabOps.open(INITIAL_TABS, file("a")))).toBe(INITIAL_TABS);
  });

  it("leaves tabs alone when no preview is visible", () => {
    let s = tabOps.open(INITIAL_TABS, { kind: "preview", sessionId: "s1" });
    s = tabOps.open(s, file("a"));
    expect(tabOps.followPreview(s, "s2")).toBe(s);
  });

  it("reorders tabs within a group", () => {
    let s = tabOps.open(INITIAL_TABS, file("a"));
    s = tabOps.open(s, file("b"));
    s = tabOps.open(s, file("c"));
    s = tabOps.move(s, "file:c", 0, "file:a");
    expect(keys(s, 0)).toEqual(["file:c", "file:a", "file:b"]);
    s = tabOps.move(s, "file:c", 0);
    expect(keys(s, 0)).toEqual(["file:a", "file:b", "file:c"]);
  });

  it("splits by moving a tab to group 1 and opens new tabs in the focused group", () => {
    let s = tabOps.open(INITIAL_TABS, file("a"));
    s = tabOps.open(s, { kind: "preview", sessionId: "s1" });
    s = tabOps.move(s, "preview:s1", 1);
    expect(keys(s, 0)).toEqual(["file:a"]);
    expect(keys(s, 1)).toEqual(["preview:s1"]);
    expect(s.activeIn).toEqual(["file:a", "preview:s1"]);
    expect(s.focused).toBe(1);
    s = tabOps.activate(s, "file:a");
    expect(s.focused).toBe(0);
    s = tabOps.open(s, file("b"));
    expect(keys(s, 0)).toEqual(["file:a", "file:b"]);
    // Re-opening an existing tab focuses it in its own group.
    s = tabOps.open(s, { kind: "preview", sessionId: "s1" });
    expect(s.focused).toBe(1);
  });

  it("closes the split when its last tab closes or moves away", () => {
    let s = tabOps.open(INITIAL_TABS, file("a"));
    s = tabOps.open(s, file("b"));
    s = tabOps.move(s, "file:b", 1);
    s = tabOps.close(s, "file:b");
    expect(s.activeIn).toEqual(["file:a"]);
    expect(s.focused).toBe(0);
    s = tabOps.open(s, file("b"));
    s = tabOps.move(s, "file:b", 1);
    s = tabOps.move(s, "file:b", 0, "file:a");
    expect(keys(s, 0)).toEqual(["file:b", "file:a"]);
    expect(s.activeIn).toEqual(["file:b"]);
  });

  it("promotes the split group when the main group empties", () => {
    let s = tabOps.open(INITIAL_TABS, file("a"));
    s = tabOps.open(s, file("b"));
    s = tabOps.move(s, "file:b", 1);
    s = tabOps.close(s, "file:a");
    expect(keys(s, 0)).toEqual(["file:b"]);
    expect(s.activeIn).toEqual(["file:b"]);
  });

  it("falls back to the welcome tab when everything closes", () => {
    let s = tabOps.open(INITIAL_TABS, file("a"));
    s = tabOps.close(s, "file:a");
    expect(s.tabs.map((t) => t.key)).toEqual(["welcome"]);
    expect(s.activeIn).toEqual(["welcome"]);
  });

  it("splits into more than two groups and closes empty ones in between", () => {
    let s = tabOps.open(INITIAL_TABS, file("a"));
    s = tabOps.open(s, file("b"));
    s = tabOps.open(s, file("c"));
    s = tabOps.split(s, "file:c", 1);
    s = tabOps.split(s, "file:b", 1);
    // b went into a new group between a and c.
    expect(s.activeIn).toEqual(["file:a", "file:b", "file:c"]);
    expect(s.focused).toBe(1);
    s = tabOps.close(s, "file:b");
    expect(s.activeIn).toEqual(["file:a", "file:c"]);
    expect(keys(s, 1)).toEqual(["file:c"]);
    expect(s.focused).toBe(0);
  });

  it("opens a tab in a new group on the right, up to the group limit", () => {
    let s = tabOps.open(INITIAL_TABS, file("a"));
    for (let i = 1; i < MAX_GROUPS + 2; i++) s = tabOps.open(s, file(`x${i}`), s.activeIn.length);
    expect(s.activeIn).toHaveLength(MAX_GROUPS);
    expect(keys(s, MAX_GROUPS - 1)).toEqual([
      `file:x${MAX_GROUPS - 1}`,
      `file:x${MAX_GROUPS}`,
      `file:x${MAX_GROUPS + 1}`,
    ]);
    // Splitting at the limit moves the tab into the nearest group instead.
    s = tabOps.split(s, `file:x${MAX_GROUPS}`, 1);
    expect(s.activeIn).toHaveLength(MAX_GROUPS);
    expect(keys(s, 1)).toEqual(["file:x1", `file:x${MAX_GROUPS}`]);
  });

  it("turns a new-conversation tab into its conversation in place", () => {
    let s = tabOps.open(INITIAL_TABS, file("a"));
    s = tabOps.open(s, { kind: "chat", sessionId: null, draft: 1 }, 1);
    s = tabOps.open(s, file("b"), 1);
    s = tabOps.activate(s, "chat:new:1");
    s = tabOps.replace(s, "chat:new:1", { kind: "chat", sessionId: "s1" });
    expect(keys(s, 1)).toEqual(["chat:s1", "file:b"]);
    expect(s.activeIn).toEqual(["file:a", "chat:s1"]);
    // A conversation already open elsewhere is shown instead of opened twice.
    s = tabOps.open(s, { kind: "chat", sessionId: null, draft: 2 }, 0);
    s = tabOps.replace(s, "chat:new:2", { kind: "chat", sessionId: "s1" });
    expect(s.tabs.map((t) => t.key)).toEqual(["file:a", "chat:s1", "file:b"]);
    expect(s.focused).toBe(1);
  });
});

describe("the saved layout", () => {
  it("starts in the chat view with the project column open", () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(null).mode).toBe("chat");
    expect(parseLayout(null).rail).toBe(true);
  });

  it("moves a layout from before the chat view to it, keeping its panels", () => {
    const layout = parseLayout('{"side":"git","bottom":"terminal","agentPanel":false,"agentDock":"left"}');
    expect(layout).toMatchObject({
      mode: "chat",
      side: "git",
      bottom: "terminal",
      agentPanel: false,
      agentDock: "left",
      rail: true,
    });
  });

  it.each(["agents", "goals", "nonsense"])("replaces the removed side panel %s with the explorer", (side) => {
    expect(parseLayout(JSON.stringify({ side })).side).toBe("files");
  });

  it("keeps a closed side panel closed", () => {
    expect(parseLayout('{"side":null}').side).toBeNull();
  });

  it("remembers the view and the column state", () => {
    const layout = parseLayout('{"mode":"code","rail":false,"railCollapsed":{"goals":true}}');
    expect(layout).toMatchObject({ mode: "code", rail: false, railCollapsed: { goals: true } });
  });

  it.each(['{"mode":"other"}', '{"railCollapsed":null}'])("ignores invalid values in %s", (raw) => {
    expect(parseLayout(raw)).toEqual(DEFAULT_LAYOUT);
  });

  it("falls back to the default when the saved value is corrupt", () => {
    expect(parseLayout("{oops")).toEqual(DEFAULT_LAYOUT);
  });
});
