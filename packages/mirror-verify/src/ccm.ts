import { Workspace, type Asset, type Entry, type Locale, type Redirect, type SiteConfig, type SiteSettings, type CcmSchemaFile } from "@harness/mirror-core";
import type { CcmData } from "./types.js";

async function tryJson<T>(ws: Workspace, rel: string): Promise<T | undefined> {
  try {
    return await ws.readJson<T>(rel);
  } catch {
    return undefined;
  }
}

/** Lenient reader of workspace ccm/ (verify must not depend on core's readCcm). */
export async function readCcmData(ws: Workspace, site?: SiteConfig): Promise<CcmData> {
  const entries: Entry[] = [];
  for (const f of await ws.list("ccm/entries", ".json")) {
    const e = await tryJson<Entry>(ws, f);
    if (e && e.ccmId && e.type) entries.push({ ...e, status: e.status ?? "published", fields: e.fields ?? {} });
  }
  const assets: Asset[] = [];
  for (const f of await ws.list("ccm/assets", ".json")) {
    const a = await tryJson<Asset>(ws, f);
    if (a && a.ccmId) assets.push(a);
  }
  const redirects = ((await tryJson<Redirect[]>(ws, Workspace.REDIRECTS_PATH)) ?? []).map((r) => ({ ...r, status: r.status ?? 301 }));
  let locales = (await tryJson<Locale[]>(ws, Workspace.LOCALES_PATH)) ?? [];
  if (!locales.length && site)
    locales = site.locales.map((l) => ({ code: l.code, name: l.name ?? l.code, default: !!l.default, fallback: l.fallback, pathPrefix: l.pathPrefix ?? (l.default ? "" : l.code) }));
  const settings = await tryJson<SiteSettings>(ws, Workspace.SETTINGS_PATH);
  const schema = await tryJson<CcmSchemaFile>(ws, Workspace.SCHEMA_PATH);
  return { schema, entries, assets, redirects, locales, settings };
}

/** "/de" style prefix for a locale ("" for the default locale). */
export function localePrefix(locales: Locale[], code: string | undefined): string {
  const l = locales.find((x) => x.code === code);
  if (!l || l.default) return "";
  const p = (l.pathPrefix ?? l.code).replace(/^\/+|\/+$/g, "");
  return p ? `/${p}` : "";
}
