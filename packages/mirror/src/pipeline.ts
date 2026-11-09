// Mirror mode of the recreation: the page's own markup, styles and scripts are captured and re-served by a generated
// Next.js app, then held to the verify suite. The stages run the same steps in the same order as the pipeline this
// was taken from; a stage's failing gate stops the run except where that pipeline carries on (design, verify, fix).
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import YAML from "yaml";
import type {
  EventBody,
  RecreateConsent,
  RecreateRequest,
  RecreateStage,
  RecreateWidthResult,
} from "@harness/protocol";
import {
  checkRobots,
  findChrome,
  GuardError,
  resolveChecked,
  validateUrl,
  type GuardOptions,
} from "@harness/capture";
import { comparePage, type MeasureReport } from "@harness/measure";
import {
  excludeRunsFromGit,
  isRunId,
  joinInside,
  newRunId,
  normaliseUrl,
  resolveOut,
  RunDir,
  RUNS_DIR,
  type RecreateResult,
  type RunManifest,
} from "@harness/recreate";
import {
  createHostLlmClient,
  DEFAULT_VIEWPORTS,
  emptyReport,
  failingGates,
  parseSiteConfigYaml,
  runStep,
  validateCcm,
  withRunScope,
  Workspace,
  type HostComplete,
  type LlmClient,
  type Logger,
  type SiteConfig,
  type StepContext,
  type StepFn,
  type StepReport,
} from "@harness/mirror-core";
import { htmlAdapter } from "@harness/mirror-capture";
import { designExtract } from "@harness/mirror-design";
import { nextjsContentfulGenerator } from "@harness/mirror-generate";
import {
  captureScreenshot,
  contextFromStep,
  loadForCaptureInfo,
  newCaptureContext,
  verifyStep,
} from "@harness/mirror-verify";
import {
  AppServer,
  runAutofix,
  selectHandlers,
  type AttemptRecord,
  type Handler,
  type RerunOptions,
  type RerunStep,
  type StepRunner,
} from "@harness/mirror-fix";
import { APP_DIR, freePort, installAppDeps, nextBin } from "./app.js";
import { reportStep } from "./report.js";
import { resolveSource, SourceBlocked } from "./source.js";

export type MirrorProgress = Extract<EventBody, { type: `recreate.${string}` }>;

export interface MirrorConfig {
  enabled?: boolean;
  respectRobots?: boolean;
  allowLocal?: boolean;
  assets?: "run-dir" | "project" | "none";
  mirror?: {
    viewports?: { name: string; width: number; height: number }[];
    maxPages?: number;
    gates?: { parity?: number; bboxPx?: number; textSimilarity?: number };
    fix?: { enabled?: boolean; maxIterations?: number; budgetUsd?: number };
    mask?: string[];
  };
}

export interface MirrorHost {
  projectRoot: string;
  config: MirrorConfig;
  signal?: AbortSignal;
  progress(e: MirrorProgress): void;
  log(message: string): void;
  consent(info: { url: string; reason: string }): Promise<RecreateConsent | null>;
  complete?: HostComplete;
  /** environment variables the generated app's build and server must not see */
  secretEnv?: string[];
}

export const MIRROR_STAGES: RecreateStage[] = [
  "consent",
  "crawl",
  "ccm",
  "design",
  "generate",
  "appbuild",
  "serve",
  "verify",
  "fix",
  "reverify",
  "report",
];

export const MIRROR_CONSENT_REASON = (url: string) =>
  `Mirrors ${url} 1:1: copies its markup, stylesheets, scripts, images and fonts into .harness/recreate (kept out of git) and builds and runs a local Next.js app from them, which executes code derived from that page on this machine. The result is a verbatim copy. You are responsible for how you use the result.`;

/** Reported, but no reason to call the copy a failure: a mirror holds raw HTML by design and has no SEO mapping step. */
const ADVISORY_GATE = /^(seo|a11y|performance|cleanliness)\./;

const DEFAULT_BUDGET_USD = 3.9;
const SITE_DIR = "sites";
const PREVIEW_DIR = "out/preview";

class MirrorCancelled extends Error {}
class StageFailed extends Error {}

const reportPassed = (r: StepReport) => r.ok && failingGates(r).length === 0;
const hadCrash = (r: StepReport) => r.issues.some((i) => i.code === "STEP_FAILED");

function pngSize(file: string): { width: number; height: number } {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(24);
    readSync(fd, b, 0, 24, 0);
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } finally {
    closeSync(fd);
  }
}

