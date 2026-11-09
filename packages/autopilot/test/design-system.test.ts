import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  lintRawCss,
  lintWorkspaceCss,
  specFromSnapshot,
  tokenizeCss,
  type RawValue,
} from "@harness/design-system";
import { fileURLToPath } from "node:url";
import {
  autopilotPaths,
  createDesignSystemStage,
  DEFAULT_AUTOPILOT_CONFIG,
  type StageContext,
} from "@harness/autopilot";
import { recordedDesignSystem } from "./design-system-helpers.js";

type Built = Awaited<ReturnType<typeof recordedDesignSystem>>;
let built: Built;
const read = (p: string) => readFileSync(join(built.out, p), "utf8");
const recorded = fileURLToPath(
  new URL("../../capture/test/sites/acme/recorded/1440.snapshot.json", import.meta.url),
);

beforeAll(async () => {
  built = await recordedDesignSystem();
}, 120_000);

describe("reading the brand from a snapshot", () => {
  it("reads the recorded capture reproducibly, without a browser", () => {
    const snap = JSON.parse(readFileSync(recorded, "utf8"));
    const a = specFromSnapshot(snap, { name: "Acme" });
    const b = specFromSnapshot(snap, { name: "Acme" });
    expect(a).toEqual(b);
    expect(a.colors?.primary).toBe("#0f5132");
    expect(a.fonts?.sans).toBe("Acme Sans");
    expect(a.sources?.["colors.primary"]).toBe("site");
    expect(a.notes?.[0]).toContain("no live page");
  });
});

describe("composites in the design-system workspace", () => {
  it("emits @<prefix>-ds/site next to the packages, in the workspace", () => {
    const root = JSON.parse(read("package.json"));
    expect(root.workspaces).toContain("packages/site");
    expect(root.workspaces).not.toContain("packages/angular");
    expect(root.scripts.build).toContain("packages/site");
    const pkg = JSON.parse(read("packages/site/package.json"));
    expect(pkg.name).toBe("@acme-ds/site");
    expect(Object.keys(pkg.dependencies)).toEqual(
      expect.arrayContaining(["@acme-ds/tokens", "@acme-ds/react"]),
    );
  });

  it("emits the page's sections and repeated components", () => {
    const { sections, components } = built.report.site;
    expect(sections).toEqual(expect.arrayContaining(["Hero", "Header", "Footer"]));
    expect(components.length).toBeGreaterThan(5);
    for (const s of sections)
      expect(existsSync(join(built.out, `packages/site/src/sections/${s}/${s}.tsx`)), s).toBe(true);
    const hero = read("packages/site/src/sections/Hero/Hero.tsx");
    expect(hero).toContain('data-ds="Hero"');
    expect(hero).toContain('data-ds-kind="section"');
    expect(hero).not.toMatch(/data:image/);
    expect(read("packages/site/src/index.ts")).toContain("export { default as Hero } from './sections/Hero'");
  });

  it("keeps a primitive path next to the measured markup for swappable sets", () => {
    const swaps = read("packages/site/src/swaps.ts");
    expect(swaps).toContain('"FilledLightButton":false');
    const source = read("packages/site/src/components/FilledLightButton/FilledLightButton.tsx");
    expect(source).toContain("SWAPS.FilledLightButton ?");
    expect(source).toContain('<DsButton data-ds-primitive="Button"');
    expect(source).toContain("@acme-ds/react");
  });

  it("links are relative to the rebuilt site", () => {
    for (const f of ["packages/site/src/data/header.ts"])
      expect(read(f)).not.toMatch(/https?:\/\/acme\.example/);
  });

  it("composite CSS holds tokens only; measured values live in the token layer", () => {
    const composites = read("packages/site/src/styles/composites.css");
    expect(lintRawCss(composites)).toEqual([]);
    expect(composites).toMatch(/var\(--acme-site-size-\d+\)/);
    expect(composites).toMatch(/var\(--acme-primary-\d+\)|var\(--acme-[a-z-]+\)/);
    const tokens = read("packages/site/src/styles/site-tokens.css");
    expect(tokens).toMatch(/--acme-site-size-1: [\d.]+px;/);
    expect(built.report.site.tokens.aliased).toBeGreaterThan(0);
  });

  it("passes the raw-value lint and the element checks of §1", () => {
    expect(built.report.rawValues).toEqual([]);
    const gate = (id: string) => built.gates.find((g) => g.id === id);
    expect(gate("css.rawValues")?.pass).toBe(true);
    expect(gate("contrast.pairs")?.pass).toBe(true);
    expect(gate("elements.registered")).toMatchObject({ pass: true, value: 28, threshold: 28 });
    expect(gate("elements.reactWrappers")?.pass).toBe(true);
    expect(gate("npm.install")).toBeUndefined();
  });

  it("writes design-system/report.json with provenance, contrast and the composites", () => {
    const report = JSON.parse(read("design-system/report.json"));
    expect(report.scope).toBe("@acme-ds");
    expect(report.provenance["colors.primary"]).toBe("site");
    expect(report.contrast.pairs).toBeGreaterThan(50);
    expect(report.contrast.failing).toEqual([]);
    expect(report.site.sections).toContain("Footer");
  });
});

