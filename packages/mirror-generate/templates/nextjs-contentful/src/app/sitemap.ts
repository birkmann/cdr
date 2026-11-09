import type { MetadataRoute } from "next";
import { getData } from "../lib/data";
import { siteOrigin } from "../lib/route";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const data = await getData(false);
  const origin = await siteOrigin(data, data.default);
  const paths = await data.listPaths();
  const byId = new Map<string, { locale: string; path: string }[]>();
  for (const p of paths) byId.set(p.ccmId, [...(byId.get(p.ccmId) ?? []), { locale: p.locale, path: p.path }]);
  return paths.map((p) => {
    const alts = byId.get(p.ccmId) ?? [];
    return {
      url: origin + p.path,
      ...(p.lastModified ? { lastModified: p.lastModified } : {}),
      ...(alts.length > 1 ? { alternates: { languages: Object.fromEntries(alts.map((a) => [a.locale, origin + a.path])) } } : {}),
    };
  });
}
