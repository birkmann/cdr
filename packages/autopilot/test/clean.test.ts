import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autopilotPaths, cleanCycles, type AutopilotPaths } from "@harness/autopilot";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(cycles: number[]): AutopilotPaths {
  const root = mkdtempSync(join(tmpdir(), "autopilot-clean-"));
  dirs.push(root);
  const paths = autopilotPaths(root);
  const write = (path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "content");
  };
  for (const cycle of cycles) {
    const dir = paths.cycleDir(cycle);
    for (const file of [
      "REPORT.md",
      "report.json",
      "index.html",
      "findings.json",
      "FINDINGS.md",
      "matrix.json",
    ])
      write(join(dir, file));
    const stage = paths.stageDir(cycle, "bvg", "mirror");
    write(join(stage, "summary.json"));
    write(join(stage, "log.txt"));
    write(join(stage, "screens/mobile/original.png"));
    write(join(paths.projectDir(cycle, "bvg"), "out/mirror/index.html"));
  }
  write(join(paths.snapshots, "bvg/2026/raw/index.html"));
  return paths;
}

describe("cleanCycles", () => {
  it("keeps the newest cycles and only the reports of the older ones", () => {
    const paths = setup([1, 2, 3, 4]);
    const result = cleanCycles(paths, 2);
    expect(result.kept).toEqual([3, 4]);
    expect(result.cleaned).toEqual([1, 2]);
    expect(result.bytesFreed).toBeGreaterThan(0);

    for (const file of [
      "REPORT.md",
      "report.json",
      "index.html",
      "findings.json",
      "FINDINGS.md",
      "matrix.json",
    ])
      expect(existsSync(join(paths.cycleDir(1), file))).toBe(true);
    const stage = paths.stageDir(1, "bvg", "mirror");
    expect(existsSync(join(stage, "summary.json"))).toBe(true);
    expect(existsSync(join(stage, "log.txt"))).toBe(false);
    expect(existsSync(join(stage, "screens"))).toBe(false);
    expect(existsSync(paths.projectDir(1, "bvg"))).toBe(false);

    expect(existsSync(join(paths.stageDir(3, "bvg", "mirror"), "log.txt"))).toBe(true);
    expect(existsSync(join(paths.projectDir(4, "bvg"), "out/mirror/index.html"))).toBe(true);
  });

  it("never touches snapshots", () => {
    const paths = setup([1, 2]);
    cleanCycles(paths, 1);
    expect(existsSync(join(paths.snapshots, "bvg/2026/raw/index.html"))).toBe(true);
  });

  it("does nothing when there are few cycles", () => {
    const paths = setup([1]);
    expect(cleanCycles(paths, 3)).toEqual({ kept: [1], cleaned: [], bytesFreed: 0 });
  });

  it("handles a project with no cycles and a bad keep", () => {
    const root = mkdtempSync(join(tmpdir(), "autopilot-clean-"));
    dirs.push(root);
    expect(cleanCycles(autopilotPaths(root), 3)).toEqual({ kept: [], cleaned: [], bytesFreed: 0 });
    expect(() => cleanCycles(autopilotPaths(root), 0)).toThrow(/--keep/);
  });
});
