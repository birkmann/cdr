/**
 * The policy check of §5.5: a deterministic check on every candidate diff, before anything is built. It is what
 * keeps the loop from passing by lowering the bar. Hostnames and site ids come from `sites.yaml`.
 */
import type { SitesFile } from "./types.js";

export type PolicyCode =
  | "MATRIX_HOSTNAME"
  | "MATRIX_SITE_ID"
  | "GATE_DEFAULT"
  | "MASK_ADDED"
  | "PROTECTED_PATH"
  | "TS_SUPPRESSION"
  | "TEST_DISABLED"
  | "TEST_DELETED";

export interface PolicyViolation {
  code: PolicyCode;
  file: string;
  /** Line in the new file (or the old file for a removed line). */
  line?: number;
  detail: string;
}

export interface PolicyResult {
  ok: boolean;
  violations: PolicyViolation[];
  /** One line per violation, for the registry. */
  reason: string;
}

export interface DiffLine {
  kind: "+" | "-";
  text: string;
  line: number;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  added: boolean;
  deleted: boolean;
  lines: DiffLine[];
}

function headerPath(raw: string): string | null {
  const path = raw.trim().replace(/\t.*$/, "");
  if (path === "/dev/null") return null;
  const unquoted = path.startsWith('"') ? (JSON.parse(path) as string) : path;
  return unquoted.replace(/^[ab]\//, "");
}

/** Parse `git diff` output. Hunk sizes are honoured, so a removed line starting with `-- ` is not read as a header. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (!current) continue;
      if (line.startsWith("+")) {
        current.lines.push({ kind: "+", text: line.slice(1), line: newLine++ });
        newLeft--;
      } else if (line.startsWith("-")) {
        current.lines.push({ kind: "-", text: line.slice(1), line: oldLine++ });
        oldLeft--;
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file"
      } else {
        oldLine++;
        newLine++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      current = { path: match?.[2] ?? "", added: false, deleted: false, lines: [] };
      if (match && match[1] !== match[2]) current.oldPath = match[1];
      files.push(current);
    } else if (current) {
      if (line.startsWith("new file mode")) current.added = true;
      else if (line.startsWith("deleted file mode")) current.deleted = true;
      else if (line.startsWith("rename from ")) current.oldPath = line.slice("rename from ".length).trim();
      else if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length).trim();
      else if (line.startsWith("+++ ")) {
        const path = headerPath(line.slice(4));
        if (path) current.path = path;
      } else if (line.startsWith("--- ")) {
        const path = headerPath(line.slice(4));
        if (path && path !== current.path) current.oldPath = path;
      } else {
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk) {
          oldLine = Number(hunk[1]);
          oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
          newLine = Number(hunk[3]);
          newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
        }
      }
    }
  }
  return files;
}

/** Paths a fixer never touches (§5.5). The judge itself is included: a fixer rewriting it could accept anything. */
const PROTECTED: RegExp[] = [
  /^\.harness(\/|$)/,
  /^autopilot\/sites\.yaml$/,
  /^autopilot\/baseline\.json$/,
  /^autopilot\/registry\.json$/,
  /^packages\/autopilot\/src\/(policy|decide)\.ts$/,
];

/** Where gate defaults live (§5.5). */
const GATE_OWNERS = /^packages\/(protocol|mirror-core|mirror-verify|recreate|measure|mirror)\//;

const isTestPath = (path: string): boolean =>
  /(^|\/)(test|tests|__tests__)\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path);

/** A gate value or the name of a gate default, whichever package it sits in. */
const GATE_NAMES =
  /\b(screenshotThreshold|bboxTolerancePx|bboxPx|textSimilarity|responsivePixel|sweepHeightPct|heightPct|fittedSections|singleUse|DEFAULT_GATES)\b/;
