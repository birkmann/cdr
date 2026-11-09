/**
 * Canonical Content Model (CCM) — the CMS-neutral contract every source writes and every target reads.
 * See MIGRATION_PLAN.md §3. FROZEN CONTRACT: changes must be additive (new optional fields) and noted in
 * docs/adr/0001-ccm-contract.md.
 */
import { z } from "zod";

/** Stable id derived from the source, e.g. "drupal:node:123", "html:page:/about-us". Locale is NOT part of the id. */
export const CcmId = z.string().min(1);
export type CcmId = z.infer<typeof CcmId>;

export const LocaleCode = z.string().min(2); // BCP-47-ish: "de", "en", "de-CH"

export const SourceRef = z.object({
  system: z.string(), // "drupal", "html", "strapi", ...
  kind: z.string(), // "node", "paragraph", "taxonomy_term", "file", "page", ...
  id: z.string(), // native id in the source system
  bundle: z.string().optional(), // drupal bundle / source type name
  url: z.string().optional(), // where it was read from
});
export type SourceRef = z.infer<typeof SourceRef>;

// ---------------------------------------------------------------- schema (content types)

export const FieldType = z.enum([
  "text",
  "richText",
  "number",
  "boolean",
  "date",
  "reference",
  "link",
  "enum",
  "json",
  "slug",
  "component",
  "componentList",
]);
export type FieldType = z.infer<typeof FieldType>;

export const FieldDef = z.object({
  id: z.string(), // camelCase CCM field id
  name: z.string(),
  type: FieldType,
  required: z.boolean().default(false),
  localized: z.boolean().default(false),
  /** 1 = single value, -1 = unlimited, n = max n */
  cardinality: z.number().int().default(1),
  /** for reference/component/componentList: allowed target CCM content type ids, or "asset" / "term:<taxonomyId>" */
  allowedTypes: z.array(z.string()).optional(),
  /** for enum */
  options: z.array(z.string()).optional(),
  validations: z.record(z.string(), z.unknown()).optional(),
  sourceMeta: z.record(z.string(), z.unknown()).optional(), // original field name/type for traceability
});
export type FieldDef = z.infer<typeof FieldDef>;

export const ContentType = z.object({
  id: z.string(), // camelCase, e.g. "page", "article", "sectionHero"
  name: z.string(),
  description: z.string().optional(),
  /** "document" = routable page-level entry; "component" = only embedded (paragraphs etc.) */
  kind: z.enum(["document", "component", "settings"]).default("document"),
  displayField: z.string().optional(),
  fields: z.array(FieldDef),
  sourceMeta: z.record(z.string(), z.unknown()).optional(),
});
export type ContentType = z.infer<typeof ContentType>;

// ---------------------------------------------------------------- rich text (portable AST, §3.3)

export const Mark = z.enum(["bold", "italic", "underline", "code", "superscript", "subscript", "strikethrough"]);

export type RichInline =
  | { type: "text"; value: string; marks?: z.infer<typeof Mark>[] }
  | { type: "break" }
  | { type: "link"; href?: string; ref?: Reference; title?: string; children: RichInline[] }
  | { type: "inlineEntry"; ref: Reference };

export type RichBlock =
  | { type: "paragraph"; children: RichInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: RichInline[] }
  | { type: "list"; ordered: boolean; children: RichListItem[] }
  | { type: "blockquote"; children: RichBlock[] }
  | { type: "hr" }
  | { type: "embeddedAsset"; ref: Reference; caption?: string }
  | { type: "embeddedEntry"; ref: Reference }
  /** unsupported construct (table, iframe, script, custom markup) kept verbatim; target decides */
  | { type: "rawHtml"; html: string; reason?: string };

export type RichListItem = { type: "listItem"; children: RichBlock[] };
export type RichTextDoc = { type: "doc"; children: RichBlock[] };

export const Reference = z.object({
  kind: z.enum(["entry", "asset", "term"]),
  id: CcmId,
});
export type Reference = z.infer<typeof Reference>;

const RichInlineSchema: z.ZodType<RichInline> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("text"), value: z.string(), marks: z.array(Mark).optional() }),
    z.object({ type: z.literal("break") }),
    z.object({
      type: z.literal("link"),
      href: z.string().optional(),
      ref: Reference.optional(),
      title: z.string().optional(),
      children: z.array(RichInlineSchema),
    }),
    z.object({ type: z.literal("inlineEntry"), ref: Reference }),
  ]),
);

const RichBlockSchema: z.ZodType<RichBlock> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("paragraph"), children: z.array(RichInlineSchema) }),
    z.object({
      type: z.literal("heading"),
      level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
      children: z.array(RichInlineSchema),
    }),
    z.object({
      type: z.literal("list"),
      ordered: z.boolean(),
      children: z.array(z.object({ type: z.literal("listItem"), children: z.array(RichBlockSchema) })),
    }),
    z.object({ type: z.literal("blockquote"), children: z.array(RichBlockSchema) }),
    z.object({ type: z.literal("hr") }),
    z.object({ type: z.literal("embeddedAsset"), ref: Reference, caption: z.string().optional() }),
    z.object({ type: z.literal("embeddedEntry"), ref: Reference }),
    z.object({ type: z.literal("rawHtml"), html: z.string(), reason: z.string().optional() }),
  ]),
);

export const RichTextDocSchema: z.ZodType<RichTextDoc> = z.object({
  type: z.literal("doc"),
  children: z.array(RichBlockSchema),
});

// ---------------------------------------------------------------- field values

export const LinkValue = z.object({ href: z.string().optional(), ref: Reference.optional(), label: z.string().optional() });

/** Values are loosely typed on purpose; `validateCcm` (core/validate.ts) checks them against FieldDef.
 * component / componentList values MUST be Reference objects ({ kind: "entry", id }) to component entries. */
