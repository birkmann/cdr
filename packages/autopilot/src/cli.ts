// `cdr autopilot <command>`: the terminal front end of the matrix (plan §3.3). Exit code 0 only when the command's own
// verdict is good, so the commands compose in shell scripts and CI.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { loadConfig } from "@harness/core";
import { loopCommands } from "./cli-loop.js";
import { inspectCycle } from "./inspect.js";
import { autopilotPaths } from "./paths.js";
import { reportIndex, writeReports } from "./report.js";
import { matrixVerdict, runMatrix } from "./runner.js";
import { loadSites, selectSites } from "./sites.js";
import { createFreezeStage } from "./stages/freeze.js";
import { autopilotStatus, latestCycle } from "./status.js";
import {
  DEFAULT_AUTOPILOT_CONFIG,
  STAGE_ORDER,
  type AutopilotConfig,
  type AutopilotPaths,
  type MatrixResult,
  type StageName,
} from "./types.js";

export interface AutopilotCliContext {
  cwd: string;
  out: NodeJS.WritableStream;
  /** Stops a run between stages (Ctrl+C in `cdr`); absent when the caller does not forward signals. */
  signal?: AbortSignal;
}

interface Flags {
  sites?: string[];
  stages?: StageName[];
  parallel?: number;
  cycle?: number;
  refresh: boolean;
  wayback?: string[];
  keepCache: boolean;
  open: boolean;
  cwd?: string;
}

const USAGE = `usage: cdr autopilot <command> [options]

  freeze  --sites a,b [--refresh] [--wayback a]     capture each site into a replayable snapshot
  run     --sites a,b [--stages x,y] [--parallel n] [--cycle n] [--keep-cache]
  inspect --cycle n                                 findings.json and FINDINGS.md; exit 1 when new findings exist
  status                                            cycle, per-site gates, spent budget, running goals
  report  --cycle n [--open]                        REPORT.md, report.json and index.html
  fix | verify | loop | rules | diff | clean        the self-improving half (see docs/autopilot.md)

  --cwd <dir>   the repository root (default: the current directory)
`;

const TAKES_VALUE = new Set(["--sites", "--stages", "--parallel", "--cycle", "--wayback", "--cwd"]);

function parseFlags(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = { refresh: false, keepCache: false, open: false };
  const positional: string[] = [];
  const list = (v: string) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    let [name, value] = arg.split("=", 2) as [string, string | undefined];
    if (TAKES_VALUE.has(name) && value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Error(`${name} needs a value`);
    }
    switch (name) {
      case "--sites":
        flags.sites = list(value!);
        break;
      case "--stages": {
        const stages = list(value!);
        for (const s of stages)
          if (!STAGE_ORDER.includes(s as StageName))
            throw new Error(`--stages: unknown stage "${s}" (${STAGE_ORDER.join(", ")})`);
        flags.stages = stages as StageName[];
        break;
      }
      case "--parallel":
        flags.parallel = Number(value);
        if (!Number.isInteger(flags.parallel) || flags.parallel < 1)
          throw new Error("--parallel must be a whole number from 1");
        break;
      case "--cycle":
        flags.cycle = Number(value);
        if (!Number.isInteger(flags.cycle) || flags.cycle < 1)
          throw new Error("--cycle must be a whole number from 1");
        break;
      case "--wayback":
        flags.wayback = list(value!);
        break;
      case "--cwd":
        flags.cwd = value!;
        break;
      case "--refresh":
        flags.refresh = true;
        break;
      case "--keep-cache":
        flags.keepCache = true;
        break;
      case "--open":
        flags.open = true;
        break;
      default:
        throw new Error(`unknown option ${name}`);
    }
  }
  return { flags, positional };
}

/** The `autopilot` block of the project's config over the defaults. */
function autopilotConfig(root: string): AutopilotConfig {
  let block: Partial<AutopilotConfig> | undefined;
  try {
    block = (loadConfig({ projectPath: root, skipGlobal: true }) as { autopilot?: Partial<AutopilotConfig> })
      .autopilot;
  } catch {
    block = undefined;
  }
  return {
    ...DEFAULT_AUTOPILOT_CONFIG,
    ...block,
    budgets: { ...DEFAULT_AUTOPILOT_CONFIG.budgets, ...block?.budgets },
    freeze: { ...DEFAULT_AUTOPILOT_CONFIG.freeze, ...block?.freeze },
    coverage: { ...DEFAULT_AUTOPILOT_CONFIG.coverage, ...block?.coverage },
  };
}

/** The cycle a run goes into: `--cycle`, the latest for a partial `--stages` run, else the one after the last finished. */
function runCycle(paths: AutopilotPaths, flags: Flags): number {
  if (flags.cycle) return flags.cycle;
  const latest = latestCycle(paths);
  if (!latest) return 1;
  if (flags.stages) return latest;
  return existsSync(join(paths.cycleDir(latest), "matrix.json")) ? latest + 1 : latest;
}

function needCycle(paths: AutopilotPaths, flags: Flags): number {
  const cycle = flags.cycle ?? latestCycle(paths);
  if (!cycle) throw new Error("no cycle to report on; run `cdr autopilot run` first");
  return cycle;
}

