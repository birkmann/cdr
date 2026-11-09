/**
 * Contentful (CDA, all locales, links unresolved) → CCM bundle. Mirrors the mapping convention in
 * docs/AGENT_WORKPLAN.md "Contentful mapping" (written by the target-contentful adapter):
 *  - content type id = CCM type id, field id = CCM field id; `ccmId`, `path` (localized), `seo` (localized JSON) on documents
 *  - Link Entry/Asset → CCM Reference; Link to `taxonomyTerm` → term reference
 *  - RichText → CCM rich-text AST; `embedded-entry-block` → `htmlBlock` = rawHtml node
 *  - `navigation` (title, navId, items JSON), `siteSettings` (JSON fields), `collectionDefinition` (collectionId, definition)
 * Pure and synchronous so it can be unit-tested against hand-written CDA JSON.
 */
import type {
  Asset,
  CollectionDef,
  ContentType,
  Entry,
  Locale,
  Mark,
  Navigation,
  Redirect,
  Reference,
  RichBlock,
  RichInline,
  RichTextDoc,
  SiteSettings,
  Taxonomy,
} from "../ccm-types";
import type { CcmBundle } from "./store";

// ---------------------------------------------------------------- CDA shapes (subset)

export interface CdaLink {
  sys: { type: "Link"; linkType: "Entry" | "Asset"; id: string };
}
export interface CdaEntry {
  sys: { id: string; type: "Entry"; contentType: { sys: { id: string } }; updatedAt?: string; publishedAt?: string; revision?: number };
  fields: Record<string, Record<string, unknown> | undefined>;
  metadata?: { tags?: { sys: { id: string } }[] };
}
export interface CdaAsset {
  sys: { id: string; type: "Asset"; updatedAt?: string };
  fields: {
    title?: Record<string, string>;
    description?: Record<string, string>;
    file?: Record<string, { url: string; fileName: string; contentType: string; details?: { size?: number; image?: { width: number; height: number } } }>;
  };
}
export interface CdaLocale {
  code: string;
  name: string;
  default: boolean;
  fallbackCode: string | null;
}
export interface CfNode {
  nodeType: string;
  data?: Record<string, unknown> & { target?: CdaLink; uri?: string };
  content?: CfNode[];
  value?: string;
  marks?: { type: string }[];
}

export interface NormalizeInput {
  entries: CdaEntry[];
  assets: CdaAsset[];
  locales: CdaLocale[];
  /** URL prefixes per locale (Contentful has none) — from the generated config (CCM locales) */
  localeConfig?: { code: string; pathPrefix?: string; name?: string }[];
  /** CCM schema (generated from ccm/schema) — tells which fields are localized */
  contentTypes?: ContentType[];
  /** contentful asset id → { ccmId, originalPath } (generated from CCM assets + idmap) */
  assetPaths?: Record<string, { ccmId?: string; originalPath?: string; width?: number; height?: number }>;
  redirects?: Redirect[];
  /** preview: keep entries without publishedAt as drafts */
  preview?: boolean;
}

const SYSTEM_TYPES = new Set(["taxonomyTerm", "navigation", "siteSettings", "collectionDefinition", "htmlBlock"]);
const SYSTEM_FIELDS = new Set(["ccmId", "path", "seo"]);
const MARKS: Mark[] = ["bold", "italic", "underline", "code", "superscript", "subscript", "strikethrough"];

export function isCdaLink(v: unknown): v is CdaLink {
  return !!v && typeof v === "object" && (v as CdaLink).sys?.type === "Link";
}
function isCfDoc(v: unknown): v is CfNode {
  return !!v && typeof v === "object" && (v as CfNode).nodeType === "document";
}

