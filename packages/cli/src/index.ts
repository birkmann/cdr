import { parseArgs } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Attachment, HarnessConfig, HarnessEvent, ModelRole } from "@harness/protocol";
import { isInternalEvent } from "@harness/protocol";
import {
  Harness,
  initProject,
  parseModelRef,
  redactValue,
  runEvals,
  saveEvalSummary,
  WORKFLOW_PRESETS,
  GoalStore,
  discardGoal,
  mergeGoal,
  pauseGoal,
  startGoal,
  workingTreeDiff,
  currentBranch,
  resolveInProject,
  ATTACHMENT_LIMITS,
  defaultOutputDir,
  discoverSkills,
  type Session,
} from "@harness/core";
import { startServer, loadOrCreateToken } from "@harness/server";
import { HARNESS_VERSION } from "@harness/protocol";
import { runTui } from "./tui/index.js";
import { REPL_HELP, parseSkillCommand, rewindCommand } from "./commands.js";
import { Renderer, c, colorDiff } from "./render.js";
import { attachPrompts, createTerminal, type Terminal } from "./interact.js";

export const VERSION = HARNESS_VERSION;

const HELP = `CDR ${VERSION} — code. build. ship.

Usage:
  cdr                         interactive session in the current directory
  cdr run "<task>"            run the full workflow (plan → execute → verify → review → finish)
  cdr plan "<task>"           plan only (no edits)
  cdr review                  review the current git diff
  cdr resume <session-id>     continue an earlier interactive session
  cdr sessions                list sessions
  cdr serve                   start the HTTP + SSE server for frontends
  cdr goal new "<title>" --criteria "<c>" [--criteria …] [--budget-cost N] [--max-rounds N]
  cdr goal list | run <id> | merge <id> | discard <id>
                                 autonomous goals in a worktree (see docs/workflows.md)
  cdr models [--remote]       show configured models (--remote: query providers)
  cdr config                  print the effective config (secrets redacted)
  cdr init                    write cdr.config.json + AGENTS.md for this project
  cdr eval                    run the eval task set (evals/; --suite apps for app building)
  cdr recreate <url>          recreate a live page 1:1 (asks for consent; see docs/recreate.md)
      [--widths 390,768,1440] [--to static,react-vite,ds-react] [--style tailwind|css-modules|vanilla]
      [--out ./site] [--repair] [--no-checks] [--build] [--from <stage> --run <id>] [--json] [--yes]
  cdr mcp recreate            the recreate stages as an MCP server on stdio (capture needs consent: true; --yes)

Options:
  -C, --cwd <dir>                 project directory (default: current directory)
  -m, --model <provider/model>    model for all roles (e.g. deepseek/deepseek-chat, local/qwen3:8b)
      --executor/--planner/--reviewer <ref>   model per role
  -w, --workflow <name>           ${Object.keys(WORKFLOW_PRESETS).join(" | ")} | custom
      --no-plan                   skip the plan phase
  -y, --yes                       auto-approve plans and permission prompts
      --mode <ask|auto|yolo>      permission mode (default: config or "ask")
      --commit                    commit the result on a harness/<slug> branch
      --skill <name>              give the agent this skill's instructions (repeatable; see /skills)
  -s, --sandbox                   work in a fresh sandbox folder (~/.harness/sandboxes) instead of the cwd
      --plain                     use the simple text interface (no full-screen UI)
      --json                      emit raw JSONL events on stdout (for scripting)
  -v, --verbose                   show full tool output and reasoning
      --port <n> --host <h>       serve: bind address (default 127.0.0.1:8787)
      --origin <url>              serve: allowed CORS origin (repeatable)
      --token-env <NAME>          serve: read the API token from this env var (never printed)
      --ready-json                serve: print one JSON line {"ready":true,"url","port"} on stdout when listening
      --static <dir>              serve: serve this built web UI at /
      --criteria <text>           goal new: acceptance criterion (repeatable)
      --budget-cost <n> --max-rounds <n> --base <branch> --description <text>   goal new options
      --filter <s> --keep         eval: only tasks matching <s>; keep temp dirs
      --suite <name> --repeat <n> eval: task suite (code | apps | all, default code); runs per task
      --judge <provider/model>    eval: model that scores judge checks (default: the evaluated model)
      --label <text>              eval: name stored with the results (see scripts/evals/compare.mjs)
      --max-context <tokens>      eval: context budget per agent (context.maxContext) to A/B test compaction
  -h, --help / --version
`;

