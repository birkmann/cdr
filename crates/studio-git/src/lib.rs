//! Git operations for CDR Studio.
//!
//! Everything shells out to the `git` executable (porcelain / plumbing output
//! with `-z` parsing), so the user's credential helpers, SSH agent, hooks and
//! configuration apply unchanged. Every function takes the repository path
//! explicitly and is a plain blocking function; callers in async contexts
//! should use `spawn_blocking`.
//!
//! Commands run with `LC_ALL=C`, `-c core.quotepath=off` and
//! `GIT_LITERAL_PATHSPECS=1`; non-network commands additionally run with
//! `GIT_TERMINAL_PROMPT=0` and no stdin. Network commands ([`clone`],
//! [`fetch`], [`pull`], [`push`]) stream `--progress` output to a callback and
//! can be cancelled with an `Arc<AtomicBool>`.
//!
//! [`set_extra_config`] injects process-wide git configuration (for example
//! a GitHub token as `http.https://github.com/.extraheader`) through
//! `GIT_CONFIG_*` environment variables into every command.
//!
//! All public types serialize with camelCase field names for the TypeScript
//! webview; [`Error`] serializes as its message string.

mod branch;
mod cmd;
mod diff;
mod error;
mod graph;
mod history;
mod progress;
mod remote;
mod status;
mod worktree;

pub use branch::{
    abort_cherry_pick, abort_merge, abort_rebase, branches, checkout, cherry_pick,
    conflicted_paths, continue_rebase, create_branch, delete_branch, merge, rebase, rename_branch,
    stash_apply, stash_drop, stash_pop, stash_push, stashes, Branch, MergeResult, Stash,
};
pub use cmd::set_extra_config;
pub use diff::{
    diff_file, diff_text, discard, discard_hunk, stage, stage_hunk, unstage, unstage_hunk,
    DiffLine, DiffLineKind, FileDiff, Hunk,
};
pub use error::{Error, Result};
pub use graph::{graph_lanes, EdgeKind, GraphEdge, GraphRow};
pub use history::{
    blame, commit, commit_file_diff, log, show_commit, BlameLine, Commit, CommitDetail, CommitFile,
    CommitInfo, CommitOptions, LogOptions, RefKind, RefLabel,
};
pub use progress::{parse_progress, Progress};
pub use remote::{
    add_remote, clone, fetch, github_repo_slug, parse_github_url, pull, push, remotes,
    remove_remote, CloneOptions, Remote,
};
pub use status::{init, is_repo, repo_root, status, ChangeKind, FileStatus, Status};
pub use worktree::{
    add_worktree, conflict_versions, remove_worktree, resolve_conflict, worktrees, ConflictFile,
    Worktree,
};
