//! Parsing of git `--progress` output.

use serde::Serialize;

/// One progress update from a long-running git command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Phase name such as `"Receiving objects"`; empty for plain messages.
    pub phase: String,
    /// Percentage of the current phase, when git reported one.
    pub percent: Option<u8>,
    /// Items done in this phase, when reported (`450` in `45% (450/1000)`).
    pub current: Option<u64>,
    /// Total items in this phase, when reported.
    pub total: Option<u64>,
    /// The full stderr line (without `remote: ` prefix).
    pub message: String,
}

/// Parses one stderr line (split on `\r` / `\n`) into a [`Progress`].
pub fn parse_progress(line: &str) -> Progress {
    let text = line.trim();
    let text = text.strip_prefix("remote:").map(str::trim).unwrap_or(text);
    let mut p = Progress {
        phase: String::new(),
        percent: None,
        current: None,
        total: None,
        message: text.to_string(),
    };
    let Some((phase, rest)) = text.split_once(':') else {
        return p;
    };
    let rest = rest.trim_start();
    let Some(pct_end) = rest.find('%') else {
        // e.g. "Enumerating objects: 5, done."
        let first = rest
            .split(|c: char| c == ',' || c.is_whitespace())
            .next()
            .unwrap_or("");
        if let Ok(n) = first.parse::<u64>() {
            p.phase = phase.trim().to_string();
            p.current = Some(n);
        }
        return p;
    };
    let Ok(percent) = rest[..pct_end].trim().parse::<u32>() else {
        return p;
    };
    p.phase = phase.trim().to_string();
    p.percent = Some(percent.min(100) as u8);
    let after = &rest[pct_end + 1..];
    if let (Some(open), Some(close)) = (after.find('('), after.find(')')) {
        if open < close {
            if let Some((a, b)) = after[open + 1..close].split_once('/') {
                p.current = a.trim().parse().ok();
                p.total = b.trim().parse().ok();
            }
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_percent_lines() {
        let p = parse_progress("Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s");
        assert_eq!(p.phase, "Receiving objects");
        assert_eq!(p.percent, Some(45));
        assert_eq!(p.current, Some(450));
        assert_eq!(p.total, Some(1000));

        let p = parse_progress("remote: Counting objects: 100% (3/3), done.");
        assert_eq!(p.phase, "Counting objects");
        assert_eq!(p.percent, Some(100));
        assert_eq!(p.message, "Counting objects: 100% (3/3), done.");
    }

    #[test]
    fn parses_counts_and_messages() {
        let p = parse_progress("remote: Enumerating objects: 5, done.");
        assert_eq!(p.phase, "Enumerating objects");
        assert_eq!(p.percent, None);
        assert_eq!(p.current, Some(5));

        let p = parse_progress("Cloning into 'x'...");
        assert_eq!(p.phase, "");
        assert_eq!(p.percent, None);
        assert_eq!(p.message, "Cloning into 'x'...");

        let p = parse_progress("fatal: repository 'x' does not exist");
        assert_eq!(p.phase, "");
        assert_eq!(p.percent, None);
    }
}
