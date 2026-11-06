import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  /** The current listeners, for `restoreListeners` once a lease of a reused browser ends. */
  listenerMark(): Set<(method: string, params: any, sessionId?: string) => void> {
    return new Set(this.listeners);
  }

  /** Remove every listener added since `mark` was taken. */
  restoreListeners(mark: Set<(method: string, params: any, sessionId?: string) => void>): void {
    for (const l of [...this.listeners]) if (!mark.has(l)) this.listeners.delete(l);
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
  /** The temporary profile folder (holds `DevToolsActivePort` when started with --remote-debugging-port). */
  profile: string;
  /** Whether the browser keeps Node's event loop alive (off while it waits idle in the pool). */
  ref(on: boolean): void;
  /** Kill at once and delete the profile synchronously (process exit). */
  killSync(): void;
  /** Close Chrome (gracefully when possible), wait for it to exit and delete its profile. Never throws. */
  close(): Promise<void>;
}

/**
 * Start headless Chrome on a pipe with a fresh profile (deleted on close). A start that does not answer in
 * time is tried once more: on a busy machine the first start of a browser can take longer than the timeout.
 */
export async function launchChrome(
  chrome: string,
  opts: { args?: string[]; signal?: AbortSignal } = {},
): Promise<Browser> {
  try {
    return await launchOnce(chrome, opts);
  } catch (e) {
    if (opts.signal?.aborted || !/timed out/.test((e as Error).message)) throw e;
    return launchOnce(chrome, opts);
  }
}

