//! Provider API keys and the GitHub token in the OS keychain (file fallback when unavailable).
//!
//! Names that look like environment variables (`DEEPSEEK_API_KEY`) are provider keys and are passed
//! to the harness process. Other names (`github_token`) are used only by the app.

use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::{err, CmdResult};
use crate::AppState;

static STORE: OnceLock<Result<studio_keys::KeyStore, String>> = OnceLock::new();

fn store() -> CmdResult<&'static studio_keys::KeyStore> {
    STORE
        .get()
        .ok_or_else(|| "The key store is not ready yet.".to_string())?
        .as_ref()
        .map_err(|e| e.clone())
}

pub fn init(app: &AppHandle) {
    let config = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from(".cdr-studio"));
    let fallback = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| config.clone())
        .join("keys");
    let _ = STORE.set(studio_keys::KeyStore::open(&config, &fallback).map_err(err));
}

pub fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('A'..='Z'))
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

pub fn get(name: &str) -> Option<String> {
    store().ok()?.get(name).ok().flatten()
}

pub fn set(name: &str, value: &str) -> CmdResult<()> {
    store()?.set(name, value).map_err(err)
}

pub fn delete(name: &str) -> CmdResult<()> {
    store()?.delete(name).map(|_| ()).map_err(err)
}

/// Names of stored provider keys (never their values).
pub fn provider_names() -> Vec<String> {
    store()
        .ok()
        .and_then(|s| s.list_known().ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|n| is_env_name(n))
        .collect()
}

/// Give the harness the stored provider keys as environment variables.
pub async fn load_provider_env(app: &AppHandle) {
    let pairs: Vec<(String, String)> = provider_names()
        .into_iter()
        .filter_map(|n| get(&n).map(|v| (n, v)))
        .collect();
    app.state::<AppState>().sidecar.set_extra_env(pairs).await;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredKey {
    name: String,
    backend: String,
}

#[tauri::command]
pub async fn provider_keys_list() -> CmdResult<Vec<StoredKey>> {
    let s = store()?;
    let backend = s.backend().to_string();
    Ok(provider_names()
        .into_iter()
        .map(|name| StoredKey {
            name,
            backend: backend.clone(),
        })
        .collect())
}

async fn restart(app: &AppHandle, state: &State<'_, AppState>) {
    load_provider_env(app).await;
    state.sidecar.start(app.clone()).await;
}

#[tauri::command]
pub async fn provider_key_set(
    name: String,
    value: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    if !is_env_name(&name) {
        return Err("Use an environment variable name such as DEEPSEEK_API_KEY.".into());
    }
    set(&name, value.trim())?;
    restart(&app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn provider_key_delete(
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    delete(&name)?;
    restart(&app, &state).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_names() {
        assert!(is_env_name("DEEPSEEK_API_KEY"));
        assert!(is_env_name("K2"));
        assert!(!is_env_name("github_token"));
        assert!(!is_env_name("2KEY"));
        assert!(!is_env_name(""));
    }
}
