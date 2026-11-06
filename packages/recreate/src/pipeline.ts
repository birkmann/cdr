// The recreate pipeline: deterministic stages over files in the run folder, the model
// only where judgement is needed (naming, vision, repair) and only through the host. Nothing here knows about
// providers, sessions or events: progress goes out as plain `recreate.*` event bodies through `host.progress`,
// which core turns into session events.
import { pathToFileURL } from "node:url";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  EventBody,
  RecreateConfig,
  RecreateConsent,
  RecreateRequest,
  RecreateStage,
  RecreateTarget,
  SceneDesignSystem,
  SceneElement,
  SceneScreen,
} from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import {
  CdpCaptureDriver,
  CaptureError,
  RemoteCaptureDriver,
  findChrome,
  cropRows,
  decodePng,
  encodePng,
  deviceHeight,
  deviceOf,
  type CaptureDriver,
  type Peek,
  type RgbImage,
  type Shot,
  type Snapshot,
} from "@harness/capture";
import {
  devicePlan,
  layoutSwitches,
  pageScreens,
  pageSections,
  planSessions,
  sessionSnapshot,
  tagSections,
  walk,
  type PageCapture,
  type ProjectFont,
  type Section,
} from "@harness/scene";
import {
  applyNamingPlan,
  catalogOf,
  completeDesignSystem,
  componentApi,
  extractComponents,
  fallbackNames,
  mergeRetry,
  mergeTwins,
  namingCatalog,
  namingLint,
  namingMessages,
  numberedProps,
  retryEntries,
  retryMessages,
  structureLint,
  usageContexts,
  validateNaming,
  type NamingAnswer,
  type NamingEntry,
  type NamingPlan,
} from "@harness/extract";
import { getEmitter, loadEmitters, type FileMap } from "@harness/codegen";
import {
  comparePage,
  DEFAULT_GATES,
  formatReport,
  maskRects,
  type MaskRect,
  liveExpectations,
  measure,
  LAYOUT_CHECK_JS,
  OUTPUT_PROBE_JS,
  sweepWidths,
  parseVerdict,
  sectionBand,
  VISION_SYSTEM,
  visionPrompt,
  type MeasureReport,
} from "@harness/measure";
import {
  isRunId,
  joinInside,
  newRunId,
  RunDir,
  stagesFor,
  STAGE_ORDER,
  type RunManifest,
  type StageRecord,
} from "./manifest.js";

export type RecreateProgress = Extract<EventBody, { type: `recreate.${string}` }>;

/** A text (+ images) model call the host makes with the configured role's model. */
export interface ChatRequest {
  purpose: "naming" | "vision";
  messages: { role: "system" | "user"; content: string; images?: { mimeType: string; data: string }[] }[];
  json?: boolean;
}

/** One section the agent may patch (between its markers in the output file). */
export interface RepairTask {
  runId: string;
  /** output file relative to the project root */
  file: string;
  section: { id: string; label: string; kind: string; index: number };
  attempt: number;
  maxAttempts: number;
  widths: { width: number; pixel: number; live: Buffer; out: Buffer }[];
  threshold: number;
}

export interface RecreateHost {
  projectRoot: string;
  config?: RecreateConfig;
  driver?: CaptureDriver;
  signal?: AbortSignal;
  progress?(e: RecreateProgress): void;
  log?(message: string): void;
  /** Ask the user. null = denied. Required: a run never starts without consent. */
  consent(o: { url: string; reason: string }): Promise<RecreateConsent | null>;
  /** model call; absent = deterministic stages only (fallback names, no vision verdict) */
  chat?(req: ChatRequest): Promise<string>;
  /** the agent patches one section; true when it changed the file */
  repair?(task: RepairTask): Promise<boolean>;
  /** run `npm install && npm run build` in converted projects (needs the network) */
  runBuilds?(dir: string): Promise<{ ok: boolean; output: string }>;
  /** check every section against the live page while building (default true) */
  sectionChecks?: boolean;
}

export interface RecreateResult {
  runId: string;
  dir: string;
  manifest: RunManifest;
  status: "success" | "failed" | "cancelled";
  outputs: { target: RecreateTarget; path: string }[];
  comparePath?: string;
  reports: MeasureReport[];
  summary: string;
}

export class RecreateDenied extends Error {}

export const CONSENT_REASON = (url: string) =>
  `Recreates ${url} 1:1 from its live DOM, including text, images, fonts and logos. You are responsible for how you use the result. Assets will be stored under .harness/recreate and kept out of git.`;

const DEFAULT_WIDTHS = [390, 768, 1440];
const tierOf = (w: number, i: number) => (i === 0 ? 0 : w < 768 ? w : w < 1024 ? 768 : 1024);
const NAMING_BATCH = 30;
const REPAIR_ATTEMPTS = 2;
/** capture sessions at once (each its own browser) */
const CAPTURE_PARALLEL = 3;
/** section repairs (model calls) at once */
const REPAIR_PARALLEL = 3;

/** `fn` over `items`, at most `limit` at a time; results in input order. The first failure rejects (after the rest settle). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed: { e: unknown } | null = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed ??= { e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw (failed as { e: unknown }).e;
  return out;
}

/** Normalise "bvg.de" → "https://bvg.de/". */
export function normaliseUrl(input: string): string {
  const t = input.trim();
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  return u.toString();
}

function textsOfSnapshot(snap: any): string[] {
  const out: string[] = [];
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.kind === "text" && typeof n.text === "string") out.push(n.text.replace(/\s+/g, " ").trim());
    for (const c of Array.isArray(n.children) ? n.children : []) visit(c);
  };
  visit(snap?.root);
  return out.filter((t) => t.length > 1);
}

