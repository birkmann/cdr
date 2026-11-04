//! Git commands for the UI, backed by `studio-git` (the git CLI).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use studio_git as g;
use tauri::{AppHandle, Emitter, State};

use super::{blocking, err, CmdResult};
use crate::AppState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    op: String,
    percent: Option<u8>,
    phase: String,
}

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Register a cancel flag for a long-running operation (one per operation name).
fn cancel_flag(op: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    cancels()
        .lock()
        .unwrap()
        .insert(op.to_string(), flag.clone());
    flag
}

fn progress(app: &AppHandle, op: &'static str) -> impl FnMut(g::Progress) {
    let app = app.clone();
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    move |p: g::Progress| {
        // Throttle UI updates.
        if last.elapsed() < std::time::Duration::from_millis(80) && p.percent != Some(100) {
            return;
        }
        last = std::time::Instant::now();
        let phase = if p.phase.is_empty() {
            p.message.clone()
        } else {
            p.phase.clone()
        };
        let _ = app.emit(
            "git://progress",
            ProgressEvent {
                op: op.into(),
                percent: p.percent,
                phase,
            },
        );
    }
}

#[tauri::command]
pub async fn git_cancel(op: String) -> CmdResult<()> {
    if let Some(f) = cancels().lock().unwrap().get(&op) {
        f.store(true, Ordering::SeqCst);
    }
    Ok(())
}

macro_rules! repo_cmd {
    ($name:ident ( $($arg:ident : $ty:ty),* ) -> $ret:ty => |$root:ident| $body:expr) => {
        #[tauri::command]
        pub async fn $name(root: String, $($arg: $ty,)* state: State<'_, AppState>) -> CmdResult<$ret> {
            let $root: PathBuf = state.root(&root)?;
            blocking(move || $body.map_err(err)).await
        }
    };
}

#[tauri::command]
pub async fn git_is_repo(root: String, state: State<'_, AppState>) -> CmdResult<bool> {
    let root = state.root(&root)?;
    blocking(move || Ok(g::is_repo(&root))).await
}

repo_cmd!(git_init() -> () => |r| g::init(&r));
repo_cmd!(git_status() -> g::Status => |r| g::status(&r));
repo_cmd!(git_diff_file(path: String, staged: bool) -> g::FileDiff => |r| g::diff_file(&r, &path, staged));
repo_cmd!(git_diff_text(staged: bool) -> String => |r| g::diff_text(&r, staged));
repo_cmd!(git_stage(paths: Vec<String>) -> () => |r| g::stage(&r, &paths));
repo_cmd!(git_unstage(paths: Vec<String>) -> () => |r| g::unstage(&r, &paths));
repo_cmd!(git_discard(paths: Vec<String>) -> () => |r| g::discard(&r, &paths));
repo_cmd!(git_stage_hunk(path: String, hunk: usize) -> () => |r| g::stage_hunk(&r, &path, hunk));
repo_cmd!(git_unstage_hunk(path: String, hunk: usize) -> () => |r| g::unstage_hunk(&r, &path, hunk));
repo_cmd!(git_discard_hunk(path: String, hunk: usize) -> () => |r| g::discard_hunk(&r, &path, hunk));
repo_cmd!(git_commit(options: g::CommitOptions) -> g::Commit => |r| g::commit(&r, &options).map(|i| i.commit));
repo_cmd!(git_show(id: String) -> g::CommitDetail => |r| g::show_commit(&r, &id));
repo_cmd!(git_commit_file_diff(id: String, path: String) -> g::FileDiff => |r| g::commit_file_diff(&r, &id, &path));
repo_cmd!(git_blame(path: String) -> Vec<g::BlameLine> => |r| g::blame(&r, &path));
repo_cmd!(git_branches() -> Vec<g::Branch> => |r| g::branches(&r));
repo_cmd!(git_create_branch(name: String, start: Option<String>, checkout: bool) -> () => |r| g::create_branch(&r, &name, start.as_deref(), checkout));
repo_cmd!(git_checkout(name: String) -> () => |r| g::checkout(&r, &name));
repo_cmd!(git_rename_branch(from: String, to: String) -> () => |r| g::rename_branch(&r, &from, &to));
repo_cmd!(git_delete_branch(name: String, force: bool) -> () => |r| g::delete_branch(&r, &name, force));
repo_cmd!(git_merge(branch: String) -> g::MergeResult => |r| g::merge(&r, &branch));
repo_cmd!(git_rebase(onto: String) -> g::MergeResult => |r| g::rebase(&r, &onto));
repo_cmd!(git_continue_rebase() -> g::MergeResult => |r| g::continue_rebase(&r));
repo_cmd!(git_cherry_pick(id: String) -> g::MergeResult => |r| g::cherry_pick(&r, &id));
repo_cmd!(git_stashes() -> Vec<g::Stash> => |r| g::stashes(&r));
repo_cmd!(git_stash_push(message: Option<String>, include_untracked: bool) -> bool => |r| g::stash_push(&r, message.as_deref(), include_untracked));
repo_cmd!(git_stash_pop(index: usize) -> g::MergeResult => |r| g::stash_pop(&r, index));
repo_cmd!(git_stash_drop(index: usize) -> () => |r| g::stash_drop(&r, index));
repo_cmd!(git_remotes() -> Vec<g::Remote> => |r| g::remotes(&r));
repo_cmd!(git_add_remote(name: String, url: String) -> () => |r| g::add_remote(&r, &name, &url));
repo_cmd!(git_worktrees() -> Vec<g::Worktree> => |r| g::worktrees(&r));
repo_cmd!(git_conflict(path: String) -> g::ConflictFile => |r| g::conflict_versions(&r, &path));
repo_cmd!(git_resolve(path: String, content: String) -> () => |r| g::resolve_conflict(&r, &path, &content));

