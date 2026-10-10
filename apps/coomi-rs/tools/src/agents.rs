use async_trait::async_trait;
use coomi_engine::Agent;
use coomi_engine::AgentEvent;
use coomi_engine::AgentObserver;
use coomi_engine::ApprovalHandler;
use coomi_engine::ChatMessage;
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
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use std::sync::Mutex;
use crate::ProcessManager;
use tokio::task::AbortHandle;
use uuid::Uuid;

use crate::CoreTools;

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
    processes: Option<Arc<ProcessManager>>,
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
    auto_compact_percent: u8,
    agents: Mutex<BTreeMap<String, AgentRecord>>,
}

impl AgentScheduler {
    pub fn new(
        cwd: PathBuf,
        home: PathBuf,
        provider: ProviderConfig,
        policy: AccessMode,
        system_prompt: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            cwd,
            home,
            provider,
            sub_agents: Vec::new(),
            fallback_sub_agent_id: None,
            policy,
            system_prompt,
            persistent_memory: true,
            max_agents: 3,
            auto_compact_percent: 80,
            agents: Mutex::new(BTreeMap::new()),
        })
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

    pub fn with_limits(mut self: Arc<Self>, max_agents: usize, auto_compact_percent: u8) -> Arc<Self> {
        let scheduler = Arc::get_mut(&mut self).expect("configure scheduler before sharing");
        scheduler.max_agents = max_agents.clamp(1, 20);
        scheduler.auto_compact_percent = auto_compact_percent.clamp(10, 95);
        self
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
        let id = Uuid::new_v4().to_string();
        let output = Arc::new(Mutex::new(String::new()));
        let messages = fork_history(parent_messages, fork_turns)?;
        {
            let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
            let running = agents.values().filter(|r| r.status == "running").count();
            if running >= self.max_agents { return Err(format!("agent concurrency limit reached ({})", self.max_agents)); }
            agents.insert(id.clone(), AgentRecord {
                task: task.clone(), status: "running".into(), output: Arc::clone(&output),
                started: Instant::now(), abort: None, processes: None,
            });
        }
        let scheduler = Arc::clone(self);
        let task_for_run = task.clone();
        let sub_agent_id = sub_agent_id.map(str::to_owned);
        let id_for_run = id.clone();
        let output_for_run = Arc::clone(&output);
        let join = tokio::spawn(async move {
            let result = scheduler
                .run_agent(
                    &id_for_run,
                    messages,
                    task_for_run,
                    Arc::clone(&output_for_run),
                    sub_agent_id.as_deref(),
                )
                .await;
            let mut agents = scheduler.agents.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(record) = agents.get_mut(&id_for_run).filter(|r| r.status == "running") {
                record.status = if result.is_ok() {
                    "completed".into()
                } else {
                    "failed".into()
                };
                record.abort = None;
            }
            if let Err(error) = result {
                let mut output = output_for_run.lock().unwrap_or_else(|e| e.into_inner());
                if !output.is_empty() {
                    output.push_str("\n\n");
                }
                output.push_str(&format!("agent failed: {error:#}"));
            }
        });
        {
            let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(record) = agents.get_mut(&id) {
                if record.status == "running" { record.abort = Some(join.abort_handle()); }
                else if record.status == "closed" { join.abort(); }
            }
        }
        Ok(id)
    }

    async fn run_agent(
        self: &Arc<Self>,
        id: &str,
        messages: Vec<ChatMessage>,
        task: String,
        output: Arc<Mutex<String>>,
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
        let security = SecurityPolicy::new(&self.cwd, self.policy)?;
        let mut tools = CoreTools::new(self.cwd.clone(), security)
            .with_skills_directory(self.home.join("skills"))
            .with_config_home(self.home.clone())
            .with_hooks(Arc::new(HookRunner::load(&self.home)?));
        if self.persistent_memory {
            tools = tools.with_memory(Arc::new(MemoryManager::new(&self.home, &self.cwd)));
        }
        let processes = tools.process_manager();
        {
            let mut records = self.agents.lock().unwrap_or_else(|e| e.into_inner());
            let Some(record) = records.get_mut(id).filter(|r| r.status == "running") else { return Ok(()); };
            record.processes = Some(Arc::clone(&processes));
        }
        let _process_guard = SubagentProcessGuard(processes);
        let observer = AgentOutputObserver { output };
        let role = selected
            .filter(|entry| !entry.description.is_empty())
            .map(|entry| format!(" Your configured role is: {}.", entry.description))
            .unwrap_or_default();
        Agent::new(format!(
            "{}\n\nYou are a delegated Coomi sub-agent.{role} Complete the assigned task independently and return a concise result to the parent agent.",
            self.system_prompt
        ))
        .with_auto_compact_percent(self.auto_compact_percent)
        .run_turn(
            &mut session,
            task,
            &provider,
            &tools,
            &SubagentApproval,
            &observer,
        )
        .await?;
        Ok(())
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
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    pub async fn close(&self, id: &str) -> Result<AgentSnapshot, String> {
        let (abort, processes) = {
            let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
            let record = agents
                .get_mut(id)
                .ok_or_else(|| format!("unknown agent: {id}"))?;
            record.status = "closed".into();
            (record.abort.take(), record.processes.take())
        };
        if let Some(abort) = abort {
            abort.abort();
        }
        if let Some(processes) = processes { processes.terminate_all().await; }
        self.snapshots(&[id.to_owned()])
            .await
            .into_iter()
            .next()
            .ok_or_else(|| format!("unknown agent: {id}"))
    }

    /// Abort only this parent's children, synchronously, and reap their shell groups.
    pub fn cancel_all(&self) {
        let processes = {
            let mut records = self.agents.lock().unwrap_or_else(|e| e.into_inner());
            records.values_mut().filter_map(|record| {
                if record.status == "running" { record.status = "closed".into(); }
                if let Some(abort) = record.abort.take() { abort.abort(); }
                record.processes.take()
            }).collect::<Vec<_>>()
        };
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move { for manager in processes { manager.terminate_all().await; } });
        }
    }

    pub async fn snapshots(&self, ids: &[String]) -> Vec<AgentSnapshot> {
        let agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
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
                output: output.lock().unwrap_or_else(|e| e.into_inner()).clone(),
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

struct SubagentProcessGuard(Arc<ProcessManager>);
impl Drop for SubagentProcessGuard {
    fn drop(&mut self) {
        let processes = Arc::clone(&self.0);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move { processes.terminate_all().await; });
        }
    }
}

