import type { Issue } from "@harness/mirror-core";
import { fetchWithTimeout } from "../context.js";
import { extractImageSrcs } from "../html.js";
import type { CheckResult, VerifyContext } from "../types.js";
import { finish, mapLimit } from "./util.js";

async function probe(url: string): Promise<{ status: number; contentType: string; error?: string }> {
  try {
    const res = await fetchWithTimeout(url, { redirect: "follow" });
    const contentType = res.headers.get("content-type") ?? "";
    await res.arrayBuffer();
    return { status: res.status, contentType };
  } catch (e) {
    return { status: 0, contentType: "", error: (e as Error).message };
  }
}

/** Every CCM asset is served under its original path; every <img> on crawled pages loads. */
export async function media(cx: VerifyContext): Promise<CheckResult> {
  const issues: Issue[] = [];
  /** the same path on the original (replay): a file missing there too is a capture gap, not a migration defect */
  const servedOnOld = async (pathAndQuery: string) => {
    const r = await probe(cx.oldBaseUrl + (pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`));
    return r.status === 200 && !/text\/html/i.test(r.contentType);
  };
  const assetRows = await mapLimit(cx.ccm.assets, 8, async (a) => {
    let path = a.originalPath;
    if (!path && /^https?:\/\//.test(a.src)) path = new URL(a.src).pathname;
    if (!path) {
      issues.push({ severity: "warning", code: "ASSET_NO_PUBLIC_PATH", message: `${a.ccmId} has no originalPath/public URL; not checked`, ref: a.ccmId });
      return { ccmId: a.ccmId, path: undefined, status: undefined, ok: true, skipped: true };
    }
    const url = cx.newBaseUrl + (path.startsWith("/") ? path : `/${path}`);
    const r = await probe(url);
    let ok = r.status === 200 && !/text\/html/i.test(r.contentType);
    let notOnOriginal = false;
    if (!ok) notOnOriginal = !(await servedOnOld(path));
    if (!ok && !notOnOriginal)
      issues.push({ severity: "error", code: "ASSET_MISSING", message: `${path} → ${r.status || r.error} ${r.contentType}`, ref: a.ccmId, actionable: true });
    if (notOnOriginal) ok = true;
    return { ccmId: a.ccmId, path, status: r.status, contentType: r.contentType, ok, notOnOriginal, skipped: false };
  });

  const crawl = await cx.crawlNew();
  const origin = new URL(cx.newBaseUrl).origin;
  const imgs = new Map<string, string[]>();
  for (const p of crawl.pages) {
    if (p.page.status !== 200 || !p.page.html) continue;
    for (const src of extractImageSrcs(p.page.html)) {
      let u: URL;
      try {
        u = new URL(src, p.page.finalUrl);
      } catch {
        continue;
      }
      if (u.protocol === "data:") continue;
      if (u.origin !== origin) {
        const n = cx.hostNormalize(u.toString());
        if (!n.startsWith("/")) continue; // external CDN etc.
        u = new URL(n, origin);
      }
      imgs.set(u.toString(), [...(imgs.get(u.toString()) ?? []), p.path]);
    }
  }
  const imgRows = await mapLimit([...imgs.keys()].sort(), 8, async (url) => {
    const r = await probe(url);
    let ok = r.status === 200 && !/text\/html/i.test(r.contentType);
    let notOnOriginal = false;
    if (!ok) {
      const u = new URL(url);
      notOnOriginal = !(await servedOnOld(u.pathname + u.search));
    }
    if (!ok && !notOnOriginal)
      issues.push({ severity: "error", code: "IMAGE_BROKEN", message: `${url} → ${r.status || r.error} (on ${imgs.get(url)!.join(", ")})`, ref: url, actionable: true });
    if (notOnOriginal) ok = true;
    return { url, status: r.status, contentType: r.contentType, ok, notOnOriginal, pages: imgs.get(url) };
  });
  const gaps = [...assetRows, ...imgRows].filter((r) => (r as { notOnOriginal?: boolean }).notOnOriginal);
  if (gaps.length)
    issues.push({
      severity: "warning",
      code: "MEDIA_MISSING_ON_ORIGINAL",
      message: `${gaps.length} file(s) missing on the new site AND on the original replay (not captured): ${gaps
        .slice(0, 6)
        .map((g) => ("path" in g && g.path) || ("url" in g && g.url))
        .join(", ")}`,
    });
  const missing = assetRows.filter((r) => !r.ok).length + imgRows.filter((r) => !r.ok).length;
  return finish(cx, "media", {
    gates: { missing: { pass: missing === 0, value: missing, threshold: 0 } },
    stats: { notOnOriginal: gaps.length, assets: assetRows.length, assetsMissing: assetRows.filter((r) => !r.ok).length, images: imgRows.length, imagesBroken: imgRows.filter((r) => !r.ok).length },
    issues,
    details: { assets: assetRows, images: imgRows },
  });
}
