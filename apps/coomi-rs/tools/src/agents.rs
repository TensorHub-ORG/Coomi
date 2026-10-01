use async_trait::async_trait;
use coomi_engine::Agent;
use coomi_engine::AgentEvent;
use coomi_engine::AgentObserver;
use coomi_engine::ApprovalHandler;
use coomi_engine::ChatMessage;
use coomi_engine::InputQueue;
use coomi_engine::Session;
use coomi_engine::ToolCall;
use coomi_engine::UserInputRequest;
use coomi_engine::UserInputResponse;
use coomi_security::AccessMode;
use coomi_security::HookRunner;
use coomi_security::SecurityPolicy;
use coomi_services::HttpModelProvider;
use coomi_services::MemoryManager;
use coomi_services::ProviderConfig;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;
use uuid::Uuid;

use crate::CoreTools;
use crate::ProcessManager;

#[derive(Clone, Debug)]
pub struct AgentSnapshot {
    pub id: String,
    pub status: String,
    pub task: String,
    pub output: String,
    pub elapsed_ms: u128,
}

#[derive(Clone)]
pub struct ConfiguredSubAgent {
    pub id: String,
    pub provider: ProviderConfig,
    pub description: String,
}

struct AgentRecord {
    task: String,
    status: String,
    output: Arc<Mutex<String>>,
    started: Instant,
    abort: Option<AbortHandle>,
}

pub struct AgentScheduler {
    cwd: PathBuf,
    home: PathBuf,
    provider: ProviderConfig,
    sub_agents: Vec<ConfiguredSubAgent>,
    fallback_sub_agent_id: Option<String>,
    policy: AccessMode,
    system_prompt: String,
    persistent_memory: bool,
    max_agents: usize,
    agents: Mutex<BTreeMap<String, AgentRecord>>,
    /// 该角色的输入队列：外部（老板或其他角色）向里推消息，agent 在模型/工具边界
    /// 收到并继续执行（实现「中断该角色 → 发消息 → 继续」）。
    input_queue: Arc<InputQueue>,
    /// 同一团队所有角色的输入队列（agent_id → queue）：角色可通过 message_agent 工具
    /// 把消息推给另一个角色。
    shared_queues: Arc<std::sync::Mutex<HashMap<String, Arc<InputQueue>>>>,
    /// 协同工作台回调：(agent_id, kind, delta)。kind ∈ {"text","reasoning"}。
    /// 设置后 AgentOutputObserver 会把文本与思考过程实时转发。
    collab_callback: Option<Arc<dyn Fn(&str, &str, &str) + Send + Sync>>,
    /// 禁止破坏性 shell 命令（协同子 Agent 一律启用，防止 rm -rf / format 等越权）。
    deny_destructive: bool,
    /// 该角色所有工具共用的进程管理器，供上层按任务精确终止长进程（编译/安装等）。
    process_manager: Arc<ProcessManager>,
    /// 查询团队文件活动日志（team_files 工具）。
    team_files_query: Option<Arc<dyn Fn(Value) -> Value + Send + Sync>>,
    /// 查询团队角色实时状态（team_status 工具）。
    team_status_query: Option<Arc<dyn Fn(Value) -> Value + Send + Sync>>,
    /// 拉取发给自己的消息（team_inbox 工具）。
    team_inbox_query: Option<Arc<dyn Fn(Value) -> Value + Send + Sync>>,
    /// 记录一条团队内消息（message_agent 发出后回写共享日志）。
    team_message_sink: Option<Arc<dyn Fn(Value) + Send + Sync>>,
    /// 协同写互斥钩子，透传给 CoreTools。
    file_write_guard: Option<Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>>,
    /// 子 Agent 的工具质量层开关（能力开关 toolEnhance，默认开）。
    tool_enhance: bool,
    /// 是否已登记进进程内注册表（跨轮枚举用，见 LIVE_SCHEDULERS）。
    registered: AtomicBool,
}

/// 进程内活着的调度器注册表。
///
/// AgentScheduler 由各调用点临时创建（每个对话轮一个），手里只有局部 Arc，
/// HTTP 侧无从枚举。这里只登记 Weak：实例一旦 drop 就自动从表里消失，
/// 不会延长任何调度器的生命周期。
///
/// 登记时机是「第一次真正派发子智能体」（spawn），不能放在构造期：
/// 构造后的 with_* 构建器用 Arc::get_mut 改配置，而 Arc::get_mut 要求
/// 没有任何 Weak 引用，构造期登记会让构建器 panic。
static LIVE_SCHEDULERS: OnceLock<StdMutex<Vec<Weak<AgentScheduler>>>> = OnceLock::new();

