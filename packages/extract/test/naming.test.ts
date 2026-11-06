// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import type { SceneComponentDef, SceneDesignSystem, SceneElement } from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import { DATA_GUARD_RULE, DATA_TAG } from "@harness/scene";
import {
  badComponentName,
  badPropName,
  catalogForModel,
  foldWords,
  isBuiltInName,
  lookOf,
  namingCatalog,
  namingLint,
  namingMessages,
  propLabel,
  retryMessages,
  semanticNameIssue,
  transliterate,
  usageContexts,
  validateNaming,
  type NamingEntry,
} from "@harness/extract";
import { componentApi } from "@harness/extract";
import { properTokens } from "@harness/extract";

const card = (id: string, title: string): SceneElement => ({
  id,
  type: "frame",
  name: "Teaser · Tickets",
  meta: { tag: "a" },
  interaction: { onTap: "open-url", url: "https://www.bvg.de/de/abos-und-tickets" },
  layout: { direction: "column", gap: 8, width: 300 },
  children: [
    { id: `${id}-img`, type: "image", image: { src: "a.jpg" }, layout: { width: 300, height: 160 } },
    { id: `${id}-t`, type: "text", text: title, style: { fontSize: 22 } },
    {
      id: `${id}-d`,
      type: "text",
      text: "Alle Tickets und Abos im Überblick, mit Preisen und Tarifen.",
      style: { fontSize: 15 },
    },
    {
      id: `${id}-b`,
      type: "button",
      instance: { componentId: "btn" },
      children: [{ id: `${id}-bl`, type: "text", text: "Mehr erfahren" }],
    },
  ],
});
const SETS: SceneComponentDef[] = [
  {
    id: "btn",
    name: "Button / Outline light",
    kind: "button",
    defaultVariant: "default",
    properties: [{ name: "Label", type: "text", default: "Mehr erfahren", target: "bl" }],
    variants: {
      default: { id: "b", type: "button", children: [{ id: "bl", type: "text", text: "Mehr erfahren" }] },
    },
  },
  {
    id: "btn2",
    name: "Button / Outline light 2",
    kind: "button",
    defaultVariant: "default",
    variants: { default: { id: "b2", type: "button", text: "M17" } },
  },
  {
    id: "teaser",
    name: "Teaser / vertical",
    kind: "teaser",
    defaultVariant: "breakpoint=sm",
    variantAxes: { breakpoint: ["sm", "lg"] },
    properties: [{ name: "Title", type: "text", default: "Tickets", target: "c-t" }],
    variants: { "breakpoint=sm": card("c", "Tickets"), "breakpoint=lg": card("c", "Tickets") },
  },
  {
    id: "footer",
    name: "Footer",
    kind: "footer",
    defaultVariant: "default",
    variants: {
      default: {
        id: "f",
        type: "frame",
        meta: { tag: "footer" },
        children: [{ id: "f1", type: "text", text: "Impressum" }],
      },
    },
  },
];
const DS: SceneDesignSystem = { version: 1, name: "BVG", tokens: { ...DEFAULT_TOKENS }, componentSets: SETS };
const entries = () => namingCatalog(DS, ["btn", "btn2", "teaser", "footer"], { instances: { teaser: 6 } });
const entry = (id: string): NamingEntry => entries().find((e) => e.id === id)!;

