/**
 * Capture store: every request a page made, answered later from disk (docs/plans/autopilot-self-improving-pipeline.md §2.1).
 *
 *   <snapshot>/raw/index.json   { site, source, origin, createdAt, entries: [{ url, method, status, headers, bodyFile, mime, from }] }
 *   <snapshot>/assets/<sha256>
 *
 * Bodies are stored decoded (no content-encoding). Entries are sorted (url, method) and headers are
 * whitelisted + sorted, so the same input always produces byte-identical index.json.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const INDEX_FILE = "raw/index.json";
export const BODIES_DIR = "assets";

export type CaptureSource = "live" | "har" | "wayback" | "mixed";

export interface CaptureEntry {
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  /** path relative to the capture dir: `assets/<sha256>` */
  bodyFile: string;
  mime: string;
  /** `live:<how>` | `har:<file>` | `wayback:<timestamp>` */
  from: string;
  /** optional provenance note, e.g. "substitute for an unarchived Drupal aggregate: <archived url>" */
  note?: string;
}

export interface CaptureIndex {
  site: string;
  source: CaptureSource;
  origin: string;
  createdAt: string;
  entries: CaptureEntry[];
}

export interface PutInput {
  url: string;
  method?: string;
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string;
  mime?: string;
  from: string;
  note?: string;
}

/** Response headers worth replaying. Everything else (cookies, CSP, HSTS, encodings, CDN noise) is dropped. */
export const KEPT_HEADERS = new Set([
  "content-type",
  "content-language",
  "last-modified",
  "etag",
  "cache-control",
  "expires",
  "location",
  "access-control-allow-origin",
  "link",
]);

export function sanitizeHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k0, v] of Object.entries(h)) {
    const k = k0.toLowerCase();
    if (!KEPT_HEADERS.has(k) || v === undefined) continue;
    const val = Array.isArray(v) ? v.join(", ") : String(v);
    out[k] = out[k] ? `${out[k]}, ${val}` : val;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Canonical URL key: parsed + re-serialised, fragment dropped, query string kept exactly. */
export function normalizeUrl(u: string): string {
  const url = new URL(u);
  url.hash = "";
  return url.href;
}

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function mimeFromHeaders(headers: Record<string, string>, url?: string): string {
  const ct = headers["content-type"];
  if (ct) return ct.split(";")[0]!.trim().toLowerCase();
  return url ? guessMime(url) : "application/octet-stream";
}

const EXT_MIME: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  xml: "application/xml",
  txt: "text/plain",
};

export function guessMime(u: string): string {
  let p = u;
  try {
    p = new URL(u).pathname;
  } catch {
    /* relative */
  }
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return (m && EXT_MIME[m[1]!.toLowerCase()]) || "application/octet-stream";
}

const DRUPAL_AGGREGATE = /\/files\/(css|js)\/(css|js)_[A-Za-z0-9_-]+\.(css|js)$/;
export function isDrupalAggregate(u: string): boolean {
  try {
    return DRUPAL_AGGREGATE.test(new URL(u).pathname);
  } catch {
    return false;
  }
}

function sourceOf(entries: CaptureEntry[]): CaptureSource {
  const kinds = new Set(entries.map((e) => e.from.split(":")[0]));
  if (kinds.size === 1 && kinds.has("live")) return "live";
  if (kinds.size === 1 && kinds.has("har")) return "har";
  if (kinds.size === 1 && kinds.has("wayback")) return "wayback";
  return kinds.size === 0 ? "live" : "mixed";
}

export interface OpenOptions {
  site: string;
  origin: string;
  /** fixed createdAt (tests); default: kept from an existing index, else now */
  createdAt?: string;
  /** start empty even if an index exists */
  fresh?: boolean;
}

export class CaptureStore {
  private byKey = new Map<string, CaptureEntry>();
  private byPath = new Map<string, string[]>(); // origin+pathname → keys
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(
    readonly dir: string,
    readonly site: string,
    readonly origin: string,
    readonly createdAt: string,
  ) {}

  static async open(dir: string, o: OpenOptions): Promise<CaptureStore> {
    const idx = join(dir, INDEX_FILE);
    let existing: CaptureIndex | undefined;
    if (!o.fresh && existsSync(idx)) existing = JSON.parse(await readFile(idx, "utf8")) as CaptureIndex;
    const s = new CaptureStore(
      dir,
      o.site,
      existing?.origin ?? o.origin,
      o.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    );
    for (const e of existing?.entries ?? []) s.index(e);
    await mkdir(join(dir, BODIES_DIR), { recursive: true });
    return s;
  }

  /** Read-only open of an existing capture dir (replay server). */
  static async load(dir: string): Promise<CaptureStore> {
    const idx = join(dir, INDEX_FILE);
    if (!existsSync(idx)) throw new Error(`no capture at ${dir} (run: cdr autopilot freeze)`);
    const j = JSON.parse(await readFile(idx, "utf8")) as CaptureIndex;
    return CaptureStore.open(dir, { site: j.site, origin: j.origin });
  }

