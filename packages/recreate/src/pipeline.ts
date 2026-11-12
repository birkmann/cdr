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
import { createHash } from "node:crypto";
import {
  CdpCaptureDriver,
  CaptureError,
  fetchPublic,
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
  type SnapHover,
  type Snapshot,
} from "@harness/capture";
import {
  devicePlan,
  layoutSwitches,
  planCaptures,
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
import {
  emitAngularPage,
  emitLit,
  emitReactPage,
  emitModern,
  getEmitter,
  loadEmitters,
  provenance,
  type FileMap,
  type ModernDoc,
} from "@harness/codegen";
import type { SceneLayout } from "@harness/protocol";
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
  sweepPlan,
  layoutCheck,
  flowLint,
  sectionClasses,
  parseVerdict,
  sectionBand,
  VISION_SYSTEM,
  visionPrompt,
  type FlowRule,
  type GateResult,
  type LayoutFacts,
  type LighthouseScores,
  type MeasureReport,
  type QualityGate,
  type QualityProbe,
  type QualityReport,
  liveQuality,
  lighthouseGate,
  qualityGates,
  QUALITY_PROBE_JS,
  runLighthouse,
  serveDir,
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
  /** why it is repaired: its pixels at the captured widths, or its layout between them */
  reason?: "pixel" | "responsive" | "flow";
  /** what is wrong with the section at widths between the captured ones (the live page has none of it) */
  sweep?: { width: number; issues: string[]; out?: Buffer }[];
  /** why the previous attempt's patch was not written */
  rejected?: string[];
  /** widths the page's variants switch at (media queries there are breakpoints, not pins) */
  boundaries?: number[];
}

/** What one repair attempt did: changed the files, or was rejected (and why). */
export interface RepairOutcome {
  changed: boolean;
  rejected?: string[];
  note?: string;
}

/** The comment that opens a repair's CSS in styles.css (a pass is undone section by section by it). */
export const repairMarker = (id: string, attempt: number) =>
  `/* repair: section ${id}, attempt ${attempt} */`;

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
  /** the agent patches one section: true (or `changed`) when it changed the file; `rejected` says why it did not */
  repair?(task: RepairTask): Promise<boolean | RepairOutcome>;
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
/**
 * emitter output rules that fail the flow gate (CSS added after the build always does: ADDED_RULES): the emitter
 * writes flow layout, so a pin or a scaled layout outside the sections it kept fitted is a defect
 */
