import { describe, expect, it } from "vitest";
import { rankOf } from "../src/collect.js";
import type { StageIssue } from "../src/types.js";

const issue = (code: string, severity: StageIssue["severity"] = "error"): StageIssue => ({
  code,
  message: code,
  severity,
});

describe("rankOf", () => {
  it.each(["SEO_DIFF", "A11Y_REGRESSION", "PERF_REGRESSION", "LIGHTHOUSE_MISSING", "RAWHTML_SHARE"])(
    "ranks %s, an issue of an advisory check, as advisory even at error severity",
    (code) => expect(rankOf(issue(code), new Map(), "mirror")).toBe(3),
  );

  it("still ranks other error issues as failing a hard gate", () =>
    expect(rankOf(issue("VISUAL_DIFF"), new Map(), "mirror")).toBe(1));

  it("still lets a chain blocker outrank everything", () =>
    expect(rankOf(issue("BUILD_FAILED"), new Map(), "design-system")).toBe(0));
});
