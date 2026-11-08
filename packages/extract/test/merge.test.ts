import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SceneDesignSystem, SceneElement, SceneScreen } from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import { pageScreens } from "@harness/scene";
import { extractComponents, mergeTwins, twinGroups } from "@harness/extract";
import { getEmitter } from "@harness/codegen";

const recorded = (w: number) =>
  JSON.parse(
    readFileSync(
      new URL(`../../capture/test/sites/acme/recorded/${w}.snapshot.json`, import.meta.url),
      "utf8",
    ),
  );

function extracted(): { ds: SceneDesignSystem; screens: SceneScreen[] } {
  // the fitted geometry: its copies of one card differ in their numbers (twins to merge); in flow they come out alike
  const ps = pageScreens(
    [
      { width: 390, minWidth: 0, snap: recorded(390) },
      { width: 768, minWidth: 768, snap: recorded(768) },
      { width: 1440, minWidth: 1024, snap: recorded(1440) },
    ],
    true,
    { flow: false },
  );
  let ds: SceneDesignSystem = { version: 1, name: "acme", tokens: DEFAULT_TOKENS, componentSets: [] };
  let screens = ps.screens;
  let n = 0;
  for (let round = 0; round < 3; round++) {
    const r = extractComponents(
      screens.map((s) => ({ nodeId: s.id, screen: s })),
      ds,
      {
        newId: () => `cmp-${++n}`,
        sections: round === 0,
      },
    );
    if (!r.components.length) break;
    ds = r.ds;
    screens = screens.map((s) => r.screens.get(s.id) ?? s);
  }
  return { ds, screens };
}

const visible = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const pictures = (html: string) => [...html.matchAll(/\bsrc="([^"]+)"/g)].map((m) => m[1]).sort();
const instances = (screens: SceneScreen[]) => {
  let n = 0;
  const visit = (e: SceneElement) => {
    if (e.instance) n++;
    e.children?.forEach(visit);
  };
  screens.forEach((s) => visit(s.root));
  return n;
};

describe("mergeTwins (W1)", () => {
  it("leaves no twin groups, keeps every instance and changes nothing a visitor sees", () => {
    const { ds, screens } = extracted();
    expect(twinGroups(ds.componentSets ?? []).length).toBeGreaterThan(0);
    const m = mergeTwins(ds, screens);
    expect(m.merged.length).toBeGreaterThan(0);
    expect(twinGroups(m.ds.componentSets ?? [])).toEqual([]);
    expect(m.ds.componentSets!.length).toBe(ds.componentSets!.length - m.merged.length);
    expect(instances(m.screens)).toBe(instances(screens));
    for (const { from } of m.merged) {
      const stale = JSON.stringify(m.screens).includes(`"componentId":"${from}"`);
      expect(stale).toBe(false);
    }
    const before = String(getEmitter("static")!.emit({ screens, page: "acme" }, {})["index.html"]);
    const after = String(getEmitter("static")!.emit({ screens: m.screens, page: "acme" }, {})["index.html"]);
    expect(visible(after)).toBe(visible(before));
    expect(pictures(after)).toEqual(pictures(before));
  });
});
