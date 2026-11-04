//! Low level helpers that run the `git` executable.

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::RwLock;
use std::time::Duration;

use crate::error::{Error, Result};
use crate::progress::{parse_progress, Progress};

/// Environment variables from a parent git process that would redirect our commands.
const SCRUB_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
];

/// Process-wide extra git configuration, passed via `GIT_CONFIG_*` env vars.
static EXTRA_CONFIG: RwLock<Vec<(String, String)>> = RwLock::new(Vec::new());

/// Sets configuration applied to every git command this crate runs (local
/// and network), e.g. `("http.https://github.com/.extraheader",
/// "AUTHORIZATION: basic ...")`. The pairs are passed through the
/// environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<i>`,
/// `GIT_CONFIG_VALUE_<i>`, git 2.31+), never on the command line, and are
/// never included in logs or error messages. An empty `Vec` clears them.
pub fn set_extra_config(pairs: Vec<(String, String)>) {
    let mut guard = EXTRA_CONFIG.write().unwrap_or_else(|e| e.into_inner());
    *guard = pairs;
}

fn apply_extra_config(cmd: &mut Command) {
    let pairs = EXTRA_CONFIG.read().unwrap_or_else(|e| e.into_inner());
    if pairs.is_empty() {
        return;
    }
    cmd.env("GIT_CONFIG_COUNT", pairs.len().to_string());
    for (i, (k, v)) in pairs.iter().enumerate() {
        cmd.env(format!("GIT_CONFIG_KEY_{i}"), k);
        cmd.env(format!("GIT_CONFIG_VALUE_{i}"), v);
    }
}

/// Builds a `git` command running in `dir`.
///
/// `network` commands keep terminal prompts enabled so credential helpers and
/// askpass programs configured by the user keep working.
pub(crate) fn command(dir: &Path, network: bool) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .args(["-c", "core.quotepath=off", "-c", "color.ui=false"])
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_PAGER", "cat")
        // Status and diff must not take the index lock, or they race with commits and staging.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null());
    for var in SCRUB_ENV {
        cmd.env_remove(var);
    }
    if !network {
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }
    apply_extra_config(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn describe<S: AsRef<OsStr>>(args: &[S]) -> String {
    args.iter()
        .take(3)
        .map(|a| a.as_ref().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn spawn_error(err: std::io::Error) -> Error {
    if err.kind() == std::io::ErrorKind::NotFound {
        Error::GitNotFound(err.to_string())
    } else {
        Error::Io(err)
    }
}

/// Converts a failed [`Output`] into an [`Error::Command`].
pub(crate) fn failure<S: AsRef<OsStr>>(args: &[S], out: &Output) -> Error {
    let mut message = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if message.is_empty() {
        message = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }
    if message.is_empty() {
        message = format!("exit status {:?}", out.status.code());
    }
    Error::Command {
        command: describe(args),
        code: out.status.code(),
        message,
    }
}

/// True when git failed only because another process holds a repository lock (`index.lock`).
/// Git checks the lock before changing anything, so the command can simply be retried.
pub(crate) fn lock_busy(out: &Output) -> bool {
    let err = String::from_utf8_lossy(&out.stderr);
    err.contains(".lock") && (err.contains("File exists") || err.contains("Another git process"))
}

/// Runs git and returns its raw output regardless of exit status. Retries for up to ~3 s
/// while another git process (an agent, a terminal, an editor) holds the index lock.
pub(crate) fn output<S: AsRef<OsStr>>(
    dir: &Path,
    args: &[S],
    stdin: Option<&[u8]>,
) -> Result<Output> {
    let mut attempt = 0;
    loop {
        let out = output_once(dir, args, stdin)?;
        if out.status.success() || attempt >= 30 || !lock_busy(&out) {
            return Ok(out);
        }
        attempt += 1;
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn output_once<S: AsRef<OsStr>>(dir: &Path, args: &[S], stdin: Option<&[u8]>) -> Result<Output> {
    let mut cmd = command(dir, false);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn().map_err(spawn_error)?;
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take().expect("stdin piped");
        let input = input.to_vec();
        // Write on a separate thread so large inputs cannot deadlock with stdout.
        let writer = std::thread::spawn(move || {
            let _ = pipe.write_all(&input);
        });
        let out = child.wait_with_output()?;
        let _ = writer.join();
        return Ok(out);
    }
    Ok(child.wait_with_output()?)
}

/// Runs git, failing on a non-zero exit status, and returns stdout bytes.
pub(crate) fn run<S: AsRef<OsStr>>(dir: &Path, args: &[S]) -> Result<Vec<u8>> {
    let out = output(dir, args, None)?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(failure(args, &out))
    }
}

/// Like [`run`] with stdin input.
pub(crate) fn run_input<S: AsRef<OsStr>>(dir: &Path, args: &[S], input: &[u8]) -> Result<Vec<u8>> {
    let out = output(dir, args, Some(input))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(failure(args, &out))
    }
}

/// Like [`run`], returning stdout as (lossy) UTF-8 text.
pub(crate) fn run_str<S: AsRef<OsStr>>(dir: &Path, args: &[S]) -> Result<String> {
    Ok(String::from_utf8_lossy(&run(dir, args)?).into_owned())
}

/// Result of a long-running command.
pub(crate) struct ProgressOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    /// Non-progress stderr lines (messages, errors).
    pub messages: String,
}

impl ProgressOutput {
    pub(crate) fn into_error(self, command: &str) -> Error {
        let mut message = self.messages.trim().to_string();
        if message.is_empty() {
            message = self.stdout.trim().to_string();
        }
        Error::Command {
            command: command.to_string(),
            code: self.code,
            message,
        }
    }

    pub(crate) fn combined(&self) -> String {
        let mut s = self.stdout.trim().to_string();
        let m = self.messages.trim();
        if !m.is_empty() {
            if !s.is_empty() {
                s.push('\n');
            }
            s.push_str(m);
        }
        s
    }
}

/// Runs a (network) git command, streaming `--progress` stderr into `progress`
/// and killing the process when `cancel` becomes true.
pub(crate) fn run_progress(
    dir: &Path,
    args: &[OsString],
    progress: &mut dyn FnMut(Progress),
    cancel: Option<&AtomicBool>,
) -> Result<ProgressOutput> {
    let mut cmd = command(dir, true);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(spawn_error)?;
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");

    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        let mut line = Vec::new();
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &b in &chunk[..n] {
                        if b == b'\r' || b == b'\n' {
                            if !line.is_empty() {
                                let text = String::from_utf8_lossy(&line).into_owned();
                                line.clear();
                                if tx.send(text).is_err() {
                                    return;
                                }
                            }
                        } else {
                            line.push(b);
                        }
                    }
                }
            }
        }
        if !line.is_empty() {
            let _ = tx.send(String::from_utf8_lossy(&line).into_owned());
        }
    });

    let mut messages = String::new();
    let cancelled = || cancel.is_some_and(|c| c.load(Ordering::SeqCst));
    loop {
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Cancelled);
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => {
                let p = parse_progress(&line);
                if p.percent.is_none() {
                    messages.push_str(&line);
                    messages.push('\n');
                }
                progress(p);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Cancelled);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = out_thread.join().unwrap_or_default();
    Ok(ProgressOutput {
        success: status.success(),
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        messages,
    })
}

