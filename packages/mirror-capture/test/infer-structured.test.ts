/**
 * W2-F generic pre-pass rules (theme-agnostic, synthetic markup): JSON data islands, repeated data items keyed by
 * data-* ids, variant / state / modifier classes, repeated BEM blocks as item roots, block-link labels, parent links.
 * Each rule: the coverage sees the gap (a DOCUMENT_TEXT_UNMAPPED issue, no text in it), the pre-pass closes it.
 */
import { describe, expect, it } from "vitest";
import { inferProfilesIterative, pageCoverageRatio, simulateCoverage, unmappedTextIssues } from "../src/infer.js";
import { ProfilePackSchema } from "../src/profiles.js";
import { coverageInputFor } from "../src/testing.js";

const BASE = "http://localhost:4499";
/** a node page holding paragraphs in an entity-reference-revisions field (Drupal core markup only) */
const page = (paragraphs: string) => `<!DOCTYPE html><html lang="en"><head><title>T</title></head>
<body class="path-node page-node-type-landing"><main id="main-content"><h1 class="page-title">T</h1>
<article class="node node--type-landing node--view-mode-full"><div class="field field--name-field-sections field--type-entity-reference-revisions field--label-hidden field--items">
${paragraphs
  .split("\u0001")
  .map((p) => `<div class="field--item">${p}</div>`)
  .join("\n")}
</div></article></main></body></html>`;
const input = (files: Record<string, string>) => coverageInputFor(files, BASE, BASE);
const sections = (ccm: { entries: { type: string; fields: Record<string, unknown> }[] }, type: string) => ccm.entries.filter((e) => e.type === type);

const GALLERY = `<div id="section-11" class="paragraph paragraph--type--filter-gallery">
  <h2 class="filter-gallery__title">Pick a flavour</h2>
  <ul class="filter-gallery__pills">
    <li><button class="filter-gallery__pill" type="button" data-category-id="c1" data-js-pill>Alpha flavours</button></li>
    <li><button class="filter-gallery__pill" type="button" data-category-id="c2" data-js-pill>Beta flavours</button></li>
  </ul>
  <div class="filter-gallery__group is-default" data-category-id="default">
    <button class="filter-gallery__tile" type="button" data-tile-id="10" data-position="1" aria-label="Open Alpha one"><img class="filter-gallery__tile-logo" src="/files/a1.png" alt=""></button>
    <button class="filter-gallery__tile" type="button" data-tile-id="11" data-position="2" aria-label="Open Alpha two"><img class="filter-gallery__tile-logo" src="/files/a2.png" alt=""></button>
  </div>
  <div class="filter-gallery__group" data-category-id="c2">
    <button class="filter-gallery__tile" type="button" data-tile-id="12" data-position="1" aria-label="Open Beta one"><img class="filter-gallery__tile-logo" src="/files/b1.png" alt=""></button>
  </div>
  <script type="application/json">{"tiles":{"10":{"label":"Alpha one detail","strapline":"Crunchy morning cereal"}}}</script>
</div>`;

describe("structured data: JSON islands + data items", () => {
  it("coverage reports them (structure only), the pre-pass maps them to json + nested list slots", async () => {
    const inp = input({ "/g": page(GALLERY) });
    const none = await simulateCoverage(inp, "none", undefined);
    const issues = unmappedTextIssues(none.analysis).filter((i) => i.message.startsWith("sectionFilterGallery"));
    expect(issues.map((i) => i.ref)).toEqual(expect.arrayContaining(["/g#filter_gallery/json:script", "/g#filter_gallery/data:.filter-gallery__pill", "/g#filter_gallery/data:.filter-gallery__group"]));
    for (const t of ["Alpha", "Beta", "Crunchy", "Open"]) expect(JSON.stringify(issues)).not.toContain(t);

    const pre = await inferProfilesIterative(inp, "none", undefined, { rounds: 3 });
    expect(ProfilePackSchema.safeParse(pre.pack).success).toBe(true);
    const slots = pre.pack.profiles?.filter_gallery?.slots ?? {};
    expect(slots.data).toEqual({ sel: "script[type='application/json']", kind: "json" });
    expect(slots.pills).toEqual({ sel: ".filter-gallery__pill", kind: "list", item: { categoryId: "@data-category-id", label: "text" } });
    expect(slots.groups).toEqual({
      sel: ".filter-gallery__group",
      kind: "list",
      item: { categoryId: "@data-category-id", default: "?is-default", tiles: { sel: ".filter-gallery__tile", item: { position: "#@data-position", tileId: "@data-tile-id", label: "@aria-label", logo: "img" } } },
    });
    expect(pageCoverageRatio(pre.analysis, ["/g"]).ratio).toBe(1);
    const [e] = sections(pre.ccm, "sectionFilterGallery");
    expect(e.fields.pills).toEqual([{ categoryId: "c1", label: "Alpha flavours" }, { categoryId: "c2", label: "Beta flavours" }]);
    expect((e.fields.groups as any[])[0]).toMatchObject({ categoryId: "default", default: true, tiles: [{ tileId: "10", position: 1, label: "Open Alpha one", logo: { kind: "asset" } }, { tileId: "11" }] });
    expect((e.fields.data as any).tiles["10"].strapline).toBe("Crunchy morning cereal");
  });

  it("ignores Drupal bookkeeping data attributes and non-repeated ids", async () => {
    const html = `<div id="section-12" class="paragraph paragraph--type--note" data-history-node-id="5"><p class="note__text">Hello there friends</p>
      <div class="note__a" data-quickedit-entity-id="node/1">x</div><div class="note__a" data-quickedit-entity-id="node/2">y</div><span class="note__one" data-item-id="9">only one</span></div>`;
    const none = await simulateCoverage(input({ "/n": page(html) }), "none", undefined);
    expect(unmappedTextIssues(none.analysis).filter((i) => /data item/.test(i.message))).toEqual([]);
  });
});

