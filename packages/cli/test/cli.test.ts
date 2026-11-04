import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { Harness, MockProvider } from "@harness/core";
import { main } from "../src/index.js";

const MODELS = {
  providers: { mock: { type: "mock" } },
  models: { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" },
} as never;
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const bin = join(repo, "packages/cli/dist/bin.js");

function sink() {
  let data = "";
  const w = new Writable({
    write(chunk, _e, cb) {
      data += chunk.toString();
      cb();
    },
  });
  return {
    w,
    get text() {
      return data.replace(/\x1b\[[0-9;]*m/g, "");
    },
  };
}

function project(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cli-proj-"));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  return dir;
}

beforeAll(() => {
  // the subprocess tests use the compiled binary
  const r = spawnSync("npx", ["tsc", "-b", "packages/cli"], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
});

describe("cli (in-process)", () => {
  it("run --yes executes the workflow and returns 0", async () => {
    const dir = project({ "a.txt": "a\n" });
    const mock = new MockProvider({
      handler: (req) => {
        const sys = req.messages[0].content;
        const last = req.messages.at(-1)!;
        if (sys.startsWith("You are the PLANNER")) return { text: "# Plan\n## Steps\n1. edit a.txt" };
        if (sys.includes("REVIEWER")) return { text: '{"summary":"ok","findings":[]}' };
        if (last.role === "user")
          return { toolCalls: [{ name: "patch_file", args: { path: "a.txt", search: "a", replace: "b" } }] };
        return { text: "edited a.txt" };
      },
    });
    const harness = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MODELS,
    });
    const out = sink();
    const code = await main(["run", "change a to b", "--yes", "-C", dir], {
      harness,
      stdout: out.w,
      stderr: out.w,
    });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("b\n");
    expect(out.text).toContain("── plan ──");
    expect(out.text).toContain("⏺ patch_file");
    expect(out.text).toContain("+b");
    expect(out.text).toContain("✔ success");
    expect(out.text).toMatch(/report: .*\.harness\/reports\//);
  });

  it("--json emits JSONL events without internal ones", async () => {
    const dir = project();
    const harness = new Harness({
      providers: { mock: new MockProvider({ replies: [{ text: "# Plan\n## Steps\n1. x" }] }) },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MODELS,
    });
    const out = sink();
    const code = await main(["plan", "something", "--json", "-C", dir], {
      harness,
      stdout: out.w,
      stderr: new Writable({ write: (_c, _e, cb) => cb() }),
    });
    expect(code).toBe(0);
    const events = out.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events[0].type).toBe("session.created");
    expect(events.at(-1).type).toBe("status");
    expect(events.some((e) => e.type === "done" && e.status === "success")).toBe(true);
    expect(events.some((e) => e.type.startsWith("context."))).toBe(false);
  });

  it("init, config, sessions, unknown command", async () => {
    const dir = project({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    const harness = new Harness({
      providers: { mock: new MockProvider() },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MODELS,
    });
    const out = sink();
    expect(await main(["init", "-C", dir], { harness, stdout: out.w })).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "cdr.config.json"), "utf8")).verify.test).toBe("npm test");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("Test: `npm test`");
    const cfg = sink();
    expect(await main(["config", "-C", dir], { harness, stdout: cfg.w })).toBe(0);
    expect(JSON.parse(cfg.text).verify.test).toBe("npm test");
    expect(await main(["sessions"], { harness, stdout: out.w })).toBe(0);
    const e = sink();
    expect(await main(["bogus"], { harness, stdout: e.w, stderr: e.w })).toBe(2);
    expect(e.text).toContain("Unknown command");
    expect(await main(["--nope"], { harness, stdout: e.w, stderr: e.w })).toBe(2);
  });

  it("returns 1 when the workflow fails", async () => {
    const dir = project();
    const harness = new Harness({
      providers: { mock: new MockProvider({ handler: () => ({ text: "nope" }) }) },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: { ...MODELS, verify: { test: "exit 1", maxAttempts: 1 } },
    });
    const out = sink();
    expect(
      await main(["run", "x", "--yes", "--workflow", "quick-fix", "-C", dir], {
        harness,
        stdout: out.w,
        stderr: out.w,
      }),
    ).toBe(1);
    expect(out.text).toContain("✘ failed");
  });
});

