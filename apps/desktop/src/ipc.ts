// Typed wrappers around the Rust commands in crates/studio-app/src/commands.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : ((e as Error)?.message ?? String(e)));
  }
}

export function on<T>(event: string, fn: (payload: T) => void): () => void {
  let un: UnlistenFn | undefined;
  let stopped = false;
  void listen<T>(event, (e) => fn(e.payload)).then((u) => (stopped ? u() : (un = u)));
  return () => {
    stopped = true;
    un?.();
  };
}

// ------------------------------------------------------------------ harness & app

export interface HarnessStatus {
  state: "starting" | "ready" | "restarting" | "failed" | "attached";
  url?: string;
  token?: string;
  error?: string;
  node?: string;
  entry?: string;
  restarts: number;
}
export interface Workspace {
  root: string;
  name: string;
}
export interface RecentRepo {
  path: string;
  name: string;
  openedAt: number;
  exists: boolean;
}
export interface AppInfo {
  version: string;
  home: string;
  configDir: string;
  defaultCloneDir: string;
  platform: string;
  githubClientId: boolean;
}

export const harness = {
  status: () => call<HarnessStatus>("harness_status"),
  logs: () => call<string[]>("harness_logs"),
  restart: () => call<void>("harness_restart"),
};
export const app = {
  info: () => call<AppInfo>("app_info"),
  openWorkspace: (path: string) => call<Workspace>("workspace_open", { path }),
  recent: () => call<RecentRepo[]>("workspace_recent"),
  forget: (path: string) => call<void>("workspace_forget", { path }),
  setCloneDir: (path: string) => call<void>("settings_set_clone_dir", { path }),
};

// ------------------------------------------------------------------ files

export interface FileContent {
  path: string;
  content: string;
  binary: boolean;
  size: number;
  tooLarge: boolean;
  mtime: number;
}
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
}
export interface SearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  include?: string;
  maxResults?: number;
}
export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  length: number;
  text: string;
}
export interface FsChange {
  root: string;
  paths: string[];
  gitChanged: boolean;
}

export const fs = {
  read: (root: string, path: string) => call<FileContent>("fs_read", { root, path }),
  write: (root: string, path: string, content: string) => call<number>("fs_write", { root, path, content }),
  create: (root: string, path: string, dir = false) => call<void>("fs_create", { root, path, dir }),
  rename: (root: string, from: string, to: string) => call<void>("fs_rename", { root, from, to }),
  remove: (root: string, path: string) => call<void>("fs_delete", { root, path }),
  listDir: (root: string, path: string) => call<DirEntry[]>("fs_list_dir", { root, path }),
  listFiles: (root: string) => call<string[]>("fs_list_files", { root }),
  search: (root: string, query: string, options: SearchOptions = {}) =>
    call<{ matches: SearchMatch[]; truncated: boolean; filesSearched: number }>("fs_search", {
      root,
      query,
      options,
    }),
  replace: (root: string, query: string, replacement: string, options: SearchOptions, paths: string[]) =>
    call<number>("fs_replace", { root, query, replacement, options, paths }),
  watch: (root: string) => call<void>("watch_start", { root }),
  unwatch: (root: string) => call<void>("watch_stop", { root }),
};

// ------------------------------------------------------------------ git

export type ChangeKind =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "typeChanged"
  | "unmerged";
