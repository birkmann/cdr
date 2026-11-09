/**
 * Static render mode ("static islands"): string renderers + an end-to-end render of the trimmed nestle.com fixture
 * (generator → generated app copy in src/__gen_test__ → staticDocument()).
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RichText } from "../richtext/RichText";
import type { RichTextDoc } from "../ccm-types";
import { renderToHtml, serializeNodes } from "../html/serialize";
import { parseHtml } from "../html/parse";
import { bindProps, formatPhpDate, scope, type RenderCtx } from "./runtime";
import { renderTemplateString } from "./template-string";

const ctx = { locale: "en", path: "/", chrome: { languages: [] }, renderEntry: () => null, renderComponent: () => null } as unknown as RenderCtx;
const hooks = { html: (v: unknown) => (typeof v === "string" ? v : "") };

describe("renderTemplateString (Handlebars subset → original markup)", () => {
  it("keeps the template bytes, escapes text, uses attr() inside tags", () => {
    const t = `<div id="section-{{entityId}}" class="a  b" style="background-image: url(&#x27;&#x27;);">\n  <a href="{{link}}"{{#if active}} aria-current="page"{{/if}}>{{link}}</a>{{{body}}}</div>`;
    const link = { _kind: "link", href: "/about?a=1&b=2", label: "About <us>" };
    const out = renderTemplateString(t, scope({ entityId: "334386", link, active: true, body: "<p>x</p>" }), ctx, hooks);
    expect(out).toBe(`<div id="section-334386" class="a  b" style="background-image: url(&#x27;&#x27;);">\n  <a href="/about?a=1&amp;b=2" aria-current="page">About &lt;us&gt;</a><p>x</p></div>`);
  });

  it("each / if / else / @index / ../ and raw-text elements", () => {
    const t = `<ul>{{#each items}}<li data-i="{{@index}}">{{this.label}}{{#if ../flag}}!{{else}}?{{/if}}</li>{{/each}}</ul><script>var a = "<b>{{x}}";</script>{{x}}`;
    const out = renderTemplateString(t, scope({ items: [{ label: "a" }, { label: "b" }], flag: false, x: "y" }), ctx, hooks);
    expect(out).toBe(`<ul><li data-i="0">a?</li><li data-i="1">b?</li></ul><script>var a = "<b>y";</script>y`);
  });
});

describe("renderToHtml (React subset → HTML, for rich text inside static islands)", () => {
  it("matches react-dom/server for RichText output", () => {
    const doc = {
      type: "doc",
      children: [
        { type: "heading", level: 2, children: [{ type: "text", value: "Why & how" }] },
        { type: "paragraph", children: [{ type: "text", value: "A ", marks: [] }, { type: "text", value: "bold", marks: ["bold", "italic"] }, { type: "link", href: "/x?a=1&b=2", children: [{ type: "text", value: "link" }] }] },
        { type: "list", ordered: false, children: [{ type: "listItem", children: [{ type: "paragraph", children: [{ type: "text", value: "one" }] }] }] },
        { type: "hr" },
      ],
    } as unknown as RichTextDoc;
    const el = <RichText doc={doc} />;
    expect(renderToHtml(el)).toBe(renderToStaticMarkup(el).replace(/\/>/g, ">")); // void elements without "/"
  });

  it("serialises parsed nodes with raw attribute names (svg case kept)", () => {
    const html = '<svg viewBox="0 0 1 1"><use xlink:href="#arrow--right"></use></svg><img src="a.jpg" alt="x &amp; y">';
    expect(serializeNodes(parseHtml(html))).toBe(html);
  });
});

describe("bindProps — design contract (derive, instanceProps, hints)", () => {
  const entry = { _kind: "entry", ccmId: "drupal:paragraph:334386", type: "sectionCText", locale: "en", fields: { title: "From CCM", body: { type: "doc", children: [{ type: "paragraph", children: [{ type: "text", value: "Hi" }] }] }, links: [{ _kind: "link", href: "/jobs", label: "Jobs" }], jobCount: "2206 jobs", jobCountHtml: "<strong>2206</strong> jobs" }, source: { system: "html", kind: "paragraph", id: "334386" } };
  const inst = { key: "entityId" as const, props: { "334386": { title: "mined", eyebrow: "Mined eyebrow", links: [{ link: { url: "/jobs" }, link2: "Jobs", icon: "arrow" }] } } };
  it("derives the entity id, prefers CCM values, falls back to this instance's mined values", () => {
    const vm = bindProps(
      [
        { name: "entityId", type: "text", derive: "ccmIdTail" },
        { name: "title", type: "text", ccmField: "title" },
        { name: "eyebrow", type: "text" },
        { name: "body", type: "richText", ccmField: "body", inline: true },
        { name: "jobCount", type: "richText", ccmField: "jobCount" },
        { name: "links", type: "list", ccmField: "links", itemFields: { link: "link", link2: "text" } },
      ],
      entry,
      ctx,
      undefined,
      inst,
    );
    expect(vm.entityId).toBe("334386");
    expect(vm.title).toBe("From CCM");
    expect(vm.eyebrow).toBe("Mined eyebrow");
    expect(vm.body).toBe("Hi"); // single paragraph without <p>
    expect(vm.jobCount).toBe("<strong>2206</strong> jobs"); // <field>Html twin
    const l = (vm.links as Record<string, unknown>[])[0];
    expect((l.link as { href: string }).href).toBe("/jobs");
    expect(l.link2).toBe("Jobs");
    expect(l.icon).toBe("arrow");
  });
});

// ---------------------------------------------------------------- end to end: generator → app copy → staticDocument

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "../../../../..");
const GEN = join(HERE, "../../../__gen_test__"); // outside src/ (the scaffold copies src/); removed afterwards

describe("static document of the nestle.com fixture (generated app)", () => {
  let doc: { htmlAttrs: Record<string, string>; bodyAttrs: Record<string, string>; head: string; body: string };
  beforeAll(async () => {
    await rm(GEN, { recursive: true, force: true });
    await mkdir(join(GEN, "ws"), { recursive: true });
    await cp(join(REPO, "packages/generators/nextjs-contentful/src/__fixtures__/nestle"), join(GEN, "ws/nestle"), { recursive: true });
    await writeFile(join(GEN, "pnpm-workspace.yaml"), "packages: []\n");
    const { generate } = await import("../../../../../packages/generators/nextjs-contentful/src/generate");
    const { SiteConfig, Workspace } = await import("../../../../../packages/core/src/index");
    const site = SiteConfig.parse({ site: "nestle", baseUrl: "http://localhost:4401", frontend: { dataSource: "ccm", appDir: "app" } });
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    const r = await generate({ site, ws: new Workspace("nestle", join(GEN, "ws")), dryRun: false, log, options: { repoRoot: GEN, install: false, download: false } } as never);
    expect(r.ok).toBe(true);
    process.env.CCM_DIR = join(GEN, "ws/nestle/ccm");
    const app = join(GEN, "app/src");
    const { resolveRoute } = await import(/* @vite-ignore */ join(app, "lib/route.ts"));
    const { buildChrome } = await import(/* @vite-ignore */ join(app, "lib/render/page.tsx"));
    const { staticDocument, isStaticMode } = await import(/* @vite-ignore */ join(app, "lib/render/static.ts"));
    expect(isStaticMode()).toBe(true);
    const { data, entry, locale } = await resolveRoute("/");
    expect(entry?.ccmId).toBe("drupal:node:472961");
    doc = await staticDocument(data, entry, "/", locale, await buildChrome(data, entry, locale, "/"));
  }, 60_000);
  afterAll(async () => {
    delete process.env.CCM_DIR;
    await rm(GEN, { recursive: true, force: true });
  });

  it("reproduces <html>/<body> attributes", () => {
    expect(doc.htmlAttrs).toEqual({ lang: "en", dir: "ltr", prefix: "og: https://ogp.me/ns#" });
    expect(doc.bodyAttrs.class).toBe("hide-default-heading home path-frontpage page-node-type-dsu-component-page has-glyphicons");
  });

  it("renders the head in original order: SEO from CCM, preload, stylesheets, drupalSettings before jQuery", () => {
    const h = doc.head;
    const at = (s: string) => {
      const i = h.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(h.startsWith('<meta charset="utf-8" />')).toBe(true);
    expect(at('<meta name="description"')).toBeLessThan(at('<link rel="canonical" href="https://www.nestle.com/"'));
    expect(at("<title>Nestlé: Good food, Good life | Nestlé Global</title>")).toBeLessThan(at('<link rel="preload" as="font"'));
    expect(at('href="/_design/styles/css_agg0.css"')).toBeLessThan(at('href="/_design/styles/darkmode.css" class="darkreader darkmode-css"'));
    expect(at('<script type="application/json" data-drupal-selector="drupal-settings-json">')).toBeLessThan(at('<script src="/core/assets/vendor/jquery/jquery.min.js?v=4.0.0"></script>'));
    expect(at("jquery.min.js")).toBeLessThan(at("seckit.document_write.js"));
    expect(h).not.toMatch(/gtm\.js|gtag\.js|dataLayer_tags/);
    expect(h).not.toContain("localhost:4401"); // replay URLs inside drupalSettings are root-relative
    expect(h).toContain('"searchUrl":"/searchresults"');
    expect(h).not.toContain('href="/_design/styles/seckit.noscript_tag.css"');
  });

  it("renders the body from the layout + templates, scripts at the end, URLs normalised", () => {
    const b = doc.body;
    expect(b).toContain('<div id="seckit-noscript-tag">');
    expect(b).toContain('<symbol id="arrow--right"');
    expect(b).not.toContain("GTM-PWRZ37");
    expect(b).toContain('<header class="header-wrapper">'); // chrome via instance values (path "/")
    expect(b).toContain('<span class="switch">Dark mode</span>');
    expect(b).toContain('<div class="field-components-container component-472961">');
    expect(b).toContain('<div id="section-334386" class="paragraph paragraph--type--c-text paragraph--view-mode--default" style="background-image: url(&#x27;&#x27;);">');
    expect(b).toContain("<p>We work closely with farmers");
    // replay + old-origin resource URLs are root-relative, share-link query keeps an absolute URL without a request
    expect(b).toContain('<img src="/sites/default/files/2026-06/farm.jpg" srcset="/sites/default/files/2026-06/farm.jpg 1x, /sites/default/files/2026-06/farm-2x.jpg 2x" alt="Farm">');
    expect(b).not.toMatch(/localhost:4401|https:\/\/www\.nestle\.com\/sites/);
    // end-of-body scripts in original order, inline script inline
    const tail = b.slice(b.indexOf('<div class="nav-overlay hide">'));
    expect(tail.indexOf('<script src="/_design/scripts/popper.js"></script>')).toBeLessThan(tail.indexOf("<script>window.__inlineRan = true;</script>"));
    expect(tail).toContain('<script src="/themes/custom/da_vinci_code/node_modules/%40searchstax-inc/searchstudio-ux-js/dist/%40searchstax-inc/searchstudio-ux-js.iife.js?v=1.x"></script>');
  });
});

