/**
 * Re-running pipeline steps after a patch. The loop only knows the `StepRunner` interface; the CLI supplies the real
 * implementation (the same `buildStep` + `runStep` as `pnpm migrate <step>`), tests supply fakes.
 *
 * "build" contract (docs/autofix-notes.md, W1-C): `pnpm exec next build` in the app dir with CCM_DIR=<ws>/ccm, then
 * (re)start `pnpm exec next start -p <appPort>` as a child of the loop and wait for HTTP < 500 on "/".
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { StepReport } from "@harness/mirror-core";
import type { RerunStep, VerifyScope } from "./types.js";

export interface RerunOptions {
  /** verify scope (checks / urls / viewports) for a "verify" step */
  verify?: VerifyScope;
  /** Candidate.stepOptions[step] */
  options?: Record<string, unknown>;
}

export interface StepRunner {
  /** run one step; resolves with its report (a crashing step resolves ok:false + STEP_FAILED, like runStep) */
  run(step: RerunStep, opts?: RerunOptions): Promise<StepReport>;
  /** stop anything the runner started (app server) */
  close?(): Promise<void>;
}

/** Thrown by a runner when the environment, not the candidate, prevents the step (e.g. foreign process on the app port). */
export class RerunEnvironmentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RerunEnvironmentError";
  }
}

function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => res(e.code !== "EADDRINUSE" && e.code !== "EACCES"));
    s.listen(port, host, () => s.close(() => res(true)));
  });
}

/** true when nothing listens on the port (IPv4 + IPv6 bind test, and nothing answers HTTP on localhost) */
export async function portFree(port: number): Promise<boolean> {
  if (!(await bindable(port, "127.0.0.1"))) return false;
  if (!(await bindable(port, "::"))) return false;
  const answers = await fetch(`http://localhost:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(2000) }).then(
    () => true,
    () => false,
  );
  return !answers;
}

async function waitHttp(url: string, timeoutMs: number, child?: ChildProcess): Promise<void> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    if (child && child.exitCode !== null) throw new Error(`app server exited with code ${child.exitCode} before answering ${url}`);
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`app did not answer ${url} within ${Math.round(timeoutMs / 1000)} s (${last})`);
}

export interface AppServerOptions {
  appDir: string;
  port: number;
  env?: Record<string, string>;
  /** replaces process.env as the base of the app's environment */
  baseEnv?: NodeJS.ProcessEnv;
  /** command overrides (tests) */
  buildCmd?: [string, string[]];
  startCmd?: (port: number) => [string, string[]];
  readyTimeoutMs?: number;
  buildTimeoutMs?: number;
  onLog?: (line: string) => void;
}

/** Build + (re)start of the app under test. Only ever stops servers it started itself. */
export class AppServer {
  private child?: ChildProcess;
  constructor(private readonly o: AppServerOptions) {}

  get running(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  async build(): Promise<{ ok: boolean; output: string; durationMs: number }> {
    const t0 = Date.now();
    const [cmd, args] = this.o.buildCmd ?? ["pnpm", ["exec", "next", "build"]];
    const { code, output } = await runCmd(cmd, args, this.o.appDir, this.env(), this.o.buildTimeoutMs ?? 900_000);
    return { ok: code === 0, output, durationMs: Date.now() - t0 };
  }

  async restart(): Promise<void> {
    await this.stop();
    if (!(await portFree(this.o.port))) throw new RerunEnvironmentError(`port ${this.o.port} is bound by a process autofix did not start — stop it or pass --app-port`, "AUTOFIX_APP_PORT_BUSY");
    const [cmd, args] = this.o.startCmd ? this.o.startCmd(this.o.port) : ["pnpm", ["exec", "next", "start", "-p", String(this.o.port)]];
    const child = spawn(cmd, args, { cwd: this.o.appDir, env: this.env(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    child.stdout?.on("data", (d) => this.o.onLog?.(String(d)));
    child.stderr?.on("data", (d) => this.o.onLog?.(String(d)));
    this.child = child;
    await waitHttp(`http://localhost:${this.o.port}/`, this.o.readyTimeoutMs ?? 180_000, child);
  }

  async stop(): Promise<void> {
    const c = this.child;
    this.child = undefined;
    if (!c || c.exitCode !== null) return;
    await new Promise<void>((res) => {
      const done = () => res();
      c.once("exit", done);
      try {
        // detached → own process group: kill pnpm + next together
        if (c.pid && process.platform !== "win32") process.kill(-c.pid, "SIGTERM");
        else c.kill("SIGTERM");
      } catch {
        res();
      }
      setTimeout(() => {
        try {
          if (c.pid && process.platform !== "win32") process.kill(-c.pid, "SIGKILL");
          else c.kill("SIGKILL");
        } catch {
          /* gone */
        }
        res();
      }, 10_000).unref();
    });
  }

  private env(): NodeJS.ProcessEnv {
    return { ...(this.o.baseEnv ?? process.env), NEXT_TELEMETRY_DISABLED: "1", ...(this.o.env ?? {}) };
  }
}

function runCmd(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (d: unknown) => {
      out += String(d);
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(t);
      res({ code: -1, output: out + String(e.message) });
    });
    child.on("exit", (code) => {
      clearTimeout(t);
      res({ code: code ?? -1, output: out });
    });
  });
}
