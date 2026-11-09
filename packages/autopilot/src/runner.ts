// The matrix runner (plan §3): each site goes through the stages in order, in its own project folder and with its own
// ports. A stage's throw becomes a `crashed` summary, a failure skips what depends on it, and everything a stage does
// lands in its folder (§3.4). The matrix never goes down because a site did.
import { appendFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { DEFAULT_VIEWPORTS } from "@harness/mirror-core";
import { startReplayServer } from "@harness/mirror-replay";
import { redact, redactValue } from "@harness/core";
import { readJsonOr, readMatrix, readSummaries } from "./collect.js";
import { createPortPool } from "./ports.js";
import { STAGES } from "./stages/index.js";
import { currentSnapshotDir, readSnapshotRef } from "./stages/freeze.js";
import {
  DEFAULT_AUTOPILOT_CONFIG,
  STAGE_ORDER,
  type AutopilotConfig,
  type AutopilotPaths,
  type Gate,
  type MatrixResult,
  type PortPool,
  type SiteConfig,
  type SnapshotRef,
  type StageContext,
  type StageIssue,
  type StageName,
  type StageRunner,
  type StageSummary,
} from "./types.js";

/** The stages a stage needs (§2): the chain, with the mirror beside the design system, not before it. */
export const STAGE_DEPS: Record<StageName, StageName[]> = {
  freeze: [],
  mirror: ["freeze"],
  "design-system": ["freeze"],
  replica: ["freeze", "design-system"],
  final: ["freeze", "replica"],
};

/** Per-stage wall clock budgets (§6.2). */
export function stageBudgetMs(stage: StageName, config: AutopilotConfig, site?: SiteConfig): number {
  switch (stage) {
    case "freeze":
      // the Wayback Machine is rate limited and backed off from politely: minutes turn into most of an hour
      return site?.freeze?.wayback ? 45 * 60_000 : 15 * 60_000;
    case "mirror":
      return 40 * 60_000;
    case "design-system":
      return config.budgets.designSystemMs;
    case "replica":
    case "final":
      return config.budgets.replicaMs;
  }
}

const GRACE_MS = 30_000;

export interface OpenedReplay {
  snapshot: SnapshotRef;
  close(): Promise<void>;
}

/** Starts the replay server of a snapshot on a port from the pool; misses go to the site's freeze folder. */
export async function openSnapshotReplay(
  dir: string,
  ports: PortPool,
  missesLog: string,
  log: (line: string) => void,
): Promise<OpenedReplay> {
  const ref = readSnapshotRef(dir);
  const port = await ports.acquire();
  const server = await startReplayServer({
    captureDir: dir,
    port,
    host: "127.0.0.1",
    missesLog,
    log: { info: log, warn: log },
  });
  const { pathname, search } = new URL(ref.finalUrl);
  return {
    snapshot: { ...ref, replayUrl: `${server.url}${pathname}${search}` },
    close: async () => {
      await server.close();
      ports.release(port);
    },
  };
}

/** The site's project: an empty folder with its own config, so `.harness/recreate/<run>` folders never mix (§3.2). */
export function writeProjectConfig(
  paths: AutopilotPaths,
  projectDir: string,
  site: SiteConfig,
  replayUrl?: string,
): void {
  mkdirSync(join(projectDir, ".harness"), { recursive: true });
  const root = readJsonOr<{ models?: unknown }>(join(paths.root, ".harness/config.json"), {});
  const viewports = site.viewports?.length
    ? site.viewports.map((name) => {
        const vp = DEFAULT_VIEWPORTS.find((v) => v.name === name);
        if (!vp) throw new Error(`${site.id}: unknown viewport "${name}"`);
        return vp;
      })
    : undefined;
  const config = {
    ...(root.models ? { models: root.models } : {}),
    checkpoints: { enabled: false },
    recreate: {
      allowLocal: true,
      ...(viewports ? { mirror: { viewports } } : {}),
    },
    ...(replayUrl ? { autopilot: { replayUrl } } : {}),
  };
  writeFileSync(join(projectDir, ".harness/config.json"), `${JSON.stringify(config, null, 2)}\n`);
  // the generated apps' dependencies are shared between sites and cycles
  const depsLink = join(projectDir, ".harness/recreate/.mirror-deps");
  if (!existsSync(depsLink)) {
    const shared = join(paths.state, "mirror-deps");
    mkdirSync(shared, { recursive: true });
    mkdirSync(dirname(depsLink), { recursive: true });
    try {
      symlinkSync(shared, depsLink);
    } catch {
      /* a failed link only means this site installs for itself */
    }
  }
}

export interface RunMatrixOptions {
  paths: AutopilotPaths;
  cycle: number;
  sites: SiteConfig[];
  config?: AutopilotConfig;
  /** Only these stages run; earlier summaries on disk stand for the others. */
  stages?: StageName[];
  parallel?: number;
  /** Replacements for the real stages (tests, `--refresh`). */
  runners?: Partial<Record<StageName, StageRunner>>;
  ports?: PortPool;
  signal?: AbortSignal;
  keepCache?: boolean;
  /** Skip writing `matrix.json` (`freeze` alone is not a matrix run). */
  noMatrix?: boolean;
  /** Replaces the real replay server (tests). */
  openReplay?: (
    dir: string,
    ports: PortPool,
    missesLog: string,
    log: (line: string) => void,
  ) => Promise<OpenedReplay>;
  /** Progress lines for the terminal. */
  progress?: (line: string) => void;
}

function gitCommit(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function skippedSummary(stage: StageName, site: string, reason: string): StageSummary {
  return {
    stage,
    site,
    status: "skipped",
    wallClockMs: 0,
    gates: [],
    issues: [{ code: "STAGE_SKIPPED", message: reason, severity: "info" }],
    artifacts: {},
  };
}

function crashedSummary(
  stage: StageName,
  site: string,
  error: unknown,
  wallClockMs: number,
  stageDir: string,
): StageSummary {
  const e = error as Error;
  return {
    stage,
    site,
    status: "crashed",
    wallClockMs,
    gates: [],
    issues: [
      {
        code: "CRASHED",
        message: e.stack ?? e.message ?? String(error),
        severity: "error",
        evidence: [join(stageDir, "log.txt")],
      },
    ],
    artifacts: {},
  };
}

/** The stages running right now, across the sites of this process. */
const activeStages = new Set<StageFiles>();

class StageFiles {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "log.txt"), "");
    writeFileSync(join(dir, "events.jsonl"), "");
  }

  log(line: string): void {
    appendFileSync(join(this.dir, "log.txt"), `[${new Date().toISOString()}] ${redact(line)}\n`);
  }

  event(body: unknown): void {
    appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify(redactValue(body))}\n`);
  }

  write(summary: StageSummary): void {
    writeFileSync(join(this.dir, "summary.json"), `${JSON.stringify(redactValue(summary), null, 2)}\n`);
    const errors = summary.issues
      .filter((i) => i.severity === "error")
      .map((i) => ({
        code: i.code,
        ...(i.cause ? { cause: i.cause } : {}),
        step: summary.stage,
        message: i.message,
        ...(i.evidence?.length ? { file: i.evidence[0] } : {}),
      }));
    writeFileSync(join(this.dir, "errors.json"), `${JSON.stringify(redactValue(errors), null, 2)}\n`);
  }
}

/** Why a stage cannot run: an earlier stage it depends on failed, crashed or was skipped. */
function blockedBy(
  stage: StageName,
  previous: Partial<Record<StageName, StageSummary>>,
): { dep: StageName; status: string } | undefined {
  for (const dep of STAGE_DEPS[stage]) {
    const s = previous[dep];
    if (s && s.status !== "passed") return { dep, status: s.status };
  }
  return undefined;
}

async function raceBudget(
  run: Promise<StageSummary>,
  budgetMs: number,
  abort: () => void,
): Promise<StageSummary> {
  let timer: NodeJS.Timeout | undefined;
  let grace: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort();
      grace = setTimeout(() => reject(new StageTimeout(budgetMs)), GRACE_MS);
    }, budgetMs);
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (grace) clearTimeout(grace);
    // a stage that outlived its budget is abandoned; its late rejection must not take the process down
    run.catch(() => undefined);
  }
}

class StageTimeout extends Error {
  constructor(readonly budgetMs: number) {
    super(`stage exceeded its budget of ${Math.round(budgetMs / 1000)} s`);
    this.name = "StageTimeout";
  }
}

async function runStage(
  o: RunMatrixOptions,
  runner: StageRunner,
  site: SiteConfig,
  previous: Partial<Record<StageName, StageSummary>>,
  snapshot: SnapshotRef | undefined,
  config: AutopilotConfig,
  ports: PortPool,
): Promise<StageSummary> {
  const { paths, cycle } = o;
  const stageDir = paths.stageDir(cycle, site.id, runner.name);
  // a stage re-run on its cycle generates from scratch: files of the earlier attempt must not end up in this one
  rmSync(join(stageDir, "out"), { recursive: true, force: true });
  const files = new StageFiles(stageDir);
  const budgetMs = stageBudgetMs(runner.name, config, site);
  const controller = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, controller.signal]) : controller.signal;
  const ctx: StageContext = {
    site,
    cycle,
    paths,
    config,
    projectDir: paths.projectDir(cycle, site.id),
    stageDir,
    snapshot,
    previous,
    ports,
    signal,
    log: (line) => files.log(line),
    event: (body) => files.event(body),
    keepCache: !!o.keepCache,
  };
  const startedAt = Date.now();
  files.log(`${runner.name} starts for ${site.id}`);
  activeStages.add(files);
  let summary: StageSummary;
  try {
    const running = Promise.resolve().then(() => runner.run(ctx));
    summary = await raceBudget(running, budgetMs, () => controller.abort());
    summary = { ...summary, stage: runner.name, site: site.id, wallClockMs: Date.now() - startedAt };
  } catch (e) {
    if (e instanceof StageTimeout) {
      files.log(e.message);
      summary = {
        ...crashedSummary(runner.name, site.id, e, Date.now() - startedAt, stageDir),
        issues: [
          { code: "TIMEOUT", message: e.message, severity: "error", evidence: [join(stageDir, "log.txt")] },
        ],
      };
    } else {
      files.log(`crashed: ${(e as Error).stack ?? String(e)}`);
      summary = crashedSummary(runner.name, site.id, e, Date.now() - startedAt, stageDir);
    }
  }
  activeStages.delete(files);
  files.log(`${runner.name} finished: ${summary.status}`);
  files.write(summary);
  return summary;
}

async function runSite(
  o: RunMatrixOptions,
  site: SiteConfig,
  config: AutopilotConfig,
  ports: PortPool,
): Promise<void> {
  const { paths, cycle } = o;
  const selected = o.stages ?? STAGE_ORDER;
  const runners = { ...STAGES, ...(o.runners ?? {}) };
  const projectDir = paths.projectDir(cycle, site.id);
  writeProjectConfig(paths, projectDir, site);
  const openReplay = o.openReplay ?? openSnapshotReplay;
  const missesLog = join(paths.stageDir(cycle, site.id, "freeze"), "replay-misses.jsonl");

  // earlier summaries of this cycle stand for the stages that are not selected this time
  const previous: Partial<Record<StageName, StageSummary>> = {};
  for (const [stage, s] of Object.entries(readSummaries(paths, cycle, site.id)))
    if (!selected.includes(stage as StageName)) previous[stage as StageName] = s;

  let replay: OpenedReplay | undefined;
  let replayTried = false;
  const ensureReplay = async (): Promise<SnapshotRef | undefined> => {
    if (replay) return replay.snapshot;
    if (replayTried) return undefined;
    replayTried = true;
    const dir = previous.freeze?.artifacts?.snapshot ?? currentSnapshotDir(paths, site.id);
    if (!dir) return undefined;
    mkdirSync(dirname(missesLog), { recursive: true });
    const opened = await openReplay(dir, ports, missesLog, (l) => o.progress?.(`${site.id}: ${l}`));
    replay = opened;
    writeProjectConfig(paths, projectDir, site, opened.snapshot.replayUrl);
    return opened.snapshot;
  };

  try {
    for (const stage of STAGE_ORDER) {
      if (!selected.includes(stage)) continue;
      const blocked = o.signal?.aborted ? { dep: stage, status: "cancelled" } : blockedBy(stage, previous);
      if (blocked) {
        const files = new StageFiles(paths.stageDir(cycle, site.id, stage));
        const summary = skippedSummary(stage, site.id, `skipped: ${blocked.dep} ${blocked.status}`);
        files.log(`${stage} skipped: ${blocked.dep} ${blocked.status}`);
        files.write(summary);
        previous[stage] = summary;
        o.progress?.(`${site.id}: ${stage} skipped (${blocked.dep} ${blocked.status})`);
        continue;
      }
      let snapshot: SnapshotRef | undefined;
      if (stage !== "freeze") {
        try {
          snapshot = await ensureReplay();
        } catch (e) {
          // a broken snapshot fails this stage and everything that needs it, not the matrix
          o.progress?.(`${site.id}: the snapshot's replay did not start: ${(e as Error).message}`);
        }
      }
      o.progress?.(`${site.id}: ${stage} running`);
      const summary = await runStage(o, runners[stage], site, { ...previous }, snapshot, config, ports);
      previous[stage] = summary;
      o.progress?.(
        `${site.id}: ${stage} ${summary.status} (${Math.round(summary.wallClockMs / 1000)} s, ${summary.gates.filter((g) => g.pass).length}/${summary.gates.length} gates)`,
      );
    }
  } finally {
    await replay?.close().catch(() => undefined);
  }
}

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  });
  await Promise.all(workers);
}