/** Make `.harness/recreate/` invisible to git (like worktrees): .git/info/exclude. */
export function excludeRunsFromGit(projectRoot: string): void {
  const git = join(projectRoot, ".git");
  if (!existsSync(git)) return;
  const file = join(git, "info", "exclude");
  try {
    const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (cur.split(/\r?\n/).includes(".harness/recreate/")) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}.harness/recreate/\n`);
  } catch {
    /* a worktree's .git is a file: nothing to do */
  }
}

/**
 * The project folder `out` names: relative, inside the project (symlinks resolved), not in .git. Throws otherwise.
 * (core's resolveInProject with forWrite, which this package cannot import.)
 */
export function resolveOut(projectRoot: string, out: string): string {
  if (typeof out !== "string" || !out.trim()) throw new Error("out must be a folder path");
  if (isAbsolute(out) || out.split(/[\\/]/).includes(".."))
    throw new Error(`out "${out}" must be a relative folder inside the project`);
  const root = realpathSync(projectRoot);
  const abs = resolve(root, out);
  let existing = abs;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, abs));
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`out "${out}" is outside the project`);
  if (rel.split(sep)[0] === ".git") throw new Error("out must not be inside .git");
  return real;
}

class Runner {
  readonly dir: RunDir;
  m: RunManifest;
  readonly driver: CaptureDriver;
  readonly cfg: RecreateConfig;
  readonly reports: MeasureReport[] = [];

  constructor(
    private readonly host: RecreateHost,
    runId: string,
    manifest: RunManifest,
  ) {
    this.dir = new RunDir(host.projectRoot, runId);
    this.m = manifest;
    this.cfg = host.config ?? {};
    // remote: the capture runs on a service (no Chrome here); local outputs are shot by Chrome when there is one
    this.driver =
      host.driver ??
      (this.cfg.driver === "remote" && this.cfg.remoteUrl
        ? new RemoteCaptureDriver(this.cfg.remoteUrl, findChrome() ? { local: new CdpCaptureDriver() } : {})
        : new CdpCaptureDriver());
  }

  emit(e: RecreateProgress) {
    try {
      this.host.progress?.(e);
    } catch {
      /* a listener's failure never breaks the run */
    }
  }

  get guard() {
    return { allowLocal: this.cfg.allowLocal === true };
  }

  /** The live page's first screen: written and announced at once, so the UI has something to show while capturing. */
  onPeek = (p: Peek) => {
    const rel = `capture/peek/${p.width}.jpg`;
    this.dir.write(rel, p.jpeg);
    this.emit({
      type: "recreate.shot",
      runId: this.m.id,
      kind: "peek",
      width: p.width,
      height: p.height,
      path: this.dir.rel(rel),
    });
  };

  /** A live reference shot: written as soon as it is taken (the measure stage reads it from here). */
  private shotsWritten = new Set<number>();
  onShot = (shot: Shot) => {
    this.shotsWritten.add(shot.width);
    this.dir.write(`capture/live/${shot.width}.png`, shot.png);
    this.dir.writeJson(`capture/live/${shot.width}.json`, {
      texts: shot.texts ?? [],
      overflowPx: shot.overflowPx ?? 0,
      ...(shot.probe !== undefined ? { probe: shot.probe } : {}),
    });
    this.emit({
      type: "recreate.shot",
      runId: this.m.id,
      kind: "live",
      width: shot.width,
      height: shot.height,
      path: this.dir.rel(`capture/live/${shot.width}.png`),
    });
  };

  get url() {
    return this.m.request.url;
  }

  cancelled() {
    if (this.host.signal?.aborted) throw new CaptureError("cancelled", "Cancelled.");
  }

  async stage(
    name: RecreateStage,
    fn: () => Promise<Partial<StageRecord> | void>,
    o: { persist?: boolean } = {},
  ) {
    this.cancelled();
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    this.m.stages[name] = { status: "running", startedAt };
    if (o.persist !== false) this.dir.saveManifest(this.m);
    this.emit({ type: "recreate.stage", runId: this.m.id, stage: name, status: "running" });
    try {
      const extra = (await fn()) ?? {};
      const rec: StageRecord = { status: extra.status ?? "done", startedAt, ms: Date.now() - t0, ...extra };
      this.m.stages[name] = rec;
      this.dir.saveManifest(this.m);
      this.emit({
        type: "recreate.stage",
        runId: this.m.id,
        stage: name,
        status: rec.status === "skipped" ? "skipped" : rec.status === "failed" ? "failed" : "done",
        ms: rec.ms,
        ...(rec.detail ? { detail: rec.detail } : {}),
        ...(rec.skipped?.length ? { skipped: rec.skipped } : {}),
      });
    } catch (e) {
      const detail = (e as Error).message;
      this.m.stages[name] = { status: "failed", ms: Date.now() - t0, detail };
      if (o.persist !== false) this.dir.saveManifest(this.m);
      this.emit({
        type: "recreate.stage",
        runId: this.m.id,
        stage: name,
        status: "failed",
        ms: Date.now() - t0,
        detail,
      });
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------------ consent
  async consent() {
    if (this.m.consent) return { detail: "recorded earlier" };
    const answer = await this.host.consent({ url: this.url, reason: CONSENT_REASON(this.url) });
    if (!answer) throw new RecreateDenied("Consent was not given; nothing was captured.");
    this.m.consent = answer;
    this.emit({ type: "recreate.consent", runId: this.m.id, url: this.url, consent: answer });
    return { detail: `${answer.by} (${answer.mode})` };
  }

  // ------------------------------------------------------------------------------------------------ probe
  async probe() {
    const widths = this.m.request.widths?.length
      ? [...new Set(this.m.request.widths.map((w) => Math.round(w)))].sort((a, b) => a - b)
      : null;
    if (widths) {
      // the widest capture is also walked at 1920 px: wide screens follow measured geometry, not a guess
      this.m.sessions = widths.map((w, i) => ({
        width: w,
        alt: i === widths.length - 1 && w < 1800 ? [1920] : [],
        menus: [],
      }));
      this.m.variants = widths.map((w, i) => ({ width: w, minWidth: tierOf(w, i), session: i }));
      return { detail: `widths given: ${widths.join(", ")}` };
    }
    let switches: number[] = [];
    try {
      const probe = await this.driver.probe(this.url, {
        guard: this.guard,
        respectRobots: this.cfg.respectRobots,
        signal: this.host.signal,
        onPeek: this.onPeek,
      });
      this.dir.writeJson("capture/layout.json", probe);
      switches = layoutSwitches(probe.breakpoints);
    } catch (e) {
      if (
        e instanceof CaptureError &&
        ["browser_unavailable", "blocked_address", "robots", "cancelled", "invalid_url"].includes(e.code)
      )
        throw e;
      this.host.log?.(
        `layout probe failed (${(e as Error).message}); capturing at ${DEFAULT_WIDTHS.join(", ")}`,
      );
    }
    const plans = devicePlan(switches);
    const sessions = planSessions(plans);
    this.m.sessions = sessions.map((s) => ({
      width: s.width,
      alt: s.alt,
      menus: s.variants.map((v) => v.width).filter((w) => w !== s.width),
    }));
    this.m.variants = sessions.flatMap((s, i) =>
      s.variants.map((v) => ({ width: v.width, minWidth: v.minWidth, session: i })),
    );
    this.m.variants.sort((a, b) => a.width - b.width);
    if (this.m.variants.length) this.m.variants[0].minWidth = 0;
    return {
      detail: `switches ${switches.join(", ") || "none"}; variants ${this.m.variants.map((v) => `${v.width}≥${v.minWidth}`).join(", ")}`,
    };
  }

  // ------------------------------------------------------------------------------------------------ capture
  async capture() {
    const skipped: string[] = [];
    const sessions = this.m.sessions ?? [];
    const variants = this.m.variants ?? [];
    // widths between and beyond the captures: shot live too (the responsive gate), each in the session of its device class
    const sweep = sweepWidths(variants.map((v) => v.width));
    this.m.sweep = sweep;
    const sessionFor = (w: number) => {
      const by = sessions.map((x, i) => ({ i, w: x.width })).sort((a, b) => a.w - b.w);
      const cls = (x: number) => (x < 600 ? 0 : x < 1024 ? 1 : 2);
      return (by.filter((x) => cls(x.w) === cls(w)).pop() ?? by.filter((x) => x.w <= w).pop() ?? by[0]).i;
    };
    // each session in its own browser, a few at once (the earlier project: FIG_CAPTURE_PARALLEL); results are applied in order
    const runOne = async (i: number) => {
      this.cancelled();
      const s = sessions[i];
      const mine = variants.filter((v) => v.session === i);
      const extra = sweep.filter((w) => sessionFor(w) === i);
      return this.driver.capture(
        this.url,
        { width: s.width, alt: s.alt, menus: s.menus },
        {
          guard: this.guard,
          respectRobots: this.cfg.respectRobots,
          budgets: this.cfg.budgets,
          shotWidths: [...mine.map((v) => v.width), ...extra],
          shotProbe: LAYOUT_CHECK_JS,
          signal: this.host.signal,
          log: (msg) => this.host.log?.(`capture ${s.width}px: ${msg}`),
          onPeek: this.onPeek,
          onShot: this.onShot,
        },
      );
    };
    const results = await mapLimit(
      sessions.map((_, i) => i),
      Math.max(1, Math.round(this.cfg.captureParallel ?? CAPTURE_PARALLEL)),
      runOne,
    );
    for (const [i, s] of sessions.entries()) {
      const res = results[i];
      const mine = variants.filter((v) => v.session === i);
      this.m.finalUrl = res.finalUrl;
      skipped.push(...res.skipped.map((x) => `${s.width}px: ${x}`));
      for (const v of mine) {
        const snap = v.width === s.width ? res.snapshot : sessionSnapshot(res.snapshot, v.width, s.alt);
        if (!snap) {
          skipped.push(`variant ${v.width}px (not walked)`);
          continue;
        }
        this.dir.writeJson(`capture/${v.width}.snapshot.json`, snap);
      }
      // a driver that does not report shots as they come (a test double): written now
      for (const shot of res.shots) if (!this.shotsWritten.has(shot.width)) this.onShot(shot);
    }
    this.m.variants = variants.filter((v) => this.dir.exists(`capture/${v.width}.snapshot.json`));
    if (!this.m.variants.length) throw new Error("no width could be captured");
    this.m.variants[0].minWidth = 0;
    return { detail: `${this.m.variants.length} variant(s)`, skipped };
  }

  snapshotOf(width: number): Snapshot {
    return this.dir.readJson<Snapshot>(`capture/${width}.snapshot.json`);
  }

  /** Moving media at `width` (video, canvas: never the same frame twice), masked out of every pixel comparison. */
  private mediaMasks = new Map<number, MaskRect[]>();
  mediaAt(width: number): MaskRect[] {
    let m = this.mediaMasks.get(width);
    if (!m) {
      m = this.dir.exists(`capture/${width}.snapshot.json`) ? movingMedia(this.snapshotOf(width)) : [];
      this.mediaMasks.set(width, m);
    }
    return m;
  }

  // ------------------------------------------------------------------------------------------------ scene
  async scene() {
    const caps: PageCapture[] = (this.m.variants ?? []).map((v) => ({
      width: v.width,
      minWidth: v.minWidth,
      snap: this.snapshotOf(v.width),
    }));
    const ps = pageScreens(caps);
    const sections = pageSections(ps.screens);
    const tagged = tagSections(ps.screens, sections);
    this.dir.writeJson("scene/screens.json", tagged);
    this.dir.writeJson("scene/sections.json", sections);
    this.dir.writeJson("scene/fonts.json", ps.fonts);
    this.dir.writeJson("scene/page.json", {
      page: ps.page,
      variants: ps.variants,
      hints: ps.hints,
      stats: ps.stats,
      warnings: ps.warnings,
    });
    return {
      detail: `${ps.screens.length} screen(s), ${sections.length} sections, ${ps.stats.elements} elements${ps.warnings.length ? `, ${ps.warnings.length} warning(s)` : ""}`,
    };
  }

  screens(): SceneScreen[] {
    return this.dir.readJson<SceneScreen[]>("scene/screens.json");
  }
  sections(): Section[] {
    return this.dir.readJson<Section[]>("scene/sections.json");
  }
  fonts(): ProjectFont[] {
    return this.dir.readJson<ProjectFont[]>("scene/fonts.json");
  }
  pageName(): string {
    return this.dir.readJson<{ page: string }>("scene/page.json").page;
  }

  emitOptions() {
    return {
      sourceUrl: this.m.finalUrl ?? this.url,
      capturedAt: this.m.stages.capture?.startedAt,
      assets: this.cfg.assets ?? "run-dir",
      // embedded by default: the capture already downloaded them, and most sites refuse cross-origin font loads
      fonts: this.cfg.fonts ?? "embed",
      style: this.m.request.style,
    } as const;
  }

  writeFiles(rel: string, files: FileMap) {
    const base = this.dir.path(rel);
    // every emitted file stays inside its target folder (a name like "../x" or "/x" is refused)
    for (const f of Object.keys(files)) joinInside(base, f);
    rmSync(base, { recursive: true, force: true });
    for (const [f, c] of Object.entries(files)) this.dir.write(`${rel}/${f}`, c);
  }

  // ------------------------------------------------------------------------------------------------ build
  /**
   * The whole page is written at once (never partly hidden), then checked: one output shot per width scores every
   * section's band against the live page. Sections below their threshold are repaired only when asked (`repair`),
   * a few at once, and re-scored with one more shot per width per pass.
   */
  async build() {
    const screens = this.screens();
    const sections = this.sections();
    const files = getEmitter("static")!.emit(
      { screens, fonts: this.fonts(), page: this.pageName() },
      this.emitOptions(),
    );
    this.writeFiles("out/static", files);
    this.addOutput("static", "out/static");
    const widths = (this.m.variants ?? []).map((v) => v.width);
    const checks =
      this.host.sectionChecks !== false && widths.every((w) => this.dir.exists(`capture/live/${w}.png`));
    const threshold = Math.max((this.cfg.gates?.pixel ?? DEFAULT_GATES.pixel) * 3, 0.03);
    const repairAllowed = this.m.request.repair === true && !!this.host.repair;
    const base = (s: Section, k: number) => ({
      type: "recreate.section" as const,
      runId: this.m.id,
      index: k,
      total: sections.length,
      id: s.id,
      kind: s.kind,
      label: s.label,
      bands: s.copies.map((c) => ({ width: c.width, y: Math.round(c.y), h: Math.round(c.h) })),
    });
    if (!checks) {
      for (const [k, s] of sections.entries()) this.emit({ ...base(s, k), status: "ok" });
      return { detail: `${sections.length} sections` };
    }
    for (const [k, s] of sections.entries()) this.emit({ ...base(s, k), status: "checking" });
    let results = await this.checkSections(sections, widths);
    const status = new Map<string, "ok" | "below-threshold" | "repaired">(
      sections.map((s) => [s.id, results.get(s.id)!.worst <= threshold ? "ok" : "below-threshold"]),
    );
    for (let attempt = 1; repairAllowed && attempt <= REPAIR_ATTEMPTS; attempt++) {
      const failing = sections
        .map((s, k) => ({ s, k }))
        .filter(({ s }) => status.get(s.id) === "below-threshold");
      if (!failing.length) break;
      this.cancelled();
      for (const { s, k } of failing) this.emit({ ...base(s, k), status: "building" });
      // patches to one file: the host serialises its writes; the model calls run side by side
      const changed = await mapLimit(failing, REPAIR_PARALLEL, ({ s, k }) =>
        this.host.repair!({
          runId: this.m.id,
          file: this.dir.rel("out/static/index.html"),
          section: { id: s.id, label: s.label, kind: s.kind, index: k },
          attempt,
          maxAttempts: REPAIR_ATTEMPTS,
          widths: results.get(s.id)!.widths,
          threshold,
        }).catch((e) => {
          this.host.log?.(`repair of ${s.id} failed: ${(e as Error).message}`);
          return false;
        }),
      );
      if (!changed.some(Boolean)) break;
      results = await this.checkSections(sections, widths);
      for (const { s } of failing) if (results.get(s.id)!.worst <= threshold) status.set(s.id, "repaired");
    }
    let below = 0;
    for (const [k, s] of sections.entries()) {
      const st = status.get(s.id)!;
      if (st === "below-threshold") below++;
      this.emit({ ...base(s, k), status: st, pixel: results.get(s.id)!.worst });
    }
    return { detail: `${sections.length} sections, ${below} below the band threshold` };
  }

  /** Every section's band at every width from one output shot per width: live crop vs. output crop. */
  async checkSections(sections: Section[], widths: number[]) {
    const RECTS_JS = `(() => { const v = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }; const bp = [...document.querySelectorAll('[data-bp]')].find(v) || document; const out = {}; for (const e of bp.querySelectorAll('[data-section]')) { if (!v(e)) continue; const id = e.getAttribute('data-section'); if (out[id]) continue; const r = e.getBoundingClientRect(); out[id] = { y: r.top + scrollY, h: r.height } } return out })()`;
    const shots = await this.driver.shoot(
      pathToFileURL(this.dir.path("out/static/index.html")).href,
      widths,
      {
        guard: false,
        probe: RECTS_JS,
        signal: this.host.signal,
      },
    );
    // each full-page image decoded once per width (not once per section)
    const live = new Map(
      shots.map((shot) => [
        shot.width,
        maskRects(decodePng(this.dir.read(`capture/live/${shot.width}.png`)), this.mediaAt(shot.width)),
      ]),
    );
    const outs = new Map(
      shots.map((shot) => [shot.width, maskRects(decodePng(shot.png), this.mediaAt(shot.width))]),
    );
    const out = new Map<string, { worst: number; widths: RepairTask["widths"] }>();
    for (const s of sections) {
      const ws: RepairTask["widths"] = [];
      let worst = 0;
      for (const shot of shots) {
        const copy = s.copies.find((c) => c.width === shot.width) ?? null;
        const rects = (shot.probe ?? {}) as Record<string, { y: number; h: number } | undefined>;
        const rect = rects[s.id] ?? null;
        if (!copy && !rect) continue;
        // a section the output lacks at this width (or the live page lacks): the live band against nothing
        const band = sectionBandPair(live.get(shot.width)!, outs.get(shot.width)!, copy, rect);
        worst = Math.max(worst, band.pixel);
        ws.push({ width: shot.width, ...band });
      }
      out.set(s.id, { worst, widths: ws });
    }
    return out;
  }

  addOutput(target: RecreateTarget, path: string) {
    this.m.outputs = [...this.m.outputs.filter((o) => o.target !== target), { target, path }];
  }

  // ------------------------------------------------------------------------------------------------ measure
  async measure() {
    const widths = (this.m.variants ?? []).map((v) => v.width);
    const live = widths
      .filter((w) => this.dir.exists(`capture/live/${w}.png`))
      .map((w) => ({
        width: w,
        png: this.dir.read(`capture/live/${w}.png`),
        ...this.dir.readJson<{ texts: string[]; overflowPx: number }>(`capture/live/${w}.json`),
      }));
    if (!live.length) return { status: "skipped" as const, detail: "no live shots were taken" };
    const targets = this.m.outputs.filter((o) => o.target === "static");
    for (const t of targets) {
      // the output at the captured widths and at the sweep widths: two browsers side by side
      const sweepWs = this.m.sweep ?? sweepWidths(widths);
      const [shots, sweepOut] = await Promise.all([
        this.driver.shoot(
          pathToFileURL(this.dir.path(t.path, "index.html")).href,
          live.map((l) => l.width),
          {
            guard: false,
            probe: OUTPUT_PROBE_JS,
            signal: this.host.signal,
          },
        ),
        sweepWs.length
          ? this.driver.shoot(pathToFileURL(this.dir.path(t.path, "index.html")).href, sweepWs, {
              guard: false,
              probe: LAYOUT_CHECK_JS,
              signal: this.host.signal,
            })
          : Promise.resolve([]),
      ]);
      const captured: Record<number, string[]> = {};
      const expectations: Record<number, ReturnType<typeof liveExpectations>> = {};
      for (const w of widths) {
        const snap = this.snapshotOf(w);
        captured[w] = textsOfSnapshot(snap);
        expectations[w] = liveExpectations(snap);
      }
      // the responsive sweep: the output at widths between and beyond the captures, checked for its layout and
      // against the live page where it was shot
      const sweepLive = sweepWs
        .filter((w) => this.dir.exists(`capture/live/${w}.png`))
        .map((w) => ({
          width: w,
          png: this.dir.read(`capture/live/${w}.png`),
          ...this.dir.readJson<{ texts: string[]; overflowPx: number; probe?: unknown }>(
            `capture/live/${w}.json`,
          ),
        }));
      for (const o of sweepOut) this.dir.write(`measure/${t.target}/sweep/${o.width}.png`, o.png);
      const { report, images } = measure({
        target: t.target,
        sweep: {
          out: sweepOut,
          live: sweepLive,
          // each variant's measured span (its capture width and its alt walks)
          spans: this.screens()
            .filter((x) => x.responsive || !x.root.meta?.overlayOf)
            .filter((x) => typeof x.root.meta?.overlayOf !== "string")
            .map((x) => {
              const ws = [x.width, ...(x.responsive?.measured ?? [])];
              return [Math.min(...ws), Math.max(...ws)] as [number, number];
            }),
        },
        live,
        out: shots,
        captured,
        expectations,
        mask: Object.fromEntries(widths.map((w) => [w, this.mediaAt(w)])),
        gates: this.cfg.gates,
      });
      for (const img of images) {
        this.dir.write(`measure/${t.target}/${img.width}/live.png`, img.live);
        this.dir.write(`measure/${t.target}/${img.width}/out.png`, img.out);
        this.dir.write(`measure/${t.target}/${img.width}/diff.png`, img.diff);
      }
      // the vision verdict, when a vision-capable model is configured
      if (this.host.chat) report.vision = await this.vision(report, images).catch(() => undefined);
      this.dir.writeJson(`measure/${t.target}/report.json`, report);
      this.reports.push(report);
      this.m.measurements = [
        ...this.m.measurements.filter((x) => x.target !== t.target),
        { target: t.target, report: `measure/${t.target}/report.json`, pass: report.pass },
      ];
      this.m.gates = report.gates.map((g) => ({ name: g.name, pass: g.pass, detail: g.detail }));
      this.emit({
        type: "recreate.measured",
        runId: this.m.id,
        target: t.target,
        widths: report.widths.map((w) => ({
          width: w.width,
          pixel: w.pixel,
          textReal: w.textReal,
          textDrift: w.textDrift,
          height: { live: w.liveHeight, out: w.outHeight },
          hscroll: w.hscroll,
        })),
        gates: report.gates.map((g) => ({ name: g.name, pass: g.pass, detail: g.detail })),
        comparePath: this.dir.rel("compare/index.html"),
      });
    }
    this.dir.write(
      "compare/index.html",
      comparePage(this.reports, { title: this.pageName(), sourceUrl: this.m.finalUrl ?? this.url }),
    );
    return { detail: this.reports.map((r) => formatReport(r).split("\n")[0]).join("; ") };
  }

  /** One verdict per width; the model calls run side by side, each full-page image decoded once. */
  async vision(report: MeasureReport, images: { width: number; live: Buffer; out: Buffer }[]) {
    const verdicts = await mapLimit(report.widths, REPAIR_PARALLEL, async (w) => {
      const img = images.find((i) => i.width === w.width);
      if (!img) return null;
      const worst = [...w.bands]
        .sort((a, b) => b.mismatch - a.mismatch)
        .slice(0, 3)
        .sort((a, b) => a.y - b.y);
      const live = decodePng(img.live),
        out = decodePng(img.out);
      const pairs = worst.map((b) => sectionBand(live, out, b.y, b.h));
      const text = await this.host.chat!({
        purpose: "vision",
        json: true,
        messages: [
          { role: "system", content: VISION_SYSTEM },
          {
            role: "user",
            content: visionPrompt(w.width, worst),
            images: pairs.flatMap((p) => [
              { mimeType: "image/png", data: p.live.toString("base64") },
              { mimeType: "image/png", data: p.out.toString("base64") },
            ]),
          },
        ],
      }).catch(() => "");
      const v = parseVerdict(text);
      return v ? { width: w.width, verdict: v.verdict, differences: v.differences } : null;
    });
    return verdicts.filter((v): v is NonNullable<typeof v> => v !== null);
  }

  // ------------------------------------------------------------------------------------------------ components
  async components() {
    const screens = this.screens();
    const hints = this.dir.readJson<{ hints: Partial<typeof DEFAULT_TOKENS> }>("scene/page.json").hints;
    let ds: SceneDesignSystem = {
      version: 1,
      name: this.pageName(),
      tokens: { ...DEFAULT_TOKENS, theme: "light", ...hints },
      componentSets: [],
    };
    let current = screens;
    let made = 0;
    let n = 0;
    // three rounds: a round merges what the previous one left as near twins (the earlier project's extraction loop)
    for (let round = 0; round < 3; round++) {
      const r = extractComponents(
        current.map((s) => ({ nodeId: s.id, screen: s })),
        ds,
        { newId: () => `cmp-${++n}`, sections: round === 0 },
      );
      if (!r.components.length) break;
      made += r.components.length;
      ds = r.ds;
      current = current.map((s) => r.screens.get(s.id) ?? s);
    }
    // sets that differ only in content become one (W1); every copy keeps its own copy and pictures
    const twins = mergeTwins(ds, current);
    ds = twins.ds;
    current = twins.screens;
    // naming: the model when there is one (validated, one retry round), deterministic names for the rest
    const naming = await this.name(ds, current);
    ds = naming.ds;
    current = naming.screens;
    const apiProps = (d: Parameters<typeof componentApi>[0]) =>
      componentApi(d, ds, { slots: true }).map((p) => p.label);
    const lint = structureLint({
      sets: ds.componentSets ?? [],
      screens: current,
      apiProps,
      numberedProps: (d) => numberedProps(d, ds).map((p) => p.label),
      naming: { status: naming.status, unnamed: naming.unnamed },
    });
    const uses = new Map<string, number>();
    for (const s of current)
      walk(s.root, (e: SceneElement) => {
        if (e.instance) uses.set(e.instance.componentId, (uses.get(e.instance.componentId) ?? 0) + 1);
      });
    const sets = (ds.componentSets ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      ...(d.kind ? { kind: d.kind } : {}),
      variants: Object.keys(d.variants).length,
      props: apiProps(d),
      uses: uses.get(d.id) ?? 0,
    }));
    const issues = lint.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail ?? ""}`.trim());
    this.dir.writeJson("components/sets.json", ds.componentSets ?? []);
    this.dir.writeJson("components/naming.json", naming.record);
    this.dir.writeJson("components/lint.json", lint);
    this.dir.writeJson("components/screens.json", current);
    this.dir.writeJson("design-system/system.json", ds);
    this.emit({ type: "recreate.components", runId: this.m.id, sets, lint: { pass: lint.ok, issues } });
    this.m.gates = [
      ...this.m.gates.filter((g) => g.name !== "components"),
      { name: "components", pass: lint.ok, detail: issues.join("; ") || `${sets.length} sets` },
    ];
    return {
      detail: `${made} sets extracted, naming ${naming.status}, lint ${lint.ok ? "pass" : `fail (${issues.length})`}`,
    };
  }

  async name(ds: SceneDesignSystem, screens: SceneScreen[]) {
    const ids = (ds.componentSets ?? []).map((d) => d.id);
    const record: { calls: number; plan?: NamingPlan; fallback?: NamingPlan; error?: string } = { calls: 0 };
    let status: "complete" | "partial" | "fallback" = "fallback";
    if (this.host.chat && ids.length) {
      try {
        const instances: Record<string, number> = {};
        for (const s of screens)
          walk(s.root, (e: SceneElement) => {
            if (e.instance) instances[e.instance.componentId] = (instances[e.instance.componentId] ?? 0) + 1;
          });
        const pages = screens.map((s) => s.root);
        const contexts = usageContexts([
          ...pages,
          ...(ds.componentSets ?? []).flatMap((d) => Object.values(d.variants)),
        ]);
        const entries = namingCatalog(ds, ids, { instances, contexts });
        const site = this.pageName();
        const batches: NamingEntry[][] = [];
        for (let i = 0; i < entries.length; i += NAMING_BATCH)
          batches.push(entries.slice(i, i + NAMING_BATCH));
        const answers = await Promise.all(
          batches.map(async (batch) => {
            record.calls++;
            const others = (ds.componentSets ?? [])
              .filter((d) => !batch.some((e) => e.id === d.id))
              .map((d) => d.name);
            const text = await this.host.chat!({
              purpose: "naming",
              json: true,
              messages: namingMessages(ds, batch, { others, site }),
            }).catch(() => "");
            return parseJsonLoose<NamingAnswer>(text);
          }),
        );
        const usable = answers.filter((a): a is NamingAnswer => !!a && Array.isArray(a.components));
        if (usable.length) {
          const lint = namingLint(ds, pages);
          const merged: NamingAnswer = {
            components: usable.flatMap((a) => a.components as unknown[]),
            order: usable.flatMap((a) => (Array.isArray(a.order) ? a.order : [])),
          };
          let plan = validateNaming(ds, entries, merged, new Map(), lint);
          const retry = retryEntries(entries, plan);
          if (retry.length) {
            record.calls++;
            const proposed = new Map(plan.sets.filter((x) => x.name).map((x) => [x.id, x.name!]));
            const taken = (ds.componentSets ?? [])
              .filter((d) => !retry.some((e) => e.id === d.id))
              .map((d) => proposed.get(d.id) ?? d.name);
            const text = await this.host.chat!({
              purpose: "naming",
              json: true,
              messages: retryMessages(ds, retry, plan.rejected, taken, site),
            }).catch(() => "");
            const again = parseJsonLoose<NamingAnswer>(text);
            if (again && Array.isArray(again.components)) {
              const names = (again.components as unknown[])
                .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
                .map((c) => ({ id: c.id, name: c.name }));
              plan = mergeRetry(plan, validateNaming(ds, retry, { components: names }, proposed, lint));
            }
          }
          record.plan = plan;
          const applied = applyNamingPlan(ds, screens, plan);
          ds = applied.ds;
          screens = applied.screens;
          status = "complete";
        } else record.error = "the model gave no usable answer";
      } catch (e) {
        record.error = (e as Error).message;
      }
    }
    // whatever is still on a built-in name gets a deterministic one (counted: naming is not complete then)
    const fb = fallbackNames(ds);
    if (fb.sets.length) {
      record.fallback = fb;
      const applied = applyNamingPlan(ds, screens, fb);
      ds = applied.ds;
      screens = applied.screens;
      if (status === "complete") status = "partial";
    }
    return {
      ds,
      screens,
      record,
      status: status === "complete" ? "complete" : status,
      unnamed: fb.sets.map((s) => s.id),
    };
  }

  // ------------------------------------------------------------------------------------------------ system
  async system() {
    const ds = this.dir.readJson<SceneDesignSystem>("design-system/system.json");
    const screens = this.dir.readJson<SceneScreen[]>("components/screens.json");
    const done = completeDesignSystem(ds, screens);
    this.dir.writeJson("design-system/system.json", done.ds);
    const cat = catalogOf(done.ds);
    return {
      detail: `${(done.ds.componentSets ?? []).length} sets (${done.added.length} generated), ${cat.length} categories`,
    };
  }

  // ------------------------------------------------------------------------------------------------ convert / ds-export
  async convert(kind: "convert" | "ds-export") {
    const isDs = (t: string) => t.startsWith("ds-") || t === "tokens" || t === "design-md";
    const targets = (this.m.request.to ?? ["static"]).filter(
      (t) => t !== "static" && (kind === "ds-export" ? isDs(t) : !isDs(t)),
    );
    const notes: string[] = [];
    if (this.cfg.emitters?.length) {
      // project emitter plugins (recreate.emitters), registered by id before the targets are looked up
      const plugins = await loadEmitters(this.cfg.emitters, this.host.projectRoot);
      for (const e of plugins.errors) notes.push(`emitter ${e.path}: ${e.error}`);
    }
    const system = this.dir.exists("design-system/system.json")
      ? this.dir.readJson<SceneDesignSystem>("design-system/system.json")
      : undefined;
    const screens = this.dir.exists("components/screens.json")
      ? this.dir.readJson<SceneScreen[]>("components/screens.json")
      : this.screens();
    for (const t of targets) {
      const e = getEmitter(t);
      if (!e) {
        notes.push(`${t}: no such emitter`);
        continue;
      }
      const rel = `out/${t}`;
      this.writeFiles(
        rel,
        e.emit({ screens, fonts: this.fonts(), system, page: this.pageName() }, this.emitOptions()),
      );
      this.addOutput(t, rel);
      if (this.host.runBuilds && existsSync(this.dir.path(rel, "package.json"))) {
        const b = await this.host.runBuilds(this.dir.path(rel));
        this.m.gates = [
          ...this.m.gates.filter((g) => g.name !== `build:${t}`),
          { name: `build:${t}`, pass: b.ok, detail: b.output.slice(-400) },
        ];
        notes.push(`${t}: build ${b.ok ? "ok" : "failed"}`);
      } else notes.push(`${t}: written`);
    }
    return { detail: notes.join("; ") || "nothing to convert" };
  }
}