/// Joins a repository-relative path onto `repo`, rejecting absolute paths and `..`.
pub(crate) fn safe_join(repo: &Path, rel: &str) -> Result<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() {
        return Err(Error::Invalid("empty path".into()));
    }
    for c in p.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => {
                return Err(Error::Invalid(format!(
                    "path must be relative to the repository: {rel}"
                )))
            }
        }
    }
    Ok(repo.join(p))
}

/// Turns a repository-relative path into a literal pathspec (no glob magic).
pub(crate) fn lit(path: &str) -> String {
    format!(":(literal){path}")
}

/// Rejects values that git would interpret as options.
pub(crate) fn no_option(what: &str, value: &str) -> Result<()> {
    if value.starts_with('-') || value.is_empty() {
        Err(Error::Invalid(format!("invalid {what}: {value:?}")))
    } else {
        Ok(())
    }
}

/// Splits NUL separated output, dropping the trailing empty field.
pub(crate) fn split_nul(bytes: &[u8]) -> Vec<String> {
    let mut v: Vec<String> = bytes
        .split(|b| *b == 0)
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    if v.last().is_some_and(|s| s.is_empty()) {
        v.pop();
    }
    v
}

/// Whether `HEAD` points at a commit (false in a fresh repository).
pub(crate) fn has_head(repo: &Path) -> Result<bool> {
    let out = output(
        repo,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        None,
    )?;
    Ok(out.status.success())
}

/// Absolute path of the repository's git directory.
pub(crate) fn git_dir(repo: &Path) -> Result<PathBuf> {
    let s = run_str(repo, &["rev-parse", "--absolute-git-dir"])?;
    Ok(PathBuf::from(s.trim_end_matches(['\n', '\r'])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_config_reaches_git_via_env() {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init", "-q"]).unwrap();
        run(dir.path(), &["config", "user.name", "Local Name"]).unwrap();
        set_extra_config(vec![
            ("user.name".into(), "Configured Via Env".into()),
            (
                "http.https://github.com/.extraheader".into(),
                "AUTHORIZATION: basic c2VjcmV0".into(),
            ),
        ]);
        let name = run_str(dir.path(), &["config", "user.name"]).unwrap();
        assert_eq!(name.trim(), "Configured Via Env");
        let header = run_str(
            dir.path(),
            &["config", "http.https://github.com/.extraheader"],
        )
        .unwrap();
        assert_eq!(header.trim(), "AUTHORIZATION: basic c2VjcmV0");
        // Values never appear in argv or error messages.
        let cmd = command(dir.path(), true);
        assert!(!format!("{:?}", cmd.get_args().collect::<Vec<_>>()).contains("c2VjcmV0"));
        let err = run(dir.path(), &["no-such-subcommand"])
            .unwrap_err()
            .to_string();
        assert!(!err.contains("c2VjcmV0"), "{err}");
        set_extra_config(Vec::new());
        let name = run_str(dir.path(), &["config", "user.name"]).unwrap();
        assert_eq!(name.trim(), "Local Name");
        assert!(run(
            dir.path(),
            &["config", "http.https://github.com/.extraheader"]
        )
        .is_err());
    }
}
