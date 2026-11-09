import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  autopilotPaths,
  checkReproducibility,
  compareCycles,
  diffResults,
  diffTrees,
  normaliseGenerated,
  renderDiff,
  writeJson,
  writeMatrix,
  type FindingsFile,
  type MatrixResult,
} from "@harness/autopilot";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-diff-"));
  dirs.push(dir);
  return dir;
};

function tree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function result(
  cycle: number,
  gates: Record<string, boolean>,
  usage = 1,
  artifacts: Record<string, string> = {},
): MatrixResult {
  return {
    cycle,
    commit: "c",
    sites: {
      bvg: {
        mirror: {
          stage: "mirror",
          site: "bvg",
          status: "passed",
          wallClockMs: 60_000,
          gates: Object.entries(gates).map(([id, pass]) => ({ id, pass, hard: true })),
          issues: [],
          usage: { calls: 1, cachedCalls: 0, costUsd: usage },
          artifacts,
        },
      },
    },
  };
}

const findings = (cycle: number, ...signatures: string[]): FindingsFile => ({
  cycle,
  findings: signatures.map((signature) => ({
    signature,
    stage: "mirror",
    code: "x",
    message: "m",
    sites: ["bvg"],
    rank: 1,
    status: "new",
    evidence: [],
  })),
});

describe("diffResults", () => {
  it("names gates that flipped, regressions first, and findings that came and went", () => {
    const diff = diffResults(
      result(1, { a: true, b: false, c: true }),
      result(2, { a: false, b: true }),
      findings(1, "s1", "s2"),
      findings(2, "s2", "s3"),
    );
    expect(diff.regressions).toEqual(["bvg/mirror/a"]);
    expect(diff.flips.map((f) => f.key)).toEqual(["bvg/mirror/a", "bvg/mirror/c", "bvg/mirror/b"]);
    expect(diff.flips[1]).toEqual({ key: "bvg/mirror/c", from: true, to: null });
    expect(diff.appeared).toEqual(["s3"]);
    expect(diff.disappeared).toEqual(["s1"]);
  });

  it("renders a readable report", () => {
    const text = renderDiff(
      diffResults(result(1, { a: true }), result(2, { a: false }, 3), findings(1), findings(2)),
    );
    expect(text).toContain("Cycle 2 against cycle 1");
    expect(text).toContain("bvg/mirror/a: pass → fail");
    expect(text).toContain("$1.00 → $3.00");
  });
});

describe("compareCycles", () => {
  it("reads two cycles from disk and reports a missing one", () => {
    const paths = autopilotPaths(temp());
    writeMatrix(paths, result(1, { a: true }));
    writeJson(join(paths.cycleDir(1), "findings.json"), findings(1, "x"));
    writeMatrix(paths, result(2, { a: true }));
    writeJson(join(paths.cycleDir(2), "findings.json"), findings(2));
    expect(compareCycles(paths, 1, 2).disappeared).toEqual(["x"]);
    expect(() => compareCycles(paths, 1, 3)).toThrow(/cycle 3/);
  });
});

describe("normaliseGenerated", () => {
  it("removes timestamps, ports and cycle paths", () => {
    expect(normaliseGenerated("at 2026-11-09T10:00:00.123Z or 2026-11-09 10:00:00")).toBe(
      "at <timestamp> or <timestamp>",
    );
    expect(normaliseGenerated("t=1762678800000")).toBe("t=<timestamp>");
    expect(normaliseGenerated("http://127.0.0.1:43101/a and localhost:3000")).toBe(
      "http://127.0.0.1:<port>/a and localhost:<port>",
    );
    expect(normaliseGenerated("/x/cycles/12/bvg")).toBe("/x/cycles/<n>/bvg");
  });

  it("leaves other numbers alone", () => {
    expect(normaliseGenerated("width: 1440px; id 12345")).toBe("width: 1440px; id 12345");
  });
});

describe("diffTrees", () => {
  it("is empty for trees differing only in timestamps and build output", () => {
    const a = temp();
    const b = temp();
    tree(a, {
      "src/a.ts": "// 2026-01-01T00:00:00Z\nx",
      ".next/cache/a": "1",
      "node_modules/p/a.js": "1",
      "package-lock.json": "1",
    });
    tree(b, {
      "src/a.ts": "// 2027-01-01T00:00:00Z\nx",
      ".next/cache/a": "2",
      "node_modules/p/a.js": "2",
      "package-lock.json": "2",
    });
    expect(diffTrees(a, b)).toEqual([]);
  });

  it("lists changed, added and removed files, including binaries", () => {
    const a = temp();
    const b = temp();
    tree(a, { "a.ts": "1", "gone.ts": "x", "logo.png": "AAA" });
    tree(b, { "a.ts": "2", "new.ts": "x", "logo.png": "BBB" });
    expect(diffTrees(a, b)).toEqual(["a.ts", "gone.ts", "logo.png", "new.ts"]);
  });
});

describe("checkReproducibility", () => {
  it("is ok when gates and code match", () => {
    const a = temp();
    const b = temp();
    tree(a, { "x.ts": "same" });
    tree(b, { "x.ts": "same" });
    const report = checkReproducibility(
      result(1, { g: true }, 1, { mirrorApp: a }),
      result(2, { g: true }, 1, { mirrorApp: b }),
    );
    expect(report).toEqual({ ok: true, differing: {} });
  });

  it("reports differing gates and files per site", () => {
    const a = temp();
    const b = temp();
    tree(a, { "x.ts": "1" });
    tree(b, { "x.ts": "2" });
    const report = checkReproducibility(
      result(1, { g: true }, 1, { mirrorApp: a }),
      result(2, { g: false }, 1, { mirrorApp: b }),
    );
    expect(report.ok).toBe(false);
    expect(report.differing.bvg).toEqual(["gate mirror/g: true -> false", "mirror/mirrorApp/x.ts"]);
  });

  it("compares the coverage gate by value, since its threshold may have been raised", () => {
    const before = result(1, { "ds.coverage": true });
    const after = result(2, { "ds.coverage": false });
    before.sites.bvg!.mirror!.gates[0]!.value = 0.55;
    after.sites.bvg!.mirror!.gates[0]!.value = 0.55;
    expect(checkReproducibility(before, after).ok).toBe(true);
    after.sites.bvg!.mirror!.gates[0]!.value = 0.6;
    expect(checkReproducibility(before, after).ok).toBe(false);
  });
});