/** The live crop of a section vs. the output's crop of the same section. */
/** Boxes of the snapshot's videos and canvases large enough to matter (icons and tiny players are kept). */
export function movingMedia(snap: Snapshot): MaskRect[] {
  const out: MaskRect[] = [];
  const visit = (n: { kind?: string; tag?: string; rect?: MaskRect; children?: unknown[] } | undefined) => {
    if (!n) return;
    const r = n.rect;
    if (n.kind === "raster" && (n.tag === "video" || n.tag === "canvas") && r && r.w * r.h >= 40_000)
      out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    for (const c of n.children ?? []) visit(c as never);
  };
  visit(snap.root as never);
  return out;
}

function sectionBandPair(
  live: RgbImage,
  out: RgbImage,
  copy: { y: number; h: number } | null,
  rect: { y: number; h: number } | null,
): { pixel: number; live: Buffer; out: Buffer } {
  if (!copy || !rect) {
    const b = copy ?? rect!;
    const one = sectionBand(live, out, b.y, b.h);
    return { ...one, pixel: 1 };
  }
  // same height band in both (the live height): a shorter or taller output section shows as mismatch rows
  const l = cropRows(live, copy.y, copy.h);
  const o = cropRows(out, rect.y, Math.max(rect.h, 1));
  const res = sectionBand(l, o, 0, Math.max(copy.h, rect.h));
  return { pixel: res.pixel, live: encodePng(l), out: encodePng(o) };
}

