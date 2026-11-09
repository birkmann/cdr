import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Workspace, testStepContext } from "@harness/mirror-core";
import { designExtract } from "../src/index.js";
import { applyDesignOverrides, applyOverrides, ComponentOverride, readOverrides, restoreLazySrc, SITE_CSS_HREF, type DesignDocs, type DesignOverrides } from "../src/overrides.js";

const GIF = "data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
function base(): DesignDocs {
  return {
    manifest: {
      stylesheets: ["styles/a.css", "styles/b.css"],
      scripts: [{ src: "scripts/x.js", placement: "body", original: "/x.js", role: "theme" }],
      components: [
        { id: "card", file: "components/card.json", kind: "section" },
        { id: "share", file: "components/share.json", kind: "chrome" },
        { id: "footer", file: "components/footer.json", kind: "chrome" },
      ],
      templates: [{ contentType: "page", file: "templates/page.json" }],
      layouts: [{ id: "default", file: "layouts/default.json" }],
      defaultLocale: "en",
      assetSets: {
        home: {
          id: "home",
          pages: ["/"],
          stylesheets: [
            { href: "styles/a.css", original: "/core/a.css?x=1" },
            { href: "styles/b.css", original: "/theme/b.css" },
            { href: "styles/noscript_tag.css", original: "/seckit/noscript_tag.css" },
          ],
          scripts: [
            { src: "scripts/gtm.js", placement: "head", original: "/gtm.js", role: "tracker" },
            { src: "scripts/x.js", placement: "body", original: "/x.js", role: "theme" },
          ],
        },
      },
      pages: { "/about": { locale: "en", contentType: "page", components: {} } },
    },
    components: [
      { id: "card", kind: "section", template: '<div class="card"><div class="card__body">{{{body}}}</div></div>', props: [{ name: "body", type: "richText" }] },
      { id: "share", kind: "chrome", template: '<div class="share">…</div>', props: [] },
      { id: "footer", kind: "chrome", template: `<footer><img src="/m.webp?itok=1" class="b-lazy" data-src="/m.webp?itok=1"><img src="${GIF}" class="b-lazy" data-src="/n.webp"></footer>`, props: [] },
    ],
    templates: [{ contentType: "page", slots: [{ component: "pageTitle", region: "header" }, { component: "body", region: "content" }], wrapperHtml: "<main>{{{regions.header}}}{{{regions.content}}}</main>" }],
    layout: { id: "default", template: "{{{main}}}" },
  };
}
const none: DesignOverrides = { components: {}, pages: {} };

