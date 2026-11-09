import { describe, expect, it } from "vitest";
import { CLOSE_LABEL, pickViewport, type ViewportInteractions } from "./NavInteractions";

const rec = (trigger: string) => ({ trigger, label: trigger, changes: [] });
const sets: ViewportInteractions = {
  mobile: { width: 375, records: [rec("mobile")] },
  tablet: { width: 768, records: [rec("tablet")] },
  desktop: { width: 1440, records: [rec("desktop")] },
};

describe("NavInteractions (menus replayed from the crawl)", () => {
  it("uses the records of the widest crawled viewport that fits the window, the smallest one below it", () => {
    expect(pickViewport(sets, 320)[0]!.trigger).toBe("mobile");
    expect(pickViewport(sets, 375)[0]!.trigger).toBe("mobile");
    expect(pickViewport(sets, 1024)[0]!.trigger).toBe("tablet");
    expect(pickViewport(sets, 1920)[0]!.trigger).toBe("desktop");
    expect(pickViewport({}, 800)).toEqual([]);
  });
  it("recognises close buttons inside an opened panel", () => {
    for (const l of ["Suche schließen", "Close menu", "×", "Zurück", "Fermer"]) expect(CLOSE_LABEL.test(l)).toBe(true);
    for (const l of ["Verbindungen", "Mehr anzeigen", "Search"]) expect(CLOSE_LABEL.test(l)).toBe(false);
  });
});
