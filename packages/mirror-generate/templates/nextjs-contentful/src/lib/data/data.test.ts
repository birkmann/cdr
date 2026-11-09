import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RichTextDoc } from "../ccm-types";
import { richTextToPlainText } from "../richtext/RichText";
import { createCcmSource } from "./ccm-source";
import { normalizeContentful, richTextFromContentful, type CdaAsset, type CdaEntry, type CdaLocale } from "./contentful-normalize";
import { Store } from "./store";
import type { AssetView, CollectionView, EntryView, LinkView, TermView } from "./types";

const CCM_DIR = fileURLToPath(new URL("../../../fixtures/ccm", import.meta.url));
const fake = JSON.parse(readFileSync(new URL("./__fixtures__/fake-space.cda.json", import.meta.url), "utf8")) as { locales: CdaLocale[]; entries: CdaEntry[]; assets: CdaAsset[] };
const assetMap = JSON.parse(readFileSync(new URL("./__fixtures__/asset-map.json", import.meta.url), "utf8")) as Record<string, { assetId: string; ccmId: string }>;
const schema = JSON.parse(readFileSync(`${CCM_DIR}/schema/content-types.json`, "utf8"));
const localeConfig = JSON.parse(readFileSync(`${CCM_DIR}/i18n/locales.json`, "utf8"));
const link = (linkType: "Entry" | "Asset", id: string) => ({ sys: { type: "Link" as const, linkType, id } });

describe("richTextFromContentful", () => {
  it("maps Contentful nodes back to the CCM AST (marks, links, embeds, htmlBlock, tables, soft breaks)", () => {
    const doc = richTextFromContentful(
      {
        nodeType: "document",
        content: [
          { nodeType: "heading-2", content: [{ nodeType: "text", value: "Hi", marks: [] }] },
          {
            nodeType: "paragraph",
            content: [
              { nodeType: "text", value: "a\nb", marks: [{ type: "bold" }] },
              { nodeType: "hyperlink", data: { uri: "https://x.test" }, content: [{ nodeType: "text", value: "ext", marks: [] }] },
              { nodeType: "entry-hyperlink", data: { target: link("Entry", "e1") }, content: [{ nodeType: "text", value: "int", marks: [] }] },
            ],
          },
          { nodeType: "ordered-list", content: [{ nodeType: "list-item", content: [{ nodeType: "paragraph", content: [{ nodeType: "text", value: "one", marks: [] }] }] }] },
          { nodeType: "embedded-asset-block", data: { target: link("Asset", "a1") } },
          { nodeType: "embedded-entry-block", data: { target: link("Entry", "html1") } },
          { nodeType: "table", content: [{ nodeType: "table-row", content: [{ nodeType: "table-header-cell", content: [{ nodeType: "paragraph", content: [{ nodeType: "text", value: "Day", marks: [] }] }] }] }] },
          { nodeType: "hr" },
        ],
      },
      { toRef: (l) => ({ kind: l.sys.linkType === "Asset" ? "asset" : "entry", id: `ccm:${l.sys.id}` }), htmlOf: (id) => (id === "html1" ? "<iframe src=\"https://v\"></iframe>" : undefined) },
    );
    expect(doc.children[0]).toEqual({ type: "heading", level: 2, children: [{ type: "text", value: "Hi" }] });
    expect(doc.children[1]).toEqual({
      type: "paragraph",
      children: [
        { type: "text", value: "a", marks: ["bold"] },
        { type: "break" },
        { type: "text", value: "b", marks: ["bold"] },
        { type: "link", href: "https://x.test", children: [{ type: "text", value: "ext" }] },
        { type: "link", ref: { kind: "entry", id: "ccm:e1" }, children: [{ type: "text", value: "int" }] },
      ],
    });
    expect(doc.children[2]).toMatchObject({ type: "list", ordered: true });
    expect(doc.children[3]).toEqual({ type: "embeddedAsset", ref: { kind: "asset", id: "ccm:a1" } });
    expect(doc.children[4]).toEqual({ type: "rawHtml", html: '<iframe src="https://v"></iframe>' });
    expect(doc.children[5]).toEqual({ type: "rawHtml", html: "<table><tbody><tr><th>Day</th></tr></tbody></table>", reason: "table" });
    expect(doc.children[6]).toEqual({ type: "hr" });
  });
});

