import { resolve } from "node:path";
import { loadConfig, type Harness } from "@harness/core";
import { buildDesignSystem, type DsBuildResult, type Framework } from "@harness/autopilot";

export interface DesignSystemCliContext {
  cwd: string;
  out: NodeJS.WritableStream;
  harness?: Harness;
  /** Replaces the build (tests). */
  build?: typeof buildDesignSystem;
}

export interface DesignSystemArgs {
  url?: string;
  run?: string;
  out: string;
  frameworks: Framework[];
  name?: string;
  prefix?: string;
  yes: boolean;
  json: boolean;
}

export const DESIGN_SYSTEM_USAGE = `Usage: cdr design-system <url|--run id> --out <dir> [--frameworks react[,lit,angular]] [--name <name>] [--prefix <prefix>] [--yes] [--json]

  <url>                the page to read (or --run <id>, a recreate run of this project: reads its capture, no browser)
  --out <dir>          the workspace folder
  --frameworks <list>  react (default), lit, angular. Tokens, web components and React are always part of it.
  --name, --prefix     override the brand name and the element prefix (2 to 12 lowercase letters)
  --yes                consent to capturing the page (required; recorded as auto)
  --json               print the result as JSON
`;

const FRAMEWORKS: Framework[] = ["react", "lit", "angular"];

/** Pure: the arguments, or the reason they are wrong. */
export function parseDesignSystemArgs(argv: string[]): DesignSystemArgs | { error: string } {
  let url: string | undefined;
  let run: string | undefined;
  let out: string | undefined;
  let frameworksArg: string | undefined;
  let name: string | undefined;
  let prefix: string | undefined;
  let yes = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--json") json = true;
    else if (["--run", "--out", "--frameworks", "--name", "--prefix"].includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--run") run = v;
      else if (a === "--out") out = v;
      else if (a === "--frameworks") frameworksArg = v;
      else if (a === "--name") name = v;
      else prefix = v;
    } else if (a.startsWith("-")) return { error: `Unknown option ${a}` };
    else if (url === undefined) url = a;
    else return { error: `Unexpected argument ${a}` };
  }
  if (url && run) return { error: "Give a URL or --run <id>, not both." };
  if (!url && !run) return { error: "Give a URL or --run <id>." };
  if (!out) return { error: "--out <dir> is required." };
  if (prefix !== undefined && !/^[a-z][a-z0-9]{1,11}$/.test(prefix))
    return {
      error: `--prefix "${prefix}" must be 2 to 12 lowercase letters or digits, starting with a letter.`,
    };
  const frameworks = (frameworksArg ?? "react")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  const unknown = frameworks.filter((f) => !FRAMEWORKS.includes(f as Framework));
  if (unknown.length) return { error: `Unknown framework ${unknown.join(", ")} (react, lit, angular).` };
  return {
    ...(url ? { url } : {}),
    ...(run ? { run } : {}),
    out,
    frameworks: [...new Set(frameworks)] as Framework[],
    ...(name ? { name } : {}),
    ...(prefix ? { prefix } : {}),
    yes,
    json,
  };
}

function summary(r: DsBuildResult): string {
  const failing = r.gates.filter((g) => g.hard && !g.pass);
  return [
    `${r.ok ? "Built" : "Failed"}: ${r.report.name} (${r.report.scope}) in ${r.out}`,
    `Recreate run: ${r.runId}`,
    ...r.gates.map(
      (g) => `  ${g.pass ? "pass" : "FAIL"}  ${g.id}${g.value !== undefined ? ` = ${String(g.value)}` : ""}`,
    ),
    `Report: ${r.out}/design-system/report.json`,
    ...(failing.length ? [`Failing: ${failing.map((g) => g.id).join(", ")}`] : []),
    "",
  ].join("\n");
}

/** `cdr design-system <url|--run id> --out <dir> --frameworks … --name --prefix --yes`. Returns the exit code. */
export async function designSystemCommand(argv: string[], ctx: DesignSystemCliContext): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    ctx.out.write(DESIGN_SYSTEM_USAGE);
    return 0;
  }
  const args = parseDesignSystemArgs(argv);
  if ("error" in args) {
    ctx.out.write(`${args.error}\n\n${DESIGN_SYSTEM_USAGE}`);
    return 1;
  }
  if (!args.yes) {
    ctx.out.write("Reading a page's design needs consent: pass --yes (it is recorded as auto).\n");
    return 1;
  }
  const config = loadConfig({ projectPath: ctx.cwd }).recreate ?? {};
  const build = ctx.build ?? buildDesignSystem;
  try {
    const r = await build({
      projectDir: ctx.cwd,
      out: resolve(ctx.cwd, args.out),
      ...(args.url ? { url: args.url } : {}),
      ...(args.run ? { run: args.run } : {}),
      ...(args.name ? { name: args.name } : {}),
      ...(args.prefix ? { prefix: args.prefix } : {}),
      frameworks: args.frameworks,
      recreate: config,
      yes: true,
      log: args.json ? () => undefined : (l) => ctx.out.write(`${l}\n`),
    });
    ctx.out.write(args.json ? `${JSON.stringify(r.report)}\n` : summary(r));
    return r.ok ? 0 : 1;
  } catch (e) {
    ctx.out.write(`${(e as Error).message}\n`);
    return 1;
  }
}
