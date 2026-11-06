//! GitHub REST access for cloning, pull requests and sign-in.
//! The token lives in the OS keychain; it is used here and for git over HTTPS, never sent to agents.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const API: &str = "https://api.github.com";

#[derive(Debug, thiserror::Error)]
pub enum GithubError {
    #[error("GitHub request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("GitHub returned {status}: {message}")]
    Api { status: u16, message: String },
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
    pub full_name: String,
    pub description: Option<String>,
    pub private: bool,
    pub clone_url: String,
    pub ssh_url: String,
    pub default_branch: String,
    pub updated_at: String,
    pub stars: u64,
    pub fork: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub head: String,
    pub base: String,
    pub author: String,
    pub updated_at: String,
    /// success | failure | pending | none
    pub checks: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

pub struct Github {
    http: reqwest::Client,
    api: String,
}

impl Default for Github {
    fn default() -> Self {
        Self::new(API)
    }
}

impl Github {
    pub fn new(api: &str) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("CDRStudio/0.1")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("http client");
        Self {
            http,
            api: api.trim_end_matches('/').to_string(),
        }
    }

    async fn get(&self, token: &str, path: &str) -> Result<Value, GithubError> {
        let res = self
            .http
            .get(format!("{}{}", self.api, path))
            .bearer_auth(token)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .send()
            .await?;
        Self::json(res).await
    }

