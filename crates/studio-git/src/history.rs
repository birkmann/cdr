//! Commits, log, commit details and blame.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cmd::{self, has_head, no_option, run, safe_join, split_nul};
use crate::diff::{parse_file_diff, FileDiff};
use crate::error::{Error, Result};
use crate::status::ChangeKind;

/// Options for [`commit`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitOptions {
    pub message: String,
    /// Amend the previous commit. An empty message keeps the old message.
    pub amend: bool,
    /// Add a `Signed-off-by:` trailer.
    pub sign_off: bool,
    /// Values for `Co-Authored-By:` trailers, e.g. `"CDR <agent@cdr.invalid>"`.
    pub co_authors: Vec<String>,
    pub allow_empty: bool,
}

/// Result of [`commit`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    /// The newly created commit.
    pub commit: Commit,
    /// Combined stdout/stderr of `git commit`, including hook output.
    pub output: String,
}

/// Kind of a ref decoration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
    Head,
}

/// A ref pointing at a commit (`main`, `origin/main`, `v1.0`, `HEAD`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    pub kind: RefKind,
}

/// A commit as listed by [`log`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Unix seconds.
    pub author_time: i64,
    /// Unix seconds.
    pub committer_time: i64,
    pub subject: String,
    pub body: String,
    pub refs: Vec<RefLabel>,
}

/// Options for [`log`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogOptions {
    /// Revision to list from: `None` means `HEAD`, `"--all"` lists all refs,
    /// anything else is a revision / range (`main`, `a..b`).
    pub rev: Option<String>,
    /// Only commits touching this path (file history).
    pub path: Option<String>,
    pub skip: usize,
    /// Maximum number of commits; 0 means no limit.
    pub limit: usize,
    /// Case-insensitive fixed-string search in commit messages.
    pub search: Option<String>,
}

/// A file changed by a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub kind: ChangeKind,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

/// A commit with its changed files (compared with the first parent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub commit: Commit,
    pub files: Vec<CommitFile>,
}

/// One line of [`blame`] output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 1-based line number in the current file.
    pub line: u32,
    /// All zeros for uncommitted lines.
    pub commit_id: String,
    pub author: String,
    /// Author time, unix seconds.
    pub time: i64,
    pub summary: String,
    /// Line content.
    pub text: String,
}

/// Creates a commit from the index and returns it.
pub fn commit(repo: &Path, opts: &CommitOptions) -> Result<CommitInfo> {
    let mut args: Vec<String> = vec!["commit".into()];
    let keep_message = opts.amend && opts.message.trim().is_empty();
    if keep_message {
        args.push("--no-edit".into());
    } else {
        if opts.message.trim().is_empty() {
            return Err(Error::Invalid("commit message is empty".into()));
        }
        args.extend(["-F".into(), "-".into()]);
    }
    if opts.amend {
        args.push("--amend".into());
    }
    if opts.sign_off {
        args.push("--signoff".into());
    }
    if opts.allow_empty {
        args.push("--allow-empty".into());
    }
    for c in &opts.co_authors {
        let c = c.trim();
        if c.is_empty() || c.contains('\n') {
            return Err(Error::Invalid(format!("invalid co-author {c:?}")));
        }
        args.push("--trailer".into());
        args.push(format!("Co-Authored-By: {c}"));
    }
    let out = cmd::output(
        repo,
        &args,
        (!keep_message).then_some(opts.message.as_bytes()),
    )?;
    if !out.status.success() {
        return Err(cmd::failure(&args, &out));
    }
    let mut output = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        output.push('\n');
        output.push_str(err.trim());
    }
    let commit = log_args(repo, &["-n1".into(), "HEAD".into()])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Parse("new commit not found".into()))?;
    Ok(CommitInfo { commit, output })
}

const LOG_FORMAT: &str =
    "--format=%x1e%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%D%x00%s%x00%b";

fn parse_refs(decor: &str) -> Vec<RefLabel> {
    let mut refs = Vec::new();
    for part in decor.split(", ").map(str::trim).filter(|s| !s.is_empty()) {
        let (part, head) = match part.strip_prefix("HEAD -> ") {
            Some(rest) => (rest, true),
            None => (part, false),
        };
        if head {
            refs.push(RefLabel {
                name: "HEAD".into(),
                kind: RefKind::Head,
            });
        }
        if part == "HEAD" {
            refs.push(RefLabel {
                name: "HEAD".into(),
                kind: RefKind::Head,
            });
        } else if let Some(t) = part.strip_prefix("tag: ") {
            let t = t.strip_prefix("refs/tags/").unwrap_or(t);
            refs.push(RefLabel {
                name: t.into(),
                kind: RefKind::Tag,
            });
        } else if let Some(b) = part.strip_prefix("refs/heads/") {
            refs.push(RefLabel {
                name: b.into(),
                kind: RefKind::LocalBranch,
            });
        } else if let Some(r) = part.strip_prefix("refs/remotes/") {
            if !r.ends_with("/HEAD") {
                refs.push(RefLabel {
                    name: r.into(),
                    kind: RefKind::RemoteBranch,
                });
            }
        }
    }
    refs
}

