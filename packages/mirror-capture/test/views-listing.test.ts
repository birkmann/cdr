/**
 * W2-I: crawled Views page displays → Collection naming and row type (synthetic Drupal core markup, theme-agnostic).
 * Name = the page h1, else the head <title> without the site-name suffix, never "<View> (page_1)"; type = the dominant
 * row bundle, also for grid styles without `.views-row` (core responsive grid).
 */
import { describe, expect, it } from "vitest";
import { buildCcm, listingPageName } from "../src/to-ccm.js";
import { coverageInputFor } from "../src/testing.js";

const BASE = "http://localhost:4499";
const card = (type: string, path: string, title: string) =>
  `<article class="node node--type-${type} node--view-mode-card"><h2><a href="${path}"><span class="field field--name-title">${title}</span></a></h2></article>`;
const listing = (title: string, h1: string | null, view: string, display: string, inner: string) => `<!DOCTYPE html><html lang="en"><head><title>${title}</title>
<meta property="og:site_name" content="Demo Magazine"></head><body class="path-${view}"><main id="main-content">${h1 ? `<h1 class="page-title">${h1}</h1>` : ""}
<div class="block block-system block-system-main-block"><div class="views-element-container"><div class="view view-${view} view-id-${view} view-display-id-${display}"><div class="view-content">${inner}</div></div></div></div></main></body></html>`;

async function collectionsOf(files: Record<string, string>) {
  const input = coverageInputFor(files, BASE, BASE);
  const res = await buildCcm({
    baseUrl: BASE,
    pages: input.crawl.pages,
    assets: [],
    links: {},
    redirects: [],
    readText: async (rel) => files[input.crawl.pages.find((p) => p.files.raw === rel || p.files.rendered === rel)!.path],
  });
  return res.collections;
}

describe("Views listing pages → collections", () => {
  it("names the listing after its h1 and types it by the rows of a responsive grid (no .views-row)", async () => {
    const grid = `<div class="views-view-responsive-grid"><div class="views-view-responsive-grid__item"><div class="views-view-responsive-grid__item-inner">${card("recipe", "/recipes/a", "A")}</div></div>
<div class="views-view-responsive-grid__item"><div class="views-view-responsive-grid__item-inner">${card("recipe", "/recipes/b", "B")}</div></div></div>`;
    const [c] = await collectionsOf({ "/recipes": listing("Recipes | Demo Magazine", "Recipes", "recipes", "page_1", grid) });
    expect(c).toMatchObject({ id: "recipes--page_1", name: "Recipes", type: "recipe", path: { en: "/recipes" } });
  });

  it("falls back to the <title> without the site name, and to the dominant row bundle", async () => {
    const rows = [card("article", "/a/1", "1"), card("recipe", "/r/1", "2"), card("recipe", "/r/2", "3")].map((x) => `<div class="views-row">${x}</div>`).join("");
    const [c] = await collectionsOf({ "/front": listing("Home | Demo Magazine", null, "frontpage", "page_1", rows) });
    expect(c).toMatchObject({ name: "Home", type: "recipe" });
  });

  it("listingPageName keeps titles without a site-name suffix", () => {
    expect(listingPageName({ pageTitle: "News" })).toBe("News");
    expect(listingPageName({ title: "Home | Demo", siteName: "Demo" })).toBe("Home");
    expect(listingPageName({ title: "Home – Demo" })).toBe("Home");
    expect(listingPageName({ title: "A | B", siteName: "Other" })).toBe("A | B");
    expect(listingPageName({ title: "Demo", siteName: "Demo" })).toBeUndefined();
  });
});
