//! CDR Studio: Tauri shell around the CDR harness.
//!
//! Rust owns what a browser cannot do (git, terminals, files, watching, language servers,
//! credentials, the harness process). Agents run inside the harness and are rendered from its
//! events; the app keeps no agent state of its own.

pub mod commands;
pub mod files;
pub mod github;
pub mod paths;
pub mod scheduler;
pub mod settings;
pub mod sidecar;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::{Manager, RunEvent};
use tokio::sync::Mutex;

use settings::AppSettings;
use sidecar::Sidecar;

pub struct AppState {
    pub sidecar: Sidecar,
    pub settings: Mutex<AppSettings>,
    pub settings_path: PathBuf,
    pub config_dir: PathBuf,
    /// Canonical roots the user opened; file, git, and terminal commands are confined to these.
    pub workspaces: std::sync::Mutex<HashSet<PathBuf>>,
    pub github: github::Github,
}

impl AppState {
    /// Canonical root for a workspace path the user has opened (or a folder inside one).
    pub fn root(&self, path: &str) -> Result<PathBuf, String> {
        let p = Path::new(path)
            .canonicalize()
            .map_err(|e| format!("{path}: {e}"))?;
        let ws = self.workspaces.lock().unwrap();
        if ws.iter().any(|r| p.starts_with(r)) {
            Ok(p)
        } else {
            Err(format!("Workspace is not open: {path}"))
        }
    }

    pub fn allow(&self, path: &Path) -> Result<PathBuf, String> {
        let p = path
            .canonicalize()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if !p.is_dir() {
            return Err(format!("Not a folder: {}", p.display()));
        }
        if p.parent().is_none() || Some(&p) == dirs::home_dir().as_ref() {
            return Err(
                "Open a project folder, not your home directory or the filesystem root.".into(),
            );
        }
        self.workspaces.lock().unwrap().insert(p.clone());
        Ok(p)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from(".morrow-studio"));
            let _ = std::fs::create_dir_all(&config_dir);
            let settings_path = config_dir.join("settings.json");
            let state = AppState {
                sidecar: Sidecar::new(),
                settings: Mutex::new(AppSettings::load(&settings_path)),
                settings_path,
                config_dir,
                workspaces: Default::default(),
                github: github::Github::default(),
            };
            let sidecar = state.sidecar.clone();
            app.manage(state);
            commands::init(app.handle());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                commands::load_provider_env(&handle).await;
                sidecar.start(handle.clone()).await;
            });
            scheduler::spawn(
                app.handle().clone(),
                app.state::<AppState>().sidecar.clone(),
            );
            Ok(())
        })
        .invoke_handler(commands::handler())
        .build(tauri::generate_context!())
        .expect("error while building CDR Studio");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<AppState>().sidecar.kill_blocking();
            commands::shutdown(handle);
        }
    });
}
