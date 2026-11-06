import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@harness/protocol";
import { Harness, MockProvider } from "@harness/core";
import { parseRecreateRequest, startServer, type StartedServer } from "@harness/server";
import { createClient } from "@harness/client";

const MODELS = {
  providers: { mock: { type: "mock" } },
  models: { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" },
} as never;

let srv: StartedServer;
let project: string;
const TOKEN = "recreate-token";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), "srv-recreate-"));
  writeFileSync(join(project, "README.md"), "x\n");
  const harness = new Harness({
    providers: { mock: new MockProvider({ replies: [{ text: "ok" }] }) },
    skipGlobalConfig: true,
    loadEnv: false,
    configOverrides: MODELS,
  });
  srv = await startServer({ harness, port: 0, token: TOKEN, keepAliveMs: 200 });
});
afterAll(async () => {
  await srv?.close();
});

const post = (id: string, body: unknown) =>
  fetch(`${srv.url}/sessions/${id}/recreate`, {
    method: "POST",
    headers: auth,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /sessions/:id/recreate", () => {
  it("validates the request body", async () => {
    expect(parseRecreateRequest({ url: "https://example.com", widths: [390, 1440], to: ["react"] })).toEqual({
      url: "https://example.com/",
      widths: [390, 1440],
      to: ["react-vite"],
    });
    const c = createClient({ baseUrl: srv.url, token: TOKEN });
    const info = await c.createSession({ projectPath: project });
    const bad: [unknown, RegExp][] = [
      ["not json", /invalid JSON/],
      [{}, /url is required/],
      [{ url: 42 }, /url is required/],
      [{ url: "not a url" }, /valid URL/],
      [{ url: "ftp://example.com" }, /http/],
      [{ url: "https://example.com", widths: [100] }, /320 and 2560/],
      [{ url: "https://example.com", widths: [390.5] }, /integers/],
      [{ url: "https://example.com", widths: "390" }, /widths/],
      [{ url: "https://example.com", to: [3] }, /to must be/],
      [{ url: "https://example.com", to: ["pdf"] }, /unknown target/],
      [{ url: "https://example.com", style: "sass" }, /style/],
      [{ url: "https://example.com", from: "build" }, /from needs run/],
      [{ url: "https://example.com", run: "../x" }, /run id/],
      [{ url: "https://example.com", out: "../escape" }, /relative folder inside the project/],
      [{ url: "https://example.com", out: "/tmp/escape" }, /relative folder inside the project/],
      [{ url: "https://example.com", out: "site/../../x" }, /relative folder inside the project/],
      [{ url: "https://example.com", out: ".git/hooks" }, /relative folder inside the project/],
    ];
    for (const [body, message] of bad) {
      const r = await post(info.id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(message);
    }
    expect((await post("nope", { url: "https://example.com" })).status).toBe(404);
    const unauth = await fetch(`${srv.url}/sessions/${info.id}/recreate`, {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(unauth.status).toBe(401);
  });

  it("starts a run in the background, asks for consent and rejects a second run", async () => {
    const c = createClient({ baseUrl: srv.url, token: TOKEN });
    const info = await c.createSession({ projectPath: project, permissionMode: "ask" });
    const s = srv.harness.getSession(info.id);
    const seen: HarnessEvent[] = [];
    let onRequest: (e: HarnessEvent) => void = () => undefined;
    const requested = new Promise<HarnessEvent>((r) => (onRequest = r));
    const unsubscribe = s.subscribe((e) => {
      seen.push(e);
      if (e.type === "permission.request" && e.tool === "recreate_capture") onRequest(e);
    });
    try {
      const r = await post(info.id, { url: "http://192.0.2.1/", widths: [390] });
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ ok: true });
      const req = (await requested) as Extract<HarnessEvent, { type: "permission.request" }>;
      expect(req.risk).toBe("high");
      // one run per session
      expect((await post(info.id, { url: "https://example.com" })).status).toBe(409);
      // the existing permission endpoint answers the consent; denying ends the run without capturing anything
      await c.answerPermission(info.id, req.id, "deny");
      for (let i = 0; i < 100 && !seen.some((e) => e.type === "done"); i++)
        await new Promise((res) => setTimeout(res, 20));
      const done = seen.find((e) => e.type === "done") as Extract<HarnessEvent, { type: "done" }>;
      expect(done).toBeTruthy();
      expect(done.status).not.toBe("success");
      // the run is over: a new one may start
      for (let i = 0; i < 50; i++) {
        const again = await post(info.id, { url: "http://192.0.2.1/" });
        if (again.status === 202) break;
        await new Promise((res) => setTimeout(res, 20));
        if (i === 49) throw new Error(`second run refused: ${again.status}`);
      }
      const pending = () => s.pendingRequests().find((p) => p.type === "permission.request");
      for (let i = 0; i < 100 && !pending(); i++) await new Promise((res) => setTimeout(res, 20));
      const second = pending();
      if (second) await c.answerPermission(info.id, (second as { id: string }).id, "deny");
    } finally {
      unsubscribe();
    }
  });

  it("is refused when recreate is disabled in the config", async () => {
    const harness = new Harness({
      providers: { mock: new MockProvider({ replies: [{ text: "ok" }] }) },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: { ...(MODELS as object), recreate: { enabled: false } } as never,
    });
    const off = await startServer({ harness, port: 0, token: TOKEN });
    try {
      const c = createClient({ baseUrl: off.url, token: TOKEN });
      const info = await c.createSession({ projectPath: project });
      const r = await fetch(`${off.url}/sessions/${info.id}/recreate`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ url: "https://example.com" }),
      });
      expect(r.status).toBe(403);
      const details = (await c.getSession(info.id, { events: false })) as { recreateEnabled?: boolean };
      expect(details.recreateEnabled).toBe(false);
    } finally {
      await off.close();
    }
  });
});

