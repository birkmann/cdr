/**
 * Internet Archive (Wayback Machine) client — polite: ≤ 2 concurrent requests, spacing between request
 * starts, 429/5xx backoff, and a disk cache so nothing is ever fetched twice.
 *
 * Only https://web.archive.org is ever contacted (hard guard in `archiveFetch`). Raw original bytes come
 * from `/web/<ts>id_/<url>`; Wayback's "closest capture" redirects are followed, archived redirects are
 * returned as redirects, archived Cloudflare challenge pages / 4xx captures are rejected.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { guardedFetch } from "@harness/mirror-core";
import { guessMime, isDrupalAggregate, sanitizeHeaders } from "./store.js";
import { isChallengePage, isTextMime, kindOf, stripWaybackArtefacts } from "./rewrite.js";

export const ARCHIVE_HOST = "web.archive.org";

export interface WaybackLog {
  info(msg: string): void;
  warn(msg: string): void;
  debug?(msg: string): void;
}

export interface WaybackOptions {
  /** disk cache dir (e.g. captures/<site>/.wayback-cache) */
  cacheDir: string;
  concurrency?: number;
  /** min ms between two request starts */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: WaybackLog;
  /** never touch the network (tests / replay without fill): cache only */
  offline?: boolean;
  timeoutMs?: number;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  location?: string;
}

export interface Resolved {
  /** the URL that was asked for (the store key) */
  url: string;
  /** archived URL actually used (differs when a fallback matched) */
  archivedUrl: string;
  ts: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  mime: string;
  note?: string;
}

