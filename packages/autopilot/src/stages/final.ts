// final (plan §2.5): the replica judged like the mirror: the verify suite against the snapshot, then the rebuild
// pipeline's responsive sweep and flow lint, the DS coverage metric and a compare page.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { launchChromium, parseSiteConfigYaml, Workspace, type StepReport } from "@harness/mirror-core";
import { AppServer } from "@harness/mirror-fix";
import { runMirror } from "@harness/mirror";
import { loadForCaptureInfo, newCaptureContext, verifyStep } from "@harness/mirror-verify";
import { appFlowInput, measureRunOutput, RunDir, type RecreateHost } from "@harness/recreate";
import {
  COVERAGE_PROBE_JS,
  summariseCoverage,
  type CoverageResult,
  type CoverageSample,
} from "../coverage.js";
import { scrubbedEnv } from "../ds-build.js";
import { nextBinOf } from "../replica-app.js";
import { DISMISSED_QUERY } from "../replica-overlays.js";
import type { Gate, StageContext, StageIssue, StageRunner, StageSummary } from "../types.js";
import { viewportsOf } from "./replica.js";

/** The checks whose gates are hard for the replica (§1), and the advisory one. */
const HARD_CHECKS = ["visual", "content", "links", "media", "fidelity"];
const ADVISORY_CHECKS = ["a11y"];

interface VisualRow {
  viewport: string;
  parity?: number;
  parityPass?: boolean;
  bboxPass?: boolean;
  heightPass?: boolean;
  bbox?: { maxDelta?: number | string };
  height?: { delta?: number };
  diff?: string;
  baseline?: string;
  current?: string;
  diagnosis?: { file: string; cause: string };
}

/** Sweep findings as the §4.2 codes. */
export function sweepIssues(
  sweep: readonly {
    width: number;
    pass: boolean;
    issues: string[];
    pairs?: unknown[];
    clipped?: unknown[];
    hscroll?: number;
    height?: { pct: number };
  }[],
): StageIssue[] {
  const out: StageIssue[] = [];
  for (const c of sweep) {
    if (c.pass) continue;
    for (const msg of c.issues) {
      const code = /overlap|over other|content pair/i.test(msg)
        ? "OVERLAP"
        : /cut|clipped/i.test(msg)
          ? "CUT_TEXT"
          : /scroll|offscreen|outside the screen/i.test(msg)
            ? "SIDEWAYS_SCROLL"
            : /height/i.test(msg)
              ? "HEIGHT_DRIFT"
              : "OVERLAP";
      out.push({ code, message: `${c.width}px: ${msg}`, severity: "error" });
    }
  }
  return out;
}

/** The hard gates of the final stage from verify's report, per viewport for the visual ones. */
export function gatesFromVerify(report: Pick<StepReport, "gates">, rows: readonly VisualRow[]): Gate[] {
  const gates: Gate[] = [];
  // the thresholds verify itself applied: this stage never sets its own
  const parity = report.gates?.["visual.parity"]?.threshold as Gate["threshold"];
  const bboxPx = report.gates?.["visual.bbox"]?.threshold as Gate["threshold"];
  const heightPx = report.gates?.["visual.height"]?.threshold as Gate["threshold"];
  for (const r of rows) {
    if (typeof r.parity === "number")
      gates.push({
        id: "visual.parity",
        viewport: r.viewport,
        pass: !!r.parityPass,
        hard: true,
        value: r.parity,
        threshold: parity,
      });
    gates.push({
      id: "visual.bbox",
      viewport: r.viewport,
      pass: !!r.bboxPass,
      hard: true,
      value: r.bbox?.maxDelta ?? "missing",
      threshold: bboxPx,
    });
    gates.push({
      id: "visual.height",
      viewport: r.viewport,
      pass: !!r.heightPass,
      hard: true,
      value: r.height?.delta ?? "missing",
      threshold: heightPx,
    });
  }
  for (const [id, g] of Object.entries(report.gates ?? {})) {
    const check = id.split(".")[0]!;
    if (check === "visual") {
      if (!rows.length)
        gates.push({
          id,
          pass: g.pass,
          hard: true,
          value: g.value as Gate["value"],
          threshold: g.threshold as Gate["threshold"],
        });
      continue;
    }
    const hard = HARD_CHECKS.includes(check);
    if (!hard && !ADVISORY_CHECKS.includes(check)) continue;
    gates.push({
      id,
      pass: g.pass,
      hard,
      value: g.value as Gate["value"],
      threshold: g.threshold as Gate["threshold"],
    });
  }
  return gates;
}

