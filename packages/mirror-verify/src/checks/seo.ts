import type { Issue } from "@harness/mirror-core";
import { extractSeo, type SeoData } from "../html.js";
import type { CheckResult, VerifyContext } from "../types.js";
import { finish, mapLimit, notRun, notRunIssue } from "./util.js";

export interface SeoDiff {
  path: string;
  field: string;
  old: string | undefined;
  new: string | undefined;
}

function flatten(d: SeoData): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {
    lang: d.lang,
    title: d.title,
    description: d.description,
    canonical: d.canonical,
    robots: d.robots,
    hreflang: d.hreflang.length ? d.hreflang.join("\n") : undefined,
    jsonLd: d.jsonLd.length ? d.jsonLd.join("\n") : undefined,
  };
  for (const [k, v] of Object.entries(d.og)) out[k] = v;
  for (const [k, v] of Object.entries(d.twitter)) out[k] = v;
  for (const [k, v] of Object.entries(d.meta ?? {})) out[k.includes(":") ? k : `meta:${k}`] = v;
  return out;
}

export function diffSeo(path: string, o: SeoData, n: SeoData): SeoDiff[] {
  const a = flatten(o);
  const b = flatten(n);
  const diffs: SeoDiff[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if ((a[k] ?? undefined) === (b[k] ?? undefined)) continue;
    if (k === "jsonLd") {
      // report JSON-LD per node, so the finding names the @type that differs
      const os = new Set((a[k] ?? "").split("\n").filter(Boolean));
      const ns = new Set((b[k] ?? "").split("\n").filter(Boolean));
      const typeOf = (j: string) => /"@type":("[^"]*"|\[[^\]]*\])/.exec(j)?.[1] ?? "?";
      const gone = [...os].filter((x) => !ns.has(x));
      const added = [...ns].filter((x) => !os.has(x));
      const types = [...new Set([...gone, ...added].map(typeOf))];
      for (const t of types)
        diffs.push({ path, field: `jsonLd[${t}]`, old: gone.filter((x) => typeOf(x) === t).join("\n") || undefined, new: added.filter((x) => typeOf(x) === t).join("\n") || undefined });
      continue;
    }
    diffs.push({ path, field: k, old: a[k], new: b[k] });
  }
  if (n.jsonLdErrors > o.jsonLdErrors) diffs.push({ path, field: "jsonLd.parseErrors", old: String(o.jsonLdErrors), new: String(n.jsonLdErrors) });
  return diffs;
}

const clip = (s: string | undefined, n = 240) => (s && s.length > n ? `${s.slice(0, n)}…` : String(s));

/** title/description/canonical/robots/og/twitter/hreflang/JSON-LD parity, old vs new. */
export async function seoParity(cx: VerifyContext): Promise<CheckResult> {
  const issues: Issue[] = [];
  const rows = await mapLimit(cx.allPaths, 6, async (path) => {
    const [op, np] = await Promise.all([cx.fetchPage("old", path), cx.fetchPage("new", path)]);
    if (op.status !== 200 || np.status !== 200) return { path, skipped: true, diffs: [] as SeoDiff[] };
    const o = extractSeo(op.html, cx.hostNormalize, cx.normalizeText);
    const n = extractSeo(np.html, cx.hostNormalize, cx.normalizeText);
    return { path, skipped: false, diffs: diffSeo(path, o, n), old: o, new: n };
  });
  const diffs = rows.flatMap((r) => r.diffs);
  for (const d of diffs)
    issues.push({ severity: "error", code: "SEO_DIFF", message: `${d.path} ${d.field}: ${clip(JSON.stringify(d.old))} → ${clip(JSON.stringify(d.new))}`, ref: d.path, actionable: true });
  for (const r of rows) if (r.skipped) issues.push({ severity: "warning", code: "SEO_SKIPPED", message: `${r.path}: not compared (page missing on one side)`, ref: r.path });
  const compared = rows.filter((r) => !r.skipped).length;
  if (!compared) issues.push(notRunIssue("seo", `0 of ${rows.length} pages answered 200 on both sides`));
  return finish(cx, "seo", {
    gates: { diffs: compared ? { pass: diffs.length === 0, value: diffs.length, threshold: 0 } : notRun(0) },
    stats: { pages: rows.length, compared: rows.filter((r) => !r.skipped).length, diffs: diffs.length },
    issues,
    details: { diffs, pages: rows },
  });
}
