//! Repository discovery and working tree status.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cmd::{self, git_dir, run, run_str};
use crate::error::{Error, Result};

/// Kind of change of a file in the index or the working tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Unmodified,
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
    /// Unmerged (part of a conflict).
    Unmerged,
    Untracked,
    Ignored,
}

impl ChangeKind {
    pub(crate) fn from_code(c: char) -> ChangeKind {
        match c {
            'M' => ChangeKind::Modified,
            'T' => ChangeKind::TypeChanged,
            'A' => ChangeKind::Added,
            'D' => ChangeKind::Deleted,
            'R' => ChangeKind::Renamed,
            'C' => ChangeKind::Copied,
            'U' => ChangeKind::Unmerged,
            '?' => ChangeKind::Untracked,
            '!' => ChangeKind::Ignored,
            _ => ChangeKind::Unmodified,
        }
    }
}

/// One changed path from `git status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    /// Repository-relative path with forward slashes.
    pub path: String,
    /// Original path for renames and copies.
    pub orig_path: Option<String>,
    /// Staged change (HEAD vs index).
    pub index: ChangeKind,
    /// Unstaged change (index vs working tree).
    pub worktree: ChangeKind,
    /// The path has unresolved merge conflicts.
    pub conflicted: bool,
}

/// Working tree status.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Current branch name; `None` when detached.
    pub branch: Option<String>,
    /// Abbreviated HEAD commit id; `None` before the first commit.
    pub head: Option<String>,
    /// Upstream branch, e.g. `origin/main`.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub detached: bool,
    pub files: Vec<FileStatus>,
    pub merge_in_progress: bool,
    pub rebase_in_progress: bool,
    pub cherry_pick_in_progress: bool,
}

/// Returns true when `path` is inside a git work tree.
pub fn is_repo(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    cmd::output(path, &["rev-parse", "--is-inside-work-tree"], None)
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Returns the top-level directory of the work tree containing `path`.
pub fn repo_root(path: &Path) -> Result<PathBuf> {
    if !path.is_dir() {
        return Err(Error::NotARepo(path.to_path_buf()));
    }
    let out = cmd::output(path, &["rev-parse", "--show-toplevel"], None)?;
    if !out.status.success() {
        return Err(Error::NotARepo(path.to_path_buf()));
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Ok(PathBuf::from(s.trim_end_matches(['\n', '\r'])))
}

/// Creates `path` (if needed) and runs `git init` in it.
pub fn init(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    run(path, &["init", "-q"])?;
    Ok(())
}

/// Returns the working tree status (`git status --porcelain=v2 --branch -z`).
pub fn status(repo: &Path) -> Result<Status> {
    let out = run(
        repo,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )?;
    let mut st = parse_status(&out)?;
    let dir = git_dir(repo)?;
    st.merge_in_progress = dir.join("MERGE_HEAD").exists();
    st.rebase_in_progress = dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists();
    st.cherry_pick_in_progress = dir.join("CHERRY_PICK_HEAD").exists();
    Ok(st)
}

fn xy(field: &str) -> Result<(ChangeKind, ChangeKind)> {
    let mut chars = field.chars();
    match (chars.next(), chars.next()) {
        (Some(x), Some(y)) => Ok((ChangeKind::from_code(x), ChangeKind::from_code(y))),
        _ => Err(Error::Parse(format!("bad status XY field {field:?}"))),
    }
}

/// Parses `git status --porcelain=v2 --branch -z` output.
pub(crate) fn parse_status(bytes: &[u8]) -> Result<Status> {
    let records = cmd::split_nul(bytes);
    let mut st = Status::default();
    let mut it = records.into_iter();
    while let Some(rec) = it.next() {
        if let Some(header) = rec.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => {
                    st.head = Some(value.chars().take(7).collect());
                }
                "branch.head" => {
                    if value == "(detached)" {
                        st.detached = true;
                    } else {
                        st.branch = Some(value.to_string());
                    }
                }
                "branch.upstream" => st.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = rec.chars().next().unwrap_or(' ');
        match kind {
            '1' => {
                let parts: Vec<&str> = rec.splitn(9, ' ').collect();
                if parts.len() != 9 {
                    return Err(Error::Parse(format!("bad status record {rec:?}")));
                }
                let (index, worktree) = xy(parts[1])?;
                st.files.push(FileStatus {
                    path: parts[8].to_string(),
                    orig_path: None,
                    index,
                    worktree,
                    conflicted: false,
                });
            }
            '2' => {
                let parts: Vec<&str> = rec.splitn(10, ' ').collect();
                if parts.len() != 10 {
                    return Err(Error::Parse(format!("bad status record {rec:?}")));
                }
                let (index, worktree) = xy(parts[1])?;
                let orig = it
                    .next()
                    .ok_or_else(|| Error::Parse("missing rename source".into()))?;
                st.files.push(FileStatus {
                    path: parts[9].to_string(),
                    orig_path: Some(orig),
                    index,
                    worktree,
                    conflicted: false,
                });
            }
            'u' => {
                let parts: Vec<&str> = rec.splitn(11, ' ').collect();
                if parts.len() != 11 {
                    return Err(Error::Parse(format!("bad status record {rec:?}")));
                }
                let (index, worktree) = xy(parts[1])?;
                st.files.push(FileStatus {
                    path: parts[10].to_string(),
                    orig_path: None,
                    index,
                    worktree,
                    conflicted: true,
                });
            }
            '?' | '!' => {
                let path = rec.get(2..).unwrap_or("").to_string();
                st.files.push(FileStatus {
                    path,
                    orig_path: None,
                    index: ChangeKind::Unmodified,
                    worktree: ChangeKind::from_code(kind),
                    conflicted: false,
                });
            }
            _ => {}
        }
    }
    Ok(st)
}

/// Whether `path` is an untracked (not ignored) file.
pub(crate) fn is_untracked(repo: &Path, path: &str) -> Result<bool> {
    let spec = cmd::lit(path);
    let out = run_str(
        repo,
        &[
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
            "--",
            &spec,
        ],
    )?;
    Ok(out.split('\0').any(|p| p == path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let raw = concat!(
            "# branch.oid 1234567890abcdef1234567890abcdef12345678\0",
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 .M N... 100644 100644 100644 aaaa bbbb src/a b.rs\0",
            "2 R. N... 100644 100644 100644 aaaa bbbb R100 new.txt\0old.txt\0",
            "u UU N... 100644 100644 100644 100644 a b c conflict.txt\0",
            "? untracked file.txt\0",
        );
        let st = parse_status(raw.as_bytes()).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.head.as_deref(), Some("1234567"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert!(!st.detached);
        assert_eq!(st.files.len(), 4);
        assert_eq!(st.files[0].path, "src/a b.rs");
        assert_eq!(st.files[0].index, ChangeKind::Unmodified);
        assert_eq!(st.files[0].worktree, ChangeKind::Modified);
        assert_eq!(st.files[1].path, "new.txt");
        assert_eq!(st.files[1].orig_path.as_deref(), Some("old.txt"));
        assert_eq!(st.files[1].index, ChangeKind::Renamed);
        assert!(st.files[2].conflicted);
        assert_eq!(st.files[2].index, ChangeKind::Unmerged);
        assert_eq!(st.files[3].worktree, ChangeKind::Untracked);
        assert_eq!(st.files[3].path, "untracked file.txt");
    }

    #[test]
    fn parses_initial_and_detached() {
        let st = parse_status(b"# branch.oid (initial)\0# branch.head (detached)\0").unwrap();
        assert!(st.head.is_none());
        assert!(st.detached);
        assert!(st.branch.is_none());
    }
}