describe("naming catalog", () => {
  it("describes each set compactly: structure, kind, breakpoints, copy (read-only), renameable props", () => {
    const t = entry("teaser");
    expect(t).toMatchObject({
      name: "Teaser / vertical",
      kind: "teaser",
      category: "content",
      breakpoints: ["sm", "lg"],
      layer: "Teaser",
      instances: 6,
      links: ["/de/abos-und-tickets"],
      contains: ["Button / Outline light"],
    });
    expect(t.structure).toBe("a[image, text×2, <Button / Outline light>]");
    expect(t.texts).toEqual([
      "Tickets",
      "Alle Tickets und Abos im Überblick, mit Preisen und Tarifen.",
      "Mehr erfahren",
    ]);
    // the property first, then the content slots componentApi exposes (the built-in names: the description is a
    // second "title"); the breakpoint axis is not renamed
    expect(t.props.map((p) => [p.id, p.name, p.type, p.ref.kind])).toEqual([
      ["p1", "title", "text", "property"],
      ["p2", "subtitle", "text", "slot"],
      ["p3", "image", "image", "slot"],
    ]);
    expect(t.fixedProps).toEqual(["breakpoint"]);
    expect(entry("btn").usedIn).toEqual(["Teaser / vertical"]);
  });

  it("sends the model ids, names and props without internal refs, wrapped as data under the guard rule", () => {
    const model = catalogForModel(entries());
    expect(JSON.stringify(model)).not.toContain('"ref"');
    expect(model[2]!.props).toEqual([
      { id: "p1", name: "title", type: "text" },
      { id: "p2", name: "subtitle", type: "text" },
      { id: "p3", name: "image", type: "image" },
    ]);
    const [system, user] = namingMessages(DS, entries(), { site: "bvg.de", others: ["Header"] });
    expect(system!.content).toContain(DATA_GUARD_RULE);
    expect(system!.content).toMatch(/never translate, rewrite or return them/);
    expect(user!.content).toContain("Website: bvg.de · BVG");
    expect(user!.content).toContain(`<${DATA_TAG} source="component catalog">`);
    expect(user!.content).toContain('"name":"Teaser / vertical"');
  });
});

