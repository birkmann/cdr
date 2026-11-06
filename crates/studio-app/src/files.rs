//! File operations and project search for the editor, confined to an open workspace.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::paths::{relative, resolve, PathError};

const MAX_READ: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub binary: bool,
    pub size: u64,
    pub too_large: bool,
    /// Modification time in milliseconds, used to detect external changes.
    pub mtime: u64,
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn read(root: &Path, rel: &str) -> Result<FileContent, PathError> {
    let p = resolve(root, rel)?;
    let meta = std::fs::metadata(&p)?;
    let size = meta.len();
    if size > MAX_READ {
        return Ok(FileContent {
            path: rel.into(),
            content: String::new(),
            binary: false,
            size,
            too_large: true,
            mtime: mtime_ms(&p),
        });
    }
    let bytes = std::fs::read(&p)?;
    let binary = bytes.iter().take(8000).any(|b| *b == 0);
    let content = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(FileContent {
        path: rel.into(),
        content,
        binary,
        size,
        too_large: false,
        mtime: mtime_ms(&p),
    })
}

const MAX_IMAGE: u64 = 16 * 1024 * 1024;

/// Read an image inside the workspace as a `data:` URL, for rendered Markdown previews.
/// Only known image types are served, so this cannot be used to read arbitrary files.
pub fn read_image(root: &Path, rel: &str) -> Result<String, PathError> {
    use base64::Engine;
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => {
            return Err(
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "not an image").into(),
            )
        }
    };
    let p = resolve(root, rel)?;
    if std::fs::metadata(&p)?.len() > MAX_IMAGE {
        return Err(
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "image too large").into(),
        );
    }
    let bytes = std::fs::read(&p)?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Write a file; returns the new modification time.
pub fn write(root: &Path, rel: &str, content: &str) -> Result<u64, PathError> {
    let p = resolve(root, rel)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&p, content)?;
    Ok(mtime_ms(&p))
}

pub fn create(root: &Path, rel: &str, dir: bool) -> Result<(), PathError> {
    let p = resolve(root, rel)?;
    if p.exists() {
        return Err(PathError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{rel} already exists"),
        )));
    }
    if dir {
        std::fs::create_dir_all(&p)?;
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&p, "")?;
    }
    Ok(())
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), PathError> {
    let a = resolve(root, from)?;
    let b = resolve(root, to)?;
    if b.exists() {
        return Err(PathError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{to} already exists"),
        )));
    }
    if let Some(parent) = b.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(a, b)?;
    Ok(())
}

pub fn delete(root: &Path, rel: &str) -> Result<(), PathError> {
    if rel.trim_matches('/').is_empty() {
        return Err(PathError::Escape(
            "refusing to delete the workspace root".into(),
        ));
    }
    let p = resolve(root, rel)?;
    let meta = std::fs::symlink_metadata(&p)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&p)?;
    } else {
        std::fs::remove_file(&p)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// Glob like `*.ts` or `src/**`; empty = all files.
    pub include: String,
    pub max_results: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub length: usize,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub files_searched: usize,
}

pub fn search(root: &Path, query: &str, opts: &SearchOptions) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult {
            matches: vec![],
            truncated: false,
            files_searched: 0,
        });
    }
    let mut pattern = if opts.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if opts.whole_word {
        pattern = format!(r"\b{pattern}\b");
    }
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!opts.case_sensitive)
        .size_limit(1 << 22)
        .build()
        .map_err(|e| format!("Invalid search pattern: {e}"))?;
    let max = if opts.max_results == 0 {
        2000
    } else {
        opts.max_results
    };
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .parents(true)
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            !(n == ".git" || n == "node_modules" || n == "target")
        });
    if !opts.include.trim().is_empty() {
        let mut ob = ignore::overrides::OverrideBuilder::new(root);
        for g in opts
            .include
            .split(',')
            .map(str::trim)
            .filter(|g| !g.is_empty())
        {
            ob.add(g).map_err(|e| e.to_string())?;
        }
        builder.overrides(ob.build().map_err(|e| e.to_string())?);
    }
    let matches = Arc::new(Mutex::new(Vec::<SearchMatch>::new()));
    let files = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let root_buf = root.to_path_buf();
    builder.build_parallel().run(|| {
        let re = re.clone();
        let matches = matches.clone();
        let files = files.clone();
        let root = root_buf.clone();
        Box::new(move |entry| {
            use ignore::WalkState;
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            if matches.lock().unwrap().len() >= max {
                return WalkState::Quit;
            }
            let Ok(meta) = entry.metadata() else {
                return WalkState::Continue;
            };
            if meta.len() > 2 * 1024 * 1024 {
                return WalkState::Continue;
            }
            let Ok(bytes) = std::fs::read(entry.path()) else {
                return WalkState::Continue;
            };
            if bytes.iter().take(4000).any(|b| *b == 0) {
                return WalkState::Continue;
            }
            files.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let text = String::from_utf8_lossy(&bytes);
            let rel = relative(&root, entry.path());
            let mut local = Vec::new();
            for (i, line) in text.lines().enumerate() {
                for m in re.find_iter(line) {
                    let col = line[..m.start()].chars().count();
                    let shown: String = line.chars().take(400).collect();
                    local.push(SearchMatch {
                        path: rel.clone(),
                        line: i + 1,
                        column: col + 1,
                        length: m.as_str().chars().count(),
                        text: shown,
                    });
                    if local.len() > 200 {
                        break;
                    }
                }
            }
            if !local.is_empty() {
                matches.lock().unwrap().extend(local);
            }
            WalkState::Continue
        })
    });
    let mut matches = std::mem::take(&mut *matches.lock().unwrap());
    matches.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.line.cmp(&b.line))
            .then(a.column.cmp(&b.column))
    });
    let truncated = matches.len() >= max;
    matches.truncate(max);
    Ok(SearchResult {
        matches,
        truncated,
        files_searched: files.load(std::sync::atomic::Ordering::Relaxed),
    })
}

