use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

pub const COGNITIVE_PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CognitiveState {
    pub version: u32,
    pub name: String,
    pub address: String,
    #[serde(default)]
    pub preset: String,
    #[serde(default)]
    pub personality: BTreeMap<String, String>,
    pub paused: bool,
    pub emotion: String,
    pub attention: String,
    pub bond: f64,
    pub needs: BTreeMap<String, f64>,
    pub memory_count: u64,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CognitiveTurnContext {
    pub version: u32,
    pub state_summary: String,
    pub memories: Vec<String>,
    pub personality: BTreeMap<String, String>,
    pub relationship: String,
    #[serde(default)]
    pub life_name: String,
    #[serde(default)]
    pub user_address: String,
    #[serde(default)]
    pub personality_label: String,
    #[serde(default)]
    pub personality_instruction: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CognitiveExport {
    pub version: u32,
    pub path: PathBuf,
    pub sha256: String,
}

#[async_trait]
pub trait CognitiveRuntime: Send + Sync {
    async fn bootstrap(
        &self,
        profile_id: &str,
        name: &str,
        address: &str,
        preset: &str,
    ) -> Result<CognitiveState>;
    async fn configure(
        &self,
        profile_id: &str,
        name: &str,
        address: &str,
        preset: &str,
    ) -> Result<CognitiveState>;
    async fn before_turn(&self, profile_id: &str, user_text: &str) -> Result<CognitiveTurnContext>;
    async fn after_turn(
        &self,
        profile_id: &str,
        user_text: &str,
        assistant_text: &str,
        shared_memory_count: Option<u64>,
    ) -> Result<CognitiveState>;
    async fn get_state(&self, profile_id: &str) -> Result<CognitiveState>;
    async fn recall_memory(
        &self,
        profile_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<String>>;
    async fn personality(&self, profile_id: &str) -> Result<BTreeMap<String, String>>;
    async fn bond(&self, profile_id: &str) -> Result<f64>;
    async fn pause(&self, profile_id: &str, paused: bool) -> Result<CognitiveState>;
    async fn snapshot(&self, profile_id: &str) -> Result<PathBuf>;
    async fn export(&self, profile_id: &str, destination: &Path) -> Result<CognitiveExport>;
    async fn reset(&self, profile_id: &str) -> Result<CognitiveState>;
    async fn delete(&self, profile_id: &str) -> Result<()>;
}

struct StdioConnection {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

#[derive(Clone)]
pub struct StdioCognitiveRuntime {
    token: String,
    connection: Arc<Mutex<StdioConnection>>,
}

impl StdioCognitiveRuntime {
    pub async fn spawn(
        python: &Path,
        sidecar: &Path,
        state_root: &Path,
        token: impl Into<String>,
    ) -> Result<Self> {
        let token = token.into();
        tokio::fs::create_dir_all(state_root).await?;
        let mut command = Command::new(python);
        command
            .arg(sidecar)
            .arg("--stdio")
            .arg("--state-root")
            .arg(state_root)
            .env_clear()
            .env("COOMI_LIFE_TOKEN", &token)
            .env("HOME", state_root)
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("LANG", "C.UTF-8");
        Self::spawn_command(command, token).await
    }

    pub async fn spawn_command(mut command: Command, token: impl Into<String>) -> Result<Self> {
        let token = token.into();
        anyhow::ensure!(token.len() >= 32, "cognitive sidecar token is too short");
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("failed to start cognitive sidecar")?;
        let stdin = child
            .stdin
            .take()
            .context("cognitive sidecar has no stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("cognitive sidecar has no stdout")?;
        let runtime = Self {
            token,
            connection: Arc::new(Mutex::new(StdioConnection {
                child,
                stdin,
                stdout: BufReader::new(stdout),
                next_id: 1,
            })),
        };
        let version: Value = runtime.call("ping", json!({})).await?;
        anyhow::ensure!(
            version.get("version").and_then(Value::as_u64)
                == Some(u64::from(COGNITIVE_PROTOCOL_VERSION)),
            "cognitive sidecar protocol mismatch"
        );
        Ok(runtime)
    }

    pub async fn shutdown(&self) -> Result<()> {
        let _ = self.call::<Value>("shutdown", json!({})).await;
        let mut connection = self.connection.lock().await;
        let _ = connection.child.kill().await;
        Ok(())
    }

    async fn call<T>(&self, method: &str, params: Value) -> Result<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let mut connection = self.connection.lock().await;
        let id = connection.next_id;
        connection.next_id = connection.next_id.saturating_add(1);
        let request = json!({
            "jsonrpc": "2.0",
            "version": COGNITIVE_PROTOCOL_VERSION,
            "id": id,
            "auth": self.token,
            "method": method,
            "params": params,
        });
        let mut encoded = serde_json::to_vec(&request)?;
        encoded.push(b'\n');
        connection.stdin.write_all(&encoded).await?;
        connection.stdin.flush().await?;
        let mut line = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(20),
            connection.stdout.read_line(&mut line),
        )
        .await
        .context("cognitive sidecar timed out")??;
        let response: Value =
            serde_json::from_str(&line).context("invalid cognitive sidecar JSON")?;
        anyhow::ensure!(
            response.get("id").and_then(Value::as_u64) == Some(id),
            "cognitive response id mismatch"
        );
        if let Some(error) = response.get("error") {
            anyhow::bail!(
                "cognitive sidecar error: {}",
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
            );
        }
        serde_json::from_value(response.get("result").cloned().unwrap_or(Value::Null))
            .context("invalid cognitive response result")
    }

    fn profile_params(profile_id: &str) -> Value {
        json!({"profile_id": validate_profile_id(profile_id)})
    }
}

#[async_trait]
impl CognitiveRuntime for StdioCognitiveRuntime {
    async fn bootstrap(
        &self,
        profile_id: &str,
        name: &str,
        address: &str,
        preset: &str,
    ) -> Result<CognitiveState> {
        self.call(
            "bootstrap",
            json!({"profile_id": validate_profile_id(profile_id), "name": name, "address": address, "preset": preset}),
        )
        .await
    }

    async fn configure(
        &self,
        profile_id: &str,
        name: &str,
        address: &str,
        preset: &str,
    ) -> Result<CognitiveState> {
        self.call(
            "configure",
            json!({
                "profile_id": validate_profile_id(profile_id),
                "name": bounded_text(name),
                "address": bounded_text(address),
                "preset": preset,
            }),
        )
        .await
    }

    async fn before_turn(&self, profile_id: &str, user_text: &str) -> Result<CognitiveTurnContext> {
        self.call(
            "before_turn",
            json!({"profile_id": validate_profile_id(profile_id), "user_text": bounded_text(user_text)}),
        )
        .await
    }

    async fn after_turn(
        &self,
        profile_id: &str,
        user_text: &str,
        assistant_text: &str,
        shared_memory_count: Option<u64>,
    ) -> Result<CognitiveState> {
        self.call(
            "after_turn",
            json!({
                "profile_id": validate_profile_id(profile_id),
                "user_text": bounded_text(user_text),
                "assistant_text": bounded_text(assistant_text),
                "shared_memory_count": shared_memory_count,
            }),
        )
        .await
    }

    async fn get_state(&self, profile_id: &str) -> Result<CognitiveState> {
        self.call("get_state", Self::profile_params(profile_id))
            .await
    }

    async fn recall_memory(
        &self,
        profile_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<String>> {
        self.call(
            "recall_memory",
            json!({"profile_id": validate_profile_id(profile_id), "query": bounded_text(query), "limit": limit.clamp(1, 12)}),
        )
        .await
    }

    async fn personality(&self, profile_id: &str) -> Result<BTreeMap<String, String>> {
        self.call("personality", Self::profile_params(profile_id))
            .await
    }

    async fn bond(&self, profile_id: &str) -> Result<f64> {
        self.call("bond", Self::profile_params(profile_id)).await
    }

    async fn pause(&self, profile_id: &str, paused: bool) -> Result<CognitiveState> {
        self.call(
            "pause",
            json!({"profile_id": validate_profile_id(profile_id), "paused": paused}),
        )
        .await
    }

    async fn snapshot(&self, profile_id: &str) -> Result<PathBuf> {
        self.call("snapshot", Self::profile_params(profile_id))
            .await
    }

    async fn export(&self, profile_id: &str, destination: &Path) -> Result<CognitiveExport> {
        self.call(
            "export",
            json!({"profile_id": validate_profile_id(profile_id), "destination": destination}),
        )
        .await
    }

    async fn reset(&self, profile_id: &str) -> Result<CognitiveState> {
        self.call("reset", Self::profile_params(profile_id)).await
    }

    async fn delete(&self, profile_id: &str) -> Result<()> {
        let _: Value = self
            .call("delete", Self::profile_params(profile_id))
            .await?;
        Ok(())
    }
}

pub fn generate_cognitive_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn validate_profile_id(value: &str) -> &str {
    if value.len() <= 64
        && !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        value
    } else {
        "invalid-profile"
    }
}

fn bounded_text(value: &str) -> String {
    value.chars().take(12_000).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_random_and_long_enough_for_sidecar_authentication() {
        let first = generate_cognitive_token();
        let second = generate_cognitive_token();
        assert_ne!(first, second);
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn profile_and_turn_inputs_are_bounded() {
        assert_eq!(validate_profile_id("life_1"), "life_1");
        assert_eq!(validate_profile_id("../escape"), "invalid-profile");
        assert_eq!(bounded_text(&"x".repeat(20_000)).len(), 12_000);
    }
}
