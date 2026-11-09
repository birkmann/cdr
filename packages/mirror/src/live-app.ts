// The generated app of a finished mirror run, started on demand so the page can be viewed as it really behaves. A
// static copy cannot do that: sites load more code at runtime from root-relative paths, and files the crawl never saw
// reach the source through the app's rewrites. Each app gets its own loopback origin, away from the UI's storage.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { RunDir } from "@harness/recreate";
import { APP_DIR, freePort, nextBin } from "./app.js";

const MAX_APPS = 3;
const READY_TIMEOUT_MS = 60_000;

interface LiveApp {
  child: ChildProcess;
  origin: string;
  buildId: string;
  used: number;
  ready: Promise<void>;
}

const apps = new Map<string, LiveApp>();

export interface OpenMirrorApp {
  projectRoot: string;
  runId: string;
  /** Names of environment variables the app must not see (provider keys). */
  secretEnv?: string[];
}

function stop(key: string) {
  const app = apps.get(key);
  apps.delete(key);
  app?.child.kill();
}

/** Stops every app started here. Also runs when the process exits. */
export function closeMirrorApps() {
  for (const key of [...apps.keys()]) stop(key);
}

async function waitUntilAnswering(origin: string, child: ChildProcess) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The app exited with code ${child.exitCode}.`);
    const status = await fetch(`${origin}/`, { redirect: "manual", signal: AbortSignal.timeout(5000) }).then(
      (r) => r.status,
      () => 0,
    );
    if (status > 0 && status < 500) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("The app did not answer in time.");
}

async function start(dir: RunDir, appDir: string, buildId: string, secretEnv: string[]): Promise<LiveApp> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, CCM_DIR: dir.path("ccm") };
  for (const name of secretEnv) delete env[name];
  const child = spawn(
    process.execPath,
    [nextBin(appDir), "start", "--hostname", "127.0.0.1", "-p", String(port)],
    {
      cwd: appDir,
      env,
      stdio: "ignore",
    },
  );
  child.on("error", () => undefined);
  const origin = `http://127.0.0.1:${port}`;
  return { child, origin, buildId, used: Date.now(), ready: waitUntilAnswering(origin, child) };
}

let exitHooked = false;

/** Starts the run's app if it is not running yet and returns the address of the recreated page. */
export async function openMirrorApp(o: OpenMirrorApp): Promise<{ url: string }> {
  const dir = new RunDir(o.projectRoot, o.runId);
  if (!dir.exists("manifest.json")) throw new Error(`No recreation run "${o.runId}" in this project.`);
  const manifest = dir.manifest();
  if (manifest.request.mode !== "mirror") throw new Error(`Run "${o.runId}" is not a mirror run.`);
  if (manifest.stages.report?.status !== "done") throw new Error(`Run "${o.runId}" has not finished.`);
  const appDir = dir.path(APP_DIR);
  const buildFile = dir.path(APP_DIR, ".next/BUILD_ID");
  if (!existsSync(buildFile) || !existsSync(nextBin(appDir)))
    throw new Error(`Run "${o.runId}" has no built app.`);
  const buildId = readFileSync(buildFile, "utf8").trim();

  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", closeMirrorApps);
  }
  const key = dir.path();
  const known = apps.get(key);
  // a run resumed since then has rebuilt the app
  if (known && (known.buildId !== buildId || known.child.exitCode !== null)) stop(key);
  let app = apps.get(key);
  if (!app) {
    app = await start(dir, appDir, buildId, o.secretEnv ?? []);
    apps.set(key, app);
    const oldest = [...apps.entries()].filter(([k]) => k !== key).sort((a, b) => a[1].used - b[1].used);
    while (apps.size > MAX_APPS) stop(oldest.shift()![0]);
  }
  app.used = Date.now();
  try {
    await app.ready;
  } catch (e) {
    stop(key);
    throw e;
  }
  const page = manifest.finalUrl ? new URL(manifest.finalUrl).pathname : "/";
  return { url: `${app.origin}${page}` };
}