describe("cli (subprocess)", () => {
  const env = (home: string, replies: unknown[]) => ({
    ...process.env,
    HARNESS_HOME: home,
    NO_COLOR: "1",
    HARNESS_MOCK_REPLIES: JSON.stringify(replies),
  });

  function runBin(
    args: string[],
    input: string,
    e: NodeJS.ProcessEnv,
    cwd: string,
  ): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [bin, ...args], { cwd, env: e });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code: code ?? -1, out }));
      p.stdin.end(input);
    });
  }

  it("interactive chat answers permission prompts from stdin and can be resumed", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-home-"));
    const dir = project({ "harness.config.json": JSON.stringify(MODELS) });
    const r = await runBin(
      [],
      "please write\ny\n/exit\n",
      env(home, [
        { toolCalls: [{ name: "write_file", args: { path: "w.txt", content: "w" } }] },
        { text: "wrote it" },
      ]),
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Allow write_file");
    expect(r.out).toContain("wrote it");
    expect(existsSync(join(dir, "w.txt"))).toBe(true);
    const id = /cdr resume (\S+)\)/.exec(r.out)?.[1];
    expect(id).toBeTruthy();
    const r2 = await runBin(["resume", id!], "again\n", env(home, [{ text: "second answer" }]), dir);
    expect(r2.out).toContain("resumed");
    expect(r2.out).toContain("second answer");
    const r3 = await runBin(["sessions"], "", env(home, []), dir);
    expect(r3.out).toContain(id!);
  });

  it("persists model and permission switches, handles multiline input, and starts fresh sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "cdr-cli-"));
    const dir = project({
      "cdr.config.json": JSON.stringify(MODELS),
      "notes.md": "# Context\nPlease preserve this.",
    });
    const r = await runBin(
      [],
      "/model mock/next\n/mode auto\n/attach notes.md\nfirst line\\\n  second line\n/status\n/new\nlast message",
      env(home, [{ text: "answer one" }, { text: "answer two" }]),
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Model: mock/next (all roles)");
    expect(r.out).toContain("permission mode: auto");
    expect(r.out.match(/✔ success/g)).toHaveLength(2); // each session uses a fresh mock provider
    const { SessionStore } = await import("@harness/core");
    const store = new SessionStore(join(home, "sessions"));
    const sessions = store.list();
    expect(sessions).toHaveLength(2);
    const logs = sessions.map((s) => store.read(s.id));
    expect(logs.flat().some((e) => e.type === "message.end" && e.attachments?.[0]?.name === "notes.md")).toBe(
      true,
    );
    expect(logs.flat().some((e) => e.type === "message.end" && e.text === "first line\n  second line")).toBe(
      true,
    );
    expect(logs.flat().some((e) => e.type === "message.end" && e.text === "last message")).toBe(true);
    expect(logs.flat().some((e) => e.type === "session.settings" && e.models?.executor === "mock/next")).toBe(
      true,
    );
    const first = sessions.find((s) => logs[sessions.indexOf(s)].some((e) => e.type === "session.settings"))!;
    const resumed = await runBin(["resume", first.id], "/status\n/exit\n", env(home, []), dir);
    expect(resumed.out).toContain("mock/next · auto permissions");
    expect(resumed.out).toContain("answer one");
  });

  it("keeps new sandbox conversations in managed sandbox workspaces", async () => {
    const home = mkdtempSync(join(tmpdir(), "cdr-sandbox-cli-"));
    writeFileSync(join(home, "config.json"), JSON.stringify(MODELS));
    const r = await runBin(["--sandbox"], "/new\n/status\n/exit\n", env(home, []), project());
    expect(r.code).toBe(0);
    const { SessionStore } = await import("@harness/core");
    const sessions = new SessionStore(join(home, "sessions")).list();
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.sandbox)).toBe(true);
    expect(sessions[0].projectPath).not.toBe(sessions[1].projectPath);
  });

  it("keeps interactive JSON output parseable", async () => {
    const home = mkdtempSync(join(tmpdir(), "cdr-json-"));
    const dir = project({ "cdr.config.json": JSON.stringify(MODELS) });
    const result = spawnSync(process.execPath, [bin, "--json"], {
      cwd: dir,
      env: env(home, [{ text: "hello" }]),
      input: "hello\n/exit\n",
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.some((e) => e.type === "message.end" && e.text === "hello")).toBe(true);
    expect(result.stderr).toContain("CDR");
  });

  it("denied permission keeps the file untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-home-"));
    const dir = project({ "harness.config.json": JSON.stringify(MODELS) });
    const r = await runBin(
      ["run", "write", "--workflow", "quick-fix"],
      "n\n",
      env(home, [
        { toolCalls: [{ name: "write_file", args: { path: "w.txt", content: "w" } }] },
        { text: "ok I won't" },
      ]),
      dir,
    );
    expect(r.out).toContain("denied");
    expect(existsSync(join(dir, "w.txt"))).toBe(false);
  });
});

