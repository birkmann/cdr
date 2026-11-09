/**
 * Minimal, dependency-free copy of the CCM types the app needs (source of truth: packages/core/src/ccm.ts).
 * The app is deployable on its own (Vercel), so it must not import @cmp/core.
 */
export type Mark = "bold" | "italic" | "underline" | "code" | "superscript" | "subscript" | "strikethrough";
export interface Reference {
  kind: "entry" | "asset" | "term";
  id: string;
}
export type RichInline =
  | { type: "text"; value: string; marks?: Mark[]; /** <abbr title> around the (marked) text */ abbr?: string }
  | { type: "break" }
  | { type: "link"; href?: string; ref?: Reference; title?: string; children: RichInline[] }
  | { type: "inlineEntry"; ref: Reference; entry?: unknown };
export type RichBlock =
  | { type: "paragraph"; children: RichInline[]; /** original had no <p> (bare inline content) — render children only */ implicit?: boolean }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: RichInline[] }
  | { type: "list"; ordered: boolean; children: RichListItem[] }
  | { type: "blockquote"; children: RichBlock[] }
  | { type: "hr" }
  /** `asset` / `entry` are filled in by the data layer (resolved references) */
  | { type: "embeddedAsset"; ref: Reference; caption?: string; asset?: unknown }
  | { type: "embeddedEntry"; ref: Reference; entry?: unknown }
  | { type: "rawHtml"; html: string; reason?: string };
export type RichListItem = { type: "listItem"; children: RichBlock[] };
export type RichTextDoc = { type: "doc"; children: RichBlock[] };

export interface SeoMeta {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  og?: Record<string, string>;
  twitter?: Record<string, string>;
  /** other `<meta name="…">` tags that matter for SEO (keywords, news_keywords, abstract, site verification) */
  meta?: Record<string, string>;
  hreflang?: { locale: string; href: string }[];
  structuredData?: unknown[];
}
export interface SourceRef {
  system: string;
  kind: string;
  id: string;
  bundle?: string;
  url?: string;
}
export interface Entry {
  ccmId: string;
  type: string;
  locale: string;
  path?: string;
  slug?: string;
  status?: "published" | "draft" | "archived";
  fields: Record<string, unknown>;
  meta?: SeoMeta;
  sourceChangedAt?: string;
  source?: SourceRef;
}
export interface Asset {
  ccmId: string;
  src: string;
  originalPath?: string;
  fileName: string;
  mime: string;
  size?: number;
  width?: number;
  height?: number;
  focalPoint?: { x: number; y: number };
  title?: Record<string, string>;
  alt?: Record<string, string>;
  private?: boolean;
  source?: SourceRef;
}
export interface Term {
  ccmId: string;
  name: Record<string, string>;
  slug?: Record<string, string>;
  parent?: string;
  weight?: number;
  description?: Record<string, string>;
}
export interface Taxonomy {
  id: string;
  name: string;
  hierarchical?: boolean;
  terms: Term[];
}
export interface NavItem {
  id: string;
  label: Record<string, string>;
  href?: string;
  ref?: Reference;
  weight?: number;
  children: NavItem[];
  /** Contentful mapping: resolved path per locale */
  path?: Record<string, string>;
}
export interface Navigation {
  id: string;
  name: string;
  items: NavItem[];
}
export interface Redirect {
  from: string;
  to: string;
  status?: 301 | 302 | 307 | 308;
  locale?: string;
}
export interface Locale {
  code: string;
  name: string;
  default?: boolean;
  fallback?: string;
  pathPrefix?: string;
}
export interface SiteScript {
  id: string;
  src?: string;
  inline?: string;
  placement: "head" | "body";
  /** "module" for ES-module scripts (design manifest) */
  type?: string;
}
export interface SiteSettings {
  siteName: Record<string, string>;
  baseUrl: string;
  logo?: Reference;
  footerText?: Record<string, string>;
  seoDefaults?: SeoMeta;
  scripts?: SiteScript[];
  extra?: Record<string, unknown>;
}
export interface CollectionDef {
  id: string;
  name: string;
  type: string;
  filters?: { field: string; op: "eq" | "neq" | "in" | "contains" | "exists" | "gt" | "lt"; value: unknown }[];
  sort?: { field: string; direction: "asc" | "desc" }[];
  limit?: number;
  pagination?: { pageSize: number };
  manual?: boolean;
  /** optional extension: listing page path(s) (Drupal view page display), string or per-locale record */
  path?: string | Record<string, string>;
  source?: SourceRef;
}
export interface FieldDef {
  id: string;
  name: string;
  type: string;
  required?: boolean;
  localized?: boolean;
  cardinality?: number;
  allowedTypes?: string[];
}
export interface ContentType {
  id: string;
  name: string;
  kind?: "document" | "component" | "settings";
  displayField?: string;
  fields: FieldDef[];
}
