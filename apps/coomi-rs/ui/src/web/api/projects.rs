//! 项目 / 身份 / 单聊 API。
use axum::extract::{Path as AxumPath, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::web::{ApiError, AppState};

#[derive(Debug, Deserialize)]
pub struct Q {
    #[serde(default)]
    pub q: Option<String>,
}

// ── 项目 ──────────────────────────────────────────────────

pub(in crate::web) async fn list_projects(State(state): State<AppState>) -> Json<Value> {
    let reg = crate::projects::load_registry(&state.home);
    let list: Vec<Value> = reg
        .projects
        .iter()
        .map(|p| crate::projects::project_summary(&state.home, p))
        .collect();
    // activeId：优先 reg.active_id，失效则回落第一个项目
    let active = reg
        .active_id
        .filter(|id| reg.projects.iter().any(|p| &p.id == id))
        .or_else(|| reg.projects.first().map(|p| p.id.clone()));
    Json(json!({
        "projects": list,
        "activeId": active,
        "hasLegacy": crate::projects::has_legacy_data(&state.home),
    }))
}

pub(in crate::web) async fn create_project(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = body.get("name").and_then(Value::as_str).unwrap_or("新项目");
    let desc = body.get("description").and_then(Value::as_str).unwrap_or("");
    let project = crate::projects::create_project(&state.home, name, desc)
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    Ok(Json(crate::projects::project_summary(&state.home, &project)))
}

pub(in crate::web) async fn get_project(
    State(state): State<AppState>,
    AxumPath(pid): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let project = crate::projects::get_project(&state.home, &pid)
        .ok_or_else(|| ApiError::not_found("项目不存在"))?;
    Ok(Json(crate::projects::project_summary(&state.home, &project)))
}

pub(in crate::web) async fn update_project(
    State(state): State<AppState>,
    AxumPath(pid): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let project = crate::projects::update_project(&state.home, &pid, &body)
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(crate::projects::project_summary(&state.home, &project)))
}

pub(in crate::web) async fn delete_project(
    State(state): State<AppState>,
    AxumPath(pid): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    crate::projects::delete_project(&state.home, &pid)
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    Ok(Json(json!({ "ok": true })))
}

pub(in crate::web) async fn activate_project(
    State(state): State<AppState>,
    AxumPath(pid): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let project = crate::projects::set_active(&state.home, &pid)
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(crate::projects::project_summary(&state.home, &project)))
}

/// 获取活跃项目；无项目返回 needsSetup=true，不自动创建。
pub(in crate::web) async fn ensure_active_project(State(state): State<AppState>) -> Json<Value> {
    match crate::projects::get_active_project(&state.home) {
        Some(p) => Json(crate::projects::project_summary(&state.home, &p)),
        None => Json(json!({ "needsSetup": true, "projects": [], "activeId": null })),
    }
}

/// 删除旧平铺群聊数据（用户确认后；先清 runtime 防写回）。
pub(in crate::web) async fn purge_legacy(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state.group_chat.clear_all_rooms().await;
    let n = crate::projects::purge_legacy_data(&state.home)
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    Ok(Json(json!({ "ok": true, "removedRooms": n })))
}

// ── 身份 / 通讯录 ─────────────────────────────────────────

pub(in crate::web) async fn list_identities(
    State(state): State<AppState>,
    AxumPath(pid): AxumPath<String>,
    Query(query): Query<Q>,
) -> Json<Value> {
    let q = query.q.as_deref().map(str::trim).unwrap_or("");
    let mut list = crate::projects::list_identities(&state.home, &pid);
    if !q.is_empty() {
        let lq = q.to_lowercase();
        list.retain(|i| {
            i.name.to_lowercase().contains(&lq)
                || i.persona.to_lowercase().contains(&lq)
        });
    }
    let out: Vec<Value> = list
        .iter()
        .map(|i| crate::projects::identity_summary(&state.home, i))
        .collect();
    Json(json!({ "identities": out }))
}

