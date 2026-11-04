//! Ignore rules: built-in exclusions plus `.gitignore` files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;

/// Directory names that are never watched or listed, at any depth.
const ALWAYS_IGNORED_DIRS: &[&str] = &["node_modules", "target", ".git"];

/// True for paths excluded regardless of `.gitignore`: `.git`,
/// `node_modules/`, `target/` (any depth) and `.harness/sessions`.
pub(crate) fn always_ignored(rel: &str) -> bool {
    let mut prev: Option<&str> = None;
    for comp in rel.split('/') {
        if ALWAYS_IGNORED_DIRS.contains(&comp) {
            return true;
        }
        if prev == Some(".harness") && comp == "sessions" {
            return true;
        }
        prev = Some(comp);
    }
    false
}

/// Lazily loaded `.gitignore` matchers for a tree, with git precedence:
/// deeper files override shallower ones, which override
/// `.git/info/exclude` and the global excludes file.
pub(crate) struct IgnoreRules {
    root: PathBuf,
    per_dir: HashMap<PathBuf, Option<Gitignore>>,
    base: Gitignore,
    global: Gitignore,
}

impl IgnoreRules {
    pub(crate) fn new(root: &Path) -> IgnoreRules {
        let mut b = GitignoreBuilder::new(root);
        let exclude = root.join(".git/info/exclude");
        if exclude.is_file() {
            let _ = b.add(exclude);
        }
        let base = b.build().unwrap_or_else(|_| Gitignore::empty());
        let (global, _) = Gitignore::global();
        IgnoreRules {
            root: root.to_path_buf(),
            per_dir: HashMap::new(),
            base,
            global,
        }
    }

    /// Drops cached `.gitignore` matchers (call when one changed).
    pub(crate) fn invalidate(&mut self) {
        self.per_dir.clear();
    }

    fn dir_matcher(&mut self, dir: &Path) -> Option<&Gitignore> {
        self.per_dir
            .entry(dir.to_path_buf())
            .or_insert_with(|| {
                let file = dir.join(".gitignore");
                if !file.is_file() {
                    return None;
                }
                let (gi, _) = Gitignore::new(&file);
                (!gi.is_empty()).then_some(gi)
            })
            .as_ref()
    }

    /// Whether one path (all of whose ancestors are not ignored) matches.
    fn matches(&mut self, rel: &str, is_dir: bool) -> bool {
        let abs = self.root.join(rel);
        let mut dir = abs.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if !d.starts_with(&self.root) {
                break;
            }
            if let Some(gi) = self.dir_matcher(&d) {
                match gi.matched(&abs, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
            if d == self.root {
                break;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
        match self.base.matched(&abs, is_dir) {
            Match::Ignore(_) => return true,
            Match::Whitelist(_) => return false,
            Match::None => {}
        }
        matches!(
            self.global.matched(Path::new(rel), is_dir),
            Match::Ignore(_)
        )
    }

    /// Whether `rel` (forward slashes, relative to the root) is ignored,
    /// either itself or through an ignored ancestor directory.
    pub(crate) fn is_ignored(&mut self, rel: &str, is_dir: bool) -> bool {
        if rel.is_empty() {
            return false;
        }
        if always_ignored(rel) {
            return true;
        }
        let parts: Vec<&str> = rel.split('/').collect();
        let mut prefix = String::new();
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                prefix.push('/');
            }
            prefix.push_str(part);
            let last = i + 1 == parts.len();
            if self.matches(&prefix, !last || is_dir) {
                return true;
            }
        }
        false
    }
}

/// Converts `path` into a root-relative path with forward slashes.
pub(crate) fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut s = String::new();
    for c in rel.components() {
        if let std::path::Component::Normal(p) = c {
            if !s.is_empty() {
                s.push('/');
            }
            s.push_str(&p.to_string_lossy());
        }
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_rules() {
        assert!(always_ignored("node_modules"));
        assert!(always_ignored("a/node_modules/b.js"));
        assert!(always_ignored("target/debug/x"));
        assert!(always_ignored(".git/config"));
        assert!(always_ignored(".harness/sessions/abc.jsonl"));
        assert!(!always_ignored(".harness/config.json"));
        assert!(!always_ignored("src/targets.rs"));
    }

    #[test]
    fn gitignore_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "*.log\nbuild/\n").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/.gitignore"), "!keep.log\nlocal.txt\n").unwrap();
        let mut r = IgnoreRules::new(root);
        assert!(r.is_ignored("a.log", false));
        assert!(r.is_ignored("sub/a.log", false));
        assert!(!r.is_ignored("sub/keep.log", false));
        assert!(r.is_ignored("sub/local.txt", false));
        assert!(!r.is_ignored("local.txt", false));
        assert!(r.is_ignored("build", true));
        assert!(r.is_ignored("build/out/x.js", false));
        assert!(!r.is_ignored("src/main.rs", false));
    }
}
