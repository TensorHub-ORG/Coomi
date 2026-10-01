use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::task::AbortHandle;
use tokio::time::Duration;

use crate::web::CollabSettings;
use coomi_engine::InputQueue;
use coomi_tools::ProcessManager;
use serde_json::{json, Value};

/// 内存中每个任务保留的最大事件条数（超出时丢弃最旧事件并记录截断标记）。
/// failed/error 类事件会尽量保留在环尾缓冲，避免关键错误被 FIFO 挤掉。
const MAX_EVENTS: usize = 20_000;
const CRITICAL_EVENT_KEEP: usize = 64;

/// 共享输入队列（agent_id → queue），用于角色间发消息。
pub type AgentQueues = Arc<StdMutex<HashMap<String, Arc<InputQueue>>>>;

/// 文件认领/锁：path → owner。调度器统一维护（D2）。
/// 锁带租约：持有者崩溃/取消后租约过期自动可被抢占（D 崩溃释放）。
pub type FileClaims = Arc<StdMutex<HashMap<String, String>>>;

/// 更细的写锁表：path → 锁详情（租约 + 拒绝计数）。
pub type FileLocks = Arc<StdMutex<HashMap<String, FileLock>>>;

#[derive(Clone, Debug)]
pub struct FileLock {
    pub owner: String,
    pub acquired_at_ms: u64,
    pub expires_at_ms: u64,
    /// 冲突时对方拒绝/被拒次数（超过上限引导挂起，D10=2）。
    pub denials: u32,
}

pub const DEFAULT_LOCK_LEASE_MS: u64 = 90_000;
pub const DEFAULT_LOCK_DENY_LIMIT: u32 = 2;
pub const DEFAULT_MERGE_LIMIT: u32 = 2;

/// 协同工作台持久化任务 DTO。
/// 每次状态/输出更新均落盘，重启后 running/starting 转为 interrupted。
/// 角色间消息（team_inbox 收件箱）。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub content: String,
    pub ts: f64,
    #[serde(default)]
    pub read: bool,
}

/// 角色时间线上的一条活动（思考/工具/文本），按发生顺序记录，供前端聊天式展示。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivity {
    pub id: String,
    /// reasoning | tool | text
    pub kind: String,
    pub ts_ms: u64,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_status: Option<String>,
    /// 工具调用 id（kind == tool 时用于把 start/finish 合并成一条）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabOrchestration {
    /// planning | executing | merging | done
    pub phase: String,
    #[serde(default)]
    pub subtasks: Vec<CollabSubtask>,
    #[serde(default)]
    pub merge_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_result: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabSubtask {
    pub id: String,
    pub agent_id: String,
    pub instruction: String,
    /// pending | starting | running | completed | failed | cancelled | timeout
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabTask {
    pub id: String,
    /// 关联的 session_id（用于推送事件）。
    pub session_id: String,
    pub task: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cwd: String,
    /// 协同设置（角色/模型选择等）。
    #[serde(default)]
    pub settings: CollabSettings,
    #[serde(default)]
    pub status: CollabTaskStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
    #[serde(default)]
    pub agents: Vec<CollabAgent>,
    #[serde(default)]
    pub messages: Vec<CollabMessage>,
    /// 角色间消息（team_inbox）。
    #[serde(default)]
    pub team_messages: Vec<TeamMessage>,
    #[serde(default)]
    pub events: Vec<serde_json::Value>,
    #[serde(default)]
    pub artifacts: Vec<CollabArtifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 重试次数（>0 表示这是重试任务，前端显示「重试中」）。
    #[serde(default)]
    pub retry_count: u32,
    /// orchestrated 模式的拆解/子任务/汇总状态（仅该模式使用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestration: Option<CollabOrchestration>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CollabTaskStatus {
    #[default]
    Queued,
    Draft,
    Starting,
    Running,
    Completed,
    Partial,
    Failed,
    Cancelled,
    Interrupted,
}

impl CollabTaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Partial | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Draft => "draft",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Partial => "partial",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabAgent {
    pub id: String,
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub reasoning: String,
    /// 卡片上的实时状态提示（最后一个思考/输出片段）。
    #[serde(default)]
    pub current_message: String,
    #[serde(default)]
    pub tools: Vec<serde_json::Value>,
    /// 有序活动时间线（思考/工具/文本交错），供前端聊天式展示。
    #[serde(default)]
    pub activities: Vec<AgentActivity>,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub content: String,
    pub ts: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabArtifact {
    pub id: String,
    pub agent_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    /// 动作：read / write / edit / patch。
    #[serde(default)]
    pub action: String,
    /// 被创建/修改的文件路径（前端「产物」Tab 展示）。
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub created_at_ms: u64,
    #[serde(default)]
    pub modified_at_ms: u64,
}

/// 带回调的 CollabRuntime：任务创建后通过 set_callback 设置事件推送函数，
/// 避免 collab.rs 反向依赖 web.rs 中的私有类型。
/// 去掉首尾空白，并把 3 个以上连续换行压成 1 个空行。
fn collapse_blank_lines(input: &str) -> String {
    let trimmed = input.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut newline_run = 0_u8;
    for ch in trimmed.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                out.push(ch);
            }
        } else {
            newline_run = 0;
            out.push(ch);
        }
    }
    out
}

/// 取字符串尾部 n 个字符。
fn tail_chars(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        s.to_owned()
    } else {
        chars[chars.len() - n..].iter().collect()
    }
}

