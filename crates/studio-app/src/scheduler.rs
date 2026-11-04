//! Starts scheduled goals and notifies about goal outcomes.
//! The harness owns what a goal does; this only decides when to start it (plan section 5.4).

use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::sidecar::{HarnessState, Sidecar};
use crate::AppState;

/// Convert a standard 5-field cron line (Sunday = 0) to the `cron` crate format
/// (seconds field first, Sunday = 1).
pub fn to_cron_crate(expr: &str) -> Option<String> {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return None;
    }
    let dow = parts[4]
        .split(',')
        .map(|item| {
            let (range, step) = match item.split_once('/') {
                Some((r, s)) => (r, Some(s)),
                None => (item, None),
            };
            let conv = |t: &str| -> String {
                match t.parse::<u32>() {
                    Ok(n) => ((n % 7) + 1).to_string(),
                    Err(_) => t.to_string(),
                }
            };
            let range = match range.split_once('-') {
                Some((a, b)) => format!(
                    "{}-{}",
                    conv(a),
                    if b == "7" { "7".to_string() } else { conv(b) }
                ),
                None => conv(range),
            };
            match step {
                Some(s) => format!("{range}/{s}"),
                None => range,
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    Some(format!(
        "0 {} {} {} {} {}",
        parts[0], parts[1], parts[2], parts[3], dow
    ))
}

/// Next run strictly after `after` for a 5-field cron expression.
pub fn next_cron(expr: &str, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let schedule = cron::Schedule::from_str(&to_cron_crate(expr)?).ok()?;
    schedule.after(&after).next()
}

/// Goals whose schedule says they should start now.
pub fn due_goals(goals: &[Value], now: DateTime<Utc>, last: &HashMap<String, i64>) -> Vec<String> {
    let mut due = Vec::new();
    for g in goals {
        let Some(id) = g.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let status = g.get("status").and_then(|v| v.as_str()).unwrap_or("draft");
        if matches!(status, "running" | "discarded" | "done") {
            continue;
        }
        let Some(schedule) = g.get("schedule").filter(|s| !s.is_null()) else {
            continue;
        };
        let last_run = last.get(id).copied();
        if let Some(at) = schedule.get("at").and_then(|v| v.as_str()) {
            let Ok(at) = DateTime::parse_from_rfc3339(at) else {
                continue;
            };
            let at = at.with_timezone(&Utc);
            if at <= now
                && last_run.is_none_or(|l| l < at.timestamp())
                && matches!(status, "draft" | "scheduled")
            {
                due.push(id.to_string());
            }
        } else if let Some(expr) = schedule.get("cron").and_then(|v| v.as_str()) {
            let base = last_run
                .and_then(|l| Utc.timestamp_opt(l, 0).single())
                .or_else(|| {
                    g.get("createdAt")
                        .or_else(|| g.get("updatedAt"))
                        .and_then(|v| v.as_str())
                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.with_timezone(&Utc))
                })
                .unwrap_or(now - chrono::Duration::minutes(1));
            if let Some(next) = next_cron(expr, base) {
                if next <= now {
                    due.push(id.to_string());
                }
            }
        }
    }
    due
}

pub fn spawn(app: AppHandle, sidecar: Sidecar) {
    tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::new();
        let mut seen: HashMap<String, String> = HashMap::new();
        let mut first = true;
        loop {
            tokio::time::sleep(Duration::from_secs(if first { 3 } else { 20 })).await;
            let st = sidecar.status().await;
            if !matches!(st.state, HarnessState::Ready | HarnessState::Attached) {
                continue;
            }
            let (Some(url), Some(token)) = (st.url, st.token) else {
                continue;
            };
            let Ok(res) = http
                .get(format!("{url}/goals"))
                .bearer_auth(&token)
                .send()
                .await
            else {
                continue;
            };
            if !res.status().is_success() {
                continue;
            }
            let body: Value = res.json().await.unwrap_or(Value::Null);
            let goals = body
                .get("goals")
                .and_then(|g| g.as_array())
                .cloned()
                .or_else(|| body.as_array().cloned())
                .unwrap_or_default();

            // Outcome notifications on status transitions (not for the initial snapshot).
            for g in &goals {
                let (Some(id), Some(status)) = (
                    g.get("id").and_then(|v| v.as_str()),
                    g.get("status").and_then(|v| v.as_str()),
                ) else {
                    continue;
                };
                let prev = seen.insert(id.to_string(), status.to_string());
                if first || prev.as_deref() == Some(status) {
                    continue;
                }
                let title = g.get("title").and_then(|v| v.as_str()).unwrap_or("Goal");
                let msg = match status {
                    "review" => Some("is ready for review"),
                    "needs-attention" => Some("needs your attention"),
                    "failed" => Some("failed"),
                    _ => None,
                };
                if let Some(msg) = msg {
                    let _ = app
                        .notification()
                        .builder()
                        .title("CDR Studio")
                        .body(format!("{title} {msg}"))
                        .show();
                }
                let _ = app.emit("goals://changed", id);
            }
            first = false;

            let state = app.state::<AppState>();
            let last = state.settings.lock().await.goal_last_scheduled.clone();
            let now = Utc::now();
            for id in due_goals(&goals, now, &last) {
                let ok = http
                    .post(format!("{url}/goals/{id}/run"))
                    .bearer_auth(&token)
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(false);
                let mut s = state.settings.lock().await;
                s.goal_last_scheduled.insert(id.clone(), now.timestamp());
                let _ = s.save(&state.settings_path);
                drop(s);
                if ok {
                    let _ = app.emit("goals://changed", &id);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_weekdays() {
        assert_eq!(to_cron_crate("0 2 * * 1-5").unwrap(), "0 0 2 * * 2-6");
        assert_eq!(to_cron_crate("30 9 * * 0,6").unwrap(), "0 30 9 * * 1,7");
        assert_eq!(to_cron_crate("0 2 * * *").unwrap(), "0 0 2 * * *");
        assert!(to_cron_crate("bad").is_none());
    }

    #[test]
    fn next_weekday_run() {
        // 2026-11-07 is a Saturday; the next weekday 02:00 is Monday 2026-11-09.
        let sat = Utc.with_ymd_and_hms(2026, 11, 7, 12, 0, 0).unwrap();
        let next = next_cron("0 2 * * 1-5", sat).unwrap();
        assert_eq!(next, Utc.with_ymd_and_hms(2026, 11, 9, 2, 0, 0).unwrap());
    }

    #[test]
    fn finds_due_goals() {
        let now = Utc.with_ymd_and_hms(2026, 11, 9, 2, 0, 30).unwrap();
        let goals = vec![
            json!({"id":"a","status":"scheduled","schedule":{"at":"2026-11-09T01:00:00Z"}}),
            json!({"id":"b","status":"scheduled","schedule":{"at":"2026-11-10T01:00:00Z"}}),
            json!({"id":"c","status":"review","schedule":{"cron":"0 2 * * 1-5"},"createdAt":"2026-11-08T00:00:00Z"}),
            json!({"id":"d","status":"running","schedule":{"cron":"* * * * *"}}),
            json!({"id":"e","status":"draft","schedule":null}),
        ];
        let mut last = HashMap::new();
        assert_eq!(due_goals(&goals, now, &last), ["a", "c"]);
        last.insert("a".to_string(), now.timestamp());
        last.insert("c".to_string(), now.timestamp());
        assert!(due_goals(&goals, now, &last).is_empty());
    }
}
