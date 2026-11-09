/**
 * Asset access for the style/script port: crawl downloads first (exact URL incl. query, then by path), otherwise a
 * fetch from the site's own baseUrl (the "live" site — for nestle the local replay server). Requests never leave
 * the baseUrl origin, so the pipeline cannot reach a third-party or the original production host by accident.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Issue, Workspace } from "@harness/mirror-core";
import type { AssetRecord } from "@harness/mirror-capture";

export interface LoadedAsset {
  url: string; // absolute
  path: string; // URL path (decoded)
  query: string; // "?…" or ""
  body: Buffer;
  mime: string;
  from: "crawl" | "fetch";
}

export class AssetLoader {
  private byUrl = new Map<string, AssetRecord>();
  private byPath = new Map<string, AssetRecord>();
  private cache = new Map<string, Promise<LoadedAsset | undefined>>();
  readonly origin: string;
  issues: Issue[] = [];
  fetched = 0;
  /** fetches that failed at the network level (site down) — distinct from HTTP misses */
  networkErrors = 0;

  constructor(
    private ws: Workspace,
    readonly baseUrl: string,
    assets: AssetRecord[],
    private opts: { fetch?: boolean; fetchImpl?: typeof fetch } = {},
  ) {
    this.origin = new URL(baseUrl).origin;
    for (const a of assets) {
      this.byUrl.set(normUrl(a.url, baseUrl), a);
      if (!this.byPath.has(a.path)) this.byPath.set(a.path, a);
    }
  }

  /** absolute URL for an href found on a page (protocol-relative and relative resolved against baseUrl) */
  abs(href: string, from?: string): string | undefined {
    try {
      return new URL(href, from ?? this.baseUrl + "/").href;
    } catch {
      return undefined;
    }
  }

  sameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  /** replay convention for third-party hosts: /__ext/<host>/<path> on the baseUrl origin */
  extUrl(url: string): string | undefined {
    try {
      const u = new URL(url);
      if (u.origin === this.origin || !/^https?:$/.test(u.protocol)) return undefined;
      return `${this.origin}/__ext/${u.host}${u.pathname}${u.search}`;
    } catch {
      return undefined;
    }
  }

  async load(url: string): Promise<LoadedAsset | undefined> {
    const key = normUrl(url, this.baseUrl);
    let p = this.cache.get(key);
    if (!p) {
      p = this.doLoad(key);
      this.cache.set(key, p);
    }
    return p;
  }

  private async doLoad(url: string): Promise<LoadedAsset | undefined> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    const path = safeDecode(u.pathname) || "/";
    const exact = this.byUrl.get(url);
    // a crawl record of the same path but another query string may be a different file version (cache busters)
    const byPath = this.byPath.get(path);
    const rec = exact ?? (byPath && (!u.search || normUrl(byPath.url, this.baseUrl) === url || !this.canFetch(u)) ? byPath : undefined);
    if (rec && u.origin === this.origin) {
      try {
        return { url, path, query: u.search, body: await readFile(this.ws.path(rec.file)), mime: rec.mime, from: "crawl" };
      } catch {
        /* fall through to fetch */
      }
    }
    if (!this.canFetch(u)) return undefined;
    try {
      const f = this.opts.fetchImpl ?? fetch;
      const res = await f(url, { redirect: "follow" });
      if (!res.ok) {
        this.issues.push({ severity: "info", code: "DESIGN_ASSET_HTTP", message: `${url} returned ${res.status}`, ref: path });
        return undefined;
      }
      this.fetched++;
      return { url, path, query: u.search, body: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get("content-type") ?? "").split(";")[0].trim(), from: "fetch" };
    } catch (e) {
      this.networkErrors++;
      this.issues.push({ severity: "warning", code: "DESIGN_ASSET_FETCH_FAILED", message: `${url}: ${(e as Error).message}`, ref: path });
      return undefined;
    }
  }

  private canFetch(u: URL): boolean {
    return this.opts.fetch !== false && u.origin === this.origin;
  }
}

function normUrl(url: string, base: string): string {
  try {
    const u = new URL(url.replace(/&amp;/g, "&"), base + "/");
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const sha = (b: Buffer | string, n = 8) => createHash("sha256").update(b).digest("hex").slice(0, n);

/** design-relative file name for an asset path (+ query hash when the same path exists in several versions) */
export class NameRegistry {
  private used = new Map<string, string>(); // name -> content sha
  constructor(private dir: string) {}
  name(basename: string, content: Buffer | string): { rel: string; fresh: boolean } {
    const h = sha(content, 16);
    let name = basename;
    for (let i = 0; ; i++) {
      if (i > 0) {
        const dot = basename.lastIndexOf(".");
        name = dot > 0 ? `${basename.slice(0, dot)}.${h.slice(0, 8)}${i > 1 ? i : ""}${basename.slice(dot)}` : `${basename}.${h.slice(0, 8)}`;
      }
      const prev = this.used.get(name);
      if (prev === undefined) {
        this.used.set(name, h);
        return { rel: `${this.dir}/${name}`, fresh: true };
      }
      if (prev === h) return { rel: `${this.dir}/${name}`, fresh: false };
    }
  }
}
