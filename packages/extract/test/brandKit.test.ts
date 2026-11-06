// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import type { SceneComponentDef, SceneDesignSystem, SceneElement, SceneScreen } from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import { ESSENTIAL_KINDS, componentApi } from "@harness/extract";
import {
  GENERATED_KINDS,
  SITE_KINDS,
  TEXT_STYLE_IDS,
  brandFoundations,
  completeDesignSystem,
  foundationsScreen,
  headNounKind,
  inferKindFromName,
  kindOfSet,
} from "@harness/extract";
import { axesOf, buildInstance, elementsOf, parseVariantKey } from "@harness/extract";

const ds = (sets: SceneComponentDef[] = []): SceneDesignSystem => ({
  version: 1,
  name: "Acme",
  tokens: { ...DEFAULT_TOKENS },
  componentSets: sets,
});

const t = (
  id: string,
  text: string,
  size: number,
  weight: number,
  color = "rgb(34, 34, 34)",
  lh = 1.5,
): SceneElement => ({
  id,
  type: "text",
  text,
  style: {
    fontFamily: "Acme Sans, Arial, sans-serif",
    fontSize: size,
    fontWeight: weight as 400,
    lineHeightPx: size * lh,
    color,
  },
});
const cta = (id: string, label: string): SceneElement => ({
  id,
  type: "button",
  name: `Button · ${label}`,
  layout: { width: 180, height: 44, direction: "row", align: "center", justify: "center" },
  style: { background: "rgb(227, 6, 19)", radius: 4 },
  children: [t(`${id}-l`, label, 16, 600, "rgb(255, 255, 255)", 1.2)],
});
const ghost = (id: string, label: string): SceneElement => ({
  id,
  type: "button",
  name: `Button · ${label}`,
  layout: { width: 160, height: 44, direction: "row" },
  style: { background: "transparent", radius: 4, border: { width: 1, color: "rgb(34, 34, 34)" } },
  children: [t(`${id}-l`, label, 16, 600, "rgb(34, 34, 34)", 1.2)],
});
const card = (id: string): SceneElement => ({
  id,
  type: "frame",
  name: "Card",
  layout: { direction: "column", gap: 12, padding: 24, width: 360, height: 300 },
  style: {
    background: "rgb(255, 255, 255)",
    radius: 12,
    shadows: [{ x: 0, y: 4, blur: 16, color: "rgba(0, 0, 0, 0.12)" }],
  },
  children: [
    {
      id: `${id}-img`,
      type: "image",
      image: { src: "https://example.com/a.jpg", alt: "Photo" },
      layout: { width: "fill", height: 160 },
    },
    t(`${id}-t`, "Neuigkeiten aus der Region", 24, 700, "rgb(34, 34, 34)", 1.25),
  ],
});
const page = (): SceneScreen => ({
  version: 1,
  id: "home",
  name: "Home",
  platform: "web",
  width: 1280,
  height: 2000,
  responsive: { group: "home", minWidth: 1280 },
  root: {
    id: "root",
    type: "frame",
    layout: { direction: "column", gap: 32, padding: [48, 80] },
    style: { background: "rgb(255, 255, 255)" },
    children: [
      t("h1", "Willkommen bei Acme", 44, 700, "rgb(34, 34, 34)", 1.1),
      t("h2", "Unsere Angebote", 32, 700, "rgb(34, 34, 34)", 1.2),
      t(
        "p1",
        "Wir bringen dich schnell und sicher ans Ziel. Entdecke unsere Angebote für jeden Tag und jede Strecke.",
        16,
        400,
      ),
      t(
        "p2",
        "Mit dem neuen Tarif fährst du günstiger als je zuvor, und das ganz ohne Papierkram oder Wartezeiten.",
        16,
        400,
      ),
      t("meta", "Stand: Oktober 2026 – alle Angaben ohne Gewähr", 14, 400, "rgb(110, 110, 110)"),
      {
        id: "row",
        type: "frame",
        layout: { direction: "row", gap: 16 },
        children: [cta("b1", "Jetzt buchen"), cta("b2", "Tickets kaufen"), ghost("b3", "Mehr erfahren")],
      },
      {
        id: "cards",
        type: "frame",
        layout: { direction: "row", gap: 24 },
        children: [card("c1"), card("c2")],
      },
      {
        id: "band",
        type: "frame",
        layout: { direction: "column", padding: 40, width: "fill", height: 300 },
        style: { background: "rgb(244, 244, 244)" },
        children: [t("bt", "Häufige Fragen rund um dein Abo", 16, 400)],
      },
    ],
  },
});

