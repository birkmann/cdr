//! Environment for the processes CDR Studio starts (Node, git, terminals, language servers).
//!
//! The Linux AppImage runs the app with `APPDIR` set and points `LD_LIBRARY_PATH`, `PATH`,
//! `XDG_DATA_DIRS`, GTK and GIO variables into its own mount. The app needs them, but programs
//! from the user's system do not: they would load the bundle's older libraries and fail, e.g.
//! `/usr/bin/node: …/usr/lib/libffi.so.8: version 'LIBFFI_CALL_PLAN_8.4' not found`.
//! [`host_env`] lists how to undo that for a child process; outside an AppImage it is empty.

use std::ffi::OsString;
use std::path::Path;

/// Variables the AppImage runtime adds for itself; children never need them.
const APPIMAGE_ONLY: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "APPIMAGE_SILENT_INSTALL"];

/// Changes for a child's environment: `(name, Some(value))` to set, `(name, None)` to remove.
pub fn host_env() -> Vec<(OsString, Option<OsString>)> {
    match std::env::var_os("APPDIR") {
        Some(appdir) if !appdir.is_empty() => changes(Path::new(&appdir), std::env::vars_os()),
        _ => Vec::new(),
    }
}

/// Applies [`host_env`] to a standard command.
pub fn apply(cmd: &mut std::process::Command) {
    for (name, value) in host_env() {
        match value {
            Some(v) => cmd.env(name, v),
            None => cmd.env_remove(name),
        };
    }
}

fn changes(
    appdir: &Path,
    vars: impl Iterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, Option<OsString>)> {
    let mut out = Vec::new();
    for (name, value) in vars {
        if APPIMAGE_ONLY.iter().any(|n| name == *n) {
            out.push((name, None));
            continue;
        }
        let entries: Vec<_> = std::env::split_paths(&value).collect();
        if !entries.iter().any(|p| p.starts_with(appdir)) {
            continue;
        }
        let kept: Vec<_> = entries
            .into_iter()
            .filter(|p| !p.starts_with(appdir) && !p.as_os_str().is_empty())
            .collect();
        if kept.is_empty() {
            out.push((name, None));
        } else {
            out.push((name, std::env::join_paths(kept).ok()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(vars: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
        let vars = vars
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)));
        changes(Path::new("/tmp/.mount_CDR-x"), vars)
            .into_iter()
            .map(|(k, v)| {
                (
                    k.into_string().unwrap(),
                    v.map(|v| v.into_string().unwrap()),
                )
            })
            .collect()
    }

    #[test]
    fn drops_bundle_paths_and_keeps_the_users() {
        let got = run(&[
            (
                "LD_LIBRARY_PATH",
                "/tmp/.mount_CDR-x/usr/lib:/tmp/.mount_CDR-x/usr/lib64",
            ),
            ("PATH", "/tmp/.mount_CDR-x/usr/bin:/usr/local/bin:/usr/bin"),
            ("XDG_DATA_DIRS", "/tmp/.mount_CDR-x/usr/share:/usr/share"),
            ("HOME", "/home/u"),
            ("APPDIR", "/tmp/.mount_CDR-x"),
            ("APPIMAGE", "/home/u/CDR.AppImage"),
        ]);
        assert_eq!(
            got,
            vec![
                ("LD_LIBRARY_PATH".into(), None),
                ("PATH".into(), Some("/usr/local/bin:/usr/bin".into())),
                ("XDG_DATA_DIRS".into(), Some("/usr/share".into())),
                ("APPDIR".into(), None),
                ("APPIMAGE".into(), None),
            ]
        );
    }

    #[test]
    fn keeps_a_users_own_library_path() {
        let got = run(&[(
            "LD_LIBRARY_PATH",
            "/tmp/.mount_CDR-x/usr/lib:/opt/cuda/lib64",
        )]);
        assert_eq!(
            got,
            vec![("LD_LIBRARY_PATH".into(), Some("/opt/cuda/lib64".into()))]
        );
    }

    #[test]
    fn leaves_similar_prefixes_alone() {
        assert!(run(&[("PATH", "/tmp/.mount_CDR-xyz/bin:/usr/bin")]).is_empty());
    }
}