describe("naming checks", () => {
  it("accepts semantic PascalCase / camelCase identifiers only", () => {
    expect(badComponentName("HeroTeaser")).toBeNull();
    expect(badComponentName("heroTeaser")).toMatch(/PascalCase/);
    expect(badComponentName("Hero Teaser")).toMatch(/PascalCase/);
    expect(badComponentName("Button2")).toMatch(/number/);
    expect(badComponentName("Component")).toBe("reserved");
    expect(badComponentName("SBahnTeaser")).toMatch(/export name/);
    expect(badComponentName("VeryLongNameWithManyWordsInIt")).toBe("too long");
    expect(badPropName("imageSrc")).toBeNull();
    expect(badPropName("class")).toBe("reserved");
    expect(badPropName("onClick")).toBe("reserved");
    expect(badPropName("imageURL")).toMatch(/acronym/);
    expect(badPropName("Title")).toMatch(/camelCase/);
    // a prop label componentApi spells back to the same name
    expect(propLabel("imageSrc")).toBe("Image src");
    expect(
      componentApi(
        {
          ...SETS[0]!,
          properties: [{ name: propLabel("ctaLabel"), type: "text", default: "", target: "bl" }],
        },
        DS,
      )[0]!.name,
    ).toBe("ctaLabel");
    // a named content slot keeps its name in the API (what the exports use)
    expect(
      componentApi({ ...SETS[2]!, propNames: { "c-d:text": "Summary", "c-img:image": "Image src" } }, DS, {
        slots: true,
      }).map((p) => p.name),
    ).toEqual(["breakpoint", "title", "summary", "imageSrc"]);
  });

  it("keeps what holds up: valid unique names, known categories, props renamed one for one; left-out sets keep their names", () => {
    const plan = validateNaming(DS, entries(), {
      components: [
        {
          id: "btn",
          name: "SecondaryButton",
          category: "forms",
          props: [{ id: "p1", name: "label", type: "text" }],
        },
        { id: "btn2", name: "LineBadge", category: "feedback" },
        {
          id: "teaser",
          name: "TicketTeaser",
          category: "nonsense",
          props: [
            { id: "p1", name: "title", type: "text" },
            { id: "p2", name: "summary", type: "text" },
            { id: "p3", name: "imageSrc", type: "image" },
          ],
        },
        { id: "ghost", name: "Ghost" },
      ],
      order: ["btn2", "teaser", "btn", "ghost"],
    });
    expect(plan.sets).toEqual([
      { id: "btn", from: "Button / Outline light", name: "SecondaryButton", props: [] },
      { id: "btn2", from: "Button / Outline light 2", name: "LineBadge", category: "feedback", props: [] },
      {
        id: "teaser",
        from: "Teaser / vertical",
        name: "TicketTeaser",
        props: [
          { ref: { kind: "slot", target: "c-d", field: "text" }, from: "subtitle", to: "summary" },
          { ref: { kind: "slot", target: "c-img", field: "image" }, from: "image", to: "imageSrc" },
        ],
      },
    ]);
    // footer: left out → keeps "Footer"; the unknown id is reported
    expect(plan.rejected).toEqual(["ghost: unknown component"]);
    // the order, grouped by category: content, forms, feedback
    expect(plan.order).toEqual(["teaser", "btn", "btn2"]);
  });

  it("rejects bad names, duplicates and props that are added, dropped or retyped", () => {
    const plan = validateNaming(DS, entries(), {
      components: [
        { id: "btn", name: "Button2" },
        { id: "btn2", name: "Footer" }, // a footer's noun for a button
        {
          id: "teaser",
          name: "NewsCard",
          props: [
            { id: "p1", name: "title" },
            { id: "p2", name: "text" },
          ],
        },
        { id: "footer", name: "NewsCard" }, // a card's noun for a footer (and a second proposal of one name)
      ],
    });
    expect(plan.sets).toEqual([{ id: "teaser", from: "Teaser / vertical", name: "NewsCard", props: [] }]);
    expect(plan.rejected).toEqual([
      "Button / Outline light → Button2: ends in a number",
      "Button / Outline light 2 → Footer: names a footer for a button",
      "Teaser / vertical props: 2 props for 3",
      "Footer → NewsCard: names a card for a footer",
    ]);
    // a name proposed twice: the first in catalog order keeps it
    const taken = validateNaming(DS, entries(), {
      components: [
        { id: "btn", name: "PrimaryButton" },
        { id: "btn2", name: "PrimaryButton" },
        { id: "teaser", name: "Footer" },
      ],
    });
    expect(taken.sets).toEqual([
      { id: "btn", from: "Button / Outline light", name: "PrimaryButton", props: [] },
    ]);
    expect(taken.rejected).toEqual([
      "Teaser / vertical → Footer: names a footer for a teaser",
      "Button / Outline light 2 → PrimaryButton: not unique",
    ]);
    const typed = validateNaming(DS, entries(), {
      components: [
        {
          id: "teaser",
          props: [
            { id: "p1", name: "title", type: "text" },
            { id: "p2", name: "summary", type: "image" },
            { id: "p3", name: "imageSrc" },
          ],
        },
      ],
    });
    expect(typed.sets).toEqual([]);
    expect(typed.rejected).toEqual(["Teaser / vertical props: subtitle changes type to image"]);
    const dup = validateNaming(DS, entries(), {
      components: [
        {
          id: "teaser",
          props: [
            { id: "p1", name: "title" },
            { id: "p2", name: "title" },
            { id: "p3", name: "class" },
          ],
        },
      ],
    });
    // a name that does not hold up keeps the prop's old name; the other renames stay
    expect(dup.rejected).toEqual([
      "Teaser / vertical prop image → class: reserved",
      "Teaser / vertical prop subtitle → title: twice",
    ]);
    expect(dup.sets).toEqual([]);
    const reserved = validateNaming(DS, entries(), {
      components: [
        {
          id: "teaser",
          props: [
            { id: "p1", name: "heading" },
            { id: "p2", name: "breakpoint" },
            { id: "p3", name: "class" },
          ],
        },
      ],
    });
    expect(reserved.rejected).toEqual([
      "Teaser / vertical prop image → class: reserved",
      "Teaser / vertical prop subtitle → breakpoint: twice",
    ]);
    expect(reserved.sets).toEqual([
      {
        id: "teaser",
        from: "Teaser / vertical",
        props: [{ ref: { kind: "property", property: "Title" }, from: "title", to: "heading" }],
      },
    ]);
    // numbered props and filler suffixes are no names
    const numbered = validateNaming(DS, entries(), {
      components: [
        {
          id: "teaser",
          name: "TeaserAlt",
          props: [
            { id: "p1", name: "title1" },
            { id: "p2", name: "summary" },
            { id: "p3", name: "imageSrc" },
          ],
        },
      ],
    });
    expect(numbered.rejected).toEqual([
      "Teaser / vertical → TeaserAlt: a filler suffix instead of what differs",
      "Teaser / vertical prop title → title1: ends in a number",
    ]);
    expect(numbered.sets[0]!.props.map((p) => p.to)).toEqual(["summary", "imageSrc"]);
    expect(validateNaming(DS, entries(), { components: "nope" } as never).rejected).toEqual([
      "answer has no components list",
    ]);
    expect(validateNaming(DS, entries(), null).sets).toEqual([]);
  });

  it("leaves a set alone whose name changed while the model was thinking", () => {
    const later: SceneDesignSystem = {
      ...DS,
      componentSets: SETS.map((d) => (d.id === "btn" ? { ...d, name: "My button" } : d)),
    };
    const plan = validateNaming(later, entries(), { components: [{ id: "btn", name: "SecondaryButton" }] });
    expect(plan.sets).toEqual([]);
    expect(plan.rejected).toEqual(["Button / Outline light: renamed meanwhile"]);
  });
});

