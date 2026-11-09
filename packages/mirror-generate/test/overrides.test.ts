import { describe, expect, it } from "vitest";
import { siteOverridesLast } from "../src/generate.js";
import { mergeSeoRules } from "../src/seo.js";

describe("W1-B generator hooks", () => {
  it("design/overrides/site.css is emitted last in every stylesheet list", () => {
    const j: Record<string, unknown> = {
      stylesheets: ["/_design/styles/site-overrides.css", "/_design/a.css"],
      types: { page: { stylesheets: [{ href: "/_design/styles/site-overrides.css" }, { href: "/x.css" }] } },
      pages: { "/": { stylesheets: [{ href: "/y.css" }] } },
    };
    siteOverridesLast(j);
    expect(j.stylesheets).toEqual(["/_design/a.css", "/_design/styles/site-overrides.css"]);
    expect((j.types as any).page.stylesheets.map((s: { href: string }) => s.href)).toEqual(["/x.css", "/_design/styles/site-overrides.css"]);
    expect((j.pages as any)["/"].stylesheets).toEqual([{ href: "/y.css" }]);
  });

  it("mapping/seo.yaml rules win over inferred ones per tag; invalid ones are skipped", () => {
    const inferred = { rules: { "og:title": { from: "title" as const } }, order: ["og:title"], rejected: ["og:type", "twitter:card"] };
    const r = mergeSeoRules(inferred, { rules: { "og:title": { const: "X" }, "og:type": { perType: { article: "article", page: "website" } }, "twitter:card": { bogus: 1 }, "not a tag": { const: "y" } } });
    expect(r.rules["og:title"]).toEqual({ const: "X" });
    expect(r.rules["og:type"]).toEqual({ perType: { article: "article", page: "website" } });
    expect(r.order).toEqual(["og:title", "og:type"]);
    expect(r.rejected).toEqual(["twitter:card"]);
    expect(r.invalid.sort()).toEqual(["not a tag", "twitter:card"]);
    expect(mergeSeoRules(inferred, undefined)).toMatchObject({ rules: inferred.rules, applied: [] });
  });
});
