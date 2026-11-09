// replica (plan §2.4): the page rebuilt in Next.js from the design system's composites, on a free port, without provider
// keys in its environment, with primitives kept only where the section's parity holds (the swap contract).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_VIEWPORTS, launchChromium } from "@harness/mirror-core";
import { AppServer } from "@harness/mirror-fix";
import { loadForCaptureInfo, newCaptureContext } from "@harness/mirror-verify";
import { RunDir } from "@harness/recreate";
import { runCommand, scrubbedEnv } from "../ds-build.js";
import {
  copyDsPackages,
  ensureReplicaDeps,
  nextBinOf,
  replicaNames,
  writeReplicaApp,
  type ReplicaNames,
} from "../replica-app.js";
import { probeOnLoadOverlays } from "../replica-overlays.js";
import {
  decideSwaps,
  measureSectionParity,
  revertIssues,
  swapsSource,
  type ParityMeasure,
  type SectionBand,
} from "../swap.js";
import type { Gate, StageContext, StageIssue, StageRunner, StageSummary } from "../types.js";

const SWAP_ROUNDS = 3;
const SECTION_GATE = 0.97;

export interface ReplicaStageOptions {
  /** Replaces the build and the measurement (tests): gives the parity of a swap round. */
  buildAndMeasure?: (ctx: StageContext, enabled: string[], round: number) => Promise<ParityMeasure>;
}

/** The candidates' names in the workspace and whether a real rebuild happened. */
export function swapCandidates(dsDir: string): string[] {
  const src = readFileSync(join(dsDir, "packages/site/src/swaps.ts"), "utf8");
  const json = /SWAPS: Record<string, boolean> = (\{[^\n]*\})/.exec(src)?.[1] ?? "{}";
  return Object.keys(JSON.parse(json) as Record<string, boolean>);
}

