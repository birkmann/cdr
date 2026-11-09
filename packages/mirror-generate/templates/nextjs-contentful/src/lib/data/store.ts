/**
 * In-memory CCM store implementing DataSource. Both data sources end up here:
 *  - `ccm`: bundle read from the workspace ccm/ directory (build time, offline)
 *  - `contentful`: CDA entries normalised back to a CCM bundle (contentful-normalize.ts)
 * so reference resolution, collections, navigation and routing behave identically.
 */
import { createHash } from "node:crypto";
import type {
  Asset,
  CollectionDef,
  ContentType,
  Entry,
  FieldDef,
  Locale,
  NavItem,
  Navigation,
  Redirect,
  Reference,
  RichBlock,
  RichInline,
  RichTextDoc,
  SiteSettings,
  Taxonomy,
  Term,
} from "../ccm-types";
import type {
  AssetView,
  CollectionView,
  DataSource,
  EntryStub,
  EntryView,
  LinkView,
  NavItemView,
  PathInfo,
  SettingsView,
  TermView,
} from "./types";

export interface CcmBundle {
  contentTypes: ContentType[];
  entries: Entry[];
  assets: Asset[];
  taxonomies: Taxonomy[];
  navigation: Navigation[];
  redirects: Redirect[];
  locales: Locale[];
  collections: CollectionDef[];
  settings: SiteSettings | null;
}

export interface StoreOptions {
  id?: "ccm" | "contentful";
  /** include drafts (preview) */
  includeDrafts?: boolean;
  /** public URL for an asset; default: originalPath, else absolute src, else /_assets/<safeId>/<fileName> */
  assetUrl?: (a: Asset) => string;
}

const DOC_DEPTH = 2; // expand document references this deep (teasers need title/image/path)
const COMPONENT_DEPTH = 8;

/**
 * Filesystem-safe id — same algorithm as @cmp/core `safeId` (the generator writes public/_assets/<safeId>/ with it):
 * ids longer than 200 chars after sanitising (asset URLs with long query strings) are truncated and suffixed with a
 * sha1 of the full id, so a path segment stays under the 255-byte filesystem limit.
 */
export function safeId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s.length) return "root";
  if (s.length <= 200) return s;
  const hash = createHash("sha1").update(id).digest("hex").slice(0, 12);
  return `${s.slice(0, 200 - 12 - 1).replace(/[._-]+$/, "")}_${hash}`;
}

export function defaultAssetUrl(a: Asset): string {
  if (a.originalPath) return a.originalPath.startsWith("/") ? a.originalPath : "/" + a.originalPath;
  if (/^https?:\/\//.test(a.src) || a.src.startsWith("//")) return a.src;
  return `/_assets/${safeId(a.ccmId)}/${a.fileName}`;
}

export function normalisePrefix(p: string | undefined): string {
  const s = (p ?? "").trim().replace(/^\/+|\/+$/g, "");
  return s ? "/" + s : "";
}

export function joinPrefix(prefix: string, path: string): string {
  if (!prefix) return path || "/";
  if (!path || path === "/") return prefix;
  return prefix + (path.startsWith("/") ? path : "/" + path);
}

function isRef(v: unknown): v is Reference {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Reference).id === "string" &&
    ["entry", "asset", "term"].includes((v as Reference).kind) &&
    Object.keys(v as object).every((k) => k === "kind" || k === "id")
  );
}
function isDoc(v: unknown): v is RichTextDoc {
  return !!v && typeof v === "object" && (v as RichTextDoc).type === "doc" && Array.isArray((v as RichTextDoc).children);
}
function isLinkValue(v: unknown): v is { href?: string; ref?: Reference; label?: string; title?: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  return keys.length > 0 && keys.every((k) => ["href", "ref", "label", "title", "uri", "options", "entryId", "path"].includes(k)) && ("href" in o || "ref" in o || "uri" in o);
}
function pick(rec: Record<string, string> | string | undefined, locale: string, chain: string[]): string | undefined {
  if (rec == null) return undefined;
  if (typeof rec === "string") return rec;
  for (const l of [locale, ...chain]) if (rec[l] != null) return rec[l];
  const first = Object.values(rec)[0];
  return first;
}

