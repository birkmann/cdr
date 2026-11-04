//! Diffs and file / hunk level staging.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cmd::{self, has_head, run, run_input, safe_join};
use crate::error::{Error, Result};
use crate::status::is_untracked;

/// Kind of a diff line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Add,
    Del,
    Context,
}

/// One line of a hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    /// Line number in the old file (context and deleted lines).
    pub old_no: Option<u32>,
    /// Line number in the new file (context and added lines).
    pub new_no: Option<u32>,
    /// Line content without the leading `+`/`-`/` ` and without the line ending.
    pub text: String,
}

/// One hunk of a file diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// The full `@@ -a,b +c,d @@ section` line.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

/// Structured diff of a single file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// Git considers the file binary; `hunks` is empty.
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

/// A single-file patch split into its header and raw hunks.
#[derive(Debug, Default)]
pub(crate) struct RawPatch {
    pub header: Vec<u8>,
    pub hunks: Vec<Vec<u8>>,
    pub binary: bool,
}

fn lines_with_endings(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut rest = bytes;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let end = rest
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(rest.len());
        let (line, tail) = rest.split_at(end);
        rest = tail;
        Some(line)
    })
}

/// Splits the first file of a unified diff into header and hunks.
pub(crate) fn split_patch(bytes: &[u8]) -> RawPatch {
    let mut p = RawPatch::default();
    let mut seen_diff = false;
    for line in lines_with_endings(bytes) {
        if line.starts_with(b"diff --git ") {
            if seen_diff {
                break;
            }
            seen_diff = true;
        }
        if line.starts_with(b"@@") {
            p.hunks.push(line.to_vec());
        } else if let Some(h) = p.hunks.last_mut() {
            h.extend_from_slice(line);
        } else {
            if line.starts_with(b"Binary files ") || line.starts_with(b"GIT binary patch") {
                p.binary = true;
            }
            p.header.extend_from_slice(line);
        }
    }
    p
}

fn parse_range(s: &str) -> Option<(u32, u32)> {
    let (a, b) = match s.split_once(',') {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    };
    let start = a.parse().ok()?;
    let len = match b {
        Some(b) => b.parse().ok()?,
        None => 1,
    };
    Some((start, len))
}

/// Parses `@@ -a,b +c,d @@` into `(a, b, c, d)`.
pub(crate) fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = line.strip_prefix("@@ ")?;
    let end = rest.find(" @@")?;
    let mut parts = rest[..end].split(' ');
    let old = parse_range(parts.next()?.strip_prefix('-')?)?;
    let new = parse_range(parts.next()?.strip_prefix('+')?)?;
    Some((old.0, old.1, new.0, new.1))
}

fn strip_eol(line: &[u8]) -> String {
    let mut l = line;
    if l.ends_with(b"\n") {
        l = &l[..l.len() - 1];
    }
    if l.ends_with(b"\r") {
        l = &l[..l.len() - 1];
    }
    String::from_utf8_lossy(l).into_owned()
}

fn parse_hunk(raw: &[u8]) -> Hunk {
    let mut lines = lines_with_endings(raw);
    let header = strip_eol(lines.next().unwrap_or_default());
    let (old_start, old_lines, new_start, new_lines) =
        parse_hunk_header(&header).unwrap_or((0, 0, 0, 0));
    let (mut o, mut n) = (old_start, new_start);
    let mut out = Vec::new();
    for line in lines {
        let (kind, body) = match line.first() {
            Some(b'+') => (DiffLineKind::Add, &line[1..]),
            Some(b'-') => (DiffLineKind::Del, &line[1..]),
            Some(b' ') => (DiffLineKind::Context, &line[1..]),
            Some(b'\\') => continue,
            Some(b'\n') => (DiffLineKind::Context, &line[..0]),
            _ => continue,
        };
        let (old_no, new_no) = match kind {
            DiffLineKind::Add => {
                n += 1;
                (None, Some(n - 1))
            }
            DiffLineKind::Del => {
                o += 1;
                (Some(o - 1), None)
            }
            DiffLineKind::Context => {
                o += 1;
                n += 1;
                (Some(o - 1), Some(n - 1))
            }
        };
        out.push(DiffLine {
            kind,
            old_no,
            new_no,
            text: strip_eol(body),
        });
    }
    Hunk {
        header,
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines: out,
    }
}

