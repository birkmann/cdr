import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { Risk, TodoItem } from "@harness/protocol";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { ToolError } from "./types.js";
import { hasRipgrep, listProjectFiles, rel, renderTree, resolveInProject } from "./paths.js";
import { unifiedDiff } from "../diff.js";
import { runShell } from "../shell.js";
import { globToRegExp, truncateMiddle } from "../util.js";
import { harnessHome } from "../config.js";
import { isReadOnlyCommand } from "../permissions.js";
import { searchUnsplashTool, useUnsplashPhotoTool } from "./unsplash.js";
import { loadSkillTool } from "./skill.js";
import { VIEWPORTS, formatPageReport, probePage } from "./browser.js";

const MAX_READ_BYTES = 2_000_000;
const DEFAULT_READ_LINES = 2000;

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a text file from the project. Returns line-numbered content (format: `<line>\\t<text>`). " +
    "Use offset/limit (1-based line numbers) for large files. Always read a file before editing it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root." },
      offset: { type: "integer", description: "1-based line to start from (default 1)." },
      limit: { type: "integer", description: `Max lines to return (default ${DEFAULT_READ_LINES}).` },
    },
    required: ["path"],
  },
  readOnly: true,
  async execute(args: { path: string; offset?: number; limit?: number }, ctx) {
    const abs = resolveInProject(ctx.projectRoot, args.path);
    if (!existsSync(abs)) return { ok: false, output: `File not found: ${args.path}` };
    const st = statSync(abs);
    if (st.isDirectory()) return { ok: false, output: `${args.path} is a directory. Use list_dir instead.` };
    if (st.size > MAX_READ_BYTES)
      return {
        ok: false,
        output: `File too large (${st.size} bytes). Use grep to find the relevant region.`,
      };
    const buf = readFileSync(abs);
    if (isBinary(buf))
      return { ok: false, output: `${args.path} looks like a binary file (${st.size} bytes).` };
    const lines = buf.toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const offset = Math.max(1, args.offset ?? 1);
    const limit = Math.max(1, args.limit ?? DEFAULT_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice
      .map((l, i) => `${offset + i}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`)
      .join("\n");
    const more =
      offset - 1 + limit < lines.length
        ? `\n[showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}; use offset to read more]`
        : "";
    return { ok: true, output: (body || "(empty file)") + more };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create a new file or completely overwrite an existing one. Prefer patch_file for changes to existing files. " +
    "Parent directories are created automatically.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["path", "content"],
  },
  readOnly: false,
  async execute(args: { path: string; content: string }, ctx) {
    const abs = resolveInProject(ctx.projectRoot, args.path, { forWrite: true });
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const existed = existsSync(abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, args.content);
    const r = rel(ctx.projectRoot, abs);
    const diff = unifiedDiff(r, before, args.content);
    const lines = args.content.split("\n").length;
    return {
      ok: true,
      output: `${existed ? "Overwrote" : "Created"} ${r} (${lines} lines).`,
      diff,
      edited: [r],
    };
  },
};

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Find the region most similar to `search` to give the model a useful hint on a miss. */
function nearMiss(content: string, search: string): string {
  const lines = content.split("\n");
  const first = search
    .split("\n")
    .find((l) => l.trim().length > 0)
    ?.trim();
  if (!first) return "";
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = similarity(lines[i].trim(), first);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  if (best < 0 || bestScore < 0.5) return "";
  const n = search.split("\n").length;
  const from = Math.max(0, best - 1);
  const to = Math.min(lines.length, best + n + 1);
  const snippet = lines
    .slice(from, to)
    .map((l, i) => `${from + i + 1}\t${l}`)
    .join("\n");
  return `\nClosest match (similarity ${(bestScore * 100).toFixed(0)}%) near line ${best + 1}:\n${snippet}\nCheck whitespace/indentation and copy the text exactly from read_file output (without line numbers).`;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, c] of A) inter += Math.min(c, B.get(g) ?? 0);
  return (2 * inter) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1));
}

