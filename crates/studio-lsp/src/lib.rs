//! Language server supervisor and JSON-RPC bridge for CDR Studio.
//!
//! [`LspManager::start`] spawns a server from the registry (see
//! [`default_registry`]), performs the `initialize` / `initialized`
//! handshake and returns a [`ServerId`]. Afterwards the editor talks to the
//! server through [`LspManager::send`] (raw JSON-RPC passthrough) and
//! receives everything the server sends through the `on_message` callback
//! given to [`LspManager::new`].
//!
//! Threading: each server has a reader thread (stdout, parses frames and
//! invokes `on_message`) and a stderr drain thread; `send` writes from the
//! caller's thread. `on_message` therefore runs on reader threads and must
//! be `Send + Sync`.
//!
//! The manager answers a few server-to-client requests itself so servers
//! never stall waiting for an editor that does not implement them:
//! `workspace/configuration` (nulls), `workspace/workspaceFolders`,
//! `window/workDoneProgress/create`, `client/registerCapability` and
//! `client/unregisterCapability`. Those are not forwarded. Internal requests
//! use string ids prefixed with `studio-`; editor ids should be numbers.
//!
//! `textDocument/publishDiagnostics` notifications are forwarded *and*
//! cached; [`LspManager::diagnostics`] returns the cache for the Problems
//! view and the agent. When a server process ends, a synthetic
//! notification `{"method":"$/studio/serverExited","params":{"code":..}}`
//! is delivered through `on_message`.

mod framing;
mod registry;
mod uri;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, Value};

pub use framing::{read_json, read_message, write_message};
pub use registry::{availability, default_registry, which, ServerAvailability, ServerSpec};
pub use uri::{path_to_uri, uri_to_path};

/// Identifier of a running language server.
pub type ServerId = u32;

/// Errors of this crate; serializes as its message string.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no language server registered for {0:?}")]
    UnknownLanguage(String),
    #[error("language server {0:?} is not installed (not found on PATH)")]
    NotInstalled(String),
    #[error("no language server with id {0}")]
    NotFound(ServerId),
    #[error("language server failed to initialize: {0}")]
    Initialize(String),
    #[error("invalid JSON-RPC message: {0}")]
    InvalidMessage(String),
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

/// Zero-based position (UTF-16 code units, as negotiated by default in LSP).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

/// A range in a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// Diagnostic severity (missing severities are treated as errors).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
    Information,
    Hint,
}

/// A cached diagnostic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub range: Range,
    pub severity: Severity,
    pub message: String,
    pub source: Option<String>,
    /// Diagnostic code as a string (numbers are stringified).
    pub code: Option<String>,
    /// Server that reported it.
    pub server: ServerId,
}

/// A running server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub id: ServerId,
    pub language: String,
    pub root: PathBuf,
    pub command: String,
    pub pid: u32,
}

const INIT_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const STDERR_TAIL: usize = 64 * 1024;

type OnMessage = dyn Fn(ServerId, Value) + Send + Sync;

struct Server {
    info: ServerInfo,
    root_uri: String,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    capabilities: Mutex<Option<Value>>,
    stderr: Mutex<VecDeque<u8>>,
}

impl Server {
    fn write(&self, msg: &Value) -> Result<()> {
        let body = serde_json::to_vec(msg).expect("serialize JSON");
        let mut w = self.stdin.lock().unwrap();
        framing::write_message(&mut *w, &body)?;
        Ok(())
    }

    fn request(&self, id: &str, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.to_string(), tx);
        self.write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        let res = rx.recv_timeout(timeout);
        self.pending.lock().unwrap().remove(id);
        match res {
            Ok(v) => Ok(v),
            Err(_) => Err(Error::Initialize(format!(
                "no response to {method} within {}s",
                timeout.as_secs()
            ))),
        }
    }

    fn stderr_text(&self) -> String {
        let buf = self.stderr.lock().unwrap();
        let (a, b) = buf.as_slices();
        let mut v = a.to_vec();
        v.extend_from_slice(b);
        String::from_utf8_lossy(&v).into_owned()
    }
}