export class Store implements DataSource {
  readonly id: "ccm" | "contentful";
  private locales: Locale[];
  private defaultLocale: string;
  private types = new Map<string, ContentType>();
  private byId = new Map<string, Map<string, Entry>>();
  private byPath = new Map<string, Entry>();
  private assets = new Map<string, Asset>();
  private assetsByPath = new Map<string, Asset>();
  private terms = new Map<string, Term & { taxonomy: string }>();
  private nav = new Map<string, Navigation>();
  private collections = new Map<string, CollectionDef>();
  private termPaths = new Map<string, { term: Term & { taxonomy: string }; locale: string }>();
  private collectionPaths = new Map<string, { def: CollectionDef; locale: string }>();
  private nodeIndex = new Map<string, string>(); // drupal nid -> ccmId

  constructor(
    readonly bundle: CcmBundle,
    private opts: StoreOptions = {},
  ) {
    this.id = opts.id ?? "ccm";
    this.locales = bundle.locales.length ? bundle.locales : [{ code: "en", name: "English", default: true, pathPrefix: "" }];
    this.defaultLocale = (this.locales.find((l) => l.default) ?? this.locales[0]).code;
    for (const t of bundle.contentTypes) this.types.set(t.id, t);
    for (const e of bundle.entries) {
      if (!opts.includeDrafts && e.status && e.status !== "published") continue;
      let m = this.byId.get(e.ccmId);
      if (!m) this.byId.set(e.ccmId, (m = new Map()));
      m.set(e.locale, e);
      if (e.path && this.isRoutable(e)) this.byPath.set(normPath(e.path), e);
      if (e.source?.system === "drupal" && e.source.kind === "node") this.nodeIndex.set(e.source.id, e.ccmId);
    }
    for (const a of bundle.assets) {
      this.assets.set(a.ccmId, a);
      if (a.originalPath) this.assetsByPath.set(normPath(a.originalPath), a);
    }
    for (const tx of bundle.taxonomies) for (const t of tx.terms) this.terms.set(t.ccmId, { ...t, taxonomy: tx.id });
    for (const n of bundle.navigation) this.nav.set(n.id, n);
    for (const c of bundle.collections) this.collections.set(c.id, c);
    // term + collection listing pages (only when not shadowed by a real entry)
    for (const t of this.terms.values())
      for (const l of this.locales) {
        const p = this.termPath(t, l.code);
        if (p && !this.byPath.has(p) && (t.slug?.[l.code] || l.code === this.defaultLocale)) this.termPaths.set(p, { term: t, locale: l.code });
      }
    for (const c of this.collections.values())
      for (const l of this.locales) {
        const p = this.collectionPath(c, l.code);
        if (p && !this.byPath.has(p)) this.collectionPaths.set(p, { def: c, locale: l.code });
      }
  }

  // ------------------------------------------------------------ locales & paths