export const patchFileTool: Tool = {
  name: "patch_file",
  description:
    "Edit a file by replacing an exact text snippet. `search` must match the file content exactly (including " +
    "whitespace and indentation) and must be unique unless replace_all is true. Include enough surrounding lines " +
    "to make it unique. Returns a unified diff. To create a new file use write_file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      search: { type: "string", description: "Exact existing text to replace." },
      replace: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "search", "replace"],
  },
  readOnly: false,
  async execute(args: { path: string; search: string; replace: string; replace_all?: boolean }, ctx) {
    const abs = resolveInProject(ctx.projectRoot, args.path, { forWrite: true });
    if (!existsSync(abs))
      return { ok: false, output: `File not found: ${args.path}. Use write_file to create it.` };
    if (args.search === "") return { ok: false, output: "`search` must not be empty." };
    if (args.search === args.replace)
      return { ok: false, output: "`search` and `replace` are identical; nothing to do." };
    const content = readFileSync(abs, "utf8");
    const positions: number[] = [];
    for (
      let i = content.indexOf(args.search);
      i >= 0;
      i = content.indexOf(args.search, i + args.search.length)
    )
      positions.push(i);
    if (positions.length === 0) {
      return {
        ok: false,
        output: `No match for \`search\` in ${args.path}.${nearMiss(content, args.search)}`,
      };
    }
    if (positions.length > 1 && !args.replace_all) {
      return {
        ok: false,
        output: `\`search\` matches ${positions.length} times in ${args.path} (lines ${positions.map((p) => lineOf(content, p)).join(", ")}). Add surrounding context to make it unique, or set replace_all.`,
      };
    }
    const updated = args.replace_all
      ? content.split(args.search).join(args.replace)
      : content.replace(args.search, () => args.replace);
    writeFileSync(abs, updated);
    const r = rel(ctx.projectRoot, abs);
    const diff = unifiedDiff(r, content, updated);
    return {
      ok: true,
      output: `Patched ${r} (${positions.length} replacement${positions.length > 1 ? "s" : ""}).\n${diff}`,
      diff,
      edited: [r],
    };
  },
};

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by glob pattern (e.g. `src/**/*.ts`, `**/package.json`). Honours .gitignore. Returns relative paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Directory to search in (default project root)." },
    },
    required: ["pattern"],
  },
  readOnly: true,
  async execute(args: { pattern: string; path?: string }, ctx) {
    const files = listProjectFiles(ctx.projectRoot, args.path ?? ".");
    const base =
      args.path && args.path !== "."
        ? rel(ctx.projectRoot, resolveInProject(ctx.projectRoot, args.path)) + "/"
        : "";
    const re = globToRegExp(args.pattern);
    const reBasename = !args.pattern.includes("/") ? re : null;
    const hits = files.filter((f) => {
      const local = base && f.startsWith(base) ? f.slice(base.length) : f;
      return re.test(local) || (reBasename && reBasename.test(local.split("/").pop()!));
    });
    if (!hits.length) return { ok: true, output: "No files matched." };
    const shown = hits.slice(0, 500);
    return {
      ok: true,
      output: shown.join("\n") + (hits.length > 500 ? `\n[${hits.length - 500} more not shown]` : ""),
    };
  },
};

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents with a regular expression (ripgrep syntax). Returns `path:line:text` matches. " +
    "Use `glob` to restrict file types (e.g. `*.ts`).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "File or directory (default project root)." },
      glob: { type: "string", description: "Only search files matching this glob." },
      ignore_case: { type: "boolean" },
    },
    required: ["pattern"],
  },
  readOnly: true,
  async execute(args: { pattern: string; path?: string; glob?: string; ignore_case?: boolean }, ctx) {
    const target = resolveInProject(ctx.projectRoot, args.path ?? ".");
    const root = resolveInProject(ctx.projectRoot, ".");
    const max = 300;
    if (hasRipgrep()) {
      const a = [
        "-n",
        "--no-heading",
        "--hidden",
        "--no-require-git",
        "-g",
        "!.git",
        "-g",
        "!node_modules",
        "--max-columns",
        "400",
        "--max-columns-preview",
      ];
      if (args.ignore_case) a.push("-i");
      if (args.glob) a.push("-g", args.glob);
      a.push("-e", args.pattern, "--", rel(ctx.projectRoot, target));
      const r = spawnSync("rg", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (r.status === 2) return { ok: false, output: `grep error: ${r.stderr.trim()}` };
      const lines = r.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => l.replace(/^\.\//, ""));
      if (!lines.length) return { ok: true, output: "No matches." };
      return {
        ok: true,
        output:
          lines.slice(0, max).join("\n") +
          (lines.length > max ? `\n[${lines.length - max} more matches not shown]` : ""),
      };
    }
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.ignore_case ? "i" : "");
    } catch (e) {
      return { ok: false, output: `Invalid regex: ${(e as Error).message}` };
    }
    const files = statSync(target).isFile()
      ? [rel(ctx.projectRoot, target)]
      : listProjectFiles(ctx.projectRoot, rel(ctx.projectRoot, target));
    const g = args.glob ? globToRegExp(args.glob) : null;
    const out: string[] = [];
    for (const f of files) {
      if (g && !g.test(f) && !g.test(f.split("/").pop()!)) continue;
      let text: string;
      try {
        const buf = readFileSync(join(root, f));
        if (isBinary(buf)) continue;
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      text.split("\n").forEach((l, i) => {
        if (re.test(l)) out.push(`${f}:${i + 1}:${l.slice(0, 400)}`);
      });
      if (out.length > max) break;
    }
    return { ok: true, output: out.length ? out.slice(0, max).join("\n") : "No matches." };
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description: "Show a depth-limited tree of a directory (honours .gitignore).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Default: project root." },
      depth: { type: "integer", description: "Default 2." },
    },
  },
  readOnly: true,
  async execute(args: { path?: string; depth?: number }, ctx) {
    const p = args.path ?? ".";
    const abs = resolveInProject(ctx.projectRoot, p);
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      return { ok: false, output: `Not a directory: ${p}` };
    const base = rel(ctx.projectRoot, abs);
    const files = listProjectFiles(ctx.projectRoot, p).map((f) =>
      base === "." ? f : f.slice(base.length + 1),
    );
    return { ok: true, output: files.length ? renderTree(files, Math.max(1, args.depth ?? 2)) : "(empty)" };
  },
};

