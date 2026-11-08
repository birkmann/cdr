import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ImagePart } from "@harness/protocol";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { rel, resolveInProject } from "./paths.js";

/**
 * Visual self-check for native programs: start the program, find the windows it opens, press keys to get past a
 * start screen, capture frames over time and have a vision model judge them against what the program should show.
 * `set_launch` refuses to add a Launch button until a check ran on the current files and passed.
 */

export interface AppWindow {
  id: string;
  pid: number;
  width: number;
  height: number;
  title?: string;
}

/** Platform access to windows. Swapped out in tests; `null` when this machine cannot capture windows. */
export interface WindowBackend {
  name: string;
  /** On-screen top-level windows owned by any of `pids`. */
  list(pids: number[]): AppWindow[];
  /** Write a PNG of the window to `file` (at most ~1280 px wide); an error message on failure. */
  capture(win: AppWindow, file: string): string | undefined;
  /** Press `key` in the window; an error message on failure. Must not type into other programs. */
  press(win: AppWindow, key: string): string | undefined;
  /** What to tell the user when nothing could be captured (missing permission). */
  permissionHint: string;
  /** What to tell the user when keys could not be pressed. */
  keysHint: string;
}

const run = (cmd: string, args: string[], input?: string) =>
  spawnSync(cmd, args, { encoding: "utf8", input, timeout: 10_000 });

const has = (cmd: string) => run("sh", ["-c", `command -v ${cmd}`]).status === 0;

const MAC_LIST = String.raw`ObjC.import('CoreGraphics');
function run(argv) {
  const pids = argv[0].split(',').map(Number);
  const ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  return JSON.stringify(list
    .filter((w) => w.kCGWindowLayer === 0 && pids.includes(w.kCGWindowOwnerPID))
    .map((w) => ({ id: String(w.kCGWindowNumber), pid: w.kCGWindowOwnerPID, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height, title: w.kCGWindowName || undefined })));
}`;

const MAC_KEYS: Record<string, number> = {
  space: 49,
  enter: 36,
  return: 36,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  escape: 53,
  esc: 53,
  tab: 48,
};

const macBackend: WindowBackend = {
  name: "macOS",
  permissionHint:
    "macOS did not allow capturing the window. Give the app that runs cdr (CDR Studio, Terminal, iTerm, VS Code …) " +
    "Screen Recording permission in System Settings → Privacy & Security, then restart it.",
  keysHint:
    "To let check_app press keys, give the app that runs cdr Accessibility permission in System Settings → " +
    "Privacy & Security.",
  list(pids) {
    const r = run("osascript", ["-l", "JavaScript", "-e", MAC_LIST, pids.join(",")]);
    try {
      return (JSON.parse(r.stdout || "[]") as AppWindow[]).filter((w) => w.width > 40 && w.height > 40);
    } catch {
      return [];
    }
  },
  capture(win, file) {
    const r = run("screencapture", ["-x", "-o", "-l", win.id, file]);
    if (r.status !== 0 || !existsSync(file)) return (r.stderr || r.stdout || "screencapture failed").trim();
    run("sips", ["-Z", "1280", file]);
    return undefined;
  },
  press(win, key) {
    const k = key.toLowerCase();
    const code = MAC_KEYS[k];
    if (code === undefined && !/^[a-z0-9]$/.test(k)) return `Unknown key "${key}".`;
    const stroke = code !== undefined ? `key code ${code}` : `keystroke "${k}"`;
    // bring the program forward and press only while it is frontmost, so keys never land in another app
    const script = `tell application "System Events"
  set p to first process whose unix id is ${win.pid}
  if not frontmost of p then set frontmost of p to true
  delay 0.15
  if frontmost of p then
    ${stroke}
    return "ok"
  end if
  return "not frontmost"
end tell`;
    const r = run("osascript", ["-e", script]);
    const out = (r.stdout || "").trim();
    if (r.error || r.status === null)
      return "System Events did not answer (macOS may be asking for Accessibility permission).";
    if (r.status !== 0)
      return /1002|-1743|-25211|berechtigt|not allowed|assistive/i.test(r.stderr || "")
        ? "macOS does not allow sending keystrokes (Accessibility permission missing)."
        : (r.stderr || "osascript failed").trim();
    return out === "ok" ? undefined : "The window did not come to the front; no key was pressed.";
  },
};

