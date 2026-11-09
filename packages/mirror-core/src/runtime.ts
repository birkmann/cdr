/**
 * What one mirror run provides to the code below it, without threading it through every call: the network guard (the
 * crawl and verify only reach public addresses and the run's own app) and the Chrome to fall back on.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, LaunchOptions } from "playwright";

export type RequestGuard = (url: URL) => boolean | Promise<boolean>;

export interface RunScope {
  guard?: RequestGuard;
  /** used when Playwright has no Chromium of its own */
  chromePath?: string;
}

const scope = new AsyncLocalStorage<RunScope>();

export const withRunScope = <T>(s: RunScope, fn: () => Promise<T>): Promise<T> => scope.run(s, fn);

const MAX_REDIRECTS = 10;

/** `fetch` under the run's guard. Redirects are followed hop by hop so that each target is checked. */
export async function guardedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const guard = scope.getStore()?.guard;
  if (!guard) return fetch(input, init);
  let url = new URL(String(input));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await guard(url))) throw new Error(`request to ${url.host} refused: not a public address`);
    const res = await fetch(url, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (init.redirect === "manual" || res.status < 300 || res.status >= 400 || !location) return res;
    await res.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error(`too many redirects from ${String(input)}`);
}

/** Must be registered after a context's other routes: Playwright asks the newest route first. */
export async function guardContext(ctx: BrowserContext): Promise<void> {
  const guard = scope.getStore()?.guard;
  if (!guard) return;
  await ctx.route(
    (u) => u.protocol === "http:" || u.protocol === "https:",
    async (route) => {
      const allowed = await Promise.resolve(guard(new URL(route.request().url()))).catch(() => false);
      await (allowed ? route.fallback() : route.abort("blockedbyclient")).catch(() => undefined);
    },
  );
}

export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  const { chromium } = await import("playwright");
  const chrome = scope.getStore()?.chromePath;
  try {
    return await chromium.launch(options);
  } catch (e) {
    if (chrome && /Executable doesn't exist/i.test((e as Error).message)) return chromium.launch({ ...options, executablePath: chrome });
    throw e;
  }
}

/** First of `candidates` (relative to `base`) that exists: asset folders sit next to the compiled code or the single-file bundle. */
export function firstExistingPath(base: string, candidates: string[]): string {
  const paths = candidates.map((c) => fileURLToPath(new URL(c, base)));
  return paths.find((p) => existsSync(p)) ?? paths[0];
}
