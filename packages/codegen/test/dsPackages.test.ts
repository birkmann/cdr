import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SceneDesignSystem, SceneScreen } from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import { pageScreens } from "@harness/scene";
import { applyNamingPlan, extractComponents, fallbackNames, mergeTwins } from "@harness/extract";
import { contrastRatio, contrastRows, designSystemModel, getEmitter } from "@harness/codegen";

const recorded = (w: number) =>
  JSON.parse(
    readFileSync(
      new URL(`../../capture/test/sites/acme/recorded/${w}.snapshot.json`, import.meta.url),
      "utf8",
    ),
  );

function system(): { ds: SceneDesignSystem; screens: SceneScreen[] } {
  const ps = pageScreens([
    { width: 390, minWidth: 0, snap: recorded(390) },
    { width: 1440, minWidth: 1024, snap: recorded(1440) },
  ]);
  let ds: SceneDesignSystem = {
    version: 1,
    name: "Acme Outdoor",
    tokens: {
      ...DEFAULT_TOKENS,
      theme: "light",
      background: "#f7f5f0",
      surface: "#ffffff",
      text: "#1b1f1d",
      textMuted: "#5b6460",
      primary: "#0f5132",
    },
    componentSets: [],
  };
  let screens = ps.screens;
  let n = 0;
  for (let round = 0; round < 3; round++) {
    const r = extractComponents(
      screens.map((s) => ({ nodeId: s.id, screen: s })),
      ds,
      { newId: () => `cmp-${++n}`, sections: round === 0 },
    );
    if (!r.components.length) break;
    ds = r.ds;
    screens = screens.map((s) => r.screens.get(s.id) ?? s);
  }
  const m = mergeTwins(ds, screens);
  const named = applyNamingPlan(m.ds, m.screens, fallbackNames(m.ds));
  return { ds: named.ds, screens: named.screens };
}

describe("design-system packages (one model, three frameworks)", () => {
  const { ds, screens } = system();
  const model = designSystemModel(ds);
  const out = Object.fromEntries(
    (["ds-react", "ds-lit", "ds-angular"] as const).map((id) => [
      id,
      getEmitter(id)!.emit({ screens, system: ds, page: "Acme" }, { sourceUrl: "https://acme.example/" }),
    ]),
  );

  it("writes a buildable package per framework with the same components", () => {
    for (const [id, files] of Object.entries(out)) {
      const pkg = JSON.parse(String(files["package.json"]));
      expect(pkg.name, id).toMatch(/acme/);
      expect(pkg.scripts?.build, id).toBeTruthy();
      expect(
        Object.keys(files).some((f) => f.startsWith("docs/")),
        id,
      ).toBe(true);
      expect(files["credits.json"], id).toBeTruthy();
      const src = Object.entries(files)
        .filter(([f]) => /\.(tsx?|js)$/.test(f))
        .map(([, c]) => String(c))
        .join("\n");
      // every component of the shared model appears in every framework's sources
      for (const spec of model.specs)
        expect(src.includes(spec.file) || src.includes(spec.name), `${id}: ${spec.name}`).toBe(true);
    }
  });

  it("documents every prop and carries a WCAG contrast table", () => {
    for (const [id, files] of Object.entries(out)) {
      const docs = Object.entries(files)
        .filter(([f]) => f.startsWith("docs/") && f.endsWith(".html"))
        .map(([, c]) => String(c))
        .join("\n");
      expect(docs, id).toContain('id="contrast"');
      for (const spec of model.specs)
        for (const p of spec.props ?? [])
          expect(docs.includes(p.name), `${id}: ${spec.name}.${p.name}`).toBe(true);
    }
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    const rows = contrastRows(ds);
    expect(rows.find((r) => r.fg.startsWith("text ") && r.bg.startsWith("background"))?.level).toBe("AAA");
  });
});
