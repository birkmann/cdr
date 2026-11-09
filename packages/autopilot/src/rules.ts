/**
 * Rules (§5.4): the durable output of a fix. A rule names at least one live guard, a regression test or an output
 * lint, so the finding cannot come back silently. `rules --check` fails on a rule whose guard is gone.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, signatureStage, writeJson } from "./registry.js";
import type { AutopilotPaths, Finding, RuleEntry } from "./types.js";

const MAX_SLUG = 100;

/** A signature as a file name or the tail of a branch name: `mirror:visual.parity:CSS_MISSING` → `mirror-visual.parity-CSS_MISSING`. */
export function signatureSlug(signature: string): string {
  const slug = signature
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (slug.length <= MAX_SLUG)
    return slug || createHash("sha256").update(signature).digest("hex").slice(0, 12);
  const hash = createHash("sha256").update(signature).digest("hex").slice(0, 8);
  return `${slug.slice(0, MAX_SLUG - 9).replace(/[-.]+$/g, "")}-${hash}`;
}

/** Repository-relative path of a signature's rule file. */
export const ruleFileFor = (signature: string): string => `autopilot/rules/${signatureSlug(signature)}.md`;

export const rulesFile = (paths: AutopilotPaths): string => join(paths.committed, "rules.json");

export function readRules(paths: AutopilotPaths): RuleEntry[] {
  return readJson<{ rules?: RuleEntry[] }>(rulesFile(paths), {}).rules ?? [];
}

/** One entry per signature, sorted, so merges of independent fixes stay mechanical. */
export function writeRules(paths: AutopilotPaths, rules: RuleEntry[]): void {
  writeJson(rulesFile(paths), { rules: normaliseRules(rules) });
}

export function normaliseRules(rules: RuleEntry[]): RuleEntry[] {
  const bySignature = new Map(rules.map((rule) => [rule.signature, rule]));
  return [...bySignature.values()].sort((a, b) => a.signature.localeCompare(b.signature));
}

/** The markdown form of §5.4. */
export function renderRuleMarkdown(rule: RuleEntry): string {
  const header = [
    rule.seen.length ? `Seen: ${rule.seen.join(", ")}` : "",
    rule.fixedCycle !== undefined ? `Fixed: cycle ${rule.fixedCycle}` : "",
    rule.goalId ? `Goal: ${rule.goalId}` : "",
  ].filter(Boolean);
  const guards = rule.guards.map((guard) =>
    guard.kind === "test" ? `test: ${guard.file} ${JSON.stringify(guard.name)}` : `lint: ${guard.file}`,
  );
  return [
    `# ${rule.signature}`,
    header.join(" · "),
    "## Symptom",
    rule.symptom,
    "## Root cause",
    rule.rootCause,
    "## Invariant",
    rule.invariant,
    "## Guard",
    ...guards,
    "",
  ].join("\n");
}

export type RuleProblemCode =
  | "NO_GUARD"
  | "RULE_FILE_MISSING"
  | "RULE_FILE_MISMATCH"
  | "TEST_FILE_MISSING"
  | "TEST_NOT_FOUND"
  | "TEST_DISABLED"
  | "LINT_MISSING"
  | "LINT_NO_DEFAULT_EXPORT";

export interface RuleProblem {
  signature: string;
  code: RuleProblemCode;
  detail: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How a test of this name is declared in a test file, if it is. `describe` blocks count: a rule may name a group. */
export function findTest(source: string, name: string): "live" | "disabled" | "missing" {
  const quoted = ['"', "'", "`"].map((q) => `${q}${escapeRegExp(name)}${q}`).join("|");
  const pattern = new RegExp(
    `\\b(?:it|test|describe)((?:\\.[A-Za-z]+)*)\\s*(?:\\([^()]*\\))?\\s*\\(\\s*(?:${quoted})`,
    "g",
  );
  let found: "live" | "disabled" | "missing" = "missing";
  for (const match of source.matchAll(pattern)) {
    const modifiers = match[1] ?? "";
    if (/\.(skip|todo|fails)\b/.test(modifiers)) found = "disabled";
    else return "live";
  }
  return found;
}

/** Every problem of the rules at `root`. Empty means every rule has a live guard. */
export function checkRules(root: string, rules: RuleEntry[]): RuleProblem[] {
  const problems: RuleProblem[] = [];
  for (const rule of rules) {
    const problem = (code: RuleProblemCode, detail: string) =>
      problems.push({ signature: rule.signature, code, detail });
    if (!rule.guards?.length) problem("NO_GUARD", "the rule names no test and no lint");
    const ruleFile = join(root, rule.file);
    if (!existsSync(ruleFile)) problem("RULE_FILE_MISSING", `${rule.file} does not exist`);
    else if (!readFileSync(ruleFile, "utf8").split("\n", 1)[0]?.includes(rule.signature))
      problem("RULE_FILE_MISMATCH", `the first line of ${rule.file} does not name ${rule.signature}`);
    for (const guard of rule.guards ?? []) {
      const file = join(root, guard.file);
      if (guard.kind === "test") {
        if (!existsSync(file)) {
          problem("TEST_FILE_MISSING", `${guard.file} does not exist`);
          continue;
        }
        const state = findTest(readFileSync(file, "utf8"), guard.name);
        if (state === "missing") problem("TEST_NOT_FOUND", `${guard.file} has no test named "${guard.name}"`);
        if (state === "disabled") problem("TEST_DISABLED", `"${guard.name}" in ${guard.file} is disabled`);
      } else if (!existsSync(file)) {
        problem("LINT_MISSING", `${guard.file} does not exist`);
      } else if (!/\bexport\s+default\b/.test(readFileSync(file, "utf8"))) {
        problem("LINT_NO_DEFAULT_EXPORT", `${guard.file} has no default export`);
      }
    }
  }
  return problems;
}

export function ruleForSignature(rules: RuleEntry[], signature: string): RuleEntry | undefined {
  return rules.find((rule) => rule.signature === signature);
}

/** Rules a fixer should read: this signature, or the same stage and a symptom that names the finding's code (§5.4). */
export function relatedRules(rules: RuleEntry[], finding: Pick<Finding, "signature" | "code">): RuleEntry[] {
  const stage = signatureStage(finding.signature);
  return rules.filter(
    (rule) =>
      rule.signature === finding.signature ||
      (signatureStage(rule.signature) === stage &&
        (rule.signature.includes(finding.code) || rule.symptom.includes(finding.code))),
  );
}

/** Union of two versions of `rules.json`: independent fixes each add one entry, so this is the only sane merge. */
export function unionRulesJson(ours: string, theirs: string): string | null {
  try {
    const left = (JSON.parse(ours) as { rules?: RuleEntry[] }).rules ?? [];
    const right = (JSON.parse(theirs) as { rules?: RuleEntry[] }).rules ?? [];
    return JSON.stringify({ rules: normaliseRules([...left, ...right]) }, null, 2) + "\n";
  } catch {
    return null;
  }
}
