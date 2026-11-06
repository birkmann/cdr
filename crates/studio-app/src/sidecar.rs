//! Supervises the CDR harness server (Node) that runs agents for the app.
//!
//! The server binds 127.0.0.1 on a random port with a per-launch token passed through the
//! environment, so the token never appears on a command line or in a URL. When the server exits
//! unexpectedly it is restarted with backoff; the webview is told through `harness://status`.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

pub const TOKEN_ENV: &str = "CDR_STUDIO_TOKEN";
const MAX_LOG_LINES: usize = 400;
const MAX_RESTARTS: u32 = 5;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HarnessState {
    Starting,
    Ready,
    Restarting,
    Failed,
    Attached,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub state: HarnessState,
    pub url: Option<String>,
    pub token: Option<String>,
    pub error: Option<String>,
    pub node: Option<String>,
    pub entry: Option<String>,
    pub restarts: u32,
}

struct Inner {
    status: HarnessStatus,
    child: Option<Child>,
    logs: VecDeque<String>,
    /// Bumped on every intentional (re)start so a stale exit watcher does not restart.
    generation: u64,
    extra_env: Vec<(String, String)>,
}

#[derive(Clone)]
pub struct Sidecar {
    inner: Arc<Mutex<Inner>>,
}

impl Default for Sidecar {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                status: HarnessStatus {
                    state: HarnessState::Starting,
                    url: None,
                    token: None,
                    error: None,
                    node: None,
                    entry: None,
                    restarts: 0,
                },
                child: None,
                logs: VecDeque::new(),
                generation: 0,
                extra_env: Vec::new(),
            })),
        }
    }

    pub async fn status(&self) -> HarnessStatus {
        self.inner.lock().await.status.clone()
    }

    pub async fn logs(&self) -> Vec<String> {
        self.inner.lock().await.logs.iter().cloned().collect()
    }

    /// Environment added to the server process (provider keys from the keychain).
    pub async fn set_extra_env(&self, env: Vec<(String, String)>) {
        self.inner.lock().await.extra_env = env;
    }

    /// Start (or restart) the server. Uses an external server when CDR_STUDIO_SERVER is set.
    pub async fn start(&self, app: AppHandle) {
        if let (Ok(url), Ok(token)) = (std::env::var("CDR_STUDIO_SERVER"), std::env::var(TOKEN_ENV))
        {
            let mut g = self.inner.lock().await;
            g.status = HarnessStatus {
                state: HarnessState::Attached,
                url: Some(url.trim_end_matches('/').to_string()),
                token: Some(token),
                error: None,
                node: None,
                entry: None,
                restarts: 0,
            };
            let s = g.status.clone();
            drop(g);
            let _ = app.emit("harness://status", s);
            return;
        }
        let generation = {
            let mut g = self.inner.lock().await;
            if let Some(mut child) = g.child.take() {
                let _ = child.start_kill();
            }
            g.generation += 1;
            g.status.state = if g.status.restarts > 0 {
                HarnessState::Restarting
            } else {
                HarnessState::Starting
            };
            g.status.error = None;
            g.generation
        };
        let s = self.status().await;
        let _ = app.emit("harness://status", s);
        match self.spawn(&app, generation).await {
            Ok(()) => {}
            Err(e) => {
                let mut g = self.inner.lock().await;
                g.status.state = HarnessState::Failed;
                g.status.error = Some(e.to_string());
                g.logs.push_back(format!("[studio] {e}"));
                let s = g.status.clone();
                drop(g);
                let _ = app.emit("harness://status", s);
            }
        }
    }

    pub async fn stop(&self) {
        let mut g = self.inner.lock().await;
        g.generation += 1;
        if let Some(mut child) = g.child.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
    }

    /// Kill synchronously (used from the exit handler where no runtime await is possible).
    pub fn kill_blocking(&self) {
        if let Ok(mut g) = self.inner.try_lock() {
            g.generation += 1;
            if let Some(child) = g.child.as_mut() {
                let _ = child.start_kill();
            }
        }
    }

    async fn spawn(&self, app: &AppHandle, generation: u64) -> anyhow::Result<()> {
        let node = find_node().ok_or_else(|| {
            anyhow::anyhow!(
                "Node.js 22 or newer was not found. Install Node.js or set CDR_NODE to its path."
            )
        })?;
        let entry = find_entry(app).ok_or_else(|| {
            anyhow::anyhow!("The CDR harness was not found. Run `pnpm build:packages && pnpm bundle:harness`, or set CDR_HARNESS_ENTRY.")
        })?;
        let token = random_token();
        let extra_env = self.inner.lock().await.extra_env.clone();
        let mut cmd = Command::new(&node);
        cmd.arg(&entry)
            .args([
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--token-env",
                TOKEN_ENV,
                "--ready-json",
            ])
            .args([
                "--origin",
                "tauri://localhost",
                "--origin",
                "http://tauri.localhost",
                "--origin",
                "https://tauri.localhost",
            ])
            .args([
                "--origin",
                "http://127.0.0.1:5174",
                "--origin",
                "http://localhost:5174",
            ])
            .env(TOKEN_ENV, &token)
            // The harness exits when this process disappears, even after a crash or SIGKILL.
            .env("CDR_PARENT_PID", std::process::id().to_string())
            .env("NO_COLOR", "1")
            .envs(extra_env)
            .current_dir(dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow::anyhow!("Could not start {}: {e}", node.display()))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        {
            let mut g = self.inner.lock().await;
            g.status.node = Some(node.display().to_string());
            g.status.entry = Some(entry.display().to_string());
            g.child = Some(child);
        }

        let (ready_tx, ready_rx) = oneshot::channel::<String>();
        let me = self.clone();
        tokio::spawn(async move {
            let mut ready_tx = Some(ready_tx);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(url) = parse_ready(&line) {
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(url);
                    }
                }
                me.log(line).await;
            }
        });
        let me = self.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                me.log(line).await;
            }
        });

        let url = match tokio::time::timeout(Duration::from_secs(30), ready_rx).await {
            Ok(Ok(url)) => url,
            _ => {
                let tail = self
                    .logs()
                    .await
                    .into_iter()
                    .rev()
                    .take(6)
                    .collect::<Vec<_>>();
                let tail: Vec<_> = tail.into_iter().rev().collect();
                anyhow::bail!("The harness server did not start.\n{}", tail.join("\n"));
            }
        };
        {
            let mut g = self.inner.lock().await;
            if g.generation != generation {
                return Ok(());
            }
            g.status.state = HarnessState::Ready;
            g.status.url = Some(url);
            g.status.token = Some(token);
            let s = g.status.clone();
            drop(g);
            let _ = app.emit("harness://status", s);
        }
        self.watch_exit(app.clone(), generation);
        Ok(())
    }

    fn watch_exit(&self, app: AppHandle, generation: u64) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let mut g = me.inner.lock().await;
                if g.generation != generation {
                    return;
                }
                let exited = match g.child.as_mut() {
                    Some(c) => c.try_wait().ok().flatten(),
                    None => return,
                };
                let Some(code) = exited else { continue };
                g.child = None;
                g.logs
                    .push_back(format!("[studio] harness exited with {code}"));
                if g.status.restarts >= MAX_RESTARTS {
                    g.status.state = HarnessState::Failed;
                    g.status.error = Some(format!("The harness server stopped ({code}) and was restarted {MAX_RESTARTS} times."));
                    let s = g.status.clone();
                    drop(g);
                    let _ = app.emit("harness://status", s);
                    return;
                }
                g.status.restarts += 1;
                let delay = Duration::from_millis(500 * 2u64.pow(g.status.restarts.min(5)));
                drop(g);
                tokio::time::sleep(delay).await;
                me.start(app.clone()).await;
                return;
            }
        });
    }

    async fn log(&self, line: String) {
        let mut g = self.inner.lock().await;
        let line = redact_line(&line, g.status.token.as_deref());
        g.logs.push_back(line);
        while g.logs.len() > MAX_LOG_LINES {
            g.logs.pop_front();
        }
    }
}

