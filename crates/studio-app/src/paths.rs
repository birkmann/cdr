//! Workspace path confinement for file commands coming from the webview.

use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("Path escapes the workspace: {0}")]
    Escape(String),
    #[error("Workspace is not open: {0}")]
    NotOpen(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// Resolve `rel` inside `root`. Rejects absolute paths, `..`, and symlinks that leave the root.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    let root = root.canonicalize()?;
    let rel = rel.trim_start_matches("./");
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err(PathError::Escape(rel.to_string()));
    }
    let joined = if rel.is_empty() {
        root.clone()
    } else {
        root.join(rel_path)
    };
    // Check the deepest existing ancestor so new files under a symlinked folder are caught too.
    let mut probe = joined.as_path();
    loop {
        if probe.exists() {
            let real = probe.canonicalize()?;
            if !real.starts_with(&root) {
                return Err(PathError::Escape(rel.to_string()));
            }
            break;
        }
        match probe.parent() {
            Some(p) => probe = p,
            None => break,
        }
    }
    Ok(joined)
}

/// Relative path with forward slashes.
pub fn relative(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confines_paths() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        assert!(resolve(dir.path(), "src/a.ts").is_ok());
        assert!(resolve(dir.path(), "").is_ok());
        assert!(matches!(
            resolve(dir.path(), "../x"),
            Err(PathError::Escape(_))
        ));
        assert!(matches!(
            resolve(dir.path(), "/etc/passwd"),
            Err(PathError::Escape(_))
        ));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/tmp", dir.path().join("out")).unwrap();
            assert!(matches!(
                resolve(dir.path(), "out/file"),
                Err(PathError::Escape(_))
            ));
        }
    }
}
