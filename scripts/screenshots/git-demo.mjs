// A small reviewable change set, created only in the screenshot's temporary clone.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

export function prepareGitDemo(repo) {
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  const source = "packages/core/src/permission-summary.ts";
  writeFileSync(join(repo, source), `export type PermissionMode = "ask" | "auto" | "yolo";

export function describePermissionMode(mode: PermissionMode): string {
  if (mode === "ask") return "Ask before making changes";
  if (mode === "auto") return "Approve routine work automatically";
  return "Allow tools without prompting";
}
`);
  git("add", source);
  git("commit", "-qm", "Add permission mode descriptions");
  git("checkout", "-qb", "feat/permission-summary");
  writeFileSync(join(repo, source), `export type PermissionMode = "ask" | "auto" | "yolo";

export interface PermissionSummary {
  label: string;
  description: string;
  confirmation: string;
}

const SUMMARIES: Record<PermissionMode, PermissionSummary> = {
  ask: {
    label: "Ask",
    description: "Stay in control of every change.",
    confirmation: "Confirm edits and non-read-only commands.",
  },
  auto: {
    label: "Auto",
    description: "Keep routine work moving.",
    confirmation: "Confirm risky or unconfined commands.",
  },
  yolo: {
    label: "Full access",
    description: "Run tools without interactive approval.",
    confirmation: "Project restrictions and deny rules still apply.",
  },
};

/** Display copy only; PermissionPolicy enforces the rules. */
export function permissionSummary(mode: PermissionMode) {
  return { ...SUMMARIES[mode] };
}

/** Keep the string API for existing callers. */
export function describePermissionMode(mode: PermissionMode): string {
  return permissionSummary(mode).description;
}
`);
  const test = "packages/core/test/permission-summary.test.ts";
  writeFileSync(join(repo, test), `import { describe, expect, it } from "vitest";
import { permissionSummary, describePermissionMode } from "../src/permission-summary.js";

describe("permission summaries", () => {
  it.each(["ask", "auto", "yolo"] as const)("describes %s", (mode) => {
    const summary = permissionSummary(mode);
    expect(summary.label).toBeTruthy();
    expect(summary.confirmation).toBeTruthy();
    expect(describePermissionMode(mode)).toBe(summary.description);
  });

  it("keeps built-in restrictions visible for full access", () => {
    expect(permissionSummary("yolo").confirmation).toContain("deny rules");
  });

  it("returns a fresh summary", () => {
    permissionSummary("ask").label = "Changed";
    expect(permissionSummary("ask").label).toBe("Ask");
  });
});
`);
  writeFileSync(join(repo, "docs/permission-modes.md"), `# Permission modes

| Mode | When CDR asks |
| --- | --- |
| Ask | Before edits and commands that are not read-only |
| Auto | Before risky commands or work outside the sandbox |
| Full access | No interactive approval; deny rules still apply |

The summary helper supplies display copy. PermissionPolicy remains the enforcement layer.
`);
  git("add", source, test);
}
