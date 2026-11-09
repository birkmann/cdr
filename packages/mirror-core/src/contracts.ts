/**
 * Cross-package contracts: site config, step context/report, adapter interfaces, LLM client.
 * FROZEN CONTRACT (additive changes only, note them in docs/adr/0001-ccm-contract.md).
 */
import { z } from "zod";
import type { Workspace } from "./workspace.js";
import type { CcmSchemaFile } from "./ccm.js";

// ---------------------------------------------------------------- sites/<site>.yaml

export const Viewport = z.object({ name: z.string(), width: z.number().int(), height: z.number().int() });
export const DEFAULT_VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

export const SiteConfig = z.object({
  site: z.string(), // slug, also the workspace dir name
  name: z.string().optional(),
  baseUrl: z.string().url(), // live (or local fixture) site
  /** POC URLs (paths) — crawl seeds; crawler also follows sitemap/menu if crawl.follow */
  urls: z.array(z.string()).default(["/"]),
  locales: z
    .array(z.object({ code: z.string(), name: z.string().optional(), default: z.boolean().optional(), fallback: z.string().optional(), pathPrefix: z.string().optional() }))
    .default([{ code: "en", default: true }]),
  source: z
    .object({
      adapter: z.enum(["drupal", "html"]).default("drupal"),
      drupal: z
        .object({
          version: z.string().optional(), // "7" | "9" | "10" | "11"
          jsonapiUrl: z.string().optional(), // default `${DRUPAL_BASE_URL}/jsonapi`
          extractors: z.array(z.enum(["jsonapi", "drush", "sql", "fixture"])).default(["jsonapi"]),
          /** for tests / offline: directory with recorded JSON:API responses */
          fixtureDir: z.string().optional(),
          /**
           * drush extractor: command ("drush", "vendor/bin/drush", "ddev drush"), working dir (repo-relative, e.g. the DDEV
           * project), --root/--uri, and `inline` (no shared files: php:eval dumps on stdout; default on for ddev/lando/docker/@alias)
           */
          drush: z.object({ command: z.string().optional(), cwd: z.string().optional(), root: z.string().optional(), uri: z.string().optional(), inline: z.boolean().optional() }).optional(),
        })
        .default({ extractors: ["jsonapi"] }),
      /**
       * html adapter: theme pack with paragraph profiles (packages/adapters/source-html/themes/<id>.yaml).
       * "auto" (default) = detect from /themes/custom/<theme>/ asset paths, "none" = generic extraction only.
       */
      themePack: z.string().optional(),
    })
    .default({ adapter: "drupal", drupal: { extractors: ["jsonapi"] } }),
  crawl: z
    .object({
      follow: z.boolean().default(false),
      maxPages: z.number().int().default(50),
      viewports: z.array(Viewport).default(DEFAULT_VIEWPORTS),
      /** CSS selectors masked in screenshots (cookie banners, carousels, dates) */
      mask: z.array(z.string()).default([]),
    })
    .default({ follow: false, maxPages: 50, viewports: DEFAULT_VIEWPORTS, mask: [] }),
  target: z
    .object({
      adapter: z.literal("contentful").default("contentful"),
      contentful: z
        .object({
          spaceIdEnv: z.string().default("CONTENTFUL_SPACE_ID"),
          environment: z.string().optional(), // default CONTENTFUL_ENVIRONMENT or migration-<date>
          taxonomyMode: z.enum(["contentType", "tags"]).default("contentType"),
          rawHtmlMode: z.enum(["htmlBlockEntry", "textField"]).default("htmlBlockEntry"),
        })
        .default({ spaceIdEnv: "CONTENTFUL_SPACE_ID", taxonomyMode: "contentType", rawHtmlMode: "htmlBlockEntry" }),
    })
    .default({ adapter: "contentful", contentful: { spaceIdEnv: "CONTENTFUL_SPACE_ID", taxonomyMode: "contentType", rawHtmlMode: "htmlBlockEntry" } }),
  frontend: z
    .object({
      generator: z.literal("nextjs-contentful").default("nextjs-contentful"),
      appDir: z.string().optional(), // default apps/<site>-web
      /** where the generated app reads content: "contentful" (prod) or "ccm" (offline, reads workspace ccm/) */
      dataSource: z.enum(["contentful", "ccm"]).default("contentful"),
    })
    .default({ generator: "nextjs-contentful", dataSource: "contentful" }),
  parity: z
    .object({
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
      screenshotThreshold: z.number().default(0.97), // §7.3 Tier 2
      bboxTolerancePx: z.number().default(4),
      textSimilarity: z.number().default(0.99),
      /** class-name prefixes of the theme's components (diff attribution priority, e.g. ["dsu-c-", "ln-c-"]); added to a generic default */
      componentClassPrefixes: z.array(z.string()).optional(),
    })
    .default({ tier: 2, screenshotThreshold: 0.97, bboxTolerancePx: 4, textSimilarity: 0.99 }),
  llm: z
    .object({
      sendContent: z.boolean().default(false), // §14 #9
      model: z.string().optional(), // default OLLAMA_MODEL
      stepModels: z.record(z.string(), z.string()).default({}),
      /** hard cap on estimated LLM spend per process (USD); calls beyond it fail fast -> deterministic path */
      budgetUsd: z.number().optional(),
    })
    .default({ sendContent: false, stepModels: {} }),
  /** `migrate autofix` (DeepSeek-only plan): gate-verified fix loop over TASKS.md items */
  autofix: z
    .object({
      maxIterations: z.number().int().default(40),
      /** candidates tried per task before it is marked NEEDS_HUMAN */
      candidatesPerTask: z.number().int().default(3),
      /** stop a task after this many accepted-or-rejected rounds without metric improvement */
      patience: z.number().int().default(5),
      /** port the app under test is served on (default: from frontend / verify) */
      appPort: z.number().int().optional(),
    })
    .optional(),
});
export type SiteConfig = z.infer<typeof SiteConfig>;