type DiagMap = HashMap<ServerId, HashMap<PathBuf, Vec<Diagnostic>>>;

struct Inner {
    registry: Vec<ServerSpec>,
    servers: Mutex<HashMap<ServerId, Arc<Server>>>,
    diagnostics: Mutex<DiagMap>,
    on_message: Box<OnMessage>,
    next_id: AtomicU32,
}

/// Supervises language servers. Cloning shares the same servers.
#[derive(Clone)]
pub struct LspManager {
    inner: Arc<Inner>,
}

/// Client capabilities sent with `initialize`.
pub fn client_capabilities() -> Value {
    json!({
        "general": { "positionEncodings": ["utf-16"] },
        "workspace": {
            "workspaceFolders": true,
            "configuration": true,
            "applyEdit": true,
            "workspaceEdit": { "documentChanges": true },
            "didChangeConfiguration": { "dynamicRegistration": false },
            "didChangeWatchedFiles": { "dynamicRegistration": false },
            "symbol": {}
        },
        "textDocument": {
            "synchronization": { "dynamicRegistration": false, "didSave": true, "willSave": false },
            "completion": {
                "contextSupport": true,
                "completionItem": {
                    "snippetSupport": true,
                    "documentationFormat": ["markdown", "plaintext"],
                    "resolveSupport": { "properties": ["documentation", "detail"] }
                }
            },
            "hover": { "contentFormat": ["markdown", "plaintext"] },
            "signatureHelp": {
                "signatureInformation": {
                    "documentationFormat": ["markdown", "plaintext"],
                    "parameterInformation": { "labelOffsetSupport": true }
                }
            },
            "definition": { "linkSupport": true },
            "typeDefinition": { "linkSupport": true },
            "implementation": { "linkSupport": true },
            "references": {},
            "documentHighlight": {},
            "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
            "codeAction": {
                "codeActionLiteralSupport": {
                    "codeActionKind": {
                        "valueSet": ["", "quickfix", "refactor", "refactor.extract",
                            "refactor.inline", "refactor.rewrite", "source",
                            "source.organizeImports"]
                    }
                },
                "resolveSupport": { "properties": ["edit"] }
            },
            "formatting": {},
            "rangeFormatting": {},
            "rename": { "prepareSupport": true },
            "inlayHint": {},
            "publishDiagnostics": {
                "relatedInformation": true,
                "versionSupport": true,
                "tagSupport": { "valueSet": [1, 2] }
            }
        },
        "window": { "workDoneProgress": true, "showMessage": {}, "showDocument": { "support": false } }
    })
}

fn parse_diagnostic(server: ServerId, v: &Value) -> Option<Diagnostic> {
    let range: Range = serde_json::from_value(v.get("range")?.clone()).ok()?;
    let severity = match v.get("severity").and_then(Value::as_u64) {
        Some(2) => Severity::Warning,
        Some(3) => Severity::Information,
        Some(4) => Severity::Hint,
        _ => Severity::Error,
    };
    let code = match v.get("code") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    Some(Diagnostic {
        range,
        severity,
        message: v.get("message")?.as_str()?.to_string(),
        source: v.get("source").and_then(Value::as_str).map(String::from),
        code,
        server,
    })
}

impl LspManager {
    /// Creates a manager with the [`default_registry`]. `on_message` receives
    /// every server → client message (responses to editor requests,
    /// notifications, server requests that are not answered internally).
    pub fn new(on_message: impl Fn(ServerId, Value) + Send + Sync + 'static) -> LspManager {
        Self::with_registry(default_registry(), on_message)
    }