export interface FinalStageOptions {
  /** Replaces the verify, sweep and coverage work (tests) with recorded results. */
  measure?: (ctx: StageContext) => Promise<FinalMeasured>;
}

/** The raw measurements the stage turns into gates. */
export interface FinalMeasured {
  verify: Pick<StepReport, "gates" | "issues">;
  rows: VisualRow[];
  sweep: { width: number; pass: boolean; issues: string[]; pairs?: unknown[]; clipped?: unknown[] }[];
  sweepGate?: { name: string; pass: boolean; detail?: string };
  flow?: {
    pass: boolean;
    violations: { rule: string; selector?: string; detail: string }[];
    outOfFlow?: { max: number };
  };
  flowGate?: { name: string; pass: boolean; detail?: string };
  coverage: CoverageResult;
}

export function createFinalStage(options: FinalStageOptions = {}): StageRunner {
  return {
    name: "final",
    async run(ctx: StageContext): Promise<StageSummary> {
      const startedAt = Date.now();
      const replica = ctx.previous.replica;
      const appDir = replica?.artifacts.replicaApp;
      const runDirPath = replica?.artifacts.runDir;
      const oldUrl = ctx.snapshot?.replayUrl;
      const fail = (message: string): StageSummary => ({
        stage: "final",
        site: ctx.site.id,
        status: "failed",
        wallClockMs: Date.now() - startedAt,
        gates: [],
        issues: [{ code: "STAGE_FAILED", cause: "no-input", message, severity: "error" }],
        artifacts: {},
      });
      if (!options.measure && (!appDir || !runDirPath || !existsSync(appDir)))
        return fail("no replica app was built");
      if (!options.measure && !oldUrl) return fail("no snapshot replay URL");
      const measured = options.measure
        ? await options.measure(ctx)
        : await measureReplica(ctx, appDir!, runDirPath!, oldUrl!);

      mkdirSync(ctx.stageDir, { recursive: true });
      const write = (name: string, v: unknown) =>
        writeFileSync(join(ctx.stageDir, name), `${JSON.stringify(v, null, 2)}\n`);
      write("sweep.json", { sweep: measured.sweep, gate: measured.sweepGate });
      write("flow.json", { flow: measured.flow, gate: measured.flowGate });
      write("coverage.json", measured.coverage);

      const gates = gatesFromVerify(measured.verify, measured.rows);
      const issues: StageIssue[] = [];
      for (const i of measured.verify.issues ?? [])
        if (i.severity !== "info")
          issues.push({
            code: i.code,
            message: i.message,
            severity: i.severity === "error" ? "error" : "warning",
          });
      for (const r of measured.rows)
        if (r.parityPass === false)
          issues.push({
            code: "visual.parity",
            ...(r.diagnosis ? { cause: r.diagnosis.cause } : {}),
            message: `${r.viewport}: parity ${r.parity}`,
            severity: "error",
            evidence: [
              join(ctx.stageDir, r.diff ?? ""),
              ...(r.diagnosis ? [join(ctx.stageDir, r.diagnosis.file)] : []),
            ],
          });
      gates.push({
        id: "responsive",
        pass: !!measured.sweepGate?.pass,
        hard: true,
        ...(measured.sweepGate?.detail ? { value: measured.sweepGate.detail.slice(0, 200) } : {}),
      });
      issues.push(...sweepIssues(measured.sweep));
      gates.push({
        id: "flow",
        pass: !!measured.flowGate?.pass,
        hard: true,
        ...(measured.flowGate?.detail ? { value: measured.flowGate.detail.slice(0, 200) } : {}),
      });
      for (const v of measured.flow?.violations ?? [])
        issues.push({
          code: "FLOW",
          cause: v.rule,
          message: `${v.selector ?? ""} ${v.detail}`.trim(),
          severity: "error",
        });

      // the loop passes the ratcheted target as `coverage.start` (§6.4)
      const target = ctx.config.coverage.start;
      const coverage = measured.coverage;
      const covered = coverage.value >= target;
      gates.push({ id: "ds.coverage", pass: covered, hard: true, value: coverage.value, threshold: target });
      if (!covered)
        issues.push({
          code: "DS_COVERAGE_LOW",
          message: `coverage ${coverage.value} below target ${target} (primitives alone ${coverage.primitiveOnly}, with section composites ${coverage.withSections})`,
          severity: "error",
          evidence: [join(ctx.stageDir, "coverage.json")],
        });

      const status: StageSummary["status"] = gates.filter((g) => g.hard).every((g) => g.pass)
        ? "passed"
        : "failed";
      return {
        stage: "final",
        site: ctx.site.id,
        status,
        wallClockMs: Date.now() - startedAt,
        gates,
        issues,
        artifacts: {
          replicaApp: appDir ?? "",
          compare: join(ctx.stageDir, "compare", "index.html"),
          verifyDir: join(ctx.stageDir, "verify"),
          coverage: join(ctx.stageDir, "coverage.json"),
        },
      };
    },
  };
}

