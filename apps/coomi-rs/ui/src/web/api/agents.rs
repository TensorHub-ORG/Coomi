//! 子智能体 API：这里只放「读完整对话」的新接口；列表 / 关闭的历史实现
//! 仍留在 web::mod.rs（list_subagents_api / close_subagent_api），写法对齐即可。

use axum::extract::{Path as AxumPath, State};
use axum::Json;
use coomi_engine::ChatMessage;
use coomi_engine::Role;
use coomi_tools::AgentScheduler;
use serde_json::{json, Value};

use crate::web::{ApiError, AppState};

/// GET /api/agents/{id}/messages —— 单个子智能体详情（含完整对话消息）。
///
/// 数据源与 /api/agents 同一进程内注册表（AgentScheduler 的 Weak 表）：
/// 子智能体不存在（或所属调度器已 drop）返回 404，与 {id}/close 行为一致。
/// messages 只投影「只读展示所需的最小集」（role/content/reasoning/tools），
/// 不放敏感内部字段（request_context 记忆尾巴 / provider_items / 附件 / 置顶位等）。
pub(in crate::web) async fn agent_messages_api(
    State(_state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let (snapshot, messages) = AgentScheduler::detail_any(&id)
        .await
        .map_err(|error| ApiError::not_found(error))?;
    Ok(Json(json!({
        "id": snapshot.id,
        "status": snapshot.status,
        "task": snapshot.task,
        "output": snapshot.output,
        "elapsed_ms": u64::try_from(snapshot.elapsed_ms).unwrap_or(u64::MAX),
        "messages": messages.iter().map(message_json).collect::<Vec<_>>(),
    })))
}

/// ChatMessage → 只读展示最小集。role 用显式匹配（与引擎 types.rs 里
/// #[serde(rename_all = "lowercase")] 的序列化名一致）；reasoning / tools
/// 仅在非空时出现（对应接口形状里的可选字段）。
fn message_json(message: &ChatMessage) -> Value {
    let mut entry = serde_json::Map::new();
    entry.insert("role".to_owned(), json!(role_str(&message.role)));
    entry.insert("content".to_owned(), json!(message.content));
    if !message.reasoning.is_empty() {
        entry.insert("reasoning".to_owned(), json!(message.reasoning));
    }
    if !message.tool_calls.is_empty() {
        entry.insert(
            "tools".to_owned(),
            json!(message
                .tool_calls
                .iter()
                .map(|call| json!({
                    "id": call.id,
                    "name": call.name,
                    "arguments": call.arguments,
                }))
                .collect::<Vec<_>>()),
        );
    }
    Value::Object(entry)
}

/// 引擎 Role 的序列化名：system / user / assistant / tool。
fn role_str(role: &Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}
