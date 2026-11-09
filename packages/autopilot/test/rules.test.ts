import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appsOf,
  autopilotPaths,
  checkRules,
  findTest,
  lintFindings,
  readRules,
  relatedRules,
  renderRuleMarkdown,
  ruleFileFor,
  runLints,
  signatureSlug,
  unionRulesJson,
  writeRules,
  type MatrixResult,
  type RuleEntry,
} from "@harness/autopilot";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "autopilot-rules-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const SIG = "mirror:visual.parity:CSS_MISSING";
const FILE = ruleFileFor(SIG);
const rule = (over: Partial<RuleEntry> = {}): RuleEntry => ({
  signature: SIG,
  file: FILE,
  seen: ["bvg (cycle 2)"],
  symptom: "visual.parity 0.91",
  rootCause: "noscript links stayed live",
  invariant: "noscript stylesheets stay inert",
  guards: [{ kind: "test", file: "packages/x/test/a.test.ts", name: "noscript stays inert" }],
  ...over,
});
const liveFiles = {
  [FILE]: `# ${SIG}\n`,
  "packages/x/test/a.test.ts": `import { it } from "vitest";\nit("noscript stays inert", () => {});\n`,
};

describe("signatures as names", () => {
  it("makes file and branch safe slugs and keeps the signature recognisable", () => {
    expect(signatureSlug(SIG)).toBe("mirror-visual.parity-CSS_MISSING");
    expect(signatureSlug("a:b/c d")).toBe("a-b-c-d");
    expect(signatureSlug("a..lock")).not.toContain("..");
  });

  it("shortens very long signatures to a stable, distinct name", () => {
    const long = `mirror:${"x".repeat(300)}`;
    expect(signatureSlug(long).length).toBeLessThanOrEqual(100);
    expect(signatureSlug(long)).toBe(signatureSlug(long));
    expect(signatureSlug(long)).not.toBe(signatureSlug(`${long}y`));
  });
});

describe("findTest", () => {
  it("finds live, disabled and missing tests", () => {
    expect(findTest(`it("a b", () => {});`, "a b")).toBe("live");
    expect(findTest("test('a b', () => {});", "a b")).toBe("live");
    expect(findTest('describe("a b", () => {});', "a b")).toBe("live");
    expect(findTest('it.each([1])("a b", () => {});', "a b")).toBe("live");
    expect(findTest(`it.skip("a b", () => {});`, "a b")).toBe("disabled");
    expect(findTest(`it("a c", () => {});`, "a b")).toBe("missing");
  });
});

describe("checkRules", () => {
  it("passes a rule with its file and a live test", () => {
    expect(checkRules(repo(liveFiles), [rule()])).toEqual([]);
  });

  it("fails a rule whose named test does not exist", () => {
    const root = repo({
      [FILE]: `# ${SIG}\n`,
      "packages/x/test/a.test.ts": `it("something else", () => {});\n`,
    });
    expect(checkRules(root, [rule()])).toEqual([expect.objectContaining({ code: "TEST_NOT_FOUND" })]);
  });

  it("fails a rule whose test file is gone", () => {
    const root = repo({ [FILE]: `# ${SIG}\n` });
    expect(checkRules(root, [rule()])).toEqual([expect.objectContaining({ code: "TEST_FILE_MISSING" })]);
  });

  it("fails a rule whose test is disabled", () => {
    const root = repo({
      [FILE]: `# ${SIG}\n`,
      "packages/x/test/a.test.ts": `it.skip("noscript stays inert", () => {});\n`,
    });
    expect(checkRules(root, [rule()])).toEqual([expect.objectContaining({ code: "TEST_DISABLED" })]);
  });

  it("fails a rule whose lint is missing or exports nothing", () => {
    const guards: RuleEntry["guards"] = [{ kind: "lint", file: "autopilot/lints/x.mjs" }];
    expect(checkRules(repo({ [FILE]: `# ${SIG}\n` }), [rule({ guards })])[0]!.code).toBe("LINT_MISSING");
    const root = repo({ [FILE]: `# ${SIG}\n`, "autopilot/lints/x.mjs": "export const a = 1;\n" });
    expect(checkRules(root, [rule({ guards })])[0]!.code).toBe("LINT_NO_DEFAULT_EXPORT");
  });

  it("fails a rule with no guard, a missing rule file or the wrong rule file", () => {
    expect(checkRules(repo(liveFiles), [rule({ guards: [] })])[0]!.code).toBe("NO_GUARD");
    expect(
      checkRules(repo({ "packages/x/test/a.test.ts": liveFiles["packages/x/test/a.test.ts"]! }), [rule()])[0]!
        .code,
    ).toBe("RULE_FILE_MISSING");
    expect(checkRules(repo({ ...liveFiles, [FILE]: "# other\n" }), [rule()])[0]!.code).toBe(
      "RULE_FILE_MISMATCH",
    );
  });
});

