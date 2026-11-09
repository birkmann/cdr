/**
 * @cmp/design — `migrate design extract` (MIGRATION_PLAN.md §7.1): tokens, style port, component mining, templates.
 *
 * Input: the html crawl (raw/html/, crawled on demand if missing or ctx.options.recrawl).
 * Output (workspace design/): manifest.json, tokens.json, styles/*.css, assets/**, scripts/*.js,
 * components/<id>.json, templates/<ccmType>.json, layouts/default.json (+ screenshots/ from the crawl).
 */
import { readCcm, type Issue, type StepContext, type StepReport } from "@harness/mirror-core";
import { bundleToType, crawlSite, dom, mainContentRoot, parsePage, readCrawl, resolveProfileSet, type PageInfo } from "@harness/mirror-capture";
import { extractTokens } from "./tokens.js";
import { portStyles, type StyleEntry } from "./styles.js";
import { portScripts, type ScriptEntry } from "./scripts.js";
import { AssetLoader } from "./assets.js";
import { mineComponents, isRichDrupalTheme, type ComponentDef, type MinePage, type PageDesign } from "./mine.js";
import { refineWithLlm } from "./llm.js";
import { reconcileWithCcm } from "./reconcile.js";
import { applyDesignOverrides, readOverrides } from "./overrides.js";

/** manifest stylesheet list where CSS-in-JS server blocks keep their data-styled/data-emotion marker */
function withCssInJsMarkers(styles: { stylesheets: string[]; pageStyles: Record<string, StyleEntry[]> }): DesignManifest["stylesheets"] {
  const marked = new Map<string, Record<string, string>>();
  for (const list of Object.values(styles.pageStyles)) for (const e of list) if (e.attrs && Object.keys(e.attrs).some((k) => /^data-(styled|emotion)/.test(k))) marked.set(e.href, e.attrs as Record<string, string>);
  return styles.stylesheets.map((href) => (marked.has(href) ? { href, role: "inline" as const, original: "inline" as const, attrs: marked.get(href)! } : href));
}

/** Distinct custom elements (`<c4d-card>`) a page needs before it counts as built from web components. */
const WEB_COMPONENT_TAGS = 8;
/** external scripts the page loads (not trackers): the site's own JS that renders or upgrades its markup */
function sameSiteScripts(info: PageInfo): number {
  return info.scripts.filter((sc) => !!sc.src && !/googletagmanager|google-analytics|gtag\/js|adobedtm|tiqcdn|tealium|hotjar|clarity\.ms|segment\.(io|com)|doubleclick|facebook\.net|cookiebot|onetrust|didomi|usercentrics|consent/i.test(sc.src)).length;
}
function customElementTags(tree: dom.Root): number {
  return new Set(dom.selectAll("*", tree).map((e) => e.tagName).filter((t) => /^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(t))).size;
}

export { extractTokens, toHex, toPx, type TokenTree } from "./tokens.js";
export { portStyles, type StylePortResult, type StyleEntry } from "./styles.js";
export { portScripts, type ScriptPortResult, type ScriptEntry } from "./scripts.js";
export { AssetLoader } from "./assets.js";
export { mineComponents, normalizeHtml, detectDateFormat, isRichDrupalTheme, isEntity, entityIdOf, scopeItem, type ComponentDef, type PropDef, type TemplateDef, type LayoutDef, type MinePage, type MineResult, type PageDesign } from "./mine.js";
export { renderTemplate, parseTemplate, templatePaths, escapeHtml } from "./render.js";
export { refineWithLlm, skeletonOf } from "./llm.js";
export { renderDesignPage, loadDesign, startDesignPreview, type DesignBundle } from "./preview.js";
export { reconcileWithCcm, type ReconcileStats } from "./reconcile.js";
export {
  applyOverrides,
  applyDesignOverrides,
  readOverrides,
  writeDesignBase,
  restoreLazySrc,
  overridesHash,
  ComponentOverride,
  PageOverride,
  PagesOverride,
  AssetsOverride,
  ScriptsOverride,
  ScriptRule,
  SITE_CSS_HREF,
  BASE_DIR as DESIGN_BASE_DIR,
  OVERRIDES_DIR as DESIGN_OVERRIDES_DIR,
  type DesignOverrides,
  type DesignDocs,
  type ApplyResult,
} from "./overrides.js";

