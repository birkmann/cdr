import type { Issue } from "@harness/mirror-core";
import { localePrefix } from "../ccm.js";
import { fetchWithTimeout, getPage, normPath } from "../context.js";
import type { CheckResult, VerifyContext } from "../types.js";
import { finish, mapLimit } from "./util.js";

export interface ExpectedRedirect {
  from: string;
  to: string;
  status: number;
  origin: "ccm" | "node";
}

/** CCM redirect target → path ("internal:/node/2", "entity:node/2", absolute URLs on known hosts). */
function targetPath(cx: VerifyContext, to: string, locale?: string): string {
  let t = to.trim().replace(/^internal:/, "");
  const ent = /^entity:node\/(\d+)/.exec(t);
  if (ent) t = `/node/${ent[1]}`;
  t = cx.hostNormalize(t);
  if (!t.startsWith("/")) return t; // external
  const prefix = localePrefix(cx.ccm.locales, locale);
  if (prefix && /^\/node\/\d+/.test(t)) t = prefix + t;
  return normPath(t);
}

export function expectedRedirects(cx: VerifyContext): ExpectedRedirect[] {
  const out: ExpectedRedirect[] = [];
  const seen = new Set<string>();
  for (const r of cx.ccm.redirects) {
    const from = normPath(r.from);
    if (seen.has(from)) continue;
    seen.add(from);
    out.push({ from, to: targetPath(cx, r.to, r.locale), status: r.status ?? 301, origin: "ccm" });
  }
  for (const e of cx.ccm.entries) {
    if (e.source?.system !== "drupal" || e.source.kind !== "node" || !e.path || (e.status ?? "published") !== "published") continue;
    const from = `${localePrefix(cx.ccm.locales, e.locale)}/node/${e.source.id}`;
    if (seen.has(from)) continue;
    seen.add(from);
    out.push({ from, to: normPath(e.path), status: 301, origin: "node" });
  }
  return out;
}

/** Every CCM redirect + /node/<nid> must answer with the right status and Location. */
export async function redirects(cx: VerifyContext): Promise<CheckResult> {
  const expected = expectedRedirects(cx);
  const map = new Map(expected.map((r) => [r.from, r.to]));
  const finalOf = (p: string) => {
    let cur = p;
    for (let i = 0; i < 10 && map.has(cur); i++) cur = map.get(cur)!;
    return cur;
  };
  const issues: Issue[] = [];
  const rows = await mapLimit(expected, 8, async (r) => {
    const url = cx.newBaseUrl + r.from;
    let status = 0;
    let location = "";
    let error: string | undefined;
    try {
      const res = await fetchWithTimeout(url, { redirect: "manual" });
      status = res.status;
      location = res.headers.get("location") ?? "";
      await res.arrayBuffer().catch(() => undefined);
    } catch (e) {
      error = (e as Error).message;
    }
    const locPath = location ? cx.hostNormalize(new URL(location, url).toString()) : "";
    const final = finalOf(r.from);
    const locOk = !!locPath && (normPath(locPath) === r.to || normPath(locPath) === final || finalOf(normPath(locPath)) === final);
    let targetStatus: number | undefined;
    if (locOk && final.startsWith("/")) targetStatus = (await getPage(cx.newBaseUrl + final)).status;
    const pass = status === r.status && locOk && (targetStatus === undefined || targetStatus === 200);
    if (!pass)
      issues.push({
        severity: "error",
        code: "REDIRECT_WRONG",
        message: `${r.from}: expected ${r.status} → ${r.to}, got ${status || error}${location ? ` → ${locPath}` : ""}${targetStatus && targetStatus !== 200 ? ` (target ${targetStatus})` : ""}`,
        ref: r.from,
        actionable: true,
      });
    return { ...r, actual: { status, location: locPath, targetStatus, error }, pass };
  });
  const failed = rows.filter((r) => !r.pass).length;
  return finish(cx, "redirects", {
    gates: { failed: { pass: failed === 0, value: failed, threshold: 0 } },
    stats: { redirects: rows.length, fromCcm: rows.filter((r) => r.origin === "ccm").length, nodePaths: rows.filter((r) => r.origin === "node").length, failed },
    issues,
    details: { redirects: rows },
  });
}
