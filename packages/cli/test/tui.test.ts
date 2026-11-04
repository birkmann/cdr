import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness, MockProvider } from "@harness/core";
import { initialSessionState } from "@harness/client";
import {
  TerminalApp,
  Editor,
  InputDecoder,
  renderView,
  transcript,
  width,
  type View,
} from "@harness/cli/tui";

const models = { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" };
const apps: TerminalApp[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.key("", { name: "d", ctrl: true });
});

function setup(provider = new MockProvider({ handler: () => ({ text: "Hello from CDR." }) })) {
  const root = mkdtempSync(join(tmpdir(), "morrow-tui-"));
  const harness = new Harness({
    providers: { mock: provider },
    sessionsDir: join(root, ".sessions"),
    skipGlobalConfig: true,
    loadEnv: false,
    configOverrides: { providers: { mock: { type: "mock" } }, models, verify: { maxAttempts: 1 } },
  });
  const session = harness.createSession({ projectPath: root });
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
      return this;
    },
  });
  let outputText = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _, cb) {
        outputText += chunk.toString();
        cb();
      },
    }),
    { isTTY: true, columns: 120, rows: 38 },
  );
  const app = new TerminalApp(harness, session, {
    version: "test",
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });
  apps.push(app);
  const result = app.run();
  const send = (text: string) => {
    app.editor.set(text);
    app.key("\r", { name: "return", sequence: "\r" });
  };
  return {
    app,
    result,
    send,
    root,
    session,
    harness,
    provider,
    input,
    output,
    get outputText() {
      return outputText;
    },
  };
}

function view(): View {
  return {
    state: initialSessionState(),
    editor: new Editor(),
    project: "/tmp/project",
    branch: "main",
    model: "deepseek/deepseek-flash",
    permission: "ask",
    mode: "Chat",
    version: "test",
    sessionId: "test",
    busy: false,
    elapsed: 0,
    frame: 0,
    scroll: 0,
    expanded: false,
    sidebar: true,
    attachments: [],
  };
}