export interface DesignManifest {
  baseUrl: string;
  viewports: { name: string; width: number; height: number }[];
  /** design-relative hrefs; static sites: a CSS-in-JS block as { href, role: "inline", attrs } (inlined with its marker) */
  stylesheets: (string | { href: string; role: "inline"; original: "inline"; attrs: Record<string, string> })[];
  fonts: string[];
  scripts: { src: string; placement: "head" | "body"; original?: string; role?: string; type?: string; attrs?: Record<string, string> }[];
  components: { id: string; file: string; kind: string; ccmType?: string }[];
  templates: { contentType: string; file: string }[];
  layouts: { id: string; file: string }[];
  tokensFile: "tokens.json";
  favicon?: string;
  images: string[];
  screenshots: Record<string, string[]>;
  mask: string[];
  locales: string[];
  defaultLocale: string;
  /** how CCM rich text should be rendered to match the original markup */
  richText: { embeddedAsset?: string; listItemParagraphs: boolean };
  source: "heuristic" | "llm";
  /**
   * Per-page asset sets (Drupal loads different CSS/JS aggregates per page; load exactly ONE set per page, in order —
   * mixing sets re-runs core/misc/drupal.js and re-orders the cascade). `stylesheets`/`scripts` above = the set of
   * the canonical page (rich sites) or the union (simple sites).
   */
  assetSets?: Record<string, AssetSet>;
  /** crawled page path -> rendering hints (asset set, content type, body class, variant components, layout variant) */
  pages?: Record<string, PageDesign & { assetSet: string }>;
  /** content type -> default asset set for pages that were not crawled */
  contentTypes?: Record<string, { assetSet: string; examplePath: string }>;
  /** <link rel=preload as=font> of the original pages */
  preload?: { href: string; as: "font"; type?: string; crossorigin?: string }[];
  /** scripts/styles deliberately not ported (trackers, clickjacking guards, print CSS) */
  excluded?: { original: string; reason: string; placement?: "head" | "body" }[];
  /** licensing note for ported fonts */
  fontsNote?: string;
}

export interface AssetSet {
  id: string;
  pages: string[];
  /** ordered: href (design-relative or absolute), media, attrs (e.g. class "darkreader darkmode-css") */
  stylesheets: StyleEntry[];
  /** ordered, head first: drupalSettings block (role "settings", type application/json), jQuery, aggregates, vendor … */
  scripts: ScriptEntry[];
  /** drupalSettings JSON (design-relative) */
  settings?: string;
}

function localeOf(info: PageInfo, path: string, codes: string[], prefixes: Map<string, string>, def: string): string {
  if (info.lang && codes.includes(info.lang)) return info.lang;
  for (const [code, pre] of prefixes) if (pre && (path === `/${pre}` || path.startsWith(`/${pre}/`))) return code;
  return info.lang?.split("-")[0] ?? def;
}

/**
 * PageInfo of the server HTML with the tree exactly as served: parsePage normalises its tree for content extraction
 * (lazy-image src, Cloudflare e-mails); the design must keep what the ported JS (blazy, email-decode) transforms.
 */
export function serverPageInfo(html: string, path: string, base: string): PageInfo {
  const info = parsePage(html, path, base);
  const tree = dom.parseDocument(html);
  return { ...info, tree, main: mainContentRoot(tree) };
}

