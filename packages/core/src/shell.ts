import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface ShellOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Env var names to remove from the child environment (e.g. provider API keys). */
  stripEnv?: string[];
  sandbox?: "none" | "bwrap";
  /** Allow network inside the sandbox (default false). */
  network?: boolean;
  maxOutput?: number;
  /** Extra variables for the child environment. */
  env?: Record<string, string>;
}

export interface ShellResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

export function bwrapArgs(cwd: string, network: boolean): string[] {
  const args = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--bind",
    cwd,
    cwd,
    "--chdir",
    cwd,
    "--die-with-parent",
    "--unshare-pid",
  ];
  if (!network) args.push("--unshare-net");
  return args;
}

/** Run a shell command, capturing interleaved stdout/stderr. Kills the whole process group on timeout/abort. */
export function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of opts.stripEnv ?? []) delete env[k];
    Object.assign(env, opts.env);
    env.HARNESS = "1";
    env.CI = env.CI ?? "1"; // discourage interactive prompts / watch modes
    let file = "bash";
    let args = ["-c", command];
    if (opts.sandbox === "bwrap") {
      if (!existsSync("/usr/bin/bwrap") && !existsSync("/bin/bwrap")) {
        return resolve({
          exitCode: 127,
          output: "Sandbox 'bwrap' requested but bubblewrap is not installed.",
          timedOut: false,
          aborted: false,
        });
      }
      file = "bwrap";
      // Home is read-only inside the sandbox: send package-manager caches to the tmpfs.
      env.npm_config_cache = "/tmp/.npm";
      env.PIP_CACHE_DIR = "/tmp/.pip";
      env.YARN_CACHE_FOLDER = "/tmp/.yarn";
      env.PNPM_HOME = "/tmp/.pnpm";
      env.XDG_CACHE_HOME = "/tmp/.cache";
      args = [...bwrapArgs(opts.cwd, !!opts.network), "bash", "-c", command];
    }
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const max = opts.maxOutput ?? 2_000_000;
    let output = "";
    let timedOut = false;
    let aborted = false;
    const onData = (d: Buffer) => {
      if (output.length < max) output += d.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      output += `\n${e.message}`;
    });
    let done = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, sig: NodeJS.Signals | null, detached = false) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (drain) clearTimeout(drain);
      opts.signal?.removeEventListener("abort", onAbort);
      let exitCode = code ?? (sig ? 128 : 1);
      if (timedOut) {
        output += `\n[harness] command timed out after ${opts.timeoutMs} ms and was killed`;
        exitCode = 124;
      }
      if (aborted) output += `\n[harness] command aborted`;
      if (detached && !timedOut && !aborted)
        output += `\n[harness] the command left a background process running; its later output is not captured`;
      resolve({ exitCode, output, timedOut, aborted });
    };
    // A job the command left in the background (`server &`) keeps the output pipes open long after the shell
    // itself is done. Do not wait for it: return once the shell has exited and its own output is read.
    child.on("exit", (code, sig) => {
      drain = setTimeout(() => {
        for (const stream of [child.stdout, child.stderr]) {
          stream.off("data", onData);
          // keep reading (and dropping) so the background job never writes into a closed pipe
          stream.resume();
          (stream as unknown as { unref?(): void }).unref?.();
        }
        finish(code, sig, true);
      }, EXIT_DRAIN_MS);
    });
    child.on("close", (code, sig) => finish(code, sig));
  });
}

/** How long the output pipes may stay open after the shell exited before the command counts as finished. */
const EXIT_DRAIN_MS = 250;
