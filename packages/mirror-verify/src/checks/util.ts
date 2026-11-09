import type { Issue } from "@harness/mirror-core";
import type { CheckResult, GateResult, VerifyContext } from "../types.js";

export function finish(
  cx: VerifyContext,
  check: string,
  parts: { gates: Record<string, GateResult>; stats?: CheckResult["stats"]; issues?: Issue[]; details?: unknown },
): Promise<CheckResult> {
  const res: CheckResult = {
    check,
    ok: Object.values(parts.gates).every((g) => g.pass),
    stats: parts.stats ?? {},
    issues: parts.issues ?? [],
    gates: parts.gates,
    details: parts.details ?? {},
  };
  return cx.ws.writeJson(`verify/${check}.json`, res).then(() => res);
}

/**
 * Gate of a check that compared nothing (0 entries, every page skipped, no shot measured): never a pass.
 * `value: "not-run"` keeps the gate contract ({pass, value, threshold}); `pass: false` makes verify/summary.json `ok` false.
 */
export function notRun(threshold?: number | string): GateResult {
  return { pass: false, value: "not-run", ...(threshold !== undefined ? { threshold } : {}) };
}

/** CHECK_NOT_RUN issue (error → TASKS.md) for a gate that compared nothing */
export function notRunIssue(check: string, why: string): Issue {
  return { severity: "error", code: "CHECK_NOT_RUN", message: `${check}: nothing compared — ${why}`, ref: check, actionable: true };
}

export const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** Run fn over items with limited concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