describe("rule files", () => {
  it("renders the format of the plan", () => {
    const text = renderRuleMarkdown({ ...rule(), fixedCycle: 3, goalId: "goal-1" });
    expect(text).toContain(`# ${SIG}`);
    expect(text).toContain("Seen: bvg (cycle 2) · Fixed: cycle 3 · Goal: goal-1");
    expect(text).toContain('test: packages/x/test/a.test.ts "noscript stays inert"');
  });

  it("writes one entry per signature and unions two versions", () => {
    const root = repo();
    const paths = autopilotPaths(root);
    writeRules(paths, [rule(), rule({ symptom: "newer" })]);
    expect(readRules(paths).map((r) => r.symptom)).toEqual(["newer"]);
    const a = JSON.stringify({ rules: [rule()] });
    const b = JSON.stringify({ rules: [rule({ signature: "b:B" })] });
    expect(
      (JSON.parse(unionRulesJson(a, b)!) as { rules: RuleEntry[] }).rules.map((r) => r.signature),
    ).toEqual(["b:B", SIG]);
    expect(unionRulesJson("not json", b)).toBeNull();
  });

  it("offers rules of the same stage and code to a fixer", () => {
    const rules = [rule(), rule({ signature: "design-system:BUILD_FAILED:tsc", symptom: "tsc fails" })];
    expect(
      relatedRules(rules, { signature: "mirror:visual.parity:ASSET", code: "visual.parity" }).map(
        (r) => r.signature,
      ),
    ).toEqual([SIG]);
    expect(relatedRules(rules, { signature: "replica:flow:x", code: "flow" })).toEqual([]);
  });
});

describe("output lints", () => {
  const appMatrix = (dir: string): MatrixResult => ({
    cycle: 1,
    commit: "x",
    sites: {
      bvg: {
        mirror: {
          stage: "mirror",
          site: "bvg",
          status: "passed",
          wallClockMs: 1,
          gates: [],
          issues: [],
          artifacts: { mirrorApp: dir },
        },
      },
    },
  });

  it("runs every lint on every app and turns issues into a finding", async () => {
    const root = repo({
      "autopilot/lints/no-foo.mjs": `export default ({ appDir, site }) => [{ message: site + " has foo", file: "page.html" }];\n`,
      "autopilot/lints/passes.mjs": `export default () => [];\n`,
    });
    const app = repo({ "page.html": "foo" });
    const paths = autopilotPaths(root);
    const results = await runLints(paths, appsOf(appMatrix(app)));
    expect(results).toHaveLength(2);
    const rules = [rule({ guards: [{ kind: "lint", file: "autopilot/lints/no-foo.mjs" }] })];
    const findings = lintFindings(results, rules);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      signature: "mirror:LINT:no-foo",
      sites: ["bvg"],
      rule: SIG,
      rank: 1,
      code: "LINT",
      cause: "no-foo",
    });
    expect(findings[0]!.evidence).toEqual([join(app, "page.html")]);
  });

  it("reports a lint that throws instead of reading it as a pass", async () => {
    const root = repo({
      "autopilot/lints/broken.mjs": `export default () => { throw new Error("boom"); };\n`,
    });
    const app = repo({ "page.html": "x" });
    const results = await runLints(autopilotPaths(root), appsOf(appMatrix(app)));
    expect(results[0]).toMatchObject({ crashed: "boom", issues: [] });
    expect(lintFindings(results, [])[0]!.signature).toBe("mirror:LINT_CRASHED:broken");
  });
});
