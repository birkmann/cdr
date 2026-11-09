/**
 * The ONE data interface every page/component uses. Both implementations (`ccm`: workspace files, `contentful`: CDA)
 * return CCM-shaped data with references already resolved, so rendering never knows where content came from.
 */
import type { CollectionDef, ContentType, Locale, Redirect, RichTextDoc, SeoMeta, SiteScript, SourceRef } from "../ccm-types";

export interface AssetView {
  _kind: "asset";
  ccmId: string;
  /** URL to use on the new site (original public path when known → URL parity, §14 #5) */
  url: string;
  /** upstream binary location (absolute URL, Contentful CDN, or workspace file) */
  src?: string;
  originalPath?: string;
  fileName: string;
  mime: string;
  width?: number;
  height?: number;
  alt: string;
  title: string;
}

export interface TermView {
  _kind: "term";
  ccmId: string;
  locale: string;
  name: string;
  slug?: string;
  path?: string;
}

export interface LinkView {
  _kind: "link";
  href: string;
  label: string;
  external: boolean;
  title?: string;
}

/** Shallow pointer used when an entry reference is not expanded (depth limit / cycles / unpublished). */
export interface EntryStub {
  _kind: "entryStub";
  ccmId: string;
  type?: string;
  path?: string;
  title?: string;
}

export interface EntryView {
  _kind: "entry";
  ccmId: string;
  type: string;
  locale: string;
  path?: string;
  slug?: string;
  status: "published" | "draft" | "archived";
  /** resolved field values: asset refs → AssetView, entry refs → EntryView/EntryStub, term refs → TermView,
   * links → LinkView, rich text → RichTextDoc with `href`/`asset`/`entry` filled in, collections → CollectionView */
  fields: Record<string, unknown>;
  meta?: SeoMeta;
  sourceChangedAt?: string;
  source?: SourceRef;
}

export interface CollectionView {
  _kind: "collection";
  id: string;
  items: EntryView[];
}

export interface NavItemView {
  id: string;
  label: string;
  href: string;
  external: boolean;
  weight: number;
  level: number;
  children: NavItemView[];
}

export interface SettingsView {
  siteName: string;
  slogan?: string;
  baseUrl: string;
  logo?: AssetView;
  footerText?: string;
  seoDefaults?: SeoMeta;
  scripts: SiteScript[];
  extra: Record<string, unknown>;
}

export interface PathInfo {
  path: string;
  locale: string;
  ccmId: string;
  type: string;
  /** "entry" = CCM document entry, "collection" = listing page of a Collection, "term" = taxonomy term page */
  kind: "entry" | "collection" | "term";
  lastModified?: string;
}

export interface DataSource {
  readonly id: "ccm" | "contentful";
  getLocales(): Promise<Locale[]>;
  getContentTypes(): Promise<ContentType[]>;
  listPaths(): Promise<PathInfo[]>;
  /** locale defaults to the one implied by the path prefix */
  getEntryByPath(path: string, locale?: string): Promise<EntryView | null>;
  getNavigation(id: string, locale: string): Promise<NavItemView[]>;
  getSettings(locale: string): Promise<SettingsView>;
  getCollection(id: string): Promise<CollectionDef | null>;
  runCollection(def: CollectionDef | string, locale: string, opts?: { page?: number }): Promise<EntryView[]>;
  /** translations of the same ccmId (for hreflang + language switcher) */
  getAlternates(ccmId: string): Promise<{ locale: string; path: string }[]>;
  getAssetByPath(originalPath: string): Promise<AssetView | null>;
  getRedirects(): Promise<Redirect[]>;
}

export type { RichTextDoc };
