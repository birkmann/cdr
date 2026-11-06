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
  formatBalance,
  transcript,
  contentWidth,
  BANNER_ROWS,
  Canvas,
  loadDesign,
  width,
  type View,
} from "@harness/cli/tui";

/** The full suite runs dozens of forks in parallel; a turn can take a second or two under load. */
const waitFor = (assert: () => void) => vi.waitFor(assert, { timeout: 15_000, interval: 25 });

const models = { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" };
const apps: TerminalApp[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.key("", { name: "d", ctrl: true });
});

function setup(provider = new MockProvider({ handler: () => ({ text: "Hello from CDR." }) })) {
  const root = mkdtempSync(join(tmpdir(), "cdr-tui-"));
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

  it("shows the provider account balance and run spend in the sidebar", () => {
    const v = view();
    v.state.messages.a = { id: "a", role: "user", text: "hi" } as View["state"]["messages"][string];
    v.state.timeline = [{ kind: "message", id: "a" }];
    expect(renderView(v, 160, 48).plain().join("\n")).not.toContain("ACCOUNT");
    v.balance = {
      items: [{ currency: "USD", total: 17.96, granted: 0, toppedUp: 17.96 }],
      start: [{ currency: "USD", total: 18.03 }],
    };
    v.state.todos = [{ id: "1", text: "write tests", status: "in_progress" }] as View["state"]["todos"];
    const screen = renderView(v, 160, 48).plain().join("\n");
    expect(screen).toContain("ACCOUNT");
    expect(screen).toContain("$17.96");
    expect(screen).toContain("spent $0.07 this run");
    expect(screen).toContain("TASKS");
    for (const [columns, rows] of [
      [80, 24],
      [40, 14],
      [30, 10],
    ]) {
      const c = renderView(v, columns, rows);
      expect(c.plain()).toHaveLength(rows);
      for (const row of c.plain()) expect(width(row)).toBe(columns);
    }
  });

  it("formats balances: multiple currencies, low balance, and failed refreshes", () => {
    expect(formatBalance(undefined)).toEqual([]);
    expect(formatBalance({ items: [] })).toEqual([]);
    expect(formatBalance({ items: [], error: true })).toEqual([{ text: "balance unavailable", fg: "faint" }]);
    const lines = formatBalance({
      items: [
        { currency: "USD", total: 1.5, granted: 1, toppedUp: 0.5 },
        { currency: "CNY", total: 6.07 },
      ],
      error: true,
    });
    expect(lines).toEqual([
      { text: "$1.50", fg: "red" },
      { text: "¥6.07", fg: "red" },
      { text: "granted $1.00", fg: "faint" },
      { text: "topped up $0.50", fg: "faint" },
      { text: "refresh failed", fg: "faint" },
    ]);
  });

  it("fetches the provider balance into the sidebar when the TUI starts", async () => {
    const provider = Object.assign(new MockProvider({ handler: () => ({ text: "ok" }) }), {
      getBalance: vi.fn(async () => [{ currency: "USD", total: 12.34 }]),
    });
    const { app } = setup(provider);
    await waitFor(() => expect(app.snapshot().balance?.items[0]?.total).toBe(12.34));
    expect(provider.getBalance).toHaveBeenCalled();
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
    await waitFor(() => expect(x.app.state.status).toBe("failed"));
    fail = false;
    const id = x.session.id;
    x.send("/continue");
    await waitFor(() => expect(x.app.state.done?.status).toBe("success"));
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
      await waitFor(() => expect(x.app.snapshot().dialog).toBeDefined());
      expect(x.app.snapshot().elapsed).toBe(2);
      now += 2 * 60 * 60_000;
      expect(x.app.snapshot().elapsed).toBe(2);
      expect(renderView(x.app.snapshot(), 120, 38).plain().join("\n")).toContain("Waiting for you");
      x.input.write("y");
      await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
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
    await waitFor(() => expect(x.app.snapshot().dialog?.selected).toBe(2));
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
    await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
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
    await waitFor(() => expect(x.app.snapshot().dialog).toBeDefined());
    x.input.write(key);
    await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
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
      await waitFor(() => expect(x.outputText).toContain("Thinking"));
      const first = x.app.snapshot();
      const outputLength = x.outputText.length;
      await waitFor(() => expect(x.app.snapshot().frame).toBeGreaterThan(first.frame + 2));
      expect(x.app.state.lastSeq).toBe(first.state.lastSeq);
      expect(x.outputText.slice(outputLength)).toContain("Thinking");
    } finally {
      release({ text: "Ready." });
    }
    await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    const frame = x.app.snapshot().frame;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(x.app.snapshot().frame).toBeLessThanOrEqual(frame + 1);
  });
  it("streams a response from session events and restores terminal modes on exit", async () => {
    const x = setup();
    expect(x.input.isRaw).toBe(true);
    expect(x.outputText).toContain("\x1b[?1049h");
    x.send("hello");
    await waitFor(() => expect(x.app.snapshot().state.done?.status).toBe("success"));
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
    await waitFor(() => expect(x.session.config.models.executor).toBe("mock/new"));
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
    await waitFor(() => expect(x.app.snapshot().dialog?.title).toContain("Permission required"));
    x.app.key("n", { name: "n" });
    await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    expect(existsSync(join(x.root, "result.txt"))).toBe(false);
    x.send("write it again");
    await waitFor(() => expect(x.app.snapshot().dialog?.title).toContain("Permission required"));
    x.app.key("y", { name: "y" });
    await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    expect(readFileSync(join(x.root, "result.txt"), "utf8")).toBe("approved");
  });

  it("cancels a waiting request and returns to the composer", async () => {
    const x = setup(
      new MockProvider({
        replies: [{ toolCalls: [{ name: "write_file", args: { path: "no.txt", content: "no" } }] }],
      }),
    );
    x.send("write");
    await waitFor(() => expect(x.app.snapshot().dialog).toBeDefined());
    x.app.key("", { name: "c", ctrl: true });
    await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
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
    await waitFor(() => expect(x.app.snapshot().dialog?.title).toBe("Review the plan"));
    x.input.write("\x1b[D");
    x.input.write("\r");
    expect(x.app.snapshot().dialog?.title).toBe("Edit plan before approval");
    x.app.snapshot().dialog!.editor!.set("# Revised plan\n## Steps\n1. Explain a greeting");
    x.app.key("", { name: "s", ctrl: true });
    await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
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
    await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    const original = x.session.id;
    x.send("/new");
    await waitFor(() => expect(x.app.snapshot().sessionId).not.toBe(original));
    expect(Object.values(x.app.state.messages)).toHaveLength(0);
    x.app.key("", { name: "r", ctrl: true });
    x.app.key("Remember this conversation", {});
    x.app.key("\r", { name: "return" });
    await waitFor(() => expect(x.app.snapshot().sessionId).toBe(original));
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
    await waitFor(() => expect(x.app.snapshot().dialog?.title).toBe("CDR needs your input"));
    x.app.key("2", { name: "2" });
    x.app.key("\r", { name: "return" });
    await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
    expect(x.session.events.some((e) => e.type === "question.answered" && e.answer === "Green")).toBe(true);
  });

  describe("Claude Code style layout", () => {
    function chat() {
      const v = view();
      v.sidebar = false;
      v.state.messages = {
        u: { id: "u", role: "user", text: "read the file" },
        a: { id: "a", role: "assistant", text: "Here it is.", streaming: false },
      } as typeof v.state.messages;
      v.state.tools = {
        t: { id: "t", name: "read_file", args: { path: "a.ts" }, status: "ok", output: "one\ntwo\nthree" },
      } as typeof v.state.tools;
      v.state.timeline = [
        { kind: "message", id: "u" },
        { kind: "message", id: "a" },
        { kind: "tool", id: "t" },
      ];
      return v;
    }
    it("renders a flowing single column with a banner, markers, rules and one status line", () => {
      const v = chat();
      const screen = renderView(v, 100, 30).plain();
      const text = screen.join("\n");
      expect(text).not.toContain("WORKSPACE");
      expect(text).not.toContain("── FINISH");
      expect(screen[0]).toContain("╭");
      expect(text).toContain("Welcome to CDR");
      expect(text).toMatch(/^ > read the file/m);
      expect(text).toMatch(/^ ● Here it is\./m);
      expect(text).toMatch(/● ReadFile\(path="a\.ts"\)\s*\n\s+⎿  one/);
      const rules = screen.flatMap((row, i) => (/^─+\s*$/.test(row) ? [i] : []));
      expect(rules).toHaveLength(2);
      expect(rules[1] - rules[0]).toBe(2);
      expect(screen.at(-1)).toContain("ask before changes");
      expect(screen.at(-1)).toContain("deepseek-flash");
    });
    it("scrolls the banner away and clamps the scroll range", () => {
      const v = chat();
      for (let i = 0; i < 40; i++) {
        v.state.messages[`m${i}`] = {
          id: `m${i}`,
          role: "assistant",
          text: `line ${i}`,
          streaming: false,
        } as never;
        v.state.timeline.push({ kind: "message", id: `m${i}` });
      }
      expect(renderView(v, 100, 24).plain().join("\n")).not.toContain("Welcome to CDR");
      v.scroll = transcript(v.state, contentWidth(100), false).length + BANNER_ROWS;
      expect(renderView(v, 100, 24).plain().join("\n")).toContain("Welcome to CDR");
    });
    it("shows an animated activity line while busy and keeps the sidebar optional", () => {
      const v = chat();
      v.busy = true;
      v.elapsed = 7;
      v.state.status = "running";
      v.state.messages.b = { id: "b", role: "assistant", text: "", streaming: true } as never;
      v.state.timeline.push({ kind: "message", id: "b" });
      expect(renderView(v, 100, 30).plain().join("\n")).toContain("Thinking… (7s · esc to interrupt)");
      expect(contentWidth(160, true)).toBeLessThan(contentWidth(160, false));
      expect(contentWidth(100, true)).toBe(contentWidth(100, false));
      v.sidebar = true;
      expect(renderView(v, 160, 40).plain().join("\n")).toContain("WORKSPACE");
    });
    it("uses the terminal's default colours instead of painted ones", () => {
      const c = new Canvas(10, 2);
      c.text(0, 0, "hi");
      const line = c.lines(true)[0];
      expect(line).toContain("39;49");
      expect(line).not.toContain("NaN");
      expect(c.lines(true)[1]).not.toContain("NaN");
    });
  });

  describe("mouse wheel", () => {
    const up = "\x1b[<64;10;5M";
    const down = "\x1b[<65;10;5M";
    async function longChat() {
      const x = setup();
      for (let i = 0; i < 5; i++) {
        x.send(`message ${i}`);
        await waitFor(() => expect(x.app.snapshot().busy).toBe(false));
      }
      return x;
    }

    it("scrolls the transcript and leaves the input and history alone", async () => {
      const x = await longChat();
      expect(x.app.snapshot().scroll).toBe(0);
      x.input.write(up);
      expect(x.app.snapshot().scroll).toBe(3);
      x.input.write(up);
      expect(x.app.snapshot().scroll).toBe(6);
      expect(x.app.editor.text).toBe("");
      x.input.write(down);
      x.input.write(down);
      x.input.write(down);
      expect(x.app.snapshot().scroll).toBe(0);
      // Plain arrows still recall prompt history.
      x.input.write("\x1b[A");
      expect(x.app.editor.text).toBe("message 4");
    }, 30_000);

    it("handles reports split across chunks, modifiers, clicks and pastes", async () => {
      const x = await longChat();
      x.input.write("\x1b[<6");
      x.input.write("4;10;5M");
      expect(x.app.snapshot().scroll).toBe(3);
      x.input.write("\x1b[<68;10;5M"); // shift+wheel up
      expect(x.app.snapshot().scroll).toBe(6);
      x.input.write("\x1b[<0;10;5M\x1b[<0;10;5m"); // click + release
      expect(x.app.snapshot().scroll).toBe(6);
      expect(x.app.editor.text).toBe("");
      x.input.write(`\x1b[200~${up}\x1b[201~`);
      expect(x.app.snapshot().scroll).toBe(6);
      // Pasted as text (the editor strips the control character), never treated as a wheel event.
      expect(x.app.editor.text).toContain("64;10;5M");
    }, 30_000);

    it("enables mouse reporting on open and releases it on exit unless CDR_NO_MOUSE is set", async () => {
      const x = setup();
      expect(x.outputText).toContain("\x1b[?1000h\x1b[?1006h");
      x.app.key("d", { name: "d", ctrl: true });
      await x.result;
      expect(x.outputText).toContain("\x1b[?1006l\x1b[?1000l");
      process.env.CDR_NO_MOUSE = "1";
      try {
        const y = setup();
        expect(y.outputText).not.toContain("\x1b[?1000h");
      } finally {
        delete process.env.CDR_NO_MOUSE;
      }
    });
  });

  describe("terminal designs", () => {
    function chatView(): View {
      const v = view();
      v.sidebar = false;
      v.state.messages = {
        u: { id: "u", role: "user", text: "read the file" },
        a: { id: "a", role: "assistant", text: "Here it is.", streaming: false },
      } as typeof v.state.messages;
      v.state.timeline = [
        { kind: "message", id: "u" },
        { kind: "message", id: "a" },
      ];
      return v;
    }
    it("draws the default design unless the view asks for classic", () => {
      const v = chatView();
      const flowing = renderView(v, 100, 30).plain().join("\n");
      expect(flowing).toContain("Welcome to CDR");
      expect(flowing).not.toContain("▸  CDR");
      v.design = "classic";
      const boxed = renderView(v, 100, 30);
      const text = boxed.plain().join("\n");
      expect(text).toContain("▸  CDR");
      expect(text).toContain("YOU");
      expect(text).not.toContain("Welcome to CDR");
      // The classic look paints its own graphite background instead of inheriting the terminal's.
      expect(boxed.cells[0][0].bg).toBe("#1c1c1c");
      expect(
        renderView({ ...view(), design: "classic" }, 100, 30)
          .plain()
          .join("\n"),
      ).toContain("████");
    });
    it("switches with /terminal-design, remembers the choice and starts in the default design", async () => {
      expect(loadDesign()).toBe("default");
      const x = setup();
      expect(x.app.snapshot().design).toBe("default");
      x.send("/terminal-design classic");
      await waitFor(() => expect(x.app.snapshot().design).toBe("classic"));
      expect(x.app.snapshot().notice).toContain("Classic");
      expect(loadDesign()).toBe("classic");
      x.send("/terminal-design nope");
      await waitFor(() => expect(x.app.snapshot().notice).toContain("default | classic"));
      expect(x.app.snapshot().design).toBe("classic");
      x.send("/terminal-design");
      await waitFor(() => expect(x.app.snapshot().picker?.title).toBe("Terminal design"));
      x.app.key("\r", { name: "return", sequence: "\r" });
      await waitFor(() => expect(x.app.snapshot().design).toBe("default"));
      expect(loadDesign()).toBe("default");
    });
  });
});