describe("normalizeContentful (hand-written CDA JSON)", () => {
  const locales: CdaLocale[] = [
    { code: "en", name: "English", default: true, fallbackCode: null },
    { code: "de", name: "Deutsch", default: false, fallbackCode: "en" },
  ];
  const ct = (id: string) => ({ sys: { id } });
  const entries: CdaEntry[] = [
    {
      sys: { id: "a-1", type: "Entry", contentType: ct("article"), publishedAt: "2024-01-01" },
      fields: {
        ccmId: { en: "drupal:node:3" },
        path: { en: "/news/x", de: "/de/news/x" },
        seo: { en: { title: "X | Site" } },
        title: { en: "X", de: "X de" },
        image: { en: link("Asset", "img-1") },
        tags: { en: [link("Entry", "t-1")] },
      },
    },
    { sys: { id: "p-1", type: "Entry", contentType: ct("page") }, fields: { ccmId: { en: "drupal:node:9" }, path: { en: "/only-en" }, title: { en: "Only EN" } } },
    { sys: { id: "t-1", type: "Entry", contentType: ct("taxonomyTerm") }, fields: { ccmId: { en: "drupal:taxonomy_term:1" }, name: { en: "Breakfast", de: "Frühstück" }, slug: { en: "breakfast", de: "fruehstueck" }, taxonomy: { en: "tags" } } },
    { sys: { id: "n-1", type: "Entry", contentType: ct("navigation") }, fields: { navId: { en: "main" }, title: { en: "Main" }, items: { en: [{ id: "1", label: { en: "News" }, href: "/news", children: [] }] } } },
    { sys: { id: "s-1", type: "Entry", contentType: ct("siteSettings") }, fields: { siteName: { en: { en: "Site", de: "Seite" } }, baseUrl: { en: "https://old.test" }, logo: { en: link("Asset", "img-1") } } },
    { sys: { id: "c-1", type: "Entry", contentType: ct("collectionDefinition") }, fields: { collectionId: { en: "articles--page_news" }, definition: { en: { id: "x", name: "News", type: "article", filters: [], sort: [] } } } },
  ];
  const assets: CdaAsset[] = [
    { sys: { id: "img-1", type: "Asset" }, fields: { title: { en: "Oats" }, description: { en: "Rolled oats", de: "Haferflocken" }, file: { en: { url: "//images.ctfassets.net/s/img-1/h/oats.jpg", fileName: "oats.jpg", contentType: "image/jpeg", details: { size: 1, image: { width: 800, height: 600 } } } } } },
  ];
  const b = normalizeContentful({ entries, assets, locales, localeConfig: [{ code: "de", pathPrefix: "de" }], assetPaths: { "img-1": { ccmId: "drupal:media:22", originalPath: "/sites/default/files/oats.jpg" } } });

  it("produces one CCM entry per routable locale with ccmId, path, meta and resolved refs", () => {
    const art = b.entries.filter((e) => e.ccmId === "drupal:node:3");
    expect(art.map((e) => [e.locale, e.path, e.fields.title])).toEqual([["en", "/news/x", "X"], ["de", "/de/news/x", "X de"]]);
    expect(art[0].meta).toEqual({ title: "X | Site" });
    expect(art[0].fields.image).toEqual({ kind: "asset", id: "drupal:media:22" });
    expect(art[0].fields.tags).toEqual([{ kind: "term", id: "drupal:taxonomy_term:1" }]);
    expect(b.entries.filter((e) => e.ccmId === "drupal:node:9").map((e) => e.locale)).toEqual(["en"]);
  });

  it("maps assets, taxonomy, navigation, settings, collections and locales", () => {
    expect(b.assets[0]).toMatchObject({ ccmId: "drupal:media:22", src: "https://images.ctfassets.net/s/img-1/h/oats.jpg", originalPath: "/sites/default/files/oats.jpg", width: 800, alt: { en: "Rolled oats", de: "Haferflocken" } });
    expect(b.taxonomies[0].terms[0]).toMatchObject({ ccmId: "drupal:taxonomy_term:1", name: { en: "Breakfast", de: "Frühstück" } });
    expect(b.navigation[0]).toMatchObject({ id: "main", items: [{ href: "/news" }] });
    expect(b.settings).toMatchObject({ siteName: { en: "Site", de: "Seite" }, baseUrl: "https://old.test", logo: { kind: "asset", id: "drupal:media:22" } });
    expect(b.collections[0].id).toBe("articles--page_news");
    expect(b.locales.find((l) => l.code === "de")).toMatchObject({ pathPrefix: "de", fallback: "en" });
  });

  it("feeds the same Store: term paths, localized nav hrefs, asset views", async () => {
    const s = new Store(b);
    expect((await s.listPaths()).map((p) => p.path)).toEqual(["/de/news/x", "/de/tags/fruehstueck", "/news/x", "/only-en", "/tags/breakfast"]);
    const de = await s.getEntryByPath("/de/news/x");
    expect((de!.fields.image as AssetView).alt).toBe("Haferflocken");
    expect((de!.fields.tags as TermView[])[0].path).toBe("/de/tags/fruehstueck");
    expect((await s.getNavigation("main", "de"))[0].href).toBe("/de/news");
  });
});