const FLOW_GATING: FlowRule[] = ["media-pin", "value-pin", "zoom"];
/** texts the output takes out of the flow while the live page keeps them in it fail the flow gate */
const FLOW_OUT_OF_FLOW_GATES = true;
const tierOf = (w: number, i: number) => (i === 0 ? 0 : w < 768 ? w : w < 1024 ? 768 : 1024);
const NAMING_BATCH = 30;
const REPAIR_ATTEMPTS = 2;
/** capture sessions at once (each its own browser) */
const CAPTURE_PARALLEL = 3;
/** outputs built from the live DOM: the modern page and its projects (Lit, React, Angular) */
type DomTarget = "modern" | "lit" | "react-page" | "angular-page";
const DOM_TARGETS: DomTarget[] = ["modern", "lit", "react-page", "angular-page"];
const PROJECT_TARGETS: DomTarget[] = ["lit", "react-page", "angular-page"];
/** bytes of video a run downloads at most (config `recreate.budgets.mediaBytes`) */
const DEFAULT_MEDIA_BYTES = 40_000_000;
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
      height: shot.height,
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

  /** The live page's layout facts at a probe width (no screenshot): written as soon as they are taken. */
  private probesWritten = new Set<number>();
  onProbe = (p: Shot) => {
    this.probesWritten.add(p.width);
    // a probe width that also has a live shot keeps the shot's facts
    if (this.shotsWritten.has(p.width)) return;
    this.dir.writeJson(`capture/live/${p.width}.json`, {
      texts: p.texts ?? [],
      overflowPx: p.overflowPx ?? 0,
      height: p.height,
      ...(p.probe !== undefined ? { probe: p.probe } : {}),
    });
  };

  /** The widths the static output is checked at besides the captured ones (sweepPlan); `n`: the measurement's number. */
  plan(n = this.m.measures ?? 0) {
    const variants = this.m.variants ?? [];
    return sweepPlan({
      captured: variants.map((v) => v.width),
      measured: (this.m.sessions ?? []).flatMap((s) => [s.width, ...s.alt]),
      boundaries: variants.map((v) => v.minWidth).filter((w) => w > 0),
      seed: `${this.m.id}:${n}`,
    });
  }

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
      // each given width is one variant, applying from its device class; it is walked again across its own layout
      // range (the range's start, device widths, steps of a few hundred px; the widest up to 1920 px), so the output
      // follows measured geometry between the widths instead of fitted values. Its range ends at the next variant or
      // at the page's own next layout switch (probed): past it the page has a layout that was not captured.
      const mins = widths.map((w, i) => tierOf(w, i));
      const switches = await this.layoutProbe().catch((e) => {
        if (e instanceof CaptureError && ["cancelled", "browser_unavailable"].includes(e.code)) throw e;
        return [] as number[];
      });
      const plans = planCaptures(
        [...new Set([...mins.filter((m) => m > 0), ...switches])].sort((a, b) => a - b),
        widths,
      ).filter((p) => widths.includes(p.width));
      this.m.sessions = widths.map((w) => ({
        width: w,
        alt: plans.find((p) => p.width === w)?.alt ?? [],
        menus: [],
      }));
      this.m.variants = widths.map((w, i) => ({
        width: w,
        minWidth: mins[i]!,
        session: i,
        alt: plans.find((p) => p.width === w)?.alt ?? [],
      }));
      return { detail: `widths given: ${widths.join(", ")}` };
    }
    let switches: number[] = [];
    try {
      switches = await this.layoutProbe();
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
    // one variant per layout range of the page (every range measured: no width between captures shows a layout the
    // page does not have there), or one per device class (`recreate.capturePlan: "devices"`: quicker on pages with
    // many switches; the ranges between devices are then reported as not captured)
    const plans = this.cfg.capturePlan === "devices" ? devicePlan(switches) : planCaptures(switches);
    const sessions = planSessions(plans);
    this.m.sessions = sessions.map((s) => ({
      width: s.width,
      alt: s.alt,
      menus: s.variants.map((v) => v.width).filter((w) => w !== s.width),
    }));
    this.m.variants = sessions.flatMap((s, i) =>
      s.variants.map((v) => ({ width: v.width, minWidth: v.minWidth, session: i, alt: v.alt })),
    );
    this.m.variants.sort((a, b) => a.width - b.width);
    if (this.m.variants.length) this.m.variants[0].minWidth = 0;
    return {
      detail: `switches ${switches.join(", ") || "none"}; variants ${this.m.variants.map((v) => `${v.width}≥${v.minWidth}`).join(", ")}`,
    };
  }

  /** The page's own layout switches (the probe, recorded in capture/layout.json). */
  async layoutProbe(): Promise<number[]> {
    const probe = await this.driver.probe(this.url, {
      guard: this.guard,
      respectRobots: this.cfg.respectRobots,
      signal: this.host.signal,
      onPeek: this.onPeek,
    });
    this.dir.writeJson("capture/layout.json", probe);
    return layoutSwitches(probe.breakpoints);
  }

  // ------------------------------------------------------------------------------------------------ capture
  async capture() {
    const skipped: string[] = [];
    const sessions = this.m.sessions ?? [];
    const variants = this.m.variants ?? [];
    // widths between and beyond the captures: shot live too (the responsive gate), each in the session of its device class
    const sweep = sweepWidths(variants.map((v) => v.width));
    this.m.sweep = sweep;
    // and layout facts (no screenshot) at the sweep plan's grid and variant boundaries: the live page's own overlaps
    // and heights there, which the output is compared with
    const probe = this.plan(0).live.filter((w) => !sweep.includes(w));
    this.m.probe = probe;
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
      const facts = probe.filter((w) => sessionFor(w) === i);
      return this.driver.capture(
        this.url,
        { width: s.width, alt: s.alt, menus: s.menus },
        {
          guard: this.guard,
          respectRobots: this.cfg.respectRobots,
          budgets: this.cfg.budgets,
          shotWidths: [...mine.map((v) => v.width), ...extra],
          shotProbe: LAYOUT_CHECK_JS,
          ...(facts.length ? { probeWidths: facts, onProbe: this.onProbe } : {}),
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
        // each variant keeps the walks of its own layout range (the session walked those of all its variants)
        const snap = sessionSnapshot(res.snapshot, v.width, v.alt ?? s.alt);
        if (!snap) {
          skipped.push(`variant ${v.width}px (not walked)`);
          continue;
        }
        this.dir.writeJson(`capture/${v.width}.snapshot.json`, snap);
      }
      // a driver that does not report shots as they come (a test double): written now
      for (const shot of res.shots) if (!this.shotsWritten.has(shot.width)) this.onShot(shot);
      for (const p of res.probes ?? []) if (!this.probesWritten.has(p.width)) this.onProbe(p);
    }
    this.m.variants = variants.filter((v) => this.dir.exists(`capture/${v.width}.snapshot.json`));
    if (!this.m.variants.length) throw new Error("no width could be captured");
    this.m.variants[0].minWidth = 0;
    const media = await this.media(skipped).catch((e) => {
      skipped.push(`videos: ${(e as Error).message}`);
      return 0;
    });
    return { detail: `${this.m.variants.length} variant(s)${media ? `, ${media} video(s)` : ""}`, skipped };
  }

  /**
   * The page's videos as files (`capture/media/`, indexed in `capture/media.json`): one source per video (MP4 first,
   * then WebM), each URL once for all variants, through the same guard as the capture, within `budgets.mediaBytes`.
   * Streams (MSE / HLS) have no file: the recreation keeps their poster. Nothing is fetched with `assets: "none"`.
   */
  async media(skipped: string[]): Promise<number> {
    if ((this.cfg.assets ?? "run-dir") === "none") return 0;
    const wanted = new Map<string, string | undefined>();
    const visit = (n: any) => {
      if (!n || typeof n !== "object") return;
      if (n.media?.kind === "video" && !n.media.stream) {
        const srcs: { src: string; type?: string }[] = n.media.sources ?? [];
        const rank = (x: { src: string; type?: string }) =>
          /mp4/i.test(x.type ?? "") || /\.mp4(\?|$)/i.test(x.src)
            ? 0
            : /webm/i.test(x.type ?? "") || /\.webm(\?|$)/i.test(x.src)
              ? 1
              : 2;
        const best = [...srcs].sort((a, b) => rank(a) - rank(b))[0];
        if (best?.src && !wanted.has(best.src)) wanted.set(best.src, best.type);
      }
      for (const c of n.children ?? []) visit(c);
    };
    for (const v of this.m.variants ?? []) {
      const snap = this.snapshotOf(v.width);
      visit(snap.root);
      for (const i of (snap as any).invisible ?? []) visit(i.node);
    }
    if (!wanted.size) return 0;
    let left = Math.max(0, this.cfg.budgets?.mediaBytes ?? DEFAULT_MEDIA_BYTES);
    const index: Record<string, { file: string; type: string; bytes: number }> = {};
    for (const [url, type] of wanted) {
      this.cancelled();
      if (left <= 0) {
        skipped.push(`video ${url.slice(0, 120)} (media budget)`);
        continue;
      }
      // a stream recorded in the page: its loop is already here
      if (url.startsWith("data:video/")) {
        const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
        if (m) {
          const body = m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!));
          const file = `media/${createHash("sha256").update(body).digest("hex").slice(0, 16)}.webm`;
          this.dir.write(`capture/${file}`, body);
          index[url] = { file, type: m[1]!, bytes: body.length };
          left -= body.length;
        }
        continue;
      }
      const got = await fetchPublic(
        url,
        {
          "user-agent": "Mozilla/5.0 (compatible; CDR recreate)",
          referer: this.m.finalUrl ?? this.url,
          accept: "video/*,*/*",
        },
        left,
        60_000,
        this.guard,
      ).catch(() => null);
      if (!got?.body.length) {
        skipped.push(`video ${url.slice(0, 120)} (not downloaded)`);
        continue;
      }
      const mime = got.type.split(";")[0]!.trim() || type || "video/mp4";
      const ext = /webm/.test(mime) ? "webm" : /ogg/.test(mime) ? "ogv" : "mp4";
      const file = `media/${createHash("sha256").update(got.body).digest("hex").slice(0, 16)}.${ext}`;
      this.dir.write(`capture/${file}`, got.body);
      index[url] = { file, type: mime, bytes: got.body.length };
      left -= got.body.length;
    }
    this.dir.writeJson("capture/media.json", index);
    return Object.keys(index).length;
  }

  /** the downloaded videos (capture/media.json): source URL → bytes and type */
  mediaFiles(): Record<string, { body: Uint8Array; type: string }> {
    if (!this.dir.exists("capture/media.json")) return {};
    const idx = this.dir.readJson<Record<string, { file: string; type: string }>>("capture/media.json");
    const out: Record<string, { body: Uint8Array; type: string }> = {};
    for (const [u, f] of Object.entries(idx))
      if (this.dir.exists(`capture/${f.file}`))
        out[u] = { body: this.dir.read(`capture/${f.file}`), type: f.type };
    return out;
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
    // the fitted geometry too, when the run may keep sections fitted (gates.fittedSections): the build falls back to it
    // section by section where the flow version misses the live page
    if (this.fittedBudget() > 0) {
      const fit = pageScreens(caps, undefined, { flow: false });
      this.dir.writeJson("scene/screens.fitted.json", tagSections(fit.screens, pageSections(fit.screens)));
    } else this.dir.remove("scene/screens.fitted.json");
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
  /** sections the build may keep at their fitted geometry (gates.fittedSections, default 0: none) */
  fittedBudget(): number {
    return Math.max(0, Math.floor(this.cfg.gates?.fittedSections ?? DEFAULT_GATES.fittedSections));
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
  /** targets built from the live DOM (one DOM for every width) rather than from the scene */
  get domTargets(): DomTarget[] {
    return (this.m.request.to ?? ["static"]).filter((t): t is DomTarget =>
      DOM_TARGETS.includes(t as DomTarget),
    );
  }

  /** does the run need the scene-based static page (static itself, its projects and design systems) */
  get wantsStatic(): boolean {
    const to = this.m.request.to ?? ["static"];
    return to.some((t) => !DOM_TARGETS.includes(t as DomTarget));
  }

  /**
   * The modern recreation (out/modern): the variants' walks matched into one DOM, CSS fitted across widths, real media,
   * hover looks, menus, sliders. The Lit project (out/lit) is built from the same document; with `--build` its
   * `npm run build` is a gate and its dist is measured.
   */
  async buildModern(): Promise<string> {
    const variants = (this.m.variants ?? []).map((v) => ({
      width: v.width,
      minWidth: v.minWidth,
      snap: this.snapshotOf(v.width),
    }));
    const o = this.emitOptions();
    const { files, report, doc } = emitModern({
      variants,
      media: (o.assets ?? "run-dir") === "none" ? {} : this.mediaFiles(),
      page: this.pageName(),
      sourceUrl: o.sourceUrl,
      fonts: o.fonts === "system" ? "system" : "embed",
      images: o.assets !== "none",
    });
    const notes = provenance(
      { screens: [], page: this.pageName(), fonts: this.fonts() },
      o,
      "A modern recreation: one semantic DOM for every width. Open index.html, or serve the folder.",
    );
    this.writeFiles("out/modern", { ...files, ...notes });
    this.dir.write("build/modern.styles.base.css", String(files["styles.css"] ?? ""));
    this.dir.writeJson("build/modern.report.json", report);
    this.addOutput("modern", "out/modern");
    const parts = [
      `modern: ${report.sections} sections, ${report.classes} classes, breakpoints ${report.mediaQueries.join("/") || "none"}`,
      `${report.videos.filter((v) => v.file).length}/${report.videos.length} videos, ${report.sliders} sliders, ${report.hoverRules} hover looks`,
    ];
    for (const t of ["lit", "react-page", "angular-page"] as const)
      if (this.domTargets.includes(t)) parts.push(await this.buildProject(t, doc, files));
    return parts.join("; ");
  }

  /**
   * A project of the modern page (out/<target>): Lit, React or Angular, each prerendered by its own build and hydrated.
   * With `--build` its `npm run build` is a gate (`build:<target>`) and its dist is measured like the modern page.
   */
  async buildProject(
    t: "lit" | "react-page" | "angular-page",
    doc: ModernDoc,
    modern: FileMap,
  ): Promise<string> {
    const o = this.emitOptions();
    const opts = { projectName: this.pageName(), sourceUrl: o.sourceUrl };
    const files =
      t === "lit"
        ? emitLit(doc, modern, opts)
        : t === "react-page"
          ? emitReactPage(doc, modern, opts)
          : emitAngularPage(doc, modern, opts);
    const what = { lit: "A Lit + Vite", "react-page": "A React + Vite", "angular-page": "An Angular" }[t];
    const notes = provenance(
      { screens: [], page: this.pageName(), fonts: this.fonts() },
      o,
      `${what} recreation: \`npm install && npm run build\` (prerendered, hydrated).`,
    );
    this.writeFiles(`out/${t}`, { ...files, ...notes });
    this.addOutput(t, `out/${t}`);
    if (!this.host.runBuilds) return `${t}: written`;
    const b = await this.host.runBuilds(this.dir.path(`out/${t}`));
    this.m.gates = [
      ...this.m.gates.filter((g) => g.name !== `build:${t}`),
      { name: `build:${t}`, pass: b.ok, detail: b.output.slice(-400) },
    ];
    return `${t}: build ${b.ok ? "ok" : "failed"}`;
  }

  async build() {
    let modern = "";
    if (this.domTargets.length) modern = await this.buildModern();
    if (!this.wantsStatic) return { detail: modern };
    const screens = this.screens();
    const sections = this.sections();
    const files = getEmitter("static")!.emit(
      { screens, fonts: this.fonts(), page: this.pageName() },
      this.emitOptions(),
    );
    this.writeFiles("out/static", files);
    this.addOutput("static", "out/static");
    // the stylesheet as the build wrote it: what is added later (a repair, the agent) is linted on its own (flow gate)
    if (typeof files["styles.css"] === "string") this.dir.write("build/styles.base.css", files["styles.css"]);
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
      return { detail: [modern, `${sections.length} sections`].filter(Boolean).join("; ") };
    }
    for (const [k, s] of sections.entries()) this.emit({ ...base(s, k), status: "checking" });
    let results = await this.checkSections(sections, widths);
    // a section whose flow version misses its band may keep its fitted geometry, as many as the run allows
    // (gates.fittedSections): kept only where that is closer to the live page
    const fitted = await this.fallBack(sections, widths, threshold, results);
    if (fitted.length) results = await this.checkSections(sections, widths);
    // between the captures: each section's layout at the sweep widths (only when repairs may follow)
    let sweep = repairAllowed ? await this.sectionSweep() : null;
    const reasonOf = (id: string): RepairTask["reason"] => {
      if (results.get(id)!.worst > threshold) return "pixel";
      const found = sweep?.issues.get(id) ?? [];
      if (!found.length) return undefined;
      // only CSS that does not flow (texts placed by coordinates the page keeps in flow): the flow reason
      return found.every((x) => x.startsWith("flow:")) ? "flow" : "responsive";
    };
    const reasons = new Map(sections.map((s) => [s.id, reasonOf(s.id)]));
    const status = new Map<string, "ok" | "below-threshold" | "repaired">(
      sections.map((s) => [s.id, reasons.get(s.id) ? "below-threshold" : "ok"]),
    );
    const rejected = new Map<string, string[]>();
    const reverted = new Set<string>();
    const boundaries = (this.m.variants ?? []).map((v) => v.minWidth).filter((w) => w > 0);
    const indexRel = "out/static/index.html",
      cssRel = "out/static/styles.css";
    for (let attempt = 1; repairAllowed && attempt <= REPAIR_ATTEMPTS; attempt++) {
      const failing = sections
        .map((s, k) => ({ s, k }))
        .filter(({ s }) => status.get(s.id) === "below-threshold");
      if (!failing.length) break;
      this.cancelled();
      for (const { s, k } of failing)
        this.emit({ ...base(s, k), status: "building", reason: reasons.get(s.id) });
      const before = {
        html: this.dir.read(indexRel).toString("utf8"),
        css: this.dir.read(cssRel).toString("utf8"),
        results,
        sweep,
      };
      // patches to one file: the host serialises its writes; the model calls run side by side
      const outcomes = await mapLimit(failing, REPAIR_PARALLEL, ({ s, k }) =>
        this.host.repair!({
          runId: this.m.id,
          file: this.dir.rel(indexRel),
          section: { id: s.id, label: s.label, kind: s.kind, index: k },
          attempt,
          maxAttempts: REPAIR_ATTEMPTS,
          widths: results.get(s.id)!.widths,
          threshold,
          reason: reasons.get(s.id),
          sweep: this.sweepTask(s.id, sweep),
          ...(rejected.get(s.id)?.length ? { rejected: rejected.get(s.id) } : {}),
          boundaries,
        })
          .then((o): RepairOutcome => (typeof o === "boolean" ? { changed: o } : o))
          .catch((e): RepairOutcome => {
            this.host.log?.(`repair of ${s.id} failed: ${(e as Error).message}`);
            return { changed: false };
          }),
      );
      failing.forEach(({ s }, i) => rejected.set(s.id, outcomes[i]!.rejected ?? []));
      const changed = failing.filter((_, i) => outcomes[i]!.changed);
      if (!changed.length) {
        // every patch was rejected: the next attempt gets the reasons
        if (failing.some(({ s }) => rejected.get(s.id)?.length)) continue;
        break;
      }
      results = await this.checkSections(sections, widths);
      const after = before.sweep ? await this.sectionSweep() : null;
      // a patch stays only if it helped and broke nothing at any width: no new overlap or cut text between the
      // captures, the page height no further from the live page's where the section changed, its pixels better
      const undo = changed.filter(
        ({ s }) => !this.keepRepair(s.id, reasons.get(s.id), before, { results, sweep: after }),
      );
      if (undo.length) {
        this.revertRepairs(
          undo.map(({ s }) => s.id),
          attempt,
          before,
          undo.length === changed.length,
        );
        for (const { s } of undo) {
          results.set(s.id, before.results.get(s.id)!);
          reverted.add(s.id);
        }
        sweep = before.sweep && attempt < REPAIR_ATTEMPTS ? await this.sectionSweep() : after;
      } else sweep = after;
      for (const { s } of changed) {
        if (undo.some((u) => u.s.id === s.id)) continue;
        reverted.delete(s.id);
        const next = reasonOf(s.id);
        if (!next) status.set(s.id, "repaired");
        else reasons.set(s.id, next);
      }
    }
    let below = 0;
    for (const [k, s] of sections.entries()) {
      const st = status.get(s.id)!;
      if (st === "below-threshold") below++;
      this.emit({
        ...base(s, k),
        status: st,
        pixel: results.get(s.id)!.worst,
        ...(st !== "ok" && reasons.get(s.id) ? { reason: reasons.get(s.id) } : {}),
        ...(reverted.has(s.id) ? { reverted: true } : {}),
      });
    }
    return {
      detail: [
        modern,
        `${sections.length} sections, ${below} below the band threshold${reverted.size ? `, ${reverted.size} repair(s) undone` : ""}`,
      ]
        .filter(Boolean)
        .join("; "),
    };
  }

  /**
   * The fitted fallback (gates.fittedSections > 0): sections below their threshold, worst first, are swapped for their
   * fitted conversion one at a time and kept when their band gets closer to the live page. Sections holding a menu or
   * widget control stay in flow (their targets are the flow scene's). → the sections kept fitted (out/static/fitted.json).
   */
  async fallBack(
    sections: Section[],
    widths: number[],
    threshold: number,
    results: Map<string, { worst: number }>,
  ): Promise<string[]> {
    const budget = this.fittedBudget();
    this.dir.remove("out/static/fitted.json");
    if (!budget || !this.dir.exists("scene/screens.fitted.json")) return [];
    const fit = this.dir.readJson<SceneScreen[]>("scene/screens.fitted.json");
    let screens = this.screens();
    const kept: string[] = [];
    const candidates = sections
      .filter((s) => results.get(s.id)!.worst > threshold)
      .sort((a, b) => results.get(b.id)!.worst - results.get(a.id)!.worst);
    for (const s of candidates) {
      if (kept.length >= budget) break;
      const next = spliceFitted(screens, fit, s.id);
      if (!next) continue;
      this.writeFiles("out/static", this.emitStatic(next));
      const after = await this.checkSections([s], widths);
      if (after.get(s.id)!.worst < results.get(s.id)!.worst - 1e-4) {
        screens = next;
        kept.push(s.id);
        this.host.log?.(
          `section ${s.id} keeps its fitted geometry (pixel ${(after.get(s.id)!.worst * 100).toFixed(1)} %)`,
        );
      }
    }
    // the page as kept (the last check may have been of a swap that was not kept)
    const files = this.emitStatic(screens);
    this.writeFiles("out/static", files);
    if (typeof files["styles.css"] === "string") this.dir.write("build/styles.base.css", files["styles.css"]);
    if (kept.length) this.dir.writeJson("out/static/fitted.json", kept);
    return kept;
  }

  /** The static output of these screens. */
  emitStatic(screens: SceneScreen[]): FileMap {
    return getEmitter("static")!.emit(
      { screens, fonts: this.fonts(), page: this.pageName() },
      this.emitOptions(),
    );
  }

  /**
   * Every section's layout at the widths the live page has facts for (between and beyond the captures): the output
   * shot facts-only in two browsers, each width compared with the live page (layoutCheck). → per section the issues
   * the live page does not have, and per width the page's and the sections' heights.
   */
  async sectionSweep(): Promise<SectionSweep | null> {
    const ws = [...new Set([...(this.m.probe ?? []), ...(this.m.sweep ?? [])])]
      .filter((w) => this.dir.exists(`capture/live/${w}.json`))
      .sort((a, b) => a - b);
    if (!ws.length) return null;
    const page = pathToFileURL(this.dir.path("out/static/index.html")).href;
    const half = Math.ceil(ws.length / 2);
    const shots = (
      await Promise.all(
        [ws.slice(0, half), ws.slice(half)]
          .filter((c) => c.length)
          .map((c) =>
            this.driver.shoot(page, c, {
              guard: false,
              probe: LAYOUT_CHECK_JS,
              factsOnly: true,
              signal: this.host.signal,
            }),
          ),
      )
    ).flat();
    const live = new Map(this.liveFacts(ws).map((l) => [l.width, l]));
    const issues = new Map<string, string[]>();
    const outOfFlow = new Map<string, Set<string>>();
    const heights = new Map<number, { page?: number; live?: number; sections: Record<string, number> }>();
    const add = (id: string | undefined, msg: string) => {
      if (!id) return;
      issues.set(id, [...(issues.get(id) ?? []), msg]);
    };
    for (const o of shots) {
      const l = live.get(o.width);
      const c = layoutCheck(o.width, o, l?.probe ? l : null, undefined, 1, true);
      for (const p of c.pairs ?? [])
        add(p.section, `${o.width}px: "${p.a}" overlaps ${p.kind === "media" ? "an image" : `"${p.b}"`}`);
      for (const x of c.clipped ?? []) add(x.section, `${o.width}px: "${x.text}" is cut off by its box`);
      // texts the output takes out of the flow that the live page keeps in it: the section's CSS does not flow
      const at = new Map(((o.probe as LayoutFacts | undefined)?.anchors ?? []).map((a) => [a.k, a.s]));
      for (const k of c.outOfFlow ?? []) {
        const id = at.get(k);
        if (id) (outOfFlow.get(id) ?? outOfFlow.set(id, new Set()).get(id)!).add(k.slice(2));
      }
      const f = o.probe as LayoutFacts | undefined;
      const lf = l?.probe as LayoutFacts | undefined;
      heights.set(o.width, { page: f?.docHeight, live: lf?.docHeight, sections: f?.sections ?? {} });
    }
    for (const [id, texts] of outOfFlow)
      add(
        id,
        `flow: ${[...texts]
          .slice(0, 3)
          .map((t) => `"${t}"`)
          .join(", ")} placed by coordinates; the page keeps ${texts.size === 1 ? "it" : "them"} in its flow`,
      );
    return { issues, heights };
  }

  /** The section's sweep issues per width, for its repair task. */
  sweepTask(id: string, sweep: SectionSweep | null): RepairTask["sweep"] {
    const by = new Map<number, string[]>();
    for (const msg of sweep?.issues.get(id) ?? []) {
      if (msg.startsWith("flow:")) {
        by.set(0, [...(by.get(0) ?? []), msg.slice(6)]);
        continue;
      }
      const w = Number(msg.slice(0, msg.indexOf("px")));
      by.set(w, [...(by.get(w) ?? []), msg.slice(msg.indexOf(":") + 2)]);
    }
    return [...by].map(([width, issues]) => ({ width, issues }));
  }

  /** Did the pass's patch of section `id` help without breaking anything? (see build) */
  keepRepair(
    id: string,
    reason: RepairTask["reason"],
    before: { results: Map<string, { worst: number }>; sweep: SectionSweep | null },
    after: { results: Map<string, { worst: number }>; sweep: SectionSweep | null },
  ): boolean {
    const threshold = Math.max((this.cfg.gates?.pixel ?? DEFAULT_GATES.pixel) * 3, 0.03);
    const p0 = before.results.get(id)?.worst ?? 1,
      p1 = after.results.get(id)?.worst ?? 1;
    const pixelOk =
      reason === "pixel" || reason === undefined ? p1 < p0 - 1e-4 : p1 <= Math.max(threshold, p0);
    if (!pixelOk) return false;
    if (!before.sweep || !after.sweep) return true;
    const was = new Set(before.sweep.issues.get(id) ?? []);
    const now = after.sweep.issues.get(id) ?? [];
    if (now.some((x) => !was.has(x))) return false;
    if ((reason === "responsive" || reason === "flow") && now.length >= was.size) return false;
    for (const [w, a] of after.sweep.heights) {
      const b = before.sweep.heights.get(w);
      if (!b || a.live === undefined || a.page === undefined || b.page === undefined) continue;
      const sectionMoved = Math.abs((a.sections[id] ?? 0) - (b.sections[id] ?? 0)) > 1;
      if (sectionMoved && Math.abs(a.page - a.live) > Math.abs(b.page - a.live) + 2) return false;
    }
    return true;
  }

  /**
   * Undo the pass's patches of these sections: their CSS block (by its repair marker) and their markup (between the
   * section markers) back to what they were before the pass. `all`: every patch of the pass is undone, so the files
   * are restored as a whole (also what a repair wrote without markers).
   */
  revertRepairs(ids: string[], attempt: number, before: { html: string; css: string }, all: boolean) {
    const indexRel = "out/static/index.html",
      cssRel = "out/static/styles.css";
    if (all) {
      this.dir.write(indexRel, before.html);
      this.dir.write(cssRel, before.css);
      return;
    }
    let css = this.dir.read(cssRel).toString("utf8");
    let html = this.dir.read(indexRel).toString("utf8");
    for (const id of ids) {
      css = withoutRepairBlock(css, id, attempt);
      const old = [...before.html.matchAll(sectionRe(id))].map((m) => m[0]);
      let i = 0;
      html = html.replace(sectionRe(id), (m) => old[i++] ?? m);
    }
    this.dir.write(cssRel, css);
    this.dir.write(indexRel, html);
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
    // the static page, the modern one, and the Lit project's build when it was built (served like a host serves it)
    const targets = this.m.outputs
      .filter(
        (o) =>
          o.target === "static" ||
          o.target === "modern" ||
          (PROJECT_TARGETS.includes(o.target as DomTarget) && this.dir.exists(o.path, "dist", "index.html")),
      )
      .map((o) => ({
        ...o,
        root: PROJECT_TARGETS.includes(o.target as DomTarget) ? `${o.path}/dist` : o.path,
      }));
    // every measurement checks a few widths the ones before did not (the plan's rotating widths)
    const plan = this.plan(this.m.measures ?? 0);
    this.m.measures = (this.m.measures ?? 0) + 1;
    for (const t of targets) {
      const served = t.target === "static" ? null : await serveDir(this.dir.path(t.root));
      try {
        const page = served ? served.url : pathToFileURL(this.dir.path(t.path, "index.html")).href;
        const sweep = await this.sweepOutput(page, plan);
        const captured: Record<number, string[]> = {};
        const expectations: Record<number, ReturnType<typeof liveExpectations>> = {};
        for (const w of widths) {
          const snap = this.snapshotOf(w);
          captured[w] = textsOfSnapshot(snap);
          expectations[w] = liveExpectations(snap);
        }
        for (const o of sweep.out)
          if (o.png?.length) this.dir.write(`measure/${t.target}/sweep/${o.width}.png`, o.png);
        const { report, images } = measure({
          target: t.target,
          sweep: {
            out: sweep.out,
            live: this.liveFacts([...sweep.out.map((o) => o.width)]),
            spans: this.spans(),
            plan: { grid: plan.grid, boundaries: plan.boundaries, rotating: plan.rotating },
          },
          live,
          out: sweep.captured,
          captured,
          expectations,
          mask: Object.fromEntries(widths.map((w) => [w, this.mediaAt(w)])),
          gates: this.cfg.gates,
          flow: PROJECT_TARGETS.includes(t.target as DomTarget)
            ? undefined
            : this.flowInput(
                t.path,
                t.target === "modern" ? "build/modern.styles.base.css" : "build/styles.base.css",
              ),
        });
        // the quality gates (accessibility, markup, motion, behaviour, hover, Lighthouse) for the outputs built to be kept
        if (t.target !== "static") await this.quality(report, page, served ? this.dir.path(t.root) : null);
        for (const img of images) {
          this.dir.write(`measure/${t.target}/${img.width}/live.png`, img.live);
          this.dir.write(`measure/${t.target}/${img.width}/out.png`, img.out);
          this.dir.write(`measure/${t.target}/${img.width}/diff.png`, img.diff);
        }
        // the worst failing widths that had no screenshot: shot now, for the compare page and the agent's crops
        const worst = (report.sweep ?? [])
          .filter((c) => !c.pass && !this.dir.exists(`measure/${t.target}/sweep/${c.width}.png`))
          .sort(
            (a, b) => b.issues.length - a.issues.length || (b.pairs?.length ?? 0) - (a.pairs?.length ?? 0),
          )
          .slice(0, 2)
          .map((c) => c.width);
        if (worst.length) {
          const shots = await this.driver
            .shoot(page, worst, { guard: false, probe: LAYOUT_CHECK_JS, signal: this.host.signal })
            .catch(() => []);
          for (const o of shots) this.dir.write(`measure/${t.target}/sweep/${o.width}.png`, o.png);
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
      } finally {
        await served?.close();
      }
    }
    this.dir.write(
      "compare/index.html",
      comparePage(this.reports, {
        title: this.pageName(),
        sourceUrl: this.m.finalUrl ?? this.url,
        outputPage: (t) =>
          PROJECT_TARGETS.includes(t as DomTarget) ? `../out/${t}/dist/index.html` : `../out/${t}/index.html`,
      }),
    );
    return { detail: this.reports.map((r) => formatReport(r).split("\n")[0]).join("; ") };
  }

  /** Each variant's measured span (its capture width and its alt walks): pixels and heights must match there. */
  spans(): [number, number][] {
    return this.screens()
      .filter((x) => x.responsive || !x.root.meta?.overlayOf)
      .filter((x) => typeof x.root.meta?.overlayOf !== "string")
      .map((x) => {
        const ws = [x.width, ...(x.responsive?.measured ?? [])];
        return [Math.min(...ws), Math.max(...ws)] as [number, number];
      });
  }

  /** The live page's facts (and shot, where taken) at these widths, from the capture. */
  liveFacts(ws: number[]) {
    return [...new Set(ws)]
      .filter((w) => this.dir.exists(`capture/live/${w}.json`))
      .map((w) => ({
        width: w,
        ...(this.dir.exists(`capture/live/${w}.png`) ? { png: this.dir.read(`capture/live/${w}.png`) } : {}),
        ...this.dir.readJson<{ texts: string[]; overflowPx: number; probe?: unknown }>(
          `capture/live/${w}.json`,
        ),
      }));
  }

  /**
   * The output at the captured widths (screenshots and interaction probes), at the widths the live page was
   * screenshotted at (layout facts and screenshots) and at the rest of the sweep plan (layout facts only, resized in
   * place): a few browsers side by side.
   */
  async sweepOutput(page: string, plan: ReturnType<Runner["plan"]>) {
    const widths = (this.m.variants ?? []).map((v) => v.width);
    const shotWs = (this.m.sweep ?? sweepWidths(widths)).filter((w) => !widths.includes(w));
    const factWs = plan.all.filter((w) => !shotWs.includes(w) && !widths.includes(w));
    const half = Math.ceil(factWs.length / 2);
    const chunks = [factWs.slice(0, half), factWs.slice(half)].filter((c) => c.length);
    const o = { guard: false as const, signal: this.host.signal };
    const [captured, shots, ...facts] = await Promise.all([
      this.driver.shoot(page, widths, { ...o, probe: OUTPUT_PROBE_JS }),
      shotWs.length ? this.driver.shoot(page, shotWs, { ...o, probe: LAYOUT_CHECK_JS }) : Promise.resolve([]),
      ...chunks.map((c) => this.driver.shoot(page, c, { ...o, probe: LAYOUT_CHECK_JS, factsOnly: true })),
    ]);
    return { captured, out: [...shots, ...facts.flat()].sort((a, b) => a.width - b.width) };
  }

  /**
   * Accessibility (axe), markup, motion, slider behaviour and hover looks of an output at its widest and narrowest
   * width, against what the live page has; Lighthouse on the served folder (phone and desktop). Added to `report`.
   */
  async quality(report: MeasureReport, page: string, folder: string | null) {
    const ws = (this.m.variants ?? []).map((v) => v.width);
    if (!ws.length) return;
    const snaps = ws.map((w) => this.snapshotOf(w));
    const live = liveQuality(snaps);
    const widths = [...new Set([ws[ws.length - 1]!, ws[0]!])];
    const inspect = this.driver.inspect?.bind(this.driver);
    const gates: GateResult[] = [];
    const reports: QualityReport[] = [];
    if (!inspect) {
      for (const name of ["a11y", "markup", "motion", "behaviour"] as const)
        gates.push({ name, pass: true, detail: "skipped (the driver cannot inspect pages)" });
    } else {
      // the live page's own accessibility at the widest width, once per run (for comparison)
      let liveAxe: QualityProbe["axe"] | undefined, liveNodes: number | undefined;
      if (this.dir.exists("measure/live-quality.json"))
        ({ axe: liveAxe, nodes: liveNodes } = this.dir.readJson<{
          axe?: QualityProbe["axe"];
          nodes?: number;
        }>("measure/live-quality.json"));
      else if (this.cfg.gates?.liveQuality !== false) {
        const lq = await inspect(this.m.finalUrl ?? this.url, widths[0]!, {
          guard: this.guard,
          probe: QUALITY_PROBE_JS,
          signal: this.host.signal,
        }).catch(() => null);
        const p = lq?.probe as QualityProbe | undefined;
        if (p && !p.error) {
          liveAxe = p.axe;
          liveNodes = p.nodes;
          this.dir.writeJson("measure/live-quality.json", {
            axe: p.axe,
            nodes: p.nodes,
            at: new Date().toISOString(),
          });
        }
      }
      const by = new Map<string, QualityGate>();
      for (const [k, w] of widths.entries()) {
        this.cancelled();
        const r = await inspect(page, w, {
          guard: false,
          probe: QUALITY_PROBE_JS,
          hover: k === 0,
          signal: this.host.signal,
        }).catch((e) => ({ probe: { error: (e as Error).message } }));
        const probe = r.probe as QualityProbe | undefined;
        const q = qualityGates(probe, live, {
          liveNodes,
          liveAxe,
          ...(k === 0 ? { outHover: (r as { hover?: SnapHover[] }).hover ?? [] } : {}),
        });
        reports.push({
          width: w,
          ...(probe ? { probe } : {}),
          ...(k === 0 && liveAxe ? { live: { axe: liveAxe, nodes: liveNodes } } : {}),
          ...(q.hover ? { hover: q.hover } : {}),
          gates: q.gates,
        });
        // a gate fails when it fails at any width; its line names the widths
        for (const g of q.gates) {
          const prev = by.get(g.name);
          by.set(
            g.name,
            prev
              ? {
                  name: g.name,
                  pass: prev.pass && g.pass,
                  detail: prev.detail === g.detail ? prev.detail : `${prev.detail} | ${w}px: ${g.detail}`,
                }
              : { ...g, detail: widths.length > 1 ? `${w}px: ${g.detail}` : g.detail },
          );
        }
      }
      gates.push(...by.values());
    }
    // Lighthouse on the served folder
    if (folder && this.cfg.gates?.lighthouse !== false) {
      const scores = await runLighthouse(page, {
        chromePath: findChrome() ?? undefined,
        signal: this.host.signal,
      }).catch((e) => {
        this.host.log?.(`lighthouse failed: ${(e as Error).message}`);
        return [] as LighthouseScores[];
      });
      const lg = lighthouseGate(
        scores,
        typeof this.cfg.gates?.lighthouse === "object" ? this.cfg.gates.lighthouse : {},
      );
      gates.push({ name: "lighthouse", ...lg });
      if (scores) report.lighthouse = scores;
    }
    report.quality = reports;
    report.gates.push(...gates);
    report.pass = report.gates.every((g) => g.pass);
  }

  /** The output's stylesheet for the flow gate: linted against the build's own (what was added after it). */
  flowInput(rel: string, baseline = "build/styles.base.css") {
    const cssPath = `${rel}/styles.css`,
      htmlPath = `${rel}/index.html`;
    if (!this.dir.exists(cssPath) || !this.dir.exists(htmlPath)) return undefined;
    const html = this.dir.read(htmlPath).toString("utf8");
    const { sections, media } = sectionClasses(html);
    const fitted = this.fittedSections();
    const lint = flowLint({
      css: this.dir.read(cssPath).toString("utf8"),
      ...(this.dir.exists(baseline) ? { baseline: this.dir.read(baseline).toString("utf8") } : {}),
      scope: { ids: [...sections.keys()], classes: [...sections.values()].flatMap((c) => [...c]) },
      mediaClasses: media,
      boundaries: (this.m.variants ?? []).map((v) => v.minWidth).filter((w) => w > 0),
      exempt: fitted.flatMap((id) => [...(sections.get(id) ?? [])]),
    });
    return { lint, gating: FLOW_GATING, outOfFlow: FLOW_OUT_OF_FLOW_GATES, fitted };
  }

  /** Sections the emitter kept at their fitted geometry (they do not reflow). */
  fittedSections(): string[] {
    return this.dir.exists("out/static/fitted.json")
      ? this.dir.readJson<string[]>("out/static/fitted.json")
      : [];
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
      (t) =>
        t !== "static" &&
        !DOM_TARGETS.includes(t as DomTarget) &&
        (kind === "ds-export" ? isDs(t) : !isDs(t)),
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

/**
 * The screens with section `id` taken from the fitted conversion in every variant that has it: its content and own
 * layout the fitted one's, its place in its parent the flow one's (ids of the fitted subtree prefixed, they come from
 * another conversion). Null when no variant could be swapped or the section holds a control that opens or switches
 * something (its targets are the flow scene's).
 */
export function spliceFitted(flow: SceneScreen[], fitted: SceneScreen[], id: string): SceneScreen[] | null {
  let swapped = 0;
  const find = (e: SceneElement, p: SceneElement | null): [SceneElement, SceneElement | null] | null => {
    if (e.meta?.section === id) return [e, p];
    for (const c of e.children ?? []) {
      const r = find(c, e);
      if (r) return r;
    }
    return null;
  };
  const interactive = (e: SceneElement): boolean =>
    !!e.interaction || !!e.states || (e.children ?? []).some(interactive);
  const prefix = (e: SceneElement): SceneElement => ({
    ...e,
    id: `f-${e.id}`,
    ...(e.children ? { children: e.children.map(prefix) } : {}),
  });
  const OUTER = [
    "position",
    "x",
    "y",
    "right",
    "bottom",
    "margin",
    "alignSelf",
    "grow",
    "constraints",
    "z",
  ] as const;
  const out = flow.map((s) => {
    const f = fitted.find(
      (x) =>
        x.width === s.width &&
        (x.root.meta?.overlayOf === undefined) === (s.root.meta?.overlayOf === undefined),
    );
    if (!f || s.root.meta?.overlayOf !== undefined) return s;
    const root = structuredClone(s.root);
    const a = find(root, null),
      b = find(f.root, null);
    if (!a || !b || !a[1] || interactive(a[0]) || interactive(b[0])) return s;
    const [mine, parent] = a;
    const theirs = prefix(structuredClone(b[0]));
    const layout: SceneLayout = { ...theirs.layout };
    for (const k of OUTER) delete layout[k];
    for (const k of OUTER)
      if (mine.layout?.[k] !== undefined) (layout as Record<string, unknown>)[k] = mine.layout[k];
    // the band keeps the width its parent gives it in flow; its height is the fitted one's (its content is placed)
    if (mine.layout?.width === "fill" || typeof mine.layout?.width === "string")
      layout.width = mine.layout.width;
    parent.children = parent.children!.map((c) =>
      c === mine
        ? { ...theirs, id: mine.id, layout, meta: { ...theirs.meta, section: id, fitted: true } }
        : c,
    );
    swapped++;
    return { ...s, root };
  });
  return swapped ? out : null;
}

/** One sweep of the output for the repair loop: per section its issues, per width the heights. */
interface SectionSweep {
  issues: Map<string, string[]>;
  heights: Map<number, { page?: number; live?: number; sections: Record<string, number> }>;
}

const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A section's copies in index.html, markers included. */
export const sectionRe = (id: string) =>
  new RegExp(`<!-- section:${escRe(id)} -->[\\s\\S]*?<!-- /section -->`, "g");

/** `css` without the block a repair of section `id` added in `attempt` (from its marker to the next marker or the end). */
export function withoutRepairBlock(css: string, id: string, attempt: number): string {
  const marker = `\n${repairMarker(id, attempt)}`;
  const i = css.indexOf(marker);
  if (i < 0) return css;
  const j = css.indexOf("\n/* repair: section ", i + marker.length);
  return css.slice(0, i) + (j < 0 ? "" : css.slice(j));
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