export interface FileStatus {
  path: string;
  origPath?: string;
  index: ChangeKind;
  worktree: ChangeKind;
  conflicted: boolean;
}
export interface GitStatus {
  branch?: string;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  files: FileStatus[];
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
}
export interface DiffLine {
  kind: "add" | "del" | "context";
  oldNo?: number;
  newNo?: number;
  text: string;
}
export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}
export interface FileDiff {
  path: string;
  binary: boolean;
  hunks: Hunk[];
}
export interface RefLabel {
  name: string;
  kind: "localBranch" | "remoteBranch" | "tag" | "head";
}
export interface Commit {
  id: string;
  shortId: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerTime: number;
  subject: string;
  body: string;
  refs: RefLabel[];
}
export interface GraphEdge {
  fromLane: number;
  toLane: number;
  kind: "firstParent" | "mergeParent" | "passThrough";
}
export interface GraphRow {
  lane: number;
  lanesIn: number[];
  edges: GraphEdge[];
  width: number;
}
export interface CommitFile {
  path: string;
  origPath?: string;
  kind: ChangeKind | string;
  additions: number;
  deletions: number;
}
export interface Branch {
  name: string;
  isRemote: boolean;
  isHead: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  lastCommitTime: number;
  lastSubject: string;
  shortId: string;
}
export interface MergeResult {
  ok: boolean;
  conflicts: string[];
  message: string;
}
export interface Stash {
  index: number;
  message: string;
  id: string;
}
export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}
export interface Worktree {
  path: string;
  branch?: string;
  head: string;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}
export interface ConflictFile {
  base?: string;
  ours?: string;
  theirs?: string;
  merged: string;
}
export interface BlameLine {
  line: number;
  commitId: string;
  author: string;
  time: number;
  summary: string;
}
export interface GitProgress {
  op: string;
  percent?: number;
  phase: string;
}

export const git = {
  isRepo: (root: string) => call<boolean>("git_is_repo", { root }),
  init: (root: string) => call<void>("git_init", { root }),
  status: (root: string) => call<GitStatus>("git_status", { root }),
  diffFile: (root: string, path: string, staged: boolean) =>
    call<FileDiff>("git_diff_file", { root, path, staged }),
  diffText: (root: string, staged: boolean) => call<string>("git_diff_text", { root, staged }),
  stage: (root: string, paths: string[]) => call<void>("git_stage", { root, paths }),
  unstage: (root: string, paths: string[]) => call<void>("git_unstage", { root, paths }),
  discard: (root: string, paths: string[]) => call<void>("git_discard", { root, paths }),
  stageHunk: (root: string, path: string, hunk: number) => call<void>("git_stage_hunk", { root, path, hunk }),
  unstageHunk: (root: string, path: string, hunk: number) =>
    call<void>("git_unstage_hunk", { root, path, hunk }),
  discardHunk: (root: string, path: string, hunk: number) =>
    call<void>("git_discard_hunk", { root, path, hunk }),
  commit: (
    root: string,
    o: { message: string; amend?: boolean; signOff?: boolean; coAuthors?: string[]; allowEmpty?: boolean },
  ) =>
    call<Commit>("git_commit", {
      root,
      options: { amend: false, signOff: false, coAuthors: [], allowEmpty: false, ...o },
    }),
  log: (
    root: string,
    o: { rev?: string; path?: string; skip?: number; limit?: number; search?: string } = {},
  ) =>
    call<{ commits: Commit[]; graph: GraphRow[] }>("git_log", {
      root,
      options: { skip: 0, limit: 200, ...o },
    }),
  show: (root: string, id: string) => call<{ commit: Commit; files: CommitFile[] }>("git_show", { root, id }),
  commitFileDiff: (root: string, id: string, path: string) =>
    call<FileDiff>("git_commit_file_diff", { root, id, path }),
  blame: (root: string, path: string) => call<BlameLine[]>("git_blame", { root, path }),
  branches: (root: string) => call<Branch[]>("git_branches", { root }),
  createBranch: (root: string, name: string, start?: string, checkout = true) =>
    call<void>("git_create_branch", { root, name, start, checkout }),
  checkout: (root: string, name: string) => call<void>("git_checkout", { root, name }),
  renameBranch: (root: string, from: string, to: string) =>
    call<void>("git_rename_branch", { root, from, to }),
  deleteBranch: (root: string, name: string, force = false) =>
    call<void>("git_delete_branch", { root, name, force }),
  merge: (root: string, branch: string) => call<MergeResult>("git_merge", { root, branch }),
  rebase: (root: string, onto: string) => call<MergeResult>("git_rebase", { root, onto }),
  abort: (root: string) => call<void>("git_abort", { root }),
  continueRebase: (root: string) => call<MergeResult>("git_continue_rebase", { root }),
  cherryPick: (root: string, id: string) => call<MergeResult>("git_cherry_pick", { root, id }),
  stashes: (root: string) => call<Stash[]>("git_stashes", { root }),
  stashPush: (root: string, message?: string, includeUntracked = true) =>
    call<void>("git_stash_push", { root, message, includeUntracked }),
  stashPop: (root: string, index: number) => call<void>("git_stash_pop", { root, index }),
  stashDrop: (root: string, index: number) => call<void>("git_stash_drop", { root, index }),
  remotes: (root: string) => call<Remote[]>("git_remotes", { root }),
  addRemote: (root: string, name: string, url: string) => call<void>("git_add_remote", { root, name, url }),
  fetch: (root: string) => call<void>("git_fetch", { root }),
  pull: (root: string) => call<MergeResult>("git_pull", { root }),
  push: (root: string, o: { setUpstream?: boolean; forceWithLease?: boolean; branch?: string } = {}) =>
    call<void>("git_push", {
      root,
      branch: o.branch,
      setUpstream: !!o.setUpstream,
      forceWithLease: !!o.forceWithLease,
    }),
  clone: (url: string, dest: string, o: { branch?: string; depth?: number } = {}) =>
    call<string>("git_clone", { url, dest, options: o }),
  cancel: (op: string) => call<void>("git_cancel", { op }),
  worktrees: (root: string) => call<Worktree[]>("git_worktrees", { root }),
  conflict: (root: string, path: string) => call<ConflictFile>("git_conflict", { root, path }),
  resolve: (root: string, path: string, content: string) =>
    call<void>("git_resolve", { root, path, content }),
};