export function normalizeContentful(input: NormalizeInput): CcmBundle {
  const defaultCode = (input.locales.find((l) => l.default) ?? input.locales[0])?.code ?? "en";
  const prefixes = new Map((input.localeConfig ?? []).map((l) => [l.code, l.pathPrefix ?? ""]));
  const locales: Locale[] = input.locales.map((l) => ({
    code: l.code,
    name: (input.localeConfig ?? []).find((c) => c.code === l.code)?.name ?? l.name,
    default: l.default,
    fallback: l.fallbackCode ?? undefined,
    pathPrefix: l.default ? "" : (prefixes.get(l.code) ?? l.code),
  }));
  const codes = locales.map((l) => l.code);
  const chainOf = (code: string): string[] => {
    const out = [code];
    let cur = locales.find((l) => l.code === code)?.fallback;
    while (cur && !out.includes(cur)) {
      out.push(cur);
      cur = locales.find((l) => l.code === cur)?.fallback;
    }
    if (!out.includes(defaultCode)) out.push(defaultCode);
    return out;
  };
  const types = new Map((input.contentTypes ?? []).map((t) => [t.id, t]));
  const rawById = new Map(input.entries.map((e) => [e.sys.id, e]));
  const typeOf = (e: CdaEntry) => e.sys.contentType.sys.id;

  /** value of a field in a locale, honouring the fallback chain (non-localized fields live under the default locale) */
  const val = (e: CdaEntry, field: string, code: string): unknown => {
    const f = e.fields[field];
    if (!f) return undefined;
    for (const c of chainOf(code)) if (f[c] !== undefined) return f[c];
    return undefined;
  };
  const ccmIdOf = (e: CdaEntry): string => {
    const v = val(e, "ccmId", defaultCode);
    return typeof v === "string" && v ? v : `contentful:${typeOf(e)}:${e.sys.id}`;
  };
  const assetCcmId = (id: string): string => input.assetPaths?.[id]?.ccmId ?? `contentful:asset:${id}`;

  const toRef = (l: CdaLink): Reference | undefined => {
    if (l.sys.linkType === "Asset") return { kind: "asset", id: assetCcmId(l.sys.id) };
    const t = rawById.get(l.sys.id);
    if (!t) return undefined; // unpublished / missing target
    return { kind: typeOf(t) === "taxonomyTerm" ? "term" : "entry", id: ccmIdOf(t) };
  };

  const convValue = (v: unknown, code: string): unknown => {
    if (v == null) return v;
    if (isCdaLink(v)) return toRef(v) ?? null;
    if (Array.isArray(v)) return v.map((x) => convValue(x, code)).filter((x) => x !== null);
    if (isCfDoc(v)) return richTextFromContentful(v, { toRef, htmlOf: (id) => htmlBlockHtml(rawById.get(id), code) });
    return v;
  };
  const htmlBlockHtml = (e: CdaEntry | undefined, code: string): string | undefined => {
    if (!e || typeOf(e) !== "htmlBlock") return undefined;
    const h = val(e, "html", code);
    return typeof h === "string" ? h : undefined;
  };

  // ---------------------------------------------------------------- entries
  const entries: Entry[] = [];
  for (const e of input.entries) {
    const type = typeOf(e);
    if (SYSTEM_TYPES.has(type)) continue;
    const ct = types.get(type);
    const hasPath = !!e.fields.path || ct?.kind === "document";
    const ccmId = ccmIdOf(e);
    for (const code of codes) {
      const path = e.fields.path?.[code];
      if (hasPath && e.fields.path && typeof path !== "string") continue; // not routable in this locale
      const fields: Record<string, unknown> = {};
      for (const k of Object.keys(e.fields)) {
        if (SYSTEM_FIELDS.has(k)) continue;
        const localized = ct?.fields.find((f) => f.id === k)?.localized;
        const raw = localized === false ? val(e, k, defaultCode) : val(e, k, code);
        if (raw === undefined) continue;
        fields[k] = convValue(raw, code);
      }
      const seo = e.fields.seo?.[code];
      entries.push({
        ccmId,
        type,
        locale: code,
        path: typeof path === "string" ? path : undefined,
        slug: typeof path === "string" ? (path.split("/").filter(Boolean).pop() ?? "") : undefined,
        status: input.preview && !e.sys.publishedAt ? "draft" : "published",
        fields,
        meta: seo && typeof seo === "object" ? (seo as Entry["meta"]) : undefined,
        sourceChangedAt: e.sys.updatedAt,
        source: { system: "contentful", kind: "entry", id: e.sys.id, bundle: type },
      });
    }
  }

  // ---------------------------------------------------------------- assets
  const assets: Asset[] = input.assets.map((a) => {
    const file = pickRec(a.fields.file, chainOf(defaultCode));
    const title: Record<string, string> = {};
    const alt: Record<string, string> = {};
    for (const c of codes) {
      if (a.fields.title?.[c]) title[c] = a.fields.title[c];
      // CCM alt text maps to the Contentful asset description (title = fallback)
      const d = a.fields.description?.[c] ?? a.fields.title?.[c];
      if (d) alt[c] = d;
    }
    const url = file?.url ?? "";
    return {
      ccmId: assetCcmId(a.sys.id),
      src: url.startsWith("//") ? "https:" + url : url,
      originalPath: input.assetPaths?.[a.sys.id]?.originalPath,
      fileName: file?.fileName ?? a.sys.id,
      mime: file?.contentType ?? "application/octet-stream",
      size: file?.details?.size,
      // CDA image details, else the CCM dimensions (generated assets.json) — needed for width/height attributes
      width: file?.details?.image?.width ?? input.assetPaths?.[a.sys.id]?.width,
      height: file?.details?.image?.height ?? input.assetPaths?.[a.sys.id]?.height,
      title,
      alt,
      source: { system: "contentful", kind: "asset", id: a.sys.id },
    };
  });

  // ---------------------------------------------------------------- system types
  const taxonomies = new Map<string, Taxonomy>();
  const navigation: Navigation[] = [];
  const collections: CollectionDef[] = [];
  let settings: SiteSettings | null = null;
  const perLocale = (e: CdaEntry, field: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const f = e.fields[field] ?? {};
    for (const c of codes) if (typeof f[c] === "string") out[c] = f[c] as string;
    return out;
  };
  for (const e of input.entries) {
    const type = typeOf(e);
    if (type === "taxonomyTerm") {
      const txId = String(val(e, "taxonomy", defaultCode) ?? "tags");
      let tx = taxonomies.get(txId);
      if (!tx) taxonomies.set(txId, (tx = { id: txId, name: txId, hierarchical: false, terms: [] }));
      const parent = val(e, "parent", defaultCode);
      const slug = perLocale(e, "slug");
      tx.terms.push({
        ccmId: ccmIdOf(e),
        name: perLocale(e, "name"),
        slug: Object.keys(slug).length ? slug : undefined,
        parent: isCdaLink(parent) ? toRef(parent)?.id : undefined,
      });
      if (parent) tx.hierarchical = true;
    } else if (type === "navigation") {
      const items = val(e, "items", defaultCode);
      navigation.push({
        id: String(val(e, "navId", defaultCode) ?? e.sys.id),
        name: String(val(e, "title", defaultCode) ?? ""),
        items: Array.isArray(items) ? (items as Navigation["items"]) : [],
      });
    } else if (type === "collectionDefinition") {
      const def = val(e, "definition", defaultCode) as CollectionDef | undefined;
      const id = String(val(e, "collectionId", defaultCode) ?? def?.id ?? e.sys.id);
      if (def) collections.push({ ...def, id });
    } else if (type === "siteSettings") {
      const g = (k: string) => {
        const v = val(e, k, defaultCode);
        return isCdaLink(v) ? toRef(v) : v;
      };
      const siteName = g("siteName");
      settings = {
        siteName: (typeof siteName === "string" ? { [defaultCode]: siteName } : (siteName as Record<string, string>)) ?? perLocale(e, "siteName"),
        baseUrl: String(g("baseUrl") ?? ""),
        logo: g("logo") as Reference | undefined,
        footerText: g("footerText") as Record<string, string> | undefined,
        seoDefaults: g("seoDefaults") as SiteSettings["seoDefaults"],
        scripts: g("scripts") as SiteSettings["scripts"],
        extra: g("extra") as Record<string, unknown> | undefined,
      };
    }
  }

  return {
    contentTypes: input.contentTypes ?? [],
    entries,
    assets,
    taxonomies: [...taxonomies.values()],
    navigation,
    redirects: input.redirects ?? [],
    locales,
    collections,
    settings,
  };
}