/// Abort whichever of merge, rebase, or cherry-pick is in progress.
#[tauri::command]
pub async fn git_abort(root: String, state: State<'_, AppState>) -> CmdResult<()> {
    let r = state.root(&root)?;
    blocking(move || {
        let s = g::status(&r).map_err(err)?;
        if s.rebase_in_progress {
            g::abort_rebase(&r).map_err(err)
        } else if s.merge_in_progress {
            g::abort_merge(&r).map_err(err)
        } else {
            g::abort_cherry_pick(&r).map_err(err)
        }
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogResult {
    commits: Vec<g::Commit>,
    graph: Vec<g::GraphRow>,
}

#[tauri::command]
pub async fn git_log(
    root: String,
    options: g::LogOptions,
    state: State<'_, AppState>,
) -> CmdResult<LogResult> {
    let r = state.root(&root)?;
    blocking(move || {
        let commits = g::log(&r, &options).map_err(err)?;
        let graph = g::graph_lanes(&commits);
        Ok(LogResult { commits, graph })
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(root: String, app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let r = state.root(&root)?;
    let cancel = cancel_flag("fetch");
    let p = progress(&app, "fetch");
    blocking(move || g::fetch(&r, None, p, Some(cancel)).map_err(err)).await
}

#[tauri::command]
pub async fn git_pull(
    root: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<g::MergeResult> {
    let r = state.root(&root)?;
    let cancel = cancel_flag("pull");
    let p = progress(&app, "pull");
    blocking(move || g::pull(&r, p, Some(cancel)).map_err(err)).await
}

#[tauri::command]
pub async fn git_push(
    root: String,
    branch: Option<String>,
    set_upstream: bool,
    force_with_lease: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let r = state.root(&root)?;
    let cancel = cancel_flag("push");
    let p = progress(&app, "push");
    blocking(move || {
        // Pushing a named branch needs a remote; default to origin like `git push -u origin <branch>`.
        let remote = branch.as_ref().map(|_| "origin");
        g::push(
            &r,
            remote,
            branch.as_deref(),
            set_upstream,
            force_with_lease,
            p,
            Some(cancel),
        )
        .map_err(err)
    })
    .await
}

/// Clone into `dest` (created). The new folder is registered as an open workspace.
#[tauri::command]
pub async fn git_clone(
    url: String,
    dest: String,
    options: g::CloneOptions,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<String> {
    let dest = PathBuf::from(&dest);
    if dest.exists()
        && std::fs::read_dir(&dest)
            .map(|mut d| d.next().is_some())
            .unwrap_or(true)
    {
        return Err(format!(
            "{} already exists and is not empty.",
            dest.display()
        ));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    let cancel = cancel_flag("clone");
    let p = progress(&app, "clone");
    let path =
        blocking(move || g::clone(&url, &dest, &options, p, Some(cancel)).map_err(err)).await?;
    state.allow(&path)?;
    Ok(path.to_string_lossy().to_string())
}