function printMatrix(out: NodeJS.WritableStream, m: MatrixResult): boolean {
  const verdict = matrixVerdict(m);
  out.write(
    `cycle ${m.cycle}: ${verdict.green ? "green" : `not green (${verdict.failing.length} failing)`}\n`,
  );
  for (const line of verdict.failing) out.write(`  ${line}\n`);
  return verdict.green;
}

async function runCommand(flags: Flags, paths: AutopilotPaths, ctx: AutopilotCliContext): Promise<number> {
  const file = loadSites(paths);
  const sites = selectSites(file, flags.sites);
  const config = autopilotConfig(paths.root);
  const cycle = runCycle(paths, flags);
  ctx.out.write(`cycle ${cycle}: running ${sites.map((s) => s.id).join(", ")}\n`);
  const runners =
    flags.refresh || flags.wayback?.length
      ? { freeze: createFreezeStage({ refresh: flags.refresh, wayback: flags.wayback }) }
      : undefined;
  const matrix = await runMatrix({
    paths,
    cycle,
    sites,
    config,
    ...(flags.stages ? { stages: flags.stages } : {}),
    ...(flags.parallel ? { parallel: flags.parallel } : {}),
    ...(runners ? { runners } : {}),
    keepCache: flags.keepCache,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    progress: (line) => ctx.out.write(`${line}\n`),
  });
  writeReports(paths, cycle, config);
  return printMatrix(ctx.out, matrix) ? 0 : 1;
}

async function freezeCommand(flags: Flags, paths: AutopilotPaths, ctx: AutopilotCliContext): Promise<number> {
  const file = loadSites(paths);
  const sites = selectSites(file, flags.sites);
  const cycle = flags.cycle ?? (latestCycle(paths) || 1);
  const matrix = await runMatrix({
    paths,
    cycle,
    sites,
    config: autopilotConfig(paths.root),
    stages: ["freeze"],
    noMatrix: true,
    runners: { freeze: createFreezeStage({ refresh: flags.refresh, wayback: flags.wayback }) },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    progress: (line) => ctx.out.write(`${line}\n`),
  });
  return printMatrix(ctx.out, matrix) ? 0 : 1;
}

function inspectCommand(flags: Flags, paths: AutopilotPaths, ctx: AutopilotCliContext): number {
  const cycle = needCycle(paths, flags);
  const result = inspectCycle(paths, cycle);
  const { new: added, recurring, regressed, fixed } = result.counts;
  ctx.out.write(
    `cycle ${cycle}: ${added} new, ${recurring} recurring, ${regressed} regressed, ${fixed} fixed (${join(paths.cycleDir(cycle), "FINDINGS.md")})\n`,
  );
  return result.hasNew ? 1 : 0;
}

function reportCommand(flags: Flags, paths: AutopilotPaths, ctx: AutopilotCliContext): number {
  const cycle = needCycle(paths, flags);
  const report = writeReports(paths, cycle, autopilotConfig(paths.root));
  const index = reportIndex(paths, cycle);
  ctx.out.write(`cycle ${cycle}: ${report.green ? "green" : "not green"} (${index})\n`);
  if (flags.open) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [index], { detached: true, stdio: "ignore" })
      .on("error", () => undefined)
      .unref();
  }
  return 0;
}

function statusCommand(paths: AutopilotPaths, ctx: AutopilotCliContext): number {
  const status = autopilotStatus(paths);
  ctx.out.write(status.text);
  return status.green ? 0 : 1;
}

/** `cdr autopilot <freeze|run|inspect|fix|verify|loop|status|report|rules|diff|clean>`. Returns the exit code. */
export async function autopilotMain(argv: string[], ctx: AutopilotCliContext): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    ctx.out.write(USAGE);
    return command ? 0 : 1;
  }
  const delegated = loopCommands[command];
  if (delegated) {
    // the loop owns its own flags; only --cwd is common
    const cwdAt = rest.findIndex((a) => a === "--cwd");
    let cwd = ctx.cwd;
    let args = rest;
    if (cwdAt >= 0) {
      if (rest[cwdAt + 1] === undefined) {
        ctx.out.write("--cwd needs a value\n");
        return 2;
      }
      cwd = resolve(ctx.cwd, rest[cwdAt + 1]!);
      args = [...rest.slice(0, cwdAt), ...rest.slice(cwdAt + 2)];
    }
    return delegated(args, { ...ctx, cwd });
  }
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(rest);
  } catch (e) {
    ctx.out.write(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { flags } = parsed;
  const root = flags.cwd ? resolve(ctx.cwd, flags.cwd) : ctx.cwd;
  const paths = autopilotPaths(root);
  try {
    switch (command) {
      case "run":
        return await runCommand(flags, paths, ctx);
      case "freeze":
        return await freezeCommand(flags, paths, ctx);
      case "inspect":
        return inspectCommand(flags, paths, ctx);
      case "status":
        return statusCommand(paths, ctx);
      case "report":
        return reportCommand(flags, paths, ctx);
      default:
        ctx.out.write(`unknown autopilot command "${command}"\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    ctx.out.write(`cdr autopilot ${command}: ${(e as Error).message}\n`);
    return 1;
  }
}
