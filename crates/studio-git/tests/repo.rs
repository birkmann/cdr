//! Integration tests against throwaway repositories in temp directories.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use studio_git::*;

struct Repo {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn configure(dir: &Path) {
    git(dir, &["config", "user.name", "Test User"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    git(dir, &["config", "core.autocrlf", "false"]);
}

impl Repo {
    fn new() -> Repo {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo");
        init(&path).unwrap();
        git(&path, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        configure(&path);
        Repo { _dir: dir, path }
    }
    fn p(&self) -> &Path {
        &self.path
    }
    fn write(&self, rel: &str, content: &str) {
        let f = self.path.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, content).unwrap();
    }
    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.path.join(rel)).unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        git(&self.path, args)
    }
    fn commit_all(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }
}

fn no_progress(_: Progress) {}

#[test]
fn repo_discovery() {
    let r = Repo::new();
    assert!(is_repo(r.p()));
    std::fs::create_dir_all(r.p().join("sub/dir")).unwrap();
    let root = repo_root(&r.p().join("sub/dir")).unwrap();
    assert_eq!(root.canonicalize().unwrap(), r.p().canonicalize().unwrap());
    let other = tempfile::tempdir().unwrap();
    assert!(!is_repo(other.path()));
    assert!(matches!(repo_root(other.path()), Err(Error::NotARepo(_))));
    assert!(!is_repo(&other.path().join("missing")));
}

#[test]
fn status_on_empty_repo() {
    let r = Repo::new();
    let st = status(r.p()).unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert!(st.head.is_none());
    assert!(st.files.is_empty());
    assert!(log(r.p(), &LogOptions::default()).unwrap().is_empty());
}

#[test]
fn status_renames_untracked_and_modified() {
    let r = Repo::new();
    r.write("a.txt", "alpha\nbeta\ngamma\ndelta\n");
    r.write("b.txt", "bee\n");
    r.write("del.txt", "gone\n");
    r.commit_all("init");
    r.git(&["mv", "a.txt", "renamed a.txt"]);
    r.write("b.txt", "bee 2\n");
    r.write("new dir/ünïcode.txt", "new\n");
    std::fs::remove_file(r.p().join("del.txt")).unwrap();

    let st = status(r.p()).unwrap();
    assert_eq!(st.head.as_ref().map(|h| h.len()), Some(7));
    assert!(!st.detached);
    let find = |p: &str| {
        st.files
            .iter()
            .find(|f| f.path == p)
            .unwrap_or_else(|| panic!("{p} in {:?}", st.files))
    };
    let ren = find("renamed a.txt");
    assert_eq!(ren.index, ChangeKind::Renamed);
    assert_eq!(ren.orig_path.as_deref(), Some("a.txt"));
    assert_eq!(find("b.txt").worktree, ChangeKind::Modified);
    assert_eq!(find("b.txt").index, ChangeKind::Unmodified);
    assert_eq!(find("new dir/ünïcode.txt").worktree, ChangeKind::Untracked);
    assert_eq!(find("del.txt").worktree, ChangeKind::Deleted);

    // JSON shape for the webview.
    let json = serde_json::to_value(&st).unwrap();
    assert!(json.get("mergeInProgress").is_some());
    assert!(json["files"][0].get("origPath").is_some());
}

#[test]
fn diff_of_modified_staged_and_untracked() {
    let r = Repo::new();
    r.write("f.txt", "one\ntwo\nthree\n");
    r.commit_all("init");
    r.write("f.txt", "one\nTWO\nthree\nfour\n");
    let d = diff_file(r.p(), "f.txt", false).unwrap();
    assert_eq!(d.hunks.len(), 1);
    let kinds: Vec<_> = d.hunks[0].lines.iter().map(|l| l.kind).collect();
    use DiffLineKind::*;
    assert_eq!(kinds, vec![Context, Del, Add, Context, Add]);
    assert_eq!(d.hunks[0].lines[2].text, "TWO");
    assert_eq!(d.hunks[0].lines[4].new_no, Some(4));
    assert!(diff_file(r.p(), "f.txt", true).unwrap().hunks.is_empty());

    stage(r.p(), &["f.txt"]).unwrap();
    assert_eq!(diff_file(r.p(), "f.txt", true).unwrap().hunks.len(), 1);
    assert!(diff_text(r.p(), true).unwrap().contains("+TWO"));
    assert!(diff_text(r.p(), false).unwrap().is_empty());

    r.write("u.txt", "x\ny\n");
    let d = diff_file(r.p(), "u.txt", false).unwrap();
    assert_eq!(d.hunks.len(), 1);
    assert!(d.hunks[0].lines.iter().all(|l| l.kind == Add));
    assert_eq!(d.hunks[0].lines.len(), 2);

    std::fs::write(r.p().join("bin.dat"), [0u8, 1, 2, 0, 255]).unwrap();
    assert!(diff_file(r.p(), "bin.dat", false).unwrap().binary);
    assert!(diff_file(r.p(), "../escape", false).is_err());
}

#[test]
fn stage_unstage_discard_files() {
    let r = Repo::new();
    r.write("t.txt", "a\n");
    r.commit_all("init");
    r.write("t.txt", "b\n");
    r.write("u.txt", "u\n");
    stage(r.p(), &["t.txt", "u.txt"]).unwrap();
    let st = status(r.p()).unwrap();
    assert!(st.files.iter().all(|f| f.index != ChangeKind::Unmodified));
    unstage(r.p(), &["t.txt", "u.txt"]).unwrap();
    let st = status(r.p()).unwrap();
    assert!(st.files.iter().all(|f| f.index == ChangeKind::Unmodified));
    discard(r.p(), &["t.txt", "u.txt"]).unwrap();
    assert_eq!(r.read("t.txt"), "a\n");
    assert!(!r.p().join("u.txt").exists());
    assert!(status(r.p()).unwrap().files.is_empty());
}

#[test]
fn paths_are_literal_not_globs() {
    let r = Repo::new();
    r.write("keep", "k");
    r.commit_all("init");
    r.write("a[1].txt", "x");
    r.write("a1.txt", "y");
    r.write("star*.txt", "z");
    r.write("starry.txt", "w");
    stage(r.p(), &["a[1].txt", "star*.txt"]).unwrap();
    let st = status(r.p()).unwrap();
    let staged: Vec<&str> = st
        .files
        .iter()
        .filter(|f| f.index == ChangeKind::Added)
        .map(|f| f.path.as_str())
        .collect();
    assert_eq!(staged, vec!["a[1].txt", "star*.txt"]);
    assert_eq!(diff_file(r.p(), "a1.txt", false).unwrap().hunks.len(), 1);
    discard(r.p(), &["a1.txt"]).unwrap();
    assert!(r.p().join("a[1].txt").exists());
    assert!(!r.p().join("a1.txt").exists());
}

#[test]
fn unstage_in_unborn_repo() {
    let r = Repo::new();
    r.write("x.txt", "x\n");
    stage(r.p(), &["x.txt"]).unwrap();
    assert_eq!(status(r.p()).unwrap().files[0].index, ChangeKind::Added);
    unstage(r.p(), &["x.txt"]).unwrap();
    assert_eq!(
        status(r.p()).unwrap().files[0].worktree,
        ChangeKind::Untracked
    );
}

/// Small deterministic PRNG so the property test needs no extra crates.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn random_edit(rng: &mut Lcg, base: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for (i, l) in base.iter().enumerate() {
        match rng.below(12) {
            0 => out.push(format!("changed {i} {}", rng.next())),
            1 => {}
            2 => {
                out.push(format!("inserted {}", rng.next()));
                out.push(l.clone());
            }
            _ => out.push(l.clone()),
        }
    }
    if rng.below(3) == 0 {
        out.push("appended".into());
    }
    out
}