// ------------------------------------------------------------------ terminals

export const pty = {
  spawn: (root: string, cols: number, rows: number, command?: string) =>
    call<number>("pty_spawn", { root, cols, rows, command }),
  write: (id: number, data: string) => call<void>("pty_write", { id, data }),
  resize: (id: number, cols: number, rows: number) => call<void>("pty_resize", { id, cols, rows }),
  kill: (id: number) => call<void>("pty_kill", { id }),
};

// ------------------------------------------------------------------ language servers

export interface Diagnostic {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}
export const lsp = {
  available: () => call<{ language: string; command: string; available: boolean }[]>("lsp_available"),
  start: (root: string, language: string) => call<number | null>("lsp_start", { root, language }),
  send: (id: number, message: unknown) => call<void>("lsp_send", { id, message: JSON.stringify(message) }),
  diagnostics: (root: string) => call<Diagnostic[]>("lsp_diagnostics", { root }),
};

// ------------------------------------------------------------------ secrets & GitHub

export interface GithubUser {
  login: string;
  name?: string;
  avatarUrl?: string;
}
export interface GithubRepo {
  fullName: string;
  description?: string;
  private: boolean;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  updatedAt: string;
  stars: number;
  fork: boolean;
}
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  head: string;
  base: string;
  author: string;
  updatedAt: string;
  checks: string;
}
export const keys = {
  list: () => call<{ name: string; backend: string }[]>("provider_keys_list"),
  set: (name: string, value: string) => call<void>("provider_key_set", { name, value }),
  remove: (name: string) => call<void>("provider_key_delete", { name }),
};
export const github = {
  status: () => call<GithubUser | null>("github_status"),
  setToken: (token: string) => call<GithubUser>("github_set_token", { token }),
  importGh: () => call<GithubUser>("github_import_gh"),
  logout: () => call<void>("github_logout"),
  repos: (page = 1) => call<GithubRepo[]>("github_repos", { page }),
  search: (query: string) => call<GithubRepo[]>("github_search", { query }),
  pulls: (root: string) => call<PullRequest[]>("github_pulls", { root }),
  createPr: (root: string, o: { head: string; base: string; title: string; body: string; draft: boolean }) =>
    call<PullRequest>("github_create_pr", { root, ...o }),
  deviceStart: () =>
    call<{
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      interval: number;
      expiresIn: number;
    }>("github_device_start"),
  devicePoll: (deviceCode: string) => call<GithubUser | null>("github_device_poll", { deviceCode }),
};
