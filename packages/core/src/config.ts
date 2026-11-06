import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HarnessConfig, KeySource, ModelRole } from "@harness/protocol";
import { deepMerge } from "./util.js";

export const DEFAULT_CONFIG: HarnessConfig = {
  providers: {
    deepseek: {
      type: "openai-compatible",
      baseURL: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    },
    ollama: { type: "openai-compatible", baseURL: "https://ollama.com/v1", apiKeyEnv: "OLLAMA_API_KEY" },
    local: { type: "openai-compatible", baseURL: "http://localhost:11434/v1" },
    openrouter: {
      type: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
    anthropic: { type: "anthropic", baseURL: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" },
  },
  models: {
    executor: "deepseek/deepseek-flash",
    planner: "deepseek/deepseek-v4-pro",
    reviewer: "deepseek/deepseek-v4-pro",
    summarizer: "deepseek/deepseek-flash",
  },
  verify: { maxAttempts: 3, timeoutMs: 10 * 60_000 },
  permissions: { mode: "ask", bash: { allow: [], deny: [] } },
  hooks: {},
  workflow: "default",
  // Long jobs (1:1 recreation, component generation) need room; compaction keeps each turn cheap.
  limits: { maxTurns: 150, timeoutMs: 3 * 60 * 60_000 },
  context: { maxContext: 64_000, compactAt: 0.7, keepRecent: 6, maxToolOutput: 20_000, repoMapDepth: 3 },
  sandbox: "none",
  mcpServers: {},
};

/** Where the terminal app puts files a chat creates, unless `outputDir` is configured: `$CDR_OUTPUT_DIR` or ~/Documents/CDR. */
export function defaultOutputDir(): string {
  return expandOutputDir(process.env.CDR_OUTPUT_DIR) ?? join(homedir(), "Documents", "CDR");
}

/** `~`/`~/x` to the home folder, anything else to an absolute path; undefined for an empty value. */
function expandOutputDir(dir: string | undefined): string | undefined {
  if (typeof dir !== "string" || !dir.trim()) return undefined;
  dir = dir.trim();
  return dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : resolve(dir);
}

/** Base folder for files created in chats (`outputDir`), or undefined when not set or disabled. */
export function outputBaseDir(cfg: Pick<HarnessConfig, "outputDir">): string | undefined {
  return expandOutputDir(cfg.outputDir === false ? undefined : cfg.outputDir);
}

export function harnessHome(): string {
  // Keep the existing data directory so renaming the app never hides saved sessions.
  return process.env.CDR_HOME ?? process.env.HARNESS_HOME ?? join(homedir(), ".harness");
}

export const PROJECT_CONFIG_FILES = [
  "cdr.config.json",
  ".cdr/config.json",
  "harness.config.json",
  ".harness/config.json",
];

function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  // allow // line comments (jsonc-lite) – only full-line comments to stay safe with URLs
  const stripped = raw
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  try {
    return JSON.parse(stripped);
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${(e as Error).message}`);
  }
}

export interface LoadConfigOptions {
  projectPath: string;
  overrides?: Partial<HarnessConfig>;
  /** Skip ~/.harness/config.json (tests). */
  skipGlobal?: boolean;
}

export function loadConfig(opts: LoadConfigOptions): HarnessConfig {
  let cfg: HarnessConfig = structuredClone(DEFAULT_CONFIG);
  if (!opts.skipGlobal) {
    const global = join(harnessHome(), "config.json");
    if (existsSync(global)) cfg = deepMerge(cfg, readJson(global));
  }
  for (const f of PROJECT_CONFIG_FILES) {
    const p = join(opts.projectPath, f);
    if (existsSync(p)) {
      cfg = deepMerge(cfg, readJson(p));
      break;
    }
  }
  if (opts.overrides) cfg = deepMerge(cfg, opts.overrides);
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: HarnessConfig): void {
  for (const [role, ref] of Object.entries(cfg.models)) {
    if (!ref) continue;
    const { provider } = parseModelRef(ref);
    if (!cfg.providers[provider]) {
      throw new Error(`models.${role} references unknown provider "${provider}" (in "${ref}")`);
    }
  }
  const mode = cfg.permissions?.mode;
  if (mode && !["ask", "auto", "yolo"].includes(mode)) throw new Error(`Invalid permissions.mode "${mode}"`);
}

/** "provider/model-name" – the model name may itself contain slashes. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf("/");
  if (i <= 0) throw new Error(`Model reference "${ref}" must look like "provider/model"`);
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function resolveModelRef(cfg: HarnessConfig, roleOrRef: ModelRole | string): string {
  if (roleOrRef.includes("/")) return roleOrRef;
  const ref = cfg.models[roleOrRef as ModelRole] ?? cfg.models.executor;
  if (!ref) throw new Error(`No model configured for role "${roleOrRef}"`);
  return ref;
}

/** Variables defined in `<dir>/.env` (empty when the file is missing). */
export function parseDotEnv(dir: string): Record<string, string> {
  const path = join(resolve(dir), ".env");
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}

/** The .env file each variable was loaded from by `loadDotEnv` into `process.env`. */
const dotEnvOrigin = new Map<string, string>();

/** Minimal .env parser. Does not override variables already set in the environment. */
export function loadDotEnv(dir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parseDotEnv(dir))) {
    if (env[name] === undefined) {
      env[name] = value;
      loaded.push(name);
      if (env === process.env) dotEnvOrigin.set(name, join(resolve(dir), ".env"));
    }
  }
  return loaded;
}

/**
 * Where the value of an API key variable comes from: the file it was loaded from (`project-env`, `home-env`)
 * or the process environment (shell, or keys the desktop app passes from the keychain). Undefined when unset.
 * Compares values only; never returns them. `file` is the .env path; a key loaded for another project
 * stays in the environment of this process, so it can differ from the asked project's .env.
 */
export function keySource(
  name: string,
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { source: KeySource; file?: string } | undefined {
  const value = env[name];
  if (!value) return undefined;
  const homeEnv = join(resolve(harnessHome()), ".env");
  const projectEnv = join(resolve(projectPath), ".env");
  const origin = env === process.env ? dotEnvOrigin.get(name) : undefined;
  const file =
    origin && parseDotEnv(dirname(origin))[name] === value
      ? origin
      : parseDotEnv(projectPath)[name] === value
        ? projectEnv
        : parseDotEnv(harnessHome())[name] === value
          ? homeEnv
          : undefined;
  if (!file) return { source: "environment" };
  return { source: file === homeEnv ? "home-env" : "project-env", file };
}
