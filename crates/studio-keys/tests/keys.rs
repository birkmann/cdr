use studio_keys::{Error, KeyStore};

fn roundtrip(ks: &KeyStore) {
    assert_eq!(ks.get("anthropic").unwrap(), None);
    ks.set("anthropic", "sk-ant-123").unwrap();
    ks.set("github", "gho_abc").unwrap();
    assert_eq!(ks.get("anthropic").unwrap().as_deref(), Some("sk-ant-123"));
    ks.set("anthropic", "sk-ant-456").unwrap();
    assert_eq!(ks.get("anthropic").unwrap().as_deref(), Some("sk-ant-456"));
    assert_eq!(ks.list_known().unwrap(), vec!["anthropic", "github"]);
    assert_eq!(
        ks.env_pairs(&[
            ("ANTHROPIC_API_KEY", "anthropic"),
            ("OPENAI_API_KEY", "openai")
        ])
        .unwrap(),
        vec![("ANTHROPIC_API_KEY".to_string(), "sk-ant-456".to_string())]
    );
    assert!(ks.delete("anthropic").unwrap());
    assert!(!ks.delete("anthropic").unwrap());
    assert_eq!(ks.get("anthropic").unwrap(), None);
    assert_eq!(ks.list_known().unwrap(), vec!["github"]);
    assert!(matches!(
        ks.set("bad name", "x"),
        Err(Error::InvalidName(_))
    ));
}

#[test]
fn file_backend_roundtrip_and_permissions() {
    let cfg = tempfile::tempdir().unwrap();
    let secrets = tempfile::tempdir().unwrap();
    let dir = secrets.path().join("keys");
    let ks = KeyStore::with_file_backend(cfg.path(), &dir).unwrap();
    assert_eq!(ks.backend(), "file");
    assert!(!ks.backend_info().secure);
    roundtrip(&ks);

    // Persists across instances.
    let again = KeyStore::with_file_backend(cfg.path(), &dir).unwrap();
    assert_eq!(again.get("github").unwrap().as_deref(), Some("gho_abc"));

    // The index never contains values.
    let index = std::fs::read_to_string(cfg.path().join("keys-index.json")).unwrap();
    assert!(index.contains("github") && !index.contains("gho_abc"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("secrets.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}

#[test]
fn keyring_mock_store_roundtrip() {
    let cfg = tempfile::tempdir().unwrap();
    let store = keyring_core::mock::Store::new().unwrap();
    let ks = KeyStore::with_store(cfg.path(), store, "mock");
    assert_eq!(ks.backend(), "mock");
    assert!(ks.backend_info().secure);
    roundtrip(&ks);
}

#[test]
fn forced_file_backend_via_env() {
    let cfg = tempfile::tempdir().unwrap();
    let fb = tempfile::tempdir().unwrap();
    // SAFETY: only this test touches this variable.
    unsafe { std::env::set_var("CDR_KEYS_BACKEND", "file") };
    let ks = KeyStore::open(cfg.path(), fb.path()).unwrap();
    unsafe { std::env::remove_var("CDR_KEYS_BACKEND") };
    assert_eq!(ks.backend(), "file");
    assert!(ks.backend_info().fallback_reason.is_some());
    ks.set("x", "y").unwrap();
    assert_eq!(ks.get("x").unwrap().as_deref(), Some("y"));
    let json = serde_json::to_value(ks.backend_info()).unwrap();
    assert_eq!(json["name"], "file");
    assert!(json.get("fallbackReason").is_some());
}

#[test]
fn errors_serialize_as_strings() {
    let e = Error::InvalidName("a b".into());
    assert_eq!(
        serde_json::to_value(&e).unwrap(),
        serde_json::json!("invalid secret name \"a b\"")
    );
}
