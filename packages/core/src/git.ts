import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { truncateMiddle } from "./util.js";

export function git(root: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

export function isGitRepo(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"]).ok;
}

export function hasHead(root: string): boolean {
  return git(root, ["rev-parse", "--verify", "-q", "HEAD"]).ok;
}

/** Full working-tree diff against HEAD including untracked files (excluding .harness/). */
export function workingTreeDiff(root: string, maxChars = 60_000): string | null {
  if (!isGitRepo(root)) return null;
  const parts: string[] = [];
  if (hasHead(root)) parts.push(git(root, ["diff", "HEAD", "--", ".", ":(exclude).harness"]).out);
  else
    parts.push(
      git(root, ["diff", "--cached", "--", ".", ":(exclude).harness"]).out,
      git(root, ["diff", "--", ".", ":(exclude).harness"]).out,
    );
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"])
    .out.split("\n")
    .filter((f) => f && !f.startsWith(".harness/"));
  for (const f of untracked.slice(0, 30)) {
    const p = join(root, f);
    try {
      if (!existsSync(p) || statSync(p).size > 100_000) {
        parts.push(`--- /dev/null\n+++ b/${f}\n(new file, too large to show)`);
        continue;
      }
      const content = readFileSync(p, "utf8");
      parts.push(
        `--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${content.split("\n").length} @@\n${content
          .split("\n")
          .map((l) => "+" + l)
          .join("\n")}`,
      );
    } catch {
      /* ignore */
    }
  }
  if (untracked.length > 30) parts.push(`(${untracked.length - 30} more untracked files not shown)`);
  return truncateMiddle(parts.filter(Boolean).join("\n").trim(), maxChars).text;
}

export function currentBranch(root: string): string | null {
  const r = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.out.trim() : null;
}

/** Create branch harness/<slug> (unique) and commit all changes except .harness/. */
export function commitOnBranch(
  root: string,
  slug: string,
  message: string,
): { ok: boolean; branch?: string; error?: string } {
  if (!isGitRepo(root)) return { ok: false, error: "not a git repository" };
  let branch = `harness/${slug}`;
  for (let i = 2; git(root, ["rev-parse", "--verify", "-q", branch]).ok; i++) branch = `harness/${slug}-${i}`;
  const co = git(root, ["checkout", "-b", branch]);
  if (!co.ok) return { ok: false, error: co.err.trim() };
  const c = commitAll(root, message);
  if (!c.ok) return { ok: false, branch, error: c.error };
  if (!c.commit) return { ok: false, branch, error: "nothing to commit" };
  return { ok: true, branch };
}

// ---------------------------------------------------------------- worktrees (subagents, goals)

/** `-c user.*` arguments when the repository has no committer identity configured. */
function identityArgs(root: string): string[] {
  const args: string[] = [];
  if (!git(root, ["config", "user.name"]).out.trim()) args.push("-c", "user.name=CDR");
  if (!git(root, ["config", "user.email"]).out.trim()) args.push("-c", "user.email=cdr@localhost");
  return args;
}

/** Top-level directory of the main checkout of the repository containing `root`. */
export function repoRoot(root: string): string | null {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  const dir = common.out.trim();
  // Main checkout: <top>/.git. A linked worktree reports the main repo's .git dir.
  return dir.endsWith("/.git") ? dir.slice(0, -5) : top.ok ? top.out.trim() : null;
}

/** Keep `.harness/` (worktrees, plans, reports) out of `git status` of the main checkout. */
function excludeHarnessDir(root: string): void {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return;
  const file = join(common.out.trim(), "info", "exclude");
  try {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split("\n").some((l) => l.trim() === ".harness/" || l.trim() === ".harness")) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}.harness/\n`);
  } catch {
    /* best effort */
  }
}

export function branchExists(root: string, branch: string): boolean {
  return git(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).ok;
}

/** Create a linked worktree at `path` on `branch` (created from `base`, default HEAD, if it does not exist). */
export function createWorktree(
  root: string,
  path: string,
  branch: string,
  base?: string,
): { ok: boolean; path: string; branch: string; base?: string; error?: string } {
  if (!isGitRepo(root)) return { ok: false, path, branch, error: "not a git repository" };
  if (!hasHead(root)) return { ok: false, path, branch, error: "repository has no commits yet" };
  excludeHarnessDir(root);
  mkdirSync(dirname(path), { recursive: true });
  const r = branchExists(root, branch)
    ? git(root, ["worktree", "add", path, branch])
    : git(root, ["worktree", "add", "-b", branch, path, base ?? "HEAD"]);
  if (!r.ok) return { ok: false, path, branch, error: (r.err || r.out).trim() };
  const head = git(path, ["rev-parse", "HEAD"]);
  return { ok: true, path, branch, base: head.ok ? head.out.trim() : undefined };
}

/** Remove a linked worktree (forcefully) and optionally its branch. */
export function removeWorktree(
  root: string,
  path: string,
  opts: { deleteBranch?: boolean | string } = {},
): { ok: boolean; error?: string } {
  let branch = typeof opts.deleteBranch === "string" ? opts.deleteBranch : undefined;
  if (opts.deleteBranch === true && existsSync(path)) {
    const b = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (b.ok && b.out.trim() !== "HEAD") branch = b.out.trim();
  }
  let error: string | undefined;
  if (existsSync(path)) {
    const r = git(root, ["worktree", "remove", "--force", "--force", path]);
    if (!r.ok) error = (r.err || r.out).trim();
  }
  git(root, ["worktree", "prune"]);
  if (branch && branchExists(root, branch)) {
    const d = git(root, ["branch", "-D", branch]);
    if (!d.ok) error ??= (d.err || d.out).trim();
  }
  return { ok: !error, error };
}

/** Stage everything except `.harness/` and commit. `commit` is the new HEAD, or undefined if nothing changed. */
export function commitAll(root: string, message: string): { ok: boolean; commit?: string; error?: string } {
  if (!isGitRepo(root)) return { ok: false, error: "not a git repository" };
  // Naming an ignored path in a pathspec makes `git add` fail, so only exclude .harness/ when it is not ignored.
  const ignored = git(root, ["check-ignore", "-q", ".harness/"]).ok;
  const add = git(root, ["add", "-A", "--", ".", ...(ignored ? [] : [":(exclude).harness"])]);
  if (!add.ok) return { ok: false, error: (add.err || add.out).trim() };
  if (git(root, ["diff", "--cached", "--quiet"]).ok) return { ok: true };
  const c = git(root, [...identityArgs(root), "commit", "-q", "-m", message, "--no-verify"]);
  if (!c.ok) return { ok: false, error: (c.err || c.out).trim() };
  return { ok: true, commit: git(root, ["rev-parse", "HEAD"]).out.trim() };
}

/** Merge `branch` into the current branch of `root`. Aborts and lists conflicting files on conflict. */
export function mergeBranch(
  root: string,
  branch: string,
  message?: string,
): { ok: boolean; commit?: string; conflicts?: string[]; error?: string } {
  if (!isGitRepo(root)) return { ok: false, error: "not a git repository" };
  if (!branchExists(root, branch)) return { ok: false, error: `no such branch: ${branch}` };
  const r = git(root, [
    ...identityArgs(root),
    "merge",
    "--no-ff",
    "--no-edit",
    ...(message ? ["-m", message] : []),
    branch,
  ]);
  if (r.ok) return { ok: true, commit: git(root, ["rev-parse", "HEAD"]).out.trim() };
  const conflicts = git(root, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
  if (conflicts.length) git(root, ["merge", "--abort"]);
  return { ok: false, conflicts: conflicts.length ? conflicts : undefined, error: (r.err || r.out).trim() };
}

/** `git diff --stat` of the working tree against `base` (default HEAD), plus untracked files; excludes `.harness/`. */
export function diffStat(root: string, base = "HEAD"): string {
  if (!isGitRepo(root)) return "";
  const stat = git(root, ["diff", "--stat", base, "--", ".", ":(exclude).harness"]).out.trimEnd();
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"])
    .out.split("\n")
    .filter((f) => f && !f.startsWith(".harness/"));
  return [stat, ...untracked.map((f) => ` ${f} | new (untracked)`)].filter(Boolean).join("\n");
}
