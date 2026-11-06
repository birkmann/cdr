import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isWorkspaceContainer, listProjectFiles, resolveInProject, type Session } from "@harness/core";

/** Old home-directory sessions retain their files, but cannot expose the whole home. */
export function sessionFileScope(s: Session) {
  const roots = new Set<string>();
  const files = new Set<string>();
  const attachments = new Set<string>();
  const restricted = isWorkspaceContainer(s.projectRoot);
  const local = (path: string) => relative(s.projectRoot, path).split(sep).join("/");
  const resolveVisible = (path: unknown) => {
    if (typeof path !== "string") return;
    try {
      const abs = resolveInProject(s.projectRoot, path);
      if (
        local(abs)
          .split("/")
          .some((p) => p.startsWith("."))
      )
        return;
      return abs;
    } catch {
      return;
    }
  };
  if (!restricted) roots.add(s.projectRoot);
  /** recreation outputs: walked directly (git / ripgrep skip them, they are excluded from git on purpose) */
  const runRoots = new Set<string>();
  // the outputs of recreation runs this session started (they live under the hidden, gitignored .harness/recreate/)
  for (const event of s.events) {
    if (event.type !== "recreate.started" || typeof event.dir !== "string") continue;
    try {
      const run = resolveInProject(s.projectRoot, event.dir);
      if (!/[\\/]\.harness[\\/]recreate[\\/][^\\/]+$/.test(run)) continue;
      roots.add(join(run, "out"));
      runRoots.add(join(run, "out"));
      files.add(join(run, "compare", "index.html"));
    } catch {
      /* not inside the project */
    }
  }
  if (restricted) {
    const calls = new Map<string, unknown>();
    for (const event of s.events) {
      if (event.type === "tool.call" && ["write_file", "patch_file"].includes(event.name))
        calls.set(event.id, (event.args as { path?: unknown } | null)?.path);
      if (event.type === "tool.result" && event.ok && calls.has(event.id)) {
        const abs = resolveVisible(calls.get(event.id));
        if (abs) files.add(abs);
      }
      if (event.type === "preview.ready") {
        const abs = resolveVisible(event.path);
        if (abs) {
          files.add(abs);
          const dir = dirname(abs);
          // A root-level index.html never grants access to the entire home directory.
          if (dir !== s.projectRoot && !isWorkspaceContainer(dir)) roots.add(dir);
        }
      }
      if (event.type === "message.end") {
        for (const attachment of event.attachments ?? []) {
          try {
            attachments.add(resolveInProject(s.projectRoot, attachment.path));
          } catch {
            /* Invalid legacy path. */
          }
        }
      }
    }
  }
  const allowed = (abs: string, raw = false) =>
    files.has(abs) ||
    (raw && attachments.has(abs)) ||
    [...roots].some((root) => abs === root || abs.startsWith(root + sep));
  return {
    resolve(path: string, raw = false): string {
      const abs = resolveInProject(s.projectRoot, path);
      if (!allowed(abs, raw)) throw new Error("File is outside this session's workspace.");
      return abs;
    },
    list(path = "."): string[] {
      const base = resolveInProject(s.projectRoot, path);
      if (base !== s.projectRoot && !allowed(base))
        throw new Error("Directory is outside this session's workspace.");
      const candidates = new Set(files);
      for (const root of runRoots) for (const f of walkFiles(root)) candidates.add(f);
      for (const root of roots) {
        if (!existsSync(root)) continue;
        if (runRoots.has(root)) continue;
        for (const name of listProjectFiles(root)) {
          try {
            // Also exclude symlinks pointing outside the workspace being enumerated.
            candidates.add(resolveInProject(root, name));
          } catch {
            /* Out-of-workspace symlink. */
          }
        }
      }
      return [...candidates]
        .filter(
          (abs) =>
            (base === s.projectRoot || abs === base || abs.startsWith(base + sep)) &&
            existsSync(abs) &&
            statSync(abs).isFile(),
        )
        .map(local)
        .sort()
        .slice(0, 20_000);
    },
  };
}

/** Every file under `dir` (no symlinks followed), at most `limit`. */
function walkFiles(dir: string, limit = 5000): string[] {
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
      const full = join(abs, e);
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Project files the conversation referenced (tool `path` arguments and attachments), in first-use order. */
export function sessionReferencedFiles(s: Session): { path: string; uses: string[]; viewable: boolean }[] {
  const scope = sessionFileScope(s);
  const found = new Map<string, Set<string>>();
  const add = (path: unknown, use: string) => {
    if (typeof path !== "string" || !path.trim()) return;
    let abs: string;
    try {
      abs = resolveInProject(s.projectRoot, path);
    } catch {
      return; // outside the project
    }
    // Directories (e.g. list_dir of the project root) aren't files to open.
    if (existsSync(abs) && statSync(abs).isDirectory()) return;
    const rel = relative(s.projectRoot, abs).split(sep).join("/");
    if (!found.has(rel)) found.set(rel, new Set());
    found.get(rel)!.add(use);
  };
  for (const event of s.events) {
    if (event.type === "tool.call") add((event.args as { path?: unknown } | null)?.path, event.name);
    else if (event.type === "preview.ready") add(event.path, "preview");
    else if (event.type === "message.end")
      for (const attachment of event.attachments ?? []) add(attachment.path, "attachment");
  }
  return [...found].map(([path, uses]) => {
    let viewable = false;
    try {
      // Images and PDFs open through /raw (which also serves attachments); text opens through /files.
      const abs = scope.resolve(path, /\.(png|jpe?g|gif|webp|svg|ico|pdf)$/i.test(path));
      viewable = existsSync(abs) && statSync(abs).isFile();
    } catch {
      /* not visible to this session */
    }
    return { path, uses: [...uses], viewable };
  });
}
