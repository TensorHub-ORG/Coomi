//! 群聊运行时：内存存储 + 持久化 + 房间 CRUD + 消息写入。
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Mutex, Notify};
use tokio::time::Duration;

use crate::collab::current_ms;
use super::types::*;

pub struct GroupChatRuntime {
    pub(crate) home: PathBuf,
    pub(crate) rooms: Arc<Mutex<HashMap<String, GroupRoom>>>,
    pub(crate) rounds: Arc<Mutex<HashMap<String, u64>>>,
    dirty: Arc<AtomicBool>,
    save_notify: Arc<Notify>,
}

impl GroupChatRuntime {
    pub fn new(home: &Path) -> Self {
        let home = home.to_path_buf();
        let runtime = Self {
            home: home.clone(),
            rooms: Arc::new(Mutex::new(HashMap::new())),
            rounds: Arc::new(Mutex::new(HashMap::new())),
            dirty: Arc::new(AtomicBool::new(false)),
            save_notify: Arc::new(Notify::new()),
        };
        let rooms = Arc::clone(&runtime.rooms);
        let path = runtime.store_path();
        tokio::spawn(async move {
            let _ = load_rooms(&path, &rooms).await;
        });
        let rooms = Arc::clone(&runtime.rooms);
        let path = runtime.store_path();
        let dirty = Arc::clone(&runtime.dirty);
        let notify = Arc::clone(&runtime.save_notify);
        tokio::spawn(async move {
            loop {
                notify.notified().await;
                tokio::time::sleep(Duration::from_millis(200)).await;
                while dirty.swap(false, Ordering::SeqCst) {
                    persist_rooms(&path, &rooms).await;
                }
            }
        });
        runtime
    }

    fn store_path(&self) -> PathBuf {
        self.home.join("group-chat").join("rooms.json")
    }

    pub(crate) async fn persist(&self) {
        self.dirty.store(true, Ordering::SeqCst);
        self.save_notify.notify_one();
    }

    pub async fn flush(&self) {
        self.dirty.store(true, Ordering::SeqCst);
        self.save_notify.notify_one();
        tokio::time::sleep(Duration::from_millis(0)).await;
        persist_rooms(&self.store_path(), &self.rooms).await;
        self.dirty.store(false, Ordering::SeqCst);
    }

    // ── 列表 / 查询 ──────────────────────────────────────────

    pub async fn list(&self) -> Vec<GroupRoom> {
        let rooms = self.rooms.lock().await;
        let mut ids: Vec<(String, u64)> = rooms
            .iter()
            .map(|(id, r)| (id.clone(), r.updated_at_ms))
            .collect();
        ids.sort_by_key(|(_, ts)| std::cmp::Reverse(*ts));
        ids.into_iter()
            .filter_map(|(id, _)| rooms.get(&id).cloned())
            .collect()
    }

    /// 轻量摘要：不带 messages / activities，供首页轮询。
    pub async fn list_summaries_filtered(
        &self,
        allowed_ids: Option<&std::collections::HashSet<String>>,
    ) -> Vec<serde_json::Value> {
        let rooms = self.rooms.lock().await;
        let mut rows: Vec<(u64, serde_json::Value)> = rooms
            .values()
            .filter(|room| match allowed_ids {
                Some(set) => set.contains(&room.id),
                None => true,
            })
            .map(|room| {
                let last = room.messages.last();
                let preview = last.map(|m| {
                    let who = if m.from == "user" {
                        "用户".to_string()
                    } else {
                        room.members
                            .iter()
                            .find(|x| x.id == m.from)
                            .map(|x| x.name.clone())
                            .unwrap_or_else(|| m.from.clone())
                    };
                    format!("{}: {}", who, m.content.chars().take(80).collect::<String>())
                });
                let member_colors: Vec<&str> = room.members.iter().map(|m| m.color.as_str()).collect();
                let member_ids: Vec<&str> = room.members.iter().map(|m| m.id.as_str()).collect();
                let row = serde_json::json!({
                    "id": room.id,
                    "name": room.name,
                    "topic": room.topic,
                    "status": room.status,
                    "speakMode": room.speak_mode,
                    "memberCount": room.members.len(),
                    "memberColors": member_colors,
                    "memberIds": member_ids,
                    "preview": preview.unwrap_or_default(),
                    "messageCount": room.messages.len(),
                    "updatedAtMs": room.updated_at_ms,
                    "reasoningEffort": room.reasoning_effort,
                    "muted": room.muted,
                    "projectId": room.project_id,
                    "messages": [],
                    "activities": [],
                });
                (room.updated_at_ms, row)
            })
            .collect();
        rows.sort_by_key(|(ts, _)| std::cmp::Reverse(*ts));
        rows.into_iter().map(|(_, row)| row).collect()
    }