pub(crate) fn parse_log(out: &[u8]) -> Result<Vec<Commit>> {
    let text = String::from_utf8_lossy(out);
    let mut commits = Vec::new();
    for rec in text.split('\x1e').filter(|r| !r.trim().is_empty()) {
        let f: Vec<&str> = rec.splitn(10, '\0').collect();
        if f.len() != 10 {
            return Err(Error::Parse(format!("bad log record {rec:?}")));
        }
        commits.push(Commit {
            id: f[0].trim_start_matches('\n').to_string(),
            short_id: f[1].to_string(),
            parents: f[2].split_whitespace().map(String::from).collect(),
            author_name: f[3].to_string(),
            author_email: f[4].to_string(),
            author_time: f[5].parse().unwrap_or(0),
            committer_time: f[6].parse().unwrap_or(0),
            refs: parse_refs(f[7]),
            subject: f[8].to_string(),
            body: f[9].trim_end().to_string(),
        });
    }
    Ok(commits)
}

fn log_args(repo: &Path, extra: &[String]) -> Result<Vec<Commit>> {
    let mut args: Vec<String> = vec![
        "log".into(),
        "--decorate=full".into(),
        "--no-color".into(),
        LOG_FORMAT.into(),
    ];
    args.extend_from_slice(extra);
    parse_log(&run(repo, &args)?)
}

/// Lists commits (newest first, parents always after children).
pub fn log(repo: &Path, opts: &LogOptions) -> Result<Vec<Commit>> {
    let mut args: Vec<String> = vec!["--date-order".into()];
    if opts.skip > 0 {
        args.push(format!("--skip={}", opts.skip));
    }
    if opts.limit > 0 {
        args.push(format!("--max-count={}", opts.limit));
    }
    if let Some(s) = opts.search.as_deref().filter(|s| !s.is_empty()) {
        args.extend([
            "--regexp-ignore-case".into(),
            "--fixed-strings".into(),
            format!("--grep={s}"),
        ]);
    }
    match opts.rev.as_deref() {
        None | Some("") | Some("HEAD") => {
            if !has_head(repo)? {
                return Ok(Vec::new());
            }
            args.push("HEAD".into());
        }
        Some("--all") => args.push("--all".into()),
        Some(rev) => {
            no_option("revision", rev)?;
            args.push(rev.into());
        }
    }
    args.push("--".into());
    if let Some(p) = opts.path.as_deref().filter(|p| !p.is_empty()) {
        args.push(cmd::lit(p));
    }
    log_args(repo, &args)
}

fn first_parent_args(id: &str) -> Vec<String> {
    vec![
        "show".into(),
        "--format=".into(),
        "--no-color".into(),
        "--diff-merges=first-parent".into(),
        "-M".into(),
        id.into(),
    ]
}

/// Returns a commit and the files it changed relative to its first parent.
pub fn show_commit(repo: &Path, id: &str) -> Result<CommitDetail> {
    no_option("commit id", id)?;
    let commit = log_args(repo, &["-n1".into(), id.into(), "--".into()])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Invalid(format!("unknown commit {id}")))?;

    let mut args = first_parent_args(&commit.id);
    args.extend(["-z".into(), "--name-status".into()]);
    let ns = split_nul(trim_leading_newlines(&run(repo, &args)?));
    let mut files = Vec::new();
    let mut it = ns.into_iter();
    while let Some(code) = it.next() {
        let code = code.trim_start_matches('\n').to_string();
        let Some(first) = code.chars().next() else {
            continue;
        };
        let kind = ChangeKind::from_code(first);
        let (orig_path, path) = if matches!(first, 'R' | 'C') {
            let orig = it.next().unwrap_or_default();
            (Some(orig), it.next().unwrap_or_default())
        } else {
            (None, it.next().unwrap_or_default())
        };
        files.push(CommitFile {
            path,
            orig_path,
            kind,
            additions: 0,
            deletions: 0,
            binary: false,
        });
    }

    let mut args = first_parent_args(&commit.id);
    args.extend(["-z".into(), "--numstat".into()]);
    let raw = run(repo, &args)?;
    let fields = split_nul(trim_leading_newlines(&raw));
    let mut stats: HashMap<String, (u32, u32, bool)> = HashMap::new();
    let mut it = fields.into_iter();
    while let Some(rec) = it.next() {
        let rec = rec.trim_start_matches('\n');
        let mut parts = rec.splitn(3, '\t');
        let (a, d, p) = (
            parts.next().unwrap_or(""),
            parts.next().unwrap_or(""),
            parts.next().unwrap_or(""),
        );
        let path = if p.is_empty() {
            let _orig = it.next();
            it.next().unwrap_or_default()
        } else {
            p.to_string()
        };
        let binary = a == "-";
        stats.insert(
            path,
            (a.parse().unwrap_or(0), d.parse().unwrap_or(0), binary),
        );
    }
    for f in &mut files {
        if let Some((a, d, b)) = stats.get(&f.path) {
            f.additions = *a;
            f.deletions = *d;
            f.binary = *b;
        }
    }
    Ok(CommitDetail { commit, files })
}

