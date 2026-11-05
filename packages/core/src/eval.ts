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
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessConfig, HarnessEvent, ImagePart } from "@harness/protocol";
import { Harness, type HarnessOptions } from "./session.js";
import { git } from "./git.js";
import { runShell } from "./shell.js";
import { globToRegExp, truncateMiddle } from "./util.js";
import { ProviderRegistry } from "./providers/index.js";
import { collect } from "./providers/types.js";
import { findChrome } from "./tools/builtin.js";
import { VIEWPORTS, formatPageReport, probePage, type PageReport } from "./tools/browser.js";

export type EvalCheck =
  | { type: "command"; command: string; timeoutMs?: number }
  | { type: "fileContains"; path: string; pattern: string; flags?: string }
  | { type: "fileNotContains"; path: string; pattern: string; flags?: string }
  | { type: "onlyChanged"; paths: string[] }
  | PreviewCheck
  | JudgeCheck
  | { type: "maxFiles"; count: number };

/** Loads a page in headless Chrome (fails when no browser is installed). */
export interface PreviewCheck {
  type: "preview";
  /** HTML file (default index.html). */
  path?: string;
  /** Viewport names: small, phone, tablet, desktop (default phone + desktop). */
  viewports?: string[];
  /** Fail on uncaught exceptions or console.error (default true). */
  noJsErrors?: boolean;
  /** Fail on horizontal overflow at any viewport (default true). */
  noOverflow?: boolean;
  /** Fail when a visible control has no accessible name (default true). */
  namedControls?: boolean;
  /** Fail when an image fails to load (default true). */
  noBrokenImages?: boolean;
  /** Minimum loaded images at the widest viewport. */
  minImagesLoaded?: number;
  /** Only enforce minImagesLoaded when this environment variable is set (e.g. UNSPLASH_ACCESS_KEY). */
  imagesRequireEnv?: string;
  /** Minimum visible buttons. */
  minButtons?: number;
  /** Click every visible button and reload; fail on errors (default true). */
  exercise?: boolean;
}

/** Scores the result with a model against a rubric (1–5 per dimension). */
export interface JudgeCheck {
  type: "judge";
  /** Rubric dimensions; default: JUDGE_RUBRIC. */
  rubric?: string[];
  /** Pass when the mean score is at least this (default 4). */
  minScore?: number;
  /** HTML file to judge (default index.html). */
  path?: string;
  /** Judge model ref; falls back to the run's judge model, then the executor. */
  model?: string;
  /** Send phone and desktop screenshots (vision-capable judges only). */
  vision?: boolean;
}

export interface EvalTask {
  id: string;
  /** Starting repository under evals/fixtures; omit with `sandbox: true`. */
  fixture?: string;
  task: string;
  /** Workflow preset, or "chat" for a single chat turn like the web app's Chat mode. */
  workflow?: string;
  /** Run in an empty sandbox workspace, exactly like a new web app chat (sandbox prompt and skills). */
  sandbox?: boolean;
  /** Task group, selected with --suite (default "code"). */
  suite?: string;
  checks: EvalCheck[];
  timeoutMs?: number;
  maxTurns?: number;
}

export const JUDGE_RUBRIC = [
  "Visual design: deliberate hierarchy, typography and spacing; one coherent direction",
  "Restraint: free of generic AI-generated tropes (decorative gradients, emoji icons, shadowed card grids, filler copy)",
  "Responsiveness: works from a 320px phone to a wide desktop without overflow or cramped controls",
  "Functionality: every visible control works; state, persistence and edge cases are handled",
  "Content: specific, realistic copy and data; demo-only actions are labelled",
  "Accessibility: semantic markup, labelled controls, keyboard use, visible focus",
  "Craft: clean self-contained code, images handled well with credits when photos are used",
];

export interface CheckResult {
  passed: boolean;
  detail?: string;
  /** judge: mean score and per-dimension scores. */
  score?: number;
  scores?: Record<string, number>;
}