describe("naming context", () => {
  it("says where instances sit (the control around them, the copy next to them) and how a set looks", () => {
    const page: SceneElement = {
      id: "r",
      type: "frame",
      children: [
        {
          id: "b",
          type: "button",
          name: "Button · Details zur Störung",
          interaction: { onTap: "open-url", url: "https://www.bvg.de/de/stoerung" },
          children: [{ id: "i", type: "icon", instance: { componentId: "info" } }],
        },
        {
          id: "row",
          type: "frame",
          children: [
            { id: "i2", type: "icon", instance: { componentId: "home" } },
            { id: "t", type: "text", text: "Startseite" },
          ],
        },
      ],
    };
    expect(usageContexts([page])).toEqual({
      info: ["button “Details zur Störung” → /de/stoerung"],
      home: ["next to “Startseite”"],
    });
    expect(
      lookOf({
        id: "x",
        type: "button",
        layout: { width: 36.08, height: 19 },
        style: { border: { width: 1, color: "rgb(225, 225, 225)" } },
        children: [{ id: "l", type: "text", text: "M17", style: { fontSize: 16, color: "rgb(37, 37, 37)" } }],
      }),
    ).toBe("36×19 · outline #e1e1e1 · 16px #252525 text");
    const withCtx = namingCatalog(DS, ["btn"], {
      contexts: { btn: ["link “Tickets”"] },
      glyphs: { btn: "arrow right" },
    })[0]!;
    expect(catalogForModel([withCtx])[0]).toMatchObject({ uses: ["link “Tickets”"], glyph: "arrow right" });
  });

  it("checks a second round against the names other sets get in the same run", () => {
    const plan = validateNaming(
      DS,
      entries(),
      { components: [{ id: "btn2", name: "LineBadge" }] },
      new Map([["btn", "LineBadge"]]),
    );
    expect(plan.rejected).toEqual(["Button / Outline light 2 → LineBadge: not unique"]);
    const msgs = retryMessages(
      DS,
      [entry("btn2")],
      ["Button / Outline light 2 → LineBadge: not unique"],
      ["LineBadge", "Footer"],
      "bvg.de",
    );
    expect(msgs[1]!.content).toContain("Names in use: LineBadge, Footer");
    expect(msgs[1]!.content).toContain('"rejected":"LineBadge: not unique"');
  });
});