/// Converts raw unified diff bytes for one file into a [`FileDiff`].
pub(crate) fn parse_file_diff(path: &str, bytes: &[u8]) -> FileDiff {
    let raw = split_patch(bytes);
    FileDiff {
        path: path.to_string(),
        binary: raw.binary,
        hunks: raw.hunks.iter().map(|h| parse_hunk(h)).collect(),
    }
}

const DIFF_FLAGS: &[&str] = &[
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "-U3",
];

/// Raw diff bytes of one path (index vs worktree, or HEAD vs index when `staged`).
/// Untracked files (when not staged) produce an all-added diff.
fn raw_diff(repo: &Path, path: &str, staged: bool) -> Result<Vec<u8>> {
    if !staged && is_untracked(repo, path)? {
        let mut args = vec!["diff", "--no-index"];
        args.extend_from_slice(DIFF_FLAGS);
        args.extend_from_slice(&["--", "/dev/null", path]);
        let out = cmd::output(repo, &args, None)?;
        // `--no-index` exits with 1 when the files differ.
        return match out.status.code() {
            Some(0) | Some(1) => Ok(out.stdout),
            _ => Err(cmd::failure(&args, &out)),
        };
    }
    let mut args = vec!["diff"];
    args.extend_from_slice(DIFF_FLAGS);
    if staged {
        args.push("--cached");
    }
    let spec = cmd::lit(path);
    args.extend_from_slice(&["--", &spec]);
    run(repo, &args)
}

/// Structured diff of one file. `staged` compares HEAD with the index,
/// otherwise the index with the working tree. Untracked files are shown as
/// entirely added.
pub fn diff_file(repo: &Path, path: &str, staged: bool) -> Result<FileDiff> {
    safe_join(repo, path)?;
    let bytes = raw_diff(repo, path, staged)?;
    Ok(parse_file_diff(path, &bytes))
}

/// Unified diff of the whole repository (staged or unstaged), as text for the agent.
pub fn diff_text(repo: &Path, staged: bool) -> Result<String> {
    let mut args = vec!["diff"];
    args.extend_from_slice(DIFF_FLAGS);
    if staged {
        args.push("--cached");
    }
    Ok(String::from_utf8_lossy(&run(repo, &args)?).into_owned())
}

fn path_args<S: AsRef<str>>(base: &[&str], paths: &[S]) -> Vec<String> {
    let mut v: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    v.push("--".into());
    v.extend(paths.iter().map(|p| cmd::lit(p.as_ref())));
    v
}

/// Stages paths (`git add -A`), including deletions.
pub fn stage<S: AsRef<str>>(repo: &Path, paths: &[S]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    run(repo, &path_args(&["add", "-A"], paths))?;
    Ok(())
}

/// Unstages paths, restoring their index entries from HEAD.
pub fn unstage<S: AsRef<str>>(repo: &Path, paths: &[S]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    if has_head(repo)? {
        run(repo, &path_args(&["reset", "-q", "HEAD"], paths))?;
    } else {
        run(
            repo,
            &path_args(&["rm", "--cached", "-r", "-q", "--ignore-unmatch"], paths),
        )?;
    }
    Ok(())
}

/// Discards working tree changes: tracked paths are checked out from the
/// index, untracked files are deleted.
pub fn discard<S: AsRef<str>>(repo: &Path, paths: &[S]) -> Result<()> {
    let mut tracked = Vec::new();
    for p in paths {
        let p = p.as_ref();
        let full = safe_join(repo, p)?;
        if is_untracked(repo, p)? {
            if full.is_dir() {
                std::fs::remove_dir_all(&full)?;
            } else {
                std::fs::remove_file(&full)?;
            }
        } else {
            tracked.push(p.to_string());
        }
    }
    if !tracked.is_empty() {
        run(repo, &path_args(&["checkout", "-q"], &tracked))?;
    }
    Ok(())
}

fn hunk_has_context(hunk: &[u8]) -> bool {
    lines_with_endings(hunk)
        .skip(1)
        .any(|l| l.starts_with(b" "))
}

