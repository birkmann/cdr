import { readFile, rm } from "node:fs/promises";
import { safeId, type Issue } from "@harness/mirror-core";
import type { BrowserContext, Page } from "playwright";
import {
  attributeDiff,
  blockedHosts,
  firstDivergence,
  captureScreenshot,
  collectBoxes,
  collectComponentBoxes,
  compareBoxes,
  compareImages,
  DEFAULT_BBOX_SELECTORS,
  loadForCaptureInfo,
  newCaptureContext,
  type AttributedRegion,
  type Box,
  type ComponentBox,
  type LoadInfo,
  type ViewportSpec,
} from "../capture.js";
import { readCrawl, resolveProfileSet } from "@harness/mirror-capture";
import { diagnoseShot } from "../diagnose.js";
import type { CheckResult, VerifyContext } from "../types.js";
import { finish, notRun, notRunIssue, round } from "./util.js";

const fmtDelta = (d: number) => (Number.isFinite(d) ? d : "missing");

/**
 * Did the original change between the crawl and this verify? Only then may a shot that fails against the live original
 * be re-judged against the crawl-time capture (SOURCE_DRIFT). A live shot that reproduces the crawl shot pixel for
 * pixel (a replayed capture, a static page) means the difference is the migration's — bmw.de: a 24 px key-element box
 * delta on a static replay must stay a BBOX_DIFF, not become "drift".
 */
export function sourceDrifted(oldLive: Buffer, crawlShot: Buffer): boolean {
  const c = compareImages(oldLive, crawlShot);
  return c.parity < 0.999 || c.oldSize.width !== c.newSize.width || c.oldSize.height !== c.newSize.height;
}

/**
 * Verdict for a live-baseline shot once the original HAS drifted from its crawl-time capture. The capture is the
 * pipeline's input, so it judges the shot — also when the comparison against the live page passed: a live page that
 * happens to be in the same changed state as a defective new page must not hide the defect. (ibm.com renders its
 * footer 144 px shorter on some loads of the original; a from-blank run passed or failed depending on which state the
 * live page was in when verify ran, so the same input gave different gate results.) Key-element boxes have no
 * crawl-time twin, so against the capture the pixel + page-size match stands in for them.
 * Severity of the SOURCE_DRIFT note: info when live and capture agree (both pass), warning when the verdict differs
 * from the live one or the shot fails against the capture.
 */
export function judgeDrifted(
  live: { parityPass: boolean; bboxPass: boolean; heightPass: boolean },
  capture: { parity: number; heightDelta: number; widthDelta: number },
  threshold: number,
  heightTol: number,
): { parityPass: boolean; heightPass: boolean; livePass: boolean; capturePass: boolean; severity: "info" | "warning" } {
  const livePass = live.parityPass && live.bboxPass && live.heightPass;
  const parityPass = capture.parity >= threshold;
  const heightPass = Math.abs(capture.heightDelta) <= heightTol && Math.abs(capture.widthDelta) <= heightTol;
  const capturePass = parityPass && heightPass;
  return { parityPass, heightPass, livePass, capturePass, severity: livePass && capturePass ? "info" : "warning" };
}
const fmtRegion = (r: AttributedRegion) => `${r.component}${r.element ? ` › ${r.element}` : ""} @y${r.y} ${r.w}×${r.h} (${Math.round(r.share * 100)}%)`;

/**
 * Baseline policy (`options.baseline`):
 * - "live" (default when the old site is reachable): capture the old site now with the exact same routine as the new
 *   one (stabilised: lazy images, fonts, frozen timers/carousels/videos, fixed/sticky pinned, same masks).
 * - "design": prefer design/screenshots/<vp>/<id>.png (crawler baseline) and fall back to live.
 * Without a reachable old site the design baseline is the only option (bbox + attribution on the new side only).
 */
type BaselinePolicy = "live" | "design";

interface Side {
  page: Page;
  ctx: BrowserContext;
}

/**
 * Theme component-class prefixes for diff attribution: `site.parity.componentClassPrefixes` ∪ the resolved theme pack's
 * (`@cmp/source-html` resolveProfileSet: site profiles.yaml > theme pack, auto-detected from the crawl). Cached per run.
 */
