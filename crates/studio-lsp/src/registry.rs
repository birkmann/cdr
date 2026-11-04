//! Known language servers and availability detection.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How to start a language server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSpec {
    /// Registry key, e.g. `"typescript"`.
    pub language: String,
    /// LSP language ids served (`"typescriptreact"`, ...).
    pub language_ids: Vec<String>,
    /// File extensions served, without dot.
    pub extensions: Vec<String>,
    /// Executable name (looked up on `PATH`) or path.
    pub command: String,
    pub args: Vec<String>,
    /// `initializationOptions` sent with `initialize`.
    #[serde(default)]
    pub initialization_options: Option<serde_json::Value>,
}

impl ServerSpec {
    /// Whether this spec serves `key`: its language, a language id or an
    /// extension (with or without dot).
    pub fn matches(&self, key: &str) -> bool {
        let key = key.trim_start_matches('.');
        self.language == key
            || self.language_ids.iter().any(|l| l == key)
            || self.extensions.iter().any(|e| e.eq_ignore_ascii_case(key))
    }
}

/// Availability of a registry entry on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAvailability {
    pub language: String,
    pub command: String,
    pub available: bool,
    /// Resolved executable path when available.
    pub path: Option<String>,
}

fn spec(language: &str, ids: &[&str], exts: &[&str], command: &str, args: &[&str]) -> ServerSpec {
    ServerSpec {
        language: language.into(),
        language_ids: ids.iter().map(|s| s.to_string()).collect(),
        extensions: exts.iter().map(|s| s.to_string()).collect(),
        command: command.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        initialization_options: None,
    }
}

/// The built-in registry.
pub fn default_registry() -> Vec<ServerSpec> {
    vec![
        spec(
            "typescript",
            &[
                "typescript",
                "typescriptreact",
                "javascript",
                "javascriptreact",
            ],
            &["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
            "typescript-language-server",
            &["--stdio"],
        ),
        spec("rust", &["rust"], &["rs"], "rust-analyzer", &[]),
        spec(
            "python",
            &["python"],
            &["py", "pyi"],
            "pyright-langserver",
            &["--stdio"],
        ),
        spec("go", &["go"], &["go"], "gopls", &[]),
    ]
}

/// Finds an executable like `which`: paths containing a separator are
/// checked directly, otherwise each `PATH` entry (with `PATHEXT` on Windows).
pub fn which(command: &str) -> Option<PathBuf> {
    let candidate = Path::new(command);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return is_executable(candidate).then(|| candidate.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(|s| s.to_string())
        .chain([String::new()])
        .collect();
    #[cfg(not(windows))]
    let exts: Vec<String> = vec![String::new()];
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let p = dir.join(format!("{command}{ext}"));
            if is_executable(&p) {
                return Some(p);
            }
        }
    }
    None
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Availability of every entry of `registry`.
pub fn availability(registry: &[ServerSpec]) -> Vec<ServerAvailability> {
    registry
        .iter()
        .map(|s| {
            let path = which(&s.command);
            ServerAvailability {
                language: s.language.clone(),
                command: s.command.clone(),
                available: path.is_some(),
                path: path.map(|p| p.display().to_string()),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_matching() {
        let r = default_registry();
        let find = |k: &str| r.iter().find(|s| s.matches(k)).map(|s| s.language.as_str());
        assert_eq!(find("tsx"), Some("typescript"));
        assert_eq!(find(".jsx"), Some("typescript"));
        assert_eq!(find("javascriptreact"), Some("typescript"));
        assert_eq!(find("rs"), Some("rust"));
        assert_eq!(find("python"), Some("python"));
        assert_eq!(find("go"), Some("go"));
        assert_eq!(find("cobol"), None);
    }

    #[test]
    #[cfg(unix)]
    fn which_finds_sh() {
        assert!(which("sh").is_some());
        assert!(which("/bin/sh").is_some());
        assert!(which("definitely-not-a-real-binary-xyz").is_none());
        let a = availability(&default_registry());
        assert_eq!(a.len(), 4);
    }
}