export function parseJsonLoose<T>(text: string): T | null {
  const body = String(text ?? "").replace(/```(?:json)?/gi, "");
  const a = body.indexOf("{"),
    b = body.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(body.slice(a, b + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * Run (or resume) a recreation. A new run gets a fresh run folder; `request.run` + `request.from` re-runs that run's
 * stages from `from` on (earlier stages' files are reused).
 */
export async function runRecreate(
  request: RecreateRequest,
  host: RecreateHost,
  opts: { stopAfter?: RecreateStage } = {},
): Promise<RecreateResult> {
  // `out` is checked before anything happens: a relative folder inside the project, never .git
  const outDir = request.out !== undefined ? resolveOut(host.projectRoot, request.out) : undefined;
  let runId = request.run;
  let manifest: RunManifest;
  let isNew = false;
  if (runId !== undefined && !isRunId(runId)) throw new Error(`"${runId}" is not a run id`);
  if (runId && existsSync(new RunDir(host.projectRoot, runId).path("manifest.json"))) {
    // a resumed run keeps its URL (the request's, if any, is ignored) and its targets unless new ones are asked
    manifest = new RunDir(host.projectRoot, runId).manifest();
    const to = request.to?.length
      ? request.to
      : manifest.request.to?.length
        ? manifest.request.to
        : ["static"];
    manifest.request = { ...manifest.request, ...request, url: manifest.request.url, to };
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
      request: { ...request, run: undefined, url, to: request.to?.length ? request.to : ["static"] },
      stages: {},
      outputs: [],
      measurements: [],
      gates: [],
    };
    delete manifest.request.run;
  }
  const url = manifest.request.url;
  const targets = manifest.request.to as RecreateTarget[];
  const r = new Runner(host, runId, manifest);
  // a new run writes nothing before consent: a denied run leaves no folder
  if (!isNew) r.dir.saveManifest(r.m);
  const order = stagesFor(targets);
  // a stage these targets skip resumes at the next one they run (never back at probe: that would re-capture)
  // (repair is part of build)
  const fromAt = request.from ? STAGE_ORDER.indexOf(request.from === "repair" ? "build" : request.from) : -1;
  const next = fromAt < 0 ? 0 : order.findIndex((st) => STAGE_ORDER.indexOf(st) >= fromAt);
  const from = next < 0 ? order.length : next;
  r.emit({
    type: "recreate.started",
    runId,
    url,
    widths: manifest.request.widths ?? [],
    targets,
    // only a consent given earlier; a new one is reported by recreate.consent once it is given
    ...(r.m.consent ? { consent: r.m.consent } : {}),
    dir: r.dir.rel(),
  });
  let status: RecreateResult["status"] = "success";
  let summary = "";
  try {
    // consent is never skipped by --from: a resumed run that never had it asks now
    if (!r.m.consent) await r.stage("consent", () => r.consent(), { persist: !isNew });
    excludeRunsFromGit(host.projectRoot);
    const last =
      opts.stopAfter && order.includes(opts.stopAfter) ? order.indexOf(opts.stopAfter) : order.length - 1;
    for (const st of order.slice(Math.max(from, 1), last + 1)) {
      if (st === "consent") continue;
      await r.stage(st, async () => {
        switch (st) {
          case "probe":
            return r.probe();
          case "capture":
            return r.capture();
          case "scene":
            return r.scene();
          case "build":
            return r.build();
          case "measure":
            return r.measure();
          case "components":
            return r.components();
          case "system":
            return r.system();
          case "convert":
            return r.convert("convert");
          case "ds-export":
            return r.convert("ds-export");
          default:
            return { status: "skipped" as const };
        }
      });
    }
    const failing = r.m.gates.filter((g) => !g.pass);
    const partial = last < order.length - 1;
    summary = partial
      ? `Stages done up to ${order[last]}.`
      : failing.length
        ? `Recreated with failing gates: ${failing.map((g) => g.name).join(", ")}.`
        : "Recreated; all gates pass.";
    if (failing.length && !partial) status = "failed";
  } catch (e) {
    status = e instanceof CaptureError && e.code === "cancelled" ? "cancelled" : "failed";
    summary = (e as Error).message;
  }
  r.m.status = status;
  r.m.summary = summary;
  // a new run without consent leaves nothing behind
  const denied = isNew && !r.m.consent;
  if (denied) rmSync(r.dir.path(), { recursive: true, force: true });
  else r.dir.saveManifest(r.m);
  const comparePath = r.dir.exists("compare/index.html") ? r.dir.rel("compare/index.html") : undefined;
  r.emit({
    type: "recreate.finished",
    runId,
    status,
    outputs: r.m.outputs.map((o) => ({ target: o.target, path: r.dir.rel(o.path) })),
    ...(comparePath ? { comparePath } : {}),
    summary,
  });
  // copy outputs into the project when asked (assets: run-dir keeps captured assets out of the project)
  if (outDir && status !== "cancelled" && !denied) {
    for (const o of r.m.outputs) {
      const dest = r.m.outputs.length > 1 ? joinInside(outDir, o.target) : outDir;
      cpSync(r.dir.path(o.path), dest, { recursive: true });
    }
  }
  return {
    runId,
    dir: r.dir.rel(),
    manifest: r.m,
    status,
    outputs: r.m.outputs.map((o) => ({ target: o.target, path: r.dir.rel(o.path) })),
    comparePath,
    reports: r.reports,
    summary,
  };
}

/** Width → viewport height used for every capture and shot (shared so tools can say it). */
export const viewportHeightOf = (w: number) => deviceHeight(deviceOf(w));
export { STAGE_ORDER };
