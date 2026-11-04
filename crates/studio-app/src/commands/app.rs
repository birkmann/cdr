use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, State};

use super::{blocking, err, secrets, CmdResult};
use crate::files::{self, FileContent, SearchOptions, SearchResult};
use crate::github::{DeviceCode, GithubRepo, GithubUser, PullRequest};
use crate::settings::{AppSettings, RecentRepo};
use crate::sidecar::HarnessStatus;
use crate::AppState;

// ------------------------------------------------------------------ harness

#[tauri::command]
pub async fn harness_status(state: State<'_, AppState>) -> CmdResult<HarnessStatus> {
    Ok(state.sidecar.status().await)
}

#[tauri::command]
pub async fn harness_logs(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    Ok(state.sidecar.logs().await)
}

#[tauri::command]
pub async fn harness_restart(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    secrets::load_provider_env(&app).await;
    state.sidecar.start(app.clone()).await;
    Ok(())
}

// ------------------------------------------------------------------ workspaces

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub root: String,
    pub name: String,
}

#[tauri::command]
pub async fn workspace_open(path: String, state: State<'_, AppState>) -> CmdResult<Workspace> {
    let root = state.allow(&PathBuf::from(&path))?;
    let mut s = state.settings.lock().await;
    s.touch_recent(&root);
    s.save(&state.settings_path).map_err(err)?;
    Ok(Workspace {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        root: root.to_string_lossy().to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    #[serde(flatten)]
    pub repo: RecentRepo,
    pub exists: bool,
}

#[tauri::command]
pub async fn workspace_recent(state: State<'_, AppState>) -> CmdResult<Vec<RecentEntry>> {
    let s = state.settings.lock().await;
    Ok(s.recent_repos
        .iter()
        .map(|r| RecentEntry {
            exists: PathBuf::from(&r.path).is_dir(),
            repo: r.clone(),
        })
        .collect())
}

#[tauri::command]
pub async fn workspace_forget(path: String, state: State<'_, AppState>) -> CmdResult<()> {
    let mut s = state.settings.lock().await;
    s.recent_repos.retain(|r| r.path != path);
    s.save(&state.settings_path).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub home: String,
    pub config_dir: String,
    pub default_clone_dir: String,
    pub platform: String,
    pub github_client_id: bool,
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> CmdResult<AppInfo> {
    let s = state.settings.lock().await;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        home: dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default(),
        config_dir: state.config_dir.to_string_lossy().to_string(),
        default_clone_dir: s.default_clone_dir().to_string_lossy().to_string(),
        platform: std::env::consts::OS.into(),
        github_client_id: std::env::var("CDR_GITHUB_CLIENT_ID")
            .or_else(|_| std::env::var("MORROW_GITHUB_CLIENT_ID"))
            .is_ok(),
    })
}

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> CmdResult<AppSettings> {
    Ok(state.settings.lock().await.clone())
}

#[tauri::command]
pub async fn settings_set_clone_dir(path: String, state: State<'_, AppState>) -> CmdResult<()> {
    let mut s = state.settings.lock().await;
    s.clone_dir = Some(path);
    s.save(&state.settings_path).map_err(err)
}

// ------------------------------------------------------------------ files

#[tauri::command]
pub async fn fs_read(
    root: String,
    path: String,
    state: State<'_, AppState>,
) -> CmdResult<FileContent> {
    let root = state.root(&root)?;
    blocking(move || files::read(&root, &path).map_err(err)).await
}

#[tauri::command]
pub async fn fs_write(
    root: String,
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> CmdResult<u64> {
    let root = state.root(&root)?;
    blocking(move || files::write(&root, &path, &content).map_err(err)).await
}

#[tauri::command]
pub async fn fs_create(
    root: String,
    path: String,
    dir: bool,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let root = state.root(&root)?;
    blocking(move || files::create(&root, &path, dir).map_err(err)).await
}

#[tauri::command]
pub async fn fs_rename(
    root: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let root = state.root(&root)?;
    blocking(move || files::rename(&root, &from, &to).map_err(err)).await
}

#[tauri::command]
pub async fn fs_delete(root: String, path: String, state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.root(&root)?;
    blocking(move || files::delete(&root, &path).map_err(err)).await
}

#[tauri::command]
pub async fn fs_search(
    root: String,
    query: String,
    options: SearchOptions,
    state: State<'_, AppState>,
) -> CmdResult<SearchResult> {
    let root = state.root(&root)?;
    blocking(move || files::search(&root, &query, &options)).await
}

#[tauri::command]
pub async fn fs_replace(
    root: String,
    query: String,
    replacement: String,
    options: SearchOptions,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> CmdResult<usize> {
    let root = state.root(&root)?;
    blocking(move || files::replace_all(&root, &query, &replacement, &options, &paths)).await
}

// ------------------------------------------------------------------ GitHub

const GITHUB_TOKEN: &str = "github_token";

pub fn github_token() -> Option<String> {
    secrets::get(GITHUB_TOKEN)
}

/// Store the token and make git use it for github.com over HTTPS.
fn store_token(token: &str) -> CmdResult<()> {
    secrets::set(GITHUB_TOKEN, token)?;
    studio_git::set_extra_config(crate::github::git_auth_pairs(token));
    Ok(())
}

fn require_token() -> CmdResult<String> {
    github_token().ok_or_else(|| "Sign in to GitHub first (Settings → GitHub).".to_string())
}

#[tauri::command]
pub async fn github_status(state: State<'_, AppState>) -> CmdResult<Option<GithubUser>> {
    match github_token() {
        None => Ok(None),
        Some(t) => state.github.user(&t).await.map(Some).map_err(err),
    }
}

#[tauri::command]
pub async fn github_set_token(token: String, state: State<'_, AppState>) -> CmdResult<GithubUser> {
    let token = token.trim().to_string();
    let user = state.github.user(&token).await.map_err(err)?;
    store_token(&token)?;
    Ok(user)
}

#[tauri::command]
pub async fn github_import_gh(state: State<'_, AppState>) -> CmdResult<GithubUser> {
    let token = blocking(|| {
        crate::github::gh_cli_token()
            .ok_or_else(|| "The GitHub CLI (gh) is not installed or not signed in.".to_string())
    })
    .await?;
    let user = state.github.user(&token).await.map_err(err)?;
    store_token(&token)?;
    Ok(user)
}

#[tauri::command]
pub async fn github_logout() -> CmdResult<()> {
    studio_git::set_extra_config(Vec::new());
    secrets::delete(GITHUB_TOKEN)
}

#[tauri::command]
pub async fn github_repos(
    page: Option<u32>,
    state: State<'_, AppState>,
) -> CmdResult<Vec<GithubRepo>> {
    let t = require_token()?;
    state.github.repos(&t, page.unwrap_or(1)).await.map_err(err)
}

#[tauri::command]
pub async fn github_search(
    query: String,
    state: State<'_, AppState>,
) -> CmdResult<Vec<GithubRepo>> {
    let t = require_token()?;
    state.github.search_repos(&t, &query).await.map_err(err)
}

fn slug(root: &std::path::Path) -> CmdResult<(String, String)> {
    studio_git::github_repo_slug(root)
        .ok_or_else(|| "The origin remote is not a GitHub repository.".to_string())
}

#[tauri::command]
pub async fn github_pulls(root: String, state: State<'_, AppState>) -> CmdResult<Vec<PullRequest>> {
    let t = require_token()?;
    let (owner, name) = slug(&state.root(&root)?)?;
    state.github.pulls(&t, &owner, &name).await.map_err(err)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn github_create_pr(
    root: String,
    head: String,
    base: String,
    title: String,
    body: String,
    draft: bool,
    state: State<'_, AppState>,
) -> CmdResult<PullRequest> {
    let t = require_token()?;
    let (owner, name) = slug(&state.root(&root)?)?;
    state
        .github
        .create_pull(&t, &owner, &name, &head, &base, &title, &body, draft)
        .await
        .map_err(err)
}

fn client_id() -> CmdResult<String> {
    std::env::var("CDR_GITHUB_CLIENT_ID").or_else(|_| std::env::var("MORROW_GITHUB_CLIENT_ID"))
        .map_err(|_| "Browser sign-in needs CDR_GITHUB_CLIENT_ID (a GitHub OAuth app). Paste a personal access token instead.".to_string())
}

#[tauri::command]
pub async fn github_device_start(state: State<'_, AppState>) -> CmdResult<DeviceCode> {
    state.github.device_start(&client_id()?).await.map_err(err)
}

#[tauri::command]
pub async fn github_device_poll(
    device_code: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<GithubUser>> {
    match state
        .github
        .device_poll(&client_id()?, &device_code)
        .await
        .map_err(err)?
    {
        None => Ok(None),
        Some(token) => {
            let user = state.github.user(&token).await.map_err(err)?;
            store_token(&token)?;
            Ok(Some(user))
        }
    }
}