    pub async fn list_summaries(&self) -> Vec<serde_json::Value> {
        self.list_summaries_filtered(None).await
    }

    pub async fn get(&self, id: &str) -> Option<GroupRoom> {
        self.rooms.lock().await.get(id).cloned()
    }

    // ── 房间 CRUD ────────────────────────────────────────────

    pub async fn create(
        &self,
        name: &str,
        topic: &str,
        speak_mode: SpeakMode,
        members: Vec<ChatMember>,
    ) -> GroupRoom {
        self.create_in_project(name, topic, speak_mode, members, None).await
    }

    pub async fn create_in_project(
        &self,
        name: &str,
        topic: &str,
        speak_mode: SpeakMode,
        members: Vec<ChatMember>,
        project_id: Option<&str>,
    ) -> GroupRoom {
        let id = uuid::Uuid::new_v4().to_string();
        let now = current_ms();
        let mut work_dir: Option<String> = None;
        if let Some(pid) = project_id {
            if let Ok(wd) = crate::projects::register_room(&self.home, pid, &id) {
                work_dir = Some(wd.display().to_string());
            }
        }
        let room = GroupRoom {
            id: id.clone(),
            name: if name.trim().is_empty() {
                "新群聊".into()
            } else {
                name.trim().to_owned()
            },
            topic: topic.trim().to_owned(),
            status: RoomStatus::Idle,
            speak_mode,
            members,
            messages: Vec::new(),
            next_speaker: 0,
            speak_counts: HashMap::new(),
            host_allow: Vec::new(),
            reasoning_effort: default_effort(),
            context_paths: Vec::new(),
            work_dir,
            activities: Vec::new(),
            idle_chat_enabled: false,
            muted: false,
            project_id: project_id.map(str::to_owned),
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.rooms.lock().await.insert(id, room.clone());
        self.persist().await;
        room
    }

    pub async fn delete(&self, id: &str) -> bool {
        let existed = self.rooms.lock().await.remove(id).is_some();
        if existed {
            self.flush().await;
        }
        existed
    }

    // ── 字段更新 ────────────────────────────────────────────

    async fn mutate<F>(&self, id: &str, f: F) -> Option<GroupRoom>
    where
        F: FnOnce(&mut GroupRoom),
    {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(id)?;
        f(room);
        room.updated_at_ms = current_ms();
        let out = room.clone();
        drop(rooms);
        self.persist().await;
        Some(out)
    }

    pub async fn set_topic(&self, id: &str, topic: &str) -> Option<GroupRoom> {
        let topic = topic.trim().to_owned();
        self.mutate(id, |r| r.topic = topic).await
    }

    pub async fn rename(&self, id: &str, name: &str) -> Option<GroupRoom> {
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        let name = name.to_owned();
        self.mutate(id, |r| r.name = name).await
    }

    pub async fn update_members(&self, id: &str, members: Vec<ChatMember>) -> Result<GroupRoom, String> {
        if members.is_empty() {
            return Err("至少需要 1 个成员".into());
        }
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(id).ok_or_else(|| "room not found".to_string())?;
        room.members = members;
        room.next_speaker = 0;
        let member_ids: std::collections::HashSet<String> =
            room.members.iter().map(|m| m.id.clone()).collect();
        room.host_allow.retain(|m| member_ids.contains(m));
        room.updated_at_ms = current_ms();
        let out = room.clone();
        drop(rooms);
        self.persist().await;
        Ok(out)
    }

    pub async fn remove_member(&self, room_id: &str, member_id: &str) -> Option<GroupRoom> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(room_id)?;
        let before = room.members.len();
        room.members.retain(|m| m.id != member_id);
        if room.members.len() == before {
            return None;
        }
        room.host_allow.retain(|m| m != member_id);
        room.updated_at_ms = current_ms();
        let out = room.clone();
        drop(rooms);
        self.persist().await;
        Some(out)
    }

