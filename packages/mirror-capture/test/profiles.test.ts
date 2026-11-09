/**
 * P1 theme packs (docs/DEEPSEEK_ONLY_PLAN.md §5.1): schema, merge precedence site > theme > generic, detection,
 * resolution from the workspace. The Acme goldens (acme.test.ts) cover byte-identical extraction.
 */
import { describe, expect, it } from "vitest";
import { createTempWorkspace, testSiteConfig } from "@harness/mirror-core";
import {
  DEFAULT_PROFILE_SET,
  detectThemes,
  GENERIC_PROFILE_SET,
  isValidSelector,
  packForThemes,
  ParagraphProfileSchema,
  parseProfilePack,
  profileSetFor,
  ProfilePackSchema,
  themePacks,
} from "../src/profiles.js";
import { resolveProfileSet } from "../src/theme-pack.js";

describe("theme packs", () => {
  it("da_vinci_code.yaml loads and holds the former constants", () => {
    const p = themePacks().get("da_vinci_code")!;
    expect(p).toBeDefined();
    expect(Object.keys(DEFAULT_PROFILE_SET.profiles)).toHaveLength(19);
    expect(DEFAULT_PROFILE_SET.entityRoots.map((r) => r.type)).toEqual(["accordion_item", "downloads", "brand_portfolio", "downloads_item"]);
    // theme class fields first, then the generic ones not already listed (first match per field wins)
    expect(DEFAULT_PROFILE_SET.classFields.map((c) => `${c.field}:${c.re.source}`)).toEqual([
      "style:^cta-style-(.+)$",
      "position:^position-(left|right|center|top|bottom)$",
      "color:^color-library-(.+)$",
      "background:^da-vinci-code-background--(.+)$",
      "background:^background--(.+)$",
      "container:^container--(.+)$",
    ]);
    expect(DEFAULT_PROFILE_SET.profiles.brand_portfolio.slots!.groups).toMatchObject({ kind: "list", item: { brands: { sel: ".brand-portfolio__bubble" } } });
    expect(GENERIC_PROFILE_SET).toMatchObject({ id: "none", themePack: "none", profiles: {}, entityRoots: [], sources: ["generic"] });
  });

  it("schema rejects bad selectors, non-camelCase field ids, list without item, unknown keys", () => {
    expect(isValidSelector(".a > b[c='d']")).toBe(true);
    expect(isValidSelector("a[")).toBe(false);
    expect(ParagraphProfileSchema.safeParse({ slots: { title: ".x" } }).success).toBe(true);
    expect(ParagraphProfileSchema.safeParse({ slots: { title: "a[" } }).success).toBe(false);
    expect(ParagraphProfileSchema.safeParse({ slots: { Title: ".x" } }).success).toBe(false);
    expect(ParagraphProfileSchema.safeParse({ slots: { field_title: ".x" } }).success).toBe(false);
    expect(ParagraphProfileSchema.safeParse({ slots: { l: { sel: ".x", kind: "list" } } }).success).toBe(false);
    expect(ParagraphProfileSchema.safeParse({ slots: { t: { sel: ".x", kind: "bogus" } } }).success).toBe(false);
    expect(ParagraphProfileSchema.safeParse({ slot: {} }).success).toBe(false);
    expect(ProfilePackSchema.safeParse({ classFields: [{ re: "^no-group$", field: "x" }] }).success).toBe(false);
    expect(() => parseProfilePack("profiles:\n  Bad-Name: {}\n", "t.yaml")).toThrow(/t.yaml: invalid profile pack: profiles/);
  });

  it("merge: site > theme > generic; slot override/append/remove; site entity roots first; profile removal", () => {
    const site = parseProfilePack(`
profiles:
  statement_component:
    slots:
      eyebrow: ".statement__kicker"
      image: { sel: ".statement__image img", kind: asset }
  accordion_item:
    slots:
      number: null
  feature_banner: null
  new_thing:
    slots: { title: ".new-thing__title" }
entityRoots:
  - { sel: "div.new-thing", type: new_thing, entity: paragraph }
  - { sel: ".downloads-item", type: downloads_item, entity: item }
classFields:
  - { re: "^tone-(.+)$", field: tone }
`);
    const s = profileSetFor("da_vinci_code", site);
    expect(s.id).toBe("site+da_vinci_code");
    expect(s.sources).toEqual(["site:mapping/profiles.yaml", "theme:da_vinci_code", "generic"]);
    expect(s.profiles.statement_component.slots).toEqual({ eyebrow: ".statement__kicker", image: { sel: ".statement__image img", kind: "asset" } });
    expect(Object.keys(s.profiles.accordion_item.slots!)).toEqual(["title"]);
    expect(s.profiles.accordion_item.flags).toEqual({ expanded: "is-expanded" });
    expect(s.profiles.feature_banner).toBeUndefined();
    expect(s.profiles.new_thing.slots).toEqual({ title: ".new-thing__title" });
    expect(s.entityRoots.map((r) => r.type)).toEqual(["new_thing", "downloads_item", "accordion_item", "downloads", "brand_portfolio"]);
    expect(s.classFields[0].field).toBe("tone");
    // the theme layer itself is untouched
    expect(DEFAULT_PROFILE_SET.profiles.statement_component.slots).toEqual({ eyebrow: ".statement__eyebrow" });
    expect(() => profileSetFor("nope")).toThrow(/theme pack "nope" not found/);
  });

  it("detection: /themes/custom/<theme>/ paths and ajaxPageState, most frequent first", () => {
    expect(detectThemes(["/themes/custom/da_vinci_code/logo.svg", '<link href="/themes/custom/da_vinci_code/x.css"><script src="/themes/contrib/stable/y.js">'])).toEqual(["da_vinci_code", "stable"]);
    expect(detectThemes(['{"ajaxPageState":{"libraries":"x","theme":"olivero","theme_token":null}}', "/themes/custom/foo/a.css", "/themes/custom/foo/b.css"])).toEqual(["olivero", "foo"]);
    expect(packForThemes(["stable", "da_vinci_code"])).toBe("da_vinci_code");
    expect(packForThemes(["olivero"])).toBe("none");
  });
});