describe("the raw-value lint", () => {
  const values = (l: RawValue[]) => l.map((x) => x.value);
  it("finds raw colours and sizes in declarations", () => {
    expect(values(lintRawCss(".a { color: #fff; padding: 12px 1rem; background: rgb(1, 2, 3); }"))).toEqual([
      "#fff",
      "12px",
      "1rem",
      "rgb(1, 2, 3)",
    ]);
  });
  it("leaves tokens, zero, percentages and hairlines alone", () => {
    expect(
      lintRawCss(
        ".a { color: var(--x); margin: 0px; width: 100%; height: 50vh; border: 1px solid var(--b); outline: 2px solid var(--f); }",
      ),
    ).toEqual([]);
  });
  it("ignores @font-face, media conditions and url()s", () => {
    expect(
      lintRawCss(
        "@font-face { font-family: A; src: url(a.woff2); font-weight: 100 900; }\n@media (min-width: 768px) { .a { color: var(--c); } }\n.b { background: url(i-12px.png); }",
      ),
    ).toEqual([]);
  });
  it("lints only component CSS of the workspace", () => {
    const files = {
      "packages/web-components/src/components/x.ts": "css`.a{ padding: 7px; }`",
      "packages/site/src/styles/composites.css": ".b{ color: #123456; }",
      "packages/site/src/styles/site-tokens.css": ":root{ --v: 7px; }\n.c{ color: #000; }",
      "docs/docs.css": ".d{ padding: 7px; }",
    };
    expect(lintWorkspaceCss(files).map((x) => x.file)).toEqual([
      "packages/web-components/src/components/x.ts",
      "packages/site/src/styles/composites.css",
    ]);
  });
});

describe("tokenizing measured CSS", () => {
  it("names each measured value once, aliases design tokens and reuses names", () => {
    const aliases = new Map([["#0f5132", "var(--acme-primary-60)"]]);
    const t = tokenizeCss(
      ".a { padding: 12px; margin: 12px 4px; color: #0F5132; background: #abcdef; }\n@media (min-width: 900px) { .b { padding: 4px; } }",
      {
        tokenPrefix: "--acme-site",
        aliases,
      },
    );
    expect(t.css).toBe(
      ".a { padding: var(--acme-site-size-1); margin: var(--acme-site-size-1) var(--acme-site-size-2); color: var(--acme-primary-60); background: var(--acme-site-color-1); }\n@media (min-width: 900px) { .b { padding: var(--acme-site-size-2); } }",
    );
    expect(t.tokens).toEqual([
      { name: "--acme-site-color-1", value: "#abcdef", kind: "color" },
      { name: "--acme-site-size-1", value: "12px", kind: "size" },
      { name: "--acme-site-size-2", value: "4px", kind: "size" },
    ]);
    expect(t.aliased).toBe(1);
  });
  it("is deterministic and keeps url() and zero", () => {
    const css = ".a { background: url('a12px.png') no-repeat 0px; }";
    expect(tokenizeCss(css, { tokenPrefix: "--s" }).css).toBe(css);
  });
});

describe("the design-system stage", () => {
  const ctx = (replayUrl?: string): StageContext => ({
    site: { id: "acme", fixture: "acme", framework: "nextjs" },
    cycle: 1,
    paths: autopilotPaths("/tmp/autopilot-x"),
    config: DEFAULT_AUTOPILOT_CONFIG,
    projectDir: "/tmp/autopilot-x/project",
    stageDir: "/tmp/autopilot-x/stage",
    ...(replayUrl
      ? {
          snapshot: {
            site: "acme",
            dir: "/s",
            finalUrl: replayUrl,
            replayUrl,
            capturedAt: "",
            source: "fixture" as const,
          },
        }
      : {}),
    previous: {},
    ports: { acquire: async () => 1, release: () => undefined },
    signal: new AbortController().signal,
    log: () => undefined,
    event: () => undefined,
    keepCache: false,
  });

  it("fails with a finding when there is no snapshot to read", async () => {
    const r = await createDesignSystemStage().run(ctx());
    expect(r).toMatchObject({ stage: "design-system", status: "failed", artifacts: {} });
    expect(r.issues[0]).toMatchObject({ code: "STAGE_FAILED", cause: "no-snapshot" });
  });

  it("reports the build's gates and issues and names the workspace", async () => {
    const stage = createDesignSystemStage({
      build: async (o) => {
        expect(o.url).toBe("http://127.0.0.1:9/");
        expect(o.yes).toBe(true);
        expect(o.prefix).toBe("acme");
        return {
          ok: false,
          runId: "r",
          runDir: "/run",
          out: o.out,
          report: {} as never,
          gates: [{ id: "npm.build", pass: false, hard: true }],
          issues: [{ code: "BUILD_FAILED", cause: "build", message: "x", severity: "error" }],
        };
      },
    });
    const r = await stage.run(ctx("http://127.0.0.1:9/"));
    expect(r.status).toBe("failed");
    expect(r.issues[0]).toMatchObject({ code: "BUILD_FAILED", cause: "build" });
    expect(r.artifacts.designSystem).toBe("/tmp/autopilot-x/stage/out/design-system");
    expect(r.artifacts.runDir).toBe("/run");
  });
});