describe("CLI and server produce identical event logs (M3)", () => {
  it("same task, same mock model → same event sequence", async () => {
    const { startServer } = await import("@harness/server");
    const { createClient } = await import("@harness/client");
    const handler = (req: { messages: { role: string; content: string }[] }) =>
      req.messages.at(-1)!.role === "user"
        ? {
            text: "Editing.",
            toolCalls: [{ name: "patch_file", args: { path: "a.txt", search: "a", replace: "b" } }],
          }
        : { text: "Done editing." };
    const mk = () =>
      new Harness({
        providers: { mock: new MockProvider({ handler }) },
        skipGlobalConfig: true,
        loadEnv: false,
        configOverrides: MODELS,
      });

    // CLI
    const h1 = mk();
    const p1 = project({ "a.txt": "a\n" });
    const out = sink();
    expect(
      await main(["run", "edit a", "--json", "--workflow", "quick-fix", "--mode", "yolo", "-C", p1], {
        harness: h1,
        stdout: out.w,
        stderr: new Writable({ write: (_c, _e, cb) => cb() }),
      }),
    ).toBe(0);
    const cliId = JSON.parse(out.text.split("\n")[0]).sessionId;

    // server
    const h2 = mk();
    const p2 = project({ "a.txt": "a\n" });
    const srv = await startServer({ harness: h2, port: 0, token: "t" });
    try {
      const c = createClient({ baseUrl: srv.url, token: "t" });
      const s = await c.createSession({ projectPath: p2, workflow: "quick-fix", permissionMode: "yolo" });
      const done = (async () => {
        for await (const _ of c.events(s.id, { untilDone: true }));
      })();
      await c.send(s.id, "edit a", { mode: "task" });
      await done;
      await new Promise((r) => setTimeout(r, 50));
      const norm = (events: { type: string; seq: number }[], root: string) =>
        events.map((e) =>
          JSON.stringify(e, (k, v) =>
            ["ts", "sessionId", "id", "reportPath", "runId", "toolCallId"].includes(k) ? undefined : v,
          )
            .split(realpathSync(root))
            .join("<root>"),
        );
      const a = norm(h1.store.read(cliId), p1);
      const b = norm(h2.store.read(s.id), p2);
      expect(b).toEqual(a);
      expect(readFileSync(join(p1, "a.txt"), "utf8")).toBe(readFileSync(join(p2, "a.txt"), "utf8"));
    } finally {
      await srv.close();
    }
  });
});

