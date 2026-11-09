// The design system of a captured page (plan §2.3): the workspace generated from the snapshot's brand reading and the
// rebuild pipeline's component sets, then built for real. Shared by `cdr design-system` and the autopilot stage.
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, relative } from "node:path";
import { findChrome } from "@harness/mirror";
import { formatPageReport, probePage, VIEWPORTS, type PageReport } from "@harness/core";
import {
  buildWorkspace,
  elements,
  lintWorkspaceCss,
  normalizeSpec,
  readUrl,
  specFromSnapshot,
  type BrandSpec,
  type Workspace,
} from "@harness/design-system";
import { normaliseUrl, pseudoTexts, runRecreate, RunDir, type RecreateResult } from "@harness/recreate";
import type { RecreateConfig } from "@harness/protocol";
import type { Gate, StageIssue } from "./types.js";

export type Framework = "react" | "lit" | "angular";

export interface DsBuildOptions {
  /** where `.harness/recreate/<run>` lives */
  projectDir: string;
  /** the workspace folder, absolute */
  out: string;
  /** the page; a snapshot replay URL or a page URL */
  url?: string;
  /** an existing recreate run of this project (its capture is reused, no browser and no live page) */
  run?: string;
  name?: string;
  prefix?: string;
  frameworks: Framework[];
  /** `recreate` config of the capture, e.g. `{ allowLocal: true, respectRobots: false }` */
  recreate?: RecreateConfig;
  /** capture widths; default: the page's own layout ranges */
  widths?: number[];
  /** with the page's own layout ranges: the widths later checks compare at, measured exactly */
  preferWidths?: number[];
  /** the consent the capture needs is given (`--yes`, or the matrix's snapshot) */
  yes: boolean;
  log(line: string): void;
  signal?: AbortSignal;
  /** Replaces command execution (tests). Default: real `npm`. */
  exec?: ExecFn;
  /** Replaces the docs preview check (tests). */
  preview?: PreviewFn;
  /** Skip `npm install` and friends: only generates and lints. Tests of emission use it; a real run never does. */
  generateOnly?: boolean;
  /** absent: the run's own recreate with `runRecreate`; tests inject a recorded result */
  recreateRun?: typeof runRecreate;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; output: string; ms: number }>;

export interface PreviewReport {
  viewport: string;
  theme: string;
  ok: boolean;
  errors: string[];
  overflowPx: number;
  detail: string;
}

export type PreviewFn = (docsDir: string, viewports: string[], themes: string[]) => Promise<PreviewReport[]>;

export interface DsCommandResult {
  command: string;
  ok: boolean;
  ms: number;
  outputTail: string;
}

/** `design-system/report.json` (§2.3). */
export interface DsReport {
  name: string;
  prefix: string;
  scope: string;
  out: string;
  runId: string;
  sourceUrl: string;
  frameworks: Framework[];
  brand: BrandSpec;
  provenance: Record<string, string>;
  contrast: {
    pairs: number;
    failing: { theme: string; fg: string; bg: string; ratio: number; min: number }[];
  };
  rawValues: { file: string; value: string; prop: string; selector: string }[];
  elements: { registered: number; expected: number; wrapped: number };
  site: { components: string[]; sections: string[]; tokens: { measured: number; aliased: number } };
  commands: DsCommandResult[];
  preview: PreviewReport[];
  naming: string;
}

export interface DsBuildResult {
  ok: boolean;
  runId: string;
  runDir: string;
  out: string;
  report: DsReport;
  gates: Gate[];
  issues: StageIssue[];
}

const consent = async () => ({ by: "auto" as const, at: new Date().toISOString(), mode: "yes" as const });

/** Runs a command, output collected (never echoed: it can hold paths and tokens of the environment). */
export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number; output: string; ms: number }> {
  return new Promise((res) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], signal });
    let output = "";
    const cap = (d: Buffer) => {
      output = (output + d.toString()).slice(-200_000);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ code: 1, output: `${output}\n${e.message}`, ms: Date.now() - t0 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, output, ms: Date.now() - t0 });
    });
  });
}

