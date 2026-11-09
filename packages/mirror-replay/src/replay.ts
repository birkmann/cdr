/**
 * Replay server: serves a capture store as if it were the original origin.
 *
 *   GET /<path>?<query>             → <origin>/<path>?<query>  (exact query first, then store fallbacks)
 *   GET /__ext/<host>/<path>?<q>    → https://<host>/<path>?<q> (captured third-party hosts)
 *   GET /__replay/status            → JSON stats (entries, misses, fills)
 *   trackers (TRACKER_HOSTS / TRACKER_PATHS) → 204, misses → 404 + one JSON line in the misses log (REPLAY_404)
 *
 * HTML/CSS/JS/JSON/SVG bodies are rewritten on the fly (origin → replay base, third-party → /__ext/).
 * A strict CSP (`default-src 'self' …`) makes sure a replayed page can never reach the live origin,
 * a third party or the archive, even through URLs constructed at runtime.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { CaptureStore, type CaptureEntry } from "./store.js";
import {
  isTrackerUrl,
  kindOf,
  openXfToggles,
  rewriteHtml,
  rewriteJs,
  rewriteText,
  type RewriteOptions,
} from "./rewrite.js";
import type { WaybackClient } from "./wayback.js";

export interface ReplayOptions {
  /** the snapshot folder */
  captureDir: string;
  /** an already opened store (capture run shares it); default: CaptureStore.load(captureDir) */
  store?: CaptureStore;
  port?: number;
  host?: string;
  /** on a miss, fetch from the Wayback Machine into the store */
  /**
   * On a miss, fetch from the Wayback Machine into the store. Only sub-resources (anything with a file
   * extension, or a third-party URL) and the listed `pages` are filled; other documents (link probes,
   * HEAD requests) get an immediate 404 so crawlers are not slowed down by out-of-scope pages.
   */
  fillFromWayback?: {
    client: WaybackClient;
    timestamp: string | ((url: string, referer?: string) => string);
    pages?: string[];
  };
  /** JSON lines `{ ts, method, url, kind, referer }`, default: <captureDir>/misses.jsonl */
  missesLog?: string;
  /** strict same-origin CSP (default true) */
  csp?: boolean;
  log?: { info(m: string): void; warn(m: string): void };
}

/** What a request the snapshot could not answer was for: `probe` for requests no page needs (link checks, robots). */
export type MissKind = "document" | "stylesheet" | "script" | "image" | "font" | "media" | "fetch" | "probe";

export interface ReplayMiss {
  url: string;
  method: string;
  kind: MissKind;
  referer?: string;
  count: number;
}

export interface ReplayServer {
  url: string;
  port: number;
  server: Server;
  store: CaptureStore;
  misses: Map<string, ReplayMiss>;
  fills: number;
  close(): Promise<void>;
}

export const REPLAY_CSP =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; frame-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:";

/** Map a replay request path to the original URL it stands for. */
export function originalUrlFor(reqUrl: string, origin: string): string | undefined {
  if (reqUrl.startsWith("/__ext/")) {
    const m = /^\/__ext\/([^/?#]+)([^#]*)/.exec(reqUrl);
    if (!m || !/^[a-z0-9.-]+(:\d+)?$/i.test(m[1]!)) return undefined;
    const rest = m[2] || "/";
    return new URL(`https://${m[1]}${rest.startsWith("/") ? rest : "/" + rest}`).href;
  }
  return new URL(reqUrl, origin).href;
}

/** Fill policy: no HEAD probes; same-origin extension-less paths (documents) only when listed in `pages`. */
export function shouldFill(target: string, method: string, origin: string, pages?: string[]): boolean {
  if (method === "HEAD") return false;
  const u = new URL(target);
  if (u.origin !== new URL(origin).origin) return true;
  const last = u.pathname.split("/").pop() ?? "";
  if (/\.[a-z0-9]{1,6}$/i.test(last)) return true;
  if (!pages) return true;
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/$/, "") : p);
  return pages.map(norm).includes(norm(u.pathname));
}