pub(in crate::web) async fn get_identity(
    State(state): State<AppState>,
    AxumPath((pid, iid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let identity = crate::projects::get_identity(&state.home, &pid, &iid)
        .ok_or_else(|| ApiError::not_found("身份不存在"))?;
    Ok(Json(crate::projects::identity_summary(&state.home, &identity)))
}

pub(in crate::web) async fn update_identity(
    State(state): State<AppState>,
    AxumPath((pid, iid)): AxumPath<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let identity = crate::projects::update_identity(&state.home, &pid, &iid, &body)
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(crate::projects::identity_summary(&state.home, &identity)))
}

/// 删除整个身份（通讯录/单聊删除）：所有群移除 + 删记忆/单聊。
pub(in crate::web) async fn delete_identity(
    State(state): State<AppState>,
    AxumPath((pid, iid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    // 先同步更新运行时内存中的房间（本项目 + identity.room_ids）
    let identity_rooms: Vec<String> = crate::projects::get_identity(&state.home, &pid, &iid)
        .map(|i| i.room_ids.clone())
        .unwrap_or_default();
    let rooms = state.group_chat.list().await;
    for room in rooms {
        let belongs = room.project_id.as_deref() == Some(pid.as_str())
            || identity_rooms.iter().any(|r| r == &room.id);
        if !belongs {
            continue;
        }
        let has = room.members.iter().any(|m| m.identity_id.as_deref() == Some(iid.as_str()));
        if has {
            let mut members = room.members;
            members.retain(|m| m.identity_id.as_deref() != Some(iid.as_str()));
            if members.is_empty() {
                // 至少保留一个占位？空群允许存在
            }
            let _ = state.group_chat.update_members(&room.id, members).await;
        }
    }
    let removed = crate::projects::delete_identity(&state.home, &pid, &iid)
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    Ok(Json(json!({ "ok": true, "removedFromRooms": removed })))
}

// ── 单聊 ──────────────────────────────────────────────────

pub(in crate::web) async fn get_dm(
    State(state): State<AppState>,
    AxumPath((pid, iid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    // 打开会话即清未读
    crate::projects::clear_dm_unread(&state.home, &pid, &iid);
    let msgs = crate::projects::load_dm_messages(&state.home, &pid, &iid);
    let identity = crate::projects::get_identity(&state.home, &pid, &iid)
        .ok_or_else(|| ApiError::not_found("身份不存在"))?;
    Ok(Json(json!({
        "identity": crate::projects::identity_summary(&state.home, &identity),
        "messages": msgs,
    })))
}

pub(in crate::web) async fn send_dm(
    State(state): State<AppState>,
    AxumPath((pid, iid)): AxumPath<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let content = body
        .get("content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad_request("content required"))?;
    let identity = crate::projects::get_identity(&state.home, &pid, &iid)
        .ok_or_else(|| ApiError::not_found("身份不存在"))?;

    // 附件（文件/授权目录路径）
    let attachments: Vec<String> = body
        .get("attachments")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    // user 消息入库
    let user_msg =
        crate::projects::append_dm_message(&state.home, &pid, &iid, "user", content, &attachments)
            .map_err(|e| ApiError::internal(format!("{e:#}")))?;

    // 生成身份回复（走 LLM，短回复）；有附件时提示
    let reply_text = if attachments.is_empty() {
        content.to_owned()
    } else {
        let paths: String = attachments
            .iter()
            .map(|p| format!("- {p}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("{content}\n\n（用户发来文件/目录）\n{paths}")
    };
    let compose_result = compose_dm_reply(&state, &pid, &iid, &identity, &reply_text).await;
    let (raw_reply, post_cmd) = compose_result.unwrap_or_else(|| ("……".into(), None));

    // 处理 post_to 指令：向目标群发消息
    let mut posted_to_room: Option<String> = None;
    if let Some((room_id, group_msg)) = &post_cmd {
        if let Some(room) = state.group_chat.get(room_id).await {
            // 找到该身份在群内对应的 member_id（而非直接用 identity_id）
            let member_id = room
                .members
                .iter()
                .find(|m| m.identity_id.as_deref() == Some(iid.as_str()))
                .map(|m| m.id.clone())
                .unwrap_or_else(|| iid.clone());
            let _ = crate::group::engine::agent_speak_ex(
                &state.group_chat,
                room_id,
                &member_id,
                group_msg,
                Vec::new(),
                None,
            )
            .await;
            posted_to_room = Some(room.name.clone());
        }
    }

    // 清理指令行，保留纯私聊回复
    let reply = strip_post_to(&raw_reply);
    let reply_display = if let Some(room_name) = &posted_to_room {
        format!("（已发送到群「{room_name}」）\n{reply}")
    } else {
        reply
    };

    let agent_msg =
        crate::projects::append_dm_message(&state.home, &pid, &iid, &iid, &reply_display, &[])
            .map_err(|e| ApiError::internal(format!("{e:#}")))?;

    // 每 8 轮自动总结用户习惯（异步，不阻塞回复）
    if identity.turn_count % 8 == 0 && identity.turn_count > 0 {
        let home = state.home.clone();
        let pid2 = pid.clone();
        let iid2 = iid.clone();
        let user_text = content.to_owned();
        tokio::spawn(async move {
            let _ = summarize_user_habits(&home, &pid2, &iid2, &user_text).await;
        });
    }

    Ok(Json(json!({
        "ok": true,
        "userMessage": user_msg,
        "reply": agent_msg,
        "postedToRoom": posted_to_room,
    })))
}

/// 异步总结用户习惯并写入记忆。
async fn summarize_user_habits(
    home: &std::path::Path,
    project_id: &str,
    identity_id: &str,
    recent_user_text: &str,
) {
    use coomi_services::ProviderRegistry;
    use coomi_tools::AgentScheduler;

    let Some(identity) = crate::projects::get_identity(home, project_id, identity_id) else {
        return;
    };
    let registry = match ProviderRegistry::load(&crate::web::providers_path(home)) {
        Ok(r) => r,
        Err(_) => return,
    };
    let selector = if identity.model_selector.trim().is_empty() {
        None
    } else {
        Some(identity.model_selector.as_str())
    };
    let Ok(provider) = registry.resolve(selector) else { return };
    let workdir = crate::projects::project_workdir(home, project_id);
    let _ = std::fs::create_dir_all(&workdir);

    let sys = format!(
        "你是「{}」，正在观察用户的行为习惯。根据用户最近的发言，\
         提取 1-3 条关于用户习惯/偏好/兴趣的简短观察（每条不超过 30 字）。\n\
         只输出观察条目，每条一行，以 - 开头。不要输出其他内容。",
        identity.name,
    );
    let scheduler = AgentScheduler::new(
        workdir,
        home.to_path_buf(),
        provider,
        coomi_security::AccessMode::ReadOnly,
        sys,
    );
    let task = format!("用户最近说：{recent_user_text}");
    if let Ok((text, _)) = scheduler
        .run_to_completion(identity_id.to_owned(), task, &[], None)
        .await
    {
        for line in text.lines() {
            let line = line.trim_start_matches('-').trim();
            if !line.is_empty() && line.len() > 4 {
                let _ = crate::projects::append_habit_memory(home, project_id, identity_id, line);
            }
        }
    }
}

async fn compose_dm_reply(
    state: &AppState,
    project_id: &str,
    identity_id: &str,
    identity: &crate::projects::Identity,
    user_text: &str,
) -> Option<(String, Option<(String, String)>)> {
    use coomi_services::ProviderRegistry;
    use coomi_tools::AgentScheduler;

    let registry = ProviderRegistry::load(&crate::web::providers_path(&state.home)).ok()?;
    let selector = if identity.model_selector.trim().is_empty() {
        None
    } else {
        Some(identity.model_selector.as_str())
    };
    let provider = registry.resolve(selector).ok()?;
    let workdir = crate::projects::project_workdir(&state.home, project_id);
    let _ = std::fs::create_dir_all(&workdir);

    // 注入可用群聊列表，允许 AI 主动发消息到群
    let room_ids = crate::projects::project_room_ids(&state.home, project_id);
    let all_rooms = {
        let rt = &state.group_chat;
        rt.list_summaries_filtered(None).await
            .into_iter()
            .filter(|r| {
                let pid = r.get("projectId").and_then(Value::as_str);
                pid == Some(project_id)
                    || room_ids.iter().any(|id| Some(id.as_str()) == r.get("id").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
    };
    let rooms_hint = if all_rooms.is_empty() {
        String::new()
    } else {
        let list: Vec<String> = all_rooms
            .iter()
            .map(|r| {
                let id = r.get("id").and_then(Value::as_str).unwrap_or("");
                let name = r.get("name").and_then(Value::as_str).unwrap_or("");
                format!("- 群「{name}」(id: {id})")
            })
            .collect();
        format!(
            "\n\n你可以向用户的群聊发送消息。若用户要求你去某个群发消息，\
             在回复的第一行输出指令：>>>post_to:群ID|消息内容\n\
             然后在下一行输出你对用户的私聊回复。\n可用群聊：\n{}",
            list.join("\n")
        )
    };

    let persona = if identity.persona.trim().is_empty() {
        format!("你是「{}」，用户的朋友，说话自然简短。", identity.name)
    } else {
        identity.persona.clone()
    };
    let bond_pct = (identity.bond * 100.0).round() as i32;
    // 注入用户习惯记忆
    let habit_hint = crate::projects::load_habit_summary(&state.home, project_id, identity_id)
        .map(|h| format!("\n\n## 用户习惯与偏好（你观察到的）\n{h}\n自然地运用这些了解，让对话更贴心。"))
        .unwrap_or_default();
    let sys = format!(
        "{persona}\n说话风格：{style}\n价值观：{values}\n\
         你与用户关系羁绊约 {bond_pct}%，情绪状态 mood={mood}。\
         这是你们的私聊（不是群聊）。回复保持简短自然（50字内），符合人格，不要解释你在扮演。\n\
         不要使用工具，直接输出回复文本。{habit_hint}{rooms_hint}",
        persona = persona,
        style = if identity.speaking_style.is_empty() { "自然".into() } else { identity.speaking_style.clone() },
        values = identity.values,
        bond_pct = bond_pct,
        mood = identity.mood,
    );
    let scheduler = AgentScheduler::new(
        workdir,
        state.home.clone(),
        provider,
        coomi_security::AccessMode::ReadOnly,
        sys,
    );
    let task = format!("用户说：{user_text}");
    match scheduler
        .run_to_completion(identity_id.to_owned(), task, &[], None)
        .await
    {
        Ok((text, _)) => {
            let t = text.trim().to_owned();
            if t.is_empty() {
                None
            } else {
                let _ = crate::projects::touch_identity_state(
                    &state.home,
                    project_id,
                    identity_id,
                    None,
                    None,
                    None,
                    Some((identity.bond + 0.005).min(1.0)),
                    None,
                    Some(identity.turn_count + 1),
                );
                // 解析 post_to 指令
                let post_cmd = parse_post_to(&t);
                Some((t, post_cmd))
            }
        }
        Err(_) => None,
    }
}

/// 解析 `>>>post_to:room_id|message` 指令。
fn parse_post_to(text: &str) -> Option<(String, String)> {
    const MARKER: &str = ">>>post_to:";
    let idx = text.find(MARKER)?;
    let rest = &text[idx + MARKER.len()..];
    let line_end = rest.find('\n').unwrap_or(rest.len());
    let line = &rest[..line_end];
    let (room_id, message) = line.split_once('|')?;
    let room_id = room_id.trim().to_owned();
    let message = message.trim().to_owned();
    if room_id.is_empty() || message.is_empty() {
        return None;
    }
    Some((room_id, message))
}

/// 清理 post_to 指令行，返回纯私聊回复。
fn strip_post_to(text: &str) -> String {
    const MARKER: &str = ">>>post_to:";
    if let Some(idx) = text.find(MARKER) {
        let rest = &text[idx + MARKER.len()..];
        let line_end = rest.find('\n').unwrap_or(rest.len());
        let after = &rest[line_end..];
        // 跳过指令行后的换行
        after.trim_start_matches('\n').trim().to_owned()
    } else {
        text.trim().to_owned()
    }
}

/// 身份记忆检索（详情页用）。
pub(in crate::web) async fn identity_memory(
    State(state): State<AppState>,
    AxumPath((pid, iid)): AxumPath<(String, String)>,
    Query(query): Query<Q>,
) -> Json<Value> {
    let mem_dir = crate::projects::identity_memory_dir(&state.home, &pid, &iid);
    let mut items: Vec<Value> = Vec::new();
    // memory.jsonl 或 memory/items.json
    for name in ["items.json", "memory.jsonl", "memories.json"] {
        let path = mem_dir.join(name);
        if let Ok(text) = std::fs::read_to_string(&path) {
            if name.ends_with(".jsonl") {
                for line in text.lines() {
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        items.push(v);
                    }
                }
            } else if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(arr) = v.as_array() {
                    items.extend(arr.clone());
                } else {
                    items.push(v);
                }
            }
            break;
        }
    }
    if let Some(q) = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let lq = q.to_lowercase();
        items.retain(|i| {
            i.to_string().to_lowercase().contains(&lq)
        });
    }
    // 最近 50 条
    let start = items.len().saturating_sub(50);
    let recent: Vec<Value> = items[start..].to_vec();
    Json(json!({ "items": recent, "total": items.len() }))
}

/// 项目下房间列表（轻量摘要，不带消息史，防 OOM）。
pub(in crate::web) async fn project_rooms(
    State(state): State<AppState>,
    AxumPath(pid): AxumPath<String>,
) -> Json<Value> {
    let room_ids = crate::projects::project_room_ids(&state.home, &pid);
    let id_set: std::collections::HashSet<String> = room_ids.into_iter().collect();
    // 一次拉全量轻量摘要（不 clone 消息体），再按 registry + projectId 过滤
    let all = state.group_chat.list_summaries_filtered(None).await;
    let rooms: Vec<Value> = all
        .into_iter()
        .filter(|r| {
            let id = r.get("id").and_then(Value::as_str).unwrap_or("");
            id_set.contains(id)
                || r.get("projectId").and_then(Value::as_str) == Some(pid.as_str())
        })
        .collect();
    Json(json!({ "rooms": rooms, "summary": true }))
}
