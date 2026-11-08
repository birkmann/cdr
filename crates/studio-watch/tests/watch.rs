use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use studio_watch::{list_files, read_dir, ChangeBatch, ChangeKind, Watcher};

fn write(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

struct Collector {
    rx: mpsc::Receiver<ChangeBatch>,
    _w: Watcher,
}

impl Collector {
    fn start(root: &Path) -> Collector {
        let (tx, rx) = mpsc::channel();
        let w = Watcher::new(root, 50, move |b| {
            let _ = tx.send(b);
        })
        .unwrap();
        // Give the backend a moment to register watches.
        std::thread::sleep(Duration::from_millis(100));
        Collector { rx, _w: w }
    }

    /// Collects batches until `done` holds for the merged result or timeout.
    fn until(&self, done: impl Fn(&ChangeBatch) -> bool) -> ChangeBatch {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut all = ChangeBatch::default();
        while Instant::now() < deadline {
            if let Ok(b) = self.rx.recv_timeout(Duration::from_millis(100)) {
                all.git_changed |= b.git_changed;
                all.changes.extend(b.changes);
                if done(&all) {
                    return all;
                }
            }
        }
        panic!("timed out; got {all:?}");
    }

    fn drain(&self, wait_ms: u64) -> ChangeBatch {
        let mut all = ChangeBatch::default();
        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        while Instant::now() < deadline {
            if let Ok(b) = self.rx.recv_timeout(Duration::from_millis(50)) {
                all.git_changed |= b.git_changed;
                all.changes.extend(b.changes);
            }
        }
        all
    }
}

fn has(b: &ChangeBatch, path: &str, kind: ChangeKind) -> bool {
    b.changes.iter().any(|c| c.path == path && c.kind == kind)
}

fn has_path(b: &ChangeBatch, path: &str) -> bool {
    b.changes.iter().any(|c| c.path == path)
}

#[test]
fn create_modify_delete() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "existing.txt", "1");
    let c = Collector::start(root);

    write(root, "new.txt", "hello");
    let b = c.until(|b| has_path(b, "new.txt"));
    assert!(has(&b, "new.txt", ChangeKind::Created), "{b:?}");
    c.drain(200);

    write(root, "existing.txt", "2");
    let b = c.until(|b| has_path(b, "existing.txt"));
    // FSEvents can still report a file written just before the watch began as created.
    assert!(
        has(&b, "existing.txt", ChangeKind::Modified)
            || (cfg!(target_os = "macos") && has(&b, "existing.txt", ChangeKind::Created)),
        "{b:?}"
    );
    c.drain(200);

    std::fs::remove_file(root.join("existing.txt")).unwrap();
    let b = c.until(|b| has(b, "existing.txt", ChangeKind::Removed));
    assert!(!b.git_changed);

    // Files in a newly created directory tree are reported and watched.
    write(root, "deep/er/file.rs", "x");
    c.until(|b| has_path(b, "deep/er/file.rs"));
    c.drain(200);
    write(root, "deep/er/file2.rs", "y");
    c.until(|b| has(b, "deep/er/file2.rs", ChangeKind::Created));
    c.drain(200);

    std::fs::rename(root.join("new.txt"), root.join("renamed.txt")).unwrap();
    let b = c.until(|b| has_path(b, "renamed.txt"));
    let ch = b.changes.iter().find(|c| c.path == "renamed.txt").unwrap();
    assert!(
        matches!(ch.kind, ChangeKind::Renamed | ChangeKind::Created),
        "{b:?}"
    );
}

