//! 引擎运行态文件（`<home>/runtime.json`）：记录「哪些会话还有未完成的回合」。
//!
//! 为什么需要它：会话任务表只活在内存里。引擎进程被杀（崩溃、更新、断电）后，
//! 前端就再也看不到「这个会话还有一轮没跑完」——运行时状态连同一轮的内容一起消失。
//! 这份文件是崩溃后仍可读的唯一凭据：
//!   * 引擎运行中每 2 秒刷新一次（只有内容变了才写盘）；
//!   * 重启后把上次遗留的未完成回合恢复成 running（`interrupted: true`），
//!     直到该会话被继续（重新跑起来 → 由当前进程接管）或被显式取消。

use super::AppState;
use coomi_engine::SessionStore;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use uuid::Uuid;

/// 运行态文件名（相对 home）。
pub(super) const RUNTIME_STATE_FILE: &str = "runtime.json";
/// 刷盘间隔：够快（崩溃最多丢 2 秒的状态）又不会把磁盘写穿。
const RUNTIME_FLUSH_INTERVAL: Duration = Duration::from_secs(2);
/// 文件格式版本，便于以后加字段时前端/旧引擎各读各的。
const RUNTIME_STATE_VERSION: u8 = 1;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs())
        .unwrap_or(0)
}

pub(super) fn runtime_state_path(home: &Path) -> PathBuf {
    home.join(RUNTIME_STATE_FILE)
}

/// 一个未完成回合：接口与磁盘文件共用同一套字段。
#[derive(Clone, Debug)]
pub(super) struct RuntimeEntry {
    pub session_id: String,
    pub started_at: u64,
    pub round: u64,
    pub last_event_at: u64,
    pub phase: String,
    pub task_id: Option<String>,
    /// true = 引擎重启后从磁盘恢复、当前进程并未在跑（等待用户继续或取消）。
    pub interrupted: bool,
}

impl RuntimeEntry {
    fn to_json(&self) -> Value {
        json!({
            "session_id": self.session_id,
            "started_at": self.started_at,
            "round": self.round,
            "last_event_at": self.last_event_at,
            "phase": self.phase,
            "task_id": self.task_id,
        })
    }

    fn from_json(item: &Value) -> Option<Self> {
        let session_id = item.get("session_id").and_then(Value::as_str)?;
        if session_id.is_empty() {
            return None;
        }
        Some(Self {
            session_id: session_id.to_owned(),
            started_at: item.get("started_at").and_then(Value::as_u64).unwrap_or(0),
            round: item.get("round").and_then(Value::as_u64).unwrap_or(0),
            last_event_at: item
                .get("last_event_at")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            phase: item
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or("running")
                .to_owned(),
            task_id: item
                .get("task_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            interrupted: true,
        })
    }
}

/// 运行态注册表：内存里的权威副本，磁盘文件只是它的持久化投影。
#[derive(Default)]
pub(super) struct RuntimeRegistry {
    /// 上次进程遗留、尚未被继续/取消的未完成回合（key = session_id）。
    restored: StdMutex<HashMap<String, RuntimeEntry>>,
    /// 上一次写盘的内容；内容没变就不重复写（每 2 秒一次也不产生无谓 I/O）。
    last_written: StdMutex<String>,
}

impl RuntimeRegistry {
    /// 启动时读取磁盘运行态：上次进程被杀时留下的未完成回合，重启后仍标记 running。
    pub(super) fn load(home: &Path) -> Self {
        let registry = Self::default();
        let Ok(bytes) = std::fs::read(runtime_state_path(home)) else {
            return registry;
        };
        let Ok(document) = serde_json::from_slice::<Value>(&bytes) else {
            eprintln!("[runtime] ignoring unreadable {RUNTIME_STATE_FILE}");
            return registry;
        };
        let Some(items) = document.get("sessions").and_then(Value::as_array) else {
            return registry;
        };
        {
            let mut restored = registry
                .restored
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for item in items {
                if let Some(entry) = RuntimeEntry::from_json(item) {
                    restored.insert(entry.session_id.clone(), entry);
                }
            }
            if !restored.is_empty() {
                println!(
                    "[runtime] restored {} unfinished session turn(s) from {RUNTIME_STATE_FILE}",
                    restored.len()
                );
            }
        }
        registry
    }