describe("contentful source ≡ ccm source (agent D fake space vs workspace ccm/)", async () => {
  const assetPaths = Object.fromEntries(Object.entries(assetMap).map(([originalPath, v]) => [v.assetId, { ccmId: v.ccmId, originalPath }]));
  const cf = new Store(normalizeContentful({ entries: fake.entries, assets: fake.assets, locales: fake.locales, localeConfig, contentTypes: schema.contentTypes, assetPaths }), { id: "contentful" });
  const ccm = await createCcmSource(CCM_DIR);

  it("lists the same routable paths", async () => {
    const paths = async (s: Store) => (await s.listPaths()).filter((p) => p.kind === "entry").map((p) => p.path);
    expect(await paths(cf)).toEqual(await paths(ccm));
  });

  it("renders the same text, links, assets and collections per page", async () => {
    for (const path of ["/", "/about-us", "/news/healthy-breakfast", "/de", "/de/ueber-uns"]) {
      const a = (await cf.getEntryByPath(path))!;
      const b = (await ccm.getEntryByPath(path))!;
      expect(a.ccmId).toBe(b.ccmId);
      expect(a.fields.title).toBe(b.fields.title);
      expect(a.meta?.title).toBe(b.meta?.title);
      if (b.fields.body) expect(richTextToPlainText(a.fields.body as RichTextDoc)).toBe(richTextToPlainText(b.fields.body as RichTextDoc));
      if (b.fields.image) expect((a.fields.image as AssetView).url).toBe((b.fields.image as AssetView).url);
    }
    const home = (s: EntryView) => s.fields.sections as EntryView[];
    const [cfHome, ccmHome] = [(await cf.getEntryByPath("/de"))!, (await ccm.getEntryByPath("/de"))!];
    expect(home(cfHome).map((x) => x.type)).toEqual(home(ccmHome).map((x) => x.type));
    expect((home(cfHome)[0].fields.cta as LinkView).href).toBe("/de/news/gesundes-fruehstueck");
    const items = (s: EntryView) => (home(s)[2].fields.collection as CollectionView).items.map((i) => i.path);
    expect(items(cfHome)).toEqual(items(ccmHome));
    expect(await cf.getNavigation("main", "de")).toEqual(await ccm.getNavigation("main", "de"));
    expect((await cf.getSettings("de")).siteName).toBe("Nestle Demo Küche");
  });
});

