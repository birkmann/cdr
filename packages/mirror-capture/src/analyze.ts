/**
 * analyze (html adapter): inventory of the crawl — URL patterns, templates by body class, components found,
 * media, third-party scripts, locales. Writes analysis/html-inventory.json + analysis/html-SUMMARY.md.
 */
import { stringify } from "yaml";
import type { ContentType, StepContext, StepReport, Issue } from "@harness/mirror-core";
import { readCrawl } from "./crawl.js";
import { classes, select, selectAll } from "./dom.js";
import { parsePage } from "./page.js";
import { buildCcm, entityRoot } from "./to-ccm.js";
import { walk } from "./dom.js";
import type { ProfileSet } from "./profiles.js";
import { resolveProfileSet } from "./theme-pack.js";

export interface HtmlInventory {
  baseUrl: string;
  generator?: string;
  pages: number;
  statuses: Record<string, number>;
  locales: { code: string; pages: number }[];
  urlPatterns: { pattern: string; count: number; examples: string[] }[];
  templates: { template: string; bodyClass: string; count: number; paths: string[] }[];
  components: { kind: "paragraph" | "view" | "block" | "landmark" | "node-view-mode"; id: string; count: number; pages: number }[];
  media: { images: number; distinctImages: number; bytes: number; byMime: Record<string, number> };
  thirdPartyScripts: { src: string; placement: string; blockedDuringCrawl: boolean }[];
  forms: number;
  iframes: number;
  redirects: number;
  brokenLinks: string[];
  complexity: { score: number; factors: Record<string, number> };
}

const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

export async function analyzeHtml(ctx: StepContext): Promise<{ inventory: HtmlInventory; issues: Issue[] }> {
  const crawl = await readCrawl(ctx.ws);
  if (!crawl) throw new Error("raw/html/crawl.json not found — run extract (html adapter) first");
  const base = crawl.index.baseUrl;
  const { set: ps } = await resolveProfileSet(ctx.ws, ctx.site, crawl, { themePack: (ctx.options as { themePack?: string }).themePack });
  const issues: Issue[] = [];
  const statuses = new Map<string, number>();
  const locales = new Map<string, number>();
  const patterns = new Map<string, { count: number; examples: string[] }>();
  const templates = new Map<string, { bodyClass: string; paths: string[] }>();
  const comps = new Map<string, { kind: HtmlInventory["components"][number]["kind"]; id: string; count: number; pages: Set<string> }>();
  const third = new Map<string, { placement: string; blocked: boolean }>();
  let images = 0;
  let forms = 0;
  let iframes = 0;
  let generator: string | undefined;
  const distinct = new Set<string>();

  const addComp = (kind: HtmlInventory["components"][number]["kind"], id: string, page: string) => {
    const k = `${kind}:${id}`;
    const c = comps.get(k) ?? { kind, id, count: 0, pages: new Set<string>() };
    c.count++;
    c.pages.add(page);
    comps.set(k, c);
  };

  for (const m of crawl.pages) {
    inc(statuses, String(m.status));
    // raw server HTML (what toCCM reads) when captured, else the rendered DOM
    const raw = m.files.raw ? await ctx.ws.readText(m.files.raw).catch(() => "") : "";
    const info = parsePage(/<body[\s>]/i.test(raw) ? raw : await ctx.ws.readText(m.files.rendered), m.path, base);
    generator ??= info.tree && (select("meta[name=Generator]", info.tree)?.properties?.content as string | undefined);
    inc(locales, info.lang ?? "unknown");
    const segs = m.path.split("/").filter(Boolean);
    const localeSeg = segs[0] && info.lang && segs[0] === info.lang ? 1 : 0;
    const rest = segs.slice(localeSeg);
    const pattern = (localeSeg ? `/${segs[0]}` : "") + (rest.length === 0 ? "/" : rest.length === 1 ? `/${rest[0]}` : `/${rest[0]}/*`);
    const pt = patterns.get(pattern) ?? { count: 0, examples: [] };
    pt.count++;
    if (pt.examples.length < 3) pt.examples.push(m.path);
    patterns.set(pattern, pt);
    const tplClass = info.bodyClasses.find((c) => c.startsWith("page-node-type-")) ?? info.bodyClasses.find((c) => c.startsWith("path-")) ?? "";
    const t = templates.get(info.template) ?? { bodyClass: tplClass, paths: [] };
    t.paths.push(m.path);
    templates.set(info.template, t);
    // paragraphs (incl. theme roots without the `paragraph` class) and nodes rendered in a view mode (slides)
    walk(info.tree, (el) => {
      const r = entityRoot(el, ps);
      if (r) addComp(r.entity === "node" ? "node-view-mode" : "paragraph", r.machine, m.path);
      return true;
    });
    for (const v of info.drupal.views) addComp("view", `${v.id}.${v.display}`, m.path);
    for (const b of selectAll("[id^='block-']", info.tree)) addComp("block", String(b.properties?.id), m.path);
    for (const vm of selectAll("[class*='node--view-mode-']", info.tree)) {
      const c = classes(vm).find((x) => x.startsWith("node--view-mode-") && !x.startsWith("node--view-mode--"));
      if (c) addComp("node-view-mode", c.slice(16), m.path);
    }
    for (const l of ["header", "nav", "main", "footer", "aside"]) if (select(l, info.tree)) addComp("landmark", l, m.path);
    for (const s of info.scripts) if (s.src && s.thirdParty) third.set(s.src, { placement: s.placement, blocked: m.network.some((n) => n.url === s.src && n.blocked) });
    images += info.images.length;
    for (const i of info.images) distinct.add(i.path ?? i.src);
    forms += selectAll("main form, [role=main] form", info.tree).length;
    iframes += selectAll("iframe", info.tree).length;
  }
  const byMime: Record<string, number> = {};
  let bytes = 0;
  for (const a of crawl.assets.filter((a) => a.kind === "image")) {
    byMime[a.mime] = (byMime[a.mime] ?? 0) + 1;
    bytes += a.size;
  }
  const broken = Object.values(crawl.links).filter((l) => l.status >= 400 && !(l.replay && l.status === 404)).map((l) => l.path);
  const notCaptured = Object.values(crawl.links).filter((l) => l.replay && l.status === 404).length;
  if (notCaptured) issues.push({ severity: "info", code: "LINK_NOT_CAPTURED", message: `${notCaptured} internal link target(s) are not in the capture store (replay 404) — not checked` });
  for (const b of broken) issues.push({ severity: "warning", code: "BROKEN_LINK", message: `internal link ${b} is broken on the live site`, ref: b, actionable: true });

  const tplCount = templates.size;
  const compCount = [...comps.values()].filter((c) => c.kind === "paragraph").length;
  const factors = { templates: tplCount, paragraphTypes: compCount, views: [...comps.values()].filter((c) => c.kind === "view").length, locales: locales.size, thirdPartyScripts: third.size, iframes, forms };
  const score = Math.round(factors.templates * 2 + factors.paragraphTypes * 1.5 + factors.views * 3 + (factors.locales - 1) * 2 + factors.thirdPartyScripts + factors.iframes * 2 + factors.forms * 3);

  const inventory: HtmlInventory = {
    baseUrl: base,
    generator,
    pages: crawl.pages.length,
    statuses: Object.fromEntries(statuses),
    locales: [...locales.entries()].map(([code, pages]) => ({ code, pages })),
    urlPatterns: [...patterns.entries()].map(([pattern, v]) => ({ pattern, ...v })).sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern)),
    templates: [...templates.entries()].map(([template, v]) => ({ template, bodyClass: v.bodyClass, count: v.paths.length, paths: v.paths.sort() })).sort((a, b) => a.template.localeCompare(b.template)),
    components: [...comps.values()].map((c) => ({ kind: c.kind, id: c.id, count: c.count, pages: c.pages.size })).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
    media: { images, distinctImages: distinct.size, bytes, byMime },
    thirdPartyScripts: [...third.entries()].map(([src, v]) => ({ src, placement: v.placement, blockedDuringCrawl: v.blocked })),
    forms,
    iframes,
    redirects: crawl.index.redirects.length,
    brokenLinks: broken,
    complexity: { score, factors },
  };
  return { inventory, issues };
}

