//! Gitignore-aware, debounced file watching and directory listing for
//! CDR Studio.
//!
//! [`Watcher`] watches a project tree and reports batches of [`Change`]s
//! through a callback, after the tree has been quiet for the debounce
//! interval (or at the latest after four intervals of continuous activity).
//! Paths ignored by `.gitignore` (nested files, `.git/info/exclude` and the
//! global excludes file) and the built-in exclusions `node_modules/`,
//! `target/`, `.harness/sessions` and `.git/` are not reported. Changes to
//! `.git/HEAD`, `.git/index`, `.git/packed-refs` and `.git/refs/**` set
//! [`ChangeBatch::git_changed`] instead, so the app can refresh git status.
//!
//! On Linux each non-ignored directory gets its own inotify watch, so large
//! ignored trees such as `node_modules` do not exhaust the watch limit; on
//! macOS and Windows the native recursive watcher is used and ignored paths
//! are filtered.

mod ignore_rules;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use serde::{Serialize, Serializer};

use ignore_rules::{always_ignored, relative, IgnoreRules};

/// Errors of this crate; serializes as its message string.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("file watcher error: {0}")]
    Notify(#[from] notify::Error),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// `Result` alias using [`Error`].
pub type Result<T> = std::result::Result<T, Error>;

/// Kind of a file change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Created,
    Modified,
    Removed,
    Renamed,
}

/// One changed path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Path relative to the watched root, with forward slashes.
    pub path: String,
    pub kind: ChangeKind,
    /// Previous path for [`ChangeKind::Renamed`] when the platform reports it.
    pub old_path: Option<String>,
}

/// A debounced batch of changes.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeBatch {
    /// Changes sorted by path; each path appears at most once.
    pub changes: Vec<Change>,
    /// `.git/HEAD`, `.git/index` or refs changed.
    pub git_changed: bool,
}

/// An entry of [`read_dir`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Path relative to the root, with forward slashes.
    pub path: String,
    pub is_dir: bool,
    /// Ignored by `.gitignore` or the built-in rules (the explorer shows these like any other entry).
    pub ignored: bool,
}

/// Watches a tree until dropped.
pub struct Watcher {
    _inner: Arc<Mutex<RecommendedWatcher>>,
    root: PathBuf,
}

impl Watcher {
    /// Starts watching `root`. `on_change` is called from a background
    /// thread with each non-empty batch.
    pub fn new(
        root: impl AsRef<Path>,
        debounce_ms: u64,
        on_change: impl Fn(ChangeBatch) + Send + 'static,
    ) -> Result<Watcher> {
        let root = root.as_ref().canonicalize()?;
        if !root.is_dir() {
            return Err(Error::InvalidPath(root.display().to_string()));
        }
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let watcher = notify::recommended_watcher(move |ev| {
            let _ = tx.send(ev);
        })?;
        let inner = Arc::new(Mutex::new(watcher));
        let git_dirs = git_dirs(&root);
        {
            let mut w = inner.lock().unwrap();
            if per_dir_watches() {
                let mut rules = IgnoreRules::new(&root);
                watch_tree(&mut w, &root, &root, &mut rules);
                for g in &git_dirs {
                    let _ = w.watch(g, RecursiveMode::NonRecursive);
                    let refs = g.join("refs");
                    if refs.is_dir() {
                        let _ = w.watch(&refs, RecursiveMode::Recursive);
                    }
                }
            } else {
                w.watch(&root, RecursiveMode::Recursive)?;
                for g in git_dirs.iter().filter(|g| !g.starts_with(&root)) {
                    let _ = w.watch(g, RecursiveMode::Recursive);
                }
            }
        }
        let state = State {
            root: root.clone(),
            rules: IgnoreRules::new(&root),
            git_dirs,
            watcher: Arc::downgrade(&inner),
            pending: BTreeMap::new(),
            git_changed: false,
        };
        let debounce = Duration::from_millis(debounce_ms.max(1));
        std::thread::Builder::new()
            .name("studio-watch".into())
            .spawn(move || run(state, rx, debounce, on_change))?;
        Ok(Watcher {
            _inner: inner,
            root,
        })
    }

