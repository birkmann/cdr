//! Worktrees and conflict resolution.

use std::path::Path;

use serde::Serialize;

use crate::cmd::{self, no_option, run, safe_join, split_nul};
use crate::error::Result;

/// A linked or main work tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Absolute path.
    pub path: String,
    /// Checked out branch (short name); `None` when detached or bare.
    pub branch: Option<String>,
    /// HEAD commit id (empty for a bare main repository).
    pub head: String,
    pub locked: bool,
    pub prunable: bool,
    /// The main work tree (first entry).
    pub is_main: bool,
}

/// The versions of a conflicted file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    /// Common ancestor (stage 1).
    pub base: Option<String>,
    /// Current branch version (stage 2).
    pub ours: Option<String>,
    /// Incoming version (stage 3).
    pub theirs: Option<String>,
    /// Working tree file, usually with conflict markers (empty if deleted).
    pub merged: String,
}

/// Lists work trees (`git worktree list --porcelain -z`).
pub fn worktrees(repo: &Path) -> Result<Vec<Worktree>> {
    let out = run(repo, &["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_worktrees(&out))
}

pub(crate) fn parse_worktrees(out: &[u8]) -> Vec<Worktree> {
    let mut list = Vec::new();
    let mut cur: Option<Worktree> = None;
    for field in split_nul(out).into_iter().chain([String::new()]) {
        if field.is_empty() {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((&field, ""));
        if key == "worktree" {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            cur = Some(Worktree {
                path: value.to_string(),
                branch: None,
                head: String::new(),
                locked: false,
                prunable: false,
                is_main: list.is_empty(),
            });
            continue;
        }
        let Some(w) = cur.as_mut() else { continue };
        match key {
            "HEAD" => w.head = value.to_string(),
            "branch" => {
                w.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_string(),
                )
            }
            "locked" => w.locked = true,
            "prunable" => w.prunable = true,
            _ => {}
        }
    }
    list
}

/// Adds a work tree at `path`. With `create`, a new branch `branch` is
/// created from `start` (default HEAD); otherwise the existing branch is
/// checked out there.
pub fn add_worktree(
    repo: &Path,
    path: &Path,
    branch: &str,
    create: bool,
    start: Option<&str>,
) -> Result<()> {
    no_option("branch", branch)?;
    let p = path.as_os_str().to_string_lossy().into_owned();
    let mut args = vec!["worktree".to_string(), "add".into(), "-q".into()];
    if create {
        args.extend(["-b".into(), branch.into(), "--".into(), p]);
        if let Some(s) = start.filter(|s| !s.is_empty()) {
            no_option("start point", s)?;
            args.push(s.into());
        }
    } else {
        args.extend(["--".into(), p, branch.into()]);
    }
    run(repo, &args)?;
    Ok(())
}

/// Removes the work tree at `path`.
pub fn remove_worktree(repo: &Path, path: &Path, force: bool) -> Result<()> {
    let p = path.as_os_str().to_string_lossy().into_owned();
    let mut args = vec!["worktree".to_string(), "remove".into()];
    if force {
        args.push("--force".into());
    }
    args.extend(["--".into(), p]);
    run(repo, &args)?;
    Ok(())
}

fn stage_blob(repo: &Path, stage: u8, path: &str) -> Result<Option<String>> {
    let spec = format!(":{stage}:{path}");
    let out = cmd::output(repo, &["cat-file", "blob", &spec], None)?;
    Ok(out
        .status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned()))
}

/// Base / ours / theirs versions (index stages 1-3) and the working file.
pub fn conflict_versions(repo: &Path, path: &str) -> Result<ConflictFile> {
    let full = safe_join(repo, path)?;
    let merged = match std::fs::read(&full) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    Ok(ConflictFile {
        base: stage_blob(repo, 1, path)?,
        ours: stage_blob(repo, 2, path)?,
        theirs: stage_blob(repo, 3, path)?,
        merged,
    })
}

/// Writes the resolved `content` to `path` and stages it.
pub fn resolve_conflict(repo: &Path, path: &str, content: &str) -> Result<()> {
    let full = safe_join(repo, path)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&full, content)?;
    run(repo, &["add", "--", &cmd::lit(path)])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_porcelain() {
        let raw = b"worktree /r\0HEAD abc\0branch refs/heads/main\0\0worktree /r-wt\0HEAD def\0detached\0locked reason\0\0worktree /gone\0HEAD 123\0branch refs/heads/x\0prunable gitdir file points to non-existent location\0\0";
        let w = parse_worktrees(raw);
        assert_eq!(w.len(), 3);
        assert!(w[0].is_main);
        assert_eq!(w[0].branch.as_deref(), Some("main"));
        assert!(!w[1].is_main);
        assert!(w[1].branch.is_none());
        assert!(w[1].locked);
        assert_eq!(w[1].head, "def");
        assert!(w[2].prunable);
    }
}