describe("semantic lint", () => {
  // an ibm.com-like capture: sections named after their heading copy and Carbon's "cds--" classes
  const section = (id: string, heading: string, layer: string): SceneComponentDef => ({
    id,
    name: `Section / ${heading}`,
    kind: "section",
    defaultVariant: "default",
    variants: {
      default: {
        id: `${id}-r`,
        type: "frame",
        name: layer,
        children: [
          { id: `${id}-h`, type: "text", text: heading, meta: { tag: "h2" } },
          {
            id: `${id}-c`,
            type: "frame",
            name: "Cds card content",
            children: [{ id: `${id}-t`, type: "text", text: "4,5 Milliarden USD Umsatz im Quartal" }],
          },
        ],
      },
    },
  });
  const LDS: SceneDesignSystem = {
    version: 1,
    name: "IBM",
    tokens: { ...DEFAULT_TOKENS },
    componentSets: [
      section("s1", "Schulungen für die Zukunft", "Cds layout"),
      section("s2", "Neues aus der Forschung", "Cds grid"),
      {
        id: "b",
        name: "Button / primary",
        kind: "button",
        defaultVariant: "default",
        variants: {
          default: {
            id: "b-r",
            type: "button",
            name: "Cds btn",
            children: [{ id: "b-t", type: "text", text: "Mehr erfahren" }],
          },
        },
      },
    ],
  };
  const page: SceneElement = {
    id: "p",
    type: "frame",
    children: [{ id: "p1", type: "text", text: "Hybrid Cloud und künstliche Intelligenz für Unternehmen" }],
  };
  const lint = namingLint(LDS, [page]);
  const le = namingCatalog(LDS, ["s1", "s2", "b"]);

  it("folds copy and names alike: umlauts, accents, PascalCase", () => {
    expect(transliterate("Schulungen für die Zukunft · Straße · Café")).toBe(
      "Schulungen fuer die Zukunft   Strasse   Cafe",
    );
    expect(foldWords("SchulungenFuerDieZukunft")).toEqual(foldWords("Schulungen für die Zukunft"));
    expect(foldWords("SchulungenFurDieZukunft")).toEqual(["schulungen", "fur", "die", "zukunft"]);
    expect(isBuiltInName("Card / with image 2")).toBe(true);
    expect(isBuiltInName("Icon 17")).toBe(true);
    expect(isBuiltInName("NewsCard")).toBe(false);
  });

  it("rejects page copy of three words or more, CSS-class tokens and another kind's head noun", () => {
    const s1 = le.find((e) => e.id === "s1")!;
    expect(semanticNameIssue("SchulungenFuerDieZukunft", s1, lint)).toMatch(/^captured page copy/);
    expect(semanticNameIssue("SchulungenFurDieZukunftSection", s1, lint)).toMatch(/^captured page copy/);
    // copy anywhere on the pages, not only the set's own
    expect(semanticNameIssue("KuenstlicheIntelligenzFuerUnternehmenSection", s1, lint)).toMatch(
      /^captured page copy/,
    );
    // a noun of the copy (capitalised mid-sentence, never lower case) is the copy's, not what the section is
    expect(semanticNameIssue("ZukunftSection", s1, lint)).toMatch(
      /^a product, brand or event of the copy \(“zukunft”\)/,
    );
    expect(semanticNameIssue("CdsCardContent", s1, lint)).toBe("a CSS class token (“cds”)");
    expect(semanticNameIssue("SwiperGallery", s1, lint)).toMatch(/CSS class/);
    expect(semanticNameIssue("TrainingTeaserCard", s1, lint)).toBe("names a card for a section");
    expect(semanticNameIssue("TrainingIcon", s1, lint)).toBe("names an icon for a section");
    expect(
      semanticNameIssue(
        "PrimarySection",
        le.find((e) => e.id === "b")!,
        lint,
      ),
    ).toBe("names a section for a button");
    expect(semanticNameIssue("TrainingSection", s1, lint)).toBeNull();
    expect(
      semanticNameIssue(
        "PrimaryButton",
        le.find((e) => e.id === "b")!,
        lint,
      ),
    ).toBeNull();
  });

  it("feeds the lint into validateNaming: rejected names go to the retry round with the reason", () => {
    const plan = validateNaming(
      LDS,
      le,
      {
        components: [
          { id: "s1", name: "SchulungenFuerDieZukunft" },
          { id: "s2", name: "CdsGridSection" },
          { id: "b", name: "PrimaryButton" },
        ],
      },
      new Map(),
      lint,
    );
    expect(plan.sets.map((x) => [x.id, x.name])).toEqual([["b", "PrimaryButton"]]);
    expect(plan.rejected).toEqual([
      "Section / Schulungen für die Zukunft → SchulungenFuerDieZukunft: captured page copy (“schulungen fur die”)",
      "Section / Neues aus der Forschung → CdsGridSection: a CSS class token (“cds”)",
    ]);
    // without a lint context, the system's own copy and layer names are used
    expect(
      validateNaming(LDS, le, { components: [{ id: "s1", name: "SchulungenFuerDieZukunft" }] }).rejected[0],
    ).toMatch(/captured page copy/);
    const msgs = retryMessages(LDS, [le[1]!], plan.rejected, ["PrimaryButton"], "ibm.com");
    expect(msgs[1]!.content).toContain('"rejected":"CdsGridSection: a CSS class token (“cds”)"');
  });
});

