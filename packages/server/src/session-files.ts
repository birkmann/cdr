import { existsSync, statSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
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
  else {
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
      for (const root of roots) {
        if (!existsSync(root)) continue;
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