// ---------------------------------------------------------------- steps & reports

export type StepName =
  | "init"
  | "extract"
  | "analyze"
  | "map"
  | "transform"
  | "load"
  | "design-extract"
  | "frontend-generate"
  | "verify"
  | "report"
  | "autofix";

export interface Logger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
}

export interface StepContext {
  site: SiteConfig;
  ws: Workspace;
  dryRun: boolean;
  log: Logger;
  llm?: LlmClient;
  /** free-form CLI options for the step */
  options: Record<string, unknown>;
}

export type IssueSeverity = "error" | "warning" | "info";
export interface Issue {
  severity: IssueSeverity;
  code: string; // e.g. "UNMAPPED_FIELD", "BROKEN_LINK"
  message: string;
  ref?: string; // ccmId / url / file
  /** becomes a TASKS.md item when true */
  actionable?: boolean;
}

/** Every step returns one of these; core writes reports/<step>.json + .md (§4). */
export interface StepReport {
  step: StepName | string;
  site: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  dryRun: boolean;
  /** counts / metrics, e.g. { entries: 12, assets: 4 } */
  stats: Record<string, number | string | boolean>;
  issues: Issue[];
  outputs: string[]; // workspace-relative paths written
  /** gate results, e.g. { "ccm.valid": true } */
  gates?: Record<string, { pass: boolean; value?: number | string; threshold?: number | string }>;
}

export type StepFn = (ctx: StepContext) => Promise<StepReport>;

// ---------------------------------------------------------------- adapters (§9.1)

export interface SourceInfo {
  system: string;
  version?: string;
  capabilities: string[];
  details?: Record<string, unknown>;
}

export interface SourceAdapter {
  id: string;
  detect(ctx: StepContext): Promise<SourceInfo>;
  extract: StepFn; // -> raw/
  analyze: StepFn; // -> analysis/
  /** proposes mapping/*.yaml (LLM optional) */
  proposeMapping?: StepFn;
  toCCM: StepFn; // raw/ + mapping/ -> ccm/
}

export interface TargetCapabilities {
  richText: "json" | "html" | "markdown";
  localization: "field" | "entry";
  inlineComponents: boolean;
  hierarchicalTaxonomy: boolean;
  assetFocalPoint: boolean;
  limits: Record<string, number>; // fieldsPerContentType, contentTypes, locales, richTextBytes, assetBytes, reqPerSecond
}

export interface TargetAdapter {
  id: string;
  capabilities(): TargetCapabilities;
  /** content model check of the CCM schema against target capabilities/limits (lossy conversions) */
  checkSchema(schema: CcmSchemaFile, ctx: StepContext): Issue[];
  loadSchema: StepFn;
  loadContent: StepFn; // writes idmap.json
  verify: StepFn;
}

export interface FrontendGenerator {
  id: string;
  generate: StepFn; // design/ + ccm/schema + mapping -> apps/<site>-web
}

// ---------------------------------------------------------------- LLM (§10.1)

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * Optional images for vision-capable models (e.g. deepseek-flash), sent as OpenAI-style `image_url` parts after the
   * text. PNG/JPEG data URLs or workspace-relative paths (resolved by the client). Providers without vision drop them.
   */
  images?: string[];
}
export interface LlmRequest {
  step: string; // for logging & per-step model override
  messages: LlmMessage[];
  /** ask for a JSON object response */
  json?: boolean;
  temperature?: number;
  model?: string;
  /** cap on completion tokens (reasoning tokens included on DeepSeek V4) */
  maxTokens?: number;
  /** reasoning effort for models that support it (DeepSeek V4 `reasoning_effort`: none = thinking off | low | high | max) */
  effort?: "none" | "low" | "high" | "max";
  /**
   * Response validator: called with the parsed JSON (json: true). Return the value or throw with a message — the client
   * retries once with the error appended, then throws LlmError. Not part of the cache key; `schemaId` is.
   */
  validate?: (value: unknown) => unknown;
  /** stable id of the expected response shape (part of the cache key), e.g. "profile-infer@1" */
  schemaId?: string;
  /** false = never read/write the response cache for this call (default true) */
  cache?: boolean;
}
export interface LlmResponse {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  /** provider that served the call ("deepseek", "ollama", ...) */
  provider?: string;
  /** true when the primary provider failed/limited and a fallback answered */
  fallback?: boolean;
  /** served from workspace llm-cache/ (no API call, no cost) */
  cached?: boolean;
  /** parsed + validated JSON when the request had json: true */
  parsed?: unknown;
}
/** Implementations must log every call to workspace llm-log/ (prompt hash, model, tokens). */
export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}
