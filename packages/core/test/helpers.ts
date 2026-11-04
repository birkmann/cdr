import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { HarnessConfig } from "@harness/protocol";
import { DEFAULT_CONFIG, type ToolContext } from "@harness/core";

export function tempProject(files: Record<string, string> = {}, opts: { git?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-proj-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  if (opts.git) {
    const g = (...a: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-qm", "init");
  }
  return dir;
}

export function toolCtx(
  root: string,
  config: Partial<HarnessConfig> = {},
): ToolContext & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    projectRoot: root,
    config: { ...structuredClone(DEFAULT_CONFIG), ...config },
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    ask: async () => "yes",
    todos: [],
    secretEnv: [],
    events,
  };
}

/** Config overrides that route every role to the injected mock provider. */
export const MOCK_MODELS: Partial<HarnessConfig> = {
  providers: { mock: { type: "mock" } } as HarnessConfig["providers"],
  models: { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" },
};
