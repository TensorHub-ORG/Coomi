//! 群聊审计日志：记录所有工具调用和敏感操作。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;

/// 审计事件类型
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEvent {
    /// 工具调用
    ToolCall { tool: String, args: String, success: bool },
    /// 敏感操作（需要确认）
    SensitiveOp { action: String, target: String },
    /// 成员发言
    Speak { member_id: String, content_len: usize },
    /// 成员加入/离开
    MemberChange { action: String, member_id: String },
    /// 生命体绑定
    LifeBind { life_id: String, member_id: String },
}

/// 审计日志条目
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub timestamp_ms: u64,
    pub event: AuditEntryEvent,
    pub room_id: String,
}

/// 审计事件（序列化友好）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum AuditEntryEvent {
    ToolCall { tool: String, args: String, success: bool },
    SensitiveOp { action: String, target: String },
    Speak { member_id: String, content_len: usize },
    MemberChange { action: String, member_id: String },
    LifeBind { life_id: String, member_id: String },
}

/// 审计日志写入器
pub struct AuditLogger {
    path: std::path::PathBuf,
}

impl AuditLogger {
    pub fn new(home: &Path, room_id: &str) -> Self {
        let dir = home.join("group-chat").join("audit");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join(format!("{room_id}.log"));
        Self { path }
    }

    pub fn log(&self, event: AuditEntryEvent, room_id: &str) {
        let entry = AuditEntry {
            timestamp_ms: now_ms(),
            event,
            room_id: room_id.to_owned(),
        };
        if let Ok(line) = serde_json::to_string(&entry) {
            if let Ok(mut file) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
            {
                let _ = writeln!(file, "{line}");
            }
        }
    }

    /// 读取最近 N 条审计日志。
    pub fn recent(&self, limit: usize) -> Vec<AuditEntry> {
        let Ok(content) = fs::read_to_string(&self.path) else {
            return vec![];
        };
        let lines: Vec<&str> = content.lines().collect();
        let start = lines.len().saturating_sub(limit);
        lines[start..]
            .iter()
            .filter_map(|l| serde_json::from_str::<AuditEntry>(l).ok())
            .collect()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
