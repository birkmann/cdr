import type { MetadataRoute } from "next";
import { getData } from "../lib/data";
import { siteOrigin } from "../lib/route";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const data = await getData(false);
  const origin = await siteOrigin(data, data.default);
  // Drupal core robots.txt disallows its admin/system paths — keep them blocked, they do not exist on the new site
  return {
    rules: [{ userAgent: "*", disallow: ["/api/", "/admin/", "/user/", "/node/add/", "/search/"] }],
    sitemap: `${origin}/sitemap.xml`,
  };
}
