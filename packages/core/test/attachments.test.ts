import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Harness,
  MockProvider,
  OpenAICompatibleProvider,
  collect,
  processAttachments,
  toAnthropicMessages,
  summarize,
} from "@harness/core";
import { MOCK_MODELS, tempProject } from "./helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("attachments", () => {
  it("saves files, inlines text, passes images and references binaries", () => {
    const root = tempProject();
    const r = processAttachments(root, "s1", [
      { name: "shot.png", mimeType: "image/png", data: PNG },
      { name: "notes.md", mimeType: "text/markdown", data: b64("# hi\nthere") },
      { name: "../../evil name.ts", mimeType: "", data: b64("export const x = 1;") },
      { name: "doc.pdf", mimeType: "application/pdf", data: b64("%PDF-1.4\u0000binary") },
    ]);
    expect(r.images).toEqual([{ mimeType: "image/png", data: PNG, name: "shot.png" }]);
    expect(r.infos.map((i) => i.kind)).toEqual(["image", "text", "text", "binary"]);
    expect(r.text).toContain("```md\n# hi\nthere\n```");
    expect(r.text).toContain("export const x = 1;");
    expect(r.text).toContain("doc.pdf");
    for (const i of r.infos) {
      expect(i.path.startsWith(".harness/attachments/s1/")).toBe(true);
      expect(existsSync(join(root, i.path))).toBe(true);
    }
    expect(r.infos[2].path).not.toContain("..");
    expect(readFileSync(join(root, r.infos[1].path), "utf8")).toBe("# hi\nthere");
  });

  it("rejects oversized attachments", () => {
    const big = Buffer.alloc(11 * 1024 * 1024).toString("base64");
    expect(() =>
      processAttachments(tempProject(), "s", [
        { name: "x.bin", mimeType: "application/octet-stream", data: big },
      ]),
    ).toThrow(/10 MB/);
  });

  it("chat sends images to the model and records attachment metadata", async () => {
    const root = tempProject();
    const mock = new MockProvider({ replies: [{ text: "I see a pixel" }] });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s = h.createSession({ projectPath: root });
    await s.chat("what is this?", [{ name: "p.png", mimeType: "image/png", data: PNG }]);
    const user = mock.calls[0].messages[1];
    expect(user.role === "user" && user.images?.[0].mimeType).toBe("image/png");
    expect(user.content).toContain("what is this?");
    const end = s.events.find((e) => e.type === "message.end" && e.attachments);
    expect(end && end.type === "message.end" && end.attachments?.[0]).toMatchObject({
      name: "p.png",
      kind: "image",
    });
  });

  it("OpenAI adapter sends image_url parts and falls back without images when rejected", async () => {
    const bodies: any[] = [];
    const responses = [
      new Response('{"error":{"message":"unknown variant `image_url`, expected `text`"}}', { status: 400 }),
      new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
    ];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return responses.shift()!;
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider({ id: "t", baseURL: "http://x", fetch: fetchFn });
    const r = await collect(
      p.stream({
        model: "m",
        messages: [{ role: "user", content: "look", images: [{ mimeType: "image/png", data: PNG }] }],
      }),
    );
    expect(r.text).toBe("ok");
    expect(bodies[0].messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG}` },
    });
    expect(typeof bodies[1].messages[0].content).toBe("string");
    expect(bodies[1].messages[0].content).toContain("cannot view images");
  });

  it("Anthropic conversion puts image blocks before the text", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "see", images: [{ mimeType: "image/png", data: PNG }] },
    ]);
    expect(messages[0].content.map((c: any) => c.type)).toEqual(["image", "text"]);
    expect(messages[0].content[0].source).toEqual({ type: "base64", media_type: "image/png", data: PNG });
  });
});

describe("session settings, titles and deletion", () => {
  it("records model changes and re-applies them on resume", async () => {
    const root = tempProject();
    const sessionsDir = join(tempProject(), "sessions");
    const a = new MockProvider({ id: "a", replies: [{ text: "from a" }] });
    const b = new MockProvider({ id: "b", replies: [{ text: "from b" }, { text: "from b again" }] });
    const cfg = {
      providers: { a: { type: "mock" as const }, b: { type: "mock" as const } },
      models: { executor: "a/x", planner: "a/x", reviewer: "a/x", summarizer: "a/x" },
    };
    const mk = () =>
      new Harness({
        sessionsDir,
        providers: { a, b },
        skipGlobalConfig: true,
        loadEnv: false,
        configOverrides: cfg as never,
      });
    const s = mk().createSession({ projectPath: root });
    expect((await s.chat("hi")).text).toBe("from a");
    s.updateSettings({ models: { executor: "b/y" }, permissionMode: "auto", title: "My chat" });
    expect((await s.chat("again")).text).toBe("from b");
    expect(() => s.updateSettings({ models: { executor: "nope/z" } })).toThrow(/Unknown provider/);
    const h2 = mk();
    const resumed = h2.getSession(s.id);
    expect(resumed.config.models.executor).toBe("b/y");
    expect(resumed.policy.mode).toBe("auto");
    expect((await resumed.chat("third")).text).toBe("from b again");
    const info = h2.listSessions()[0];
    expect(info).toMatchObject({ title: "My chat", model: "b/y", permissionMode: "auto" });
    h2.deleteSession(s.id);
    expect(h2.listSessions()).toHaveLength(0);
  });

  it("derives a title from the first user message", () => {
    const ev = (type: string, extra: object, seq: number) =>
      ({ v: 1, seq, ts: "2026-01-01T00:00:00Z", sessionId: "x", type, ...extra }) as any;
    const info = summarize("x", [
      ev("session.created", { projectPath: "/p", workflow: "default" }, 1),
      ev("message.start", { id: "m1", role: "user" }, 2),
      ev("message.end", { id: "m1", text: "Fix   the\nlogin bug" }, 3),
    ]);
    expect(info.title).toBe("Fix the login bug");
  });
});
