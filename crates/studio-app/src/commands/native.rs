//! Terminals, file watching, directory listing and language servers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use super::{blocking, err, secrets, CmdResult};
use crate::AppState;

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn app() -> Option<&'static AppHandle> {
    APP.get()
}

// ------------------------------------------------------------------ terminals

fn ptys() -> &'static studio_pty::PtyManager {
    static P: OnceLock<studio_pty::PtyManager> = OnceLock::new();
    P.get_or_init(studio_pty::PtyManager::new)
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: u32,
    code: Option<i32>,
}

/// Start a shell (or `command` through the shell) in a workspace folder.
#[tauri::command]
pub async fn pty_spawn(
    root: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
    state: State<'_, AppState>,
) -> CmdResult<u32> {
    let cwd = state.root(&root)?;
    let mut opts = studio_pty::SpawnOptions::new(cwd);
    opts.cols = cols;
    opts.rows = rows;
    opts.env = vec![
        ("TERM".into(), "xterm-256color".into()),
        ("COLORTERM".into(), "truecolor".into()),
        ("TERM_PROGRAM".into(), "CDRStudio".into()),
    ];
    // Keys stored for the harness stay out of user terminals.
    opts.env_remove = secrets::provider_names();
    if let Some(cmd) = command.filter(|c| !c.trim().is_empty()) {
        // Run the command, then keep an interactive shell open so output stays readable.
        #[cfg(unix)]
        {
            let shell = studio_pty::default_shell();
            opts.shell = Some(shell.clone());
            opts.args = vec!["-c".into(), format!("{cmd}; exec {shell}")];
        }
        #[cfg(windows)]
        {
            opts.shell = Some("cmd.exe".into());
            opts.args = vec!["/K".into(), cmd];
        }
    }
    let id = ptys()
        .spawn(
            opts,
            |id, bytes| {
                if let Some(a) = app() {
                    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                    let _ = a.emit("pty://output", PtyOutput { id, data });
                }
            },
            |id, code| {
                if let Some(a) = app() {
                    let _ = a.emit("pty://exit", PtyExit { id, code });
                }
            },
        )
        .map_err(err)?;
    Ok(id)
}

#[tauri::command]
pub async fn pty_write(id: u32, data: String) -> CmdResult<()> {
    ptys().write(id, data.as_bytes()).map_err(err)
}

#[tauri::command]
pub async fn pty_resize(id: u32, cols: u16, rows: u16) -> CmdResult<()> {
    ptys().resize(id, cols, rows).map_err(err)
}

#[tauri::command]
pub async fn pty_kill(id: u32) -> CmdResult<()> {
    // The process may already have exited.
    let _ = ptys().kill(id);
    Ok(())
}

// ------------------------------------------------------------------ files & watching

fn watchers() -> &'static Mutex<HashMap<PathBuf, studio_watch::Watcher>> {
    static W: OnceLock<Mutex<HashMap<PathBuf, studio_watch::Watcher>>> = OnceLock::new();
    W.get_or_init(Default::default)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChanged {
    root: String,
    paths: Vec<String>,
    git_changed: bool,
}

#[tauri::command]
pub async fn watch_start(root: String, state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.root(&root)?;
    if watchers().lock().unwrap().contains_key(&root) {
        return Ok(());
    }
    let root_str = root.to_string_lossy().to_string();
    let r = root.clone();
    let w = blocking(move || {
        studio_watch::Watcher::new(&r, 150, move |batch| {
            if let Some(a) = app() {
                let _ = a.emit(
                    "fs://changed",
                    FsChanged {
                        root: root_str.clone(),
                        paths: batch.changes.iter().map(|c| c.path.clone()).collect(),
                        git_changed: batch.git_changed,
                    },
                );
            }
        })
        .map_err(err)
    })
    .await?;
    watchers().lock().unwrap().insert(root, w);
    Ok(())
}