#[test]
fn ignores_git_internals_node_modules_and_gitignore() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, ".gitignore", "*.log\ndist/\n");
    std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
    std::fs::create_dir_all(root.join("target/debug")).unwrap();
    std::fs::create_dir_all(root.join(".harness/sessions")).unwrap();
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::fs::create_dir_all(root.join(".git/refs/heads")).unwrap();
    std::fs::create_dir_all(root.join(".git/objects/ab")).unwrap();
    write(root, ".git/HEAD", "ref: refs/heads/main\n");
    let c = Collector::start(root);

    write(root, "node_modules/pkg/index.js", "x");
    write(root, "target/debug/out", "x");
    write(root, ".harness/sessions/s.jsonl", "x");
    write(root, "dist/bundle.js", "x");
    write(root, "debug.log", "x");
    write(root, ".git/objects/ab/cdef", "x");
    write(root, ".git/config", "x");
    write(root, "visible.txt", "x");
    let b = c.until(|b| has_path(b, "visible.txt"));
    let more = c.drain(300);
    let paths: Vec<&str> = b
        .changes
        .iter()
        .chain(more.changes.iter())
        .map(|c| c.path.as_str())
        .collect();
    assert_eq!(paths, vec!["visible.txt"], "{paths:?}");
    assert!(!b.git_changed && !more.git_changed);

    write(root, ".git/index", "x");
    let b = c.until(|b| b.git_changed);
    assert!(b.changes.is_empty(), "{b:?}");
    c.drain(200);

    write(root, ".git/refs/heads/main", "abc");
    c.until(|b| b.git_changed);
    c.drain(200);

    // A gitignore edit is picked up.
    write(root, ".gitignore", "*.log\ndist/\n*.tmp\n");
    c.until(|b| has_path(b, ".gitignore"));
    c.drain(200);
    write(root, "a.tmp", "x");
    write(root, "b.txt", "x");
    let b = c.until(|b| has_path(b, "b.txt"));
    let more = c.drain(300);
    assert!(
        !has_path(&b, "a.tmp") && !has_path(&more, "a.tmp"),
        "{b:?} {more:?}"
    );
}

#[test]
fn debounces_bursts_into_one_batch() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let (tx, rx) = mpsc::channel();
    let _w = Watcher::new(root, 300, move |b| {
        let _ = tx.send(b);
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    for i in 0..20 {
        write(root, &format!("f{i}.txt"), "x");
    }
    let b = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(b.changes.len(), 20, "{b:?}");
    assert!(b.changes.windows(2).all(|w| w[0].path < w[1].path));
    let json = serde_json::to_value(&b).unwrap();
    assert!(json.get("gitChanged").is_some());
    assert_eq!(json["changes"][0]["kind"], "created");
}

#[test]
fn list_files_respects_gitignore() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, ".gitignore", "*.log\nbuild/\n");
    write(root, "src/main.rs", "");
    write(root, "src/lib.rs", "");
    write(root, "README.md", "");
    write(root, "app.log", "");
    write(root, "build/out.js", "");
    write(root, "node_modules/x/index.js", "");
    write(root, "target/debug/bin", "");
    write(root, ".git/HEAD", "");
    write(root, ".harness/sessions/a.jsonl", "");
    write(root, ".harness/config.json", "");
    write(root, "sub/.gitignore", "secret.txt\n");
    write(root, "sub/secret.txt", "");
    write(root, "sub/ok.txt", "");
    let files = list_files(root, 100).unwrap();
    assert_eq!(
        files,
        vec![
            ".gitignore",
            ".harness/config.json",
            "README.md",
            "src/lib.rs",
            "src/main.rs",
            "sub/.gitignore",
            "sub/ok.txt",
        ]
    );
    assert_eq!(list_files(root, 2).unwrap().len(), 2);
}

#[test]
fn read_dir_marks_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, ".gitignore", "*.log\n");
    write(root, "b.txt", "");
    write(root, "A.txt", "");
    write(root, "x.log", "");
    write(root, "src/mod.rs", "");
    write(root, "node_modules/p/i.js", "");
    write(root, ".git/HEAD", "");
    let entries = read_dir(root, "").unwrap();
    let names: Vec<(&str, bool, bool)> = entries
        .iter()
        .map(|e| (e.name.as_str(), e.is_dir, e.ignored))
        .collect();
    assert_eq!(
        names,
        vec![
            ("node_modules", true, true),
            ("src", true, false),
            (".gitignore", false, false),
            ("A.txt", false, false),
            ("b.txt", false, false),
            ("x.log", false, true),
        ]
    );
    let sub = read_dir(root, "src").unwrap();
    assert_eq!(sub[0].path, "src/mod.rs");
    assert!(read_dir(root, "../etc").is_err());
}
