#![cfg(unix)]

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use studio_pty::{PtyId, PtyManager, SpawnOptions};

struct Session {
    id: PtyId,
    out: Arc<Mutex<Vec<u8>>>,
    exit: mpsc::Receiver<Option<i32>>,
}

impl Session {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.out.lock().unwrap()).into_owned()
    }
    fn wait_for(&self, needle: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if self.text().contains(needle) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

fn start(m: &PtyManager, shell: &str, args: &[&str]) -> Session {
    let out = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel();
    let sink = Arc::clone(&out);
    let opts = SpawnOptions {
        shell: Some(shell.into()),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: vec![("STUDIO_PTY_TEST".into(), "yes".into())],
        env_remove: vec!["SECRET_TEST_KEY".into()],
        ..SpawnOptions::new(std::env::temp_dir())
    };
    let id = m
        .spawn(
            opts,
            move |_, bytes| sink.lock().unwrap().extend_from_slice(&bytes),
            move |_, code| {
                let _ = tx.send(code);
            },
        )
        .unwrap();
    Session { id, out, exit: rx }
}

#[test]
fn echo_output_and_exit_code() {
    let m = PtyManager::new();
    let s = start(
        &m,
        "/bin/sh",
        &["-c", "echo hi; echo $STUDIO_PTY_TEST; exit 3"],
    );
    let code = s.exit.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(code, Some(3));
    let text = s.text();
    assert!(text.contains("hi"), "{text:?}");
    assert!(text.contains("yes"), "{text:?}");
    assert!(m.list().is_empty());
    assert!(m.write(s.id, b"x").is_err());
}

#[test]
fn write_input_to_cat() {
    let m = PtyManager::new();
    let s = start(&m, "cat", &[]);
    assert_eq!(m.list().len(), 1);
    assert_eq!(m.list()[0].id, s.id);
    assert!(m.list()[0].pid.is_some());
    m.write(s.id, b"hello pty\n").unwrap();
    assert!(s.wait_for("hello pty"), "{:?}", s.text());
    // Ctrl-D ends cat.
    m.write(s.id, &[4]).unwrap();
    assert_eq!(
        s.exit.recv_timeout(Duration::from_secs(10)).unwrap(),
        Some(0)
    );
}

#[test]
fn resize_is_visible_to_the_program() {
    let m = PtyManager::new();
    let s = start(&m, "/bin/sh", &["-c", "read x; stty size"]);
    m.resize(s.id, 101, 37).unwrap();
    assert_eq!((m.list()[0].cols, m.list()[0].rows), (101, 37));
    m.write(s.id, b"\n").unwrap();
    assert!(s.wait_for("37 101"), "{:?}", s.text());
    s.exit.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(m.resize(s.id, 10, 10).is_err());
}

#[test]
fn kill_reports_exit() {
    let m = PtyManager::new();
    let s = start(&m, "sleep", &["30"]);
    m.kill(s.id).unwrap();
    let code = s.exit.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_ne!(code, Some(0));
    assert!(m.list().is_empty());
    assert!(m.kill(s.id).is_err());
}

#[test]
fn default_shell_starts() {
    let m = PtyManager::new();
    let out = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel();
    let sink = Arc::clone(&out);
    let opts = SpawnOptions {
        shell: Some("/bin/sh".into()),
        ..SpawnOptions::new(std::env::temp_dir())
    };
    let id = m
        .spawn(
            opts,
            move |_, b| sink.lock().unwrap().extend_from_slice(&b),
            move |_, c| {
                let _ = tx.send(c);
            },
        )
        .unwrap();
    m.write(id, b"echo interactive-$((1+2))\nexit\n").unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap(), Some(0));
    assert!(String::from_utf8_lossy(&out.lock().unwrap()).contains("interactive-3"));
    assert!(!studio_pty::default_shell().is_empty());
}

#[test]
fn options_deserialize_with_defaults() {
    let o: SpawnOptions = serde_json::from_str(r#"{"cwd":"/tmp","envRemove":["A"]}"#).unwrap();
    assert_eq!((o.cols, o.rows), (80, 24));
    assert_eq!(o.env_remove, vec!["A".to_string()]);
}