/** The mirror run whose content model verify reads; made here when the matrix ran without the mirror stage. */
async function mirrorRun(ctx: StageContext, oldUrl: string): Promise<string> {
  const given = ctx.previous.mirror?.artifacts.runDir;
  if (given && existsSync(join(given, "ccm"))) return given;
  ctx.log("no mirror run to take the content model from: running the mirror once (no fix loop, no model)");
  const r = await runMirror(
    { url: oldUrl, mode: "mirror", fix: false },
    {
      projectRoot: ctx.projectDir,
      config: { allowLocal: true, respectRobots: false },
      signal: ctx.signal,
      progress: () => undefined,
      log: ctx.log,
      consent: async () => ({ by: "auto", at: new Date().toISOString(), mode: "yes" }),
      secretEnv: Object.keys(process.env).filter((k) => !(k in scrubbedEnv())),
    },
  );
  return join(ctx.projectDir, r.dir);
}

/** The composites' stylesheet as it was emitted, before its values became tokens: tokens would hide its numbers from the lint. */
function rawCss(ctx: StageContext): string {
  const ds =
    ctx.previous["design-system"]?.artifacts.designSystem ?? ctx.previous.replica?.artifacts.designSystem;
  return ds ? readFileSync(join(ds, "design-system/composites.raw.css"), "utf8") : "";
}