    /// The canonical root being watched.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

fn per_dir_watches() -> bool {
    cfg!(any(target_os = "linux", target_os = "android"))
}

/// The git directory (and common directory for linked worktrees) of `root`.
fn git_dirs(root: &Path) -> Vec<PathBuf> {
    let dot_git = root.join(".git");
    let mut dirs = Vec::new();
    if dot_git.is_dir() {
        dirs.push(dot_git);
    } else if let Ok(text) = std::fs::read_to_string(&dot_git) {
        if let Some(p) = text.trim().strip_prefix("gitdir:") {
            let p = root.join(p.trim());
            if let Ok(p) = p.canonicalize() {
                if let Ok(common) = std::fs::read_to_string(p.join("commondir")) {
                    if let Ok(c) = p.join(common.trim()).canonicalize() {
                        dirs.push(c);
                    }
                }
                dirs.insert(0, p);
            }
        }
    }
    dirs
}

/// Adds non-recursive watches for `dir` and all non-ignored subdirectories.
fn watch_tree(w: &mut RecommendedWatcher, root: &Path, dir: &Path, rules: &mut IgnoreRules) {
    let _ = w.watch(dir, RecursiveMode::NonRecursive);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let p = e.path();
        match relative(root, &p) {
            Some(rel) if !rules.is_ignored(&rel, true) => watch_tree(w, root, &p, rules),
            _ => {}
        }
    }
}

struct State {
    root: PathBuf,
    rules: IgnoreRules,
    git_dirs: Vec<PathBuf>,
    watcher: Weak<Mutex<RecommendedWatcher>>,
    pending: BTreeMap<String, Change>,
    git_changed: bool,
}

fn is_git_signal(rel_in_git_dir: &str) -> bool {
    if rel_in_git_dir.ends_with(".lock") {
        return false;
    }
    matches!(rel_in_git_dir, "HEAD" | "index" | "packed-refs")
        || rel_in_git_dir.starts_with("refs/")
        || rel_in_git_dir == "refs"
}

impl State {
    fn record(&mut self, path: String, kind: ChangeKind, old_path: Option<String>) {
        use ChangeKind::*;
        let merged = match self.pending.get(&path).map(|c| c.kind) {
            Some(Created) if kind == Modified => Some(Created),
            Some(Created) if kind == Removed => None,
            Some(Removed) if kind == Created => Some(Modified),
            _ => Some(kind),
        };
        match merged {
            Some(kind) => {
                self.pending.insert(
                    path.clone(),
                    Change {
                        path,
                        kind,
                        old_path,
                    },
                );
            }
            None => {
                self.pending.remove(&path);
            }
        }
    }

    /// Returns the root-relative path when `path` should be reported.
    fn classify(&mut self, path: &Path) -> Option<String> {
        for g in &self.git_dirs {
            if let Ok(rest) = path.strip_prefix(g) {
                let rest = rest.to_string_lossy().replace('\\', "/");
                if is_git_signal(&rest) {
                    self.git_changed = true;
                }
                return None;
            }
        }
        let rel = relative(&self.root, path)?;
        if rel.is_empty() {
            return None;
        }
        if rel == ".git" || rel.starts_with(".git/") {
            if is_git_signal(rel.trim_start_matches(".git").trim_start_matches('/')) {
                self.git_changed = true;
            }
            return None;
        }
        if rel.ends_with(".gitignore") || rel == ".git/info/exclude" {
            self.rules.invalidate();
        }
        let is_dir = path.is_dir();
        if self.rules.is_ignored(&rel, is_dir) {
            return None;
        }
        Some(rel)
    }