    /// 当前进程正在跑的回合（只看内存任务表；不碰磁盘，供前端 2s/10s 轮询用）。
    fn live_entries(state: &AppState) -> HashMap<String, RuntimeEntry> {
        // try_lock：拿不到（有别的路径正持有）就返回空表 —— 运行态只是提示，
        // 绝不能让调用方（HTTP 接口 / 2 秒刷盘线程）阻塞在锁上（阻塞会让接口挂死）。
        let tasks = match state.tasks.try_lock() {
            Ok(tasks) => tasks,
            Err(_) => return HashMap::new(),
        };
        tasks
            .iter()
            .filter(|(_, task)| task.running.load(Ordering::SeqCst))
            .map(|(session_id, task)| {
                let entry = RuntimeEntry {
                    session_id: session_id.clone(),
                    started_at: task.started_at.load(Ordering::SeqCst),
                    round: task.round.load(Ordering::SeqCst),
                    last_event_at: task.last_event_at.load(Ordering::SeqCst),
                    phase: task
                        .phase
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone(),
                    task_id: task
                        .task_id
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone(),
                    interrupted: false,
                };
                (session_id.clone(), entry)
            })
            .collect()
    }

    /// 未完成回合快照：正在跑的 + 重启后恢复的（接口与写盘共用）。
    pub(super) fn snapshot(&self, state: &AppState) -> Vec<RuntimeEntry> {
        let mut merged = {
            let restored = self
                .restored
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            restored.clone()
        };
        for (session_id, entry) in Self::live_entries(state) {
            merged.insert(session_id, entry);
        }
        let mut entries = merged.into_values().collect::<Vec<_>>();
        // 先按开始时间、再按会话 id：前端轮询拿到的顺序稳定，列表不会跳。
        entries.sort_by(|left, right| {
            left.started_at
                .cmp(&right.started_at)
                .then_with(|| left.session_id.cmp(&right.session_id))
        });
        entries
    }

    /// 某个会话是否处于「重启后仍未完成」的状态（会话列表据此显示 running 标记）。
    pub(super) fn is_interrupted(&self, session_id: &str, state: &AppState) -> bool {
        // 锁序：**先取 restored 并立即释放**，再动 tasks —— 与 snapshot 一致，避免 AB-BA 互等。
        let in_restored = {
            let restored = self
                .restored
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            restored.contains_key(session_id)
        };
        if !in_restored {
            return false;
        }
        // tasks 用 try_lock：拿不到（有别的路径正持有）就按「未在跑」降级 ——
        // 这只是列表上的一个提示标记，绝不能让 HTTP 接口挂死（挂死会让前端以为引擎断开）。
        match state.tasks.try_lock() {
            Ok(tasks) => !tasks.get(session_id).is_some_and(|task| task.running.load(Ordering::SeqCst)),
            Err(_) => true,
        }
    }

    /// 显式取消 / 会话被删除 / 会话数据被清空：未完成回合的标记必须一起消失，
    /// 否则用户取消后重启还会看到「running」。
    pub(super) fn clear(&self, session_id: &str) {
        self.restored
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(session_id);
    }

    /// 周期性同步：重建当前进程的活跃条目、摘掉已被继续或已经不存在的恢复条目，
    /// 内容有变化时才写盘。
    pub(super) fn sync_and_flush(&self, state: &AppState) {
        let live = Self::live_entries(state);
        let entries = {
            let mut restored = self
                .restored
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // 被继续（当前进程已接管）或会话已不在磁盘上 → 恢复标记完成使命。
            restored.retain(|session_id, _| {
                if live.contains_key(session_id) {
                    return false;
                }
                Uuid::parse_str(session_id)
                    .map(|id| SessionStore::new(&state.home).contains(id))
                    .unwrap_or(false)
            });
            let mut merged = restored.clone();
            drop(restored);
            for (session_id, entry) in live {
                merged.insert(session_id, entry);
            }
            let mut entries = merged.into_values().collect::<Vec<_>>();
            entries.sort_by(|left, right| {
                left.started_at
                    .cmp(&right.started_at)
                    .then_with(|| left.session_id.cmp(&right.session_id))
            });
            entries
        };
        let document = json!({
            "version": RUNTIME_STATE_VERSION,
            "updated_at": now_secs(),
            "sessions": entries.iter().map(RuntimeEntry::to_json).collect::<Vec<_>>(),
        });
        let text = document.to_string();
        {
            let mut last = self
                .last_written
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *last == text {
                return;
            }
            *last = text.clone();
        }
        if let Err(error) = write_atomic(&runtime_state_path(&state.home), text.as_bytes()) {
            eprintln!("[runtime] failed to persist {RUNTIME_STATE_FILE}: {error}");
        }
    }
}

/// 原子写：先写临时文件再 rename，崩溃/断电不会留下截断的 JSON。
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// 后台刷盘线程：每 2 秒把内存运行态投影到 runtime.json。
pub(super) fn spawn_flusher(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RUNTIME_FLUSH_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            state.runtime.sync_and_flush(&state);
        }
    });
}