fn join(lines: &[String], trailing_newline: bool) -> String {
    let mut s = lines.join("\n");
    if trailing_newline && !lines.is_empty() {
        s.push('\n');
    }
    s
}

fn blob(r: &Repo, spec: &str) -> String {
    r.git(&["rev-parse", spec]).trim().to_string()
}

#[test]
fn staging_hunks_one_by_one_equals_staging_file() {
    for seed in 0..25u64 {
        let r = Repo::new();
        let mut rng = Lcg(seed * 7919 + 1);
        let n = 20 + rng.below(60);
        let base: Vec<String> = (0..n).map(|i| format!("line {i}")).collect();
        let base_nl = rng.below(4) != 0;
        r.write("f.txt", &join(&base, base_nl));
        r.commit_all("base");
        let edited = random_edit(&mut rng, &base);
        let edited_nl = rng.below(4) != 0;
        r.write("f.txt", &join(&edited, edited_nl));
        let worktree_blob = r.git(&["hash-object", "f.txt"]).trim().to_string();
        let head_blob = blob(&r, "HEAD:f.txt");

        // Stage hunks in random order until nothing is left.
        let mut guard = 0;
        loop {
            let d = diff_file(r.p(), "f.txt", false).unwrap();
            if d.hunks.is_empty() {
                break;
            }
            let i = rng.below(d.hunks.len());
            stage_hunk(r.p(), "f.txt", i).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
            guard += 1;
            assert!(guard < 500);
        }
        assert_eq!(blob(&r, ":f.txt"), worktree_blob, "seed {seed}: stage");

        // Unstage hunks one by one back to HEAD.
        loop {
            let d = diff_file(r.p(), "f.txt", true).unwrap();
            if d.hunks.is_empty() {
                break;
            }
            let i = rng.below(d.hunks.len());
            unstage_hunk(r.p(), "f.txt", i).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        }
        assert_eq!(blob(&r, ":f.txt"), head_blob, "seed {seed}: unstage");

        // Discard hunks one by one: the work tree returns to the index version.
        loop {
            let d = diff_file(r.p(), "f.txt", false).unwrap();
            if d.hunks.is_empty() {
                break;
            }
            let i = rng.below(d.hunks.len());
            discard_hunk(r.p(), "f.txt", i).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        }
        assert_eq!(
            r.read("f.txt"),
            join(&base, base_nl),
            "seed {seed}: discard"
        );
    }
}

