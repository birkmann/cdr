import { describe, expect, it } from "vitest";
import { checkPolicy, parseUnifiedDiff, summarizeDiff, type SitesFile } from "@harness/autopilot";

const sites: SitesFile = {
  sites: [
    { id: "bvg", url: "https://www.bvg.de/de", framework: "nextjs" },
    { id: "vw", url: "https://www.vw.de/", framework: "nextjs" },
    { id: "ibm", url: "https://www.ibm.com/us-en", framework: "nextjs" },
  ],
  holdout: [
    { id: "acme", fixture: "acme", framework: "nextjs" },
    { id: "fluid", fixture: "fluid", framework: "nextjs" },
    { id: "deutschebahn", url: "https://www.deutschebahn.com/de", framework: "nextjs" },
  ],
};

/** A one-file unified diff, the shape of `git diff`, with lines given with their +/- markers. */
function diff(path: string, ...lines: string[]): string {
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed} +1,${added} @@`,
    ...lines,
    "",
  ].join("\n");
}

const codes = (text: string) => checkPolicy(text, sites).violations.map((v) => v.code);

describe("the policy check", () => {
  it("passes an ordinary fix", () => {
    const result = checkPolicy(
      diff("packages/mirror-design/src/styles.ts", "-  keep(link);", "+  if (!inNoscript(link)) keep(link);"),
      sites,
    );
    expect(result).toEqual({ ok: true, violations: [], reason: "" });
  });

  it("rejects a matrix hostname in packages, from sites.yaml and not a list", () => {
    expect(codes(diff("packages/core/src/x.ts", '+  if (url.includes("www.bvg.de")) return;'))).toEqual([
      "MATRIX_HOSTNAME",
    ]);
    expect(codes(diff("packages/core/src/x.ts", '+  host === "ibm.com"'))).toEqual(["MATRIX_HOSTNAME"]);
    expect(codes(diff("packages/core/src/x.ts", '+  host === "deutschebahn.com"'))).toEqual([
      "MATRIX_HOSTNAME",
    ]);
    const other: SitesFile = {
      sites: [{ id: "shop", url: "https://example.net/", framework: "nextjs" }],
      holdout: [],
    };
    expect(checkPolicy(diff("packages/core/src/x.ts", '+  host === "www.bvg.de"'), other).ok).toBe(true);
    expect(checkPolicy(diff("packages/core/src/x.ts", '+  host === "example.net"'), other).ok).toBe(false);
  });

  it("rejects a site id as a whole word, in any case, but not as part of a longer word", () => {
    expect(codes(diff("packages/core/src/x.ts", '+  if (site === "bvg") skipFonts();'))).toEqual([
      "MATRIX_SITE_ID",
    ]);
    expect(codes(diff("packages/core/src/x.ts", "+// workaround for BVG"))).toEqual(["MATRIX_SITE_ID"]);
    expect(codes(diff("packages/core/src/x.ts", '+  const ibmx = "subvgx";'))).toEqual([]);
  });

  it("tells the CSS unit vw from the site vw", () => {
    expect(codes(diff("packages/scene/src/x.ts", '+  const units = ["px", "vw", "vh"];'))).toEqual([]);
    expect(codes(diff("packages/scene/src/x.ts", "+  width: 100vw;"))).toEqual([]);
    expect(codes(diff("packages/scene/src/x.ts", '+  if (site.id === "vw") return;'))).toEqual([
      "MATRIX_SITE_ID",
    ]);
    expect(codes(diff("packages/core/src/x.ts", '+  fetch("https://vw.de/")'))).toEqual(["MATRIX_HOSTNAME"]);
  });

  it("does not treat a fixture name as a site id", () => {
    expect(codes(diff("packages/recreate/src/fluid.ts", "+  // fluid geometry between widths"))).toEqual([]);
  });

  it("only looks at packages/** for names", () => {
    expect(codes(diff("docs/recreate.md", "+bvg.de behind a CDN"))).toEqual([]);
  });

  it("rejects a changed gate default in mirror-core and the protocol", () => {
    expect(
      codes(
        diff(
          "packages/mirror-core/src/contracts.ts",
          "-      screenshotThreshold: z.number().default(0.97),",
          "+      screenshotThreshold: z.number().default(0.9),",
        ),
      ),
    ).toEqual(["GATE_DEFAULT", "GATE_DEFAULT"]);
    expect(
      codes(
        diff(
          "packages/recreate/src/pipeline.ts",
          "-const DEFAULT_GATES = { pixel: 1 };",
          "+const DEFAULT_GATES = { pixel: 2 };",
        ),
      ),
    ).toContain("GATE_DEFAULT");
    expect(codes(diff("packages/mirror-verify/src/checks/visual.ts", "+  const parityFloor = 0.5;"))).toEqual(
      ["GATE_DEFAULT"],
    );
  });

  it("rejects gates changed in any config, but ignores thresholds in a test", () => {
    expect(codes(diff(".harness/config.json", '+  "gates": { "pixel": 9 }'))).toContain("GATE_DEFAULT");
    expect(codes(diff("cdr.config.json", '+  "gates": { "pixel": 9 }'))).toEqual(["GATE_DEFAULT"]);
    expect(
      codes(diff("packages/mirror-core/test/contracts.test.ts", "+  screenshotThreshold: 0.5,")),
    ).toEqual([]);
  });

  it("rejects an added mask, skip or exclude in a config or a verify call", () => {
    expect(codes(diff("autopilot/site-overrides.yaml", "+mask: ['.hero']"))).toEqual(["MASK_ADDED"]);
    expect(codes(diff("cdr.config.json", '+  "exclude": ["/news"]'))).toEqual(["MASK_ADDED"]);
    expect(codes(diff("packages/mirror-verify/src/checks/visual.ts", "+  skip: ['visual'],"))).toEqual([
      "MASK_ADDED",
    ]);
    expect(
      codes(diff("packages/mirror/src/pipeline.ts", "+  await verifyStep(ctx, { mask: ['.x'] });")),
    ).toEqual(["MASK_ADDED"]);
  });

  it("leaves tsconfig excludes and ordinary local variables alone", () => {
    expect(codes(diff("packages/foo/tsconfig.json", '+  "exclude": ["dist"]'))).toEqual([]);
    expect(codes(diff("packages/foo/src/x.ts", "+  const skip = new Set<string>();"))).toEqual([]);
  });

  it("rejects edits under protected paths, including a rename out of one", () => {
    for (const path of [
      ".harness/autopilot/state.json",
      "autopilot/sites.yaml",
      "autopilot/baseline.json",
      "autopilot/registry.json",
    ])
      expect(codes(diff(path, "+x"))).toEqual(["PROTECTED_PATH"]);
    const rename =
      "diff --git a/autopilot/registry.json b/autopilot/x.json\nsimilarity index 100%\nrename from autopilot/registry.json\nrename to autopilot/x.json\n";
    expect(codes(rename)).toEqual(["PROTECTED_PATH"]);
  });

  it("rejects a fixer editing the policy check or the accept rule itself", () => {
    expect(codes(diff("packages/autopilot/src/policy.ts", "+// x"))).toEqual(["PROTECTED_PATH"]);
    expect(codes(diff("packages/autopilot/src/decide.ts", "+// x"))).toEqual(["PROTECTED_PATH"]);
  });

  it("allows rule files and lints, which a fix must add", () => {
    expect(codes(diff("autopilot/rules.json", '+{"rules": []}'))).toEqual([]);
    expect(codes(diff("autopilot/rules/x.md", "+# x"))).toEqual([]);
    expect(codes(diff("autopilot/lints/x.mjs", "+export default () => [];"))).toEqual([]);
  });

  it("rejects new type-check suppressions", () => {
    expect(codes(diff("packages/x/src/a.ts", "+  // @ts-ignore"))).toEqual(["TS_SUPPRESSION"]);
    expect(codes(diff("packages/x/src/a.ts", "+// @ts-nocheck"))).toEqual(["TS_SUPPRESSION"]);
    expect(codes(diff("packages/x/src/a.ts", "+  // @ts-expect-error nope"))).toEqual(["TS_SUPPRESSION"]);
    expect(codes(diff("packages/x/test/a.test.ts", "+  // @ts-expect-error wrong on purpose"))).toEqual([]);
  });

  it("rejects disabled tests and focused tests", () => {
    for (const line of [
      '+it.skip("a", () => {});',
      '+describe.skip("a", () => {});',
      '+test.todo("a");',
      '+xit("a", () => {});',
      '+it.only("a", () => {});',
    ])
      expect(codes(diff("packages/x/test/a.test.ts", line))).toEqual(["TEST_DISABLED"]);
  });

  it("rejects deleting a test file", () => {
    const deleted = [
      "diff --git a/packages/x/test/a.test.ts b/packages/x/test/a.test.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/packages/x/test/a.test.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-it('a', () => {});",
      "",
    ].join("\n");
    expect(codes(deleted)).toEqual(["TEST_DELETED"]);
  });

  it("gives a reason line per violation", () => {
    const { reason } = checkPolicy(diff("packages/x/src/a.ts", "+// @ts-ignore", "+// bvg"), sites);
    expect(reason.split("\n")).toHaveLength(2);
    expect(reason).toContain("TS_SUPPRESSION packages/x/src/a.ts:1");
  });
});

describe("parseUnifiedDiff", () => {
  it("is not fooled by removed lines that look like headers", () => {
    const text = diff("packages/x/src/a.ts", "--- not a header", "+++ not a header either");
    const [file] = parseUnifiedDiff(text);
    expect(file!.path).toBe("packages/x/src/a.ts");
    expect(file!.lines).toEqual([
      { kind: "-", text: "-- not a header", line: 1 },
      { kind: "+", text: "++ not a header either", line: 1 },
    ]);
  });

  it("reads new files and a summary per file", () => {
    const text = [
      "diff --git a/packages/x/src/new.ts b/packages/x/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/packages/x/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(text)[0]).toMatchObject({ path: "packages/x/src/new.ts", added: true });
    expect(summarizeDiff(text)).toBe("packages/x/src/new.ts +2 -0 (new)");
  });
});
