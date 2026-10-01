//! 协同任务 CRUD API：列表/创建/启动/事件/产物/草稿/详情/删除/取消/打断/重试。
//! 编排逻辑（run_collab_turn / orchestrated）仍留在 mod.rs，后续再拆。
use axum::extract::{Path as AxumPath, Query, State};
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use crate::collab::CollabTaskStatus;
use crate::web::{ApiError, AppState, CollabSettings};

pub(in crate::web) async fn list_collab_tasks(State(state): State<AppState>) -> Json<Value> {
    let tasks = state.collab_runtime.list_task_summaries().await;
    Json(json!({ "tasks": tasks }))
}

pub(in crate::web) async fn create_collab_task(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let task_text = body
        .get("task")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::bad_request("task is required"))?
        .to_owned();
    let session_id = body
        .get("session_id")
        .or_else(|| body.get("sessionId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| task_text.chars().take(42).collect());
    let cwd = body
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let settings: CollabSettings = body
        .get("settings")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_else(|| crate::web::read_collab_settings(&state.home));
    let auto_start = body
        .get("auto_start")
        .or_else(|| body.get("autoStart"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let collab_task = state
        .collab_runtime
        .create_task(&session_id, &task_text, &title, &cwd, settings.clone())
        .await;
    state
        .collab_runtime
        .append_message(&collab_task.id, "owner", "all", &task_text)
        .await;

    if !auto_start {
        state
            .collab_runtime
            .update_status_blocking(&collab_task.id, CollabTaskStatus::Draft, None)
            .await;
        return Ok(Json(json!({
            "ok": true,
            "task_id": collab_task.id,
            "status": "draft",
            "agent_ids": [],
        })));
    }

    crate::web::launch_collab_execution(
        &state,
        &collab_task.id,
        &session_id,
        &task_text,
        &settings,
        &cwd,
    )
    .await
}

pub(in crate::web) async fn start_collab_task(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let task = state
        .collab_runtime
        .get_task(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("collab task {id} not found")))?;
    if !matches!(task.status, CollabTaskStatus::Draft | CollabTaskStatus::Queued) {
        return Err(ApiError::bad_request(format!(
            "task is {:?}, only draft/queued can be started",
            task.status.as_str()
        )));
    }
    crate::web::launch_collab_execution(
        &state,
        &id,
        &task.session_id,
        &task.task,
        &task.settings,
        &task.cwd,
    )
    .await
}

pub(in crate::web) async fn list_collab_events(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let task = state
        .collab_runtime
        .get_task(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("collab task {id} not found")))?;
    let since = params
        .get("since_seq")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let total = task.events.len();
    let events: Vec<Value> = task.events.into_iter().skip(since).collect();
    Ok(Json(json!({ "events": events, "next_seq": total, "total": total })))
}

pub(in crate::web) async fn list_collab_artifacts(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let task = state
        .collab_runtime
        .get_task(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("collab task {id} not found")))?;
    Ok(Json(json!({ "artifacts": task.artifacts })))
}

pub(in crate::web) async fn list_collab_drafts(State(state): State<AppState>) -> Json<Value> {
    let drafts = state.collab_runtime.load_drafts();
    Json(json!({ "drafts": drafts }))
}

pub(in crate::web) async fn save_collab_draft(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if !body.is_object() {
        return Err(ApiError::bad_request("draft object required"));
    }
    let id = state.collab_runtime.upsert_draft(body);
    Ok(Json(json!({ "ok": true, "id": id })))
}

pub(in crate::web) async fn delete_collab_draft(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    if !state.collab_runtime.delete_draft(&id) {
        return Err(ApiError::not_found("draft not found"));
    }
    Ok(Json(json!({ "ok": true, "id": id })))
}

pub(in crate::web) async fn get_collab_task(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let task = state
        .collab_runtime
        .get_task(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("collab task {id} not found")))?;
    match serde_json::to_value(&task) {
        Ok(value) => Ok(Json(value)),
        Err(error) => Ok(Json(json!({ "error": format!("serialization failed: {error}") }))),
    }
}

pub(in crate::web) async fn get_collab_task_lite(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    state
        .collab_runtime
        .task_summary(&id)
        .await
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("collab task {id} not found")))
}

pub(in crate::web) async fn delete_collab_task(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let deleted = state.collab_runtime.delete_task(&id).await;
    if !deleted {
        return Err(ApiError::not_found(format!("collab task {id} not found")));
    }
    Ok(Json(json!({ "deleted": true, "id": id })))
}

pub(in crate::web) async fn cancel_collab_task(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let exists = state.collab_runtime.get_task(&id).await.is_some();
    if !exists {
        return Err(ApiError::not_found(format!("collab task {id} not found")));
    }
    let cancelled = state.collab_runtime.cancel_task(&id).await;
    Ok(Json(json!({ "cancelled": cancelled, "id": id })))
}

pub(in crate::web) async fn interrupt_collab_task(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let Some(task) = state.collab_runtime.get_task(&id).await else {
        return Err(ApiError::not_found(format!("collab task {id} not found")));
    };
    if !matches!(
        task.status,
        CollabTaskStatus::Starting | CollabTaskStatus::Running
    ) {
        return Err(ApiError::bad_request("task is not running"));
    }
    state.collab_runtime.interrupt_agents(&id).await;
    for agent in &task.agents {
        if agent.status == "running" || agent.status == "starting" {
            state
                .collab_runtime
                .finish_agent(&id, &agent.id, "failed", "", "", Some("被用户硬打断"))
                .await;
        }
    }
    let _ = state
        .collab_runtime
        .append_message(&id, "system", "all", "用户触发硬打断：当前工具已中止。")
        .await;
    let context = state.task(&task.session_id);
    context.push_event(json!({
        "event_type": "collab_agent_message",
        "task_id": id,
        "from": "system",
        "to": "all",
        "content": "用户触发硬打断",
        "ts": crate::web::unix_time(),
    }));
    Ok(Json(json!({ "ok": true, "id": id, "interrupted": true })))
}

pub(in crate::web) async fn retry_collab_task(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let task = state
        .collab_runtime
        .get_task(&id)
        .await
        .ok_or_else(|| ApiError::not_found(format!("collab task {id} not found")))?;
    if !matches!(
        task.status,
        CollabTaskStatus::Failed
            | CollabTaskStatus::Partial
            | CollabTaskStatus::Cancelled
            | CollabTaskStatus::Interrupted
    ) {
        return Err(ApiError::bad_request(
            "task can only be retried from failed/partial/cancelled/interrupted status",
        ));
    }
    state.collab_runtime.reset_for_retry(&id).await;
    state
        .collab_runtime
        .set_retry_count(&id, task.retry_count.saturating_add(1))
        .await;
    let _ = state
        .collab_runtime
        .append_message(&id, "system", "all", "任务重试：保留此前对话与产物，重新启动执行。")
        .await;
    let result = crate::web::launch_collab_execution(
        &state,
        &id,
        &task.session_id,
        &task.task,
        &task.settings,
        &task.cwd,
    )
    .await?;
    let mut value = result.0;
    value["original_id"] = json!(id);
    value["new_task_id"] = json!(id);
    Ok(Json(value))
}
