import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@harness/protocol";
import { Harness, MockProvider } from "@harness/core";
import { startServer, type StartedServer } from "@harness/server";
import { createClient, initialSessionState, reduceSession, HarnessApiError } from "@harness/client";

const MODELS = {
  providers: { mock: { type: "mock" } },
  models: { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" },
} as never;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let srv: StartedServer;
let project: string;
const mock = new MockProvider({
  handler: (req) => {
    const last = req.messages.at(-1)!;
    const sys = req.messages[0].content;
    if (sys.startsWith("You are the PLANNER")) return { text: "# Plan\n## Steps\n1. write hello.txt" };
    if (sys.includes("code REVIEWER")) return { text: '```json\n{"summary":"fine","findings":[]}\n```' };
    if (last.role === "user")
      return { toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "hi\n" } }] };
    return { text: "Wrote hello.txt" };
  },
});

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), "srv-proj-"));
  writeFileSync(join(project, "README.md"), "x\n");
  const harness = new Harness({
    providers: { mock },
    skipGlobalConfig: true,
    loadEnv: false,
    configOverrides: MODELS,
  });
  srv = await startServer({ harness, port: 0, token: "test-token", keepAliveMs: 200 });
});
afterAll(async () => {
  await srv?.close();
});

describe("server + client", () => {
  it("rejects missing or wrong tokens, allows /health", async () => {
    expect((await fetch(`${srv.url}/health`)).status).toBe(200);
    expect((await fetch(`${srv.url}/sessions`)).status).toBe(401);
    expect((await fetch(`${srv.url}/sessions`, { headers: { authorization: "Bearer nope" } })).status).toBe(
      401,
    );
    const bad = createClient({ baseUrl: srv.url, token: "wrong" });
    await expect(bad.listSessions()).rejects.toBeInstanceOf(HarnessApiError);
  });

  it("CORS allows configured origins only", async () => {
    const ok = await fetch(`${srv.url}/sessions`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const no = await fetch(`${srv.url}/sessions`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("tells the user to connect a model instead of starting a chat without an API key", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    try {
      const c = createClient({ baseUrl: srv.url, token: "test-token" });
      const before = (await c.listSessions()).length;
      const noKey = { executor: "deepseek/deepseek-flash" };
      for (const req of [
        { projectPath: project, models: noKey },
        { sandbox: { name: "nokey" }, models: noKey },
      ]) {
        const err = await c.createSession(req).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(HarnessApiError);
        expect((err as HarnessApiError).status).toBe(400);
        expect((err as Error).message).toMatch(/No model is connected.*DEEPSEEK_API_KEY/);
      }
      expect((await c.listSessions()).length).toBe(before);

      // an existing chat switched to a provider without a key: refused before any user message is recorded
      const info = await c.createSession({ projectPath: project });
      await c.updateSettings(info.id, { models: noKey });
      await expect(c.send(info.id, "hello")).rejects.toThrow(/No model is connected/);
      const s = await c.getSession(info.id);
      expect(s.events?.some((e) => e.type === "message.start")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shows where a conversation is stored, its raw log and the files it used", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    const storage = await c.storage();
    expect(storage.sessionsDir).toBeTruthy();
    const info = await c.createSession({ projectPath: project, permissionMode: "yolo" });
    const done = (async () => {
      for await (const _ of c.events(info.id, { untilDone: true })) void _;
    })();
    await c.send(info.id, "create hello.txt");
    await done;
    const log = await c.sessionLog(info.id);
    expect(log.path).toBe(join(storage.sessionsDir, `${info.id}.jsonl`));
    expect(log.content).toBe(readFileSync(log.path, "utf8"));
    expect(log.bytes).toBe(Buffer.byteLength(log.content));
    expect(log.truncated).toBe(false);
    const lines = log.content.trim().split("\n");
    expect(log.records).toBe(lines.length);
    expect(lines.map((l) => JSON.parse(l).type)).toContain("session.created");
    expect(log.files).toEqual([{ path: "hello.txt", uses: ["write_file"], viewable: true }]);
    await expect(c.sessionLog("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("deletes messages, branches a conversation and merges the branch back", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    const info = await c.createSession({ projectPath: project, permissionMode: "yolo" });
    const turn = async (id: string, text: string) => {
      const done = (async () => {
        for await (const _ of c.events(id, {
          untilDone: true,
          after: (await c.getSession(id, { events: false })).lastSeq,
        }))
          void _;
      })();
      await c.send(id, text, { mode: "chat" });
      await done;
    };
    await turn(info.id, "one");
    await turn(info.id, "two");
    const userIds = async (id: string) =>
      ((await c.getSession(id)).events ?? []).flatMap((e) =>
        e.type === "message.start" && e.role === "user" ? [e.id] : [],
      );
    const [one, two] = await userIds(info.id);

    const branch = await c.forkSession(info.id, { messageId: one });
    expect(branch).toMatchObject({
      title: "one (branch)",
      forkedFrom: { sessionId: info.id, messageId: one },
    });
    expect(await userIds(branch.id)).toEqual([one]);
    await turn(branch.id, "three");
    expect(await c.mergeBranch(branch.id)).toEqual({ targetId: info.id, messages: 2 });
    await expect(c.mergeBranch(branch.id)).rejects.toMatchObject({ status: 409 });

    expect((await c.deleteMessage(info.id, two)).ids).toContain(two);
    const state = ((await c.getSession(info.id)).events ?? []).reduce(reduceSession, initialSessionState());
    const users = state.timeline.flatMap((i) =>
      i.kind === "message" && state.messages[i.id].role === "user" ? [state.messages[i.id].text] : [],
    );
    expect(users).toEqual(["one", "three"]);
    await expect(c.deleteMessage(info.id, two)).rejects.toMatchObject({ status: 409 });
    expect((await c.forkSession(info.id)).title).toBe("one (copy)");
    await expect(c.forkSession("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("runs a full task with plan approval and permissions via HTTP + SSE", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    const info = await c.createSession({ projectPath: project, permissionMode: "ask" });
    expect(info.status).toBe("idle");
    const events: HarnessEvent[] = [];
    let state = initialSessionState();
    const consumer = (async () => {
      for await (const e of c.events(info.id, { untilDone: true })) {
        events.push(e);
        state = reduceSession(state, e);
        if (e.type === "plan.proposed") await c.decidePlan(info.id, e.id, "approve");
        if (e.type === "permission.request") await c.answerPermission(info.id, e.id, "allow");
      }
    })();
    await c.send(info.id, "create hello.txt", { mode: "task" });
    await expect(c.send(info.id, "again", { mode: "task" })).rejects.toMatchObject({ status: 409 });
    await consumer;
    expect(readFileSync(join(project, "hello.txt"), "utf8")).toBe("hi\n");
    expect(state.done?.status).toBe("success");
    expect(state.pendingPermissions).toHaveLength(0);
    expect(Object.values(state.tools)[0]).toMatchObject({ name: "write_file", status: "ok" });
    expect(
      Object.values(state.messages).some((m) => m.role === "user" && m.text === "create hello.txt"),
    ).toBe(true);
    // internal events are filtered from the stream
    expect(events.some((e) => e.type.startsWith("context."))).toBe(false);
    // seq strictly increasing
    expect(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq)).toBe(true);

    // session details, files and diff helpers
    const details = await c.getSession(info.id);
    expect(details.status).toBe("done");
    expect(details.events!.length).toBeGreaterThan(events.length); // includes internal events
    expect((await c.files(info.id)).files).toContain("hello.txt");
    expect((await c.files(info.id, "hello.txt")).content).toBe("hi\n");
    await expect(c.files(info.id, "../../etc/passwd")).rejects.toMatchObject({ status: 403 });
    expect((await c.listSessions()).map((s) => s.id)).toContain(info.id);

    // reconnect: replay from a seq returns only later events
    const mid = events[Math.floor(events.length / 2)].seq;
    const replay: HarnessEvent[] = [];
    for await (const e of c.events(info.id, { after: mid, untilDone: true })) replay.push(e);
    expect(replay[0].seq).toBeGreaterThan(mid);
    expect(replay.at(-1)!.type).toBe("done");

    // the event log on disk is identical to what a CLI-driven session records (same core)
    const disk = srv.harness.store.read(info.id);
    expect(disk.map((e) => e.seq)).toEqual(details.events!.map((e) => e.seq));
  });

  it("follows each batch of events with a comment line, without waiting for the keep-alive", async () => {
    // WebKit can hold the last packet of a stream until another arrives; the comment releases it.
    const quiet = await startServer({
      harness: srv.harness,
      port: 0,
      token: "test-token",
      keepAliveMs: 60_000,
    });
    try {
      const c = createClient({ baseUrl: quiet.url, token: "test-token" });
      const info = await c.createSession({ projectPath: project, permissionMode: "auto" });
      await c.send(info.id, "hello", { mode: "chat" });
      for await (const _ of c.events(info.id, { untilDone: true })) void _;
      const ctrl = new AbortController();
      const res = await fetch(`${quiet.url}/sessions/${info.id}/events?after=0`, {
        headers: { authorization: "Bearer test-token" },
        signal: ctrl.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const deadline = Date.now() + 2000;
      while (!text.includes(": ping") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      ctrl.abort();
      expect(text).toContain("event: done");
      expect(text.indexOf(": ping")).toBeGreaterThan(text.indexOf("event: done"));
    } finally {
      await quiet.close();
    }
  });

  it("chat mode, cancel and validation errors", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    await expect(c.createSession({ projectPath: "/definitely/not/here" })).rejects.toMatchObject({
      status: 400,
    });
    const info = await c.createSession({ projectPath: project });
    await expect(c.send(info.id, "")).rejects.toMatchObject({ status: 400 });
    await expect(c.answerPermission(info.id, "nope", "allow")).rejects.toMatchObject({ status: 404 });
    await expect(c.getSession("missing-session")).rejects.toMatchObject({ status: 404 });

    const ctrl = new AbortController();
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const e of c.events(info.id, { signal: ctrl.signal, untilDone: true })) {
        seen.push(e.type);
        if (e.type === "permission.request") await c.cancel(info.id);
      }
    })();
    await c.send(info.id, "write it");
    await consumer;
    expect(seen).toContain("permission.request");
    expect(seen.at(-1)).toBe("done");
    const d = await c.getSession(info.id, { events: false });
    expect(d.status).toBe("cancelled");
    expect(d.events).toBeUndefined();
  });

  it("previews and restores a turn checkpoint, and undoes the restore", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    const root = mkdtempSync(join(tmpdir(), "srv-cp-"));
    writeFileSync(join(root, "README.md"), "x\n");
    const info = await c.createSession({ projectPath: root, permissionMode: "yolo" });
    const events: HarnessEvent[] = [];
    const consumer = (async () => {
      for await (const e of c.events(info.id, { untilDone: true })) events.push(e);
    })();
    await c.send(info.id, "write it");
    await consumer;
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hi\n");
    const cp = events.find((e) => e.type === "checkpoint.created");
    if (cp?.type !== "checkpoint.created") throw new Error("no checkpoint");
    expect(await c.previewCheckpoint(info.id, cp.id)).toEqual([{ path: "hello.txt", status: "deleted" }]);
    const r = await c.restoreCheckpoint(info.id, cp.id);
    expect(r.changed).toBe(1);
    expect(existsSync(join(root, "hello.txt"))).toBe(false);
    await c.restoreCheckpoint(info.id, r.backupId);
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hi\n");
    await expect(c.restoreCheckpoint(info.id, "cp_missing")).rejects.toMatchObject({ status: 409 });
    const d = await c.getSession(info.id);
    expect(d.events?.filter((e) => e.type === "checkpoint.restored")).toHaveLength(2);
  });

  it("lists skills and sends a message with selected skills", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    const skills = await c.skills(project);
    expect(skills.find((s) => s.name === "grill-me")).toMatchObject({ source: "builtin", userOnly: true });
    expect((await c.skills()).some((s) => s.name === "tdd")).toBe(true);
    const info = await c.createSession({ projectPath: project, permissionMode: "yolo" });
    await expect(c.send(info.id, "x", { skills: ["no-such-skill"] })).rejects.toMatchObject({ status: 400 });
    await c.send(info.id, "grill my plan", { skills: ["grill-me"] });
    let state = initialSessionState();
    for await (const e of c.events(info.id, { untilDone: true })) state = reduceSession(state, e);
    const user = Object.values(state.messages).find((m) => m.role === "user");
    expect(user).toMatchObject({ text: "grill my plan", skills: ["grill-me"] });
  });

  it("validates and persists thinking effort through the API and reducer", async () => {
    const provider = new MockProvider({ replies: [{ text: "ok" }] });
    provider.capabilities = () => ({
      tools: true,
      json: true,
      contextWindow: 100000,
      reasoningEfforts: ["none", "low", "high", "max"],
    });
    const h = new Harness({
      providers: { mock: provider },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MODELS,
    });
    const server = await startServer({ harness: h, port: 0, token: "effort-test" });
    try {
      const c = createClient({ baseUrl: server.url, token: "effort-test" });
      expect((await c.models(project, "mock/m")).reasoningEfforts).toEqual(["none", "low", "high", "max"]);
      const created = await c.createSession({ projectPath: project, reasoningEffort: "high" });
      expect(created.reasoningEffort).toBe("high");
      await c.updateSettings(created.id, { reasoningEffort: "none" });
      const snapshot = await c.getSession(created.id);
      expect(snapshot.reasoningEffort).toBe("none");
      expect(snapshot.events!.reduce(reduceSession, initialSessionState).reasoningEffort).toBe("none");
      expect((await c.listSessions()).find((s) => s.id === created.id)?.reasoningEffort).toBe("none");
      await expect(c.updateSettings(created.id, { reasoningEffort: "medium" })).rejects.toMatchObject({
        status: 400,
      });
      await expect(c.createSession({ sandbox: true, reasoningEffort: "bad" as never })).rejects.toMatchObject(
        { status: 400 },
      );
    } finally {
      await server.close();
    }
  });

  it("reports the executor provider's account balance, and null where it has none", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    expect(await c.balance({ projectPath: project })).toEqual({ provider: "mock", items: null });
    const provider = new MockProvider({ replies: [{ text: "ok" }] });
    let fail = false;
    Object.assign(provider, {
      getBalance: async () => {
        if (fail) throw new Error("balance request failed (500)");
        return [{ currency: "USD", total: 12.34, granted: 0, toppedUp: 12.34 }];
      },
    });
    const h = new Harness({
      providers: { mock: provider },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MODELS,
    });
    const server = await startServer({ harness: h, port: 0, token: "balance-test" });
    try {
      const b = createClient({ baseUrl: server.url, token: "balance-test" });
      expect(await b.balance({ projectPath: project, model: "mock/m" })).toEqual({
        provider: "mock",
        items: [{ currency: "USD", total: 12.34, granted: 0, toppedUp: 12.34 }],
      });
      expect(await b.balance({ projectPath: project, provider: "nope" })).toEqual({
        provider: "nope",
        items: null,
      });
      fail = true;
      await expect(b.balance({ projectPath: project })).rejects.toMatchObject({ status: 502 });
    } finally {
      await server.close();
    }
  });

  it("mirrors an independently running terminal session, then allows web continuation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminalProvider = new MockProvider({
      handler: async (_req, index) => {
        if (!index) {
          await gate;
          return {
            toolCalls: [
              { name: "write_file", args: { path: "index.html", content: "<h1>Built in terminal</h1>" } },
              { name: "set_preview", args: { path: "index.html", title: "Terminal app" } },
            ],
          };
        }
        return { text: "Terminal build complete" };
      },
    });
    const sessionsDir = mkdtempSync(join(tmpdir(), "shared-sessions-"));
    const root = mkdtempSync(join(tmpdir(), "shared-project-"));
    const options = { sessionsDir, skipGlobalConfig: true, loadEnv: false, configOverrides: MODELS };
    const terminal = new Harness({ ...options, providers: { mock: terminalProvider } });
    const web = new Harness({
      ...options,
      providers: { mock: new MockProvider({ replies: [{ text: "Continued on web" }] }) },
    });
    const original = terminal.createSession({ projectPath: root, permissionMode: "auto" });
    const server = await startServer({ harness: web, port: 0, token: "shared-test" });
    try {
      const c = createClient({ baseUrl: server.url, token: "shared-test" });
      const before = await c.getSession(original.id); // Cache it before the terminal starts.
      const received: HarnessEvent[] = [];
      const stream = (async () => {
        for await (const e of c.events(original.id, { after: before.lastSeq, untilDone: true }))
          received.push(e);
      })();
      const run = original.chat("Build a page");
      const active = await c.getSession(original.id);
      expect(active.status).toBe("running");
      expect(active.externalRun).toBe(true);
      await expect(c.send(original.id, "Do not duplicate this run")).rejects.toMatchObject({ status: 409 });
      await expect(c.cancel(original.id)).rejects.toMatchObject({ status: 409 });
      release();
      await run;
      await stream;
      expect(received.some((e) => e.type === "preview.ready")).toBe(true);
      expect(received.some((e) => e.type === "message.end" && e.text === "Terminal build complete")).toBe(
        true,
      );
      expect(new Set(received.map((e) => e.seq)).size).toBe(received.length);
      const completed = await c.getSession(original.id);
      expect(completed.externalRun).toBe(false);
      expect(completed.lastSeq).toBe(original.events.at(-1)!.seq);
      expect((await c.files(original.id)).files).toContain("index.html");
      expect(await (await fetch(c.previewUrl(completed.previewBase, "index.html"))).text()).toContain(
        "Built in terminal",
      );
      expect(web.store.read(original.id)).toHaveLength(original.events.length); // Mirroring never appends duplicates.
      await web.getSession(original.id).chat("Continue here");
      original.syncFromStore();
      expect(original.events.some((e) => e.type === "message.end" && e.text === "Continued on web")).toBe(
        true,
      );
      expect(new Set(original.events.map((e) => e.seq)).size).toBe(original.events.length);
    } finally {
      release();
      await server.close();
      terminal.closeAll();
      web.closeAll();
    }
  });

  it("lists models and workflows", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    const m = await c.models(project);
    expect(m.models.find((x) => x.role === "executor")).toMatchObject({ id: "mock/m", configured: true });
    expect(m.workflows).toContain("quick-fix");
    // the mock provider needs no key, so there is no key variable or source to report
    expect(m.providers).toContainEqual({ id: "mock", configured: true });
  });
  it("continues a stopped job through the client, preserving the session and enforcing state checks", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    const info = await c.createSession({ projectPath: project, permissionMode: "ask" });
    await expect(c.continueJob(info.id)).rejects.toMatchObject({ status: 409 });
    const first = (async () => {
      for await (const e of c.events(info.id, { untilDone: true })) {
        if (e.type === "permission.request") await c.cancel(info.id);
      }
    })();
    await c.send(info.id, "write it");
    await first;
    const before = await c.getSession(info.id);
    const after = (async () => {
      const events: HarnessEvent[] = [];
      for await (const e of c.events(info.id, { after: before.lastSeq, untilDone: true })) {
        events.push(e);
        if (e.type === "permission.request") {
          await expect(c.continueJob(info.id)).rejects.toMatchObject({ status: 409 });
          await c.answerPermission(info.id, e.id, "allow");
        }
      }
      return events;
    })();
    await c.continueJob(info.id);
    const events = await after;
    expect(events.at(-1)).toMatchObject({ type: "done", status: "success" });
    expect((await c.getSession(info.id)).id).toBe(info.id);
  });
});