/** The environment for generated projects: no provider keys or other secrets (§3.4). */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1" };
  for (const name of Object.keys(env))
    if (
      /(_KEY|_TOKEN|_SECRET|PASSWORD|_PWD|API_?KEY)$/i.test(name) ||
      /^(ANTHROPIC|OPENAI|GEMINI|OPENROUTER|AWS)_/i.test(name)
    )
      delete env[name];
  return env;
}

/** Text files of a directory, keys relative to `root`. */
function readTextTree(dir: string, root = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) Object.assign(out, readTextTree(p, root));
    else if (/\.(tsx?|css|json|md)$/.test(name)) out[relative(root, p)] = readFileSync(p, "utf8");
  }
  return out;
}

/** Serves a built docs folder over http (the docs build is an app: `file://` would break its module scripts). */
function serveDir(dir: string): Promise<{ url: string; close(): void; server: Server }> {
  const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".woff2": "font/woff2",
    ".png": "image/png",
  };
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const file = join(dir, path === "/" ? "index.html" : decodeURIComponent(path));
      if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (!a || typeof a === "string") return reject(new Error("no port"));
      resolve({ url: `http://127.0.0.1:${a.port}/`, close: () => server.close(), server });
    });
  });
}

/** `check_preview` on the docs: phone and desktop in light and darkest: no console error, no overflow (§1). */
export async function checkDocsPreview(
  docsDir: string,
  viewports: string[],
  themes: string[],
  signal?: AbortSignal,
): Promise<PreviewReport[]> {
  const chrome = findChrome();
  const out: PreviewReport[] = [];
  if (!chrome) {
    return viewports.flatMap((viewport) =>
      themes.map((theme) => ({
        viewport,
        theme,
        ok: false,
        errors: ["no Chrome found (set HARNESS_CHROME)"],
        overflowPx: 0,
        detail: "not checked",
      })),
    );
  }
  const site = await serveDir(docsDir);
  // a workspace with the page's components has their catalogue and the page besides the docs' index
  const pages = ["", ...["site.html", "page.html"].filter((f) => existsSync(join(docsDir, f)))];
  try {
    for (const page of pages)
      for (const viewport of viewports)
        for (const theme of themes) {
          const vp = VIEWPORTS[viewport];
          const report: PageReport = await probePage(chrome, `${site.url}${page}?theme=${theme}`, {
            viewports: vp ? [vp] : undefined,
            signal,
            exercise: false,
          });
          out.push({
            viewport: page ? `${page} ${viewport}` : viewport,
            theme,
            // these two show the captured page's markup: its findings (in `detail`) are the page's, not the docs'
            ok: page ? report.errors.length === 0 : report.ok,
            errors: report.errors,
            overflowPx: Math.max(0, ...report.viewports.map((v) => v.overflowPx)),
            detail: formatPageReport(report, "docs", site.url).slice(0, 2000),
          });
        }
  } finally {
    site.close();
  }
  return out;
}

const gate = (id: string, pass: boolean, value?: Gate["value"], threshold?: Gate["threshold"]): Gate => ({
  id,
  pass,
  hard: true,
  ...(value !== undefined ? { value } : {}),
  ...(threshold !== undefined ? { threshold } : {}),
});

/** Recreation run for this page: the capture of the page and the pipeline's `components` stage. */
async function recreateRun(o: DsBuildOptions): Promise<RecreateResult> {
  const run = o.recreateRun ?? runRecreate;
  const request = {
    url: o.url ?? "",
    to: ["react-vite", "replica-nextjs"],
    style: "vanilla" as const,
    ...(o.widths?.length ? { widths: o.widths } : {}),
    ...(o.run ? { run: o.run, from: "components" as const } : {}),
  };
  return run(request as never, {
    projectRoot: o.projectDir,
    config: { allowLocal: true, respectRobots: false, ...o.recreate },
    ...(o.preferWidths?.length ? { preferWidths: o.preferWidths } : {}),
    consent,
    signal: o.signal,
    log: (m) => o.log(m),
    progress: (e) => {
      if (e.type === "recreate.stage")
        o.log(`recreate ${e.stage}: ${e.status}${e.detail ? ` (${e.detail})` : ""}`);
    },
  });
}

