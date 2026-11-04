import type { HarnessEvent } from "@harness/protocol";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

export function summarizeArgs(args: unknown, max = 100): string {
  if (!args || typeof args !== "object") return String(args ?? "").slice(0, max);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    let s = typeof v === "string" ? v : JSON.stringify(v);
    s = s.replace(/\s+/g, " ");
    if (s.length > 60) s = s.slice(0, 57) + "…";
    parts.push(`${k}=${typeof v === "string" ? JSON.stringify(s) : s}`);
  }
  const out = parts.join(", ");
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

export function colorDiff(diff: string, maxLines = 40): string {
  const lines = diff.split("\n");
  const shown = lines
    .slice(0, maxLines)
    .map((l) =>
      l.startsWith("+++") || l.startsWith("---")
        ? c.bold(l)
        : l.startsWith("+")
          ? c.green(l)
          : l.startsWith("-")
            ? c.red(l)
            : l.startsWith("@@")
              ? c.cyan(l)
              : c.dim(l),
    );
  if (lines.length > maxLines) shown.push(c.dim(`… ${lines.length - maxLines} more lines`));
  return shown.join("\n");
}

/** Plain streaming renderer for the terminal. */
export class Renderer {
  private atLineStart = true;
  private inReasoning = false;
  private usage = { input: 0, output: 0, cost: 0 };
  private spinner?: ReturnType<typeof setInterval>;
  private started = Date.now();
  private turnUsage = { input: 0, output: 0, cost: 0 };
  constructor(
    private readonly out: NodeJS.WritableStream = process.stdout,
    private readonly opts: { verbose?: boolean } = {},
  ) {}

  private write(s: string) {
    if (!s) return;
    this.out.write(s);
    this.atLineStart = s.endsWith("\n");
  }
  private line(s: string) {
    if (!this.atLineStart) this.write("\n");
    this.write(s + "\n");
  }

  get totals() {
    return this.usage;
  }

  dispose() {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    this.out.write("\r\x1b[2K");
  }

  private working(label: string) {
    if (!(this.out as NodeJS.WriteStream).isTTY) return;
    const frames = ["◐", "◓", "◑", "◒"];
    let frame = 0;
    this.spinner = setInterval(() => {
      this.out.write(
        `\r\x1b[2K${c.cyan(frames[frame++ % frames.length])} ${c.dim(label)} ${c.dim(`${Math.floor((Date.now() - this.started) / 1000)}s · Ctrl+C to stop`)}`,
      );
    }, 100);
    this.spinner.unref();
  }