describe("list items in the catalog", () => {
  const tile = (i: number): SceneElement => ({
    id: `c${i}`,
    type: "frame",
    name: "Card",
    layout: { direction: "column", gap: 8, width: 300 },
    style: { radius: 8, background: "#fff" },
    children: [
      { id: `c${i}-img`, type: "image", image: { src: `${i}.jpg` }, layout: { width: 300, height: 160 } },
      { id: `c${i}-t`, type: "text", text: `Titel ${i}`, style: { fontSize: 22 } },
      { id: `c${i}-d`, type: "text", text: `Beschreibung Nummer ${i} lang genug`, style: { fontSize: 15 } },
    ],
  });
  const grid: SceneComponentDef = {
    id: "grid",
    name: "Section / Card grid",
    kind: "section",
    defaultVariant: "default",
    variants: {
      default: {
        id: "r",
        type: "frame",
        layout: { direction: "column" },
        children: [
          { id: "h", type: "text", text: "Angebote", style: { fontSize: 32 }, meta: { tag: "h2" } },
          {
            id: "row",
            type: "frame",
            layout: { direction: "row", gap: 16 },
            children: [tile(1), tile(2), tile(3)],
          },
        ],
      },
    },
  };
  const GDS: SceneDesignSystem = {
    version: 1,
    name: "X",
    tokens: { ...DEFAULT_TOKENS },
    componentSets: [grid],
  };

  it("sends one prop per item field (the first item stands for all), and applies its name to every item", () => {
    const [e] = namingCatalog(GDS, ["grid"], { maxProps: 4 });
    // the section's own title, then the cards' fields once each: not cards[1…2], and they do not use up maxProps
    expect(e!.props.map((p) => [p.id, p.name, p.item?.list ?? null])).toEqual([
      ["p1", "title", null],
      ["p2", "title", "cards"],
      ["p3", "subtitle", "cards"],
      ["p4", "image", "cards"],
    ]);
    expect(e!.fixedProps).toEqual([]);
    expect(catalogForModel([e!])[0]!.props[1]).toEqual({
      id: "p2",
      name: "title",
      type: "text",
      item: "cards",
    });
    // "title" is the section's own and a card field: different lists, no clash
    const plan = validateNaming(GDS, [e!], {
      components: [
        {
          id: "grid",
          name: "OfferGrid",
          props: [
            { id: "p1", name: "title" },
            { id: "p2", name: "title" },
            { id: "p3", name: "summary" },
            { id: "p4", name: "imageSrc" },
          ],
        },
      ],
    });
    expect(plan.rejected).toEqual([]);
    const props = plan.sets[0]!.props;
    expect(props.filter((p) => p.to === "summary").map((p) => p.ref)).toEqual(
      [1, 2, 3].map((i) => ({ kind: "slot", target: `c${i}-d`, field: "text" })),
    );
    expect(props.filter((p) => p.to === "imageSrc")).toHaveLength(3);
    // two fields of one list may not share a name
    const twice = validateNaming(GDS, [e!], {
      components: [
        {
          id: "grid",
          props: [
            { id: "p1", name: "title" },
            { id: "p2", name: "title" },
            { id: "p3", name: "title" },
            { id: "p4", name: "image" },
          ],
        },
      ],
    });
    expect(twice.rejected).toEqual(["Section / Card grid prop subtitle → title: twice"]);
  });
});