export function createReplicaStage(options: ReplicaStageOptions = {}): StageRunner {
  return {
    name: "replica",
    async run(ctx: StageContext): Promise<StageSummary> {
      const startedAt = Date.now();
      const gates: Gate[] = [];
      const issues: StageIssue[] = [];
      const done = (status: StageSummary["status"], artifacts: Record<string, string>): StageSummary => ({
        stage: "replica",
        site: ctx.site.id,
        status,
        wallClockMs: Date.now() - startedAt,
        gates,
        issues,
        artifacts,
      });
      const ds = ctx.previous["design-system"];
      const dsDir = ds?.artifacts.designSystem;
      const runDir = ds?.artifacts.runDir;
      if (!dsDir || !runDir || !existsSync(join(dsDir, "packages/site/package.json"))) {
        issues.push({
          code: "STAGE_FAILED",
          cause: "no-design-system",
          message: "the design-system stage has not produced a workspace with its composites",
          severity: "error",
        });
        return done("failed", {});
      }
      const oldUrl = ctx.snapshot?.replayUrl;
      if (!oldUrl) {
        issues.push({
          code: "STAGE_FAILED",
          cause: "no-snapshot",
          message: "no snapshot to rebuild against",
          severity: "error",
        });
        return done("failed", {});
      }
      const env = scrubbedEnv();
      const appDir = join(ctx.stageDir, "out", "replica");
      const report = JSON.parse(readFileSync(join(dsDir, "design-system/report.json"), "utf8")) as {
        name: string;
        prefix: string;
      };
      const names: ReplicaNames = replicaNames(dsDir);
      const log = ctx.log;
      const run = new RunDir(ctx.projectDir, runDir.split("/").pop() ?? "");
      const sections = run.readJson<SectionBand[]>("scene/sections.json");
      const candidates = swapCandidates(dsDir);
      let enabled = [...candidates];
      const pageTsx = pageOfWorkspace(dsDir);
      const facts = pageFacts(run);
      const viewports = viewportsOf(ctx);
      const capture = {
        allowHosts: [new URL(oldUrl).host, new URL(oldUrl).hostname, "127.0.0.1"],
        allowThirdParty: false,
      };
      const browser = options.buildAndMeasure ? null : await launchChromium({ headless: true });
      const variants = (run.manifest().variants ?? []).slice().sort((a, b) => a.minWidth - b.minWidth);
      const overlays = browser
        ? await probeOnLoadOverlays({
            browser,
            url: oldUrl,
            viewports,
            capture,
            minWidthOf: (w) => variants.filter((v) => v.minWidth <= w).pop()?.minWidth ?? 0,
          })
        : [];
      if (browser) await copyPageMedia(browser, oldUrl, viewports, capture, join(appDir, "public"), log);
      if (overlays.length) log(`${overlays.length} on-load dialog(s) of the page kept`);
      const widest = viewports.reduce((a, b) => (b.width > a.width ? b : a), viewports[0]!);
      writeReplicaApp({
        appDir,
        dsDir,
        names,
        pageTsx,
        overlays,
        pagePath: new URL(oldUrl).pathname,
        serverWidth: widest.width,
        title: facts.title || report.name,
        lang: facts.lang || "en",
        depsCache: join(ctx.paths.state, "replica-deps"),
        env,
        log,
      });
      if (!options.buildAndMeasure)
        await ensureReplicaDeps({ appDir, depsCache: join(ctx.paths.state, "replica-deps"), env, log });
      const port = await ctx.ports.acquire();
      const server = new AppServer({
        appDir,
        port,
        baseEnv: env,
        env: {},
        buildCmd: [process.execPath, [nextBinOf(appDir), "build"]],
        startCmd: (p) => [
          process.execPath,
          [nextBinOf(appDir), "start", "--hostname", "127.0.0.1", "-p", String(p)],
        ],
        onLog: (l) => log(l.trimEnd()),
      });
      const newUrl = `http://127.0.0.1:${port}/`;
      const swapDir = join(ctx.stageDir, "swaps");
      let measure: ParityMeasure | undefined;
      let appbuild = true;
      try {
        const buildSite = async () => {
          writeFileSync(join(dsDir, "packages/site/src/swaps.ts"), swapsSource(enabled, candidates));
          const r = await runCommand(
            "npm",
            ["run", "build", "-w", "packages/site"],
            dsDir,
            env,
            300_000,
            ctx.signal,
          );
          if (r.code !== 0) throw new Error(`site build failed: ${r.output.slice(-400)}`);
          copyDsPackages({ appDir, dsDir, names });
        };
        const app = async () => {
          const build = await server.build();
          if (!build.ok) {
            appbuild = false;
            issues.push({
              code: "BUILD_FAILED",
              cause: "next",
              message: `next build failed: ${build.output.slice(-400)}`,
              severity: "error",
              evidence: [appDir],
            });
            return false;
          }
          await server.restart();
          return true;
        };
        for (let round = 1; round <= SWAP_ROUNDS; round++) {
          if (ctx.signal.aborted) break;
          if (options.buildAndMeasure) measure = await options.buildAndMeasure(ctx, enabled, round);
          else {
            await buildSite();
            if (!(await app())) break;
            measure = await measureSectionParity({
              browser: browser!,
              oldUrl,
              newUrl,
              viewports,
              sections,
              capture,
              outDir: swapDir,
              log,
            });
          }
          const decision = decideSwaps({
            enabled,
            usage: measure.usage,
            sections: measure.sections,
            sets: measure.sets,
            gate: SECTION_GATE,
          });
          log(`swap round ${round}: ${enabled.length} swapped, ${decision.revert.length} reverted`);
          issues.push(...revertIssues(decision, measure.crops));
          if (!decision.revert.length) break;
          enabled = decision.keep;
          if (round === SWAP_ROUNDS && !options.buildAndMeasure) {
            await buildSite();
            await app();
          }
        }
      } finally {
        await server.stop();
        await browser?.close().catch(() => undefined);
        ctx.ports.release(port);
      }
      gates.push({ id: "appbuild", pass: appbuild, hard: true, value: appbuild });
      writeFileSync(
        join(ctx.stageDir, "swaps.json"),
        `${JSON.stringify({ candidates, kept: enabled, parity: measure?.sections, sets: measure?.sets }, null, 2)}\n`,
      );
      return done(appbuild ? "passed" : "failed", {
        replicaApp: appDir,
        designSystem: dsDir,
        runDir,
      });
    },
  };
}

