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
    // ---- psi-v2 增量字段（sidecar public_state 的 camelCase 输出）----
    /// 情绪效价（Russell 环状模型横轴，[-1, 1]）。
    #[serde(default, rename = "emotionValence")]
    pub emotion_valence: f64,
    /// 情绪唤醒度（纵轴，[0, 1]）。
    #[serde(default = "default_arousal", rename = "emotionArousal")]
    pub emotion_arousal: f64,
    /// 依恋阶段中文名（初识/熟识/伙伴/挚友/知己）。
    #[serde(default, rename = "bondStage")]
    pub bond_stage: String,
    /// 累计对话轮次。
    #[serde(default, rename = "turnCount")]
    pub turn_count: u64,
    /// 连续接触天数。
    #[serde(default, rename = "streakDays")]
    pub streak_days: u64,
    /// 相识天数。
    #[serde(default = "default_days_together", rename = "daysTogether")]
    pub days_together: u64,
    /// 当前最强驱力维度（需求名）。
    #[serde(default, rename = "dominantUrge")]
    pub dominant_urge: String,
    // ---- psi-v2.1 增量字段 ----
    /// 用户最近几天的心情镜像（加权平均效价，无样本为 None）。
    #[serde(default, rename = "userMoodAvg")]
    pub user_mood_avg: Option<f64>,
    /// 进行中的记挂事项数（pending + passed）。
    #[serde(default, rename = "agendaPending")]
    pub agenda_pending: u32,
    // ---- psi-v2.2 增量字段（sidecar public_state 的 camelCase 输出）----
    /// 天气化情绪（图标 + 中文标签）。
    #[serde(default)]
    pub weather: Option<CognitiveWeather>,
    /// 时间线大事记条数。
    #[serde(default, rename = "timelineCount")]
    pub timeline_count: u64,
    /// 已封存记忆胶囊数。
    #[serde(default, rename = "capsuleCount")]
    pub capsule_count: u64,
    /// 已封存关系周报数。
    #[serde(default, rename = "weeklyReportCount")]
    pub weekly_report_count: u64,
}

/// 进行中的记挂事项（psi-v2.1：before_turn 语境材料）。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct CognitiveAgendaItem {
    /// 事项原文（用户分句，≤96 字符）。
    #[serde(default)]
    pub text: String,
    /// 到期日（YYYY-MM-DD）。
    #[serde(default, rename = "due_day")]
    pub due_day: String,
    /// 状态（pending / passed / done）。
    #[serde(default)]
    pub status: String,
}

fn default_arousal() -> f64 {
    0.25
}

fn default_days_together() -> u64 {
    1
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
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
    // ---- psi-v2.1 增量（sidecar before_turn 的透传材料）----
    /// 重逢等待天数（连续无接触天数；<3 表示非重逢场景，0 表示当天有接触）。
    #[serde(default, rename = "reunion_waited_days")]
    pub reunion_waited_days: u32,
    /// 进行中的记挂事项（含到期未结），LLM 可自然问起。
    #[serde(default, rename = "user_agenda")]
    pub user_agenda: Vec<CognitiveAgendaItem>,
    /// 用户最近几天的心情镜像（无样本为 None）。
    #[serde(default, rename = "user_mood_avg")]
    pub user_mood_avg: Option<f64>,
    /// 驱力驱动提问：这一次对话它「想问什么」（已按人格与语境选材）。
    #[serde(default, rename = "urge_question")]
    pub urge_question: String,
    // ---- psi-v2.2 增量（sidecar before_turn 的透传材料）----
    /// 情境联想记忆：用户文本与某段旧记忆共享实质词时摘录（带冷却，空串表示无联想）。
    #[serde(default, rename = "cued_recall")]
    pub cued_recall: String,
    /// 习惯观察：基于最近活跃小时的作息洞察（空串表示暂无观察）。
    #[serde(default, rename = "habit_observation")]
    pub habit_observation: String,
    /// 昨日记忆胶囊摘录（空串表示昨天未封存）。
    #[serde(default, rename = "daily_capsule")]
    pub daily_capsule: String,
    /// 上周关系周报摘录（空串表示上周无周报）。
    #[serde(default, rename = "weekly_report")]
    pub weekly_report: String,
    /// 天气化情绪（Russell 象限隐喻：sunny/partly_cloudy/cloudy/overcast/stormy）。
    #[serde(default)]
    pub weather: Option<CognitiveWeather>,
}