describe("sets that share a built-in name (extraction nameClash) and unique sections", () => {
  const tile = (
    id: string,
    w: number,
    extraction: Record<string, unknown>,
    name: string,
  ): SceneComponentDef =>
    ({
      id,
      name,
      kind: "card",
      defaultVariant: "default",
      extraction,
      variants: {
        default: {
          id: `${id}-r`,
          type: "frame",
          layout: { width: w, height: 200 },
          children: [{ id: `${id}-i`, type: "image", image: { src: `${id}.jpg` } }],
        },
      },
    }) as SceneComponentDef;
  const CDS: SceneDesignSystem = {
    version: 1,
    name: "X",
    tokens: { ...DEFAULT_TOKENS },
    componentSets: [
      tile("c1", 300, { nameClash: "Card / with image" }, "Card / with image"),
      tile("c2", 200, { nameClash: "Card / with image" }, "Card / with image 2"),
      tile("c3", 100, { nameClash: "Card / with image" }, "Card / with image 3"),
      {
        id: "s",
        name: "Section / Stats",
        kind: "section",
        defaultVariant: "default",
        extraction: { single: true, nearest: 0.4 },
        variants: { default: { id: "s-r", type: "frame" } },
      } as SceneComponentDef,
    ],
  };
  const ce = () => namingCatalog(CDS, ["c1", "c2", "c3", "s"]);

  it("tells the model which sets must get distinct names and which section is unique", () => {
    const model = catalogForModel(ce());
    expect(
      model.map((m) => [
        m.id,
        (m as { nameClash?: string }).nameClash ?? null,
        (m as { single?: boolean }).single ?? null,
      ]),
    ).toEqual([
      ["c1", "Card / with image", null],
      ["c2", "Card / with image", null],
      ["c3", "Card / with image", null],
      ["s", null, true],
    ]);
    expect(namingMessages(CDS, ce())[0]!.content).toMatch(/same nameClash .* never numbers/);
  });

  it("rejects a plan that leaves a clash group on one base name or numbered names", () => {
    // the same base name for two of them (one a pending name from another batch), the third left out
    const plan = validateNaming(
      CDS,
      ce(),
      { components: [{ id: "c1", name: "PhotoCard" }] },
      new Map([["c2", "PhotoCard"]]),
    );
    expect(plan.sets).toEqual([]);
    expect(plan.rejected).toEqual([
      "Card / with image → PhotoCard: not unique",
      "Card / with image: still on the built-in name it shares with 2 other sets (“Card / with image”)",
      "Card / with image 3: still on the built-in name it shares with 2 other sets (“Card / with image”)",
    ]);
    // distinct semantic names for all three: accepted
    const ok = validateNaming(CDS, ce(), {
      components: [
        { id: "c1", name: "WideOfferCard" },
        { id: "c2", name: "OfferCard" },
        { id: "c3", name: "ThumbnailCard" },
      ],
    });
    expect(ok.rejected).toEqual([]);
    expect(ok.sets.map((x) => x.name)).toEqual(["WideOfferCard", "OfferCard", "ThumbnailCard"]);
    // a number is never a way out
    expect(
      validateNaming(CDS, ce(), {
        components: [
          { id: "c1", name: "OfferCard" },
          { id: "c2", name: "OfferCard2" },
          { id: "c3", name: "ThumbnailCard" },
        ],
      }).rejected,
    ).toEqual([
      "Card / with image 2 → OfferCard2: ends in a number",
      "Card / with image 2: still on the built-in name it shares with 2 other sets (“Card / with image”)",
    ]);
  });
});

