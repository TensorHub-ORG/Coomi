//! 发言引擎：轮流 / 抢麦 / 主持 + @波次队列 + LLM 回复。
use std::path::Path;
use std::sync::Arc;

use coomi_security::AccessMode;
use coomi_services::{ProviderConfig, ProviderRegistry};
use coomi_tools::AgentScheduler;

use super::prompt::{build_member_sys, parse_mentions, speaker_prompt, split_file_marker};
use super::runtime::GroupChatRuntime;
use super::types::*;

/// 用户发言。返回本轮应发言的成员 id 列表。
pub async fn user_speak_ex(
    rt: &GroupChatRuntime,
    id: &str,
    content: &str,
    to: Option<&str>,
    attachments: Vec<String>,
    reply_to: Option<String>,
) -> Result<Vec<String>, String> {
    let mut rooms = rt.rooms.lock().await;
    let room = rooms
        .get_mut(id)
        .ok_or_else(|| "room not found".to_string())?;
    let msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        from: "user".into(),
        to: to.unwrap_or("all").into(),
        content: content.chars().take(12_000).collect(),
        kind: "user".into(),
        ts: crate::collab::current_ms() as f64 / 1000.0,
        attachments,
        reply_to,
    };
    if let Some(target) = to {
        if target != "all" {
            push_activity(
                room,
                "user",
                "directed",
                &format!("@{} {}", target, content.chars().take(60).collect::<String>()),
                Some(msg.id.clone()),
            );
        }
    }
    room.messages.push(msg);
    room.updated_at_ms = crate::collab::current_ms();
    room.status = RoomStatus::Running;

    let member_ids: Vec<String> = room.members.iter().map(|m| m.id.clone()).collect();
    if member_ids.is_empty() {
        room.status = RoomStatus::Idle;
        drop(rooms);
        rt.persist().await;
        return Ok(vec![]);
    }

    let targets: Vec<String> = match (to, room.speak_mode.clone()) {
        (Some(t), _) if t != "all" => {
            if member_ids.iter().any(|m| m == t) {
                vec![t.to_owned()]
            } else {
                room.status = RoomStatus::Idle;
                drop(rooms);
                rt.persist().await;
                return Err(format!("unknown member: {t}"));
            }
        }
        (_, SpeakMode::Host) => {
            if room.host_allow.is_empty() {
                room.status = RoomStatus::Idle;
                drop(rooms);
                rt.persist().await;
                return Err("host mode: set host_allow before speaking".into());
            }
            room.host_allow
                .iter()
                .filter(|id| member_ids.contains(id))
                .cloned()
                .collect()
        }
        (_, SpeakMode::RoundRobin) => {
            let mut found = Vec::new();
            for _ in 0..member_ids.len() {
                let idx = room.next_speaker % member_ids.len();
                room.next_speaker = (idx + 1) % member_ids.len();
                let mid = member_ids[idx].clone();
                let member = room.members.iter().find(|m| m.id == mid);
                let used = room.speak_counts.get(&mid).copied().unwrap_or(0);
                let quota = member.map(|m| m.quota).unwrap_or(0);
                if quota == 0 || used < quota {
                    found.push(mid);
                    break;
                }
            }
            if found.is_empty() {
                room.status = RoomStatus::Done;
                drop(rooms);
                rt.persist().await;
                return Ok(vec![]);
            }
            found
        }
        (_, SpeakMode::Open) => {
            // 抢麦模式：随机选 1-2 个有配额的成员（而非全部），更像自由对话
            let candidates: Vec<String> = member_ids
                .iter()
                .filter(|id| {
                    let used = room.speak_counts.get(*id).copied().unwrap_or(0);
                    let quota = room
                        .members
                        .iter()
                        .find(|m| &m.id == *id)
                        .map(|m| m.quota)
                        .unwrap_or(0);
                    quota == 0 || used < quota
                })
                .cloned()
                .collect();
            if candidates.is_empty() {
                Vec::new()
            } else {
                let now = crate::collab::current_ms() as usize;
                let pick_count = if candidates.len() >= 3 { 2 } else { 1 };
                let mut picked = Vec::new();
                let mut used_idx = std::collections::HashSet::new();
                for _ in 0..pick_count {
                    let mut idx = (now + picked.len() * 7) % candidates.len();
                    while used_idx.contains(&idx) && used_idx.len() < candidates.len() {
                        idx = (idx + 1) % candidates.len();
                    }
                    used_idx.insert(idx);
                    picked.push(candidates[idx].clone());
                }
                picked
            }
        }
    };
    if targets.is_empty() {
        room.status = RoomStatus::Done;
    }
    drop(rooms);
    rt.persist().await;
    Ok(targets)
}

