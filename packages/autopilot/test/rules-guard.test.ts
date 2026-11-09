import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { autopilotPaths, checkRules, readRules } from "@harness/autopilot";

// `rules --check` as part of `pnpm test` (§5.4): a merged rule whose guard disappeared fails the test suite.
const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("autopilot/rules.json in this repository", () => {
  it("every rule names a live test or lint", () => {
    expect(checkRules(root, readRules(autopilotPaths(root)))).toEqual([]);
  });
});