  private key(url: string, method = "GET"): string {
    return `${method.toUpperCase()} ${normalizeUrl(url)}`;
  }

  private index(e: CaptureEntry): void {
    const k = this.key(e.url, e.method);
    const isNew = !this.byKey.has(k);
    this.byKey.set(k, e);
    if (isNew) {
      const u = new URL(e.url);
      const pk = `${e.method} ${u.origin}${u.pathname}`;
      const list = this.byPath.get(pk) ?? [];
      list.push(k);
      this.byPath.set(pk, list);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  entries(): CaptureEntry[] {
    return [...this.byKey.values()].sort((a, b) =>
      a.url < b.url ? -1 : a.url > b.url ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0,
    );
  }

  get(url: string, method = "GET"): CaptureEntry | undefined {
    return this.byKey.get(this.key(url, method));
  }

  /**
   * Exact match first (query string exact). Fallbacks, in order:
   *  1. same path with/without a trailing slash (no query on either side);
   *  2. same path, different query: Drupal aggregates (`css_<hash>.css`, hash = content) match any query;
   *     other URLs pick the candidate sharing the most query params (cache busters like `?tnamkk`, `?v=…`).
   * Returns `{ entry, exact }`.
   */
  lookup(url: string, method = "GET"): { entry: CaptureEntry; exact: boolean } | undefined {
    const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    u.hash = "";
    const exact =
      this.byKey.get(`${m} ${u.href}`) ?? (m !== "GET" ? this.byKey.get(`GET ${u.href}`) : undefined);
    if (exact) return { entry: exact, exact: true };
    if (!u.search) {
      const alt = new URL(u.href);
      alt.pathname =
        u.pathname.endsWith("/") && u.pathname !== "/" ? u.pathname.slice(0, -1) : u.pathname + "/";
      const e = this.byKey.get(`GET ${alt.href}`);
      if (e && e.status < 400) return { entry: e, exact: false };
    }
    const cands = (this.byPath.get(`GET ${u.origin}${u.pathname}`) ?? [])
      .map((k) => this.byKey.get(k)!)
      .filter((e) => e.status < 400);
    if (!cands.length) return undefined;
    const want = new URLSearchParams(u.search);
    const score = (e: CaptureEntry): number => {
      const q = new URLSearchParams(new URL(e.url).search);
      let s = 0;
      for (const [k, v] of want)
        if (q.get(k) === v) s += 2;
        else if (q.has(k)) s += 1;
      return s;
    };
    const best = [...cands].sort(
      (a, b) =>
        score(b) - score(a) ||
        (a.status === 200 ? -1 : 0) - (b.status === 200 ? -1 : 0) ||
        a.url.length - b.url.length ||
        (a.url < b.url ? -1 : 1),
    )[0]!;
    return { entry: best, exact: false };
  }

  hosts(): string[] {
    return [...new Set([...this.byKey.values()].map((e) => new URL(e.url).host))].sort();
  }

  /** Store a response. Returns false (and keeps the old one) when an entry exists and `replace` is not set. */
  async put(p: PutInput, opts: { replace?: boolean } = {}): Promise<boolean> {
    const method = (p.method ?? "GET").toUpperCase();
    const url = normalizeUrl(p.url);
    if (!opts.replace && this.byKey.has(this.key(url, method))) return false;
    const body = typeof p.body === "string" ? Buffer.from(p.body, "utf8") : p.body;
    const hash = sha256(body);
    const file = join(this.dir, BODIES_DIR, hash);
    if (!existsSync(file)) {
      await mkdir(join(this.dir, BODIES_DIR), { recursive: true });
      // two responses with the same body can arrive together: each writes its own temporary file
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, file);
    }
    const headers = sanitizeHeaders(p.headers ?? {});
    const e: CaptureEntry = {
      url,
      method,
      status: p.status,
      headers,
      bodyFile: `${BODIES_DIR}/${hash}`,
      mime: (p.mime ?? mimeFromHeaders(headers, url)).toLowerCase(),
      from: p.from,
      ...(p.note ? { note: p.note } : {}),
    };
    this.index(e);
    this.dirty = true;
    return true;
  }

  async readBody(e: CaptureEntry): Promise<Buffer> {
    return readFile(join(this.dir, e.bodyFile));
  }

  toIndex(): CaptureIndex {
    const entries = this.entries();
    return {
      site: this.site,
      source: sourceOf(entries),
      origin: this.origin,
      createdAt: this.createdAt,
      entries,
    };
  }

  /** Write index.json (serialised; safe to call concurrently). */
  async save(force = false): Promise<void> {
    this.saving = this.saving.then(async () => {
      if (!this.dirty && !force && existsSync(join(this.dir, INDEX_FILE))) return;
      this.dirty = false;
      const f = join(this.dir, INDEX_FILE);
      await mkdir(dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.toIndex(), null, 2) + "\n");
      await rename(tmp, f);
    });
    return this.saving;
  }
}