export function bashTool(opts: { readOnlyMode?: boolean } = {}): Tool {
  return {
    name: "bash",
    description: opts.readOnlyMode
      ? "Run a READ-ONLY shell command in the project root (e.g. ls, cat, git status, git log, rg). Commands that modify files are rejected."
      : "Run a shell command (bash) in the project root. Use for builds, tests, git inspection, package managers. " +
        "Output is truncated (head+tail). Do not start long-running servers or interactive programs. Default timeout 120 s.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer", description: "Timeout in seconds (default 120, max 1800)." },
      },
      required: ["command"],
    },
    readOnly: !!opts.readOnlyMode,
    risk(args: { command: string }): Risk {
      return isReadOnlyCommand(args.command) ? "low" : "medium";
    },
    async execute(args: { command: string; timeout?: number }, ctx): Promise<ToolResult> {
      if (opts.readOnlyMode && !isReadOnlyCommand(args.command)) {
        return {
          ok: false,
          output: `Only read-only commands are allowed in this phase. Rejected: ${args.command}`,
        };
      }
      const timeoutMs = Math.min(1800, Math.max(1, args.timeout ?? 120)) * 1000;
      const r = await runShell(args.command, {
        cwd: resolveInProject(ctx.projectRoot, "."),
        timeoutMs,
        signal: ctx.signal,
        stripEnv: ctx.secretEnv,
        sandbox: ctx.config.sandbox,
        network: ctx.config.sandboxNetwork,
      });
      const out = r.output.trim() || "(no output)";
      return { ok: r.exitCode === 0, output: `${out}\n[exit code ${r.exitCode}]` };
    },
  };
}

export const runVerificationTool: Tool = {
  name: "run_verification",
  description:
    "Run the project's configured build/test/lint commands and return a structured result. Use before claiming the task is done.",
  parameters: { type: "object", properties: {} },
  readOnly: false,
  risk: () => "low",
  async execute(_args, ctx) {
    if (!ctx.verify) return { ok: false, output: "Verification is not available in this context." };
    const r = await ctx.verify.run(0, ctx.signal);
    if (r.skipped) return { ok: true, output: "No build/test/lint commands are configured or detected." };
    return {
      ok: r.ok,
      output:
        r.steps.map((s) => `## ${s.kind}: ${s.command} → exit ${s.exitCode}\n${s.output}`).join("\n\n") +
        `\n\nOverall: ${r.ok ? "PASS" : "FAIL"}`,
    };
  },
};

export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Ask the user a question when you are genuinely blocked on a decision. Optionally provide answer options.",
  parameters: {
    type: "object",
    properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
    required: ["question"],
  },
  readOnly: true,
  async execute(args: { question: string; options?: string[] }, ctx) {
    const answer = await ctx.ask(args.question, args.options);
    return { ok: true, output: `User answered: ${answer}` };
  },
};

export const todoTool: Tool = {
  name: "todo",
  description:
    "Maintain a checklist for the current task. Pass the full list each time; statuses: pending, in_progress, done. " +
    "Keep exactly one item in_progress while working.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["items"],
  },
  readOnly: true,
  async execute(args: { items: Partial<TodoItem>[] }, ctx) {
    const items: TodoItem[] = args.items.map((it, i) => ({
      id: it.id ?? String(i + 1),
      text: String(it.text ?? ""),
      status: it.status === "done" || it.status === "in_progress" ? it.status : "pending",
    }));
    ctx.todos.splice(0, ctx.todos.length, ...items);
    ctx.emit({ type: "todo.update", items });
    const done = items.filter((i) => i.status === "done").length;
    return { ok: true, output: `Todo list updated (${done}/${items.length} done).` };
  },
};

