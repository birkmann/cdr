import type { Issue, RichBlock } from "@harness/mirror-core";
import { mainText } from "../html.js";
import { textSimilarity } from "../text.js";
import type { CheckResult, VerifyContext } from "../types.js";
import { finish, mapLimit, notRun, notRunIssue, round } from "./util.js";

/** one diff window in words: replaced, missing on the new page, or extra on the new page (never `"" → "…"`) */
export function describeDiff(d: { old: string; new: string; at: number }): string {
  const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
  if (!d.old) return `extra on new page at word ${d.at}: "${clip(d.new)}"`;
  if (!d.new) return `missing on new page at word ${d.at}: "${clip(d.old)}"`;
  return `"${clip(d.old)}" → "${clip(d.new)}" at word ${d.at}`;
}

/** Normalised main-content text diff old vs new per routable page. */
export async function richTextFidelity(cx: VerifyContext): Promise<CheckResult> {
  const threshold = cx.site.parity.textSimilarity;
  const issues: Issue[] = [];
  if (cx.renderedOldPaths.length)
    issues.push({
      severity: "info",
      code: "OLD_RENDERED_DOM",
      message: `${cx.renderedOldPaths.length} page(s) compared against the browser-rendered original (content was taken from the rendered DOM, CONTENT_FROM_RENDERED_DOM): ${cx.renderedOldPaths.slice(0, 6).join(", ")}${cx.renderedOldPaths.length > 6 ? ", …" : ""}`,
    });
  const rows = await mapLimit(cx.allPaths, 6, async (path) => {
    const [op, np] = await Promise.all([cx.fetchPage("old", path), cx.fetchPage("new", path)]);
    if (op.status !== 200 || np.status !== 200) return { path, skipped: true, oldStatus: op.status, newStatus: np.status };
    const o0 = mainText(op.html, cx.mask);
    const n0 = mainText(np.html, cx.mask);
    const ot = cx.normalizeText(o0.text);
    const nt = cx.normalizeText(n0.text);
    const o = { ...o0, words: ot.split(/\s+/).filter(Boolean).length };
    const n = { ...n0, words: nt.split(/\s+/).filter(Boolean).length };
    let r = textSimilarity(ot, nt);
    let pass = r.similarity >= threshold;
    // the live original moved on since the crawl (news, disruption tickers): when the new page matches the text the
    // pipeline was given (crawl-time capture), the difference is source drift, not a migration defect
    let baseline: "live" | "crawl" = "live";
    let liveSimilarity: number | undefined;
    const crawled = pass ? undefined : cx.crawlPage(path);
    if (crawled) {
      const ct = cx.normalizeText(mainText(await crawled.contentHtml().catch(() => ""), cx.mask).text);
      const rc = ct ? textSimilarity(ct, nt) : undefined;
      if (rc && rc.similarity >= threshold) {
        liveSimilarity = round(r.similarity);
        issues.push({
          severity: "warning",
          code: "SOURCE_DRIFT",
          message: `${path}: main text differs from the live original (similarity ${round(r.similarity)}) but matches the crawl-time capture (${round(rc.similarity)}): the source changed since the crawl` + (r.diffs[0] ? ` (e.g. ${describeDiff(r.diffs[0])})` : ""),
          ref: path,
        });
        r = rc;
        pass = true;
        baseline = "crawl";
      }
    }
    if (!pass)
      issues.push({
        severity: "error",
        code: "TEXT_DIFF",
        message: `${path}: main text similarity ${round(r.similarity)} < ${threshold} (old ${o.words} / new ${n.words} words)` + (r.diffs[0] ? ` (e.g. ${describeDiff(r.diffs[0])})` : ""),
        ref: path,
        actionable: true,
      });
    return { path, skipped: false, similarity: round(r.similarity), pass, method: r.method, baseline, ...(liveSimilarity !== undefined ? { liveSimilarity } : {}), selectors: { old: o.selector, new: n.selector }, diffs: r.diffs };
  });
  const compared = rows.filter((r) => !r.skipped) as Array<{ path: string; similarity: number; pass: boolean }>;
  const min = compared.length ? Math.min(...compared.map((r) => r.similarity)) : 1;
  const failing = compared.filter((r) => !r.pass).length;
  for (const r of rows) if (r.skipped) issues.push({ severity: "warning", code: "TEXT_SKIPPED", message: `${r.path}: not compared (old ${r.oldStatus}, new ${r.newStatus})`, ref: r.path });
  if (!compared.length) issues.push(notRunIssue("fidelity", `0 of ${rows.length} pages answered 200 on both sides`));
  return finish(cx, "fidelity", {
    gates: { similarity: compared.length ? { pass: failing === 0, value: round(min), threshold } : notRun(threshold) },
    stats: { pages: rows.length, compared: compared.length, failing, minSimilarity: round(min) },
    issues,
    details: { pages: rows },
  });
}

function countBlocks(blocks: RichBlock[], acc: { total: number; raw: number }) {
  for (const b of blocks) {
    acc.total++;
    if (b.type === "rawHtml") acc.raw++;
    else if (b.type === "blockquote") countBlocks(b.children, acc);
    else if (b.type === "list") for (const li of b.children) countBlocks(li.children, acc);
  }
}

function walkDocs(v: unknown, f: (blocks: RichBlock[]) => void) {
  if (!v || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) walkDocs(x, f);
    return;
  }
  const o = v as Record<string, unknown>;
  if (o.type === "doc" && Array.isArray(o.children)) {
    f(o.children as RichBlock[]);
    return;
  }
  for (const x of Object.values(o)) walkDocs(x, f);
}

/** Share of rich-text block nodes that fell back to rawHtml (CCM only). */
export async function richTextCleanliness(cx: VerifyContext): Promise<CheckResult> {
  const threshold = Number(cx.options.rawHtmlThreshold ?? 0.05);
  const total = { total: 0, raw: 0 };
  const perEntry: Array<{ ccmId: string; locale: string; total: number; raw: number }> = [];
  for (const e of cx.ccm.entries) {
    const acc = { total: 0, raw: 0 };
    walkDocs(e.fields, (b) => countBlocks(b, acc));
    if (!acc.total) continue;
    total.total += acc.total;
    total.raw += acc.raw;
    if (acc.raw) perEntry.push({ ccmId: e.ccmId, locale: e.locale, ...acc });
  }
  const share = total.total ? total.raw / total.total : 0;
  const pass = share < threshold;
  const issues: Issue[] = pass
    ? []
    : [{ severity: "warning", code: "RAWHTML_SHARE", message: `rawHtml share ${round(share)} ≥ ${threshold}: decide on an HTML field or improve the transform`, actionable: true }];
  return finish(cx, "cleanliness", {
    gates: { rawHtmlShare: { pass, value: round(share), threshold } },
    stats: { blocks: total.total, rawHtml: total.raw, share: round(share) },
    issues,
    details: { entriesWithRawHtml: perEntry },
  });
}
