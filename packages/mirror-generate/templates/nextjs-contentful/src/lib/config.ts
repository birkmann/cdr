/** Runtime configuration: generated defaults (src/generated/config.json) overridden by env vars. */
import generated from "../generated/config.json";
import { isAbsolute, resolve } from "node:path";

export interface AppConfig {
  site: string;
  dataSource: "ccm" | "contentful";
  /** absolute path of the CCM directory (ccm data source) */
  ccmDir: string;
  /** public origin of the new site (canonical, sitemap, hreflang) — defaults to the live site's baseUrl */
  siteUrl: string;
  contentful: { spaceId?: string; environment: string; deliveryToken?: string; previewToken?: string; host?: string };
  previewSecret?: string;
  revalidateSecret?: string;
}

type Gen = { site?: string; dataSource?: string; ccmDir?: string; siteUrl?: string; contentful?: { spaceIdEnv?: string; environment?: string } };

export function getConfig(): AppConfig {
  const g = generated as Gen;
  const ds = (process.env.DATA_SOURCE ?? g.dataSource ?? "ccm") as AppConfig["dataSource"];
  const rawDir = process.env.CCM_DIR ?? g.ccmDir ?? "fixtures/ccm";
  const spaceEnv = g.contentful?.spaceIdEnv ?? "CONTENTFUL_SPACE_ID";
  return {
    site: g.site ?? "site",
    dataSource: ds === "contentful" ? "contentful" : "ccm",
    ccmDir: isAbsolute(rawDir) ? rawDir : resolve(/*turbopackIgnore: true*/ process.cwd(), rawDir),
    siteUrl: (process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? g.siteUrl ?? "").replace(/\/+$/, ""),
    contentful: {
      spaceId: process.env[spaceEnv] ?? process.env.CONTENTFUL_SPACE_ID,
      environment: process.env.CONTENTFUL_ENVIRONMENT ?? g.contentful?.environment ?? "master",
      deliveryToken: process.env.CONTENTFUL_DELIVERY_TOKEN,
      previewToken: process.env.CONTENTFUL_PREVIEW_TOKEN,
      host: process.env.CONTENTFUL_HOST,
    },
    previewSecret: process.env.PREVIEW_SECRET ?? process.env.CONTENTFUL_PREVIEW_SECRET,
    revalidateSecret: process.env.REVALIDATE_SECRET ?? process.env.CONTENTFUL_REVALIDATE_SECRET,
  };
}
