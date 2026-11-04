use std::path::PathBuf;

use serde::{Serialize, Serializer};

/// Errors returned by every fallible function in this crate.
///
/// Serializes as its human readable message (a JSON string), so Tauri
/// commands can return `Result<T, studio_git::Error>` directly.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The `git` executable could not be started.
    #[error("git executable not found: {0}")]
    GitNotFound(String),
    /// A git command exited with a non-zero status.
    #[error("git {command} failed: {message}")]
    Command {
        command: String,
        code: Option<i32>,
        message: String,
    },
    /// The path is not inside a git work tree.
    #[error("not a git repository: {}", .0.display())]
    NotARepo(PathBuf),
    /// Git produced output this crate could not understand.
    #[error("failed to parse git output: {0}")]
    Parse(String),
    /// The caller passed an argument that cannot be used.
    #[error("invalid argument: {0}")]
    Invalid(String),
    /// The operation was cancelled through its cancel flag.
    #[error("operation cancelled")]
    Cancelled,
    /// File system error.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// `Result` alias using [`Error`].
pub type Result<T> = std::result::Result<T, Error>;