    /// A directory appeared: watch it (Linux) and report files already inside.
    fn created_dir(&mut self, path: &Path) {
        if per_dir_watches() {
            if let Some(w) = self.watcher.upgrade() {
                let mut w = w.lock().unwrap();
                watch_tree(&mut w, &self.root, path, &mut self.rules);
            }
        }
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if let Some(rel) = self.classify(&p) {
                self.record(rel, ChangeKind::Created, None);
                if p.is_dir() {
                    self.created_dir(&p);
                }
            }
        }
    }

    fn handle(&mut self, ev: notify::Event) {
        let kind = match ev.kind {
            EventKind::Access(_) => return,
            EventKind::Create(_) => ChangeKind::Created,
            EventKind::Remove(_) => ChangeKind::Removed,
            EventKind::Modify(ModifyKind::Name(mode)) => {
                match mode {
                    RenameMode::Both if ev.paths.len() == 2 => {
                        let from = self.classify(&ev.paths[0]);
                        let to_path = ev.paths[1].clone();
                        let to = self.classify(&to_path);
                        match (from, to) {
                            (Some(f), Some(t)) => {
                                self.pending.remove(&f);
                                self.record(t, ChangeKind::Renamed, Some(f));
                            }
                            (Some(f), None) => self.record(f, ChangeKind::Removed, None),
                            (None, Some(t)) => self.record(t, ChangeKind::Created, None),
                            (None, None) => {}
                        }
                        if to_path.is_dir() {
                            self.created_dir(&to_path);
                        }
                        return;
                    }
                    RenameMode::From => ChangeKind::Removed,
                    RenameMode::To => ChangeKind::Created,
                    _ => {
                        // Unknown side of a rename: decide by existence.
                        for p in &ev.paths {
                            let k = if p.exists() {
                                ChangeKind::Created
                            } else {
                                ChangeKind::Removed
                            };
                            if let Some(rel) = self.classify(p) {
                                self.record(rel, k, None);
                                if k == ChangeKind::Created && p.is_dir() {
                                    self.created_dir(p);
                                }
                            }
                        }
                        return;
                    }
                }
            }
            _ => ChangeKind::Modified,
        };
        for p in &ev.paths {
            if let Some(rel) = self.classify(p) {
                // Directory metadata changes are noise for the UI.
                if kind == ChangeKind::Modified && p.is_dir() {
                    continue;
                }
                // FSEvents reports a deleted file's whole history (create, remove, modify) in one event.
                let kind = if kind == ChangeKind::Modified && !p.exists() {
                    ChangeKind::Removed
                } else {
                    kind
                };
                self.record(rel, kind, None);
                if kind == ChangeKind::Created && p.is_dir() {
                    self.created_dir(p);
                }
            }
        }
    }

    fn take(&mut self) -> Option<ChangeBatch> {
        if self.pending.is_empty() && !self.git_changed {
            return None;
        }
        let batch = ChangeBatch {
            changes: std::mem::take(&mut self.pending).into_values().collect(),
            git_changed: self.git_changed,
        };
        self.git_changed = false;
        Some(batch)
    }
}

fn run(
    mut state: State,
    rx: mpsc::Receiver<notify::Result<notify::Event>>,
    debounce: Duration,
    on_change: impl Fn(ChangeBatch),
) {
    let max_wait = debounce * 4;
    while let Ok(first) = rx.recv() {
        if let Ok(ev) = first {
            state.handle(ev);
        }
        let started = Instant::now();
        let mut disconnected = false;
        loop {
            let left = max_wait.saturating_sub(started.elapsed());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(debounce.min(left)) {
                Ok(Ok(ev)) => state.handle(ev),
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        if let Some(batch) = state.take() {
            on_change(batch);
        }
        if disconnected {
            break;
        }
    }
}

/// Lists files under `root` (gitignore-aware, built-in exclusions applied),
/// as sorted root-relative paths with forward slashes, at most `max` entries.
pub fn list_files(root: impl AsRef<Path>, max: usize) -> Result<Vec<String>> {
    let root = root.as_ref();
    if !root.is_dir() {
        return Err(Error::InvalidPath(root.display().to_string()));
    }
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(ALWAYS_DIRS.contains(&name.as_ref()) && e.depth() > 0)
        })
        .build();
    for entry in walker.flatten() {
        if out.len() >= max {
            break;
        }
        if !entry
            .file_type()
            .is_some_and(|t| t.is_file() || t.is_symlink())
        {
            continue;
        }
        if let Some(rel) = relative(root, entry.path()) {
            if !rel.is_empty() && !always_ignored(&rel) {
                out.push(rel);
            }
        }
    }
    out.sort();
    Ok(out)
}

const ALWAYS_DIRS: &[&str] = &[".git", "node_modules", "target"];

/// Lists the direct children of `root/rel` for the explorer: directories
/// first, then files, each group sorted case-insensitively. `.git` is
/// omitted; ignored entries are included with `ignored: true`.
pub fn read_dir(root: impl AsRef<Path>, rel: &str) -> Result<Vec<DirEntry>> {
    let root = root.as_ref();
    let rel = rel.trim_matches('/');
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|c| {
            !matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err(Error::InvalidPath(rel.to_string()));
    }
    let dir = root.join(rel_path);
    let mut rules = IgnoreRules::new(root);
    let mut entries = Vec::new();
    for e in std::fs::read_dir(&dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let is_dir = std::fs::metadata(e.path())
            .map(|m| m.is_dir())
            .unwrap_or(false);
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let ignored = rules.is_ignored(&path, is_dir);
        entries.push(DirEntry {
            name,
            path,
            is_dir,
            ignored,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}
