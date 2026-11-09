/**
 * Zero-dependency static server for fixtures/site (the "live Drupal site" of the fixture).
 *
 *   pnpm tsx fixtures/serve.ts --port 4400
 *
 * Behaviour (Drupal-like):
 * - /<alias> → <alias>/index.html; trailing slash → 301 to the slash-less path
 * - seed redirects (redirect module) → 301; /node/<nid>, /de/node/<nid> (and /taxonomy/term/<tid>) → 301 to the alias
 * - unknown paths → 404 page (status 404), German 404 page under /de/
 * - absolute URLs baked in as http://localhost:4400 are rewritten to the request host (canonical, og:url, hreflang, sitemap)
 *
 * Also exported: startFixtureServer({ port }) for tests (port 0 = random).
 */
import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "site");
const BAKED_ORIGIN = "http://localhost:4400";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

interface SeedLite {
  nodes: { nid: number; translations: Record<string, { alias: string }> }[];
  taxonomies: { terms: { tid: number; alias: Record<string, string> }[] }[];
  redirects: { from: string; to: string; status: number; language: string }[];
}

async function loadRedirects(): Promise<Map<string, { to: string; status: number }>> {
  const seed: SeedLite = JSON.parse(await readFile(join(HERE, "seed.json"), "utf8"));
  const map = new Map<string, { to: string; status: number }>();
  const localeOf = (l: string) => (l === "en" ? "" : `/${l}`);
  for (const n of seed.nodes)
    for (const [l, tr] of Object.entries(n.translations)) map.set(`${localeOf(l)}/node/${n.nid}`, { to: tr.alias, status: 301 });
  for (const v of seed.taxonomies)
    for (const t of v.terms) for (const [l, a] of Object.entries(t.alias)) map.set(`${localeOf(l)}/taxonomy/term/${t.tid}`, { to: a, status: 301 });
  for (const r of seed.redirects) {
    const m = /^(?:internal:\/|entity:)node\/(\d+)$/.exec(r.to);
    const node = m ? seed.nodes.find((n) => n.nid === Number(m[1])) : undefined;
    const to = node ? (node.translations[r.language] ?? node.translations.en).alias : r.to.replace(/^internal:/, "");
    map.set(r.from, { to, status: r.status });
  }
  return map;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export interface FixtureServer {
  server: Server;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFixtureServer(opts: { port?: number; host?: string; quiet?: boolean } = {}): Promise<FixtureServer> {
  const redirects = await loadRedirects();
  const host = opts.host; // undefined = dual-stack (::), so both localhost/::1 and 127.0.0.1 work
  const server = createServer(async (req, res) => {
    const started = Date.now();
    let status = 200;
    try {
      const url = new URL(req.url ?? "/", "http://x");
      let path = decodeURIComponent(url.pathname);
      const origin = `http://${req.headers.host ?? `localhost:${(server.address() as { port: number }).port}`}`;
      const send = async (code: number, file: string, extra: Record<string, string> = {}) => {
        status = code;
        const ext = extname(file);
        let body: Buffer | string = await readFile(file);
        if (ext === ".html" || ext === ".xml" || ext === ".txt") body = body.toString("utf8").split(BAKED_ORIGIN).join(origin);
        res.writeHead(code, {
          "Content-Type": TYPES[ext] ?? "application/octet-stream",
          "Content-Length": String(Buffer.byteLength(body)),
          "X-Generator": "Drupal 10 (https://www.drupal.org)",
          "Cache-Control": ext === ".html" ? "max-age=0, public" : "max-age=31536000, public",
          ...(ext === ".html" ? { "Content-Language": path.startsWith("/de") ? "de" : "en", "X-Drupal-Cache": "HIT" } : {}),
          ...extra,
        });
        res.end(req.method === "HEAD" ? undefined : body);
      };
      const redirect = (to: string, code = 301) => {
        status = code;
        res.writeHead(code, { Location: to + url.search, "Content-Type": "text/html; charset=utf-8", "X-Redirect-Id": "fixture" });
        res.end(req.method === "HEAD" ? undefined : `<a href="${to}">${to}</a>`);
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        status = 405;
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      if (path.length > 1 && path.endsWith("/")) return redirect(path.replace(/\/+$/, ""));
      const r = redirects.get(path);
      if (r) return redirect(r.to, r.status);
      const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
      const direct = join(ROOT, safe);
      if (!direct.startsWith(ROOT)) return send(404, join(ROOT, "404.html"));
      if (extname(safe) && (await isFile(direct))) return send(200, direct);
      const index = join(direct, "index.html");
      if (await isFile(index)) return send(200, index);
      const de = path === "/de" || path.startsWith("/de/");
      return send(404, join(ROOT, de ? "de/404.html" : "404.html"));
    } catch (e) {
      status = 500;
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(e));
    } finally {
      if (!opts.quiet) console.log(`${req.method} ${req.url} ${status} ${Date.now() - started}ms`);
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 4400, host, () => ok());
  });
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT ?? 4400);
  const quiet = process.argv.includes("--quiet");
  const s = await startFixtureServer({ port, host: process.env.HOST, quiet });
  console.log(`fixture site (fixtures/site) on ${s.baseUrl}`);
}