describe("resolveProfileSet (workspace)", () => {
  const crawl = (assetPath: string) => ({ pages: [], assets: [{ url: "", path: assetPath, file: "", kind: "image" as const, mime: "image/svg+xml", size: 1, sha256: "", referencedBy: [] }] });

  it("auto detects the pack; none = generic + THEME_PACK_NONE only for auto; site profiles.yaml on top", async () => {
    const { ws, cleanup } = await createTempWorkspace("prof");
    try {
      const site = testSiteConfig();
      const auto = await resolveProfileSet(ws, site, crawl("/themes/custom/da_vinci_code/logo.svg"));
      expect(auto).toMatchObject({ requested: "auto", detected: ["da_vinci_code"], issues: [] });
      expect(auto.set.id).toBe("da_vinci_code");
      const unknown = await resolveProfileSet(ws, site, crawl("/themes/custom/umami/logo.svg"));
      expect(unknown.set.id).toBe("none");
      expect(unknown.issues[0]).toMatchObject({ code: "THEME_PACK_NONE", severity: "info" });
      const none = await resolveProfileSet(ws, testSiteConfig({ source: { adapter: "html", themePack: "none" } }), crawl("/themes/custom/da_vinci_code/logo.svg"));
      expect(none.set.id).toBe("none");
      expect(none.issues).toEqual([]);
      await ws.writeText("mapping/profiles.yaml", "profiles:\n  statement_component:\n    slots:\n      eyebrow: .statement__eyebrow\n");
      const withSite = await resolveProfileSet(ws, site, crawl("/themes/custom/umami/logo.svg"));
      expect(withSite.set).toMatchObject({ id: "site", themePack: "none", profiles: { statement_component: { slots: { eyebrow: ".statement__eyebrow" } } } });
      expect((await resolveProfileSet(ws, site, undefined, { themePack: "da_vinci_code", sitePack: null })).set.id).toBe("da_vinci_code");
      await ws.writeText("mapping/profiles.yaml", "profiles:\n  x:\n    slots:\n      Bad: .y\n");
      await expect(resolveProfileSet(ws, site)).rejects.toThrow(/invalid profile pack/);
    } finally {
      await cleanup();
    }
  });
});