struct AgentOutputObserver {
    output: Arc<Mutex<String>>,
}

impl AgentObserver for AgentOutputObserver {
    fn on_event(&self, event: &AgentEvent) {
        let delta = match event {
            AgentEvent::Text(value) | AgentEvent::TextDelta(value) => Some(value),
            _ => None,
        };
        if let Some(delta) = delta
            && let Ok(mut output) = self.output.lock()
        {
            output.push_str(delta);
        }
    }
}

struct SubagentApproval;

#[async_trait]
impl ApprovalHandler for SubagentApproval {
    async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool {
        false
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
#[cfg(test)]
mod reliability_tests {
    use super::*;
    use coomi_services::{ProviderKind,RemoteCompactionMode};
    use std::sync::atomic::{AtomicBool,Ordering};
    fn config()->ProviderConfig {ProviderConfig{
        id:"mock".into(),display:"mock".into(),kind:ProviderKind::OpenAiCompatible,api_key:String::new(),api_keys:vec![],
        base_url:"http://127.0.0.1:1/v1".into(),model:"mock".into(),fast_model:None,models:vec!["mock".into()],
        model_context_windows:BTreeMap::new(),model_vision_support:BTreeMap::new(),model_parameters:BTreeMap::new(),
        capabilities:Default::default(),remote_compaction_mode:RemoteCompactionMode::default(),extra_headers:BTreeMap::new(),
        deepseek_thinking_enabled:false,deepseek_search_enabled:false,
    }}
    #[tokio::test]
    async fn immediate_subagent_failure_cannot_leave_running_record() {
        let home=tempfile::tempdir().unwrap();
        let scheduler=AgentScheduler::new(home.path().into(),home.path().into(),config(),AccessMode::WorkspaceWrite,"test".into())
            .with_sub_agents(vec![ConfiguredSubAgent{id:"known".into(),provider:config(),description:String::new()}],Some("known".into()));
        for _ in 0..20 {
            let id=scheduler.spawn("task".into(),&[],Some("none"),Some("unknown")).await.unwrap();
            let status=scheduler.wait(&[id],1000).await;
            assert_eq!(status[0].status,"failed");assert!(status[0].output.contains("unknown configured sub-agent"));
        }
    }
    #[tokio::test]
    async fn dropping_parent_tools_aborts_children_and_keeps_other_parent_isolated() {
        let home=tempfile::tempdir().unwrap();
        let scheduler=AgentScheduler::new(home.path().into(),home.path().into(),config(),AccessMode::WorkspaceWrite,"test".into());
        let ran=Arc::new(AtomicBool::new(false));let flag=Arc::clone(&ran);
        let child=tokio::spawn(async move {tokio::time::sleep(std::time::Duration::from_millis(100)).await;flag.store(true,Ordering::SeqCst);});
        scheduler.agents.lock().unwrap().insert("child".into(),AgentRecord{task:"task".into(),status:"running".into(),output:Arc::new(Mutex::new(String::new())),started:Instant::now(),abort:Some(child.abort_handle()),processes:None});
        let other=AgentScheduler::new(home.path().into(),home.path().into(),config(),AccessMode::WorkspaceWrite,"other".into());
        other.agents.lock().unwrap().insert("other".into(),AgentRecord{task:"task".into(),status:"running".into(),output:Arc::new(Mutex::new(String::new())),started:Instant::now(),abort:None,processes:None});
        let policy=SecurityPolicy::new(home.path(),AccessMode::WorkspaceWrite).unwrap();
        let tools=CoreTools::new(home.path().into(),policy).with_agent_scheduler(Arc::clone(&scheduler),vec![]);
        drop(tools);assert!(child.await.unwrap_err().is_cancelled());assert!(!ran.load(Ordering::SeqCst));
        assert_eq!(scheduler.snapshots(&[]).await[0].status,"closed");assert_eq!(other.snapshots(&[]).await[0].status,"running");
    }
    #[test]
    fn concurrent_output_collection_keeps_every_delta() {
        let output=Arc::new(Mutex::new(String::new()));
        let handles=(0..4).map(|_|{let output=Arc::clone(&output);std::thread::spawn(move ||{let observer=AgentOutputObserver{output};for _ in 0..1000 {observer.on_event(&AgentEvent::TextDelta("x".into()));}})}).collect::<Vec<_>>();
        for handle in handles {handle.join().unwrap();}
        assert_eq!(output.lock().unwrap().len(),4000);
    }
}