describe("server: web app support", () => {
  it("attachments, raw files, settings, browse, delete and static UI", async () => {
    const { mkdirSync } = await import("node:fs");
    const staticDir = mkdtempSync(join(tmpdir(), "static-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>ui</title>");
    mkdirSync(join(staticDir, "assets"));
    writeFileSync(join(staticDir, "assets", "app.js"), "console.log(1)");
    const proj = mkdtempSync(join(tmpdir(), "srv-web-"));
    mkdirSync(join(proj, "sub"));
    const harness = new Harness({
      providers: { mock: new MockProvider({ handler: () => ({ text: "seen" }) }) },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MODELS,
    });
    const s2 = await startServer({ harness, port: 0, token: "tk", staticDir, allowedRoots: [tmpdir()] });
    try {
      // static UI without auth, SPA fallback, API still protected
      expect(await (await fetch(`${s2.url}/`)).text()).toContain("<title>ui</title>");
      expect(await (await fetch(`${s2.url}/c/some-chat`)).text()).toContain("<title>ui</title>");
      expect((await fetch(`${s2.url}/assets/app.js`)).headers.get("content-type")).toContain("javascript");
      expect((await fetch(`${s2.url}/sessions`)).status).toBe(401);
      expect((await fetch(`${s2.url}/../../etc/passwd`)).status).not.toBe(500);

      const c = createClient({ baseUrl: s2.url, token: "tk" });
      // browse
      const b = await c.browse(proj);
      expect(b.dirs.map((d) => d.name)).toEqual(["sub"]);
      await expect(c.browse("/etc")).rejects.toMatchObject({ status: 403 });

      // attachments → raw
      const info = await c.createSession({ projectPath: proj });
      const done = (async () => {
        for await (const _ of c.events(info.id, { untilDone: true }));
      })();
      await c.send(info.id, "look", {
        attachments: [
          { name: "a.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") },
        ],
      });
      await done;
      const d = await c.getSession(info.id);
      const end = d.events!.find((e) => e.type === "message.end" && e.attachments);
      const path = end && end.type === "message.end" ? end.attachments![0].path : "";
      const raw = await fetch(c.rawUrl(info.id, path));
      expect(await raw.text()).toBe("hello");
      expect((await fetch(c.rawUrl(info.id, "../../etc/passwd"))).status).toBe(403);
      await expect(
        c.send(info.id, "x", {
          attachments: [{ name: "big", mimeType: "x", data: "A".repeat(15 * 1024 * 1024) }],
        }),
      ).rejects.toMatchObject({ status: 400 });

      // settings + title in list
      const updated = await c.updateSettings(info.id, { permissionMode: "auto", title: "Renamed" });
      expect(updated.permissionMode).toBe("auto");
      expect((await c.listSessions()).find((x) => x.id === info.id)?.title).toBe("Renamed");
      await expect(c.updateSettings(info.id, { models: { executor: "nope/x" } })).rejects.toMatchObject({
        status: 400,
      });

      // delete
      await c.deleteSession(info.id);
      expect((await c.listSessions()).some((x) => x.id === info.id)).toBe(false);
      await expect(c.deleteSession(info.id)).rejects.toMatchObject({ status: 404 });
    } finally {
      await s2.close();
    }
  });
});