describe("brand foundations", () => {
  it("reads colours by role, fonts, the type scale, radii and elevations from the screens", () => {
    const f = brandFoundations([page()], ds());
    expect(f.tokens).toMatchObject({
      theme: "light",
      primary: "#e30613",
      background: "#ffffff",
      text: "#222222",
      textMuted: "#6e6e6e",
      surfaceAlt: "#f4f4f4",
      fontFamily: "Acme Sans",
    });
    const text = Object.fromEntries(f.styles.text.map((s) => [s.name, s]));
    expect(text["Heading/H1"]).toMatchObject({ fontSize: 44, fontWeight: 700, fontFamily: "Acme Sans" });
    expect(text["Heading/H2"]).toMatchObject({ fontSize: 32, fontWeight: 700 });
    expect(text["Body/Regular"]).toMatchObject({ fontSize: 16, fontWeight: 400, lineHeight: 1.5 });
    expect(text["Label/Button"]).toMatchObject({ fontSize: 16, fontWeight: 600 });
    expect(text["Display"]!.fontSize).toBeGreaterThan(44);
    // every role of the scale exists once, sizes descend from display to h4
    expect(f.styles.text.map((s) => s.id).sort()).toEqual(Object.values(TEXT_STYLE_IDS).sort());
    const sizes = ["Display", "Heading/H1", "Heading/H2", "Heading/H3", "Heading/H4"].map(
      (n) => text[n]!.fontSize,
    );
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(new Set(sizes).size).toBe(sizes.length);
    expect(f.styles.paint.find((p) => p.name === "Brand/Primary")?.color).toBe("$primary");
    expect(f.styles.paint.find((p) => p.name === "Brand/On primary")?.color).toBe("$background");
    expect(f.styles.effect.find((e) => e.name === "Elevation/1")?.shadows).toEqual([
      { x: 0, y: 4, blur: 16, color: "rgba(0, 0, 0, 0.12)" },
    ]);
    expect(f.styles.effect.map((e) => e.name)).toEqual([
      "Elevation/1",
      "Elevation/2",
      "Elevation/3",
      "Focus ring",
    ]);
    expect(f.summary).toMatchObject({
      radii: { control: 4, card: 12 },
      controls: { height: 44, secondary: "outline" },
    });
    const vars = f.variables![0]!.variables.map((v) => v.name);
    expect(vars).toEqual(expect.arrayContaining(["space/md", "radius/control", "radius/card"]));
  });

  it("derives the feedback colours and a readable muted colour when the site has none", () => {
    const f = brandFoundations([page()], ds());
    for (const k of ["success", "warning", "danger"] as const) expect(f.tokens[k]).toMatch(/^#[0-9a-f]{6}$/);
    expect(f.tokens.danger).not.toBe(f.tokens.primary);
  });
});

describe("kinds a system already has", () => {
  it("reads the role from set names (head noun first) and falls back to other", () => {
    const def = (
      name: string,
      main: SceneElement = { id: "r", type: "frame", children: [{ id: "t", type: "text", text: "Hi" }] },
    ): SceneComponentDef => ({ id: name, name, variants: { default: main }, defaultVariant: "default" });
    expect(inferKindFromName(def("Footer / Link"))).toBe("link");
    expect(inferKindFromName(def("Icon / location pin"))).toBe("icon");
    expect(inferKindFromName(def("Form / Rac Input Wrapper"))).toBe("input");
    expect(inferKindFromName(def("List item / Button 3"))).toBe("button");
    expect(inferKindFromName(def("List / List item 4"))).toBe("list-item");
    expect(
      inferKindFromName(
        def("Button / Close", { id: "r", type: "button", children: [{ id: "i", type: "icon", icon: "x" }] }),
      ),
    ).toBe("icon-button");
    expect(inferKindFromName(def("time"))).toBe("other");
    expect(kindOfSet({ ...def("Footer / Link"), kind: "card" }, ds())).toBe("card");
  });
});

describe("complete a design system", () => {
  const existing: SceneComponentDef[] = [
    {
      id: "site-btn",
      name: "Hero CTA",
      kind: "button",
      origin: "extracted",
      variants: { default: cta("x", "Los") },
      defaultVariant: "default",
    },
    {
      id: "site-link",
      name: "Footer / Link",
      origin: "extracted",
      variants: { default: t("l", "Impressum", 14, 400) },
      defaultVariant: "default",
    },
  ];

  it("applies the foundations and generates exactly the missing essential kinds", () => {
    const r = completeDesignSystem(ds(existing), [page()]);
    const made = r.added.map((id) => r.ds.componentSets!.find((d) => d.id === id)!);
    const kinds = made.map((d) => d.kind);
    // the site's one-off button / link looks are no system controls: the brand's Button and Link are generated too
    for (const k of SITE_KINDS) expect(kinds).not.toContain(k);
    // the full set, whether the page shows it or not (tables, quotes, a lightbox, content blocks…)
    const expected = ESSENTIAL_KINDS.filter((k) => !SITE_KINDS.includes(k));
    expect([...kinds].sort()).toEqual([...expected].sort());
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const d of made)
      expect(d).toMatchObject({
        origin: "generated",
        category: expect.any(String),
        description: expect.any(String),
      });
    expect(r.ds.tokens.primary).toBe("#e30613");
    expect(r.ds.styles!.text.some((s) => s.name === "Heading/H1")).toBe(true);
    // existing sets are untouched; the form nests the system's Button
    expect(r.ds.componentSets!.slice(0, 2)).toEqual(existing);
    const form = made.find((d) => d.kind === "form")!;
    const button = made.find((d) => d.kind === "button")!;
    expect([...elementsOf(form.variants.default!)].some((e) => e.instance?.componentId === button.id)).toBe(
      true,
    );
  });

  it("reuses a site control that is a real system component (a style axis to choose from)", () => {
    const systemBtn: SceneComponentDef = {
      id: "site-btn",
      name: "Button",
      kind: "button",
      origin: "extracted",
      variantAxes: { variant: ["primary", "secondary"] },
      variants: { "variant=primary": cta("x", "Los"), "variant=secondary": cta("y", "Mehr") },
      defaultVariant: "variant=primary",
    };
    const r = completeDesignSystem(ds([systemBtn]), [page()]);
    const made = r.added.map((id) => r.ds.componentSets!.find((d) => d.id === id)!);
    expect(made.map((d) => d.kind)).not.toContain("button");
    const form = made.find((d) => d.kind === "form")!;
    expect([...elementsOf(form.variants.default!)].some((e) => e.instance?.componentId === "site-btn")).toBe(
      true,
    );
  });

  it("a site control whose only axis is its colour is no system component: the brand Button is still made", () => {
    const toneBtn: SceneComponentDef = {
      id: "site-btn",
      name: "PrimaryButton",
      kind: "button",
      origin: "extracted",
      variantAxes: { tone: ["yellow", "light"] },
      variants: { "tone=yellow": cta("x", "Los"), "tone=light": cta("y", "Mehr") },
      defaultVariant: "tone=yellow",
    };
    const r = completeDesignSystem(ds([toneBtn]), [page()]);
    const made = r.added.map((id) => r.ds.componentSets!.find((d) => d.id === id)!);
    expect(made.find((d) => d.kind === "button")?.variantAxes).toMatchObject({
      variant: ["primary", "secondary", "ghost"],
    });
  });

  it("generates sets with valid variant keys, property targets and instances that build", () => {
    const r = completeDesignSystem(ds(), [page()], { force: true });
    expect(r.added.length).toBe(GENERATED_KINDS.length);
    for (const id of r.added) {
      const def = r.ds.componentSets!.find((d) => d.id === id)!;
      const keys = Object.keys(def.variants);
      expect(keys).toContain(def.defaultVariant);
      const axes = axesOf(def);
      if (def.variantAxes) {
        expect(keys.length).toBe(Object.values(def.variantAxes).reduce((n, v) => n * v.length, 1));
        for (const k of keys)
          for (const [a, v] of Object.entries(parseVariantKey(k))) expect(axes[a]).toContain(v);
      } else expect(keys).toEqual(["default"]);
      const main = def.variants[def.defaultVariant]!;
      const ids = new Set([...elementsOf(main)].map((e) => e.id));
      for (const p of def.properties ?? [])
        expect(ids.has(p.target), `${def.name}: ${p.name} → ${p.target}`).toBe(true);
      // element ids are unique within each variant tree
      for (const v of Object.values(def.variants)) {
        const all = [...elementsOf(v)].map((e) => e.id);
        expect(new Set(all).size, def.name).toBe(all.length);
      }
      for (const k of keys) {
        const inst = buildInstance(
          {
            id: "i",
            type: def.variants[k]!.type,
            instance: { componentId: id, variant: parseVariantKey(k) },
          },
          r.ds,
        );
        expect(inst.instance?.componentId).toBe(id);
        expect([...elementsOf(inst)].slice(1).every((e) => e.id.startsWith("i__"))).toBe(true);
      }
      expect(componentApi(def, r.ds).length).toBeGreaterThanOrEqual(0);
    }
    const button = r.ds.componentSets!.find((d) => d.kind === "button")!;
    expect(button.variantAxes).toEqual({
      variant: ["primary", "secondary", "ghost"],
      size: ["sm", "md", "lg"],
    });
    expect(button.properties!.map((p) => p.name)).toEqual(["Label", "Show icon"]);
    const built = buildInstance(
      { id: "b", type: "button", instance: { componentId: button.id, props: { Label: "Weiter" } } },
      r.ds,
    );
    expect([...elementsOf(built)].find((e) => e.type === "text")?.text).toBe("Weiter");
    // brand look: the site's control radius / height, colours as token refs
    const md = button.variants["variant=primary,size=md"]!;
    expect(md.style).toMatchObject({ background: "$primary", radius: 4 });
    expect(md.layout?.height).toBe(44);
    const input = r.ds.componentSets!.find((d) => d.kind === "input")!;
    expect(input.variantAxes).toEqual({ state: ["default", "focus", "error", "disabled"] });
  });

  it("is idempotent: completing twice adds nothing and keeps the styles", () => {
    const once = completeDesignSystem(ds(existing), [page()]);
    const twice = completeDesignSystem(once.ds, [page()]);
    expect(twice.added).toEqual([]);
    expect(twice.ds.componentSets!.length).toBe(once.ds.componentSets!.length);
    expect(twice.ds.styles).toEqual(once.ds.styles);
    expect(twice.ds.variables).toEqual(once.ds.variables);
  });

  it("honours kinds, newId and keeps tokens when asked", () => {
    let n = 0;
    const r = completeDesignSystem(ds(), [page()], {
      kinds: ["badge", "header", "stat"],
      newId: () => `new-${++n}`,
      applyTokens: false,
    });
    expect(r.added).toEqual(["new-1", "new-2"]);
    expect(r.ds.componentSets!.map((d) => d.kind)).toEqual(["badge", "stat"]);
    expect(r.ds.tokens.primary).toBe(DEFAULT_TOKENS.primary);
  });

  it("builds a foundations specimen screen", () => {
    const r = completeDesignSystem(ds(), [page()], { kinds: [] });
    const s = foundationsScreen(r.ds);
    expect(s.platform).toBe("web");
    expect([...elementsOf(s.root)].filter((e) => e.styleRefs?.text).length).toBe(
      Object.keys(TEXT_STYLE_IDS).length,
    );
  });
});

describe("headNounKind", () => {
  it("a name whose head noun names another kind of thing overrides the structural guess", () => {
    expect(headNounKind("ChevronRightIcon", "accordion")).toBe("icon");
    expect(headNounKind("WebinarTag", "card")).toBe("tag");
    expect(headNounKind("LegalNav", "list")).toBe("navigation");
    // a name that only refines the kind, or says nothing, changes nothing
    expect(headNounKind("PlayButton", "icon-button")).toBeNull();
    expect(headNounKind("CompanyLinkGroup", "list-item")).toBeNull();
    expect(headNounKind("NewsCard", "card")).toBeNull();
  });
});
