import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessConfig, ModelRole } from "@harness/protocol";
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
  limits: { maxTurns: 60, timeoutMs: 60 * 60_000 },
  context: { compactAt: 0.7, keepRecent: 6, maxToolOutput: 20_000, repoMapDepth: 3 },
  sandbox: "none",
  mcpServers: {},
};

export function harnessHome(): string {
  // Keep the existing data directory so renaming the app never hides saved sessions.
  return (
    process.env.CDR_HOME ?? process.env.MORROW_HOME ?? process.env.HARNESS_HOME ?? join(homedir(), ".harness")
  );
}

export const PROJECT_CONFIG_FILES = [
  "cdr.config.json",
  ".cdr/config.json",
  "morrow.config.json",
  ".morrow/config.json",
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

/** Minimal .env parser. Does not override variables already set in the environment. */
export function loadDotEnv(dir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const path = join(resolve(dir), ".env");
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    if (env[m[1]] === undefined) {
      env[m[1]] = value;
      loaded.push(m[1]);
    }
  }
  return loaded;
}
