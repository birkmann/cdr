import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Harness, MockProvider, harnessHome, checkPreviewTool, findChrome } from "@harness/core";
import { MOCK_MODELS, tempProject, toolCtx } from "./helpers.js";

describe("sandbox sessions", () => {
  it("creates separate sandboxes when launched from a workspace container", () => {
    const h = new Harness({ skipGlobalConfig: true, loadEnv: false, configOverrides: MOCK_MODELS });
    const a = h.createSession({ projectPath: homedir(), title: "first" });
    const b = h.createSession({ projectPath: homedir(), title: "second" });
    const c = h.createSession({ projectPath: "/" });
    expect(a.isSandbox && b.isSandbox && c.isSandbox).toBe(true);
    expect(a.projectRoot).not.toBe(b.projectRoot);
    expect(a.projectRoot).not.toBe(homedir());
    expect(h.createSession({ projectPath: tempProject() }).isSandbox).toBe(false);
  });
  it("creates a fresh git workspace, uses auto permissions, sandbox prompt and set_preview", async () => {
    const mock = new MockProvider({
      replies: [
        {
          toolCalls: [
            {
              name: "write_file",
              args: { path: "index.html", content: "<canvas id=c></canvas><script src=game.js></script>" },
            },
          ],
        },
        {
          toolCalls: [
            { name: "write_file", args: { path: "game.js", content: "console.log('snake')" } },
            { name: "set_preview", args: { path: "index.html", title: "Snake" } },
          ],
        },
        { text: "Done – open the preview." },
      ],
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s = h.createSession({ sandbox: { name: "Create a snake game" } });
    expect(s.projectRoot.startsWith(join(harnessHome(), "sandboxes", "create-a-snake-game-"))).toBe(true);
    expect(existsSync(join(s.projectRoot, ".git"))).toBe(true);
    expect(s.isSandbox).toBe(true);
    expect(s.policy.mode).toBe("auto");
    await s.chat("create a snake game");
    // no permission prompts in auto mode, files written
    expect(s.events.some((e) => e.type === "permission.request")).toBe(false);
    expect(readFileSync(join(s.projectRoot, "game.js"), "utf8")).toContain("snake");
    expect(mock.calls[0].messages[0].content).toContain("# Sandbox workspace");
    expect(mock.calls[0].tools?.map((t) => t.name)).toContain("set_preview");
    const prev = s.events.find((e) => e.type === "preview.ready");
    expect(prev).toMatchObject({ path: "index.html", title: "Snake" });
    const info = h.listSessions().find((x) => x.id === s.id)!;
    expect(info.sandbox).toBe(true);
    // resume keeps sandbox behaviour
    const h2 = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const r = h2.getSession(s.id);
    expect(r.isSandbox).toBe(true);
    expect(r.policy.mode).toBe("auto");
  });

  it("set_preview rejects missing and non-HTML files", async () => {
    const mock = new MockProvider({
      replies: [
        {
          toolCalls: [
            { name: "set_preview", args: { path: "nope.html" } },
            { name: "set_preview", args: { path: ".gitignore" } },
          ],
        },
        { text: "ok" },
      ],
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s = h.createSession({ sandbox: true });
    await s.chat("x");
    const results = mock.calls[1].messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results[0]).toContain("No such file");
    expect(results[1]).toContain("needs an .html file");
    expect(s.events.some((e) => e.type === "preview.ready")).toBe(false);
  });

  it("marks sessions whose project folder was deleted", async () => {
    const { rmSync } = await import("node:fs");
    const h = new Harness({
      providers: { mock: new MockProvider() },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s = h.createSession({ sandbox: true });
    const h2 = new Harness({
      sessionsDir: h.store.dir,
      providers: { mock: new MockProvider() },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    rmSync(s.projectRoot, { recursive: true, force: true });
    expect(h2.listSessions().find((x) => x.id === s.id)?.projectMissing).toBe(true);
  });
});

describe("check_preview and auto preview", () => {
  const hasChrome = !!findChrome();
  it.skipIf(!hasChrome)(
    "reports JavaScript errors and page summary from a headless browser",
    async () => {
      const root = tempProject({
        "ok.html":
          "<!doctype html><body><h1>Snake</h1><canvas></canvas><script>console.log('ready')</script></body>",
        "bad.html": "<!doctype html><body><p>x</p><script>notDefined()</script></body>",
      });
      const ok = await checkPreviewTool.execute({ path: "ok.html" }, toolCtx(root));
      expect(ok.ok).toBe(true);
      expect(ok.output).toContain("1 canvas");
      expect(ok.output).toContain("Snake");
      expect(ok.output).toContain("No JavaScript errors");
      expect(ok.output).toContain("ready");
      const bad = await checkPreviewTool.execute({ path: "bad.html" }, toolCtx(root));
      expect(bad.ok).toBe(false);
      expect(bad.output).toMatch(/Uncaught ReferenceError: notDefined is not defined/);
    },
    60_000,
  );

  it("publishes index.html automatically when a sandbox run ends without set_preview", async () => {
    const mock = new MockProvider({
      replies: [
        { toolCalls: [{ name: "write_file", args: { path: "index.html", content: "<h1>hi</h1>" } }] },
        { text: "done" },
      ],
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s = h.createSession({ sandbox: true });
    await s.chat("make a page");
    const prev = s.events.filter((e) => e.type === "preview.ready");
    expect(prev).toHaveLength(1);
    expect(prev[0]).toMatchObject({ path: "index.html" });
    expect(mock.calls[0].messages[0].content).toContain("Do NOT install browsers");
  });
});