describe("recreate run folders on the preview path", () => {
  it("serves this session's run files read-only with content types, and nothing else", async () => {
    const c = createClient({ baseUrl: srv.url, token: TOKEN });
    const info = await c.createSession({ projectPath: project });
    const s = srv.harness.getSession(info.id);
    const runId = "20260101-000000-example-abc";
    const dir = join(project, ".harness", "recreate", runId);
    for (const d of ["compare", "out/static", "measure/static/390"])
      mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(
      join(dir, "compare/index.html"),
      '<!doctype html><img src="../measure/static/390/live.png">',
    );
    writeFileSync(join(dir, "out/static/index.html"), "<!doctype html><h1>out</h1>");
    writeFileSync(join(dir, "out/static/styles.css"), "h1{color:red}");
    writeFileSync(join(dir, "measure/static/390/live.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, "manifest.json"), "{}");
    writeFileSync(join(dir, "font.woff2"), "wOF2");
    writeFileSync(join(project, ".harness", "secret.txt"), "nope");
    const otherRun = "20260101-000000-other-xyz";
    mkdirSync(join(project, ".harness", "recreate", otherRun), { recursive: true });
    writeFileSync(join(project, ".harness", "recreate", otherRun, "manifest.json"), "{}");

    const d = await c.getSession(info.id, { events: false });
    expect((d as { recreateEnabled?: boolean }).recreateEnabled).toBe(true);
    const url = (path: string) => `${srv.url}${d.previewBase}${path}`;
    // unknown to this session until it has started the run
    expect((await fetch(url(`.harness/recreate/${runId}/compare/index.html`))).status).toBe(404);
    s.emit({
      type: "recreate.started",
      runId,
      url: "https://example.com/",
      widths: [390],
      targets: ["static"],
      dir: `.harness/recreate/${runId}`,
    });
    const types: Record<string, string> = {
      "compare/index.html": "text/html",
      "compare/": "text/html",
      "out/static": "text/html",
      "out/static/styles.css": "text/css",
      "measure/static/390/live.png": "image/png",
      "manifest.json": "application/json",
      "font.woff2": "font/woff2",
    };
    for (const [path, type] of Object.entries(types)) {
      const r = await fetch(url(`.harness/recreate/${runId}/${path}`));
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type"), path).toContain(type);
      // opened top-level (a new tab), the page still gets an opaque origin: no access to the app's storage
      expect(r.headers.get("content-security-policy"), path).toBe(
        "sandbox allow-scripts allow-popups allow-forms",
      );
    }
    const page = await (await fetch(url(`.harness/recreate/${runId}/compare/index.html`))).text();
    expect(page).toContain("../measure/static/390/live.png");
    // no traversal out of the run folder, no other runs, no other .harness files, no forged key
    for (const path of [
      `.harness/recreate/${runId}/..%2Fsecret.txt`,
      `.harness/recreate/${runId}/..%2F..%2Fsecret.txt`,
      `.harness/recreate/${runId}/..%2F..%2F..%2FREADME.md`,
    ])
      expect([403, 404], path).toContain((await fetch(url(path))).status);
    expect((await fetch(url(`.harness/recreate/${otherRun}/manifest.json`))).status).toBe(404);
    expect((await fetch(url(`.harness/recreate/..%2Fsecret.txt/x`))).status).toBe(404);
    expect((await fetch(url(".harness/secret.txt"))).status).toBe(404);
    expect((await fetch(url(`.harness/recreate/${runId}/missing.png`))).status).toBe(404);
    expect(
      (
        await fetch(
          `${srv.url}/preview/${info.id}~000000000000000000000000/.harness/recreate/${runId}/manifest.json`,
        )
      ).status,
    ).toBe(404);
  });
});
