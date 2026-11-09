/**
 * Browser pass over the replay: loads every page at every viewport, scrolls to trigger lazy loading,
 * and lets the replay server fill misses (fonts, CSS url()s, srcset candidates, JS-requested resources).
 *
 * Every request leaving the replay origin is intercepted: the original origin is mapped back onto the
 * replay, third-party hosts go through /__ext/<host>/ (so they are captured too), trackers are aborted.
 * Nothing is ever sent to the original origin or anywhere but the replay server.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchChromium } from "@harness/mirror-core";
import { isTrackerUrl } from "./rewrite.js";

export type CaptureBrowser = Awaited<ReturnType<typeof launchChromium>>;
export type CaptureContext = Awaited<ReturnType<CaptureBrowser["newContext"]>>;
export type CapturePage = Awaited<ReturnType<CaptureContext["newPage"]>>;
type Route = Parameters<Exclude<Parameters<CapturePage["route"]>[1], undefined>>[0];

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export interface BrowseOptions {
  replayUrl: string;
  origin: string;
  paths: string[];
  viewports: Viewport[];
  /** full-page screenshots into <dir>/<viewport>/<name>.png */
  screenshotDir?: string;
  browser?: CaptureBrowser;
  navigationTimeoutMs?: number;
  log?: { info(m: string): void; warn(m: string): void };
}

export interface PageResult {
  path: string;
  viewport: string;
  requests: number;
  failed: string[];
  status404: string[];
  external: string[];
  title?: string;
  height?: number;
  screenshot?: string;
}

export function shotName(path: string): string {
  const s = path.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return s.length ? s : "root";
}

const SCROLL_JS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let pass = 0; pass < 2; pass++) {
    let y = 0;
    for (let i = 0; i < 400; i++) {
      const h = Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
      if (y >= h) break;
      y += Math.max(200, Math.floor(window.innerHeight * 0.6));
      window.scrollTo(0, y);
      await sleep(120);
    }
    await sleep(400);
  }
  window.scrollTo(0, 0);
  await sleep(300);
  return Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
})()`;

async function routeExternal(route: Route, replay: URL, origin: URL): Promise<void> {
  const u = new URL(route.request().url());
  if (u.protocol === "data:" || u.protocol === "blob:") return route.continue();
  if (u.host === replay.host) return route.continue();
  if (isTrackerUrl(u.href)) return route.abort("blockedbyclient");
  const originHosts = new Set([origin.host, origin.host.replace(/^www\./, "")]);
  const target = originHosts.has(u.host)
    ? `${replay.origin}${u.pathname}${u.search}`
    : `${replay.origin}/__ext/${u.host}${u.pathname}${u.search}`;
  try {
    const resp = await route.fetch({ url: target, maxRedirects: 0 });
    await route.fulfill({ response: resp });
  } catch {
    await route.abort("failed").catch(() => undefined);
  }
}

export async function browsePages(o: BrowseOptions): Promise<PageResult[]> {
  const own = !o.browser;
  const browser = o.browser ?? (await launchChromium());
  const replay = new URL(o.replayUrl);
  const origin = new URL(o.origin);
  const results: PageResult[] = [];
  try {
    for (const vp of o.viewports) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        serviceWorkers: "block",
        colorScheme: "light",
        reducedMotion: "no-preference",
      });
      await ctx.route("**/*", (route) => routeExternal(route, replay, origin));
      for (const path of o.paths) {
        const page: CapturePage = await ctx.newPage();
        const r: PageResult = {
          path,
          viewport: vp.name,
          requests: 0,
          failed: [],
          status404: [],
          external: [],
        };
        page.on("request", (req) => {
          r.requests++;
          const u = new URL(req.url());
          if (u.host !== replay.host && u.protocol.startsWith("http")) r.external.push(req.url());
        });
        page.on("requestfailed", (req) =>
          r.failed.push(`${req.url()} (${req.failure()?.errorText ?? "failed"})`),
        );
        page.on("response", (resp) => {
          if (resp.status() === 404) r.status404.push(resp.url());
        });
        try {
          await page.goto(new URL(path, replay).href, {
            waitUntil: "load",
            timeout: o.navigationTimeoutMs ?? 900_000,
          });
          await page.waitForLoadState("networkidle", { timeout: 120_000 }).catch(() => undefined);
          r.height = (await page.evaluate(SCROLL_JS)) as number;
          await page.waitForLoadState("networkidle", { timeout: 120_000 }).catch(() => undefined);
          await page.evaluate(SCROLL_JS);
          await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
          r.title = await page.title();
          if (o.screenshotDir) {
            await mkdir(join(o.screenshotDir, vp.name), { recursive: true });
            r.screenshot = join(o.screenshotDir, vp.name, `${shotName(path)}.png`);
            await page.screenshot({ path: r.screenshot, fullPage: true, timeout: 120_000 });
          }
        } catch (e) {
          o.log?.warn(`browse ${path} @${vp.name}: ${(e as Error).message.split("\n")[0]}`);
          r.failed.push(`navigation: ${(e as Error).message.split("\n")[0]}`);
        }
        o.log?.info(
          `browsed ${path} @${vp.name}: ${r.requests} requests, ${r.status404.length} 404, ${r.failed.length} failed`,
        );
        results.push(r);
        await page.close();
      }
      await ctx.close();
    }
  } finally {
    if (own) await browser.close();
  }
  return results;
}
