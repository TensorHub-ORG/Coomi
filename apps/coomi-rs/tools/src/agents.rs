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
use tokio::sync::Mutex;
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
            let result = scheduler
                .run_agent(
                    messages,
                    task_for_run,
                    Arc::clone(&output_for_run),
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

    async fn run_agent(
        self: &Arc<Self>,
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
        let observer = AgentOutputObserver { output };
        let role = selected
            .filter(|entry| !entry.description.is_empty())
            .map(|entry| format!(" Your configured role is: {}.", entry.description))
            .unwrap_or_default();
        Agent::new(format!(
            "{}\n\nYou are a delegated Coomi sub-agent.{role} Complete the assigned task independently and return a concise result to the parent agent.",
            self.system_prompt
        ))
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
}

impl AgentObserver for AgentOutputObserver {
    fn on_event(&self, event: &AgentEvent) {
        let delta = match event {
            AgentEvent::Text(value) | AgentEvent::TextDelta(value) => Some(value),
            _ => None,
        };
        if let Some(delta) = delta
            && let Ok(mut output) = self.output.try_lock()
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