#[tauri::command]
pub async fn watch_stop(root: String) -> CmdResult<()> {
    if let Ok(p) = Path::new(&root).canonicalize() {
        watchers().lock().unwrap().remove(&p);
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_list_dir(
    root: String,
    path: String,
    state: State<'_, AppState>,
) -> CmdResult<Vec<studio_watch::DirEntry>> {
    let root = state.root(&root)?;
    crate::paths::resolve(&root, &path).map_err(err)?;
    blocking(move || studio_watch::read_dir(&root, &path).map_err(err)).await
}

#[tauri::command]
pub async fn fs_list_files(root: String, state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let root = state.root(&root)?;
    blocking(move || studio_watch::list_files(&root, 50_000).map_err(err)).await
}

// ------------------------------------------------------------------ language servers

fn lsp_manager() -> &'static studio_lsp::LspManager {
    static L: OnceLock<studio_lsp::LspManager> = OnceLock::new();
    L.get_or_init(|| studio_lsp::LspManager::new(on_lsp_message))
}

/// Diagnostic in the shape the editor and Problems view use (1-based lines and columns).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiDiagnostic {
    path: String,
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
    severity: &'static str,
    message: String,
    source: Option<String>,
}

fn severity(s: studio_lsp::Severity) -> &'static str {
    match s {
        studio_lsp::Severity::Error => "error",
        studio_lsp::Severity::Warning => "warning",
        studio_lsp::Severity::Information => "info",
        studio_lsp::Severity::Hint => "hint",
    }
}

fn ui(path: &str, d: &studio_lsp::Diagnostic) -> UiDiagnostic {
    UiDiagnostic {
        path: path.to_string(),
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        end_line: d.range.end.line + 1,
        end_column: d.range.end.character + 1,
        severity: severity(d.severity),
        message: d.message.clone(),
        source: d.source.clone(),
    }
}

#[derive(Clone, Serialize)]
struct DiagnosticsEvent {
    root: String,
    path: String,
    diagnostics: Vec<UiDiagnostic>,
}

fn on_lsp_message(id: studio_lsp::ServerId, msg: Value) {
    if msg.get("method").and_then(|m| m.as_str()) != Some("textDocument/publishDiagnostics") {
        return;
    }
    let Some(a) = app() else { return };
    let Some(uri) = msg.pointer("/params/uri").and_then(|u| u.as_str()) else {
        return;
    };
    let Some(file) = studio_lsp::uri_to_path(uri) else {
        return;
    };
    let Some(server) = lsp_manager().servers().into_iter().find(|s| s.id == id) else {
        return;
    };
    let Ok(rel) = file.strip_prefix(&server.root) else {
        return;
    };
    let rel = rel.to_string_lossy().replace('\\', "/");
    let all = lsp_manager().diagnostics(&server.root);
    let diagnostics = all
        .get(&rel)
        .map(|ds| ds.iter().map(|d| ui(&rel, d)).collect())
        .unwrap_or_default();
    let _ = a.emit(
        "lsp://diagnostics",
        DiagnosticsEvent {
            root: server.root.to_string_lossy().to_string(),
            path: rel,
            diagnostics,
        },
    );
}

#[tauri::command]
pub async fn lsp_available() -> CmdResult<Vec<studio_lsp::ServerAvailability>> {
    blocking(|| Ok(lsp_manager().availability())).await
}

/// Start (or reuse) the language server for `language` in `root`. Returns null when none is installed.
#[tauri::command]
pub async fn lsp_start(
    root: String,
    language: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<u32>> {
    let root = state.root(&root)?;
    blocking(move || {
        let m = lsp_manager();
        if let Some(s) = m
            .servers()
            .into_iter()
            .find(|s| s.language == language && s.root == root)
        {
            return Ok(Some(s.id));
        }
        let available = m
            .availability()
            .into_iter()
            .any(|a| a.language == language && a.available);
        if !available {
            return Ok(None);
        }
        m.start(&language, &root).map(Some).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn lsp_send(id: u32, message: String) -> CmdResult<()> {
    blocking(move || lsp_manager().send(id, &message).map_err(err)).await
}

#[tauri::command]
pub async fn lsp_diagnostics(
    root: String,
    state: State<'_, AppState>,
) -> CmdResult<Vec<UiDiagnostic>> {
    let root = state.root(&root)?;
    Ok(lsp_manager()
        .diagnostics(&root)
        .iter()
        .flat_map(|(p, ds)| ds.iter().map(move |d| ui(p, d)))
        .collect())
}

pub fn shutdown() {
    ptys().kill_all();
    lsp_manager().shutdown_all();
    watchers().lock().unwrap().clear();
}
