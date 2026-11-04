//! Terminals for CDR Studio, built on `portable-pty`.
//!
//! [`PtyManager::spawn`] starts a shell (or any program) attached to a new
//! pseudo terminal. Output is delivered from a dedicated reader thread per
//! terminal through the `on_output` callback; a second waiter thread reports
//! the exit code through `on_exit` once the process ended and its output has
//! been drained, then forgets the terminal. All methods are cheap and
//! non-blocking apart from writes to the terminal.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize, Serializer};

/// Identifier of a terminal, unique within a [`PtyManager`].
pub type PtyId = u32;

/// Errors of this crate; serializes as its message string.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no terminal with id {0}")]
    NotFound(PtyId),
    #[error("failed to start terminal: {0}")]
    Spawn(String),
    #[error("terminal error: {0}")]
    Pty(String),
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

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

/// How to start a terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Working directory.
    pub cwd: PathBuf,
    /// Program to run; defaults to [`default_shell`].
    #[serde(default)]
    pub shell: Option<String>,
    /// Arguments for the program (none starts an interactive shell).
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment variables (override inherited ones).
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// Inherited environment variables to remove (e.g. provider API keys).
    #[serde(default)]
    pub env_remove: Vec<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

impl SpawnOptions {
    /// Options for an interactive default shell in `cwd`, 80x24.
    pub fn new(cwd: impl Into<PathBuf>) -> SpawnOptions {
        SpawnOptions {
            cwd: cwd.into(),
            shell: None,
            args: Vec::new(),
            env: Vec::new(),
            env_remove: Vec::new(),
            cols: default_cols(),
            rows: default_rows(),
        }
    }
}

/// A running terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: PtyId,
    pub pid: Option<u32>,
    pub shell: String,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
}

/// The default shell: `$SHELL`, else `/bin/sh` (Unix) or `%COMSPEC%`,
/// else `powershell.exe` (Windows).
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

struct Entry {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    info: PtyInfo,
}

/// Owns all terminals of the app. Cloning shares the same set of terminals.
#[derive(Clone, Default)]
pub struct PtyManager {
    entries: Arc<Mutex<HashMap<PtyId, Entry>>>,
    next_id: Arc<AtomicU32>,
}

fn pty_err(e: impl std::fmt::Display) -> Error {
    Error::Pty(e.to_string())
}

impl PtyManager {
    pub fn new() -> PtyManager {
        PtyManager::default()
    }

    /// Starts a terminal. `on_output` receives raw output bytes from a reader
    /// thread; `on_exit` is called once with the exit code (`None` when killed
    /// by a signal) after the output has been drained.
    pub fn spawn(
        &self,
        opts: SpawnOptions,
        on_output: impl Fn(PtyId, Vec<u8>) + Send + 'static,
        on_exit: impl Fn(PtyId, Option<i32>) + Send + 'static,
    ) -> Result<PtyId> {
        let size = PtySize {
            rows: opts.rows.max(1),
            cols: opts.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| Error::Spawn(e.to_string()))?;
        let shell = opts
            .shell
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(&opts.args);
        cmd.cwd(&opts.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for k in &opts.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| Error::Spawn(format!("{shell}: {e}")))?;
        // The slave side belongs to the child now; keeping it open would
        // prevent EOF on the reader.
        drop(pair.slave);

        let master = pair.master;
        let mut reader = master.try_clone_reader().map_err(pty_err)?;
        let writer = master.take_writer().map_err(pty_err)?;
        let killer = child.clone_killer();
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let info = PtyInfo {
            id,
            pid: child.process_id(),
            shell,
            cwd: opts.cwd.clone(),
            cols: size.cols,
            rows: size.rows,
        };
        self.entries.lock().unwrap().insert(
            id,
            Entry {
                master,
                writer: Arc::new(Mutex::new(writer)),
                killer,
                info,
            },
        );

        let (done_tx, done_rx) = mpsc::channel::<()>();
        std::thread::Builder::new()
            .name(format!("pty-{id}-reader"))
            .spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => on_output(id, buf[..n].to_vec()),
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                let _ = done_tx.send(());
            })?;

        let entries = Arc::clone(&self.entries);
        std::thread::Builder::new()
            .name(format!("pty-{id}-waiter"))
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) if status.signal().is_none() => Some(status.exit_code() as i32),
                    _ => None,
                };
                // Let the reader drain what the process printed last. A
                // background process can keep the terminal open, so do not
                // wait forever.
                let _ = done_rx.recv_timeout(Duration::from_millis(500));
                entries.lock().unwrap().remove(&id);
                on_exit(id, code);
            })?;
        Ok(id)
    }

    /// Writes input (keystrokes, pasted text) to the terminal.
    pub fn write(&self, id: PtyId, bytes: &[u8]) -> Result<()> {
        // Clone the writer out so a blocked write (full terminal buffer)
        // does not hold the manager lock.
        let writer = {
            let map = self.entries.lock().unwrap();
            Arc::clone(&map.get(&id).ok_or(Error::NotFound(id))?.writer)
        };
        let mut w = writer.lock().unwrap();
        w.write_all(bytes)?;
        w.flush()?;
        Ok(())
    }

    /// Resizes the terminal.
    pub fn resize(&self, id: PtyId, cols: u16, rows: u16) -> Result<()> {
        let mut map = self.entries.lock().unwrap();
        let e = map.get_mut(&id).ok_or(Error::NotFound(id))?;
        let size = PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        e.master.resize(size).map_err(pty_err)?;
        e.info.cols = size.cols;
        e.info.rows = size.rows;
        Ok(())
    }

    /// Kills the terminal's process. `on_exit` still fires.
    pub fn kill(&self, id: PtyId) -> Result<()> {
        let mut map = self.entries.lock().unwrap();
        let e = map.get_mut(&id).ok_or(Error::NotFound(id))?;
        e.killer.kill()?;
        Ok(())
    }

    /// Kills every terminal (e.g. on window close).
    pub fn kill_all(&self) {
        let mut map = self.entries.lock().unwrap();
        for e in map.values_mut() {
            let _ = e.killer.kill();
        }
    }

    /// Running terminals, ordered by id.
    pub fn list(&self) -> Vec<PtyInfo> {
        let map = self.entries.lock().unwrap();
        let mut v: Vec<PtyInfo> = map.values().map(|e| e.info.clone()).collect();
        v.sort_by_key(|i| i.id);
        v
    }
}
