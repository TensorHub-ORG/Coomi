//! 持久化记忆系统 —— 跨会话存储和检索记忆。
//!
//! 类似于人类的长期记忆：用户偏好、项目事实、工具知识等
//! 可以在不同会话之间共享和检索。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 记忆条目
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MemoryEntry {
    pub key: String,
    pub value: String,
    pub category: MemoryCategory,
    pub created_at: i64,
    pub updated_at: i64,
    pub access_count: u64,
    pub expires_at: Option<i64>,
}

/// 记忆分类
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub enum MemoryCategory {
    UserPreference,
    ProjectFact,
    ToolKnowledge,
    ConversationContext,
    Decision,
}

impl MemoryCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemoryCategory::UserPreference => "user_preference",
            MemoryCategory::ProjectFact => "project_fact",
            MemoryCategory::ToolKnowledge => "tool_knowledge",
            MemoryCategory::ConversationContext => "conversation_context",
            MemoryCategory::Decision => "decision",
        }
    }
}

/// 记忆存储
pub struct MemoryStore {
    path: PathBuf,
    entries: HashMap<String, MemoryEntry>,
}

impl MemoryStore {
    pub fn new(coomi_home: impl AsRef<std::path::Path>) -> Self {
        let path = coomi_home.as_ref().join("memory.json");
        let entries = if path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        Self { path, entries }
    }

    /// 存储记忆
    pub fn store(&mut self, key: &str, value: &str, category: MemoryCategory) {
        let now = now_ms();
        self.entries.insert(
            key.to_string(),
            MemoryEntry {
                key: key.to_string(),
                value: value.to_string(),
                category,
                created_at: now,
                updated_at: now,
                access_count: 0,
                expires_at: None,
            },
        );
    }

    /// 检索记忆（增加访问计数）
    pub fn recall(&mut self, key: &str) -> Option<&MemoryEntry> {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.access_count += 1;
            Some(entry)
        } else {
            None
        }
    }

    /// 关键词搜索
    pub fn search(&self, query: &str, category: Option<MemoryCategory>) -> Vec<&MemoryEntry> {
        let query_lower = query.to_lowercase();
        self.entries
            .values()
            .filter(|e| category.as_ref().map_or(true, |c| &e.category == c))
            .filter(|e| {
                e.key.to_lowercase().contains(&query_lower)
                    || e.value.to_lowercase().contains(&query_lower)
            })
            .collect()
    }

    /// 按分类列出
    pub fn by_category(&self, category: MemoryCategory) -> Vec<&MemoryEntry> {
        self.entries
            .values()
            .filter(|e| e.category == category)
            .collect()
    }

    /// 删除记忆
    pub fn forget(&mut self, key: &str) -> bool {
        self.entries.remove(key).is_some()
    }

    /// 清理过期记忆
    pub fn prune_expired(&mut self) {
        let now = now_ms();
        self.entries
            .retain(|_, e| e.expires_at.map_or(true, |exp| exp > now));
    }

    /// 保存到磁盘
    pub fn save(&self) -> Result<(), std::io::Error> {
        let json = serde_json::to_string_pretty(&self.entries)?;
        fs::write(&self.path, json)
    }

    /// 获取所有记忆数量
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