    /// Creates a manager with a custom registry.
    pub fn with_registry(
        registry: Vec<ServerSpec>,
        on_message: impl Fn(ServerId, Value) + Send + Sync + 'static,
    ) -> LspManager {
        LspManager {
            inner: Arc::new(Inner {
                registry,
                servers: Mutex::new(HashMap::new()),
                diagnostics: Mutex::new(HashMap::new()),
                on_message: Box::new(on_message),
                next_id: AtomicU32::new(1),
            }),
        }
    }

    /// The registry in use.
    pub fn registry(&self) -> &[ServerSpec] {
        &self.inner.registry
    }

    /// Availability of each registry entry on this machine.
    pub fn availability(&self) -> Vec<ServerAvailability> {
        availability(&self.inner.registry)
    }

    /// Finds the registry entry for a language name, LSP language id or file
    /// extension.
    pub fn spec_for(&self, language: &str) -> Option<&ServerSpec> {
        self.inner.registry.iter().find(|s| s.matches(language))
    }

    /// Starts the server for `language` in `root`, performs the initialize
    /// handshake (blocking, up to 60 s) and returns its id. If a server for
    /// the same registry entry and root is already running, its id is
    /// returned instead.
    pub fn start(&self, language: &str, root: impl AsRef<Path>) -> Result<ServerId> {
        let spec = self
            .spec_for(language)
            .ok_or_else(|| Error::UnknownLanguage(language.to_string()))?
            .clone();
        let root = root.as_ref().canonicalize()?;
        if let Some(id) = self
            .servers()
            .into_iter()
            .find(|s| s.language == spec.language && s.root == root)
            .map(|s| s.id)
        {
            return Ok(id);
        }
        let exe = which(&spec.command).ok_or_else(|| Error::NotInstalled(spec.command.clone()))?;
        let mut cmd = Command::new(&exe);
        studio_env::apply(&mut cmd);
        let mut child = cmd
            .args(&spec.args)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        let root_uri = path_to_uri(&root);
        let server = Arc::new(Server {
            info: ServerInfo {
                id,
                language: spec.language.clone(),
                root: root.clone(),
                command: spec.command.clone(),
                pid: child.id(),
            },
            root_uri: root_uri.clone(),
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            capabilities: Mutex::new(None),
            stderr: Mutex::new(VecDeque::new()),
        });
        self.inner
            .servers
            .lock()
            .unwrap()
            .insert(id, Arc::clone(&server));

        {
            let server = Arc::clone(&server);
            std::thread::Builder::new()
                .name(format!("lsp-{id}-stderr"))
                .spawn(move || {
                    let mut buf = [0u8; 4096];
                    while let Ok(n) = stderr.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        let mut tail = server.stderr.lock().unwrap();
                        tail.extend(&buf[..n]);
                        let excess = tail.len().saturating_sub(STDERR_TAIL);
                        tail.drain(..excess);
                    }
                })?;
        }
        {
            let inner = Arc::downgrade(&self.inner);
            let server = Arc::clone(&server);
            std::thread::Builder::new()
                .name(format!("lsp-{id}-reader"))
                .spawn(move || reader_loop(inner, server, stdout))?;
        }

        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let params = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "CDR Studio", "version": env!("CARGO_PKG_VERSION") },
            "locale": "en",
            "rootPath": root.display().to_string(),
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": root_uri, "name": name }],
            "capabilities": client_capabilities(),
            "initializationOptions": spec.initialization_options.clone().unwrap_or(Value::Null),
            "trace": "off"
        });
        let init = server
            .request("studio-initialize", "initialize", params, INIT_TIMEOUT)
            .and_then(|resp| {
                if let Some(err) = resp.get("error") {
                    return Err(Error::Initialize(err.to_string()));
                }
                Ok(resp.get("result").cloned().unwrap_or(Value::Null))
            });
        let result = match init {
            Ok(r) => r,
            Err(e) => {
                let tail = server.stderr_text();
                let _ = self.kill(id);
                return Err(match e {
                    Error::Initialize(m) if !tail.trim().is_empty() => {
                        Error::Initialize(format!("{m}; stderr: {}", tail.trim()))
                    }
                    e => e,
                });
            }
        };
        *server.capabilities.lock().unwrap() = result.get("capabilities").cloned();
        server.write(&json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}))?;
        Ok(id)
    }

    fn server(&self, id: ServerId) -> Result<Arc<Server>> {
        self.inner
            .servers
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or(Error::NotFound(id))
    }

    /// Sends a raw JSON-RPC message (request, response or notification)
    /// from the editor to the server. The text must be one JSON object.
    pub fn send(&self, id: ServerId, json_message: &str) -> Result<()> {
        let value: Value =
            serde_json::from_str(json_message).map_err(|e| Error::InvalidMessage(e.to_string()))?;
        self.send_value(id, &value)
    }

    /// Like [`send`](Self::send) with an already parsed message.
    pub fn send_value(&self, id: ServerId, message: &Value) -> Result<()> {
        if !message.is_object() {
            return Err(Error::InvalidMessage(
                "message must be a JSON object".into(),
            ));
        }
        let server = self.server(id)?;
        let mut msg = message.clone();
        if msg.get("jsonrpc").is_none() {
            msg["jsonrpc"] = json!("2.0");
        }
        server.write(&msg)
    }

    /// `ServerCapabilities` from the server's initialize result.
    pub fn capabilities(&self, id: ServerId) -> Result<Option<Value>> {
        Ok(self.server(id)?.capabilities.lock().unwrap().clone())
    }

    /// The last 64 KiB the server wrote to stderr (its log).
    pub fn stderr_tail(&self, id: ServerId) -> Result<String> {
        Ok(self.server(id)?.stderr_text())
    }

    /// Running servers ordered by id.
    pub fn servers(&self) -> Vec<ServerInfo> {
        let mut v: Vec<ServerInfo> = self
            .inner
            .servers
            .lock()
            .unwrap()
            .values()
            .map(|s| s.info.clone())
            .collect();
        v.sort_by_key(|s| s.id);
        v
    }

    /// Cached diagnostics of all servers for files under `root`, keyed by
    /// path relative to `root` (forward slashes), sorted by path, with each
    /// file's diagnostics sorted by position.
    pub fn diagnostics(&self, root: impl AsRef<Path>) -> BTreeMap<String, Vec<Diagnostic>> {
        let root = root.as_ref();
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let mut out: BTreeMap<String, Vec<Diagnostic>> = BTreeMap::new();
        let cache = self.inner.diagnostics.lock().unwrap();
        for files in cache.values() {
            for (path, diags) in files {
                let Ok(rel) = path.strip_prefix(&root) else {
                    continue;
                };
                let key = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.entry(key).or_default().extend(diags.iter().cloned());
            }
        }
        for diags in out.values_mut() {
            diags.sort_by_key(|d| (d.range.start.line, d.range.start.character, d.severity));
        }
        out
    }

    /// Gracefully stops a server (`shutdown` request, `exit` notification),
    /// killing it if it does not exit within a few seconds.
    pub fn shutdown(&self, id: ServerId) -> Result<()> {
        let server = self.server(id)?;
        let _ = server.request(
            &format!("studio-shutdown-{id}"),
            "shutdown",
            Value::Null,
            SHUTDOWN_TIMEOUT,
        );
        // Forget it first so the reader does not report an unexpected exit.
        self.inner.servers.lock().unwrap().remove(&id);
        self.inner.diagnostics.lock().unwrap().remove(&id);
        let _ = server.write(&json!({"jsonrpc": "2.0", "method": "exit"}));
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        let mut child = server.child.lock().unwrap();
        loop {
            if child.try_wait()?.is_some() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        Ok(())
    }

    /// Kills a server immediately and forgets it.
    pub fn kill(&self, id: ServerId) -> Result<()> {
        let server = self
            .inner
            .servers
            .lock()
            .unwrap()
            .remove(&id)
            .ok_or(Error::NotFound(id))?;
        {
            let mut child = server.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
        self.inner.diagnostics.lock().unwrap().remove(&id);
        Ok(())
    }

    /// Shuts down every server.
    pub fn shutdown_all(&self) {
        for s in self.servers() {
            let _ = self.shutdown(s.id);
        }
    }
}

fn reader_loop(inner: Weak<Inner>, server: Arc<Server>, stdout: std::process::ChildStdout) {
    let id = server.info.id;
    let mut reader = BufReader::new(stdout);
    while let Ok(Some(msg)) = framing::read_json(&mut reader) {
        if !msg.is_object() {
            continue;
        }
        // The manager is gone: stop forwarding.
        let Some(inner) = inner.upgrade() else { return };
        dispatch(&inner, &server, msg);
    }
    let Some(inner) = inner.upgrade() else { return };
    // Stream closed: the process exited (or is about to).
    let mut code = None;
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        match server.child.lock().unwrap().try_wait() {
            Ok(Some(status)) => {
                code = status.code();
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let was_running = inner.servers.lock().unwrap().remove(&id).is_some();
    inner.diagnostics.lock().unwrap().remove(&id);
    server.pending.lock().unwrap().clear();
    if was_running {
        (inner.on_message)(
            id,
            json!({"jsonrpc": "2.0", "method": "$/studio/serverExited", "params": {"code": code}}),
        );
    }
}

fn dispatch(inner: &Inner, server: &Server, msg: Value) {
    let id = server.info.id;
    let method = msg.get("method").and_then(Value::as_str).map(String::from);
    let msg_id = msg.get("id").cloned();
    match (method.as_deref(), msg_id) {
        // Response.
        (None, Some(rid)) => {
            if let Some(s) = rid.as_str().filter(|s| s.starts_with("studio-")) {
                if let Some(tx) = server.pending.lock().unwrap().remove(s) {
                    let _ = tx.send(msg);
                }
                return;
            }
            (inner.on_message)(id, msg);
        }
        // Server → client request.
        (Some(m), Some(rid)) => {
            let result = match m {
                "workspace/configuration" => {
                    let n = msg["params"]["items"].as_array().map_or(0, Vec::len);
                    Some(Value::Array(vec![Value::Null; n]))
                }
                "workspace/workspaceFolders" => {
                    let name = server
                        .info
                        .root
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    Some(json!([{ "uri": server.root_uri, "name": name }]))
                }
                "window/workDoneProgress/create"
                | "client/registerCapability"
                | "client/unregisterCapability" => Some(Value::Null),
                _ => None,
            };
            match result {
                Some(r) => {
                    let _ = server.write(&json!({"jsonrpc": "2.0", "id": rid, "result": r}));
                }
                None => (inner.on_message)(id, msg),
            }
        }
        // Notification.
        (Some(m), None) => {
            if m == "textDocument/publishDiagnostics" {
                update_diagnostics(inner, id, &msg["params"]);
            }
            (inner.on_message)(id, msg);
        }
        (None, None) => {}
    }
}

fn update_diagnostics(inner: &Inner, id: ServerId, params: &Value) {
    let Some(path) = params
        .get("uri")
        .and_then(Value::as_str)
        .and_then(uri_to_path)
    else {
        return;
    };
    let diags: Vec<Diagnostic> = params
        .get("diagnostics")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|d| parse_diagnostic(id, d)).collect())
        .unwrap_or_default();
    let mut cache = inner.diagnostics.lock().unwrap();
    let files = cache.entry(id).or_default();
    if diags.is_empty() {
        files.remove(&path);
    } else {
        files.insert(path, diags);
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        for (_, s) in self.servers.lock().unwrap().drain() {
            let mut c = s.child.lock().unwrap();
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
