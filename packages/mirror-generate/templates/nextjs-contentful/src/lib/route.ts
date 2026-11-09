/** Route helpers shared by layout, page and metadata: slug params ↔ live URL path, entry lookup, site URL. */
import { cache } from "react";
import { draftMode } from "next/headers";
import { getConfig } from "./config";
import { getData } from "./data";
import type { Store } from "./data/store";
import type { EntryView } from "./data/types";

export type SlugParams = { slug?: string[] };

export function pathFromSlug(slug: string[] | undefined): string {
  if (!slug?.length) return "/";
  return "/" + slug.map((s) => decodeURIComponent(s)).join("/");
}

export function slugFromPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

async function isDraft(): Promise<boolean> {
  try {
    return (await draftMode()).isEnabled;
  } catch {
    return false;
  }
}

export const resolveRoute = cache(async (path: string): Promise<{ data: Store; entry: EntryView | null; locale: string; draft: boolean }> => {
  const draft = await isDraft();
  const data = await getData(draft);
  const entry = await data.getEntryByPath(path);
  return { data, entry, locale: entry?.locale ?? data.localeFromPath(path), draft };
});

/** origin used for canonical/hreflang/sitemap: SITE_URL env → generated siteUrl → settings.baseUrl */
export async function siteOrigin(data: Store, locale: string): Promise<string> {
  const cfg = getConfig();
  if (cfg.siteUrl) return cfg.siteUrl;
  const s = await data.getSettings(locale);
  return (s.baseUrl || "http://localhost:3000").replace(/\/+$/, "");
}

/** replace the origin of an absolute URL of the old site with the new origin (paths are preserved 1:1) */
export function rehost(url: string, origin: string, oldOrigins: string[]): string {
  try {
    const u = new URL(url);
    if (oldOrigins.some((o) => o && new URL(o).host === u.host)) return origin + u.pathname + u.search + u.hash;
    return url;
  } catch {
    return url.startsWith("/") ? origin + url : url;
  }
}

/** shared SEO inputs for metadata (page) and social head tags (layout) */
export async function seoContext(data: Store, entry: EntryView, path: string, locale: string) {
  const settings = await data.getSettings(locale);
  const origin = await siteOrigin(data, locale);
  const olds = [settings.baseUrl];
  const meta = { ...(settings.seoDefaults ?? {}), ...(entry.meta ?? {}) };
  // entries without their own head title (synthetic listing/term pages, adapters without metatag): Drupal core's
  // "<title> | <site name>" before the site-wide default title
  const own = String(entry.fields.title ?? entry.fields.name ?? "");
  const title = entry.meta?.title ?? (own ? [own, settings.siteName].filter(Boolean).join(" | ") : undefined) ?? meta.title ?? settings.siteName ?? "";
  // synthetic listing/term pages carry no meta: Views/term pages print no canonical link of their own
  const synthetic = entry.ccmId.startsWith("collection:") || entry.type === "taxonomyTerm";
  const canonical = meta.canonical ? rehost(meta.canonical, origin, olds) : origin + path;
  /** `<link rel=canonical>`: undefined for synthetic listing/term pages without meta (og:url keeps `canonical`) */
  const canonicalLink = meta.canonical || !synthetic || entry.meta ? canonical : undefined;
  return { settings, origin, olds, meta, title, canonical, canonicalLink, rehost: (u: string) => rehost(u, origin, olds) };
}