fn live_scheduler_registry() -> &'static StdMutex<Vec<Weak<AgentScheduler>>> {
    LIVE_SCHEDULERS.get_or_init(|| StdMutex::new(Vec::new()))
}

impl AgentScheduler {
    pub fn new(
        cwd: PathBuf,
        home: PathBuf,
        provider: ProviderConfig,
        policy: AccessMode,
        system_prompt: String,
    ) -> Arc<Self> {
        let scheduler = Arc::new(Self {
            cwd,
            home,
            provider,
            sub_agents: Vec::new(),
            fallback_sub_agent_id: None,
            policy,
            system_prompt,
            persistent_memory: true,
            max_agents: 3,
            agents: Mutex::new(BTreeMap::new()),
            input_queue: Arc::new(InputQueue::default()),
            shared_queues: Arc::new(std::sync::Mutex::new(HashMap::new())),
            collab_callback: None,
            deny_destructive: false,
            process_manager: Arc::new(ProcessManager::default()),
            team_files_query: None,
            team_status_query: None,
            team_inbox_query: None,
            team_message_sink: None,
            file_write_guard: None,
            tool_enhance: true,
            registered: AtomicBool::new(false),
        });
        scheduler
    }

    /// 登记到进程内注册表（幂等，只在 spawn 里调用，见注册表注释）。
    fn register_live(self: &Arc<Self>) {
        if self.registered.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut registry = live_scheduler_registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.retain(|entry| entry.strong_count() > 0);
        registry.push(Arc::downgrade(self));
    }

    /// 当前活着的调度器（已 drop 的自动跳过）。仅用于枚举，不持有强引用。
    pub fn live() -> Vec<Arc<Self>> {
        let mut registry = live_scheduler_registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.retain(|entry| entry.strong_count() > 0);
        registry.iter().filter_map(Weak::upgrade).collect()
    }

    /// 全进程子智能体快照：把每个活着调度器里的记录（running / completed /
    /// failed / closed）汇总起来，最近的排在前面。
    /// 注意：所属调度器已经 drop 的历史记录无法再枚举（进程内不留档案）。
    pub async fn live_snapshots() -> Vec<AgentSnapshot> {
        let mut out = Vec::new();
        for scheduler in Self::live() {
            out.extend(scheduler.snapshots(&[]).await);
        }
        out.sort_by(|left, right| right.elapsed_ms.cmp(&left.elapsed_ms));
        out
    }

    /// 按 id 关闭子智能体（自动找到所属调度器）。找不到时返回可读错误。
    pub async fn close_any(id: &str) -> Result<AgentSnapshot, String> {
        for scheduler in Self::live() {
            if scheduler.snapshots(&[id.to_owned()]).await.is_empty() {
                continue;
            }
            return scheduler.close(id).await;
        }
        Err(format!("unknown agent: {id}"))
    }

    /// 子 Agent 是否启用工具质量层（批 5）。
    pub fn with_tool_enhance(mut self: Arc<Self>, enabled: bool) -> Arc<Self> {
        let scheduler = Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared");
        scheduler.tool_enhance = enabled;
        self
    }

    /// 共享同一团队所有角色的输入队列（agent_id → queue），实现角色间发消息。
    pub fn with_shared_queues(
        mut self: Arc<Self>,
        queues: Arc<std::sync::Mutex<HashMap<String, Arc<InputQueue>>>>,
    ) -> Arc<Self> {
        let scheduler = Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared");
        scheduler.shared_queues = queues;
        self
    }

    /// 该角色的输入队列：外部向其 push 消息，正在执行的 agent 在模型/工具边界接收。
    pub fn input_queue(&self) -> Arc<InputQueue> {
        Arc::clone(&self.input_queue)
    }

    /// 团队共享队列的句柄（供 CoreTools 的 message_agent 工具使用）。
    pub fn shared_queues(&self) -> Arc<std::sync::Mutex<HashMap<String, Arc<InputQueue>>>> {
        Arc::clone(&self.shared_queues)
    }

