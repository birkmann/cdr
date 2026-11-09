import { cp, mkdtemp, readFile, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiteConfig, Workspace, type StepContext } from "@harness/mirror-core";
import { compileComponentModule, compileTemplate } from "../src/compile.js";
import { buildRedirects, nextjsContentfulGenerator, rewriteCssUrls, tokensToCss } from "../src/index.js";
import { inferSeoRules } from "../src/seo.js";

const FIXTURE_WS = fileURLToPath(new URL("./__fixtures__/ws", import.meta.url));
const log = { info() {}, warn() {}, error() {}, debug() {} };

describe("compileTemplate (Handlebars subset → TSX)", () => {
  it("keeps DOM, classes and whitespace; compiles placeholders to runtime calls", () => {
    const r = compileTemplate('<div class="hero">\n  <h2 class="hero__title">{{title}}</h2>\n  <img src="{{image.url}}" alt="{{image.alt}}">{{{body}}}</div>');
    expect(r.jsx).toContain('"className": "hero"');
    expect(r.jsx).toContain('{"\\n  "}');
    expect(r.jsx).toContain('{R.text(R.val(s0, "title"), ctx)}');
    expect(r.jsx).toContain('"src": R.attr(R.val(s0, "image.url"))');
    expect(r.jsx).toContain('<R.Html value={R.val(s0, "body")} ctx={ctx} />');
    expect(r.jsx).toMatch(/<img [^>]*\/>/);
    expect(r.paths).toEqual(["body", "image.alt", "image.url", "title"]);
  });

  it("handles each/if in children, class values and attribute position", () => {
    const r = compileTemplate(
      '<ul>{{#each items}}<li class="item {{#if this.active}}is-active{{/if}}"><a href="{{this.url}}"{{#if this.active}} aria-current="page"{{/if}}>{{this.label}}</a>{{#if this.children}}<ul>{{#each this.children}}<li>{{this.label}}</li>{{/each}}</ul>{{/if}}</li>{{/each}}</ul>',
    );
    expect(r.jsx).toContain('{R.each(s0, "items", (s1) => (');
    expect(r.jsx).toContain('"className": R.cat("item ", (R.truthy(R.val(s1, "this.active")) ? "is-active" : ""))');
    expect(r.jsx).toContain('...(R.truthy(R.val(s1, "this.active")) ? { "aria-current": "page" } : {  })');
    expect(r.jsx).toContain('{R.each(s1, "this.children", (s2) => (');
    expect(r.warnings).toEqual([]);
  });

  it("maps attributes to React props (bare, boolean, style, svg case, data-*)", () => {
    const r = compileTemplate('<div data-off-canvas hidden style="color: red; background-image: url(a.png)" tabindex="-1"><svg viewBox="0 0 1 1"><path stroke-width="2"/></svg><input value="x"></div>');
    expect(r.jsx).toContain('"data-off-canvas": ""');
    expect(r.jsx).toContain('"hidden": true');
    expect(r.jsx).toContain('"style": {"color":"red","backgroundImage":"url(a.png)"}');
    expect(r.jsx).toContain('"tabIndex": "-1"');
    expect(r.jsx).toContain('"viewBox": "0 0 1 1"');
    expect(r.jsx).toContain('"strokeWidth": "2"');
    expect(r.jsx).toContain('"defaultValue": "x"');
  });

  it("is deterministic and falls back to runtime string rendering for unbalanced blocks", () => {
    const t = '<p>{{#if a}}<b>x{{/if}}</b></p>';
    const a = compileComponentModule("odd", t, "test");
    expect(a.fallback).toBe(true);
    expect(a.code).toContain("R.TemplateString");
    const ok1 = compileComponentModule("siteHeader", "<header>{{siteName}}</header>", "test");
    const ok2 = compileComponentModule("siteHeader", "<header>{{siteName}}</header>", "test");
    expect(ok1.code).toBe(ok2.code);
    expect(ok1.code).toContain("export default function SiteHeader(");
  });

  it("compiles every mined fixture component without fallback", async () => {
    const dir = join(FIXTURE_WS, "design/components");
    for (const f of await readdir(dir)) {
      const c = JSON.parse(await readFile(join(dir, f), "utf8"));
      const m = compileComponentModule(c.id, c.template, f);
      expect(m.fallback, `${c.id}: ${m.warnings.join("; ")}`).toBe(false);
    }
  });
});

