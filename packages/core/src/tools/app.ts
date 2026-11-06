import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { harnessHome } from "../config.js";
import { bwrapArgs } from "../shell.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { rel, resolveInProject } from "./paths.js";

/** A program started with `run_app`. It runs in its own process group and outlives the turn that started it. */
export interface AppRecord {
  command: string;
  /** Folder relative to the project root ("" for the root). */
  cwd: string;
  /** URL to wait for, when the caller named one. */
  url?: string;
  /** Process group leader; unset once the app was stopped or found dead. */
  pid?: number;
  /** Kernel start time of `pid` (Linux), so a reused pid is not mistaken for the app. */
  procStart?: string;
  startedAt: string;
  log: string;
  /** URLs that answered the last time they were checked. */
  urls: string[];
}

interface AppState {
  projectRoot: string;
  /** Most recently started first. */
  apps: AppRecord[];
}

const canonical = (p: string) => (existsSync(p) ? realpathSync(p) : p);
const projectKey = (root: string) => createHash("sha256").update(canonical(root)).digest("hex").slice(0, 16);
const appsDir = () => join(harnessHome(), "apps");
const stateFile = (root: string) => join(appsDir(), `${projectKey(root)}.json`);

function loadState(root: string): AppState {
  try {
    const s = JSON.parse(readFileSync(stateFile(root), "utf8")) as AppState;
    if (Array.isArray(s.apps)) return s;
  } catch {
    /* nothing remembered yet */
  }
  return { projectRoot: canonical(root), apps: [] };
}

function saveState(root: string, state: AppState): void {
  mkdirSync(appsDir(), { recursive: true });
  writeFileSync(stateFile(root), JSON.stringify(state, null, 2));
}

/** The app commands remembered for a project, most recently started first. */
export function rememberedApps(projectRoot: string): AppRecord[] {
  return loadState(projectRoot).apps;
}

function procStart(pid: number): string | undefined {
  try {
    // field 22 of /proc/<pid>/stat, counted after the parenthesised command name
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** True while the process group started for `app` still exists. */
export function appAlive(app: AppRecord): boolean {
  if (!app.pid) return false;
  try {
    process.kill(-app.pid, 0);
  } catch {
    return false;
  }
  const now = procStart(app.pid);
  // the leader may have exited while children keep the group alive: only a different start time is a reused pid
  return !(app.procStart && now && now !== app.procStart);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s"'<>()[\]]*)?/g;

/** Local URLs a program announced in its output (`Local: http://localhost:5173/`), in order of appearance. */
export function localUrls(log: string): string[] {
  const found = new Set<string>();
  for (const m of log.replace(ANSI, "").matchAll(LOCAL_URL)) {
    found.add(m[0].replace(/\/\/(?:0\.0\.0\.0|\[::\])/, "//localhost").replace(/[.,;:!?]+$/, ""));
  }
  return [...found];
}

async function answers(url: string): Promise<number | undefined> {
  try {
    // any HTTP status counts: a login redirect or a 404 at "/" still means the server is up
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1500) });
    await r.body?.cancel();
    return r.status;
  } catch {
    return undefined;
  }
}

