/**
 * getData(): the DataSource for the current request. `ccm` (offline, workspace files) or `contentful` (CDA / Preview API).
 * Loaded once per process (build) — draft mode always gets a fresh preview store.
 */
import { cache } from "react";
import { getConfig } from "../config";
import { createCcmSource } from "./ccm-source";
import type { Store } from "./store";

let published: Promise<Store> | undefined;
let publishedAt = 0;
const TTL_MS = Number(process.env.CONTENT_CACHE_TTL_MS ?? 60_000);

async function load(preview: boolean): Promise<Store> {
  const cfg = getConfig();
  if (cfg.dataSource === "contentful") {
    const { createContentfulSource } = await import("./contentful-source");
    return createContentfulSource(cfg, preview);
  }
  return createCcmSource(cfg.ccmDir, { includeDrafts: preview });
}

/** drop the cached published store (revalidation webhook) */
export function invalidateData(): void {
  published = undefined;
}

export async function getStore(preview = false): Promise<Store> {
  if (preview) return load(true);
  const stale = getConfig().dataSource === "contentful" && Date.now() - publishedAt > TTL_MS;
  if (!published || stale) {
    publishedAt = Date.now();
    published = load(false).catch((e) => {
      published = undefined;
      throw e;
    });
  }
  return published;
}

/** per-request memo (React cache) — call from server components */
export const getData = cache(async (preview: boolean = false) => getStore(preview));

export type { DataSource, EntryView, AssetView, NavItemView, SettingsView, PathInfo, CollectionView, LinkView, TermView, EntryStub } from "./types";