  render(e: HarnessEvent): void {
    this.dispose();
    switch (e.type) {
      case "run.start":
        if (e.continuedFrom) this.out.write(c.cyan("Continuing saved job; existing work retained.\n"));
        break;
      case "status":
        if (e.status === "running") {
          this.started = Date.now();
          this.turnUsage = { ...this.usage };
          this.working("Working…");
        }
        break;
      case "session.settings":
        if (e.reasoningEffort !== undefined) this.line(c.gray(`Thinking effort: ${e.reasoningEffort}`));
        break;
      case "phase.start":
        this.line(
          c.magenta(c.bold(`\n── ${e.phase}${e.round && e.round > 1 ? ` (round ${e.round})` : ""} ──`)),
        );
        break;
      case "message.start":
        this.inReasoning = false;
        if (e.role === "assistant") this.working("Thinking…");
        break;
      case "reasoning.delta":
        if (!this.inReasoning) {
          this.inReasoning = true;
          this.line(c.gray("… thinking"));
        }
        if (this.opts.verbose) this.write(c.gray(e.text));
        break;
      case "message.delta":
        if (this.inReasoning) {
          this.inReasoning = false;
          if (!this.atLineStart) this.write("\n");
        }
        this.write(e.text);
        break;
      case "message.end":
        if (!this.atLineStart) this.write("\n");
        break;
      case "tool.call":
        this.line(`${c.cyan("⏺")} ${c.bold(e.name)}${c.dim(`(${summarizeArgs(e.args)})`)}`);
        this.working(e.name);
        break;
      case "tool.result": {
        const first = e.output.split("\n").find((l) => l.trim()) ?? "";
        const n = e.output.split("\n").length;
        const status = e.ok ? c.green("✓") : c.red("✗");
        if (e.diff)
          this.line(
            `  ${status} ${c.dim(first)}\n${indent(colorDiff(e.diff.split("\n").slice(2).join("\n"), this.opts.verbose ? 400 : 30))}`,
          );
        else if (this.opts.verbose || !e.ok)
          this.line(
            `  ${status} ${indent(e.ok ? c.dim(e.output.slice(0, 4000)) : c.red(e.output.slice(0, 2000))).trimStart()}`,
          );
        else
          this.line(`  ${status} ${c.dim(first.slice(0, 120))}${n > 1 ? c.dim(` (+${n - 1} lines)`) : ""}`);
        break;
      }
      case "permission.resolved":
        if (e.auto) this.line(c.dim(`  (auto-approved)`));
        break;
      case "verify.result":
        this.line(
          `${e.exitCode === 0 ? c.green("✔") : c.red("✘")} ${e.kind}: ${c.bold(e.command)} ${c.dim(`exit ${e.exitCode}`)}`,
        );
        if (e.exitCode !== 0) this.line(indent(c.dim(e.output.split("\n").slice(-25).join("\n"))));
        break;
      case "review.findings":
        if (!e.findings.length) this.line(c.green("Review: no findings."));
        for (const f of e.findings) {
          const sev =
            f.severity === "blocking"
              ? c.red(f.severity)
              : f.severity === "major"
                ? c.yellow(f.severity)
                : c.dim(f.severity);
          this.line(
            `  ${sev} ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.issue}${f.suggestion ? c.dim(` → ${f.suggestion}`) : ""}`,
          );
        }
        break;
      case "todo.update":
        this.line(
          e.items
            .map(
              (i) =>
                `  ${i.status === "done" ? c.green("☑") : i.status === "in_progress" ? c.yellow("▸") : "☐"} ${i.text}`,
            )
            .join("\n"),
        );
        break;
      case "preview.ready":
        this.line(c.green(`  ▶ preview: ${e.path}`) + c.dim("  (open the chat in the web app to see it)"));
        break;
      case "memory.saved":
        this.line(c.dim(`  remembered (${e.scope}): ${e.fact}`));
        break;
      case "usage":
        this.usage.input += e.inputTokens;
        this.usage.output += e.outputTokens;
        this.usage.cost += e.cost ?? 0;
        break;
      case "log":
        if (e.level === "warn") this.line(c.yellow(`! ${e.message}`));
        else if (this.opts.verbose) this.line(c.dim(e.message));
        break;
      case "error":
        this.line(c.red(`✗ ${e.message}`));
        break;
      case "agent.spawned":
        this.line(
          `${c.magenta("◆")} ${c.bold(`subagent ${e.role}`)} ${c.dim(`[${e.isolation}${e.branch ? ` · ${e.branch}` : ""}]`)} ${e.task.split("\n")[0].slice(0, 100)}` +
            c.dim(`\n    session ${e.sessionId}`),
        );
        break;
      case "agent.status":
        if (e.status === "waiting") this.line(c.yellow(`  ◆ subagent ${e.agentId} is waiting for input`));
        else if (this.opts.verbose)
          this.line(c.dim(`  ◆ ${e.agentId} ${e.status}${e.phase ? ` · ${e.phase}` : ""}`));
        break;
      case "agent.finished": {
        const col = e.status === "success" ? c.green : e.status === "cancelled" ? c.yellow : c.red;
        this.line(
          `${col("◆")} subagent ${e.agentId} ${col(e.status)}${e.summary ? c.dim(` – ${e.summary.split("\n")[0].slice(0, 120)}`) : ""}` +
            (e.diffStat ? `\n${indent(c.dim(e.diffStat.split("\n").slice(-12).join("\n")))}` : ""),
        );
        break;
      }
      case "goal.started":
        this.line(
          c.cyan(c.bold(`◎ goal ${e.title} · round ${e.round}`)) + c.dim(`  ${e.branch} · ${e.worktree}`),
        );
        break;
      case "goal.checkpoint": {
        const met = e.criteria.filter((x) => x.met).length;
        this.line(
          `${c.cyan("◎")} checkpoint ${c.bold(e.commit.slice(0, 10))} ${c.dim(e.step)} · ${met}/${e.criteria.length} criteria met` +
            (e.criteria.length
              ? "\n" +
                e.criteria
                  .map(
                    (x) =>
                      `    ${x.met ? c.green("✓") : c.red("✗")} ${x.criterion}${x.evidence ? c.dim(` – ${x.evidence}`) : ""}`,
                  )
                  .join("\n")
              : ""),
        );
        break;
      }
      case "goal.paused":
        this.line(c.yellow(`◎ goal paused (${e.reason})${e.detail ? `: ${e.detail}` : ""}`));
        break;
      case "goal.finished": {
        const col = e.status === "success" ? c.green : e.status === "cancelled" ? c.yellow : c.red;
        this.line(
          col(c.bold(`◎ goal ${e.status}`)) + c.dim(`  branch ${e.branch}${e.prUrl ? ` · ${e.prUrl}` : ""}`),
        );
        break;
      }
      case "done": {
        const col = e.status === "success" ? c.green : e.status === "cancelled" ? c.yellow : c.red;
        const u = {
          input: this.usage.input - this.turnUsage.input,
          output: this.usage.output - this.turnUsage.output,
          cost: this.usage.cost - this.turnUsage.cost,
        };
        this.line(
          col(
            c.bold(`\n${e.status === "success" ? "✔" : e.status === "cancelled" ? "■" : "✘"} ${e.status}`),
          ) +
            c.dim(
              `  ${u.input} in / ${u.output} out tokens${u.cost ? `, $${u.cost.toFixed(4)}` : ""} · ${((Date.now() - this.started) / 1000).toFixed(1)}s`,
            ) +
            (e.reportPath ? c.dim(`\n  report: ${e.reportPath}`) : ""),
        );
        break;
      }
    }
  }
}

function indent(s: string, pad = "    "): string {
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
