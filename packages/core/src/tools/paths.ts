import { existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { ToolError } from "./types.js";

/**
 * Resolve a user/model-supplied path inside the project root.
 * Rejects absolute paths outside the root, `..` escapes and symlink escapes.
 */
export function resolveInProject(root: string, p: string, opts: { forWrite?: boolean } = {}): string {
  if (typeof p !== "string" || !p.trim()) throw new ToolError("Path must be a non-empty string.");
  const realRoot = realpathSync(root);
  const abs = isAbsolute(p) ? resolve(p) : resolve(realRoot, p);
  // Find the deepest existing ancestor and resolve symlinks on it.
  let existing = abs;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = realpathSync(existing);
  const real = join(realExisting, relative(existing, abs));
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new ToolError(`Path "${p}" is outside the project root (${realRoot}). Access denied.`);
  }
  if (opts.forWrite) {
    const rel = relative(realRoot, real).split(sep);
    if (rel[0] === ".git") throw new ToolError(`Writing inside .git is not allowed.`);
  }
  return real;
}

function tryResolve(root: string, p: string, opts: { forWrite?: boolean }): string | undefined {
  try {
    return resolveInProject(root, p, opts);
  } catch (e) {
    if (e instanceof ToolError) return undefined;
    throw e;
  }
}

/** realpath of the deepest existing ancestor plus the missing remainder, so a folder that does not exist yet still gets a symlink-free path. */
function realpathLoose(p: string): string {
  const abs = resolve(p);
  let existing = abs;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return join(realpathSync(existing), relative(existing, abs));
}

/** `~` and `~/x` mean the home folder: the paths shown for output files use it, and the model may pass them back. */
function expandHome(p: string): string {
  return typeof p === "string" && (p === "~" || p.startsWith("~/")) ? join(homedir(), p.slice(1)) : p;
}

/** True when `abs` is the output folder or inside it (symlink-resolved, also while the folder does not exist yet). */
function insideOutput(outDir: string, abs: string): boolean {
  const root = realpathLoose(outDir);
  const real = realpathLoose(abs);
  return real === root || real.startsWith(root + sep);
}

/**
 * Resolve a file tool's path. Normally that is resolveInProject. In a chat turn (`ctx.outputDir` set) a file
 * that exists in the project is still read and edited in place, as is one already in the output folder, and so
 * is a new file in an existing project subfolder. Other new files are created in the output folder (same relative
 * path), so chats do not add stray files to the repository.
 * The full path of an output file (as reported by write_file, `~` allowed) addresses it directly.
 */
export function resolveTarget(
  ctx: { projectRoot: string; outputDir?: string },
  p: string,
  opts: { forWrite?: boolean } = {},
): { abs: string; output: boolean } {
  const outDir = ctx.outputDir;
  if (!outDir) return { abs: resolveInProject(ctx.projectRoot, p, opts), output: false };
  p = expandHome(p);
  const outputExists = existsSync(outDir);
  if (typeof p === "string" && isAbsolute(p) && insideOutput(outDir, p))
    return { abs: outputExists ? resolveInProject(outDir, p, opts) : realpathLoose(p), output: true };
  const inProject = tryResolve(ctx.projectRoot, p, opts);
  if (inProject && existsSync(inProject)) return { abs: inProject, output: false };
  const inOutput = outputExists ? tryResolve(outDir, p, opts) : undefined;
  if (inOutput && existsSync(inOutput)) return { abs: inOutput, output: true };
  if (!opts.forWrite || !inProject) {
    // Reads of missing files report "not found" for the project path; escapes raise the usual error.
    return { abs: resolveInProject(ctx.projectRoot, p, opts), output: false };
  }
  const realRoot = realpathSync(ctx.projectRoot);
  // A new file in a folder the project already has (src/utils.ts) is meant for the project: it goes there, with
  // the normal approval. Top-level files and new folders (poems/dogs.md) go to the output folder.
  if (dirname(inProject) !== realRoot && existsSync(dirname(inProject)))
    return { abs: inProject, output: false };
  const relPath = relative(realRoot, inProject);
  if (!outputExists) {
    // The folder is created by the write. Resolve symlinks on what exists so the path matches a later realpath.
    const root = realpathLoose(outDir);
    const abs = join(root, relPath);
    if (abs !== root && !abs.startsWith(root + sep))
      throw new ToolError(`Path "${p}" is outside the output folder.`);
    return { abs, output: true };
  }
  return { abs: resolveInProject(outDir, relPath, opts), output: true };
}

