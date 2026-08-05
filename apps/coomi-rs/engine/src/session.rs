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
    /// 会话标题：首条用户消息的本地推导，供会话列表/检索使用。
    #[serde(default)]
    pub title: String,
    /// 会话一句话摘要：本地规则推导（首条 user + 末尾 assistant），供检索匹配。
    #[serde(default)]
    pub summary: String,
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
            title: String::new(),
            summary: String::new(),
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
    /// 首条用户消息的短预览（向后兼容）。
    pub preview: String,
    /// 会话标题：持久化的 Session.title，缺省时惰性推导。
    pub title: String,
    /// 会话摘要：持久化的 Session.summary，缺省时惰性推导。
    pub summary: String,
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
            let preview = first_user_content(&session.messages)
                .map(compact_preview)
                .unwrap_or_default();
            // title/summary 为空的旧会话在这里惰性推导，无需迁移写盘。
            let title = if session.title.trim().is_empty() {
                first_user_content(&session.messages)
                    .map(derive_title)
                    .unwrap_or_default()
            } else {
                session.title.clone()
            };
            let summary = if session.summary.trim().is_empty() {
                derive_summary(&session.messages)
            } else {
                session.summary.clone()
            };
            summaries.push(SessionSummary {
                id: session.id,
                provider_id: session.provider_id,
                model: session.model,
                cwd: session.cwd,
                updated_at: session.updated_at,
                preview,
                title,
                summary,
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

/// 首条真实用户消息的原文（跳过 internal 消息，如自动注入的指令）。
fn first_user_content(messages: &[ChatMessage]) -> Option<&str> {
    messages
        .iter()
        .find(|message| message.role == crate::Role::User && !message.internal)
        .map(|message| message.content.as_str())
}

/// 标题：首条用户消息压缩为一行，截断到 42 字符（与前端 deriveTitle 一致）。
fn derive_title(value: &str) -> String {
    let single_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = single_line.trim();
    let mut chars = trimmed.chars();
    let head: String = chars.by_ref().take(42).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// 本地规则摘要：首条用户消息 + 末尾 assistant 回复（各截断），以 " → " 连接。
/// 无 assistant 消息时退化为首条用户消息。
fn derive_summary(messages: &[ChatMessage]) -> String {
    let first = first_user_content(messages)
        .map(compact_preview)
        .unwrap_or_default();
    let last_assistant = messages
        .iter()
        .rev()
        .find(|message| {
            message.role == crate::Role::Assistant
                && !message.content.trim().is_empty()
                && !message.compaction_summary
        })
        .map(|message| summarize_assistant(&message.content))
        .unwrap_or_default();
    if first.is_empty() {
        return String::new();
    }
    if last_assistant.is_empty() {
        first
    } else {
        format!("{first} → {last_assistant}")
    }
}

/// 助手回复摘要：首尾双侧采样（各 `SUMMARY_TAIL_CHARS` 字符）。
/// 只取开头会把长回复中后段的关键信息（技术词、结论）漏掉，
/// 导致检索命中不了——检索的价值正在于这些词。
const SUMMARY_TAIL_CHARS: usize = 96;

fn summarize_assistant(content: &str) -> String {
    let single_line = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let s = single_line.trim();
    let len = s.chars().count();
    if len <= SUMMARY_TAIL_CHARS * 2 {
        return s.chars().take(SUMMARY_TAIL_CHARS * 2).collect();
    }
    let head: String = s.chars().take(SUMMARY_TAIL_CHARS).collect();
    let tail: String = s
        .chars()
        .rev()
        .take(SUMMARY_TAIL_CHARS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{head}…{tail}")
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
        session
            .messages
            .push(ChatMessage::assistant("the build is green", Vec::new()));
        store.save(&session).expect("save session");

        let listed = store.list(Some(home.path())).expect("list sessions");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].preview, "inspect this project");
        assert_eq!(listed[0].title, "inspect this project");
        assert_eq!(listed[0].summary, "inspect this project → the build is green");
        assert_eq!(store.load(session.id).expect("load session").model, "model");
        assert!(store.delete(session.id).expect("delete session"));
        assert!(!store.delete(session.id).expect("delete missing session"));
    }

    #[test]
    fn list_lazily_derives_title_and_summary_for_old_sessions() {
        let home = tempfile::tempdir().expect("temporary home");
        let store = SessionStore::new(home.path());
        // 模拟旧版本会话：无 title/summary 字段（serde default 兼容）。
        let mut session = Session::new("provider", "model", home.path().to_path_buf());
        session.title.clear();
        session.summary.clear();
        let long_first = format!("first message {}", "x".repeat(200));
        session.messages.push(ChatMessage::user(long_first.clone()));
        session
            .messages
            .push(ChatMessage::user("second user message, not the title"));
        session
            .messages
            .push(ChatMessage::assistant("finished the migration", Vec::new()));
        store.save(&session).expect("save session");

        // 反序列化旧 JSON（无 title/summary 键）仍然成功。
        let path = store.path(session.id);
        let mut value = serde_json::to_value(&session).expect("serialize session");
        value
            .as_object_mut()
            .expect("session object")
            .remove("title");
        value
            .as_object_mut()
            .expect("session object")
            .remove("summary");
        std::fs::write(&path, serde_json::to_vec_pretty(&value).expect("pretty json"))
            .expect("write old-style json");
        let loaded = store.load(session.id).expect("load old-style session");
        assert!(loaded.title.is_empty());
        assert!(loaded.summary.is_empty());

        let listed = store.list(Some(home.path())).expect("list sessions");
        assert_eq!(listed.len(), 1);
        // 标题取首条 user 消息并截断到 42 字符 + 省略号。
        assert_eq!(listed[0].title.chars().count(), 43);
        assert!(listed[0].title.starts_with("first message"));
        assert!(listed[0].title.ends_with('…'));
        // 摘要含首条 user 与末尾 assistant 回复。
        assert!(listed[0].summary.contains("first message"));
        assert!(listed[0].summary.contains("finished the migration"));
        assert!(!listed[0].summary.contains("second user message"));
    }

    #[test]
    fn derive_title_compresses_and_truncates() {
        assert_eq!(derive_title("  hello\n  world  "), "hello world");
        let long = "a".repeat(100);
        let title = derive_title(&long);
        assert_eq!(title.chars().count(), 43);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn derive_summary_links_first_user_and_last_assistant() {
        let messages = vec![
            ChatMessage::user("fix the parser"),
            ChatMessage::assistant("on it", Vec::new()),
            ChatMessage::user("also update tests"),
            ChatMessage::assistant("tests updated", Vec::new()),
        ];
        let summary = derive_summary(&messages);
        assert_eq!(summary, "fix the parser → tests updated");
        // 无 assistant 时退化为首条 user。
        let only_user = vec![ChatMessage::user("just a note")];
        assert_eq!(derive_summary(&only_user), "just a note");
    }

    #[test]
    fn derive_summary_captures_tail_keywords_of_long_reply() {
        // 长回复：关键信息（多进程）只出现在尾部，只取开头会漏掉。
        let mut long = String::from("GIL 全称 Global Interpreter Lock，它让 CPython 同一时刻只有一个线程执行字节码。");
        long.push_str(&"a".repeat(2000));
        long.push_str("需要的话我可以帮你写一个对比 GIL 影响、或用多进程/NumPy 加速的具体示例。");
        let messages = vec![
            ChatMessage::user("Python 的 GIL 是什么？影响什么场景"),
            ChatMessage::assistant(&long, Vec::new()),
        ];
        let summary = derive_summary(&messages);
        assert!(summary.contains("多进程"), "摘要应包含尾部关键词，实际: {summary:?}");
        // 短回复双侧不重复、不截断过多。
        let short = vec![
            ChatMessage::user("hi"),
            ChatMessage::assistant("hello world", Vec::new()),
        ];
        assert_eq!(derive_summary(&short), "hi → hello world");
    }
}