pub struct CollabRuntime {
    home: PathBuf,
    pub tasks: Arc<Mutex<HashMap<String, CollabTask>>>,
    abort_handles: Arc<Mutex<HashMap<String, Vec<AbortHandle>>>>,
    /// 每个任务的角色共享输入队列（task_id → AgentQueues），用于角色间发消息。
    queues: Arc<Mutex<HashMap<String, AgentQueues>>>,
    /// 每个任务的文件认领表（task_id → FileClaims），写文件前校验归属。
    claims: Arc<Mutex<HashMap<String, FileClaims>>>,
    /// 文件写锁（带租约）：调度器统一管理。
    locks: Arc<Mutex<HashMap<String, FileLocks>>>,
    /// 当有活跃 WebSocket 会话时设置，用于推送事件到前端。
    event_callback: Arc<Mutex<Option<Box<dyn Fn(&str, serde_json::Value) + Send + Sync>>>>,
    /// 每个任务的进程管理器（task_id → manager），取消任务时精确终止其长进程。
    process_managers: Arc<Mutex<HashMap<String, Arc<ProcessManager>>>>,
    /// 落盘合流：脏标记 + 通知，后台循环按 150ms 去抖批量写盘，避免每个事件都整文件重写。
    dirty: Arc<AtomicBool>,
    save_notify: Arc<Notify>,
    /// 已请求取消的任务 id（取消信号，供轮次循环即时退出）。
    cancelled: Arc<StdMutex<HashMap<String, bool>>>,
    /// 广播节流：task_id → (last_broadcast_ms, last_payload_hash)。避免唤醒风暴。
    broadcast_throttle: Arc<StdMutex<HashMap<String, (u64, u64)>>>,
    /// 运行中定向/插入指令：task_id → (agent_id → 待注入消息)。agent spawn 时消费。
    pending_directives: Arc<StdMutex<HashMap<String, HashMap<String, Vec<String>>>>>,
    /// 任务级取消时用于精确 abort 的额外句柄（子任务超时 abort 也用）。
    subtask_aborts: Arc<StdMutex<HashMap<String, Vec<AbortHandle>>>>,
}

async fn load_and_recover(tasks: &Arc<Mutex<HashMap<String, CollabTask>>>, home: &Path) {
    let rt = CollabRuntime {
        home: home.to_path_buf(),
        tasks: Arc::clone(tasks),
        abort_handles: Arc::new(Mutex::new(HashMap::new())),
        queues: Arc::new(Mutex::new(HashMap::new())),
        claims: Arc::new(Mutex::new(HashMap::new())),
        locks: Arc::new(Mutex::new(HashMap::new())),
        event_callback: Arc::new(Mutex::new(None)),
        process_managers: Arc::new(Mutex::new(HashMap::new())),
        dirty: Arc::new(AtomicBool::new(false)),
        save_notify: Arc::new(Notify::new()),
        cancelled: Arc::new(StdMutex::new(HashMap::new())),
        broadcast_throttle: Arc::new(StdMutex::new(HashMap::new())),
        pending_directives: Arc::new(StdMutex::new(HashMap::new())),
        subtask_aborts: Arc::new(StdMutex::new(HashMap::new())),
    };
    rt.load_all_blocking(tasks).await;
    rt.recover_interrupted_blocking(tasks).await;
}

impl CollabRuntime {
    pub fn new(home: &Path) -> Self {
        let runtime = Self {
            home: home.to_path_buf(),
            tasks: Arc::new(Mutex::new(HashMap::new())),
            abort_handles: Arc::new(Mutex::new(HashMap::new())),
            queues: Arc::new(Mutex::new(HashMap::new())),
            claims: Arc::new(Mutex::new(HashMap::new())),
            locks: Arc::new(Mutex::new(HashMap::new())),
            event_callback: Arc::new(Mutex::new(None)),
            process_managers: Arc::new(Mutex::new(HashMap::new())),
            dirty: Arc::new(AtomicBool::new(false)),
            save_notify: Arc::new(Notify::new()),
            cancelled: Arc::new(StdMutex::new(HashMap::new())),
            broadcast_throttle: Arc::new(StdMutex::new(HashMap::new())),
            pending_directives: Arc::new(StdMutex::new(HashMap::new())),
            subtask_aborts: Arc::new(StdMutex::new(HashMap::new())),
        };
        // 异步初始化：加载并恢复中断的任务。
        let tasks_clone = Arc::clone(&runtime.tasks);
        let home_clone = home.to_path_buf();
        tokio::spawn(async move {
            load_and_recover(&tasks_clone, &home_clone).await;
        });
        // 后台落盘循环：把高频事件写入合流成去抖的整文件快照写。
        let tasks_clone = Arc::clone(&runtime.tasks);
        let home_clone = runtime.home.clone();
        let notify = Arc::clone(&runtime.save_notify);
        let dirty = Arc::clone(&runtime.dirty);
        tokio::spawn(async move {
            Self::save_loop(tasks_clone, home_clone, notify, dirty).await;
        });
        runtime
    }

    /// 后台去抖落盘循环：150ms 去抖，合并同一窗口内的所有改动为一次快照写。
    async fn save_loop(
        tasks: Arc<Mutex<HashMap<String, CollabTask>>>,
        home: PathBuf,
        notify: Arc<Notify>,
        dirty: Arc<AtomicBool>,
    ) {
        loop {
            notify.notified().await;
            tokio::time::sleep(Duration::from_millis(150)).await;
            loop {
                if !dirty.swap(false, Ordering::SeqCst) {
                    break;
                }
                Self::save_all_blocking(&tasks, &home).await;
            }
        }
    }

