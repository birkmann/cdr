//! Branches, merge / rebase / cherry-pick and stashes.

use std::path::Path;

use serde::Serialize;

use crate::cmd::{self, no_option, run, run_str, split_nul};
use crate::error::{Error, Result};

/// A local or remote-tracking branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Short name: `main` or `origin/main`.
    pub name: String,
    pub is_remote: bool,
    /// The branch is checked out in this work tree.
    pub is_head: bool,
    /// Upstream of a local branch, e.g. `origin/main`.
    pub upstream: Option<String>,
    /// Commits ahead of upstream (`None` without upstream).
    pub ahead: Option<u32>,
    /// Commits behind upstream (`None` without upstream).
    pub behind: Option<u32>,
    /// Committer time of the tip, unix seconds.
    pub last_commit_time: i64,
    pub last_subject: String,
    pub short_id: String,
}

/// Outcome of merge, rebase, cherry-pick, pull and stash pop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    /// True when the operation completed without conflicts.
    pub ok: bool,
    /// Paths with conflicts that must be resolved.
    pub conflicts: Vec<String>,
    /// Git's output.
    pub message: String,
}

/// A stash entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    /// N in `stash@{N}`.
    pub index: usize,
    pub message: String,
    /// Commit id of the stash.
    pub id: String,
}

/// Lists local branches followed by remote-tracking branches.
pub fn branches(repo: &Path) -> Result<Vec<Branch>> {
    let out = run_str(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(objectname:short)%00%(contents:subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut list = Vec::new();
    for line in out.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.splitn(7, '\0').collect();
        if f.len() != 7 {
            return Err(Error::Parse(format!("bad for-each-ref line {line:?}")));
        }
        let (name, is_remote) = if let Some(n) = f[0].strip_prefix("refs/heads/") {
            (n, false)
        } else if let Some(n) = f[0].strip_prefix("refs/remotes/") {
            if n.ends_with("/HEAD") {
                continue;
            }
            (n, true)
        } else {
            continue;
        };
        let upstream = (!f[2].is_empty()).then(|| f[2].to_string());
        let (mut ahead, mut behind) = (None, None);
        if upstream.is_some() && f[3] != "gone" {
            ahead = Some(0);
            behind = Some(0);
            for part in f[3].split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") {
                    ahead = n.parse().ok();
                } else if let Some(n) = part.strip_prefix("behind ") {
                    behind = n.parse().ok();
                }
            }
        }
        list.push(Branch {
            name: name.to_string(),
            is_remote,
            is_head: f[1] == "*",
            upstream,
            ahead,
            behind,
            last_commit_time: f[4].parse().unwrap_or(0),
            short_id: f[5].to_string(),
            last_subject: f[6].to_string(),
        });
    }
    Ok(list)
}

fn ref_exists(repo: &Path, full: &str) -> Result<bool> {
    Ok(
        cmd::output(repo, &["show-ref", "--verify", "--quiet", full], None)?
            .status
            .success(),
    )
}

/// Creates branch `name` at `start` (default HEAD), optionally checking it out.
pub fn create_branch(repo: &Path, name: &str, start: Option<&str>, checkout: bool) -> Result<()> {
    no_option("branch name", name)?;
    let mut args = if checkout {
        vec!["checkout", "-q", "-b", name]
    } else {
        vec!["branch", name]
    };
    if let Some(s) = start.filter(|s| !s.is_empty()) {
        no_option("start point", s)?;
        args.push(s);
    }
    run(repo, &args)?;
    Ok(())
}

/// Checks out a branch (or any revision, detached). Giving a remote-tracking
/// branch such as `origin/feature` checks out (creating if needed) a local
/// `feature` branch tracking it.
pub fn checkout(repo: &Path, name: &str) -> Result<()> {
    no_option("branch name", name)?;
    if ref_exists(repo, &format!("refs/heads/{name}"))? {
        run(repo, &["checkout", "-q", name, "--"])?;
        return Ok(());
    }
    if ref_exists(repo, &format!("refs/remotes/{name}"))? {
        let local = name.split_once('/').map(|(_, b)| b).unwrap_or(name);
        if ref_exists(repo, &format!("refs/heads/{local}"))? {
            run(repo, &["checkout", "-q", local, "--"])?;
        } else {
            run(repo, &["checkout", "-q", "-b", local, "--track", name])?;
        }
        return Ok(());
    }
    run(repo, &["checkout", "-q", name, "--"])?;
    Ok(())
}

/// Renames a local branch.
pub fn rename_branch(repo: &Path, old: &str, new: &str) -> Result<()> {
    no_option("branch name", old)?;
    no_option("branch name", new)?;
    run(repo, &["branch", "-m", old, new])?;
    Ok(())
}

/// Deletes a local branch (`-d`, or `-D` with `force`).
pub fn delete_branch(repo: &Path, name: &str, force: bool) -> Result<()> {
    no_option("branch name", name)?;
    run(repo, &["branch", if force { "-D" } else { "-d" }, name])?;
    Ok(())
}

