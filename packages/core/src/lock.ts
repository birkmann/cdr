import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { harnessHome } from "./config.js";

const held = new Map<string, string>(); // lock path -> session id (this process)

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a session's workspace is currently owned by a live runner. */
export function sessionHasProjectLock(projectRoot: string, sessionId: string): boolean {
  const key = createHash("sha1").update(resolve(projectRoot)).digest("hex").slice(0, 16);
  try {
    const info = JSON.parse(readFileSync(join(harnessHome(), "locks", `${key}.lock`), "utf8"));
    return info.sessionId === sessionId && Number.isInteger(info.pid) && pidAlive(info.pid);
  } catch {
    return false;
  }
}

/** Per-project lock so two agents never edit the same tree concurrently (across processes too). */
export function acquireProjectLock(projectRoot: string, sessionId: string): () => void {
  const dir = join(harnessHome(), "locks");
  mkdirSync(dir, { recursive: true });
  const key = createHash("sha1").update(resolve(projectRoot)).digest("hex").slice(0, 16);
  const path = join(dir, `${key}.lock`);
  const mine = held.get(path);
  if (mine && mine !== sessionId)
    throw new Error(`Project ${projectRoot} is busy (session ${mine} is running)`);
  if (!mine && existsSync(path)) {
    try {
      const info = JSON.parse(readFileSync(path, "utf8")) as { pid: number; sessionId: string };
      if (info.pid !== process.pid && pidAlive(info.pid)) {
        throw new Error(`Project ${projectRoot} is busy (session ${info.sessionId}, pid ${info.pid})`);
      }
    } catch (e) {
      if ((e as Error).message.startsWith("Project")) throw e;
    }
  }
  writeFileSync(
    path,
    JSON.stringify({
      pid: process.pid,
      sessionId,
      projectRoot: resolve(projectRoot),
      at: new Date().toISOString(),
    }),
  );
  held.set(path, sessionId);
  return () => {
    if (held.get(path) === sessionId) {
      held.delete(path);
      rmSync(path, { force: true });
    }
  };
}
