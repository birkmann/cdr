import { describe, expect, it } from "vitest";
import type { ChatMessage, HarnessEvent } from "@harness/protocol";
import { Harness, MockProvider, rebuildMessages } from "@harness/core";
import { initialSessionState, reduceSession } from "@harness/client";
import { MOCK_MODELS, tempProject } from "./helpers";

/** Replies "re: <last user text>"; "use a tool" first reads a file, then answers. */
function setup() {
  const mock = new MockProvider({
    handler: (req) => {
      const last = req.messages[req.messages.length - 1];
      if (last.role === "tool") return { text: "read it" };
      const text = String(last.content).split("\n\n").pop()!;
      if (text === "use a tool") return { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] };
      return { text: `re: ${text}` };
    },
  });
  const h = new Harness({
    providers: { mock },
    skipGlobalConfig: true,
    loadEnv: false,
    configOverrides: { ...MOCK_MODELS, checkpoints: { enabled: false } },
  });
  return { h, mock, root: tempProject({ "a.txt": "hello" }) };
}

const userIds = (events: HarnessEvent[]) =>
  events.flatMap((e) => (e.type === "message.start" && e.role === "user" ? [e.id] : []));
const contents = (messages: ChatMessage[]) => messages.map((m) => `${m.role}:${m.content}`);
const view = (events: HarnessEvent[]) => events.reduce(reduceSession, initialSessionState());
const texts = (events: HarnessEvent[]) => {
  const s = view(events);
  return s.timeline.flatMap((i) => (i.kind === "message" ? [s.messages[i.id].text] : []));
};

describe("editing a conversation", () => {
  it("deletes a user message with its whole exchange from the transcript and the model's context", async () => {
    const { h, mock, root } = setup();
    const s = h.createSession({ projectPath: root });
    await s.chat("first");
    await s.chat("use a tool");
    await s.chat("third");
    const [first, second] = userIds(s.events);
    expect(Object.keys(view(s.events).tools)).toHaveLength(1);

    expect(s.deleteMessage(second).ids.length).toBe(3); // the message, the tool-call turn, the answer
    expect(texts(s.events)).toEqual(["first", "re: first", "third", "re: third"]);
    expect(view(s.events).tools).toEqual({});
    const context = rebuildMessages(s.events, "chat");
    expect(context[0].role).toBe("system");
    expect(contents(context.slice(1))).toEqual([
      "user:first",
      "assistant:re: first",
      "user:third",
      "assistant:re: third",
    ]);

    // The model no longer sees it, and the title still comes from the first message.
    await s.chat("fourth");
    const sent = mock.calls[mock.calls.length - 1].messages;
    expect(sent.some((m) => m.content === "use a tool" || m.role === "tool")).toBe(false);
    expect(s.info().title).toBe("first");

    s.deleteMessage(first);
    expect(s.info().title).toBe("third");
    expect(() => s.deleteMessage(first)).toThrow("already deleted");
  });

  it("deletes an assistant reply but keeps the question", async () => {
    const { h, root } = setup();
    const s = h.createSession({ projectPath: root });
    await s.chat("first");
    await s.chat("second");
    const reply = view(s.events).timeline.find(
      (i) => i.kind === "message" && view(s.events).messages[i.id].text === "re: first",
    )!;
    s.deleteMessage((reply as { id: string }).id);
    expect(texts(s.events)).toEqual(["first", "second", "re: second"]);
    expect(contents(rebuildMessages(s.events, "chat").slice(1))).toEqual([
      "user:first",
      "user:second",
      "assistant:re: second",
    ]);
  });

  it("duplicates, branches and merges a branch back into its origin", async () => {
    const { h, root } = setup();
    const a = h.createSession({ projectPath: root });
    await a.chat("first");
    await a.chat("second");
    const [first] = userIds(a.events);

    const copy = h.forkSession(a.id);
    expect(texts(copy.events)).toEqual(texts(a.events));
    expect(copy.info()).toMatchObject({ title: "first (copy)", forkedFrom: { sessionId: a.id } });

    const b = h.forkSession(a.id, { messageId: first });
    expect(texts(b.events)).toEqual(["first", "re: first"]);
    expect(b.info()).toMatchObject({
      title: "first (branch)",
      status: "idle",
      forkedFrom: { sessionId: a.id, messageId: first },
    });
    await b.chat("alternative");
    expect(contents(rebuildMessages(b.events, "chat").slice(1))).toEqual([
      "user:first",
      "assistant:re: first",
      "user:alternative",
      "assistant:re: alternative",
    ]);

    expect(h.mergeBranch(b.id)).toMatchObject({ target: a, messages: 2 });
    expect(texts(a.events)).toEqual([
      "first",
      "re: first",
      "second",
      "re: second",
      "alternative",
      "re: alternative",
    ]);
    expect(view(a.events).timeline.some((i) => i.kind === "event" && i.event.type === "branch.merged")).toBe(
      true,
    );
    const merged = rebuildMessages(a.events, "chat");
    expect(merged.filter((m) => m.role === "system")).toHaveLength(1);
    expect(merged.at(-2)?.content).toMatch(/branch of this conversation .*\n\nalternative$/);
    expect(() => h.mergeBranch(b.id)).toThrow("no new messages");

    // A later merge brings only what was added since; a message deleted in the branch stays out.
    await b.chat("more");
    await b.chat("scrap this");
    b.deleteMessage(userIds(b.events).at(-1)!);
    expect(h.mergeBranch(b.id).messages).toBe(2);
    expect(texts(a.events).slice(-2)).toEqual(["more", "re: more"]);

    expect(() => h.mergeBranch(a.id)).toThrow("not a branch");
    expect(() => h.forkSession(a.id, { messageId: "msg_nope" })).toThrow("No message");
  });
});
