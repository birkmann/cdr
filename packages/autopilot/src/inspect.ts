// `autopilot inspect` (plan §4.3): the cycle's findings labelled new, recurring, regressed or fixed against the
// registry and the previous cycle, ranked as in §4.4, written to findings.json and FINDINGS.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { collectCycle, readJsonOr, readSummaries, type CollectedFinding } from "./collect.js";
import {
  type AutopilotPaths,
  type Finding,
  type FindingsFile,
  type FindingStatus,
  type Registry,
  type RegistryEntry,
  type RuleEntry,
} from "./types.js";

export function readRegistry(paths: Pick<AutopilotPaths, "committed">): Registry {
  return readJsonOr<Registry>(join(paths.committed, "registry.json"), { entries: {} });
}

function readRules(paths: Pick<AutopilotPaths, "committed">): Map<string, string> {
  const raw = readJsonOr<RuleEntry[] | { rules?: RuleEntry[] }>(join(paths.committed, "rules.json"), []);
  const rules = Array.isArray(raw) ? raw : (raw.rules ?? []);
  return new Map(rules.map((r) => [r.signature, r.file]));
}

const readFindings = (paths: Pick<AutopilotPaths, "cycleDir">, cycle: number) =>
  readJsonOr<FindingsFile | undefined>(join(paths.cycleDir(cycle), "findings.json"), undefined);

function isFixedStatus(s: RegistryEntry["status"] | undefined): boolean {
  return typeof s === "object" && s !== null && "fixed" in s;
}

function labelNew(
  f: CollectedFinding,
  entry: RegistryEntry | undefined,
  previous: FindingsFile | undefined,
): FindingStatus {
  if (entry && (isFixedStatus(entry.status) || entry.status === "regressed")) return "regressed";
  if (entry) return "recurring";
  if (previous?.findings.some((p) => p.signature === f.signature && p.status !== "fixed")) return "recurring";
  return "new";
}

const ORDER: Record<FindingStatus, number> = { new: 0, recurring: 1, regressed: 2, fixed: 3 };

/**
 * §4.4: chain blockers first, then hard gates, health, advisory. Within a rank more sites first, then more cycles.
 * `cycles` is how long the signature has been seen; a stable tie-break keeps the order reproducible.
 */
export function rankFindings(findings: Finding[], registry: Registry): Finding[] {
  const cycles = (f: Finding) => {
    const e = registry.entries[f.signature];
    return e ? e.lastCycle - e.firstCycle + 1 : 1;
  };
  return [...findings].sort(
    (a, b) =>
      a.rank - b.rank ||
      b.sites.length - a.sites.length ||
      cycles(b) - cycles(a) ||
      a.signature.localeCompare(b.signature),
  );
}

export interface InspectResult {
  file: FindingsFile;
  counts: Record<FindingStatus, number>;
  /** `new` findings or a regression: `inspect` exits 1 (plan §3.3). */
  hasNew: boolean;
}

/** Findings from before that are gone now: a stage that did not run this cycle cannot have fixed anything. */
function fixedFindings(
  paths: AutopilotPaths,
  cycle: number,
  previous: FindingsFile | undefined,
  currentSignatures: Set<string>,
): Finding[] {
  if (!previous) return [];
  const out: Finding[] = [];
  for (const p of previous.findings) {
    if (p.status === "fixed" || currentSignatures.has(p.signature)) continue;
    // health and reproducibility are judged over the whole site, not one stage's summary
    const ranEverywhere = p.sites.every((site) => {
      const summary =
        p.stage === "health" || p.stage === "reproducibility"
          ? Object.values(readSummaries(paths, cycle, site))[0]
          : readSummaries(paths, cycle, site)[p.stage];
      return !!summary && summary.status !== "skipped";
    });
    if (ranEverywhere) out.push({ ...p, status: "fixed" });
  }
  return out;
}

export function inspectCycle(paths: AutopilotPaths, cycle: number): InspectResult {
  const registry = readRegistry(paths);
  const rules = readRules(paths);
  const previous = cycle > 1 ? readFindings(paths, cycle - 1) : undefined;
  const collected = collectCycle(paths, cycle);
  const current: Finding[] = collected.map((f) => {
    const entry = registry.entries[f.signature];
    const rule = entry?.rule ?? rules.get(f.signature);
    return { ...f, status: labelNew(f, entry, previous), ...(rule ? { rule } : {}) };
  });
  const signatures = new Set(current.map((f) => f.signature));
  // open in the registry but gone now counts as fixed even when the previous cycle's file is missing
  const registryOpen: Finding[] = Object.values(registry.entries)
    .filter(
      (e) =>
        !signatures.has(e.signature) &&
        (e.status === "open" || (typeof e.status === "object" && "fixing" in e.status)),
    )
    .filter((e) => !previous?.findings.some((p) => p.signature === e.signature))
    .filter((e) => e.sites.every((s) => Object.keys(readSummaries(paths, cycle, s)).length > 0))
    .map((e) => ({
      signature: e.signature,
      stage: e.signature.split(":")[0] as Finding["stage"],
      code: e.signature.split(":")[1] ?? e.signature,
      message: `not seen in cycle ${cycle}; it was open since cycle ${e.firstCycle}`,
      sites: e.sites,
      rank: 3,
      status: "fixed",
      evidence: [],
      ...(e.rule ? { rule: e.rule } : {}),
    }));
  const fixed = [...fixedFindings(paths, cycle, previous, signatures), ...registryOpen];
  const ranked = rankFindings(current, registry);
  // findings.json is ranked; FINDINGS.md groups them in the order new, recurring, regressed, fixed
  const findings = [...ranked, ...rankFindings(fixed, registry)];
  const file: FindingsFile = { cycle, findings };
  const dir = paths.cycleDir(cycle);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "findings.json"), `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(join(dir, "FINDINGS.md"), findingsMarkdown(file, dir));
  const counts: Record<FindingStatus, number> = { new: 0, recurring: 0, regressed: 0, fixed: 0 };
  for (const f of findings) counts[f.status]++;
  return { file, counts, hasNew: counts.new > 0 || counts.regressed > 0 };
}

const RANK_LABEL = ["blocks the chain", "fails a hard gate", "health", "advisory"];

export function findingsMarkdown(file: FindingsFile, relTo?: string): string {
  const rel = (p: string) => (relTo ? relative(relTo, p) || p : p);
  const out: string[] = [`# Findings, cycle ${file.cycle}`, ""];
  const groups: FindingStatus[] = ["new", "recurring", "regressed", "fixed"];
  const headings: Record<FindingStatus, string> = {
    new: "New",
    recurring: "Recurring",
    regressed: "Regressed (fixed before, back now)",
    fixed: "Fixed (open before, gone now)",
  };
  if (!file.findings.length) out.push("No findings.", "");
  for (const group of groups) {
    const fs = file.findings
      .filter((f) => f.status === group)
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.rank - b.rank);
    if (!fs.length) continue;
    out.push(`## ${headings[group]} (${fs.length})`, "");
    for (const f of fs) {
      out.push(`### \`${f.signature}\``, "");
      out.push(`- ${RANK_LABEL[f.rank]} · sites: ${f.sites.join(", ")}`);
      if (f.rule) out.push(`- guarded by rule: \`${f.rule}\``);
      out.push(`- ${f.message.split("\n")[0]!}`);
      if (f.evidence.length) {
        out.push("- evidence:");
        for (const e of f.evidence.slice(0, 8)) out.push(`  - \`${rel(e)}\``);
        if (f.evidence.length > 8) out.push(`  - …and ${f.evidence.length - 8} more`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}