/// 天气化情绪（psi-v2.2：情绪二维 → 天气隐喻）。
#[derive(Clone, Debug, Deserialize, Default, Eq, PartialEq, Serialize)]
pub struct CognitiveWeather {
    /// 天气图标键（sunny / partly_cloudy / cloudy / overcast / stormy）。
    #[serde(default)]
    pub icon: String,
    /// 天气中文标签（晴朗 / 多云转晴 / 多云 / 阴天 / 雷雨）。
    #[serde(default)]
    pub label: String,
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
    // ---- psi-v2 增量方法 ----
    /// 仪表盘：状态 + 依恋 + 需求/驱力 + 情绪 + 心情曲线 + 统计。
    async fn dashboard(&self, profile_id: &str) -> Result<Value>;
    /// 心情曲线：最近 N 天的心情事件列表。
    async fn mood_curve(&self, profile_id: &str, days: u32) -> Result<Value>;
    /// 外部事件进入认知管线（task_success / task_failure / session_start …）。
    async fn record_event(&self, profile_id: &str, kind: &str, detail: &str) -> Result<CognitiveState>;
    /// 巩固：记忆主题与核心记忆统计。
    async fn reflect(&self, profile_id: &str) -> Result<Value>;
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

    async fn dashboard(&self, profile_id: &str) -> Result<Value> {
        self.call("get_dashboard", Self::profile_params(profile_id))
            .await
    }

    async fn mood_curve(&self, profile_id: &str, days: u32) -> Result<Value> {
        self.call(
            "mood_curve",
            json!({
                "profile_id": validate_profile_id(profile_id),
                "days": days.min(90),
            }),
        )
        .await
    }

    async fn record_event(&self, profile_id: &str, kind: &str, detail: &str) -> Result<CognitiveState> {
        self.call(
            "record_event",
            json!({
                "profile_id": validate_profile_id(profile_id),
                "kind": kind,
                "detail": detail,
            }),
        )
        .await
    }

