/**
 * W2-K regressions (Umami JSON:API, uncrawled article pages):
 *  - the "submitted" byline: author label (`field--name-uid`, plain text) binds to the CCM `author` field, the printed
 *    date ("25th October 2026" / "25th Octubre 2026", PHP "jS F Y", no <time>) binds to `created` with the pattern
 *  - a Views block in the sidebar region of the type wrapper ("More featured articles") becomes a slot component whose
 *    rows bind to the view's CCM collection; the block renders only when the collection has rows
 *  - enum labels per locale from the source's config translations and from teaser cards linking to their entity
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTempWorkspace } from "@harness/mirror-core";
import { mineComponents, normalizeHtml, reconcileWithCcm, renderTemplate, serverPageInfo, type MinePage } from "../src/index.js";
import { detectPhpDate, formatPhpDate } from "../src/php-date.js";

const FIX = fileURLToPath(new URL("./__fixtures__/drupal-core/article-herbs.html", import.meta.url));
const BASE = "http://drupal.test";

describe("PHP date patterns (Drupal date formats Intl can't print)", () => {
  it("formats and detects 'jS F Y' with English ordinals and title-cased translated month names", () => {
    expect(formatPhpDate("2026-10-25T20:38:07.000Z", "jS F Y", "en")).toBe("25th October 2026");
    expect(formatPhpDate("2026-11-01T20:38:06Z", "jS F Y", "es", "title")).toBe("1st Noviembre 2026");
    expect(formatPhpDate("2026-10-22T08:05:00Z", "D, m/d/Y - H:i", "en")).toBe("Thu, 10/22/2026 - 08:05");
    expect(formatPhpDate("2026-10-12T00:00:00Z", "jS \\o\\f F", "en")).toBe("12th of October");
    expect(detectPhpDate("2026-10-25T20:38:07.000Z", "25th Octubre 2026", "es")).toEqual({ pattern: "jS F Y", tag: "es", case: "title" });
    expect(detectPhpDate("2026-10-25T20:38:07.000Z", "26th October 2026", "en")).toBeUndefined();
  });
});

async function minedArticle() {
  const en = await readFile(FIX, "utf8");
  const es = en
    .replace('lang="en"', 'lang="es"')
    .replace(">by <", ">por <")
    .replace("25th October 2026", "25th Octubre 2026")
    .replace("More featured articles", "Más artículos destacados")
    .replaceAll("View Article", "Ver artículo")
    .replaceAll('href="/en', 'href="/es')
    .replace(">Home<", ">Inicio<");
  const mk = (src: string, path: string, locale: string): MinePage => {
    const info = serverPageInfo(src, path, BASE);
    return { path, locale, info, ccmType: "article", rawInfo: info };
  };
  return mineComponents([mk(en, "/en/articles/herbs", "en"), mk(es, "/es/articles/hierbas", "es")], { defaultLocale: "en", rich: true });
}

async function ccmWorkspace() {
  const t = await createTempWorkspace("byline");
  const { ws } = t;
  await ws.writeJson("ccm/schema/content-types.json", {
    contentTypes: [{ id: "article", name: "Article", kind: "document", fields: [{ id: "title", name: "Title", type: "text" }, { id: "created", name: "Created", type: "date" }, { id: "author", name: "Author", type: "text" }, { id: "body", name: "Body", type: "richText" }] }],
  });
  await ws.writeJson("ccm/i18n/locales.json", [{ code: "en", name: "English", default: true, pathPrefix: "en" }, { code: "es", name: "Español", pathPrefix: "es" }]);
  for (const [lc, path] of [["en", "/en/articles/herbs"], ["es", "/es/articles/hierbas"]])
    await ws.writeJson(ws.entryPath("article", "drupal:node:11", lc), { ccmId: "drupal:node:11", type: "article", locale: lc, path, status: "published", fields: { title: "Herbs", created: "2026-10-25T20:38:07.000Z", author: "Holly Foat" }, source: { system: "drupal", kind: "node", id: "11" } });
  await ws.writeJson("ccm/collections/articles_aside--block_1.json", { id: "articles_aside--block_1", name: "More featured articles", type: "article", filters: [{ field: "ccmId", op: "neq", value: "{{current.ccmId}}" }], sort: [{ field: "created", direction: "desc" }], limit: 3, manual: false });
  return t;
}

describe("article byline + sidebar Views block (Umami uncrawled articles, W2-K)", () => {
  it("binds the author label and the printed date to CCM fields; the sidebar view block is a collection-bound slot", async () => {
    const r = await minedArticle();
    const { ws, cleanup } = await ccmWorkspace();
    try {
      const rec = await reconcileWithCcm(ws, r.components, { locale: "en" });
      expect(rec!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["DESIGN_DATE_BOUND", "DESIGN_COLLECTION_BOUND"]));
      const body = r.components.find((c) => c.id === "articleBody")!;
      const by = Object.fromEntries(body.props.map((p) => [p.name, p]));
      expect(by.uid).toMatchObject({ type: "text", ccmField: "author" });
      expect(by.created).toMatchObject({ ccmField: "created", format: { kind: "date", pattern: "jS F Y", locales: { en: "en", es: "es" }, case: { es: "title" } } });
      expect(body.template).toContain("{{created.formatted}}");
      expect(body.template).toContain("<span>{{uid}}</span>");
      expect(body.template).not.toContain("October");
      // still reproduces the crawled example and the es instance
      expect(normalizeHtml(renderTemplate(body.template, body.exampleProps))).toBe(normalizeHtml(body.exampleHtml));
      const t = { ...(body.exampleProps.t as Record<string, unknown>), by: "por" };
      expect(normalizeHtml(renderTemplate(body.template, { ...body.exampleProps, ...body.instanceProps!["/es/articles/hierbas"], t }))).toContain("25th Octubre 2026");

      const tpl = r.templates.find((x) => x.contentType === "article")!;
      expect(tpl.slots).toContainEqual({ component: "blockDemoViewsBlockArticlesAsideBlock1", region: "sidebar" });
      expect(tpl.wrapperHtml).toContain("{{{regions.sidebar}}}");
      expect(tpl.wrapperHtml).not.toContain("Oatmeal");
      const block = r.components.find((c) => c.id === "blockDemoViewsBlockArticlesAsideBlock1")!;
      expect(block.props.find((p) => p.name === "items")).toMatchObject({ collection: "articles_aside--block_1", itemComponent: "articleCard" });
      expect(block.props.find((p) => p.name.startsWith("t."))?.i18n).toEqual({ en: "More featured articles", es: "Más artículos destacados" });
      expect(block.template.startsWith("{{#if items}}")).toBe(true);
      expect(renderTemplate(block.template, { ...block.exampleProps, items: [] }).trim()).toBe("");
      expect(normalizeHtml(renderTemplate(block.template, block.exampleProps))).toBe(normalizeHtml(block.exampleHtml));
      expect(r.components.find((c) => c.id === "articleCard")?.props.map((p) => p.name)).toEqual(expect.arrayContaining(["title", "readMore"]));
    } finally {
      await cleanup();
    }
  });

  it("enum labels per locale: source config translations + labels printed by teaser cards linking to their entity", async () => {
    const { ws, cleanup } = await createTempWorkspace("enum-i18n");
    try {
      await ws.writeJson("ccm/schema/content-types.json", {
        contentTypes: [{ id: "recipe", name: "Recipe", kind: "document", fields: [{ id: "title", name: "Title", type: "text" }, { id: "difficulty", name: "Difficulty", type: "enum", options: ["easy", "medium", "hard"], sourceMeta: { optionLabels: { easy: "Easy", medium: "Medium", hard: "Hard" }, optionLabelsByLocale: { es: { easy: "Fácil", medium: "Medio", hard: "Díficil" } } } }] }],
      });
      await ws.writeJson("ccm/i18n/locales.json", [{ code: "en", name: "English", default: true, pathPrefix: "en" }, { code: "es", name: "Español", pathPrefix: "es" }]);
      for (const [id, lc, path, d] of [["1", "en", "/en/recipes/quiche", "medium"], ["1", "es", "/es/recipes/quiche", "medium"], ["2", "es", "/es/recipes/pizza", "easy"]])
        await ws.writeJson(ws.entryPath("recipe", `drupal:node:${id}`, lc), { ccmId: `drupal:node:${id}`, type: "recipe", locale: lc, path, status: "published", fields: { title: "Q", difficulty: d }, source: { system: "drupal", kind: "node", id } });
      const body = { id: "recipeBody", name: "Recipe body", selector: "article", kind: "document", template: "<b>{{difficulty}}</b>", exampleHtml: "", exampleProps: {}, source: "heuristic", instances: 2, pages: [], locales: ["en", "es"], verified: true, instanceKey: "path", props: [{ name: "difficulty", type: "text", ccmField: "difficulty" }], instanceProps: { "/en/recipes/quiche": { difficulty: "Medium" }, "/es/recipes/quiche": { difficulty: "Medio" } } };
      const card = { id: "recipeCard", name: "Card", selector: "article", kind: "section", template: '<a href="{{readMore.url}}">{{difficulty}}</a>', exampleHtml: "", exampleProps: {}, source: "heuristic", instances: 1, pages: [], locales: ["es"], verified: true, instanceKey: "entityId", props: [{ name: "difficulty", type: "text", ccmField: "difficulty" }, { name: "readMore", type: "link", ccmField: "readMore" }], instanceProps: { "/es/recipes#1": { difficulty: "Fácil", readMore: { url: "/es/recipes/pizza" } } } };
      await reconcileWithCcm(ws, [body, card] as never, { locale: "en" });
      const d = (body.props[0] as { display?: { labels?: Record<string, Record<string, string>> } }).display;
      // translated config labels (verbatim, typo included) for keys no es page shows; crawled labels win where seen
      expect(d?.labels?.es).toEqual({ easy: "Fácil", medium: "Medio", hard: "Díficil" });
      expect(d?.labels?.en).toEqual({ easy: "Easy", medium: "Medium", hard: "Hard" });
      // without config translations, the es card's "Fácil" (linking to the easy recipe) is learned from the crawl
      const ct = await ws.readJson<{ contentTypes: { fields: { sourceMeta?: Record<string, unknown> }[] }[] }>("ccm/schema/content-types.json");
      delete ct.contentTypes[0].fields[1].sourceMeta!.optionLabelsByLocale;
      await ws.writeJson("ccm/schema/content-types.json", ct);
      const body2 = { ...body, props: [{ name: "difficulty", type: "text", ccmField: "difficulty" }] };
      const card2 = { ...card, props: [{ name: "difficulty", type: "text", ccmField: "difficulty" }, { name: "readMore", type: "link", ccmField: "readMore" }] };
      await reconcileWithCcm(ws, [body2, card2] as never, { locale: "en" });
      expect((body2.props[0] as { display?: { labels?: Record<string, Record<string, string>> } }).display?.labels?.es).toEqual({ medium: "Medio", easy: "Fácil" });
    } finally {
      await cleanup();
    }
  });
});

describe("list items bound to a reference field take the referenced entries' field ids (Acme /about downloads, W2-K)", () => {
  it("renames an item key the entries hold under another name, by value; same-named keys stay", async () => {
    const { ws, cleanup } = await createTempWorkspace("item-keys");
    try {
      await ws.writeJson("ccm/schema/content-types.json", {
        contentTypes: [
          { id: "sectionDownloads", name: "Downloads", kind: "component", fields: [{ id: "title", name: "Title", type: "text" }, { id: "items", name: "Items", type: "componentList" }] },
          { id: "sectionDownloadsItem", name: "Item", kind: "component", fields: [{ id: "description", name: "D", type: "text" }, { id: "downloadLinkLabel", name: "L", type: "text" }] },
        ],
      });
      await ws.writeJson("ccm/i18n/locales.json", [{ code: "en", name: "English", default: true }]);
      const put = (ccmId: string, type: string, fields: Record<string, unknown>, id: string) => ws.writeJson(ws.entryPath(type, ccmId, "en"), { ccmId, type, locale: "en", status: "published", fields, source: { system: "drupal", kind: "paragraph", id } });
      await put("drupal:paragraph:7", "sectionDownloads", { title: "Downloads", items: [{ kind: "entry", id: "drupal:paragraph:8" }, { kind: "entry", id: "drupal:paragraph:9" }] }, "7");
      await put("drupal:paragraph:8", "sectionDownloadsItem", { description: "Annual Review", downloadLinkLabel: "Download" }, "8");
      await put("drupal:paragraph:9", "sectionDownloadsItem", { description: "Statement", downloadLinkLabel: "Download" }, "9");
      const items = [{ description: "Annual Review", downloadLink: "Download" }, { description: "Statement", downloadLink: "Download" }];
      const template = '<div><h2>{{title}}</h2>{{#each items}}<h3>{{this.description}}</h3><span>{{this.downloadLink}}</span>{{/each}}<i>{{this.downloadLink}}</i></div>';
      const comp = {
        id: "sectionDownloads", name: "Downloads", selector: "div", kind: "section", template, exampleHtml: "", exampleProps: { title: "Downloads", items: structuredClone(items) }, source: "heuristic", instances: 1, pages: [], locales: ["en"], verified: true, instanceKey: "entityId",
        props: [{ name: "title", type: "text", ccmField: "title" }, { name: "items", type: "list", ccmField: "items", itemFields: { description: "text", downloadLink: "text" } }],
        instanceProps: { "7": { title: "Downloads", items: structuredClone(items) } },
      };
      const rec = await reconcileWithCcm(ws, [comp] as never, { locale: "en" });
      expect(rec!.issues.map((i) => i.code)).toContain("DESIGN_ITEM_KEY_BOUND");
      expect(comp.props[1]).toMatchObject({ ccmField: "items", itemFields: { description: "text", downloadLinkLabel: "text" } });
      expect(comp.template).toContain("<span>{{this.downloadLinkLabel}}</span>");
      expect(comp.template).toContain("<i>{{this.downloadLink}}</i>"); // outside the list: untouched
      expect(renderTemplate(comp.template, comp.exampleProps)).toContain("<span>Download</span>");
      expect((comp.instanceProps["7"].items as Record<string, unknown>[])[0]).toEqual({ description: "Annual Review", downloadLinkLabel: "Download" });
    } finally {
      await cleanup();
    }
  });
});

describe("same-named binding to an empty CCM field (crawl-only `uid: []`, W2-K)", () => {
  it("unbinds a shown text prop whose same-named field is empty on every crawled instance", async () => {
    const { ws, cleanup } = await createTempWorkspace("empty-field");
    try {
      await ws.writeJson("ccm/schema/content-types.json", { contentTypes: [{ id: "article", name: "Article", kind: "document", fields: [{ id: "title", name: "Title", type: "text" }, { id: "uid", name: "Uid", type: "text", cardinality: -1 }] }] });
      await ws.writeJson("ccm/i18n/locales.json", [{ code: "en", name: "English", default: true, pathPrefix: "en" }]);
      await ws.writeJson(ws.entryPath("article", "html:page:/en/a", "en"), { ccmId: "html:page:/en/a", type: "article", locale: "en", path: "/en/a", status: "published", fields: { title: "A", uid: [] }, source: { system: "html", kind: "page", id: "/en/a" } });
      const comp = { id: "articleBody", name: "Body", selector: "article", kind: "document", template: "<b>{{uid}}</b>", exampleHtml: "", exampleProps: {}, source: "heuristic", instances: 1, pages: [], locales: ["en"], verified: true, instanceKey: "path", props: [{ name: "title", type: "text", ccmField: "title" }, { name: "uid", type: "text", ccmField: "uid" }], instanceProps: { "/en/a": { title: "A", uid: "Holly Foat" } } };
      await reconcileWithCcm(ws, [comp] as never, { locale: "en" });
      expect((comp.props[1] as { ccmField?: string }).ccmField).toBeUndefined();
      expect((comp.props[0] as { ccmField?: string }).ccmField).toBe("title");
    } finally {
      await cleanup();
    }
  });
});