describe("ccm Store", async () => {
  const s = await createCcmSource(CCM_DIR);
  it("routes entries, term pages and collection listing pages with locale prefixes", async () => {
    const paths = (await s.listPaths()).map((p) => `${p.kind}:${p.path}`);
    expect(paths).toContain("entry:/");
    expect(paths).toContain("entry:/de/ueber-uns");
    expect(paths).toContain("collection:/news");
    expect(paths).toContain("collection:/de/news");
    expect(paths).toContain("term:/de/tags/fruehstueck");
    expect(s.localeFromPath("/de/news")).toBe("de");
    expect(s.localeFromPath("/designers")).toBe("en");
  });
  it("resolves rich-text entry links, language-neutral nav hrefs and collections", async () => {
    const about = (await s.getEntryByPath("/about-us"))!;
    const links: string[] = [];
    JSON.stringify(about.fields.body, (k, v) => (k === "href" && typeof v === "string" && links.push(v), v));
    expect(links).toContain("/news/healthy-breakfast");
    const nav = await s.getNavigation("main", "de");
    expect(nav.map((n) => n.href)).toEqual(["/de", "/de/ueber-uns", "/de/news"]);
    expect(nav[2].children[0].href).toBe("/de/news/gesundes-fruehstueck");
    const news = (await s.getEntryByPath("/news"))!;
    expect((news.fields.items as EntryView[]).map((e) => e.path)).toEqual(["/news/fruit", "/news/healthy-breakfast"]);
    expect(await s.getAlternates("drupal:node:2")).toEqual([{ locale: "en", path: "/about-us" }, { locale: "de", path: "/de/ueber-uns" }]);
  });
});

describe("Views listing pages (Umami regression, W2-G)", () => {
  const bundle = (collections: unknown[]) =>
    ({
      contentTypes: [{ id: "recipe", name: "Recipe", kind: "document", fields: [{ id: "title", name: "Title", type: "text" }] }],
      entries: [
        { ccmId: "drupal:node:1", type: "recipe", locale: "en", path: "/en/recipes/quiche", status: "published", fields: { title: "Quiche" } },
        { ccmId: "drupal:node:2", type: "recipe", locale: "en", path: "/en/recipes/pizza", status: "published", fields: { title: "Pizza" } },
      ],
      assets: [],
      taxonomies: [],
      navigation: [],
      redirects: [],
      locales: [
        { code: "en", name: "English", default: true, pathPrefix: "en" },
        { code: "es", name: "Español", fallback: "en", pathPrefix: "es" },
      ],
      collections,
      settings: null,
    }) as never;
  it("routes a Collection with per-locale path, and a crawl-derived (source-html) view at its crawled path", async () => {
    const s = new Store(bundle([{ id: "recipes--page_1", name: "Recipes", type: "recipe", path: { en: "/en/recipes", es: "/es/recipes" }, source: { system: "drupal", kind: "view_display", id: "recipes.page_1" } }]));
    const e = await s.getEntryByPath("/en/recipes");
    expect(e).toMatchObject({ ccmId: "collection:recipes--page_1", type: "collection", fields: { title: "Recipes" } });
    expect(((e!.fields.collection as CollectionView).items as EntryView[]).map((x) => x.path).sort()).toEqual(["/en/recipes/pizza", "/en/recipes/quiche"]);
    expect(await s.getEntryByPath("/es/recipes")).not.toBeNull();
    // the default locale is prefixed too (pathPrefix "en"): neutral links and term pages get /en
    expect(s.prefixOf("en")).toBe("/en");
    expect(s.localizeHref("/tags/egg", "en", true)).toBe("/en/tags/egg");
    expect(s.localizeHref("/en/recipes", "en", true)).toBe("/en/recipes");
    const h = new Store(bundle([{ id: "recipes--page_1", name: "Recipes", type: "recipe", source: { system: "html", kind: "view", id: "recipes.page_1", url: "/en/recipes" } }]));
    expect((await h.getEntryByPath("/en/recipes"))?.type).toBe("collection");
    expect(await h.getEntryByPath("/es/recipes")).toBeNull();
  });
  it("embedded collections with contextual filters run for the current entry (related recipes, W2-J)", async () => {
    const b = bundle([{ id: "related--block_1", name: "Related", type: "recipe", limit: 4, sort: [{ field: "created", direction: "desc" }], filters: [{ field: "ccmId", op: "neq", value: "{{current.ccmId}}" }, { field: "category", op: "in", value: "{{current.terms}}" }], source: { system: "drupal", kind: "view_display", id: "related.block_1", bundle: "block" } }]) as unknown as { entries: Record<string, unknown>[] };
    const cat = (id: string) => [{ kind: "term", id }];
    b.entries = [
      { ccmId: "drupal:node:1", type: "recipe", locale: "en", path: "/en/recipes/quiche", status: "published", fields: { title: "Quiche", category: cat("t:main"), created: "2026-01-03" } },
      { ccmId: "drupal:node:2", type: "recipe", locale: "en", path: "/en/recipes/pizza", status: "published", fields: { title: "Pizza", category: cat("t:main"), created: "2026-01-02" } },
      { ccmId: "drupal:node:3", type: "recipe", locale: "en", path: "/en/recipes/cake", status: "published", fields: { title: "Cake", category: cat("t:dessert"), created: "2026-01-01" } },
    ];
    const s = new Store(b as never);
    expect((await s.runCollection("related--block_1", "en", { current: "drupal:node:1" })).map((e) => e.fields.title)).toEqual(["Pizza"]);
    expect((await s.runCollection("related--block_1", "en", { current: "drupal:node:3" })).map((e) => e.fields.title)).toEqual([]);
    // no current entry: contextual filters do not apply (Views "exception: all")
    expect((await s.runCollection("related--block_1", "en")).length).toBe(3);
  });

  it("term pages live at the source alias (+ locale prefix) when the slug is a full path (W2-J)", async () => {
    const b = bundle([]) as unknown as Record<string, unknown>;
    b.taxonomies = [{ id: "recipe_category", name: "Recipe category", hierarchical: false, terms: [
      { ccmId: "drupal:taxonomy_term:1", name: { en: "Main courses", es: "Platos principales" }, slug: { en: "/recipe-category/main-courses", es: "/recipe-category/platos-principales" }, source: { system: "drupal", kind: "taxonomy_term", id: "1" } },
      { ccmId: "drupal:taxonomy_term:2", name: { en: "Snacks" }, slug: { en: "snacks" }, source: { system: "drupal", kind: "taxonomy_term", id: "2" } },
    ] }];
    const s = new Store(b as never);
    expect((await s.getEntryByPath("/en/recipe-category/main-courses"))?.type).toBe("taxonomyTerm");
    expect((await s.getEntryByPath("/es/recipe-category/platos-principales"))?.type).toBe("taxonomyTerm");
    expect(await s.getEntryByPath("/en/recipe_category/main-courses")).toBeNull();
    // bare slugs keep the /<taxonomy>/<slug> fallback
    expect((await s.getEntryByPath("/en/recipe_category/snacks"))?.type).toBe("taxonomyTerm");
  });
});