    async fn reflect(&self, profile_id: &str) -> Result<Value> {
        self.call("reflect", Self::profile_params(profile_id))
            .await
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

    #[test]
    fn cognitive_state_parses_psi_v2_fields() {
        // sidecar public_state 的 camelCase 输出形状（psi-v2）。
        let payload = serde_json::json!({
            "version": 2,
            "name": "小酷",
            "address": "你",
            "preset": "warm",
            "personality": {"label": "温柔"},
            "paused": false,
            "emotion": "warm",
            "attention": "user",
            "bond": 0.42,
            "needs": {"relatedness": 0.6, "competence": 0.5},
            "memory_count": 12,
            "updated_at_ms": 1_700_000_000_000u64,
            "emotionValence": 0.31,
            "emotionArousal": 0.44,
            "bondStage": "熟识",
            "turnCount": 88,
            "streakDays": 3,
            "daysTogether": 21,
            "dominantUrge": "relatedness",
        });
        let state: CognitiveState = serde_json::from_value(payload).expect("parse v2 state");
        assert_eq!(state.preset, "warm");
        assert!((state.emotion_valence - 0.31).abs() < 1e-9);
        assert!((state.emotion_arousal - 0.44).abs() < 1e-9);
        assert_eq!(state.bond_stage, "熟识");
        assert_eq!(state.turn_count, 88);
        assert_eq!(state.streak_days, 3);
        assert_eq!(state.days_together, 21);
        assert_eq!(state.dominant_urge, "relatedness");
    }

    #[test]
    fn cognitive_state_tolerates_v1_payload_without_v2_fields() {
        // v1 sidecar 的旧响应没有 v2 字段：serde 默认值兜底，消费方不崩溃。
        let payload = serde_json::json!({
            "version": 1,
            "name": "Life",
            "address": "you",
            "paused": false,
            "emotion": "neutral",
            "attention": "user",
            "bond": 0.1,
            "needs": {},
            "memory_count": 0,
            "updated_at_ms": 0,
        });
        let state: CognitiveState = serde_json::from_value(payload).expect("parse v1 state");
        assert_eq!(state.bond_stage, "");
        assert_eq!(state.turn_count, 0);
        assert!((state.emotion_arousal - 0.25).abs() < 1e-9);
        assert_eq!(state.days_together, 1);
    }

    #[test]
    fn cognitive_state_parses_psi_v21_fields() {
        // psi-v2.1 增量：心情镜像 + 记挂计数（public_state 的 camelCase 输出）。
        let payload = serde_json::json!({
            "version": 2,
            "name": "小酷",
            "address": "你",
            "paused": false,
            "emotion": "warm",
            "attention": "user",
            "bond": 0.42,
            "needs": {},
            "memory_count": 3,
            "updated_at_ms": 1_700_000_000_000u64,
            "userMoodAvg": -0.35,
            "agendaPending": 2,
        });
        let state: CognitiveState = serde_json::from_value(payload).expect("parse v2.1 state");
        assert!((state.user_mood_avg.expect("mood") - (-0.35)).abs() < 1e-9);
        assert_eq!(state.agenda_pending, 2);
    }

    #[test]
    fn cognitive_state_v21_defaults_are_backward_compatible() {
        // psi-v2 响应（无 v2.1 字段）：镜像为 None、记挂为 0。
        let payload = serde_json::json!({
            "version": 2,
            "name": "小酷",
            "address": "你",
            "paused": false,
            "emotion": "warm",
            "attention": "user",
            "bond": 0.42,
            "needs": {},
            "memory_count": 3,
            "updated_at_ms": 1_700_000_000_000u64,
        });
        let state: CognitiveState = serde_json::from_value(payload).expect("parse v2 state");
        assert_eq!(state.user_mood_avg, None);
        assert_eq!(state.agenda_pending, 0);
    }

    #[test]
    fn cognitive_turn_context_parses_psi_v21_material() {
        // sidecar before_turn 的 v2.1 语境材料：重逢 / 记挂 / 心情镜像 / 驱力提问。
        let payload = serde_json::json!({
            "version": 2,
            "state_summary": "summary",
            "memories": [],
            "personality": {},
            "relationship": "r",
            "reunion_waited_days": 5,
            "user_agenda": [
                {"text": "我三天后有个面试", "due_day": "2026-09-13", "status": "pending"},
                {"text": "周五要交报告", "due_day": "2026-09-11", "status": "passed"},
            ],
            "user_mood_avg": -0.28,
            "urge_question": "问问他今天过得怎么样",
        });
        let context: CognitiveTurnContext =
            serde_json::from_value(payload).expect("parse v2.1 context");
        assert_eq!(context.reunion_waited_days, 5);
        assert_eq!(context.user_agenda.len(), 2);
        assert_eq!(context.user_agenda[0].text, "我三天后有个面试");
        assert_eq!(context.user_agenda[1].status, "passed");
        assert!((context.user_mood_avg.expect("mood") - (-0.28)).abs() < 1e-9);
        assert_eq!(context.urge_question, "问问他今天过得怎么样");
        // 反向序列化（注入 LLM 提示词时整体 JSON 化）保留 snake_case 键名。
        let encoded = serde_json::to_value(&context).expect("encode context");
        assert_eq!(encoded["reunion_waited_days"], 5);
        assert_eq!(encoded["user_agenda"][0]["due_day"], "2026-09-13");
    }

    #[test]
    fn cognitive_turn_context_v21_defaults_are_backward_compatible() {
        // psi-v2 sidecar 的旧 before_turn 响应没有 v2.1 字段：全部默认值兜底。
        let payload = serde_json::json!({
            "version": 2,
            "state_summary": "summary",
            "memories": [],
            "personality": {},
            "relationship": "r",
        });
        let context: CognitiveTurnContext =
            serde_json::from_value(payload).expect("parse v2 context");
        assert_eq!(context.reunion_waited_days, 0);
        assert!(context.user_agenda.is_empty());
        assert_eq!(context.user_mood_avg, None);
        assert!(context.urge_question.is_empty());
    }
}