/** The brand reading: from the run's widest snapshot when there is one, otherwise the page itself. */
async function brandReading(
  o: DsBuildOptions,
  dir: RunDir,
  manifest: ReturnType<RunDir["manifest"]>,
  url: string,
): Promise<Partial<BrandSpec>> {
  const widths = (manifest.variants ?? []).map((v) => v.width).sort((a, b) => b - a);
  const snapshotFile = widths[0] !== undefined ? `capture/${widths[0]}.snapshot.json` : undefined;
  if (snapshotFile && dir.exists(snapshotFile))
    return specFromSnapshot(dir.readJson(snapshotFile), { name: o.name, url });
  // a run without a capture, or a first look at the page
  const r = await readUrl(url, {
    name: o.name,
    signal: o.signal,
    guard: { allowLocal: !!o.recreate?.allowLocal },
    respectRobots: o.recreate?.respectRobots,
  });
  return r.spec;
}

/** Commands that make a workspace: exit code per command, the tail of the output kept. */
async function buildAndCheck(
  o: DsBuildOptions,
  exec: ExecFn,
): Promise<{ commands: DsCommandResult[]; failed: DsCommandResult | null }> {
  const commands: DsCommandResult[] = [];
  const run = async (command: string, args: string[]) => {
    o.log(`$ npm ${args.join(" ")}`);
    const r = await exec("npm", args, o.out);
    const row: DsCommandResult = {
      command: `npm ${args.join(" ")}`,
      ok: r.code === 0,
      ms: r.ms,
      outputTail: r.output.slice(-2000),
    };
    commands.push(row);
    return row;
  };
  const steps: [string, string[]][] = [
    ["install", ["install", "--no-audit", "--no-fund", "--loglevel=error"]],
    ["build", ["run", "build"]],
    ["test", ["test"]],
    ["docs", ["run", "docs:build"]],
  ];
  if (o.frameworks.includes("angular")) steps.splice(2, 0, ["angular", ["run", "build:angular"]]);
  let failed: DsCommandResult | null = null;
  for (const [, args] of steps) {
    if (o.signal?.aborted) break;
    const row = await run(args[0]!, args);
    if (!row.ok) {
      failed = row;
      break;
    }
  }
  return { commands, failed };
}

const CAUSES: Record<string, string> = {
  install: "install",
  run: "build",
  test: "test",
};
const causeOf = (cmd: string) => {
  const words = cmd.split(" ");
  if (words[1] === "run") return words[2] === "docs:build" ? "docs" : "build";
  return CAUSES[words[1] ?? ""] ?? "build";
};

function writeFiles(dir: string, files: Record<string, string>, images: Record<string, Uint8Array>) {
  for (const [path, content] of Object.entries(files)) {
    const f = join(dir, path);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  for (const [path, bytes] of Object.entries(images)) {
    const f = join(dir, "packages/site/public", path);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, bytes);
  }
}

/** Generates the workspace of `ws` and returns its report data (no command run). */
export function generateWorkspace(
  spec: BrandSpec,
  o: Pick<DsBuildOptions, "frameworks" | "out">,
  site: {
    files: Record<string, string>;
    sets: { name: string; kind?: string }[];
    origin?: string;
    pageUrl?: string;
  },
): Workspace {
  const ws = buildWorkspace(spec, {
    frameworks: { angular: o.frameworks.includes("angular") },
    site,
  });
  // the components of an earlier generation would stay in the barrel's folder, and on macOS lend new ones their casing
  rmSync(join(o.out, "packages/site/src"), { recursive: true, force: true });
  writeFiles(o.out, ws.files, ws.site?.inlineImages ?? {});
  return ws;
}

