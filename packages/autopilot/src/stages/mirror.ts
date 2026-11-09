// mirror (plan §2.2): the existing `recreate --mirror` chain against the site's snapshot, in its own project folder.
// Nothing changes in the pipeline; autopilot only reads what it writes (collect.ts readMirrorRun).
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Harness, loadDotEnv, recreateInSession, type Session } from "@harness/core";
import { readJsonOr, readMirrorRun } from "../collect.js";
import type { StageContext, StageIssue, StageRunner, StageSummary } from "../types.js";

export interface MirrorStageOptions {
  /** The harness the run's session comes from; default: the user's own config. */
  createHarness?: (ctx: StageContext) => Harness;
  /** Runs the mirror in the session; default `recreateInSession` (tests replace it). */
  recreate?: typeof recreateInSession;
}

function defaultHarness(ctx: StageContext): Harness {
  return new Harness({ sessionsDir: join(ctx.stageDir, "sessions") });
}

interface VisualRow {
  viewport: string;
  baseline?: string;
  current?: string;
  diff?: string;
}

/** `screens/<viewport>/{original,new,diff}.png` link to the verify folder, they are not copies (§3.4). */
function linkScreens(ctx: StageContext, runDir: string): void {
  const rows = readJsonOr<{ details?: { results?: VisualRow[] } }>(join(runDir, "verify/visual.json"), {})
    .details?.results;
  if (!rows) return;
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.viewport)) continue;
    seen.add(r.viewport);
    const dir = join(ctx.stageDir, "screens", r.viewport);
    mkdirSync(dir, { recursive: true });
    const links: [string | undefined, string][] = [
      [r.baseline, "original.png"],
      [r.current, "new.png"],
      [r.diff, "diff.png"],
    ];
    for (const [rel, name] of links) {
      const source = rel ? join(runDir, rel) : undefined;
      const target = join(dir, name);
      rmSync(target, { force: true });
      if (source && existsSync(source)) symlinkSync(source, target);
    }
  }
}

/** Model answers kept across cycles (§6.1): a repeat run from the same snapshot makes no live call. */
function llmCacheDir(ctx: StageContext): string {
  return join(ctx.paths.state, "llm-cache", ctx.site.id);
}

function copyLlmCache(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
}

function noSnapshotSummary(ctx: StageContext, message: string, startedAt: number): StageSummary {
  const issue: StageIssue = { code: "SNAPSHOT_INCOMPLETE", cause: "missing", message, severity: "error" };
  return {
    stage: "mirror",
    site: ctx.site.id,
    status: "failed",
    wallClockMs: Date.now() - startedAt,
    gates: [],
    issues: [issue],
    artifacts: {},
  };
}

async function mirror(ctx: StageContext, o: MirrorStageOptions): Promise<StageSummary> {
  const startedAt = Date.now();
  const live = process.env.RECREATE_LIVE === "1" ? ctx.site.url : undefined;
  const url = ctx.snapshot?.replayUrl ?? live;
  if (!url)
    return noSnapshotSummary(
      ctx,
      `${ctx.site.id} has no snapshot to mirror from; run freeze first (or set RECREATE_LIVE=1 to mirror the live page)`,
      startedAt,
    );
  loadDotEnv(ctx.paths.root);
  const harness = (o.createHarness ?? defaultHarness)(ctx);
  let session: Session | undefined;
  let runDir: string | undefined;
  try {
    session = harness.createSession({
      projectPath: ctx.projectDir,
      permissionMode: "yolo",
      autoApprove: { permissions: true, plan: true },
      origin: "cli",
      title: `autopilot mirror ${ctx.site.id}`,
    });
    const s = session;
    const unsubscribe = s.subscribe((event) => {
      ctx.event(event);
      if (event.type === "log") ctx.log(event.message);
      if (event.type === "recreate.started") {
        runDir = resolve(ctx.projectDir, event.dir);
        if (ctx.keepCache) copyLlmCache(llmCacheDir(ctx), join(runDir, "llm-cache"));
      }
      if (event.type === "recreate.stage")
        ctx.log(`${event.stage}: ${event.status}${event.detail ? ` (${event.detail})` : ""}`);
    });
    const abort = () => s.cancel();
    ctx.signal.addEventListener("abort", abort, { once: true });
    let finished: Awaited<ReturnType<typeof recreateInSession>>;
    try {
      finished = await (o.recreate ?? recreateInSession)(
        s,
        { url, mode: "mirror" },
        { yes: true, shareCheckout: true },
      );
    } finally {
      ctx.signal.removeEventListener("abort", abort);
      unsubscribe();
    }
    runDir = resolve(ctx.projectDir, finished.dir);
    ctx.log(`mirror run ${finished.runId}: ${finished.status}: ${finished.summary}`);
    copyLlmCache(join(runDir, "llm-cache"), llmCacheDir(ctx));
    linkScreens(ctx, runDir);
    const digest = readMirrorRun(runDir);
    const issues = [...digest.issues];
    let status = digest.status;
    if (finished.status === "cancelled") {
      status = "failed";
      issues.push({
        code: "STAGE_FAILED",
        cause: "cancelled",
        message: "the mirror run was cancelled",
        severity: "error",
        evidence: [join(runDir, "manifest.json")],
      });
    }
    return {
      stage: "mirror",
      site: ctx.site.id,
      status,
      wallClockMs: Date.now() - startedAt,
      gates: digest.gates,
      issues,
      usage: digest.usage,
      artifacts: {
        runDir,
        manifest: join(runDir, "manifest.json"),
        mirrorApp: join(runDir, "out/mirror"),
        verifyDir: join(runDir, "verify"),
        report: join(runDir, "REPORT.md"),
      },
    };
  } finally {
    session?.close();
  }
}

export function createMirrorStage(options: MirrorStageOptions = {}): StageRunner {
  return { name: "mirror", run: (ctx) => mirror(ctx, options) };
}

export const mirrorStage: StageRunner = createMirrorStage();
