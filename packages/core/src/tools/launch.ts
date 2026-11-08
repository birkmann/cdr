import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LaunchFramework } from "@harness/protocol";
import type { Tool } from "./types.js";
import { rel, resolveInProject } from "./paths.js";
import { lastAppCheck, launchBlocker } from "./check-app.js";

const FRAMEWORKS: LaunchFramework[] = [
  "rust",
  "tauri",
  "go",
  "python",
  "node",
  "deno",
  "bun",
  "swift",
  "dotnet",
  "java",
  "kotlin",
  "c",
  "cpp",
  "zig",
  "dart",
  "godot",
  "other",
];

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Language or framework of the program in `dir`, from its manifest files (then the command's first word). */
export function detectFramework(dir: string, command = ""): LaunchFramework {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    /* fall through to the command */
  }
  const has = (n: string) => names.includes(n);
  if (has("src-tauri") || /\btauri\b/.test(read(join(dir, "Cargo.toml")))) return "tauri";
  if (has("Cargo.toml")) return "rust";
  if (has("go.mod")) return "go";
  if (has("project.godot")) return "godot";
  if (has("pubspec.yaml")) return "dart";
  if (has("Package.swift")) return "swift";
  if (has("build.zig")) return "zig";
  if (names.some((n) => /\.(csproj|fsproj|sln)$/.test(n))) return "dotnet";
  if (has("build.gradle.kts") || names.some((n) => n.endsWith(".kt"))) return "kotlin";
  if (has("pom.xml") || has("build.gradle")) return "java";
  if (has("deno.json") || has("deno.jsonc")) return "deno";
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  if (has("package.json")) return "node";
  if (has("pyproject.toml") || has("requirements.txt") || names.some((n) => n.endsWith(".py")))
    return "python";
  if (has("CMakeLists.txt") || names.some((n) => /\.(cpp|cc|cxx|hpp)$/.test(n))) return "cpp";
  if (names.some((n) => n.endsWith(".c"))) return "c";
  const word = command.trim().split(/\s+/)[0] ?? "";
  const byCommand: Record<string, LaunchFramework> = {
    cargo: "rust",
    go: "go",
    python: "python",
    python3: "python",
    uv: "python",
    node: "node",
    npm: "node",
    pnpm: "node",
    npx: "node",
    deno: "deno",
    bun: "bun",
    swift: "swift",
    dotnet: "dotnet",
    java: "java",
    gradle: "java",
    mvn: "java",
    zig: "zig",
    dart: "dart",
    flutter: "dart",
    godot: "godot",
  };
  return byCommand[word] ?? "other";
}

export const setLaunchTool: Tool = {
  name: "set_launch",
  description:
    "Give the user a Launch button in the chat for a native program you built (desktop app, game, CLI or server " +
    "that is not a web page), e.g. `cargo run --release` or `python main.py`. Call it once the program builds " +
    "and runs. For a program with a window, play-test it with check_app first: the button is only added once a " +
    "visual check of the current files passes. The user starts it themselves; this tool does not run anything.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command that starts the program, e.g. cargo run --release",
      },
      cwd: {
        type: "string",
        description: "Folder to run it in, relative to the project root (default: the project root).",
      },
      title: { type: "string", description: "Short name of the program, e.g. Snake (native)." },
      framework: {
        type: "string",
        enum: FRAMEWORKS,
        description: "Language or framework (detected from the project files when omitted).",
      },
    },
    required: ["command"],
  },
  readOnly: true,
  risk: () => "low",
  async execute(args: { command: string; cwd?: string; title?: string; framework?: LaunchFramework }, ctx) {
    const command = args.command?.trim();
    if (!command) return { ok: false, output: "set_launch needs a `command`." };
    if (/[\r\n]/.test(command))
      return { ok: false, output: "Give a single-line command (join steps with &&)." };
    const abs = resolveInProject(ctx.projectRoot, args.cwd || ".");
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      return { ok: false, output: `No such folder: ${args.cwd}.` };
    const blocked = launchBlocker(ctx.projectRoot, command);
    if (blocked) return { ok: false, output: blocked };
    const cwd = rel(ctx.projectRoot, abs);
    const framework =
      args.framework && FRAMEWORKS.includes(args.framework) ? args.framework : detectFramework(abs, command);
    ctx.emit({
      type: "launch.ready",
      command,
      ...(cwd && cwd !== "." ? { cwd } : {}),
      ...(args.title ? { title: args.title } : {}),
      framework,
    });
    const check = lastAppCheck(ctx.projectRoot, command);
    const notes = [
      `The user now has a Launch button for \`${command}\`. Do not run it again yourself just to show it.`,
    ];
    if (check?.verdict === "unverified")
      notes.push("Its window was not looked at: tell the user that the appearance is unchecked.");
    if (check?.verdict === "fail")
      notes.push(
        `check_app still reports problems; tell the user what is still wrong:\n${check.problems.map((p) => `- ${p}`).join("\n")}`,
      );
    return { ok: true, output: notes.join("\n") };
  },
};
