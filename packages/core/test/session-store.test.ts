import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, rebuildMessages } from "@harness/core";
import type { ChatMessage, HarnessEvent } from "@harness/protocol";

describe("shared session log tailing", () => {
  it("waits for a complete UTF-8 record and never repeats an already consumed event", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "session-tail-")));
    const record = (seq: number, text: string) => ({
      v: 1,
      sessionId: "shared",
      seq,
      ts: new Date().toISOString(),
      type: "message.delta",
      id: "msg",
      text,
    });
    const first = record(1, "hello");
    appendFileSync(store.path("shared"), JSON.stringify(first) + "\n");
    const initial = store.readAfter("shared", 0, 0);
    expect(initial.events).toEqual([first]);
    const second = record(2, "Ready 🌅");
    const bytes = Buffer.from(JSON.stringify(second) + "\n");
    const split = bytes.indexOf(Buffer.from("🌅")) + 2;
    appendFileSync(store.path("shared"), bytes.subarray(0, split));
    expect(store.readAfter("shared", initial.offset, 1)).toEqual({ events: [], offset: initial.offset });
    appendFileSync(store.path("shared"), bytes.subarray(split));
    const next = store.readAfter("shared", initial.offset, 1);
    expect(next.events).toEqual([second]);
    expect(store.readAfter("shared", next.offset, 2)).toEqual({ events: [], offset: next.offset });
  });
});

describe("rebuildMessages tool turns", () => {
  const log = (messages: ChatMessage[]) =>
    messages.map((message, seq) => ({
      seq,
      type: "context.append",
      agent: "chat",
      message,
    })) as HarnessEvent[];
  const call = (id: string, name = "read_file") => ({ id, name, arguments: "{}" });
  const result = (id: string): ChatMessage => ({
    role: "tool",
    toolCallId: id,
    name: "read_file",
    content: "ok",
  });
  const assistant = (...ids: string[]): ChatMessage => ({
    role: "assistant",
    content: "",
    toolCalls: ids.map((id) => call(id)),
  });
  const user: ChatMessage = { role: "user", content: "continue" };

  it("answers a call left unanswered before later complete turns", () => {
    const rebuilt = rebuildMessages(log([assistant("a"), user, assistant("b"), result("b")]), "chat");
    expect(rebuilt.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant", "tool"]);
    expect(rebuilt[1]).toMatchObject({ toolCallId: "a", content: expect.stringContaining("interrupted") });
    expect(rebuilt[4]).toEqual(result("b"));
  });

  it("keeps what a partly answered turn finished and the messages after it", () => {
    const rebuilt = rebuildMessages(log([assistant("a", "b"), result("b"), user]), "chat");
    expect(rebuilt.map((m) => (m.role === "tool" ? m.toolCallId : m.role))).toEqual([
      "assistant",
      "a",
      "b",
      "user",
    ]);
    expect(rebuilt[2]).toEqual(result("b"));
    expect(rebuilt[1]).toMatchObject({ content: expect.stringContaining("interrupted") });
  });

  it("drops a result whose call is gone and leaves valid history unchanged", () => {
    const valid = [assistant("a"), result("a"), user];
    expect(rebuildMessages(log(valid), "chat")).toEqual(valid);
    expect(rebuildMessages(log([result("x"), user]), "chat")).toEqual([user]);
  });
});
