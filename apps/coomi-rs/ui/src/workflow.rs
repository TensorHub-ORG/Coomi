//! Durable workflow runs. Definitions stay immutable while an execution is running.
mod control;
mod executor;
#[cfg(test)]
mod tests;

use anyhow::{Context, Result, bail};
use chrono::{TimeZone, Timelike};
use control::{Interaction, RunState};
use coomi_engine::{
    Session, TokenUsage, WorkflowRunOutcome, WorkflowRunner, WorkflowState, WorkflowStepState,
    WorkflowStore,
};
use executor::WorkflowExecutor;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Semaphore, watch};
use uuid::Uuid;

const RUNS_LIMIT: usize = 50;
static RUNS_LOCK: Mutex<()> = Mutex::new(());
fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StepOutcome {
    pub id: String,
    pub name: String,
    pub state: String,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub result: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub status: String,
    pub duration_ms: Option<u64>,
    pub trigger: String,
    pub steps: Vec<StepOutcome>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub pending: Option<Interaction>,
    #[serde(default)]
    pub usage: TokenUsage,
    #[serde(default)]
    pub snapshot: Option<WorkflowState>,
    #[serde(default)]
    pub children: BTreeMap<String, WorkflowState>,
    #[serde(default)]
    pub sessions: BTreeMap<String, Session>,
    #[serde(default)]
    pub resumed_from: Option<String>,
}
impl RunRecord {
    pub fn public(&self) -> Value {
        json!({"id":self.id,"started_at":self.started_at,"finished_at":self.finished_at,
            "status":self.status,"duration_ms":self.duration_ms,"trigger":self.trigger,
            "steps":self.steps,"error":self.error,"pending":self.pending,"usage":self.usage,
            "resumable":self.snapshot.is_some() && matches!(self.status.as_str(),"failed"|"interrupted"),
            "resumed_from":self.resumed_from})
    }
}
pub fn step_outcomes(workflow: &WorkflowState) -> Vec<StepOutcome> {
    workflow
        .steps
        .iter()
        .map(|step| StepOutcome {
            id: step.id.clone(),
            name: step.name.clone(),
            state: format!("{:?}", step.state).to_lowercase(),
            duration_ms: step.duration_ms,
            attempts: step.attempts,
            result: step.result.clone(),
            error: if step.state == WorkflowStepState::Failed {
                Some(
                    step.result
                        .as_ref()
                        .and_then(|v| v.get("error"))
                        .and_then(Value::as_str)
                        .unwrap_or("step failed")
                        .into(),
                )
            } else {
                None
            },
        })
        .collect()
}
fn valid_id(id: &str) -> Result<()> {
    anyhow::ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "invalid workflow/run id"
    );
    Ok(())
}
fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("missing parent")?;
    std::fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
