/**
 * @cmp/source-html — HTML crawl source adapter (MIGRATION_PLAN.md §5.1 #5, §12 Phase 1a).
 *
 *   extract       Playwright crawl -> raw/html/ + design/screenshots/
 *   analyze       inventory -> analysis/html-inventory.json, analysis/html-SUMMARY.md
 *   proposeMapping  mapping/html.yaml (deterministic, from the inferred schema)
 *   toCCM         fast path: crawl -> ccm/ (Drupal markup -> same CCM ids as @cmp/source-drupal); content from the RAW
 *                 server HTML, theme-printed values via paragraph profiles (site mapping/profiles.yaml > themes/<id>.yaml > generic), html
 *                 fallback for the rest
 */
import { guardedFetch } from "@harness/mirror-core";
import type { SourceAdapter, SourceInfo, StepContext, StepReport } from "@harness/mirror-core";
import { crawlSite, fetchChain, FETCH_TIMEOUT_MS, type CrawlOptions } from "./crawl.js";
import { analyzeStep, proposeMappingStep } from "./analyze.js";
import { htmlToCcmStep } from "./to-ccm.js";

export * from "./crawl.js";
export * from "./interactions.js";
export {
  parsePage,
  normalizeTree,
  decodeCfEmail,
  mainContentRoot,
  bundleToType,
  paragraphToType,
  fieldNameToId,
  machineName,
  type PageInfo,
  type MenuItemInfo,
  type MenuItemExtra,
  type MenuInfo,
  type BlockInfo,
  type SocialLinkInfo,
  type ScriptInfo,
} from "./page.js";
export {
  buildCcm,
  htmlToCcmStep,
  pageCcmId,
  sectionCcmId,
  assetCcmId,
  termCcmId,
  blockCcmId,
  collectionId,
  collectionFieldValue,
  classifyField,
  fieldInfo,
  entityRoot,
  type FieldKind,
  type ToCcmResult,
  type BuildCcmInput,
} from "./to-ccm.js";
export { preferRenderedContent, pageContentHtml, isServerHtml } from "./content-source.js";
export {
  PARAGRAPH_PROFILES,
  ENTITY_ROOTS,
  CLASS_FIELDS,
  SLOT_KINDS,
  DEFAULT_PROFILE_SET,
  GENERIC_PROFILE_SET,
  GENERIC_PACK,
  THEMES_DIR,
  ProfilePackSchema,
  ParagraphProfileSchema,
  SlotDefSchema,
  SlotSchema,
  EntityRootSchema,
  ClassFieldSchema,
  ListItemSpecSchema,
  isValidSelector,
  parseProfilePack,
  themePacks,
  themePack,
  mergeProfilePacks,
  profileSetFor,
  detectThemes,
  packForThemes,
  slotDef,
  type ParagraphProfile,
  type PackProfile,
  type ProfilePack,
  type ProfileSet,
  type EntityRootDef,
  type ClassFieldDef,
  type ListItemSpec,
  type SlotDef,
  type SlotKind,
} from "./profiles.js";
export { resolveProfileSet, readSiteProfiles, SITE_PROFILES_PATH, type ResolvedProfiles } from "./theme-pack.js";
export {
  analyzeCoverage,
  inferProfiles,
  mergeIntoSitePack,
  skeletonOf,
  prunedSkeletonOf,
  documentDossierParts,
  loadCoverageInput,
  readCcmEntries,
  measureTextCoverage,
  simulateCoverage,
  coverageRatio,
  pageCoverageRatio,
  unmappedTextIssues,
  DOCUMENT_TEXT_UNMAPPED,
  type CoverageFinding,
  inferProfilesIterative,
  type InferRound,
  type UncoveredElement,
  type CoverageGroup,
  type TextCoverage,
  type CoverageAnalysis,
  type CoveragePage,
  type CoverageInput,
  type InstanceRef,
  type InferResult,
  type InferredSlot,
} from "./infer.js";
export { analyzeHtml, analyzeStep, proposeMappingStep, type HtmlInventory } from "./analyze.js";
export * as dom from "./dom.js";
export * as testing from "./testing.js";
export { STYLE_PROPS, KEY_ELEMENTS } from "./browser.js";

/** extract step: crawl with options from ctx.options (urls, follow, maxPages, viewports, mask, screenshots). */
export async function extractStep(ctx: StepContext): Promise<StepReport> {
  const startedAt = new Date().toISOString();
  const o = ctx.options as Partial<CrawlOptions>;
  const res = await crawlSite(ctx, {
    urls: o.urls,
    follow: o.follow,
    maxPages: o.maxPages,
    viewports: o.viewports,
    mask: o.mask,
    screenshots: o.screenshots,
    blockThirdParty: o.blockThirdParty,
  });
  const poc = (ctx.site.urls ?? []).length;
  const crawledPoc = (ctx.site.urls ?? []).filter((u) => res.index.pages.some((p) => p.requested.includes(u) || p.path === u)).length;
  const incomplete = res.issues.filter((i) => i.code === "CRAWL_PAGE_INCOMPLETE").length;
  return {
    step: "extract",
    site: ctx.site.site,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: !res.issues.some((i) => i.severity === "error"),
    dryRun: ctx.dryRun,
    stats: {
      adapter: "html",
      pages: res.pages.length,
      screenshots: res.pages.reduce((n, p) => n + Object.keys(p.screenshots).length, 0),
      assets: res.assets.length,
      redirects: res.index.redirects.length,
      linksProbed: Object.keys(res.links).length,
      failed: res.index.failed.length,
    },
    issues: res.issues,
    outputs: res.outputs,
    gates: {
      "crawl.pocUrls": { pass: crawledPoc === poc, value: crawledPoc, threshold: poc },
      // a source page that never finished rendering is not a usable parity baseline (crawl.ts pageCompleteness)
      "crawl.pagesComplete": { pass: incomplete === 0, value: incomplete, threshold: 0 },
    },
  };
}

export const htmlAdapter: SourceAdapter = {
  id: "html",
  async detect(ctx: StepContext): Promise<SourceInfo> {
    const base = ctx.site.baseUrl.replace(/\/+$/, "");
    const capabilities = ["crawl", "screenshots", "computed-styles", "assets", "fast-path-ccm"];
    try {
      const res = await guardedFetch(base + "/", { headers: { "user-agent": "cmp-crawler" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const html = await res.text();
      const gen = /<meta name="Generator" content="([^"]+)"/i.exec(html)?.[1] ?? res.headers.get("x-generator") ?? undefined;
      const drupal = /drupal/i.exec(gen ?? "") ? /Drupal (\d+)/i.exec(gen ?? "")?.[1] : undefined;
      const sitemap = await fetchChain(base + "/sitemap.xml", { method: "HEAD" }).catch(() => undefined);
      return {
        system: drupal ? "drupal" : "html",
        version: drupal,
        capabilities: [...capabilities, ...(sitemap?.status === 200 ? ["sitemap"] : []), ...(drupal ? ["drupal-markup"] : [])],
        details: { status: res.status, generator: gen, lang: /<html[^>]*\slang="([^"]+)"/i.exec(html)?.[1] },
      };
    } catch (e) {
      return { system: "html", capabilities, details: { error: (e as Error).message } };
    }
  },
  extract: extractStep,
  analyze: analyzeStep,
  proposeMapping: proposeMappingStep,
  toCCM: htmlToCcmStep,
};
