import { createInterface, type Interface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { HarnessEvent } from "@harness/protocol";
import type { Session } from "@harness/core";
import { c, summarizeArgs } from "./render.js";
import { completeCommand } from "./commands.js";

export interface Terminal {
  rl: Interface;
  ask(prompt: string): Promise<string>;
  readPrompt(prompt: string): Promise<string>;
  readonly closed: boolean;
  close(): void;
}

export function createTerminal(
  output: NodeJS.WritableStream = process.stdout,
  opts: { input?: NodeJS.ReadableStream; history?: string[]; skills?: string[] } = {},
): Terminal {
  const input = opts.input ?? process.stdin;
  const isTTY = !!(input as NodeJS.ReadStream).isTTY && !!(output as NodeJS.WriteStream).isTTY;
  const rl = createInterface({
    input,
    output,
    terminal: isTTY,
    completer: (line: string) => completeCommand(line, opts.skills),
    history: opts.history?.slice(-200).reverse(),
    historySize: 200,
    removeHistoryDuplicates: true,
  });
  // Buffer lines so piped input (all lines arriving at once) is never dropped.
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!("");
  });
  const ask = (prompt: string): Promise<string> => {
    if (lines.length) {
      const l = lines.shift()!;
      output.write(prompt + (isTTY ? "" : l + "\n"));
      return Promise.resolve(l);
    }
    if (closed) return Promise.resolve("");
    if (isTTY) {
      rl.setPrompt(prompt);
      rl.prompt();
    } else output.write(prompt);
    return new Promise((resolve) =>
      waiters.push((l) => {
        if (!isTTY && !closed) output.write(l + "\n");
        resolve(l);
      }),
    );
  };
  return {
    rl,
    ask: async (prompt) => (await ask(prompt)).trim(),
    async readPrompt(prompt) {
      let text = await ask(prompt);
      while (text.endsWith("\\") && !(closed && lines.length === 0)) {
        text = text.slice(0, -1) + "\n" + (await ask(c.dim("  … ")));
      }
      return text;
    },
    get closed() {
      return closed && lines.length === 0;
    },
    close: () => rl.close(),
  };
}

/** Answer permission / question / plan requests from the terminal. */
export function attachPrompts(
  session: Session,
  term: Terminal,
  out: NodeJS.WritableStream = process.stdout,
): () => void {
  // Serialise prompts: one at a time.
  let chain = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch(() => {});
  };
  return session.subscribe((e: HarnessEvent) => {
    if (e.type === "permission.request" && !session.autoApprove.permissions) {
      enqueue(async () => {
        const risk =
          e.risk === "high"
            ? c.red("high risk")
            : e.risk === "medium"
              ? c.yellow("medium risk")
              : c.dim("low risk");
        const detail =
          e.tool === "bash"
            ? c.bold(String((e.args as { command?: string })?.command ?? ""))
            : summarizeArgs(e.args, 200);
        out.write(
          `\n${c.yellow("?")} Allow ${c.bold(e.tool)} ${detail} (${risk})${e.reason ? c.dim(` – ${e.reason}`) : ""}\n`,
        );
        const a = (await term.ask(`  [y]es / [n]o / [a]lways: `)).toLowerCase();
        session.resolvePermission(e.id, a.startsWith("a") ? "always" : a.startsWith("y") ? "allow" : "deny");
      });
    } else if (e.type === "question" && session.autoApprove.questions === undefined) {
      enqueue(async () => {
        out.write(`\n${c.cyan("?")} ${c.bold(e.text)}\n`);
        e.options?.forEach((o, i) => out.write(`  ${i + 1}. ${o}\n`));
        const a = await term.ask("  answer: ");
        const n = Number(a);
        session.answerQuestion(
          e.id,
          e.options && Number.isInteger(n) && n >= 1 && n <= e.options.length ? e.options[n - 1] : a,
        );
      });
    } else if (e.type === "plan.proposed" && !session.autoApprove.plan) {
      enqueue(async () => {
        out.write(`\n${c.bold("Proposed plan")} ${c.dim(`(${e.path})`)}\n\n${e.markdown}\n\n`);
        while (true) {
          const a = (
            await term.ask(
              `${c.yellow("?")} [a]pprove / [e]dit in $EDITOR / [r]eject with feedback / [q]uit: `,
            )
          ).toLowerCase();
          if (a.startsWith("a") || a === "y" || a === "yes") return void session.decidePlan(e.id, "approve");
          if (a.startsWith("q") || a === "") return void session.decidePlan(e.id, "reject");
          if (a.startsWith("r")) {
            const feedback = await term.ask("  feedback: ");
            return void session.decidePlan(e.id, "reject", undefined, feedback || undefined);
          }
          if (a.startsWith("e")) {
            const editor = process.env.VISUAL || process.env.EDITOR || "vi";
            writeFileSync(e.path, e.markdown + "\n");
            term.rl.pause();
            const r = spawnSync(editor, [e.path], { stdio: "inherit", shell: true });
            term.rl.resume();
            if (r.status !== 0) {
              out.write(c.red(`  editor exited with ${r.status}\n`));
              continue;
            }
            return void session.decidePlan(e.id, "edit", readFileSync(e.path, "utf8"));
          }
        }
      });
    }
  });
}
