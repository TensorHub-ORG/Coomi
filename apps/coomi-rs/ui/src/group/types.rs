//! 群聊类型定义：成员 / 消息 / 活动 / 房间 / 发言模式。
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeakMode {
    #[default]
    RoundRobin,
    Open,
    Host,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoomStatus {
    #[default]
    Idle,
    Running,
    Done,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMember {
    pub id: String,
    pub name: String,
    pub model_selector: String,
    pub prompt: String,
    pub color: String,
    pub icon: String,
    #[serde(default)]
    pub quota: u32,
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub speaking_style: String,
    #[serde(default)]
    pub values: String,
    #[serde(default)]
    pub emotion_bias: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub life_id: Option<String>,
    /// 项目内身份 id（同名跨群共享记忆）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub content: String,
    pub kind: String,
    pub ts: f64,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

/// 成员活动轨迹：思考/发言/定向交流。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberActivity {
    pub id: String,
    /// speak | directed | system
    pub kind: String,
    pub member_id: String,
    pub detail: String,
    pub at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRoom {
    pub id: String,
    pub name: String,
    pub topic: String,
    pub status: RoomStatus,
    pub speak_mode: SpeakMode,
    pub members: Vec<ChatMember>,
    pub messages: Vec<ChatMessage>,
    pub next_speaker: usize,
    pub speak_counts: HashMap<String, u32>,
    pub host_allow: Vec<String>,
    #[serde(default = "default_effort")]
    pub reasoning_effort: String,
    #[serde(default)]
    pub context_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<String>,
    #[serde(default)]
    pub activities: Vec<MemberActivity>,
    #[serde(default)]
    pub idle_chat_enabled: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

pub fn default_effort() -> String {
    "auto".into()
}
