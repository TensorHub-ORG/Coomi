use crate::ChatMessage;
use crate::ContextState;
use crate::LoopState;
use crate::PlanState;
use crate::TokenUsage;
use anyhow::Context;
use anyhow::Result;
use chrono::DateTime;
use chrono::Utc;
use serde::Deserialize;
use serde::Serialize;
use std::cmp::Reverse;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Session {
    pub id: Uuid,
    pub provider_id: String,
    pub model: String,
    pub cwd: PathBuf,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub messages: Vec<ChatMessage>,
    pub usage: TokenUsage,
    #[serde(default)]
    pub context: ContextState,
    #[serde(default)]
    pub plan: Option<PlanState>,
    #[serde(default)]
    pub loop_state: Option<LoopState>,
    #[serde(default)]
    pub hooks_started: bool,
}

impl Session {
    pub fn new(provider_id: impl Into<String>, model: impl Into<String>, cwd: PathBuf) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            provider_id: provider_id.into(),
            model: model.into(),
            cwd,
            created_at: now,
            updated_at: now,
            messages: Vec::new(),
            usage: TokenUsage::default(),
            context: ContextState::default(),
            plan: None,
            loop_state: None,
            hooks_started: false,
        }
    }

    pub fn switch_model(&mut self, provider_id: impl Into<String>, model: impl Into<String>) {
        self.provider_id = provider_id.into();
        self.model = model.into();
        self.touch();
    }

    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }
}

impl SessionStore {
    /// 刷新会话的「最后执行时间」并落盘。
    /// 列表排序以此为准：无论 agent 执行完成、被用户取消还是意外中断，
    /// 都要记录最后一次执行的时间（cancel 等路径不会走 run_turn 的 save）。
    pub fn touch_updated_at(&self, id: Uuid) -> Result<()> {
        let mut session = self.load(id)?;
        session.touch();
        self.save(&session)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionSummary {
    pub id: Uuid,
    pub provider_id: String,
    pub model: String,
    pub cwd: PathBuf,
    pub updated_at: DateTime<Utc>,
    pub preview: String,
}

pub struct SessionStore {
    directory: PathBuf,
}

impl SessionStore {
    pub fn new(coomi_home: impl AsRef<Path>) -> Self {
        Self {
            directory: coomi_home.as_ref().join("sessions"),
        }
    }

    pub fn save(&self, session: &Session) -> Result<()> {
        fs::create_dir_all(&self.directory).with_context(|| {
            format!(
                "failed to create session directory {}",
                self.directory.display()
            )
        })?;
        let path = self.path(session.id);
        let bytes = serde_json::to_vec_pretty(session)?;
        // 原子写：先写临时文件再 rename，避免崩溃/断电留下截断的 JSON，
        // 防止会话记录“莫名消失”（损坏文件此前会被 load 失败后静默丢弃）。
        let tmp = self.directory.join(format!("{}.json.tmp", session.id));
        fs::write(&tmp, &bytes)
            .with_context(|| format!("failed to write session {}", tmp.display()))?;
        fs::rename(&tmp, &path).with_context(|| {
            format!(
                "failed to commit session {} ({} -> {})",
                session.id,
                tmp.display(),
                path.display()
            )
        })
    }

    pub fn load(&self, id: Uuid) -> Result<Session> {
        let path = self.path(id);
        let bytes = fs::read(&path)
            .with_context(|| format!("failed to read session {}", path.display()))?;
        serde_json::from_slice(&bytes)
            .with_context(|| format!("invalid session file {}", path.display()))
    }

    pub fn delete(&self, id: Uuid) -> Result<bool> {
        let path = self.path(id);
        if !path.exists() {
            return Ok(false);
        }
        fs::remove_file(&path)
            .with_context(|| format!("failed to delete session {}", path.display()))?;
        Ok(true)
    }

    /// Whether a session file exists on disk for this id.
    pub fn contains(&self, id: Uuid) -> bool {
        self.path(id).exists()
    }

    pub fn latest(&self, cwd: Option<&Path>) -> Result<Option<Session>> {
        let summaries = self.list(cwd)?;
        summaries
            .first()
            .map(|summary| self.load(summary.id))
            .transpose()
    }

    pub fn list(&self, cwd: Option<&Path>) -> Result<Vec<SessionSummary>> {
        if !self.directory.exists() {
            return Ok(Vec::new());
        }

        let canonical_filter = cwd.and_then(|path| path.canonicalize().ok());
        let mut summaries = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(session) = serde_json::from_slice::<Session>(&bytes) else {
                continue;
            };
            if let Some(filter) = &canonical_filter
                && session.cwd.canonicalize().ok().as_ref() != Some(filter)
            {
                continue;
            }
            let preview = session
                .messages
                .iter()
                .find(|message| message.role == crate::Role::User)
                .map(|message| compact_preview(&message.content))
                .unwrap_or_default();
            summaries.push(SessionSummary {
                id: session.id,
                provider_id: session.provider_id,
                model: session.model,
                cwd: session.cwd,
                updated_at: session.updated_at,
                preview,
            });
        }
        summaries.sort_by_key(|summary| Reverse(summary.updated_at));
        Ok(summaries)
    }

    fn path(&self, id: Uuid) -> PathBuf {
        self.directory.join(format!("{id}.json"))
    }
}

fn compact_preview(value: &str) -> String {
    let single_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    single_line.chars().take(72).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_lists_and_loads_sessions() {
        let home = tempfile::tempdir().expect("temporary home");
        let store = SessionStore::new(home.path());
        let mut session = Session::new("provider", "model", home.path().to_path_buf());
        session
            .messages
            .push(ChatMessage::user("inspect this project"));
        store.save(&session).expect("save session");

        let listed = store.list(Some(home.path())).expect("list sessions");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].preview, "inspect this project");
        assert_eq!(store.load(session.id).expect("load session").model, "model");
        assert!(store.delete(session.id).expect("delete session"));
        assert!(!store.delete(session.id).expect("delete missing session"));
    }
}
