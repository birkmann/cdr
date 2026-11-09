/**
 * `autopilot/registry.json` (§4.3): every signature ever seen, its status and its attempts. Attempts are the memory
 * of the loop: a fixer reads every earlier attempt with its reason, and three discarded ones hand the signature to a
 * person (§7).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AutopilotPaths,
  Finding,
  FindingsFile,
  FixAttempt,
  Registry,
  RegistryEntry,
  RegistryStatus,
} from "./types.js";

/** Discarded attempts (since the last accepted one) after which a signature goes to a person (§7). */
export const NEEDS_HUMAN_AFTER = 3;

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Written to a temporary name first, so a crash never leaves half a file for a later resume. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, file);
}

export const registryFile = (paths: AutopilotPaths): string => join(paths.committed, "registry.json");

export function readRegistry(paths: AutopilotPaths): Registry {
  const data = readJson<Partial<Registry>>(registryFile(paths), {});
  return { entries: data.entries ?? {} };
}

/** Keys sorted, so the committed file diffs by entry. */
export function writeRegistry(paths: AutopilotPaths, registry: Registry): void {
  const entries: Registry["entries"] = {};
  for (const key of Object.keys(registry.entries).sort()) entries[key] = registry.entries[key]!;
  writeJson(registryFile(paths), { entries });
}

/** The stage a signature belongs to: its first segment. */
export const signatureStage = (signature: string): string => signature.split(":")[0] ?? "";

export interface MergeOptions {
  /**
   * What this cycle actually ran. An open signature that was not seen counts as fixed only when all of its sites and
   * its stage ran; without this nothing is marked fixed, because a partial run proves nothing about what it skipped.
   */
  ran?: { sites: string[]; stages: string[] };
}

const isFixed = (status: RegistryStatus): status is { fixed: number } =>
  typeof status === "object" && "fixed" in status;
const isFixing = (status: RegistryStatus): status is { fixing: string } =>
  typeof status === "object" && "fixing" in status;

/** Add one cycle's findings to the registry. Merging the same cycle twice changes nothing. */
export function mergeFindings(registry: Registry, file: FindingsFile, options: MergeOptions = {}): Registry {
  const next: Registry = { entries: { ...registry.entries } };
  const seen = new Set<string>();
  for (const finding of file.findings) {
    if (finding.status === "fixed") continue;
    seen.add(finding.signature);
    const existing = next.entries[finding.signature];
    if (!existing) {
      next.entries[finding.signature] = {
        signature: finding.signature,
        firstCycle: file.cycle,
        lastCycle: file.cycle,
        sites: [...new Set(finding.sites)].sort(),
        count: 1,
        status: "open",
        ...(finding.rule ? { rule: finding.rule } : {}),
        attempts: [],
      };
      continue;
    }
    const sameCycle = existing.lastCycle === file.cycle;
    next.entries[finding.signature] = {
      ...existing,
      lastCycle: Math.max(existing.lastCycle, file.cycle),
      sites: [...new Set([...existing.sites, ...finding.sites])].sort(),
      count: sameCycle ? existing.count : existing.count + 1,
      // A signature that was fixed and is back is a regression of the guard, which is worth its own label.
      status: isFixed(existing.status) && existing.status.fixed < file.cycle ? "regressed" : existing.status,
    };
  }
  if (options.ran) {
    const sites = new Set(options.ran.sites);
    const stages = new Set(options.ran.stages);
    for (const [signature, entry] of Object.entries(next.entries)) {
      if (seen.has(signature) || entry.lastCycle >= file.cycle) continue;
      if (entry.status === "accepted-advisory" || isFixed(entry.status) || isFixing(entry.status)) continue;
      if (!stages.has(signatureStage(signature))) continue;
      if (!entry.sites.every((site) => sites.has(site))) continue;
      next.entries[signature] = { ...entry, status: { fixed: file.cycle } };
    }
  }
  return next;
}

/** The label `inspect` gives a finding (§4.3), from what the registry knew before this cycle was merged. */
export function labelFinding(registry: Registry, signature: string): "new" | "recurring" | "regressed" {
  const entry = registry.entries[signature];
  if (!entry) return "new";
  return isFixed(entry.status) || entry.status === "regressed" ? "regressed" : "recurring";
}

export function markFixing(registry: Registry, signature: string, goalId: string): void {
  const entry = registry.entries[signature];
  if (entry) entry.status = { fixing: goalId };
}

/** Discarded attempts that count towards NEEDS_HUMAN: a fix that was accepted and later regressed starts over. */
export function discardedSinceAccepted(entry: RegistryEntry): number {
  let count = 0;
  for (let i = entry.attempts.length - 1; i >= 0; i--) {
    if (entry.attempts[i]!.verdict === "accepted") break;
    count++;
  }
  return count;
}

/** Record a verdict. Returns the entry; a third discard marks it NEEDS_HUMAN and the loop goes on with the rest. */
export function recordAttempt(
  registry: Registry,
  signature: string,
  attempt: FixAttempt,
  rule?: string,
): RegistryEntry {
  const entry: RegistryEntry =
    registry.entries[signature] ??
    (registry.entries[signature] = {
      signature,
      firstCycle: attempt.cycle,
      lastCycle: attempt.cycle,
      sites: [],
      count: 0,
      status: "open",
      attempts: [],
    });
  const accepted = entry.attempts.some((a) => a.verdict === "accepted");
  entry.attempts.push(attempt);
  if (attempt.verdict === "accepted") {
    entry.status = { fixed: attempt.cycle };
    if (rule) entry.rule = rule;
  } else if (discardedSinceAccepted(entry) >= NEEDS_HUMAN_AFTER) {
    entry.status = "NEEDS_HUMAN";
  } else {
    entry.status = accepted ? "regressed" : "open";
  }
  return entry;
}

/**
 * May a fixer take this signature? Running goals, people's decisions and solved signatures are left alone. A
 * `fixing` entry whose goal is not running was left by a crash, so it may be taken again.
 */
export function isFixable(
  entry: RegistryEntry | undefined,
  isGoalActive: (goalId: string) => boolean = () => false,
): boolean {
  if (!entry) return true;
  if (entry.status === "NEEDS_HUMAN" || entry.status === "accepted-advisory") return false;
  if (isFixing(entry.status)) return !isGoalActive(entry.status.fixing);
  return !isFixed(entry.status);
}

/** Findings the registry tracks but a person must look at, with every attempt (§7). */
export function needsHumanReport(registry: Registry): string {
  const entries = Object.values(registry.entries).filter((e) => e.status === "NEEDS_HUMAN");
  if (!entries.length) return "";
  const lines = ["## NEEDS_HUMAN", ""];
  for (const entry of entries) {
    lines.push(`### ${entry.signature}`, "", `Sites: ${entry.sites.join(", ") || "none"}`, "");
    for (const attempt of entry.attempts) {
      lines.push(`- ${attempt.goalId} (cycle ${attempt.cycle}, ${attempt.verdict}): ${attempt.reason}`);
      if (attempt.diffSummary) lines.push(`  ${attempt.diffSummary.replace(/\n/g, "\n  ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Findings of the cycle that are still in the way, in the order of §4.4. */
export function rankFindings(findings: Finding[], registry: Registry): Finding[] {
  const cycles = (f: Finding) => registry.entries[f.signature]?.count ?? 1;
  return [...findings].sort(
    (a, b) =>
      a.rank - b.rank ||
      b.sites.length - a.sites.length ||
      cycles(b) - cycles(a) ||
      a.signature.localeCompare(b.signature),
  );
}