const BUTTONS = [
  `<div id="section-21" class="paragraph paragraph--type--cta-button btn-style-primary is-active"><a class="cta-button__link" href="/a">Go A</a></div>`,
  `<div id="section-22" class="paragraph paragraph--type--cta-button btn-style-secondary"><a class="cta-button__link" href="/b">Go B</a></div>`,
  `<div id="section-23" class="paragraph paragraph--type--banner tone--dark"><div class="banner banner--wide"><h2 class="banner__title">Big news today</h2></div></div>`,
  `<div id="section-24" class="paragraph paragraph--type--card card card--red card--plain"><h3 class="card__title">Card one here</h3></div>`,
  `<div id="section-25" class="paragraph paragraph--type--card card card--blue card--tall"><h3 class="card__title">Card two here</h3></div>`,
].join("\u0001");

describe("class-derived values", () => {
  it("variant classes → class fields, varying state classes → flags, BEM-modified elements → classes slots", async () => {
    const inp = input({ "/b": page(BUTTONS) });
    const none = await simulateCoverage(inp, "none", undefined);
    const msgs = unmappedTextIssues(none.analysis).map((i) => i.message);
    expect(msgs.some((m) => /variant class btn-style-\* on the root \(proposed field btnStyle\)/.test(m))).toBe(true);
    expect(msgs.some((m) => /state class is-active on some roots \(proposed field active\)/.test(m))).toBe(true);
    expect(msgs.some((m) => /modifier classes of \.banner \(proposed field bannerClasses\)/.test(m))).toBe(true);
    // several modifiers of one family on a root (`card--red card--plain`) are a set, not one value
    expect(msgs.some((m) => /variant class card--/.test(m))).toBe(false);

    const pre = await inferProfilesIterative(inp, "none", undefined, { rounds: 3 });
    expect(pre.pack.classFields).toEqual(expect.arrayContaining([{ re: "^btn-style-(.+)$", field: "btnStyle" }, { re: "^tone--(.+)$", field: "tone" }]));
    expect(pre.pack.profiles?.cta_button?.flags).toEqual({ active: "is-active" });
    expect(pre.pack.profiles?.banner?.slots?.bannerClasses).toEqual({ sel: ".banner", kind: "classes" });
    const btn = sections(pre.ccm, "sectionCtaButton");
    expect(btn.map((e) => [e.fields.btnStyle, e.fields.active])).toEqual([["primary", true], ["secondary", false]]);
    expect(sections(pre.ccm, "sectionBanner")[0].fields).toMatchObject({ tone: "dark", bannerClasses: "banner banner--wide" });
    expect(pageCoverageRatio(pre.analysis, ["/b"]).ratio).toBe(1);
  });
});

const FILES = `<div id="section-31" class="paragraph paragraph--type--file-list"><h2 class="file-list__title">Reports and files</h2>
  <div class="file-item"><a class="file-item__link" href="/files/one.pdf"><div class="file-item__image"><img src="/files/one.png" alt=""></div><h3 class="file-item__name">Annual one</h3><span class="file-item__size">2 MB</span><span class="file-item__cta">Download</span></a></div>
  <div class="file-item"><a class="file-item__link" href="/files/two.pdf"><div class="file-item__image"><img src="/files/two.png" alt=""></div><h3 class="file-item__name">Annual two</h3><span class="file-item__size">3 MB</span><span class="file-item__cta">Download</span></a></div>
</div>`;
const TEASERS = [
  `<a href="/story-one"><div id="section-41" class="paragraph paragraph--type--teaser"><h3 class="teaser__title">Story one title</h3><p class="teaser__body">Some teaser body text</p><span class="teaser__more">Read more</span></div></a>`,
  `<a href="/story-two"><div id="section-42" class="paragraph paragraph--type--teaser"><h3 class="teaser__title">Story two title</h3><p class="teaser__body">Other teaser body text</p><span class="teaser__more">Read more</span></div></a>`,
].join("\u0001");

