import { existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
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
