import { describe, expect, it } from "vitest";
import { slugify, normalizeText, toCamelCase, toPascalCase, decodeEntities } from "../src/index.js";

describe("slugify", () => {
  it.each([
    ["Fünf Tipps für ein gesundes Frühstück", "fuenf-tipps-fuer-ein-gesundes-fruehstueck"],
    ["Über uns", "ueber-uns"],
    ["Ernährung", "ernaehrung"],
    ["Straße & Öl", "strasse-oel"],
    ["  Hello,   World!  ", "hello-world"],
    ["Crème brûlée", "creme-brulee"],
    ["Why fruit's good", "why-fruits-good"],
    ["---", ""],
    ["Home 2024", "home-2024"],
  ])("%s -> %s", (input, out) => expect(slugify(input)).toBe(out));
});

describe("case helpers", () => {
  it.each([
    ["landing_page", "landingPage", "LandingPage"],
    ["page", "page", "Page"],
    ["teaser_list", "teaserList", "TeaserList"],
    ["hero", "hero", "Hero"],
    ["foo_bar", "fooBar", "FooBar"],
    ["teaser-list", "teaserList", "TeaserList"],
    ["fooBar", "fooBar", "FooBar"],
    ["Über uns", "ueberUns", "UeberUns"],
    ["HTMLBlock", "htmlBlock", "HtmlBlock"],
    ["field_cta2", "fieldCta2", "FieldCta2"],
  ])("%s", (input, camel, pascal) => {
    expect(toCamelCase(input)).toBe(camel);
    expect(toPascalCase(input)).toBe(pascal);
  });
});

describe("normalizeText", () => {
  it("collapses whitespace, nbsp, entities, zero-width", () => {
    expect(normalizeText("  a\u00a0&nbsp;b\n\t c&amp;d\u200b e&#8211;f &#x2014; ")).toBe("a b c&d e–f —");
    expect(normalizeText("Möglich")).toBe("Möglich");
    expect(decodeEntities("&unknown; &lt;p&gt;")).toBe("&unknown; <p>");
  });
});