const X_KEYS: Record<string, string> = {
  space: "space",
  enter: "Return",
  return: "Return",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
};

const x11Backend: WindowBackend = {
  name: "X11",
  permissionHint: "Capturing the window failed (needs a running X server, xdotool and ImageMagick's import).",
  keysHint: "Pressing keys failed (needs xdotool and an X server that accepts synthetic input).",
  list(pids) {
    const wins: AppWindow[] = [];
    for (const pid of pids) {
      const r = run("xdotool", ["search", "--onlyvisible", "--pid", String(pid)]);
      for (const id of (r.stdout || "").split(/\s+/).filter(Boolean)) {
        const g = run("xdotool", ["getwindowgeometry", "--shell", id]).stdout || "";
        const width = Number(/WIDTH=(\d+)/.exec(g)?.[1] ?? 0);
        const height = Number(/HEIGHT=(\d+)/.exec(g)?.[1] ?? 0);
        if (width > 40 && height > 40) wins.push({ id, pid, width, height });
      }
    }
    return wins;
  },
  capture(win, file) {
    const r = run("import", ["-window", win.id, "-resize", "1280x1280>", file]);
    return r.status === 0 && existsSync(file) ? undefined : (r.stderr || "import failed").trim();
  },
  press(win, key) {
    const k = X_KEYS[key.toLowerCase()] ?? (/^[a-z0-9]$/i.test(key) ? key.toLowerCase() : undefined);
    if (!k) return `Unknown key "${key}".`;
    const r = run("xdotool", ["key", "--window", win.id, k]);
    return r.status === 0 ? undefined : (r.stderr || "xdotool failed").trim();
  },
};

let backendOverride: WindowBackend | null | undefined;

/** Replace the window backend (tests); `undefined` restores the platform default. */
export function setWindowBackend(b: WindowBackend | null | undefined): void {
  backendOverride = b;
}

/** The window backend for this machine, or null when windows cannot be captured here. */
export function windowBackend(): WindowBackend | null {
  if (backendOverride !== undefined) return backendOverride;
  if (process.env.CDR_WINDOW_CAPTURE === "off") return null;
  if (process.platform === "darwin") return has("screencapture") && has("osascript") ? macBackend : null;
  if (process.platform === "linux" && process.env.DISPLAY && has("xdotool") && has("import"))
    return x11Backend;
  return null;
}

/** Pids of `root` and all its descendants. */
function processTree(root: number): number[] {
  const r = run("ps", ["-A", "-o", "pid=,ppid="]);
  const children = new Map<number, number[]>();
  for (const line of (r.stdout || "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!) ?? []));
  return out;
}

// ---------------------------------------------------------------- check records (for set_launch)

export interface AppCheckRecord {
  /** When the check finished (ms). */
  at: number;
  /** pass: frames reviewed, no problems; fail: problems found; unverified: nothing could be looked at. */
  verdict: "pass" | "fail" | "unverified";
  problems: string[];
  /** Checks of this command that failed in a row. */
  failures: number;
}

const records = new Map<string, AppCheckRecord>();
const recordKey = (root: string, command: string) => `${root}\0${command.trim()}`;

export function lastAppCheck(root: string, command: string): AppCheckRecord | undefined {
  return records.get(recordKey(root, command));
}

const SKIP_DIRS = new Set([
  ".git",
  ".harness",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".venv",
  "venv",
  ".zig-cache",
  "zig-out",
  ".dart_tool",
  ".godot",
]);

/** Newest modification time of the project's source files (build output and dependencies skipped). */
export function newestSourceChange(root: string): number {
  let newest = 0;
  let seen = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (++seen > 20_000) return;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n)) walk(p);
      } else if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  walk(root);
  return newest;
}

/**
 * Why `set_launch` must not add the button yet, or undefined when it may. Only enforced where windows can be
 * captured; after three failed checks in a row the button is allowed so a stuck agent can hand over.
 */
export function launchBlocker(root: string, command: string): string | undefined {
  if (!windowBackend()) return undefined;
  const r = lastAppCheck(root, command);
  if (!r || newestSourceChange(root) > r.at)
    return (
      "Check the running program first: call check_app with this command and an `expect` describing what a " +
      "correct window shows (for a game: what is on screen while playing, and `keys` that start it). " +
      "The Launch button is added once a visual check of the current files passes."
    );
  if (r.verdict === "fail" && r.failures < 3)
    return `The last check_app found problems. Fix them, run check_app again, then call set_launch:\n${r.problems.map((p) => `- ${p}`).join("\n")}`;
  return undefined;
}

