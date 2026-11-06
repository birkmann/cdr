import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { Risk, TodoItem } from "@harness/protocol";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { ToolError } from "./types.js";
import {
  displayPath,
  hasRipgrep,
  listProjectFiles,
  rel,
  renderTree,
  resolveInProject,
  resolveTarget,
  searchRoot,
} from "./paths.js";
import { unifiedDiff } from "../diff.js";
import { runShell } from "../shell.js";
import { globToRegExp, redact, truncateMiddle } from "../util.js";
import { harnessHome } from "../config.js";
import { isReadOnlyCommand } from "../permissions.js";
import { searchUnsplashTool, useUnsplashPhotoTool } from "./unsplash.js";
import { loadSkillTool } from "./skill.js";
import { setLaunchTool } from "./launch.js";
import { runAppTool, stopAppTool } from "./app.js";
import { VIEWPORTS, formatPageReport, probePage } from "./browser.js";
import { findChrome, sharedChromeEndpoint } from "@harness/capture";

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
    const { abs } = resolveTarget(ctx, args.path);
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

/** True when a file tool call would write into the chat output folder instead of the project. */
function isOutputWrite(ctx: ToolContext | undefined, path: unknown): boolean {
  if (!ctx?.outputDir || typeof path !== "string") return false;
  try {
    return resolveTarget(ctx, path, { forWrite: true }).output;
  } catch {
    return false;
  }
}

