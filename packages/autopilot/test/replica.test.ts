import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  autopilotPaths,
  createReplicaStage,
  DEFAULT_AUTOPILOT_CONFIG,
  replicaFiles,
  swapCandidates,
  type StageContext,
} from "@harness/autopilot";
import { recordedDesignSystem } from "./design-system-helpers.js";
import { fitsFileSystem } from "../src/stages/replica.js";

type Built = Awaited<ReturnType<typeof recordedDesignSystem>>;
let built: Built;
beforeAll(async () => {
  built = await recordedDesignSystem();
}, 120_000);

const names = {
  scope: "@acme-ds",
  tokens: "@acme-ds/tokens",
  wc: "@acme-ds/web-components",
  react: "@acme-ds/react",
  site: "@acme-ds/site",
};
const page = () => {
  const pages = JSON.parse(readFileSync(join(built.out, "design-system/pages.json"), "utf8")) as Record<
    string,
    string
  >;
  return Object.values(pages)[0]!;
};

function context(): StageContext {
  const root = built.project;
  const paths = autopilotPaths(root);
  return {
    site: { id: "acme", fixture: "acme", framework: "nextjs" },
    cycle: 1,
    paths,
    config: DEFAULT_AUTOPILOT_CONFIG,
    projectDir: built.project,
    stageDir: paths.stageDir(1, "acme", "replica"),
    snapshot: {
      site: "acme",
      dir: root,
      finalUrl: "http://127.0.0.1:1/",
      replayUrl: "http://127.0.0.1:1/",
      capturedAt: "",
      source: "fixture",
    },
    previous: {
      "design-system": {
        stage: "design-system",
        site: "acme",
        status: "passed",
        wallClockMs: 0,
        gates: [],
        issues: [],
        artifacts: { designSystem: built.out, runDir: built.runDir },
      },
    },
    ports: { acquire: async () => 45871, release: () => undefined },
    signal: new AbortController().signal,
    log: () => undefined,
    event: () => undefined,
    keepCache: false,
  };
}

describe("the replica from the acme recordings", () => {
  it("recognises a media path no file system can store", () => {
    expect(fitsFileSystem("media/fast/photo.jpg")).toBe(true);
    expect(fitsFileSystem(`media/fast/${"x".repeat(256)}.jpg`)).toBe(false);
  });

  it("answers at the path of the original page", () => {
    const config = (pagePath?: string) =>
      replicaFiles({ names, pageTsx: page(), title: "T", lang: "de", pagePath })["next.config.mjs"]!;
    expect(config("/de.html")).toContain(`{ source: "/de.html", destination: "/" }`);
    expect(config("/")).not.toContain("rewrites");
    expect(config()).not.toContain("rewrites");
  });

  it("renders the page component under the name the generator gave it", () => {
    for (const name of ["Startseite", "Page"]) {
      const tsx = replicaFiles({
        names,
        pageTsx: `export default function ${name}() {\n  return <main />\n}\n`,
        title: "T",
        lang: "de",
      })["app/page.tsx"]!;
      expect(tsx).toContain(`function ${name}()`);
      expect(tsx).toContain(`return <${name} />`);
      expect(tsx).toContain("export default function ReplicaPage()");
    }
  });

  it("renders every section of the page from the design system's composites", () => {
    const files = replicaFiles({ names, pageTsx: page(), title: "Acme Outdoor", lang: "en" });
    const tsx = files["app/page.tsx"]!;
    expect(tsx.startsWith("'use client'")).toBe(true);
    const sections = JSON.parse(readFileSync(join(built.runDir, "scene/sections.json"), "utf8")) as {
      id: string;
    }[];
    expect(sections.length).toBeGreaterThanOrEqual(6);
    // each composite the page uses comes from the site package and wears the section it renders
    const imported =
      /import \{ ([^}]+) \} from '@acme-ds\/site'\n\/\/ Home/.exec(tsx)?.[1]?.split(", ") ?? [];
    const renderedSections = new Set<string>();
    for (const name of imported) {
      if (!tsx.includes(`<${name}`)) continue;
      const file = [`sections/${name}/${name}.tsx`, `components/${name}/${name}.tsx`]
        .map((f) => join(built.out, "packages/site/src", f))
        .find(existsSync);
      expect(file, name).toBeDefined();
      for (const m of readFileSync(file!, "utf8").matchAll(/data-section="([^"]+)"/g))
        renderedSections.add(m[1]!);
    }
    expect([...renderedSections].sort()).toEqual(expect.arrayContaining(sections.map((s) => s.id).sort()));
  });

  it("keeps one <main>: the page's frames are boxes", () => {
    const tsx = page();
    expect(tsx).not.toMatch(/<main[^>]*data-screen/);
    expect(tsx).toMatch(/<div className="home__main" data-screen/);
    expect((tsx.match(/<main\b/g) ?? []).length).toBe((tsx.match(/<\/main>/g) ?? []).length);
  });

  it("restores the page's headings so verify can compare them", () => {
    const hero = readFileSync(
      join(built.out, "packages/site/src/components/StackedBlock/StackedBlock.tsx"),
      "utf8",
    );
    expect(hero).toMatch(/<h1\b/);
  });

  it("writes the app with the design system's tokens and composites, on the mirror's framework versions", () => {
    const files = replicaFiles({ names, pageTsx: page(), title: "Acme Outdoor", lang: "en" });
    expect(files["app/layout.tsx"]).toContain("@acme-ds/tokens/tokens.css");
    expect(files["app/layout.tsx"]).toContain("@acme-ds/site/styles.css");
    expect(JSON.parse(files["package.json"]!).dependencies.next).toBe("16.4.4");
    expect(files["app/layout.tsx"]).toContain('lang="en"');
  });
});

describe("the swap rounds of the replica stage", () => {
  it("reverts a swap whose section loses parity and keeps the rest (no build, recorded numbers)", async () => {
    const ctx = context();
    const candidates = swapCandidates(built.out);
    expect(candidates.length).toBeGreaterThan(2);
    const [bad, ...rest] = candidates;
    const rounds: string[][] = [];
    const stage = createReplicaStage({
      buildAndMeasure: async (_c, enabled) => {
        rounds.push([...enabled]);
        const usingBad = enabled.includes(bad!);
        return {
          sections: { hero: { desktop: usingBad ? 0.8 : 0.99 } },
          sets: { [bad!]: { desktop: 0.5 }, [rest[0]!]: { desktop: 0.999 } },
          usage: [
            { set: bad!, section: "hero", viewport: "desktop" },
            { set: rest[0]!, section: "hero", viewport: "desktop" },
          ],
          crops: { [`${bad}@desktop`]: "/tmp/crop.diff.png" },
        };
      },
    });
    const r = await stage.run(ctx);
    expect(r.status).toBe("passed");
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toContain(bad);
    expect(rounds[1]).not.toContain(bad);
    expect(rounds[1]).toEqual(expect.arrayContaining(rest));
    const revert = r.issues.find((i) => i.code === "DS_SWAP_REVERTED");
    expect(revert?.message).toContain(bad);
    expect(revert?.evidence).toEqual(["/tmp/crop.diff.png"]);
    const swaps = JSON.parse(readFileSync(join(ctx.stageDir, "swaps.json"), "utf8"));
    expect(swaps.kept).not.toContain(bad);
    void writeFileSync;
  }, 60_000);
});
