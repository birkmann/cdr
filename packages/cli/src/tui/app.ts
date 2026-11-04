import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Key } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { initialSessionState, reduceSession, type SessionState } from "@harness/client";
import {
  ATTACHMENT_LIMITS,
  currentBranch,
  parseModelRef,
  resolveInProject,
  workingTreeDiff,
  type Harness,
  type Session,
} from "@harness/core";
import type { Attachment, HarnessEvent } from "@harness/protocol";
import { COMMANDS } from "../commands.js";
import { Editor, InputDecoder } from "./input.js";
import { Screen, clean } from "./screen.js";
import { renderView, transcript, type Dialog, type Picker, type PickerItem, type View } from "./view.js";

const MODES = [
  { label: "Chat" },
  { label: "Build", workflow: "default" },
  { label: "Plan", workflow: "plan-only" },
  { label: "Quick fix", workflow: "quick-fix" },
  { label: "Review", workflow: "review-only" },
];
type PickerKind = "commands" | "models" | "sessions" | "permissions";
interface Options {
  version: string;
  verbose?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export class TerminalApp {
  readonly editor = new Editor();
  state: SessionState = initialSessionState();
  private session: Session;
  private input: NodeJS.ReadStream;
  private output: NodeJS.WriteStream;
  private screen: Screen;
  private decoder?: InputDecoder;
  private utf8 = new StringDecoder("utf8");
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private resolve?: (code: number) => void;
  private closed = false;
  private wasRaw = false;
  private dirty = true;
  private frame = 0;
  private scroll = 0;
  private expanded = false;
  private sidebar = true;
  private mode = 0;
  private branch: string | null = null;
  private started = Date.now();
  private waitingAt?: number;
  private waitingMs = 0;
  private notice = "";
  private noticeUntil = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private historyDraft = "";
  private attachments: Attachment[] = [];
  private picker?: Picker & { kind: PickerKind; all: PickerItem[] };
  private document?: View["document"];
  private promptId = "";
  private promptMode: "select" | "feedback" | "edit" | "answer" = "select";
  private reply = new Editor();
  private choice = 0;
  private promptScroll = 0;
  private action = false;
  private interrupted = false;
  private activeRun?: Promise<unknown>;
  constructor(
    private harness: Harness,
    session: Session,
    private opts: Options,
  ) {
    this.session = session;
    this.expanded = !!opts.verbose;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.screen = new Screen(this.output);
    this.bind(session);
  }
  private bind(session: Session) {
    this.unsubscribe?.();
    this.session = session;
    this.state = initialSessionState();
    this.branch = currentBranch(session.projectRoot);
    this.history = [];
    this.historyIndex = -1;
    this.scroll = 0;
    this.promptId = "";
    this.waitingAt = undefined;
    this.waitingMs = 0;
    this.unsubscribe = session.subscribe((event) => {
      const previousStatus = this.state.status;
      this.state = reduceSession(this.state, event);
      if (event.type === "status") {
        const now = Date.now();
        if (event.status === "running") {
          if (previousStatus !== "waiting") {
            this.started = now;
            this.waitingMs = 0;
            this.interrupted = false;
          }
          if (this.waitingAt !== undefined) this.waitingMs += now - this.waitingAt;
          this.waitingAt = undefined;
        } else if (event.status === "waiting" && this.waitingAt === undefined) this.waitingAt = now;
      }
      this.dirty = true;
    }, 0);
    const users = new Set(
      session.events.flatMap((e) => (e.type === "message.start" && e.role === "user" ? [e.id] : [])),
    );
    this.history = session.events
      .flatMap((e) => (e.type === "message.end" && users.has(e.id) ? [e.text] : []))
      .slice(-200);
  }
  private get busy() {
    return this.session.isRunning || this.action;
  }
  private alert(text: string) {
    this.notice = clean(text);
    this.noticeUntil = Date.now() + 7000;
    this.dirty = true;
  }
  private pending(): HarnessEvent | undefined {
    if (!this.session.isRunning) return;
    return this.state.pendingPermissions[0] ?? this.state.pendingQuestions[0] ?? this.state.pendingPlan;
  }
  private dialog(): Dialog | undefined {
    const p = this.pending();
    if (!p || !("id" in p)) return;
    if (p.id !== this.promptId) {
      this.promptId = p.id;
      this.promptScroll = 0;
      this.reply.set("");
      this.promptMode = "select";
      this.choice = p.type === "permission.request" ? 2 : p.type === "plan.proposed" ? 3 : 0;
      if (p.type === "question") this.promptMode = "answer";
    }
    if (p.type === "permission.request")
      return {
        title: `Permission required · ${p.risk} risk`,
        body: `${p.tool}\n\n${JSON.stringify(p.args, null, 2)}${p.reason ? `\n\n${p.reason}` : ""}`,
        actions: ["Allow once", "Always", "Deny"],
        selected: this.choice,
        scroll: this.promptScroll,
        warning: p.risk === "high",
        hint: "←→ / Tab select · Enter confirm · 1/2/3 choose · PgUp/PgDn read",
      };
    if (p.type === "plan.proposed")
      return {
        title:
          this.promptMode === "edit"
            ? "Edit plan before approval"
            : this.promptMode === "feedback"
              ? "Plan feedback"
              : "Review the plan",
        body:
          this.promptMode === "edit"
            ? "Edit the plan below. Ctrl+S approves your revised plan. Escape returns to review."
            : p.markdown,
        actions:
          this.promptMode === "select"
            ? ["Approve", "Feedback", "Edit", "Reject"]
            : [this.promptMode === "edit" ? "Approve edit" : "Send feedback", "Back"],
        selected: this.promptMode === "select" ? this.choice : 0,
        scroll: this.promptScroll,
        editor: this.promptMode !== "select" ? this.reply : undefined,
        hint:
          this.promptMode !== "select"
            ? "ctrl+s submit · ctrl+j newline · esc back"
            : "←→ choose · Enter confirm · PgUp/PgDn read",
      };
    if (p.type === "question")
      return {
        title: "CDR needs your input",
        body:
          p.text + (p.options?.length ? "\n\n" + p.options.map((o, i) => `${i + 1}. ${o}`).join("\n") : ""),
        editor: this.reply,
        actions: ["Answer"],
        selected: 0,
        scroll: this.promptScroll,
        hint: "Type an answer or option number · Enter send · Esc cancel turn",
      };
  }
  snapshot(): View {
    return {
      state: this.state,
      editor: this.editor,
      project: this.session.projectRoot,
      branch: this.branch,
      model: this.session.config.models.executor || "No model configured",
      permission: this.session.policy.mode,
      mode: MODES[this.mode].label,
      version: this.opts.version,
      sessionId: this.session.id,
      busy: this.busy,
      elapsed: Math.max(
        0,
        Math.floor(((this.waitingAt ?? Date.now()) - this.started - this.waitingMs) / 1000),
      ),
      frame: this.frame,
      scroll: this.scroll,
      expanded: this.expanded,
      sidebar: this.sidebar,
      notice: Date.now() < this.noticeUntil ? this.notice : undefined,
      attachments: this.attachments.map((a) => a.name),
      picker: this.picker,
      dialog: this.dialog(),
      document: this.document,
    };
  }
  private draw = () => {
    if (this.closed) return;
    if (!this.dirty && !this.busy && !(this.notice && Date.now() >= this.noticeUntil)) return;
    if (this.notice && Date.now() >= this.noticeUntil) this.notice = "";
    this.dirty = false;
    this.frame++;
    this.screen.draw(
      renderView(
        this.snapshot(),
        Math.min(this.output.columns || 80, 500),
        Math.min(this.output.rows || 24, 200),
      ),
    );
  };
  private resize = () => {
    this.screen.reset();
    this.dirty = true;
    this.draw();
  };
  private data = (data: Buffer | string) =>
    this.decoder?.feed(typeof data === "string" ? data : this.utf8.write(data));
  private signal = () => this.finish(130);
  private end = () => this.finish(0);
  run(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      try {
        this.screen.open();
        this.wasRaw = !!this.input.isRaw;
        this.input.setRawMode(true);
        this.decoder = new InputDecoder(
          (text, key) => {
            try {
              this.key(text, key);
            } catch (error) {
              this.alert((error as Error).message);
            }
          },
          (text) => {
            const target = this.dialog()?.editor ?? this.picker?.query ?? this.editor;
            // A pasted command is only a draft; the user must explicitly submit it.
            if (this.pending() && !this.dialog()?.editor) return;
            target.insert(text);
            if (this.picker) this.filterPicker();
            this.dirty = true;
          },
        );
        this.input.on("data", this.data);
        this.input.on("end", this.end);
        this.input.resume();
        this.output.on("resize", this.resize);
        process.on("SIGINT", this.signal);
        process.on("SIGTERM", this.signal);
        process.on("exit", this.restore);
        this.timer = setInterval(this.draw, 80);
        this.draw();
      } catch (error) {
        this.restore();
        reject(error);
      }
    });
  }
  private restore = () => {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    this.decoder?.close();
    this.input.off("data", this.data);
    this.input.off("end", this.end);
    this.output.off("resize", this.resize);
    process.off("SIGINT", this.signal);
    process.off("SIGTERM", this.signal);
    process.off("exit", this.restore);
    if (this.input.isTTY) this.input.setRawMode(this.wasRaw);
    this.input.pause();
    this.screen.close();
    this.session.close();
  };
  private finish(code: number) {
    if (this.closed) return;
    this.session.cancel();
    this.restore();
    this.resolve?.(code);
  }
  private edit(editor: Editor, text: string, key: Key): boolean {
    if (key.name === "left") editor.move(-1);
    else if (key.name === "right") editor.move(1);
    else if (key.name === "home" || (key.ctrl && key.name === "a")) editor.boundary(false);
    else if (key.name === "end" || (key.ctrl && key.name === "e")) editor.boundary(true);
    else if (key.name === "backspace") editor.remove(true);
    else if (key.name === "delete") editor.remove(false);
    else if (key.ctrl && key.name === "u") editor.kill(true);
    else if (key.ctrl && key.name === "k") editor.kill(false);
    else if (key.ctrl && key.name === "w") editor.wordBack();
    else if (
      key.sequence === "\x1b[13;2u" ||
      key.sequence === "\x1b[27;2;13~" ||
      (key.name === "return" && (key.shift || key.meta)) ||
      (key.ctrl && key.name === "j") ||
      key.name === "enter" ||
      key.sequence === "\n"
    )
      editor.insert("\n");
    else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) editor.insert(text);
    else return false;
    return true;
  }
  key(text: string, key: Key) {
    if (this.closed) return;
    this.dirty = true;
    if (key.ctrl && key.name === "c") {
      if (this.busy && !this.interrupted) {
        this.interrupted = true;
        this.session.cancel();
        this.alert("Cancelling… Ctrl+C again to exit");
        return;
      }
      if (this.editor.text && !this.busy && !this.pending()) {
        this.editor.set("");
        this.alert("Draft cleared. Ctrl+C to exit.");
        return;
      }
      this.finish(130);
      return;
    }
    if (key.ctrl && key.name === "d") {
      this.finish(0);
      return;
    }
    const prompt = this.dialog();
    if (prompt) {
      this.promptKey(text, key, prompt);
      return;
    }
    if (this.document) {
      if (key.name === "escape" || key.name === "q") this.document = undefined;
      else if (["pagedown", "down"].includes(key.name || ""))
        this.document.scroll = Math.min(
          Math.max(0, this.documentRows() - 5),
          this.document.scroll + (key.name === "down" ? 1 : 10),
        );
      else if (["pageup", "up"].includes(key.name || ""))
        this.document.scroll = Math.max(0, this.document.scroll - (key.name === "up" ? 1 : 10));
      return;
    }
    if (key.ctrl && key.name === "p") {
      this.picker ? (this.picker = undefined) : this.openPicker("commands");
      return;
    }
    if (key.ctrl && key.name === "o") {
      this.openPicker("models");
      return;
    }
    if (key.ctrl && key.name === "r") {
      this.openPicker("sessions");
      return;
    }
    if (this.picker) {
      this.pickerKey(text, key);
      return;
    }
    if (key.name === "escape") {
      if (this.busy) {
        this.session.cancel();
        this.alert("Cancelling…");
      }
      return;
    }
    if (key.ctrl && key.name === "t") {
      this.expanded = !this.expanded;
      return;
    }
    if (key.ctrl && key.name === "b") {
      this.sidebar = !this.sidebar;
      return;
    }
    if (key.ctrl && key.name === "l") {
      this.screen.reset();
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      const limit = Math.max(
        0,
        transcript(this.state, Math.max(20, Math.min(102, (this.output.columns || 80) - 8)), this.expanded)
          .length - 1,
      );
      this.scroll = Math.min(limit, Math.max(0, this.scroll + (key.name === "pageup" ? 10 : -10)));
      return;
    }
    if (key.name === "end" && !this.editor.text) {
      this.scroll = 0;
      return;
    }
    if (key.name === "tab") {
      if (this.editor.text.startsWith("/")) this.openPicker("commands", this.editor.text);
      else {
        this.mode = (this.mode + (key.shift ? MODES.length - 1 : 1)) % MODES.length;
      }
      return;
    }
    if (key.name === "up" || key.name === "down") {
      if (this.editor.vertical(key.name === "up" ? -1 : 1)) return;
      if (key.name === "up" && this.history.length) {
        if (this.historyIndex === -1) {
          this.historyDraft = this.editor.text;
          this.historyIndex = this.history.length;
        }
        this.historyIndex = Math.max(0, this.historyIndex - 1);
        this.editor.set(this.history[this.historyIndex]);
      } else if (key.name === "down" && this.historyIndex !== -1) {
        this.historyIndex++;
        if (this.historyIndex >= this.history.length) {
          this.historyIndex = -1;
          this.editor.set(this.historyDraft);
        } else this.editor.set(this.history[this.historyIndex]);
      }
      return;
    }
    if (key.name === "return" && !key.shift && !key.meta) {
      void this.submit();
      return;
    }
    this.edit(this.editor, text, key);
    if (this.editor.text === "/") this.openPicker("commands", "/");
  }
  private documentRows() {
    return (
      (this.document?.text.length || 0) / Math.max(20, (this.output.columns || 80) - 10) +
      (this.document?.text.split("\n").length || 0)
    );
  }
  private promptKey(text: string, key: Key, d: Dialog) {
    const p = this.pending();
    if (!p || !("id" in p)) return;
    if (key.name === "pageup") {
      this.promptScroll = Math.max(0, this.promptScroll - 10);
      return;
    }
    if (key.name === "pagedown") {
      this.promptScroll = Math.min(d.body.length, this.promptScroll + 10);
      return;
    }
    if (key.name === "escape") {
      if (this.promptMode === "feedback" || this.promptMode === "edit") {
        this.promptMode = "select";
        return;
      }
      if (p.type === "permission.request") this.session.resolvePermission(p.id, "deny");
      else if (p.type === "plan.proposed") this.session.decidePlan(p.id, "reject");
      else this.session.cancel();
      return;
    }
    if (p.type === "permission.request" && ["y", "a", "n"].includes(text.toLowerCase())) {
      this.session.resolvePermission(
        p.id,
        text.toLowerCase() === "y" ? "allow" : text.toLowerCase() === "a" ? "always" : "deny",
      );
      return;
    }
    if (d.editor) {
      const submit =
        p.type === "question"
          ? key.name === "return" && !key.shift && !key.meta
          : key.ctrl && key.name === "s";
      if (submit && this.reply.text.trim()) {
        if (p.type === "question") {
          const n = Number(this.reply.text);
          this.session.answerQuestion(
            p.id,
            p.options && Number.isInteger(n) && n > 0 && n <= p.options.length
              ? p.options[n - 1]
              : this.reply.text,
          );
        } else if (p.type === "plan.proposed")
          this.session.decidePlan(
            p.id,
            this.promptMode === "edit" ? "edit" : "reject",
            this.promptMode === "edit" ? this.reply.text : undefined,
            this.promptMode === "feedback" ? this.reply.text : undefined,
          );
      } else if (key.name === "up" || key.name === "down") this.reply.vertical(key.name === "up" ? -1 : 1);
      else this.edit(this.reply, text, key);
      return;
    }
    if (["left", "right", "up", "down", "tab"].includes(key.name || "")) {
      this.choice =
        (this.choice + (key.name === "left" || key.name === "up" || key.shift ? d.actions.length - 1 : 1)) %
        d.actions.length;
      return;
    }
    if (/^[1-9]$/.test(text) && Number(text) <= d.actions.length) this.choice = Number(text) - 1;
    else if (key.name !== "return") return;
    if (p.type === "permission.request")
      this.session.resolvePermission(p.id, (["allow", "always", "deny"] as const)[this.choice]);
    else if (p.type === "plan.proposed") {
      if (this.choice === 0) this.session.decidePlan(p.id, "approve");
      else if (this.choice === 3) this.session.decidePlan(p.id, "reject");
      else {
        this.promptMode = this.choice === 1 ? "feedback" : "edit";
        this.reply.set(this.choice === 2 ? p.markdown : "");
        this.promptScroll = 0;
      }
    }
  }
  private openPicker(kind: PickerKind, query = "") {
    let items: PickerItem[];
    if (kind === "commands") items = COMMANDS.map(([label, detail]) => ({ label, detail, value: label }));
    else if (kind === "sessions")
      items = this.harness.listSessions().map((s) => ({
        label: s.title || s.id,
        detail: basename(s.projectPath),
        value: s.id,
        disabled: s.projectMissing,
      }));
    else if (kind === "permissions")
      items = [
        { label: "Ask", detail: "Approve edits and commands", value: "ask" },
        { label: "Auto", detail: "Ask for risky commands", value: "auto" },
        { label: "Full access", detail: "No interactive approvals", value: "yolo" },
      ];
    else {
      const { registry } = this.harness.providerRegistry(this.session.projectRoot);
      const refs = new Set(Object.values(this.session.config.models).filter((r): r is string => !!r));
      for (const [provider, config] of Object.entries(this.session.config.providers))
        for (const model of Object.keys(config.models || {})) refs.add(`${provider}/${model}`);
      items = [...refs].map((ref) => ({
        label: ref,
        detail: ref === this.session.config.models.executor ? "current" : "configured",
        value: ref,
        disabled: !registry.isConfigured(parseModelRef(ref).provider),
      }));
    }
    this.picker = {
      kind,
      title:
        kind === "commands"
          ? "Commands"
          : kind === "models"
            ? "Choose a model"
            : kind === "sessions"
              ? "Resume a conversation"
              : "Permissions",
      query: new Editor(),
      items,
      all: items,
      selected: 0,
      hint:
        kind === "models" ? "Type provider/model · ctrl+f discover · Enter select · Esc close" : undefined,
    };
    this.picker.query.set(query);
    this.filterPicker();
    this.dirty = true;
  }
  private filterPicker() {
    const p = this.picker;
    if (!p) return;
    const q = p.query.text.toLowerCase().replace(/^\//, "");
    p.items = p.all.filter((i) => `${i.label} ${i.detail || ""}`.toLowerCase().includes(q));
    p.selected = 0;
    if (
      p.kind === "models" &&
      /^[^\s/]+\/\S+$/.test(p.query.text) &&
      !p.items.some((i) => i.value === p.query.text)
    )
      p.items.unshift({ label: `Use ${p.query.text}`, value: p.query.text, detail: "custom model" });
  }
  private pickerKey(text: string, key: Key) {
    const p = this.picker!;
    if (key.name === "escape") {
      if (p.kind === "commands" && p.query.text.startsWith("/")) this.editor.set(p.query.text);
      this.picker = undefined;
      return;
    }
    if (key.ctrl && key.name === "f" && p.kind === "models") {
      void this.discoverModels(p).catch((e) => this.alert((e as Error).message));
      return;
    }
    if (["up", "down", "tab"].includes(key.name || "")) {
      p.selected =
        (p.selected + (key.name === "up" || key.shift ? p.items.length - 1 : 1)) % (p.items.length || 1);
      return;
    }
    if (key.name === "return") {
      if (this.busy) {
        this.alert("Wait for this turn to finish, or press Esc to cancel it.");
        return;
      }
      if (p.kind === "commands" && /^\/\w+\s+\S/.test(p.query.text)) {
        this.editor.set(p.query.text);
        this.picker = undefined;
        void this.submit();
        return;
      }
      const item = p.items[p.selected];
      if (!item || item.disabled) return;
      this.picker = undefined;
      const draft = this.editor.text.startsWith("/") ? "" : this.editor.text;
      if (p.kind === "commands") {
        if (["/run", "/quick", "/plan", "/attach", "/resume"].includes(item.value))
          this.editor.set(item.value + " ");
        else {
          this.editor.set(item.value);
          void this.submit();
        }
      } else if (p.kind === "models") {
        this.editor.set(`/model ${item.value}`);
        void this.submit().then(() => {
          if (!this.editor.text) this.editor.set(draft);
          this.dirty = true;
        });
      } else if (p.kind === "permissions") {
        this.editor.set(`/mode ${item.value}`);
        void this.submit().then(() => {
          if (!this.editor.text) this.editor.set(draft);
          this.dirty = true;
        });
      } else {
        this.editor.set(`/resume ${item.value}`);
        void this.submit();
      }
      return;
    }
    this.edit(p.query, text, key);
    this.filterPicker();
  }
  private async discoverModels(p: Picker & { all: PickerItem[] }) {
    p.hint = "Discovering configured providers…";
    this.dirty = true;
    const { registry, config } = this.harness.providerRegistry(this.session.projectRoot);
    const found = await Promise.all(
      Object.keys(config.providers)
        .filter((id) => registry.isConfigured(id))
        .map(async (id) => {
          try {
            return ((await registry.get(id).listModels?.(AbortSignal.timeout(6000))) || []).map((model) => ({
              label: `${id}/${model}`,
              value: `${id}/${model}`,
              detail: id,
            }));
          } catch {
            return [];
          }
        }),
    );
    if (this.picker !== p || this.closed) return;
    const all = new Map(p.all.map((i) => [i.value, i]));
    found.flat().forEach((i) => all.set(i.value, i));
    p.all = [...all.values()];
    p.hint = "↑↓ choose · Enter select · Esc close";
    this.filterPicker();
    this.dirty = true;
  }
  private async submit() {
    const text = this.editor.text.trim();
    if (!text) return;
    if (this.busy) {
      this.alert("CDR is working. Your draft is kept; Esc cancels the current turn.");
      return;
    }
    this.editor.set("");
    this.historyIndex = -1;
    this.scroll = 0;
    if (this.history.at(-1) !== text) this.history = [...this.history, text].slice(-200);
    const [command, ...parts] = text.split(/\s+/),
      arg = parts.join(" ");
    try {
      if (["/exit", "/quit", "/q"].includes(command)) {
        this.finish(0);
        return;
      }
      if (["/help", "/commands"].includes(command)) {
        this.openPicker("commands");
        return;
      }
      if (command === "/continue") {
        this.action = true;
        this.activeRun = this.session.continueJob();
        await this.activeRun;
        return;
      }
      if (command === "/model" || command === "/models") {
        if (!arg || arg === "remote") {
          this.openPicker("models");
          if (arg === "remote")
            void this.discoverModels(this.picker!).catch((e) => this.alert((e as Error).message));
          return;
        }
        const { provider, model } = parseModelRef(arg),
          { registry } = this.harness.providerRegistry(this.session.projectRoot);
        if (!model || !registry.isConfigured(provider))
          throw new Error(`Configure ${provider} before selecting this model.`);
        this.session.updateSettings({
          models: { executor: arg, planner: arg, reviewer: arg, summarizer: arg },
        });
        this.alert(`Model switched to ${arg}`);
        return;
      }
      if (command === "/mode") {
        if (!arg) {
          this.openPicker("permissions");
          return;
        }
        if (!["ask", "auto", "yolo"].includes(arg)) throw new Error("Use /mode ask, auto, or yolo");
        this.session.updateSettings({ permissionMode: arg as "ask" | "auto" | "yolo" });
        return;
      }
      if (command === "/sessions" || (command === "/resume" && !arg)) {
        this.openPicker("sessions");
        return;
      }
      if (command === "/new" || command === "/resume") {
        if (command === "/resume" && arg === this.session.id) return;
        const next =
          command === "/resume"
            ? this.harness.getSession(arg)
            : this.harness.createSession({
                ...(this.session.isSandbox ? { sandbox: true } : { projectPath: this.session.projectRoot }),
                workflow: this.session.workflow,
                models: this.session.config.models,
                permissionMode: this.session.policy.mode,
                autoApprove: this.session.autoApprove,
              });
        this.session.close();
        this.bind(next);
        this.attachments = [];
        this.dirty = true;
        return;
      }
      if (["/status", "/session", "/cost"].includes(command)) {
        const u = this.state.usage;
        this.document = {
          title: "Session details",
          scroll: 0,
          text: `Session\n${this.session.id}\n\nProject\n${this.session.projectRoot}\n\nModel\n${this.session.config.models.executor}\n\nPermissions\n${this.session.policy.mode}\n\nUsage\n${u.inputTokens} input · ${u.outputTokens} output tokens · $${u.cost.toFixed(4)}\n\nResume later\ncdr resume ${this.session.id}`,
        };
        return;
      }
      if (command === "/diff") {
        this.document = {
          title: "Working tree changes",
          text: workingTreeDiff(this.session.projectRoot) ?? "This folder is not a Git repository.",
          scroll: 0,
        };
        return;
      }
      if (command === "/clear") {
        this.scroll = 0;
        this.screen.reset();
        return;
      }
      if (command === "/attach") {
        const path = resolveInProject(this.session.projectRoot, arg.replace(/^["']|["']$/g, ""));
        if (this.attachments.length >= ATTACHMENT_LIMITS.maxFiles)
          throw new Error("At most 20 attachments per message.");
        if (!statSync(path).isFile() || statSync(path).size > ATTACHMENT_LIMITS.maxBytes)
          throw new Error("Choose a file up to 10 MB.");
        const mime: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".gif": "image/gif",
        };
        this.attachments.push({
          name: basename(path),
          mimeType: mime[extname(path).toLowerCase()] || "application/octet-stream",
          data: readFileSync(path).toString("base64"),
        });
        this.alert(`Attached ${basename(path)} to the next message`);
        return;
      }
      if (command === "/attachments") {
        if (arg === "clear") this.attachments = [];
        this.alert(
          this.attachments.length
            ? this.attachments.map((a) => a.name).join(" · ")
            : "No pending attachments",
        );
        return;
      }
      const workflowCommand = /^\/(run|quick|plan|review)\b\s*([\s\S]*)$/.exec(text);
      if (text.startsWith("/") && !workflowCommand)
        throw new Error(`Unknown command ${command}. Ctrl+P opens commands.`);
      let workflow = MODES[this.mode].workflow,
        task = text;
      if (workflowCommand) {
        workflow = {
          run: this.session.workflow,
          quick: "quick-fix",
          plan: "plan-only",
          review: "review-only",
        }[workflowCommand[1]];
        task =
          workflowCommand[2].trim() ||
          (workflowCommand[1] === "review" ? "Review the current uncommitted changes." : "");
        if (!task) throw new Error(`Usage: ${command} <task>`);
      }
      this.action = true;
      this.started = Date.now();
      this.interrupted = false;
      this.dirty = true;
      this.activeRun = workflow
        ? this.session.run(task, { workflow, attachments: this.attachments })
        : this.session.chat(task, this.attachments);
      await this.activeRun;
      this.attachments = [];
    } catch (error) {
      this.alert((error as Error).message);
      if (!this.editor.text) this.editor.set(text);
    } finally {
      this.action = false;
      this.activeRun = undefined;
      this.dirty = true;
    }
  }
}

export async function runTui(harness: Harness, session: Session, opts: Options): Promise<number> {
  return new TerminalApp(harness, session, opts).run();
}
