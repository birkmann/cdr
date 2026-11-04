import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig, HarnessEvent } from "@harness/protocol";
import { Harness, type HarnessOptions } from "./session.js";
import { git } from "./git.js";
import { runShell } from "./shell.js";
import { globToRegExp } from "./util.js";

export type EvalCheck =
  | { type: "command"; command: string; timeoutMs?: number }
  | { type: "fileContains"; path: string; pattern: string; flags?: string }
  | { type: "fileNotContains"; path: string; pattern: string; flags?: string }
  | { type: "onlyChanged"; paths: string[] };

export interface EvalTask {
  id: string;
  fixture: string;
  task: string;
  workflow?: string;
  checks: EvalCheck[];
  timeoutMs?: number;
}

export interface EvalTaskResult {
  id: string;
  passed: boolean;
  runStatus: string;
  checks: { check: EvalCheck; passed: boolean; detail?: string }[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  wallMs: number;
  error?: string;
}

export interface EvalSummary {
  date: string;
  model: string;
  workflow: string;
  passed: number;
  total: number;
  passRate: number;
  results: EvalTaskResult[];
}

export function loadEvalTasks(evalsDir: string, filter?: string): EvalTask[] {
  const dir = join(evalsDir, "tasks");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalTask)
    .filter((t) => !filter || t.id.includes(filter));
}

async function runCheck(root: string, c: EvalCheck): Promise<{ passed: boolean; detail?: string }> {
  switch (c.type) {
    case "command": {
      const r = await runShell(c.command, { cwd: root, timeoutMs: c.timeoutMs ?? 120_000 });
      return { passed: r.exitCode === 0, detail: r.exitCode === 0 ? undefined : r.output.slice(-1500) };
    }
    case "fileContains":
    case "fileNotContains": {
      const p = join(root, c.path);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      if (text === null) return { passed: c.type === "fileNotContains", detail: `${c.path} missing` };
      const hit = new RegExp(c.pattern, c.flags ?? "").test(text);
      return {
        passed: c.type === "fileContains" ? hit : !hit,
        detail: hit ? undefined : `pattern /${c.pattern}/ not found`,
      };
    }
    case "onlyChanged": {
      const changed = git(root, ["status", "--porcelain", "--untracked-files=all"])
        .out.split("\n")
        .filter(Boolean)
        .map((l) => l.slice(3).trim())
        .filter((f) => !f.startsWith(".harness/"));
      const res = c.paths.map(globToRegExp);
      const bad = changed.filter((f) => !res.some((r) => r.test(f)));
      return {
        passed: bad.length === 0,
        detail: bad.length ? `unexpected changes: ${bad.join(", ")}` : undefined,
      };
    }
  }
}

/** Run eval tasks in isolated temp copies of their fixtures. */
export async function runEvals(o: {
  evalsDir: string;
  model: string;
  workflow?: string;
  filter?: string;
  harnessOptions?: HarnessOptions;
  configOverrides?: Partial<HarnessConfig>;
  onProgress?: (msg: string) => void;
  keep?: boolean;
}): Promise<EvalSummary> {
  const tasks = loadEvalTasks(o.evalsDir, o.filter);
  const results: EvalTaskResult[] = [];
  const workflow = o.workflow ?? "quick-fix";
  for (const t of tasks) {
    const work = mkdtempSync(join(tmpdir(), `harness-eval-${t.id}-`));
    const started = Date.now();
    const res: EvalTaskResult = {
      id: t.id,
      passed: false,
      runStatus: "error",
      checks: [],
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      wallMs: 0,
    };
    try {
      cpSync(join(o.evalsDir, "fixtures", t.fixture), work, { recursive: true });
      git(work, ["init", "-q"]);
      git(work, ["-c", "user.email=eval@harness", "-c", "user.name=eval", "add", "-A"]);
      git(work, ["-c", "user.email=eval@harness", "-c", "user.name=eval", "commit", "-qm", "fixture"]);
      const harness = new Harness({
        // keep eval sessions out of the user's chat history
        sessionsDir: join(work, ".harness", "sessions"),
        ...o.harnessOptions,
        skipGlobalConfig: o.harnessOptions?.skipGlobalConfig ?? true,
        configOverrides: {
          ...(o.configOverrides ?? {}),
          ...(o.harnessOptions?.configOverrides ?? {}),
          models: { executor: o.model, planner: o.model, reviewer: o.model, summarizer: o.model },
          limits: { maxTurns: 40, timeoutMs: t.timeoutMs ?? 15 * 60_000 },
        },
      });
      const session = harness.createSession({
        projectPath: work,
        workflow: t.workflow ?? workflow,
        permissionMode: "auto",
        autoApprove: { permissions: true, plan: true, questions: "Use your best judgement." },
      });
      o.onProgress?.(`▶ ${t.id}`);
      const run = await session.run(t.task);
      res.runStatus = run.status;
      res.turns = session.budget.turns;
      res.inputTokens = session.budget.inputTokens;
      res.outputTokens = session.budget.outputTokens;
      res.cost = session.budget.cost;
      for (const c of t.checks) res.checks.push({ check: c, ...(await runCheck(work, c)) });
      res.passed = res.checks.every((c) => c.passed);
      session.close();
      const errors = session.events.filter((e): e is HarnessEvent & { type: "error" } => e.type === "error");
      if (errors.length)
        res.error = errors
          .map((e) => e.message)
          .join("; ")
          .slice(0, 500);
    } catch (e) {
      res.error = (e as Error).message;
    } finally {
      res.wallMs = Date.now() - started;
      if (!o.keep) rmSync(work, { recursive: true, force: true });
    }
    o.onProgress?.(
      `${res.passed ? "✔" : "✘"} ${t.id} (${res.runStatus}, ${res.turns} turns, ${(res.wallMs / 1000).toFixed(1)} s)`,
    );
    results.push(res);
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    date: new Date().toISOString(),
    model: o.model,
    workflow,
    passed,
    total: results.length,
    passRate: results.length ? passed / results.length : 0,
    results,
  };
}

export function saveEvalSummary(evalsDir: string, s: EvalSummary): string {
  const dir = join(evalsDir, "results");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${s.date.replace(/[:.]/g, "-")}.json`);
  writeFileSync(p, JSON.stringify(s, null, 2));
  return p;
}
