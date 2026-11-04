import type { EventBody, HarnessConfig } from "@harness/protocol";
import type { AgentHooks } from "./loop.js";
import { runShell } from "./shell.js";
import { truncateMiddle } from "./util.js";

/**
 * Turn shell hooks from config into AgentHooks.
 * - afterEdit: runs after every successful file edit; output is appended to the tool result.
 * - onStop: runs when the agent wants to stop; a non-zero exit feeds the output back and continues
 *   (bounded by verify.maxAttempts).
 */
export function configHooks(opts: {
  config: HarnessConfig;
  projectRoot: string;
  signal: AbortSignal;
  secretEnv: string[];
  emit: (e: EventBody) => void;
}): AgentHooks {
  const { config, projectRoot, signal, secretEnv, emit } = opts;
  const h = config.hooks ?? {};
  let stopAttempts = 0;
  const run = (cmd: string) =>
    runShell(cmd, {
      cwd: projectRoot,
      signal,
      stripEnv: secretEnv,
      timeoutMs: config.verify?.timeoutMs ?? 600_000,
      sandbox: config.sandbox,
      network: config.sandboxNetwork,
    });
  return {
    afterTool: h.afterEdit
      ? async (_call, _args, result) => {
          if (!result.ok || !result.edited?.length) return;
          const r = await run(h.afterEdit!);
          emit({ type: "log", level: "info", message: `afterEdit hook exited ${r.exitCode}` });
          return `[afterEdit hook \`${h.afterEdit}\` exit ${r.exitCode}]\n${truncateMiddle(r.output.trim(), 6000).text}`;
        }
      : undefined,
    onStop: h.onStop
      ? async () => {
          const r = await run(h.onStop!);
          emit({ type: "log", level: "info", message: `onStop hook exited ${r.exitCode}` });
          if (r.exitCode === 0) return;
          if (++stopAttempts > (config.verify?.maxAttempts ?? 3)) return;
          return `The onStop check \`${h.onStop}\` failed (exit ${r.exitCode}). Fix it before finishing:\n\`\`\`\n${truncateMiddle(r.output.trim(), 8000).text}\n\`\`\``;
        }
      : undefined,
  };
}