describe("design overrides (pure merge)", () => {
  it("no overrides → identical output, no marker", () => {
    const b = base();
    const r = applyOverrides(b, none);
    expect(r.manifest).toEqual(b.manifest);
    expect(r.components).toEqual(b.components);
    expect(r.applied).toEqual([]);
    expect(r.manifest.overrides).toBeUndefined();
  });

  it("component: templateReplace + propsPatch; unknown find / prop → errors, base untouched", () => {
    const b = base();
    const r = applyOverrides(b, {
      ...none,
      components: {
        card: { templateReplace: [{ find: 'class="card__body"', replace: 'class="card__body card__body--x"' }], propsPatch: { set: { body: { inline: true } } } },
        share: { templateReplace: [{ find: "nope", replace: "x" }], propsPatch: { set: { missing: { inline: true } } } },
      },
    });
    const card = r.components.find((c) => c.id === "card")!;
    expect(card.template).toContain("card__body--x");
    expect((card.props as { inline?: boolean }[])[0].inline).toBe(true);
    expect(card.overridden).toBe(true);
    expect(r.issues.map((i) => i.code)).toEqual(["DESIGN_OVERRIDE_NO_MATCH", "DESIGN_OVERRIDE_NO_MATCH"]);
    expect(String(b.components[0].template)).not.toContain("--x");
  });

  it("create a component; unknown component without create is an error", () => {
    const r = applyOverrides(base(), { ...none, components: { extra: { create: true, kind: "section", template: "<div class=extra></div>" }, ghost: { template: "<b></b>" } } });
    expect(r.components.some((c) => c.id === "extra")).toBe(true);
    expect((r.manifest.components as { id: string }[]).some((c) => c.id === "extra")).toBe(true);
    expect(r.issues.some((i) => i.code === "DESIGN_OVERRIDE_UNKNOWN_COMPONENT" && i.message.includes("ghost"))).toBe(true);
  });

  it("pages: slotsInsert after a slot, starting from the content-type template", () => {
    const r = applyOverrides(base(), { ...none, pages: { "/about": { slotsInsert: [{ slot: { component: "share", region: "header" }, after: "pageTitle" }], components: { footer: "footerV2" } } } });
    const pg = (r.manifest.pages as Record<string, { template: { slots: { component: string }[]; wrapperHtml: string }; components: Record<string, string> }>)["/about"];
    expect(pg.template.slots.map((s) => s.component)).toEqual(["pageTitle", "share", "body"]);
    expect(pg.template.wrapperHtml).toContain("regions.header");
    expect(pg.components.footer).toBe("footerV2");
  });

  it("assets: remove by substring, add after, order; scripts.json exclude", () => {
    const r = applyOverrides(base(), {
      ...none,
      assets: { stylesheets: { remove: ["noscript_tag.css"], add: [{ href: "styles/c.css", after: "a.css" }], order: ["b.css", "a.css"] } },
      scripts: { "gtm.js": { exclude: true, note: "tracker" } },
    });
    const set = (r.manifest.assetSets as Record<string, { stylesheets: { href: string }[]; scripts: { src: string }[] }>).home;
    expect(set.stylesheets.map((s) => s.href)).toEqual(["styles/b.css", "styles/c.css", "styles/a.css"]);
    expect(set.scripts.map((s) => s.src)).toEqual(["scripts/x.js"]);
    expect((r.manifest.excluded as { original: string }[])[0].original).toBe("/gtm.js");
    expect(r.manifest.stylesheets).toEqual(["styles/b.css", "styles/c.css", "styles/a.css"]);
  });

  it("images.keepRawLazySrc restores the placeholder of resolved lazy images only", () => {
    const [html, n] = restoreLazySrc('<img src="/m.webp?itok=1" data-src="/m.webp?itok=1"><img src="/k.png">');
    expect(n).toBe(1);
    expect(html).toContain('src="data:image/gif');
    const r = applyOverrides(base(), { ...none, assets: { images: { keepRawLazySrc: ["footer"] } } });
    const t = String(r.components.find((c) => c.id === "footer")!.template);
    expect(t.match(/src="data:image\/gif/g)?.length).toBe(2);
    expect(t).toContain('data-src="/m.webp?itok=1"');
  });

  it("site.css is appended LAST to every stylesheet list", () => {
    const r = applyOverrides(base(), { ...none, siteCss: ".card{color:red}", assets: { stylesheets: { add: [{ href: "styles/z.css" }] } } });
    const set = (r.manifest.assetSets as Record<string, { stylesheets: { href: string }[] }>).home;
    expect(set.stylesheets[set.stylesheets.length - 1].href).toBe(SITE_CSS_HREF);
    expect((r.manifest.stylesheets as string[]).at(-1)).toBe(SITE_CSS_HREF);
    expect(r.applied).toContain("site.css");
  });

  it("reproducibility is re-checked on overridden components (gate after overrides)", () => {
    const b = base();
    const card = b.components[0];
    card.exampleProps = { body: "<p>x</p>" };
    card.exampleHtml = '<div class="card"><div class="card__body"><p>x</p></div></div>';
    card.verified = false; // e.g. mined template broke the instance
    card.template = '<div class="card"><div class="card__body card__body--broken">{{{body}}}</div></div>';
    const fixed = applyOverrides(b, { ...none, components: { card: { templateReplace: [{ find: " card__body--broken", replace: "" }] } } });
    expect(fixed.components[0].verified).toBe(true);
    const broken = applyOverrides(base(), { ...none, components: { card: { exampleProps: { body: "<p>x</p>" }, templateReplace: [{ find: 'class="card"', replace: 'class="card x"' }] } } });
    // no exampleHtml in the base fixture → flag untouched
    expect(broken.components[0].verified).toBeUndefined();
  });

  it("deterministic: same inputs → identical output", () => {
    const ov: DesignOverrides = { ...none, components: { card: { propsPatch: { set: { body: { inline: true } } } } }, siteCss: "x{}" };
    expect(JSON.stringify(applyOverrides(base(), ov))).toBe(JSON.stringify(applyOverrides(base(), ov)));
  });

  it("schema is strict (unknown keys rejected)", () => {
    expect(ComponentOverride.safeParse({ templateReplace: [{ find: "a", replace: "b" }] }).success).toBe(true);
    expect(ComponentOverride.safeParse({ tempalte: "x" }).success).toBe(false);
  });
});

describe("design overrides (workspace I/O, fast path)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("bootstraps design/base, applies overrides from files, writes site css + report; invalid files are reported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmp-ov-"));
    dirs.push(dir);
    const ws = new Workspace("t", dir);
    const b = base();
    await ws.writeJson("design/manifest.json", b.manifest);
    for (const c of b.components) await ws.writeJson(`design/components/${c.id}.json`, c);
    for (const t of b.templates) await ws.writeJson(`design/templates/${t.contentType}.json`, t);
    await ws.writeJson("design/layouts/default.json", b.layout);
    await mkdir(ws.path("design/overrides/components"), { recursive: true });
    await writeFile(ws.path("design/overrides/components/card.json"), JSON.stringify({ propsPatch: { set: { body: { inline: true } } } }));
    await writeFile(ws.path("design/overrides/pages.json"), JSON.stringify({ "/about": { bogus: 1 } }));
    await writeFile(ws.path("design/overrides/site.css"), ".card{margin:0}\n");
    const r = await applyDesignOverrides(ws);
    expect(r.issues.some((i) => i.code === "DESIGN_BASE_BOOTSTRAPPED")).toBe(true);
    expect(r.gates["design.componentsReproducible"]).toMatchObject({ threshold: 3 });
    expect(r.issues.some((i) => i.code === "DESIGN_OVERRIDE_INVALID" && i.ref === "design/overrides/pages.json")).toBe(true);
    const card = JSON.parse(await readFile(ws.path("design/components/card.json"), "utf8"));
    expect(card.props[0].inline).toBe(true);
    const baseCard = JSON.parse(await readFile(ws.path("design/base/components/card.json"), "utf8"));
    expect(baseCard.props[0].inline).toBeUndefined();
    expect(await readFile(ws.path("design/styles/site-overrides.css"), "utf8")).toContain(".card{margin:0}");
    const applied = JSON.parse(await readFile(ws.path("design/overrides-applied.json"), "utf8"));
    expect(applied.applied).toEqual(["component:card", "site.css"]);
    // re-apply after removing the overrides → back to the base (fix rolled back cleanly)
    await rm(ws.path("design/overrides"), { recursive: true });
    await applyDesignOverrides(ws);
    expect(JSON.parse(await readFile(ws.path("design/components/card.json"), "utf8"))).toEqual(baseCard);
    expect(JSON.parse(await readFile(ws.path("design/manifest.json"), "utf8"))).toEqual(b.manifest);
    const { overrides } = await readOverrides(ws.path("design"));
    expect(overrides).toEqual({ components: {}, pages: {}, assets: undefined, scripts: undefined });
  });
  it("fast path (apply-overrides-only) carries the mined issues of the last full extract, minus overridden refs (W2-K)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmp-ov-"));
    dirs.push(dir);
    const ws = new Workspace("t", dir);
    const b = base();
    await ws.writeJson("design/manifest.json", b.manifest);
    for (const c of b.components) await ws.writeJson(`design/components/${c.id}.json`, c);
    for (const t of b.templates) await ws.writeJson(`design/templates/${t.contentType}.json`, t);
    await ws.writeJson("design/layouts/default.json", b.layout);
    await ws.writeJson("design/base/issues.json", [
      { severity: "info", code: "COMPONENT_VARIANT", message: "card variant", ref: "card" },
      { severity: "info", code: "COMPONENT_VARIANT", message: "share variant", ref: "share" },
      { severity: "warning", code: "COMPONENT_DEGRADED", message: "footer", ref: "footer" },
    ]);
    await mkdir(ws.path("design/overrides/components"), { recursive: true });
    await writeFile(ws.path("design/overrides/components/card.json"), JSON.stringify({ propsPatch: { set: { body: { inline: true } } } }));
    const r = await designExtract(testStepContext(ws, { options: { applyOverridesOnly: true } }));
    expect(r.stats.mode).toBe("apply-overrides");
    expect(r.issues.filter((i) => i.code.startsWith("COMPONENT_")).map((i) => i.ref)).toEqual(["share", "footer"]);
  });
});