    async fn json(res: reqwest::Response) -> Result<Value, GithubError> {
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let message = body
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("request failed")
                .to_string();
            let detail = body
                .get("errors")
                .and_then(|e| e.as_array())
                .map(|errs| {
                    errs.iter()
                        .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .filter(|s| !s.is_empty());
            return Err(GithubError::Api {
                status: status.as_u16(),
                message: detail.map(|d| format!("{message}: {d}")).unwrap_or(message),
            });
        }
        Ok(body)
    }

    pub async fn user(&self, token: &str) -> Result<GithubUser, GithubError> {
        let v = self.get(token, "/user").await?;
        Ok(GithubUser {
            login: s(&v, "login"),
            name: v.get("name").and_then(|n| n.as_str()).map(String::from),
            avatar_url: v
                .get("avatar_url")
                .and_then(|n| n.as_str())
                .map(String::from),
        })
    }

    pub async fn repos(&self, token: &str, page: u32) -> Result<Vec<GithubRepo>, GithubError> {
        let v = self
            .get(token, &format!("/user/repos?sort=updated&per_page=100&page={page}&affiliation=owner,collaborator,organization_member"))
            .await?;
        Ok(v.as_array()
            .map(|a| a.iter().map(repo_from).collect())
            .unwrap_or_default())
    }

    pub async fn search_repos(
        &self,
        token: &str,
        query: &str,
    ) -> Result<Vec<GithubRepo>, GithubError> {
        let q = urlencode(query);
        let v = self
            .get(token, &format!("/search/repositories?q={q}&per_page=30"))
            .await?;
        Ok(v.get("items")
            .and_then(|i| i.as_array())
            .map(|a| a.iter().map(repo_from).collect())
            .unwrap_or_default())
    }

    pub async fn pulls(
        &self,
        token: &str,
        owner: &str,
        repo: &str,
    ) -> Result<Vec<PullRequest>, GithubError> {
        let v = self
            .get(
                token,
                &format!("/repos/{owner}/{repo}/pulls?state=open&per_page=50"),
            )
            .await?;
        let mut out = Vec::new();
        for p in v.as_array().cloned().unwrap_or_default() {
            let sha = p
                .pointer("/head/sha")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string();
            let checks = if sha.is_empty() {
                "none".to_string()
            } else {
                match self
                    .get(
                        token,
                        &format!("/repos/{owner}/{repo}/commits/{sha}/status"),
                    )
                    .await
                {
                    Ok(st) if st.get("total_count").and_then(|c| c.as_u64()) == Some(0) => {
                        "none".into()
                    }
                    Ok(st) => s(&st, "state"),
                    Err(_) => "none".into(),
                }
            };
            out.push(PullRequest {
                number: p.get("number").and_then(|n| n.as_u64()).unwrap_or(0),
                title: s(&p, "title"),
                url: s(&p, "html_url"),
                state: s(&p, "state"),
                draft: p.get("draft").and_then(|d| d.as_bool()).unwrap_or(false),
                head: p
                    .pointer("/head/ref")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .into(),
                base: p
                    .pointer("/base/ref")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .into(),
                author: p
                    .pointer("/user/login")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .into(),
                updated_at: s(&p, "updated_at"),
                checks,
            });
        }
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_pull(
        &self,
        token: &str,
        owner: &str,
        repo: &str,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> Result<PullRequest, GithubError> {
        let res = self
            .http
            .post(format!("{}/repos/{owner}/{repo}/pulls", self.api))
            .bearer_auth(token)
            .header("accept", "application/vnd.github+json")
            .json(&json!({ "title": title, "head": head, "base": base, "body": body, "draft": draft }))
            .send()
            .await?;
        let p = Self::json(res).await?;
        Ok(PullRequest {
            number: p.get("number").and_then(|n| n.as_u64()).unwrap_or(0),
            title: s(&p, "title"),
            url: s(&p, "html_url"),
            state: s(&p, "state"),
            draft,
            head: head.into(),
            base: base.into(),
            author: p
                .pointer("/user/login")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .into(),
            updated_at: s(&p, "updated_at"),
            checks: "none".into(),
        })
    }

    /// Create an empty repository on the signed-in account (no README, so a local branch pushes cleanly).
    pub async fn create_repo(
        &self,
        token: &str,
        name: &str,
        description: &str,
        private: bool,
    ) -> Result<GithubRepo, GithubError> {
        let res = self
            .http
            .post(format!("{}/user/repos", self.api))
            .bearer_auth(token)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .json(&json!({
                "name": name,
                "description": description,
                "private": private,
                "auto_init": false,
            }))
            .send()
            .await?;
        Ok(repo_from(&Self::json(res).await?))
    }

    /// OAuth device flow (needs an OAuth app client id: CDR_GITHUB_CLIENT_ID).
    pub async fn device_start(&self, client_id: &str) -> Result<DeviceCode, GithubError> {
        let res = self
            .http
            .post("https://github.com/login/device/code")
            .header("accept", "application/json")
            .form(&[("client_id", client_id), ("scope", "repo read:org")])
            .send()
            .await?;
        let v = Self::json(res).await?;
        if let Some(err) = v.get("error_description").and_then(|e| e.as_str()) {
            return Err(GithubError::Other(err.into()));
        }
        Ok(DeviceCode {
            device_code: s(&v, "device_code"),
            user_code: s(&v, "user_code"),
            verification_uri: s(&v, "verification_uri"),
            interval: v.get("interval").and_then(|i| i.as_u64()).unwrap_or(5),
            expires_in: v.get("expires_in").and_then(|i| i.as_u64()).unwrap_or(900),
        })
    }

    /// Returns Ok(Some(token)) when authorised, Ok(None) while pending.
    pub async fn device_poll(
        &self,
        client_id: &str,
        device_code: &str,
    ) -> Result<Option<String>, GithubError> {
        let res = self
            .http
            .post("https://github.com/login/oauth/access_token")
            .header("accept", "application/json")
            .form(&[
                ("client_id", client_id),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await?;
        let v = Self::json(res).await?;
        if let Some(t) = v.get("access_token").and_then(|t| t.as_str()) {
            return Ok(Some(t.to_string()));
        }
        match v.get("error").and_then(|e| e.as_str()) {
            Some("authorization_pending") | Some("slow_down") => Ok(None),
            Some(e) => Err(GithubError::Other(
                v.get("error_description")
                    .and_then(|d| d.as_str())
                    .unwrap_or(e)
                    .to_string(),
            )),
            None => Ok(None),
        }
    }
}

fn s(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string()
}

fn repo_from(v: &Value) -> GithubRepo {
    GithubRepo {
        full_name: s(v, "full_name"),
        description: v
            .get("description")
            .and_then(|d| d.as_str())
            .map(String::from),
        private: v.get("private").and_then(|p| p.as_bool()).unwrap_or(false),
        clone_url: s(v, "clone_url"),
        ssh_url: s(v, "ssh_url"),
        default_branch: s(v, "default_branch"),
        updated_at: s(v, "updated_at"),
        stars: v
            .get("stargazers_count")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        fork: v.get("fork").and_then(|x| x.as_bool()).unwrap_or(false),
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Token from the GitHub CLI, if it is installed and signed in.
pub fn gh_cli_token() -> Option<String> {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(["auth", "token"]);
    studio_env::apply(&mut cmd);
    let out = cmd.output().ok()?;
    let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !t.is_empty()).then_some(t)
}

/// Git config (key, value) that authenticates HTTPS requests to github.com with the token.
/// Passed to git through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, never on a command line.
pub fn git_auth_pairs(token: &str) -> Vec<(String, String)> {
    use base64::Engine;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    vec![(
        "http.https://github.com/.extraheader".into(),
        format!("AUTHORIZATION: basic {basic}"),
    )]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_queries() {
        assert_eq!(urlencode("rust lang/x"), "rust%20lang%2Fx");
    }

    #[test]
    fn auth_config_uses_basic_header() {
        let pairs = git_auth_pairs("abc");
        assert_eq!(pairs[0].0, "http.https://github.com/.extraheader");
        assert!(pairs[0].1.starts_with("AUTHORIZATION: basic "));
        assert!(!pairs[0].1.contains("abc"));
    }

    /// Minimal local HTTP server returning a fixed JSON body (no network).
    async fn serve_once(status: u16, body: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn reads_user_and_reports_errors() {
        let api = serve_once(
            200,
            r#"{"login":"octo","name":"Octo Cat","avatar_url":null}"#,
        )
        .await;
        let u = Github::new(&api).user("t").await.unwrap();
        assert_eq!(u.login, "octo");
        let api = serve_once(401, r#"{"message":"Bad credentials"}"#).await;
        let e = Github::new(&api).user("t").await.unwrap_err();
        assert!(e.to_string().contains("401") && e.to_string().contains("Bad credentials"));
    }

    #[tokio::test]
    async fn creates_repositories_and_reports_name_clashes() {
        let api = serve_once(
            201,
            r#"{"full_name":"octo/snake","private":true,"clone_url":"https://github.com/octo/snake.git","ssh_url":"git@github.com:octo/snake.git","default_branch":"main","updated_at":"2026-11-06T12:00:00Z","stargazers_count":0,"fork":false}"#,
        )
        .await;
        let r = Github::new(&api)
            .create_repo("t", "snake", "", true)
            .await
            .unwrap();
        assert_eq!(r.full_name, "octo/snake");
        assert!(r.private);
        assert_eq!(r.clone_url, "https://github.com/octo/snake.git");
        let api = serve_once(
            422,
            r#"{"message":"Repository creation failed.","errors":[{"message":"name already exists on this account"}]}"#,
        )
        .await;
        let e = Github::new(&api)
            .create_repo("t", "snake", "", true)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("name already exists"));
    }
}
