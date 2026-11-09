// The generated app's dependencies. One install per dependency set is kept beside the runs and copied into each app,
// so a new run needs the network only the first time.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

export const DEPS_DIR = ".mirror-deps";
const INSTALL_TIMEOUT_MS = 600_000;

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => (err = (err + String(d)).slice(-4000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) res();
      else rej(new Error(`${cmd} ${args.join(" ")} exited with ${code}: ${err.slice(-1500)}`));
    });
  });
}

export async function installAppDeps(
  appDir: string,
  runsDir: string,
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): Promise<void> {
  if (existsSync(join(appDir, "node_modules/next/package.json"))) return;
  const pkg = JSON.parse(await readFile(join(appDir, "package.json"), "utf8")) as {
    dependencies?: unknown;
    devDependencies?: unknown;
  };
  const manifest = JSON.stringify(
    { dependencies: pkg.dependencies, devDependencies: pkg.devDependencies },
    null,
    2,
  );
  const key = createHash("sha256").update(manifest).digest("hex").slice(0, 16);
  const cached = join(runsDir, DEPS_DIR, key);
  const installed = () => existsSync(join(cached, "node_modules/next/package.json"));
  if (!installed()) {
    log("installing the app's dependencies (once per dependency set; needs the network)");
    const tmp = `${cached}.tmp-${randomBytes(4).toString("hex")}`;
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, "package.json"), manifest);
    try {
      await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], tmp, env);
      // A run in parallel may have published this set meanwhile and be copying from it: a complete cache is never removed.
      if (!installed()) {
        try {
          await rename(tmp, cached);
        } catch {
          if (installed()) log("another run installed the same dependencies first; using those");
          else {
            await rm(cached, { recursive: true, force: true });
            await rename(tmp, cached);
          }
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  await cp(join(cached, "node_modules"), join(appDir, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
}

export const APP_DIR = "out/mirror";

export const nextBin = (appDir: string) => join(appDir, "node_modules/next/dist/bin/next");

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? res(a.port) : rej(new Error("no free port"))));
    });
  });
}
