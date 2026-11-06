import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { CheckpointChange } from "@harness/protocol";

export type { CheckpointChange };

/**
 * Workspace checkpoints: snapshots of a project's files kept in a shadow git repository outside the
 * project (`<harness home>/checkpoints/<project hash>`), so they never touch the project's own git
 * history, index or branches. A checkpoint is taken before every turn; restoring one first takes a
 * checkpoint of the current state, so a restore can itself be undone.
 *
 * What is captured: every file git would see in the project (its `.gitignore` files are honored, so
 * `node_modules` & co. stay out) plus recreation outputs under `.harness/recreate/` (without the large
 * capture/measure artifacts). Ignored files are neither captured nor touched by a restore.
 *
 * Never captured: environment files (`.env` and `.env.*` at any depth, even when the project tracks
 * them). They usually hold secrets, and checkpoints are kept outside the project indefinitely; a
 * restore leaves them alone, even when restoring an older checkpoint that has them.
 */

const EXCLUDES = [
  "# managed by CDR: what workspace checkpoints leave out",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".next/",
  ".turbo/",
  ".cache/",
  "target/",
  ".DS_Store",
  ".env",
  ".env.*",
  ".harness/*",
  "!.harness/recreate/",
  ".harness/recreate/*/capture/",
  ".harness/recreate/*/measure/",
  "",
].join("\n");

/** Captured even when the project's own .gitignore excludes `.harness/`. */
const RECREATE_PATHSPEC = [
  ".harness/recreate",
  ":(exclude,glob).harness/recreate/*/capture/**",
  ":(exclude,glob).harness/recreate/*/measure/**",
];

/** Environment files: never captured (see the header). Pathspecs override a project's `!.env` rules. */
const ENV_EXCLUDES = [":(exclude,glob)**/.env", ":(exclude,glob)**/.env.*"];
const ENV_TRACKED = [":(glob)**/.env", ":(glob)**/.env.*"];

export function isEnvFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === ".env" || name.startsWith(".env.");
}

/** Refuse to snapshot trees this large (e.g. a project without a .gitignore around huge data). */
const MAX_FILES = 50_000;

