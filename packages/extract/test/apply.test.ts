import { describe, expect, it } from "vitest";
import type { SceneComponentDef, SceneDesignSystem, SceneScreen } from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import { applyNamingPlan, fallbackNames } from "@harness/extract";

const set = (
  id: string,
  name: string,
  kind: SceneComponentDef["kind"],
  props: string[] = [],
): SceneComponentDef => ({
  id,
  name,
  kind,
  variants: { default: { id: `${id}-main`, type: "frame" } },
  defaultVariant: "default",
  properties: props.map((p) => ({ name: p, type: "text", default: "", target: `${id}-t` })),
});

const ds = (sets: SceneComponentDef[]): SceneDesignSystem => ({
  version: 1,
  name: "t",
  tokens: DEFAULT_TOKENS,
  componentSets: sets,
});

describe("fallbackNames (W3 / W4)", () => {
  it("names built-in sets from kind and words, transliterated, unique without numbers", () => {
    const plan = fallbackNames(
      ds([
        set("a", "Section / Über uns 2", "section"),
        set("b", "Card / Teaser", "card"),
        set("c", "Card / Teaser 3", "card"),
        set("d", "PrimaryButton", "button"),
      ]),
    );
    const names = Object.fromEntries(plan.sets.map((s) => [s.id, s.name]));
    expect(names.a).toBe("UeberUnsSection");
    expect(names.b).toBe("TeaserCard");
    expect(names.c).toMatch(/^[A-Z][a-z]+TeaserCard$/);
    expect(names.c).not.toMatch(/(Alt|Variant|Other|Copy|New)$/);
    expect(names.d).toBeUndefined();
    for (const n of Object.values(names)) expect(n).not.toMatch(/\d/);
  });

  it("stays letters only and unique without case when a site runs out of single letters", () => {
    const sets = Array.from({ length: 70 }, (_, i) => set(`s${i}`, "Card / Teaser", "card"));
    const names = fallbackNames(ds(sets)).sets.map((s) => s.name!);
    for (const n of names) expect(n).toMatch(/^[A-Za-z]+$/);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(70);
  });
});

describe("applyNamingPlan", () => {
  it("renames sets and props; instances keep their values under the new prop name", () => {
    const d = ds([set("a", "Card / Teaser", "card", ["Title 2"])]);
    const screens: SceneScreen[] = [
      {
        version: 1,
        id: "s",
        name: "s",
        platform: "web",
        width: 390,
        height: 800,
        root: {
          id: "r",
          type: "frame",
          children: [
            { id: "i", type: "frame", instance: { componentId: "a", props: { "Title 2": "Hello" } } },
          ],
        },
      },
    ];
    const out = applyNamingPlan(d, screens, {
      sets: [
        {
          id: "a",
          from: "Card / Teaser",
          name: "ProductCard",
          props: [{ ref: { kind: "property", property: "Title 2" }, from: "Title 2", to: "headline" }],
        },
      ],
      order: null,
      rejected: [],
    });
    expect(out.ds.componentSets![0].name).toBe("ProductCard");
    expect(out.ds.componentSets![0].properties![0].name).toBe("Headline");
    expect(out.screens[0].root.children![0].instance!.props).toEqual({ Headline: "Hello" });
    expect(out.renamed).toBe(1);
  });
});
