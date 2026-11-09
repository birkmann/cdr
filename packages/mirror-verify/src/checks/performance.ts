import { launchChromium } from "@harness/mirror-core";
import type { Issue } from "@harness/mirror-core";
import type { CheckResult, VerifyContext } from "../types.js";
import { finish, round } from "./util.js";

type LighthouseFn = (url: string, flags: Record<string, unknown>) => Promise<{ lhr: { categories: { performance?: { score: number | null } } } } | undefined>;

async function loadLighthouse(): Promise<LighthouseFn | undefined> {
  try {
    const name = "lighthouse"; // not a declared dependency: optional
    const mod = (await import(name)) as { default?: LighthouseFn };
    return mod.default;
  } catch {
    return undefined;
  }
}

/** Optional Lighthouse performance comparison; skipped gracefully when lighthouse is not installed. */
export async function performance(cx: VerifyContext): Promise<CheckResult> {
  const lighthouse = await loadLighthouse();
  if (!lighthouse)
    return finish(cx, "performance", {
      gates: { score: { pass: true, value: "skipped" } },
      stats: { skipped: true },
      issues: [{ severity: "info", code: "LIGHTHOUSE_MISSING", message: "lighthouse not installed — performance check skipped" }],
    });
  const port = 9300 + Math.floor(Math.random() * 500);
  const browser = await launchChromium({ args: [`--remote-debugging-port=${port}`] });
  const issues: Issue[] = [];
  const rows: Array<{ path: string; old?: number; new?: number }> = [];
  try {
    for (const path of cx.urls) {
      const score = async (url: string) => (await lighthouse(url, { port, output: "json", onlyCategories: ["performance"], logLevel: "error" }))?.lhr.categories.performance?.score ?? undefined;
      const o = await score(cx.oldBaseUrl + path).catch(() => undefined);
      const n = await score(cx.newBaseUrl + path).catch(() => undefined);
      rows.push({ path, old: o ?? undefined, new: n ?? undefined });
      if (o != null && n != null && n < o - 0.05)
        issues.push({ severity: "warning", code: "PERF_REGRESSION", message: `${path}: performance ${round(o, 2)} → ${round(n, 2)}`, ref: path });
    }
  } finally {
    await browser.close();
  }
  const regressions = issues.length;
  return finish(cx, "performance", {
    gates: { score: { pass: regressions === 0, value: regressions, threshold: 0 } },
    stats: { skipped: false, pages: rows.length, regressions },
    issues,
    details: { pages: rows },
  });
}