fn trim_leading_newlines(b: &[u8]) -> &[u8] {
    let n = b.iter().take_while(|c| **c == b'\n').count();
    &b[n..]
}

/// Diff of one file in a commit, relative to the commit's first parent.
pub fn commit_file_diff(repo: &Path, id: &str, path: &str) -> Result<FileDiff> {
    no_option("commit id", id)?;
    safe_join(repo, path)?;
    let detail = show_commit(repo, id)?;
    let mut paths = vec![path.to_string()];
    if let Some(orig) = detail
        .files
        .iter()
        .find(|f| f.path == path)
        .and_then(|f| f.orig_path.clone())
    {
        paths.push(orig);
    }
    let mut args = first_parent_args(&detail.commit.id);
    args.extend([
        "-p".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--src-prefix=a/".into(),
        "--dst-prefix=b/".into(),
        "--".into(),
    ]);
    args.extend(paths.iter().map(|p| cmd::lit(p)));
    let raw = run(repo, &args)?;
    Ok(parse_file_diff(path, trim_leading_newlines(&raw)))
}

/// Line-by-line blame of the working tree version of `path`.
pub fn blame(repo: &Path, path: &str) -> Result<Vec<BlameLine>> {
    safe_join(repo, path)?;
    let out = run(repo, &["blame", "--porcelain", "--", path])?;
    Ok(parse_blame(&out))
}

#[derive(Default, Clone)]
struct BlameMeta {
    author: String,
    time: i64,
    summary: String,
}

pub(crate) fn parse_blame(out: &[u8]) -> Vec<BlameLine> {
    let text = String::from_utf8_lossy(out);
    let mut meta: HashMap<String, BlameMeta> = HashMap::new();
    let mut lines = Vec::new();
    let mut current: Option<(String, u32)> = None;
    for line in text.split('\n') {
        if let Some(content) = line.strip_prefix('\t') {
            if let Some((id, n)) = current.take() {
                let m = meta.get(&id).cloned().unwrap_or_default();
                lines.push(BlameLine {
                    line: n,
                    commit_id: id,
                    author: m.author,
                    time: m.time,
                    summary: m.summary,
                    text: content.trim_end_matches('\r').to_string(),
                });
            }
            continue;
        }
        match &current {
            None => {
                let mut parts = line.split(' ');
                let id = parts.next().unwrap_or("");
                if id.len() >= 40 && id.chars().all(|c| c.is_ascii_hexdigit()) {
                    let _orig = parts.next();
                    let n = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
                    meta.entry(id.to_string()).or_default();
                    current = Some((id.to_string(), n));
                }
            }
            Some((id, _)) => {
                let (key, value) = line.split_once(' ').unwrap_or((line, ""));
                let m = meta.entry(id.clone()).or_default();
                match key {
                    "author" => m.author = value.to_string(),
                    "author-time" => m.time = value.parse().unwrap_or(0),
                    "summary" => m.summary = value.to_string(),
                    _ => {}
                }
            }
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_decorations() {
        let refs = parse_refs(
            "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD",
        );
        assert_eq!(
            refs,
            vec![
                RefLabel {
                    name: "HEAD".into(),
                    kind: RefKind::Head
                },
                RefLabel {
                    name: "main".into(),
                    kind: RefKind::LocalBranch
                },
                RefLabel {
                    name: "v1".into(),
                    kind: RefKind::Tag
                },
                RefLabel {
                    name: "origin/main".into(),
                    kind: RefKind::RemoteBranch
                },
            ]
        );
    }

    #[test]
    fn parses_blame_porcelain() {
        let id = "a".repeat(40);
        let raw = format!(
            "{id} 1 1 2\nauthor Ann\nauthor-mail <a@x>\nauthor-time 100\nsummary first\nfilename f\n\tone\n{id} 2 2\n\ttwo\n"
        );
        let b = parse_blame(raw.as_bytes());
        assert_eq!(b.len(), 2);
        assert_eq!(b[1].line, 2);
        assert_eq!(b[1].author, "Ann");
        assert_eq!(b[1].summary, "first");
        assert_eq!(b[1].text, "two");
        assert_eq!(b[0].time, 100);
    }
}