// ---------------------------------------------------------------- review

export const APP_REVIEW_SYSTEM = `You are a strict QA tester looking at screenshots of a native program (desktop app or game) that an AI coding agent just built. The frames were captured in order, a moment apart, while the program ran; listed keys were pressed between them.

Judge ONLY what the pixels show, never what the program is supposed to do. For every frame, first describe concretely what is on screen: each object, its shape, where it is, what touches what. Then compare with the expected behaviour and list every visible defect, for example:
- game objects with the wrong shape or structure (an obstacle that should be two parts with a gap is one solid block, pieces overlap, sprites are boxes or missing),
- things in the wrong place (off screen, clipped, drawn over the HUD, floating), wrong scale or aspect ratio, letterboxing that hides content,
- text that is clipped, overlapping, unreadable or shows placeholders,
- nothing changing between frames when it should move, or the program stuck on a start or error screen,
- blank, black or garbled areas, rendering artefacts.

Report only defects a user would call broken or clearly wrong, not style preferences (capitalisation, colour choices, font size, art style). Keys are pressed a moment before a frame is captured, so a short action (a jump, a flap, a click effect) may already be over: report missing reaction to input only when nothing at all changes between frames.

If you cannot see any image, reply exactly NO_IMAGES. Otherwise reply with ONLY a JSON object in a \`\`\`json fenced block:
{"frames": ["what frame 1 shows", "..."], "problems": ["concrete defect and where it is", "..."], "verdict": "pass" | "fail"}
verdict is "pass" only when problems is empty.`;

interface Review {
  frames: string[];
  problems: string[];
  verdict: "pass" | "fail";
}