#[test]
fn stage_single_hunk_leaves_others() {
    let r = Repo::new();
    let base: Vec<String> = (0..30).map(|i| format!("l{i}")).collect();
    r.write("f.txt", &join(&base, true));
    r.commit_all("base");
    let mut edited = base.clone();
    edited[2] = "X".into();
    edited[25] = "Y".into();
    r.write("f.txt", &join(&edited, true));
    assert_eq!(diff_file(r.p(), "f.txt", false).unwrap().hunks.len(), 2);
    stage_hunk(r.p(), "f.txt", 1).unwrap();
    let staged = diff_file(r.p(), "f.txt", true).unwrap();
    assert_eq!(staged.hunks.len(), 1);
    assert!(staged.hunks[0].lines.iter().any(|l| l.text == "Y"));
    let unstaged = diff_file(r.p(), "f.txt", false).unwrap();
    assert_eq!(unstaged.hunks.len(), 1);
    assert!(unstaged.hunks[0].lines.iter().any(|l| l.text == "X"));
    assert!(stage_hunk(r.p(), "f.txt", 5).is_err());

    // Untracked file: hunk 0 stages the whole file.
    r.write("new.txt", "n\n");
    stage_hunk(r.p(), "new.txt", 0).unwrap();
    assert_eq!(diff_file(r.p(), "new.txt", true).unwrap().hunks.len(), 1);
}