describe("cli: goals and sidecar serve", () => {
  it("goal new / list / discard in-process", async () => {
    const dir = project({ "a.txt": "a\n" });
    const g = (...a: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-qm", "init");
    const harness = new Harness({ skipGlobalConfig: true, loadEnv: false, configOverrides: MODELS });
    const out = sink();
    const code = await main(
      [
        "goal",
        "new",
        "Add",
        "CSV",
        "--criteria",
        "tests pass",
        "--criteria",
        "docs",
        "--budget-cost",
        "2",
        "--json",
        "-C",
        dir,
      ],
      { harness, stdout: out.w, stderr: out.w },
    );
    expect(code).toBe(0);
    const goal = JSON.parse(out.text);
    expect(goal).toMatchObject({
      title: "Add CSV",
      acceptance: ["tests pass", "docs"],
      budget: { maxCost: 2 },
      status: "draft",
    });
    const list = sink();
    expect(await main(["goal", "list", "-C", dir], { harness, stdout: list.w, stderr: list.w })).toBe(0);
    expect(list.text).toContain(goal.id);
    const d = sink();
    expect(await main(["goal", "discard", goal.id], { harness, stdout: d.w, stderr: d.w })).toBe(0);
    expect(d.text).toContain("discarded");
  });

  it("serve --port 0 --token-env --ready-json prints one ready line and never the token", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-sidecar-"));
    const token = "sidecar-secret-token-123";
    const p = spawn(
      process.execPath,
      [
        bin,
        "serve",
        "--port",
        "0",
        "--token-env",
        "MORROW_SIDECAR_TOKEN",
        "--ready-json",
        "--origin",
        "tauri://localhost",
        "--origin",
        "http://tauri.localhost",
      ],
      { cwd: home, env: { ...process.env, HARNESS_HOME: home, NO_COLOR: "1", MORROW_SIDECAR_TOKEN: token } },
    );
    let stdout = "";
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    try {
      const line = await new Promise<string>((resolve, reject) => {
        p.stdout.on("data", (d) => {
          stdout += d;
          if (stdout.includes("\n")) resolve(stdout.split("\n")[0]);
        });
        p.on("exit", () => reject(new Error(`exited: ${stderr}`)));
      });
      const ready = JSON.parse(line);
      expect(ready).toMatchObject({ ready: true });
      expect(ready.port).toBeGreaterThan(0);
      expect(ready.url).toBe(`http://127.0.0.1:${ready.port}`);
      expect(
        (await fetch(`${ready.url}/sessions`, { headers: { authorization: `Bearer ${token}` } })).status,
      ).toBe(200);
      expect((await fetch(`${ready.url}/sessions`)).status).toBe(401);
      const pre = await fetch(`${ready.url}/goals`, {
        method: "OPTIONS",
        headers: { origin: "tauri://localhost", "access-control-request-method": "GET" },
      });
      expect(pre.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
      expect(existsSync(join(home, "server-token"))).toBe(false);
    } finally {
      p.kill("SIGTERM");
      await new Promise((r) => p.on("close", r));
    }
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stdout + stderr).not.toContain(token);
  });

  it("serve stops when the process in MORROW_PARENT_PID exits (sidecar watchdog)", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-watchdog-"));
    const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"]);
    const p = spawn(process.execPath, [bin, "serve", "--port", "0", "--token-env", "T", "--ready-json"], {
      cwd: home,
      env: {
        ...process.env,
        HARNESS_HOME: home,
        NO_COLOR: "1",
        T: "watchdog-token",
        MORROW_PARENT_PID: String(parent.pid),
      },
    });
    const exited = new Promise<number | null>((r) => p.on("exit", (code) => r(code)));
    try {
      await new Promise<void>((resolve) =>
        p.stdout.on("data", (d) => String(d).includes('"ready"') && resolve()),
      );
      const code = await Promise.race([
        exited,
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8000)),
      ]);
      expect(code).toBe(0);
    } finally {
      p.kill("SIGTERM");
      parent.kill();
    }
  });
});
