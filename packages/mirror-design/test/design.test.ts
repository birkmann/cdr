import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTempWorkspace, testSiteConfig, silentLogger, type LlmClient, type StepContext, type Workspace } from "@harness/mirror-core";
import { crawlSite, dom, parsePage } from "@harness/mirror-capture";
import { startFixtureServer, type FixtureServer } from "../../mirror/test/fixtures/serve.js";
import { designExtract, normalizeHtml, renderTemplate, parseTemplate, templatePaths, detectDateFormat, skeletonOf, type ComponentDef, type DesignManifest, type TemplateDef } from "../src/index.js";

interface Golden {
  pocUrls: string[];
  components: { id: string; kind: string; ccmType?: string; props: { name: string; type: string; ccmField?: string }[]; i18nKeys: string[] }[];
  templates: { contentType: string; chrome: string[]; slots: TemplateDef["slots"]; bodyClass?: string }[];
  tokens: Record<string, string>;
}
const golden: Golden = JSON.parse(await readFile(fileURLToPath(new URL("./__fixtures__/fixture-golden.json", import.meta.url)), "utf8"));

let server: FixtureServer;
let ws: Workspace;
let cleanup: () => Promise<void>;
let ctx: StepContext;

beforeAll(async () => {
  server = await startFixtureServer({ port: 0, quiet: true });
  ({ ws, cleanup } = await createTempWorkspace("fixture"));
  const site = testSiteConfig({
    site: "fixture",
    baseUrl: server.baseUrl,
    urls: golden.pocUrls,
    locales: [
      { code: "en", name: "English", default: true, pathPrefix: "" },
      { code: "de", name: "Deutsch", fallback: "en", pathPrefix: "de" },
    ],
    crawl: { follow: false, maxPages: 50, viewports: [{ name: "mobile", width: 375, height: 812 }, { name: "tablet", width: 768, height: 1024 }, { name: "desktop", width: 1440, height: 900 }], mask: ["#cookie-banner"] },
  });
  ctx = { site, ws, dryRun: false, log: silentLogger, options: {} };
  await crawlSite(ctx, { screenshots: false });
}, 90_000);

afterAll(async () => {
  await server?.close();
  await cleanup?.();
});

const readComp = (id: string) => ws.readJson<ComponentDef>(`design/components/${id}.json`);

describe("renderTemplate (Handlebars subset)", () => {
  it("supports vars, raw, each, nested each, if/else, attributes", () => {
    const t = `<ul>{{#each items}}<li class="x {{#if this.active}}on{{/if}}"><a href="{{this.url}}">{{this.label}}</a>{{#if this.children}}<ol>{{#each this.children}}<li>{{this.label}}-{{@index}}</li>{{/each}}</ol>{{else}}!{{/if}}</li>{{/each}}</ul>{{{html}}}{{title}}`;
    const out = renderTemplate(t, {
      title: "<b>",
      html: "<i>raw</i>",
      items: [
        { url: "/a", label: "A", active: true, children: [{ label: "A1" }] },
        { url: "/b", label: "B&", children: [] },
      ],
    });
    expect(out).toBe(`<ul><li class="x on"><a href="/a">A</a><ol><li>A1-0</li></ol></li><li class="x "><a href="/b">B&amp;</a>!</li></ul><i>raw</i>&lt;b&gt;`);
    expect(() => parseTemplate("{{#each x}}")).toThrow();
  });
  it("detects Drupal date formats per locale", () => {
    expect(detectDateFormat("2024-05-20T08:00:00+00:00", "20 May 2024", "en")).toEqual({ tag: "en-GB", options: { day: "numeric", month: "long", year: "numeric" } });
    expect(detectDateFormat("2024-05-20T08:00:00+00:00", "20. Mai 2024", "de")?.tag).toBe("de");
  });
  it("builds structure-only LLM skeletons", () => {
    expect(skeletonOf(`<p class="a">Secret text</p><h2>{{title}}</h2><img alt="Private">`, false)).toBe(`<p class="a">…</p><h2>{{title}}</h2><img alt="…">`);
  });
});