const DEST_KIND: Record<string, MissKind> = {
  document: "document",
  iframe: "document",
  frame: "document",
  style: "stylesheet",
  script: "script",
  image: "image",
  font: "font",
  video: "media",
  audio: "media",
  track: "media",
  empty: "fetch",
};
const EXT_KIND: [RegExp, MissKind][] = [
  [/\.css$/i, "stylesheet"],
  [/\.m?js$/i, "script"],
  [/\.(png|jpe?g|gif|webp|avif|svg|ico)$/i, "image"],
  [/\.(woff2?|ttf|otf|eot)$/i, "font"],
  [/\.(mp4|webm|mp3|m3u8)$/i, "media"],
];

/** Browsers say what a request is for; other clients (link checks, robots, HEAD) only count when they ask for a page asset. */
export function missKind(target: string, method: string, secFetchDest?: string): MissKind {
  if (method === "HEAD") return "probe";
  const dest = secFetchDest?.toLowerCase();
  if (dest && DEST_KIND[dest]) return DEST_KIND[dest]!;
  let path = target;
  try {
    path = new URL(target).pathname;
  } catch {
    /* relative */
  }
  return EXT_KIND.find(([re]) => re.test(path))?.[1] ?? "probe";
}

function replayBaseOf(req: IncomingMessage, fallback: string): string {
  const forced = req.headers["x-replay-base"];
  if (typeof forced === "string" && /^https?:\/\//.test(forced)) return forced.replace(/\/$/, "");
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
  return host ? `${proto}://${host}` : fallback;
}

export async function startReplayServer(o: ReplayOptions): Promise<ReplayServer> {
  const store = o.store ?? (await CaptureStore.load(o.captureDir));
  const missesLog = o.missesLog ?? join(o.captureDir, "misses.jsonl");
  await mkdir(dirname(missesLog), { recursive: true });
  const misses = new Map<string, ReplayMiss>();
  const pendingFills = new Map<string, Promise<CaptureEntry | undefined>>();
  let fills = 0;
  const host = o.host ?? "127.0.0.1";
  let fallbackBase = "";

  const extHosts = (): string[] => store.hosts();

  async function fill(target: string, referer?: string): Promise<CaptureEntry | undefined> {
    const f = o.fillFromWayback;
    if (!f) return undefined;
    let p = pendingFills.get(target);
    if (!p) {
      p = (async () => {
        const ts = typeof f.timestamp === "function" ? f.timestamp(target, referer) : f.timestamp;
        const r = await f.client.resolve(target, ts).catch((e) => {
          o.log?.warn(`fill failed for ${target}: ${(e as Error).message}`);
          return undefined;
        });
        if (!r) return undefined;
        await store.put({
          url: target,
          status: r.status,
          headers: r.headers,
          body: r.body,
          mime: r.mime,
          from: `wayback:${r.ts}`,
          note: r.note,
        });
        await store.save();
        fills++;
        return store.get(target);
      })().finally(() => pendingFills.delete(target));
      pendingFills.set(target, p);
    }
    return p;
  }

  async function logMiss(target: string, method: string, kind: MissKind, referer?: string): Promise<void> {
    const m = misses.get(target);
    if (m) {
      m.count++;
      return;
    }
    misses.set(target, { url: target, method, kind, referer, count: 1 });
    const line = JSON.stringify({ ts: new Date().toISOString(), method, url: target, kind, referer });
    await appendFile(missesLog, `${line}\n`).catch(() => undefined);
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    const reqUrl = req.url ?? "/";
    const base = replayBaseOf(req, fallbackBase);
    const common: Record<string, string> = {
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-replay": "1",
    };
    if (o.csp !== false) common["content-security-policy"] = REPLAY_CSP;

    if (reqUrl === "/__replay/status") {
      res.writeHead(200, { ...common, "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify(
          {
            site: store.site,
            origin: store.origin,
            entries: store.size,
            fills,
            misses: [...misses.values()],
          },
          null,
          2,
        ),
      );
      return;
    }
    if (method === "OPTIONS") {
      res.writeHead(204, {
        ...common,
        "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
        "access-control-allow-headers": "*",
      });
      res.end();
      return;
    }
    let target: string | undefined;
    try {
      target = originalUrlFor(reqUrl, store.origin);
    } catch {
      target = undefined;
    }
    if (!target) {
      res.writeHead(400, common);
      res.end("bad request");
      return;
    }
    if (isTrackerUrl(target)) {
      res.writeHead(204, common);
      res.end();
      return;
    }
    const referer = typeof req.headers.referer === "string" ? req.headers.referer : undefined;
    let hit = store.lookup(target, method);
    if (!hit || !hit.exact) {
      // exact miss: try the archive first (exact URL beats a fallback), then the store fallback
      const filled =
        o.fillFromWayback && shouldFill(target, method, store.origin, o.fillFromWayback.pages)
          ? await fill(target, referer)
          : undefined;
      if (filled) hit = { entry: filled, exact: true };
    }
    if (!hit) {
      const dest = req.headers["sec-fetch-dest"];
      await logMiss(
        target,
        method,
        missKind(target, method, typeof dest === "string" ? dest : undefined),
        referer,
      );
      res.writeHead(404, { ...common, "content-type": "text/plain; charset=utf-8" });
      res.end(`replay miss: ${target}`);
      return;
    }
    const e = hit.entry;
    const rw: RewriteOptions = {
      origin: store.origin,
      replayBase: base,
      extHosts: extHosts(),
      keepLink: (href) => {
        try {
          return !store.lookup(new URL(href, store.origin).href);
        } catch {
          return false;
        }
      },
    };
    const headers: Record<string, string> = { ...common };
    if (!hit.exact) headers["x-replay-fallback"] = e.url;
    if (e.headers["content-language"]) headers["content-language"] = e.headers["content-language"];
    if (e.headers["last-modified"]) headers["last-modified"] = e.headers["last-modified"];

    if (e.status >= 300 && e.status < 400) {
      const loc = e.headers["location"];
      if (loc) headers["location"] = rewriteText(new URL(loc, e.url).href, rw);
      res.writeHead(e.status, headers);
      res.end();
      return;
    }
    let body = await store.readBody(e);
    const kind = kindOf(e.mime);
    let ct = e.headers["content-type"] ?? e.mime;
    if (kind !== "binary") {
      const txt = body.toString("latin1");
      const out =
        kind === "html"
          ? rewriteHtml(openXfToggles(txt), rw)
          : kind === "js"
            ? rewriteJs(txt, rw)
            : rewriteText(txt, rw);
      if (out !== txt) body = Buffer.from(out, "latin1");
      if (!/charset=/i.test(ct) && kind !== "text") ct += "; charset=utf-8";
    }
    headers["content-type"] = ct;
    headers["accept-ranges"] = "bytes";
    const range =
      typeof req.headers.range === "string" ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range) : null;
    if (range && e.status === 200 && kind === "binary") {
      const size = body.length;
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      if (!range[1]) end = size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end || start >= size) {
        res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(end - start + 1),
      });
      res.end(method === "HEAD" ? undefined : body.subarray(start, end + 1));
      return;
    }
    headers["content-length"] = String(body.length);
    res.writeHead(e.status, headers);
    res.end(method === "HEAD" ? undefined : body);
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    handler(req, res).catch((err) => {
      o.log?.warn(`replay error ${req.url}: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("replay error");
    });
  };
  const listen = (srv: Server, port: number, h: string) =>
    new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, h, () => resolve());
    });
  const server = createServer(onRequest);
  await listen(server, o.port ?? 0, host);
  // "localhost" may resolve to ::1 first: also answer on the IPv6 loopback (same port) when binding loopback
  let server6: Server | undefined;
  if (host === "127.0.0.1") {
    const s6 = createServer(onRequest);
    const p = (server.address() as { port: number }).port;
    await listen(s6, p, "::1").then(
      () => (server6 = s6),
      () => undefined,
    );
  }
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (o.port ?? 0);
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  fallbackBase = url;
  return {
    url,
    port,
    server,
    store,
    misses,
    get fills() {
      return fills;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server6?.closeAllConnections?.();
        server6?.close();
        server.close(() => r());
      }),
  };
}
