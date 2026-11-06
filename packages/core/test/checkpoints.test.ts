import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, Harness, MockProvider } from "@harness/core";
import { MOCK_MODELS, tempProject } from "./helpers.js";

const read = (root: string, p: string) => readFileSync(join(root, p), "utf8");

describe("CheckpointStore", () => {
  it("restores modified, deleted and added files and leaves ignored files alone", async () => {
    const root = tempProject(
      {
        "a.txt": "one\n",
        "src/b.css": "body{}\n",
        ".gitignore": "node_modules/\n",
        "node_modules/x/index.js": "v1",
        ".harness/recreate/run1/out/static/index.html": "<h1>old</h1>",
        ".harness/recreate/run1/capture/shot.png": "png",
      },
      { git: true },
    );
    const store = new CheckpointStore(root, mkdtempSync(join(tmpdir(), "cp-store-")));
    const before = await store.create("s/cp1", "before");
    expect(before.files).toBe(4); // a.txt, b.css, .gitignore, recreate output (not capture, not node_modules)

    writeFileSync(join(root, "a.txt"), "two\n");
    spawnSync("rm", ["-rf", join(root, "src")]); // deleted through a shell, not a file tool
    mkdirSync(join(root, "new/dir"), { recursive: true });
    writeFileSync(join(root, "new/dir/c.ts"), "export {}\n");
    writeFileSync(join(root, ".harness/recreate/run1/out/static/index.html"), "<h1>broken</h1>");
    writeFileSync(join(root, "node_modules/x/index.js"), "v2");

    const preview = await store.preview(before.commit);
    expect(preview).toEqual(
      expect.arrayContaining([
        { path: "a.txt", status: "modified" },
        { path: "src/b.css", status: "added" },
        { path: "new/dir/c.ts", status: "deleted" },
        { path: ".harness/recreate/run1/out/static/index.html", status: "modified" },
      ]),
    );
    expect(preview).toHaveLength(4);

    const backup = await store.create("s/cp2", "backup");
    const changed = await store.restore(before.commit, backup.commit);
    expect(changed).toHaveLength(4);
    expect(read(root, "a.txt")).toBe("one\n");
    expect(read(root, "src/b.css")).toBe("body{}\n");
    expect(existsSync(join(root, "new"))).toBe(false);
    expect(read(root, ".harness/recreate/run1/out/static/index.html")).toBe("<h1>old</h1>");
    expect(read(root, "node_modules/x/index.js")).toBe("v2");
    // The project's own git repository is untouched.
    expect(
      spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" }).stdout.trim().split("\n"),
    ).toHaveLength(1);

    // ...and the restore can be undone.
    await store.restore(backup.commit, (await store.create("s/cp3", "x")).commit);
    expect(read(root, "a.txt")).toBe("two\n");
    expect(existsSync(join(root, "src/b.css"))).toBe(false);
    expect(read(root, "new/dir/c.ts")).toBe("export {}\n");
  });
});

