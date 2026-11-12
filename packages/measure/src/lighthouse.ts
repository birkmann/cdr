// Lighthouse over a recreation, served from its folder on 127.0.0.1 (no network): performance, accessibility, best
// practices and SEO, on a phone and on a desktop. Lighthouse is an optional dependency, loaded only when it is
// installed; without it the gate says "skipped", never "pass".
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serve a folder on 127.0.0.1 (a random port), as a static host would: index.html for folders, long caching for
 * hashed assets, byte ranges for media. Nothing outside the folder is served.
 */
export async function serveDir(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const size = statSync(file).size;
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string | number> = {
      "content-type": type,
      "cache-control": /\.html$/.test(file) ? "no-cache" : "public, max-age=31536000, immutable",
      "accept-ranges": "bytes",
    };
    // text compressed, as every production host serves it
    if (
      /^(text\/|application\/json|image\/svg)/.test(type) &&
      /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))
    ) {
      const body = gzipSync(readFileSync(file));
      res.writeHead(200, {
        ...headers,
        "content-encoding": "gzip",
        "content-length": body.length,
        vary: "accept-encoding",
      });
      res.end(body);
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export interface LighthouseScores {
  formFactor: "mobile" | "desktop";
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
  /** the audits that cost the most points, per category */
  failing: { id: string; title: string; score: number | null; category: string }[];
  metrics: { lcp?: number; cls?: number; tbt?: number; fcp?: number };
  /** the element Lighthouse took as the largest contentful paint */
  lcpElement?: string;
}

export interface LighthouseThresholds {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

export const DEFAULT_LIGHTHOUSE: LighthouseThresholds = {
  performance: 90,
  accessibility: 95,
  bestPractices: 95,
  seo: 90,
};

/** Is Lighthouse installed (the optional dependency)? */
export async function lighthouseAvailable(): Promise<boolean> {
  try {
    const name = "lighthouse";
    await import(/* @vite-ignore */ name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lighthouse on `url` in its own headless Chrome (`chromePath`), once per form factor. null when Lighthouse is not
 * installed. Throws when Chrome cannot start.
 */
export async function runLighthouse(
  url: string,
  o: { chromePath?: string; formFactors?: ("mobile" | "desktop")[]; signal?: AbortSignal } = {},
): Promise<LighthouseScores[] | null> {
  let lighthouse: any, launcher: any;
  try {
    const lh = "lighthouse",
      cl = "chrome-launcher";
    lighthouse = (await import(/* @vite-ignore */ lh)).default;
    launcher = await import(/* @vite-ignore */ cl);
  } catch {
    return null;
  }
  const chrome = await launcher.launch({
    chromePath: o.chromePath,
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    logLevel: "silent",
  });
  try {
    const out: LighthouseScores[] = [];
    for (const ff of o.formFactors ?? ["mobile", "desktop"]) {
      if (o.signal?.aborted) break;
      const desktop = ff === "desktop";
      const r = await lighthouse(
        url,
        {
          port: chrome.port,
          output: "json",
          logLevel: "error",
          onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
        },
        {
          extends: "lighthouse:default",
          settings: desktop
            ? {
                formFactor: "desktop",
                screenEmulation: {
                  mobile: false,
                  width: 1350,
                  height: 940,
                  deviceScaleFactor: 1,
                  disabled: false,
                },
                throttling: {
                  rttMs: 40,
                  throughputKbps: 10240,
                  cpuSlowdownMultiplier: 1,
                  requestLatencyMs: 0,
                  downloadThroughputKbps: 0,
                  uploadThroughputKbps: 0,
                },
                emulatedUserAgent:
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
              }
            : { formFactor: "mobile" },
        },
      );
      const lhr = r?.lhr;
      if (!lhr) continue;
      const score = (k: string) => Math.round((lhr.categories?.[k]?.score ?? 0) * 100);
      const failing: LighthouseScores["failing"] = [];
      for (const [cat, c] of Object.entries<any>(lhr.categories ?? {}))
        for (const ref of c.auditRefs ?? []) {
          const a = lhr.audits?.[ref.id];
          if (!a || ref.weight === 0 || a.score === null || a.score >= 0.9) continue;
          failing.push({ id: ref.id, title: String(a.title ?? ref.id), score: a.score, category: cat });
        }
      const num = (id: string) =>
        typeof lhr.audits?.[id]?.numericValue === "number"
          ? Math.round(lhr.audits[id].numericValue * 1000) / 1000
          : undefined;
      out.push({
        formFactor: ff,
        performance: score("performance"),
        accessibility: score("accessibility"),
        bestPractices: score("best-practices"),
        seo: score("seo"),
        failing: failing.slice(0, 20),
        ...(lcpOf(lhr) ? { lcpElement: lcpOf(lhr) } : {}),
        metrics: {
          lcp: num("largest-contentful-paint"),
          cls: num("cumulative-layout-shift"),
          tbt: num("total-blocking-time"),
          fcp: num("first-contentful-paint"),
        },
      });
    }
    return out;
  } finally {
    await chrome.kill();
  }
}

function lcpOf(lhr: any): string | undefined {
  const items = lhr.audits?.["largest-contentful-paint-element"]?.details?.items ?? [];
  for (const it of items) {
    const node = it?.node ?? it?.items?.[0]?.node;
    if (node?.snippet) return String(node.snippet).slice(0, 200);
  }
  return undefined;
}

/** Lighthouse scores against the thresholds: the gate's verdict and its line. */
export function lighthouseGate(
  scores: LighthouseScores[] | null,
  t: Partial<LighthouseThresholds> = {},
): { pass: boolean; detail: string } {
  const th = { ...DEFAULT_LIGHTHOUSE, ...t };
  if (!scores) return { pass: true, detail: "skipped (lighthouse is not installed)" };
  if (!scores.length) return { pass: false, detail: "lighthouse produced no report" };
  const below: string[] = [];
  for (const s of scores)
    for (const [k, v] of [
      ["performance", s.performance],
      ["accessibility", s.accessibility],
      ["bestPractices", s.bestPractices],
      ["seo", s.seo],
    ] as const)
      if (v < th[k]) below.push(`${s.formFactor} ${k} ${v} < ${th[k]}`);
  const line = scores
    .map((s) => `${s.formFactor} ${s.performance}/${s.accessibility}/${s.bestPractices}/${s.seo}`)
    .join(", ");
  return {
    pass: !below.length,
    detail: `${line} (perf/a11y/best/seo)${below.length ? `; below: ${below.join(", ")}` : ""}`,
  };
}
