/**
 * Environment handling: repo-root discovery, `.env` loading (never prints values) and secret redaction.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

/** Walk up from `start` until a directory containing `pnpm-workspace.yaml` is found; falls back to `start`. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export interface LoadEnvResult {
  /** absolute path of the env file that was read (undefined if none found) */
  path?: string;
  loaded: boolean;
  /** variable NAMES set from the file (values are never returned or logged) */
  keys: string[];
  /** variable names present in the file but left alone because they were already set in the environment */
  skipped: string[];
}

/**
 * Load `.env` into `process.env` without overriding variables already set (the real environment wins).
 * Lookup order: explicit `path` → `CMP_ENV_FILE` → `<repoRoot>/.env`. Missing file is not an error.
 */
export function loadEnv(opts: { path?: string; env?: NodeJS.ProcessEnv; override?: boolean } = {}): LoadEnvResult {
  const env = opts.env ?? process.env;
  const file = opts.path ?? env.CMP_ENV_FILE ?? join(findRepoRoot(), ".env");
  if (!existsSync(file)) return { path: undefined, loaded: false, keys: [], skipped: [] };
  const parsed = parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
  const keys: string[] = [];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (!opts.override && env[k] !== undefined && env[k] !== "") {
      skipped.push(k);
      continue;
    }
    env[k] = v;
    keys.push(k);
  }
  return { path: file, loaded: true, keys, skipped };
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)/i;

/** Values of env vars whose names look secret (min length 6 so we never redact trivial strings). */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === "string" && v.length >= 6)
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
}

/** Replace any secret env value occurring in `text` with `***`. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const s of secretValues(env)) if (out.includes(s)) out = out.split(s).join("***");
  return out;
}
