import type { Issue, StepContext, StepFn, StepReport } from "@harness/mirror-core";
import { accessibility } from "./checks/a11y.js";
import { contentCompleteness } from "./checks/content.js";
import { linkCheck } from "./checks/links.js";
import { media } from "./checks/media.js";
import { playback } from "./checks/playback.js";
export type { PlayerFinding } from "./checks/playback.js";
import { performance } from "./checks/performance.js";
import { redirects } from "./checks/redirects.js";
import { richTextCleanliness, richTextFidelity } from "./checks/richtext.js";
import { seoParity } from "./checks/seo.js";
import { visualRegression } from "./checks/visual.js";
import { contextFromStep } from "./context.js";
import type { CheckFn, CheckResult, VerifyContext } from "./types.js";

export * from "./types.js";
export { buildVerifyContext, contextFromStep, getPage, normPath, parseUrlList } from "./context.js";
export { readCcmData, localePrefix } from "./ccm.js";
export {
  CAPTURE_SETTINGS,
  DEFAULT_BBOX_SELECTORS,
  COMPONENT_CLASS_RE,
  GENERIC_COMPONENT_CLASS_PREFIXES,
  componentClassRe,
  priorityClassRe,
  captureScreenshot,
  loadForCapture,
  loadForCaptureInfo,
  newCaptureContext,
  blockedHosts,
  hostAllowed,
  collectBoxes,
  collectComponentBoxes,
  compareBoxes,
  compareImages,
  diffRegions,
  attributeRegions,
  attributeDiff,
  firstDivergence,
  type ViewportSpec,
  type Box,
  type ComponentBox,
  type DiffRegion,
  type AttributedRegion,
  type CaptureContextOptions,
} from "./capture.js";
export { visualTable, resolveViewports } from "./checks/visual.js";
export {
  diagnoseShot,
  launchBrowser,
  findDivergence,
  classify,
  diffAssetSets,
  alignChildren,
  signature,
  nodeLabel,
  skeleton,
  attrDiff,
  unstableNodes,
  assetKey,
  STYLE_PROPS,
  type ParityDossier,
  type ParityCause,
  type Classification,
  type SnapNode,
  type PageSnapshot,
  type Divergence,
  type DiagnoseOptions,
  type RuleOrigin,
} from "./diagnose.js";
export { FORBIDDEN_HOSTS, captureOrigin } from "./context.js";
export { textSimilarity, localNormalizeText, localPlainText, loadTextFns } from "./text.js";
export { mainText, pageText, extractSeo, extractHrefs, extractImageSrcs } from "./html.js";
export { keyTexts } from "./checks/content.js";
export { expectedRedirects } from "./checks/redirects.js";
export { diffSeo } from "./checks/seo.js";
export { accessibility, contentCompleteness, linkCheck, media, performance, playback, redirects, richTextCleanliness, richTextFidelity, seoParity, visualRegression };

/** Check id (= verify/<id>.json and gate prefix) → implementation, in run order. */
export const CHECKS: Record<string, CheckFn> = {
  content: contentCompleteness,
  fidelity: richTextFidelity,
  cleanliness: richTextCleanliness,
  links: linkCheck,
  redirects,
  media,
  playback,
  seo: seoParity,
  visual: visualRegression,
  a11y: accessibility,
  performance,
};

/** Aliases accepted in `checks` (export names and common spellings). */
const ALIASES: Record<string, string> = {
  contentCompleteness: "content",
  completeness: "content",
  richTextFidelity: "fidelity",
  richTextCleanliness: "cleanliness",
  linkCheck: "links",
  link: "links",
  seoParity: "seo",
  visualRegression: "visual",
  screenshots: "visual",
  accessibility: "a11y",
  players: "playback",
  video: "playback",
  perf: "performance",
  lighthouse: "performance",
};

export function resolveCheckIds(ids?: string[]): string[] {
  if (!ids || !ids.length) return Object.keys(CHECKS);
  const out: string[] = [];
  for (const raw of ids.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean)) {
    const id = CHECKS[raw] ? raw : ALIASES[raw];
    if (!id) throw new Error(`unknown verify check "${raw}" (known: ${Object.keys(CHECKS).join(", ")})`);
    if (!out.includes(id)) out.push(id);
  }
  return Object.keys(CHECKS).filter((k) => out.includes(k));
}

/** Run checks sequentially on a shared context; a throwing check is recorded as failed, others continue. */
export async function runChecks(cx: VerifyContext, ids?: string[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const id of resolveCheckIds(ids)) {
    const started = Date.now();
    try {
      const r = await CHECKS[id](cx);
      r.stats.durationMs = Date.now() - started;
      results.push(r);
      cx.log.info(`verify ${id}: ${r.ok ? "pass" : "FAIL"}`, r.gates);
    } catch (e) {
      const err = e as Error;
      cx.log.error(`verify ${id} crashed: ${err.message}`);
      const r: CheckResult = {
        check: id,
        ok: false,
        stats: { durationMs: Date.now() - started, crashed: true },
        issues: [{ severity: "error", code: "CHECK_CRASHED", message: `${id}: ${err.message}`, actionable: true }],
        gates: { run: { pass: false, value: "crashed" } },
        details: { error: err.stack ?? err.message },
      };
      await cx.ws.writeJson(`verify/${id}.json`, r).catch(() => undefined);
      results.push(r);
    }
  }
  return results;
}

/** Aggregate per-check results into one StepReport (gates prefixed `<check>.<gate>`). */
export function toStepReport(cx: VerifyContext, results: CheckResult[], startedAt: string, dryRun = false): StepReport {
  const gates: NonNullable<StepReport["gates"]> = {};
  const stats: StepReport["stats"] = { newBaseUrl: cx.newBaseUrl, oldBaseUrl: cx.oldBaseUrl, checks: results.length };
  const issues: Issue[] = [];
  for (const r of results) {
    for (const [g, v] of Object.entries(r.gates)) gates[`${r.check}.${g}`] = v;
    stats[`${r.check}.ok`] = r.ok;
    issues.push(...r.issues);
  }
  return {
    step: "verify",
    site: cx.site.site,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: results.every((r) => r.ok),
    dryRun,
    stats,
    issues,
    outputs: [...results.map((r) => `verify/${r.check}.json`), "verify/summary.json"],
    gates,
  };
}

/**
 * migrate verify: options `{ checks?: string[], newBaseUrl: string, oldBaseUrl?: string, urls?: string[] }`.
 * Writes verify/<check>.json + verify/summary.json.
 */
export const verifyStep: StepFn = async (ctx: StepContext) => {
  const startedAt = new Date().toISOString();
  const cx = await contextFromStep(ctx);
  try {
    const checks = ctx.options.checks as string[] | string | undefined;
    const results = await runChecks(cx, typeof checks === "string" ? [checks] : checks);
    const report = toStepReport(cx, results, startedAt, ctx.dryRun);
    await ctx.ws.writeJson("verify/summary.json", {
      ok: report.ok,
      newBaseUrl: cx.newBaseUrl,
      oldBaseUrl: cx.oldBaseUrl,
      gates: report.gates,
      checks: Object.fromEntries(results.map((r) => [r.check, { ok: r.ok, gates: r.gates, stats: r.stats, issues: r.issues.filter((i) => i.severity !== "info").length }])),
    });
    return report;
  } finally {
    await cx.close();
  }
};