describe("designExtract on the fixture site", () => {
  let report: Awaited<ReturnType<typeof designExtract>>;
  beforeAll(async () => {
    report = await designExtract(ctx);
  }, 60_000);

  it("reports success and every component reproduces its original HTML", () => {
    expect(report.ok).toBe(true);
    expect(report.gates?.["design.componentsReproducible"].pass).toBe(true);
    expect(report.issues.filter((i) => i.severity !== "info")).toEqual([]);
  });

  it("mines exactly the golden components (ids, kinds, ccmTypes, props, i18n keys)", async () => {
    const manifest = await ws.readJson<DesignManifest>("design/manifest.json");
    expect(manifest.components.map((c) => c.id).sort()).toEqual(golden.components.map((c) => c.id).sort());
    for (const g of golden.components) {
      const c = await readComp(g.id);
      expect({ id: c.id, kind: c.kind, ccmType: c.ccmType }).toEqual({ id: g.id, kind: g.kind, ccmType: g.ccmType });
      const props = c.props
        .filter((p) => !p.name.startsWith("t."))
        .map((p) => ({ name: p.name, type: p.type, ...(p.ccmField ? { ccmField: p.ccmField } : {}) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(props, g.id).toEqual(g.props);
      expect(c.props.filter((p) => p.name.startsWith("t.")).map((p) => p.name).sort(), g.id).toEqual(g.i18nKeys);
      expect(c.verified, g.id).toBe(true);
      // every placeholder in the template is declared as a prop (or an each-item / nested path of one)
      const declared = new Set(c.props.map((p) => p.name.split(".")[0]));
      for (const path of templatePaths(c.template)) {
        if (path.startsWith("this") || path.startsWith("@")) continue;
        expect(declared.has(path.split(".")[0]), `${g.id}: ${path}`).toBe(true);
      }
    }
  });

  it("writes the golden content-type templates", async () => {
    for (const g of golden.templates) {
      const t = await ws.readJson<TemplateDef>(`design/templates/${g.contentType}.json`);
      expect({ contentType: t.contentType, chrome: t.chrome, slots: t.slots, bodyClass: t.bodyClass }).toEqual(g);
      expect(t.layout).toBe("default");
      expect(t.wrapperHtml).toContain("{{{regions.content}}}");
    }
  });

  it("templates render other instances too (German page title, switcher, footer nav)", async () => {
    const de = parsePage(await ws.readText("raw/html/pages/de_ueber-uns.rendered.html"), "/de/ueber-uns", server.baseUrl);
    const title = await readComp("pageTitle");
    const original = dom.outerHtml(dom.select(".block-page-title-block", de.tree)!);
    expect(normalizeHtml(renderTemplate(title.template, { title: "Über uns", visuallyHidden: false }))).toBe(normalizeHtml(original));

    const sw = await readComp("languageSwitcher");
    const t = sw.props.find((p) => p.name === "t.languageSwitcher")!;
    expect(t.i18n).toEqual({ en: "Language switcher", de: "Sprachumschalter" });
    const html = renderTemplate(sw.template, {
      t: { languageSwitcher: t.i18n!.de },
      links: [
        { locale: "en", label: "English", url: "/about-us", active: false },
        { locale: "de", label: "Deutsch", url: "/de/ueber-uns", active: true },
      ],
    });
    expect(normalizeHtml(html)).toBe(normalizeHtml(dom.outerHtml(dom.select(".language-switcher-language-url", de.tree)!)));

    const nav = await readComp("footerNav");
    const navHtml = renderTemplate(nav.template, {
      t: { footer: nav.props.find((p) => p.name === "t.footer")!.i18n!.de },
      items: [
        { label: "Impressum", url: "https://www.acme.com/imprint", active: false, activeTrail: false, children: [] },
        { label: "Kontakt", url: "/de/ueber-uns", active: true, activeTrail: true, children: [] },
      ],
    });
    expect(normalizeHtml(navHtml)).toBe(normalizeHtml(dom.outerHtml(dom.select("nav.menu--footer", de.tree)!)));
  });

  it("keeps the Drupal DOM/classes and uses placeholders for content", async () => {
    const hero = await readComp("sectionHero");
    expect(hero.template).toContain('class="paragraph paragraph--type--hero paragraph--view-mode--default"');
    expect(hero.template).toContain('src="{{image.url}}"');
    expect(hero.template).toContain('href="{{cta.url}}"');
    expect(hero.template).not.toContain("Start your day right");
    const nav = await readComp("mainNav");
    expect(nav.template).toContain("{{#each items}}");
    expect(nav.template).toContain("{{#each this.children}}");
    expect(nav.template).toContain("{{#if this.active}}is-active{{/if}}");
    const teaser = await readComp("articleTeaser");
    const created = teaser.props.find((p) => p.name === "created")!;
    expect(created.format).toEqual({ kind: "date", options: { day: "numeric", month: "long", year: "numeric" }, locales: { en: "en-GB", de: "de" } });
    const banner = await readComp("cookieBanner");
    expect(banner.template).toMatch(/<div id="cookie-banner"[^>]*hidden/);
    const layout = await ws.readJson<{ template: string; chrome: string[] }>("design/layouts/default.json");
    expect(layout.template).toContain("{{{chrome.siteHeader}}}");
    expect(layout.template).toContain("{{{main}}}");
    expect(layout.chrome).toEqual(["siteHeader", "siteFooter", "cookieBanner"]);
  });

  it("extracts W3C tokens from computed styles and media queries", async () => {
    const tokens = await ws.readJson<Record<string, Record<string, { $type: string; $value: unknown; $extensions?: Record<string, unknown> }>>>("design/tokens.json");
    for (const [path, want] of Object.entries(golden.tokens)) {
      const [group, rest] = path.split(".");
      const m = /^(.+?)(?:\[(\d+)\])?$/.exec(rest)!;
      const tok = tokens[group][m[1]];
      expect(m[2] !== undefined ? (tok.$value as string[])[Number(m[2])] : tok.$value, path).toBe(want);
    }
    expect(tokens.color.primary.$type).toBe("color");
    expect(tokens.fontSize.h1.$extensions?.["cmp.responsive"]).toEqual({ mobile: "32px", tablet: "40px", desktop: "48px" });
    expect((tokens.typography as unknown as Record<string, { $value: { fontSize: string } }>).h1.$value.fontSize).toBe("48px");
    expect((tokens.color as unknown as Record<string, Record<string, { $value: string }>>).semantic.link.$value).toBe("#1f4e79");
    expect(tokens.shadow.card.$value).toEqual({ color: "#1d1d1f14", offsetX: "0px", offsetY: "2px", blur: "8px", spread: "0px" });
  });

  it("ports CSS with rewritten url()s, fonts, theme images and scripts", async () => {
    const m = await ws.readJson<DesignManifest>("design/manifest.json");
    expect(m.stylesheets).toEqual(["styles/base.css", "styles/layout.css", "styles/components.css", "styles/navigation.css", "styles/cookie-banner.css"]);
    expect(m.fonts).toEqual(["assets/themes/custom/demo/fonts/inter-regular.woff2", "assets/themes/custom/demo/fonts/inter-semibold.woff2"]);
    expect(m.scripts.map((s) => s.src)).toEqual(["scripts/navigation.js", "scripts/cookies.js"]);
    expect(m.templates.map((t) => t.contentType)).toEqual(["article", "landingPage", "page"]);
    expect(m.tokensFile).toBe("tokens.json");
    const base = await ws.readText("design/styles/base.css");
    expect(base).toContain('url("../assets/themes/custom/demo/fonts/inter-regular.woff2")');
    expect(await ws.readText("design/styles/components.css")).toContain('url("../assets/themes/custom/demo/images/footer-pattern.png")');
    for (const rel of [...m.fonts, ...m.images]) expect((await stat(ws.path("design", rel))).size).toBeGreaterThan(0);
    // every url() in ported CSS resolves to a ported file
    for (const s of m.stylesheets) {
      const css = await ws.readText(`design/${s}`);
      for (const u of css.matchAll(/url\("\.\.\/([^"#]+)/g)) expect(await ws.exists("design", u[1]), u[1]).toBe(true);
    }
  });

  it("is deterministic", async () => {
    const before = await ws.readText("design/components/siteHeader.json");
    const manifestBefore = await ws.readText("design/manifest.json");
    await designExtract(ctx);
    expect(await ws.readText("design/components/siteHeader.json")).toBe(before);
    expect(await ws.readText("design/manifest.json")).toBe(manifestBefore);
  });

  it("LLM refinement is optional, structure-only and falls back on failure", async () => {
    const seen: string[] = [];
    const llm: LlmClient = {
      async complete(req) {
        seen.push(req.messages.map((m) => m.content).join("\n"));
        if (seen.length === 1) throw new Error("rate limited");
        return { content: JSON.stringify({ name: "Refined name", description: "d" }), model: "fake", promptTokens: 1, completionTokens: 1, durationMs: 1 };
      },
    };
    const { ws: ws2, cleanup: c2 } = await createTempWorkspace("fixture-llm");
    try {
      // reuse the crawl
      for (const f of await ws.list("raw/html")) await ws2.writeText(f, await readFile(ws.path(f)));
      const rep = await designExtract({ ...ctx, ws: ws2, llm, options: { llm: true } });
      expect(rep.ok).toBe(true);
      expect(rep.issues.some((i) => i.code === "LLM_FALLBACK")).toBe(true);
      const header = await ws2.readJson<ComponentDef>("design/components/siteHeader.json");
      expect(["heuristic", "llm"]).toContain(header.source);
      const comps = await Promise.all((await ws2.list("design/components", ".json")).map((f) => ws2.readJson<ComponentDef>(f)));
      expect(comps.filter((c) => c.source === "llm").length).toBe(comps.length - 1);
      // no page text was sent (sendContent=false)
      const sent = seen.join("\n");
      expect(sent).not.toContain("Start your day right");
      expect(sent).not.toContain("We are a small team");
      // ids/templates unchanged by the LLM path
      expect(header.template).toBe((await readComp("siteHeader")).template);
    } finally {
      await c2();
    }
  });
});