#[test]
fn commit_with_trailers_amend_and_signoff() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    stage(r.p(), &["a.txt"]).unwrap();
    let info = commit(
        r.p(),
        &CommitOptions {
            message: "Add a\n\nBody text.".into(),
            co_authors: vec!["CDR Agent <agent@morrow.dev>".into()],
            sign_off: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(info.commit.subject, "Add a");
    assert!(info.commit.parents.is_empty());
    let msg = r.git(&["log", "-1", "--format=%B"]);
    assert!(msg.contains("Body text."));
    assert!(msg.contains("Co-Authored-By: CDR Agent <agent@morrow.dev>"));
    assert!(msg.contains("Signed-off-by: Test User <test@example.com>"));
    assert!(info.commit.body.contains("Co-Authored-By:"));
    assert_eq!(info.commit.id, r.git(&["rev-parse", "HEAD"]).trim());
    assert!(info.commit.refs.iter().any(|r| r.kind == RefKind::Head));

    assert!(commit(
        r.p(),
        &CommitOptions {
            message: "nothing".into(),
            ..Default::default()
        }
    )
    .is_err());
    let empty = commit(
        r.p(),
        &CommitOptions {
            message: "empty".into(),
            allow_empty: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(empty.commit.parents, vec![info.commit.id.clone()]);

    let amended = commit(
        r.p(),
        &CommitOptions {
            amend: true,
            allow_empty: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(amended.commit.subject, "empty");
    assert_eq!(r.git(&["rev-list", "--count", "HEAD"]).trim(), "2");
    let amended = commit(
        r.p(),
        &CommitOptions {
            message: "reworded".into(),
            amend: true,
            allow_empty: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(amended.commit.subject, "reworded");
    assert_eq!(r.git(&["rev-list", "--count", "HEAD"]).trim(), "2");
}

#[test]
fn commit_reports_hook_output() {
    let r = Repo::new();
    let hook = r.p().join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho 'hook says hi' >&2\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    r.write("a", "a");
    stage(r.p(), &["a"]).unwrap();
    let info = commit(
        r.p(),
        &CommitOptions {
            message: "m".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(info.output.contains("hook says hi"), "{}", info.output);
}

/// Builds main: a - b - c - m, feature: b - d - (merged into m), tag v1 on a.
fn merge_history(r: &Repo) {
    r.write("f.txt", "a\n");
    r.commit_all("a");
    r.git(&["tag", "v1"]);
    r.write("f.txt", "a\nb\n");
    r.commit_all("b");
    r.git(&["checkout", "-q", "-b", "feature"]);
    r.write("g.txt", "d\n");
    r.commit_all("d");
    r.git(&["checkout", "-q", "main"]);
    r.write("f.txt", "a\nb\nc\n");
    r.commit_all("c");
    r.git(&["merge", "-q", "--no-ff", "--no-edit", "feature"]);
}

#[test]
fn log_graph_and_details() {
    let r = Repo::new();
    merge_history(&r);
    let commits = log(r.p(), &LogOptions::default()).unwrap();
    let subjects: Vec<&str> = commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects.len(), 5);
    assert!(subjects[0].starts_with("Merge branch 'feature'"));
    assert_eq!(*subjects.last().unwrap(), "a");
    assert_eq!(commits[0].parents.len(), 2);
    assert!(commits[0]
        .refs
        .iter()
        .any(|x| x.name == "main" && x.kind == RefKind::LocalBranch));
    assert!(commits[4]
        .refs
        .iter()
        .any(|x| x.name == "v1" && x.kind == RefKind::Tag));
    assert!(commits[0].author_time > 1_600_000_000);
    assert_eq!(commits[0].author_email, "test@example.com");

    let rows = graph_lanes(&commits);
    assert_eq!(rows.len(), 5);
    assert_eq!(rows[0].lane, 0);
    assert_eq!(rows[0].edges.len(), 2);
    assert!(rows.iter().any(|row| row.lane == 1));
    assert_eq!(rows[4].lane, 0);
    assert!(rows[4].edges.is_empty());

    let page = log(
        r.p(),
        &LogOptions {
            skip: 1,
            limit: 2,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].id, commits[1].id);

    let found = log(
        r.p(),
        &LogOptions {
            search: Some("D".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(found.iter().any(|c| c.subject == "d"));
    assert!(found.iter().all(|c| c.subject.to_lowercase().contains('d')));

    let hist = log(
        r.p(),
        &LogOptions {
            path: Some("g.txt".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(hist.len(), 1);
    assert_eq!(hist[0].subject, "d");

    let feat = log(
        r.p(),
        &LogOptions {
            rev: Some("feature".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(feat.len(), 3);
    let all = log(
        r.p(),
        &LogOptions {
            rev: Some("--all".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(all.len(), 5);
    assert!(log(
        r.p(),
        &LogOptions {
            rev: Some("--evil".into()),
            ..Default::default()
        }
    )
    .is_err());

    let c = commits.iter().find(|c| c.subject == "c").unwrap();
    let detail = show_commit(r.p(), &c.id).unwrap();
    assert_eq!(detail.files.len(), 1);
    assert_eq!(detail.files[0].path, "f.txt");
    assert_eq!(detail.files[0].kind, ChangeKind::Modified);
    assert_eq!(
        (detail.files[0].additions, detail.files[0].deletions),
        (1, 0)
    );
    let fd = commit_file_diff(r.p(), &c.id, "f.txt").unwrap();
    assert_eq!(fd.hunks.len(), 1);
    assert!(fd.hunks[0]
        .lines
        .iter()
        .any(|l| l.kind == DiffLineKind::Add && l.text == "c"));

    // Merge commit is compared with its first parent.
    let m = show_commit(r.p(), &commits[0].id).unwrap();
    assert_eq!(m.files.len(), 1);
    assert_eq!(m.files[0].path, "g.txt");
    assert_eq!(m.files[0].kind, ChangeKind::Added);

    // Root commit.
    let root = show_commit(r.p(), &commits[4].id).unwrap();
    assert_eq!(root.files[0].kind, ChangeKind::Added);
    assert_eq!(
        commit_file_diff(r.p(), &commits[4].id, "f.txt")
            .unwrap()
            .hunks
            .len(),
        1
    );
}

#[test]
fn show_commit_with_rename() {
    let r = Repo::new();
    r.write("old.txt", "1\n2\n3\n4\n5\n6\n");
    r.commit_all("init");
    r.git(&["mv", "old.txt", "new.txt"]);
    r.write("new.txt", "1\n2\n3\n4\n5\n6\n7\n");
    let id = r.commit_all("rename");
    let d = show_commit(r.p(), &id).unwrap();
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].kind, ChangeKind::Renamed);
    assert_eq!(d.files[0].orig_path.as_deref(), Some("old.txt"));
    assert_eq!(d.files[0].additions, 1);
    let fd = commit_file_diff(r.p(), &id, "new.txt").unwrap();
    assert_eq!(fd.hunks.len(), 1);
}

#[test]
fn blame_lines() {
    let r = Repo::new();
    r.write("f.txt", "one\ntwo\n");
    let first = r.commit_all("first");
    r.write("f.txt", "one\nTWO\nthree\n");
    let second = r.commit_all("second");
    let b = blame(r.p(), "f.txt").unwrap();
    assert_eq!(b.len(), 3);
    assert_eq!(b[0].commit_id, first);
    assert_eq!(b[0].summary, "first");
    assert_eq!(b[1].commit_id, second);
    assert_eq!(b[1].text, "TWO");
    assert_eq!(b[2].line, 3);
    assert_eq!(b[2].author, "Test User");
}

#[test]
fn branches_checkout_rename_delete() {
    let r = Repo::new();
    r.write("f", "1");
    r.commit_all("one");
    create_branch(r.p(), "topic", None, false).unwrap();
    create_branch(r.p(), "work", Some("main"), true).unwrap();
    let st = status(r.p()).unwrap();
    assert_eq!(st.branch.as_deref(), Some("work"));
    let bs = branches(r.p()).unwrap();
    let names: Vec<&str> = bs.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, vec!["main", "topic", "work"]);
    assert!(bs.iter().find(|b| b.name == "work").unwrap().is_head);
    assert_eq!(bs[0].last_subject, "one");
    assert!(bs[0].upstream.is_none() && bs[0].ahead.is_none());
    rename_branch(r.p(), "topic", "topic2").unwrap();
    checkout(r.p(), "topic2").unwrap();
    assert_eq!(status(r.p()).unwrap().branch.as_deref(), Some("topic2"));
    checkout(r.p(), "main").unwrap();
    delete_branch(r.p(), "topic2", false).unwrap();
    delete_branch(r.p(), "work", true).unwrap();
    assert_eq!(branches(r.p()).unwrap().len(), 1);
    assert!(create_branch(r.p(), "-x", None, false).is_err());

    // Detached checkout of a commit id.
    let id = r.git(&["rev-parse", "HEAD"]).trim().to_string();
    checkout(r.p(), &id).unwrap();
    let st = status(r.p()).unwrap();
    assert!(st.detached);
    assert!(st.branch.is_none());
}

#[test]
fn merge_conflict_detection_and_resolution() {
    let r = Repo::new();
    r.write("f.txt", "base\n");
    r.commit_all("base");
    r.git(&["checkout", "-q", "-b", "other"]);
    r.write("f.txt", "theirs\n");
    r.commit_all("theirs");
    r.git(&["checkout", "-q", "main"]);
    r.write("f.txt", "ours\n");
    r.commit_all("ours");

    let res = merge(r.p(), "other").unwrap();
    assert!(!res.ok);
    assert_eq!(res.conflicts, vec!["f.txt".to_string()]);
    let st = status(r.p()).unwrap();
    assert!(st.merge_in_progress);
    assert!(st.files[0].conflicted);
    assert_eq!(st.files[0].index, ChangeKind::Unmerged);

    let cf = conflict_versions(r.p(), "f.txt").unwrap();
    assert_eq!(cf.base.as_deref(), Some("base\n"));
    assert_eq!(cf.ours.as_deref(), Some("ours\n"));
    assert_eq!(cf.theirs.as_deref(), Some("theirs\n"));
    assert!(cf.merged.contains("<<<<<<<"));

    abort_merge(r.p()).unwrap();
    assert!(!status(r.p()).unwrap().merge_in_progress);
    assert_eq!(r.read("f.txt"), "ours\n");

    let res = merge(r.p(), "other").unwrap();
    assert!(!res.ok);
    resolve_conflict(r.p(), "f.txt", "resolved\n").unwrap();
    assert!(conflicted_paths(r.p()).unwrap().is_empty());
    commit(
        r.p(),
        &CommitOptions {
            message: "merge".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!status(r.p()).unwrap().merge_in_progress);

    // A clean merge.
    r.git(&["checkout", "-q", "-b", "clean"]);
    r.write("c.txt", "c\n");
    r.commit_all("clean");
    r.git(&["checkout", "-q", "main"]);
    let res = merge(r.p(), "clean").unwrap();
    assert!(res.ok, "{}", res.message);
    assert!(merge(r.p(), "no-such-branch").is_err());
}

#[test]
fn rebase_and_cherry_pick() {
    let r = Repo::new();
    r.write("f.txt", "base\n");
    r.commit_all("base");
    r.git(&["checkout", "-q", "-b", "topic"]);
    r.write("t.txt", "t\n");
    let topic_work = r.commit_all("topic work");
    r.write("f.txt", "topic\n");
    r.commit_all("topic edits f");
    r.git(&["checkout", "-q", "main"]);
    r.write("m.txt", "m\n");
    r.commit_all("main work");

    let res = cherry_pick(r.p(), &topic_work).unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(r.read("t.txt"), "t\n");

    r.write("f.txt", "main\n");
    r.commit_all("main edits f");
    r.git(&["checkout", "-q", "topic"]);
    let res = rebase(r.p(), "main").unwrap();
    assert!(!res.ok);
    assert_eq!(res.conflicts, vec!["f.txt".to_string()]);
    assert!(status(r.p()).unwrap().rebase_in_progress);
    resolve_conflict(r.p(), "f.txt", "merged\n").unwrap();
    let res = continue_rebase(r.p()).unwrap();
    assert!(res.ok, "{}", res.message);
    assert!(!status(r.p()).unwrap().rebase_in_progress);
    assert_eq!(r.read("f.txt"), "merged\n");

    // Abort path.
    r.git(&["checkout", "-q", "-b", "again", "main~1"]);
    r.write("f.txt", "again\n");
    r.commit_all("again");
    let res = rebase(r.p(), "main").unwrap();
    assert!(!res.ok);
    abort_rebase(r.p()).unwrap();
    assert!(!status(r.p()).unwrap().rebase_in_progress);
}

#[test]
fn stash_roundtrip() {
    let r = Repo::new();
    r.write("f.txt", "1\n");
    r.commit_all("init");
    assert!(!stash_push(r.p(), None, false).unwrap());
    r.write("f.txt", "2\n");
    r.write("u.txt", "u\n");
    assert!(stash_push(r.p(), Some("first"), true).unwrap());
    let st = status(r.p()).unwrap();
    assert!(st.files.is_empty(), "{:?}", st.files);
    r.write("f.txt", "3\n");
    assert!(stash_push(r.p(), Some("second"), false).unwrap());
    let list = stashes(r.p()).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].index, 0);
    assert!(list[0].message.contains("second"));
    assert!(list[1].message.contains("first"));
    assert_eq!(list[0].id.len(), 40);
    stash_drop(r.p(), 0).unwrap();
    let res = stash_pop(r.p(), 0).unwrap();
    assert!(res.ok, "{}", res.message);
    assert_eq!(r.read("f.txt"), "2\n");
    assert_eq!(r.read("u.txt"), "u\n");
    assert!(stashes(r.p()).unwrap().is_empty());
}

#[test]
fn worktrees_list_add_remove() {
    let r = Repo::new();
    r.write("f", "1");
    r.commit_all("init");
    let wt_path = r.p().parent().unwrap().join("wt");
    add_worktree(r.p(), &wt_path, "agent-1", true, None).unwrap();
    let list = worktrees(r.p()).unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].is_main);
    assert_eq!(list[0].branch.as_deref(), Some("main"));
    assert_eq!(list[1].branch.as_deref(), Some("agent-1"));
    assert!(!list[1].is_main);
    assert_eq!(list[1].head.len(), 40);
    // Status works inside the linked worktree.
    assert_eq!(status(&wt_path).unwrap().branch.as_deref(), Some("agent-1"));
    r.git(&["worktree", "lock", wt_path.to_str().unwrap()]);
    assert!(worktrees(r.p()).unwrap()[1].locked);
    r.git(&["worktree", "unlock", wt_path.to_str().unwrap()]);
    remove_worktree(r.p(), &wt_path, false).unwrap();
    assert_eq!(worktrees(r.p()).unwrap().len(), 1);
}

fn bare_remote(r: &Repo) -> (tempfile::TempDir, PathBuf, String) {
    let dir = tempfile::tempdir().unwrap();
    let bare = dir.path().join("remote.git");
    git(dir.path(), &["init", "-q", "--bare", "remote.git"]);
    git(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    let url = format!("file://{}", bare.display());
    r.git(&["remote", "add", "origin", &url]);
    r.git(&["push", "-q", "-u", "origin", "main"]);
    (dir, bare, url)
}

#[test]
fn clone_fetch_pull_push_with_progress() {
    let r = Repo::new();
    for i in 0..30 {
        r.write(&format!("f{i}.txt"), &format!("content {i}\n").repeat(50));
        r.commit_all(&format!("commit {i}"));
    }
    let (_d, _bare, url) = bare_remote(&r);

    let dest_dir = tempfile::tempdir().unwrap();
    let dest = dest_dir.path().join("nested/clone");
    let mut updates = Vec::new();
    let cloned = clone(
        &url,
        &dest,
        &CloneOptions::default(),
        |p| updates.push(p),
        None,
    )
    .unwrap();
    assert!(!updates.is_empty(), "progress callback was not invoked");
    assert!(updates.iter().any(|p| p.percent.is_some()), "{updates:?}");
    assert!(is_repo(&cloned));
    configure(&cloned);
    let st = status(&cloned).unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    assert_eq!(remotes(&cloned).unwrap()[0].fetch_url, url);
    assert!(clone(&url, &dest, &CloneOptions::default(), no_progress, None).is_err());

    // Shallow clone of a branch.
    let shallow = dest_dir.path().join("shallow");
    clone(
        &url,
        &shallow,
        &CloneOptions {
            branch: Some("main".into()),
            depth: Some(1),
        },
        no_progress,
        None,
    )
    .unwrap();
    assert_eq!(git(&shallow, &["rev-list", "--count", "HEAD"]).trim(), "1");

    // Failure cleans up.
    let bad = dest_dir.path().join("bad");
    assert!(clone(
        "file:///does/not/exist",
        &bad,
        &CloneOptions::default(),
        no_progress,
        None
    )
    .is_err());
    assert!(!bad.exists());

    // Push from the original, fetch + pull in the clone.
    r.write("new.txt", "new\n");
    r.commit_all("new upstream");
    push(r.p(), None, None, false, false, no_progress, None).unwrap();
    fetch(&cloned, Some("origin"), no_progress, None).unwrap();
    let st = status(&cloned).unwrap();
    assert_eq!(st.behind, 1);
    let br = branches(&cloned).unwrap();
    let main = br.iter().find(|b| b.name == "main").unwrap();
    assert_eq!((main.ahead, main.behind), (Some(0), Some(1)));
    assert!(br.iter().any(|b| b.name == "origin/main" && b.is_remote));
    let res = pull(&cloned, no_progress, None).unwrap();
    assert!(res.ok);
    assert!(cloned.join("new.txt").exists());

    // Push a new branch with upstream from the clone.
    create_branch(&cloned, "feature", None, true).unwrap();
    std::fs::write(cloned.join("feat.txt"), "f\n").unwrap();
    stage(&cloned, &["feat.txt"]).unwrap();
    commit(
        &cloned,
        &CommitOptions {
            message: "feat".into(),
            ..Default::default()
        },
    )
    .unwrap();
    push(&cloned, None, None, true, false, no_progress, None).unwrap();
    assert_eq!(
        status(&cloned).unwrap().upstream.as_deref(),
        Some("origin/feature")
    );

    // Divergent pull with conflict.
    std::fs::write(r.p().join("new.txt"), "upstream change\n").unwrap();
    r.commit_all("upstream change");
    push(
        r.p(),
        Some("origin"),
        Some("main"),
        false,
        false,
        no_progress,
        None,
    )
    .unwrap();
    checkout(&cloned, "main").unwrap();
    std::fs::write(cloned.join("new.txt"), "local change\n").unwrap();
    stage(&cloned, &["new.txt"]).unwrap();
    commit(
        &cloned,
        &CommitOptions {
            message: "local".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let res = pull(&cloned, no_progress, None).unwrap();
    assert!(!res.ok);
    assert_eq!(res.conflicts, vec!["new.txt".to_string()]);

    // Remote branch checkout creates a tracking branch.
    fetch(r.p(), None, no_progress, None).unwrap();
    checkout(r.p(), "origin/feature").unwrap();
    let st = status(r.p()).unwrap();
    assert_eq!(st.branch.as_deref(), Some("feature"));
    assert_eq!(st.upstream.as_deref(), Some("origin/feature"));
}

#[test]
fn cancelled_clone_returns_cancelled() {
    let r = Repo::new();
    r.write("f", "1");
    r.commit_all("init");
    let (_d, _bare, url) = bare_remote(&r);
    let dest = tempfile::tempdir().unwrap();
    let target = dest.path().join("c");
    let cancel = Arc::new(AtomicBool::new(true));
    let err = clone(
        &url,
        &target,
        &CloneOptions::default(),
        no_progress,
        Some(cancel),
    )
    .unwrap_err();
    assert!(matches!(err, Error::Cancelled));
    assert!(!target.exists());
}

#[test]
fn remotes_and_github_slug() {
    let r = Repo::new();
    assert!(github_repo_slug(r.p()).is_none());
    add_remote(r.p(), "origin", "git@github.com:octo/hello.git").unwrap();
    add_remote(r.p(), "up", "https://example.com/x.git").unwrap();
    r.git(&[
        "remote",
        "set-url",
        "--push",
        "up",
        "https://example.com/push.git",
    ]);
    let list = remotes(r.p()).unwrap();
    assert_eq!(list.len(), 2);
    let up = list.iter().find(|x| x.name == "up").unwrap();
    assert_eq!(up.fetch_url, "https://example.com/x.git");
    assert_eq!(up.push_url, "https://example.com/push.git");
    assert_eq!(
        github_repo_slug(r.p()),
        Some(("octo".to_string(), "hello".to_string()))
    );
    remove_remote(r.p(), "up").unwrap();
    assert_eq!(remotes(r.p()).unwrap().len(), 1);
}

#[test]
fn errors_serialize_as_strings() {
    let dir = tempfile::tempdir().unwrap();
    let err = status(dir.path()).unwrap_err();
    let json = serde_json::to_value(&err).unwrap();
    assert!(
        json.as_str().unwrap().contains("not a git repository"),
        "{json}"
    );
}

#[test]
fn waits_for_a_held_index_lock_and_status_does_not_take_it() {
    let r = Repo::new();
    r.write("t.txt", "a\n");
    r.commit_all("init");
    r.write("t.txt", "b\n");
    // Another process holds the index lock briefly (an agent's git command, a terminal).
    let lock = r.p().join(".git/index.lock");
    std::fs::write(&lock, "").unwrap();
    let release = {
        let lock = lock.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            std::fs::remove_file(lock).unwrap();
        })
    };
    // Status works while the lock is held (no optional locks) ...
    assert_eq!(status(r.p()).unwrap().files.len(), 1);
    // ... and staging waits for the lock instead of failing.
    stage(r.p(), &["t.txt"]).unwrap();
    release.join().unwrap();
    let st = status(r.p()).unwrap();
    assert_eq!(st.files[0].index, ChangeKind::Modified);
}