/** Files in the output folder are not part of the project: no afterEdit hook, commit or edited-file list. */
function fileEdit(path: string, output: boolean): Pick<ToolResult, "edited" | "diffPath"> {
  return output ? { diffPath: path } : { edited: [path] };
}

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
  risk: (args, ctx) => (isOutputWrite(ctx, args?.path) ? "low" : "medium"),
  async execute(args: { path: string; content: string }, ctx) {
    const { abs, output } = resolveTarget(ctx, args.path, { forWrite: true });
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const existed = existsSync(abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, args.content);
    const r = displayPath(ctx, abs, output);
    const label = output ? rel(ctx.outputDir!, abs) : r;
    const diff = unifiedDiff(label, before, args.content);
    const lines = args.content.split("\n").length;
    return {
      ok: true,
      output: `${existed ? "Overwrote" : "Created"} ${r} (${lines} lines).`,
      diff,
      ...fileEdit(label, output),
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
  risk: (args, ctx) => (isOutputWrite(ctx, args?.path) ? "low" : "medium"),
  async execute(args: { path: string; search: string; replace: string; replace_all?: boolean }, ctx) {
    const { abs, output } = resolveTarget(ctx, args.path, { forWrite: true });
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
    const r = displayPath(ctx, abs, output);
    const label = output ? rel(ctx.outputDir!, abs) : r;
    const diff = unifiedDiff(label, content, updated);
    return {
      ok: true,
      output: `Patched ${r} (${positions.length} replacement${positions.length > 1 ? "s" : ""}).\n${diff}`,
      diff,
      ...fileEdit(label, output),
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
    const { root: searchIn, path } = searchRoot(ctx, args.path);
    const files = listProjectFiles(searchIn, path);
    const base = path !== "." ? rel(searchIn, resolveInProject(searchIn, path)) + "/" : "";
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
    const { root: searchIn, path } = searchRoot(ctx, args.path);
    const target = resolveInProject(searchIn, path);
    const root = resolveInProject(searchIn, ".");
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
      a.push("-e", args.pattern, "--", rel(searchIn, target));
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
      ? [rel(searchIn, target)]
      : listProjectFiles(searchIn, rel(searchIn, target));
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
    const { root: searchIn, path: p } = searchRoot(ctx, args.path);
    const abs = resolveInProject(searchIn, p);
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      return { ok: false, output: `Not a directory: ${args.path ?? "."}` };
    const base = rel(searchIn, abs);
    const files = listProjectFiles(searchIn, p).map((f) => (base === "." ? f : f.slice(base.length + 1)));
    return { ok: true, output: files.length ? renderTree(files, Math.max(1, args.depth ?? 2)) : "(empty)" };
  },
};

const BROWSER_COMMAND = /CDR_CDP|chrom|puppeteer|playwright|devtools|remote-debugging/i;
/** Commands that run a script, which may be one written earlier to use $CDR_CDP_URL. */
const SCRIPT_COMMAND = /(^|[\s;&|(])(node|npx|tsx|ts-node|deno|bun|bunx|python3?|pnpm|npm|yarn)(\s|$)/;
/** Projects whose commands have driven the shared browser. */
const browserProjects = new Set<string>();

/**
 * DevTools endpoint of the long-lived shared Chrome for a command that drives a browser, and for script runs in
 * a project that already used it (so scripts written earlier keep finding it). Never inside the sandbox: that
 * Chrome runs outside it, with the user's file access, so handing it over would undo the sandbox's confinement.
 */
export async function browserEnv(
  command: string,
  projectRoot: string,
  config: { sandbox?: string },
): Promise<Record<string, string> | undefined> {
  if (config.sandbox === "bwrap") return undefined;
  if (!BROWSER_COMMAND.test(command) && !(browserProjects.has(projectRoot) && SCRIPT_COMMAND.test(command)))
    return undefined;
  const chrome = findChrome();
  if (!chrome) return undefined;
  try {
    const e = await sharedChromeEndpoint(chrome);
    browserProjects.add(projectRoot);
    return { CDR_CDP_URL: e.wsUrl, CDR_CDP_PORT: String(e.port) };
  } catch {
    return undefined;
  }
}

export function bashTool(opts: { readOnlyMode?: boolean } = {}): Tool {
  return {
    name: "bash",
    description: opts.readOnlyMode
      ? "Run a READ-ONLY shell command in the project root (e.g. ls, cat, git status, git log, rg). Commands that modify files are rejected."
      : "Run a shell command (bash) in the project root. Use for builds, tests, git inspection, package managers. " +
        "Output is truncated (head+tail). Do not start servers or other long-running programs here: use `run_app`, " +
        "which starts them in the background and returns their URL. No interactive programs. Default timeout 120 s. " +
        "Outside the sandbox a headless Chrome stays running for browser scripts: commands that mention CDR_CDP_URL, chrome, puppeteer or playwright get " +
        "$CDR_CDP_URL (browser WebSocket URL) and $CDR_CDP_PORT. When $CDR_CDP_URL is set, connect to it (puppeteer.connect({ browserWSEndpoint }), " +
        "chromium.connectOverCDP, or a CDP WebSocket) and close only the tabs you open; never pkill or restart that Chrome. When it is not set, launch your own headless browser.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer", description: "Timeout in seconds (default 120, max 1800)." },
      },
      required: ["command"],
    },
    readOnly: !!opts.readOnlyMode,
    shellCommand: (args: { command?: string }) => String(args?.command ?? ""),
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
      const env = await browserEnv(args.command, ctx.projectRoot, ctx.config);
      const r = await runShell(args.command, {
        env,
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

type MemoryScope = "project" | "user";

function memoryScope(scope: unknown): MemoryScope {
  return scope === "user" ? "user" : "project";
}

/** Memory is loaded into every later session, so a user-wide write asks first (in `ask` mode). */
function memoryRisk(args: { scope?: unknown }): Risk {
  return memoryScope(args?.scope) === "user" ? "medium" : "low";
}

function memoryPath(scope: MemoryScope, ctx: ToolContext): string {
  const dir =
    scope === "user"
      ? join(harnessHome(), "memory")
      : join(resolveInProject(ctx.projectRoot, "."), ".harness", "memory");
  return join(dir, "MEMORY.md");
}

function normalizeFact(fact: unknown): string {
  return String(fact ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the bullet lines in MEMORY.md that `query` names: an exact fact wins, otherwise every bullet containing it
 * (case-insensitive). Returns line indexes.
 */
const BULLET = /^\s*[-*]\s+(.*?)\s*$/;

/** The fact on a bullet line ("- fact" or "* fact", any line ending), or undefined for other lines. */
function bulletFact(line: string): string | undefined {
  const m = BULLET.exec(line);
  return m?.[1] ? normalizeFact(m[1]) : undefined;
}

function matchFacts(lines: string[], query: string): number[] {
  const bullets = lines.flatMap((l, i) => {
    const fact = bulletFact(l);
    return fact ? [{ i, fact }] : [];
  });
  const exact = bullets.filter((b) => b.fact === query);
  if (exact.length) return exact.map((b) => b.i);
  const q = query.toLowerCase();
  return bullets.filter((b) => b.fact.toLowerCase().includes(q)).map((b) => b.i);
}

function withTrailingNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/** Resolve `query` to exactly one stored fact, or explain why not. */
function findOneFact(
  path: string,
  query: string,
  scope: MemoryScope,
): { lines: string[]; index: number } | { error: string } {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const hits = matchFacts(lines, query);
  if (hits.length === 0) return { error: `No fact in ${scope} memory (${path}) matches "${query}".` };
  if (hits.length > 1)
    return {
      error:
        `"${query}" matches ${hits.length} ${scope} memories; quote one exactly:\n` +
        hits.map((i) => lines[i]).join("\n"),
    };
  return { lines, index: hits[0]! };
}

export const rememberTool: Tool = {
  name: "remember",
  description:
    "Save a durable fact for future sessions (project conventions, commands that work, user preferences). " +
    "scope=project (default) stores it with the repo, scope=user stores it globally. " +
    "To correct an outdated fact, pass it (or a unique part of it) as `replaces`. Never store secrets.",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string" },
      scope: { type: "string", enum: ["project", "user"] },
      replaces: {
        type: "string",
        description: "An existing fact (or a unique part of it) this one replaces.",
      },
    },
    required: ["fact"],
  },
  // It never touches project code, so read-only sessions keep it; `risk` still gates user-wide writes.
  readOnly: true,
  risk: memoryRisk,
  async execute(args: { fact: string; scope?: MemoryScope; replaces?: string }, ctx) {
    const scope = memoryScope(args.scope);
    const fact = normalizeFact(args.fact);
    if (!fact) return { ok: false, output: "Nothing to remember: `fact` is empty." };
    if (redact(fact) !== fact)
      return {
        ok: false,
        output: "Refused: the fact looks like it contains a secret. Memory must never hold secrets.",
      };
    const path = memoryPath(scope, ctx);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, "# Memory\n\n");

    const replaces = normalizeFact(args.replaces);
    if (replaces) {
      const found = findOneFact(path, replaces, scope);
      if ("error" in found) return { ok: false, output: found.error };
      const old = bulletFact(found.lines[found.index]!)!;
      // drop the old fact and any existing copy of the new one, then append the new one
      const body = found.lines.filter((l, i) => i !== found.index && bulletFact(l) !== fact).join("\n");
      writeFileSync(path, `${withTrailingNewline(body)}- ${fact}\n`);
      ctx.emit({ type: "memory.saved", scope, path, fact, replaced: old });
      return { ok: true, output: `Replaced in ${scope} memory: "${old}" → "${fact}".` };
    }

    const current = readFileSync(path, "utf8");
    if (current.split("\n").some((l) => bulletFact(l) === fact))
      return { ok: true, output: "Already remembered." };
    appendFileSync(path, `${current.endsWith("\n") ? "" : "\n"}- ${fact}\n`);
    ctx.emit({ type: "memory.saved", scope, path, fact });
    return { ok: true, output: `Saved to ${scope} memory.` };
  },
};

export const forgetTool: Tool = {
  name: "forget",
  description:
    "Remove a fact from memory that is wrong or no longer true. `fact` is the stored fact or a unique part of it; " +
    "scope=project (default) or user. To correct a fact instead, use remember with `replaces`.",
  parameters: {
    type: "object",
    properties: { fact: { type: "string" }, scope: { type: "string", enum: ["project", "user"] } },
    required: ["fact"],
  },
  readOnly: true,
  risk: memoryRisk,
  async execute(args: { fact: string; scope?: MemoryScope }, ctx) {
    const scope = memoryScope(args.scope);
    const query = normalizeFact(args.fact);
    if (!query) return { ok: false, output: "Nothing to forget: `fact` is empty." };
    const path = memoryPath(scope, ctx);
    const found = findOneFact(path, query, scope);
    if ("error" in found) return { ok: false, output: found.error };
    const fact = bulletFact(found.lines[found.index]!)!;
    writeFileSync(path, found.lines.filter((_, i) => i !== found.index).join("\n"));
    ctx.emit({ type: "memory.removed", scope, path, fact });
    return { ok: true, output: `Removed from ${scope} memory: "${fact}".` };
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

/** Chrome / Chromium on this machine (`HARNESS_CHROME` overrides); shared with the recreate capture. */
export { findChrome };

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
    forgetTool,
    loadSkillTool,
    setPreviewTool,
    setLaunchTool,
    runAppTool,
    stopAppTool,
    checkPreviewTool,
    searchUnsplashTool,
    useUnsplashPhotoTool,
  ];
}

export { ToolError, truncateMiddle };
export { setLaunchTool, detectFramework } from "./launch.js";
export {
  runAppTool,
  stopAppTool,
  rememberedApps,
  appAlive,
  stopApp,
  localUrls,
  type AppRecord,
} from "./app.js";
