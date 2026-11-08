//! Tauri commands exposed to the webview. Every command returns `Result<T, String>` so errors
//! arrive in the UI as readable messages.

pub mod app;
pub mod git;
pub mod native;
pub mod secrets;

use tauri::AppHandle;

pub type CmdResult<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Run blocking work (git, file system) off the async runtime.
pub async fn blocking<T, F>(f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CmdResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

pub fn init(app: &AppHandle) {
    native::init(app);
    secrets::init(app);
    if let Some(t) = app::github_token() {
        studio_git::set_extra_config(crate::github::git_auth_pairs(&t));
    }
}

pub fn shutdown(_app: &AppHandle) {
    native::shutdown();
}

pub async fn load_provider_env(app: &AppHandle) {
    secrets::load_provider_env(app).await;
}

pub fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        app::harness_status,
        app::harness_logs,
        app::harness_restart,
        app::workspace_open,
        app::workspace_allow,
        app::workspace_recent,
        app::workspace_forget,
        app::app_info,
        app::settings_get,
        app::settings_set_clone_dir,
        app::fs_read,
        app::fs_read_image,
        app::fs_write,
        app::fs_create,
        app::fs_rename,
        app::fs_delete,
        app::fs_search,
        app::fs_replace,
        app::github_status,
        app::github_set_token,
        app::github_import_gh,
        app::github_logout,
        app::github_repos,
        app::github_search,
        app::github_pulls,
        app::github_create_pr,
        app::github_create_repo,
        app::github_device_start,
        app::github_device_poll,
        secrets::provider_keys_list,
        secrets::provider_key_set,
        secrets::provider_key_delete,
        native::pty_spawn,
        native::pty_write,
        native::pty_resize,
        native::pty_kill,
        native::watch_start,
        native::watch_stop,
        native::fs_list_dir,
        native::fs_list_files,
        native::lsp_available,
        native::lsp_start,
        native::lsp_send,
        native::lsp_diagnostics,
        git::git_cancel,
        git::git_is_repo,
        git::git_init,
        git::git_status,
        git::git_summary,
        git::git_diff_file,
        git::git_diff_text,
        git::git_stage,
        git::git_unstage,
        git::git_discard,
        git::git_stage_hunk,
        git::git_unstage_hunk,
        git::git_discard_hunk,
        git::git_commit,
        git::git_log,
        git::git_show,
        git::git_commit_file_diff,
        git::git_blame,
        git::git_branches,
        git::git_create_branch,
        git::git_checkout,
        git::git_rename_branch,
        git::git_delete_branch,
        git::git_merge,
        git::git_rebase,
        git::git_abort,
        git::git_continue_rebase,
        git::git_cherry_pick,
        git::git_stashes,
        git::git_stash_push,
        git::git_stash_pop,
        git::git_stash_drop,
        git::git_remotes,
        git::git_add_remote,
        git::git_fetch,
        git::git_pull,
        git::git_push,
        git::git_clone,
        git::git_worktrees,
        git::git_conflict,
        git::git_resolve,
    ]
}
