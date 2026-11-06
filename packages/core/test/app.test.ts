import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appAlive,
  bashTool,
  DEFAULT_CONFIG,
  localUrls,
  PermissionPolicy,
  rememberedApps,
  runAppTool,
  stopAppTool,
} from "@harness/core";
import { tempProject, toolCtx } from "./helpers.js";

/** A tiny web server that announces its URL the way dev servers do. Port 0: the system picks a free one. */
const SERVER = `
const http = require("node:http");
const s = http.createServer((q, r) => r.end("hello"));
setTimeout(() => s.listen(0, "127.0.0.1", () => console.log("  Local:   http://127.0.0.1:" + s.address().port + "/")), Number(process.env.DELAY || 0));
`;

describe("run_app", () => {
  const roots: string[] = [];
  beforeAll(() => {
    // remembered commands and logs live under the harness home: keep them out of the real one
    vi.stubEnv("CDR_HOME", mkdtempSync(join(tmpdir(), "harness-home-")));
  });
  afterEach(async () => {
    for (const root of roots.splice(0)) await stopAppTool.execute({}, toolCtx(root));
  });
  afterAll(() => vi.unstubAllEnvs());
  const project = (files: Record<string, string> = {}) => {
    const root = tempProject({ "server.js": SERVER, ...files });
    roots.push(root);
    return root;
  };

  it("starts a server in the background and returns its URL as soon as it answers", async () => {
    const root = project();
    const started = Date.now();
    const r = await runAppTool.execute({ command: "node server.js" }, toolCtx(root));
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Started `node server\.js` \(pid \d+\); it answered after/);
    const url = /Open: (http:\/\/127\.0\.0\.1:\d+\/) \(HTTP 200\)/.exec(r.output)?.[1];
    expect(url).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(10_000);
    // it outlives the tool call
    expect(await (await fetch(url!)).text()).toBe("hello");
    const [app] = rememberedApps(root);
    expect(app).toMatchObject({ command: "node server.js", cwd: "", urls: [url] });
    expect(appAlive(app)).toBe(true);
  });

  it("without a command restarts the remembered one, and only reports when it already runs", async () => {
    const root = project();
    const ctx = toolCtx(root);
    const none = await runAppTool.execute({}, ctx);
    expect(none.ok).toBe(false);
    expect(none.output).toContain("No app command is known");

    const first = await runAppTool.execute({ command: "node server.js" }, ctx);
    const pid = rememberedApps(root)[0].pid;
    const again = await runAppTool.execute({}, ctx);
    expect(again.ok).toBe(true);
    expect(again.output).toContain(`is already running (pid ${pid})`);
    expect(again.output).toContain(/Open: (\S+)/.exec(first.output)![1]);

    const stopped = await stopAppTool.execute({}, ctx);
    expect(stopped.output).toBe("Stopped `node server.js`.");
    expect(appAlive(rememberedApps(root)[0])).toBe(false);
    expect((await stopAppTool.execute({}, ctx)).output).toContain("Nothing started with run_app was running");

    const restarted = await runAppTool.execute({}, ctx);
    expect(restarted.output).toMatch(/Started `node server\.js`/);
    expect(rememberedApps(root)[0].pid).not.toBe(pid);
  });

  it("reports a command that fails at once, with its output", async () => {
    const root = project();
    const r = await runAppTool.execute({ command: "echo cannot find module >&2; exit 3" }, toolCtx(root));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("exit code 3");
    expect(r.output).toContain("cannot find module");
    expect(rememberedApps(root)[0].pid).toBeUndefined();
  });

  it("returns after the wait when nothing answers, and leaves the program running", async () => {
    const root = project();
    const ctx = toolCtx(root);
    const r = await runAppTool.execute({ command: "DELAY=1500 node server.js", wait: 1 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("no URL answered within");
    expect(r.output).toContain("call run_app again to wait for it");
    // asking again waits for the same process instead of starting a second one
    const again = await runAppTool.execute({}, ctx);
    expect(again.output).toContain("is already running");
    expect(again.output).toMatch(/Open: http:\/\/127\.0\.0\.1:\d+\//);
  });

  it("waits for a named URL when the program does not print one, and runs in a subfolder", async () => {
    const root = project({ "web/server.js": "setInterval(() => {}, 1000);" });
    const ctx = toolCtx(root);
    const r = await runAppTool.execute(
      { command: "node server.js", cwd: "web", url: "http://127.0.0.1:9/", wait: 1 },
      ctx,
    );
    expect(r.output).toContain("Not answering: http://127.0.0.1:9/");
    expect(rememberedApps(root)[0]).toMatchObject({ cwd: "web", url: "http://127.0.0.1:9/" });
    expect(
      (await runAppTool.execute({ command: "true", cwd: "../.." }, ctx).catch((e) => e)).message,
    ).toMatch(/outside the project/);
  });

  it("finds announced local URLs in program output", () => {
    const log =
      "\x1b[32m➜\x1b[0m  Local:   http://localhost:5173/\n  Network: http://192.168.1.5:5173/\nServing HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...\nAPI at http://127.0.0.1:8082/board/.";
    expect(localUrls(log)).toEqual([
      "http://localhost:5173/",
      "http://localhost:8000/",
      "http://127.0.0.1:8082/board/",
    ]);
  });

  it("is subject to the shell permission rules", () => {
    const root = project();
    const ctx = toolCtx(root);
    const cfg = {
      ...structuredClone(DEFAULT_CONFIG),
      permissions: { mode: "ask" as const, bash: { deny: ["git push*"] } },
    };
    expect(new PermissionPolicy(cfg, "yolo").check(runAppTool, { command: "rm -rf /" }, ctx).decision).toBe(
      "deny",
    );
    expect(
      new PermissionPolicy(cfg, "yolo").check(runAppTool, { command: "git push origin" }, ctx).decision,
    ).toBe("deny");
    const ask = new PermissionPolicy(cfg, "ask");
    expect(ask.check(runAppTool, { command: "npm run dev" }, ctx).decision).toBe("ask");
    ask.record("run_app", { command: "npm run dev" }, "always");
    expect(ask.check(runAppTool, { command: "npm run dev" }, ctx).decision).toBe("allow");
    expect(ask.check(runAppTool, { command: "npm run other" }, ctx).decision).toBe("ask");
    const auto = new PermissionPolicy(cfg, "auto");
    expect(auto.check(runAppTool, { command: "npm run dev" }, ctx).decision).toBe("allow");
    expect(auto.check(runAppTool, { command: "sudo ./start.sh" }, ctx).decision).toBe("ask");
    expect(auto.check(stopAppTool, {}, ctx).decision).toBe("allow");
  });

  it("asks with the remembered command when none is given, and not at all while it runs", async () => {
    const root = project();
    const ctx = toolCtx(root);
    const ask = new PermissionPolicy(structuredClone(DEFAULT_CONFIG), "ask");
    await runAppTool.execute({ command: "node server.js" }, ctx);
    expect(ask.check(runAppTool, {}, ctx)).toMatchObject({ decision: "allow", risk: "low" });
    await stopAppTool.execute({}, ctx);
    expect(ask.check(runAppTool, {}, ctx)).toMatchObject({ decision: "ask", reason: "Runs: node server.js" });
  });
});

describe("bash with background jobs", () => {
  it("returns when the shell is done instead of waiting for a job left in the background", async () => {
    const root = tempProject();
    const started = Date.now();
    const r = await bashTool().execute(
      { command: "cd . && sleep 20 &\necho started; sleep 0.2", timeout: 15 },
      toolCtx(root),
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("started");
    expect(r.output).toContain("left a background process running");
    const quick = await bashTool().execute({ command: "echo done" }, toolCtx(root));
    expect(quick.output).toBe("done\n[exit code 0]");
  });
});