const prefixCache = new WeakMap<VerifyContext, Promise<string[]>>();
export function componentClassPrefixes(cx: VerifyContext): Promise<string[]> {
  let p = prefixCache.get(cx);
  if (!p) {
    p = (async () => {
      const out = [...(cx.site.parity.componentClassPrefixes ?? [])];
      try {
        const crawl = await readCrawl(cx.ws);
        const r = await resolveProfileSet(cx.ws, cx.site, crawl ? { pages: crawl.pages, assets: crawl.assets } : undefined);
        for (const x of r.set.componentClassPrefixes ?? []) if (!out.includes(x)) out.push(x);
      } catch {
        /* no crawl / invalid profiles.yaml: site prefixes only */
      }
      return out;
    })();
    prefixCache.set(cx, p);
  }
  return p;
}

async function shoot(cx: VerifyContext, side: Side, url: string, vp: ViewportSpec, selectors: string[]) {
  let info: LoadInfo = await loadForCaptureInfo(side.page, url, vp);
  // a server restarting under us (status 0 / 5xx) is transient: wait and retry once before recording an error
  for (let attempt = 1; attempt <= 2 && (info.status === 0 || info.status >= 500); attempt++) {
    cx.log.warn(`visual: ${url} returned ${info.status} @${vp.name}, retrying (${attempt}/2)`);
    await side.page.waitForTimeout(5000);
    info = await loadForCaptureInfo(side.page, url, vp);
  }
  // boxes are read in the frozen state, before the screenshot (a full-page capture resizes the viewport)
  const boxes: Box[] = await collectBoxes(side.page, selectors, cx.mask);
  const components: ComponentBox[] = await collectComponentBoxes(side.page, { classPrefixes: await componentClassPrefixes(cx) }).catch(() => []);
  const png = await captureScreenshot(side.page, url, vp, { mask: cx.mask, skipLoad: true });
  return { info, png, boxes, components };
}

/**
 * `options.viewports`: ViewportSpec[] (programmatic), or viewport names (string[] / "mobile,desktop" from the CLI
 * `--viewports`) filtering `site.crawl.viewports`. Unknown names throw (a typo must not verify nothing).
 */
export function resolveViewports(opt: unknown, configured: ViewportSpec[]): ViewportSpec[] {
  if (opt === undefined || opt === null || (Array.isArray(opt) && !opt.length) || opt === "") return configured;
  const list = (Array.isArray(opt) ? opt : [opt]) as unknown[];
  if (list.every((v) => v && typeof v === "object")) return list as ViewportSpec[];
  const names = list.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean);
  const out: ViewportSpec[] = [];
  for (const n of names) {
    const vp = configured.find((v) => v.name === n);
    if (!vp) throw new Error(`unknown viewport "${n}" (configured: ${configured.map((v) => v.name).join(", ")})`);
    if (!out.includes(vp)) out.push(vp);
  }
  return out;
}