function summaryMd(inv: HtmlInventory): string {
  const lines = [
    `# HTML crawl inventory — ${inv.baseUrl}`,
    "",
    `- Generator: ${inv.generator ?? "unknown"}`,
    `- Pages crawled: ${inv.pages} (${Object.entries(inv.statuses).map(([s, n]) => `${n}× ${s}`).join(", ")})`,
    `- Locales: ${inv.locales.map((l) => `${l.code} (${l.pages})`).join(", ")}`,
    `- Images: ${inv.media.images} references, ${inv.media.distinctImages} distinct, ${(inv.media.bytes / 1024).toFixed(0)} KiB downloaded`,
    `- Redirects seen: ${inv.redirects}; broken internal links: ${inv.brokenLinks.length}`,
    `- Complexity score: ${inv.complexity.score} (${Object.entries(inv.complexity.factors).map(([k, v]) => `${k} ${v}`).join(", ")})`,
    "",
    "## Templates",
    "",
    "| template | body class | pages |",
    "|---|---|---|",
    ...inv.templates.map((t) => `| ${t.template} | ${t.bodyClass} | ${t.paths.join(", ")} |`),
    "",
    "## URL patterns",
    "",
    ...inv.urlPatterns.map((p) => `- \`${p.pattern}\` × ${p.count} (e.g. ${p.examples.join(", ")})`),
    "",
    "## Components",
    "",
    "| kind | id | occurrences | pages |",
    "|---|---|---|---|",
    ...inv.components.filter((c) => c.kind !== "block").map((c) => `| ${c.kind} | ${c.id} | ${c.count} | ${c.pages} |`),
    "",
    "## Third-party scripts",
    "",
    ...(inv.thirdPartyScripts.length ? inv.thirdPartyScripts.map((s) => `- ${s.src} (${s.placement}${s.blockedDuringCrawl ? ", blocked during crawl" : ""})`) : ["- none"]),
    "",
  ];
  return lines.join("\n");
}

