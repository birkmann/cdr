/** `contentful` data source: CDA (or Preview API in draft mode) → normalised CCM bundle → Store. */
import { createClient } from "contentful";
import type { AppConfig } from "../config";
import generatedAssets from "../../generated/assets.json";
import generatedLocales from "../../generated/locales.json";
import generatedRedirects from "../../generated/redirects-ccm.json";
import generatedSchema from "../../generated/schema.json";
import type { ContentType, Redirect } from "../ccm-types";
import { normalizeContentful, type CdaAsset, type CdaEntry, type CdaLocale } from "./contentful-normalize";
import { Store } from "./store";

const PAGE = 1000;

export async function createContentfulSource(cfg: AppConfig, preview: boolean): Promise<Store> {
  const { spaceId, environment, deliveryToken, previewToken, host } = cfg.contentful;
  const accessToken = preview ? previewToken : deliveryToken;
  if (!spaceId || !accessToken)
    throw new Error(`contentful data source: missing CONTENTFUL_SPACE_ID / ${preview ? "CONTENTFUL_PREVIEW_TOKEN" : "CONTENTFUL_DELIVERY_TOKEN"}`);
  const client = createClient({
    space: spaceId,
    environment,
    accessToken,
    host: host ?? (preview ? "preview.contentful.com" : "cdn.contentful.com"),
  }).withAllLocales.withoutLinkResolution;

  const entries: CdaEntry[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const res = await client.getEntries({ limit: PAGE, skip, include: 0 });
    entries.push(...(res.items as unknown as CdaEntry[]));
    if (skip + PAGE >= res.total) break;
  }
  const assets: CdaAsset[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const res = await client.getAssets({ limit: PAGE, skip });
    assets.push(...(res.items as unknown as CdaAsset[]));
    if (skip + PAGE >= res.total) break;
  }
  const locales = (await createClient({ space: spaceId, environment, accessToken, host: host ?? (preview ? "preview.contentful.com" : "cdn.contentful.com") }).getLocales())
    .items as unknown as CdaLocale[];

  const bundle = normalizeContentful({
    entries,
    assets,
    locales,
    localeConfig: generatedLocales as { code: string; pathPrefix?: string; name?: string }[],
    contentTypes: (generatedSchema as { contentTypes: ContentType[] }).contentTypes,
    assetPaths: (generatedAssets as { contentful?: Record<string, { ccmId?: string; originalPath?: string; width?: number; height?: number }> }).contentful ?? {},
    redirects: generatedRedirects as Redirect[],
    preview,
  });
  return new Store(bundle, { id: "contentful", includeDrafts: preview });
}