/** Public addresses, plus the run's own app. */
export function requestGuard(options: GuardOptions, appOrigins: Set<string>) {
  const hosts = new Map<string, Promise<boolean>>();
  return (url: URL): boolean | Promise<boolean> => {
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;
    if (appOrigins.has(url.origin)) return true;
    let verdict = hosts.get(url.host);
    if (!verdict) {
      verdict = (async () => {
        try {
          await resolveChecked(validateUrl(url.href, options), options);
          return true;
        } catch (e) {
          // a host that does not resolve fails by itself, and the page's own error handling sees that
          return e instanceof GuardError && e.code === "unreachable";
        }
      })();
      hosts.set(url.host, verdict);
    }
    return verdict;
  };
}

function viewportsOf(config: MirrorConfig): { name: string; width: number; height: number }[] {
  return config.mirror?.viewports?.length ? config.mirror.viewports : DEFAULT_VIEWPORTS;
}

function siteYaml(
  id: string,
  source: { origin: string; path: string; locales: string[] },
  config: MirrorConfig,
  request: RecreateRequest,
  port: number,
): string {
  const gates = config.mirror?.gates;
  return YAML.stringify({
    site: id,
    name: new URL(source.origin).hostname.replace(/^www\./, ""),
    baseUrl: source.origin,
    urls: [source.path],
    locales: source.locales.map((code, i) => ({ code, default: i === 0, pathPrefix: i ? code : "" })),
    source: { adapter: "html", themePack: "none" },
    crawl: {
      follow: (request.pages ?? config.mirror?.maxPages ?? 1) > 1,
      maxPages: request.pages ?? config.mirror?.maxPages ?? 1,
      viewports: viewportsOf(config),
      mask: config.mirror?.mask ?? [],
    },
    target: { adapter: "contentful" },
    frontend: { generator: "nextjs-contentful", appDir: APP_DIR, dataSource: "ccm" },
    llm: {
      sendContent: false,
      budgetUsd: config.mirror?.fix?.budgetUsd ?? DEFAULT_BUDGET_USD,
      stepModels: {},
    },
    autofix: {
      appPort: port,
      ...(config.mirror?.fix?.maxIterations ? { maxIterations: config.mirror.fix.maxIterations } : {}),
    },
    ...(gates
      ? {
          parity: {
            ...(gates.parity !== undefined ? { screenshotThreshold: gates.parity } : {}),
            ...(gates.bboxPx !== undefined ? { bboxTolerancePx: gates.bboxPx } : {}),
            ...(gates.textSimilarity !== undefined ? { textSimilarity: gates.textSimilarity } : {}),
          },
        }
      : {}),
  });
}

class Mirror {
  readonly dir: RunDir;
  readonly ws: Workspace;
  readonly log: Logger;
  site!: SiteConfig;
  port = 0;
  llm?: LlmClient;
  server?: AppServer;
  private readonly appOrigins = new Set<string>();
  readonly guard: ReturnType<typeof requestGuard>;

  constructor(
    readonly host: MirrorHost,
    readonly m: RunManifest,
  ) {
    this.dir = new RunDir(host.projectRoot, m.id);
    this.ws = new Workspace(m.id, join(host.projectRoot, RUNS_DIR));
    const say = (l: string) => (msg: string) => host.log(`${l}${msg}`);
    this.log = { info: say(""), warn: say("warning: "), error: say("error: "), debug: () => undefined };
    this.guard = requestGuard({ allowLocal: host.config.allowLocal === true }, this.appOrigins);
  }

  get url() {
    return this.m.request.url;
  }
  get siteFile() {
    return this.dir.path(SITE_DIR, `${this.m.id}.yaml`);
  }
  get appDir() {
    return this.dir.path(APP_DIR);
  }
  get newBaseUrl() {
    return `http://localhost:${this.port}`;
  }

  emit(e: MirrorProgress) {
    this.host.progress(e);
  }

  cancelled() {
    if (this.host.signal?.aborted) throw new MirrorCancelled("Cancelled.");
  }

  async usePort() {
    this.port = await freePort();
    this.appOrigins.add(`http://localhost:${this.port}`);
    this.appOrigins.add(`http://127.0.0.1:${this.port}`);
  }

  appEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of this.host.secretEnv ?? []) delete env[name];
    return env;
  }

  appServer(): AppServer {
    this.server ??= new AppServer({
      appDir: this.appDir,
      port: this.port,
      baseEnv: this.appEnv(),
      env: { CCM_DIR: this.ws.path("ccm") },
      buildCmd: [process.execPath, [nextBin(this.appDir), "build"]],
      startCmd: (port) => [
        process.execPath,
        [nextBin(this.appDir), "start", "--hostname", "127.0.0.1", "-p", String(port)],
      ],
      onLog: (l) => this.host.log(l.trimEnd()),
    });
    return this.server;
  }

  async stopApp() {
    await this.server?.stop();
  }

  loadSite() {
    const { config } = parseSiteConfigYaml(readFileSync(this.siteFile, "utf8"), this.siteFile);
    this.site = { ...config, autofix: { ...config.autofix, appPort: this.port } } as SiteConfig;
  }

  ctx(step: string, options: Record<string, unknown> = {}, llm?: LlmClient): StepContext {
    return { site: this.site, ws: this.ws, dryRun: false, log: this.log, llm, options };
  }

  step(name: string, fn: StepFn, options: Record<string, unknown> = {}, llm?: LlmClient) {
    return runStep(name, fn, this.ctx(name, options, llm));
  }

  /** A step whose failing gate ends the run. */
  async must(name: string, fn: StepFn, options: Record<string, unknown> = {}, llm?: LlmClient) {
    const r = await this.step(name, fn, options, llm);
    if (!reportPassed(r)) {
      const failing = failingGates(r);
      const first = r.issues.find((i) => i.severity === "error")?.message.split("\n")[0];
      throw new StageFailed(
        `${name}: ${failing.length ? `failing gates ${failing.join(", ")}` : (first ?? "step failed")}`,
      );
    }
    return r;
  }

  /** A step that may miss its gates; only a crash ends the run. */
  async soft(name: string, fn: StepFn, options: Record<string, unknown> = {}) {
    const r = await this.step(name, fn, options);
    if (hadCrash(r))
      throw new StageFailed(`${name}: ${r.issues.find((i) => i.code === "STEP_FAILED")?.message}`);
    return r;
  }

  private transform: StepFn = async (ctx) => {
    const report = await htmlAdapter.toCCM(ctx);
    const v = await validateCcm(ctx.ws);
    return {
      ...report,
      ok: report.ok && v.ok,
      issues: [
        ...report.issues,
        ...v.issues.filter((i) => !report.issues.some((x) => x.code === i.code && x.message === i.message)),
      ],
      gates: { ...(report.gates ?? {}), "ccm.valid": { pass: v.ok, value: v.stats.errors, threshold: 0 } },
    };
  };

  // ---------------------------------------------------------------------------------------------------- stages
  async crawl() {
    const options: GuardOptions = { allowLocal: this.host.config.allowLocal === true };
    const checked = validateUrl(this.url, options);
    if (this.host.config.respectRobots !== false) {
      const r = await checkRobots(checked.toString(), { ...options, userAgent: "cmp-crawler" });
      if (!r.allowed) throw new StageFailed(`${this.url}: ${r.rule}`);
    }
    const source = await resolveSource(checked.toString());
    if (source.redirectedFrom)
      this.host.log(`followed redirect ${source.redirectedFrom} to ${source.origin}${source.path}`);
    this.m.finalUrl = `${source.origin}${source.path}`;
    this.dir.write(
      `${SITE_DIR}/${this.m.id}.yaml`,
      siteYaml(this.m.id, source, this.host.config, this.m.request, this.port),
    );
    this.loadSite();
    await this.ws.init();
    const r = await this.must("extract", (ctx) => htmlAdapter.extract(ctx));
    return { detail: `${r.stats.pages ?? this.site.urls.length} page(s), ${r.stats.assets ?? 0} assets` };
  }

  /**
   * Retakes the crawl-time screenshots with verify's own routine (frozen timers, pinned sticky elements). The crawl's
   * shots catch sticky headers mid-page and heroes in another state, which verify would then report as source drift
   * and judge the app against, although the app matches the live page.
   */
  private async stabiliseBaseline() {
    const cx = await contextFromStep(this.ctx("verify", { newBaseUrl: this.newBaseUrl }));
    try {
      const browser = await cx.browser();
      for (const path of cx.urls)
        for (const vp of this.site.crawl.viewports) {
          const shot = cx.crawlPage(path)?.screenshots[vp.name];
          if (!shot) continue;
          const context = await newCaptureContext(browser, vp, cx.capture);
          try {
            const page = await context.newPage();
            const url = cx.oldBaseUrl + path;
            const info = await loadForCaptureInfo(page, url, vp);
            if (info.status >= 200 && info.status < 400)
              await this.ws.writeText(
                shot,
                await captureScreenshot(page, url, vp, { mask: cx.mask, skipLoad: true }),
              );
          } finally {
            await context.close().catch(() => undefined);
          }
        }
    } finally {
      await cx.close();
    }
  }

  private emitShots() {
    for (const vp of this.site.crawl.viewports) {
      const dir = this.ws.path("design/screenshots", vp.name);
      if (!existsSync(dir)) continue;
      const crawl = this.readCrawlPages();
      const id = crawl[0];
      if (!id) continue;
      const file = join(dir, `${id}.png`);
      if (!existsSync(file)) continue;
      const { width, height } = pngSize(file);
      this.emit({
        type: "recreate.shot",
        runId: this.m.id,
        kind: "live",
        width,
        height,
        path: this.dir.rel("design/screenshots", vp.name, `${id}.png`),
      });
    }
  }

  private readCrawlPages(): string[] {
    try {
      const c = JSON.parse(readFileSync(this.ws.path("raw/html/crawl.json"), "utf8")) as {
        pages: { id: string }[];
      };
      return c.pages.map((p) => p.id);
    } catch {
      return [];
    }
  }

  async ccm() {
    await this.must("analyze", (ctx) => htmlAdapter.analyze(ctx));
    await this.must("map", (ctx) => htmlAdapter.proposeMapping!(ctx));
    await this.must("transform", this.transform);
    // rule candidates run with or without a model
    const r = await this.autofix(selectHandlers(["profile-infer", "mapping-review"]));
    if (!r.report.ok) throw new StageFailed("the content fix loop failed");
    await this.must("transform", this.transform);
    await this.stabiliseBaseline();
    this.emitShots();
    const v = await validateCcm(this.ws);
    return { detail: `${v.stats.entries ?? 0} entries` };
  }

  async design() {
    const r = await this.soft("design-extract", designExtract);
    return { detail: String(r.stats.renderMode ?? "") || undefined };
  }

  async generate() {
    await this.must("frontend-generate", nextjsContentfulGenerator.generate, {
      repoRoot: this.dir.path(),
      install: false,
    });
    this.writeProvenance();
    this.m.outputs = [{ target: "mirror", path: APP_DIR }];
    return {};
  }

  private writeProvenance() {
    const at = new Date().toISOString();
    this.dir.writeJson(`${APP_DIR}/credits.json`, {
      source: this.m.finalUrl ?? this.url,
      capturedAt: at,
      mode: "mirror",
      copied: ["markup", "stylesheets", "scripts", "images", "fonts"],
    });
    this.dir.write(
      `${APP_DIR}/RECREATION.md`,
      `# Mirror of ${this.m.finalUrl ?? this.url}\n\nCaptured ${at}. This app re-serves the page's own markup, stylesheets, scripts, images and fonts verbatim. They belong to their owners: use this copy for your own evaluation and prototyping, or with the rights holder's permission.\n`,
    );
  }

  async appbuild() {
    await installAppDeps(this.appDir, join(this.host.projectRoot, RUNS_DIR), this.appEnv(), (m) =>
      this.host.log(m),
    );
    await this.buildApp();
    return {};
  }

  private async buildApp() {
    const b = await this.appServer().build();
    if (!b.ok) throw new StageFailed(`next build failed: ${b.output.slice(-1500)}`);
  }

  async serve() {
    await this.appServer().restart();
    return { detail: this.newBaseUrl };
  }

  async verify(stage: "verify" | "reverify") {
    const r = await this.soft("verify", verifyStep, { newBaseUrl: this.newBaseUrl });
    this.emitGates(stage, r);
    const failing = failingGates(r).filter((g) => !ADVISORY_GATE.test(g));
    return { detail: failing.length ? `failing: ${failing.join(", ")}` : "all gates pass" };
  }

  private emitGates(stage: "verify" | "reverify", r: StepReport) {
    const drift = r.issues.filter((i) => i.code === "SOURCE_DRIFT").length;
    for (const [name, g] of Object.entries(r.gates ?? {})) {
      const check = name.split(".")[0];
      this.emit({
        type: "recreate.verify",
        runId: this.m.id,
        stage,
        check,
        gate: name,
        pass: g.pass,
        ...(g.value !== undefined ? { value: g.value } : {}),
        ...(g.threshold !== undefined ? { threshold: g.threshold } : {}),
        issues: r.issues.filter(
          (i) => i.severity !== "info" && i.code.toLowerCase().includes(check.toLowerCase()),
        ).length,
        advisory: ADVISORY_GATE.test(name),
        ...(drift ? { drift } : {}),
      });
    }
  }

  private async autofix(handlers: Handler[]) {
    const runner = this.runner();
    let result: Awaited<ReturnType<typeof runAutofix>> | undefined;
    const report = await runStep(
      "autofix",
      async () => {
        try {
          result = await runAutofix({
            site: this.site,
            ws: this.ws,
            repoRoot: this.dir.path(),
            log: this.log,
            handlers,
            runner,
            llm: this.llm,
            dryRun: false,
            newBaseUrl: this.newBaseUrl,
            appPort: this.port,
            budgetUsd: this.host.config.mirror?.fix?.budgetUsd ?? DEFAULT_BUDGET_USD,
          });
          return result.report;
        } finally {
          await runner.close?.();
        }
      },
      this.ctx("autofix"),
    );
    return { report, attempts: result?.attempts ?? [], stopReason: result?.stopReason ?? "failed" };
  }

  /** Same steps as the stages; the app is rebuilt and restarted through the run's own server. */
  private runner(): StepRunner {
    const fns: Record<string, StepFn> = {
      transform: this.transform,
      "design-extract": designExtract,
      "frontend-generate": nextjsContentfulGenerator.generate,
      verify: verifyStep,
    };
    return {
      run: async (step: RerunStep, opts: RerunOptions = {}): Promise<StepReport> => {
        this.cancelled();
        if (step === "build") {
          const r = emptyReport("build", { site: this.site, dryRun: false });
          await this.stopApp();
          const b = await this.appServer().build();
          if (!b.ok)
            return {
              ...r,
              ok: false,
              issues: [
                {
                  severity: "error",
                  code: "BUILD_FAILED",
                  message: `next build failed: ${b.output.slice(-1500)}`,
                  actionable: true,
                },
              ],
            };
          await this.appServer().restart();
          return r;
        }
        const fn = fns[step];
        if (!fn) throw new Error(`the fix loop cannot re-run step "${step}"`);
        const options: Record<string, unknown> = { ...(opts.options ?? {}) };
        if (step === "frontend-generate") {
          options.repoRoot = this.dir.path();
          options.install = false;
          options.refreshTemplate ??= false;
        }
        if (step === "verify") {
          if (!this.appServer().running) {
            if (!existsSync(join(this.appDir, ".next")))
              return {
                ...emptyReport("verify", { site: this.site, dryRun: false }),
                ok: false,
                issues: [
                  { severity: "error", code: "APP_NOT_BUILT", message: "the app has not been built yet" },
                ],
              };
            await this.appServer().restart();
          }
          options.newBaseUrl = this.newBaseUrl;
          if (opts.verify?.checks?.length) options.checks = opts.verify.checks;
          if (opts.verify?.urls?.length) options.urls = opts.verify.urls;
          if (opts.verify?.viewports?.length)
            options.viewports = this.site.crawl.viewports.filter((v) =>
              opts.verify!.viewports!.includes(v.name),
            );
        }
        return runStep(step, fn, this.ctx(step, options));
      },
      close: async () => undefined,
    };
  }

  fixEnabled() {
    return this.m.request.fix !== false && this.host.config.mirror?.fix?.enabled !== false;
  }

  async fix() {
    if (!this.fixEnabled()) return { status: "skipped" as const, detail: "off" };
    await this.stopApp();
    const r = await this.autofix(selectHandlers());
    for (const a of r.attempts) this.emitAttempt(a);
    if (hadCrash(r.report)) throw new StageFailed("the fix loop crashed");
    const accepted = r.attempts.filter((a) => a.accepted).length;
    return {
      detail: r.attempts.length
        ? `${r.attempts.length} attempt(s), ${accepted} kept (${r.stopReason})`
        : "no fix to try",
    };
  }

  private emitAttempt(a: AttemptRecord) {
    const primary = (x?: { primary?: unknown }) => (typeof x?.primary === "number" ? x.primary : undefined);
    this.emit({
      type: "recreate.fix",
      runId: this.m.id,
      handler: a.handler,
      target: a.candidate.title,
      accepted: a.accepted,
      reason: a.reason,
      ...(primary(a.before) !== undefined ? { before: primary(a.before) } : {}),
      ...(primary(a.after) !== undefined ? { after: primary(a.after) } : {}),
    });
  }

  async reverify() {
    if (!this.fixEnabled()) return { status: "skipped" as const, detail: "fix off" };
    await this.stopApp();
    await this.buildApp();
    await this.appServer().restart();
    return this.verify("reverify");
  }

  async report() {
    await this.soft("report", reportStep);
    await this.writePreview().catch((e: Error) => this.host.log(`no preview: ${e.message}`));
    this.finishMeasurement();
    return {};
  }

  /** The last verify's numbers become the run's gates and compare page. */
  private finishMeasurement() {
    const summary = this.readJson<{
      gates?: Record<string, { pass: boolean; value?: unknown; threshold?: unknown }>;
    }>("verify/summary.json");
    const extract = this.readJson<StepReport>("reports/extract.json");
    const ccm = this.readJson<StepReport>("reports/transform.json");
    const all = { ...(extract?.gates ?? {}), ...(ccm?.gates ?? {}), ...(summary?.gates ?? {}) };
    const gates = Object.entries(all)
      .filter(([name]) => !ADVISORY_GATE.test(name))
      .map(([name, g]) => ({
        name,
        pass: g.pass,
        detail: `${String(g.value ?? "")}${g.threshold !== undefined ? ` (limit ${String(g.threshold)})` : ""}`,
      }));
    this.m.gates = gates;
    const rows = (
      this.readJson<{ details?: { results?: VisualRow[] } }>("verify/visual.json")?.details?.results ?? []
    ).filter((r) => typeof r.parity === "number");
    const primary = this.m.finalUrl ? new URL(this.m.finalUrl).pathname : rows[0]?.path;
    const shown = rows.filter((r) => r.path === primary);
    const widths: RecreateWidthResult[] = [];
    const measured: MeasureReport["widths"] = [];
    for (const r of shown.length ? shown : rows) {
      const vp = this.site.crawl.viewports.find((v) => v.name === r.viewport);
      if (!vp || widths.some((w) => w.width === vp.width)) continue;
      const pixel = 1 - (r.parity ?? 0);
      const height = { live: r.height?.old ?? 0, out: r.height?.new ?? 0 };
      widths.push({ width: vp.width, pixel, textReal: 0, textDrift: 0, height, hscroll: 0 });
      measured.push({
        width: vp.width,
        pixel,
        shifted: 0,
        textReal: 0,
        textDrift: 0,
        liveHeight: height.live,
        outHeight: height.out,
        heightPct: height.live ? (Math.abs(height.out - height.live) / height.live) * 100 : 0,
        hscroll: 0,
        bands: [],
        text: { real: [], drift: [] } as never,
        interactions: [],
      });
      this.copyShot(r.baseline, vp.width, "live");
      this.copyShot(r.current, vp.width, "out");
      this.copyShot(r.diff, vp.width, "diff");
    }
    const report: MeasureReport = {
      target: "mirror",
      at: new Date().toISOString(),
      widths: measured,
      gates: gates.map((g) => ({ name: g.name, pass: g.pass, detail: g.detail })) as never,
      pass: gates.every((g) => g.pass),
    };
    this.dir.write(
      "compare/index.html",
      comparePage([report], {
        title: `Mirror of ${this.url}`,
        sourceUrl: this.url,
        measureDir: () => "../measure/mirror",
        outputPage: () => `../${PREVIEW_DIR}/index.html`,
      }),
    );
    this.m.measurements = [{ target: "mirror", report: "verify/summary.json", pass: report.pass }];
    this.emit({
      type: "recreate.measured",
      runId: this.m.id,
      target: "mirror",
      widths,
      gates,
      comparePath: this.dir.rel("compare/index.html"),
    });
  }

  /**
   * A static snapshot of the app's page for the preview pane, which serves files and cannot run a Next.js server. It
   * shows the page as rendered; the app's own hydration is left out because its chunks load from the site root.
   */
  private async writePreview() {
    if (!this.server?.running) return;
    const path = this.m.finalUrl ? new URL(this.m.finalUrl).pathname : "/";
    const res = await fetch(this.newBaseUrl + path);
    if (!res.ok) throw new Error(`the app answered HTTP ${res.status}`);
    const dir = this.dir.path(PREVIEW_DIR);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const pub = join(this.appDir, "public");
    if (existsSync(pub)) cpSync(pub, dir, { recursive: true });
    const chunks = join(this.appDir, ".next/static");
    if (existsSync(chunks)) cpSync(chunks, join(dir, "_next/static"), { recursive: true });
    for (const css of cssFiles(dir)) {
      const depth = relative(dirname(css), dir) || ".";
      writeFileSync(css, relativeCssUrls(readFileSync(css, "utf8"), `${depth.split(sep).join("/")}/`));
    }
    writeFileSync(join(dir, "index.html"), previewHtml(await res.text()));
  }

  private copyShot(rel: string | undefined, width: number, kind: string) {
    if (!rel || !existsSync(this.ws.path(rel))) return;
    const to = this.dir.path("measure/mirror", String(width), `${kind}.png`);
    mkdirSync(join(to, ".."), { recursive: true });
    copyFileSync(this.ws.path(rel), to);
  }

  private readJson<T>(rel: string): T | undefined {
    try {
      return JSON.parse(readFileSync(this.ws.path(rel), "utf8")) as T;
    } catch {
      return undefined;
    }
  }
}