/// Paths with unresolved conflicts.
pub fn conflicted_paths(repo: &Path) -> Result<Vec<String>> {
    Ok(split_nul(&run(
        repo,
        &["diff", "--name-only", "--diff-filter=U", "-z"],
    )?))
}

fn combined(out: &std::process::Output) -> String {
    let mut s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let e = String::from_utf8_lossy(&out.stderr);
    if !e.trim().is_empty() {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str(e.trim());
    }
    s
}

/// Runs a command that may stop with conflicts. Conflicts give `ok: false`;
/// other failures are errors.
pub(crate) fn conflicting_op(repo: &Path, args: &[&str]) -> Result<MergeResult> {
    let out = cmd::output(repo, args, None)?;
    let message = combined(&out);
    if out.status.success() {
        return Ok(MergeResult {
            ok: true,
            conflicts: Vec::new(),
            message,
        });
    }
    let conflicts = conflicted_paths(repo)?;
    if conflicts.is_empty() {
        return Err(cmd::failure(args, &out));
    }
    Ok(MergeResult {
        ok: false,
        conflicts,
        message,
    })
}

/// Merges `branch` into the current branch (`git merge --no-edit`).
pub fn merge(repo: &Path, branch: &str) -> Result<MergeResult> {
    no_option("branch", branch)?;
    conflicting_op(repo, &["merge", "--no-edit", branch])
}

/// Rebases the current branch onto `onto`.
pub fn rebase(repo: &Path, onto: &str) -> Result<MergeResult> {
    no_option("revision", onto)?;
    conflicting_op(repo, &["rebase", onto])
}

/// Aborts an in-progress merge.
pub fn abort_merge(repo: &Path) -> Result<()> {
    run(repo, &["merge", "--abort"])?;
    Ok(())
}

/// Aborts an in-progress rebase.
pub fn abort_rebase(repo: &Path) -> Result<()> {
    run(repo, &["rebase", "--abort"])?;
    Ok(())
}

/// Continues a rebase after conflicts were resolved and staged.
pub fn continue_rebase(repo: &Path) -> Result<MergeResult> {
    conflicting_op(repo, &["rebase", "--continue"])
}

/// Cherry-picks commit `id` onto the current branch.
pub fn cherry_pick(repo: &Path, id: &str) -> Result<MergeResult> {
    no_option("commit id", id)?;
    conflicting_op(repo, &["cherry-pick", id])
}

/// Aborts an in-progress cherry-pick.
pub fn abort_cherry_pick(repo: &Path) -> Result<()> {
    run(repo, &["cherry-pick", "--abort"])?;
    Ok(())
}

/// Lists stashes, newest first.
pub fn stashes(repo: &Path) -> Result<Vec<Stash>> {
    let out = run_str(repo, &["stash", "list", "--format=%gd%x00%H%x00%gs"])?;
    let mut list = Vec::new();
    for line in out.lines().filter(|l| !l.is_empty()) {
        let f: Vec<&str> = line.splitn(3, '\0').collect();
        if f.len() != 3 {
            return Err(Error::Parse(format!("bad stash line {line:?}")));
        }
        let index = f[0]
            .strip_prefix("stash@{")
            .and_then(|s| s.strip_suffix('}'))
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| Error::Parse(format!("bad stash ref {:?}", f[0])))?;
        list.push(Stash {
            index,
            id: f[1].to_string(),
            message: f[2].to_string(),
        });
    }
    Ok(list)
}

/// Stashes local changes. Returns false when there was nothing to stash.
pub fn stash_push(repo: &Path, message: Option<&str>, include_untracked: bool) -> Result<bool> {
    let before = stashes(repo)?.first().map(|s| s.id.clone());
    let mut args = vec!["stash", "push", "-q"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if let Some(m) = message.filter(|m| !m.is_empty()) {
        args.extend(["-m", m]);
    }
    run(repo, &args)?;
    let after = stashes(repo)?.first().map(|s| s.id.clone());
    Ok(after.is_some() && after != before)
}

/// Applies and removes `stash@{index}`. Conflicts keep the stash.
pub fn stash_pop(repo: &Path, index: usize) -> Result<MergeResult> {
    let r = format!("stash@{{{index}}}");
    conflicting_op(repo, &["stash", "pop", &r])
}

/// Applies `stash@{index}` without removing it.
pub fn stash_apply(repo: &Path, index: usize) -> Result<MergeResult> {
    let r = format!("stash@{{{index}}}");
    conflicting_op(repo, &["stash", "apply", &r])
}

/// Deletes `stash@{index}`.
pub fn stash_drop(repo: &Path, index: usize) -> Result<()> {
    let r = format!("stash@{{{index}}}");
    run(repo, &["stash", "drop", "-q", &r])?;
    Ok(())
}