function pickRec<T>(rec: Record<string, T> | undefined, chain: string[]): T | undefined {
  if (!rec) return undefined;
  for (const c of chain) if (rec[c] !== undefined) return rec[c];
  return Object.values(rec)[0];
}

// ---------------------------------------------------------------- rich text

export interface RichTextCtx {
  toRef(l: CdaLink): Reference | undefined;
  /** html of an `htmlBlock` entry by Contentful id (rawHtml round-trip) */
  htmlOf?(id: string): string | undefined;
}

export function richTextFromContentful(doc: CfNode, ctx: RichTextCtx): RichTextDoc {
  const inlines = (nodes: CfNode[] = []): RichInline[] => nodes.flatMap(inline);
  const inline = (n: CfNode): RichInline[] => {
    switch (n.nodeType) {
      case "text": {
        const marks = (n.marks ?? []).map((m) => m.type as Mark).filter((m) => MARKS.includes(m));
        const parts = (n.value ?? "").split("\n");
        const out: RichInline[] = [];
        parts.forEach((p, i) => {
          if (i > 0) out.push({ type: "break" });
          if (p) out.push(marks.length ? { type: "text", value: p, marks } : { type: "text", value: p });
        });
        return out;
      }
      case "hyperlink":
        return [{ type: "link", href: String(n.data?.uri ?? ""), children: inlines(n.content) }];
      case "entry-hyperlink":
      case "asset-hyperlink": {
        const ref = n.data?.target ? ctx.toRef(n.data.target) : undefined;
        return [ref ? { type: "link", ref, children: inlines(n.content) } : { type: "link", href: "", children: inlines(n.content) }];
      }
      case "embedded-entry-inline": {
        const ref = n.data?.target ? ctx.toRef(n.data.target) : undefined;
        return ref ? [{ type: "inlineEntry", ref }] : [];
      }
      default:
        return inlines(n.content);
    }
  };
  const block = (n: CfNode): RichBlock[] => {
    const t = n.nodeType;
    const h = /^heading-([1-6])$/.exec(t);
    if (h) return [{ type: "heading", level: Number(h[1]) as 1, children: inlines(n.content) }];
    switch (t) {
      case "paragraph":
        return [{ type: "paragraph", children: inlines(n.content) }];
      case "unordered-list":
      case "ordered-list":
        return [
          {
            type: "list",
            ordered: t === "ordered-list",
            children: (n.content ?? []).map((li) => ({ type: "listItem" as const, children: blocks(li.content) })),
          },
        ];
      case "blockquote":
        return [{ type: "blockquote", children: blocks(n.content) }];
      case "hr":
        return [{ type: "hr" }];
      case "embedded-asset-block": {
        const ref = n.data?.target ? ctx.toRef(n.data.target) : undefined;
        return ref ? [{ type: "embeddedAsset", ref }] : [];
      }
      case "embedded-entry-block": {
        const target = n.data?.target;
        if (!target) return [];
        const html = ctx.htmlOf?.(target.sys.id);
        if (html !== undefined) return [{ type: "rawHtml", html }];
        const ref = ctx.toRef(target);
        return ref ? [{ type: "embeddedEntry", ref }] : [];
      }
      case "table":
        return [{ type: "rawHtml", html: tableHtml(n), reason: "table" }];
      default:
        return n.content ? blocks(n.content) : [];
    }
  };
  const blocks = (nodes: CfNode[] = []): RichBlock[] => nodes.flatMap(block);
  return { type: "doc", children: blocks(doc.content) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function textOf(n: CfNode): string {
  if (n.nodeType === "text") return esc(n.value ?? "");
  return (n.content ?? []).map(textOf).join("");
}
function tableHtml(n: CfNode): string {
  const rows = (n.content ?? []).map((r) => {
    const cells = (r.content ?? []).map((c) => {
      const tag = c.nodeType === "table-header-cell" ? "th" : "td";
      return `<${tag}>${(c.content ?? []).map(textOf).join(" ")}</${tag}>`;
    });
    return `<tr>${cells.join("")}</tr>`;
  });
  return `<table><tbody>${rows.join("")}</tbody></table>`;
}