interface VisualRow {
  viewport: string;
  path: string;
  parity?: number;
  baseline?: string;
  current?: string;
  diff?: string;
  height?: { old: number; new: number };
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? cssFiles(p) : e.name.endsWith(".css") ? [p] : [];
  });
}

const relativeCssUrls = (css: string, prefix: string) =>
  css.replace(/url\(\s*(["']?)\/(?!\/)/g, (_m, quote: string) => `url(${quote}${prefix}`);

/** Root-relative URLs made relative to the snapshot; the Next.js runtime scripts removed. */
export function previewHtml(html: string): string {
  return relativeCssUrls(
    html
      .replace(/<script\b[^>]*\bsrc=["']\/_next\/[^>]*>\s*<\/script>/gi, "")
      .replace(/<script\b[^>]*>\s*(?:\(?self\.__next_[\s\S]*?)<\/script>/gi, "")
      .replace(/<link\b[^>]*\bhref=["']\/_next\/static\/(?:chunks|media\/[^"']*\.js)[^>]*>/gi, "")
      .replace(/(\s(?:src|href|poster|data-src|action)=["'])\/(?!\/)/gi, "$1")
      .replace(
        /(\s(?:srcset|imagesrcset|data-srcset)=["'])([^"']*)(["'])/gi,
        (_m, a: string, list: string, z: string) => a + list.replace(/(^|,\s*)\/(?!\/)/g, "$1") + z,
      ),
    "",
  );
}

/** Rejects as soon as the host cancels; the stage's own work ends with its next check. */
function untilCancelled<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((res, rej) => {
    const abort = () => rej(new MirrorCancelled("Cancelled."));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(res, rej).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function runMirror(request: RecreateRequest, host: MirrorHost): Promise<RecreateResult> {
  if (host.config.assets === "none")
    throw new Error(
      'recreate.assets "none" cannot be used with mirror mode: a mirror re-serves the page\'s own files.',
    );
  const outDir = request.out !== undefined ? resolveOut(host.projectRoot, request.out) : undefined;
  let runId = request.run;
  if (runId !== undefined && !isRunId(runId)) throw new Error(`"${runId}" is not a run id`);
  let manifest: RunManifest;
  let isNew = false;
  if (runId && existsSync(new RunDir(host.projectRoot, runId).path("manifest.json"))) {
    manifest = new RunDir(host.projectRoot, runId).manifest();
    if (manifest.request.mode !== "mirror") throw new Error(`Run "${runId}" is not a mirror run.`);
    manifest.request = { ...manifest.request, ...request, url: manifest.request.url, to: ["mirror"] };
  } else {
    if (runId && !request.url?.trim()) throw new Error(`No recreation run "${runId}" in this project.`);
    const url = normaliseUrl(request.url);
    runId = newRunId(url);
    isNew = true;
    const now = new Date().toISOString();
    manifest = {
      id: runId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      request: { ...request, run: undefined, url, mode: "mirror", to: ["mirror"] },
      stages: {},
      outputs: [],
      measurements: [],
      gates: [],
    };
    delete manifest.request.run;
  }
  const r = new Mirror(host, manifest);
  if (!isNew) r.dir.saveManifest(r.m);
  r.emit({
    type: "recreate.started",
    runId,
    url: manifest.request.url,
    widths: viewportsOf(host.config).map((v) => v.width),
    targets: ["mirror"],
    mode: "mirror",
    ...(r.m.consent ? { consent: r.m.consent } : {}),
    dir: r.dir.rel(),
  });

  const stage = async (
    name: RecreateStage,
    fn: () => Promise<{ status?: "skipped"; detail?: string } | void>,
  ) => {
    r.cancelled();
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    r.m.stages[name] = { status: "running", startedAt };
    if (r.dir.exists("manifest.json") || name !== "consent") r.dir.saveManifest(r.m);
    r.emit({ type: "recreate.stage", runId: r.m.id, stage: name, status: "running" });
    try {
      const extra = (await untilCancelled(host.signal, fn())) ?? {};
      const rec = {
        status: extra.status ?? ("done" as const),
        startedAt,
        ms: Date.now() - t0,
        ...(extra.detail ? { detail: extra.detail } : {}),
      };
      r.m.stages[name] = rec;
      r.dir.saveManifest(r.m);
      r.emit({
        type: "recreate.stage",
        runId: r.m.id,
        stage: name,
        status: rec.status,
        ms: rec.ms,
        ...(rec.detail ? { detail: rec.detail } : {}),
      });
    } catch (e) {
      const detail = (e as Error).message;
      r.m.stages[name] = { status: "failed", ms: Date.now() - t0, detail };
      r.dir.saveManifest(r.m);
      r.emit({
        type: "recreate.stage",
        runId: r.m.id,
        stage: name,
        status: "failed",
        ms: Date.now() - t0,
        detail,
      });
      throw e;
    }
  };

  let status = "success" as RecreateResult["status"];
  let summary = "";
  const chromePath = (() => {
    try {
      return findChrome() ?? undefined;
    } catch {
      return undefined;
    }
  })();
  await withRunScope({ guard: r.guard, chromePath }, async () => {
    try {
      if (!r.m.consent) {
        const url = r.m.request.url;
        const ask = async () => {
          const answer = await host.consent({ url, reason: MIRROR_CONSENT_REASON(url) });
          if (!answer) throw new StageFailed("Consent was not given; nothing was captured.");
          r.m.consent = answer;
          r.emit({ type: "recreate.consent", runId: r.m.id, url, consent: answer });
          return { detail: `${answer.by} (${answer.mode})` };
        };
        const t0 = Date.now();
        r.emit({ type: "recreate.stage", runId: r.m.id, stage: "consent", status: "running" });
        try {
          const rec = await ask();
          r.m.stages.consent = { status: "done", ms: Date.now() - t0, ...rec };
          r.emit({
            type: "recreate.stage",
            runId: r.m.id,
            stage: "consent",
            status: "done",
            ms: Date.now() - t0,
            ...rec,
          });
        } catch (e) {
          r.emit({
            type: "recreate.stage",
            runId: r.m.id,
            stage: "consent",
            status: "failed",
            ms: Date.now() - t0,
            detail: (e as Error).message,
          });
          throw e;
        }
      }
      excludeRunsFromGit(host.projectRoot);
      r.dir.saveManifest(r.m);
      await r.usePort();
      r.llm = createHostLlmClient(r.ws, undefined, host.complete);
      const order: RecreateStage[] = MIRROR_STAGES.slice(1);
      const fromAt = request.from ? order.indexOf(request.from) : 0;
      if (request.from && fromAt < 0)
        throw new Error(`Mirror mode has no stage "${request.from}" (${order.join(", ")})`);
      const start = Math.max(fromAt, 0);
      if (start > 0) r.loadSite();
      const needsApp = ["verify", "fix", "reverify"].includes(order[start]);
      if (needsApp && order[start] === "verify") await r.serve();
      for (const name of order.slice(start)) {
        await stage(name, async () => {
          switch (name) {
            case "crawl":
              return r.crawl();
            case "ccm":
              return r.ccm();
            case "design":
              return r.design();
            case "generate":
              return r.generate();
            case "appbuild":
              return r.appbuild();
            case "serve":
              return r.serve();
            case "verify":
              return r.verify("verify");
            case "fix":
              return r.fix();
            case "reverify":
              return r.reverify();
            case "report":
              return r.report();
          }
        });
      }
      const failing = r.m.gates.filter((g) => !g.pass);
      summary = failing.length
        ? `Mirrored with failing gates: ${failing.map((g) => g.name).join(", ")}.`
        : "Mirrored; all gates pass.";
      if (failing.length) status = "failed";
    } catch (e) {
      status = e instanceof MirrorCancelled ? "cancelled" : "failed";
      summary = e instanceof SourceBlocked ? `${e.message}` : (e as Error).message;
    } finally {
      await r.stopApp().catch(() => undefined);
    }
  });
  r.m.status = status;
  r.m.summary = summary;
  const denied = isNew && !r.m.consent;
  if (denied) rmSync(r.dir.path(), { recursive: true, force: true });
  else r.dir.saveManifest(r.m);
  const comparePath = r.dir.exists("compare/index.html") ? r.dir.rel("compare/index.html") : undefined;
  const outputs = r.m.outputs.map((o) => ({ target: o.target, path: r.dir.rel(o.path) }));
  r.emit({
    type: "recreate.finished",
    runId,
    status,
    outputs,
    ...(comparePath ? { comparePath } : {}),
    summary,
  });
  if (outDir && status !== "cancelled" && !denied && r.dir.exists(APP_DIR)) {
    cpSync(r.dir.path(APP_DIR), joinInside(outDir, "."), {
      recursive: true,
      filter: (p) => !/\/(node_modules|\.next)(\/|$)/.test(p),
    });
  }
  return { runId, dir: r.dir.rel(), manifest: r.m, status, outputs, comparePath, reports: [], summary };
}