pub async fn agent_speak_ex(
    rt: &GroupChatRuntime,
    id: &str,
    agent_id: &str,
    content: &str,
    attachments: Vec<String>,
    to: Option<&str>,
) -> Option<ChatMessage> {
    {
        let mut rooms = rt.rooms.lock().await;
        let room = rooms.get_mut(id)?;
        let used = room.speak_counts.entry(agent_id.to_owned()).or_insert(0);
        *used = used.saturating_add(1);
        push_activity(
            room,
            agent_id,
            "speak",
            &format!("回复: {}", content.chars().take(100).collect::<String>()),
            None,
        );
    }
    rt.append_message_ex(id, agent_id, to.unwrap_or("all"), content, "agent", attachments, None)
        .await
}

fn push_activity(room: &mut GroupRoom, member_id: &str, kind: &str, detail: &str, message_id: Option<String>) {
    room.activities.push(MemberActivity {
        id: uuid::Uuid::new_v4().to_string(),
        kind: kind.into(),
        member_id: member_id.into(),
        detail: detail.chars().take(400).collect(),
        at_ms: crate::collab::current_ms(),
        message_id,
    });
    if room.activities.len() > 500 {
        let skip = room.activities.len() - 500;
        room.activities.drain(..skip);
    }
}

/// 运行单个成员的 LLM 回复：解析 provider → 组装 prompt → AgentScheduler → (正文, 附件)。
/// is_idle=true 时注入「主动找话题」指令。
pub async fn run_member_reply(
    home: &Path,
    cwd: &Path,
    registry: &ProviderRegistry,
    member: &ChatMember,
    room: &GroupRoom,
    agent_id: &str,
    depth: usize,
    is_idle: bool,
) -> (String, Vec<String>) {
    let selector = if member.model_selector.trim().is_empty() {
        None
    } else {
        Some(member.model_selector.as_str())
    };
    let provider: ProviderConfig = match registry.resolve(selector) {
        Ok(p) => p,
        Err(_) => return (format!("（成员「{}」模型未配置，跳过）", member.name), Vec::new()),
    };
    let work = room
        .work_dir
        .clone()
        .filter(|w| !w.trim().is_empty())
        .unwrap_or_else(|| cwd.display().to_string());
    let life = member
        .life_id
        .as_deref()
        .and_then(|lid| crate::group_life::find_by_id(home, lid))
        .or_else(|| crate::group_life::find_by_member(home, &room.id, agent_id));
    let mut sys = build_member_sys(member, room, agent_id, &work, life.as_ref(), depth);
    // 闲聊模式：注入主动找话题指令
    if is_idle {
        sys.push_str(crate::group::prompt::idle_chat_instruction());
    }
    if let (Some(pid), Some(iid)) = (room.project_id.clone(), member.identity_id.clone()) {
        if let Some(snippets) = identity_memory_snippets(home, &pid, &iid, 5) {
            sys.push_str("\n\n## 共享记忆（你与用户/其他群聊中积累的记忆）\n");
            sys.push_str(&snippets);
            sys.push_str("\n自然引用这些记忆，不要生硬复述。");
        }
    }
    let prompt = speaker_prompt(room, agent_id, 16);
    let agent_cwd = std::path::PathBuf::from(&work);
    let scheduler = AgentScheduler::new(
        agent_cwd,
        home.to_path_buf(),
        provider,
        AccessMode::FullAccess,
        sys,
    );
    let task = format!(
        "{prompt}\n\n当前话题：{}",
        if room.topic.is_empty() { "（无）" } else { &room.topic }
    );
    let reply = match scheduler
        .run_to_completion(agent_id.to_owned(), task, &[], None)
        .await
    {
        Ok((text, _thought)) => text,
        Err(e) => format!("（该成员暂时无法回复：{e}）"),
    };
    split_file_marker(&reply)
}