/** Screenshot parity per URL × viewport (old vs new, same capture routine), key-element bbox diff, page height, diff attribution. */
export async function visualRegression(cx: VerifyContext): Promise<CheckResult> {
  const threshold = cx.site.parity.screenshotThreshold;
  const tol = cx.site.parity.bboxTolerancePx;
  const heightTol = Number(cx.options.heightTolerancePx ?? tol);
  const viewports: ViewportSpec[] = resolveViewports(cx.options.viewports, cx.site.crawl.viewports);
  const selectors = (cx.options.bboxSelectors as string[] | undefined) ?? DEFAULT_BBOX_SELECTORS;
  const policy: BaselinePolicy = cx.options.baseline === "design" ? "design" : "live";
  const issues: Issue[] = [];
  const oldReachable = (await cx.fetchPage("old", cx.urls[0] ?? "/")).status !== 0;
  if (!oldReachable) issues.push({ severity: "warning", code: "OLD_UNREACHABLE", message: `old site ${cx.oldBaseUrl} unreachable: bbox check skipped, design/ baselines only` });
  const browser = await cx.browser();
  const rows: Array<Record<string, unknown>> = [];
  const outputs: string[] = [];
  const blocked = new Set<string>();
  let minParity = 1;
  let maxBbox = 0;
  let maxHeight = 0;
  let failing = 0;
  for (const vp of viewports) {
    let newSide: Side | undefined;
    let oldSide: Side | undefined;
    try {
      const nctx = await newCaptureContext(browser, vp, cx.capture);
      newSide = { ctx: nctx, page: await nctx.newPage() };
      if (oldReachable) {
        const octx = await newCaptureContext(browser, vp, cx.capture);
        oldSide = { ctx: octx, page: await octx.newPage() };
      }
      for (const path of cx.urls) {
        const id = safeId(path);
        const n = await shoot(cx, newSide, cx.newBaseUrl + path, vp, selectors);
        outputs.push(await cx.ws.writeText(`verify/visual/${vp.name}/${id}.new.png`, n.png));

        let baseline: Buffer | undefined;
        let baselineSource = "design";
        let baselineFile = `design/screenshots/${vp.name}/${id}.png`;
        if (policy === "design" || !oldSide) {
          try {
            baseline = await readFile(cx.ws.path(baselineFile));
          } catch {
            baseline = undefined;
          }
        }
        let o: Awaited<ReturnType<typeof shoot>> | undefined;
        if (oldSide) {
          o = await shoot(cx, oldSide, cx.oldBaseUrl + path, vp, selectors);
          if (o.info.status >= 400 || o.info.status === 0)
            issues.push({ severity: "error", code: "OLD_PAGE_ERROR", message: `${vp.name} ${path}: old site returned ${o.info.status}`, ref: path, actionable: true });
          if (!baseline) {
            baseline = o.png;
            baselineSource = "live";
            baselineFile = `verify/visual/${vp.name}/${id}.old.png`;
            outputs.push(await cx.ws.writeText(baselineFile, baseline));
            if (policy === "design") issues.push({ severity: "info", code: "BASELINE_LIVE", message: `${vp.name} ${path}: no design/screenshots baseline, captured old site live`, ref: path });
          }
        }
        if (n.info.status >= 400 || n.info.status === 0)
          issues.push({ severity: "error", code: "NEW_PAGE_ERROR", message: `${vp.name} ${path}: new site returned ${n.info.status}`, ref: path, actionable: true });
        if (!baseline) {
          issues.push({ severity: "error", code: "BASELINE_MISSING", message: `${vp.name} ${path}: no baseline and old site unreachable`, ref: path });
          rows.push({ viewport: vp.name, path, pass: false, error: "no baseline" });
          failing++;
          minParity = 0;
          continue;
        }
        let cmp = compareImages(baseline, n.png);
        let bb = o ? compareBoxes(o.boxes, n.boxes) : undefined;
        let heightDelta = cmp.newSize.height - cmp.oldSize.height;
        let widthDelta = cmp.newSize.width - cmp.oldSize.width;
        let parityPass = cmp.parity >= threshold;
        let bboxPass = !bb || bb.maxDelta <= tol;
        let heightPass = Math.abs(heightDelta) <= heightTol && Math.abs(widthDelta) <= heightTol;
        // Source drift: a live original keeps changing (news teasers, disruption tickers, elements that render on some
        // loads only). Once the live page differs from the crawl-time capture (the pipeline's input), the capture judges
        // the shot — whether the live comparison passed or failed (judgeDrifted) — and the shot is reported as
        // SOURCE_DRIFT. A shot that reproduces the capture within the gate's own thresholds passes although the live
        // page moved on; a shot that matches a changed live page but not the capture fails, as it would have on a
        // different load of the original. Key-element boxes have no crawl-time twin (different selector set); the
        // pixel + size match against the capture stands in for them on such a shot.
        let drift: { liveParity: number; liveHeightDelta: number; liveBbox?: number; livePass: boolean } | undefined;
        const crawlShot = cx.crawlPage(path)?.screenshots[vp.name];
        if (baselineSource === "live" && crawlShot && o) {
          const crawlPng = await readFile(cx.ws.path(crawlShot)).catch(() => undefined);
          // no drift when the live original still looks exactly like its crawl-time capture: the live verdict stands
          if (crawlPng && sourceDrifted(o.png, crawlPng)) {
            const c2 = compareImages(crawlPng, n.png);
            const h2 = c2.newSize.height - c2.oldSize.height;
            const w2 = c2.newSize.width - c2.oldSize.width;
            const v = judgeDrifted({ parityPass, bboxPass, heightPass }, { parity: c2.parity, heightDelta: h2, widthDelta: w2 }, threshold, heightTol);
            drift = { liveParity: round(cmp.parity), liveHeightDelta: heightDelta, ...(bb ? { liveBbox: bb.maxDelta } : {}), livePass: v.livePass };
            const liveText = `the live original (parity ${drift.liveParity}, Δh ${drift.liveHeightDelta > 0 ? "+" : ""}${drift.liveHeightDelta}px${drift.liveBbox !== undefined ? `, bbox ${fmtDelta(drift.liveBbox)}px` : ""})`;
            const captureText = `the crawl-time capture (parity ${round(c2.parity)}, Δh ${h2 > 0 ? "+" : ""}${h2}px)`;
            cmp = c2;
            heightDelta = h2;
            widthDelta = w2;
            bb = undefined;
            parityPass = v.parityPass;
            bboxPass = true;
            heightPass = v.heightPass;
            baselineSource = "crawl";
            baselineFile = crawlShot;
            issues.push({
              severity: v.severity,
              code: "SOURCE_DRIFT",
              message: v.capturePass
                ? `${vp.name} ${path}: ${v.livePass ? "matches" : "differs from"} ${liveText} and matches ${captureText}: the source changed since the crawl — judged against the capture ${crawlShot}`
                : `${vp.name} ${path}: ${v.livePass ? "matches" : "differs from"} ${liveText} but not ${captureText}, the pipeline's input: the source changed since the crawl — judged against the capture ${crawlShot}`,
              ref: path,
            });
          }
        }
        const diffRel = `verify/visual/${vp.name}/${id}.diff.png`;
        outputs.push(await cx.ws.writeText(diffRel, cmp.diffPng));
        const regions = attributeDiff(cmp, o?.components ?? [], n.components, vp.height);
        const firstAttributed = firstDivergence(cmp, o?.components ?? [], n.components);
        const where =
          (firstAttributed ? ` — first divergence at y=${firstAttributed.y} in ${firstAttributed.component}${firstAttributed.element ? ` › ${firstAttributed.element}` : ""}` : "") +
          (regions.length ? `; top diff regions: ${regions.slice(0, 3).map(fmtRegion).join("; ")}` : "");
        if (!parityPass) {
          failing++;
          issues.push({ severity: "error", code: "VISUAL_DIFF", message: `${vp.name} ${path}: parity ${round(cmp.parity)} < ${threshold} (diff ${diffRel})${where}`, ref: path, actionable: true });
        }
        if (!bboxPass)
          issues.push({
            severity: "error",
            code: "BBOX_DIFF",
            message: `${vp.name} ${path}: key element box delta ${fmtDelta(bb!.maxDelta)}px > ${tol}px (${bb!.diffs
              .slice(0, 3)
              .map((d) => `${d.selector}#${d.index}:${fmtDelta(d.delta)}`)
              .join(", ")})`,
            ref: path,
            actionable: true,
          });
        if (heightDelta || widthDelta)
          issues.push({
            severity: heightPass ? "info" : "error",
            code: "HEIGHT_DIFF",
            message: `${vp.name} ${path}: page size ${cmp.oldSize.width}×${cmp.oldSize.height} (old) → ${cmp.newSize.width}×${cmp.newSize.height} (new), Δh ${heightDelta > 0 ? "+" : ""}${heightDelta}px${
              firstAttributed ? `; first divergence at y=${firstAttributed.y} in ${firstAttributed.component}${firstAttributed.element ? ` › ${firstAttributed.element}` : ""}` : ""
            }`,
            ref: path,
            actionable: !heightPass,
          });
        for (const ctx of [newSide.ctx, oldSide?.ctx]) if (ctx) for (const h of blockedHosts(ctx)) blocked.add(h);
        minParity = Math.min(minParity, cmp.parity);
        if (bb) maxBbox = Math.max(maxBbox, bb.maxDelta);
        maxHeight = Math.max(maxHeight, Math.abs(heightDelta), Math.abs(widthDelta));
        rows.push({
          viewport: vp.name,
          path,
          status: n.info.status,
          oldStatus: o?.info.status,
          parity: round(cmp.parity),
          pass: parityPass && bboxPass && heightPass,
          parityPass,
          bboxPass,
          heightPass,
          baselineSource,
          baseline: baselineFile,
          ...(drift ? { sourceDrift: drift } : {}),
          current: `verify/visual/${vp.name}/${id}.new.png`,
          diffPixels: cmp.diffPixels,
          size: { old: cmp.oldSize, new: cmp.newSize },
          height: { old: cmp.oldSize.height, new: cmp.newSize.height, delta: heightDelta },
          diff: diffRel,
          firstDiff: firstAttributed,
          regions,
          stabilise: { old: o?.info.freeze, new: n.info.freeze, fonts: { old: o?.info.fonts, new: n.info.fonts } },
          bbox: bb ? { maxDelta: fmtDelta(bb.maxDelta), compared: bb.compared, diffs: bb.diffs.slice(0, 20).map((d) => ({ ...d, delta: fmtDelta(d.delta) })) } : undefined,
        });
      }
    } finally {
      await newSide?.ctx.close().catch(() => undefined);
      await oldSide?.ctx.close().catch(() => undefined);
    }
  }
  // diagnosis dossiers (text only) for every failing shot measured in this run: verify/diagnosis/<viewport>/<page>.json
  if (cx.options.diagnose !== false && oldReachable) {
    for (const r of rows) {
      const vp = viewports.find((v) => v.name === r.viewport);
      if (!vp || r.carried) continue;
      const rel = `verify/diagnosis/${vp.name}/${safeId(String(r.path))}.json`;
      if (r.pass) {
        await rm(cx.ws.path(rel), { force: true });
        continue;
      }
      try {
        const d = await diagnoseShot(browser, {
          path: String(r.path),
          oldUrl: cx.oldBaseUrl + r.path,
          newUrl: cx.newBaseUrl + r.path,
          viewport: vp,
          mask: cx.mask,
          capture: cx.capture,
          tolerancePx: Math.max(1, Math.min(2, tol)),
          componentClassPrefixes: await componentClassPrefixes(cx),
          instability: cx.options.instability !== false,
        });
        outputs.push(await cx.ws.writeJson(rel, d));
        const c = d.classification;
        r.diagnosis = { file: rel, cause: c.cause, subtype: c.subtype, confidence: c.confidence, element: d.firstDivergence?.element, lane: c.lane };
        const note = ` [diagnosis: ${c.cause}${c.subtype ? `/${c.subtype}` : ""}${d.firstDivergence ? ` at ${d.firstDivergence.element}` : ""} → ${rel}]`;
        for (const i of issues) if (i.ref === r.path && i.message.startsWith(`${vp.name} ${r.path}:`) && ["VISUAL_DIFF", "BBOX_DIFF", "HEIGHT_DIFF"].includes(i.code)) i.message += note;
      } catch (e) {
        issues.push({ severity: "warning", code: "VISUAL_DIAGNOSIS_FAILED", message: `${vp.name} ${r.path}: diagnosis failed: ${(e as Error).message.split("\n")[0]}`, ref: String(r.path) });
      }
    }
  }
  if (blocked.size) issues.push({ severity: "info", code: "VISUAL_HOSTS_BLOCKED", message: `requests to non-local hosts aborted on both sides: ${[...blocked].join(", ")}` });
  // scoped run (--urls / --viewports): keep the previous run's rows (and their issues) for the shots outside the scope,
  // so verify/visual.json + the gates always describe every shot; carried rows are flagged `carried: true`
  const configuredVps = cx.site.crawl.viewports.map((v) => v.name);
  const scoped = cx.options.mergeScoped !== false && (viewports.length < configuredVps.length || cx.urls.length < (cx.site.urls ?? []).length);
  const scope = { urls: cx.urls, viewports: viewports.map((v) => v.name) };
  if (scoped) {
    const prev = await cx.ws.readJson<{ issues?: Issue[]; details?: { results?: Array<Record<string, unknown>> } }>("verify/visual.json").catch(() => undefined);
    const inScope = (vp: string, path: string) => scope.viewports.includes(vp) && scope.urls.includes(path);
    for (const r of prev?.details?.results ?? []) {
      const vp = String(r.viewport);
      const path = String(r.path);
      if (inScope(vp, path) || !configuredVps.includes(vp) || !(cx.site.urls ?? []).includes(path)) continue;
      rows.push({ ...r, carried: true });
      for (const i of prev?.issues ?? []) if (i.ref === path && i.message.startsWith(`${vp} ${path}:`)) issues.push(i);
      const parity = typeof r.parity === "number" ? r.parity : 0;
      minParity = Math.min(minParity, parity);
      if (r.parityPass === false || (r.parityPass === undefined && r.pass === false)) failing++;
      const bbd = (r.bbox as { maxDelta?: number | string } | undefined)?.maxDelta;
      if (typeof bbd === "number") maxBbox = Math.max(maxBbox, bbd);
      else if (bbd === "missing") maxBbox = Infinity;
      const hd = (r.height as { delta?: number } | undefined)?.delta;
      if (typeof hd === "number") maxHeight = Math.max(maxHeight, Math.abs(hd));
    }
    const order = (r: Record<string, unknown>) => [configuredVps.indexOf(String(r.viewport)), (cx.site.urls ?? []).indexOf(String(r.path))];
    rows.sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
  }
  const bboxGate = oldReachable
    ? { pass: maxBbox <= tol, value: Number.isFinite(maxBbox) ? maxBbox : "missing", threshold: tol }
    : { pass: true, value: "skipped", threshold: tol };
  await cx.ws.writeText("verify/visual.md", visualTable(rows, threshold, tol));
  // no shot compared (every page missing / no baseline): the gates did not run
  const compared = rows.some((r) => typeof r.parity === "number");
  if (!compared) issues.push(notRunIssue("visual", `0 of ${rows.length} shots compared`));
  return finish(cx, "visual", {
    gates: {
      parity: compared ? { pass: failing === 0, value: round(minParity), threshold } : notRun(threshold),
      bbox: bboxGate,
      height: { pass: maxHeight <= heightTol, value: maxHeight, threshold: heightTol },
    },
    stats: { shots: rows.length, failing, minParity: round(minParity), viewports: viewports.length, maxHeightDelta: maxHeight, baseline: policy, scoped, measured: rows.filter((r) => !r.carried).length },
    issues,
    details: { results: rows, scope, scores: Object.fromEntries(rows.map((r) => [`${r.path} @ ${r.viewport}`, r.parity ?? 0])), mask: cx.mask, blockedHosts: [...blocked] },
  });
}

/** Markdown gate table per URL × viewport (verify/visual.md). */
export function visualTable(rows: Array<Record<string, unknown>>, threshold: number, tol: number): string {
  const lines = [
    `| URL | viewport | parity (≥ ${threshold}) | bbox Δ (≤ ${tol}px) | height old → new (Δ) | pass | top diff regions |`,
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const bb = r.bbox as { maxDelta: number | string } | undefined;
    const h = r.height as { old: number; new: number; delta: number } | undefined;
    const regions = (r.regions as AttributedRegion[] | undefined) ?? [];
    lines.push(
      `| ${r.path} | ${r.viewport} | ${r.parity ?? "—"} ${r.parityPass ? "✓" : "✗"} | ${bb?.maxDelta ?? "—"} ${r.bboxPass ? "✓" : "✗"} | ${h ? `${h.old} → ${h.new} (${h.delta >= 0 ? "+" : ""}${h.delta})` : "—"} ${r.heightPass ? "✓" : "✗"} | ${r.pass ? "**pass**" : "**FAIL**"} | ${regions
        .slice(0, 2)
        .map((x) => `\`${x.component}\` y${x.y} ${Math.round(x.share * 100)}%`)
        .join("; ")
        .replace(/\|/g, "\\|")} |`,
    );
  }
  return lines.join("\n") + "\n";
}