/** CCM type of the synthetic listing-page entry (Collection with `path`) in the generated app */
export const LISTING_TYPE = "collection";
const normPath = (p: string) => (p.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/");

/** path -> CCM type of the routable document entries (empty without ccm/) */
async function ccmDocumentTypesByPath(ws: StepContext["ws"]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!(await ws.exists("ccm/schema/content-types.json"))) return out;
  try {
    const bundle = await readCcm(ws, { strict: false });
    const kinds = new Map(bundle.schema.contentTypes.map((t) => [t.id, t.kind ?? "document"]));
    for (const e of bundle.entries) if (e.path && kinds.get(e.type) === "document" && !out.has(normPath(e.path))) out.set(normPath(e.path), e.type);
  } catch {
    /* unreadable ccm/: no hints */
  }
  return out;
}

/** mined issues of the last full design extract (carried into the apply-overrides fast path's report) */
const BASE_ISSUES = "design/base/issues.json";

export const designExtract = async (ctx: StepContext): Promise<StepReport> => {
  const { ws, site, log } = ctx;
  const startedAt = new Date().toISOString();
  const issues: Issue[] = [];
  const outputs: string[] = [];
  const out = async (rel: string, data: unknown) => {
    if (!ctx.dryRun) await ws.writeJson(rel, data);
    outputs.push(rel);
  };

  // fast path (parity loop): re-apply design/overrides/* onto design/base/ — no crawl, no mining, no asset fetches
  if (ctx.options.applyOverridesOnly === true || ctx.options.fromCache === "overrides") {
    // the mined issues of the last full extract (design/base/issues.json) stay open, minus those about a component or
    // page an override now patches (the loop keys on them: COMPONENT_VARIANT, COMPONENT_DEGRADED, ...)
    const mined = (await ws.exists(BASE_ISSUES)) ? await ws.readJson<Issue[]>(BASE_ISSUES).catch(() => [] as Issue[]) : [];
    const r = await applyDesignOverrides(ws, { dryRun: ctx.dryRun });
    const { overrides } = await readOverrides(ws.path("design"));
    const patched = new Set([...Object.keys(overrides.components), ...Object.keys(overrides.pages)]);
    const carried = mined.filter((i) => !i.ref || !patched.has(i.ref));
    return {
      step: "design-extract",
      site: site.site,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: !r.issues.some((i) => i.severity === "error"),
      dryRun: ctx.dryRun,
      stats: { mode: "apply-overrides", ...r.stats, minedIssuesCarried: carried.length },
      issues: [...carried, ...r.issues],
      outputs: r.outputs,
      gates: r.gates,
    };
  }

  let crawl = ctx.options.recrawl ? undefined : await readCrawl(ws);
  if (!crawl) {
    log.info("no crawl found — crawling site.urls first");
    const r = await crawlSite(ctx, { screenshots: true });
    issues.push(...r.issues);
    outputs.push(...r.outputs);
    crawl = { index: r.index, pages: r.pages, assets: r.assets, links: r.links };
  }
  const base = crawl.index.baseUrl;
  const cfgLocales = site.locales ?? [];
  const def = cfgLocales.find((l) => l.default)?.code ?? cfgLocales[0]?.code ?? "en";
  const prefixes = new Map(cfgLocales.map((l) => [l.code, (l.pathPrefix ?? (l.code === def ? "" : l.code)).replace(/^\/+|\/+$/g, "")]));
  const pages: MinePage[] = [];
  const docTypes = await ccmDocumentTypesByPath(ws);
  for (const m of crawl.pages.filter((p) => p.status === 200)) {
    const info = parsePage(await ws.readText(m.files.rendered), m.path, base);
    // Views page displays: the CCM document at that path (if an adapter emits one), else the listing page type
    // `collection` (the generated app routes Collection.path to a synthetic `collection` entry)
    const ccmType = info.template.startsWith("node:")
      ? bundleToType(info.drupal.nodeType!)
      : info.template === "generic" || info.template === "front"
        ? "page"
        : info.template.startsWith("view:")
          ? (docTypes.get(normPath(m.path)) ?? LISTING_TYPE)
          : undefined;
    const rawHtml = await ws.readText(m.files.raw).catch(() => "");
    const rawInfo = rawHtml ? serverPageInfo(rawHtml, m.path, base) : undefined;
    pages.push({ path: m.path, locale: localeOf(info, m.path, [...prefixes.keys()], prefixes, def), info, ccmType, rawInfo });
  }
  if (!pages.length) throw new Error("no crawled pages with status 200 — run extract first");
  const locales = [...new Set(pages.map((p) => p.locale))].sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));

  // tokens
  const { tokens, stats: tokenStats } = extractTokens(crawl.pages, crawl.index.viewports);
  await out("design/tokens.json", tokens);

  // style + script port (rich Drupal themes: the server HTML in document order, per page)
  const rich = pages.some((p) => isRichDrupalTheme(p.rawInfo ?? p.info));
  // Web-component sites (Lit/Stencil design systems: <c4d-card>, <cds-button>…) render only when their own JS upgrades
  // the server markup. Like rich Drupal themes they are mined from the server HTML and rendered statically (original
  // JS runs once against it); mining the rendered DOM would let that JS add its output a second time.
  const webComponents = !rich && pages.some((p) => !!p.rawInfo && customElementTags(p.rawInfo.tree) >= WEB_COMPONENT_TAGS);
  // JS-rendered sites (React/Vue feature apps, viewport-dependent markup) look like the original at every viewport only
  // when their own scripts run against the server HTML. A Next.js source is the exception: its runtime (/_next/) would
  // collide with the generated Next.js app, so it is rendered from the browser-rendered DOM instead (react mode).
  const nextRuntime = pages.some((p) => (p.rawInfo ?? p.info).scripts.some((sc) => !!sc.src && /\/_next\/static\//.test(sc.src)));
  const jsApp = !rich && !webComponents && !nextRuntime && pages.some((p) => !!p.rawInfo && sameSiteScripts(p.rawInfo) > 0);
  const serverHtml = rich || webComponents || jsApp;
  const styleTrees = pages.map((p) => ({ path: p.path, tree: (serverHtml ? (p.rawInfo ?? p.info) : p.info).tree, rawTree: p.rawInfo?.tree }));
  const loader = new AssetLoader(ws, base, crawl.assets, { fetch: rich && ctx.options.fetchAssets !== false });
  const styles = await portStyles(ws, { baseUrl: base, pages: styleTrees, assets: crawl.assets, dryRun: ctx.dryRun, rich, loader });
  issues.push(...styles.issues);
  outputs.push(...styles.outputs);
  const scripts = await portScripts(ws, { baseUrl: base, pages: styleTrees, loader, dryRun: ctx.dryRun, rich, inline: serverHtml });
  issues.push(...scripts.issues);
  outputs.push(...scripts.outputs);
  // one info line for the HTTP misses of the site (details per asset in STYLE_ASSET_MISSING / SCRIPT_NOT_DOWNLOADED)
  const httpMisses = loader.issues.filter((i) => i.code === "DESIGN_ASSET_HTTP");
  if (httpMisses.length) issues.push({ severity: "info", code: "DESIGN_ASSET_HTTP", message: `${httpMisses.length} asset request(s) to ${base} failed (e.g. ${httpMisses.slice(0, 3).map((i) => i.ref).join(", ")})` });
  issues.push(...loader.issues.filter((i) => i.code !== "DESIGN_ASSET_HTTP" && i.code !== "DESIGN_ASSET_FETCH_FAILED"));
  if (loader.networkErrors)
    issues.push({ severity: "error", code: "DESIGN_SITE_UNREACHABLE", message: `${loader.networkErrors} asset fetch(es) to ${base} failed at the network level — is the site/replay running? The style/script port is incomplete.`, ref: base, actionable: true });

  // components + templates
  // rich Drupal themes: mine the server HTML (the ported behaviours transform it in the browser exactly like on the source)
  const minePages = serverHtml ? pages.map((p) => ({ ...p, info: p.rawInfo ?? p.info })) : pages;
  // profile set (site mapping/profiles.yaml > theme pack > generic), honours source.themePack / options.themePack
  const prof = await resolveProfileSet(ws, site, { pages: crawl.pages, assets: crawl.assets }, { themePack: ctx.options.themePack as string | undefined });
  issues.push(...prof.issues);
  const mined = mineComponents(minePages, { defaultLocale: def, rich, profiles: prof.set });
  issues.push(...mined.issues);
  let source: "heuristic" | "llm" = "heuristic";
  if (ctx.options.llm === true) {
    const r = await refineWithLlm(ctx, mined.components);
    issues.push(...r.issues);
    if (r.refined) source = "llm";
  }
  // bind props to the content track's CCM fields by value (when ccm/ exists)
  const rec = rich ? await reconcileWithCcm(ws, mined.components, { locale: def }) : undefined;
  if (rec) issues.push(...rec.issues);

  const screenshots: Record<string, string[]> = {};
  for (const p of crawl.pages) for (const [vp, file] of Object.entries(p.screenshots)) (screenshots[vp] ??= []).push(file.replace(/^design\//, ""));
  for (const v of Object.values(screenshots)) v.sort();
  // asset sets: pages with identical style + script lists share one
  const assetSets: Record<string, AssetSet> = {};
  const pageSet: Record<string, string> = {};
  const sortedPages = [...pages].sort((a, b) => (a.locale === def ? 0 : 1) - (b.locale === def ? 0 : 1) || a.path.localeCompare(b.path));
  for (const p of sortedPages) {
    const st = styles.pageStyles[p.path] ?? [];
    const sc = scripts.pageScripts[p.path] ?? [];
    const key = JSON.stringify([st, sc]);
    let id = Object.values(assetSets).find((x) => JSON.stringify([x.stylesheets, x.scripts]) === key)?.id;
    if (!id) {
      id = p.path === "/" ? "home" : p.path.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9._-]+/g, "_");
      assetSets[id] = { id, pages: [], stylesheets: st, scripts: sc, ...(scripts.pageSettings[p.path] ? { settings: scripts.pageSettings[p.path] } : {}) };
    }
    assetSets[id].pages.push(p.path);
    pageSet[p.path] = id;
  }
  const canonSet = sortedPages[0] ? assetSets[pageSet[sortedPages[0].path]] : undefined;
  const contentTypes: NonNullable<DesignManifest["contentTypes"]> = {};
  for (const p of sortedPages) if (p.ccmType && !contentTypes[p.ccmType]) contentTypes[p.ccmType] = { assetSet: pageSet[p.path], examplePath: p.path };
  // theme fonts (not icon fonts, not Google/OFL fonts) are the brand's licensed typefaces
  const brandFonts = styles.fonts.filter((f) => /\/themes\/custom\//.test(f) && !/icomoon|glyphicons|fontawesome|font-awesome|slick|icons?[-_.]/i.test(f));

  const manifest: DesignManifest = {
    baseUrl: base,
    viewports: crawl.index.viewports,
    stylesheets: rich && canonSet ? canonSet.stylesheets.map((e) => e.href) : serverHtml ? withCssInJsMarkers(styles) : styles.stylesheets,
    fonts: styles.fonts,
    scripts: rich && canonSet ? canonSet.scripts.filter((e) => e.role !== "settings").map((e) => ({ src: e.src, placement: e.placement, original: e.original, role: e.role, ...(e.type ? { type: e.type } : {}), ...(e.attrs ? { attrs: e.attrs } : {}) })) : scripts.scripts,
    components: mined.components.map((c: ComponentDef) => ({ id: c.id, file: `components/${c.id}.json`, kind: c.kind, ...(c.ccmType ? { ccmType: c.ccmType } : {}) })),
    templates: mined.templates.map((t) => ({ contentType: t.contentType, file: `templates/${t.contentType}.json` })),
    layouts: mined.layout ? [{ id: "default", file: "layouts/default.json" }] : [],
    tokensFile: "tokens.json",
    ...(styles.favicon ? { favicon: styles.favicon } : {}),
    images: styles.images,
    screenshots,
    mask: crawl.index.mask,
    locales,
    defaultLocale: def,
    richText: {
      ...(mined.components.some((c) => c.id === "embeddedMedia") ? { embeddedAsset: "embeddedMedia" } : {}),
      // Drupal body markup has <li>text</li>, not <li><p>text</p></li>
      listItemParagraphs: pages.some((p) => !!p.info.main && dom.selectAll(".text-content li > p, .text-formatted li > p", p.info.main).length > 0),
    },
    source,
    ...(webComponents || jsApp ? { renderMode: "static" as const } : {}),
    ...(rich
      ? {
          assetSets,
          pages: Object.fromEntries(sortedPages.map((p) => [p.path, { ...(mined.pages[p.path] ?? { locale: p.locale, components: {} }), assetSet: pageSet[p.path] }])),
          contentTypes,
          preload: styles.preload,
          excluded: [...styles.excluded, ...scripts.excluded],
          ...(brandFonts.length ? { fontsNote: `Brand fonts (${[...new Set(brandFonts.map((f) => f.split("/").pop()!.replace(/\.[a-z0-9]+$/i, "")))].join(", ")}) are licensed by the site owner: local POC use only — do not publish or redistribute.` } : {}),
        }
      : {}),
  };
  // mined result → design/base/, then design/overrides/* merged over it → design/{manifest,components,templates,layouts}
  const merged = await applyDesignOverrides(ws, {
    base: { manifest: manifest as unknown as Record<string, unknown>, components: mined.components as unknown as Record<string, unknown>[], templates: mined.templates as unknown as Record<string, unknown>[], layout: mined.layout as unknown as Record<string, unknown> | undefined },
    dryRun: ctx.dryRun,
  });
  // mined issues (before the override merge) for the fast path's report
  if (!ctx.dryRun) await ws.writeJson(BASE_ISSUES, issues);
  issues.push(...merged.issues);
  outputs.push(...(ctx.dryRun ? ["design/base/", ...mined.components.map((c) => `design/components/${c.id}.json`), ...mined.templates.map((t) => `design/templates/${t.contentType}.json`), "design/manifest.json"] : merged.outputs));

  const unverified = mined.components.filter((c) => !c.verified).map((c) => c.id);
  const degraded = mined.components.filter((c) => c.degraded).map((c) => c.id);
  return {
    step: "design-extract",
    site: site.site,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: !issues.some((i) => i.severity === "error"),
    dryRun: ctx.dryRun,
    stats: {
      pages: pages.length,
      components: mined.components.length,
      chrome: mined.components.filter((c) => c.kind === "chrome").length,
      sections: mined.components.filter((c) => c.kind === "section").length,
      documents: mined.components.filter((c) => c.kind === "document").length,
      templates: mined.templates.length,
      stylesheets: styles.stylesheets.length,
      fonts: styles.fonts.length,
      ...(rich
        ? {
            assetSets: Object.keys(assetSets).length,
            scripts: new Set(Object.values(scripts.pageScripts).flat().map((e) => e.src)).size,
            excludedScripts: scripts.excluded.length,
            excludedStyles: styles.excluded.length,
            fetchedAssets: loader.fetched,
            degradedComponents: degraded.length,
            variantComponents: mined.components.filter((c) => c.variantOf).length,
            instancesVerified: mined.components.reduce((n, c) => n + (c.instancesVerified ?? 0), 0),
            ...(rec ? { ccmComponentsMatched: rec.stats.componentsMatched, ccmPropsBound: rec.stats.propsBound, ccmPropsUnbound: rec.stats.propsUnbound, ccmTypesAligned: rec.stats.typesAligned } : {}),
            instances: mined.components.reduce((n, c) => n + c.instances, 0),
          }
        : {}),
      ...tokenStats,
      ...merged.stats,
      themePack: prof.set.id,
      source,
    },
    issues,
    outputs,
    // over the merged components (an override may fix or break reproducibility); equals the mined gate without overrides
    gates: ctx.dryRun ? { "design.componentsReproducible": { pass: unverified.length === 0, value: mined.components.length - unverified.length, threshold: mined.components.length } } : merged.gates,
  };
};