#[derive(Clone)]
pub struct RunsStore {
    dir: PathBuf,
}
impl RunsStore {
    pub fn new(home: &Path) -> Self {
        Self {
            dir: home.join("workflows"),
        }
    }
    fn file(&self, id: &str) -> Result<PathBuf> {
        valid_id(id)?;
        Ok(self.dir.join(id).join("runs.json"))
    }
    pub fn list(&self, id: &str) -> Result<Vec<RunRecord>> {
        let path = self.file(id)?;
        match std::fs::read(path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)
                .context("invalid workflow run history; original file retained")?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(error) => Err(error.into()),
        }
    }
    pub fn upsert(&self, id: &str, record: &RunRecord) -> Result<()> {
        let _lock = RUNS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut records = self.list(id)?;
        if let Some(existing) = records.iter_mut().find(|r| r.id == record.id) {
            *existing = record.clone();
        } else {
            records.insert(0, record.clone());
        }
        records.truncate(RUNS_LIMIT);
        atomic_json(&self.file(id)?, &records)
    }
    fn recover_stale(&self) -> Result<()> {
        if !self.dir.exists() {
            return Ok(());
        }
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if valid_id(&id).is_err() {
                continue;
            }
            for mut record in self.list(&id)? {
                if is_active(&record.status) {
                    record.status = "interrupted".into();
                    record.pending = None;
                    record.finished_at = Some(now_ts());
                    record.error=Some("引擎已重启；请核对最后一个步骤的产物后选择恢复，未完成步骤可能需要重新执行。".into());
                    self.upsert(&id, &record)?;
                }
            }
        }
        Ok(())
    }
}
fn is_active(status: &str) -> bool {
    matches!(
        status,
        "queued" | "running" | "pause_pending" | "paused" | "awaiting_approval" | "awaiting_input"
    )
}
struct ActiveRun {
    state: Arc<RunState>,
    done: watch::Receiver<bool>,
}
pub struct WorkflowScheduler {
    home: PathBuf,
    cwd: PathBuf,
    store: WorkflowStore,
    runs: RunsStore,
    active: Arc<Mutex<HashMap<String, ActiveRun>>>,
    slots: Arc<Semaphore>,
    last_minute: Mutex<Option<u64>>,
}
struct RunGuard {
    active: Arc<Mutex<HashMap<String, ActiveRun>>>,
    workflow_id: String,
    state: Arc<RunState>,
    done: watch::Sender<bool>,
}
impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Err(error) = self.state.change(|r| {
            if is_active(&r.status) {
                r.status = "interrupted".into();
                r.pending = None;
                r.finished_at = Some(now_ts());
                r.error = Some("工作流执行意外中断".into());
            }
        }) {
            eprintln!("workflow final checkpoint failed: {error:#}");
        }
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.workflow_id);
        let _ = self.done.send(true);
    }
}
impl WorkflowScheduler {
    pub fn new(home: &Path) -> Arc<Self> {
        Self::with_workspace(home, home)
    }
    pub fn with_workspace(home: &Path, cwd: &Path) -> Arc<Self> {
        Arc::new(Self {
            home: home.into(),
            cwd: cwd.into(),
            store: WorkflowStore::new(home),
            runs: RunsStore::new(home),
            active: Arc::new(Mutex::new(HashMap::new())),
            slots: Arc::new(Semaphore::new(2)),
            last_minute: Mutex::new(None),
        })
    }
    pub fn start(self: &Arc<Self>) -> Result<()> {
        self.runs.recover_stale()?;
        let scheduler = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
            loop {
                interval.tick().await;
                scheduler.tick().await;
            }
        });
        Ok(())
    }
    pub async fn tick(self: &Arc<Self>) {
        let minute = now_ts() / 60;
        {
            let mut last = self.last_minute.lock().unwrap_or_else(|e| e.into_inner());
            if *last == Some(minute) {
                return;
            }
            *last = Some(minute);
        }
        let Ok(ids) = self.store.list_ids() else {
            return;
        };
        for id in ids {
            let Ok(workflow) = self.store.read(&id) else {
                continue;
            };
            if !workflow.schedule.is_active()
                || !workflow
                    .schedule
                    .cron
                    .as_ref()
                    .is_some_and(|c| cron_matches_minute(c, minute))
            {
                continue;
            }
            // Persisted trigger minute prevents duplicate automatic execution after a same-minute restart.
            if self
                .runs
                .list(&id)
                .map(|r| {
                    r.iter()
                        .any(|r| r.trigger == "schedule" && r.started_at / 60 == minute)
                })
                .unwrap_or(true)
            {
                continue;
            }
            if let Err(error) = self.launch(&id, "schedule", None).await {
                eprintln!("workflow {id}: {error:#}");
            }
        }
    }
    pub async fn run_manual(self: &Arc<Self>, id: &str) -> Result<String> {
        self.launch(id, "manual", None).await
    }
    pub async fn recover(self: &Arc<Self>, id: &str, run_id: &str) -> Result<String> {
        let record = self
            .runs
            .list(id)?
            .into_iter()
            .find(|r| r.id == run_id)
            .context("run not found")?;
        anyhow::ensure!(
            matches!(record.status.as_str(), "failed" | "interrupted"),
            "only failed/interrupted runs can be recovered"
        );
        anyhow::ensure!(
            record.snapshot.is_some(),
            "legacy run has no checkpoint; start a new run"
        );
        self.launch(id, "recovery", Some(record)).await
    }
    async fn launch(
        self: &Arc<Self>,
        id: &str,
        trigger: &str,
        previous: Option<RunRecord>,
    ) -> Result<String> {
        valid_id(id)?;
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        anyhow::ensure!(!active.contains_key(id), "workflow is already active");
        let recovery = previous.is_some();
        let mut workflow = if let Some(old) = &previous {
            old.snapshot.clone().context("missing checkpoint")?
        } else {
            self.store.read(id)?
        };
        validate_definition(&workflow)?;
        let mut children = previous
            .as_ref()
            .map(|r| r.children.clone())
            .unwrap_or_default();
        if !recovery {
            workflow.reset_for_run();
            freeze_children(
                &self.store,
                &workflow,
                "",
                &mut vec![workflow.id.clone()],
                &mut children,
            )?;
        }
        for definition in std::iter::once(&workflow).chain(children.values()) {
            for step in &definition.steps {
                if let coomi_engine::StepAction::Model { model, .. } = &step.action {
                    let registry = coomi_services::ProviderRegistry::load(
                        &self.home.join("config/providers.json"),
                    )?;
                    let config = registry
                        .resolve(model.as_deref())
                        .with_context(|| format!("model for step '{}' is unavailable", step.id))?;
                    coomi_services::HttpModelProvider::new(config)?;
                }
            }
        }
        let cwd = coomi_services::RuntimePathMap::new(self.cwd.clone())
            .with_runtime_root(self.home.join("runtime-v2"))
            .resolve(workflow.cwd.as_deref().unwrap_or(&self.cwd), None)?
            .host_path
            .canonicalize()
            .context("workflow working directory is unavailable")?;
        workflow.cwd = Some(cwd);
        // A nested definition is a reusable step group, executing within this run's context.
        for child in children.values_mut() {
            child.cwd = workflow.cwd.clone();
            child.permission = workflow.permission.clone();
        }
        let run_id = Uuid::new_v4().to_string();
        let record = RunRecord {
            id: run_id.clone(),
            started_at: now_ts(),
            finished_at: None,
            status: "queued".into(),
            duration_ms: None,
            trigger: trigger.into(),
            steps: step_outcomes(&workflow),
            error: None,
            pending: None,
            usage: TokenUsage::default(),
            snapshot: Some(workflow.clone()),
            children,
            sessions: previous
                .as_ref()
                .map(|r| r.sessions.clone())
                .unwrap_or_default(),
            resumed_from: previous.map(|r| r.id),
        };
        let state = RunState::new(self.runs.clone(), id.into(), record);
        let (done_tx, done_rx) = watch::channel(false);
        {
            self.runs
                .upsert(id, &state.record.lock().unwrap_or_else(|e| e.into_inner()))?;
            active.insert(
                id.into(),
                ActiveRun {
                    state: state.clone(),
                    done: done_rx,
                },
            );
        }
        drop(active);
        let guard = RunGuard {
            active: self.active.clone(),
            workflow_id: id.into(),
            state: state.clone(),
            done: done_tx,
        };
        let slots = self.slots.clone();
        let home = self.home.clone();
        tokio::spawn(async move {
            let _guard = guard;
            let executor = WorkflowExecutor::new(home, state.clone());
            let work = async {
                let _permit = slots.acquire_owned().await?;
                state
                    .started
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                coomi_engine::TurnControl::safe_point(state.as_ref()).await?;
                state.change(|r| r.status = "running".into())?;
                if recovery {
                    WorkflowRunner::resume(&mut workflow, &executor).await
                } else {
                    WorkflowRunner::run(&mut workflow, &executor).await
                }
            };
            let outcome = tokio::select! {
                biased;
                _=state.cancel_wake.notified()=>Ok(WorkflowRunOutcome::Cancelled),
                result=work=>result,
            };
            executor.cleanup().await;
            let status = match &outcome {
                Ok(WorkflowRunOutcome::Completed) => "completed",
                Ok(WorkflowRunOutcome::Failed) => "failed",
                Ok(WorkflowRunOutcome::Cancelled) => "cancelled",
                Err(_) => "failed",
            };
            if let Err(error) = state.change(|r| {
                r.status = status.into();
                r.pending = None;
                r.finished_at = Some(now_ts());
                r.duration_ms = Some(now_ts().saturating_sub(r.started_at) * 1000);
                if let Err(error) = &outcome {
                    r.error = Some(format!("{error:#}"));
                }
                if status == "cancelled" {
                    if let Some(snapshot) = &mut r.snapshot {
                        snapshot.status = coomi_engine::WorkflowStatus::Cancelled;
                        for step in &mut snapshot.steps {
                            if step.state != WorkflowStepState::Succeeded {
                                step.state = WorkflowStepState::Cancelled;
                            }
                        }
                        r.steps = step_outcomes(snapshot);
                    }
                }
            }) {
                eprintln!("workflow completion could not be saved: {error:#}");
            }
        });
        Ok(run_id)
    }
    pub async fn action(&self, id: &str, run_id: &str, action: &str) -> Result<()> {
        let (state, mut done) = {
            let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            let run = active.get(id).context("workflow is not active")?;
            anyhow::ensure!(
                run.state
                    .record
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .id
                    == run_id,
                "run is not active"
            );
            (run.state.clone(), run.done.clone())
        };
        match action {
            "pause" => state.pause()?,
            "resume" => state.resume()?,
            "cancel" => {
                state.cancel();
                while !*done.borrow() {
                    done.changed()
                        .await
                        .context("cancel completion channel closed")?;
                }
            }
            _ => bail!("unknown workflow action"),
        }
        Ok(())
    }
    pub fn answer(&self, id: &str, run_id: &str, request: &str, value: Value) -> Result<()> {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let run = active.get(id).context("workflow is not active")?;
        anyhow::ensure!(
            run.state
                .record
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .id
                == run_id,
            "run is not active"
        );
        run.state.answer(request, value)
    }
    pub fn ensure_inactive(&self, id: &str) -> Result<()> {
        anyhow::ensure!(
            !self
                .active
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(id),
            "stop the workflow before deleting it"
        );
        Ok(())
    }
    pub fn remove(&self, id: &str) -> Result<()> {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        anyhow::ensure!(
            !active.contains_key(id),
            "stop the workflow before deleting it"
        );
        self.store.remove(id)
    }
}
pub fn validate_definition(workflow: &WorkflowState) -> Result<()> {
    workflow.validate().map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        !workflow.schedule.enabled
            || workflow
                .schedule
                .cron
                .as_deref()
                .is_some_and(|c| !c.trim().is_empty()),
        "enabled schedule requires a cron expression"
    );
    if let Some(cron) = workflow
        .schedule
        .cron
        .as_deref()
        .filter(|c| !c.trim().is_empty())
    {
        anyhow::ensure!(
            cron.split_whitespace().count() == 5,
            "cron requires five fields (minute granularity)"
        );
        croner::Cron::new(cron)
            .parse()
            .context("invalid cron expression")?;
    }
    for step in &workflow.steps {
        use coomi_engine::StepAction;
        match &step.action {
            StepAction::Script { command, timeout_s } => {
                anyhow::ensure!(!command.trim().is_empty(), "script command is empty");
                anyhow::ensure!(
                    timeout_s.is_none_or(|s| (1..=3600).contains(&s)),
                    "script timeout must be 1..3600 seconds"
                );
            }
            StepAction::Model { prompt, .. } | StepAction::Approval { prompt } => {
                anyhow::ensure!(!prompt.trim().is_empty(), "step prompt is empty")
            }
            StepAction::Tool { tool, arguments } => {
                anyhow::ensure!(
                    !tool.is_empty() && arguments.is_object(),
                    "tool requires a name and object arguments"
                );
                if matches!(tool.as_str(), "shell" | "local_shell") {
                    anyhow::ensure!(
                        arguments
                            .get("command")
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.trim().is_empty()),
                        "command step requires a command"
                    );
                    anyhow::ensure!(
                        arguments.get("action").is_none_or(|v| v == "exec"),
                        "command step requires action exec"
                    );
                    anyhow::ensure!(
                        arguments
                            .get("environment")
                            .is_none_or(|v| v == "auto" || v == "proot"),
                        "workflow commands use environment auto or proot"
                    );
                    for (key, limit) in [("timeout_s", 3600), ("timeout_ms", 3_600_000)] {
                        anyhow::ensure!(
                            arguments
                                .get(key)
                                .is_none_or(|v| v.as_u64().is_some_and(|n| n > 0 && n <= limit)),
                            "invalid command timeout"
                        );
                    }
                }
            }
            StepAction::SubWorkflow { workflow } => valid_id(workflow)?,
        }
    }
    Ok(())
}
fn freeze_children(
    store: &WorkflowStore,
    workflow: &WorkflowState,
    path: &str,
    stack: &mut Vec<String>,
    children: &mut BTreeMap<String, WorkflowState>,
) -> Result<()> {
    anyhow::ensure!(
        stack.len() <= 16 && children.len() < 128,
        "subworkflow nesting limit exceeded"
    );
    for step in &workflow.steps {
        if let coomi_engine::StepAction::SubWorkflow { workflow: id } = &step.action {
            anyhow::ensure!(!stack.contains(id), "subworkflow cycle detected: {id}");
            let mut child = store.read(id)?;
            validate_definition(&child)?;
            child.reset_for_run();
            let child_path = format!("{path}/{}", step.id);
            stack.push(id.clone());
            freeze_children(store, &child, &child_path, stack, children)?;
            stack.pop();
            children.insert(child_path, child);
        }
    }
    Ok(())
}
pub fn cron_matches_minute(expr: &str, minute: u64) -> bool {
    let Some(now) = chrono::Local
        .timestamp_opt((minute * 60) as i64, 0)
        .single()
    else {
        return false;
    };
    let Some(floor) = now.with_second(0).and_then(|t| t.with_nanosecond(0)) else {
        return false;
    };
    if expr.split_whitespace().count() != 5 {
        return false;
    }
    croner::Cron::new(expr)
        .parse()
        .ok()
        .and_then(|c| c.is_time_matching(&floor).ok())
        .unwrap_or(false)
}