export async function analyzeStep(ctx: StepContext): Promise<StepReport> {
  const startedAt = new Date().toISOString();
  const { inventory, issues } = await analyzeHtml(ctx);
  const outputs = ["analysis/html-inventory.json", "analysis/html-SUMMARY.md"];
  if (!ctx.dryRun) {
    await ctx.ws.writeJson(outputs[0], inventory);
    await ctx.ws.writeText(outputs[1], summaryMd(inventory));
  }
  return {
    step: "analyze",
    site: ctx.site.site,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: true,
    dryRun: ctx.dryRun,
    stats: {
      adapter: "html",
      pages: inventory.pages,
      templates: inventory.templates.length,
      paragraphTypes: inventory.components.filter((c) => c.kind === "paragraph").length,
      views: inventory.components.filter((c) => c.kind === "view").length,
      images: inventory.media.distinctImages,
      thirdPartyScripts: inventory.thirdPartyScripts.length,
      complexity: inventory.complexity.score,
    },
    issues,
    outputs,
  };
}

/** Where a CCM type is read from in the crawled markup (mapping/html.yaml `source`). */
function typeSource(t: ContentType, ps: ProfileSet): Record<string, string> {
  const m = t.sourceMeta ?? {};
  const dash = (v: unknown) => String(v).replace(/_/g, "-");
  if (t.kind === "document") return m.bundle ? { bodyClass: `page-node-type-${dash(m.bundle)}`, selector: `article.node--type-${dash(m.bundle)}.node--view-mode-full` } : { selector: "main" };
  if (m.viewMode) return { selector: `.node--view-mode--${dash(m.viewMode)}`, entity: "node" };
  if (m.entity === "block_content") return { selector: "[class*='block-block-content']", entity: "block_content" };
  if (m.paragraphType && m.paragraphType !== "generic") return { selector: ps.entityRoots.find((r) => r.type === m.paragraphType)?.sel ?? `.paragraph--type--${dash(m.paragraphType)}` };
  return { selector: "main > *" };
}

/** proposeMapping (fast path): derive mapping/html.yaml from the inferred CCM schema — deterministic, reviewable. */
export async function proposeMappingStep(ctx: StepContext): Promise<StepReport> {
  const startedAt = new Date().toISOString();
  const crawl = await readCrawl(ctx.ws);
  if (!crawl) throw new Error("raw/html/crawl.json not found — run extract (html adapter) first");
  const { set: ps } = await resolveProfileSet(ctx.ws, ctx.site, crawl, { themePack: (ctx.options as { themePack?: string }).themePack });
  const res = await buildCcm({
    profiles: ps,
    baseUrl: crawl.index.baseUrl,
    pages: crawl.pages,
    assets: crawl.assets,
    links: crawl.links,
    redirects: crawl.index.redirects,
    readText: (rel) => ctx.ws.readText(rel),
    siteLocales: ctx.site.locales,
    origin: crawl.index.origin,
  });
  const mapping = {
    $comment: "Proposed by the html adapter (fast path). Review and commit. Source selectors -> CCM types/fields.",
    adapter: "html",
    baseUrl: crawl.index.baseUrl,
    locales: res.locales.map((l) => ({ code: l.code, default: l.default, pathPrefix: l.pathPrefix })),
    types: Object.fromEntries(
      res.schema.contentTypes.map((t) => [
        t.id,
        {
          kind: t.kind,
          source: typeSource(t, ps),
          fields: Object.fromEntries(
            t.fields.map((f) => [
              f.id,
              {
                type: f.type,
                ...(f.allowedTypes ? { allowedTypes: f.allowedTypes } : {}),
                ...(f.localized ? { localized: true } : {}),
                ...(f.cardinality !== 1 ? { cardinality: f.cardinality } : {}),
                ...(f.sourceMeta?.drupalField ? { source: `.field--name-${String(f.sourceMeta.drupalField).replace(/_/g, "-")}` } : {}),
                ...(f.sourceMeta?.inferred ? { inferred: true, ...(f.sourceMeta.selector ? { source: String(f.sourceMeta.selector) } : {}) } : {}),
              },
            ]),
          ),
        },
      ]),
    ),
    collections: res.collections.map((c) => ({ id: c.id, type: c.type, sort: c.sort, limit: c.limit, inferred: true })),
    navigation: res.navigation.map((n) => n.id),
  };
  const out = "mapping/html.yaml";
  if (!ctx.dryRun) await ctx.ws.writeText(out, stringify(mapping, { lineWidth: 120 }));
  return {
    step: "map",
    site: ctx.site.site,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: true,
    dryRun: ctx.dryRun,
    stats: { adapter: "html", types: res.schema.contentTypes.length, collections: res.collections.length },
    issues: [{ severity: "info", code: "MAPPING_PROPOSED", message: `${out} proposed from the crawl — review before transform`, ref: out }],
    outputs: [out],
  };
}
