//! P1 工作流服务：运行历史存储、宿主步骤执行器（tool/script/subworkflow）、
//! cron 定时调度器与内置模板。API 路由层在 `web.rs`；执行层复用
//! `coomi_engine::WorkflowRunner`（DAG 调度/重试/变量注入）。

use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::Timelike;
use coomi_engine::{
    StepAction, StepContext, StepExecResult, StepExecutor, WorkflowRunOutcome, WorkflowRunner,
    WorkflowState, WorkflowStep, WorkflowStepState, WorkflowStore,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;
use uuid::Uuid;

const RUNS_LIMIT: usize = 50;
const MAX_FETCH_BYTES: usize = 8 * 1024;
const MAX_RUNNING_WORKFLOWS: usize = 2;

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ---------------------------------------------------------------------------
// 运行历史
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StepOutcome {
    pub id: String,
    pub name: String,
    pub state: String,
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub trigger: String,
    pub steps: Vec<StepOutcome>,
}

pub struct RunsStore {
    dir: PathBuf,
}

impl RunsStore {
    pub fn new(home: &Path) -> Self {
        Self {
            dir: home.join("workflows"),
        }
    }

    fn file(&self, id: &str) -> PathBuf {
        self.dir.join(id).join("runs.json")
    }

    pub fn list(&self, id: &str) -> Vec<RunRecord> {
        let Ok(bytes) = std::fs::read(self.file(id)) else {
            return Vec::new();
        };
        serde_json::from_slice::<Vec<RunRecord>>(&bytes).unwrap_or_default()
    }

    fn write(&self, id: &str, records: &[RunRecord]) {
        let path = self.file(id);
        let Some(parent) = path.parent() else { return };
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
        let Ok(bytes) = serde_json::to_vec_pretty(records) else {
            return;
        };
        let tmp = parent.join("runs.json.tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    /// 追加一条运行记录（保留最近 RUNS_LIMIT 条）。
    pub fn push(&self, id: &str, record: &RunRecord) {
        let mut records = self.list(id);
        records.insert(0, record.clone());
        records.truncate(RUNS_LIMIT);
        self.write(id, &records);
    }

    /// 以同 id 覆盖（用于运行结束后把 running 记录补全为终态）。
    pub fn upsert(&self, id: &str, record: &RunRecord) {
        let mut records = self.list(id);
        if let Some(existing) = records.iter_mut().find(|r| r.id == record.id) {
            *existing = record.clone();
        } else {
            records.insert(0, record.clone());
        }
        records.truncate(RUNS_LIMIT);
        self.write(id, &records);
    }
}

// ---------------------------------------------------------------------------
// 宿主步骤执行器（P1：Script/Tool/SubWorkflow；Model 留待 P2）
// ---------------------------------------------------------------------------

pub struct HostStepExecutor {
    home: PathBuf,
    /// 子工作流递归防环：正在执行的 workflow id 集合。
    in_flight: Arc<Mutex<HashSet<String>>>,
}

impl HostStepExecutor {
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// 把 `{{step_id}}` 引用的前置变量替换成 JSON 文本。
    fn render(&self, text: &str, vars: &std::collections::BTreeMap<String, Value>) -> String {
        let mut out = text.to_owned();
        for (key, value) in vars {
            let token = format!("{{{{{key}}}}}");
            let rendered = if value.is_string() {
                value.as_str().unwrap_or_default().to_owned()
            } else {
                value.to_string()
            };
            out = out.replace(&token, &rendered);
        }
        out
    }

    fn resolve_path(&self, raw: &str) -> PathBuf {
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            self.home.join(p)
        }
    }

    async fn run_script(
        &self,
        command: &str,
        timeout_s: Option<u64>,
        vars: &std::collections::BTreeMap<String, Value>,
    ) -> StepExecResult {
        let command = self.render(command, vars);
        let mut cmd = tokio::process::Command::new("bash");
        cmd.arg("-c").arg(&command).current_dir(&self.home);
        let future = cmd.output();
        let output = match timeout_s {
            Some(seconds) if seconds > 0 => {
                match tokio::time::timeout(std::time::Duration::from_secs(seconds), future).await {
                    Ok(result) => result,
                    Err(_) => {
                        return StepExecResult {
                            value: json!({ "error": format!("step timed out after {seconds}s") }),
                            retryable: false,
                        };
                    }
                }
            }
            _ => future.await,
        };
        match output {
            Ok(output) if output.status.success() => StepExecResult::success(json!({
                "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
                "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
            })),
            Ok(output) => StepExecResult {
                value: json!({
                    "error": format!("exit {}", output.status.code().unwrap_or(-1)),
                    "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
                    "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
                }),
                retryable: false,
            },
            Err(error) => StepExecResult {
                value: json!({ "error": error.to_string() }),
                retryable: false,
            },
        }
    }

    async fn run_tool(
        &self,
        tool: &str,
        arguments: &Value,
        vars: &std::collections::BTreeMap<String, Value>,
    ) -> StepExecResult {
        let pull_string = |key: &str| -> Option<String> {
            arguments.get(key).and_then(Value::as_str).map(|s| self.render(s, vars))
        };
        match tool {
            "shell" => {
                let command = pull_string("command").unwrap_or_default();
                if command.trim().is_empty() {
                    return StepExecResult { value: json!({"error": "shell tool requires a command"}), retryable: false };
                }
                self.run_script(&command, arguments.get("timeout_s").and_then(Value::as_u64), vars)
                    .await
            }
            "read_file" => {
                let path = self.resolve_path(&pull_string("path").unwrap_or_default());
                match std::fs::read(&path) {
                    Ok(bytes) => StepExecResult::success(json!({
                        "path": path.to_string_lossy(),
                        "content": String::from_utf8_lossy(&bytes).to_string(),
                    })),
                    Err(error) => StepExecResult { value: json!({"error": error.to_string()}), retryable: false },
                }
            }
            "write_file" => {
                let path = self.resolve_path(&pull_string("path").unwrap_or_default());
                let content = pull_string("content").unwrap_or_default();
                if let Some(parent) = path.parent() {
                    if std::fs::create_dir_all(parent).is_err() {
                        return StepExecResult { value: json!({"error": "cannot create parent dir"}), retryable: false };
                    }
                }
                match std::fs::write(&path, content.as_bytes()) {
                    Ok(_) => StepExecResult::success(json!({"path": path.to_string_lossy(), "bytes": content.len()})),
                    Err(error) => StepExecResult { value: json!({"error": error.to_string()}), retryable: false },
                }
            }
            "fetch" => {
                let url = pull_string("url").unwrap_or_default();
                if !url.starts_with("http://") && !url.starts_with("https://") {
                    return StepExecResult { value: json!({"error": "fetch tool requires an http(s) url"}), retryable: false };
                }
                match reqwest::get(&url).await {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let mut body = resp.text().await.unwrap_or_default();
                        let truncated = body.len() > MAX_FETCH_BYTES;
                        body.truncate(MAX_FETCH_BYTES);
                        StepExecResult::success(json!({"status": status, "body": body, "truncated": truncated}))
                    }
                    Err(error) => StepExecResult { value: json!({"error": error.to_string()}), retryable: false },
                }
            }
            other => StepExecResult {
                value: json!({
                    "error": format!("tool `{other}` not bound in P1; supported: shell, read_file, write_file, fetch"),
                }),
                retryable: false,
            },
        }
    }

    async fn run_subworkflow(&self, workflow_id: &str) -> StepExecResult {
        let store = WorkflowStore::new(&self.home);
        let Ok(mut sub) = store.read(workflow_id) else {
            return StepExecResult { value: json!({"error": format!("subworkflow `{workflow_id}` not found")}), retryable: false };
        };
        {
            let mut guard = self.in_flight.lock().unwrap_or_else(|p| p.into_inner());
            if guard.contains(&sub.id) || guard.contains(workflow_id) {
                return StepExecResult { value: json!({"error": "subworkflow cycle detected"}), retryable: false };
            }
            guard.insert(sub.id.clone());
        }
        let result = WorkflowRunner::run(&mut sub, self).await;
        self.in_flight.lock().unwrap_or_else(|p| p.into_inner()).remove(&sub.id);
        match result {
            Ok(WorkflowRunOutcome::Completed) => StepExecResult::success(json!({
                "subworkflow": sub.id,
                "status": "completed",
                "steps": sub.steps.iter().map(|s| json!({"id": s.id, "name": s.name, "state": format!("{:?}", s.state)})).collect::<Vec<_>>(),
            })),
            Ok(_) => StepExecResult { value: json!({"subworkflow": sub.id, "status": "interrupted"}), retryable: false },
            Err(error) => StepExecResult { value: json!({"error": error.to_string()}), retryable: false },
        }
    }
}

#[async_trait]
impl StepExecutor for HostStepExecutor {
    async fn execute(&self, ctx: &StepContext<'_>) -> StepExecResult {
        let marker = uuid::Uuid::new_v4().to_string();
        let _keep_alive = marker; // 步骤唯一标识预留（后续进度上报用）
        match &ctx.step.action {
            StepAction::Script { command, timeout_s } => {
                self.run_script(command, *timeout_s, ctx.variables).await
            }
            StepAction::Tool { tool, arguments } => {
                self.run_tool(tool, arguments, ctx.variables).await
            }
            StepAction::SubWorkflow { workflow } => self.run_subworkflow(workflow).await,
            StepAction::Model { .. } => StepExecResult { value: json!({
                "error": "model steps land in P2; this workflow uses P1 unsupported step",
            }), retryable: false },
        }
    }
}

// ---------------------------------------------------------------------------
// cron 定时调度器
// ---------------------------------------------------------------------------

pub struct WorkflowScheduler {
    home: PathBuf,
    store: WorkflowStore,
    runs: RunsStore,
    executor: Arc<HostStepExecutor>,
    running: Arc<Mutex<HashSet<String>>>,
    slots: Arc<Semaphore>,
    last_minute: Arc<Mutex<u64>>,
}

impl WorkflowScheduler {
    pub fn new(home: &Path) -> Arc<Self> {
        Arc::new(Self {
            home: home.to_path_buf(),
            store: WorkflowStore::new(home),
            runs: RunsStore::new(home),
            executor: Arc::new(HostStepExecutor::new(home)),
            running: Arc::new(Mutex::new(HashSet::new())),
            slots: Arc::new(Semaphore::new(MAX_RUNNING_WORKFLOWS)),
            last_minute: Arc::new(Mutex::new(0)),
        })
    }

    /// 在后台启动 tick 循环（每 15 秒检查一次分钟变化；跨分钟补触发）。
    pub fn start(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
            loop {
                interval.tick().await;
                this.tick().await;
            }
        });
    }

    fn now_minute() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            / 60
    }

    /// 检查这一分钟内是否有启用+配置 cron 的工作流需要触发。
    pub async fn tick(&self) {
        let minute = Self::now_minute();
        {
            let mut guard = self.last_minute.lock().unwrap_or_else(|p| p.into_inner());
            if *guard == minute {
                return;
            }
            *guard = minute;
        }
        let Ok(ids) = self.store.list_ids() else {
            return;
        };
        for id in ids {
            if self.running.lock().unwrap_or_else(|p| p.into_inner()).contains(&id) {
                continue;
            }
            let Ok(workflow) = self.store.read(&id) else {
                continue;
            };
            if !workflow.schedule.is_active() {
                continue;
            }
            let Some(expr) = workflow.schedule.cron.clone() else {
                continue;
            };
            if cron_matches_minute(&expr, minute) {
                let _ = self.run_internal(&id, "schedule").await;
            }
        }
    }

    /// 手动触发（Web API）。返回运行记录 id。
    pub async fn run_manual(self: &Arc<Self>, id: &str) -> Result<String> {
        self.run_internal(id, "manual").await
    }

    async fn run_internal(&self, id: &str, trigger: &str) -> Result<String> {
        {
            let mut guard = self.running.lock().unwrap_or_else(|p| p.into_inner());
            if guard.contains(id) {
                anyhow::bail!("workflow `{id}` is already running");
            }
            guard.insert(id.to_owned());
        }
        let permit = match self.slots.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => {
                self.running.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
                anyhow::bail!("workflow slots exhausted; retry shortly");
            }
        };

        let run_id = Uuid::new_v4().to_string();
        let mut workflow = self
            .store
            .read(id)
            .context("workflow disappeared while starting")?;
        let trigger_owned = trigger.to_owned();
        self.runs.push(id, &RunRecord {
            id: run_id.clone(),
            started_at: now_ts(),
            finished_at: None,
            status: "running".into(),
            duration_ms: None,
            trigger: trigger_owned.clone(),
            steps: Vec::new(),
        });

        let runs = RunsStore::new(&self.home);
        let executor = Arc::clone(&self.executor);
        let store = WorkflowStore::new(&self.home);
        let running_guard = Arc::clone(&self.running);
        let workflow_id = id.to_owned();
        let record_id = run_id.clone();
        tokio::spawn(async move {
            let started = now_ts();
            let outcome = WorkflowRunner::run(&mut workflow, executor.as_ref()).await;
            let finished = now_ts();
            let status = match &outcome {
                Ok(WorkflowRunOutcome::Completed) => "completed",
                Ok(_) => "cancelled",
                Err(_) => "failed",
            };
            let steps: Vec<StepOutcome> = workflow
                .steps
                .iter()
                .map(|s| StepOutcome {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    state: format!("{:?}", s.state).to_lowercase(),
                    duration_ms: None,
                    error: match &s.result {
                        Some(value) => value.get("error").and_then(Value::as_str).map(|e| e.to_owned()),
                        None => None,
                    },
                })
                .collect();
            if let Err(error) = &outcome {
                eprintln!("workflow {workflow_id} failed: {error:#}");
            }
            let _ = store.save(&workflow);
            runs.upsert(&workflow_id, &RunRecord {
                id: record_id,
                started_at: started,
                finished_at: Some(finished),
                status: status.into(),
                duration_ms: Some(finished.saturating_sub(started) * 1000),
                trigger: trigger_owned,
                steps,
            });
            running_guard.lock().unwrap_or_else(|p| p.into_inner()).remove(&workflow_id);
            drop(permit);
        });
        Ok(run_id)
    }

}

