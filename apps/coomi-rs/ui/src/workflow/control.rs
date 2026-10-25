use super::{RunRecord, RunsStore};
use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use coomi_engine::{
    ApprovalHandler, ToolCall, TurnControl, UserInputRequest, UserInputResponse, WorkflowState,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, oneshot};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Interaction {
    pub id: String,
    pub kind: String,
    pub prompt: String,
    pub tool: Option<ToolCall>,
    pub questions: Option<UserInputRequest>,
}
pub struct RunState {
    pub store: RunsStore,
    pub workflow_id: String,
    pub record: Mutex<RunRecord>,
    pub paused: AtomicBool,
    pub started: AtomicBool,
    pub cancelled: AtomicBool,
    pub wake: Notify,
    pub cancel_wake: Notify,
    pending: Mutex<Option<(String, oneshot::Sender<Value>)>>,
    denied: AtomicBool,
}
impl RunState {
    pub fn new(store: RunsStore, workflow_id: String, record: RunRecord) -> Arc<Self> {
        Arc::new(Self {
            store,
            workflow_id,
            record: Mutex::new(record),
            paused: AtomicBool::new(false),
            started: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            wake: Notify::new(),
            cancel_wake: Notify::new(),
            pending: Mutex::new(None),
            denied: AtomicBool::new(false),
        })
    }
    pub fn change(&self, update: impl FnOnce(&mut RunRecord)) -> Result<()> {
        let mut record = self.record.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = record.clone();
        update(&mut next);
        self.store.upsert(&self.workflow_id, &next)?;
        *record = next;
        Ok(())
    }
    pub fn checkpoint(&self, path: &str, workflow: &WorkflowState) -> Result<()> {
        self.change(|record| {
            if path.is_empty() {
                record.snapshot = Some(workflow.clone());
                record.steps = super::step_outcomes(workflow);
            } else {
                record.children.insert(path.into(), workflow.clone());
            }
        })
    }
    pub fn pause(&self) -> Result<()> {
        self.set_paused(true)
    }
    pub fn resume(&self) -> Result<()> {
        self.set_paused(false)?;
        self.wake.notify_one();
        Ok(())
    }
    fn set_paused(&self, value: bool) -> Result<()> {
        let mut record = self.record.lock().unwrap_or_else(|e| e.into_inner());
        anyhow::ensure!(super::is_active(&record.status), "run has already finished");
        anyhow::ensure!(
            value || self.paused.load(Ordering::SeqCst),
            "run is not paused"
        );
        let mut next = record.clone();
        if next.pending.is_none() {
            next.status = if value {
                "pause_pending"
            } else if self.started.load(Ordering::SeqCst) {
                "running"
            } else {
                "queued"
            }
            .into();
        }
        self.store.upsert(&self.workflow_id, &next)?;
        *record = next;
        self.paused.store(value, Ordering::SeqCst);
        Ok(())
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        self.wake.notify_one();
        self.cancel_wake.notify_one();
    }
    pub fn answer(&self, id: &str, answer: Value) -> Result<()> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.as_ref().map(|(key, _)| key.as_str()) != Some(id) {
            bail!("request is no longer pending");
        }
        let interaction = self
            .record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .clone()
            .context("request is no longer pending")?;
        if interaction.kind == "approval" {
            anyhow::ensure!(
                answer.get("allow").is_some_and(Value::is_boolean),
                "allow must be a boolean"
            );
        } else {
            let answers: UserInputResponse =
                serde_json::from_value(answer.get("answers").cloned().unwrap_or(Value::Null))?;
            if let Some(questions) = interaction.questions {
                anyhow::ensure!(
                    questions
                        .questions
                        .iter()
                        .all(|q| answers.get(&q.id).is_some_and(|a| !a.trim().is_empty())),
                    "answer every question before submitting"
                );
            }
        }
        let (_, sender) = pending.take().expect("checked pending");
        sender
            .send(answer)
            .map_err(|_| anyhow::anyhow!("request already closed"))
    }
    async fn interact(&self, interaction: Interaction) -> Result<Value> {
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            anyhow::ensure!(pending.is_none(), "another request is pending");
            *pending = Some((interaction.id.clone(), sender));
        }
        let status = if interaction.kind == "question" {
            "awaiting_input"
        } else {
            "awaiting_approval"
        };
        if let Err(error) = self.change(|r| {
            r.status = status.into();
            r.pending = Some(interaction);
        }) {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            return Err(error);
        }
        let result = receiver
            .await
            .map_err(|_| anyhow::anyhow!("request cancelled"));
        self.change(|r| {
            r.pending = None;
            r.status = "running".into();
        })?;
        self.safe_point().await?;
        if result
            .as_ref()
            .ok()
            .and_then(|v| v.get("allow"))
            .and_then(Value::as_bool)
            == Some(false)
        {
            self.denied.store(true, Ordering::SeqCst);
        }
        result
    }
    pub async fn approve_explicit(&self, prompt: &str) -> bool {
        self.interact(Interaction {
            id: Uuid::new_v4().to_string(),
            kind: "approval".into(),
            prompt: prompt.into(),
            tool: None,
            questions: None,
        })
        .await
        .ok()
        .and_then(|v| v.get("allow").and_then(Value::as_bool))
        .unwrap_or(false)
    }
}
#[async_trait]
impl TurnControl for RunState {
    async fn safe_point(&self) -> Result<()> {
        loop {
            // Notify stores one permit, preventing a resume between check and wait from being lost.
            let notified = self.wake.notified();
            if self.cancelled.load(Ordering::SeqCst) {
                bail!("workflow cancelled");
            }
            if self.denied.load(Ordering::SeqCst) {
                bail!("workflow approval denied");
            }
            {
                let mut record = self.record.lock().unwrap_or_else(|e| e.into_inner());
                if !self.paused.load(Ordering::SeqCst) {
                    return Ok(());
                }
                let mut next = record.clone();
                next.status = "paused".into();
                self.store.upsert(&self.workflow_id, &next)?;
                *record = next;
            }
            notified.await;
        }
    }
}
#[async_trait]
impl ApprovalHandler for RunState {
    async fn approve(&self, call: &ToolCall, reason: &str) -> bool {
        self.interact(Interaction {
            id: Uuid::new_v4().to_string(),
            kind: "approval".into(),
            prompt: reason.into(),
            tool: Some(call.clone()),
            questions: None,
        })
        .await
        .ok()
        .and_then(|v| v.get("allow").and_then(Value::as_bool))
        .unwrap_or(false)
    }
    async fn request_user_input(&self, request: &UserInputRequest) -> Option<UserInputResponse> {
        let value = self
            .interact(Interaction {
                id: Uuid::new_v4().to_string(),
                kind: "question".into(),
                prompt: "工作流需要补充信息".into(),
                tool: None,
                questions: Some(request.clone()),
            })
            .await
            .ok()?;
        serde_json::from_value(value.get("answers").cloned().unwrap_or(json!({}))).ok()
    }
}