    pub fn with_sub_agents(
        mut self: Arc<Self>,
        sub_agents: Vec<ConfiguredSubAgent>,
        fallback_sub_agent_id: Option<String>,
    ) -> Arc<Self> {
        let scheduler = Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared");
        scheduler.sub_agents = sub_agents;
        scheduler.fallback_sub_agent_id = fallback_sub_agent_id;
        self
    }

    /// 协同工作台：设置实时回调，AgentOutputObserver 收到文本/思考增量时调用。
    pub fn with_collab_callback(
        mut self: Arc<Self>,
        callback: Arc<dyn Fn(&str, &str, &str) + Send + Sync>,
    ) -> Arc<Self> {
        let scheduler = Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared");
        scheduler.collab_callback = Some(callback);
        self
    }

    /// 协同工作台：禁止破坏性 shell 命令。
    pub fn with_deny_destructive_shell(mut self: Arc<Self>) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared")
            .deny_destructive = true;
        self
    }

    /// 共享进程管理器：让上层能在取消任务时终止该角色启动的长进程。
    pub fn with_process_manager(
        mut self: Arc<Self>,
        manager: Arc<ProcessManager>,
    ) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared")
            .process_manager = manager;
        self
    }

    pub fn with_team_files_query(
        mut self: Arc<Self>,
        query: Arc<dyn Fn(Value) -> Value + Send + Sync>,
    ) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared")
            .team_files_query = Some(query);
        self
    }

    pub fn with_team_status_query(
        mut self: Arc<Self>,
        query: Arc<dyn Fn(Value) -> Value + Send + Sync>,
    ) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared")
            .team_status_query = Some(query);
        self
    }

    pub fn with_team_inbox_query(
        mut self: Arc<Self>,
        query: Arc<dyn Fn(Value) -> Value + Send + Sync>,
    ) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared")
            .team_inbox_query = Some(query);
        self
    }

    pub fn with_team_message_sink(mut self: Arc<Self>, sink: Arc<dyn Fn(Value) + Send + Sync>) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared")
            .team_message_sink = Some(sink);
        self
    }

    /// 协同工作台：写互斥（claim）钩子，组装 CoreTools 时透传。
    pub fn with_file_write_guard(
        mut self: Arc<Self>,
        guard: Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>,
    ) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared")
            .file_write_guard = Some(guard);
        self
    }

    /// 供引擎查询当前已注册的 agent（含运行中/已完成）。
    pub async fn list_agents(&self) -> Vec<(String, String, String)> {
        let agents = self.agents.lock().await;
        agents
            .iter()
            .map(|(id, record)| (id.clone(), record.status.clone(), record.task.clone()))
            .collect()
    }

    pub fn sub_agent_summary(&self) -> String {
        if self.sub_agents.is_empty() {
            return "No dedicated sub-agent models are configured; omit sub_agent_id to use the main model.".into();
        }
        let entries = self
            .sub_agents
            .iter()
            .map(|entry| {
                let fallback = self
                    .fallback_sub_agent_id
                    .as_deref()
                    .is_some_and(|id| id == entry.id);
                let description = if entry.description.is_empty() {
                    format!("{}:{}", entry.provider.id, entry.provider.model)
                } else {
                    entry.description.clone()
                };
                format!(
                    "{}{} ({description})",
                    entry.id,
                    if fallback { " [fallback]" } else { "" }
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "Configured sub-agent IDs: {entries}. Use sub_agent_id to select one; omit it to use the fallback."
        )
    }

    pub fn without_persistent_memory(mut self: Arc<Self>) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .expect("agent scheduler must be configured before it is shared")
            .persistent_memory = false;
        self
    }

    pub async fn spawn(
        self: &Arc<Self>,
        task: String,
        parent_messages: &[ChatMessage],
        fork_turns: Option<&str>,
        sub_agent_id: Option<&str>,
    ) -> Result<String, String> {
        if task.trim().is_empty() {
            return Err("agent task must not be empty".into());
        }
        // 派发即登记：HTTP /api/agents 只能看到登记过、且仍活着的调度器。
        self.register_live();
        {
            let agents = self.agents.lock().await;
            let running = agents
                .values()
                .filter(|record| record.status == "running")
                .count();
            if running >= self.max_agents {
                return Err(format!(
                    "agent concurrency limit reached ({})",
                    self.max_agents
                ));
            }
        }

        let id = Uuid::new_v4().to_string();
        let output = Arc::new(Mutex::new(String::new()));
        let messages = fork_history(parent_messages, fork_turns)?;
        let scheduler = Arc::clone(self);
        let task_for_run = task.clone();
        let sub_agent_id = sub_agent_id.map(str::to_owned);
        let id_for_run = id.clone();
        let output_for_run = Arc::clone(&output);
        let join = tokio::spawn(async move {
            let reasoning = Arc::new(Mutex::new(String::new()));
            let result = scheduler
                .run_agent(
                    id_for_run.clone(),
                    messages,
                    task_for_run,
                    Arc::clone(&output_for_run),
                    reasoning,
                    sub_agent_id.as_deref(),
                )
                .await;
            let mut agents = scheduler.agents.lock().await;
            if let Some(record) = agents.get_mut(&id_for_run) {
                record.status = if result.is_ok() {
                    "completed".into()
                } else {
                    "failed".into()
                };
                record.abort = None;
            }
            if let Err(error) = result {
                let mut output = output_for_run.lock().await;
                if !output.is_empty() {
                    output.push_str("\n\n");
                }
                output.push_str(&format!("agent failed: {error:#}"));
            }
        });
        self.agents.lock().await.insert(
            id.clone(),
            AgentRecord {
                task,
                status: "running".into(),
                output,
                started: Instant::now(),
                abort: Some(join.abort_handle()),
            },
        );
        Ok(id)
    }

    /// 协同工作台：同步执行一个 agent 到结束，返回 (文本输出, 思考过程)。
    /// 与 `spawn` 不同，这里直接 await `run_agent`，调用方负责并行与取消。
    pub async fn run_to_completion(
        self: &Arc<Self>,
        agent_id: String,
        task: String,
        parent_messages: &[ChatMessage],
        sub_agent_id: Option<&str>,
    ) -> Result<(String, String), String> {
        let output = Arc::new(Mutex::new(String::new()));
        let reasoning = Arc::new(Mutex::new(String::new()));
        let messages = fork_history(parent_messages, Some("all"))?;
        self.run_agent(
            agent_id,
            messages,
            task,
            Arc::clone(&output),
            Arc::clone(&reasoning),
            sub_agent_id,
        )
        .await
        .map_err(|error| format!("{error:#}"))?;
        let text = output.lock().await.clone();
        let thought = reasoning.lock().await.clone();
        Ok((text, thought))
    }

    async fn run_agent(
        self: &Arc<Self>,
        agent_id: String,
        messages: Vec<ChatMessage>,
        task: String,
        output: Arc<Mutex<String>>,
        reasoning: Arc<Mutex<String>>,
        sub_agent_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let selected = if self.sub_agents.is_empty() {
            None
        } else {
            let requested = sub_agent_id.or(self.fallback_sub_agent_id.as_deref());
            let id =
                requested.ok_or_else(|| anyhow::anyhow!("no fallback sub-agent is configured"))?;
            Some(
                self.sub_agents
                    .iter()
                    .find(|entry| entry.id == id)
                    .ok_or_else(|| anyhow::anyhow!("unknown configured sub-agent: {id}"))?,
            )
        };
        let provider_config = selected
            .map(|entry| entry.provider.clone())
            .unwrap_or_else(|| self.provider.clone());
        let mut session = Session::new(
            &provider_config.id,
            &provider_config.model,
            self.cwd.clone(),
        );
        session.messages = messages;
        let provider = HttpModelProvider::new(provider_config)?;
        let mut security = SecurityPolicy::new(&self.cwd, self.policy)?;
        if self.deny_destructive {
            security = security.without_destructive_shell();
        }
        // 注册自己的输入队列，让其他角色能通过 message_agent 工具找到并 push 消息。
        if let Ok(mut queues) = self.shared_queues.lock() {
            queues.insert(agent_id.clone(), Arc::clone(&self.input_queue));
        }
        let mut tools = CoreTools::new(self.cwd.clone(), security)
            .with_skills_directory(self.home.join("skills"))
            .with_config_home(self.home.clone())
            .with_session_state(None, None)
            .with_agent_queues(Arc::clone(&self.shared_queues))
            .with_own_agent_id(agent_id.clone())
            .with_process_manager(Arc::clone(&self.process_manager))
            .with_agent_scheduler(self.clone(), session.messages.clone())
            .with_tool_enhance(self.tool_enhance)
            // 子 Agent 没有能弹提问卡的前端通道（SubagentApproval 对提问一律返回 None），
            // 把 ask_user / request_save_as 从它的工具清单里去掉，避免模型白调一次。
            .with_ask_user(false)
            .with_save_as_request(false)
            .with_hooks(Arc::new(HookRunner::load(&self.home)?));
        if let Some(query) = self.team_files_query.as_ref() {
            tools = tools.with_team_files_query(Arc::clone(query));
        }
        if let Some(query) = self.team_status_query.as_ref() {
            tools = tools.with_team_status_query(Arc::clone(query));
        }
        if let Some(query) = self.team_inbox_query.as_ref() {
            tools = tools.with_team_inbox_query(Arc::clone(query));
        }
        if let Some(sink) = self.team_message_sink.as_ref() {
            tools = tools.with_team_message_sink(Arc::clone(sink));
        }
        if let Some(guard) = self.file_write_guard.as_ref() {
            tools = tools.with_file_write_guard(Arc::clone(guard));
        }
        if self.persistent_memory {
            tools = tools.with_memory(Arc::new(MemoryManager::new(&self.home, &self.cwd)));
        }
        let observer = AgentOutputObserver {
            output,
            reasoning,
            agent_id: agent_id.clone(),
            collab_callback: self.collab_callback.clone(),
        };
        let role = selected
            .filter(|entry| !entry.description.is_empty())
            .map(|entry| format!(" Your configured role is: {}.", entry.description))
            .unwrap_or_default();
        Agent::new(format!(
            "{}\n\nYou are a delegated Coomi sub-agent.{role} Complete the assigned task independently and return a concise result to the parent agent.",
            self.system_prompt
        ))
        .with_input_queue(Arc::clone(&self.input_queue))
        .run_turn(
            &mut session,
            task,
            &provider,
            &tools,
            &SubagentApproval,
            &observer,
        )
        .await?;
        // 本轮结束时收尾该角色 spawn_agent 派生的后台子 Agent，避免残留。
        self.abort_all_sub_agents().await;
        Ok(())
    }

    /// 终止本调度器 spawn_agent 派生的所有后台子 Agent（父任务取消/结束时调用）。
    pub async fn abort_all_sub_agents(&self) {
        let handles: Vec<AbortHandle> = self
            .agents
            .lock()
            .await
            .values_mut()
            .filter_map(|record| record.abort.take())
            .collect();
        for handle in handles {
            handle.abort();
        }
        // NOTE: process_manager 是整个任务共享的，不能在这里 terminate_all，
        // 否则会误杀同一团队里其他仍在运行角色的长进程。子 Agent 的 shell 进程
        // 由任务级取消（cancel_task → terminate_all）统一回收。
    }

    pub async fn wait(&self, ids: &[String], timeout_ms: u64) -> Vec<AgentSnapshot> {
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(timeout_ms.clamp(10, 3_600_000));
        loop {
            let snapshots = self.snapshots(ids).await;
            if snapshots
                .iter()
                .all(|snapshot| snapshot.status != "running")
                || tokio::time::Instant::now() >= deadline
            {
                return snapshots;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
    }

    pub async fn close(&self, id: &str) -> Result<AgentSnapshot, String> {
        let abort = {
            let mut agents = self.agents.lock().await;
            let record = agents
                .get_mut(id)
                .ok_or_else(|| format!("unknown agent: {id}"))?;
            record.status = "closed".into();
            record.abort.take()
        };
        if let Some(abort) = abort {
            abort.abort();
        }
        self.snapshots(&[id.to_owned()])
            .await
            .into_iter()
            .next()
            .ok_or_else(|| format!("unknown agent: {id}"))
    }

    pub async fn snapshots(&self, ids: &[String]) -> Vec<AgentSnapshot> {
        let agents = self.agents.lock().await;
        let selected = if ids.is_empty() {
            agents.keys().cloned().collect::<Vec<_>>()
        } else {
            ids.to_vec()
        };
        let records = selected
            .into_iter()
            .filter_map(|id| agents.get(&id).map(|record| (id, record)))
            .map(|(id, record)| {
                (
                    id,
                    record.status.clone(),
                    record.task.clone(),
                    Arc::clone(&record.output),
                    record.started.elapsed().as_millis(),
                )
            })
            .collect::<Vec<_>>();
        drop(agents);
        let mut snapshots = Vec::with_capacity(records.len());
        for (id, status, task, output, elapsed_ms) in records {
            snapshots.push(AgentSnapshot {
                id,
                status,
                task,
                output: output.lock().await.clone(),
                elapsed_ms,
            });
        }
        snapshots
    }
}

fn fork_history(
    messages: &[ChatMessage],
    fork_turns: Option<&str>,
) -> Result<Vec<ChatMessage>, String> {
    match fork_turns.unwrap_or("all") {
        "none" => Ok(Vec::new()),
        "all" => Ok(messages.to_vec()),
        value => {
            let turns = value
                .parse::<usize>()
                .map_err(|_| "fork_turns must be none, all, or a positive integer")?;
            if turns == 0 {
                return Err("fork_turns must be positive".into());
            }
            let user_positions = messages
                .iter()
                .enumerate()
                .filter_map(|(index, message)| {
                    (message.role == coomi_engine::Role::User).then_some(index)
                })
                .collect::<Vec<_>>();
            let start = user_positions
                .get(user_positions.len().saturating_sub(turns))
                .copied()
                .unwrap_or(0);
            Ok(messages[start..].to_vec())
        }
    }
}

struct AgentOutputObserver {
    output: Arc<Mutex<String>>,
    reasoning: Arc<Mutex<String>>,
    agent_id: String,
    collab_callback: Option<Arc<dyn Fn(&str, &str, &str) + Send + Sync>>,
}

impl AgentObserver for AgentOutputObserver {
    fn on_event(&self, event: &AgentEvent) {
        // 工具调用：转成 JSON 交给回调，供协同工作台展示「调用了什么工具」。
        let tool_payload = match event {
            AgentEvent::ToolStarted(call) => Some(json!({
                "id": call.id,
                "name": call.name,
                "arguments": call.arguments,
                "status": "running",
            })),
            AgentEvent::ToolFinished { call, result } => Some(json!({
                "id": call.id,
                "name": call.name,
                "arguments": call.arguments,
                "status": if result.success { "done" } else { "error" },
                "output": result.output,
            })),
            _ => None,
        };
        if let Some(payload) = tool_payload {
            if let (Some(callback), Ok(json)) = (
                self.collab_callback.as_ref(),
                serde_json::to_string(&payload),
            ) {
                callback(&self.agent_id, "tool", &json);
            }
            return;
        }
        if let AgentEvent::ModelStarted { model, .. } = event {
            if let Some(callback) = self.collab_callback.as_ref() {
                callback(&self.agent_id, "status", &format!("请求模型 {model} …"));
            }
            return;
        }
        let (kind, delta) = match event {
            AgentEvent::Text(value) | AgentEvent::TextDelta(value) => ("text", value.as_str()),
            AgentEvent::ReasoningDelta(value) => ("reasoning", value.as_str()),
            _ => return,
        };
        if let Some(callback) = self.collab_callback.as_ref() {
            callback(&self.agent_id, kind, delta);
        }
        let target = if kind == "text" {
            &self.output
        } else {
            &self.reasoning
        };
        if let Ok(mut buffer) = target.try_lock() {
            buffer.push_str(delta);
        }
    }
}

struct SubagentApproval;

#[async_trait]
impl ApprovalHandler for SubagentApproval {
    // 协同子 agent 在 SecurityPolicy 划定的边界内自主执行：工具需要授权时直接放行，
    // 越界读写/危险命令仍由 SecurityPolicy 本身拦截，而不是在这里一刀切拒绝。
    async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool {
        true
    }

    async fn request_user_input(&self, _request: &UserInputRequest) -> Option<UserInputResponse> {
        None
    }
}

pub fn snapshots_json(snapshots: &[AgentSnapshot]) -> Value {
    Value::Array(
        snapshots
            .iter()
            .map(|snapshot| {
                serde_json::json!({
                    "id": snapshot.id,
                    "status": snapshot.status,
                    "task": snapshot.task,
                    "output": snapshot.output,
                    "elapsed_ms": snapshot.elapsed_ms.to_string()
                })
            })
            .collect(),
    )
}
