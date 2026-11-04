import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBody, HarnessConfig, VerifyConfig } from "@harness/protocol";
import { runShell } from "./shell.js";
import { truncateMiddle } from "./util.js";

export interface DetectedStack {
  languages: string[];
  packageManager?: string;
  commands: { build?: string; test?: string; lint?: string };
}

export function detectStack(root: string): DetectedStack {
  const languages: string[] = [];
  const commands: DetectedStack["commands"] = {};
  let packageManager: string | undefined;
  const has = (f: string) => existsSync(join(root, f));

  if (has("package.json")) {
    languages.push(has("tsconfig.json") ? "typescript" : "javascript");
    packageManager =
      has("pnpm-lock.yaml") || has("pnpm-workspace.yaml")
        ? "pnpm"
        : has("yarn.lock")
          ? "yarn"
          : has("bun.lockb") || has("bun.lock")
            ? "bun"
            : "npm";
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      const s = pkg.scripts ?? {};
      const run = (name: string) =>
        packageManager === "npm" ? `npm run ${name}` : `${packageManager} run ${name}`;
      if (s.build) commands.build = run("build");
      else if (s.typecheck) commands.build = run("typecheck");
      if (s.test && !/no test specified/.test(s.test))
        commands.test = packageManager === "npm" ? "npm test" : `${packageManager} test`;
      if (s.lint) commands.lint = run("lint");
    } catch {
      /* ignore broken package.json */
    }
  }
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    languages.push("python");
    const py = has("pyproject.toml") ? readFileSync(join(root, "pyproject.toml"), "utf8") : "";
    if (py.includes("pytest") || has("tests") || has("pytest.ini")) commands.test ??= "python -m pytest -q";
    if (py.includes("ruff")) commands.lint ??= "ruff check .";
  }
  if (has("Cargo.toml")) {
    languages.push("rust");
    commands.build ??= "cargo build --quiet";
    commands.test ??= "cargo test --quiet";
  }
  if (has("go.mod")) {
    languages.push("go");
    commands.build ??= "go build ./...";
    commands.test ??= "go test ./...";
    commands.lint ??= "go vet ./...";
  }
  if (!commands.test && has("Makefile")) {
    const mk = readFileSync(join(root, "Makefile"), "utf8");
    if (/^test:/m.test(mk)) commands.test = "make test";
  }
  return { languages, packageManager, commands };
}

export interface VerifyStepResult {
  kind: "build" | "test" | "lint";
  command: string;
  exitCode: number;
  output: string;
}

export interface VerifyOutcome {
  ok: boolean;
  steps: VerifyStepResult[];
  /** True when nothing was configured or detected. */
  skipped: boolean;
}

export class VerifyRunner {
  readonly commands: { kind: "build" | "test" | "lint"; command: string }[];
  constructor(
    private readonly root: string,
    private readonly cfg: HarnessConfig,
    private readonly emit: (e: EventBody) => void,
    private readonly secretEnv: string[] = [],
  ) {
    const detected = detectStack(root).commands;
    const v: VerifyConfig = cfg.verify ?? {};
    const pick = (k: "build" | "test" | "lint") => (k in v ? v[k] : detected[k]);
    this.commands = (["build", "test", "lint"] as const)
      .map((kind) => ({ kind, command: pick(kind) ?? "" }))
      .filter((c) => c.command.trim().length > 0);
  }

  get maxAttempts(): number {
    return this.cfg.verify?.maxAttempts ?? 3;
  }

  async run(attempt: number, signal?: AbortSignal): Promise<VerifyOutcome> {
    if (!this.commands.length) return { ok: true, steps: [], skipped: true };
    const steps: VerifyStepResult[] = [];
    for (const c of this.commands) {
      const r = await runShell(c.command, {
        cwd: this.root,
        timeoutMs: this.cfg.verify?.timeoutMs ?? 600_000,
        signal,
        stripEnv: this.secretEnv,
        sandbox: this.cfg.sandbox,
        network: this.cfg.sandboxNetwork,
      });
      const output = truncateMiddle(r.output.trim(), 12_000).text;
      steps.push({ kind: c.kind, command: c.command, exitCode: r.exitCode, output });
      this.emit({
        type: "verify.result",
        kind: c.kind,
        command: c.command,
        exitCode: r.exitCode,
        output,
        attempt,
      });
      if (r.exitCode !== 0 && c.kind === "build") break; // tests are meaningless if the build fails
      if (signal?.aborted) break;
    }
    return { ok: steps.every((s) => s.exitCode === 0), steps, skipped: false };
  }
}

export function formatVerifyFailure(outcome: VerifyOutcome): string {
  const failed = outcome.steps.filter((s) => s.exitCode !== 0);
  return [
    "Verification FAILED. Fix the problems below, then stop (the harness re-runs verification automatically).",
    ...failed.map(
      (s) => `\n## ${s.kind}: \`${s.command}\` (exit ${s.exitCode})\n\`\`\`\n${s.output}\n\`\`\``,
    ),
  ].join("\n");
}