const NUMERIC_ASSIGNMENT = /[:=]\s*-?\d|\.default\(\s*-?\d/;
const THRESHOLD_WORD = /\b\w*(threshold|tolerance|minparity|parity|similarity)\w*\b\s*[:=]\s*-?\d/i;
const GATES_KEY = /["']?\bgates\b["']?\s*:/;
const CONFIG_FILE = /\.(json|ya?ml)$/;
const NOT_A_SITE_CONFIG = /(^|\/)(package\.json|package-lock\.json|tsconfig[^/]*\.json|pnpm-lock\.yaml)$/;
const MASK_KEY = /["']?\b(mask|masks|skip|skips|exclude|excludes)\b["']?\s*:/;
const MASK_VERIFY_CALL = /\b(verify\w*|mask\w*)\s*\(.*\b(mask|skip|exclude)\w*\s*:/;
const TS_SUPPRESSION = /@ts-(ignore|nocheck)\b/;
const TS_EXPECT = /@ts-expect-error\b/;
const DISABLED_TEST =
  /\b(?:it|test|describe)\.(?:skip|todo|only)\b|\bx(?:it|describe|test)\s*\(|\b(?:it|test)\.fails\b/;

/** Site ids that are also CSS units or layout words: those only count next to a word that names a site. */
const AMBIGUOUS_IDS = new Set(["vw", "vh", "em", "ex", "ch", "px", "pt", "pc", "cm", "mm", "in", "fr"]);
const SITE_CONTEXT = "(?:site|host|hostname|domain|origin|brand|url|href)";

interface Needles {
  hostnames: string[];
  ids: { id: string; pattern: RegExp }[];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function needlesOf(sites: SitesFile): Needles {
  const hostnames = new Set<string>();
  for (const site of [...sites.sites, ...sites.holdout]) {
    const host = site.url ? hostnameOf(site.url) : null;
    if (!host) continue;
    hostnames.add(host);
    if (host.startsWith("www.")) hostnames.add(host.slice(4));
  }
  // Fixture sites are ours and named in fixtures; only ids of real sites may not appear in the code.
  const ids = [...sites.sites, ...sites.holdout.filter((s) => s.url)].map((s) => s.id);
  return {
    hostnames: [...hostnames].sort((a, b) => b.length - a.length),
    ids: [...new Set(ids)].map((id) => {
      const word = `\\b${escapeRegExp(id)}\\b`;
      if (!AMBIGUOUS_IDS.has(id.toLowerCase())) return { id, pattern: new RegExp(word, "i") };
      // `"vw"` in a unit list is CSS; `site === "vw"` is a site branch.
      const quoted = `["'\`]${escapeRegExp(id)}["'\`]`;
      return {
        id,
        pattern: new RegExp(
          `${SITE_CONTEXT}\\w*\\b.{0,40}${quoted}|${quoted}.{0,40}${SITE_CONTEXT}\\w*\\b`,
          "i",
        ),
      };
    }),
  };
}

function hostnameIn(text: string, hostname: string): boolean {
  const lower = text.toLowerCase();
  let at = lower.indexOf(hostname);
  while (at >= 0) {
    const before = at === 0 ? "" : lower[at - 1]!;
    const after = lower[at + hostname.length] ?? "";
    if (!/[a-z0-9-]/.test(before) && !/[a-z0-9-]/.test(after)) return true;
    at = lower.indexOf(hostname, at + 1);
  }
  return false;
}

function checkFile(file: DiffFile, needles: Needles): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  const add = (code: PolicyCode, detail: string, line?: number) =>
    out.push({ code, file: file.path, detail, ...(line ? { line } : {}) });

  for (const path of [file.path, file.oldPath]) {
    if (path && PROTECTED.some((pattern) => pattern.test(path))) {
      add("PROTECTED_PATH", `${path} may not be edited by a fixer`);
      break;
    }
  }

  const inPackages = file.path.startsWith("packages/");
  const isTest = isTestPath(file.path);
  if (file.deleted && inPackages && isTest) add("TEST_DELETED", "a test file was deleted");

  const configFile = CONFIG_FILE.test(file.path) && !NOT_A_SITE_CONFIG.test(file.path);
  const verifyFile = /verify/i.test(file.path);

  for (const { kind, text, line } of file.lines) {
    if (kind === "+" && inPackages) {
      const hostname = needles.hostnames.find((h) => hostnameIn(text, h));
      if (hostname) add("MATRIX_HOSTNAME", `hostname ${hostname} of the matrix in the code`, line);
      else {
        const id = needles.ids.find((n) => n.pattern.test(text));
        if (id) add("MATRIX_SITE_ID", `site id "${id.id}" of the matrix in the code`, line);
      }
    }
    if (!isTest) {
      const gateName = GATE_NAMES.exec(text);
      if (gateName && NUMERIC_ASSIGNMENT.test(text))
        add("GATE_DEFAULT", `gate default ${gateName[1]} changed: ${text.trim()}`, line);
      else if (GATE_OWNERS.test(file.path) && THRESHOLD_WORD.test(text))
        add("GATE_DEFAULT", `threshold changed: ${text.trim()}`, line);
      if (configFile && GATES_KEY.test(text))
        add("GATE_DEFAULT", `gates changed in a config: ${text.trim()}`, line);
    }
    if (kind === "+") {
      if (!isTest) {
        if (configFile && MASK_KEY.test(text)) add("MASK_ADDED", `added to a config: ${text.trim()}`, line);
        else if (MASK_VERIFY_CALL.test(text) || (verifyFile && MASK_KEY.test(text)))
          add("MASK_ADDED", `added to a verify call: ${text.trim()}`, line);
        if (TS_EXPECT.test(text)) add("TS_SUPPRESSION", `@ts-expect-error added: ${text.trim()}`, line);
      }
      if (TS_SUPPRESSION.test(text)) add("TS_SUPPRESSION", `type check suppressed: ${text.trim()}`, line);
      if (isTest && DISABLED_TEST.test(text)) add("TEST_DISABLED", `disabled test: ${text.trim()}`, line);
    }
  }
  return out;
}

/** Check a unified diff. A violation discards the candidate with the reason (§5.5). */
export function checkPolicy(diff: string, sites: SitesFile): PolicyResult {
  const needles = needlesOf(sites);
  const violations = parseUnifiedDiff(diff).flatMap((file) => checkFile(file, needles));
  return {
    ok: violations.length === 0,
    violations,
    reason: violations.map((v) => `${v.code} ${v.file}${v.line ? `:${v.line}` : ""}: ${v.detail}`).join("\n"),
  };
}

/** A short per-file `+added -removed` list, kept with each attempt for the NEEDS_HUMAN report. */
export function summarizeDiff(diff: string, limit = 1500): string {
  const lines = parseUnifiedDiff(diff).map((file) => {
    const added = file.lines.filter((l) => l.kind === "+").length;
    const removed = file.lines.filter((l) => l.kind === "-").length;
    return `${file.path} +${added} -${removed}${file.added ? " (new)" : ""}${file.deleted ? " (deleted)" : ""}`;
  });
  const text = lines.join("\n");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${lines.length} files)`;
}
