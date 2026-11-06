//! Secret storage for CDR Studio: provider API keys, GitHub tokens and
//! the harness token.
//!
//! Secrets live in the OS credential store under the service name
//! [`SERVICE`] (macOS Keychain, Windows Credential Manager, or the Secret
//! Service on Linux/BSD) through the `keyring-core` ecosystem. When no
//! credential store is reachable (e.g. a Linux session without a Secret
//! Service daemon) a file-backed store is used instead: one JSON file with
//! `0600` permissions inside a caller-provided directory (`0700`).
//! [`KeyStore::backend`] tells which one is active.
//!
//! Credential stores cannot enumerate entries, so the *names* of stored
//! secrets (never values) are kept in a small index JSON file in the app's
//! config directory; [`KeyStore::list_known`] reads it.
//!
//! Set `CDR_KEYS_BACKEND=file` to force the file backend.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use keyring_core::CredentialStore;
use serde::{Deserialize, Serialize, Serializer};

/// Service name used for every keychain entry.
pub const SERVICE: &str = "cdr-studio";

const INDEX_FILE: &str = "keys-index.json";
const SECRETS_FILE: &str = "secrets.json";
const PROBE_NAME: &str = "__cdr_studio_probe__";

/// Errors of this crate; serializes as its message string.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("credential store error: {0}")]
    Store(String),
    #[error("invalid secret name {0:?}")]
    InvalidName(String),
    #[error("corrupt key file {path}: {message}", path = .0.display(), message = .1)]
    Corrupt(PathBuf, String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<keyring_core::Error> for Error {
    fn from(e: keyring_core::Error) -> Error {
        Error::Store(e.to_string())
    }
}

/// `Result` alias using [`Error`].
pub type Result<T> = std::result::Result<T, Error>;

/// Description of the active backend, for the settings UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    /// `"macos-keychain"`, `"windows-credential-manager"`, `"secret-service"`,
    /// `"file"` or the name given to [`KeyStore::with_store`].
    pub name: String,
    /// True for an OS credential store, false for the file fallback.
    pub secure: bool,
    /// Why the OS store is not used, when falling back to the file backend.
    pub fallback_reason: Option<String>,
}

enum Backend {
    Keychain(Arc<CredentialStore>),
    File(PathBuf),
}

/// Stores secrets by name. Safe to share between threads.
pub struct KeyStore {
    backend: Backend,
    info: BackendInfo,
    index_path: PathBuf,
    lock: Mutex<()>,
}

#[derive(Default, Serialize, Deserialize)]
struct Index {
    names: Vec<String>,
}

fn validate(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-:/@".contains(c));
    if ok && name != PROBE_NAME {
        Ok(())
    } else {
        Err(Error::InvalidName(name.to_string()))
    }
}

#[allow(unreachable_code)]
fn platform_store() -> std::result::Result<(Arc<CredentialStore>, &'static str), String> {
    #[cfg(target_os = "macos")]
    {
        let s = apple_native_keyring_store::keychain::Store::new().map_err(|e| e.to_string())?;
        return Ok((s, "macos-keychain"));
    }
    #[cfg(target_os = "windows")]
    {
        let s = windows_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
        return Ok((s, "windows-credential-manager"));
    }
    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "ios", target_os = "android"))
    ))]
    {
        let s = zbus_secret_service_keyring_store::Store::new().map_err(|e| e.to_string())?;
        return Ok((s, "secret-service"));
    }
    Err("no credential store on this platform".to_string())
}