fn single_hunk_patch(raw: &RawPatch, index: usize, path: &str) -> Result<(Vec<u8>, bool)> {
    if raw.binary {
        return Err(Error::Invalid(format!(
            "cannot apply hunks of binary file {path}"
        )));
    }
    let hunk = raw.hunks.get(index).ok_or_else(|| {
        Error::Invalid(format!(
            "hunk {index} out of range for {path} ({} hunks)",
            raw.hunks.len()
        ))
    })?;
    let mut patch = raw.header.clone();
    patch.extend_from_slice(hunk);
    if !patch.ends_with(b"\n") {
        patch.push(b'\n');
    }
    Ok((patch, !hunk_has_context(hunk)))
}

fn apply(repo: &Path, patch: &[u8], zero_context: bool, flags: &[&str]) -> Result<()> {
    let mut args = vec!["apply", "--whitespace=nowarn", "--recount"];
    if zero_context {
        args.push("--unidiff-zero");
    }
    args.extend_from_slice(flags);
    args.push("-");
    run_input(repo, &args, patch)?;
    Ok(())
}

/// Stages hunk `hunk_index` of the unstaged diff of `path` (as returned by
/// `diff_file(repo, path, false)`). For an untracked file, hunk 0 stages the
/// whole file.
pub fn stage_hunk(repo: &Path, path: &str, hunk_index: usize) -> Result<()> {
    safe_join(repo, path)?;
    if is_untracked(repo, path)? {
        if hunk_index != 0 {
            return Err(Error::Invalid(format!("hunk {hunk_index} out of range")));
        }
        return stage(repo, &[path]);
    }
    let raw = split_patch(&raw_diff(repo, path, false)?);
    let (patch, zero) = single_hunk_patch(&raw, hunk_index, path)?;
    apply(repo, &patch, zero, &["--cached"])
}

/// Unstages hunk `hunk_index` of the staged diff of `path` (as returned by
/// `diff_file(repo, path, true)`).
pub fn unstage_hunk(repo: &Path, path: &str, hunk_index: usize) -> Result<()> {
    safe_join(repo, path)?;
    let raw = split_patch(&raw_diff(repo, path, true)?);
    let (patch, zero) = single_hunk_patch(&raw, hunk_index, path)?;
    apply(repo, &patch, zero, &["--cached", "-R"])
}

/// Discards hunk `hunk_index` of the unstaged diff of `path` from the working
/// tree. For an untracked file, hunk 0 deletes the file.
pub fn discard_hunk(repo: &Path, path: &str, hunk_index: usize) -> Result<()> {
    let full = safe_join(repo, path)?;
    if is_untracked(repo, path)? {
        if hunk_index != 0 {
            return Err(Error::Invalid(format!("hunk {hunk_index} out of range")));
        }
        std::fs::remove_file(full)?;
        return Ok(());
    }
    let raw = split_patch(&raw_diff(repo, path, false)?);
    let (patch, zero) = single_hunk_patch(&raw, hunk_index, path)?;
    apply(repo, &patch, zero, &["-R"])
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@ fn x\n a\n-b\n+B\n c\n@@ -10 +10,2 @@\n j\n+k\n\\ No newline at end of file\n";

    #[test]
    fn splits_and_parses() {
        let raw = split_patch(SAMPLE.as_bytes());
        assert_eq!(raw.hunks.len(), 2);
        assert!(raw.header.starts_with(b"diff --git"));
        let d = parse_file_diff("f.txt", SAMPLE.as_bytes());
        assert!(!d.binary);
        let h = &d.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (1, 3, 1, 3)
        );
        assert_eq!(h.header, "@@ -1,3 +1,3 @@ fn x");
        assert_eq!(h.lines.len(), 4);
        assert_eq!(h.lines[1].kind, DiffLineKind::Del);
        assert_eq!(h.lines[1].old_no, Some(2));
        assert_eq!(h.lines[2].kind, DiffLineKind::Add);
        assert_eq!(h.lines[2].new_no, Some(2));
        assert_eq!(h.lines[3].old_no, Some(3));
        let h = &d.hunks[1];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (10, 1, 10, 2)
        );
        assert_eq!(h.lines.len(), 2);
        assert_eq!(h.lines[1].text, "k");
    }

    #[test]
    fn detects_binary() {
        let d = parse_file_diff(
            "x.bin",
            b"diff --git a/x.bin b/x.bin\nindex 1..2 100644\nBinary files a/x.bin and b/x.bin differ\n",
        );
        assert!(d.binary);
        assert!(d.hunks.is_empty());
    }
}
