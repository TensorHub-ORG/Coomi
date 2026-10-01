//! 目标栈（Goal Stack）：长任务中处理子问题后能回到原目标。
//!
//! 类似"注意力系统"：记录当前主任务，被子任务打断时压栈，完成后弹栈。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 目标栈条目
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalEntry {
    /// 目标描述
    pub description: String,
    /// 创建时间
    pub created_at_ms: u64,
    /// 当前状态：active | paused | done
    pub status: String,
}

/// 目标栈状态（持久化到 session 目录）
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalStack {
    /// 栈：最底层是主任务，最顶层是当前子任务
    pub stack: Vec<GoalEntry>,
    /// 被打断的待办
    #[serde(default)]
    pub pending: Vec<String>,
}

impl GoalStack {
    /// 压入新目标（子任务）。
    pub fn push(&mut self, description: &str) {
        self.stack.push(GoalEntry {
            description: description.to_owned(),
            created_at_ms: now_ms(),
            status: "active".into(),
        });
    }

    /// 弹出当前目标，返回描述。
    pub fn pop(&mut self) -> Option<GoalEntry> {
        self.stack.pop()
    }

    /// 获取当前焦点（栈顶）。
    pub fn current(&self) -> Option<&GoalEntry> {
        self.stack.last()
    }

    /// 获取主任务（栈底）。
    pub fn main_goal(&self) -> Option<&GoalEntry> {
        self.stack.first()
    }

    /// 标记当前目标完成。
    pub fn complete_current(&mut self) -> Option<GoalEntry> {
        if let Some(entry) = self.stack.last_mut() {
            entry.status = "done".into();
        }
        self.pop()
    }

    /// 记录待办（被打断时）。
    pub fn add_pending(&mut self, item: &str) {
        self.pending.push(item.to_owned());
    }

    /// 生成注入 prompt 的目标上下文。
    pub fn to_prompt_context(&self) -> String {
        if self.stack.is_empty() && self.pending.is_empty() {
            return String::new();
        }
        let mut ctx = String::from("\n\n## Goal Context (目标上下文)\n");
        if let Some(main) = self.main_goal() {
            ctx.push_str(&format!("- 主任务: {}\n", main.description));
        }
        if self.stack.len() > 1 {
            for entry in &self.stack[1..] {
                ctx.push_str(&format!("- 子任务: {}\n", entry.description));
            }
        }
        if !self.pending.is_empty() {
            ctx.push_str("- 待办:\n");
            for item in &self.pending {
                ctx.push_str(&format!("  - {}\n", item));
            }
        }
        if self.stack.len() > 1 {
            ctx.push_str("\n完成当前子任务后，记得回到主任务。");
        }
        ctx
    }

    // ── 持久化 ────────────────────────────────────────────

    fn path_for(home: &Path, session_id: &str) -> PathBuf {
        home.join("sessions").join(session_id).join("goal_stack.json")
    }

    pub fn load(home: &Path, session_id: &str) -> Self {
        let path = Self::path_for(home, session_id);
        fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, home: &Path, session_id: &str) {
        let path = Self::path_for(home, session_id);
        if let Some(p) = path.parent() {
            let _ = fs::create_dir_all(p);
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(self) {
            let _ = fs::write(&path, bytes);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