export function viewportsOf(
  ctx: Pick<StageContext, "site">,
): { name: string; width: number; height: number }[] {
  const named: Record<string, { name: string; width: number; height: number }> = Object.fromEntries(
    DEFAULT_VIEWPORTS.map((v) => [v.name, v]),
  );
  return ctx.site.viewports?.length
    ? ctx.site.viewports.map((n) => named[n] ?? named.desktop!)
    : DEFAULT_VIEWPORTS.map((v) => v);
}

const MEDIA_URLS_JS = `(() => {
  const out = new Set();
  const add = (u) => { try { out.add(new URL(u, location.href).href); } catch (e) {} };
  for (const i of document.images) if (i.getAttribute('src')) add(i.getAttribute('src'));
  for (const s of document.querySelectorAll('source[srcset], img[srcset]'))
    for (const part of s.getAttribute('srcset').split(',')) { const u = part.trim().split(/\\s+/)[0]; if (u) add(u); }
  return [...out];
})()`;

/**
 * The page's images stay reachable under their original paths too (the composites use their own copies): links to them
 * and the content model's assets keep working, as on the original.
 */
/** File systems refuse a path segment over 255 bytes; media CDNs put whole signed tokens in one. */
export function fitsFileSystem(path: string): boolean {
  return path.split("/").every((segment) => Buffer.byteLength(segment) <= 255);
}

async function copyPageMedia(
  browser: Awaited<ReturnType<typeof launchChromium>>,
  url: string,
  viewports: { name: string; width: number; height: number }[],
  capture: Parameters<typeof newCaptureContext>[2],
  publicDir: string,
  log: (l: string) => void,
): Promise<void> {
  const origin = new URL(url).origin;
  const urls = new Set<string>();
  for (const vp of viewports) {
    const ctx = await newCaptureContext(browser, vp, capture);
    try {
      const page = await ctx.newPage();
      await loadForCaptureInfo(page, url, vp);
      for (const u of (await page.evaluate(MEDIA_URLS_JS)) as string[]) urls.add(u);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
  let copied = 0;
  for (const u of urls) {
    if (new URL(u).origin !== origin) continue;
    const path = decodeURIComponent(new URL(u).pathname).replace(/^\/+/, "");
    if (!path || path.split("/").includes("..")) continue;
    if (!fitsFileSystem(path)) {
      log(`not kept, the path is too long for a file name: ${path.slice(0, 120)}…`);
      continue;
    }
    const res = await fetch(u).catch(() => null);
    if (!res?.ok) continue;
    const file = join(publicDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    copied++;
  }
  log(`${copied} image(s) of the page kept at their original paths`);
}

/** The page the design-system stage generated next to the composites. */
function pageOfWorkspace(dsDir: string): string {
  const pages = JSON.parse(readFileSync(join(dsDir, "design-system/pages.json"), "utf8")) as Record<
    string,
    string
  >;
  const page = Object.values(pages)[0];
  if (!page) throw new Error(`no page source in ${dsDir}`);
  return page;
}

/** The title and language of the widest capture. */
function pageFacts(run: RunDir): { title?: string; lang?: string } {
  const widths = (run.manifest().variants ?? []).map((v) => v.width).sort((a, b) => b - a);
  const file = widths[0] !== undefined ? `capture/${widths[0]}.snapshot.json` : undefined;
  return file && run.exists(file) ? run.readJson<{ title?: string; lang?: string }>(file) : {};
}

export const replicaStage: StageRunner = createReplicaStage();