describe("Session checkpoints", () => {
  it("checkpoints every turn, restores files changed by any tool and tells the model", async () => {
    const root = tempProject({ "style.css": "a{color:red}\n" });
    const mock = new MockProvider({
      replies: [
        { toolCalls: [{ name: "bash", args: { command: "rm style.css && echo hi > other.txt" } }] },
        { text: "Removed it." },
        { text: "Ok." },
      ],
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: { ...MOCK_MODELS },
    });
    const s = h.createSession({ projectPath: root, permissionMode: "yolo" });
    await s.chat("remove the css");
    expect(existsSync(join(root, "style.css"))).toBe(false);

    const cp = s.events.find((e) => e.type === "checkpoint.created");
    expect(cp).toMatchObject({ reason: "turn", files: 1 });
    // The user message comes first (it titles the session without waiting for git); the checkpoint
    // names it and precedes any agent work.
    const user = s.events.find((e) => e.type === "message.start" && e.role === "user")!;
    expect(cp!.seq).toBeGreaterThan(user.seq);
    expect(cp).toMatchObject({ messageId: user.type === "message.start" ? user.id : "" });
    const firstTool = s.events.find((e) => e.type === "tool.call")!;
    expect(cp!.seq).toBeLessThan(firstTool.seq);
    if (cp?.type !== "checkpoint.created") throw new Error("no checkpoint");

    expect(await s.previewCheckpoint(cp.id)).toEqual(
      expect.arrayContaining([
        { path: "style.css", status: "added" },
        { path: "other.txt", status: "deleted" },
      ]),
    );
    const r = await s.restoreCheckpoint(cp.id);
    expect(r.files).toHaveLength(2);
    expect(read(root, "style.css")).toBe("a{color:red}\n");
    expect(existsSync(join(root, "other.txt"))).toBe(false);
    const restored = s.events.at(-1);
    expect(restored).toMatchObject({ type: "checkpoint.restored", id: cp.id, changed: 2 });

    // The next turn tells the model which files changed under it.
    await s.chat("continue");
    const sent = mock.calls.at(-1)!.messages.at(-1)!;
    expect(sent.content).toContain("restored the workspace files");
    expect(sent.content).toContain("style.css");

    // Undo: the backup brings the agent's state back.
    if (restored?.type !== "checkpoint.restored") throw new Error("no restore");
    await s.restoreCheckpoint(restored.backupId);
    expect(existsSync(join(root, "style.css"))).toBe(false);
    expect(read(root, "other.txt")).toBe("hi\n");
  });

  it("skips checkpoints when disabled and rejects unknown ids", async () => {
    const h = new Harness({
      providers: { mock: new MockProvider({ replies: [{ text: "hi" }] }) },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: { ...MOCK_MODELS, checkpoints: { enabled: false } },
    });
    const s = h.createSession({ projectPath: tempProject({ "a.txt": "x" }) });
    await s.chat("hi");
    expect(s.events.some((e) => e.type.startsWith("checkpoint."))).toBe(false);
    await expect(s.restoreCheckpoint("cp_nope")).rejects.toThrow(/disabled/);
  });

  it("refuses a chat, a second restore or a preview while a restore is in progress", async () => {
    const mock = new MockProvider({ replies: [{ text: "hi" }, { text: "again" }] });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: { ...MOCK_MODELS },
    });
    const root = tempProject({ "a.txt": "one\n" });
    const s = h.createSession({ projectPath: root });
    await s.chat("hi");
    const cp = s.events.find((e) => e.type === "checkpoint.created");
    if (cp?.type !== "checkpoint.created") throw new Error("no checkpoint");
    writeFileSync(join(root, "a.txt"), "two\n");
    const restoring = s.restoreCheckpoint(cp.id);
    // All of these start while the restore awaits git, before it has changed anything.
    await expect(s.chat("concurrent")).rejects.toThrow(/already running/);
    await expect(s.restoreCheckpoint(cp.id)).rejects.toThrow(/Stop the session/);
    await expect(s.previewCheckpoint(cp.id)).rejects.toThrow(/Stop the session/);
    await restoring;
    expect(read(root, "a.txt")).toBe("one\n");
    expect(s.isRunning).toBe(false);
    await s.chat("again");
    expect(s.events.filter((e) => e.type === "checkpoint.restored")).toHaveLength(1);
  });
});

describe("CheckpointStore limits and secrets", () => {
  it("counts only files the project's git does not track against the file limit", async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, `${i}`]));
    const tracked = tempProject(files, { git: true });
    // 6 files, all tracked by the project: the first checkpoint must not count them as untracked
    const cp = await new CheckpointStore(tracked, mkdtempSync(join(tmpdir(), "cp-store-")), 3).create(
      "s/1",
      "x",
    );
    expect(cp.files).toBe(6);
    const loose = tempProject(files);
    await expect(
      new CheckpointStore(loose, mkdtempSync(join(tmpdir(), "cp-store-")), 3).create("s/1", "x"),
    ).rejects.toThrow(/more than 3 untracked files/);
  });

  it("never captures or restores .env files", async () => {
    const root = tempProject(
      { "a.txt": "one\n", ".env": "KEY=1\n", "sub/.env.local": "X=1\n" },
      { git: true },
    );
    const store = new CheckpointStore(root, mkdtempSync(join(tmpdir(), "cp-store-")));
    const first = await store.create("s/1", "x");
    expect(first.files).toBe(1);
    const tree = spawnSync("git", ["--git-dir", store.gitDir, "ls-tree", "-r", "--name-only", first.commit], {
      encoding: "utf8",
    }).stdout;
    expect(tree.trim()).toBe("a.txt");
    writeFileSync(join(root, ".env"), "KEY=2\n");
    writeFileSync(join(root, "a.txt"), "two\n");
    const changes = await store.restore(first.commit, (await store.create("s/2", "y")).commit);
    expect(changes).toEqual([{ path: "a.txt", status: "modified" }]);
    expect(read(root, ".env")).toBe("KEY=2\n");
  });
});
