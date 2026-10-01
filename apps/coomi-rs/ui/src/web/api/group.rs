//! 群聊 HTTP handlers：房间 CRUD / 成员管理 / 发言调度。
use axum::extract::{Path as AxumPath, State};
use axum::Json;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::web::{ApiError, AppState};
use crate::group::engine;
use crate::group::types::*;

// ── 列表 / 查询 ──────────────────────────────────────────────

pub(in crate::web) async fn list_group_rooms(State(state): State<AppState>) -> Json<Value> {
    let rooms = state.group_chat.list_summaries().await;
    Json(json!({ "rooms": rooms, "summary": true }))
}

pub(in crate::web) async fn list_group_rooms_full(State(state): State<AppState>) -> Json<Value> {
    let rooms = state.group_chat.list().await;
    Json(json!({ "rooms": rooms, "summary": false }))
}

pub(in crate::web) async fn get_group_room(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let room = state
        .group_chat
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

// ── 房间 CRUD ────────────────────────────────────────────────

pub(in crate::web) async fn delete_group_room(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    if !state.group_chat.delete(&id).await {
        return Err(ApiError::not_found("room not found"));
    }
    // 同步清理项目 registry 里的房间引用与工作目录，避免项目统计/列表残留。
    let home = state.home.clone();
    let room_id = id.clone();
    tokio::task::spawn_blocking(move || crate::projects::unregister_room(&home, &room_id))
        .await
        .ok();
    Ok(Json(json!({ "ok": true })))
}

pub(in crate::web) async fn create_group_room(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = body.get("name").and_then(Value::as_str).unwrap_or("新群聊").trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("群聊名称不能为空"));
    }
    {
        let rooms = state.group_chat.list().await;
        if rooms
            .iter()
            .any(|r| r.name.trim().eq_ignore_ascii_case(name))
        {
            return Err(ApiError::bad_request("群聊名称已存在，请换一个"));
        }
    }
    let topic = body.get("topic").and_then(Value::as_str).unwrap_or("");
    let mode = match body
        .get("speakMode")
        .or_else(|| body.get("speak_mode"))
        .and_then(Value::as_str)
    {
        Some("open") | Some("Open") => SpeakMode::Open,
        Some("host") | Some("Host") => SpeakMode::Host,
        _ => SpeakMode::RoundRobin,
    };
    let project_id = body
        .get("projectId")
        .or_else(|| body.get("project_id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| crate::projects::active_project_id(&state.home));
    let overwrite_persona = body
        .get("overwritePersona")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let members_raw = body
        .get("members")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if members_raw.is_empty() {
        return Err(ApiError::bad_request("至少需要 1 个成员"));
    }

    let mut members = Vec::new();
    let mut reused_names: Vec<String> = Vec::new();
    for (i, m) in members_raw.iter().enumerate() {
        let id = m
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("m{i}"));
        let member_name = m
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| id.clone());
        let persona = m.get("persona").and_then(Value::as_str).unwrap_or("").to_owned();
        let speaking_style = m
            .get("speakingStyle")
            .or_else(|| m.get("speaking_style"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let values = m.get("values").and_then(Value::as_str).unwrap_or("").to_owned();
        let model_selector = m
            .get("modelSelector")
            .or_else(|| m.get("model_selector"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let color = m
            .get("color")
            .and_then(Value::as_str)
            .unwrap_or("#2d61c6")
            .to_owned();
        let icon = m
            .get("icon")
            .and_then(Value::as_str)
            .unwrap_or("chat")
            .to_owned();

        let mut identity_id: Option<String> = None;
        if let Some(pid) = &project_id {
            let (ident, created) = crate::projects::find_or_create_identity(
                &state.home,
                pid,
                &member_name,
                &persona,
                &speaking_style,
                &values,
                &model_selector,
                &color,
                &icon,
            )
            .map_err(|e| ApiError::internal(format!("{e:#}")))?;
            if !created && !overwrite_persona {
                reused_names.push(member_name.clone());
            }
            if !created && overwrite_persona && !persona.is_empty() {
                let _ = crate::projects::update_identity(
                    &state.home,
                    pid,
                    &ident.id,
                    &serde_json::json!({
                        "persona": persona,
                        "speakingStyle": speaking_style,
                        "values": values,
                    }),
                );
            }
            identity_id = Some(ident.id);
        }

        members.push(ChatMember {
            id,
            name: member_name,
            model_selector,
            prompt: m.get("prompt").and_then(Value::as_str).unwrap_or("").to_owned(),
            color,
            icon,
            quota: m.get("quota").and_then(Value::as_u64).unwrap_or(0) as u32,
            persona,
            speaking_style,
            values,
            emotion_bias: m
                .get("emotionBias")
                .or_else(|| m.get("emotion_bias"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as f32,
            life_id: m
                .get("lifeId")
                .or_else(|| m.get("life_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            identity_id,
        });
    }

    let room = state
        .group_chat
        .create_in_project(name, topic, mode, members, project_id.as_deref())
        .await;

    if let Some(pid) = &project_id {
        for m in &room.members {
            if let Some(iid) = &m.identity_id {
                crate::projects::link_identity_room(&state.home, pid, iid, &room.id);
            }
        }
    }

    Ok(Json(serde_json::json!({
        "room": room,
        "reusedIdentities": reused_names,
    })))
}

// ── 字段更新 ────────────────────────────────────────────────

pub(in crate::web) async fn set_group_topic(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let topic = body.get("topic").and_then(Value::as_str).unwrap_or("");
    let room = state
        .group_chat
        .set_topic(&id, topic)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn set_group_speak_mode(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mode = match body
        .get("speakMode")
        .or_else(|| body.get("speak_mode"))
        .and_then(Value::as_str)
    {
        Some("open") | Some("Open") => SpeakMode::Open,
        Some("host") | Some("Host") => SpeakMode::Host,
        _ => SpeakMode::RoundRobin,
    };
    let room = state
        .group_chat
        .set_speak_mode(&id, mode)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn set_group_host_allow(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let allow = body
        .get("allow")
        .or_else(|| body.get("hostAllow"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let room = state
        .group_chat
        .set_host_allow(&id, allow)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn set_group_effort(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let effort = body
        .get("reasoningEffort")
        .or_else(|| body.get("effort"))
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let room = state
        .group_chat
        .set_reasoning_effort(&id, effort)
        .await
        .ok_or_else(|| ApiError::bad_request("invalid effort"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn merge_group_paths(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let paths = body
        .get("paths")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let room = state
        .group_chat
        .merge_context_paths(&id, paths)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn clear_group_paths(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let room = state
        .group_chat
        .clear_context_paths(&id)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn set_group_work_dir(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let dir = body.get("dir").or_else(|| body.get("path")).and_then(Value::as_str).unwrap_or("");
    let room = state
        .group_chat
        .set_work_dir(&id, dir)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn patch_group_room(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mut room = state
        .group_chat
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    if let Some(name) = body.get("name").and_then(Value::as_str) {
        ensure_room_name_available(&state, &id, name).await?;
        room = state
            .group_chat
            .rename(&id, name)
            .await
            .ok_or_else(|| ApiError::bad_request("群名称不能为空"))?;
    }
    if let Some(topic) = body.get("topic").and_then(Value::as_str) {
        room = state
            .group_chat
            .set_topic(&id, topic)
            .await
            .ok_or_else(|| ApiError::not_found("room not found"))?;
    }
    if let Some(idle) = body
        .get("idleChatEnabled")
        .or_else(|| body.get("idle_chat_enabled"))
        .and_then(Value::as_bool)
    {
        room = state
            .group_chat
            .set_idle_chat(&id, idle)
            .await
            .ok_or_else(|| ApiError::not_found("room not found"))?;
    }
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn rename_group_room(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = body.get("name").and_then(Value::as_str).unwrap_or("");
    ensure_room_name_available(&state, &id, name).await?;
    let room = state
        .group_chat
        .rename(&id, name)
        .await
        .ok_or_else(|| ApiError::bad_request("群名称不能为空"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

/// 名称查重：排除自身；与创建路径同一套规则（trim + 忽略大小写）。
async fn ensure_room_name_available(
    state: &AppState,
    exclude_id: &str,
    name: &str,
) -> Result<(), ApiError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("群名称不能为空"));
    }
    let rooms = state
        .group_chat
        .list()
        .await;
    if rooms
        .iter()
        .any(|r| r.id != exclude_id && r.name.trim().eq_ignore_ascii_case(name))
    {
        return Err(ApiError::bad_request("群聊名称已存在，请换一个"));
    }
    Ok(())
}

// ── 成员 ────────────────────────────────────────────────────

pub(in crate::web) async fn update_group_members(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let members_raw = body
        .get("members")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| ApiError::bad_request("members required"))?;
    if members_raw.is_empty() {
        return Err(ApiError::bad_request("至少需要 1 个成员"));
    }
    let mut members = Vec::new();
    for (i, m) in members_raw.iter().enumerate() {
        let mid = m
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("m{i}"));
        members.push(ChatMember {
            id: mid.clone(),
            name: m
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| mid.clone()),
            model_selector: m
                .get("modelSelector")
                .or_else(|| m.get("model_selector"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            prompt: m.get("prompt").and_then(Value::as_str).unwrap_or("").to_owned(),
            color: m
                .get("color")
                .and_then(Value::as_str)
                .unwrap_or("#2d61c6")
                .to_owned(),
            icon: m
                .get("icon")
                .and_then(Value::as_str)
                .unwrap_or("chat")
                .to_owned(),
            quota: m.get("quota").and_then(Value::as_u64).unwrap_or(0) as u32,
            persona: m.get("persona").and_then(Value::as_str).unwrap_or("").to_owned(),
            speaking_style: m
                .get("speakingStyle")
                .or_else(|| m.get("speaking_style"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            values: m.get("values").and_then(Value::as_str).unwrap_or("").to_owned(),
            emotion_bias: m
                .get("emotionBias")
                .or_else(|| m.get("emotion_bias"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as f32,
            life_id: m
                .get("lifeId")
                .or_else(|| m.get("life_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            identity_id: m
                .get("identityId")
                .or_else(|| m.get("identity_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }
    let room = state
        .group_chat
        .update_members(&id, members)
        .await
        .map_err(ApiError::bad_request)?;
    for m in &room.members {
        if let Some(life_id) = m.life_id.as_deref() {
            let _ = crate::group_life::bind_to_member(&state.home, life_id, &id, &m.id);
        }
    }
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn remove_group_member(
    State(state): State<AppState>,
    AxumPath((id, member_id)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let room = state
        .group_chat
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    let member = room
        .members
        .iter()
        .find(|m| m.id == member_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found("member not found"))?;
    let project_id = room
        .project_id
        .clone()
        .or_else(|| crate::projects::project_of_room(&state.home, &id));

    if let Some(pid) = &project_id {
        let _ = crate::projects::remove_member_from_room(
            &state.home,
            pid,
            &id,
            &member_id,
            member.identity_id.as_deref(),
        );
    } else {
        let mut life_registry = crate::group_life::load_registry(&state.home);
        let mut changed = false;
        for life in life_registry.lives.iter_mut() {
            if life.bound_room_id.as_deref() == Some(id.as_str())
                && life.bound_member_id.as_deref() == Some(member_id.as_str())
            {
                life.bound_room_id = None;
                life.bound_member_id = None;
                life.bound_identity_id = None;
                changed = true;
            }
        }
        if changed {
            let _ = crate::group_life::save_registry_public(&state.home, &life_registry);
        }
    }

    let room = state
        .group_chat
        .remove_member(&id, &member_id)
        .await
        .ok_or_else(|| ApiError::not_found("member not found or room missing"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

// ── 历史 / 配额 / 轮次 ──────────────────────────────────────

pub(in crate::web) async fn clear_group_history(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let room = state
        .group_chat
        .clear_history(&id)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn reset_group_quotas(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let room = state
        .group_chat
        .reset_quotas(&id)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn cancel_group_round(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let room = state
        .group_chat
        .cancel_round(&id)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

pub(in crate::web) async fn set_group_mute(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let muted = body.get("muted").and_then(Value::as_bool).unwrap_or(false);
    let room = state
        .group_chat
        .set_mute(&id, muted)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}

// ── 活动 ────────────────────────────────────────────────────

pub(in crate::web) async fn get_member_activities(
    State(state): State<AppState>,
    AxumPath((id, member)): AxumPath<(String, String)>,
) -> Json<Value> {
    let activities = state.group_chat.member_activities(&id, &member, 50).await;
    let room = state.group_chat.get(&id).await;
    let member_info = room.as_ref().and_then(|r| {
        r.members
            .iter()
            .find(|m| m.id == member)
            .map(|m| serde_json::to_value(m).unwrap_or_default())
    });
    let recent = room.as_ref().map(|r| {
        r.messages
            .iter()
            .rev()
            .take(5)
            .filter(|m| m.from == member || m.to == member)
            .map(|m| serde_json::to_value(m).unwrap_or_default())
            .collect::<Vec<_>>()
    });
    Json(json!({
        "activities": activities,
        "member": member_info,
        "recentMessages": recent.unwrap_or_default(),
    }))
}

// ── 发消息 ──────────────────────────────────────────────────

pub(in crate::web) async fn send_group_message(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let content = body
        .get("content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("content required"))?
        .to_owned();
    let to = body
        .get("to")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && *s != "all")
        .map(str::to_owned);
    let reply_to = body
        .get("replyTo")
        .or_else(|| body.get("reply_to"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let mut to = to;
    if let Some(rid) = reply_to.as_deref() {
        if let Some(room) = state.group_chat.get(&id).await {
            if let Some(msg) = room.messages.iter().find(|m| m.id == rid) {
                let from = msg.from.clone();
                if from != "user" && from != "owner" && from != "system" {
                    to = Some(from);
                }
            }
        }
    }
    if to.is_none() {
        if let Some(room) = state.group_chat.get(&id).await {
            if let Some(mentioned) =
                crate::group::prompt::parse_mentions(&content, &room.members).into_iter().next()
            {
                to = Some(mentioned);
            }
        }
    }
    let attachments: Vec<String> = body
        .get("attachments")
        .or_else(|| body.get("paths"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if !attachments.is_empty() {
        let _ = state
            .group_chat
            .merge_context_paths(&id, attachments.clone())
            .await;
    }
    if let Some(room) = state.group_chat.get(&id).await {
        if room.speak_mode == SpeakMode::Host
            && to.is_none()
            && room.host_allow.is_empty()
        {
            let next = room.members.iter().find(|m| {
                let used = room.speak_counts.get(&m.id).copied().unwrap_or(0);
                m.quota == 0 || used < m.quota
            });
            if let Some(m) = next {
                let _ = state
                    .group_chat
                    .set_host_allow(&id, vec![m.id.clone()])
                    .await;
            }
        }
    }
    let round = state.group_chat.begin_round(&id).await;
    let targets = engine::user_speak_ex(&state.group_chat, &id, &content, to.as_deref(), attachments, reply_to)
        .await
        .map_err(ApiError::bad_request)?;
    if targets.is_empty() {
        let room = state
            .group_chat
            .get(&id)
            .await
            .ok_or_else(|| ApiError::not_found("room not found"))?;
        return Ok(Json(serde_json::to_value(room).unwrap_or_default()));
    }
    let registry = match coomi_services::ProviderRegistry::load(&crate::web::providers_path(
        &state.home,
    )) {
        Ok(r) => r,
        Err(e) => {
            return Err(ApiError::internal(format!("加载 provider 失败: {e:#}")));
        }
    };
    let room_snap = state
        .group_chat
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    let runtime = Arc::clone(&state.group_chat);
    let home = state.home.clone();
    let cwd = state.cwd.clone();
    let spawn_id = id.clone();
    tokio::spawn(async move {
        engine::run_wave(runtime, home, cwd, registry, spawn_id, round, targets, room_snap).await;
    });
    let room = state
        .group_chat
        .get(&id)
        .await
        .ok_or_else(|| ApiError::not_found("room not found"))?;
    Ok(Json(serde_json::to_value(room).unwrap_or_default()))
}
