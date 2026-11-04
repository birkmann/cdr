//! Remotes and network operations (clone, fetch, pull, push).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::branch::{conflicted_paths, MergeResult};
use crate::cmd::{self, no_option, run, run_progress, run_str};
use crate::error::{Error, Result};
use crate::progress::Progress;

/// A configured remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

/// Options for [`clone`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloneOptions {
    /// Branch to check out instead of the remote HEAD.
    pub branch: Option<String>,
    /// Create a shallow clone with this many commits.
    pub depth: Option<u32>,
}

fn os(v: &[&str]) -> Vec<OsString> {
    v.iter().map(OsString::from).collect()
}

/// Lists remotes with their fetch and push URLs.
pub fn remotes(repo: &Path) -> Result<Vec<Remote>> {
    let out = run_str(repo, &["remote", "-v"])?;
    let mut list: Vec<Remote> = Vec::new();
    for line in out.lines() {
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let (url, kind) = match rest.rsplit_once(' ') {
            Some((u, k)) => (u.to_string(), k),
            None => (rest.to_string(), "(fetch)"),
        };
        let idx = match list.iter().position(|r| r.name == name) {
            Some(i) => i,
            None => {
                list.push(Remote {
                    name: name.to_string(),
                    fetch_url: String::new(),
                    push_url: String::new(),
                });
                list.len() - 1
            }
        };
        if kind == "(push)" {
            list[idx].push_url = url;
        } else {
            list[idx].fetch_url = url;
        }
    }
    Ok(list)
}

/// Adds a remote.
pub fn add_remote(repo: &Path, name: &str, url: &str) -> Result<()> {
    no_option("remote name", name)?;
    no_option("remote url", url)?;
    run(repo, &["remote", "add", name, url])?;
    Ok(())
}

/// Removes a remote.
pub fn remove_remote(repo: &Path, name: &str) -> Result<()> {
    no_option("remote name", name)?;
    run(repo, &["remote", "remove", name])?;
    Ok(())
}

/// Clones `url` into `dest` (which must not exist or be empty) and returns
/// the absolute path of the new work tree. On failure or cancellation the
/// partially created directory is removed.
pub fn clone(
    url: &str,
    dest: &Path,
    opts: &CloneOptions,
    mut progress: impl FnMut(Progress),
    cancel: Option<Arc<AtomicBool>>,
) -> Result<PathBuf> {
    no_option("url", url)?;
    let dest = if dest.is_absolute() {
        dest.to_path_buf()
    } else {
        std::env::current_dir()?.join(dest)
    };
    let existed = dest.exists();
    if existed && std::fs::read_dir(&dest)?.next().is_some() {
        return Err(Error::Invalid(format!(
            "destination {} already exists and is not empty",
            dest.display()
        )));
    }
    let parent = dest
        .parent()
        .ok_or_else(|| Error::Invalid("destination has no parent directory".into()))?;
    std::fs::create_dir_all(parent)?;

    let mut args = os(&["clone", "--progress"]);
    if let Some(b) = opts.branch.as_deref().filter(|b| !b.is_empty()) {
        no_option("branch", b)?;
        args.push("--branch".into());
        args.push(b.into());
    }
    if let Some(d) = opts.depth.filter(|d| *d > 0) {
        args.push(format!("--depth={d}").into());
    }
    args.push("--".into());
    args.push(url.into());
    args.push(dest.clone().into_os_string());

    let cleanup = || {
        if dest.exists() {
            let _ = std::fs::remove_dir_all(&dest);
            if existed {
                let _ = std::fs::create_dir(&dest);
            }
        }
    };
    match run_progress(parent, &args, &mut progress, cancel.as_deref()) {
        Ok(out) if out.success => Ok(dest.canonicalize().unwrap_or(dest.clone())),
        Ok(out) => {
            cleanup();
            Err(out.into_error("clone"))
        }
        Err(e) => {
            cleanup();
            Err(e)
        }
    }
}

/// Fetches `remote` (or git's default remote when `None`), pruning deleted branches.
pub fn fetch(
    repo: &Path,
    remote: Option<&str>,
    mut progress: impl FnMut(Progress),
    cancel: Option<Arc<AtomicBool>>,
) -> Result<()> {
    let mut args = os(&["fetch", "--progress", "--prune"]);
    if let Some(r) = remote.filter(|r| !r.is_empty()) {
        if r != "--all" {
            no_option("remote", r)?;
        }
        args.push(r.into());
    }
    let out = run_progress(repo, &args, &mut progress, cancel.as_deref())?;
    if out.success {
        Ok(())
    } else {
        Err(out.into_error("fetch"))
    }
}

