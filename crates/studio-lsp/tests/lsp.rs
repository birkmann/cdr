//! Integration tests for the LSP supervisor.
//!
//! This is a `harness = false` test: run with `--fake-lsp-server`, the same
//! executable acts as a tiny language server speaking Content-Length framed
//! JSON-RPC over stdio, so no real language server is needed.

use std::io::{BufReader, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use studio_lsp::{
    path_to_uri, read_json, write_message, Error, LspManager, ServerId, ServerSpec, Severity,
};

// ---------------------------------------------------------------- fake server

fn send(out: &mut impl Write, v: Value) {
    write_message(out, &serde_json::to_vec(&v).unwrap()).unwrap();
}

fn publish(out: &mut impl Write, uri: &str, text: &str) {
    let mut diags = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if let Some(col) = line.find("ERROR") {
            diags.push(json!({
                "range": {"start": {"line": i, "character": col}, "end": {"line": i, "character": col + 5}},
                "severity": 1, "message": format!("error on line {}", i + 1), "source": "fake"
            }));
        }
        if let Some(col) = line.find("WARN") {
            diags.push(json!({
                "range": {"start": {"line": i, "character": col}, "end": {"line": i, "character": col + 4}},
                "severity": 2, "message": "a warning", "code": 42
            }));
        }
    }
    send(
        out,
        json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
        "params": {"uri": uri, "diagnostics": diags}}),
    );
}