function readLog(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function tail(text: string, lines = 12): string {
  const all = text.replace(ANSI, "").trimEnd().split("\n");
  return all
    .slice(-lines)
    .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
    .join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Readiness {
  up: Array<{ url: string; status: number }>;
  down: string[];
  /** Exit code when the process ended while waiting. */
  exited?: number | null;
  waitedMs: number;
}

/** After the first URL answers: how long to wait for announced URLs that do not answer yet. */
const SETTLE_MS = 2500;
/** After the first URL answers: how long to watch the output for a further URL. */
const SECOND_URL_MS = 500;

/** Wait until the app answers on a URL (the one named, or those it printed), it exits, or `waitMs` passes. */
async function waitReady(
  app: AppRecord,
  waitMs: number,
  signal: AbortSignal,
  exit: { code?: number | null; done: boolean },
): Promise<Readiness> {
  const started = Date.now();
  let firstUp: number | undefined;
  for (;;) {
    const candidates = [...new Set([...(app.url ? [app.url] : []), ...localUrls(readLog(app.log))])];
    const checked = await Promise.all(candidates.map(async (url) => ({ url, status: await answers(url) })));
    const up = checked.filter((c): c is { url: string; status: number } => c.status !== undefined);
    const down = checked.filter((c) => c.status === undefined).map((c) => c.url);
    const waitedMs = Date.now() - started;
    const result = { up, down, waitedMs };
    if (exit.done || !appAlive(app)) {
      // the group is gone: give the exit event a moment to report the code
      if (!exit.done) await sleep(100);
      return { ...result, exited: exit.done ? exit.code : null };
    }
    if (up.length) {
      firstUp ??= Date.now();
      // a second server of the same app is often announced a moment after the first one answers
      const settled = Date.now() - firstUp;
      if (settled >= SETTLE_MS || (!down.length && settled >= SECOND_URL_MS)) return result;
    }
    if (waitedMs >= waitMs || signal.aborted) return result;
    await sleep(200);
  }
}

function describe(app: AppRecord, r: Readiness, lead: string): ToolResult {
  const lines = [lead];
  // after a failure, whatever still answers on those addresses is not this program
  if (r.exited === undefined || r.exited === 0) {
    if (r.up.length) lines.push(`Open: ${r.up.map((u) => `${u.url} (HTTP ${u.status})`).join(", ")}`);
    if (r.down.length) lines.push(`Not answering${r.up.length ? " yet" : ""}: ${r.down.join(", ")}`);
  }
  const log = tail(readLog(app.log));
  if (log) lines.push(`Last output (full log: ${app.log}):\n${log}`);
  if (r.exited !== undefined) return { ok: r.exited === 0, output: lines.join("\n") };
  lines.push(
    r.up.length
      ? "It keeps running in the background. Give the user the URL(s) and finish: no further checks are needed. Stop it with stop_app."
      : "It keeps running in the background. If it is still building, call run_app again to wait for it; stop it with stop_app.",
  );
  return { ok: true, output: lines.join("\n") };
}

interface RunAppArgs {
  command?: string;
  cwd?: string;
  url?: string;
  wait?: number;
}

/** The command a `run_app` call would start: the one given, else the one last used in this project. */
function plannedCommand(args: RunAppArgs | undefined, projectRoot: string | undefined): string | undefined {
  const command = args?.command?.trim();
  if (command) return command;
  return projectRoot ? rememberedApps(projectRoot)[0]?.command : undefined;
}

export const runAppTool: Tool = {
  name: "run_app",
  description:
    "Start the project's app or dev server in the background and wait until it answers. Returns the local URL(s) " +
    "it serves and the last output, usually within seconds. The program keeps running after the turn ends. " +
    "Call it WITHOUT a command to start the command that was used before in this project; it reports when " +
    "there is none yet. If the same command is already running it only reports its state, so calling it again " +
    "is cheap. Use this instead of `bash` for anything long-running (servers, watchers, GUI programs).",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "Shell command that starts the app, e.g. ./start.sh, npm run dev, python manage.py runserver.",
      },
      cwd: {
        type: "string",
        description: "Folder to run it in, relative to the project root (default: the project root).",
      },
      url: {
        type: "string",
        description:
          "URL to wait for, e.g. http://localhost:3000/. Only needed when the program does not print its URL.",
      },
      wait: {
        type: "integer",
        description:
          "Seconds to wait for the app to answer (default 60, max 600; raise it when a build runs first).",
      },
    },
  },
  readOnly: false,
  shellCommand: (args: RunAppArgs, ctx) => plannedCommand(args, ctx?.projectRoot),
  risk(args: RunAppArgs, ctx) {
    // reporting on an app that already runs starts nothing
    const command = plannedCommand(args, ctx?.projectRoot);
    const running = ctx && rememberedApps(ctx.projectRoot).find((a) => a.command === command && appAlive(a));
    return running ? "low" : "medium";
  },
  async execute(args: RunAppArgs, ctx: ToolContext): Promise<ToolResult> {
    const state = loadState(ctx.projectRoot);
    const command = args.command?.trim() || state.apps[0]?.command;
    if (!command)
      return {
        ok: false,
        output:
          "No app command is known for this project yet. Find how it starts (README, package.json scripts, " +
          "a start script, Makefile) and call run_app with that `command`.",
      };
    if (/[\r\n]/.test(command))
      return { ok: false, output: "Give a single-line command (join steps with &&)." };
    const remembered = state.apps.find((a) => a.command === command);
    const abs = resolveInProject(ctx.projectRoot, args.cwd || remembered?.cwd || ".");
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      return { ok: false, output: `No such folder: ${args.cwd}.` };
    const cwd = rel(ctx.projectRoot, abs);
    const waitMs = Math.min(600, Math.max(1, args.wait ?? 60)) * 1000;
    const url = args.url?.trim() || remembered?.url;

    if (remembered && appAlive(remembered)) {
      if (url) remembered.url = url;
      const r = await waitReady(remembered, waitMs, ctx.signal, { done: false });
      remembered.urls = r.up.map((u) => u.url);
      const pid = remembered.pid;
      if (r.exited !== undefined) remembered.pid = undefined;
      saveState(ctx.projectRoot, state);
      return describe(
        remembered,
        r,
        r.exited !== undefined
          ? `\`${command}\` was running (pid ${pid}) but has just stopped. Call run_app again to restart it.`
          : `\`${command}\` is already running (pid ${pid}).`,
      );
    }

    mkdirSync(appsDir(), { recursive: true });
    const log = join(
      appsDir(),
      `${projectKey(ctx.projectRoot)}-${createHash("sha256").update(command).digest("hex").slice(0, 8)}.log`,
    );
    const env = { ...process.env };
    for (const k of ctx.secretEnv) delete env[k];
    env.HARNESS = "1";
    env.BROWSER = "none"; // dev servers must not open a browser window of their own
    env.NO_COLOR = "1";
    env.PYTHONUNBUFFERED = "1"; // Python holds back output written to a file, and with it the URL it prints
    let file = "bash";
    let argv = ["-c", command];
    if (ctx.config.sandbox === "bwrap") {
      if (!existsSync("/usr/bin/bwrap") && !existsSync("/bin/bwrap"))
        return { ok: false, output: "Sandbox 'bwrap' requested but bubblewrap is not installed." };
      file = "bwrap";
      argv = [...bwrapArgs(abs, !!ctx.config.sandboxNetwork), "bash", "-c", command];
    }
    const out = openSync(log, "w");
    const exit: { code?: number | null; done: boolean } = { done: false };
    let pid: number | undefined;
    try {
      const child = spawn(file, argv, { cwd: abs, env, detached: true, stdio: ["ignore", out, out] });
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
    if (!pid) return { ok: false, output: `Could not start \`${command}\`.` };
    const app: AppRecord = {
      command,
      cwd: cwd === "." ? "" : cwd,
      ...(url ? { url } : {}),
      pid,
      procStart: procStart(pid),
      startedAt: new Date().toISOString(),
      log,
      urls: [],
    };
    state.apps = [app, ...state.apps.filter((a) => a.command !== command)].slice(0, 8);
    saveState(ctx.projectRoot, state);

    const r = await waitReady(app, waitMs, ctx.signal, exit);
    app.urls = r.up.map((u) => u.url);
    if (r.exited !== undefined) app.pid = undefined;
    saveState(ctx.projectRoot, state);
    const seconds = (r.waitedMs / 1000).toFixed(1);
    if (r.exited !== undefined)
      return describe(
        app,
        r,
        r.exited === 0
          ? `\`${command}\` finished (exit code 0) after ${seconds} s; nothing is left running.`
          : `\`${command}\` stopped after ${seconds} s (exit code ${r.exited ?? "unknown"}).`,
      );
    return describe(
      app,
      r,
      r.up.length
        ? `Started \`${command}\` (pid ${pid}); it answered after ${seconds} s.`
        : `Started \`${command}\` (pid ${pid}); it runs, but no URL answered within ${seconds} s.`,
    );
  },
};