    pub async fn clear_history(&self, id: &str) -> Option<GroupRoom> {
        let out = self
            .mutate(id, |r| {
                r.messages.clear();
                r.status = RoomStatus::Idle;
            })
            .await?;
        let _ = self.rounds.lock().await.remove(id);
        Some(out)
    }

    pub async fn reset_quotas(&self, id: &str) -> Option<GroupRoom> {
        self.mutate(id, |r| {
            r.speak_counts.clear();
            r.next_speaker = 0;
            r.status = RoomStatus::Idle;
        })
        .await
    }

    pub async fn set_speak_mode(&self, id: &str, mode: SpeakMode) -> Option<GroupRoom> {
        self.mutate(id, |r| r.speak_mode = mode).await
    }

    pub async fn set_host_allow(&self, id: &str, allow: Vec<String>) -> Option<GroupRoom> {
        self.mutate(id, |r| r.host_allow = allow).await
    }

    pub async fn set_idle_chat(&self, id: &str, enabled: bool) -> Option<GroupRoom> {
        self.mutate(id, |r| r.idle_chat_enabled = enabled).await
    }

    pub async fn set_reasoning_effort(&self, id: &str, effort: &str) -> Option<GroupRoom> {
        let effort = effort.trim().to_ascii_lowercase();
        if !["auto", "low", "medium", "high", "xhigh", "ultra"].contains(&effort.as_str()) {
            return None;
        }
        self.mutate(id, |r| r.reasoning_effort = effort).await
    }

    pub async fn set_work_dir(&self, id: &str, dir: &str) -> Option<GroupRoom> {
        let d = dir.trim().trim_end_matches('/').to_owned();
        let d = if d.is_empty() { None } else { Some(d) };
        self.mutate(id, |r| r.work_dir = d).await
    }

    pub async fn set_mute(&self, id: &str, muted: bool) -> Option<GroupRoom> {
        self.mutate(id, |r| r.muted = muted).await
    }

    pub async fn clear_context_paths(&self, id: &str) -> Option<GroupRoom> {
        self.mutate(id, |r| {
            r.context_paths.clear();
            r.work_dir = None;
        })
        .await
    }

    /// 合并上传文件 / 授权目录到房间上下文（去重）；目录同时更新 work_dir。
    pub async fn merge_context_paths(&self, id: &str, paths: Vec<String>) -> Option<GroupRoom> {
        if paths.is_empty() {
            return self.get(id).await;
        }
        self.mutate(id, |room| {
            let mut latest_dir: Option<String> = None;
            for p in paths {
                let p = p.trim().to_owned();
                if p.is_empty() {
                    continue;
                }
                if !room.context_paths.iter().any(|x| x == &p) {
                    room.context_paths.push(p.clone());
                }
                let is_dir = std::fs::metadata(&p)
                    .map(|m| m.is_dir())
                    .unwrap_or_else(|_| p.ends_with('/') || !p.contains('.'));
                if is_dir {
                    latest_dir = Some(p.trim_end_matches('/').to_owned());
                }
            }
            if let Some(dir) = latest_dir {
                room.work_dir = Some(dir);
            } else if room.work_dir.is_none() {
                if let Some(first) = room.context_paths.first() {
                    let cleaned = first.trim_end_matches('/');
                    if let Some(parent) = cleaned.rsplit_once('/') {
                        room.work_dir = Some(parent.0.to_owned());
                    }
                }
            }
        })
        .await
    }

    pub async fn clear_all_rooms(&self) {
        let mut rooms = self.rooms.lock().await;
        rooms.clear();
        let mut rounds = self.rounds.lock().await;
        rounds.clear();
        self.dirty.store(false, Ordering::SeqCst);
        let path = self.store_path();
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }

    pub async fn set_status(&self, id: &str, status: RoomStatus) {
        self.mutate(id, |r| r.status = status).await;
    }

    // ── 消息写入 ────────────────────────────────────────────