    /// 标记有未落盘改动并唤醒后台写盘（去抖合并）。
    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::SeqCst);
        self.save_notify.notify_one();
    }

    /// 同步落盘（终端状态/删除等关键路径用，立即持久化）。
    async fn flush(&self) {
        self.dirty.store(false, Ordering::SeqCst);
        Self::save_all_blocking(&self.tasks, &self.home).await;
    }

    /// 设置事件推送回调。由 web.rs 在初始化时调用，绑定到当前 session 的 ConnectionContext。
    pub async fn set_event_callback<F>(&self, f: F)
    where
        F: Fn(&str, serde_json::Value) + Send + Sync + 'static,
    {
        let mut cb = self.event_callback.lock().await;
        *cb = Some(Box::new(f));
    }

    /// 记录一个任务的共享输入队列（agent_id → queue）。
    pub async fn set_queues(&self, task_id: &str, queues: AgentQueues) {
        self.queues.lock().await.insert(task_id.to_owned(), queues);
    }

    /// 移除一个任务的共享队列（任务结束/取消时清理）。
    pub async fn remove_queues(&self, task_id: &str) {
        self.queues.lock().await.remove(task_id);
    }

    /// 取得/创建任务的文件认领表（写文件前校验用）。
    pub async fn claims_for(&self, task_id: &str) -> FileClaims {
        self.claims
            .lock()
            .await
            .entry(task_id.to_owned())
            .or_insert_with(|| Arc::new(StdMutex::new(HashMap::new())))
            .clone()
    }

    /// 尝试认领文件写入权。已被他人占用时返回冲突角色 id。
    pub fn try_claim_file(&self, claims: &FileClaims, agent_id: &str, path: &str) -> Result<(), String> {
        let key = normalize_claim_path(path);
        let mut map = claims.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match map.get(&key) {
            Some(owner) if owner != agent_id => Err(format!(
                "文件 `{key}` 已被角色 `{owner}` 认领。请改写其他文件，或用 message_agent 请对方释放/合并。"
            )),
            Some(_) => Ok(()),
            None => {
                map.insert(key, agent_id.to_owned());
                Ok(())
            }
        }
    }

    /// 检查写权限：未认领则自动认领；被他人占用则拒绝。
    pub fn check_write_claim(&self, claims: &FileClaims, agent_id: &str, path: &str) -> Result<(), String> {
        self.try_claim_file(claims, agent_id, path)
    }

    /// 取得/创建任务的文件写锁表。
    pub async fn locks_for(&self, task_id: &str) -> FileLocks {
        self.locks
            .lock()
            .await
            .entry(task_id.to_owned())
            .or_insert_with(|| Arc::new(StdMutex::new(HashMap::new())))
            .clone()
    }

    /// 尝试获取写锁（带租约）。冲突时返回结构化拒绝：owner、剩余等待估计、是否已达拒绝上限。
    pub fn try_lock_write(
        &self,
        locks: &FileLocks,
        agent_id: &str,
        path: &str,
        lease_ms: u64,
        deny_limit: u32,
    ) -> Result<(), String> {
        let key = normalize_claim_path(path);
        let now = current_ms();
        let mut map = locks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // 租约过期：崩溃/取消后自动可抢占。
        if let Some(existing) = map.get(&key) {
            if existing.expires_at_ms < now {
                map.remove(&key);
            }
        }
        match map.get(&key).cloned() {
            Some(existing) if existing.owner != agent_id => {
                let remaining = existing.expires_at_ms.saturating_sub(now);
                let denials = existing.denials.saturating_add(1);
                if let Some(slot) = map.get_mut(&key) {
                    slot.denials = denials;
                }
                let lease = lease_ms.max(1);
                if denials >= deny_limit {
                    Err(format!(
                        "LOCK_DENIED path `{key}` owned by `{}`. 已拒绝 {denials} 次。请改写其他文件或 message 对方；不要原地重试同一路径。",
                        existing.owner
                    ))
                } else {
                    Err(format!(
                        "LOCK_BUSY path `{key}` owned by `{}`，估计等待 ≤{ms}ms。可选：改写其他文件 / 稍后重试 / 写 `.coomi/collab/merge/{key}.patch` 请求托管合并。",
                        existing.owner,
                        ms = remaining.min(lease)
                    ))
                }
            }
            Some(existing) if existing.owner == agent_id => {
                // 自己续租
                if let Some(slot) = map.get_mut(&key) {
                    slot.expires_at_ms = now + lease_ms.max(1_000);
                }
                Ok(())
            }
            _ => {
                map.insert(
                    key,
                    FileLock {
                        owner: agent_id.to_owned(),
                        acquired_at_ms: now,
                        expires_at_ms: now + lease_ms.max(1_000),
                        denials: 0,
                    },
                );
                Ok(())
            }
        }
    }

    /// 续租（长事务中定期调用，避免误杀）。
    pub fn renew_lock(&self, locks: &FileLocks, agent_id: &str, path: &str, lease_ms: u64) -> bool {
        let key = normalize_claim_path(path);
        let now = current_ms();
        let mut map = locks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match map.get_mut(&key) {
            Some(existing) if existing.owner == agent_id => {
                existing.expires_at_ms = now + lease_ms.max(1_000);
                true
            }
            _ => false,
        }
    }

    /// 释放某角色持有的全部写锁（Agent 结束/取消）。
    pub fn release_agent_locks(&self, locks: &FileLocks, agent_id: &str) {
        let mut map = locks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        map.retain(|_, lock| lock.owner != agent_id);
    }

    /// 任务级清空写锁（取消/删除）。
    pub async fn remove_locks(&self, task_id: &str) {
        self.locks.lock().await.remove(task_id);
        self.claims.lock().await.remove(task_id);
    }

    /// 任务结束/删除时清理认领表。
    pub async fn remove_claims(&self, task_id: &str) {
        self.claims.lock().await.remove(task_id);
        self.locks.lock().await.remove(task_id);
    }

    /// 记录任务的进程管理器，供取消时精确终止该任务启动的长进程。
    pub async fn register_process_manager(&self, task_id: &str, manager: Arc<ProcessManager>) {
        self.process_managers
            .lock()
            .await
            .insert(task_id.to_owned(), manager);
    }

    /// 清理任务的进程管理器（任务结束/取消时调用）。
    pub async fn remove_process_manager(&self, task_id: &str) {
        self.process_managers.lock().await.remove(task_id);
    }

    /// 把消息推给某个角色（或 all）的输入队列；返回是否有匹配的队列。
    pub async fn push_message(&self, task_id: &str, agent_id: &str, content: &str) -> bool {
        let queues = self.queues.lock().await;
        let Some(map) = queues.get(task_id) else {
            return false;
        };
        let map = map.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if agent_id == "all" {
            let mut delivered = false;
            for queue in map.values() {
                queue.push(content.to_owned());
                delivered = true;
            }
            return delivered;
        }
        let Some(queue) = map.get(agent_id) else {
            return false;
        };
        queue.push(content.to_owned());
        true
    }

    fn store_path(&self) -> PathBuf {
        self.home.join("collab").join("tasks.json")
    }

    async fn load_all_blocking(&self, tasks: &Arc<Mutex<HashMap<String, CollabTask>>>) {
        let path = self.store_path();
        if !path.exists() {
            return;
        }
        let Ok(bytes) = fs::read(&path) else {
            return;
        };
        let Ok(tasks_vec) = serde_json::from_slice::<Vec<CollabTask>>(&bytes) else {
            return;
        };
        let mut map = HashMap::new();
        for task in tasks_vec {
            map.insert(task.id.clone(), task);
        }
        let mut guard = tasks.lock().await;
        *guard = map;
    }

    async fn recover_interrupted_blocking(&self, tasks: &Arc<Mutex<HashMap<String, CollabTask>>>) {
        let all = {
            let guard = tasks.lock().await;
            guard.clone()
        };
        for (id, task) in all {
            if matches!(
                task.status,
                CollabTaskStatus::Running | CollabTaskStatus::Starting
            ) {
                Self::update_status_inner(
                    tasks,
                    &self.abort_handles,
                    &id,
                    CollabTaskStatus::Interrupted,
                    None,
                    &self.home,
                )
                .await;
            }
        }
    }

    async fn save_all_blocking(tasks: &Arc<Mutex<HashMap<String, CollabTask>>>, home: &Path) {
        let vec: Vec<CollabTask> = {
            let map = tasks.lock().await;
            map.values().cloned().collect()
        };
        let path = home.join("collab").join("tasks.json");
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // 原子写入：紧凑 JSON（非 pretty），先写临时文件再 rename，避免写入中途崩溃损坏 tasks.json。
        if let Ok(bytes) = serde_json::to_vec(&vec) {
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, bytes).is_ok() {
                let _ = fs::rename(&tmp, &path);
            }
        }
    }

    async fn update_status_inner(
        tasks: &Arc<Mutex<HashMap<String, CollabTask>>>,
        _abort_handles: &Arc<Mutex<HashMap<String, Vec<AbortHandle>>>>,
        id: &str,
        status: CollabTaskStatus,
        summary: Option<&str>,
        home: &Path,
    ) {
        let mut map = tasks.lock().await;
        if let Some(task) = map.get_mut(id) {
            task.status = status.clone();
            task.updated_at_ms = current_ms();
            if status.is_terminal() {
                task.finished_at_ms = Some(task.updated_at_ms);
            }
            if let Some(s) = summary {
                task.summary = Some(s.to_string());
            }
        }
        drop(map);
        Self::save_all_blocking(tasks, home).await;
    }

    pub async fn list_tasks(&self) -> Vec<CollabTask> {
        let tasks = self.tasks.lock().await;
        let mut vec: Vec<CollabTask> = tasks.values().cloned().collect();
        vec.sort_by_key(|t| std::cmp::Reverse(t.created_at_ms));
        vec
    }

    /// 列表摘要：去掉 events / agent output 等重字段，供任务中心轮询。
    pub async fn list_task_summaries(&self) -> Vec<Value> {
        let tasks = self.tasks.lock().await;
        let mut rows: Vec<(u64, Value)> = tasks
            .values()
            .map(|task| {
                let agents: Vec<Value> = task
                    .agents
                    .iter()
                    .map(|a| {
                        json!({
                            "id": a.id,
                            "name": a.name,
                            "status": a.status,
                            "currentMessage": a.current_message,
                        })
                    })
                    .collect();
                let settings = serde_json::to_value(&task.settings).unwrap_or(Value::Null);
                let roles = settings
                    .get("roles")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                let mode = settings
                    .get("mode")
                    .cloned()
                    .unwrap_or_else(|| json!("parallel"));
                let orchestration = task.orchestration.as_ref().map(|o| {
                    json!({
                        "phase": o.phase,
                        "subtaskCount": o.subtasks.len(),
                        "subtasks": o.subtasks.iter().map(|s| json!({
                            "id": s.id,
                            "agentId": s.agent_id,
                            "status": s.status,
                        })).collect::<Vec<_>>(),
                    })
                });
                let last = task
                    .messages
                    .last()
                    .map(|m| m.content.chars().take(120).collect::<String>())
                    .unwrap_or_default();
                (
                    task.created_at_ms,
                    json!({
                        "id": task.id,
                        "sessionId": task.session_id,
                        "task": task.task.chars().take(400).collect::<String>(),
                        "title": task.title,
                        "cwd": task.cwd,
                        "status": task.status,
                        "mode": mode,
                        "createdAt": task.created_at_ms,
                        "updatedAt": task.updated_at_ms,
                        "finishedAt": task.finished_at_ms,
                        "summary": task.summary,
                        "roles": roles,
                        "agents": agents,
                        "orchestration": orchestration,
                        "preview": last,
                        "artifactCount": task.artifacts.len(),
                        "messageCount": task.messages.len(),
                        "retryCount": task.retry_count,
                    }),
                )
            })
            .collect();
        rows.sort_by_key(|(ts, _)| std::cmp::Reverse(*ts));
        rows.into_iter().map(|(_, row)| row).collect()
    }

    /// 单任务轻量状态：轮询用，剥掉 events / output / activities。
    pub async fn task_summary(&self, id: &str) -> Option<Value> {
        let tasks = self.tasks.lock().await;
        let task = tasks.get(id)?;
        let agents: Vec<Value> = task
            .agents
            .iter()
            .map(|a| {
                json!({
                    "id": a.id,
                    "name": a.name,
                    "status": a.status,
                    "currentMessage": a.current_message,
                })
            })
            .collect();
        let settings = serde_json::to_value(&task.settings).unwrap_or(Value::Null);
        let orchestration = task.orchestration.as_ref().map(|o| {
            json!({
                "phase": o.phase,
                "subtasks": o.subtasks.iter().map(|s| json!({
                    "id": s.id,
                    "agentId": s.agent_id,
                    "status": s.status,
                })).collect::<Vec<_>>(),
                "mergeResult": o.merge_result,
            })
        });
        Some(json!({
            "id": task.id,
            "status": task.status,
            "mode": settings.get("mode").cloned().unwrap_or_else(|| json!("parallel")),
            "title": task.title,
            "updatedAt": task.updated_at_ms,
            "roles": settings.get("roles").cloned().unwrap_or_else(|| json!([])),
            "agents": agents,
            "orchestration": orchestration,
            "messageCount": task.messages.len(),
            "artifactCount": task.artifacts.len(),
            "preview": task.messages.last().map(|m| m.content.chars().take(120).collect::<String>()).unwrap_or_default(),
        }))
    }

    pub async fn get_task(&self, id: &str) -> Option<CollabTask> {
        let tasks = self.tasks.lock().await;
        tasks.get(id).cloned()
    }

    pub async fn create_task(
        &self,
        session_id: &str,
        task: &str,
        title: &str,
        cwd: &str,
        settings: CollabSettings,
    ) -> CollabTask {
        let id = uuid::Uuid::new_v4().to_string();
        let now = current_ms();
        let collab_task = CollabTask {
            id: id.clone(),
            session_id: session_id.to_owned(),
            task: task.to_owned(),
            title: title.to_owned(),
            cwd: cwd.to_owned(),
            settings,
            status: CollabTaskStatus::Queued,
            created_at_ms: now,
            updated_at_ms: now,
            finished_at_ms: None,
            agents: Vec::new(),
            messages: Vec::new(),
            team_messages: Vec::new(),
            events: Vec::new(),
            artifacts: Vec::new(),
            summary: None,
            retry_count: 0,
            orchestration: None,
        };
        let mut tasks = self.tasks.lock().await;
        tasks.insert(id.clone(), collab_task.clone());
        drop(tasks);
        Self::save_all_blocking(&self.tasks, &self.home).await;
        collab_task
    }

    pub async fn delete_task(&self, id: &str) -> bool {
        let mut tasks = self.tasks.lock().await;
        let existed = tasks.remove(id).is_some();
        drop(tasks);
        if existed {
            Self::save_all_blocking(&self.tasks, &self.home).await;
            self.remove_queues(id).await;
            self.remove_claims(id).await;
        }
        existed
    }

    /// 真实取消：终止所有活跃 agent handle，更新状态。
    pub async fn cancel_task(&self, id: &str) -> bool {
        let cancellable = self.get_task(id).await.is_some_and(|task| {
            matches!(
                task.status,
                CollabTaskStatus::Draft
                    | CollabTaskStatus::Queued
                    | CollabTaskStatus::Starting
                    | CollabTaskStatus::Running
            )
        });
        if !cancellable {
            return false;
        }
        // 置取消信号：轮次循环据此即时退出，不再只依赖协作式 abort。
        self.mark_cancelled(id);
        let mut handles = {
            let mut ah = self.abort_handles.lock().await;
            ah.remove(id)
        };
        if let Some(mut h) = handles.take() {
            for handle in h.iter_mut() {
                handle.abort();
            }
        }
        {
            let mut ah = self.abort_handles.lock().await;
            ah.remove(id);
        }
        // 终止该任务启动的长进程（local_shell 编译/安装等），避免取消后后台进程残留。
        if let Some(manager) = self.process_managers.lock().await.remove(id) {
            manager.terminate_all().await;
        }
        // 释放该任务全部文件写锁（D 取消原子性：锁释放 + 唤醒由后续消息注入完成）。
        self.remove_locks(id).await;
        self.clear_directives(id);
        // 把仍标记为 running 的 agent 收尾为 cancelled，避免前端一直显示「执行中」。
        {
            let mut tasks = self.tasks.lock().await;
            if let Some(task) = tasks.get_mut(id) {
                for agent in task.agents.iter_mut() {
                    if agent.status == "running" || agent.status == "starting" {
                        agent.status = "cancelled".to_string();
                        agent.finished_at_ms = Some(current_ms());
                    }
                }
                if let Some(orch) = task.orchestration.as_mut() {
                    for st in orch.subtasks.iter_mut() {
                        if matches!(st.status.as_str(), "pending" | "starting" | "running") {
                            st.status = "cancelled".to_string();
                        }
                    }
                    if orch.phase != "done" {
                        orch.phase = "done".to_string();
                    }
                }
                task.updated_at_ms = current_ms();
            }
        }
        Self::update_status_inner(
            &self.tasks,
            &self.abort_handles,
            id,
            CollabTaskStatus::Cancelled,
            Some("cancelled by user"),
            &self.home,
        )
        .await;
        self.remove_queues(id).await;
        self.remove_claims(id).await;
        true
    }

    /// 追加一条事件到持久化任务，并通过回调推送给前端。
    pub async fn append_event(&self, id: &str, mut event: serde_json::Value) {
        if event.get("task_id").is_none() {
            event["task_id"] = serde_json::json!(id);
        }
        if event.get("ts").is_none() {
            event["ts"] = serde_json::json!(current_ms() as f64 / 1000.0);
        }
        // 追加到内存并去抖落盘（不再每个事件整文件重写）。
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            task.events.push(event.clone());
            if task.events.len() > MAX_EVENTS {
                // 丢弃最旧事件，但尽量保留最近的 failed/error 关键事件。
                let mut keep_tail: Vec<serde_json::Value> = task
                    .events
                    .iter()
                    .rev()
                    .take(CRITICAL_EVENT_KEEP)
                    .filter(|e| {
                        let et = e.get("event_type").and_then(|v| v.as_str()).unwrap_or("");
                        et == "agent_error"
                            || et == "collab_subtask_status"
                            || et == "collab_finished"
                            || e.get("status").and_then(|v| v.as_str()) == Some("failed")
                            || e.get("status").and_then(|v| v.as_str()) == Some("timeout")
                    })
                    .cloned()
                    .collect();
                keep_tail.reverse();
                let dropped = task.events.len() - MAX_EVENTS;
                let mut next: Vec<serde_json::Value> = Vec::with_capacity(MAX_EVENTS);
                next.push(serde_json::json!({
                    "event_type": "events_truncated",
                    "dropped": dropped,
                    "ts": current_ms() as f64 / 1000.0,
                }));
                let start = dropped.min(task.events.len());
                for e in task.events.drain(start..) {
                    next.push(e);
                }
                // 保证关键事件不在截断中丢失（去重按 event 内容粗粒度）。
                for e in keep_tail {
                    if !next.iter().any(|x| {
                        x.get("event_type") == e.get("event_type")
                            && x.get("agent_id") == e.get("agent_id")
                            && x.get("status") == e.get("status")
                            && x.get("ts") == e.get("ts")
                    }) {
                        if next.len() >= MAX_EVENTS {
                            next.remove(1);
                        }
                        next.push(e);
                    }
                }
                task.events = next;
            }
            task.updated_at_ms = current_ms();
        }
        drop(tasks);
        self.mark_dirty();
        // 推送回调。
        if let Some(cb) = &*self.event_callback.lock().await {
            cb(id, event);
        }
    }

    /// 注册一个 abort handle，用于后续取消。
    pub async fn register_abort(&self, id: &str, handle: AbortHandle) {
        let mut ah = self.abort_handles.lock().await;
        ah.entry(id.to_owned())
            .or_insert_with(Vec::new)
            .push(handle);
    }

    /// 清理某个任务的所有 abort handles（任务完成后调用）。
    pub async fn release_aborts(&self, id: &str) {
        let mut ah = self.abort_handles.lock().await;
        ah.remove(id);
    }

    /// 更新 agent 状态。
    /// Append a streamed delta to an agent output without losing prior chunks.
    /// 只改内存、不落盘：前端靠轮询 get 实时可见，落盘交给 agent 完成时的统一保存，
    /// 避免每个 token 都整文件重写。
    pub async fn append_agent_output(&self, id: &str, agent_id: &str, content: &str) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            if let Some(agent) = task.agents.iter_mut().find(|agent| agent.id == agent_id) {
                agent.output.push_str(content);
            }
            task.updated_at_ms = current_ms();
        }
    }

    /// 同步版：供流式回调（无法 await）直接在内存里追加文本，供前端轮询看到实时进度。
    /// 同步版：仅更新卡片上的实时状态提示（不追加输出正文）。
    pub fn append_agent_message_sync(&self, id: &str, agent_id: &str, message: &str) {
        if let Ok(mut tasks) = self.tasks.try_lock() {
            if let Some(task) = tasks.get_mut(id) {
                if let Some(agent) = task.agents.iter_mut().find(|a| a.id == agent_id) {
                    agent.current_message = message.to_owned();
                }
                task.updated_at_ms = current_ms();
            }
        }
        self.mark_dirty();
    }

    pub fn append_agent_output_sync(&self, id: &str, agent_id: &str, content: &str) {
        if let Ok(mut tasks) = self.tasks.try_lock() {
            if let Some(task) = tasks.get_mut(id) {
                if let Some(agent) = task.agents.iter_mut().find(|agent| agent.id == agent_id) {
                    agent.output.push_str(content);
                    agent.current_message = format!("输出: {}", content.chars().take(120).collect::<String>());
                }
                task.updated_at_ms = current_ms();
            }
        }
        self.mark_dirty();
    }

    /// 同步版：登记一个文件产物（角色 write/edit/patch 的文件），供前端「产物」Tab 展示。
    pub fn append_artifact_sync(&self, id: &str, agent_id: &str, action: &str, path: &str) {
        if path.trim().is_empty() {
            return;
        }
        let now = current_ms();
        if let Ok(mut tasks) = self.tasks.try_lock() {
            if let Some(task) = tasks.get_mut(id) {
                // 同一 agent 对同一路径的重复操作只保留最后一条，但保留首次创建时间。
                let created = task
                    .artifacts
                    .iter()
                    .find(|a| a.agent_id == agent_id && a.path == path)
                    .map(|a| a.created_at_ms)
                    .unwrap_or(now);
                task.artifacts.retain(|a| !(a.agent_id == agent_id && a.path == path));
                task.artifacts.push(CollabArtifact {
                    id: uuid::Uuid::new_v4().to_string(),
                    agent_id: agent_id.to_owned(),
                    kind: action.to_owned(),
                    name: path.to_owned(),
                    action: action.to_owned(),
                    path: path.to_owned(),
                    content: String::new(),
                    created_at_ms: created,
                    modified_at_ms: now,
                });
                task.updated_at_ms = now;
            }
        }
        self.mark_dirty();
    }

    /// 同步版：流式追加思考过程。
    pub fn append_agent_reasoning_sync(&self, id: &str, agent_id: &str, content: &str) {
        if let Ok(mut tasks) = self.tasks.try_lock() {
            if let Some(task) = tasks.get_mut(id) {
                if let Some(agent) = task.agents.iter_mut().find(|agent| agent.id == agent_id) {
                    agent.reasoning.push_str(content);
                    agent.current_message = format!("思考: {}", content.chars().take(120).collect::<String>());
                }
                task.updated_at_ms = current_ms();
            }
        }
        self.mark_dirty();
    }

    /// 同步版：流式追加工具调用记录。
    pub fn append_agent_tool_sync(&self, id: &str, agent_id: &str, tool: serde_json::Value) {
        if let Ok(mut tasks) = self.tasks.try_lock() {
            if let Some(task) = tasks.get_mut(id) {
                if let Some(agent) = task.agents.iter_mut().find(|agent| agent.id == agent_id) {
                    if let Some(existing) = agent
                        .tools
                        .iter_mut()
                        .find(|t| t.get("id") == tool.get("id"))
                    {
                        *existing = tool;
                    } else {
                        agent.tools.push(tool);
                    }
                }
                task.updated_at_ms = current_ms();
            }
        }
    }

    /// Append a streamed reasoning delta to an agent's thinking transcript.
    pub async fn append_agent_reasoning(&self, id: &str, agent_id: &str, content: &str) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            if let Some(agent) = task.agents.iter_mut().find(|agent| agent.id == agent_id) {
                agent.reasoning.push_str(content);
            }
            task.updated_at_ms = current_ms();
        }
    }

    pub async fn update_agent_status(
        &self,
        id: &str,
        agent_id: &str,
        status: &str,
        output: Option<&str>,
        error: Option<&str>,
    ) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            if let Some(agent) = task.agents.iter_mut().find(|a| a.id == agent_id) {
                agent.status = status.to_owned();
                if let Some(o) = output {
                    agent.output = o.to_string();
                }
                if let Some(e) = error {
                    agent.error = Some(e.to_string());
                }
                if status == "completed" || status == "failed" {
                    agent.finished_at_ms = Some(current_ms());
                }
            }
            task.updated_at_ms = current_ms();
        }
        drop(tasks);
        self.mark_dirty();
    }

    /// 一轮结束时一次性写入 agent 的最终状态、输出与思考过程（只落盘一次）。
    pub async fn finish_agent(
        &self,
        id: &str,
        agent_id: &str,
        status: &str,
        output: &str,
        reasoning: &str,
        error: Option<&str>,
    ) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            if let Some(agent) = task.agents.iter_mut().find(|a| a.id == agent_id) {
                agent.status = status.to_owned();
                agent.output = output.to_owned();
                agent.reasoning = reasoning.to_owned();
                if let Some(e) = error {
                    agent.error = Some(e.to_string());
                }
                if status == "completed" || status == "failed" {
                    agent.finished_at_ms = Some(current_ms());
                }
                agent.current_message = match status {
                    "completed" => "已完成".to_owned(),
                    "failed" => error.map(|e| e.to_owned()).unwrap_or_else(|| "失败".to_owned()),
                    _ => agent.current_message.clone(),
                };
            }
            task.updated_at_ms = current_ms();
        }
        drop(tasks);
        self.mark_dirty();
    }

    /// 追加消息记录。
    pub async fn add_agents(&self, id: &str, agents: Vec<CollabAgent>) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            task.agents = agents;
            task.updated_at_ms = current_ms();
        }
        drop(tasks);
        self.mark_dirty();
    }

    pub async fn append_message(
        &self,
        id: &str,
        from: &str,
        to: &str,
        content: &str,
    ) -> CollabMessage {
        let msg_id = uuid::Uuid::new_v4().to_string();
        let msg = CollabMessage {
            id: msg_id.clone(),
            from: from.to_owned(),
            to: to.to_owned(),
            content: collapse_blank_lines(content),
            ts: current_ms() as f64 / 1000.0,
        };
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            task.messages.push(msg.clone());
            task.updated_at_ms = current_ms();
        }
        drop(tasks);
        self.mark_dirty();
        msg
    }

    /// 有序活动时间线：追加/合并一条活动（思考/文本合并到前一条同类型，工具按 ref_id 合并 start/finish）。
    #[allow(clippy::too_many_arguments)]
    pub fn append_activity_sync(
        &self,
        id: &str,
        agent_id: &str,
        kind: &str,
        content: &str,
        tool_name: Option<&str>,
        tool_status: Option<&str>,
        ref_id: Option<&str>,
    ) {
        if let Ok(mut tasks) = self.tasks.try_lock() {
            if let Some(task) = tasks.get_mut(id) {
                if let Some(agent) = task.agents.iter_mut().find(|a| a.id == agent_id) {
                    if kind == "reasoning" || kind == "text" {
                        if let Some(last) = agent.activities.last_mut() {
                            if last.kind == kind {
                                last.content.push_str(content);
                                last.ts_ms = current_ms();
                                task.updated_at_ms = current_ms();
                                return;
                            }
                        }
                    } else if kind == "tool" {
                        if let Some(cid) = ref_id {
                            if let Some(existing) = agent
                                .activities
                                .iter_mut()
                                .find(|a| a.ref_id.as_deref() == Some(cid))
                            {
                                existing.content = content.to_owned();
                                existing.tool_status = tool_status.map(str::to_owned);
                                existing.ts_ms = current_ms();
                                task.updated_at_ms = current_ms();
                                return;
                            }
                        }
                    }
                    agent.activities.push(AgentActivity {
                        id: uuid::Uuid::new_v4().to_string(),
                        kind: kind.to_owned(),
                        ts_ms: current_ms(),
                        content: content.to_owned(),
                        tool_name: tool_name.map(str::to_owned),
                        tool_status: tool_status.map(str::to_owned),
                        ref_id: ref_id.map(str::to_owned),
                    });
                    task.updated_at_ms = current_ms();
                }
            }
        }
        self.mark_dirty();
    }

    /// 记录一条角色间消息（team_inbox 收件箱）。
    pub fn record_team_message_sync(&self, id: &str, from: &str, to: &str, content: &str) {
        let content = collapse_blank_lines(content);
        if content.is_empty() {
            return;
        }
        if let Ok(mut tasks) = self.tasks.try_lock() {
            if let Some(task) = tasks.get_mut(id) {
                task.team_messages.push(TeamMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    from: from.to_owned(),
                    to: to.to_owned(),
                    content,
                    ts: current_ms() as f64 / 1000.0,
                    read: false,
                });
                task.updated_at_ms = current_ms();
            }
        }
        self.mark_dirty();
    }

    /// 同步查询文件活动日志（team_files 工具）。
    pub fn query_files_sync(
        &self,
        id: &str,
        agent_id: &str,
        path: &str,
        action: &str,
        limit: usize,
    ) -> Value {
        let Ok(tasks) = self.tasks.try_lock() else {
            return json!([]);
        };
        let Some(task) = tasks.get(id) else {
            return json!([]);
        };
        let mut items: Vec<&CollabArtifact> = task
            .artifacts
            .iter()
            .filter(|a| agent_id.is_empty() || a.agent_id == agent_id)
            .filter(|a| path.is_empty() || a.path == path)
            .filter(|a| action.is_empty() || a.action == action)
            .collect();
        items.sort_by_key(|a| std::cmp::Reverse(a.modified_at_ms));
        items.truncate(limit.clamp(1, 200));
        json!(items)
    }

    /// 同步查询团队状态（team_status 工具）。
    pub fn query_status_sync(&self, id: &str, agent_id: &str) -> Value {
        let Ok(tasks) = self.tasks.try_lock() else {
            return json!({});
        };
        let Some(task) = tasks.get(id) else {
            return json!({});
        };
        let summarize = |agent: &CollabAgent| -> Value {
            let recent_files: Vec<&CollabArtifact> = task
                .artifacts
                .iter()
                .filter(|a| a.agent_id == agent.id)
                .collect();
            json!({
                "agent_id": agent.id,
                "name": agent.name,
                "status": agent.status,
                "current_message": agent.current_message,
                "output_tail": tail_chars(&agent.output, 200),
                "recent_tools": agent.tools.iter().rev().take(3).cloned().collect::<Vec<_>>(),
                "recent_files": recent_files.iter().rev().take(5).map(|a| json!({"action": a.action, "path": a.path})).collect::<Vec<_>>(),
            })
        };
        if agent_id.is_empty() {
            json!(task.agents.iter().map(summarize).collect::<Vec<_>>())
        } else {
            task.agents
                .iter()
                .find(|a| a.id == agent_id)
                .map(summarize)
                .unwrap_or_else(|| json!({}))
        }
    }

    /// 标记任务为已请求取消（轮次循环据此即时退出）。
    pub fn mark_cancelled(&self, id: &str) {
        self.cancelled
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.to_owned(), true);
    }

    pub fn is_cancelled(&self, id: &str) -> bool {
        self.cancelled
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .copied()
            .unwrap_or(false)
    }

    pub fn clear_cancelled(&self, id: &str) {
        self.cancelled
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
    }

    /// 广播节流：同一任务 2s 内相同负载 hash 只放行一次（D 唤醒风暴）。
    /// 返回 false 表示应丢弃本次广播（仍会记入 messages）。
    pub fn allow_broadcast(&self, task_id: &str, content: &str) -> bool {
        let now = current_ms();
        let hash = {
            let mut h: u64 = 0xcbf29ce484222325;
            for b in content.as_bytes() {
                h ^= u64::from(*b);
                h = h.wrapping_mul(0x100000001b3);
            }
            h
        };
        let mut map = self
            .broadcast_throttle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((last_ms, last_hash)) = map.get(task_id) {
            if *last_hash == hash && now.saturating_sub(*last_ms) < 2_000 {
                return false;
            }
        }
        map.insert(task_id.to_owned(), (now, hash));
        true
    }

    /// 记录一条待注入指令（角色尚未运行 / 规划阶段 / 超时后等待重试时使用）。
    pub fn queue_directive(&self, task_id: &str, agent_id: &str, content: &str) {
        let mut map = self
            .pending_directives
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = map
            .entry(task_id.to_owned())
            .or_default()
            .entry(agent_id.to_owned())
            .or_default();
        entry.push(content.to_owned());
    }

    /// 取出并消费某角色的待注入指令（agent 开始执行时调用）。
    pub fn take_directives(&self, task_id: &str, agent_id: &str) -> Vec<String> {
        let mut map = self
            .pending_directives
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.get_mut(task_id)
            .and_then(|agents| agents.remove(agent_id))
            .unwrap_or_default()
    }

    /// 清理任务的待注入指令。
    pub fn clear_directives(&self, task_id: &str) {
        self.pending_directives
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(task_id);
    }

    /// 硬打断：abort 所有已注册子任务句柄（调用方仍需 abort abort_handles）。
    pub async fn interrupt_agents(&self, task_id: &str) {
        {
            let mut sub = self
                .subtask_aborts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(handles) = sub.get_mut(task_id) {
                for h in handles.iter_mut() {
                    h.abort();
                }
                handles.clear();
            }
        }
        {
            let mut ah = self.abort_handles.lock().await;
            if let Some(handles) = ah.get_mut(task_id) {
                for h in handles.iter_mut() {
                    h.abort();
                }
            }
        }
        if let Some(manager) = self.process_managers.lock().await.remove(task_id) {
            manager.terminate_all().await;
        }
    }

    /// 注册子任务 abort 句柄（超时时可精确 abort）。
    pub async fn register_subtask_abort(&self, task_id: &str, handle: AbortHandle) {
        let mut map = self
            .subtask_aborts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.entry(task_id.to_owned()).or_default().push(handle);
    }

    /// 任务结束后清理子任务 abort 表（句柄本身在 cancel 时已 abort）。
    pub fn clear_subtask_aborts(&self, task_id: &str) {
        self.subtask_aborts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(task_id);
    }

    /// 重试前重置任务运行态：保留 messages/events/artifacts/summary 文本，
    /// 清空 agents 列表与 orchestration，使会话数据不丢失。
    pub async fn reset_for_retry(&self, id: &str) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            // 保留 messages / team_messages / events / artifacts / settings / cwd
            task.agents = Vec::new();
            task.orchestration = None;
            task.summary = None;
            task.finished_at_ms = None;
            task.status = CollabTaskStatus::Starting;
            task.updated_at_ms = current_ms();
        }
        drop(tasks);
        self.clear_directives(id);
        self.clear_subtask_aborts(id);
        self.mark_dirty();
        Self::save_all_blocking(&self.tasks, &self.home).await;
    }

    /// 释放某角色在任务上的全部写锁（Agent 结束后调用）。
    pub async fn release_agent_locks_for_task(&self, task_id: &str, agent_id: &str) {
        let locks = self.locks.lock().await;
        if let Some(task_locks) = locks.get(task_id) {
            let mut map = task_locks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            map.retain(|_, lock| lock.owner != agent_id);
        }
    }

    /// 读取/保存创建草稿（后端权威，localStorage 仅即时恢复）。
    pub fn draft_path(&self) -> PathBuf {
        self.home.join("collab").join("drafts.json")
    }

    pub fn load_drafts(&self) -> Vec<serde_json::Value> {
        let path = self.draft_path();
        let Ok(bytes) = fs::read(&path) else {
            return Vec::new();
        };
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    pub fn save_drafts(&self, drafts: &[serde_json::Value]) {
        let path = self.draft_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(drafts) {
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, bytes).is_ok() {
                let _ = fs::rename(&tmp, &path);
            }
        }
    }

    pub fn upsert_draft(&self, draft: serde_json::Value) -> String {
        let mut drafts = self.load_drafts();
        let id = draft
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut d = draft;
        d["id"] = serde_json::json!(id);
        drafts.retain(|x| x.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
        drafts.insert(0, d);
        drafts.truncate(50);
        self.save_drafts(&drafts);
        id
    }

    pub fn delete_draft(&self, id: &str) -> bool {
        let mut drafts = self.load_drafts();
        let before = drafts.len();
        drafts.retain(|x| x.get("id").and_then(|v| v.as_str()) != Some(id));
        if drafts.len() != before {
            self.save_drafts(&drafts);
            true
        } else {
            false
        }
    }

    /// 记录重试次数（重试任务标记为「重试中」）。
    pub async fn set_retry_count(&self, id: &str, count: u32) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            task.retry_count = count;
            task.updated_at_ms = current_ms();
        }
        drop(tasks);
        self.mark_dirty();
    }

    /// 设置/整体替换 orchestrated 编排状态。
    pub async fn set_orchestration(&self, id: &str, orchestration: CollabOrchestration) {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            task.orchestration = Some(orchestration);
            task.updated_at_ms = current_ms();
        }
        drop(tasks);
        self.mark_dirty();
    }

    /// 就地更新 orchestrated 编排状态；不存在时为 no-op。
    pub async fn update_orchestration<F>(&self, id: &str, f: F)
    where
        F: FnOnce(&mut CollabOrchestration),
    {
        let mut tasks = self.tasks.lock().await;
        if let Some(task) = tasks.get_mut(id) {
            if let Some(orch) = task.orchestration.as_mut() {
                f(orch);
                task.updated_at_ms = current_ms();
            }
        }
        drop(tasks);
        self.mark_dirty();
    }

    /// 同步拉取发给某角色的消息（team_inbox 工具）。
    pub fn team_messages_sync(&self, id: &str, agent_id: &str, mark_read: bool) -> Value {
        let Ok(mut tasks) = self.tasks.try_lock() else {
            return json!([]);
        };
        let Some(task) = tasks.get_mut(id) else {
            return json!([]);
        };
        let mut result = Vec::new();
        for m in task.team_messages.iter_mut() {
            if m.to == agent_id && !m.read {
                result.push(json!({"from": m.from, "content": m.content, "ts": m.ts}));
                if mark_read {
                    m.read = true;
                }
            }
        }
        json!(result)
    }

    /// 内部辅助：更新状态并落盘（由 web.rs 调用）。
    pub async fn update_status_blocking(
        &self,
        id: &str,
        status: CollabTaskStatus,
        summary: Option<&str>,
    ) {
        Self::update_status_inner(
            &self.tasks,
            &self.abort_handles,
            id,
            status,
            summary,
            &self.home,
        )
        .await;
    }

    pub async fn save_all(&self) {
        self.flush().await;
    }
}

pub fn current_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 路径归一：去空白、统一分隔符、去掉前导 ./，作为认领 key。
fn normalize_claim_path(path: &str) -> String {
    let p = path.trim().replace('\\', "/");
    let p = p.strip_prefix("./").unwrap_or(&p);
    p.trim_end_matches('/').to_owned()
}
