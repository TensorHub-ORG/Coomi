//! 群聊数字生命体 API：创建 / 列表 / 搜索 / 更新 / 绑定 / 删除。
use axum::extract::{Path as AxumPath, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::web::{ApiError, AppState};

#[derive(Debug, Deserialize)]
pub struct RegistryQuery {
    #[serde(default)]
    pub q: Option<String>,
}

pub(in crate::web) async fn group_life_registry(
    State(state): State<AppState>,
    Query(query): Query<RegistryQuery>,
) -> Json<Value> {
    let lives = match query.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(q) => crate::group_life::search_lives(&state.home, q),
        None => crate::group_life::load_registry(&state.home).lives,
    };
    Json(json!({ "version": 1, "lives": lives }))
}

pub(in crate::web) async fn group_life_create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("name required"))?;
    let persona = body.get("persona").and_then(Value::as_str).unwrap_or("");
    let speaking_style = body
        .get("speakingStyle")
        .or_else(|| body.get("speaking_style"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let values = body.get("values").and_then(Value::as_str).unwrap_or("");
    let life = crate::group_life::create_life(&state.home, name, persona, speaking_style, values)
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    // 可选：创建时即设置关系尺度
    if let Some(scale) = body.get("relationshipScale").and_then(Value::as_str) {
        if matches!(scale, "light" | "standard" | "deep") {
            let _ = crate::group_life::update_life(
                &state.home,
                &life.id,
                &json!({ "relationshipScale": scale }),
            );
        }
    }
    let life = crate::group_life::find_by_id(&state.home, &life.id).unwrap_or(life);
    Ok(Json(serde_json::to_value(life).unwrap_or_default()))
}

pub(in crate::web) async fn group_life_update(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let life = crate::group_life::update_life(&state.home, &id, &body)
        .map_err(|e| ApiError::not_found(format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(life).unwrap_or_default()))
}

pub(in crate::web) async fn group_life_bind(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let room_id = body
        .get("roomId")
        .or_else(|| body.get("room_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("roomId required"))?;
    let member_id = body
        .get("memberId")
        .or_else(|| body.get("member_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("memberId required"))?;
    let identity_id = body
        .get("identityId")
        .or_else(|| body.get("identity_id"))
        .and_then(Value::as_str);
    // 1. 写 registry（1:1 强制：旧绑定自动清除）
    let life = crate::group_life::bind_to_member_identity(
        &state.home, &id, room_id, member_id, identity_id,
    )
    .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    // 2. 同步更新内存中的 ChatMember.life_id
    let mut room_project: Option<String> = None;
    if let Some(room) = state.group_chat.get(room_id).await {
        room_project = room.project_id.clone();
        let mut members = room.members;
        for m in members.iter_mut() {
            if m.id == member_id {
                m.life_id = Some(id.clone());
            }
            // 一命一角：其他成员不得再绑同一生命体
            if m.id != member_id && m.life_id.as_deref() == Some(id.as_str()) {
                m.life_id = None;
            }
        }
        let _ = state.group_chat.update_members(room_id, members).await;
    }
    // 3. 同步身份档案 life_id
    if let Some(iid) = identity_id {
        if let Some(pid) = room_project
            .or_else(|| crate::projects::project_of_room(&state.home, room_id))
        {
            let _ = crate::projects::update_identity(
                &state.home,
                &pid,
                iid,
                &json!({ "lifeId": id }),
            );
        }
    }
    Ok(Json(json!({ "ok": true, "life": life })))
}

pub(in crate::web) async fn group_life_unbind(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let life = crate::group_life::unbind(&state.home, &id)
        .map_err(|e| ApiError::not_found(format!("{e:#}")))?;
    Ok(Json(serde_json::to_value(life).unwrap_or_default()))
}

pub(in crate::web) async fn group_life_delete(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    crate::group_life::delete_life(&state.home, &id)
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    Ok(Json(json!({ "ok": true })))
}