describe("server: agent control", () => {
  it("records the origin, stops all runs, deletes with cleanup and unloads idle sessions", async () => {
    const proj = mkdtempSync(join(tmpdir(), "srv-control-"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const harness = new Harness({
      providers: {
        mock: new MockProvider({
          handler: async (req) => {
            if (req.messages.at(-1)!.content === "hold") await Promise.race([gate, sleep(5_000)]);
            return { text: "ok" };
          },
        }),
      },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MODELS,
    });
    const s2 = await startServer({ harness, port: 0, token: "tk", unloadIdleMs: 50 });
    try {
      const c = createClient({ baseUrl: s2.url, token: "tk", origin: "desktop" });
      const info = await c.createSession({ projectPath: proj });
      expect(info.origin).toBe("desktop");
      expect((await c.createSession({ projectPath: proj, origin: "web" })).origin).toBe("web");
      await expect(c.createSession({ projectPath: proj, origin: "x" as never })).rejects.toMatchObject({
        status: 400,
      });

      await c.send(info.id, "hold");
      await vi.waitFor(async () =>
        expect((await c.getSession(info.id, { events: false })).status).toBe("running"),
      );
      const running = (await c.listSessions()).find((x) => x.id === info.id)!;
      expect(running.runStartedAt).toBeTruthy();
      await expect(c.deleteSession(info.id)).rejects.toMatchObject({ status: 409 });
      const stopped = await c.cancelAll();
      expect(stopped.cancelled).toEqual([info.id]);
      await vi.waitFor(async () =>
        expect((await c.getSession(info.id, { events: false })).status).toBe("cancelled"),
      );
      release();

      // Idle and unwatched: released from memory, then loaded again on request.
      await vi.waitFor(() => expect(harness.liveSessions().map((x) => x.id)).not.toContain(info.id), {
        timeout: 2_000,
      });
      expect((await c.getSession(info.id, { events: false })).id).toBe(info.id);

      const removed = await c.deleteSession(info.id);
      expect(removed.sessions).toEqual([info.id]);
      expect(removed.folder).toBeUndefined();
      expect(existsSync(proj)).toBe(true);
    } finally {
      release();
      await s2.close();
    }
  });
});

describe("server: uploaded document viewing", () => {
  it("serves PDF attachments inline so the UI can frame them, and lists them as viewable", async () => {
    const proj = mkdtempSync(join(tmpdir(), "srv-pdf-"));
    const harness = new Harness({
      providers: { mock: new MockProvider({ handler: () => ({ text: "seen" }) }) },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MODELS,
    });
    const s2 = await startServer({ harness, port: 0, token: "tk", allowedRoots: [tmpdir()] });
    try {
      const c = createClient({ baseUrl: s2.url, token: "tk" });
      const info = await c.createSession({ projectPath: proj });
      const done = (async () => {
        for await (const _ of c.events(info.id, { untilDone: true }));
      })();
      await c.send(info.id, "summarise", {
        attachments: [
          {
            name: "r.pdf",
            mimeType: "application/pdf",
            data: Buffer.from("%PDF-1.4 test").toString("base64"),
          },
          { name: "n.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") },
        ],
      });
      await done;
      const d = await c.getSession(info.id);
      const end = d.events!.find((e) => e.type === "message.end" && e.attachments);
      const pdf =
        end && end.type === "message.end" ? end.attachments!.find((a) => a.name === "r.pdf")! : undefined;
      expect(pdf?.mimeType).toBe("application/pdf");
      const raw = await fetch(c.rawUrl(info.id, pdf!.path));
      expect(raw.status).toBe(200);
      expect(raw.headers.get("content-type")).toBe("application/pdf");
      expect(raw.headers.get("content-disposition")).toBe("inline");
      expect(raw.headers.get("content-security-policy")).toMatch(
        /^frame-ancestors 'self' http:\/\/127\.0\.0\.1:\*/,
      );
      expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
      // other attachments keep the strict policy
      const txt =
        end && end.type === "message.end" ? end.attachments!.find((a) => a.name === "n.txt")! : undefined;
      const rawTxt = await fetch(c.rawUrl(info.id, txt!.path));
      expect(rawTxt.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(rawTxt.headers.get("content-disposition")).toBeNull();
    } finally {
      await s2.close();
    }
  });
});

describe("server: sandboxes and preview", () => {
  it("returns history snapshots with a cursor and only new public events on refresh", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    const info = await c.createSession({ sandbox: { name: "snapshot" } });
    const session = srv.harness.getSession(info.id);
    session.emit({ type: "usage", inputTokens: 100, outputTokens: 10 });
    session.emit({
      type: "context.append",
      agent: "chat",
      message: { role: "user", content: "internal context" },
    });
    const snapshot = await c.getSession(info.id, { internal: false });
    expect(snapshot.events?.some((e) => e.type === "usage")).toBe(true);
    expect(snapshot.events?.some((e) => e.type === "context.append")).toBe(false);
    expect(snapshot.lastSeq).toBe(session.events.at(-1)!.seq);
    const event = session.emit({ type: "usage", inputTokens: 200, outputTokens: 20 });
    const refresh = await c.getSession(info.id, { after: snapshot.lastSeq, internal: false });
    expect(refresh.events).toEqual([event]);
    expect(refresh.lastSeq).toBe(event.seq);
    for await (const streamed of c.events(info.id, { after: snapshot.lastSeq, reconnect: false })) {
      expect(streamed).toEqual(event);
      break;
    }
    await expect(c.getSession(info.id, { after: -1 })).rejects.toMatchObject({ status: 400 });
  });
  it("confines legacy home sessions to their creations and keeps other sessions separate", async () => {
    const home = mkdtempSync(join(tmpdir(), "legacy-home-"));
    mkdirSync(join(home, "snake-game"));
    writeFileSync(join(home, "snake-game/index.html"), "<script src='game.js'></script>");
    writeFileSync(join(home, "snake-game/game.js"), "console.log('snake')");
    writeFileSync(join(home, "private.txt"), "not part of this job");
    writeFileSync(join(home, ".bash_history"), "private commands");
    writeFileSync(join(home, "notes.txt"), "created by the agent");
    symlinkSync(join(home, "private.txt"), join(home, "snake-game/leak.txt"));
    const harness = new Harness({ skipGlobalConfig: true, loadEnv: false, configOverrides: MODELS });
    // Create the same persisted metadata older terminal sessions used, before HOME changes.
    const legacy = harness.createSession({ projectPath: home });
    legacy.emit({ type: "preview.ready", path: "snake-game/index.html" });
    legacy.emit({
      type: "tool.call",
      id: "write-notes",
      name: "write_file",
      args: { path: "notes.txt", content: "created by the agent" },
    });
    legacy.emit({ type: "tool.result", id: "write-notes", name: "write_file", ok: true, output: "written" });
    vi.stubEnv("HOME", home);
    // Reopen from disk, so scoping does not depend on transient session state.
    const reopened = new Harness({ skipGlobalConfig: true, loadEnv: false, configOverrides: MODELS });
    const server = await startServer({ harness: reopened, port: 0, token: "scope-test" });
    try {
      const c = createClient({ baseUrl: server.url, token: "scope-test" });
      const list = (await c.files(legacy.id)).files;
      expect(list).toEqual(["notes.txt", "snake-game/game.js", "snake-game/index.html"]);
      expect((await c.files(legacy.id, "snake-game")).files).toEqual([
        "snake-game/game.js",
        "snake-game/index.html",
      ]);
      expect((await c.files(legacy.id, "notes.txt")).content).toBe("created by the agent");
      for (const path of ["private.txt", ".bash_history", "snake-game/leak.txt", "../outside.txt"]) {
        await expect(c.files(legacy.id, path)).rejects.toMatchObject({ status: 403 });
        expect((await fetch(c.rawUrl(legacy.id, path))).status).toBe(403);
      }
      const details = await c.getSession(legacy.id);
      expect((await fetch(c.previewUrl(details.previewBase!, "snake-game/game.js"))).status).toBe(200);
      expect((await fetch(c.previewUrl(details.previewBase!, "private.txt"))).status).toBe(403);
      expect((await fetch(c.previewUrl(details.previewBase!, "snake-game/leak.txt"))).status).toBe(403);
      const a = await c.createSession({ sandbox: { name: "a" } });
      const b = await c.createSession({ sandbox: { name: "b" } });
      writeFileSync(join(a.projectPath, "only-a.txt"), "a");
      writeFileSync(join(b.projectPath, "only-b.txt"), "b");
      expect((await c.files(a.id)).files).toContain("only-a.txt");
      expect((await c.files(a.id)).files).not.toContain("only-b.txt");
      await expect(c.files(a.id, join(b.projectPath, "only-b.txt"))).rejects.toMatchObject({ status: 403 });
      // Root-level previews must not grant access to the rest of a home directory.
      writeFileSync(join(home, "root.html"), "root page");
      const stored = reopened.getSession(legacy.id);
      stored.emit({ type: "preview.ready", path: "root.html" });
      expect((await c.files(legacy.id)).files).not.toContain("private.txt");
      expect((await c.files(legacy.id)).files).toContain("root.html");
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });
  it("creates sandbox sessions and serves previews on a signed path", async () => {
    const harness = new Harness({
      providers: {
        mock: new MockProvider({
          replies: [
            {
              toolCalls: [
                {
                  name: "write_file",
                  args: { path: "index.html", content: '<script src="js/app.js"></script>' },
                },
                { name: "write_file", args: { path: "js/app.js", content: "document.title='ok'" } },
                { name: "set_preview", args: { path: "index.html" } },
              ],
            },
            { text: "done" },
          ],
        }),
      },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MODELS,
    });
    const s3 = await startServer({ harness, port: 0, token: "tk3" });
    try {
      const c = createClient({ baseUrl: s3.url, token: "tk3" });
      const info = await c.createSession({ sandbox: { name: "snake" } });
      expect(info.sandbox).toBe(true);
      expect(info.permissionMode).toBe("auto");
      expect(info.projectPath).toContain("sandboxes/snake-");
      const done = (async () => {
        for await (const _ of c.events(info.id, { untilDone: true }));
      })();
      await c.send(info.id, "make it");
      await done;
      const d = await c.getSession(info.id, { events: false });
      expect(d.previewBase).toMatch(new RegExp(`^/preview/${info.id}~[0-9a-f]{24}/$`));
      // no token needed, relative assets resolve
      const page = await fetch(c.previewUrl(d.previewBase, "index.html"));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("js/app.js");
      const asset = await fetch(`${s3.url}${d.previewBase}js/app.js`);
      expect(await asset.text()).toBe("document.title='ok'");
      expect((await fetch(`${s3.url}${d.previewBase}`)).status).toBe(200); // directory → index.html
      // forged signature, .git and escapes are refused
      expect((await fetch(`${s3.url}/preview/${info.id}~000000000000000000000000/index.html`)).status).toBe(
        404,
      );
      expect((await fetch(`${s3.url}${d.previewBase}.git/config`)).status).toBe(404);
      expect((await fetch(`${s3.url}${d.previewBase}..%2F..%2F..%2Fetc%2Fpasswd`)).status).toBe(403);
    } finally {
      await s3.close();
    }
  });
});

describe("goals and session trees over HTTP", () => {
  it("round-trips goal endpoints: create, edit, run, merge, discard, delete", async () => {
    const { spawnSync } = await import("node:child_process");
    const repo = mkdtempSync(join(tmpdir(), "srv-goal-"));
    writeFileSync(join(repo, "README.md"), "x\n");
    const g = (...a: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, encoding: "utf8" });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-qm", "init");
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    await expect(c.createGoal({ title: "", repo })).rejects.toMatchObject({ status: 400 });
    const goal = await c.createGoal({ title: "Write hello", repo, description: "d" });
    expect(goal.status).toBe("draft");
    expect((await c.listGoals({ repo })).map((x) => x.id)).toEqual([goal.id]);
    expect((await c.listGoals()).map((x) => x.id)).toContain(goal.id);
    const edited = await c.updateGoal(goal.id, { description: "write hello.txt", budget: { maxRounds: 2 } });
    expect(edited.description).toBe("write hello.txt");
    expect((await c.getGoal(goal.id)).budget.maxRounds).toBe(2);
    await expect(c.getGoal("goal-nope")).rejects.toMatchObject({ status: 404 });

    const running = await c.runGoal(goal.id);
    expect(running.status).toBe("running");
    expect(running.sessionId).toBeTruthy();
    for (let i = 0; i < 200; i++) {
      if ((await c.getGoal(goal.id)).status !== "running") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const reviewed = await c.getGoal(goal.id);
    expect(reviewed.status).toBe("review");
    expect(reviewed.checkpoints).toBe(1);
    const details = await c.getSession(running.sessionId!);
    expect(details.goalId).toBe(goal.id);
    let state = initialSessionState();
    for (const e of details.events!) state = reduceSession(state, e);
    expect(state.goal).toMatchObject({ goalId: goal.id, status: "finished", result: "success" });
    expect(state.goal?.checkpoints).toHaveLength(1);
    expect(state.goalId).toBe(goal.id);

    const merged = await c.mergeGoal(goal.id);
    expect(merged.status).toBe("done");
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("hi\n");
    await expect(c.discardGoal(goal.id)).rejects.toMatchObject({ status: 409 });
    await expect(c.requestGoalChanges(goal.id, "more")).rejects.toMatchObject({ status: 409 });
    await c.deleteGoal(goal.id);
    await expect(c.getGoal(goal.id)).rejects.toMatchObject({ status: 404 });

    const other = await c.createGoal({ title: "Throwaway", repo });
    expect(await c.pauseGoal(other.id)).toEqual({ wasRunning: false });
    expect((await c.discardGoal(other.id)).status).toBe("discarded");

    // CORS preflight allows PUT
    const pre = await fetch(`${srv.url}/goals/${other.id}`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "PUT" },
    });
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  it("filters sessions by parent and returns a session tree", async () => {
    const c = createClient({ baseUrl: srv.url, token: "test-token" });
    const parent = await c.createSession({ projectPath: project });
    const child = srv.harness.createSession({
      projectPath: project,
      parentSessionId: parent.id,
      title: "child",
    });
    srv.harness.createSession({ projectPath: project, parentSessionId: child.id, title: "grandchild" });
    const children = await c.listSessions({ parent: parent.id });
    expect(children.map((s) => s.id)).toEqual([child.id]);
    expect(children[0].parentSessionId).toBe(parent.id);
    const tree = await c.sessionTree(parent.id);
    expect(tree.session.id).toBe(parent.id);
    expect(tree.children[0].session.id).toBe(child.id);
    expect(tree.children[0].children[0].session.title).toBe("grandchild");
    await expect(c.sessionTree("nope")).rejects.toMatchObject({ status: 404 });
  });
});