fn fake_server() {
    let stdin = std::io::stdin();
    let mut input = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    // Stray output before the first frame must be tolerated.
    out.write_all(b"fake server booting\n").unwrap();
    while let Ok(Some(msg)) = read_json(&mut input) {
        let method = msg["method"].as_str().unwrap_or("");
        let id = msg.get("id").cloned();
        match method {
            "initialize" => {
                assert!(msg["params"]["rootUri"]
                    .as_str()
                    .unwrap()
                    .starts_with("file://"));
                assert!(msg["params"]["capabilities"]["textDocument"].is_object());
                send(
                    &mut out,
                    json!({"jsonrpc": "2.0", "id": id, "result": {
                    "capabilities": {"hoverProvider": true, "textDocumentSync": 1},
                    "serverInfo": {"name": "fake"}}}),
                );
            }
            "initialized" => {
                send(
                    &mut out,
                    json!({"jsonrpc": "2.0", "id": 100, "method": "workspace/configuration",
                    "params": {"items": [{"section": "fake"}, {"section": "other"}]}}),
                );
                send(
                    &mut out,
                    json!({"jsonrpc": "2.0", "id": 101,
                    "method": "window/workDoneProgress/create", "params": {"token": "t"}}),
                );
                send(
                    &mut out,
                    json!({"jsonrpc": "2.0", "id": 102,
                    "method": "window/showMessageRequest", "params": {"type": 3, "message": "hi"}}),
                );
            }
            "" if id == Some(json!(100)) => {
                send(
                    &mut out,
                    json!({"jsonrpc": "2.0", "method": "fake/configured",
                    "params": msg["result"].clone()}),
                );
            }
            "" => {}
            "textDocument/didOpen" => {
                let td = &msg["params"]["textDocument"];
                publish(
                    &mut out,
                    td["uri"].as_str().unwrap(),
                    td["text"].as_str().unwrap(),
                );
            }
            "textDocument/didChange" => {
                let uri = msg["params"]["textDocument"]["uri"].as_str().unwrap();
                let text = msg["params"]["contentChanges"][0]["text"].as_str().unwrap();
                publish(&mut out, uri, text);
            }
            "textDocument/didClose" => {
                let uri = msg["params"]["textDocument"]["uri"].as_str().unwrap();
                publish(&mut out, uri, "");
            }
            "textDocument/hover" => {
                let p = &msg["params"]["position"];
                send(
                    &mut out,
                    json!({"jsonrpc": "2.0", "id": id, "result": {"contents":
                    {"kind": "plaintext", "value": format!("hover at {}:{}", p["line"], p["character"])}}}),
                );
            }
            "fake/crash" => std::process::exit(3),
            "shutdown" => send(
                &mut out,
                json!({"jsonrpc": "2.0", "id": id, "result": null}),
            ),
            "exit" => std::process::exit(0),
            _ => {
                if id.is_some() {
                    send(
                        &mut out,
                        json!({"jsonrpc": "2.0", "id": id,
                        "error": {"code": -32601, "message": "method not found"}}),
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------- helpers

type Inbox = Arc<Mutex<Vec<(ServerId, Value)>>>;

fn fake_spec() -> ServerSpec {
    ServerSpec {
        language: "fake".into(),
        language_ids: vec!["fakelang".into()],
        extensions: vec!["fake".into()],
        command: std::env::current_exe().unwrap().display().to_string(),
        args: vec!["--fake-lsp-server".into()],
        initialization_options: Some(json!({"x": 1})),
    }
}

fn manager() -> (LspManager, Inbox) {
    let inbox: Inbox = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&inbox);
    let mut registry = studio_lsp::default_registry();
    registry.push(fake_spec());
    registry.push(ServerSpec {
        language: "missing".into(),
        language_ids: vec![],
        extensions: vec!["missing".into()],
        command: "no-such-language-server-xyz".into(),
        args: vec![],
        initialization_options: None,
    });
    let m = LspManager::with_registry(registry, move |id, v| sink.lock().unwrap().push((id, v)));
    (m, inbox)
}

fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}

fn find(inbox: &Inbox, pred: impl Fn(&Value) -> bool) -> Option<Value> {
    inbox
        .lock()
        .unwrap()
        .iter()
        .map(|(_, v)| v)
        .find(|v| pred(v))
        .cloned()
}

fn open(m: &LspManager, id: ServerId, path: &Path, text: &str) {
    m.send(
        id,
        &json!({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {"textDocument": {
            "uri": path_to_uri(path), "languageId": "fakelang", "version": 1, "text": text}}})
        .to_string(),
    )
    .unwrap();
}

// ---------------------------------------------------------------- tests

fn handshake_passthrough_and_auto_responses() {
    let dir = tempfile::tempdir().unwrap();
    let (m, inbox) = manager();
    let id = m.start("fake", dir.path()).unwrap();
    assert_eq!(
        m.start(".fake", dir.path()).unwrap(),
        id,
        "reuses running server"
    );
    assert_eq!(m.servers().len(), 1);
    assert_eq!(m.servers()[0].language, "fake");
    let caps = m.capabilities(id).unwrap().unwrap();
    assert_eq!(caps["hoverProvider"], true);

    // workspace/configuration was answered internally with one null per item.
    wait_until("fake/configured", || {
        find(&inbox, |v| v["method"] == "fake/configured").is_some()
    });
    let conf = find(&inbox, |v| v["method"] == "fake/configured").unwrap();
    assert_eq!(conf["params"], json!([null, null]));
    // Auto-answered requests are not forwarded, others are.
    assert!(find(&inbox, |v| v["method"] == "workspace/configuration").is_none());
    assert!(find(&inbox, |v| v["method"] == "window/workDoneProgress/create").is_none());
    wait_until("showMessageRequest", || {
        find(&inbox, |v| v["method"] == "window/showMessageRequest").is_some()
    });

    // Editor request → server response forwarded with the editor's id.
    m.send(id, r#"{"jsonrpc":"2.0","id":7,"method":"textDocument/hover","params":{"textDocument":{"uri":"file:///x.fake"},"position":{"line":3,"character":5}}}"#).unwrap();
    wait_until("hover response", || {
        find(&inbox, |v| v["id"] == 7).is_some()
    });
    let hover = find(&inbox, |v| v["id"] == 7).unwrap();
    assert_eq!(hover["result"]["contents"]["value"], "hover at 3:5");
    // The internal initialize response is not forwarded.
    assert!(find(&inbox, |v| v["id"] == "studio-initialize").is_none());

    assert!(matches!(
        m.send(id, "{not json"),
        Err(Error::InvalidMessage(_))
    ));
    assert!(matches!(m.send(id, "[1]"), Err(Error::InvalidMessage(_))));
    m.shutdown(id).unwrap();
    assert!(m.servers().is_empty());
    assert!(matches!(m.send(id, "{}"), Err(Error::NotFound(_))));
}

fn diagnostics_cache() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    let file = root.join("src/main file.fake");
    let other = root.join("ok.fake");
    let (m, inbox) = manager();
    let id = m.start("fakelang", &root).unwrap();

    open(&m, id, &file, "fine\n  WARN here\nERROR there\n");
    open(&m, id, &other, "all good\n");
    wait_until("diagnostics", || {
        m.diagnostics(&root).contains_key("src/main file.fake")
    });
    let d = m.diagnostics(&root);
    assert_eq!(d.len(), 1, "{d:?}");
    let list = &d["src/main file.fake"];
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].severity, Severity::Warning);
    assert_eq!(list[0].range.start.line, 1);
    assert_eq!(list[0].range.start.character, 2);
    assert_eq!(list[0].code.as_deref(), Some("42"));
    assert_eq!(list[1].severity, Severity::Error);
    assert_eq!(list[1].message, "error on line 3");
    assert_eq!(list[1].source.as_deref(), Some("fake"));
    assert_eq!(list[1].server, id);
    // The notification itself is forwarded to the editor too.
    assert!(find(&inbox, |v| v["method"] == "textDocument/publishDiagnostics").is_some());
    // JSON shape for the Problems view.
    let json = serde_json::to_value(&d).unwrap();
    assert_eq!(json["src/main file.fake"][0]["severity"], "warning");
    assert_eq!(
        json["src/main file.fake"][0]["range"]["start"]["character"],
        2
    );

    // Other roots see nothing.
    let elsewhere = tempfile::tempdir().unwrap();
    assert!(m.diagnostics(elsewhere.path()).is_empty());

    // Full-text change clears the warning.
    m.send(
        id,
        &json!({"jsonrpc": "2.0", "method": "textDocument/didChange", "params": {
        "textDocument": {"uri": path_to_uri(&file), "version": 2},
        "contentChanges": [{"text": "ERROR only\n"}]}})
        .to_string(),
    )
    .unwrap();
    wait_until("changed diagnostics", || {
        m.diagnostics(&root)
            .get("src/main file.fake")
            .map(|l| l.len())
            == Some(1)
    });

    m.send(
        id,
        &json!({"jsonrpc": "2.0", "method": "textDocument/didClose", "params": {
        "textDocument": {"uri": path_to_uri(&file)}}})
        .to_string(),
    )
    .unwrap();
    wait_until("cleared diagnostics", || m.diagnostics(&root).is_empty());

    open(&m, id, &file, "ERROR again\n");
    wait_until("diagnostics again", || !m.diagnostics(&root).is_empty());
    m.shutdown(id).unwrap();
    assert!(
        m.diagnostics(&root).is_empty(),
        "shutdown drops the server's diagnostics"
    );
}

fn crash_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let (m, inbox) = manager();
    let id = m.start("fake", dir.path()).unwrap();
    m.send(id, r#"{"method":"fake/crash"}"#).unwrap();
    wait_until("serverExited", || {
        find(&inbox, |v| v["method"] == "$/studio/serverExited").is_some()
    });
    let exited = find(&inbox, |v| v["method"] == "$/studio/serverExited").unwrap();
    assert_eq!(exited["params"]["code"], 3);
    assert!(m.servers().is_empty());
    assert!(m.shutdown(id).is_err());
}

fn registry_errors() {
    let dir = tempfile::tempdir().unwrap();
    let (m, _inbox) = manager();
    assert!(matches!(
        m.start("cobol", dir.path()),
        Err(Error::UnknownLanguage(_))
    ));
    assert!(matches!(
        m.start("missing", dir.path()),
        Err(Error::NotInstalled(_))
    ));
    let avail = m.availability();
    assert!(avail.iter().any(|a| a.language == "fake" && a.available));
    assert!(avail
        .iter()
        .any(|a| a.language == "missing" && !a.available));
    assert_eq!(
        m.spec_for("tsx").unwrap().command,
        "typescript-language-server"
    );
    assert_eq!(m.spec_for("rs").unwrap().command, "rust-analyzer");
    assert_eq!(m.spec_for("py").unwrap().command, "pyright-langserver");
    assert_eq!(m.spec_for("go").unwrap().command, "gopls");
    let err = serde_json::to_value(Error::NotFound(9)).unwrap();
    assert_eq!(err, json!("no language server with id 9"));
}

fn dropping_manager_kills_servers() {
    let dir = tempfile::tempdir().unwrap();
    let (m, _inbox) = manager();
    m.start("fake", dir.path()).unwrap();
    let pid = m.servers()[0].pid;
    drop(m);
    #[cfg(target_os = "linux")]
    wait_until("process gone", || {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        stat.is_empty() || stat.contains(") Z ")
    });
    let _ = pid;
}

fn main() {
    if std::env::args().any(|a| a == "--fake-lsp-server") {
        fake_server();
        return;
    }
    let filter = std::env::args().skip(1).find(|a| !a.starts_with('-'));
    let tests: &[(&str, fn())] = &[
        (
            "handshake_passthrough_and_auto_responses",
            handshake_passthrough_and_auto_responses,
        ),
        ("diagnostics_cache", diagnostics_cache),
        ("crash_is_reported", crash_is_reported),
        ("registry_errors", registry_errors),
        (
            "dropping_manager_kills_servers",
            dropping_manager_kills_servers,
        ),
    ];
    let mut ran = 0;
    for (name, f) in tests {
        if filter.as_deref().is_some_and(|flt| !name.contains(flt)) {
            continue;
        }
        print!("test {name} ... ");
        std::io::stdout().flush().unwrap();
        f();
        println!("ok");
        ran += 1;
    }
    println!("\ntest result: ok. {ran} passed; 0 failed");
}