  async getLocales() {
    return this.locales;
  }
  async getContentTypes() {
    return [...this.types.values()];
  }
  get default() {
    return this.defaultLocale;
  }
  prefixOf(locale: string): string {
    const l = this.locales.find((x) => x.code === locale);
    if (!l) return "";
    // the default locale has no prefix unless the site configures one (Drupal language negotiation with "en" for
    // English too: /en/..., Umami)
    return normalisePrefix(l.pathPrefix ?? (l.default ? "" : l.code));
  }
  /**
   * Start page of a locale: its root (prefix or "/") when a page lives there, else the page the site's redirects send
   * that root to (bvg.de/ → /de, bmw.de/ → /de/index.html). Logo and language links point here, not at a redirect.
   */
  startPath(locale: string): string {
    const root = this.prefixOf(locale) || "/";
    if (this.routeInfo(root)) return root;
    let cur = root;
    for (let i = 0; i < 5; i++) {
      const r = this.bundle.redirects.find((x) => normPath(x.from) === cur);
      if (!r || !r.to.startsWith("/")) break;
      cur = normPath(r.to.split(/[?#]/)[0]!);
      if (this.routeInfo(cur)) return cur;
    }
    return root;
  }
  localeFromPath(path: string): string {
    const p = normPath(path);
    for (const l of this.locales) {
      const pre = this.prefixOf(l.code);
      if (pre && (p === pre || p.startsWith(pre + "/"))) return l.code;
    }
    return this.defaultLocale;
  }
  private chain(locale: string): string[] {
    const out: string[] = [];
    let cur = this.locales.find((l) => l.code === locale)?.fallback;
    while (cur && !out.includes(cur) && cur !== locale) {
      out.push(cur);
      cur = this.locales.find((l) => l.code === cur)?.fallback;
    }
    if (!out.includes(this.defaultLocale) && locale !== this.defaultLocale) out.push(this.defaultLocale);
    return out;
  }
  private isRoutable(e: Entry): boolean {
    const t = this.types.get(e.type);
    return !t || t.kind === undefined || t.kind === "document";
  }
  private termPath(t: Term & { taxonomy: string }, locale: string): string | undefined {
    const slug = t.slug?.[locale] ?? (locale === this.defaultLocale ? t.slug?.[this.defaultLocale] : undefined);
    if (!slug) return undefined;
    // a slug with a leading "/" is the term's full path (source alias, e.g. "/recipe-category/x"); the locale prefix is
    // added unless the slug already carries one
    if (slug.startsWith("/")) return normPath(this.locales.some((l) => { const pre = this.prefixOf(l.code); return pre && (slug === pre || slug.startsWith(pre + "/")); }) ? slug : joinPrefix(this.prefixOf(locale), slug));
    return normPath(joinPrefix(this.prefixOf(locale), `/${t.taxonomy}/${slug}`));
  }
  private collectionPath(c: CollectionDef, locale: string): string | undefined {
    // explicit `path` extension, else a Drupal view *page* display (source.url = its path), else a listing read from a
    // crawled page (source-html: source.url = that live path, locale prefix included) for the locale it was crawled in
    let p = c.path ?? (c.source?.kind === "view_display" && c.source.bundle === "page" && c.source.url?.startsWith("/") ? c.source.url : undefined);
    if (!p && c.source?.system === "html" && /^view/.test(c.source.kind) && c.source.url?.startsWith("/")) p = { [this.localeFromPath(c.source.url)]: c.source.url };
    if (!p) return undefined;
    if (typeof p === "string") return normPath(joinPrefix(this.prefixOf(locale), p));
    const v = p[locale];
    return v ? normPath(v) : undefined;
  }

  async listPaths(): Promise<PathInfo[]> {
    const out: PathInfo[] = [];
    for (const [path, e] of this.byPath)
      out.push({ path, locale: e.locale, ccmId: e.ccmId, type: e.type, kind: "entry", lastModified: e.sourceChangedAt });
    for (const [path, { term, locale }] of this.termPaths) out.push({ path, locale, ccmId: term.ccmId, type: "taxonomyTerm", kind: "term" });
    for (const [path, { def, locale }] of this.collectionPaths) out.push({ path, locale, ccmId: def.id, type: "collection", kind: "collection" });
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async getAlternates(ccmId: string) {
    const m = this.byId.get(ccmId);
    const out: { locale: string; path: string }[] = [];
    if (m) for (const e of m.values()) if (e.path) out.push({ locale: e.locale, path: normPath(e.path) });
    if (!out.length) {
      const t = this.terms.get(ccmId);
      if (t) for (const l of this.locales) { const p = this.termPath(t, l.code); if (p && this.termPaths.has(p)) out.push({ locale: l.code, path: p }); }
      const c = this.collections.get(ccmId);
      if (c) for (const l of this.locales) { const p = this.collectionPath(c, l.code); if (p) out.push({ locale: l.code, path: p }); }
    }
    const order = this.locales.map((l) => l.code);
    return out.sort((a, b) => order.indexOf(a.locale) - order.indexOf(b.locale));
  }

  /** what lives at a path (entry, term page or collection page) */
  routeInfo(path: string): PathInfo | null {
    const p = normPath(path);
    const e = this.byPath.get(p);
    if (e) return { path: p, locale: e.locale, ccmId: e.ccmId, type: e.type, kind: "entry" };
    const t = this.termPaths.get(p);
    if (t) return { path: p, locale: t.locale, ccmId: t.term.ccmId, type: "taxonomyTerm", kind: "term" };
    const c = this.collectionPaths.get(p);
    if (c) return { path: p, locale: c.locale, ccmId: c.def.id, type: "collection", kind: "collection" };
    return null;
  }

  async getEntryByPath(path: string, locale?: string): Promise<EntryView | null> {
    const p = normPath(path);
    const e = this.byPath.get(p);
    if (e) return this.view(e, locale ?? e.locale, 0, new Set());
    // synthetic entries for term + collection listing pages
    const t = this.termPaths.get(p);
    if (t) {
      const loc = locale ?? t.locale;
      const tagged = this.bundle.entries
        .filter((x) => x.locale === loc && this.byPath.get(normPath(x.path ?? "")) === x)
        .filter((x) => Object.values(x.fields).some((v) => refList(v).some((r) => r.kind === "term" && r.id === t.term.ccmId)));
      return {
        _kind: "entry",
        ccmId: t.term.ccmId,
        type: "taxonomyTerm",
        locale: loc,
        path: p,
        slug: p.split("/").pop(),
        status: "published",
        fields: {
          title: pick(t.term.name, loc, this.chain(loc)) ?? "",
          name: pick(t.term.name, loc, this.chain(loc)) ?? "",
          description: pick(t.term.description, loc, this.chain(loc)),
          taxonomy: t.term.taxonomy,
          items: this.sortDefault(tagged).map((x) => this.view(x, loc, 1, new Set())),
        },
        meta: { title: pick(t.term.name, loc, this.chain(loc)) },
      };
    }
    const c = this.collectionPaths.get(p);
    if (c) {
      const loc = locale ?? c.locale;
      const items = this.runCollectionSync(c.def, loc);
      return {
        _kind: "entry",
        ccmId: `collection:${c.def.id}`,
        type: "collection",
        locale: loc,
        path: p,
        slug: p.split("/").pop(),
        status: "published",
        fields: { title: c.def.name, collection: { _kind: "collection", id: c.def.id, items } satisfies CollectionView, items },
      };
    }
    return null;
  }

  // ------------------------------------------------------------ resolution

  private localized(ccmId: string, locale: string): Entry | undefined {
    const m = this.byId.get(ccmId);
    if (!m) return undefined;
    for (const l of [locale, ...this.chain(locale)]) {
      const e = m.get(l);
      if (e) return e;
    }
    return m.values().next().value;
  }

  private view(e: Entry, locale: string, depth: number, seen: Set<string>): EntryView {
    const t = this.types.get(e.type);
    const nextSeen = new Set(seen).add(e.ccmId);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.fields ?? {})) {
      const def = t?.fields.find((f) => f.id === k);
      fields[k] = this.resolveValue(v, def, locale, depth, nextSeen);
    }
    return {
      _kind: "entry",
      ccmId: e.ccmId,
      type: e.type,
      locale: e.locale,
      path: e.path ? normPath(e.path) : undefined,
      slug: e.slug,
      status: e.status ?? "published",
      fields,
      meta: e.meta,
      sourceChangedAt: e.sourceChangedAt,
      source: e.source,
    };
  }

  private resolveValue(v: unknown, def: FieldDef | undefined, locale: string, depth: number, seen: Set<string>): unknown {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map((x) => this.resolveValue(x, def, locale, depth, seen));
    if (isRef(v)) return this.resolveRef(v, def, locale, depth, seen);
    if (isDoc(v)) return this.resolveDoc(v, locale, depth, seen);
    if (def?.type === "link" || isLinkValue(v)) return this.resolveLink(v as never, locale);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      // views reference (Drupal viewsreference) → collection
      const cid = typeof o.collection === "string" ? o.collection : undefined;
      if (cid && this.collections.has(cid)) {
        const items = this.runCollectionSync(this.collections.get(cid)!, locale, typeof o.limit === "number" ? o.limit : undefined);
        return { ...o, _kind: "collection", id: cid, items } satisfies CollectionView & Record<string, unknown>;
      }
    }
    if (typeof v === "string" && def?.type === "json" && this.collections.has(v)) {
      return { _kind: "collection", id: v, items: this.runCollectionSync(this.collections.get(v)!, locale) } satisfies CollectionView;
    }
    return v;
  }

  resolveRef(r: Reference, def: FieldDef | undefined, locale: string, depth: number, seen: Set<string>): unknown {
    if (r.kind === "asset") return this.assetView(r.id, locale);
    if (r.kind === "term") return this.termView(r.id, locale);
    const target = this.localized(r.id, locale);
    if (!target) return { _kind: "entryStub", ccmId: r.id } satisfies EntryStub;
    const isComponent = this.types.get(target.type)?.kind === "component" || def?.type === "component" || def?.type === "componentList";
    const limit = isComponent ? COMPONENT_DEPTH : DOC_DEPTH;
    if (seen.has(r.id) || depth >= limit) return this.stub(target, locale);
    return this.view(target, locale, depth + 1, seen);
  }

  private stub(e: Entry, locale: string): EntryStub {
    const t = this.types.get(e.type);
    const title = (t?.displayField && e.fields[t.displayField]) ?? e.fields.title ?? e.fields.name;
    return { _kind: "entryStub", ccmId: e.ccmId, type: e.type, path: this.pathFor(e.ccmId, locale), title: typeof title === "string" ? title : undefined };
  }

  /** path of an entry in a locale (falls back along the locale chain) */
  pathFor(ccmId: string, locale: string): string | undefined {
    const e = this.localized(ccmId, locale);
    if (e?.path) return normPath(e.path);
    const t = this.terms.get(ccmId);
    if (t) return this.termPath(t, locale) ?? this.termPath(t, this.defaultLocale);
    return undefined;
  }

  assetView(id: string, locale: string): AssetView | null {
    const a = this.assets.get(id);
    if (!a) return null;
    const chain = this.chain(locale);
    return {
      _kind: "asset",
      ccmId: a.ccmId,
      url: (this.opts.assetUrl ?? defaultAssetUrl)(a),
      src: a.src,
      originalPath: a.originalPath,
      fileName: a.fileName,
      mime: a.mime,
      width: a.width,
      height: a.height,
      alt: pick(a.alt, locale, chain) ?? "",
      title: pick(a.title, locale, chain) ?? "",
    };
  }

  termView(id: string, locale: string): TermView | null {
    const t = this.terms.get(id);
    if (!t) return null;
    const chain = this.chain(locale);
    return { _kind: "term", ccmId: t.ccmId, locale, name: pick(t.name, locale, chain) ?? "", slug: pick(t.slug, locale, chain), path: this.termPath(t, locale) };
  }

  resolveLink(v: { href?: string; ref?: Reference; label?: string; title?: string; uri?: string; path?: string }, locale: string): LinkView {
    let href = v.href ?? v.uri ?? "";
    // Contentful mapping: link objects also carry the target's `path` in that locale
    if (v.ref) href = (v.ref.kind === "asset" ? this.assetView(v.ref.id, locale)?.url : this.pathFor(v.ref.id, locale)) ?? v.path ?? href;
    href = this.localizeHref(href, locale, !v.ref);
    return { _kind: "link", href, label: v.label ?? v.title ?? "", external: /^[a-z]+:/i.test(href) && !href.startsWith("/"), title: v.title };
  }

  /** Drupal-ish internal hrefs → live paths of the current locale */
  localizeHref(href: string, locale: string, neutral = false): string {
    if (!href) return href;
    let h = href.replace(/^internal:/, "");
    if (h === "route:<front>" || h === "<front>") h = "/";
    const node = /^(?:entity:)?\/?node\/(\d+)(.*)$/.exec(h);
    if (node && this.nodeIndex.has(node[1])) h = (this.pathFor(this.nodeIndex.get(node[1])!, locale) ?? h) + node[2];
    if (!h.startsWith("/")) return h;
    const pre = this.prefixOf(locale);
    if (pre && !(h === pre || h.startsWith(pre + "/"))) {
      const cand = joinPrefix(pre, h);
      // NavItem/LinkValue hrefs are language-neutral (contract): always prefix, except file/system paths.
      // Rich-text hrefs come from rendered HTML (already prefixed by Drupal): prefix only when that route exists.
      if (this.routeInfo(cand) || (neutral && !/^\/(sites|themes|core|modules|_next|api)\//.test(h))) return cand;
    }
    return h;
  }

  private resolveDoc(doc: RichTextDoc, locale: string, depth: number, seen: Set<string>): RichTextDoc {
    const inl = (n: RichInline): RichInline => {
      if (n.type === "link") {
        const href = n.ref ? (n.ref.kind === "asset" ? this.assetView(n.ref.id, locale)?.url : this.pathFor(n.ref.id, locale)) ?? n.href : n.href;
        return { ...n, href: href ? this.localizeHref(href, locale) : href, children: n.children.map(inl) };
      }
      if (n.type === "inlineEntry") return { ...n, entry: this.resolveRef(n.ref, undefined, locale, depth, seen) };
      return n;
    };
    const blk = (b: RichBlock): RichBlock => {
      switch (b.type) {
        case "paragraph":
        case "heading":
          return { ...b, children: b.children.map(inl) } as RichBlock;
        case "list":
          return { ...b, children: b.children.map((li) => ({ ...li, children: li.children.map(blk) })) };
        case "blockquote":
          return { ...b, children: b.children.map(blk) };
        case "embeddedAsset":
          return { ...b, asset: b.ref.kind === "asset" ? this.assetView(b.ref.id, locale) : null };
        case "embeddedEntry":
          return { ...b, entry: this.resolveRef(b.ref, { id: "", name: "", type: "component" }, locale, depth, seen) };
        default:
          return b;
      }
    };
    return { type: "doc", children: doc.children.map(blk) };
  }

  // ------------------------------------------------------------ navigation & settings

  async getNavigation(id: string, locale: string): Promise<NavItemView[]> {
    const n = this.nav.get(id);
    if (!n) return [];
    const chain = this.chain(locale);
    const conv = (it: NavItem, level: number): NavItemView => {
      const resolved = it.path?.[locale] ?? (it.ref ? this.pathFor(it.ref.id, locale) : undefined);
      const href = resolved ? this.localizeHref(resolved, locale) : this.localizeHref(it.href ?? "", locale, true);
      return {
        id: it.id,
        label: pick(it.label, locale, chain) ?? "",
        href,
        external: /^[a-z]+:/i.test(href),
        weight: it.weight ?? 0,
        level,
        children: sortNav(it.children ?? []).map((c) => conv(c, level + 1)),
      };
    };
    return sortNav(n.items).map((i) => conv(i, 1));
  }

  async getSettings(locale: string): Promise<SettingsView> {
    const s = this.bundle.settings;
    const chain = this.chain(locale);
    const extra = (s?.extra ?? {}) as Record<string, unknown>;
    const slogan = extra.slogan as Record<string, string> | string | undefined;
    return {
      siteName: pick(s?.siteName, locale, chain) ?? "",
      slogan: pick(slogan, locale, chain),
      baseUrl: s?.baseUrl ?? "",
      logo: s?.logo ? (this.assetView(s.logo.id, locale) ?? undefined) : undefined,
      footerText: pick(s?.footerText, locale, chain),
      seoDefaults: s?.seoDefaults,
      scripts: s?.scripts ?? [],
      extra,
    };
  }

  async getAssetByPath(originalPath: string) {
    const a = this.assetsByPath.get(normPath(originalPath));
    return a ? this.assetView(a.ccmId, this.defaultLocale) : null;
  }
  async getRedirects() {
    return this.bundle.redirects;
  }

  // ------------------------------------------------------------ collections

  async getCollection(id: string) {
    return this.collections.get(id) ?? null;
  }
  /** `current` = ccmId of the entry the listing is embedded in (contextual filters, e.g. related recipes) */
  async runCollection(def: CollectionDef | string, locale: string, opts: { page?: number; current?: string } = {}) {
    const d = typeof def === "string" ? this.collections.get(def) : def;
    if (!d) return [];
    return this.runCollectionSync(d, locale, undefined, opts.page, opts.current);
  }

  private runCollectionSync(def: CollectionDef, locale: string, limitOverride?: number, page = 0, current?: string): EntryView[] {
    const cm = current ? this.byId.get(current) : undefined;
    const cur = cm ? (cm.get(locale) ?? cm.get(this.defaultLocale) ?? [...cm.values()][0]) : undefined;
    const pool = [...this.byId.values()].map((m) => m.get(locale)).filter((e): e is Entry => !!e && e.type === def.type);
    let rows = pool.filter((e) => (def.filters ?? []).every((f) => matchFilter(e, f, cur)));
    rows = (def.sort ?? []).length ? sortBy(rows, def.sort ?? []) : this.sortDefault(rows);
    const size = def.pagination?.pageSize;
    if (size) rows = rows.slice(page * size, page * size + size);
    const lim = limitOverride ?? def.limit;
    if (lim) rows = rows.slice(0, lim);
    return rows.map((e) => this.view(e, locale, 1, new Set()));
  }

  private sortDefault(rows: Entry[]): Entry[] {
    return sortBy(rows, [{ field: "created", direction: "desc" }]);
  }
}

// ------------------------------------------------------------ helpers

export function normPath(p: string): string {
  let s = (p || "/").split("#")[0].split("?")[0];
  if (!s.startsWith("/")) s = "/" + s;
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s || "/";
}

function refList(v: unknown): Reference[] {
  if (isRef(v)) return [v];
  if (Array.isArray(v)) return v.filter(isRef);
  return [];
}

function sortNav(items: NavItem[]): NavItem[] {
  return items.map((x, i) => ({ x, i })).sort((a, b) => (a.x.weight ?? 0) - (b.x.weight ?? 0) || a.i - b.i).map((p) => p.x);
}

const camel = (s: string) => s.replace(/^field_/, "").replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function fieldOf(e: Entry, field: string): unknown {
  if (field === "type") return e.type;
  if (field === "status") return e.status ?? "published";
  if (field === "locale" || field === "langcode") return e.locale;
  if (field === "path") return e.path;
  if (field === "ccmId") return e.ccmId;
  if (field in e.fields) return e.fields[field];
  const c = camel(field);
  if (c in e.fields) return e.fields[c];
  if (field === "created") return e.fields.createdAt ?? e.fields.date ?? e.fields.publishedAt ?? e.sourceChangedAt;
  if (field === "changed") return e.sourceChangedAt;
  return undefined;
}

function scalar(v: unknown): unknown {
  if (isRef(v)) return v.id;
  return v;
}

/**
 * Contextual filter values (Drupal Views contextual arguments, written by the source adapters): `{{current.ccmId}}`
 * = the entry the listing is shown on, `{{current.terms}}` = every term it references, `{{current.<field>}}` = that
 * field's value (refs → ids). Without a current entry the filter does not apply (Views "exception: all").
 */
export function contextValue(val: unknown, cur: Entry | undefined): { skip: boolean; value: unknown } {
  const m = typeof val === "string" ? /^\{\{current\.([\w$]+)\}\}$/.exec(val) : null;
  if (!m) return { skip: false, value: val };
  if (!cur) return { skip: true, value: undefined };
  if (m[1] === "ccmId") return { skip: false, value: cur.ccmId };
  if (m[1] === "terms") return { skip: false, value: Object.values(cur.fields).flatMap((v) => refList(v).filter((r) => r.kind === "term").map((r) => r.id)) };
  const raw = fieldOf(cur, m[1]);
  return { skip: false, value: Array.isArray(raw) ? raw.map(scalar) : scalar(raw) };
}

function matchFilter(e: Entry, f: { field: string; op: string; value: unknown }, cur?: Entry): boolean {
  const raw = fieldOf(e, f.field);
  const cv = contextValue(f.value, cur);
  if (cv.skip) return true;
  let val = cv.value;
  if (f.field === "status" && typeof val === "boolean") return val ? (e.status ?? "published") === "published" : (e.status ?? "published") !== "published";
  if (f.field === "status" && (val === 1 || val === "1")) val = "published";
  const vals = Array.isArray(raw) ? raw.map(scalar) : [scalar(raw)];
  switch (f.op) {
    case "eq":
      return vals.some((x) => x === val || String(x) === String(val));
    case "neq":
      return !vals.some((x) => x === val || String(x) === String(val));
    case "in":
      return Array.isArray(val) && vals.some((x) => (val as unknown[]).map(String).includes(String(x)));
    case "contains":
      return vals.some((x) => typeof x === "string" && x.includes(String(val)));
    case "exists":
      return (raw != null && raw !== "") === (val !== false);
    case "gt":
      return vals.some((x) => cmp(x, val) > 0);
    case "lt":
      return vals.some((x) => cmp(x, val) < 0);
    default:
      return true;
  }
}

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function sortBy(rows: Entry[], sort: { field: string; direction: "asc" | "desc" }[]): Entry[] {
  return rows
    .map((e, i) => ({ e, i }))
    .sort((x, y) => {
      for (const s of sort) {
        const c = cmp(fieldOf(x.e, s.field), fieldOf(y.e, s.field));
        if (c) return s.direction === "desc" ? -c : c;
      }
      return x.e.ccmId < y.e.ccmId ? -1 : x.e.ccmId > y.e.ccmId ? 1 : x.i - y.i;
    })
    .map((p) => p.e);
}