describe("items and links", () => {
  it("repeated BEM blocks inside a paragraph become item entity roots; block links get their short label", async () => {
    const inp = input({ "/f": page(FILES) });
    const pre = await inferProfilesIterative(inp, "none", undefined, { rounds: 3 });
    expect(pre.pack.entityRoots).toEqual([{ sel: ".file-item", type: "file_item", entity: "item" }]);
    const items = sections(pre.ccm, "sectionFileItem");
    expect(items).toHaveLength(2);
    const link = Object.entries(items[0].fields).find(([, v]) => (v as any)?.href);
    expect(link?.[1]).toEqual({ href: "/files/one.pdf", label: "Download" });
    expect(pageCoverageRatio(pre.analysis, ["/f"]).ratio).toBe(1);
  });

  it("the anchor wrapping a whole paragraph becomes a parentLink slot with the label element", async () => {
    const inp = input({ "/t": page(TEASERS) });
    const none = await simulateCoverage(inp, "none", undefined);
    expect(unmappedTextIssues(none.analysis).map((i) => i.ref)).toContain("/t#teaser/parentLink");
    const pre = await inferProfilesIterative(inp, "none", undefined, { rounds: 3 });
    expect(pre.pack.profiles?.teaser?.slots?.link).toEqual({ sel: "a", kind: "link", parentLink: true, labelSel: ".teaser__more" });
    expect(sections(pre.ccm, "sectionTeaser").map((e) => e.fields.link)).toEqual([{ href: "/story-one", label: "Read more" }, { href: "/story-two", label: "Read more" }]);
    expect(pageCoverageRatio(pre.analysis, ["/t"]).ratio).toBe(1);
  });
});

describe("varying class lists", () => {
  it("a BEM element whose classes differ between instances of a type gets a classes slot", async () => {
    const block = (id: number, tone: string) => `<div id="section-${id}" class="paragraph paragraph--type--split-block"><div class="split-block__text ${tone}"><h2 class="split-block__title">Title number ${id}</h2></div></div>`;
    const inp = input({ "/s": page([block(51, "bg-orange"), block(52, "bg-green")].join("\u0001")) });
    const pre = await inferProfilesIterative(inp, "none", undefined, { rounds: 3 });
    expect(pre.pack.profiles?.split_block?.slots?.textClasses).toEqual({ sel: ".split-block__text", kind: "classes" });
    expect(sections(pre.ccm, "sectionSplitBlock").map((e) => e.fields.textClasses)).toEqual(["split-block__text bg-orange", "split-block__text bg-green"]);
    // identical class lists everywhere: no slot
    const same = await inferProfilesIterative(input({ "/s": page([block(51, "bg-orange"), block(52, "bg-orange")].join("\u0001")) }), "none", undefined, { rounds: 3 });
    expect(same.pack.profiles?.split_block?.slots?.textClasses).toBeUndefined();
  });
});

describe("labels and line breaks", () => {
  it("the label element of a block link is named <x>Label; text with <br> becomes richText", async () => {
    const card = (id: number) => `<div id="section-${id}" class="paragraph paragraph--type--promo"><a class="promo__link" href="/p${id}"><h3 class="promo__title">Promo title ${id}</h3><div class="promo__body">First line of ${id}<br><br>Second line of ${id}</div><span class="promo__more">Learn more</span></a></div>`;
    const pre = await inferProfilesIterative(input({ "/p": page([card(61), card(62)].join("\u0001")) }), "none", undefined, { rounds: 3 });
    const slots = pre.pack.profiles?.promo?.slots ?? {};
    expect(slots.moreLabel).toBe(".promo__more");
    expect(slots.body).toEqual({ sel: ".promo__body", kind: "richText" });
    const link = Object.values(slots).find((x) => typeof x !== "string" && x?.kind === "link");
    expect(link).toMatchObject({ sel: "a.promo__link", labelSel: ".promo__more" });
    const [e] = sections(pre.ccm, "sectionPromo");
    expect(Object.values(e.fields)).toContainEqual({ href: "/p61", label: "Learn more" });
    expect(JSON.stringify(e.fields.body)).toContain('"type":"break"');
  });
});