fn config_get(repo: &Path, key: &str) -> Result<Option<String>> {
    let out = cmd::output(repo, &["config", "--get", key], None)?;
    Ok(out
        .status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

/// Pulls the upstream of the current branch. Honours `pull.rebase` /
/// `pull.ff`; when neither is configured, divergent histories are merged.
pub fn pull(
    repo: &Path,
    mut progress: impl FnMut(Progress),
    cancel: Option<Arc<AtomicBool>>,
) -> Result<MergeResult> {
    let mut args = os(&["pull", "--progress", "--no-edit"]);
    if config_get(repo, "pull.rebase")?.is_none() && config_get(repo, "pull.ff")?.is_none() {
        args.push("--no-rebase".into());
    }
    let out = run_progress(repo, &args, &mut progress, cancel.as_deref())?;
    let message = out.combined();
    if out.success {
        return Ok(MergeResult {
            ok: true,
            conflicts: Vec::new(),
            message,
        });
    }
    let conflicts = conflicted_paths(repo)?;
    if conflicts.is_empty() {
        return Err(out.into_error("pull"));
    }
    Ok(MergeResult {
        ok: false,
        conflicts,
        message,
    })
}

/// Pushes to `remote` (default: git's push default). `branch` names the
/// local branch to push; with `set_upstream` the remote defaults to `origin`
/// and the branch to the current one.
pub fn push(
    repo: &Path,
    remote: Option<&str>,
    branch: Option<&str>,
    set_upstream: bool,
    force_with_lease: bool,
    mut progress: impl FnMut(Progress),
    cancel: Option<Arc<AtomicBool>>,
) -> Result<()> {
    let mut args = os(&["push", "--progress"]);
    if set_upstream {
        args.push("--set-upstream".into());
    }
    if force_with_lease {
        args.push("--force-with-lease".into());
    }
    let mut remote = remote.filter(|r| !r.is_empty()).map(String::from);
    let mut branch = branch.filter(|b| !b.is_empty()).map(String::from);
    if set_upstream {
        remote.get_or_insert_with(|| "origin".into());
        if branch.is_none() {
            let b = run_str(repo, &["symbolic-ref", "--short", "HEAD"])
                .map_err(|_| Error::Invalid("cannot set upstream on a detached HEAD".into()))?;
            branch = Some(b.trim().to_string());
        }
    }
    if branch.is_some() && remote.is_none() {
        remote = Some("origin".into());
    }
    if let Some(r) = &remote {
        no_option("remote", r)?;
        args.push(r.into());
    }
    if let Some(b) = &branch {
        no_option("branch", b)?;
        args.push(b.into());
    }
    let out = run_progress(repo, &args, &mut progress, cancel.as_deref())?;
    if out.success {
        Ok(())
    } else {
        Err(out.into_error("push"))
    }
}

/// `(owner, name)` of the GitHub repository `origin` points at, if any.
pub fn github_repo_slug(repo: &Path) -> Option<(String, String)> {
    let url = run_str(repo, &["remote", "get-url", "origin"]).ok()?;
    parse_github_url(url.trim())
}

/// Parses `https://github.com/o/n(.git)`, `git@github.com:o/n.git` and
/// `ssh://git@github.com/o/n.git` into `(owner, name)`.
pub fn parse_github_url(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let rest = if let Some(r) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("ssh://"))
        .or_else(|| url.strip_prefix("git://"))
    {
        let r = r.rsplit_once('@').map(|(_, h)| h).unwrap_or(r);
        let (host, path) = r.split_once('/')?;
        let host = host.split(':').next()?;
        if !host.eq_ignore_ascii_case("github.com") && !host.eq_ignore_ascii_case("www.github.com")
        {
            return None;
        }
        path
    } else {
        // scp-like: [user@]github.com:owner/name.git
        let (host, path) = url.split_once(':')?;
        let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        path
    };
    let path = rest.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let name = parts.next().filter(|s| !s.is_empty())?;
    if parts.next().is_some() {
        return None;
    }
    Some((owner.to_string(), name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_urls() {
        let want = Some(("octo".to_string(), "repo".to_string()));
        assert_eq!(parse_github_url("https://github.com/octo/repo.git"), want);
        assert_eq!(parse_github_url("https://github.com/octo/repo"), want);
        assert_eq!(
            parse_github_url("https://user:tok@github.com/octo/repo/"),
            want
        );
        assert_eq!(parse_github_url("git@github.com:octo/repo.git"), want);
        assert_eq!(parse_github_url("ssh://git@github.com/octo/repo.git"), want);
        assert_eq!(parse_github_url("ssh://git@github.com:22/octo/repo"), want);
        assert_eq!(parse_github_url("https://gitlab.com/octo/repo.git"), None);
        assert_eq!(parse_github_url("/local/path"), None);
        assert_eq!(parse_github_url("https://github.com/octo"), None);
    }
}