export interface Checkpoint {
  commit: string;
  /** Number of files in the snapshot. */
  files: number;
}

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export class CheckpointStore {
  readonly gitDir: string;

  constructor(
    readonly projectRoot: string,
    baseDir: string,
    private readonly maxFiles = MAX_FILES,
  ) {
    const key = createHash("sha1").update(resolve(projectRoot)).digest("hex").slice(0, 16);
    this.gitDir = join(baseDir, key);
  }

  /** Run git against the shadow repository, or (`project: true`) against the project's own repository. */
  private git(args: string[], input?: string, project = false): Promise<GitResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (project) for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
    else
      Object.assign(env, {
        GIT_DIR: this.gitDir,
        GIT_WORK_TREE: this.projectRoot,
        GIT_INDEX_FILE: join(this.gitDir, "index"),
        GIT_AUTHOR_NAME: "CDR",
        GIT_AUTHOR_EMAIL: "cdr@localhost",
        GIT_COMMITTER_NAME: "CDR",
        GIT_COMMITTER_EMAIL: "cdr@localhost",
      });
    return new Promise((done) => {
      const child = spawn("git", args, {
        cwd: this.projectRoot,
        env,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
      child.stderr!.setEncoding("utf8").on("data", (d: string) => (err += d));
      child.on("error", (e) => done({ ok: false, out, err: e.message }));
      child.on("close", (code) => done({ ok: code === 0, out, err }));
      if (child.stdin) {
        // git may exit before reading all of stdin; its exit code reports the outcome.
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
      }
    });
  }

  private async ensureRepo(): Promise<void> {
    if (!existsSync(join(this.gitDir, "HEAD"))) {
      mkdirSync(this.gitDir, { recursive: true });
      const r = await this.git(["init", "-q"]);
      if (!r.ok) throw new Error(`Cannot create checkpoint store: ${(r.err || r.out).trim()}`);
      await this.git(["config", "core.autocrlf", "false"]);
      await this.git(["config", "core.quotepath", "false"]);
      await this.git(["config", "gc.auto", "0"]);
    }
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(join(this.gitDir, "info", "exclude"), EXCLUDES);
  }

  /** Stage the current workspace into the shadow index and return its tree. */
  private async stage(): Promise<{ tree: string; files: number }> {
    await this.ensureRepo();
    // Count files the project's own git does not track (the shadow index is empty on first use, so
    // asking it would count every file). Outside a git repository, fall back to the shadow view.
    let untracked = await this.git(["ls-files", "-z", "--others", "--exclude-standard"], undefined, true);
    if (!untracked.ok) untracked = await this.git(["ls-files", "-z", "--others", "--exclude-standard"]);
    if (untracked.ok && untracked.out.split("\0").filter(Boolean).length > this.maxFiles)
      throw new Error(
        `Workspace has more than ${this.maxFiles} untracked files; add a .gitignore to enable checkpoints`,
      );
    const add = await this.git(["add", "-A", "--", ".", ...ENV_EXCLUDES]);
    if (!add.ok) throw new Error(`Checkpoint failed: ${(add.err || add.out).trim()}`);
    if (existsSync(join(this.projectRoot, ".harness", "recreate")))
      await this.git(["add", "-A", "-f", "--", ...RECREATE_PATHSPEC, ...ENV_EXCLUDES]);
    // Drop env files an older checkpoint (or a restore's read-tree) left in the shadow index.
    await this.git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...ENV_TRACKED]);
    const tree = await this.git(["write-tree"]);
    if (!tree.ok) throw new Error(`Checkpoint failed: ${(tree.err || tree.out).trim()}`);
    const count = await this.git(["ls-files", "-z"]);
    return { tree: tree.out.trim(), files: count.out.split("\0").filter(Boolean).length };
  }

  /** Snapshot the workspace and keep it under `ref` (e.g. `<sessionId>/<checkpointId>`). */
  async create(ref: string, message: string): Promise<Checkpoint> {
    const { tree, files } = await this.stage();
    const c = await this.git(["commit-tree", tree, "-m", message]);
    if (!c.ok) throw new Error(`Checkpoint failed: ${(c.err || c.out).trim()}`);
    const commit = c.out.trim();
    const u = await this.git(["update-ref", `refs/cdr/${ref}`, commit]);
    if (!u.ok) throw new Error(`Checkpoint failed: ${(u.err || u.out).trim()}`);
    return { commit, files };
  }

  async exists(commit: string): Promise<boolean> {
    if (!existsSync(join(this.gitDir, "HEAD"))) return false;
    return (await this.git(["cat-file", "-e", `${commit}^{commit}`])).ok;
  }

  /** Changes between `from` and `to` (commits or trees), seen as what restoring `from` would do. */
  private async changes(from: string, to: string): Promise<CheckpointChange[]> {
    const r = await this.git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]);
    if (!r.ok) throw new Error((r.err || r.out).trim());
    const parts = r.out.split("\0").filter(Boolean);
    const out: CheckpointChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      // Older checkpoints may hold env files; a restore never touches them.
      if (isEnvFile(parts[i + 1])) continue;
      const s = parts[i][0];
      out.push({
        path: parts[i + 1],
        // `to` gained the file → restoring removes it; `to` lost it → restoring brings it back.
        status: s === "A" ? "deleted" : s === "D" ? "added" : "modified",
      });
    }
    return out;
  }

  /** What restoring `commit` would change in the current workspace (does not create a checkpoint). */
  async preview(commit: string): Promise<CheckpointChange[]> {
    const { tree } = await this.stage();
    return this.changes(commit, tree);
  }

  /**
   * Make the workspace match `commit`. `current` must be a checkpoint of the workspace taken just
   * before (so nothing is lost). Ignored/untracked-by-checkpoint files are left alone.
   */
  async restore(commit: string, current: string): Promise<CheckpointChange[]> {
    const changes = await this.changes(commit, current);
    if (!changes.length) return changes;
    const root = resolve(this.projectRoot);
    for (const c of changes) {
      if (c.status !== "deleted") continue;
      const abs = resolve(root, c.path);
      if (!abs.startsWith(root + sep)) continue;
      rmSync(abs, { force: true });
      pruneEmptyDirs(dirname(abs), root);
    }
    const read = await this.git(["read-tree", commit]);
    if (!read.ok) throw new Error(`Restore failed: ${(read.err || read.out).trim()}`);
    const write = changes.filter((c) => c.status !== "deleted").map((c) => c.path);
    if (write.length) {
      const co = await this.git(["checkout-index", "-f", "-z", "--stdin"], write.join("\0") + "\0");
      if (!co.ok) throw new Error(`Restore failed: ${(co.err || co.out).trim()}`);
    }
    return changes;
  }
}

function pruneEmptyDirs(dir: string, root: string): void {
  while (dir !== root && dir.startsWith(root + sep)) {
    try {
      if (readdirSync(dir).length) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}