async function measureReplica(
  ctx: StageContext,
  appDir: string,
  runDirPath: string,
  oldUrl: string,
): Promise<FinalMeasured> {
  const env = scrubbedEnv();
  const port = await ctx.ports.acquire();
  const server = new AppServer({
    appDir,
    port,
    baseEnv: env,
    env: {},
    startCmd: (p) => [
      process.execPath,
      [nextBinOf(appDir), "start", "--hostname", "127.0.0.1", "-p", String(p)],
    ],
    onLog: (l) => ctx.log(l.trimEnd()),
  });
  const newUrl = `http://127.0.0.1:${port}/`;
  const mirrorDir = await mirrorRun(ctx, oldUrl);
  await server.restart();
  try {
    const runId = basename(mirrorDir);
    const siteFile = join(mirrorDir, "sites", `${runId}.yaml`);
    const { config } = parseSiteConfigYaml(readFileSync(siteFile, "utf8"), siteFile);
    // verify works in this stage's folder (final/verify/…) and reads the mirror run's content model and crawl
    mkdirSync(ctx.stageDir, { recursive: true });
    for (const d of ["ccm", "raw", "design"]) {
      const from = join(mirrorDir, d);
      const to = join(ctx.stageDir, d);
      if (existsSync(from) && !existsSync(to)) symlinkSync(from, to, "dir");
    }
    const ws = new Workspace(basename(ctx.stageDir), dirname(ctx.stageDir));
    await ws.init();
    const old = new URL(oldUrl);
    const log = {
      info: (m: string) => ctx.log(m),
      warn: (m: string) => ctx.log(`warning: ${m}`),
      error: (m: string) => ctx.log(`error: ${m}`),
      debug: () => undefined,
    };
    const report = await verifyStep({
      site: config,
      ws,
      dryRun: false,
      log,
      options: {
        newBaseUrl: `http://localhost:${port}`,
        oldBaseUrl: old.origin,
        urls: [old.pathname + old.search],
        checks: [...HARD_CHECKS, ...ADVISORY_CHECKS],
      },
    });
    const visual = JSON.parse(readFileSync(join(ctx.stageDir, "verify/visual.json"), "utf8")) as {
      details?: { results?: VisualRow[] };
    };
    const rows = visual.details?.results ?? [];
    linkScreens(ctx, rows);

    // the responsive sweep and the flow lint of the rebuild pipeline, against the run's own live captures
    const runId2 = basename(runDirPath);
    const run = new RunDir(ctx.projectDir, runId2);
    const boundaries = (run.manifest().variants ?? []).map((v) => v.minWidth).filter((w) => w > 0);
    const html = await fetch(newUrl)
      .then((r) => r.text())
      .catch(() => "");
    const host: Pick<RecreateHost, "projectRoot" | "config" | "signal" | "log"> = {
      projectRoot: ctx.projectDir,
      config: { allowLocal: true, respectRobots: false },
      signal: ctx.signal,
      log: ctx.log,
    };
    const m = await measureRunOutput(host, runId2, {
      target: "replica",
      page: `${newUrl}?${DISMISSED_QUERY}`,
      compare: "compare/replica.html",
      outputPage: newUrl,
      flow: appFlowInput(rawCss(ctx), html, boundaries),
    });
    // the compare page and its pictures, in the layout the page's relative links expect
    const compareOut = join(ctx.stageDir, "compare");
    mkdirSync(compareOut, { recursive: true });
    cpSync(join(runDirPath, "compare/replica.html"), join(compareOut, "index.html"));
    cpSync(join(runDirPath, "measure/replica"), join(ctx.stageDir, "measure/replica"), { recursive: true });

    // coverage on the running app, with the routine verify uses
    const browser = await launchChromium({ headless: true });
    const samples: CoverageSample[] = [];
    try {
      const capture = {
        allowHosts: [new URL(newUrl).host, new URL(newUrl).hostname],
        allowThirdParty: false,
      };
      for (const vp of viewportsOf(ctx)) {
        const context = await newCaptureContext(browser, vp, capture);
        try {
          const page = await context.newPage();
          await loadForCaptureInfo(page, `${newUrl}?${DISMISSED_QUERY}`, vp);
          const s = (await page.evaluate(COVERAGE_PROBE_JS)) as Omit<CoverageSample, "viewport">;
          samples.push({ viewport: vp.name, ...s });
        } finally {
          await context.close().catch(() => undefined);
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
    return {
      verify: report,
      rows,
      sweep: m.sweep ?? [],
      sweepGate: m.gates.find((g) => g.name === "responsive"),
      flow: m.flow,
      flowGate: m.gates.find((g) => g.name === "flow"),
      coverage: summariseCoverage(samples),
    };
  } finally {
    await server.stop();
    ctx.ports.release(port);
  }
}

/** `screens/<viewport>/{original,new,diff}.png` link to verify's pictures (§3.4). */
function linkScreens(ctx: StageContext, rows: readonly VisualRow[]): void {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.viewport)) continue;
    seen.add(r.viewport);
    const dir = join(ctx.stageDir, "screens", r.viewport);
    mkdirSync(dir, { recursive: true });
    for (const [rel, name] of [
      [r.baseline, "original.png"],
      [r.current, "new.png"],
      [r.diff, "diff.png"],
    ] as const) {
      const from = rel ? join(ctx.stageDir, rel) : undefined;
      if (from && existsSync(from) && !existsSync(join(dir, name))) symlinkSync(from, join(dir, name));
    }
  }
}

export const finalStage: StageRunner = createFinalStage();