describe("terminal input and rendering", () => {
  it("animates live thoughts before the first chunk and stops for completed or cancelled messages", () => {
    const v = view();
    v.state.status = "running";
    v.state.messages.a = { id: "a", role: "assistant", text: "", streaming: true };
    v.state.timeline = [{ kind: "message", id: "a" }];
    const frame = (n: number, expanded = false) =>
      transcript(v.state, 72, expanded, { frame: n, elapsed: 35 });
    const first = frame(0),
      next = frame(3);
    expect(first.map((r) => r.text).join("\n")).toContain("Thinking");
    expect(first).not.toEqual(next);
    expect(first).toHaveLength(next.length);
    expect(first.find((r) => r.text.includes("Thinking"))?.style?.bold).toBe(true);
    v.state.messages.a.reasoning = "Checking the project before making changes.";
    expect(
      frame(0, true)
        .map((r) => r.text)
        .join("\n"),
    ).toContain("Checking the project");
    expect(frame(0, true)).not.toEqual(frame(3, true));
    v.state.messages.a.text = "Here is the answer.";
    expect(frame(0)).toEqual(frame(3));
    v.state.messages.a.text = "";
    v.state.status = "cancelled";
    expect(frame(0)).toEqual(frame(3));
    expect(
      frame(0)
        .map((r) => r.text)
        .join("\n"),
    ).not.toContain("Thinking");
    v.state.status = "running";
    v.state.messages.a.streaming = false;
    expect(frame(0)).toEqual(frame(3));
  });
  it("edits graphemes and preserves multiline indentation", () => {
    const e = new Editor();
    e.set("a界👩‍💻é");
    e.remove();
    expect(e.text).toBe("a界👩‍💻");
    e.move(-1);
    e.remove();
    expect(e.text).toBe("a👩‍💻");
    e.set("one\n  two");
    e.boundary(false);
    expect(e.cursor).toBe(4);
    e.insert(" ");
    expect(e.text).toBe("one\n   two");
    const layout = e.layout(5);
    expect(layout.lines).toEqual(["one", "   tw", "o"]);
    expect(width("a界👩‍💻é")).toBe(6);
  });

  it("moves across a leading empty line without wrapping to the last line", () => {
    const e = new Editor();
    e.set("\nsecond\nthird");
    e.cursor = 0;
    expect(e.vertical(-1)).toBe(false);
    expect(e.cursor).toBe(0);
    expect(e.vertical(1)).toBe(true);
    expect(e.cursor).toBe(1);
    expect(e.vertical(-1)).toBe(true);
    expect(e.cursor).toBe(0);
  });

  it("does not execute multiline bracketed paste, even across chunk boundaries", () => {
    const keys: string[] = [],
      pasted: string[] = [];
    const decoder = new InputDecoder(
      (text) => keys.push(text),
      (text) => pasted.push(text),
    );
    decoder.feed("\x1b[20");
    decoder.feed("0~/exit\r\nsecond line\x1b[20");
    decoder.feed("1~");
    expect(keys).toEqual([]);
    expect(pasted).toEqual(["/exit\nsecond line"]);
    decoder.feed("x");
    expect(keys).toEqual(["x"]);
    decoder.close();
  });

  it.each([
    [160, 48],
    [80, 24],
    [40, 14],
    [30, 10],
  ])("fits the full screen at %i × %i", (columns, rows) => {
    const v = view();
    v.editor.set("a long draft with 界 and emoji 👩‍💻\n  indented next line");
    const c = renderView(v, columns, rows);
    expect(c.plain()).toHaveLength(rows);
    for (const row of c.plain()) expect(width(row)).toBe(columns);
    if (c.cursor) {
      expect(c.cursor.x).toBeLessThan(columns);
      expect(c.cursor.y).toBeLessThan(rows);
      expect(c.cursor.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("shows all approval choices on a narrow terminal and strips terminal control sequences", () => {
    const v = view();
    v.dialog = {
      title: "Review",
      body: "\x1b]52;c;evil\x07safe\x1b[2J",
      actions: ["Approve", "Feedback", "Edit", "Reject"],
      selected: 3,
      scroll: 0,
    };
    const c = renderView(v, 40, 24),
      text = c.plain().join("\n");
    for (const label of v.dialog.actions) expect(text).toContain(label);
    expect(text).toContain("safe");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("\x1b");
  });
});

describe("full-screen session integration", () => {
  it("continues a failed job with /continue in the same session", async () => {
    let fail = true;
    const x = setup(
      new MockProvider({
        handler: () => {
          if (fail) throw new Error("Temporary provider failure");
          return { text: "Recovered the original request." };
        },
      }),
    );
    x.send("Finish the timer");
    await vi.waitFor(() => expect(x.app.state.status).toBe("failed"));
    fail = false;
    const id = x.session.id;
    x.send("/continue");
    await vi.waitFor(() => expect(x.app.state.done?.status).toBe("success"));
    expect(x.app.snapshot().sessionId).toBe(id);
    expect(x.provider.calls[1].messages.some((m) => m.content === "Finish the timer")).toBe(true);
    expect(x.app.state.errors).toEqual([]);
  });
  it("pauses the displayed timer during approval and preserves elapsed work after resuming", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const x = setup(
        new MockProvider({
          handler: (req) => {
            if (req.messages.at(-1)?.role === "user") {
              now += 2500;
              return { toolCalls: [{ name: "write_file", args: { path: "timed.txt", content: "ok" } }] };
            }
            now += 1000;
            return { text: "Done." };
          },
        }),
      );
      x.send("write");
      await vi.waitFor(() => expect(x.app.snapshot().dialog).toBeDefined());
      expect(x.app.snapshot().elapsed).toBe(2);
      now += 2 * 60 * 60_000;
      expect(x.app.snapshot().elapsed).toBe(2);
      expect(renderView(x.app.snapshot(), 120, 38).plain().join("\n")).toContain("Waiting for you");
      x.input.write("y");
      await vi.waitFor(() => expect(x.app.snapshot().busy).toBe(false));
      expect(x.app.state.done?.status).toBe("success");
      expect(x.app.snapshot().elapsed).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });
  it.each([
    ["CSI", "\x1b[D", "\x1b[C"],
    ["application cursor", "\x1bOD", "\x1bOC"],
  ])("navigates approvals with real %s arrow sequences and confirms with Enter", async (_, left, right) => {
    const x = setup(
      new MockProvider({
        replies: [
          { toolCalls: [{ name: "write_file", args: { path: "arrow.txt", content: "approved" } }] },
          { text: "Done." },
        ],
      }),
    );
    x.send("write the file");
    await vi.waitFor(() => expect(x.app.snapshot().dialog?.selected).toBe(2));
    x.input.write(left);
    expect(x.app.snapshot().dialog?.selected).toBe(1);
    x.input.write(right);
    expect(x.app.snapshot().dialog?.selected).toBe(2);
    // Escape sequences can arrive split across input chunks.
    x.input.write(right.slice(0, 2));
    x.input.write(right.slice(2));
    expect(x.app.snapshot().dialog?.selected).toBe(0);
    x.input.write("\x1b[Z");
    expect(x.app.snapshot().dialog?.selected).toBe(2);
    x.input.write("\t");
    expect(x.app.snapshot().dialog?.selected).toBe(0);
    x.input.write("\x1b[A");
    expect(x.app.snapshot().dialog?.selected).toBe(2);
    x.input.write("\x1b[B");
    expect(x.app.snapshot().dialog?.selected).toBe(0);
    expect(existsSync(join(x.root, "arrow.txt"))).toBe(false);
    expect(x.app.snapshot().notice || "").not.toContain("Cannot read");
    x.input.write("\r");
    await vi.waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    expect(readFileSync(join(x.root, "arrow.txt"), "utf8")).toBe("approved");
  });

  it.each([
    ["1", "allow"],
    ["2", "always"],
    ["3", "deny"],
  ])("accepts permission shortcut %s", async (key, decision) => {
    const x = setup(
      new MockProvider({
        replies: [
          { toolCalls: [{ name: "write_file", args: { path: "choice.txt", content: "approved" } }] },
          { text: "Done." },
        ],
      }),
    );
    x.send("write");
    await vi.waitFor(() => expect(x.app.snapshot().dialog).toBeDefined());
    x.input.write(key);
    await vi.waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    expect(x.session.events.some((e) => e.type === "permission.resolved" && e.decision === decision)).toBe(
      true,
    );
    expect(existsSync(join(x.root, "choice.txt"))).toBe(decision !== "deny");
  });
  it("repaints thinking on the timer without receiving new provider events", async () => {
    let release!: (reply: { text: string }) => void;
    const reply = new Promise<{ text: string }>((resolve) => {
      release = resolve;
    });
    const x = setup(new MockProvider({ handler: () => reply }));
    try {
      x.send("think about this");
      await vi.waitFor(() => expect(x.outputText).toContain("Thinking"));
      const first = x.app.snapshot();
      const outputLength = x.outputText.length;
      await vi.waitFor(() => expect(x.app.snapshot().frame).toBeGreaterThan(first.frame + 2));
      expect(x.app.state.lastSeq).toBe(first.state.lastSeq);
      expect(x.outputText.slice(outputLength)).toContain("Thinking");
    } finally {
      release({ text: "Ready." });
    }
    await vi.waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    const frame = x.app.snapshot().frame;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(x.app.snapshot().frame).toBeLessThanOrEqual(frame + 1);
  });
  it("streams a response from session events and restores terminal modes on exit", async () => {
    const x = setup();
    expect(x.input.isRaw).toBe(true);
    expect(x.outputText).toContain("\x1b[?1049h");
    x.send("hello");
    await vi.waitFor(() => expect(x.app.snapshot().state.done?.status).toBe("success"));
    expect(Object.values(x.app.state.messages).some((m) => m.text === "Hello from CDR.")).toBe(true);
    x.app.key("", { name: "d", ctrl: true });
    expect(await x.result).toBe(0);
    expect(x.input.isRaw).toBe(false);
    expect(x.outputText).toContain("\x1b[?2004l");
    expect(x.outputText).toContain("\x1b[?1049l");
    expect(x.input.listenerCount("data")).toBe(0);
  });

  it("offers real model selection without losing a draft", async () => {
    const x = setup();
    x.app.editor.set("Keep this draft");
    x.app.key("", { name: "o", ctrl: true });
    const p = x.app.snapshot().picker!;
    expect(p.title).toBe("Choose a model");
    x.app.key("mock/new", { sequence: "mock/new" });
    x.app.key("\r", { name: "return" });
    await vi.waitFor(() => expect(x.session.config.models.executor).toBe("mock/new"));
    expect(x.app.editor.text).toBe("Keep this draft");
    expect(
      x.session.events.some((e) => e.type === "session.settings" && e.models?.executor === "mock/new"),
    ).toBe(true);
  });

  it("supports Ctrl+J and pasted code without submitting it", () => {
    const x = setup();
    x.app.key("line one", {});
    x.app.key("\n", { name: "enter", sequence: "\n" });
    x.app.key("  line two", {});
    expect(x.app.editor.text).toBe("line one\n  line two");
    expect(x.provider.calls).toHaveLength(0);
    x.input.write("\x1b[200~\n/exit\n\x1b[201~");
    expect(x.app.editor.text).toContain("\n/exit\n");
    expect(x.provider.calls).toHaveLength(0);
  });

  it("denies a tool without changing files, and approves the next request", async () => {
    const x = setup(
      new MockProvider({
        handler: (req) =>
          req.messages.at(-1)!.role === "user"
            ? { toolCalls: [{ name: "write_file", args: { path: "result.txt", content: "approved" } }] }
            : { text: "Done." },
      }),
    );
    x.send("write it");
    await vi.waitFor(() => expect(x.app.snapshot().dialog?.title).toContain("Permission required"));
    x.app.key("n", { name: "n" });
    await vi.waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    expect(existsSync(join(x.root, "result.txt"))).toBe(false);
    x.send("write it again");
    await vi.waitFor(() => expect(x.app.snapshot().dialog?.title).toContain("Permission required"));
    x.app.key("y", { name: "y" });
    await vi.waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    expect(readFileSync(join(x.root, "result.txt"), "utf8")).toBe("approved");
  });

  it("cancels a waiting request and returns to the composer", async () => {
    const x = setup(
      new MockProvider({
        replies: [{ toolCalls: [{ name: "write_file", args: { path: "no.txt", content: "no" } }] }],
      }),
    );
    x.send("write");
    await vi.waitFor(() => expect(x.app.snapshot().dialog).toBeDefined());
    x.app.key("", { name: "c", ctrl: true });
    await vi.waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    expect(x.app.state.done?.status).toBe("cancelled");
    expect(x.app.snapshot().dialog).toBeUndefined();
    expect(existsSync(join(x.root, "no.txt"))).toBe(false);
    expect(x.input.isRaw).toBe(true);
  });

  it("edits and approves a workflow plan inside the terminal", async () => {
    const x = setup(
      new MockProvider({
        handler: (req) => {
          const system = req.messages[0].content;
          if (system.startsWith("You are the PLANNER"))
            return { text: "# Plan\n## Steps\n1. Create greeting" };
          if (system.includes("REVIEWER")) return { text: '{"summary":"Looks good","findings":[]}' };
          return { text: "Implemented." };
        },
      }),
    );
    x.send("/run create a greeting");
    await vi.waitFor(() => expect(x.app.snapshot().dialog?.title).toBe("Review the plan"));
    x.input.write("\x1b[D");
    x.input.write("\r");
    expect(x.app.snapshot().dialog?.title).toBe("Edit plan before approval");
    x.app.snapshot().dialog!.editor!.set("# Revised plan\n## Steps\n1. Explain a greeting");
    x.app.key("", { name: "s", ctrl: true });
    await vi.waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    expect(
      x.session.events.some(
        (e) => e.type === "plan.decision" && e.decision === "edit" && e.markdown?.includes("Revised plan"),
      ),
    ).toBe(true);
    expect(x.app.state.done?.status).toBe("success");
  });

  it("switches sessions from the picker and replays their transcript", async () => {
    const x = setup();
    x.send("Remember this conversation");
    await vi.waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    const original = x.session.id;
    x.send("/new");
    await vi.waitFor(() => expect(x.app.snapshot().sessionId).not.toBe(original));
    expect(Object.values(x.app.state.messages)).toHaveLength(0);
    x.app.key("", { name: "r", ctrl: true });
    x.app.key("Remember this conversation", {});
    x.app.key("\r", { name: "return" });
    await vi.waitFor(() => expect(x.app.snapshot().sessionId).toBe(original));
    expect(Object.values(x.app.state.messages).some((m) => m.text === "Hello from CDR.")).toBe(true);
  });

  it("submits question answers through the full-screen dialog", async () => {
    const x = setup(
      new MockProvider({
        handler: (req) =>
          req.messages.at(-1)!.role === "user"
            ? {
                toolCalls: [
                  { name: "ask_user", args: { question: "Which color?", options: ["Blue", "Green"] } },
                ],
              }
            : { text: "Thanks." },
      }),
    );
    x.send("Choose");
    await vi.waitFor(() => expect(x.app.snapshot().dialog?.title).toBe("CDR needs your input"));
    x.app.key("2", { name: "2" });
    x.app.key("\r", { name: "return" });
    await vi.waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    expect(x.session.events.some((e) => e.type === "question.answered" && e.answer === "Green")).toBe(true);
  });
});