describe("routing, css, tokens, seo", () => {
  it("adds /node/<nid> redirects per locale and skips self/shadowing redirects", () => {
    const issues: never[] = [];
    const r = buildRedirects(
      {
        schema: { contentTypes: [] },
        locales: [{ code: "en", name: "English", default: true }, { code: "de", name: "Deutsch", pathPrefix: "de" }],
        redirects: [{ from: "/old-about", to: "/about-us", status: 301 }, { from: "/same", to: "/same" }, { from: "/about-us", to: "/x" }],
        entries: [
          { ccmId: "drupal:node:2", type: "page", locale: "en", path: "/about-us", source: { system: "drupal", kind: "node", id: "2" } },
          { ccmId: "drupal:node:2", type: "page", locale: "de", path: "/de/ueber-uns", source: { system: "drupal", kind: "node", id: "2" } },
        ],
        assets: [],
        collections: [],
        settings: null,
      },
      issues,
    );
    expect(r.next).toEqual([
      { source: "/de/node/2", destination: "/de/ueber-uns", statusCode: 301 },
      { source: "/node/2", destination: "/about-us", statusCode: 301 },
      { source: "/old-about", destination: "/about-us", statusCode: 301 },
    ]);
    expect(issues).toHaveLength(1);
  });

  it("skips redirects whose destination Next cannot parse (ibm.com / -> /de-*)", () => {
    const issues: { code: string }[] = [];
    const r = buildRedirects(
      {
        schema: { contentTypes: [] },
        locales: [{ code: "en", name: "English", default: true }],
        redirects: [{ from: "/", to: "/de-*", status: 303 }, { from: "/a", to: "/b?x=1" }, { from: "/c", to: "https://example.com/d" }],
        entries: [],
        assets: [],
        collections: [],
        settings: null,
      },
      issues as never[],
    );
    expect(r.next.map((x) => x.source)).toEqual(["/a", "/c"]);
    expect(issues.map((i) => i.code)).toEqual(["REDIRECT_INVALID_DESTINATION"]);
  });

  it("rewrites design-root css urls only", () => {
    expect(rewriteCssUrls('a{background:url("design/assets/x.png")} b{background:url(../assets/y.svg)} c{background:url(data:image/png;base64,AA)}')).toBe(
      'a{background:url("/_design/assets/x.png")} b{background:url(../assets/y.svg)} c{background:url(data:image/png;base64,AA)}',
    );
  });

  it("turns W3C tokens into CSS variables", () => {
    expect(tokensToCss({ color: { primary: { $type: "color", $value: "#1f4e79" } }, space: { s: { $value: "4px" } } })).toContain("--color-primary: #1f4e79;");
  });

  it("infers metatag rules that reproduce every crawled page", () => {
    const html = (t: string, img?: string, type = "website") =>
      `<html><head><meta property="og:title" content="${t}"><meta property="og:type" content="${type}"><meta name="twitter:card" content="summary">${img ? `<meta property="og:image" content="http://old${img}">` : ""}</head><body></body></html>`;
    const r = inferSeoRules([
      { path: "/", locale: "en", type: "landingPage", html: html("Home | S", "/a.jpg"), title: "Home | S", imagePath: "/a.jpg", known: new Set() },
      { path: "/about", locale: "en", type: "page", html: html("About | S"), title: "About | S", known: new Set() },
      { path: "/n", locale: "en", type: "article", html: html("N | S", "/b.jpg", "article"), title: "N | S", imagePath: "/b.jpg", known: new Set() },
    ]);
    expect(r.rules["og:title"]).toEqual({ from: "title" });
    expect(r.rules["og:image"]).toEqual({ from: "image" });
    expect(r.rules["twitter:card"]).toEqual({ const: "summary" });
    expect(r.rules["og:type"]).toEqual({ perType: { landingPage: "website", page: "website", article: "article" } });
  });
});

