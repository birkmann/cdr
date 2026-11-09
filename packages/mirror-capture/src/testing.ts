/**
 * Test helpers (exported for @cmp/autofix tests): crawl inputs from HTML strings, the Nestlé paragraph wrapper, a crawl
 * written into a workspace, and the golden field-recovery comparison used by the P2 goldens.
 */
import type { Entry, Workspace } from "@harness/mirror-core";
import type { CrawlIndex, PageManifest } from "./crawl.js";
import type { CoverageInput } from "./infer.js";

export const NESTLE_BASE = "http://localhost:4401";
export const NESTLE_ORIGIN = "https://www.nestle.com";

export function fixtureManifest(path: string, file: string, base = NESTLE_BASE): PageManifest {
  return { id: file, path, requestedUrl: base + path, finalUrl: base + path, status: 200, redirectChain: [], bodyClasses: [], files: { raw: file, rendered: file }, screenshots: {}, styles: {}, images: [], network: [], links: [], hreflang: [] };
}

/** a Nestlé paragraph (or block) inside the da_vinci_code node template (same as nestle.test.ts) */
export function wrapNestleParagraph(snippet: string): string {
  const isBlock = /^\s*(<!--.*?-->\s*)?<section[^>]+block-block-content/s.test(snippet);
  const inner = isBlock
    ? `<div class="block-view-container">${snippet}</div>`
    : `<div class="field-components-container"><div class="field field--name-field-ln-n-components field--type-entity-reference-revisions field--label-hidden field--items"><div class="field--item">${snippet}</div></div></div>`;
  return `<!DOCTYPE html><html lang="en" dir="ltr"><head><title>Test | Nestlé Global</title></head>
<body class="path-node page-node-type-dsu-component-page"><main id="main-content" class="main-wrapper"><div class="region region-page-header"><header class="page-header"><h1 class="page-header__title">Test</h1></header></div>
<div class="container"><div class="region region-content"><article class="component-1"><div></div></article>${inner}</div></div></main></body></html>`;
}

/** CoverageInput (in-memory crawl) for path -> html */
export function coverageInputFor(files: Record<string, string>, base = NESTLE_BASE, origin = NESTLE_ORIGIN): CoverageInput {
  const paths = Object.keys(files);
  const pages = paths.map((path, i) => ({ ...fixtureManifest(path, `raw/html/pages/p${i}.html`, base), id: `p${i}` }));
  const index: CrawlIndex = { baseUrl: base, viewports: [], mask: [], pages: pages.map((p) => ({ path: p.path, id: p.id, status: 200, manifest: `raw/html/pages/${p.id}.json`, requested: [p.path] })), redirects: [], failed: [], origin };
  return { pages: paths.map((path) => ({ path, finalUrl: base + path, html: files[path] })), crawl: { index, pages, assets: [], links: {} }, base };
}

/** write the in-memory crawl into `ws/raw/html/` so the transform step and measureTextCoverage can read it */
export async function writeFixtureCrawl(ws: Workspace, files: Record<string, string>, base = NESTLE_BASE, origin = NESTLE_ORIGIN): Promise<void> {
  const input = coverageInputFor(files, base, origin);
  for (const [i, p] of input.crawl.pages.entries()) {
    await ws.writeText(p.files.raw!, files[p.path]);
    await ws.writeJson(input.crawl.index.pages[i].manifest, p);
  }
  await ws.writeJson("raw/html/crawl.json", input.crawl.index);
  await ws.writeJson("raw/html/assets.json", []);
  await ws.writeJson("raw/html/links.json", {});
}

const squash = (s: string) => s.replace(/\s+/g, "");
const SKIP_KEYS = new Set(["kind", "type", "marks", "level", "ordered", "target", "rel"]);

/** visible-value leaves of a field value (strings), skipping entry references and AST structure keys */
export function valueLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    const t = squash(v.replace(/<[^>]*>/g, " "));
    if (t.length >= 2) out.push(t);
  } else if (Array.isArray(v)) v.forEach((x) => valueLeaves(x, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.kind === "entry") return out;
    for (const [k, x] of Object.entries(o)) if (!SKIP_KEYS.has(k)) valueLeaves(x, out);
  }
  return out;
}

export interface FieldRecovery {
  /** golden fields with at least one visible value (excluding html fallbacks and class lists) */
  fields: number;
  /** every value leaf of the golden field appears in some typed (non-html) field of the produced sections */
  recovered: number;
  /** recovered AND the produced entry has a field with the same id */
  sameId: number;
  missing: string[];
}

/** Compare produced section entries against golden ones (projection of nestle expected/*.json: {ccmId,type,fields}). */
export function fieldRecovery(golden: Pick<Entry, "ccmId" | "type" | "fields">[], produced: Pick<Entry, "ccmId" | "type" | "fields">[]): FieldRecovery {
  const typed = produced.map((e) => ({ e, hay: Object.entries(e.fields).filter(([k]) => k !== "html").flatMap(([, v]) => valueLeaves(v)).join("\u0000") }));
  const all = typed.map((t) => t.hay).join("\u0001");
  const r: FieldRecovery = { fields: 0, recovered: 0, sameId: 0, missing: [] };
  for (const g of golden) {
    const match = produced.find((p) => p.ccmId === g.ccmId);
    for (const [k, v] of Object.entries(g.fields)) {
      if (k === "html" || k === "classes" || /Classes$/.test(k)) continue;
      const leaves = valueLeaves(v);
      if (!leaves.length) continue;
      r.fields++;
      if (leaves.every((l) => all.includes(l))) {
        r.recovered++;
        if (match && k in match.fields) r.sameId++;
      } else r.missing.push(`${g.type}.${k}`);
    }
  }
  return r;
}
