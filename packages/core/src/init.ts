import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "@harness/protocol";
import { PROJECT_CONFIG_FILES } from "./config.js";
import { detectStack } from "./verify.js";

/** `harness init`: write harness.config.json and an AGENTS.md template based on the detected stack. */
export function initProject(
  root: string,
  opts: { force?: boolean; executor?: string; configName?: string } = {},
): { written: string[]; skipped: string[] } {
  const stack = detectStack(root);
  const written: string[] = [];
  const skipped: string[] = [];
  const existing = PROJECT_CONFIG_FILES.find((name) => existsSync(join(root, name)));
  const cfgPath = join(root, existing ?? opts.configName ?? "harness.config.json");
  if (!existsSync(cfgPath) || opts.force) {
    const cfg: Partial<HarnessConfig> = {
      models: {
        executor: opts.executor ?? "deepseek/deepseek-flash",
        planner: opts.executor ?? "deepseek/deepseek-v4-pro",
        reviewer: opts.executor ?? "deepseek/deepseek-v4-pro",
      },
      verify: { ...stack.commands, maxAttempts: 3 },
      permissions: {
        mode: "ask",
        bash: {
          allow: [
            ...(stack.packageManager
              ? [`${stack.packageManager} test*`, `${stack.packageManager} run *`]
              : []),
            "git status*",
            "git diff*",
            "git log*",
          ],
          deny: ["git push*", "rm -rf *"],
        },
      },
      workflow: "default",
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    written.push(cfgPath);
  } else skipped.push(cfgPath);

  const agentsPath = join(root, "AGENTS.md");
  if (!existsSync(agentsPath) || opts.force) {
    const c = stack.commands;
    writeFileSync(
      agentsPath,
      `# AGENTS.md

Instructions for coding agents working in this repository.

## Stack
- ${stack.languages.join(", ") || "unknown"}${stack.packageManager ? ` (package manager: ${stack.packageManager})` : ""}

## Commands
${c.build ? `- Build: \`${c.build}\`\n` : ""}${c.test ? `- Test: \`${c.test}\`\n` : ""}${c.lint ? `- Lint: \`${c.lint}\`\n` : ""}${!c.build && !c.test && !c.lint ? "- (add build/test/lint commands here)\n" : ""}
## Conventions
- Keep changes minimal and focused; match the surrounding code style.
- Add or update tests for behaviour changes.
- Never commit secrets; configuration comes from environment variables.
`,
    );
    written.push(agentsPath);
  } else skipped.push(agentsPath);
  return { written, skipped };
}