describe("products, brands and events of the copy", () => {
  // ibm.com: alike card sections, each about one product, customer or event
  const copy = [
    "Wie Trivago mit IBM Cloud schneller wird",
    "Learn how Citadelle modernised its claims with watsonx Orchestrate.",
    "Maximo Application Suite",
    "Run Confluent on IBM Z and keep your data streaming.",
    "Join our November Webinar on Planning Analytics.",
    "IBM FlashSystem 5300 brings flash storage to every data center.",
    "Sign up for the Newsletter",
    "Search",
    "Case Study",
    "Read the case study",
    "Discover our products and services.",
    "Footer links",
  ];
  const page: SceneElement = {
    id: "p",
    type: "frame",
    children: copy.map((text, i) => ({ id: `t${i}`, type: "text", text })),
  };
  const IDS: SceneDesignSystem = {
    version: 1,
    name: "IBM",
    tokens: { ...DEFAULT_TOKENS },
    componentSets: [],
  };
  const lint = namingLint(IDS, [page]);
  const sec = { kind: "section" as const, texts: [] };

  it("learns them from the text statistics: capitalised mid-sentence, inner capitals or capitals, never lower case", () => {
    const p = properTokens(copy);
    for (const w of [
      "trivago",
      "citadelle",
      "confluent",
      "november",
      "flashsystem",
      "ibm",
      "orchestrate",
      "analytics",
    ])
      expect(p.has(foldWords(w).join("")), w).toBe(true);
    // common words stay usable, also when the copy capitalises them; a word the copy also writes in lower case is no name
    for (const w of ["newsletter", "search", "case", "study", "webinar", "cloud", "products", "data"])
      expect(p.has(foldWords(w).join("")), w).toBe(false);
  });

  it("in copy that is not English, any of its words that is not a common one: lower-case brands, dates", () => {
    const de = [
      "Erfahren Sie, wie trivago\nTeams mit einer Plattform der generativen KI unterstützt, die mehrere Anbieter integriert",
      "watsonx Orchestrate unterstützt KI-Agenten, die die Personalkosten um 40 % senken und 94 % der Mitarbeiteranfragen automatisch bearbeiten",
      "Webinar | 12. November",
      "Melden Sie sich für den Newsletter an und erhalten Sie die neuesten Nachrichten zu unseren Produkten und Lösungen",
      "Fallstudie",
      "Suche",
      "Kontakt",
      "Mehr erfahren über unsere Beratung und Services für Ihr Unternehmen in der Zukunft",
    ];
    const p = properTokens(de);
    for (const w of ["trivago", "watsonx", "november", "teams", "zukunft"])
      expect(p.has(foldWords(w).join("")), w).toBe(true);
    for (const w of ["newsletter", "webinar", "services"])
      expect(p.has(foldWords(w).join("")), w).toBe(false);
    const dl: typeof lint = { copy: new Set(), classTokens: new Set(), proper: p };
    expect(semanticNameIssue("TrivagoCaseStudySection", sec, dl)).toMatch(/“trivago”/);
    expect(semanticNameIssue("NovemberWebinarTile", { kind: "card", texts: [] }, dl)).toMatch(/“november”/);
    expect(semanticNameIssue("CaseStudySection", sec, dl)).toBeNull();
    expect(semanticNameIssue("NewsletterSignupSection", sec, dl)).toBeNull();
    // an icon or logo may show a brand
    expect(semanticNameIssue("WatsonxIcon", { kind: "icon", texts: [] }, dl)).toBeNull();
  });

  it("rejects names after the shown product, customer or event; keeps structure and role names", () => {
    for (const n of [
      "ConfluentSection",
      "VaultSection",
      "FlashSystemSection",
      "WatsonxOrchestrateSection",
      "PlanningAnalyticsSection",
      "TrivagoCaseStudySection",
      "CitadelleCaseStudySection",
      "NovemberWebinarSection",
    ]) {
      if (n === "VaultSection") continue; // not in this copy
      expect(semanticNameIssue(n, sec, lint), n).toMatch(/^a product, brand or event of the copy/);
    }
    for (const n of [
      "CaseStudySection",
      "WebinarSection",
      "NewsletterSignup",
      "ProductTeaserSection",
      "SearchSection",
      "CloudTeaserSection",
    ])
      expect(semanticNameIssue(n, sec, lint), n).toBeNull();
    const plan = validateNaming(
      {
        ...IDS,
        componentSets: [
          {
            id: "s",
            name: "Section / Cds card",
            kind: "section",
            defaultVariant: "default",
            variants: { default: { id: "r", type: "frame" } },
          },
        ],
      },
      [
        {
          id: "s",
          name: "Section / Cds card",
          kind: "section",
          category: "sections",
          structure: "frame",
          texts: [],
          props: [],
          fixedProps: [],
        },
      ],
      { components: [{ id: "s", name: "TrivagoCaseStudySection" }] },
      new Map(),
      lint,
    );
    expect(plan.rejected).toEqual([
      "Section / Cds card → TrivagoCaseStudySection: a product, brand or event of the copy (“trivago”), not what the component is",
    ]);
    expect(namingMessages(IDS, [])[0]!.content).toMatch(
      /never the specific product, brand, customer, person, place or event/,
    );
  });
});
