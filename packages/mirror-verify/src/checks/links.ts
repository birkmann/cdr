import type { Issue } from "@harness/mirror-core";
import { getPage, isSkippableHref, normPath } from "../context.js";
import { extractHrefs } from "../html.js";
import type { CheckResult, PageResult, VerifyContext } from "../types.js";
import { finish, mapLimit, notRun, notRunIssue } from "./util.js";
import { expectedRedirects } from "./redirects.js";

/** Internal link paths of a page (host-normalised, hash stripped, trailing slash normalised). */
export function internalLinkPaths(cx: VerifyContext, html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  const base = new URL(pageUrl);
  for (const href of extractHrefs(html)) {
    if (isSkippableHref(href)) continue;
    let u: URL;
    try {
      u = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    const norm = cx.hostNormalize(u.toString(), u.host === base.host);
    if (u.host === base.host || norm.startsWith("/")) out.add(normPath(norm));
  }
  return [...out].sort();
}

/** Path of an absolute URL on the new origin (normPath). */
function pathOfUrl(u: string): string {
  const x = new URL(u);
  return normPath(x.pathname + x.search);
}

/** Static resources are not "pages" (they are checked by the media check). */
const RESOURCE_RE = /\.(png|jpe?g|gif|svg|webp|avif|pdf|zip|docx?|xlsx?|pptx?|mp4|webm|mp3|css|js|ico|xml|txt|json|woff2?)$/i;

/**
 * Crawl the new site; every internal link must end in a 200 — except links to **out-of-scope** pages: internal
 * pages that are neither POC urls nor routable CCM entries, that the original page links in exactly the same form.
 * Those are reported (OUT_OF_SCOPE_LINK, info) but not fetched as failures; their URL structure is still checked
 * (same path on old and new page, no link to the replay/old host, no localhost leak). Link sets per page must match
 * the old site (LINK_STRUCTURE).
 */
export async function linkCheck(cx: VerifyContext): Promise<CheckResult> {
  const issues: Issue[] = [];
  const crawl = await cx.crawlNew();
  const scope = new Set(cx.allPaths);
  if (cx.stubPaths.length)
    issues.push({ severity: "info", code: "STUB_PAGES", message: `${cx.stubPaths.length} teaser-stub page(s) (title only, from listings) are link targets, not page-parity scope: ${cx.stubPaths.join(", ")}` });

  // redirects known to the pipeline (/node/<nid>, CCM redirects) count as their final target on both sides
  const rmap = new Map(expectedRedirects(cx).map((r) => [r.from, r.to]));
  const canon = (p: string) => {
    let cur = p;
    for (let i = 0; i < 10 && rmap.has(cur); i++) cur = rmap.get(cur)!;
    return cur;
  };

  // old link sets per page (host-normalised), for URL structure + out-of-scope classification
  const oldLinks = new Map<string, Set<string>>();
  // links the original had when it was crawled (the pipeline's input): a link the new page has and the live original
  // no longer shows is source drift (news teaser rotated out, disruption resolved), not a migration defect
  const crawlLinks = (path: string) => new Set((cx.crawlPage(path)?.links ?? []).map(canon));
  const structure = await mapLimit(cx.allPaths, 6, async (path) => {
    const [op, np] = await Promise.all([cx.fetchPage("old", path), cx.fetchPage("new", path)]);
    if (op.status === 200) oldLinks.set(path, new Set(internalLinkPaths(cx, op.html, op.finalUrl).map(canon)));
    if (op.status !== 200 || np.status !== 200) return { path, skipped: true, missing: [] as string[], extra: [] as string[], drifted: [] as string[] };
    const o = oldLinks.get(path)!;
    const n = new Set(internalLinkPaths(cx, np.html, np.finalUrl).map(canon));
    const cl = crawlLinks(path);
    const extraAll = [...n].filter((x) => !o.has(x));
    return { path, skipped: false, missing: [...o].filter((x) => !n.has(x)), extra: extraAll.filter((x) => !cl.has(x)), drifted: extraAll.filter((x) => cl.has(x)) };
  });
  const drifted = structure.filter((s) => s.drifted.length);
  if (drifted.length)
    issues.push({
      severity: "warning",
      code: "SOURCE_DRIFT",
      message: `${drifted.reduce((n, s) => n + s.drifted.length, 0)} link(s) the original had when it was crawled are not on the live page any more (source changed since the crawl; the new site matches the crawl): ${drifted
        .map((s) => `${s.path} → ${s.drifted.slice(0, 4).join(", ")}${s.drifted.length > 4 ? ", …" : ""}`)
        .join("; ")}`,
    });

  const targets = new Map<string, string[]>(); // url -> pages linking it
  for (const [page, links] of crawl.links) for (const l of links) targets.set(l, [...(targets.get(l) ?? []), page]);
  const known = new Map<string, PageResult>();
  for (const p of crawl.pages) known.set(p.page.url, p.page);

  const outOfScope = (url: string, from: string[]): boolean => {
    const p = canon(pathOfUrl(url));
    if (scope.has(p) || RESOURCE_RE.test(new URL(url).pathname)) return false;
    // the original links it identically from (one of) the same pages — live now, or when it was crawled → a page
    // outside the POC, not a migration bug
    return from.some((f) => oldLinks.get(f)?.has(p) || crawlLinks(f).has(p));
  };

  const results = await mapLimit([...targets.keys()].sort(), 8, async (url) => {
    const from = targets.get(url)!;
    const r = known.get(url) ?? (await getPage(url));
    const oos = r.status !== 200 && outOfScope(url, from);
    // also missing on the original (replay) and linked there identically → capture gap / dead link on the original
    let oldStatus: number | undefined;
    if (r.status !== 200 && !oos && from.some((f) => oldLinks.get(f)?.has(canon(pathOfUrl(url))))) {
      const u = new URL(url);
      oldStatus = (await getPage(cx.oldBaseUrl + u.pathname + u.search)).status;
    }
    const notOnOriginal = oldStatus !== undefined && oldStatus !== 200;
    return { url, status: r.status, finalUrl: r.finalUrl, redirected: r.redirected, from, error: r.error, outOfScope: oos, oldStatus, notOnOriginal };
  });
  const notOnOriginal = results.filter((r) => r.notOnOriginal);
  if (notOnOriginal.length)
    issues.push({
      severity: "warning",
      code: "LINK_MISSING_ON_ORIGINAL",
      message: `${notOnOriginal.length} link(s) fail on the original replay too (not captured or dead on the source; re-capture to check them): ${notOnOriginal
        .slice(0, 6)
        .map((r) => `${new URL(r.url).pathname} (old ${r.oldStatus || "error"})`)
        .join(", ")}`,
    });
  const broken = results.filter((r) => r.status !== 200 && !r.outOfScope && !r.notOnOriginal);
  const skipped = results.filter((r) => r.outOfScope);
  const redirected = results.filter((r) => r.status === 200 && r.redirected);
  for (const b of broken)
    issues.push({ severity: "error", code: "BROKEN_LINK", message: `${new URL(b.url).pathname} → ${b.status || b.error} (linked from ${b.from.join(", ")})`, ref: b.url, actionable: true });
  if (skipped.length)
    issues.push({
      severity: "info",
      code: "OUT_OF_SCOPE_LINK",
      message: `${skipped.length} link(s) to internal pages outside the POC scope (same URL as on the original; not migrated yet): ${skipped
        .slice(0, 8)
        .map((r) => new URL(r.url).pathname)
        .join(", ")}${skipped.length > 8 ? ", …" : ""}`,
    });
  for (const r of redirected)
    issues.push({ severity: "info", code: "LINK_REDIRECTS", message: `${new URL(r.url).pathname} redirects to ${new URL(r.finalUrl).pathname}`, ref: r.url });
  for (const p of crawl.pages)
    if (p.page.status !== 200 && cx.allPaths.includes(p.path))
      issues.push({ severity: "error", code: "PAGE_UNREACHABLE", message: `${p.path} → ${p.page.status || p.page.error}`, ref: p.path, actionable: true });

  // URL form on the new pages: absolute links to the old (replay) host or another localhost port are leaks.
  // A live original IS the production origin (ibm.com, volkswagen.de: old base = site baseUrl = CMS baseUrl, not a
  // capture replay): an absolute link to one of its pages outside the migration scope is the production link, valid
  // in the preview and after cutover. Only links to migrated pages must stay on the new site (relative).
  const oldHost = new URL(cx.oldBaseUrl).host;
  const newHost = new URL(cx.newBaseUrl).host;
  const hostOf = (u: string | undefined) => {
    try {
      return u ? new URL(u).host : undefined;
    } catch {
      return undefined;
    }
  };
  const oldIsProduction =
    !cx.productionOrigin && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(oldHost) && hostOf(cx.site.baseUrl) === oldHost && (hostOf(cx.ccm.settings?.baseUrl) ?? oldHost) === oldHost;
  const productionLinks: Array<{ path: string; href: string }> = [];
  const leaks: Array<{ path: string; href: string }> = [];
  for (const p of crawl.pages) {
    if (p.page.status !== 200 || !p.page.html || !cx.allPaths.includes(p.path)) continue;
    for (const href of extractHrefs(p.page.html)) {
      if (isSkippableHref(href)) continue;
      let u: URL;
      try {
        u = new URL(href, p.page.finalUrl);
      } catch {
        continue;
      }
      const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
      if (u.host === newHost || !(u.host === oldHost || local)) continue;
      if (!local && oldIsProduction && !scope.has(canon(normPath(u.pathname + u.search)))) productionLinks.push({ path: p.path, href });
      else leaks.push({ path: p.path, href });
    }
  }
  if (productionLinks.length)
    issues.push({
      severity: "info",
      code: "LINK_TO_PRODUCTION",
      message: `${productionLinks.length} absolute link(s) to pages of the live original ${cx.oldBaseUrl} outside the migration scope (production links, kept as on the original): ${[...new Set(productionLinks.map((l) => new URL(l.href).pathname))].slice(0, 6).join(", ")}`,
    });
  for (const l of leaks.slice(0, 20))
    issues.push({ severity: "error", code: "LINK_HOST_LEAK", message: `${l.path}: link points to ${l.href} (old/replay or localhost host; must be relative or the production origin)`, ref: l.path, actionable: true });

  let structureDiffs = 0;
  for (const s of structure) {
    structureDiffs += s.missing.length + s.extra.length;
    if (s.missing.length || s.extra.length)
      issues.push({
        severity: "error",
        code: "LINK_STRUCTURE",
        message: `${s.path}: links differ from old page (missing: ${s.missing.join(", ") || "-"}; extra: ${s.extra.join(", ") || "-"})`,
        ref: s.path,
        actionable: true,
      });
  }
  const unreachable = crawl.pages.filter((p) => p.page.status !== 200 && cx.allPaths.includes(p.path)).length;
  const served = crawl.pages.filter((p) => p.page.status === 200 && cx.allPaths.includes(p.path)).length;
  if (!served) issues.push(notRunIssue("links", `none of the ${cx.allPaths.length} pages answered 200 on the new site — no links checked`));
  return finish(cx, "links", {
    gates: {
      broken: { pass: broken.length === 0 && unreachable === 0, value: broken.length + unreachable, threshold: 0 },
      structureDiffs: served ? { pass: structureDiffs === 0 && leaks.length === 0, value: structureDiffs + leaks.length, threshold: 0 } : notRun(0),
    },
    stats: { pagesCrawled: crawl.pages.length, linksChecked: results.length, broken: broken.length, outOfScope: skipped.length, missingOnOriginal: notOnOriginal.length, redirected: redirected.length, unreachable, structureDiffs, hostLeaks: leaks.length, productionLinks: productionLinks.length },
    issues,
    details: {
      broken,
      outOfScope: skipped.map((r) => ({ url: r.url, status: r.status, from: r.from })),
      missingOnOriginal: notOnOriginal.map((r) => ({ url: r.url, status: r.status, oldStatus: r.oldStatus, from: r.from })),
      redirected: redirected.map((r) => ({ url: r.url, finalUrl: r.finalUrl })),
      structure: structure.filter((s) => s.missing.length || s.extra.length),
      sourceDrift: drifted.map((s) => ({ path: s.path, links: s.drifted })),
      hostLeaks: leaks,
    },
  });
}