/**
 * Where list_dir, glob and grep look: the project, or the output folder when `p` is a full path inside it
 * (the form write_file reports), so the model can search and list the files it created.
 */
export function searchRoot(
  ctx: { projectRoot: string; outputDir?: string },
  p: string | undefined,
): { root: string; path: string } {
  const path = p === undefined ? "." : expandHome(p);
  const out = ctx.outputDir;
  if (out && typeof path === "string" && isAbsolute(path) && existsSync(out) && insideOutput(out, path))
    return { root: out, path };
  return { root: ctx.projectRoot, path: p ?? "." };
}

/** A path for messages: the project-relative path, or the full path (with ~) for output-folder files. Tools accept both forms. */
export function displayPath(ctx: { projectRoot: string }, abs: string, output: boolean): string {
  if (!output) return rel(ctx.projectRoot, abs);
  const home = homedir();
  return abs === home || abs.startsWith(home + sep) ? "~" + abs.slice(home.length) : abs;
}

export function rel(root: string, abs: string): string {
  const r = relative(realpathSync(root), abs);
  return r === "" ? "." : r.split(sep).join("/");
}

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".harness",
  "coverage",
  ".turbo",
  ".cache",
]);

let rgAvailable: boolean | undefined;
export function hasRipgrep(): boolean {
  if (rgAvailable === undefined) {
    rgAvailable = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  }
  return rgAvailable;
}

/** List project files (relative posix paths), honouring .gitignore when ripgrep is available. */
export function listProjectFiles(root: string, dir = ".", limit = 20_000): string[] {
  const base = resolveInProject(root, dir);
  if (hasRipgrep()) {
    const r = spawnSync(
      "rg",
      ["--files", "--hidden", "--no-require-git", "-g", "!.git", "-g", "!node_modules", "."],
      {
        cwd: base,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (r.status === 0 || r.status === 1) {
      const prefix = rel(root, base);
      return r.stdout
        .split("\n")
        .filter(Boolean)
        .map((f) => f.replace(/^\.\//, ""))
        .map((f) => (prefix === "." ? f : `${prefix}/${f}`))
        .sort()
        .slice(0, limit);
    }
  }
  // Without ripgrep, let git apply .gitignore when the project is a repository.
  const g = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
    cwd: base,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (g.status === 0) {
    const prefix = rel(root, base);
    return [...new Set(g.stdout.split("\0").filter(Boolean))]
      .filter((f) => !f.split("/").includes("node_modules") && existsSync(join(base, f)))
      .map((f) => (prefix === "." ? f : `${prefix}/${f}`))
      .sort()
      .slice(0, limit);
  }
  const out: string[] = [];
  const walk = (abs: string) => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      if (DEFAULT_IGNORES.has(e)) continue;
      const full = join(abs, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else out.push(rel(root, full));
    }
  };
  walk(base);
  return out;
}

/** Render a depth-limited tree from a list of relative file paths. */
export function renderTree(files: string[], maxDepth: number, maxEntries = 400): string {
  type Node = Map<string, Node>;
  const rootNode: Node = new Map();
  for (const f of files) {
    const parts = f.split("/");
    let n = rootNode;
    for (let i = 0; i < parts.length; i++) {
      if (i >= maxDepth) break;
      const key = i === parts.length - 1 ? parts[i] : parts[i] + "/";
      if (!n.has(key)) n.set(key, new Map());
      n = n.get(key)!;
    }
  }
  const lines: string[] = [];
  const countFiles = (prefix: string) => files.filter((f) => f.startsWith(prefix)).length;
  const walk = (n: Node, indent: string, path: string, depth: number) => {
    const keys = [...n.keys()].sort(
      (a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b),
    );
    for (const k of keys) {
      if (lines.length >= maxEntries) {
        lines.push(`${indent}… (truncated)`);
        return;
      }
      const child = n.get(k)!;
      const full = path + k;
      if (k.endsWith("/") && child.size === 0 && depth + 1 >= maxDepth) {
        lines.push(`${indent}${k} (${countFiles(full)} files)`);
      } else {
        lines.push(`${indent}${k}`);
        walk(child, indent + "  ", full, depth + 1);
      }
    }
  };
  walk(rootNode, "", "", 0);
  return lines.join("\n");
}
