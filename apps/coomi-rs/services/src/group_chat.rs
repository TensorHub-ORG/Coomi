use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMember {
    pub id: String,
    pub name: String,
    #[serde(default)] pub model_selector: String,
    #[serde(default)] pub prompt: String,
    #[serde(default = "default_member_color")] pub color: String,
    #[serde(default = "default_member_icon")] pub icon: String,
    #[serde(default)] pub quota: u32,
}
fn default_member_color() -> String { "#2d61c6".into() }
fn default_member_icon() -> String { "chat".into() }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMessage {
    pub id: String,
    pub from: String,
    #[serde(default = "default_to")] pub to: String,
    pub content: String,
    #[serde(default)] pub attachments: Vec<String>,
    #[serde(default)] pub reply_to: Option<String>,
    pub at_ms: i64,
    #[serde(default)] pub kind: String,
}
fn default_to() -> String { "all".into() }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberActivity {
    pub id: String,
    pub member_id: String,
    pub kind: String,
    #[serde(default)] pub detail: String,
    #[serde(default)] pub message_id: Option<String>,
    pub at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRoom {
    pub id: String,
    pub name: String,
    #[serde(default)] pub topic: String,
    #[serde(default = "default_room_status")] pub status: String,
    #[serde(default = "default_speak_mode")] pub speak_mode: String,
    #[serde(default)] pub members: Vec<ChatMember>,
    #[serde(default)] pub messages: Vec<GroupMessage>,
    #[serde(default)] pub activities: Vec<MemberActivity>,
    #[serde(default)] pub context_paths: Vec<String>,
    #[serde(default)] pub work_dir: String,
    #[serde(default)] pub next_speaker: usize,
    #[serde(default)] pub speak_counts: std::collections::BTreeMap<String, u32>,
    #[serde(default)] pub host_allow: Vec<String>,
    #[serde(default = "default_reasoning_effort")] pub reasoning_effort: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}
fn default_room_status() -> String { "idle".into() }
fn default_speak_mode() -> String { "round_robin".into() }
fn default_reasoning_effort() -> String { "auto".into() }

impl GroupRoom {
    pub fn new(name: String, topic: String, speak_mode: String, members: Vec<ChatMember>, work_dir: String) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self { id: Uuid::new_v4().to_string(), name, topic, status: default_room_status(), speak_mode,
            members, messages: vec![], activities: vec![], context_paths: vec![], work_dir,
            next_speaker: 0, speak_counts: Default::default(), host_allow: vec![], reasoning_effort: default_reasoning_effort(),
            created_at_ms: now, updated_at_ms: now }
    }
}

#[derive(Clone)]
pub struct GroupChatStore { root: PathBuf }
impl GroupChatStore {
    pub fn new(home: impl AsRef<Path>) -> Self { Self { root: home.as_ref().join("group-chat") } }
    fn path(&self, id: &str) -> PathBuf { self.root.join(format!("{id}.json")) }
    pub fn list(&self) -> Result<Vec<GroupRoom>> {
        if !self.root.exists() { return Ok(vec![]) }
        let mut rooms = fs::read_dir(&self.root)?.filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") { return None }
            serde_json::from_slice::<GroupRoom>(&fs::read(path).ok()?).ok()
        }).collect::<Vec<_>>();
        rooms.sort_by_key(|room| std::cmp::Reverse(room.updated_at_ms));
        Ok(rooms)
    }
    pub fn load(&self, id: &str) -> Result<GroupRoom> {
        serde_json::from_slice(&fs::read(self.path(id)).with_context(|| format!("read group room {id}"))?)
            .with_context(|| format!("parse group room {id}"))
    }
    pub fn save(&self, mut room: GroupRoom) -> Result<GroupRoom> {
        validate(&room)?;
        room.updated_at_ms = chrono::Utc::now().timestamp_millis();
        fs::create_dir_all(&self.root)?;
        let path = self.path(&room.id); let tmp = path.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&room)?)?; fs::rename(tmp, path)?;
        Ok(room)
    }
    pub fn delete(&self, id: &str) -> Result<()> { let p=self.path(id); if p.exists(){fs::remove_file(p)?;} Ok(()) }
}
fn validate(room: &GroupRoom) -> Result<()> {
    if room.name.trim().is_empty() { bail!("group room name is required") }
    if room.members.is_empty() || room.members.len() > 30 { bail!("group room must contain 1 to 30 members") }
    if !matches!(room.speak_mode.as_str(), "round_robin" | "open" | "host") { bail!("invalid speak mode") }
    let mut ids=std::collections::HashSet::new();
    if room.members.iter().any(|m| m.id.trim().is_empty() || m.name.trim().is_empty() || !ids.insert(&m.id)) { bail!("member ids and names must be unique and non-empty") }
    Ok(())
}
