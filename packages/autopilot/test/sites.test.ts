import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPortPool, loadSites, parseSites, selectSites, siteIdFromUrl } from "@harness/autopilot";

const YAML = `
sites:
  bvg:
    url: https://www.bvg.de/de
    framework: nextjs
    viewports: [mobile, tablet, desktop]
  bmw:
    url: https://www.bmw.de/de/index.html
    freeze: { wayback: true }
holdout:
  - fixture: acme
  - fixture: fluid
  - url: https://www.deutschebahn.com/de
`;

describe("sites.yaml", () => {
  it("normalises sites and holdout entries to SiteConfig", () => {
    const { sites, holdout } = parseSites(YAML);
    expect(sites).toEqual([
      {
        id: "bvg",
        url: "https://www.bvg.de/de",
        framework: "nextjs",
        viewports: ["mobile", "tablet", "desktop"],
      },
      { id: "bmw", url: "https://www.bmw.de/de/index.html", framework: "nextjs", freeze: { wayback: true } },
    ]);
    expect(holdout).toEqual([
      { id: "acme", fixture: "acme", framework: "nextjs" },
      { id: "fluid", fixture: "fluid", framework: "nextjs" },
      { id: "deutschebahn", url: "https://www.deutschebahn.com/de", framework: "nextjs" },
    ]);
  });

  it("names a site from its URL", () => {
    expect(siteIdFromUrl("https://www.deutschebahn.com/de")).toBe("deutschebahn");
    expect(siteIdFromUrl("https://www.foo.co.uk/")).toBe("foo-co");
  });

  it("rejects a site without a source, a bad URL, and a duplicate id", () => {
    expect(() => parseSites("sites:\n  a: { framework: nextjs }\n")).toThrow(/url or a fixture/);
    expect(() => parseSites("sites:\n  a: { url: 'not a url' }\n")).toThrow(/not a URL/);
    expect(() => parseSites("sites:\n  a: { url: 'https://a.test' }\nholdout:\n  - fixture: a\n")).toThrow(
      /twice/,
    );
    expect(() => parseSites("sites:\n  a: { url: 'https://a.test', fixture: x }\n")).toThrow(/not both/);
  });

  it("selects the matrix by default and any named site, holdout included", () => {
    const file = parseSites(YAML);
    expect(selectSites(file).map((s) => s.id)).toEqual(["bvg", "bmw"]);
    expect(selectSites(file, ["acme"]).map((s) => s.id)).toEqual(["acme"]);
    expect(() => selectSites(file, ["nope"])).toThrow(/unknown site/);
  });

  it("the committed sites file parses", () => {
    const committed = join(__dirname, "../../../autopilot");
    const file = loadSites({ committed });
    expect(file.sites.map((s) => s.id)).toEqual(["bvg", "vw", "ibm", "bmw"]);
    expect(file.holdout.map((s) => s.id)).toEqual(["acme", "fluid", "deutschebahn"]);
    expect(readFileSync(join(committed, "sites.yaml"), "utf8")).toContain("wayback: true");
  });
});

describe("port pool", () => {
  it("hands out free ports once and takes them back", async () => {
    const pool = createPortPool([43800, 43803]);
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(a).not.toBe(b);
    pool.release(a);
    const c = await pool.acquire();
    expect(c).toBeGreaterThanOrEqual(43800);
    expect(c).toBeLessThanOrEqual(43803);
  });
});