describe("RichText — N2 additive keys", () => {
  it("implicit paragraphs render without <p>, abbr wraps marked text", () => {
    const doc = {
      type: "doc",
      children: [
        { type: "paragraph", implicit: true, children: [{ type: "text", value: "Card text" }, { type: "break" }, { type: "text", value: "line 2" }] },
        { type: "paragraph", children: [{ type: "text", value: "CHF", abbr: "Swiss francs", marks: ["bold"] }, { type: "text", value: " 563 million" }] },
      ],
    } as unknown as RichTextDoc;
    expect(renderToHtml(<RichText doc={doc} />)).toBe('Card text<br>line 2<p><abbr title="Swiss francs"><strong>CHF</strong></abbr> 563 million</p>');
  });
});

describe("Views listing rows (Umami regression, W2-G)", () => {
  it("crawled rows win when the collection shows the same entities, is empty or unrenderable; else the collection items render", async () => {
    const { minedListingRows, listingCollectionId } = await import("./runtime");
    const view = { props: [{ name: "items", type: "list", ccmField: "collection", itemComponent: "recipeCard" }], instanceKey: "path", instanceProps: { "/en/recipes": { items: [{ html: "<article>Q</article>", url: "/en/recipes/quiche" }] } } } as never;
    const mk = (paths: string[]) => ({ _kind: "entry", ccmId: "collection:recipes--page_1", type: "collection", locale: "en", fields: { collection: { _kind: "collection", id: "recipes--page_1", items: paths.map((p) => ({ _kind: "entry", ccmId: p, type: "recipe", path: p, fields: {} })) } } }) as never;
    const c = (path: string, canRender = true) => ({ ...ctx, path, canRender: () => canRender }) as unknown as RenderCtx;
    expect(listingCollectionId(mk([]))).toBe("recipes--page_1");
    expect(minedListingRows(view, mk(["/en/recipes/quiche", "/en/recipes/pizza"]), c("/en/recipes"))).toEqual({ items: [{ html: "<article>Q</article>", url: "/en/recipes/quiche" }] });
    expect(minedListingRows(view, mk([]), c("/en/recipes"))).toBeDefined();
    expect(minedListingRows(view, mk(["/en/recipes/pizza"]), c("/en/recipes", false))).toBeDefined();
    expect(minedListingRows(view, mk(["/en/recipes/pizza"]), c("/en/recipes"))).toBeUndefined(); // other content: render the collection
    expect(minedListingRows(view, mk(["/en/recipes/quiche"]), c("/es/recipes"))).toBeUndefined(); // not crawled
  });
});