    fn push_activity(room: &mut GroupRoom, member_id: &str, kind: &str, detail: &str, message_id: Option<String>) {
        room.activities.push(MemberActivity {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            member_id: member_id.into(),
            detail: detail.chars().take(400).collect(),
            at_ms: current_ms(),
            message_id,
        });
        if room.activities.len() > 500 {
            let skip = room.activities.len() - 500;
            room.activities.drain(..skip);
        }
    }

    pub async fn append_message(
        &self,
        id: &str,
        from: &str,
        to: &str,
        content: &str,
        kind: &str,
    ) -> Option<ChatMessage> {
        self.append_message_ex(id, from, to, content, kind, Vec::new(), None)
            .await
    }

    pub async fn append_message_ex(
        &self,
        id: &str,
        from: &str,
        to: &str,
        content: &str,
        kind: &str,
        attachments: Vec<String>,
        reply_to: Option<String>,
    ) -> Option<ChatMessage> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(id)?;
        let msg = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            from: from.to_owned(),
            to: to.to_owned(),
            content: content.chars().take(12_000).collect(),
            kind: kind.to_owned(),
            ts: current_ms() as f64 / 1000.0,
            attachments,
            reply_to,
        };
        if from != "system" && !from.is_empty() {
            let detail = if to != "all" && !to.is_empty() {
                format!("→ {}: {}", to, content.chars().take(80).collect::<String>())
            } else {
                format!("发言: {}", content.chars().take(80).collect::<String>())
            };
            Self::push_activity(room, from, "speak", &detail, Some(msg.id.clone()));
        }
        room.messages.push(msg.clone());
        if room.messages.len() > 2000 {
            let skip = room.messages.len() - 2000;
            room.messages.drain(..skip);
        }
        room.updated_at_ms = current_ms();
        drop(rooms);
        self.persist().await;
        Some(msg)
    }

    // ── 活动查询 ────────────────────────────────────────────

    pub async fn member_activities(&self, id: &str, member_id: &str, limit: usize) -> Vec<MemberActivity> {
        let rooms = self.rooms.lock().await;
        let Some(room) = rooms.get(id) else {
            return Vec::new();
        };
        room.activities
            .iter()
            .rev()
            .filter(|a| a.member_id == member_id || (a.member_id == "user" && a.detail.contains(member_id)))
            .take(limit.max(1).min(50))
            .cloned()
            .collect()
    }

    // ── 轮次 ────────────────────────────────────────────────

    pub async fn begin_round(&self, id: &str) -> u64 {
        let mut rounds = self.rounds.lock().await;
        let seq = rounds.entry(id.to_owned()).or_insert(0);
        *seq = seq.wrapping_add(1);
        *seq
    }

    pub async fn current_round(&self, id: &str) -> u64 {
        self.rounds.lock().await.get(id).copied().unwrap_or(0)
    }

    pub async fn is_current_round(&self, id: &str, round: u64) -> bool {
        self.current_round(id).await == round
    }

    pub async fn cancel_round(&self, id: &str) -> Option<GroupRoom> {
        self.begin_round(id).await;
        self.set_status(id, RoomStatus::Idle).await;
        self.get(id).await
    }

    pub fn is_finished(room: &GroupRoom) -> bool {
        if room.members.is_empty() {
            return true;
        }
        room.members.iter().all(|m| {
            let used = room.speak_counts.get(&m.id).copied().unwrap_or(0);
            m.quota > 0 && used >= m.quota
        })
    }
}

// ── 持久化 ──────────────────────────────────────────────────

async fn load_rooms(
    path: &Path,
    rooms: &Arc<Mutex<HashMap<String, GroupRoom>>>,
) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let bytes = fs::read(path)?;
    let list: Vec<GroupRoom> = serde_json::from_slice(&bytes).unwrap_or_default();
    let mut map = HashMap::new();
    for room in list {
        map.insert(room.id.clone(), room);
    }
    *rooms.lock().await = map;
    Ok(())
}

async fn persist_rooms(path: &Path, rooms: &Arc<Mutex<HashMap<String, GroupRoom>>>) {
    let snapshot: Vec<GroupRoom> = {
        let rooms = rooms.lock().await;
        rooms.values().cloned().collect()
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec(&snapshot) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }
}