async function launchOnce(chrome: string, opts: { args?: string[]; signal?: AbortSignal }): Promise<Browser> {
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
    const streams = [child.stdio[3], child.stdio[4]] as unknown as { ref?(): void; unref?(): void }[];
    return {
      cdp,
      profile,
      ref: (on) => {
        if (on) child?.ref();
        else child?.unref();
        for (const st of streams) (on ? st.ref : st.unref)?.call(st);
      },
      killSync: () => {
        closed = true;
        kill();
        try {
          rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        } catch {
          /* Chrome may still be writing; a leftover temp dir is harmless */
        }
      },
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

/**
 * A browser handed out by `leaseChrome`: exclusive until `close`, with its own browser context (fresh cookies,
 * cache and storage, like a fresh profile). Create every target in `contextId`.
 */
export interface BrowserLease {
  cdp: Cdp;
  contextId: string;
  /** Hand the browser back to the pool (its context disposed, listeners removed), or close it when broken. Never throws. */
  close(): Promise<void>;
}

/** How long a returned browser waits for the next lease before it is closed (`HARNESS_CHROME_IDLE_MS`). */
function poolIdleMs(): number {
  const v = Number(process.env.HARNESS_CHROME_IDLE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 120_000;
}
const POOL_MAX_IDLE = 2;
const pool = new Map<string, { browser: Browser; timer: ReturnType<typeof setTimeout> }[]>();
const live = new Set<Browser>();
let exitHook = false;

function track(b: Browser) {
  live.add(b);
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => {
    for (const x of live) x.killSync();
  });
}

function park(key: string, browser: Browser) {
  const list = pool.get(key) ?? [];
  if (list.length >= POOL_MAX_IDLE) {
    live.delete(browser);
    void browser.close();
    return;
  }
  browser.ref(false);
  const entry = {
    browser,
    timer: setTimeout(() => {
      const l = pool.get(key);
      if (l)
        pool.set(
          key,
          l.filter((x) => x !== entry),
        );
      live.delete(browser);
      void browser.close();
    }, poolIdleMs()),
  };
  entry.timer.unref?.();
  list.push(entry);
  pool.set(key, list);
}

/**
 * Lease a headless Chrome from a per-process pool: a browser returned by an earlier lease is reused (each lease
 * gets a new browser context), so back-to-back captures, shots and probes skip Chrome's start-up. Leases are
 * exclusive: concurrent callers get separate browsers. An abort closes the leased browser.
 */
export async function leaseChrome(
  chrome: string,
  opts: { args?: string[]; signal?: AbortSignal } = {},
): Promise<BrowserLease> {
  if (opts.signal?.aborted) throw new Error("Cancelled.");
  const key = JSON.stringify([chrome, opts.args ?? []]);
  let browser: Browser | undefined;
  for (let e = pool.get(key)?.pop(); e; e = pool.get(key)?.pop()) {
    clearTimeout(e.timer);
    if (!e.browser.cdp.closed) {
      browser = e.browser;
      break;
    }
    live.delete(e.browser);
    void e.browser.close();
  }
  if (browser) browser.ref(true);
  else {
    // no signal: the browser outlives this lease; the lease's own abort handler closes it
    browser = await launchChrome(chrome, { args: opts.args });
    track(browser);
  }
  if (opts.signal?.aborted) {
    park(key, browser);
    throw new Error("Cancelled.");
  }
  const b = browser;
  const { cdp } = b;
  const mark = cdp.listenerMark();
  let broken = false;
  const abort = () => {
    broken = true;
    live.delete(b);
    void b.close();
  };
  let contextId: string;
  try {
    contextId = (await cdp.send("Target.createBrowserContext", {}, null, 10_000)).browserContextId;
  } catch (e) {
    live.delete(b);
    await b.close();
    throw e;
  }
  opts.signal?.addEventListener("abort", abort, { once: true });
  let done = false;
  return {
    cdp,
    contextId,
    close: async () => {
      if (done) return;
      done = true;
      opts.signal?.removeEventListener("abort", abort);
      cdp.restoreListeners(mark);
      const reset =
        !broken &&
        !cdp.closed &&
        (await Promise.all([
          cdp.send(
            "Target.setAutoAttach",
            { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
            null,
            3000,
          ),
          cdp.send("Target.disposeBrowserContext", { browserContextId: contextId }, null, 5000),
        ]).then(
          () => true,
          () => false,
        ));
      if (reset) park(key, b);
      else {
        live.delete(b);
        await b.close();
      }
    },
  };
}

/** Close every idle pooled browser and the shared script browser now (tests, shutdown). */
export async function drainChromePool(): Promise<void> {
  const all = [...pool.values()].flat();
  pool.clear();
  const shared = debugChrome;
  debugChrome = undefined;
  if (shared?.timer) clearTimeout(shared.timer);
  if (shared) live.delete(shared.browser);
  await Promise.all([
    ...all.map((e) => {
      clearTimeout(e.timer);
      live.delete(e.browser);
      return e.browser.close();
    }),
    ...(shared ? [shared.browser.close()] : []),
  ]);
}

let debugChrome:
  { browser: Browser; endpoint: Promise<ChromeEndpoint>; timer?: ReturnType<typeof setTimeout> } | undefined;

export interface ChromeEndpoint {
  /** Browser-level DevTools WebSocket URL (puppeteer.connect / playwright connectOverCDP). */
  wsUrl: string;
  port: number;
}

/**
 * One long-lived headless Chrome per process with a DevTools port on 127.0.0.1, for the agent's own scripts:
 * they connect to it instead of starting and killing a browser each time. Closed after `idleMs` without a call.
 */
export async function sharedChromeEndpoint(chrome: string, idleMs = 15 * 60_000): Promise<ChromeEndpoint> {
  if (debugChrome && debugChrome.browser.cdp.closed) {
    live.delete(debugChrome.browser);
    debugChrome.browser.killSync();
    debugChrome = undefined;
  }
  if (!debugChrome) {
    const browser = await launchChrome(chrome, {
      args: ["--remote-debugging-port=0", "--allow-file-access-from-files"],
    });
    track(browser);
    browser.ref(false);
    const endpoint = (async () => {
      const file = join(browser.profile, "DevToolsActivePort");
      for (let i = 0; i < 100; i++) {
        try {
          const [port, path] = readFileSync(file, "utf8").split("\n");
          if (port && path) return { port: Number(port), wsUrl: `ws://127.0.0.1:${port}${path.trim()}` };
        } catch {
          /* not written yet */
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("Chrome did not report its DevTools port.");
    })();
    debugChrome = { browser, endpoint };
    endpoint.catch(() => {
      if (debugChrome?.browser === browser) debugChrome = undefined;
      live.delete(browser);
      void browser.close();
    });
  }
  const d = debugChrome;
  if (d.timer) clearTimeout(d.timer);
  d.timer = setTimeout(() => {
    if (debugChrome !== d) return;
    debugChrome = undefined;
    live.delete(d.browser);
    void d.browser.close();
  }, idleMs);
  d.timer.unref?.();
  return d.endpoint;
}