function parseReview(text: string): Review | undefined {
  const body = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? /\{[\s\S]*\}/.exec(text)?.[0];
  if (!body) return undefined;
  try {
    const j = JSON.parse(body) as Partial<Review>;
    const problems = Array.isArray(j.problems) ? j.problems.map(String).filter(Boolean) : [];
    return {
      frames: Array.isArray(j.frames) ? j.frames.map(String) : [],
      problems,
      verdict: problems.length || j.verdict === "fail" ? "fail" : "pass",
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- the tool

interface CheckAppArgs {
  command: string;
  cwd?: string;
  expect: string;
  keys?: string[];
  frames?: number;
  interval?: number;
  wait?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tail(text: string, lines = 15): string {
  // eslint-disable-next-line no-control-regex
  const all = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .trimEnd()
    .split("\n");
  return all
    .slice(-lines)
    .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
    .join("\n");
}

function killGroup(pid: number): void {
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, sig);
    } catch {
      return;
    }
  }
}

export const checkAppTool: Tool = {
  name: "check_app",
  description:
    "Play-test a native program with a window (desktop app or game, e.g. Rust, Go, Python, Swift): start it, press " +
    "`keys` to get past a start screen, capture its window over a few seconds and have a vision model compare the " +
    "frames with `expect`. Reports what each frame shows and every visible defect, then closes the program. Run it " +
    "after the program builds and before set_launch, and again after fixing what it reported. Do not write your " +
    "own screenshot or pixel-check code instead.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command that starts the program, e.g. cargo run --release",
      },
      cwd: {
        type: "string",
        description: "Folder to run it in, relative to the project root (default: root).",
      },
      expect: {
        type: "string",
        description:
          "What a correct window shows, concretely, e.g. 'a bird on the left; pairs of pipes, one from the top and " +
          "one from the bottom with a gap between them, scrolling left; the score at the top'.",
      },
      keys: {
        type: "array",
        items: { type: "string" },
        description:
          'Keys pressed before each frame after the first, e.g. ["space"] to start and keep a game going. ' +
          "Names: space, enter, up, down, left, right, escape, tab, or a single letter or digit. The program runs " +
          "with CDR_APP_CHECK=1 set.",
      },
      frames: { type: "integer", description: "Frames to capture (default 4, max 8)." },
      interval: { type: "integer", description: "Milliseconds between frames (default 700)." },
      wait: {
        type: "integer",
        description: "Seconds to wait for the window, including a build (default 180, max 600).",
      },
    },
    required: ["command", "expect"],
  },
  readOnly: false,
  shellCommand: (args: CheckAppArgs) => args?.command,
  risk: () => "medium",
  async execute(args: CheckAppArgs, ctx: ToolContext): Promise<ToolResult> {
    const command = args.command?.trim();
    if (!command) return { ok: false, output: "check_app needs a `command`." };
    if (/[\r\n]/.test(command))
      return { ok: false, output: "Give a single-line command (join steps with &&)." };
    if (!args.expect?.trim())
      return { ok: false, output: "Describe in `expect` what a correct window shows." };
    const abs = resolveInProject(ctx.projectRoot, args.cwd || ".");
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      return { ok: false, output: `No such folder: ${args.cwd}.` };

    const key = recordKey(ctx.projectRoot, command);
    const record = (verdict: AppCheckRecord["verdict"], problems: string[] = []) => {
      const prev = records.get(key);
      records.set(key, {
        at: Date.now(),
        verdict,
        problems,
        failures: verdict === "fail" ? (prev?.verdict === "fail" ? prev.failures : 0) + 1 : 0,
      });
    };

    const backend = windowBackend();
    if (!backend) {
      record("unverified");
      return {
        ok: true,
        output:
          "Windows cannot be captured on this machine, so the program was not looked at. Run it with run_app or " +
          "bash to make sure it starts, and tell the user that its appearance was not checked.",
      };
    }

    const frames = Math.min(8, Math.max(1, args.frames ?? 4));
    const interval = Math.min(5000, Math.max(100, args.interval ?? 700));
    const waitMs = Math.min(600, Math.max(5, args.wait ?? 180)) * 1000;
    const keys = (args.keys ?? []).map((k) => String(k).trim()).filter(Boolean);
    const work = mkdtempSync(join(tmpdir(), "cdr-check-app-"));
    const logPath = join(work, "output.log");
    const env = { ...process.env };
    for (const k of ctx.secretEnv) delete env[k];
    env.HARNESS = "1";
    env.CDR_APP_CHECK = "1"; // programs may start play by themselves under a check (see the keys fallback)
    env.NO_COLOR = "1";
    env.PYTHONUNBUFFERED = "1";
    const out = openSync(logPath, "w");
    const exit: { code?: number | null; done: boolean } = { done: false };
    let pid: number | undefined;
    try {
      const child = spawn("bash", ["-c", command], {
        cwd: abs,
        env,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.on("error", () => (exit.done = true));
      child.on("exit", (code) => {
        exit.code = code;
        exit.done = true;
      });
      child.unref();
      pid = child.pid;
    } finally {
      closeSync(out);
    }
    const log = () => {
      try {
        return tail(readFileSync(logPath, "utf8"));
      } catch {
        return "";
      }
    };
    if (!pid) {
      rmSync(work, { recursive: true, force: true });
      return { ok: false, output: `Could not start \`${command}\`.` };
    }

    try {
      // wait for a window (the command may build first)
      const started = Date.now();
      let win: AppWindow | undefined;
      while (!win) {
        if (exit.done) {
          const output = log();
          record(
            exit.code === 0 ? "unverified" : "fail",
            exit.code === 0 ? [] : ["The program exited with an error."],
          );
          return {
            ok: exit.code === 0,
            output: [
              exit.code === 0
                ? `\`${command}\` finished (exit code 0) without opening a window. If it is a CLI, that is fine; if it should show a window, it closed too early.`
                : `\`${command}\` exited with code ${exit.code ?? "unknown"} before opening a window.`,
              output ? `Last output:\n${output}` : "(no output)",
            ].join("\n"),
          };
        }
        if (Date.now() - started > waitMs || ctx.signal.aborted) {
          record("fail", ["No window appeared."]);
          return {
            ok: false,
            output: `No window from \`${command}\` appeared within ${Math.round(waitMs / 1000)} s.\nLast output:\n${log() || "(none)"}`,
          };
        }
        await sleep(500);
        // the largest window is the main one
        win = backend.list(processTree(pid)).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      }
      await sleep(1200); // first paint, fonts, assets

      const images: ImagePart[] = [];
      const notes: string[] = [];
      let keyError: string | undefined;
      let captureError: string | undefined;
      for (let i = 0; i < frames; i++) {
        if (i > 0) {
          if (keys.length && !keyError) {
            for (const k of keys) {
              keyError = backend.press(win, k);
              if (keyError) break;
            }
            notes.push(
              keyError
                ? `before frame ${i + 1}: could not press keys (${keyError})`
                : `before frame ${i + 1}: pressed ${keys.join(", ")}`,
            );
          }
          await sleep(interval);
        }
        if (exit.done) {
          notes.push(`the program exited (code ${exit.code ?? "unknown"}) before frame ${i + 1}`);
          break;
        }
        const file = join(work, `frame-${i + 1}.png`);
        captureError = backend.capture(win, file);
        if (captureError) break;
        images.push({
          mimeType: "image/png",
          data: readFileSync(file).toString("base64"),
          name: `frame-${i + 1}.png`,
        });
      }
      const crashed = exit.done;
      const output = log();

      if (!images.length) {
        record("unverified");
        return {
          ok: true,
          output: [
            `\`${command}\` opened a window (${win.width}×${win.height}), but it could not be captured: ${captureError ?? "unknown error"}.`,
            backend.permissionHint,
            "Tell the user that the program's appearance was not checked and how to allow it.",
          ].join("\n"),
        };
      }

      const head = [
        `Started \`${command}\` in ${rel(ctx.projectRoot, abs) || "."}; window ${win.width}×${win.height}${win.title ? ` "${win.title}"` : ""}.`,
        `Captured ${images.length} frame(s) ${interval} ms apart${notes.length ? `; ${notes.join("; ")}` : ""}.`,
      ];
      if (keyError)
        head.push(
          `Keys could not be pressed: ${keyError} ${backend.keysHint} The frames show the program without input. ` +
            "If it waits for a key to start, make it start play by itself when the environment variable CDR_APP_CHECK=1 " +
            "is set (check_app sets it), run check_app again, and tell the user how to allow key presses.",
        );
      if (crashed)
        head.push(`The program stopped while being checked.${output ? `\nLast output:\n${output}` : ""}`);

      // a separate look by a vision model: the agent that wrote the code tends to see what it meant to draw
      let review: Review | undefined;
      let reviewNote = "";
      if (ctx.complete) {
        const messages: ChatMessage[] = [
          { role: "system", content: APP_REVIEW_SYSTEM },
          {
            role: "user",
            content: `Expected: ${args.expect.trim()}\n\nCapture: ${head.join(" ")}`,
            images,
          },
        ];
        const model = ctx.config.appCheck?.model ?? "executor";
        try {
          // reasoning models spend part of the budget thinking before the JSON
          let text = await ctx.complete(model, messages, { maxTokens: 12_000 });
          if (/NO_IMAGES|cannot view images/i.test(text)) reviewNote = "The review model cannot view images.";
          else {
            review = parseReview(text);
            if (!review) {
              const retry = await ctx.complete(
                model,
                [
                  ...messages,
                  { role: "assistant", content: text },
                  {
                    role: "user",
                    content: "Reply again with ONLY the JSON object in a ```json block, valid JSON.",
                  },
                ],
                { maxTokens: 12_000 },
              );
              review = parseReview(retry);
              if (!review && retry.trim()) text = retry;
            }
            if (!review)
              reviewNote = text.trim()
                ? `The review model's notes (no structured verdict):\n${text.trim().slice(0, 4000)}\n`
                : "The review model returned nothing.";
          }
        } catch (e) {
          reviewNote = `The visual review failed: ${(e as Error).message}`;
        }
      } else reviewNote = "No review model is available here.";

      const lines = [...head];
      if (review) {
        const problems = [...review.problems, ...(crashed ? ["The program exited while running."] : [])];
        lines.push(
          "What the frames show:",
          ...review.frames.map((f, i) => `- frame ${i + 1}: ${f}`),
          problems.length
            ? `Problems to fix (${problems.length}):\n${problems.map((p) => `- ${p}`).join("\n")}\nFix them in the code, then run check_app again.`
            : "No visible problems: it matches the expectation.",
        );
        record(problems.length ? "fail" : "pass", problems);
        return { ok: problems.length === 0, output: lines.join("\n"), images };
      }
      lines.push(
        `${reviewNote} The frames are attached: look at them yourself and compare them with what you expected. ` +
          "If you cannot see them, tell the user the appearance was not checked (set `appCheck.model` to a vision model).",
      );
      record(crashed ? "fail" : "unverified", crashed ? ["The program exited while running."] : []);
      return { ok: !crashed, output: lines.join("\n"), images };
    } finally {
      killGroup(pid);
      rmSync(work, { recursive: true, force: true });
    }
  },
};