describe("nextjsContentfulGenerator", () => {
  let root: string;
  let ctx: StepContext;
  const app = () => join(root, "apps/fixture-web");

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cmp-gen-"));
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await mkdir(join(root, "ws"), { recursive: true });
    await cp(FIXTURE_WS, join(root, "ws/fixture"), { recursive: true });
    const site = SiteConfig.parse({ site: "fixture", baseUrl: "http://localhost:4400", frontend: { dataSource: "ccm" } });
    ctx = { site, ws: new Workspace("fixture", join(root, "ws")), dryRun: false, log, options: { repoRoot: root, install: false, download: false } };
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scaffolds the app once and generates registry, components, routing, public files", async () => {
    const r = await nextjsContentfulGenerator.generate(ctx);
    expect(r.ok).toBe(true);
    expect(r.stats.scaffolded).toBe(true);
    expect(r.stats.componentRuntimeFallbacks).toBe(0);
    const pkg = JSON.parse(await readFile(join(app(), "package.json"), "utf8"));
    expect(pkg.name).toBe("@cmp/fixture-web");
    const registry = await readFile(join(app(), "src/generated/registry.ts"), "utf8");
    expect(registry).toContain('import SiteHeader from "./components/SiteHeader";');
    expect(registry).toContain('"sectionHero": "sectionHero"');
    expect(registry).toContain('"article": "articleTeaser"');
    expect(registry).toContain("export const layout: LayoutEntry | undefined = { chrome:");
    const routing = JSON.parse(await readFile(join(app(), "src/generated/routing.json"), "utf8"));
    expect(routing.redirects).toContainEqual({ source: "/node/2", destination: "/about-us", statusCode: 301 });
    expect(routing.rewrites[0]).toEqual({ source: "/sites/default/files/:path*", destination: "/api/files/:path*" });
    const config = JSON.parse(await readFile(join(app(), "src/generated/config.json"), "utf8"));
    expect(config.dataSource).toBe("ccm");
    expect(config.ccmDir).toBe("../../ws/fixture/ccm");
    const design = JSON.parse(await readFile(join(app(), "src/generated/design.json"), "utf8"));
    expect(design.stylesheets).toContain("/_design/styles/base.css");
    // same-origin design scripts are served at their original path (loaders resolve lazy chunks relative to themselves)
    const scriptSrcs = design.scripts.map((s: { src: string }) => s.src);
    expect(scriptSrcs).toContain("/themes/custom/demo/js/cookies.js");
    expect(scriptSrcs).not.toContain("/_design/scripts/cookies.js");
    await readFile(join(app(), "public/_design/styles/base.css"));
    await readFile(join(app(), "public/sites/default/files/2024-05/oats.jpg"));
    await readFile(join(app(), "public/themes/custom/demo/js/cookies.js")); // SiteSettings script, same path as on the old site
    const types = await readFile(join(app(), "src/generated/types.ts"), "utf8");
    expect(types).toContain("export interface ArticleFields {");
    const seo = JSON.parse(await readFile(join(app(), "src/generated/seo.json"), "utf8"));
    expect(seo.rules["og:url"]).toEqual({ from: "canonical" });
    await expect(readFile(join(app(), "node_modules"), "utf8")).rejects.toThrow();
    await expect(readFile(join(app(), "src/lib/data/data.test.ts"), "utf8")).rejects.toThrow(); // template tests stay in the template
    await expect(readdir(join(app(), "fixtures"))).rejects.toThrow();
  });

  it("never overwrites owned code on re-run, regenerates src/generated deterministically", async () => {
    const owned = join(app(), "src/components/fallback.tsx");
    await writeFile(owned, "// hand-edited by the parity loop\n");
    await writeFile(join(app(), "src/generated/registry.ts"), "// stale\n");
    await writeFile(join(app(), "public/robots-extra.txt"), "owned\n");
    const before = await readFile(join(app(), "src/generated/components/SiteHeader.tsx"), "utf8");
    const r = await nextjsContentfulGenerator.generate(ctx);
    expect(r.stats.scaffolded).toBe(false);
    expect(await readFile(owned, "utf8")).toBe("// hand-edited by the parity loop\n");
    expect(await readFile(join(app(), "public/robots-extra.txt"), "utf8")).toBe("owned\n");
    expect(await readFile(join(app(), "src/generated/registry.ts"), "utf8")).toContain("export const components");
    expect(await readFile(join(app(), "src/generated/components/SiteHeader.tsx"), "utf8")).toBe(before);
  });

  it("refreshes template files the app never modified, keeps owner edits, never refreshes part of a changed set", async () => {
    const tpl = join(root, "tpl");
    await mkdir(join(tpl, "src/lib"), { recursive: true });
    await writeFile(join(tpl, "package.json"), JSON.stringify({ name: "tpl", scripts: {} }));
    await writeFile(join(tpl, "src/lib/a.ts"), "export const a = 1;\n");
    await writeFile(join(tpl, "src/lib/b.ts"), "export const b = 1;\n");
    await writeFile(join(tpl, "src/lib/c.test.ts"), "// template test\n");
    await mkdir(join(tpl, "src/generated"), { recursive: true });
    await writeFile(join(tpl, "src/generated/registry.ts"), "// template placeholder, regenerated by every generate\n");
    const tctx = { ...ctx, options: { ...ctx.options, appDir: "apps/tpl-web", templateDir: tpl } };
    const r1 = await nextjsContentfulGenerator.generate(tctx);
    expect(r1.stats.scaffolded).toBe(true);
    const tApp = join(root, "apps/tpl-web");
    const rd = (f: string) => readFile(join(tApp, f), "utf8");
    const manifest = JSON.parse(await rd(".cmp/template-files.json"));
    expect(Object.keys(manifest)).toEqual(["src/lib/a.ts", "src/lib/b.ts"]);
    // 1. template changes a and gains d → both refreshed (dry-run first: nothing written)
    await writeFile(join(tpl, "src/lib/a.ts"), "export const a = 2;\n");
    await writeFile(join(tpl, "src/lib/d.ts"), "export const d = 1;\n");
    await nextjsContentfulGenerator.generate({ ...tctx, dryRun: true });
    expect(await rd("src/lib/a.ts")).toBe("export const a = 1;\n");
    const r2 = await nextjsContentfulGenerator.generate(tctx);
    expect(r2.stats).toMatchObject({ scaffolded: false, templateFilesRefreshed: 2 });
    expect(await rd("src/lib/a.ts")).toBe("export const a = 2;\n");
    expect(await rd("src/lib/d.ts")).toBe("export const d = 1;\n");
    await expect(rd("src/lib/c.test.ts")).rejects.toThrow();
    // 2. the owner edits b; the template changes a only → a refreshed, b kept (template unchanged for b)
    await writeFile(join(tApp, "src/lib/b.ts"), "export const b = 'owned';\n");
    await writeFile(join(tpl, "src/lib/a.ts"), "export const a = 3;\n");
    const r3 = await nextjsContentfulGenerator.generate(tctx);
    expect(await rd("src/lib/a.ts")).toBe("export const a = 3;\n");
    expect(await rd("src/lib/b.ts")).toBe("export const b = 'owned';\n");
    expect(r3.issues.find((i) => i.code === "TEMPLATE_FILE_MODIFIED")?.message).toContain("src/lib/b.ts");
    // 3. the template changes a AND b together (co-changed set), b is owner-edited → nothing refreshed, reported
    await writeFile(join(tpl, "src/lib/a.ts"), "export const a = 4; export const x = 1;\n");
    await writeFile(join(tpl, "src/lib/b.ts"), "import { x } from '../src/a'; export const b = x;\n");
    const r4 = await nextjsContentfulGenerator.generate(tctx);
    expect(await rd("src/lib/a.ts")).toBe("export const a = 3;\n");
    expect(await rd("src/lib/b.ts")).toBe("export const b = 'owned';\n");
    const partial = r4.issues.find((i) => i.code === "TEMPLATE_REFRESH_PARTIAL")!;
    expect(partial.message).toContain("src/lib/b.ts");
    expect(partial.message).toContain("src/lib/a.ts");
    // 4. the loop's re-runs never refresh (refreshTemplate: false); resolving b (copy from the template) unblocks a
    await writeFile(join(tApp, "src/lib/b.ts"), await readFile(join(tpl, "src/lib/b.ts"), "utf8"));
    await nextjsContentfulGenerator.generate({ ...tctx, options: { ...tctx.options, refreshTemplate: false } });
    expect(await rd("src/lib/a.ts")).toBe("export const a = 3;\n");
    await nextjsContentfulGenerator.generate(tctx);
    expect(await rd("src/lib/a.ts")).toBe("export const a = 4; export const x = 1;\n");
  });

  it("an app from before the manifest (partial records): equal files adopted, a co-changed set is never split", async () => {
    // W2-H repro: page.tsx equal to the template, runtime.tsx a stale copy; the template then changes both together
    const tpl = join(root, "tpl2");
    await mkdir(join(tpl, "src/lib/render"), { recursive: true });
    await writeFile(join(tpl, "package.json"), JSON.stringify({ name: "tpl2", scripts: {} }));
    await writeFile(join(tpl, "src/lib/render/page.tsx"), "import { r } from '../src/runtime'; export const p = r;\n");
    await writeFile(join(tpl, "src/lib/render/runtime.tsx"), "export const r = 1; export const w = 2;\n");
    const tctx = { ...ctx, options: { ...ctx.options, appDir: "apps/tpl2-web", templateDir: tpl } };
    await nextjsContentfulGenerator.generate(tctx);
    const tApp = join(root, "apps/tpl2-web");
    const rd = (f: string) => readFile(join(tApp, f), "utf8");
    await rm(join(tApp, ".cmp/template-files.json"));
    await writeFile(join(tApp, "src/lib/render/runtime.tsx"), "export const r = 1;\n"); // stale copy, no `w`
    const r1 = await nextjsContentfulGenerator.generate(tctx);
    expect(r1.issues.find((i) => i.code === "TEMPLATE_FILE_DIVERGED")?.message).toContain("src/lib/render/runtime.tsx");
    expect(Object.keys(JSON.parse(await rd(".cmp/template-files.json")))).toEqual(["src/lib/render/page.tsx"]);
    await writeFile(join(tpl, "src/lib/render/page.tsx"), "import { r, w } from '../src/runtime'; export const p = r + w;\n");
    await writeFile(join(tpl, "src/lib/render/runtime.tsx"), "export const r = 1; export const w = 3;\n");
    const r2 = await nextjsContentfulGenerator.generate(tctx);
    expect(r2.issues.some((i) => i.code === "TEMPLATE_REFRESH_PARTIAL")).toBe(true);
    expect(await rd("src/lib/render/page.tsx")).toBe("import { r } from '../src/runtime'; export const p = r;\n"); // not refreshed alone
  });

  it("dry-run writes nothing", async () => {
    const r = await nextjsContentfulGenerator.generate({ ...ctx, dryRun: true, options: { ...ctx.options, appDir: "apps/other-web" } });
    expect(r.dryRun).toBe(true);
    await expect(readdir(join(root, "apps/other-web"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- acme.com (Drupal 10, da_vinci_code): static islands
// __fixtures__/acme = trimmed real snippets of the acme.com capture (design asset sets, drupalSettings, layout with
// GTM noscript, crawled head with trackers + seckit, CCM with replay / old-origin URLs). Captured content: internal POC only.
const ACME_WS = fileURLToPath(new URL("./__fixtures__/acme", import.meta.url));

describe("nextjsContentfulGenerator — static render mode (acme.com)", () => {
  let root: string;
  let ctx: StepContext;
  const app = () => join(root, "apps/acme-web");
  const gen = async <T = string>(rel: string, parse = false): Promise<T> => {
    const t = await readFile(join(app(), "src/generated", rel), "utf8");
    return (parse ? JSON.parse(t) : t) as T;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cmp-gen-acme-"));
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await mkdir(join(root, "ws"), { recursive: true });
    await cp(ACME_WS, join(root, "ws/acme"), { recursive: true });
    const site = SiteConfig.parse({ site: "acme", baseUrl: "http://localhost:4401", frontend: { dataSource: "ccm" } });
    ctx = { site, ws: new Workspace("acme", join(root, "ws")), dryRun: false, log, options: { repoRoot: root, install: false, download: false } };
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("detects the Drupal JS design and writes a static design.json from asset sets + crawled head", async () => {
    const r = await nextjsContentfulGenerator.generate(ctx);
    expect(r.ok).toBe(true);
    expect(r.stats.renderMode).toBe("static");
    const d = await gen<Record<string, any>>("design.json", true);
    expect(d.renderMode).toBe("static");
    // one asset set per content type / page, in original order; seckit kept, noscript-only CSS dropped
    const home = d.pages["/"];
    expect(home.stylesheets.map((s: { href: string }) => s.href)).toEqual(["/_design/styles/css_agg0.css", "/_design/styles/darkmode.css", "/_design/styles/seckit.no_body.css"]);
    expect(home.stylesheets[1].attrs).toEqual({ class: "darkreader darkmode-css" });
    expect(home.stylesheets[2].attrs).toEqual({ id: "seckit-clickjacking-no-body" });
    // scripts: settings marker first, same-origin scripts at their ORIGINAL url, vendor + inline from design/
    expect(home.scripts[0]).toEqual({ settings: true, placement: "head" });
    expect(home.scripts.map((s: { src?: string }) => s.src).filter(Boolean)).toEqual([
      "/core/assets/vendor/jquery/jquery.min.js?v=4.0.0",
      "/sites/default/files/js/js_NLxQ.js?scope=header&delta=1&language=en",
      "/_design/scripts/tracker-stub.js",
      "/modules/contrib/seckit/js/seckit.document_write.js?v=2.0.3",
      "/_design/scripts/popper.js",
      "/themes/custom/da_vinci_code/node_modules/%40searchstax-inc/searchstudio-ux-js/dist/%40searchstax-inc/searchstudio-ux-js.iife.js?v=1.x",
    ]);
    expect(home.scripts.find((s: { inline?: string }) => s.inline)).toEqual({ inline: "window.__inlineRan = true;", placement: "body" });
    expect(home.drupalSettings.path.currentPath).toBe("node/472961");
    expect(home.drupalSettings.gtm).toBeDefined(); // settings are data, kept verbatim (gtm.js itself is not loaded)
    // crawled head: per-page values are slots, static markup literal, trackers + duplicated assets gone
    const slots = home.head.filter((i: { slot?: string }) => i.slot).map((i: { slot: string }) => i.slot);
    expect(slots).toEqual(["description", "canonical", "social", "hreflang", "title", "preload", "stylesheets", "scripts"]);
    const literal = home.head.filter((i: { html?: string }) => i.html).map((i: { html: string }) => i.html).join("\n");
    expect(literal).toContain('<meta name="google-site-verification"');
    expect(literal).toContain("window.dataLayer = window.dataLayer || [];"); // inert stand-in for the removed bootstrap
    expect(literal).not.toMatch(/gtm\.js|gtag\.js|dataLayer_tags|fireTags/);
    expect(literal).toContain('<noscript>'); // seckit noscript stylesheet stays inside <noscript>
    expect(home.htmlAttrs).toEqual({ lang: "en", dir: "ltr", prefix: "og: https://ogp.me/ns#" });
    expect(home.bodyAttrs.class).toBe("hide-default-heading home path-frontpage page-node-type-dsu-component-page has-glyphicons");
    expect(d.preload).toEqual([{ href: "/_design/assets/themes/custom/da_vinci_code/fonts/Acme_Text-Book.woff2", as: "font", type: "font/woff2", crossorigin: "anonymous" }]);
    expect(d.urlRewrite).toEqual({ replay: "http://localhost:4401", origin: "https://www.acme.com" });
    expect(d.types.dsuComponentPage.scripts.length).toBe(home.scripts.length);
  });

  it("lists captured third-party resources (not scripts) so the app serves its local copy (bmw.scene7.com stage images)", async () => {
    const ws = join(root, "ws/acme");
    const assets = JSON.parse(await readFile(join(ws, "raw/html/assets.json"), "utf8"));
    await mkdir(join(ws, "raw/html/assets/__ext/cdn.example.test/is/image"), { recursive: true });
    await writeFile(join(ws, "raw/html/assets/__ext/cdn.example.test/is/image/hero:3to1"), Buffer.from([82, 73, 70, 70]));
    await writeFile(join(ws, "raw/html/assets/__ext/cdn.example.test/widget.js"), "void 0;");
    assets.push(
      { url: "http://localhost:4401/__ext/cdn.example.test/is/image/hero:3to1?wid=1919", path: "/__ext/cdn.example.test/is/image/hero:3to1?wid=1919", file: "raw/html/assets/__ext/cdn.example.test/is/image/hero:3to1", kind: "image", mime: "image/webp" },
      { url: "http://localhost:4401/__ext/cdn.example.test/widget.js", path: "/__ext/cdn.example.test/widget.js", file: "raw/html/assets/__ext/cdn.example.test/widget.js", kind: "script", mime: "application/javascript" },
    );
    await writeFile(join(ws, "raw/html/assets.json"), JSON.stringify(assets));
    try {
      expect((await nextjsContentfulGenerator.generate(ctx)).ok).toBe(true);
      const d = await gen<Record<string, any>>("design.json", true);
      expect(d.urlRewrite.thirdParty.paths).toContain("/__ext/cdn.example.test/is/image/hero:3to1");
      expect(d.urlRewrite.thirdParty.paths.some((p: string) => p.endsWith(".js"))).toBe(false);
      expect(await readFile(join(app(), "public/__ext/cdn.example.test/is/image/hero:3to1"))).toEqual(Buffer.from([82, 73, 70, 70]));
      // extension-less public files are served with the crawl-recorded Content-Type (Next would send octet-stream; an SVG <img> stays blank)
      const routing = await gen<Record<string, any>>("routing.json", true);
      expect(routing.headers).toEqual([{ source: "/__ext/cdn.example.test/is/image/hero\\:3to1", headers: [{ key: "Content-Type", value: "image/webp" }] }]);
    } finally {
      await writeFile(join(ws, "raw/html/assets.json"), JSON.stringify(assets.slice(0, -2), null, 1));
    }
  });

  it("keeps public/ a directory when the crawl recorded the page itself as an asset (toyota.com `<img src=\"\">`)", async () => {
    const ws = join(root, "ws/acme");
    const original = await readFile(join(ws, "raw/html/assets.json"), "utf8");
    await writeFile(join(ws, "raw/html/assets/index"), "");
    await writeFile(join(ws, "raw/html/assets.json"), JSON.stringify([{ url: "https://www.acme.com/", path: "/", file: "raw/html/assets/index", kind: "image", mime: "text/html" }, ...JSON.parse(original)]));
    try {
      const r = await nextjsContentfulGenerator.generate(ctx);
      expect(r.ok).toBe(true);
      expect(r.issues.filter((i) => i.code === "PUBLIC_PATH_CONFLICT")).toEqual([]);
      await readFile(join(app(), "public/core/assets/vendor/jquery/jquery.min.js"));
    } finally {
      await writeFile(join(ws, "raw/html/assets.json"), original);
      await rm(join(ws, "raw/html/assets/index"));
    }
  });

  it("emits template sources (tracker-free) with variants and mined instance values instead of compiled TSX", async () => {
    const registry = await gen("registry.ts");
    const tpl = await gen("templates-src.ts");
    expect(registry).toContain('import { T } from "./templates-src";');
    expect(registry).toContain('template: T["sectionCText"], Component: templateComponent(T["sectionCText"])');
    expect(registry).toContain('variantOf: "siteHeader"');
    expect(registry).toContain('instanceKey: "entityId", instanceProps: {"334386":');
    expect(registry).toContain('variants: [{ id: "v2", pages: ["/about"]');
    expect(registry).toContain('"derive":"ccmIdTail"');
    expect(tpl).toContain('{{{chrome.siteHeader}}}');
    expect(tpl).not.toContain("GTM-PWRZ37"); // GTM <noscript><iframe> removed from the layout
    expect(tpl).toContain('<symbol id=\\"arrow--right\\"'); // icon sprite kept
    await expect(readdir(join(app(), "src/generated/components"))).rejects.toThrow(); // no TSX components in static mode
  });

  it("serves design + crawled files at their original paths (decoded for public/)", async () => {
    await readFile(join(app(), "public/core/assets/vendor/jquery/jquery.min.js"));
    await readFile(join(app(), "public/sites/default/files/js/js_NLxQ.js"));
    await readFile(join(app(), "public/themes/custom/da_vinci_code/node_modules/@searchstax-inc/searchstudio-ux-js/dist/@searchstax-inc/searchstudio-ux-js.iife.js"));
    await readFile(join(app(), "public/themes/custom/da_vinci_code/images/icon-x.png")); // JS-requested, from raw/html/assets
    await readFile(join(app(), "public/_design/styles/seckit.no_body.css"));
    await expect(readFile(join(app(), "public/__ext/unpkg.com/x.js"))).rejects.toThrow();
    const cfg = await gen<Record<string, any>>("config.json", true);
    expect(cfg.assetSource).toEqual({ base: "http://localhost:4401", oldOrigins: ["https://www.acme.com"], localOnly: true });
  });
});

describe("fetchUrlFor (never fetches the old live origin of a captured site)", () => {
  it("re-hosts old-origin URLs onto the local source and refuses other hosts", async () => {
    const { fetchUrlFor } = await import("../src/generate.js");
    expect(fetchUrlFor("/sites/default/files/a.jpg", "http://localhost:4401", ["https://www.acme.com"])).toBe("http://localhost:4401/sites/default/files/a.jpg");
    expect(fetchUrlFor("https://www.acme.com/sites/default/files/a.jpg?itok=1", "http://localhost:4401", ["https://www.acme.com"])).toBe("http://localhost:4401/sites/default/files/a.jpg?itok=1");
    expect(fetchUrlFor("https://cdn.example.com/x.js", "http://localhost:4401", ["https://www.acme.com"])).toBeUndefined();
    expect(fetchUrlFor("https://cdn.example.com/x.js", "https://drupal.example.org", [])).toBe("https://cdn.example.com/x.js");
  });
});

describe("unReplayText (ported text files must not depend on the replay)", () => {
  it("makes replay URLs root-relative, third parties local under /__ext/", async () => {
    const { unReplayText } = await import("../src/generate.js");
    const js = 'load("http://localhost:4401/__ext/cdnjs.cloudflare.com/x.js");u="//localhost:4401/sites/a.png";j="http:\\/\\/localhost:4401\\/b"';
    expect(unReplayText(js, "http://localhost:4401")).toBe('load("/__ext/cdnjs.cloudflare.com/x.js");u="/sites/a.png";j="\\/b"');
    expect(unReplayText(js, undefined)).toBe(js);
  });
});

describe("unReplayText — scheme-less hosts", () => {
  it("returns bare replay hosts of third parties to the original host", async () => {
    const { unReplayText } = await import("../src/generate.js");
    expect(unReplayText('i="localhost:4401/__ext/cdnjs.cloudflare.com/ajax/x.js";', "http://localhost:4401")).toBe('i="cdnjs.cloudflare.com/ajax/x.js";');
  });
});

describe("headFromHtml — crawled <title> (Views listing pages have no CCM meta, W2-G)", () => {
  it("returns the decoded title text next to the head slots", async () => {
    const { headFromHtml } = await import("../src/static.js");
    const h = headFromHtml(`<html lang="en"><head><meta charset="utf-8"><title>Recipes &amp; more | Umami Food Magazine</title><link rel="canonical" href="/x"></head><body></body></html>`);
    expect(h.title).toBe("Recipes & more | Umami Food Magazine");
    expect(h.head.map((x) => x.slot ?? "html")).toEqual(["html", "title", "canonical"]);
    expect(headFromHtml("<html><head></head></html>").title).toBeUndefined();
  });

  it("keeps a `>` inside a quoted attribute value in its tag (ibm.com ut-codes metas swallowed the canonical link)", async () => {
    const { headFromHtml } = await import("../src/static.js");
    const h = headFromHtml(
      `<html><head data-x="a>b"><meta name="ut-codes" content="10M00 > 15MSC > 30MXF"/><meta name='ut-codes-id' content='10M00 - Misc > 30MXF'/><link rel="canonical" href="https://www.ibm.com/us-en"/><script data-k="1>0">var a = 1;</script></head><body class="x" data-y="p>q"></body></html>`,
    );
    expect(h.head).toEqual([
      { html: `<meta name="ut-codes" content="10M00 > 15MSC > 30MXF"/>` },
      { html: `<meta name='ut-codes-id' content='10M00 - Misc > 30MXF'/>` },
      { slot: "canonical" },
      { slot: "scripts" },
    ]);
    expect(h.bodyAttrs).toEqual({ class: "x", "data-y": "p>q" });
  });

  it("decodes numeric entities in attribute values (bmw.de body data-breakpoints JSON must survive for the site's JSON.parse)", async () => {
    const { headFromHtml } = await import("../src/static.js");
    const h = headFromHtml(`<html><head></head><body data-breakpoints="{&#34;small&#34;:767,&#x22;medium&#x22;:1023}" data-t="a &amp; b &amp;#34;"></body></html>`);
    expect(JSON.parse(h.bodyAttrs["data-breakpoints"])).toEqual({ small: 767, medium: 1023 });
    expect(h.bodyAttrs["data-t"]).toBe("a & b &#34;");
  });
});
