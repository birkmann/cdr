/**
 * Regression fixtures from the Umami (Drupal core theme) P8 run (W2-D failure classes 3–5), skeletonised:
 * __fixtures__/drupal-core/{recipe-quiche,recipe-pizza,recipes}.html.
 *  - class 4: the node sits alone in Drupal's main-content block (`div.block-system-main-block`, which source-html picks
 *    as the main content root) → the block must BE the document component, not a second static component around it.
 *  - class 5: Drupal field wrappers (labelled entity-reference `field__items` divs, labelled single/multi-value text,
 *    themed badge markup, BEM card titles around a field span) must template instead of degrading to static markup.
 *  - class 3: a Views page display becomes the `collection` listing template with a `$collection` slot whose view
 *    component binds the grid rows (responsive grid, no `.views-row`).
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleToType } from "@harness/mirror-capture";
import { mineComponents, renderTemplate, normalizeHtml, serverPageInfo, type MinePage, type MineResult } from "../src/index.js";

const FIX = (f: string) => fileURLToPath(new URL(`./__fixtures__/drupal-core/${f}`, import.meta.url));
const BASE = "http://drupal.test";

async function page(file: string, path: string): Promise<MinePage> {
  const info = serverPageInfo(await readFile(FIX(file), "utf8"), path, BASE);
  const ccmType = info.template.startsWith("node:") ? bundleToType(info.drupal.nodeType!) : info.template.startsWith("view:") ? "collection" : "page";
  return { path, locale: "en", info, ccmType, rawInfo: info };
}

async function mine(): Promise<MineResult> {
  const pages = [await page("recipe-quiche.html", "/en/recipes/quiche"), await page("recipe-pizza.html", "/en/recipes/pizza"), await page("recipes.html", "/en/recipes")];
  return mineComponents(pages, { defaultLocale: "en", rich: true });
}

describe("mining Drupal core field markup (Umami regression)", () => {
  it("renders the node once: the main-content block is the document component, not an extra slot", async () => {
    const r = await mine();
    const ids = r.components.map((c) => c.id);
    expect(ids).not.toContain("blockDemoContent");
    const body = r.components.find((c) => c.id === "recipeBody")!;
    expect(body.selector).toMatch(/^div#block-demo-content/);
    const tpl = r.templates.find((t) => t.contentType === "recipe")!;
    expect(tpl.slots.map((s) => s.component)).toEqual(["pageTitle", "recipeBody"]);
    // the node markup appears exactly once in the rendered body component
    const html = renderTemplate(body.template, body.exampleProps);
    expect(html.match(/<article class="node node--type-recipe/g)).toHaveLength(1);
    expect(tpl.wrapperHtml).not.toContain("<article");
    // the breadcrumb's last item is the page title: templated, so other recipes show their own title
    expect(tpl.wrapperHtml).toContain("<li> {{title}}</li>");
    expect(tpl.wrapperHtml).not.toContain("Quiche");
  });

  it("templates labelled reference lists, labelled/multi-value/themed text fields and BEM-wrapped field titles (no COMPONENT_DEGRADED)", async () => {
    const r = await mine();
    expect(r.issues.filter((i) => i.code === "COMPONENT_DEGRADED" || i.code === "COMPONENT_NOT_REPRODUCIBLE")).toEqual([]);
    const body = r.components.find((c) => c.id === "recipeBody")!;
    expect(body.degraded).toBeUndefined();
    expect(body.verified).toBe(true);
    expect(body.instancesVerified).toBe(2);
    const props = Object.fromEntries(body.props.map((p) => [p.name, p.type]));
    expect(props).toMatchObject({ title: "text", recipeCategory: "list", tags: "list", difficulty: "text", preparationTime: "text", ingredients: "list", recipeInstruction: "richText" });
    // the label markup stays static, only the values are props
    expect(body.template).toContain('<div class="field__label">Tags</div>');
    expect(body.template).toContain('<div class="demo-badge__label">Preparation time</div>');
    expect(body.instanceProps!["/en/recipes/pizza"].tags).toEqual([{ label: "Baked", url: "/en/tags/baked", locale: "en" }]);
    expect(body.instanceProps!["/en/recipes/pizza"].ingredients).toEqual(["Dough", "Tomato"]);
    expect(body.instanceProps!["/en/recipes/quiche"].preparationTime).toBe("40 minutes");
    // another entry's values render that entry, not the crawled example
    const pizza = body.instanceProps!["/en/recipes/pizza"];
    const out = normalizeHtml(renderTemplate(body.template, { ...body.exampleProps, ...pizza }));
    expect(out).toContain("Dough");
    expect(out).not.toContain("Butter");
    // card: <h2 class="demo-card__title"><span class="field--name-title"> is the field, one `title` prop for both spans
    const card = r.components.find((c) => c.id === "recipeCard")!;
    expect(card.degraded).toBeUndefined();
    expect(card.props.filter((p) => p.name.startsWith("title")).map((p) => [p.name, p.type])).toEqual([["title", "text"]]);
  });

  it("templates Drupal core language links (`<li data-drupal-language>`) as the translations list", async () => {
    const r = await mine();
    const sw = r.components.find((c) => c.id === "languageSwitcher")!;
    expect(sw.props.map((p) => [p.name, p.ccmField])).toEqual([["links", "translations"]]);
    expect(sw.template).toContain('{{#each links}}<li data-drupal-language="{{this.locale}}"');
  });

  it("mines a Views page display as the `collection` listing template with bound grid rows", async () => {
    const r = await mine();
    const view = r.components.find((c) => c.id === "viewRecipesPage1")!;
    expect(view.kind).toBe("document");
    expect(view.selector).toMatch(/^div#block-demo-content/);
    const items = view.props.find((p) => p.name === "items")!;
    expect(items).toMatchObject({ type: "list", ccmField: "collection", itemComponent: "recipeCard" });
    expect(view.template).toContain('{{#each items}}<div class="views-view-responsive-grid__item"><div class="views-view-responsive-grid__item-inner">{{{this.html}}}</div></div>{{/each}}');
    const rows = view.instanceProps!["/en/recipes"].items as { html: string; url: string }[];
    expect(rows.map((x) => x.url)).toEqual(["/en/recipes/quiche", "/en/recipes/pizza", "/en/recipes/curry"]);
    const coll = r.templates.find((t) => t.contentType === "collection")!;
    expect(coll.slots.map((s) => s.component)).toEqual(["pageTitle", "$collection"]);
    expect(r.components.map((c) => c.id)).not.toContain("blockDemoContent");
  });
});

describe("i18n chrome text with entities (Umami es regression, W2-J)", () => {
  it("stores translated strings decoded, so the escaped template reproduces '&' (no COMPONENT_DEGRADED)", async () => {
    const html = await readFile(FIX("recipe-quiche.html"), "utf8");
    const en = html.replace("<p>Footer</p>", "<p><strong>Umami Magazine &amp; Umami Publications</strong> is a fictional magazine.</p>");
    const es = html.replace('lang="en"', 'lang="es"').replace("<p>Footer</p>", "<p><strong>Revista Umami &amp; Publicaciones Umami</strong> es una revista ficticia.</p>");
    const mk = (src: string, path: string, locale: string): MinePage => {
      const info = serverPageInfo(src, path, BASE);
      return { path, locale, info, ccmType: "recipe", rawInfo: info };
    };
    const r = await mineComponents([mk(en, "/en/recipes/quiche", "en"), mk(es, "/es/recipes/quiche", "es")], { defaultLocale: "en", rich: true });
    expect(r.issues.filter((i) => i.code === "COMPONENT_DEGRADED")).toEqual([]);
    const i18n = r.components.flatMap((c) => c.props).filter((p) => p.i18n).map((p) => p.i18n!);
    const footer = i18n.find((m) => Object.values(m).some((v) => v.includes("Publica")));
    expect(footer).toEqual({ en: "Umami Magazine & Umami Publications", es: "Revista Umami & Publicaciones Umami" });
  });
});

describe("multilingual content-type wrapper (Umami es regression, W2-J)", () => {
  it("static wrapper text/hrefs (breadcrumb) become {{t.*}} with per-locale i18n from a crawled page of the type", async () => {
    const html = await readFile(FIX("recipe-quiche.html"), "utf8");
    const es = html.replace('lang="en"', 'lang="es"').replace('<a href="/en">Home</a>', '<a href="/es">Inicio</a>');
    const mk = (src: string, path: string, locale: string): MinePage => {
      const info = serverPageInfo(src, path, BASE);
      return { path, locale, info, ccmType: "recipe", rawInfo: info };
    };
    const r = await mineComponents([mk(html, "/en/recipes/quiche", "en"), mk(es, "/es/recipes/quiche", "es")], { defaultLocale: "en", rich: true });
    const t = r.templates.find((x) => x.contentType === "recipe")!;
    expect(t.wrapperHtml).not.toContain(">Home<");
    const vals = Object.values(t.i18n ?? {});
    expect(vals).toContainEqual({ en: "Home", es: "Inicio" });
    expect(vals).toContainEqual({ en: "/en", es: "/es" });
    // rendering the wrapper for es gives the es breadcrumb
    const tv = Object.fromEntries(Object.entries(t.i18n!).map(([k, m]) => [k, m.es]));
    expect(renderTemplate(t.wrapperHtml!, { regions: {}, title: "Quiche", t: tv })).toContain('<a href="/es">Inicio</a>');
  });
});

describe("reconcileWithCcm — formatter display, embedded views, locale-only strings (Umami regression, W2-J)", () => {
  it("binds '40 minutes' / 'Medium' to number/enum fields with a per-locale display, embedded view rows to the collection", async () => {
    const { createTempWorkspace } = await import("@harness/mirror-core");
    const { reconcileWithCcm } = await import("../src/index.js");
    const { ws, cleanup } = await createTempWorkspace("reconcile-display");
    try {
      await ws.writeJson("ccm/schema/content-types.json", { contentTypes: [{ id: "recipe", name: "Recipe", kind: "document", fields: [{ id: "title", name: "Title", type: "text" }, { id: "preparationTime", name: "Prep", type: "number" }, { id: "difficulty", name: "Difficulty", type: "enum", options: ["easy", "medium"], sourceMeta: { optionLabels: { easy: "Easy", medium: "Medium" } } }] }] });
      await ws.writeJson("ccm/i18n/locales.json", [{ code: "en", name: "English", default: true, pathPrefix: "en" }, { code: "es", name: "Español", pathPrefix: "es" }]);
      for (const [lc, path] of [["en", "/en/recipes/quiche"], ["es", "/es/recipes/quiche"]])
        await ws.writeJson(ws.entryPath("recipe", "drupal:node:1", lc), { ccmId: "drupal:node:1", type: "recipe", locale: lc, path, status: "published", fields: { title: "Q", preparationTime: 40, difficulty: "medium" }, source: { system: "drupal", kind: "node", id: "1" } });
      await ws.writeJson("ccm/collections/related--block_1.json", { id: "related--block_1", name: "Related", type: "recipe", filters: [], sort: [], manual: false });
      const template = '<article><span>{{preparationTime}}</span><span>{{difficulty}}</span><h2>{{blockTitle}}</h2><div class="view view-id-related view-display-id-block_1"><div class="view-content">{{#each items}}{{{this.html}}}{{/each}}</div></div></article>';
      const comp = {
        id: "recipeBody", name: "Recipe body", selector: "article", kind: "document", template, exampleHtml: "", exampleProps: {}, source: "heuristic", instances: 2, pages: [], locales: ["en", "es"], verified: true, instanceKey: "path",
        props: [{ name: "preparationTime", type: "text", ccmField: "preparationTime" }, { name: "difficulty", type: "text", ccmField: "difficulty" }, { name: "blockTitle", type: "text" }, { name: "items", type: "list", ccmField: "items", itemFields: { html: "html", type: "text" } }],
        instanceProps: {
          "/en/recipes/quiche": { preparationTime: "40 minutes", difficulty: "Medium", blockTitle: "Related recipes", items: [{ type: "recipeCard", html: "<a></a>" }] },
          "/es/recipes/quiche": { preparationTime: "40 minutos", difficulty: "Medio", blockTitle: "Recetas relacionadas", items: [{ type: "recipeCard", html: "<a></a>" }] },
        },
      };
      const card = { id: "recipeCard", name: "Card", selector: "article", kind: "section", template: "<article>{{difficulty}}</article>", exampleHtml: "", exampleProps: {}, source: "heuristic", instances: 2, pages: [], locales: ["en"], verified: true, instanceKey: "entityId", props: [{ name: "difficulty", type: "text", ccmField: "difficulty" }], instanceProps: { "/en/recipes#1": { difficulty: "Easy" }, "/en/recipes#2": { difficulty: "Medium" } } };
      await reconcileWithCcm(ws, [comp, card] as never, { locale: "en" });
      const by = Object.fromEntries(comp.props.map((p) => [p.name, p as Record<string, unknown>]));
      expect(by.preparationTime).toMatchObject({ ccmField: "preparationTime", display: { affix: { en: ["", " minutes"], es: ["", " minutos"] } } });
      expect(by.difficulty).toMatchObject({ ccmField: "difficulty", display: { labels: { en: { easy: "Easy", medium: "Medium" }, es: { medium: "Medio" } } } });
      expect(by.blockTitle.i18n).toEqual({ en: "Related recipes", es: "Recetas relacionadas" });
      expect(by.items).toMatchObject({ collection: "related--block_1", itemComponent: "recipeCard" });
      expect(by.items.ccmField).toBeUndefined();
      // the teaser card shows the same enum: same binding + display
      expect((card.props[0] as Record<string, unknown>).display).toEqual(by.difficulty.display);
    } finally {
      await cleanup();
    }
  });
});

describe("reconcileWithCcm — same-named text fields that disagree (Umami regression)", () => {
  it("unbinds a text prop whose plain-string CCM field holds other text (field wrapper incl. its label), keeps real matches", async () => {
    const { createTempWorkspace } = await import("@harness/mirror-core");
    const { reconcileWithCcm } = await import("../src/index.js");
    const { ws, cleanup } = await createTempWorkspace("reconcile");
    try {
      await ws.writeJson("ccm/schema/content-types.json", { contentTypes: [{ id: "recipe", name: "Recipe", kind: "document", fields: [{ id: "title", name: "Title", type: "text" }, { id: "preparationTime", name: "Prep", type: "text" }] }] });
      await ws.writeJson("ccm/i18n/locales.json", [{ code: "en", name: "English", default: true, pathPrefix: "en" }]);
      await ws.writeJson(ws.entryPath("recipe", "html:page:/en/recipes/quiche", "en"), { ccmId: "html:page:/en/recipes/quiche", type: "recipe", locale: "en", path: "/en/recipes/quiche", status: "published", fields: { title: "Quiche", preparationTime: "Preparation time 40 minutes" }, source: { system: "html", kind: "page", id: "/en/recipes/quiche" } });
      const comp = {
        id: "recipeBody", name: "Recipe body", selector: "article", kind: "document", template: "", exampleHtml: "", exampleProps: {}, source: "heuristic", instances: 1, pages: [], locales: ["en"], verified: true, instanceKey: "path",
        props: [ { name: "title", type: "text", ccmField: "title" }, { name: "preparationTime", type: "text", ccmField: "preparationTime" } ],
        instanceProps: { "/en/recipes/quiche": { title: "Quiche", preparationTime: "40 minutes" } },
      } as never;
      const r = await reconcileWithCcm(ws, [comp], { locale: "en" });
      expect(r?.stats.ccmEntries).toBe(1);
      const props = (comp as { props: { name: string; ccmField?: string }[] }).props;
      expect(props.find((p) => p.name === "title")!.ccmField).toBe("title");
      expect(props.find((p) => p.name === "preparationTime")!.ccmField).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