/**
 * The whole chain of §2.3: capture (or a run's capture) → brand reading → workspace with the page's composites →
 * real `npm install`, `build`, `test`, `docs:build` → preview → `design-system/report.json`.
 */
export async function buildDesignSystem(o: DsBuildOptions): Promise<DsBuildResult> {
  if (!o.yes) throw new Error("Recreating a page needs consent: pass --yes.");
  if (!o.url && !o.run) throw new Error("Give a URL or --run <id>.");
  const issues: StageIssue[] = [];
  const gates: Gate[] = [];
  const result = await recreateRun(o);
  if (result.status === "cancelled") throw new Error("cancelled");
  const dir = new RunDir(o.projectDir, result.runId);
  const manifest = result.manifest;
  const url = manifest.finalUrl ?? manifest.request.url;
  if (!dir.exists("out/react-vite") || !dir.exists("components/sets.json"))
    throw new Error(
      `The recreation produced no components (${result.summary}); see ${dir.path("manifest.json")}.`,
    );
  o.log(`recreate run ${result.runId}: ${result.status}${result.summary ? ` (${result.summary})` : ""}`);

  const spec = normalizeSpec({
    ...(await brandReading(o, dir, manifest, url)),
    ...(o.name ? { name: o.name } : {}),
    ...(o.prefix ? { prefix: o.prefix } : {}),
  });
  const sets = dir.readJson<{ name: string; kind?: string }[]>("components/sets.json").map((d) => ({
    name: d.name,
    ...(d.kind ? { kind: d.kind } : {}),
  }));
  const files = readTextTree(dir.path("out/react-vite/src"));
  const snapshots = (manifest.variants ?? [])
    .map((v) => `capture/${v.width}.snapshot.json`)
    .filter((f) => dir.exists(f))
    .map((f) => dir.readJson<unknown>(f));
  const site = {
    pseudoTexts: pseudoTexts(snapshots),
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [`src/${k}`, v])),
    sets,
    origin: new URL(normaliseUrl(url)).origin,
    pageUrl: url,
  };
  const ws = generateWorkspace(spec, o, site);
  // the page's images and fonts are not package code: they ship in the site package's public folder for the replica
  const pub = dir.path("out/react-vite/public");
  if (existsSync(pub)) cpSync(pub, join(o.out, "packages/site/public"), { recursive: true, force: true });

  const lint = lintWorkspaceCss(ws.files);
  const failingContrast = ws.tokens.contrast.filter((c) => !c.pass);
  const els = elements();
  const wc = ws.files["packages/web-components/src/index.ts"] ?? "";
  const react = ws.files["packages/react/src/index.ts"] ?? "";
  const registered = els.filter((e) => wc.split(`'${spec.prefix}-${e.tag}': ${e.cls},`).length === 2).length;
  const wrapped = els.filter((e) => react.includes(`export const ${e.cls} = createComponent({`)).length;

  gates.push(gate("elements.registered", registered === els.length, registered, els.length));
  gates.push(gate("elements.reactWrappers", wrapped === els.length, wrapped, els.length));
  gates.push(gate("contrast.pairs", failingContrast.length === 0, failingContrast.length, 0));
  gates.push(gate("css.rawValues", lint.length === 0, lint.length, 0));
  for (const c of failingContrast)
    issues.push({
      code: "CONTRAST_FAIL",
      message: `${c.theme}: ${c.fg} on ${c.bg} = ${c.ratio} (min ${c.min})`,
      severity: "error",
    });
  for (const v of lint)
    issues.push({
      code: "RAW_VALUE_IN_CSS",
      cause: v.file.includes("site") ? "site" : "web-components",
      message: `${v.file}: ${v.raw.prop}: ${v.raw.value} (${v.raw.selector})`,
      severity: "error",
    });

  let commands: DsCommandResult[] = [];
  let preview: PreviewReport[] = [];
  let failed: DsCommandResult | null = null;
  if (!o.generateOnly) {
    const env = scrubbedEnv();
    const exec: ExecFn = o.exec ?? ((cmd, args, cwd) => runCommand(cmd, args, cwd, env, 900_000, o.signal));
    ({ commands, failed } = await buildAndCheck(o, exec));
    if (failed) {
      const cause = causeOf(failed.command);
      issues.push({
        code: "BUILD_FAILED",
        cause,
        message: `${failed.command} failed: ${failed.outputTail.slice(-300).replace(/\s+/g, " ")}`,
        severity: "error",
        evidence: [join(o.out, "design-system/report.json")],
      });
    }
    for (const [id, re] of [
      ["npm.install", /^npm install/],
      ["npm.build", /^npm run build/],
      ["npm.test", /^npm test/],
      ["npm.docs", /docs:build/],
    ] as const) {
      const row = commands.find((c) => re.test(c.command));
      gates.push(gate(id, !!row?.ok, row ? row.ok : "not run"));
    }
    if (!failed) {
      preview = await (o.preview ?? ((d, v, t) => checkDocsPreview(d, v, t, o.signal)))(
        join(o.out, "docs/dist"),
        ["phone", "desktop"],
        ["light", "darkest"],
      );
      const bad = preview.filter((p) => !p.ok || p.overflowPx > 0);
      gates.push(gate("docs.preview", bad.length === 0, bad.length, 0));
      for (const p of bad)
        issues.push({
          code: "PREVIEW_FAILED",
          cause: p.errors.length ? "console" : "overflow",
          message: `docs at ${p.viewport} in ${p.theme}: ${p.errors[0] ?? `overflow ${p.overflowPx}px`}`,
          severity: "error",
        });
      const tsc = commands.find((c) => /^npm run build$/.test(c.command));
      gates.push(gate("tsc", !!tsc?.ok, tsc?.ok ?? "not run"));
      if (tsc && !tsc.ok)
        issues.push({
          code: "BUILD_FAILED",
          cause: "tsc",
          message: "workspace tsc failed",
          severity: "error",
        });
    }
  }

  const report: DsReport = {
    name: spec.name,
    prefix: spec.prefix,
    scope: ws.names.scope,
    out: o.out,
    runId: result.runId,
    sourceUrl: url,
    frameworks: o.frameworks,
    brand: spec,
    provenance: spec.sources ?? {},
    contrast: {
      pairs: ws.tokens.contrast.length,
      failing: failingContrast.map((c) => ({
        theme: c.theme,
        fg: c.fg,
        bg: c.bg,
        ratio: c.ratio,
        min: c.min,
      })),
    },
    rawValues: lint.map((l) => ({ file: l.file, ...l.raw })),
    elements: { registered, expected: els.length, wrapped },
    site: {
      components: ws.site?.components ?? [],
      sections: ws.site?.sections ?? [],
      tokens: ws.site?.tokens ?? { measured: 0, aliased: 0 },
    },
    commands,
    preview,
    naming: manifest.gates.find((g) => g.name === "components")?.detail ?? "",
  };
  mkdirSync(join(o.out, "design-system"), { recursive: true });
  writeFileSync(
    join(o.out, "design-system", "pages.json"),
    `${JSON.stringify(ws.site?.pages ?? {}, null, 2)}\n`,
  );
  writeFileSync(join(o.out, "design-system", "composites.raw.css"), ws.site?.rawCss ?? "");
  writeFileSync(join(o.out, "design-system", "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const ok = gates.every((g) => g.pass) && !failed;
  return { ok, runId: result.runId, runDir: dir.path(), out: o.out, report, gates, issues };
}
