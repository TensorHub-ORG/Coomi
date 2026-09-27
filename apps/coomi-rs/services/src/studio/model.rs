use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberStatus { #[default] Idle, Thinking, #[serde(alias = "executing")] Running, Waiting, #[serde(alias = "done")] Completed, Failed }

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemStatus { #[default] Pending, #[serde(alias = "in_progress")] Running, Review, #[serde(alias = "done")] Completed, Failed }

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolPermission { Ask, #[serde(alias = "readonly")] Auto, #[default] Full }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMember {
    pub id: String,
    pub name: String,
    #[serde(default)] pub avatar: String,
    pub provider_id: String,
    pub model: String,
    #[serde(default)] pub role: String,
    #[serde(default)] pub system_prompt: String,
    #[serde(default)] pub tool_permission: ToolPermission,
    #[serde(default)] pub status: MemberStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Studio {
    pub id: String,
    pub name: String,
    #[serde(default)] pub description: String,
    pub shared_dir: String,
    pub host_id: String,
    #[serde(default)] pub members: Vec<StudioMember>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Studio {
    pub fn new(name: String, shared_dir: String, members: Vec<StudioMember>, host_id: String) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self { id: Uuid::new_v4().to_string(), name, description: String::new(), shared_dir,
            host_id, members, created_at: now, updated_at: now }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMessage {
    pub id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub content: String,
    #[serde(default)] pub mentions: Vec<String>,
    #[serde(default)] pub work_item_id: Option<String>,
    #[serde(default = "default_message_kind")] pub r#type: String,
    pub timestamp: i64,
}

fn default_message_kind() -> String { "message".into() }

impl StudioMessage {
    pub fn new(sender_id: String, sender_name: String, content: String, mentions: Vec<String>) -> Self {
        Self { id: Uuid::new_v4().to_string(), sender_id, sender_name, content, mentions,
            work_item_id: None, r#type: default_message_kind(), timestamp: chrono::Utc::now().timestamp_millis() }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    pub title: String,
    #[serde(default)] pub description: String,
    pub assignee_id: String,
    #[serde(default)] pub status: WorkItemStatus,
    #[serde(default)] pub depends_on: Vec<String>,
    #[serde(default)] pub result: String,
    pub created_at: i64,
    pub updated_at: i64,
}

