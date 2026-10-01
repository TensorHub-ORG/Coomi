//! 本地模型 API handlers：状态/目录/参数/启停/下载。
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::web::{ApiError, AppState};

pub(in crate::web) async fn local_model_state(State(state): State<AppState>) -> Json<Value> {
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    serde_json::to_value(runtime.state())
        .map(Json)
        .unwrap_or_else(|_| Json(json!({})))
}

pub(in crate::web) async fn local_model_catalog(State(state): State<AppState>) -> Json<Value> {
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    Json(runtime.catalog())
}

pub(in crate::web) async fn local_model_set_params(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mut p = crate::local_model::LocalModelParams::default();
    if let Some(v) = body.get("temperature").and_then(Value::as_f64) {
        p.temperature = v as f32;
    }
    if let Some(v) = body.get("topP").or_else(|| body.get("top_p")).and_then(Value::as_f64) {
        p.top_p = v as f32;
    }
    if let Some(v) = body.get("topK").or_else(|| body.get("top_k")).and_then(Value::as_u64) {
        p.top_k = v as u32;
    }
    if let Some(v) = body.get("maxTokens").or_else(|| body.get("max_tokens")).and_then(Value::as_u64) {
        p.max_tokens = v as u32;
    }
    if let Some(v) = body.get("contextLen").or_else(|| body.get("context_len")).and_then(Value::as_u64) {
        p.context_len = v as u32;
    }
    if let Some(v) = body.get("threads").and_then(Value::as_u64) {
        p.threads = v.clamp(1, 32) as u32;
    }
    if let Some(v) = body.get("gpuLayers").or_else(|| body.get("gpu_layers")).and_then(Value::as_i64) {
        p.gpu_layers = v as i32;
    }
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    runtime.save_params(&p).map_err(|e| ApiError::internal(format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(runtime.state()).unwrap_or_default()))
}

/// 设置 llama-server 下载/来源偏好：auto | vulkan | standard | android | termux
pub(in crate::web) async fn local_model_set_backend_pref(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let pref = body
        .get("pref")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("pref is required (auto|vulkan|standard|android|termux)"))?;
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    runtime
        .save_backend_pref(pref)
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(runtime.state()).unwrap_or_default()))
}

pub(in crate::web) async fn local_model_enable(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let id = body.get("id").and_then(Value::as_str);
    let enabled = body.get("enabled").and_then(Value::as_bool).unwrap_or(id.is_some());
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    if enabled {
        let id = id.ok_or_else(|| ApiError::bad_request("id required"))?;
        let state_out = runtime
            .enable_and_start(id)
            .await
            .map_err(|e| ApiError::internal(format!("{e:#}")))?;
        return Ok(Json(serde_json::to_value(state_out).unwrap_or_default()));
    }
    let state_out = runtime
        .set_enabled(None)
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(state_out).unwrap_or_default()))
}

pub(in crate::web) async fn local_model_register(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("path required"))?;
    let name = body.get("name").and_then(Value::as_str).unwrap_or("");
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    let entry = runtime
        .register_path(path, name)
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(entry).unwrap_or_default()))
}

pub(in crate::web) async fn local_model_delete(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let id = body
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("id required"))?;
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    runtime
        .delete_model(id)
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(json!({ "ok": true })))
}

pub(in crate::web) async fn local_model_install_backend(State(state): State<AppState>) -> Json<Value> {
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    match runtime.install_backend().await {
        Ok(msg) => Json(json!({ "ok": true, "message": msg })),
        Err(e) => Json(json!({ "ok": false, "error": format!("{e:#}") })),
    }
}

pub(in crate::web) async fn local_model_start_server(State(state): State<AppState>) -> Json<Value> {
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    match runtime.start_server().await {
        Ok(msg) => Json(json!({ "ok": true, "message": msg, "state": runtime.state() })),
        Err(e) => Json(json!({ "ok": false, "error": format!("{e:#}") })),
    }
}

pub(in crate::web) async fn local_model_stop_server(State(state): State<AppState>) -> Json<Value> {
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    match runtime.stop_server().await {
        Ok(msg) => Json(json!({ "ok": true, "message": msg, "state": runtime.state() })),
        Err(e) => Json(json!({ "ok": false, "error": format!("{e:#}") })),
    }
}

pub(in crate::web) async fn local_model_download(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let id = body.get("id").and_then(Value::as_str).unwrap_or("");
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    match runtime.download_model(id).await {
        Ok(msg) => Json(json!({ "ok": true, "message": msg, "state": runtime.state() })),
        Err(e) => Json(json!({ "ok": false, "error": format!("{e:#}") })),
    }
}

pub(in crate::web) async fn local_model_download_progress(State(state): State<AppState>) -> Json<Value> {
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    Json(serde_json::to_value(runtime.download_progress()).unwrap_or_default())
}

pub(in crate::web) async fn local_model_download_cancel(State(state): State<AppState>) -> Json<Value> {
    let runtime = crate::local_model::LocalModelRuntime::new(&state.home);
    runtime.cancel_download();
    Json(json!({ "ok": true }))
}
