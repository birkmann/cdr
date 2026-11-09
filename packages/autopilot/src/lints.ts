/**
 * Output lints (§5.4): `autopilot/lints/*.mjs`, each run on every app a cycle produced. A rule's lint catches the same
 * symptom when it comes back through a different code path than the one its regression test covers.
 *
 * A lint is a module with a default export: `({ appDir, site, stage }) => [{ message, file? }]` (async is fine).
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AutopilotPaths, Finding, MatrixResult, RuleEntry, StageName } from "./types.js";

export interface LintedApp {
  site: string;
  stage: StageName;
  dir: string;
}

export interface LintIssue {
  message: string;
  file?: string;
}

export interface LintResult {
  lint: string;
  app: LintedApp;
  issues: LintIssue[];
  /** The lint itself failed: a broken guard is reported rather than read as a pass. */
  crashed?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function lintFiles(paths: AutopilotPaths): string[] {
  const dir = join(paths.committed, "lints");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => join(dir, name));
}

/** The apps of a matrix result: every `mirrorApp` and `replicaApp` that exists on disk. */
export function appsOf(matrix: MatrixResult): LintedApp[] {
  const apps: LintedApp[] = [];
  for (const [site, stages] of Object.entries(matrix.sites)) {
    for (const summary of Object.values(stages)) {
      if (!summary) continue;
      for (const key of ["mirrorApp", "replicaApp"]) {
        const dir = summary.artifacts[key];
        if (dir && existsSync(dir)) apps.push({ site, stage: summary.stage, dir });
      }
    }
  }
  return apps;
}

const MARKER = "<<<AUTOPILOT_LINT>>>";

/** Runs in a child, so a lint that hangs can be killed and a lint merged during this process is read fresh. */
const CHILD = `
const [url, input] = process.argv.slice(1);
const report = (value) => process.stdout.write(${JSON.stringify(MARKER)} + JSON.stringify(value));
try {
  const module = await import(url);
  if (typeof module.default !== "function") throw new Error("no default export");
  report({ issues: await module.default(JSON.parse(input)) });
} catch (error) {
  report({ error: error?.message ?? String(error) });
}
`;

function runInChild(url: string, input: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // The environment is dropped on purpose: a lint inspects generated files and never needs provider keys.
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, url, JSON.stringify(input)], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const at = stdout.lastIndexOf(MARKER);
      if (at < 0) return reject(new Error(stderr.trim() || "the lint exited without a result"));
      const result = JSON.parse(stdout.slice(at + MARKER.length)) as { issues?: unknown; error?: string };
      if (result.error) reject(new Error(result.error));
      else resolve(result.issues);
    });
  });
}

function asIssues(value: unknown): LintIssue[] {
  if (!Array.isArray(value)) throw new Error("a lint must return an array of { message, file? }");
  return value.map((item) => {
    const issue = item as LintIssue;
    if (typeof issue?.message !== "string") throw new Error("a lint issue needs a message");
    return { message: issue.message, ...(typeof issue.file === "string" ? { file: issue.file } : {}) };
  });
}

/** Run every lint on every app. A lint that throws or hangs becomes a result with `crashed`, never a clean pass. */
export async function runLints(
  paths: AutopilotPaths,
  apps: LintedApp[],
  options: { timeoutMs?: number } = {},
): Promise<LintResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: LintResult[] = [];
  for (const file of lintFiles(paths)) {
    const lint = basename(file, ".mjs");
    for (const app of apps) {
      try {
        const input = { appDir: app.dir, site: app.site, stage: app.stage };
        const issues = asIssues(await runInChild(pathToFileURL(file).href, input, timeoutMs));
        results.push({ lint, app, issues });
      } catch (error) {
        results.push({ lint, app, issues: [], crashed: (error as Error).message });
      }
    }
  }
  return results;
}

/** One finding per lint and stage, across sites. A failing lint is a rule that was violated, so it fails a hard gate. */
export function lintFindings(results: LintResult[], rules: RuleEntry[]): Finding[] {
  const groups = new Map<
    string,
    { result: LintResult; sites: Set<string>; evidence: Set<string>; messages: string[] }
  >();
  for (const result of results) {
    if (!result.issues.length && !result.crashed) continue;
    const key = `${result.app.stage}:${result.crashed ? "LINT_CRASHED" : "LINT"}:${result.lint}`;
    const group = groups.get(key) ?? { result, sites: new Set(), evidence: new Set(), messages: [] };
    group.sites.add(result.app.site);
    if (result.crashed) group.messages.push(result.crashed);
    for (const issue of result.issues) {
      group.messages.push(issue.message);
      group.evidence.add(issue.file ? join(result.app.dir, issue.file) : result.app.dir);
    }
    groups.set(key, group);
  }
  return [...groups.entries()].map(([signature, group]) => {
    const rule = rules.find(
      (entry) =>
        entry.signature === signature ||
        entry.guards.some(
          (guard) => guard.kind === "lint" && basename(guard.file, ".mjs") === group.result.lint,
        ),
    );
    const [stage, code, cause] = signature.split(":") as [StageName, string, string];
    return {
      signature,
      stage,
      code,
      cause,
      message: group.messages.slice(0, 5).join("; "),
      sites: [...group.sites].sort(),
      rank: 1 as const,
      status: "new" as const,
      evidence: [...group.evidence].sort(),
      ...(rule ? { rule: rule.signature } : {}),
    };
  });
}
