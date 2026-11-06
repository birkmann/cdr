import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * Dependency-free DevTools protocol client on a pipe (--remote-debugging-pipe: fd 3 in, fd 4 out, NUL-separated
 * JSON), flat sessions. Shared by core's check_preview probe and the capture driver. Incoming data is kept as a
 * chunk list and only the newest chunk is searched for the separator, so a 100 MB snapshot message stays linear.
 */
export class Cdp {
  private nextId = 1;
  private chunks: Buffer[] = [];
  private readonly waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
  closed = false;

  constructor(
    private readonly input: Writable,
    output: Readable,
  ) {
    output.on("data", (chunk: Buffer) => {
      let start = 0;
      let i: number;
      while ((i = chunk.indexOf(0, start)) >= 0) {
        this.chunks.push(chunk.subarray(start, i));
        const raw = Buffer.concat(this.chunks).toString("utf8");
        this.chunks = [];
        start = i + 1;
        this.dispatch(raw);
      }
      if (start < chunk.length) this.chunks.push(chunk.subarray(start));
    });
    output.on("close", () => this.fail(new Error("Browser closed unexpectedly.")));
    input.on("error", () => this.fail(new Error("Browser pipe closed.")));
  }

  private dispatch(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.waiting.has(msg.id)) {
      const w = this.waiting.get(msg.id)!;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message ?? "CDP error"));
      else w.resolve(msg.result);
    } else if (msg.method)
      for (const l of [...this.listeners]) {
        try {
          l(msg.method, msg.params, msg.sessionId);
        } catch {
          /* a listener's bug must not break the transport */
        }
      }
  }

  private fail(e: Error) {
    this.closed = true;
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
  }

  /** Subscribe to protocol events; returns the unsubscribe. */
  on(l: (method: string, params: any, sessionId?: string) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string | null,
    timeoutMs = 20_000,
  ): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Browser is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }

  /** Resolves true on the next `method` event of `sessionId`, false after `timeoutMs`. */
  waitFor(method: string, sessionId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let off = () => {};
      const timer = setTimeout(() => (off(), resolve(false)), timeoutMs);
      off = this.on((m, _p, s) => {
        if (m === method && s === sessionId) {
          clearTimeout(timer);
          off();
          resolve(true);
        }
      });
    });
  }

  /** `Runtime.evaluate` of an expression returning JSON (promises awaited); script exceptions become errors. */
  async eval(sessionId: string, expression: string, timeoutMs = 20_000, contextId?: number): Promise<any> {
    const r = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: timeoutMs,
        ...(contextId !== undefined ? { contextId } : {}),
      },
      sessionId,
      timeoutMs + 5000,
    );
    if (r?.exceptionDetails) {
      const msg: string =
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "script error";
      throw new Error(msg.split("\n")[0]);
    }
    return r?.result?.value ?? null;
  }
}

const CHROME_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
];
const MAC_CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
let chromePath: string | null | undefined;

/** Chrome / Chromium on this machine (`HARNESS_CHROME` overrides), or null. Cached. */
export function findChrome(): string | null {
  if (chromePath !== undefined) return chromePath;
  if (process.env.HARNESS_CHROME) return (chromePath = process.env.HARNESS_CHROME);
  for (const c of CHROME_CANDIDATES) {
    const r = spawnSync("which", [c], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return (chromePath = r.stdout.trim());
  }
  if (process.platform === "darwin")
    for (const p of MAC_CHROME) if (spawnSync("test", ["-x", p]).status === 0) return (chromePath = p);
  return (chromePath = null);
}

export interface Browser {
  cdp: Cdp;
  /** Close Chrome (gracefully when possible), wait for it to exit and delete its profile. Never throws. */
  close(): Promise<void>;
}

/** Start headless Chrome on a pipe with a fresh profile (deleted on close). */
export async function launchChrome(
  chrome: string,
  opts: { args?: string[]; signal?: AbortSignal } = {},
): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "harness-chrome-"));
  let child: ChildProcess | undefined;
  const kill = () => {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  opts.signal?.addEventListener("abort", kill, { once: true });
  let closed = false;
  const close = async (graceful: boolean) => {
    if (closed) return;
    closed = true;
    opts.signal?.removeEventListener("abort", kill);
    // Wait for Chrome to exit before deleting its profile: it keeps writing into the profile while shutting
    // down, which makes rmdir fail with ENOTEMPTY.
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child!.once("exit", () => r()));
      const done =
        graceful &&
        (await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 2_000)),
        ]));
      if (!done) {
        kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2_000))]);
      }
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* leftover temp dir is harmless */
    }
  };
  try {
    child = spawn(
      chrome,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        "--hide-scrollbars",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        ...(opts.args ?? []),
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    const spawnError = new Promise<never>((_, reject) => child!.once("error", reject));
    const cdp = new Cdp(child.stdio[3] as Writable, child.stdio[4] as Readable);
    // the pipe is up once the browser answers
    await Promise.race([cdp.send("Browser.getVersion"), spawnError]);
    return {
      cdp,
      close: async () => {
        const graceful =
          !cdp.closed &&
          (await cdp.send("Browser.close", {}, null, 3000).then(
            () => true,
            () => false,
          ));
        await close(graceful);
      },
    };
  } catch (e) {
    await close(false);
    throw e;
  }
}