export const FieldValue: z.ZodType<unknown> = z.unknown();

export const SeoMeta = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  canonical: z.string().optional(),
  robots: z.string().optional(),
  og: z.record(z.string(), z.string()).optional(), // og:title, og:image, ...
  twitter: z.record(z.string(), z.string()).optional(),
  /** other `<meta name="…">` tags that matter for SEO, by name: keywords, news_keywords, abstract, site verification (ADR 0001, 2026-11-08) */
  meta: z.record(z.string(), z.string()).optional(),
  hreflang: z.array(z.object({ locale: z.string(), href: z.string() })).optional(),
  structuredData: z.array(z.unknown()).optional(), // JSON-LD blobs
});
export type SeoMeta = z.infer<typeof SeoMeta>;

/** One Entry file per (ccmId, locale). Translations share the ccmId. */
export const Entry = z.object({
  ccmId: CcmId,
  type: z.string(), // ContentType.id
  locale: LocaleCode,
  /** full URL path incl. locale prefix as on the live site, e.g. "/de/ueber-uns"; only for routable entries */
  path: z.string().optional(),
  slug: z.string().optional(),
  status: z.enum(["published", "draft", "archived"]).default("published"),
  fields: z.record(z.string(), FieldValue),
  meta: SeoMeta.optional(),
  sourceChangedAt: z.string().optional(), // ISO timestamp, used for delta runs (§12b)
  source: SourceRef,
});
export type Entry = z.infer<typeof Entry>;

export const Asset = z.object({
  ccmId: CcmId,
  /** absolute URL or workspace-relative file path (raw/files/...) */
  src: z.string(),
  /** original public path, e.g. "/sites/default/files/2024-01/hero.jpg" — preserved for URL parity (§14 #5) */
  originalPath: z.string().optional(),
  fileName: z.string(),
  mime: z.string(),
  size: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  focalPoint: z.object({ x: z.number(), y: z.number() }).optional(),
  /** per-locale texts */
  title: z.record(z.string(), z.string()).optional(),
  alt: z.record(z.string(), z.string()).optional(),
  private: z.boolean().optional(),
  sha256: z.string().optional(),
  source: SourceRef,
});
export type Asset = z.infer<typeof Asset>;

export const Term = z.object({
  ccmId: CcmId,
  name: z.record(z.string(), z.string()), // per locale
  slug: z.record(z.string(), z.string()).optional(),
  parent: CcmId.optional(),
  weight: z.number().optional(),
  description: z.record(z.string(), z.string()).optional(),
  source: SourceRef,
});
export const Taxonomy = z.object({
  id: z.string(), // e.g. "tags"
  name: z.string(),
  hierarchical: z.boolean().default(false),
  terms: z.array(Term),
  source: SourceRef.optional(),
});
export type Taxonomy = z.infer<typeof Taxonomy>;
export type Term = z.infer<typeof Term>;

export type NavItem = {
  id: string;
  label: Record<string, string>; // per locale
  href?: string; // external URL, or a site path starting with "/" that is LANGUAGE-NEUTRAL (frontend adds the locale prefix)
  ref?: Reference; // internal entry
  weight?: number;
  children: NavItem[];
};
const NavItemSchema: z.ZodType<NavItem> = z.lazy(() =>
  z.object({
    id: z.string(),
    label: z.record(z.string(), z.string()),
    href: z.string().optional(),
    ref: Reference.optional(),
    weight: z.number().optional(),
    children: z.array(NavItemSchema),
  }),
);
export const Navigation = z.object({
  id: z.string(), // "main", "footer", ...
  name: z.string(),
  items: z.array(NavItemSchema),
  source: SourceRef.optional(),
});
export type Navigation = z.infer<typeof Navigation>;

export const Redirect = z.object({
  from: z.string(),
  to: z.string(),
  status: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).default(301),
  locale: z.string().optional(),
  source: SourceRef.optional(),
});
export type Redirect = z.infer<typeof Redirect>;

export const Locale = z.object({
  code: LocaleCode,
  name: z.string(),
  default: z.boolean().default(false),
  fallback: LocaleCode.optional(),
  /** URL prefix on the live site ("" for the default locale without prefix) */
  pathPrefix: z.string().default(""),
});
export type Locale = z.infer<typeof Locale>;

export const SiteSettings = z.object({
  siteName: z.record(z.string(), z.string()),
  baseUrl: z.string(),
  logo: Reference.optional(),
  footerText: z.record(z.string(), z.string()).optional(),
  seoDefaults: SeoMeta.optional(),
  scripts: z.array(z.object({ id: z.string(), src: z.string().optional(), inline: z.string().optional(), placement: z.enum(["head", "body"]) })).optional(), // cookie consent, analytics (§14 #6)
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type SiteSettings = z.infer<typeof SiteSettings>;

/** Declarative listing (Drupal Views) executed by the frontend (§3.1). */
export const Collection = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(), // CCM content type
  filters: z.array(z.object({ field: z.string(), op: z.enum(["eq", "neq", "in", "contains", "exists", "gt", "lt"]), value: z.unknown() })).default([]),
  sort: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) })).default([]),
  limit: z.number().int().optional(),
  pagination: z.object({ pageSize: z.number().int() }).optional(),
  manual: z.boolean().default(false), // code-level customisation → needs human (§5.2)
  /** routable listing page (Views page display), per locale incl. prefix, e.g. { en: "/news", de: "/de/news" } */
  path: z.record(z.string(), z.string()).optional(),
  source: SourceRef.optional(),
});
export type Collection = z.infer<typeof Collection>;

export const CcmSchemaFile = z.object({ contentTypes: z.array(ContentType) });
export type CcmSchemaFile = z.infer<typeof CcmSchemaFile>;