interface Flags {
  cwd?: string;
  model?: string;
  executor?: string;
  planner?: string;
  reviewer?: string;
  workflow?: string;
  "no-plan"?: boolean;
  yes?: boolean;
  mode?: string;
  commit?: boolean;
  json?: boolean;
  plain?: boolean;
  verbose?: boolean;
  port?: string;
  host?: string;
  origin?: string[];
  "token-env"?: string;
  "ready-json"?: boolean;
  static?: string;
  criteria?: string[];
  "budget-cost"?: string;
  "max-rounds"?: string;
  base?: string;
  description?: string;
  remote?: boolean;
  filter?: string;
  keep?: boolean;
  suite?: string;
  repeat?: string;
  judge?: string;
  label?: string;
  "max-context"?: string;
  force?: boolean;
  sandbox?: boolean;
  skill?: string[];
  widths?: string;
  to?: string;
  style?: string;
  out?: string;
  from?: string;
  run?: string;
  repair?: boolean;
  "no-repair"?: boolean;
  "no-checks"?: boolean;
  build?: boolean;
  help?: boolean;
  version?: boolean;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: "string", short: "C" },
      model: { type: "string", short: "m" },
      executor: { type: "string" },
      planner: { type: "string" },
      reviewer: { type: "string" },
      workflow: { type: "string", short: "w" },
      "no-plan": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      mode: { type: "string" },
      commit: { type: "boolean" },
      json: { type: "boolean" },
      plain: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      port: { type: "string" },
      host: { type: "string" },
      origin: { type: "string", multiple: true },
      "token-env": { type: "string" },
      "ready-json": { type: "boolean" },
      static: { type: "string" },
      criteria: { type: "string", multiple: true },
      "budget-cost": { type: "string" },
      "max-rounds": { type: "string" },
      base: { type: "string" },
      description: { type: "string" },
      remote: { type: "boolean" },
      filter: { type: "string" },
      keep: { type: "boolean" },
      suite: { type: "string" },
      repeat: { type: "string" },
      judge: { type: "string" },
      label: { type: "string" },
      "max-context": { type: "string" },
      force: { type: "boolean" },
      sandbox: { type: "boolean", short: "s" },
      skill: { type: "string", multiple: true },
      widths: { type: "string" },
      to: { type: "string" },
      style: { type: "string" },
      out: { type: "string" },
      from: { type: "string" },
      run: { type: "string" },
      repair: { type: "boolean" },
      "no-repair": { type: "boolean" },
      "no-checks": { type: "boolean" },
      build: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
}

function modelOverrides(f: Flags): Partial<Record<ModelRole, string>> | undefined {
  const m: Partial<Record<ModelRole, string>> = {};
  if (f.model) m.executor = m.planner = m.reviewer = m.summarizer = f.model;
  if (f.executor) m.executor = f.executor;
  if (f.planner) m.planner = f.planner;
  if (f.reviewer) m.reviewer = f.reviewer;
  return Object.keys(m).length ? m : undefined;
}

function permissionMode(f: Flags): "ask" | "auto" | "yolo" | undefined {
  if (!f.mode) return undefined;
  if (!["ask", "auto", "yolo"].includes(f.mode)) throw new Error(`--mode must be ask, auto or yolo`);
  return f.mode as "ask" | "auto" | "yolo";
}

export interface CliContext {
  harness?: Harness;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Wire a session to the terminal: renderer (or JSON), prompts, Ctrl+C → cancel. */
function attach(
  session: Session,
  f: Flags,
  term: Terminal,
  out: NodeJS.WritableStream,
  replay: boolean | number = false,
) {
  const renderer = new Renderer(f.json ? process.stderr : out, { verbose: f.verbose });
  // Subagents' permission prompts and questions are answered in this terminal too.
  const childPrompts: (() => void)[] = [];
  const unsub = session.subscribe(
    (e: HarnessEvent) => {
      if (f.json) {
        if (!isInternalEvent(e)) out.write(JSON.stringify(e) + "\n");
      } else renderer.render(e);
      if (e.type === "agent.spawned") {
        const child = session.childSessions().find((s) => s.id === e.sessionId);
        if (child) childPrompts.push(attachPrompts(child, term, f.json ? process.stderr : out));
      }
    },
    replay === false ? undefined : replay === true ? 0 : replay,
  );
  const prompts = attachPrompts(session, term, f.json ? process.stderr : out);
  const unprompt = () => {
    prompts();
    childPrompts.forEach((u) => u());
  };
  let interrupts = 0;
  const onSigint = () => {
    if (session.isRunning && interrupts++ === 0) {
      (f.json ? process.stderr : out).write(c.yellow("\n■ cancelling… (Ctrl+C again to quit)\n"));
      session.cancel();
    } else process.exit(130);
  };
  term.rl.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);
  return {
    renderer,
    resetInterrupts: () => (interrupts = 0),
    detach: () => {
      renderer.dispose();
      unsub();
      unprompt();
      term.rl.off("SIGINT", onSigint);
      process.off("SIGINT", onSigint);
    },
  };
}

