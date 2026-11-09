import type { Asset, Entry, Issue, Locale, Logger, Redirect, SiteConfig, SiteSettings, Workspace, CcmSchemaFile, RichTextDoc } from "@harness/mirror-core";
import type { Browser } from "playwright";
import type { CaptureContextOptions } from "./capture.js";

export type GateResult = { pass: boolean; value?: number | string; threshold?: number | string };

/** Result of one verify check; persisted as verify/<check>.json. */
export interface CheckResult {
  check: string;
  ok: boolean;
  stats: Record<string, number | string | boolean>;
  issues: Issue[];
  gates: Record<string, GateResult>;
  details: unknown;
}

/** CCM data as read from the workspace (lenient, no Zod validation). */
export interface CcmData {
  schema: CcmSchemaFile | undefined;
  entries: Entry[];
  assets: Asset[];
  redirects: Redirect[];
  locales: Locale[];
  settings: SiteSettings | undefined;
}

export interface PageResult {
  url: string;
  status: number; // 0 = network error
  finalUrl: string;
  redirected: boolean;
  contentType: string;
  html: string; // "" for non-HTML
  error?: string;
}

export interface CrawledPage {
  path: string;
  page: PageResult;
}

/** Crawl-time record of a POC page (html adapter `raw/html/pages/<id>.json`), see VerifyContext.crawlPage. */
export interface CrawlPageRecord {
  path: string;
  /** internal link paths of the page as crawled (rendered DOM), normalised */
  links: string[];
  /** full-page screenshot per viewport name (workspace-relative), the crawler baseline */
  screenshots: Record<string, string>;
  /** document height per viewport name at crawl time */
  documentHeight: Record<string, number>;
  /** the HTML the pipeline took the page content from (server HTML, or the rendered DOM for client-rendered pages) */
  contentHtml(): Promise<string>;
  /** true when that content came from the rendered DOM */
  rendered: boolean;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** page path -> internal link targets found on it (absolute URLs on the new origin) */
  links: Map<string, string[]>;
}

export type Side = "old" | "new";

export interface VerifyContext {
  site: SiteConfig;
  ws: Workspace;
  log: Logger;
  options: Record<string, unknown>;
  oldBaseUrl: string;
  newBaseUrl: string;
  /** POC url paths */
  urls: string[];
  ccm: CcmData;
  /** published entries that have a path (routable), deduped by path */
  routable: Entry[];
  /** POC urls ∪ routable paths, deduped, stable order */
  allPaths: string[];
  /** routable teaser-stub entries (source.kind "teaser"): link targets only, not page-parity scope */
  stubPaths: string[];
  /** mask selectors (site.crawl.mask) */
  mask: string[];
  /** browser-context guard shared by both sides (allowed hosts, forbidden production origin) */
  capture: CaptureContextOptions;
  /** production origin of a captured site (never contacted), if any */
  productionOrigin?: string;
  /** hosts treated as "this site" when normalising URLs (old, new, baseUrl, settings.baseUrl, production origin) */
  knownHosts: string[];
  normalizeText(s: string): string;
  plainText(doc: RichTextDoc): string;
  fetchPage(side: Side, path: string): Promise<PageResult>;
  /**
   * POC paths whose content the pipeline took from the browser-rendered DOM (client-rendered Next.js pages,
   * @cmp/source-html content-source.ts): `fetchPage("old", …)` renders the original in a browser for them instead of
   * fetching the server HTML, so the old side shows the same content state the migrated page was built from.
   */
  renderedOldPaths: string[];
  /**
   * What the original showed when the pipeline read it (html crawl manifest of a POC page), or undefined without a
   * crawl. A live original keeps changing (news teasers, disruption tickers): a difference between the live page and
   * the new site that is NOT a difference to the crawl-time capture is source drift, not a migration defect — the checks
   * report it as SOURCE_DRIFT and judge the shot/page against the capture instead.
   */
  crawlPage(path: string): CrawlPageRecord | undefined;
  crawlNew(): Promise<CrawlResult>;
  browser(): Promise<Browser>;
  /** host-normalise a URL to path+search when it points to one of the known site hosts */
  hostNormalize(url: string, force?: boolean): string;
  close(): Promise<void>;
}

export type CheckFn = (cx: VerifyContext) => Promise<CheckResult>;