pub fn builtin_templates() -> Vec<Value> {
    let entry =
        |key: &str, name: &str, description: &str, default_cron: &str, steps: Vec<Value>| {
            json!({
                "key": key,
                "name": name,
                "description": description,
                "default_cron": default_cron,
                "steps": steps,
            })
        };
    vec![
        entry(
            "env-inspect",
            "环境巡检",
            "检查手机 Linux 环境：系统信息、磁盘占用与工作目录汇总，适合定时采集。",
            "0 8 * * *",
            vec![
                json!({"id": "sys", "name": "系统信息", "action": {"kind": "tool", "tool": "shell", "arguments": {"command": "uname -a && echo --- && date && echo --- && df -h | head -6"}}}),
                json!({"id": "home", "name": "工作目录", "depends_on": ["sys"], "action": {"kind": "tool", "tool": "shell", "arguments": {"command": "ls -la . | head -20"}}}),
                json!({"id": "summary", "name": "写入巡检报告", "depends_on": ["sys", "home"], "action": {"kind": "tool", "tool": "write_file", "arguments": {"path": "coomi-reports/latest.txt", "content": "{{sys}}
{{home}}"}}}),
            ],
        ),
        entry(
            "daily-snapshot",
            "每日系统快照",
            "每天定时把关键目录清单留存为快照文件，便于比对变化。",
            "0 9 * * *",
            vec![
                json!({"id": "snap", "name": "生成快照", "action": {"kind": "tool", "tool": "shell", "arguments": {"command": "mkdir -p coomi-snapshots && date >> coomi-snapshots/daily.log && echo ok"}}}),
                json!({"id": "verify", "name": "校验快照", "depends_on": ["snap"], "action": {"kind": "tool", "tool": "read_file", "arguments": {"path": "coomi-snapshots/daily.log"}}}),
            ],
        ),
        entry(
            "web-watch",
            "网络状态巡检",
            "检查网络连通性并把结果写入状态文件，供后续任务消费。",
            "*/30 * * * *",
            vec![
                json!({"id": "fetch", "name": "探测连通性", "action": {"kind": "tool", "tool": "fetch", "arguments": {"url": "https://www.baidu.com"}}}),
                json!({"id": "record", "name": "记录状态", "depends_on": ["fetch"], "action": {"kind": "tool", "tool": "write_file", "arguments": {"path": "coomi-reports/network.json", "content": "{{fetch}}"}}}),
            ],
        ),
    ]
}