/// Replace all matches of a search in the given files. Returns the number of replacements.
pub fn replace_all(
    root: &Path,
    query: &str,
    replacement: &str,
    opts: &SearchOptions,
    paths: &[String],
) -> Result<usize, String> {
    let mut pattern = if opts.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if opts.whole_word {
        pattern = format!(r"\b{pattern}\b");
    }
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!opts.case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;
    let mut count = 0;
    for rel in paths {
        let p = resolve(root, rel).map_err(|e| e.to_string())?;
        let text = std::fs::read_to_string(&p).map_err(|e| format!("{rel}: {e}"))?;
        let n = re.find_iter(&text).count();
        if n == 0 {
            continue;
        }
        let out = if opts.regex {
            re.replace_all(&text, replacement)
        } else {
            re.replace_all(&text, regex::NoExpand(replacement))
        };
        std::fs::write(&p, out.as_bytes()).map_err(|e| format!("{rel}: {e}"))?;
        count += n;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("src")).unwrap();
        std::fs::write(d.path().join("src/a.ts"), "const foo = 1;\nfoo(foo);\n").unwrap();
        std::fs::write(d.path().join("src/b.md"), "Foo bar\n").unwrap();
        std::fs::write(d.path().join(".gitignore"), "ignored/\n").unwrap();
        std::fs::create_dir_all(d.path().join("ignored")).unwrap();
        std::fs::write(d.path().join("ignored/x.ts"), "foo\n").unwrap();
        // The ignore crate honours .gitignore only inside a git repository unless require_git is off.
        std::fs::create_dir_all(d.path().join(".git")).unwrap();
        d
    }

    #[test]
    fn read_image_serves_only_images_inside_the_root() {
        let d = tree();
        std::fs::write(d.path().join("logo.png"), [0x89, b'P', b'N', b'G']).unwrap();
        assert_eq!(
            read_image(d.path(), "logo.png").unwrap(),
            "data:image/png;base64,iVBORw=="
        );
        assert!(read_image(d.path(), "src/a.ts").is_err());
        assert!(read_image(d.path(), "../x.png").is_err());
        assert!(read_image(d.path(), "missing.png").is_err());
    }

    #[test]
    fn crud_round_trip() {
        let d = tree();
        create(d.path(), "new/dir/file.txt", false).unwrap();
        write(d.path(), "new/dir/file.txt", "hello").unwrap();
        assert_eq!(read(d.path(), "new/dir/file.txt").unwrap().content, "hello");
        rename(d.path(), "new/dir/file.txt", "new/file2.txt").unwrap();
        assert!(read(d.path(), "new/dir/file.txt").is_err());
        delete(d.path(), "new").unwrap();
        assert!(!d.path().join("new").exists());
        assert!(delete(d.path(), "").is_err());
        assert!(write(d.path(), "../escape.txt", "x").is_err());
    }

    #[test]
    fn searches_respecting_gitignore_and_options() {
        let d = tree();
        let r = search(d.path(), "foo", &SearchOptions::default()).unwrap();
        let paths: Vec<_> = r
            .matches
            .iter()
            .map(|m| (m.path.as_str(), m.line, m.column))
            .collect();
        assert_eq!(
            paths,
            [
                ("src/a.ts", 1, 7),
                ("src/a.ts", 2, 1),
                ("src/a.ts", 2, 5),
                ("src/b.md", 1, 1)
            ]
        );
        let cs = search(
            d.path(),
            "foo",
            &SearchOptions {
                case_sensitive: true,
                include: "*.ts".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(cs.matches.len(), 3);
        let re = search(
            d.path(),
            r"fo+\(",
            &SearchOptions {
                regex: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(re.matches.len(), 1);
        assert!(search(
            d.path(),
            "(",
            &SearchOptions {
                regex: true,
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn replaces_literally() {
        let d = tree();
        let n = replace_all(
            d.path(),
            "foo",
            "$bar",
            &SearchOptions {
                case_sensitive: true,
                ..Default::default()
            },
            &["src/a.ts".into()],
        )
        .unwrap();
        assert_eq!(n, 3);
        assert_eq!(
            std::fs::read_to_string(d.path().join("src/a.ts")).unwrap(),
            "const $bar = 1;\n$bar($bar);\n"
        );
    }
}
