/**
 * /sites/default/files/* (fallback rewrite in next.config, §14 #5): original Drupal file URLs keep working.
 * Files copied into public/ are served statically first; everything else is proxied from the asset's upstream URL
 * (Contentful CDN in production) so the public URL never changes.
 */
import { getData } from "../../../../lib/data";
import generated from "../../../../generated/config.json";

type AssetSource = { base?: string; oldOrigins?: string[]; localOnly?: boolean };
const isLoopback = (u: URL) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);

/** upstream URL of an asset: old-origin URLs re-hosted onto the configured source; local sources never go remote */
function upstreamOf(src: string): string | undefined {
  const cfg = ((generated as { assetSource?: AssetSource }).assetSource ?? {}) as AssetSource;
  let u: URL;
  try {
    u = new URL(src.startsWith("//") ? "https:" + src : src);
  } catch {
    return undefined;
  }
  if (cfg.base && (cfg.oldOrigins ?? []).some((o) => { try { return new URL(o).host === u.host; } catch { return false; } })) u = new URL(u.pathname + u.search, cfg.base);
  if (cfg.localOnly && !isLoopback(u)) return undefined;
  return u.toString();
}

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const original = "/sites/default/files/" + path.map(decodeURIComponent).join("/");
  const data = await getData(false);
  const asset = await data.getAssetByPath(original);
  const upstream = asset?.src && /^(https?:)?\/\//.test(asset.src) ? upstreamOf(asset.src) : undefined;
  if (!upstream) return new Response("Not found", { status: 404 });
  const res = await fetch(upstream);
  if (!res.ok || !res.body) return new Response("Upstream error", { status: 502 });
  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": res.headers.get("content-type") ?? asset!.mime,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