function findEvalsDir(start: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const base of [start, resolve(here, "../../..")]) {
    let dir = resolve(base);
    while (true) {
      if (existsSync(join(dir, "evals", "tasks"))) return join(dir, "evals");
      const p = dirname(dir);
      if (p === dir) break;
      dir = p;
    }
  }
  return null;
}

export async function main(argv: string[], ctx: CliContext = {}): Promise<number> {
  const out = ctx.stdout ?? process.stdout;
  const err = ctx.stderr ?? process.stderr;
  let parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    err.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const f = parsed.values as Flags;
  const [cmd = "", ...rest] = parsed.positionals;
  if (f.help || cmd === "help") {
    out.write(HELP);
    return 0;
  }
  if (f.version) {
    out.write(VERSION + "\n");
    return 0;
  }
  const cwd = resolve(f.cwd ?? process.cwd());
  // Only the terminal chat moves new files to ~/Documents/CDR; `serve` (web, desktop) shows no notice about it,
  // so there the folder applies only when the config sets `outputDir`.
  const harness = ctx.harness ?? new Harness(cmd === "serve" ? {} : { defaultOutputDir: defaultOutputDir() });

  try {
    switch (cmd) {
      case "":
      case "chat":
        return await interactive(harness, cwd, f, out);
      case "resume": {
        if (!rest[0]) throw new Error("usage: cdr resume <session-id>");
        return await interactive(harness, cwd, f, out, rest[0]);
      }
      case "run":
      case "plan":
      case "review": {
        const task =
          cmd === "review"
            ? rest.join(" ") || "Review the current uncommitted changes in this repository."
            : rest.join(" ");
        if (!task.trim()) throw new Error(`usage: cdr ${cmd} "<task>"`);
        const workflow = cmd === "plan" ? "plan-only" : cmd === "review" ? "review-only" : f.workflow;
        return await runOnce(harness, cwd, f, out, task, workflow);
      }
      case "sessions": {
        const list = harness.listSessions();
        if (f.json) out.write(JSON.stringify(list, null, 2) + "\n");
        else if (!list.length) out.write("No sessions yet.\n");
        else
          for (const s of list)
            out.write(
              `${c.bold(s.id)}  ${s.status.padEnd(9)} ${c.dim(s.workflow.padEnd(11))} ${s.projectPath}${s.title ? `  ${s.title}` : ""}\n`,
            );
        return 0;
      }
      case "web":
      case "serve": {
        // Make launch-directory credentials available to new web sandboxes as well.
        harness.config(cwd);
        // Sidecar mode: --ready-json keeps stdout for the single ready line; everything else goes to stderr.
        const info = f["ready-json"] ? err : out;
        let token: string;
        let tokenPath: string | undefined;
        if (f["token-env"]) {
          const fromEnv = process.env[f["token-env"]]?.trim();
          if (!fromEnv) throw new Error(`--token-env: environment variable ${f["token-env"]} is not set`);
          token = fromEnv;
        } else ({ token, path: tokenPath } = loadOrCreateToken());
        const port = f.port !== undefined ? Number(f.port) : 8787;
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be 0-65535");
        const here = dirname(fileURLToPath(import.meta.url));
        if (f.static && !existsSync(join(resolve(f.static), "index.html")))
          throw new Error(`--static: no index.html in ${resolve(f.static)}`);
        const staticDir = f.static
          ? resolve(f.static)
          : [resolve(here, "../../../apps/web/dist"), resolve(here, "../web")].find((d) =>
              existsSync(join(d, "index.html")),
            );
        const s = await startServer({ harness, token, port, host: f.host, origins: f.origin, staticDir });
        info.write(`${c.green("CDR")} listening on ${c.bold(s.url)}\n`);
        if (staticDir && tokenPath)
          info.write(`${c.bold("Open the app:")} ${c.cyan(`${s.url}/#token=${token}`)}\n`);
        else if (staticDir) info.write(`${c.bold("Web UI:")} ${c.cyan(s.url)}\n`);
        else info.write(c.yellow(`web UI not built (pnpm build) – API only\n`));
        info.write(
          c.dim(tokenPath ? `token stored in ${tokenPath}\n` : `token read from $${f["token-env"]}\n`),
        );
        if (f.host && !["127.0.0.1", "localhost", "::1"].includes(f.host))
          info.write(
            c.red("warning: server is reachable from the network – it can edit files and run commands.\n"),
          );
        if (f["ready-json"]) out.write(JSON.stringify({ ready: true, url: s.url, port: s.port }) + "\n");
        await new Promise<void>((r) => {
          process.once("SIGINT", r);
          process.once("SIGTERM", r);
          // Sidecar watchdog: stop when the launching app is gone, even if it was killed.
          const parent = Number(process.env.CDR_PARENT_PID);
          if (Number.isInteger(parent) && parent > 0) {
            const timer = setInterval(() => {
              try {
                process.kill(parent, 0);
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ESRCH") {
                  clearInterval(timer);
                  r();
                }
              }
            }, 1000);
          }
        });
        await s.close();
        return 0;
      }
      case "goal":
        return await goalCommand(harness, cwd, f, out, rest);
      case "models": {
        const { config, registry } = harness.providerRegistry(cwd);
        for (const [role, ref] of Object.entries(config.models)) {
          if (!ref) continue;
          const { provider } = parseModelRef(ref);
          out.write(
            `${role.padEnd(11)} ${c.bold(ref)} ${registry.isConfigured(provider) ? c.green("configured") : c.red(`missing ${config.providers[provider]?.apiKeyEnv}`)}\n`,
          );
        }
        if (f.remote) {
          for (const id of Object.keys(config.providers)) {
            if (!registry.isConfigured(id)) continue;
            try {
              const p = registry.get(id);
              const list = (await p.listModels?.(AbortSignal.timeout(8000))) ?? [];
              out.write(
                `\n${c.bold(id)} (${list.length}): ${list.slice(0, 40).join(", ")}${list.length > 40 ? " …" : ""}\n`,
              );
            } catch (e) {
              out.write(`\n${c.bold(id)}: ${c.red((e as Error).message.slice(0, 200))}\n`);
            }
          }
        }
        return 0;
      }
      case "config": {
        const cfg = harness.config(cwd, configOverrides(f));
        out.write(JSON.stringify(redactValue(cfg as HarnessConfig), null, 2) + "\n");
        return 0;
      }
      case "init": {
        const r = initProject(cwd, { force: f.force, executor: f.model, configName: "cdr.config.json" });
        for (const p of r.written) out.write(`${c.green("wrote")} ${p}\n`);
        for (const p of r.skipped)
          out.write(`${c.dim("exists")} ${p} ${c.dim("(use --force to overwrite)")}\n`);
        return 0;
      }
      case "recreate":
        return await recreateCommand(harness, cwd, f, out, rest);
      case "mcp": {
        if (rest[0] !== "recreate") throw new Error("usage: cdr mcp recreate [--yes]");
        // stdout carries JSON-RPC only: the session is not attached to a renderer
        const session = createSession(harness, cwd, f, undefined, "mcp recreate");
        try {
          if (session.config.recreate?.enabled === false)
            throw new Error("recreate is disabled in this project's config");
          const { serveRecreateMcp } = await import("@harness/core");
          await serveRecreateMcp(session, process.stdin, out, {
            yes: f.yes,
          });
          return 0;
        } finally {
          session.close();
        }
      }
      case "eval": {
        const dir = findEvalsDir(cwd);
        if (!dir) throw new Error("No evals/ directory with tasks/ found");
        // Always read the project config: it also loads the project .env (provider and Unsplash keys).
        const cwdConfig = harness.config(cwd);
        const model = f.model ?? cwdConfig.models.executor!;
        out.write(`Running evals from ${dir} with ${c.bold(model)}\n`);
        const summary = await runEvals({
          evalsDir: dir,
          model,
          workflow: f.workflow,
          filter: f.filter,
          keep: f.keep,
          suite: f.suite,
          judgeModel: f.judge,
          label: f.label,
          repeat: f.repeat ? Number(f.repeat) : undefined,
          configOverrides: f["max-context"]
            ? { context: { maxContext: maxContextFlag(f["max-context"]) } }
            : undefined,
          onProgress: (m) => out.write(m + "\n"),
        });
        const path = saveEvalSummary(dir, summary);
        const tokens = summary.results.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
        out.write(
          `\n${c.bold(`${summary.passed}/${summary.total} passed`)} (${(summary.passRate * 100).toFixed(0)}%), ${tokens} tokens → ${path}\n`,
        );
        for (const r of summary.results.filter((x) => !x.passed)) {
          out.write(
            c.red(
              `  ✘ ${r.id}${r.run ? ` #${r.run}` : ""}: ${
                [
                  ...r.checks.filter((x) => !x.passed).map((x) => `${x.check.type} ${x.detail ?? ""}`),
                  ...(r.error ? [r.error] : []),
                ].join("; ") || r.runStatus
              }\n`,
            ),
          );
        }
        return summary.passed === summary.total ? 0 : 1;
      }
      default:
        err.write(`Unknown command "${cmd}".\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    err.write(c.red(`error: ${(e as Error).message}\n`));
    return 1;
  }
}

async function goalCommand(
  harness: Harness,
  cwd: string,
  f: Flags,
  out: NodeJS.WritableStream,
  args: string[],
): Promise<number> {
  const [sub, ...rest] = args;
  const store = new GoalStore();
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  const show = (g: import("@harness/protocol").GoalInfo) =>
    `${c.bold(g.id)}  ${g.status.padEnd(15)} ${g.title}${g.branch ? c.dim(`  ${g.branch}`) : ""}${g.checkpoints ? c.dim(` · ${g.checkpoints} checkpoints`) : ""}${g.usage.cost ? c.dim(` · $${g.usage.cost.toFixed(4)}`) : ""}\n`;
  switch (sub) {
    case "new": {
      const title = rest.join(" ").trim();
      if (!title) throw new Error('usage: cdr goal new "<title>" --criteria "<criterion>" …');
      const mode = permissionMode(f);
      const maxCost = num(f["budget-cost"], "--budget-cost");
      const maxRounds = num(f["max-rounds"], "--max-rounds");
      const g = store.create({
        title,
        repo: cwd,
        description: f.description ?? "",
        acceptance: f.criteria ?? [],
        ...(f.base ? { baseBranch: f.base } : {}),
        budget: { ...(maxCost ? { maxCost } : {}), ...(maxRounds ? { maxRounds } : {}) },
        policy: mode ? { permissionMode: mode } : {},
        ...(modelOverrides(f) ? { models: modelOverrides(f) } : {}),
      });
      if (f.json) out.write(JSON.stringify(g, null, 2) + "\n");
      else out.write(`${c.green("created")} ${show(g)}${c.dim(`run it with: cdr goal run ${g.id}`)}\n`);
      return 0;
    }
    case "list":
    case undefined: {
      const list = store.list(f.cwd ? cwd : undefined);
      if (f.json) out.write(JSON.stringify(list, null, 2) + "\n");
      else if (!list.length)
        out.write('No goals yet. Create one with: cdr goal new "<title>" --criteria …\n');
      else for (const g of list) out.write(show(g));
      return 0;
    }
    case "run": {
      const id = rest[0];
      if (!id) throw new Error("usage: cdr goal run <id>");
      const existing = store.require(id);
      const before =
        existing.sessionId && harness.store.exists(existing.sessionId)
          ? (harness.getSession(existing.sessionId).events.at(-1)?.seq ?? 0)
          : 0;
      const term = createTerminal(f.json ? process.stderr : out);
      let started: ReturnType<typeof startGoal> | undefined;
      try {
        started = startGoal(harness, id, { store });
        const a = attach(started.session, f, term, out, before);
        // Ctrl+C also stops the goal between rounds (when the session itself is idle).
        const onSigint = () => void pauseGoal(id, store);
        process.on("SIGINT", onSigint);
        term.rl.on("SIGINT", onSigint);
        try {
          const g = await started.done;
          if (!f.json) out.write(`\n${show(g)}`);
          if (!f.json && g.status === "review")
            out.write(c.dim(`review the branch, then: cdr goal merge ${g.id}  (or discard)\n`));
          return g.status === "review" ? 0 : 1;
        } finally {
          process.off("SIGINT", onSigint);
          term.rl.off("SIGINT", onSigint);
          a.detach();
        }
      } finally {
        term.close();
        started?.session.close();
      }
    }
    case "merge": {
      if (!rest[0]) throw new Error("usage: cdr goal merge <id>");
      const g = mergeGoal(rest[0], store);
      out.write(`${c.green("merged")} ${g.branch} into ${g.baseBranch}\n`);
      return 0;
    }
    case "discard": {
      if (!rest[0]) throw new Error("usage: cdr goal discard <id>");
      const g = discardGoal(rest[0], store);
      out.write(`${c.yellow("discarded")} ${g.id} (worktree and branch removed)\n`);
      return 0;
    }
    default:
      throw new Error(`Unknown goal command "${sub}". Use new, list, run, merge or discard.`);
  }
}

function maxContextFlag(v: string): number {
  const n = Number(v.replace(/k$/i, "000"));
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`--max-context: ${v} is not a token count (e.g. 48000 or 48k)`);
  return n;
}

function configOverrides(f: Flags): Partial<HarnessConfig> | undefined {
  const models = modelOverrides(f);
  const mode = permissionMode(f);
  if (!models && !mode) return undefined;
  return { ...(models ? { models } : {}), ...(mode ? { permissions: { mode } } : {}) };
}

function createSession(harness: Harness, cwd: string, f: Flags, workflow?: string, title?: string): Session {
  return harness.createSession({
    ...(f.sandbox ? { sandbox: { name: title } } : { projectPath: cwd }),
    workflow: workflow ?? f.workflow,
    models: modelOverrides(f),
    permissionMode: permissionMode(f),
    autoApprove: f.yes ? { permissions: true, plan: true } : {},
    origin: "cli",
  });
}

const STYLES = ["tailwind", "css-modules", "vanilla"] as const;

/** `cdr recreate <url>`: the pipeline in a session (events rendered like a run); `capture` writes snapshots only. */
async function recreateCommand(
  harness: Harness,
  cwd: string,
  f: Flags,
  out: NodeJS.WritableStream,
  rest: string[],
): Promise<number> {
  const capturesOnly = rest[0] === "capture";
  const url = capturesOnly ? rest[1] : rest[0];
  if (!url && !f.run) throw new Error("usage: cdr recreate <url> [options] (cdr --help)");
  // a run id is one folder name under .harness/recreate (never a path)
  if (f.run !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(f.run))
    throw new Error(`--run: "${f.run}" is not a run id`);
  const widths = f.widths
    ? f.widths.split(",").map((w) => {
        const n = Number(w.trim());
        if (!Number.isFinite(n) || n < 320 || n > 2560)
          throw new Error(`--widths: ${w} is not a width (320–2560)`);
        return Math.round(n);
      })
    : undefined;
  // a resumed run keeps its own targets unless --to names new ones
  const to = (f.to ?? (f.run ? "" : "static"))
    .split(",")
    .map((t) => (t.trim() === "react" ? "react-vite" : t.trim()))
    .filter(Boolean);
  if (f.style && !(STYLES as readonly string[]).includes(f.style))
    throw new Error(`--style must be ${STYLES.join(", ")}`);
  const session = createSession(harness, cwd, f, undefined, `recreate ${url ?? f.run}`);
  if (session.config.recreate?.enabled === false)
    throw new Error("recreate is disabled in this project's config");
  const term = createTerminal(f.json ? process.stderr : out);
  const a = attach(session, f, term, out, true);
  try {
    const { recreateInSession } = await import("@harness/core");
    const r = await recreateInSession(
      session,
      {
        url: url ?? "",
        ...(widths ? { widths } : {}),
        ...(to.length ? { to } : {}),
        ...(f.style ? { style: f.style as (typeof STYLES)[number] } : {}),
        ...(f.repair && !f["no-repair"] ? { repair: true } : {}),
        ...(f.from ? { from: f.from as never } : {}),
        ...(f.run ? { run: f.run } : {}),
        ...(f.out && !capturesOnly ? { out: f.out } : {}),
      },
      {
        yes: f.yes,
        sectionChecks: !f["no-checks"],
        ...(capturesOnly ? { stopAfter: "capture" as const } : {}),
        ...(f.build ? { runBuilds: (dir: string) => npmBuild(dir) } : {}),
      },
    );
    if (capturesOnly && f.out && r.status !== "cancelled") {
      const { cpSync, existsSync } = await import("node:fs");
      const captured = join(session.projectRoot, r.dir, "capture");
      if (!existsSync(captured)) {
        if (!f.json) out.write(`nothing captured to copy to ${f.out} (${r.summary})\n`);
        return 1;
      }
      cpSync(captured, resolve(cwd, f.out), { recursive: true });
      if (!f.json) out.write(`snapshots and live shots copied to ${f.out}\n`);
    }
    return r.status === "success" ? 0 : r.status === "cancelled" ? 130 : 1;
  } finally {
    a.detach();
    term.close();
    session.close();
  }
}

/** `npm install && npm run build` in a converted project (the build gate; needs the network). */
async function npmBuild(dir: string): Promise<{ ok: boolean; output: string }> {
  const { spawnSync } = await import("node:child_process");
  const run = (args: string[]) => spawnSync("npm", args, { cwd: dir, encoding: "utf8", timeout: 600_000 });
  const i = run(["install", "--no-audit", "--no-fund"]);
  if (i.status !== 0) return { ok: false, output: `npm install failed:\n${i.stderr || i.stdout}` };
  const b = run(["run", "build"]);
  return { ok: b.status === 0, output: (b.stdout ?? "") + (b.stderr ?? "") };
}

async function runOnce(
  harness: Harness,
  cwd: string,
  f: Flags,
  out: NodeJS.WritableStream,
  task: string,
  workflow?: string,
): Promise<number> {
  const session = createSession(harness, cwd, f, workflow, task.slice(0, 40));
  if (f.sandbox && !f.json) out.write(c.dim(`sandbox: ${session.projectRoot}\n`));
  const term = createTerminal(f.json ? process.stderr : out);
  const a = attach(session, f, term, out, true);
  if (!f.json)
    out.write(
      c.dim(
        `session ${session.id} · workflow ${workflow ?? session.workflow} · ${session.config.models.executor}\n`,
      ),
    );
  try {
    const r = await session.run(task, { workflow, noPlan: f["no-plan"], commit: f.commit, skills: f.skill });
    if (!f.json && r.plan && workflow === "plan-only") out.write(`\n${r.plan}\n`);
    if (!f.json && r.branch) out.write(c.green(`committed on branch ${r.branch}\n`));
    return r.status === "success" ? 0 : r.status === "cancelled" ? 130 : 1;
  } finally {
    a.detach();
    term.close();
    session.close();
  }
}

function skillNames(session: Session): string[] {
  return discoverSkills(session.projectRoot, session.config).map((s) => s.name);
}

function skillList(session: Session): string {
  const skills = discoverSkills(session.projectRoot, session.config);
  if (!skills.length) return "No skills available.\n";
  const w = Math.max(...skills.map((s) => s.name.length)) + 1;
  return `\n${skills
    .map(
      (s) =>
        `  /${s.name.padEnd(w)} ${c.dim(s.description.length > 90 ? s.description.slice(0, 89) + "…" : s.description)}`,
    )
    .join("\n")}\n\n  /<skill> <message> sends the message with that skill's instructions.\n`;
}

async function interactive(
  harness: Harness,
  cwd: string,
  f: Flags,
  out: NodeJS.WritableStream,
  resumeId?: string,
): Promise<number> {
  let session = resumeId
    ? harness.getSession(resumeId, {
        permissionMode: permissionMode(f),
        autoApprove: f.yes ? { permissions: true, plan: true } : {},
      })
    : createSession(harness, cwd, f);
  if (
    !f.plain &&
    !f.json &&
    process.stdin.isTTY &&
    (out as NodeJS.WriteStream).isTTY &&
    process.env.TERM !== "dumb"
  ) {
    return runTui(harness, session, {
      version: VERSION,
      verbose: f.verbose,
      skills: f.skill,
      output: out as NodeJS.WriteStream,
    });
  }
  let attachments: Attachment[] = [];
  // --skill applies to the first message of an interactive session.
  let firstSkills = f.skill;
  const display = f.json ? process.stderr : out;
  const userIds = new Set(
    session.events.flatMap((e) => (e.type === "message.start" && e.role === "user" ? [e.id] : [])),
  );
  const history = session.events.flatMap((e) =>
    e.type === "message.end" && userIds.has(e.id) ? [e.text] : [],
  );
  const term = createTerminal(display, { history, skills: skillNames(session) });
  let a = attach(session, f, term, out);
  const header = () => {
    const branch = currentBranch(session.projectRoot);
    display.write(`\n${c.cyan("  ◒")} ${c.bold("CDR")} ${c.dim(VERSION)}\n`);
    display.write(`  ${c.dim(session.projectRoot)}${branch ? c.dim(` · ${branch}`) : ""}\n`);
    display.write(
      `  ${c.bold(session.config.models.executor ?? "default")} · ${session.policy.mode} permissions\n`,
    );
    display.write(c.dim("  /help commands · Tab complete · \u2191/\u2193 history · \\ multiline\n"));
  };
  const usage = () => {
    const t = a.renderer.totals;
    display.write(`${t.input} in / ${t.output} out tokens${t.cost ? `, $${t.cost.toFixed(4)}` : ""}\n`);
  };
  const replay = () => {
    // Restore the conversation without replaying permission prompts or old tool output.
    const roles = new Map<string, string>();
    for (const e of session.events) {
      if (e.type === "message.start") roles.set(e.id, e.role);
      if (e.type === "message.end" && e.text) {
        display.write(`\n${c.bold(roles.get(e.id) === "user" ? "You" : "CDR")}\n${e.text}\n`);
      }
      if (e.type === "usage") a.renderer.render(e);
    }
  };
  header();
  if (resumeId) {
    display.write(c.dim(`resumed ${session.events.length} events\n`));
    replay();
  }
  try {
    while (true) {
      a.resetInterrupts();
      const line = await term.readPrompt(`\n${c.dim(session.policy.mode)} ${c.cyan("›")} `);
      if (!line && term.closed) break;
      if (!line) continue;
      if (["/exit", "/quit", "/q"].includes(line)) break;
      try {
        const [command, ...words] = line.split(/\s+/);
        const arg = words.join(" ");
        if (command === "/help") {
          display.write(REPL_HELP);
          continue;
        }
        if (command === "/cost") {
          usage();
          continue;
        }
        if (command === "/session") {
          display.write(`${session.id}\n`);
          continue;
        }
        if (command === "/status") {
          header();
          display.write(`  session ${session.id}\n`);
          usage();
          continue;
        }
        if (command === "/terminal-design") {
          display.write("/terminal-design changes the full-screen terminal app; run cdr without --plain.\n");
          continue;
        }
        if (command === "/clear") {
          if ((display as NodeJS.WriteStream).isTTY) display.write("\x1b[2J\x1b[H");
          header();
          continue;
        }
        if (command === "/diff") {
          const diff = workingTreeDiff(session.projectRoot);
          display.write(
            diff === null
              ? "This folder is not a Git repository.\n"
              : diff
                ? colorDiff(diff, 400) + "\n"
                : "Working tree is clean.\n",
          );
          continue;
        }
        if (command === "/attach") {
          if (!arg) {
            display.write("Usage: /attach <project-relative path>\n");
            continue;
          }
          if (attachments.length >= ATTACHMENT_LIMITS.maxFiles)
            throw new Error("At most 20 attachments per message.");
          const path = resolveInProject(session.projectRoot, arg.replace(/^["']|["']$/g, ""));
          const stat = statSync(path);
          if (!stat.isFile() || stat.size > ATTACHMENT_LIMITS.maxBytes)
            throw new Error("Choose a file up to 10 MB.");
          const mime: Record<string, string> = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
          };
          attachments.push({
            name: basename(path),
            mimeType: mime[extname(path).toLowerCase()] || "application/octet-stream",
            data: readFileSync(path).toString("base64"),
          });
          display.write(
            `Attached ${basename(path)} to your next message (${attachments.length} files). /attachments clear to remove.\n`,
          );
          continue;
        }
        if (command === "/attachments") {
          if (arg === "clear") attachments = [];
          display.write(
            attachments.length
              ? attachments.map((a) => `  ${a.name}`).join("\n") + "\n"
              : "No pending attachments.\n",
          );
          continue;
        }
        if (command === "/models") {
          await main(["models", "-C", session.projectRoot, ...(arg === "remote" ? ["--remote"] : [])], {
            harness,
            stdout: display,
            stderr: display,
          });
          display.write(`\nCurrent: ${session.config.models.executor} · /model provider/model to switch\n`);
          continue;
        }
        if (command === "/continue") {
          await session.continueJob();
          continue;
        }
        if (command === "/rewind") {
          display.write(await rewindCommand(session, arg));
          continue;
        }
        if (command === "/model") {
          if (!arg) {
            display.write(
              `Current: ${session.config.models.executor}\nUsage: /model provider/model (or /models)\n`,
            );
            continue;
          }
          const { provider, model } = parseModelRef(arg);
          if (!model) throw new Error("Model name is required: /model provider/model");
          const { registry } = harness.providerRegistry(session.projectRoot);
          if (!registry.isConfigured(provider))
            throw new Error(`Provider ${provider} is not configured. Check its API key or cdr.config.json.`);
          session.updateSettings({ models: { executor: arg, planner: arg, reviewer: arg, summarizer: arg } });
          display.write(`Model: ${arg} (all roles)\n`);
          continue;
        }
        if (command === "/mode") {
          if (!["ask", "auto", "yolo"].includes(arg)) {
            display.write("Usage: /mode ask|auto|yolo\n");
            continue;
          }
          session.updateSettings({ permissionMode: arg as "ask" | "auto" | "yolo" });
          display.write(`permission mode: ${arg}\n`);
          continue;
        }
        if (command === "/sessions") {
          await main(["sessions"], { harness, stdout: display, stderr: display });
          continue;
        }
        if (command === "/new" || command === "/resume") {
          if (command === "/resume" && !arg) {
            display.write("Usage: /resume <session-id>\n");
            continue;
          }
          if (arg === session.id && command === "/resume") {
            display.write("Already in this session.\n");
            continue;
          }
          const next =
            command === "/resume"
              ? harness.getSession(arg, { autoApprove: session.autoApprove })
              : harness.createSession({
                  ...(session.isSandbox ? { sandbox: true } : { projectPath: session.projectRoot }),
                  workflow: session.workflow,
                  models: session.config.models,
                  permissionMode: session.policy.mode,
                  autoApprove: session.autoApprove,
                });
          attachments = [];
          a.detach();
          session.close();
          session = next;
          a = attach(session, f, term, out);
          header();
          if (command === "/resume") replay();
          continue;
        }
        const wf = /^\/(run|quick|plan|review)\b\s*([\s\S]*)$/.exec(line);
        if (wf) {
          const workflow =
            wf[1] === "run"
              ? session.workflow
              : wf[1] === "quick"
                ? "quick-fix"
                : wf[1] === "plan"
                  ? "plan-only"
                  : "review-only";
          const task =
            wf[2].trim() ||
            (wf[1] === "review" ? "Review the current uncommitted changes in this repository." : "");
          if (!task) {
            display.write(c.red(`usage: /${wf[1]} <task>\n`));
            continue;
          }
          const r = await session.run(task, { workflow, attachments });
          attachments = [];
          if (r.plan && workflow === "plan-only") display.write(`\n${r.plan}\n`);
        } else if (command === "/skills") {
          display.write(skillList(session));
        } else if (line.startsWith("/")) {
          const picked = parseSkillCommand(line, skillNames(session));
          if (!picked) {
            display.write(c.red(`Unknown command ${command}. Type /help or /skills, or press Tab.\n`));
            continue;
          }
          await session.chat(picked.text, attachments, { skills: picked.skills });
          attachments = [];
        } else {
          await session.chat(line, attachments, { skills: firstSkills });
          firstSkills = undefined;
          attachments = [];
        }
      } catch (e) {
        display.write(c.red(`error: ${(e as Error).message}\n`));
      }
    }
  } finally {
    a.detach();
    term.close();
    session.close();
  }
  display.write(c.dim(`\nsession saved: ${session.id} (cdr resume ${session.id})\n`));
  return 0;
}