export const rememberTool: Tool = {
  name: "remember",
  description:
    "Save a durable fact for future sessions (project conventions, commands that work, user preferences). " +
    "scope=project (default) stores it with the repo, scope=user stores it globally.",
  parameters: {
    type: "object",
    properties: { fact: { type: "string" }, scope: { type: "string", enum: ["project", "user"] } },
    required: ["fact"],
  },
  readOnly: true,
  risk: () => "low",
  async execute(args: { fact: string; scope?: "project" | "user" }, ctx) {
    const scope = args.scope === "user" ? "user" : "project";
    const dir =
      scope === "user"
        ? join(harnessHome(), "memory")
        : join(resolveInProject(ctx.projectRoot, "."), ".harness", "memory");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "MEMORY.md");
    if (!existsSync(path)) writeFileSync(path, "# Memory\n\n");
    const fact = args.fact.replace(/\s+/g, " ").trim();
    if (readFileSync(path, "utf8").includes(`- ${fact}\n`))
      return { ok: true, output: "Already remembered." };
    appendFileSync(path, `- ${fact}\n`);
    ctx.emit({ type: "memory.saved", scope, path, fact });
    return { ok: true, output: `Saved to ${scope} memory.` };
  },
};

export const setPreviewTool: Tool = {
  name: "set_preview",
  description:
    "Show a web page from the project in the user's live preview pane (e.g. index.html of a game or UI). " +
    "Call it after creating or changing something viewable. The file must be an HTML file inside the project; " +
    "relative scripts, styles and images are served alongside it.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "HTML file relative to the project root, e.g. index.html or dist/index.html",
      },
      title: { type: "string", description: "Short label for the preview." },
    },
    required: ["path"],
  },
  readOnly: true,
  risk: () => "low",
  async execute(args: { path: string; title?: string }, ctx) {
    const abs = resolveInProject(ctx.projectRoot, args.path);
    if (!existsSync(abs) || statSync(abs).isDirectory())
      return { ok: false, output: `No such file: ${args.path}. Create it first.` };
    if (!/\.html?$/i.test(abs)) return { ok: false, output: "set_preview needs an .html file." };
    const path = rel(ctx.projectRoot, abs);
    ctx.emit({ type: "preview.ready", path, title: args.title });
    return {
      ok: true,
      output: `Preview is showing ${path}. (Browser console errors are not visible to you; keep the code simple and check it carefully.)`,
    };
  },
};

const CHROME_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
];
let chromePath: string | null | undefined;
export function findChrome(): string | null {
  if (chromePath !== undefined) return chromePath;
  if (process.env.HARNESS_CHROME) return (chromePath = process.env.HARNESS_CHROME);
  for (const c of CHROME_CANDIDATES) {
    const r = spawnSync("which", [c], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return (chromePath = r.stdout.trim());
  }
  return (chromePath = null);
}

export const checkPreviewTool: Tool = {
  name: "check_preview",
  description:
    "Load an HTML file from the project in a headless browser at phone (390px) and desktop (1280px) widths and report " +
    "JavaScript errors (also while clicking every button), failed requests, horizontal overflow, broken images, " +
    "controls without an accessible name, and a summary of the rendered page. Use it after writing a page and after fixing what it reported, " +
    "instead of installing browsers or writing test scripts.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "HTML file relative to the project root (default index.html)" },
      interact: {
        type: "boolean",
        description:
          "Also click every visible button and reload to catch errors in event handlers (default true).",
      },
      viewports: {
        type: "array",
        items: { type: "string", enum: Object.keys(VIEWPORTS) },
        description: "Viewport names to check (default phone and desktop). small = 320px, tablet = 768px.",
      },
    },
  },
  readOnly: true,
  risk: () => "low",
  async execute(args: { path?: string; viewports?: string[]; interact?: boolean }, ctx) {
    const abs = resolveInProject(ctx.projectRoot, args.path || "index.html");
    if (!existsSync(abs)) return { ok: false, output: `No such file: ${args.path || "index.html"}` };
    const chrome = findChrome();
    if (!chrome)
      return { ok: true, output: "No headless browser is installed; review the code carefully instead." };
    const viewports = (args.viewports ?? []).map((v) => VIEWPORTS[v]).filter(Boolean);
    try {
      const report = await probePage(chrome, pathToFileURL(abs).href, {
        viewports,
        signal: ctx.signal,
        exercise: args.interact !== false,
      });
      const base = pathToFileURL(ctx.projectRoot).href.replace(/\/?$/, "/");
      return { ok: report.ok, output: formatPageReport(report, rel(ctx.projectRoot, abs), base) };
    } catch (e) {
      return { ok: false, output: `Browser failed: ${(e as Error).message}` };
    }
  },
};

export function builtinTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    patchFileTool,
    globTool,
    grepTool,
    listDirTool,
    bashTool(),
    runVerificationTool,
    askUserTool,
    todoTool,
    rememberTool,
    loadSkillTool,
    setPreviewTool,
    checkPreviewTool,
    searchUnsplashTool,
    useUnsplashPhotoTool,
  ];
}

export { ToolError, truncateMiddle };
