/**
 * HAR 1.2 importer (DevTools → Network → "Export HAR (sanitized)").
 *
 * - accepts a .har file or a directory of them (sorted by name);
 * - bodies: `content.text` with `encoding: "base64"` or plain text; entries without a body are only kept
 *   when they are redirects / 204s;
 * - ignores data:, blob:, chrome-extension:, about: … and 304/206 (no usable body);
 * - picks the best entry per (method, url): 200 > other 2xx > 3xx > 4xx/5xx, then has-body, then larger
 *   body, then the later request;
 * - HAR entries replace Wayback entries for the same URL (the HAR is the authoritative source).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { mimeFromHeaders, normalizeUrl, type CaptureStore } from "./store.js";
import { kindOf, stripWaybackArtefacts } from "./rewrite.js";
import { parseArchiveUrl } from "./wayback.js";

interface HarHeader {
  name: string;
  value: string;
}
interface HarEntry {
  startedDateTime?: string;
  request: { method: string; url: string };
  response: {
    status: number;
    headers?: HarHeader[];
    redirectURL?: string;
    content?: { size?: number; mimeType?: string; text?: string; encoding?: string };
  };
}

export interface HarImportResult {
  files: string[];
  seen: number;
  imported: number;
  replaced: number;
  skipped: Record<string, number>;
}

const IGNORED_SCHEMES =
  /^(data|blob|chrome-extension|moz-extension|safari-extension|about|chrome|devtools|ws|wss|file):/i;

function rank(e: HarEntry, bodyLen: number): number[] {
  const s = e.response.status;
  const cls = s === 200 ? 5 : s >= 200 && s < 300 ? 4 : s >= 300 && s < 400 ? 3 : s >= 400 ? 1 : 0;
  return [
    cls,
    bodyLen > 0 || s === 204 || (s >= 300 && s < 400) ? 1 : 0,
    bodyLen,
    Date.parse(e.startedDateTime ?? "") || 0,
  ];
}
const better = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
};

export async function listHarFiles(path: string): Promise<string[]> {
  const st = await stat(path);
  if (st.isFile()) return [path];
  return (await readdir(path))
    .filter((f) => /\.har$/i.test(f))
    .sort()
    .map((f) => join(path, f));
}

function bodyOf(e: HarEntry): Buffer {
  const c = e.response.content;
  if (!c?.text) return Buffer.alloc(0);
  return c.encoding === "base64" ? Buffer.from(c.text, "base64") : Buffer.from(c.text, "utf8");
}

/** Import HAR file(s) into the store. HAR entries override existing (Wayback) entries for the same URL. */
export async function importHar(store: CaptureStore, path: string): Promise<HarImportResult> {
  const files = await listHarFiles(path);
  if (!files.length) throw new Error(`no .har files in ${path}`);
  const best = new Map<string, { e: HarEntry; body: Buffer; r: number[]; file: string }>();
  const res: HarImportResult = {
    files: files.map((f) => basename(f)),
    seen: 0,
    imported: 0,
    replaced: 0,
    skipped: {},
  };
  const skip = (why: string) => (res.skipped[why] = (res.skipped[why] ?? 0) + 1);

  for (const file of files) {
    const har = JSON.parse(await readFile(file, "utf8")) as { log?: { entries?: HarEntry[] } };
    for (const e of har.log?.entries ?? []) {
      res.seen++;
      let url = e.request?.url;
      if (!url || IGNORED_SCHEMES.test(url)) {
        skip("scheme");
        continue;
      }
      // a HAR recorded while browsing the Wayback Machine: map back to the original URL
      const wb = /^https?:\/\/web\.archive\.org\/web\/\d/.test(url) ? parseArchiveUrl(url) : undefined;
      if (/^https?:\/\/(web-static\.)?archive\.org\//.test(url) || (url.includes("web.archive.org") && !wb)) {
        skip("archive-artefact");
        continue;
      }
      if (wb) url = wb.url;
      const s = e.response?.status ?? 0;
      if (!s || s === 304 || s === 206) {
        skip(`status-${s}`);
        continue;
      }
      let key: string;
      try {
        key = `${(e.request.method || "GET").toUpperCase()} ${normalizeUrl(url)}`;
      } catch {
        skip("bad-url");
        continue;
      }
      const body = bodyOf(e);
      if (s >= 200 && s < 300 && s !== 204 && !body.length) {
        skip("no-body");
        continue;
      }
      const r = rank(e, body.length);
      const cur = best.get(key);
      if (!cur || better(r, cur.r))
        best.set(key, { e: { ...e, request: { ...e.request, url } }, body, r, file: basename(file) });
    }
  }

  for (const key of [...best.keys()].sort()) {
    const { e, body: raw, file } = best.get(key)!;
    const headers: Record<string, string> = {};
    for (const h of e.response.headers ?? []) {
      const k = h.name.toLowerCase();
      if (k.startsWith(":")) continue;
      headers[k] = headers[k] ? `${headers[k]}, ${h.value}` : h.value;
    }
    if (e.response.redirectURL && !headers.location) headers.location = e.response.redirectURL;
    if (!headers["content-type"] && e.response.content?.mimeType)
      headers["content-type"] = e.response.content.mimeType;
    const mime = mimeFromHeaders(headers, e.request.url);
    let body = raw;
    const k = kindOf(mime);
    if (k !== "binary" && body.length) {
      const txt = body.toString("latin1");
      const st = stripWaybackArtefacts(txt, k === "text" ? "text" : k);
      if (st !== txt) body = Buffer.from(st, "latin1");
    }
    const existed = !!store.get(e.request.url, e.request.method);
    await store.put(
      {
        url: e.request.url,
        method: e.request.method,
        status: e.response.status,
        headers,
        body,
        mime,
        from: `har:${file}`,
      },
      { replace: true },
    );
    res.imported++;
    if (existed) res.replaced++;
  }
  return res;
}