/// Never keep a token in the diagnostic log, whether it is the current one or printed in a login URL.
fn redact_line(line: &str, token: Option<&str>) -> String {
    let mut out = line.to_string();
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        out = out.replace(t, "[redacted]");
    }
    let re = regex::Regex::new(r"token=[^&\s]+").expect("valid regex");
    re.replace_all(&out, "token=[redacted]").into_owned()
}

fn random_token() -> String {
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `{"ready":true,"url":"http://127.0.0.1:1234"}` or a printed `http://127.0.0.1:<port>` line.
pub fn parse_ready(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if v.get("ready").and_then(|r| r.as_bool()) == Some(true) {
                return v
                    .get("url")
                    .and_then(|u| u.as_str())
                    .map(|u| u.trim_end_matches('/').to_string());
            }
        }
        return None;
    }
    let re = regex::Regex::new(r"(http://127\.0\.0\.1:\d+)").ok()?;
    re.captures(trimmed).map(|c| c[1].to_string())
}

/// CDR_NODE, then `node` on PATH, then the login shell's PATH (desktop launchers often lack nvm).
pub fn find_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CDR_NODE") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(p) = which::which("node") {
        return Some(p);
    }
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        if let Ok(out) = std::process::Command::new(shell)
            .args(["-lic", "command -v node"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().rev().find(|l| l.trim_start().starts_with('/')) {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(p);
                }
            }
        }
        if let Some(home) = dirs::home_dir() {
            let nvm = home.join(".nvm/versions/node");
            if let Ok(rd) = std::fs::read_dir(&nvm) {
                let mut versions: Vec<PathBuf> = rd
                    .flatten()
                    .map(|e| e.path().join("bin/node"))
                    .filter(|p| p.exists())
                    .collect();
                versions.sort();
                if let Some(p) = versions.pop() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// CDR_HARNESS_ENTRY, then the bundled resource, then the repository checkout (development).
pub fn find_entry(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CDR_HARNESS_ENTRY") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("harness/cdr.mjs");
        if p.exists() {
            return Some(p);
        }
    }
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    [
        repo.join("dist-harness/cdr.mjs"),
        repo.join("packages/cli/dist/bin.js"),
    ]
    .into_iter()
    .find(|p| p.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_json_and_url_lines() {
        assert_eq!(
            parse_ready(r#"{"ready":true,"url":"http://127.0.0.1:4567/","port":4567}"#).as_deref(),
            Some("http://127.0.0.1:4567")
        );
        assert_eq!(
            parse_ready("→ Open the app: http://127.0.0.1:8787/#token=abc").as_deref(),
            Some("http://127.0.0.1:8787")
        );
        assert_eq!(parse_ready(r#"{"ready":false}"#), None);
        assert_eq!(parse_ready("starting"), None);
    }

    #[test]
    fn redacts_tokens_in_logs() {
        assert_eq!(
            redact_line("open http://x/#token=abc&server=y", None),
            "open http://x/#token=[redacted]&server=y"
        );
        assert_eq!(
            redact_line("key s3cret here", Some("s3cret")),
            "key [redacted] here"
        );
    }

    #[test]
    fn tokens_are_random_and_url_safe() {
        let a = random_token();
        assert_ne!(a, random_token());
        assert!(
            a.len() >= 40
                && a.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }
}