/** Runs the matrix and writes `cycles/<N>/matrix.json`: every summary of this cycle on disk, for the named sites. */
export async function runMatrix(o: RunMatrixOptions): Promise<MatrixResult> {
  const config = o.config ?? DEFAULT_AUTOPILOT_CONFIG;
  const ports = o.ports ?? createPortPool();
  const limit = o.parallel ?? config.parallel;
  // A rejection nothing awaits must not end every site's run: it is logged where the collector reads it (§4.2).
  const onStrayRejection = (reason: unknown) => {
    const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    for (const files of activeStages) files.log(`unhandled rejection: ${text}`);
  };
  process.on("unhandledRejection", onStrayRejection);
  try {
    return await runSites(o, config, ports, limit);
  } finally {
    process.off("unhandledRejection", onStrayRejection);
  }
}

async function runSites(
  o: RunMatrixOptions,
  config: AutopilotConfig,
  ports: PortPool,
  limit: number,
): Promise<MatrixResult> {
  await eachLimit(o.sites, limit, async (site) => {
    try {
      await runSite(o, site, config, ports);
    } catch (e) {
      // the project folder could not be set up: recorded for this site, the others carry on
      o.progress?.(`${site.id}: could not run: ${(e as Error).message}`);
      const stage = (o.stages ?? STAGE_ORDER)[0] ?? "freeze";
      const stageDir = o.paths.stageDir(o.cycle, site.id, stage);
      mkdirSync(stageDir, { recursive: true });
      new StageFiles(stageDir).write(crashedSummary(stage, site.id, e, 0, stageDir));
    }
  });
  const matrix: MatrixResult = readMatrix(o.paths, o.cycle) ?? {
    cycle: o.cycle,
    commit: "",
    sites: {},
  };
  matrix.commit = gitCommit(o.paths.root);
  for (const site of o.sites) matrix.sites[site.id] = readSummaries(o.paths, o.cycle, site.id);
  if (!o.noMatrix) {
    mkdirSync(o.paths.cycleDir(o.cycle), { recursive: true });
    writeFileSync(join(o.paths.cycleDir(o.cycle), "matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);
  }
  return matrix;
}

export interface MatrixVerdict {
  green: boolean;
  /** `site/stage: status` or `site/stage gate` for everything that keeps it from green. */
  failing: string[];
}

/** Green: every stage of every site that ran passed. A hard gate failure also fails the stage. */
export function matrixVerdict(m: MatrixResult, expected: StageName[] = []): MatrixVerdict {
  const failing: string[] = [];
  for (const [site, stages] of Object.entries(m.sites)) {
    for (const want of expected) if (!stages[want]) failing.push(`${site}/${want}: missing`);
    for (const [stage, s] of Object.entries(stages)) {
      if (!s) continue;
      if (s.status !== "passed") failing.push(`${site}/${stage}: ${s.status}`);
      for (const g of s.gates)
        if (g.hard && !g.pass)
          failing.push(`${site}/${stage} ${g.id}${g.viewport ? ` (${g.viewport})` : ""}`);
    }
  }
  return { green: failing.length === 0 && Object.keys(m.sites).length > 0, failing };
}

export type { Gate, StageIssue };