describe("bindProps — multi-value asset field bound to a single image prop (Umami regression, W2-G)", () => {
  it("uses the first asset and completes it with this instance's mined srcset", () => {
    const props = [{ name: "mediaImage", type: "asset", ccmField: "items2" }] as never;
    const entry = { _kind: "entry", ccmId: "html:page:/en/r", type: "recipe", locale: "en", path: "/en/r", fields: { items2: [{ _kind: "asset", ccmId: "a1", url: "/files/q.avif", alt: "Q" }] } };
    const c = { ...ctx, path: "/en/r" } as unknown as RenderCtx;
    const vm = bindProps(props, entry, c, undefined, { key: "path", props: { "/en/r": { mediaImage: { url: "/files/q.avif", srcset: "/files/q.avif 768w", sizes: "100vw" } } } });
    expect(vm.mediaImage).toMatchObject({ _kind: "asset", url: "/files/q.avif", srcset: "/files/q.avif 768w", sizes: "100vw" });
  });
});

describe("bindProps — Umami en+es (W2-J)", () => {
  const es = (path: string, extra: Record<string, unknown> = {}) =>
    ({ ...ctx, locale: "es", path, chrome: { languages: [{ code: "es" }, { code: "en" }], homeHref: "/es", path, ...extra } }) as unknown as RenderCtx;
  const entry = (path: string, fields: Record<string, unknown>) => ({ _kind: "entry", ccmId: "drupal:node:9", type: "recipe", locale: "es", path, fields });

  it("prints numbers/enums as the source did, per locale (display affix + labels, other-locale/source fallback)", () => {
    const props = [
      { name: "preparationTime", type: "text", ccmField: "preparationTime", display: { affix: { en: ["", " minutes"], es: ["", " minutos"] } } },
      { name: "difficulty", type: "text", ccmField: "difficulty", display: { labels: { en: { easy: "Easy", medium: "Medium" }, es: { medium: "Medio" } } } },
    ] as never;
    const vm = bindProps(props, entry("/es/r", { preparationTime: 30, difficulty: "medium" }), es("/es/r"));
    expect([vm.preparationTime, vm.difficulty]).toEqual(["30 minutos", "Medio"]);
    // a key the es crawl never showed: the source's default-language label, never the raw key
    expect(bindProps(props, entry("/es/r", { difficulty: "easy" }), es("/es/r")).difficulty).toBe("Easy");
  });

  it("prints a date bound with a PHP pattern (Drupal 'jS F Y', title-cased es month) per locale (W2-K)", () => {
    const props = [{ name: "created", type: "text", ccmField: "created", format: { kind: "date", options: {}, locales: { en: "en", es: "es" }, pattern: "jS F Y", case: { es: "title" } } }] as never;
    const vm = bindProps(props, entry("/es/r", { created: "2026-10-31T20:38:06.000Z" }), es("/es/r"));
    expect((vm.created as { formatted: string }).formatted).toBe("31st Octubre 2026");
    expect(formatPhpDate("2026-10-22T08:05:00Z", "D, m/d/Y - H:i", "en")).toBe("Thu, 10/22/2026 - 08:05");
  });

  it("an uncrawled es page takes menus / unbound strings from a crawled es instance, not the en example", () => {
    const props = [{ name: "menu", type: "list", ccmField: "navigation.main", example: [{ label: "Home", url: "/en" }] }, { name: "blockTitle", type: "text", example: "Related recipes" }] as never;
    const inst = { key: "path" as const, props: { "/en": { menu: [{ label: "Home", url: "/en" }], blockTitle: "Related recipes" }, "/es/acerca": { menu: [{ label: "Inicio", url: "/es" }], blockTitle: "Recetas relacionadas" } } };
    const vm = bindProps(props, entry("/es/r", {}), es("/es/r", { nav: { main: [] } }), undefined, inst);
    expect(vm.menu).toEqual([{ label: "Inicio", url: "/es" }]);
    expect(vm.blockTitle).toBe("Recetas relacionadas");
  });

  it("an embedded Views block's rows come from the collection run for the page entry; unresolved teaser links point to the entry", () => {
    const row = { _kind: "entry", ccmId: "drupal:node:2", type: "recipe", locale: "es", path: "/es/recipes/pizza", fields: { title: "Pizza" } };
    const props = [{ name: "items", type: "list", collection: "related--block", itemComponent: "card", itemFields: { html: "html" } }] as never;
    const c = { ...es("/es/r", { collections: { "related--block": [row] } }), renderComponent: (_id: string, src: { path?: string }) => `card:${src.path}` } as unknown as RenderCtx;
    const vm = bindProps(props, entry("/es/r", {}), c);
    expect((vm.items as { fields: { html: unknown } }[]).map((x) => x.fields.html)).toEqual(["card:/es/recipes/pizza"]);
    const link = bindProps([{ name: "readMore", type: "link", ccmField: "readMore" }] as never, row, es("/es/r"));
    expect(link.readMore).toEqual({ url: "/es/recipes/pizza", href: "/es/recipes/pizza" });
  });
});