// ---------------------------------------------------------------------------
// cron 匹配
// ---------------------------------------------------------------------------

/// 判断给定 cron 表达式是否命中「当前这一分钟」（按本地时区）。
fn cron_matches_minute(expr: &str, _minute: u64) -> bool {
    let now = chrono::Local::now();
    // 无秒 cron（5 段）只在分钟起点匹配，秒/纳秒必须归零再比对。
    let floor = now
        .with_second(0)
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(now);
    let Ok(parsed) = croner::Cron::new(expr)
        .with_seconds_optional()
        .parse()
    else {
        return false;
    };
    parsed.is_time_matching(&floor).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::cron_matches_minute;

    #[test]
    fn every_minute_matches() {
        assert!(cron_matches_minute("* * * * *", 1));
    }

    #[test]
    fn fixed_hour_does_not_match_now() {
        // True only when the wall clock is exactly 04:15; the point here is that
        // a fixed minute does NOT match every minute.
        let now_min = chrono::Local::now().format("%M").to_string();
        let expected = now_min == "15";
        assert_eq!(cron_matches_minute("15 * * * *", 1), expected);
    }

    #[test]
    fn invalid_cron_never_matches() {
        assert!(!cron_matches_minute("not a cron", 1));
    }
}

// ---------------------------------------------------------------------------
// 内置模板
// ---------------------------------------------------------------------------

pub fn builtin_templates() -> Vec<Value> {
    let entry = |key: &str, name: &str, description: &str, default_cron: &str, steps: Vec<Value>| {
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
            "检查手机 Linux 环境：系统信息、磁盘占用与宿主目录汇总，适合定时采集。",
            "0 8 * * *",
            vec![
                json!({"id": "sys", "name": "系统信息", "action": {"kind": "tool", "tool": "shell", "arguments": {"command": "uname -a && echo --- && date && echo --- && df -h | head -6"}}}),
                json!({"id": "home", "name": "宿主目录", "depends_on": ["sys"], "action": {"kind": "tool", "tool": "shell", "arguments": {"command": "ls -la ~ | head -20"}}}),
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
                json!({"id": "snap", "name": "生成快照", "action": {"kind": "tool", "tool": "shell", "arguments": {"command": "mkdir -p ~/coomi-snapshots && date >> ~/coomi-snapshots/daily.log && echo ok"}}}),
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