/// 波次队列：@触发的回复也 @他人 → 再触发。
pub async fn run_wave(
    rt: Arc<GroupChatRuntime>,
    home: std::path::PathBuf,
    cwd: std::path::PathBuf,
    registry: ProviderRegistry,
    room_id: String,
    round: u64,
    targets: Vec<String>,
    room_snap: GroupRoom,
) {
    const MAX_MENTION_DEPTH: usize = 3;
    const MAX_MENTION_PER_WAVE: usize = 4;
    const MAX_TRIGGERS_PER_MEMBER: u32 = 2;
    let mut wave: Vec<String> = targets;
    let mut depth: usize = 0;
    let mut trigger_count: std::collections::HashMap<String, u32> = wave
        .iter()
        .map(|id| (id.clone(), 1u32))
        .collect();

    while !wave.is_empty() && depth <= MAX_MENTION_DEPTH {
        let mut next_wave: Vec<String> = Vec::new();
        for agent_id in wave {
            if !rt.is_current_round(&room_id, round).await {
                break;
            }
            let member = room_snap
                .members
                .iter()
                .find(|m| m.id == agent_id)
                .cloned();
            let Some(member) = member else { continue };
            let room = match rt.get(&room_id).await {
                Some(r) => r,
                None => break,
            };
            let (reply, files) = run_member_reply(
                &home, &cwd, &registry, &member, &room, &agent_id, depth, false,
            )
            .await;
            if !rt.is_current_round(&room_id, round).await {
                break;
            }
            if !files.is_empty() {
                let _ = rt.merge_context_paths(&room_id, files.clone()).await;
            }
            if depth < MAX_MENTION_DEPTH {
                for mentioned_id in parse_mentions(&reply, &room_snap.members) {
                    if mentioned_id == agent_id {
                        continue;
                    }
                    let count = trigger_count.get(&mentioned_id).copied().unwrap_or(0);
                    if count >= MAX_TRIGGERS_PER_MEMBER {
                        continue;
                    }
                    let quota_ok = room_snap
                        .members
                        .iter()
                        .find(|m| m.id == mentioned_id)
                        .map(|m| {
                            let used = room.speak_counts.get(&mentioned_id).copied().unwrap_or(0);
                            m.quota == 0 || used < m.quota
                        })
                        .unwrap_or(false);
                    if quota_ok
                        && next_wave.len() < MAX_MENTION_PER_WAVE
                        && !next_wave.contains(&mentioned_id)
                    {
                        trigger_count.insert(mentioned_id.clone(), count + 1);
                        next_wave.push(mentioned_id);
                    }
                }
            }
            let reply_to_field = if depth > 0 { Some("user") } else { None };
            agent_speak_ex(&rt, &room_id, &agent_id, &reply, files, reply_to_field).await;

            // 更新生命体状态（mood/turn_count/bond）
            if let Some(member) = room_snap.members.iter().find(|m| m.id == agent_id) {
                if let Some(life_id) = &member.life_id {
                    // 根据回复内容简单判断情绪偏移
                    let mood_delta = if reply.contains('！') || reply.to_lowercase().contains("哈哈") {
                        0.05
                    } else if reply.contains('…') || reply.contains("抱歉") {
                        -0.02
                    } else {
                        0.01
                    };
                    crate::group_life::update_state(&home, life_id, mood_delta);
                    crate::group_life::increase_bond(&home, life_id, 0.005);

                    // 每 5 轮触发一次自我提升
                    let life = crate::group_life::find_by_id(&home, life_id);
                    if let Some(l) = life {
                        if l.turn_count % 5 == 0 && l.turn_count > 0 {
                            // 从最近消息找用户发言
                            let user_text = room_snap
                                .messages
                                .iter()
                                .rev()
                                .find(|m| m.from == "user")
                                .map(|m| m.content.clone())
                                .unwrap_or_default();
                            if !user_text.is_empty() {
                                crate::group_life::self_improve(&home, life_id, &user_text, &reply);
                            }
                        }
                    }
                }
            }
        }
        wave = next_wave;
        depth += 1;
    }

    // 无论是否为当前轮，结束时确保状态回 Idle（防止卡在 Running）
    if let Some(room) = rt.get(&room_id).await {
        if room.status == RoomStatus::Running {
            if GroupChatRuntime::is_finished(&room) {
                rt.append_message(
                    &room_id,
                    "system",
                    "all",
                    "所有成员已达发言上限，本轮讨论结束。",
                    "system",
                )
                .await;
                rt.set_status(&room_id, RoomStatus::Done).await;
            } else {
                rt.set_status(&room_id, RoomStatus::Idle).await;
            }
        }
    }
}

/// 读取身份共享记忆的最近若干条文本片段。
fn identity_memory_snippets(
    home: &Path,
    project_id: &str,
    identity_id: &str,
    limit: usize,
) -> Option<String> {
    let mem_dir = crate::projects::identity_memory_dir(home, project_id, identity_id);
    let mut texts: Vec<String> = Vec::new();
    for name in ["items.json", "memory.jsonl", "memories.json"] {
        let path = mem_dir.join(name);
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        if name.ends_with(".jsonl") {
            for line in raw.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    if let Some(t) = extract_memory_text(&v) {
                        texts.push(t);
                    }
                }
            }
        } else if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(arr) = v.as_array() {
                for item in arr {
                    if let Some(t) = extract_memory_text(item) {
                        texts.push(t);
                    }
                }
            } else if let Some(t) = extract_memory_text(&v) {
                texts.push(t);
            }
        }
        break;
    }
    if texts.is_empty() {
        return None;
    }
    let start = texts.len().saturating_sub(limit);
    let joined: String = texts[start..]
        .iter()
        .map(|t| format!("- {}", t.chars().take(160).collect::<String>()))
        .collect::<Vec<_>>()
        .join("\n");
    if joined.trim().is_empty() { None } else { Some(joined) }
}

fn extract_memory_text(v: &serde_json::Value) -> Option<String> {
    for key in ["text", "content", "summary", "user", "assistant"] {
        if let Some(t) = v.get(key).and_then(serde_json::Value::as_str) {
            if !t.trim().is_empty() {
                return Some(t.trim().to_owned());
            }
        }
    }
    None
}