export interface EvalTaskResult {
  id: string;
  /** Repetition index (1-based) when --repeat is used. */
  run?: number;
  suite?: string;
  passed: boolean;
  runStatus: string;
  checks: ({ check: EvalCheck } & CheckResult)[];
  /** Files in the workspace after the run (sandbox tasks). */
  files?: string[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  wallMs: number;
  error?: string;
}

export interface EvalSummary {
  date: string;
  /** Free-form name for comparisons (e.g. "baseline", "web-app skill"). */
  label?: string;
  model: string;
  judgeModel?: string;
  suite?: string;
  workflow: string;
  passed: number;
  total: number;
  passRate: number;
  results: EvalTaskResult[];
}

/** Load tasks; `suite` "all" (or undefined with a filter) loads every suite, otherwise only that suite (default "code"). */
export function loadEvalTasks(evalsDir: string, filter?: string, suite?: string): EvalTask[] {
  const dir = join(evalsDir, "tasks");
  const want = suite ?? (filter ? "all" : "code");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalTask)
    .filter((t) => want === "all" || (t.suite ?? "code") === want)
    .filter((t) => !filter || t.id.includes(filter));
}

/** Project files, excluding VCS, harness data, dependencies and .gitignore. */
export function workspaceFiles(root: string): string[] {
  const out: string[] = [];
  const skip = new Set([".git", ".harness", "node_modules"]);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== ".gitignore") out.push(relative(root, p).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

interface CheckContext {
  task: EvalTask;
  /** Judge model ref and the registry that resolves it. */
  judge?: { ref: string; providers: ProviderRegistry };
  /** Cached page probes per path. */
  probes: Map<string, Promise<PageReport>>;
}

function probeFor(root: string, path: string, viewports: string[], ctx: CheckContext): Promise<PageReport> {
  const key = `${path}|${viewports.join(",")}`;
  let p = ctx.probes.get(key);
  if (!p) {
    const chrome = findChrome();
    if (!chrome) return Promise.reject(new Error("No headless Chrome/Chromium found (set HARNESS_CHROME)."));
    p = probePage(chrome, pathToFileURL(join(root, path)).href, {
      viewports: viewports.map((v) => VIEWPORTS[v]).filter(Boolean),
      exercise: true,
      screenshots: true,
    });
    ctx.probes.set(key, p);
  }
  return p;
}

function previewCheck(r: PageReport, c: PreviewCheck): CheckResult {
  const fails: string[] = [];
  const exerciseErrors = new Set(r.exercise?.errors ?? []);
  const loadErrors = r.errors.filter((e) => !exerciseErrors.has(e));
  if (c.noJsErrors !== false && loadErrors.length)
    fails.push(`JavaScript errors: ${loadErrors.slice(0, 3).join(" | ")}`);
  if (c.exercise !== false && exerciseErrors.size)
    fails.push(`errors while clicking: ${[...exerciseErrors].slice(0, 3).join(" | ")}`);
  for (const v of r.viewports) {
    if (c.noOverflow !== false && v.overflowPx > 0)
      fails.push(
        `overflow ${v.overflowPx}px at ${v.viewport.width}px (${v.overflowing.slice(0, 2).join(", ")})`,
      );
  }
  const broken = [...new Set(r.viewports.flatMap((v) => v.images.failed))];
  if (c.noBrokenImages !== false && broken.length) fails.push(`${broken.length} broken image(s)`);
  const unnamed = [...new Set(r.viewports.flatMap((v) => v.unnamed))];
  if (c.namedControls !== false && unnamed.length)
    fails.push(`unnamed controls: ${unnamed.slice(0, 2).join(" | ")}`);
  const widest = r.viewports[r.viewports.length - 1];
  const needImages = c.minImagesLoaded && (!c.imagesRequireEnv || process.env[c.imagesRequireEnv]);
  if (needImages && widest && widest.images.loaded < c.minImagesLoaded!)
    fails.push(`${widest.images.loaded} images loaded, expected ≥ ${c.minImagesLoaded}`);
  if (c.minButtons && widest && widest.counts.buttons < c.minButtons)
    fails.push(`${widest.counts.buttons} buttons, expected ≥ ${c.minButtons}`);
  return { passed: fails.length === 0, detail: fails.length ? fails.join("; ") : undefined };
}

const JUDGE_SYSTEM = `You are a strict senior product designer and front-end engineer judging a web app that an AI coding agent built from a short brief. Score each rubric dimension from 1 to 5:
5 = would ship as is; polished and deliberate.
4 = good; minor issues a reviewer would mention.
3 = acceptable but generic or with noticeable flaws.
2 = weak; several clear problems.
1 = broken or missing.
Judge only what the HTML source, the automated browser report and any screenshots show. Do not reward length. Reply with ONLY a JSON object in a \`\`\`json fenced block:
{"scores": {"<dimension number>": <1-5>, ...}, "notes": {"<dimension number>": "<one short sentence>", ...}, "summary": "<two sentences>"}`;

async function judgeCheck(root: string, c: JudgeCheck, ctx: CheckContext): Promise<CheckResult> {
  const path = c.path ?? "index.html";
  const file = join(root, path);
  if (!existsSync(file)) return { passed: false, detail: `${path} missing` };
  const ref = c.model ?? ctx.judge?.ref;
  if (!ref || !ctx.judge) return { passed: false, detail: "no judge model configured" };
  const rubric = c.rubric ?? JUDGE_RUBRIC;
  let report = "(browser report unavailable)";
  let images: ImagePart[] | undefined;
  try {
    const r = await probeFor(root, path, ["phone", "desktop"], ctx);
    report = formatPageReport(r, path, pathToFileURL(root).href + "/");
    if (c.vision)
      images = r.viewports
        .filter((v) => v.screenshot)
        .map((v) => ({ mimeType: "image/png", data: v.screenshot!, name: `${v.viewport.name}.png` }));
  } catch (e) {
    report = `(browser report unavailable: ${(e as Error).message})`;
  }
  const others = workspaceFiles(root).filter((f) => f !== path);
  const user = [
    `Brief:\n${ctx.task.task}`,
    `Rubric:\n${rubric.map((d, i) => `${i + 1}. ${d}`).join("\n")}`,
    `Automated browser report:\n${report}`,
    others.length ? `Other files in the project: ${others.join(", ")}` : "",
    `Source of ${path}:\n\`\`\`html\n${truncateMiddle(readFileSync(file, "utf8"), 90_000).text}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { provider, model } = ctx.judge.providers.resolve(ref);
  const res = await collect(
    provider.stream({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        images?.length ? { role: "user", content: user, images } : { role: "user", content: user },
      ],
    }),
  );
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(res.text) ?? /(\{[\s\S]*\})/.exec(res.text);
  let parsed: { scores?: Record<string, unknown>; notes?: Record<string, string>; summary?: string } = {};
  try {
    parsed = JSON.parse(m?.[1] ?? res.text);
  } catch {
    return { passed: false, detail: `judge reply was not JSON: ${res.text.slice(0, 200)}` };
  }
  const scores: Record<string, number> = {};
  rubric.forEach((d, i) => {
    const v = Number(parsed.scores?.[String(i + 1)] ?? parsed.scores?.[d]);
    if (Number.isFinite(v)) scores[d.split(":")[0]] = Math.max(1, Math.min(5, v));
  });
  const values = Object.values(scores);
  if (!values.length) return { passed: false, detail: "judge returned no scores" };
  const score = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  const min = c.minScore ?? 4;
  const notes = Object.entries(parsed.notes ?? {})
    .map(([k, v]) => `${rubric[Number(k) - 1]?.split(":")[0] ?? k}: ${v}`)
    .join(" ");
  return {
    passed: score >= min,
    score,
    scores,
    detail: `score ${score}/5 (min ${min}). ${parsed.summary ?? ""} ${notes}`.trim(),
  };
}

async function runCheck(root: string, c: EvalCheck, ctx?: CheckContext): Promise<CheckResult> {
  const cctx: CheckContext = ctx ?? { task: { id: "", task: "", checks: [] }, probes: new Map() };
  switch (c.type) {
    case "preview": {
      const path = c.path ?? "index.html";
      if (!existsSync(join(root, path))) return { passed: false, detail: `${path} missing` };
      try {
        return previewCheck(await probeFor(root, path, c.viewports ?? ["phone", "desktop"], cctx), c);
      } catch (e) {
        return { passed: false, detail: (e as Error).message };
      }
    }
    case "judge":
      try {
        return await judgeCheck(root, c, cctx);
      } catch (e) {
        return { passed: false, detail: `judge failed: ${(e as Error).message}` };
      }
    case "maxFiles": {
      const files = workspaceFiles(root);
      return {
        passed: files.length <= c.count,
        detail:
          files.length <= c.count ? undefined : `${files.length} files: ${files.slice(0, 10).join(", ")}`,
      };
    }
    case "command": {
      const r = await runShell(c.command, { cwd: root, timeoutMs: c.timeoutMs ?? 120_000 });
      return { passed: r.exitCode === 0, detail: r.exitCode === 0 ? undefined : r.output.slice(-1500) };
    }
    case "fileContains":
    case "fileNotContains": {
      // A glob path (e.g. "**/*.{html,css,js}") searches every matching file in the workspace.
      const paths = /[*?{]/.test(c.path)
        ? workspaceFiles(root).filter((f) => globToRegExp(c.path).test(f))
        : existsSync(join(root, c.path))
          ? [c.path]
          : [];
      if (!paths.length) return { passed: c.type === "fileNotContains", detail: `${c.path} missing` };
      const re = new RegExp(c.pattern, c.flags ?? "");
      const hits = paths.filter((f) => re.test(readFileSync(join(root, f), "utf8")));
      if (c.type === "fileContains")
        return {
          passed: hits.length > 0,
          detail: hits.length ? undefined : `pattern /${c.pattern}/ not found in ${c.path}`,
        };
      return {
        passed: hits.length === 0,
        detail: hits.length ? `pattern /${c.pattern}/ found in ${hits.join(", ")}` : undefined,
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

/** Run eval tasks in isolated temp copies of their fixtures (or empty sandbox workspaces). */
export async function runEvals(o: {
  evalsDir: string;
  model: string;
  workflow?: string;
  filter?: string;
  /** Task suite ("code", "apps", … or "all"). */
  suite?: string;
  /** Model for judge checks (default: the evaluated model). Prefer a stronger, different model. */
  judgeModel?: string;
  /** Run every task this many times. */
  repeat?: number;
  label?: string;
  harnessOptions?: HarnessOptions;
  configOverrides?: Partial<HarnessConfig>;
  onProgress?: (msg: string) => void;
  keep?: boolean;
}): Promise<EvalSummary> {
  const tasks = loadEvalTasks(o.evalsDir, o.filter, o.suite);
  const results: EvalTaskResult[] = [];
  const workflow = o.workflow ?? "quick-fix";
  const repeat = Math.max(1, Math.floor(o.repeat ?? 1));
  for (const t of tasks)
    for (let run = 1; run <= repeat; run++) {
      const label = repeat > 1 ? `${t.id} #${run}` : t.id;
      const base = mkdtempSync(join(tmpdir(), `harness-eval-${t.id}-`));
      let work = base;
      const started = Date.now();
      const res: EvalTaskResult = {
        id: t.id,
        ...(repeat > 1 ? { run } : {}),
        ...(t.suite ? { suite: t.suite } : {}),
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
        const harness = new Harness({
          // keep eval sessions out of the user's chat history
          sessionsDir: join(base, ".harness", "sessions"),
          ...o.harnessOptions,
          skipGlobalConfig: o.harnessOptions?.skipGlobalConfig ?? true,
          configOverrides: {
            ...(o.configOverrides ?? {}),
            ...(o.harnessOptions?.configOverrides ?? {}),
            models: { executor: o.model, planner: o.model, reviewer: o.model, summarizer: o.model },
            limits: { maxTurns: t.maxTurns ?? 40, timeoutMs: t.timeoutMs ?? 15 * 60_000 },
          },
        });
        const autoApprove = { permissions: true, plan: true, questions: "Use your best judgement." };
        let session;
        if (t.sandbox) {
          // Same code path as a new web chat: a fresh sandbox workspace (created inside the temp dir).
          const previous = process.env.HARNESS_SANDBOXES;
          process.env.HARNESS_SANDBOXES = join(base, "sandboxes");
          try {
            session = harness.createSession({ sandbox: { name: t.id }, autoApprove, title: t.id });
          } finally {
            if (previous === undefined) delete process.env.HARNESS_SANDBOXES;
            else process.env.HARNESS_SANDBOXES = previous;
          }
          work = session.projectRoot;
        } else {
          if (!t.fixture) throw new Error(`Task ${t.id} needs a fixture or sandbox: true`);
          cpSync(join(o.evalsDir, "fixtures", t.fixture), work, { recursive: true });
          git(work, ["init", "-q"]);
          git(work, ["-c", "user.email=eval@harness", "-c", "user.name=eval", "add", "-A"]);
          git(work, ["-c", "user.email=eval@harness", "-c", "user.name=eval", "commit", "-qm", "fixture"]);
          session = harness.createSession({
            projectPath: work,
            workflow: t.workflow && t.workflow !== "chat" ? t.workflow : workflow,
            permissionMode: "auto",
            autoApprove,
          });
        }
        o.onProgress?.(`▶ ${label}`);
        const mode = t.workflow ?? (t.sandbox ? "chat" : workflow);
        if (mode === "chat") {
          const r = await session.chat(t.task);
          res.runStatus = r.status === "completed" ? "success" : r.status;
        } else {
          session.workflow = mode;
          const r = await session.run(t.task);
          res.runStatus = r.status;
        }
        res.turns = session.budget.turns;
        res.inputTokens = session.budget.inputTokens;
        res.outputTokens = session.budget.outputTokens;
        res.cost = session.budget.cost;
        const config = session.config;
        const ctx: CheckContext = {
          task: t,
          probes: new Map(),
          judge: {
            ref: o.judgeModel ?? o.model,
            providers: new ProviderRegistry(config, o.harnessOptions?.providers),
          },
        };
        for (const c of t.checks) res.checks.push({ check: c, ...(await runCheck(work, c, ctx)) });
        res.passed = res.checks.every((c) => c.passed);
        if (t.sandbox) res.files = workspaceFiles(work);
        session.close();
        const errors = session.events.filter(
          (e): e is HarnessEvent & { type: "error" } => e.type === "error",
        );
        if (errors.length)
          res.error = errors
            .map((e) => e.message)
            .join("; ")
            .slice(0, 500);
      } catch (e) {
        res.error = (e as Error).message;
      } finally {
        res.wallMs = Date.now() - started;
        if (o.keep) o.onProgress?.(`  kept ${work}`);
        else rmSync(base, { recursive: true, force: true });
      }
      const judged = res.checks.find((c) => c.score !== undefined);
      o.onProgress?.(
        `${res.passed ? "✔" : "✘"} ${label} (${res.runStatus}, ${res.turns} turns, ${(res.wallMs / 1000).toFixed(1)} s${judged ? `, judge ${judged.score}/5` : ""})`,
      );
      results.push(res);
    }
  const passed = results.filter((r) => r.passed).length;
  return {
    date: new Date().toISOString(),
    ...(o.label ? { label: o.label } : {}),
    model: o.model,
    ...(o.judgeModel ? { judgeModel: o.judgeModel } : {}),
    ...(o.suite ? { suite: o.suite } : {}),
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