describe("startPath — where the logo and language links go", () => {
  const bundle = (redirects: unknown[], locales = [{ code: "de-DE", name: "Deutsch", default: true, pathPrefix: "" }]) =>
    ({
      contentTypes: [{ id: "page", name: "Page", kind: "document", fields: [{ id: "title", name: "Title", type: "text" }] }],
      entries: [{ ccmId: "html:page:/de/home.html", type: "page", locale: "de-DE", path: "/de/index.html", status: "published", fields: { title: "BMW" } }],
      assets: [], taxonomies: [], navigation: [], collections: [], settings: null, locales, redirects,
    }) as never;
  it("follows the site's redirects from an empty locale root to the start page (bmw.de / → /de/index.html)", () => {
    expect(new Store(bundle([{ from: "/", to: "/de/index.html", status: 301 }, { from: "/de/home.html", to: "/de/index.html", status: 301 }])).startPath("de-DE")).toBe("/de/index.html");
    expect(new Store(bundle([{ from: "/", to: "/de/home.html", status: 301 }, { from: "/de/home.html", to: "/de/index.html", status: 301 }])).startPath("de-DE")).toBe("/de/index.html");
  });
  it("keeps the root when it is a page or no redirect leads to one", () => {
    expect(new Store(bundle([])).startPath("de-DE")).toBe("/");
    expect(new Store(bundle([{ from: "/", to: "https://elsewhere.test/", status: 301 }])).startPath("de-DE")).toBe("/");
    const s = new Store(bundle([{ from: "/", to: "/de/index.html", status: 301 }], [{ code: "de-DE", name: "Deutsch", default: true, pathPrefix: "de" }]));
    expect(s.startPath("de-DE")).toBe("/de"); // prefixed root: no redirect from /de, nothing to follow
  });
});
