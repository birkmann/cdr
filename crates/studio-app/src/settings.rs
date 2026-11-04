//! Persistent app settings (recent repositories, clone folder, scheduler bookkeeping).
//! UI preferences such as theme and layout stay in the webview's local storage.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    pub opened_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub recent_repos: Vec<RecentRepo>,
    pub clone_dir: Option<String>,
    /// Provider key names the user stored in the keychain (values are never written here).
    pub provider_keys: Vec<String>,
    /// goalId → unix seconds of the last scheduled start.
    pub goal_last_scheduled: HashMap<String, i64>,
}

impl AppSettings {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }

    pub fn touch_recent(&mut self, path: &Path) {
        let p = path.to_string_lossy().to_string();
        self.recent_repos.retain(|r| r.path != p);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| p.clone());
        self.recent_repos.insert(
            0,
            RecentRepo {
                path: p,
                name,
                opened_at: chrono::Utc::now().timestamp(),
            },
        );
        self.recent_repos.truncate(30);
    }

    pub fn default_clone_dir(&self) -> PathBuf {
        self.clone_dir
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join("Projects")))
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_orders_recents() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let mut s = AppSettings::load(&file);
        s.touch_recent(Path::new("/a/one"));
        s.touch_recent(Path::new("/a/two"));
        s.touch_recent(Path::new("/a/one"));
        s.save(&file).unwrap();
        let loaded = AppSettings::load(&file);
        assert_eq!(
            loaded
                .recent_repos
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
    }
}