/// Checks that the store actually answers (a locked or missing daemon fails here).
fn probe(store: &Arc<CredentialStore>) -> std::result::Result<(), String> {
    let entry = store
        .build(SERVICE, PROBE_NAME, None)
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(_) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

/// Atomically replaces `path` with `bytes`, creating the file with `mode`.
fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(mode);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    set_mode(&tmp, mode)?;
    fs::rename(&tmp, path)
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T> {
    match fs::read(path) {
        Ok(b) if b.iter().all(|c| c.is_ascii_whitespace()) => Ok(T::default()),
        Ok(b) => serde_json::from_slice(&b)
            .map_err(|e| Error::Corrupt(path.to_path_buf(), e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}

impl KeyStore {
    /// Opens the store: the OS credential store when it is reachable,
    /// otherwise the file backend in `fallback_dir`. The name index lives in
    /// `config_dir`.
    pub fn open(config_dir: impl AsRef<Path>, fallback_dir: impl AsRef<Path>) -> Result<KeyStore> {
        let forced_file = std::env::var("CDR_KEYS_BACKEND").is_ok_and(|v| v == "file");
        let reason = if forced_file {
            "CDR_KEYS_BACKEND=file".to_string()
        } else {
            match platform_store().and_then(|(s, name)| probe(&s).map(|_| (s, name))) {
                Ok((store, name)) => return Ok(Self::with_store(config_dir, store, name)),
                Err(e) => e,
            }
        };
        let mut ks = Self::with_file_backend(config_dir, fallback_dir)?;
        ks.info.fallback_reason = Some(reason);
        Ok(ks)
    }

    /// Uses the file backend in `dir` (created with `0700`; the secrets file
    /// is `0600`).
    pub fn with_file_backend(
        config_dir: impl AsRef<Path>,
        dir: impl AsRef<Path>,
    ) -> Result<KeyStore> {
        let dir = dir.as_ref();
        fs::create_dir_all(dir)?;
        set_mode(dir, 0o700)?;
        Ok(KeyStore {
            backend: Backend::File(dir.join(SECRETS_FILE)),
            info: BackendInfo {
                name: "file".into(),
                secure: false,
                fallback_reason: None,
            },
            index_path: config_dir.as_ref().join(INDEX_FILE),
            lock: Mutex::new(()),
        })
    }

    /// Uses a specific `keyring-core` credential store (e.g.
    /// `keyring_core::mock::Store::new()?` in tests), reported as `name`.
    pub fn with_store(
        config_dir: impl AsRef<Path>,
        store: Arc<CredentialStore>,
        name: &str,
    ) -> KeyStore {
        KeyStore {
            backend: Backend::Keychain(store),
            info: BackendInfo {
                name: name.to_string(),
                secure: true,
                fallback_reason: None,
            },
            index_path: config_dir.as_ref().join(INDEX_FILE),
            lock: Mutex::new(()),
        }
    }

    /// Name of the active backend (`"file"`, `"secret-service"`, ...).
    pub fn backend(&self) -> &str {
        &self.info.name
    }

    /// Details about the active backend.
    pub fn backend_info(&self) -> &BackendInfo {
        &self.info
    }

    /// Stores `value` under `name`, replacing any previous value.
    pub fn set(&self, name: &str, value: &str) -> Result<()> {
        validate(name)?;
        let _g = self.lock.lock().unwrap();
        match &self.backend {
            Backend::Keychain(store) => store.build(SERVICE, name, None)?.set_password(value)?,
            Backend::File(path) => {
                let mut map: BTreeMap<String, String> = read_json(path)?;
                map.insert(name.to_string(), value.to_string());
                write_atomic(path, &serde_json::to_vec_pretty(&map).unwrap(), 0o600)?;
            }
        }
        self.update_index(|names| {
            if !names.iter().any(|n| n == name) {
                names.push(name.to_string());
            }
        })
    }

    /// Returns the secret stored under `name`, if any.
    pub fn get(&self, name: &str) -> Result<Option<String>> {
        validate(name)?;
        let _g = self.lock.lock().unwrap();
        match &self.backend {
            Backend::Keychain(store) => match store.build(SERVICE, name, None)?.get_password() {
                Ok(v) => Ok(Some(v)),
                Err(keyring_core::Error::NoEntry) => Ok(None),
                Err(e) => Err(e.into()),
            },
            Backend::File(path) => {
                let map: BTreeMap<String, String> = read_json(path)?;
                Ok(map.get(name).cloned())
            }
        }
    }

    /// Deletes the secret `name`. Returns false when it did not exist.
    pub fn delete(&self, name: &str) -> Result<bool> {
        validate(name)?;
        let _g = self.lock.lock().unwrap();
        let existed = match &self.backend {
            Backend::Keychain(store) => {
                match store.build(SERVICE, name, None)?.delete_credential() {
                    Ok(()) => true,
                    Err(keyring_core::Error::NoEntry) => false,
                    Err(e) => return Err(e.into()),
                }
            }
            Backend::File(path) => {
                let mut map: BTreeMap<String, String> = read_json(path)?;
                let existed = map.remove(name).is_some();
                if existed {
                    write_atomic(path, &serde_json::to_vec_pretty(&map).unwrap(), 0o600)?;
                }
                existed
            }
        };
        self.update_index(|names| names.retain(|n| n != name))?;
        Ok(existed)
    }

    /// Names of stored secrets (sorted), from the non-secret index.
    pub fn list_known(&self) -> Result<Vec<String>> {
        let _g = self.lock.lock().unwrap();
        let mut idx: Index = read_json(&self.index_path)?;
        idx.names.sort();
        idx.names.dedup();
        Ok(idx.names)
    }

    /// Looks up several secrets at once, e.g. to build the sidecar's
    /// environment: `[("ANTHROPIC_API_KEY", "anthropic")]` returns the
    /// `(env var, value)` pairs that are set.
    pub fn env_pairs(&self, mapping: &[(&str, &str)]) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        for (var, name) in mapping {
            if let Some(v) = self.get(name)? {
                out.push((var.to_string(), v));
            }
        }
        Ok(out)
    }

    fn update_index(&self, f: impl FnOnce(&mut Vec<String>)) -> Result<()> {
        let mut idx: Index = read_json(&self.index_path)?;
        f(&mut idx.names);
        idx.names.sort();
        idx.names.dedup();
        write_atomic(
            &self.index_path,
            &serde_json::to_vec_pretty(&idx).unwrap(),
            0o644,
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names() {
        assert!(validate("anthropic").is_ok());
        assert!(validate("github:token@user").is_ok());
        assert!(validate("").is_err());
        assert!(validate("has space").is_err());
        assert!(validate(PROBE_NAME).is_err());
        assert!(validate(&"x".repeat(129)).is_err());
    }
}