interface CachedMeta {
  url: string;
  status: number;
  headers: Record<string, string>;
  location?: string;
  body?: string; // file name in cache dir
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** 14-digit timestamp distance in seconds (approx; good enough for "closest"). */
export function tsDistance(a: string, b: string): number {
  const d = (t: string) =>
    Date.UTC(
      +t.slice(0, 4),
      +t.slice(4, 6) - 1 || 0,
      +t.slice(6, 8) || 1,
      +t.slice(8, 10) || 0,
      +t.slice(10, 12) || 0,
      +t.slice(12, 14) || 0,
    );
  return Math.abs(d(a.padEnd(14, "0")) - d(b.padEnd(14, "0"))) / 1000;
}

/** Decode Drupal ≥ 10.1 aggregate `include=` (base64url(zlib(libraries))) → library list. */
export function decodeDrupalInclude(include: string): string[] {
  try {
    const buf = Buffer.from(include.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return inflateSync(buf).toString("utf8").split(",").filter(Boolean);
  } catch {
    return [];
  }
}

/** Parse `/web/<ts>[xx_]/<url>` out of an archive URL. */
export function parseArchiveUrl(u: string): { ts: string; flag: string; url: string } | undefined {
  const m = /\/web\/(\d{1,14})([a-z]{2}_)?\/(.+)$/.exec(u.replace(/^https?:\/\/web\.archive\.org/, ""));
  if (!m) return undefined;
  let url = m[3]!;
  if (/^https?:\/[^/]/.test(url)) url = url.replace(/^(https?:)\//, "$1//");
  return { ts: m[1]!, flag: m[2] ?? "", url };
}

function sameResource(a: string, b: string): boolean {
  // scheme, default ports, trailing slash and `?k` vs `?k=` are the same resource
  const n = (s: string) => {
    try {
      const u = new URL(s);
      return `${u.hostname}${u.pathname.replace(/\/$/, "")}?${new URLSearchParams(u.search).toString()}`;
    } catch {
      return s;
    }
  };
  return n(a) === n(b);
}

/** Decompress bodies that are still encoded (archive served the original gzip/br payload). */
export function decodeBody(body: Buffer, origEncoding?: string, mime?: string): Buffer {
  const gz = body.length > 2 && body[0] === 0x1f && body[1] === 0x8b;
  if (gz && !/gzip|x-gzip|octet-stream|zip/.test(mime ?? "")) {
    try {
      return decodeBody(gunzipSync(body), undefined, mime);
    } catch {
      return body;
    }
  }
  if (origEncoding && /\bbr\b/.test(origEncoding) && mime && isTextMime(mime)) {
    // only if it does not already look like text
    const head = body.subarray(0, 64).toString("latin1");
    if (!/^[\x09\x0a\x0d\x20-\x7e -ÿ]*$/.test(head)) {
      try {
        return brotliDecompressSync(body);
      } catch {
        return body;
      }
    }
  }
  return body;
}

export class WaybackClient {
  private active = 0;
  private queue: (() => void)[] = [];
  private lastStart = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly inflight = new Map<string, Promise<RawResponse>>();
  readonly stats = { network: 0, cached: 0, errors: 0 };
  private cdxDirCache = new Map<string, Promise<string[][]>>();

  constructor(private readonly o: WaybackOptions) {
    // through the run's request guard, like the crawl
    this.fetchImpl = o.fetchImpl ?? (guardedFetch as typeof fetch);
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    const max = Math.min(2, this.o.concurrency ?? 2);
    if (this.active >= max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      const wait = this.lastStart + (this.o.minIntervalMs ?? 250) - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  /** GET an archive URL (no redirect following), cached on disk forever. */
  async archiveFetch(url: string): Promise<RawResponse> {
    const u = new URL(url);
    if (u.hostname !== ARCHIVE_HOST || u.protocol !== "https:")
      throw new Error(`refusing non-archive request: ${url}`);
    const key = hash(u.href);
    const metaFile = join(this.o.cacheDir, `${key}.json`);
    if (existsSync(metaFile)) {
      const meta = JSON.parse(await readFile(metaFile, "utf8")) as CachedMeta;
      this.stats.cached++;
      return {
        status: meta.status,
        headers: meta.headers,
        location: meta.location,
        body: meta.body ? await readFile(join(this.o.cacheDir, meta.body)) : Buffer.alloc(0),
      };
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.networkFetch(u.href, key, metaFile).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async networkFetch(href: string, key: string, metaFile: string): Promise<RawResponse> {
    if (this.o.offline) return { status: 599, headers: {}, body: Buffer.alloc(0) };
    let attempt = 0;
    for (;;) {
      attempt++;
      const res = await this.slot(async () => {
        this.stats.network++;
        this.o.log?.debug?.(`wayback GET ${href}`);
        try {
          const r = await this.fetchImpl(href, {
            redirect: "manual",
            signal: AbortSignal.timeout(this.o.timeoutMs ?? 90_000),
            headers: { "user-agent": "cdr-autopilot capture (polite, cached)" },
          });
          const headers: Record<string, string> = {};
          r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
          const body = Buffer.from(await r.arrayBuffer());
          return {
            status: r.status,
            headers,
            body,
            location: r.headers.get("location") ?? undefined,
          } as RawResponse;
        } catch (e) {
          return {
            status: 598,
            headers: { "x-error": (e as Error).message },
            body: Buffer.alloc(0),
          } as RawResponse;
        }
      });
      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt < 5) {
        const ra = Number(res.headers["retry-after"]);
        const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60_000, 2000 * 2 ** attempt);
        this.o.log?.warn(
          `wayback ${res.status} for ${href} — retry ${attempt} in ${Math.round(backoff / 1000)}s`,
        );
        await sleep(backoff);
        continue;
      }
      if (transient) {
        this.stats.errors++;
        return res; // not cached: transient
      }
      await mkdir(this.o.cacheDir, { recursive: true });
      let bodyName: string | undefined;
      if (res.body.length) {
        bodyName = `${key}.body`;
        await writeFile(join(this.o.cacheDir, bodyName), res.body);
      }
      const meta: CachedMeta = {
        url: href,
        status: res.status,
        headers: res.headers,
        location: res.location,
        body: bodyName,
      };
      await writeFile(`${metaFile}.tmp`, JSON.stringify(meta));
      await rename(`${metaFile}.tmp`, metaFile);
      return res;
    }
  }

  /** CDX query → rows (header row removed). */
  async cdx(params: Record<string, string>): Promise<string[][]> {
    const q = new URLSearchParams({ output: "json", ...params });
    const r = await this.archiveFetch(`https://${ARCHIVE_HOST}/cdx/search/cdx?${q}`);
    if (r.status !== 200) return [];
    try {
      const rows = JSON.parse(r.body.toString("utf8") || "[]") as string[][];
      return rows.slice(1);
    } catch {
      return [];
    }
  }

  /**
   * Fetch `/web/<ts>id_/<url>`, following Wayback's closest-capture redirects (same resource) up to 6 hops.
   * Returns the archived response with original headers (from `x-archive-orig-*`) and the capture ts.
   */
  async fetchId(
    ts: string,
    url: string,
  ): Promise<
    | {
        status: number;
        headers: Record<string, string>;
        body: Buffer;
        ts: string;
        url: string;
        location?: string;
      }
    | undefined
  > {
    let cur = `https://${ARCHIVE_HOST}/web/${ts}id_/${url}`;
    for (let hop = 0; hop < 6; hop++) {
      const r = await this.archiveFetch(cur);
      const p = parseArchiveUrl(cur)!;
      if (r.status >= 300 && r.status < 400 && r.location) {
        const loc = new URL(r.location, cur).href;
        const lp = parseArchiveUrl(loc);
        if (lp && sameResource(lp.url, p.url)) {
          cur = `https://${ARCHIVE_HOST}/web/${lp.ts}id_/${lp.url}`;
          continue;
        }
        // archived redirect (original 3xx)
        const orig = Number(r.headers["x-ts"]) || r.status;
        return {
          status: orig >= 300 && orig < 400 ? orig : 301,
          headers: this.origHeaders(r.headers),
          body: Buffer.alloc(0),
          ts: p.ts,
          url: p.url,
          location: lp ? lp.url : loc,
        };
      }
      if (r.status !== 200) return undefined;
      const xts = Number(r.headers["x-ts"]) || 200;
      if (xts >= 400) return undefined;
      const headers = this.origHeaders(r.headers);
      const mime = (headers["content-type"] ?? guessMime(p.url)).split(";")[0]!.trim().toLowerCase();
      let body = decodeBody(r.body, r.headers["x-archive-orig-content-encoding"], mime);
      const k = kindOf(mime);
      if (k !== "binary") {
        const txt = body.toString("latin1");
        if (k === "html" && isChallengePage(txt)) return undefined;
        const stripped = stripWaybackArtefacts(txt, k === "text" ? "text" : k);
        if (stripped !== txt) body = Buffer.from(stripped, "latin1");
      }
      return { status: xts, headers, body, ts: p.ts, url: p.url };
    }
    return undefined;
  }

  private origHeaders(h: Record<string, string>): Record<string, string> {
    const o: Record<string, string> = {};
    if (h["content-type"]) o["content-type"] = h["content-type"];
    for (const [k, v] of Object.entries(h))
      if (k.startsWith("x-archive-orig-")) o[k.slice("x-archive-orig-".length)] = v;
    delete o["location"];
    return sanitizeHeaders(o);
  }

  private async cdxDir(dirUrl: string, ts: string): Promise<string[][]> {
    const t = new Date(
      Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8) || 1) - 120 * 86400_000,
    );
    const from = `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
    const key = `${dirUrl}|${from}`;
    let p = this.cdxDirCache.get(key);
    if (!p) {
      p = this.cdx({
        url: dirUrl,
        matchType: "prefix",
        from,
        filter: "statuscode:200",
        fl: "timestamp,original,mimetype,statuscode",
        limit: "20000",
      });
      this.cdxDirCache.set(key, p);
    }
    return p;
  }

  /**
   * Resolve an original URL near `ts`:
   *  1. `id_` closest capture of the exact URL;
   *  2. CDX: other 200 captures of the exact URL (closest ts);
   *  3. CDX: same path, other query (Drupal aggregates: same file = same content hash; cache busters);
   *  4. Drupal aggregate never archived → closest aggregate of the same kind/delta/scope by library set
   *     (decoded from `include=`), noted as a substitute.
   */
  async resolve(url: string, ts: string): Promise<Resolved | undefined> {
    const done = (r: NonNullable<Awaited<ReturnType<WaybackClient["fetchId"]>>>, note?: string): Resolved => {
      const headers = { ...r.headers };
      if (r.location) headers["location"] = r.location;
      const mime = (headers["content-type"] ?? guessMime(url)).split(";")[0]!.trim().toLowerCase();
      return { url, archivedUrl: r.url, ts: r.ts, status: r.status, headers, body: r.body, mime, note };
    };
    const a = await this.fetchId(ts, url);
    if (a) return done(a);

    // one CDX query over the path (all query variants, incl. the exact URL): exact first, then the
    // variant sharing most query params (Drupal aggregates: same file name = same content), then closest ts
    const u = new URL(url);
    const pathRows = (
      await this.cdx({
        url: `${u.host}${u.pathname}`,
        matchType: "prefix",
        filter: "statuscode:200",
        fl: "timestamp,original,mimetype,statuscode",
        limit: "2000",
      })
    ).filter((r) => {
      try {
        return new URL(r[1]!).pathname === u.pathname;
      } catch {
        return false;
      }
    });
    if (pathRows.length) {
      const want = new URLSearchParams(u.search);
      const score = (o: string) => {
        if (sameResource(o, url)) return 1000;
        const q = new URLSearchParams(new URL(o).search);
        let s = 0;
        for (const [k, v] of want) if (q.get(k) === v) s += 2;
        return s;
      };
      pathRows.sort((x, y) => score(y[1]!) - score(x[1]!) || tsDistance(x[0]!, ts) - tsDistance(y[0]!, ts));
      const tried = new Set<string>();
      for (const row of pathRows) {
        if (tried.size >= 3) break;
        if (tried.has(row[1]!)) continue;
        tried.add(row[1]!);
        const r = await this.fetchId(row[0]!, row[1]!);
        if (r)
          return done(
            r,
            sameResource(row[1]!, url) || isDrupalAggregate(url) ? undefined : `query fallback: ${row[1]}`,
          );
      }
    }

    if (isDrupalAggregate(url)) {
      const sub = await this.substituteAggregate(url, ts);
      if (sub) return sub;
    }
    return undefined;
  }

  private async substituteAggregate(url: string, ts: string): Promise<Resolved | undefined> {
    const u = new URL(url);
    const kind = u.pathname.endsWith(".css") ? "css" : "js";
    const q = u.searchParams;
    const libs = new Set(decodeDrupalInclude(q.get("include") ?? ""));
    if (!libs.size) return undefined;
    const dir = `${u.host}${u.pathname.replace(/[^/]+$/, "")}`;
    const rows = await this.cdxDir(dir, ts);
    type Cand = { row: string[]; score: number; dist: number };
    const cands: Cand[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      let o: URL;
      try {
        o = new URL(row[1]!);
      } catch {
        continue;
      }
      if (!o.pathname.endsWith(`.${kind}`)) continue;
      const oq = o.searchParams;
      if ((oq.get("delta") ?? "") !== (q.get("delta") ?? "")) continue;
      if ((oq.get("scope") ?? "") !== (q.get("scope") ?? "")) continue;
      if ((oq.get("theme") ?? "") !== (q.get("theme") ?? "")) continue;
      const ol = new Set(decodeDrupalInclude(oq.get("include") ?? ""));
      if (!ol.size) continue;
      const k = `${o.pathname}|${[...ol].sort().join(",")}`;
      if (seen.has(k + row[0])) continue;
      seen.add(k + row[0]);
      let inter = 0;
      for (const l of libs) if (ol.has(l)) inter++;
      const union = libs.size + ol.size - inter;
      const superset = inter === libs.size ? 0.05 : 0;
      cands.push({ row, score: inter / union + superset, dist: tsDistance(row[0]!, ts) });
    }
    cands.sort((a, b) => b.score - a.score || a.dist - b.dist);
    for (const c of cands.slice(0, 4)) {
      const r = await this.fetchId(c.row[0]!, c.row[1]!);
      if (!r) continue;
      const headers = { ...r.headers };
      const mime = (headers["content-type"] ?? guessMime(url)).split(";")[0]!.trim().toLowerCase();
      this.o.log?.warn(
        `substituting unarchived aggregate ${u.pathname.split("/").pop()} (delta ${q.get("delta")}) with ${new URL(r.url).pathname.split("/").pop()} @${r.ts} (library overlap ${c.score.toFixed(2)})`,
      );
      return {
        url,
        archivedUrl: r.url,
        ts: r.ts,
        status: r.status,
        headers,
        body: r.body,
        mime,
        note: `substitute for an unarchived Drupal aggregate (library overlap ${c.score.toFixed(2)}): ${r.url}`,
      };
    }
    return undefined;
  }
}