/** End the process group of `app`: SIGTERM, then SIGKILL if it has not gone within `graceMs`. */
export async function stopApp(app: AppRecord, graceMs = 3000): Promise<boolean> {
  if (!appAlive(app) || !app.pid) return false;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-app.pid!, sig);
    } catch {
      /* already gone */
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (appAlive(app) && Date.now() < deadline) await sleep(50);
  if (appAlive(app)) signal("SIGKILL");
  return true;
}

export const stopAppTool: Tool = {
  name: "stop_app",
  description:
    "Stop what `run_app` started in this project: every running app, or only the one with the given command.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Stop only the app started with this command." },
    },
  },
  readOnly: false,
  risk: () => "low",
  async execute(args: { command?: string }, ctx): Promise<ToolResult> {
    const state = loadState(ctx.projectRoot);
    const wanted = args.command?.trim();
    const stopped: string[] = [];
    for (const app of state.apps) {
      if (wanted && app.command !== wanted) continue;
      if (await stopApp(app)) stopped.push(`\`${app.command}\``);
      app.pid = undefined;
      app.urls = [];
    }
    saveState(ctx.projectRoot, state);
    return {
      ok: true,
      output: stopped.length ? `Stopped ${stopped.join(", ")}.` : "Nothing started with run_app was running.",
    };
  },
};
