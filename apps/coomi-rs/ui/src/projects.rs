//! 项目：群聊的顶层容器。
//! home/projects/{project_id}/workdir  —— 项目工作目录（隔离根）
//! home/projects/{project_id}/identities/ —— 身份库（同名跨群共享记忆）
//! home/projects/{project_id}/group-chats/{room_id}/ —— 群聊 + 独立 workdir
//! home/projects/{project_id}/dms/{identity_id}/ —— 单聊消息
//!
//! 旧数据（home/group-chat/rooms.json）首次访问时迁入「默认项目」，
//! 或由 API 显式删除（用户确认后）。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use crate::collab::current_ms;

// ── 项目 ──────────────────────────────────────────────────

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub created_at_ms: u64,
    #[serde(default)]
    pub updated_at_ms: u64,
    /// 群聊 id 列表（有序）
    #[serde(default)]
    pub room_ids: Vec<String>,
    /// 身份 id 列表
    #[serde(default)]
    pub identity_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRegistry {
    pub version: u32,
    pub projects: Vec<Project>,
    /// 当前激活项目 id
    #[serde(default)]
    pub active_id: Option<String>,
}

pub fn projects_root(home: &Path) -> PathBuf {
    home.join("projects")
}

fn registry_path(home: &Path) -> PathBuf {
    projects_root(home).join("registry.json")
}

pub fn project_dir(home: &Path, project_id: &str) -> PathBuf {
    projects_root(home).join(project_id)
}

/// 项目工作目录（成员/群 agent 的 cwd 根）。
pub fn project_workdir(home: &Path, project_id: &str) -> PathBuf {
    project_dir(home, project_id).join("workdir")
}

/// 群聊专属工作目录。
/// 新群默认落在用户可见的 /storage/emulated/0/coomi/group chat/{room_id}/workdir；
/// 无存储权限（目录不可建）时回退到项目私有目录（兼容旧结构）。
pub fn room_workdir(home: &Path, project_id: &str, room_id: &str) -> PathBuf {
    let default_root = std::path::PathBuf::from("/storage/emulated/0/coomi/group chat");
    let user_dir = default_root.join(room_id).join("workdir");
    if fs::create_dir_all(&user_dir).is_ok() {
        user_dir
    } else {
        project_dir(home, project_id)
            .join("group-chats")
            .join(room_id)
            .join("workdir")
    }
}

/// 身份记忆目录。
pub fn identity_memory_dir(home: &Path, project_id: &str, identity_id: &str) -> PathBuf {
    project_dir(home, project_id)
        .join("identities")
        .join(identity_id)
        .join("memory")
}

/// 身份档案路径。
fn identity_path(home: &Path, project_id: &str, identity_id: &str) -> PathBuf {
    project_dir(home, project_id)
        .join("identities")
        .join(format!("{identity_id}.json"))
}

fn identities_registry_path(home: &Path, project_id: &str) -> PathBuf {
    project_dir(home, project_id).join("identities").join("registry.json")
}

/// 单聊消息路径。
fn dm_messages_path(home: &Path, project_id: &str, identity_id: &str) -> PathBuf {
    project_dir(home, project_id)
        .join("dms")
        .join(identity_id)
        .join("messages.json")
}

// ── 身份 ──────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    /// 显示名
    pub name: String,
    /// 规范化名（用于同名匹配：trim + 小写）
    pub name_key: String,
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub speaking_style: String,
    #[serde(default)]
    pub values: String,
    #[serde(default)]
    pub model_selector: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default = "default_icon")]
    pub icon: String,
    /// 共享情绪
    #[serde(default)]
    pub mood: f32,
    #[serde(default)]
    pub valence: f64,
    #[serde(default)]
    pub arousal: f64,
    #[serde(default = "default_attention")]
    pub attention: String,
    /// 共享羁绊 0~1
    #[serde(default)]
    pub bond: f64,
    #[serde(default)]
    pub memory_count: u64,
    #[serde(default)]
    pub turn_count: u64,
    /// 已触发里程碑
    #[serde(default)]
    pub milestones_hit: Vec<String>,
    /// 关系内容尺度 light/standard/deep
    #[serde(default = "default_rel_scale")]
    pub relationship_scale: String,
    /// 绑定的群生命体 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub life_id: Option<String>,
    /// 出现的房间 id
    #[serde(default)]
    pub room_ids: Vec<String>,
    pub created_at_ms: u64,
    #[serde(default)]
    pub last_seen_ms: u64,
    /// 单聊未读数
    #[serde(default)]
    pub dm_unread: u32,
}

fn default_color() -> String { "#2d61c6".to_owned() }
fn default_icon() -> String { "chat".to_owned() }
fn default_attention() -> String { "user".to_owned() }
fn default_rel_scale() -> String { "standard".to_owned() }

/// 名字规范化：trim + 小写 + 去空白。
pub fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase().replace(|c: char| c.is_whitespace(), "")
}

// ── Registry IO ───────────────────────────────────────────

pub fn load_registry(home: &Path) -> ProjectRegistry {
    fs::read_to_string(registry_path(home))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(ProjectRegistry { version: 1, projects: Vec::new(), active_id: None })
}

fn save_registry(home: &Path, reg: &ProjectRegistry) -> Result<()> {
    let path = registry_path(home);
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    fs::write(&path, serde_json::to_vec_pretty(reg)?)?;
    Ok(())
}

fn load_identities(home: &Path, project_id: &str) -> Vec<Identity> {
    fs::read_to_string(identities_registry_path(home, project_id))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Identity>>(&t).ok())
        .unwrap_or_default()
}

fn save_identities(home: &Path, project_id: &str, list: &[Identity]) -> Result<()> {
    let path = identities_registry_path(home, project_id);
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    fs::write(&path, serde_json::to_vec_pretty(list)?)?;
    Ok(())
}

// ── 项目 CRUD ─────────────────────────────────────────────

/// 创建项目；ensure_dirs 会创建 workdir / identities / group-chats / dms 目录。
pub fn create_project(home: &Path, name: &str, description: &str) -> Result<Project> {
    let mut reg = load_registry(home);
    let id = format!("p_{}", current_ms());
    let now = current_ms();
    let project = Project {
        id: id.clone(),
        name: if name.trim().is_empty() { "未命名项目".into() } else { name.trim().to_owned() },
        description: description.to_owned(),
        created_at_ms: now,
        updated_at_ms: now,
        room_ids: Vec::new(),
        identity_ids: Vec::new(),
    };
    ensure_project_dirs(home, &id)?;
    reg.projects.push(project.clone());
    if reg.active_id.is_none() {
        reg.active_id = Some(id);
    }
    save_registry(home, &reg)?;
    Ok(project)
}

fn ensure_project_dirs(home: &Path, project_id: &str) -> Result<()> {
    for sub in ["workdir", "identities", "group-chats", "dms"] {
        fs::create_dir_all(project_dir(home, project_id).join(sub))?;
    }
    Ok(())
}

pub fn get_project(home: &Path, project_id: &str) -> Option<Project> {
    load_registry(home).projects.into_iter().find(|p| p.id == project_id)
}

pub fn update_project(home: &Path, project_id: &str, patch: &Value) -> Result<Project> {
    let mut reg = load_registry(home);
    let project = reg
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .with_context(|| format!("项目不存在: {project_id}"))?;
    if let Some(v) = patch.get("name").and_then(Value::as_str) {
        if !v.trim().is_empty() {
            project.name = v.trim().to_owned();
        }
    }
    if let Some(v) = patch.get("description").and_then(Value::as_str) {
        project.description = v.to_owned();
    }
    project.updated_at_ms = current_ms();
    let updated = project.clone();
    save_registry(home, &reg)?;
    Ok(updated)
}

/// 删除项目（用户确认后调用）。解绑相关生命体并清理目录。
pub fn delete_project(home: &Path, project_id: &str) -> Result<()> {
    // 先收集房间/身份 id，用于解绑生命体
    let (room_ids, identity_ids) = {
        let reg = load_registry(home);
        match reg.projects.iter().find(|p| p.id == project_id) {
            Some(p) => (p.room_ids.clone(), p.identity_ids.clone()),
            None => (Vec::new(), Vec::new()),
        }
    };
    // 解绑该房间/身份上的生命体（一命一角，删项目即失效）
    unbind_lives_for_project(home, &room_ids, &identity_ids);

    let mut reg = load_registry(home);
    reg.projects.retain(|p| p.id != project_id);
    if reg.active_id.as_deref() == Some(project_id) {
        reg.active_id = reg.projects.first().map(|p| p.id.clone());
    }
    save_registry(home, &reg)?;
    let dir = project_dir(home, project_id);
    if dir.is_dir() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// 清空绑定到指定房间/身份列表上的生命体绑定字段。
fn unbind_lives_for_project(home: &Path, room_ids: &[String], identity_ids: &[String]) {
    use crate::group_life;
    if room_ids.is_empty() && identity_ids.is_empty() {
        return;
    }
    let mut registry = group_life::load_registry(home);
    let mut changed = false;
    for life in registry.lives.iter_mut() {
        let hit_room = life
            .bound_room_id
            .as_deref()
            .map(|r| room_ids.iter().any(|x| x == r))
            .unwrap_or(false);
        let hit_identity = life
            .bound_identity_id
            .as_deref()
            .map(|i| identity_ids.iter().any(|x| x == i))
            .unwrap_or(false);
        if hit_room || hit_identity {
            life.bound_room_id = None;
            life.bound_member_id = None;
            life.bound_identity_id = None;
            changed = true;
        }
    }
    if changed {
        let _ = group_life::save_registry_public(home, &registry);
    }
}

pub fn set_active(home: &Path, project_id: &str) -> Result<Project> {
    let mut reg = load_registry(home);
    let project = reg
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .with_context(|| format!("项目不存在: {project_id}"))?
        .clone();
    reg.active_id = Some(project_id.to_owned());
    save_registry(home, &reg)?;
    Ok(project)
}

/// 当前活跃项目 id；无项目返回 None（不自动创建）。
pub fn active_project_id(home: &Path) -> Option<String> {
    let reg = load_registry(home);
    if let Some(id) = reg.active_id {
        if reg.projects.iter().any(|p| p.id == id) {
            return Some(id);
        }
    }
    reg.projects.first().map(|p| p.id.clone())
}

/// 仅返回已有活跃项目；无则 None（不自动创建默认项目）。
pub fn get_active_project(home: &Path) -> Option<Project> {
    active_project_id(home).and_then(|id| get_project(home, &id))
}

// ── 身份 CRUD ─────────────────────────────────────────────

/// 按名字查找项目内身份（同名 = 同一身份）。
pub fn find_identity_by_name(home: &Path, project_id: &str, name: &str) -> Option<Identity> {
    let key = normalize_name(name);
    if key.is_empty() {
        return None;
    }
    load_identities(home, project_id)
        .into_iter()
        .find(|i| i.name_key == key)
}

pub fn get_identity(home: &Path, project_id: &str, identity_id: &str) -> Option<Identity> {
    // 优先读单文件
    if let Ok(text) = fs::read_to_string(identity_path(home, project_id, identity_id)) {
        if let Ok(id) = serde_json::from_str::<Identity>(&text) {
            return Some(id);
        }
    }
    load_identities(home, project_id)
        .into_iter()
        .find(|i| i.id == identity_id)
}

pub fn list_identities(home: &Path, project_id: &str) -> Vec<Identity> {
    load_identities(home, project_id)
}

/// 查找或创建身份。同名返回已有；新身份写入档案 + registry。
pub fn find_or_create_identity(
    home: &Path,
    project_id: &str,
    name: &str,
    persona: &str,
    speaking_style: &str,
    values: &str,
    model_selector: &str,
    color: &str,
    icon: &str,
) -> Result<(Identity, bool)> {
    if let Some(existing) = find_identity_by_name(home, project_id, name) {
        return Ok((existing, false));
    }
    let key = normalize_name(name);
    if key.is_empty() {
        anyhow::bail!("身份名不能为空");
    }
    let id = format!("id_{}_{}", key.chars().take(12).collect::<String>(), current_ms());
    let now = current_ms();
    let identity = Identity {
        id: id.clone(),
        name: name.trim().to_owned(),
        name_key: key,
        persona: persona.to_owned(),
        speaking_style: speaking_style.to_owned(),
        values: values.to_owned(),
        model_selector: model_selector.to_owned(),
        color: if color.is_empty() { default_color() } else { color.to_owned() },
        icon: if icon.is_empty() { default_icon() } else { icon.to_owned() },
        created_at_ms: now,
        last_seen_ms: now,
        ..Default::default()
    };
    // 写单文件档案
    let path = identity_path(home, project_id, &id);
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    fs::write(&path, serde_json::to_vec_pretty(&identity)?)?;
    // 更新 registry
    let mut list = load_identities(home, project_id);
    list.push(identity.clone());
    save_identities(home, project_id, &list)?;
    // 更新项目 identity_ids
    let mut reg = load_registry(home);
    if let Some(p) = reg.projects.iter_mut().find(|p| p.id == project_id) {
        if !p.identity_ids.contains(&id) {
            p.identity_ids.push(id);
        }
        p.updated_at_ms = current_ms();
    }
    save_registry(home, &reg)?;
    Ok((identity, true))
}

/// 更新身份档案。
pub fn update_identity(home: &Path, project_id: &str, identity_id: &str, patch: &Value) -> Result<Identity> {
    let mut list = load_identities(home, project_id);
    let identity = list
        .iter_mut()
        .find(|i| i.id == identity_id)
        .with_context(|| format!("身份不存在: {identity_id}"))?;
    if let Some(v) = patch.get("name").and_then(Value::as_str) {
        if !v.trim().is_empty() {
            identity.name = v.trim().to_owned();
            identity.name_key = normalize_name(v);
        }
    }
    for field in ["persona", "speakingStyle", "values", "modelSelector", "color", "icon", "attention"] {
        if let Some(v) = patch.get(field).and_then(Value::as_str) {
            match field {
                "persona" => identity.persona = v.to_owned(),
                "speakingStyle" => identity.speaking_style = v.to_owned(),
                "values" => identity.values = v.to_owned(),
                "modelSelector" => identity.model_selector = v.to_owned(),
                "color" => identity.color = v.to_owned(),
                "icon" => identity.icon = v.to_owned(),
                "attention" => identity.attention = v.to_owned(),
                _ => {}
            }
        }
    }
    if let Some(v) = patch.get("mood").and_then(Value::as_f64) {
        identity.mood = (v as f32).clamp(-1.0, 1.0);
    }
    if let Some(v) = patch.get("relationshipScale").and_then(Value::as_str) {
        if matches!(v, "light" | "standard" | "deep") {
            identity.relationship_scale = v.to_owned();
        }
    }
    if let Some(v) = patch.get("lifeId").and_then(Value::as_str) {
        identity.life_id = Some(v.to_owned());
    } else if patch.get("lifeId").map(|v| v.is_null()).unwrap_or(false) {
        identity.life_id = None;
    }
    identity.last_seen_ms = current_ms();
    let updated = identity.clone();
    // 同步单文件
    let path = identity_path(home, project_id, identity_id);
    let _ = fs::write(&path, serde_json::to_vec_pretty(&updated)?);
    save_identities(home, project_id, &list)?;
    Ok(updated)
}

/// 将房间 id 关联到身份（通讯录用）。
pub fn link_identity_room(home: &Path, project_id: &str, identity_id: &str, room_id: &str) {
    let mut list = load_identities(home, project_id);
    if let Some(identity) = list.iter_mut().find(|i| i.id == identity_id) {
        if !identity.room_ids.iter().any(|r| r == room_id) {
            identity.room_ids.push(room_id.to_owned());
        }
        identity.last_seen_ms = current_ms();
        let updated = identity.clone();
        let _ = save_identities(home, project_id, &list);
        let path = identity_path(home, project_id, identity_id);
        if let Ok(bytes) = serde_json::to_vec_pretty(&updated) {
            let _ = fs::write(&path, bytes);
        }
    }
}

/// 从单个群移除成员（不影响身份与其他群）。返回是否有变更。
/// 解绑该成员上的生命体；从 identity.room_ids 移除本 room。
pub fn remove_member_from_room(
    home: &Path,
    project_id: &str,
    room_id: &str,
    member_id: &str,
    identity_id: Option<&str>,
) -> Result<bool> {
    // 找成员的 identity（若未显式传入）
    let iid = identity_id.map(str::to_owned).or_else(|| {
        // 从 room 文件里读 member 的 identityId
        let rooms_path = home.join("group-chat").join("rooms.json");
        if let Ok(text) = fs::read_to_string(&rooms_path) {
            if let Ok(rooms) = serde_json::from_str::<Value>(&text) {
                if let Some(arr) = rooms.as_array() {
                    for room in arr {
                        if room["id"].as_str() == Some(room_id) {
                            if let Some(members) = room["members"].as_array() {
                                for m in members {
                                    if m["id"].as_str() == Some(member_id) {
                                        return m["identityId"].as_str().map(str::to_owned);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    });

    // 解绑该房间+成员上的生命体
    let mut life_registry = crate::group_life::load_registry(home);
    let mut life_changed = false;
    for life in life_registry.lives.iter_mut() {
        let hit = (life.bound_room_id.as_deref() == Some(room_id)
            && life.bound_member_id.as_deref() == Some(member_id))
            || iid
                .as_deref()
                .map(|i| life.bound_identity_id.as_deref() == Some(i))
                .unwrap_or(false);
        // 仅解绑本 room 的绑定；identity 级绑定若指向其他 room 则保留
        let hit_room_only = life.bound_room_id.as_deref() == Some(room_id)
            && life.bound_member_id.as_deref() == Some(member_id);
        if hit_room_only {
            life.bound_room_id = None;
            life.bound_member_id = None;
            // identity 绑定一并清（一命一角，本成员离开后失效）
            life.bound_identity_id = None;
            life_changed = true;
            let _ = hit;
        }
    }
    if life_changed {
        let _ = crate::group_life::save_registry_public(home, &life_registry);
    }

    // 从 identity.room_ids 移除本 room（身份保留）
    if let Some(iid) = &iid {
        let mut list = load_identities(home, project_id);
        if let Some(identity) = list.iter_mut().find(|i| i.id == *iid) {
            identity.room_ids.retain(|r| r != room_id);
            let updated = identity.clone();
            let _ = save_identities(home, project_id, &list);
            let path = identity_path(home, project_id, iid);
            if let Ok(bytes) = serde_json::to_vec_pretty(&updated) {
                let _ = fs::write(&path, bytes);
            }
        }
    }
    Ok(true)
}

/// 删除整个身份（通讯录/单聊删除）：解绑生命体 + 从所有房间移除成员 + 删记忆/单聊。
/// 返回被移除的房间数。
pub fn delete_identity(home: &Path, project_id: &str, identity_id: &str) -> Result<usize> {
    let identity = get_identity(home, project_id, identity_id)
        .with_context(|| format!("身份不存在: {identity_id}"))?;

    // 1. 解绑生命体
    if let Some(life_id) = &identity.life_id {
        let _ = crate::group_life::unbind(home, life_id);
    }
    let mut life_registry = crate::group_life::load_registry(home);
    let mut life_changed = false;
    for life in life_registry.lives.iter_mut() {
        if life.bound_identity_id.as_deref() == Some(identity_id) {
            life.bound_room_id = None;
            life.bound_member_id = None;
            life.bound_identity_id = None;
            life_changed = true;
        }
    }
    if life_changed {
        let _ = crate::group_life::save_registry_public(home, &life_registry);
    }

    // 2. 从 identity.room_ids 列出的房间移除成员
    let mut removed_rooms = 0usize;
    for room_id in &identity.room_ids {
        // 通过 group_chat 运行时无法在此直接访问；改 rooms.json 文件
        remove_member_from_rooms_file(home, room_id, identity_id);
        removed_rooms += 1;
    }

    // 3. 删单聊目录
    let dm_dir = project_dir(home, project_id).join("dms").join(identity_id);
    if dm_dir.is_dir() {
        let _ = fs::remove_dir_all(&dm_dir);
    }

    // 4. 删身份档案 + memory
    let id_dir = project_dir(home, project_id).join("identities").join(identity_id);
    if id_dir.is_dir() {
        let _ = fs::remove_dir_all(&id_dir);
    }
    let path = identity_path(home, project_id, identity_id);
    if path.is_file() {
        let _ = fs::remove_file(&path);
    }

    // 5. 从 registry 移除
    let mut list = load_identities(home, project_id);
    list.retain(|i| i.id != identity_id);
    save_identities(home, project_id, &list)?;

    // 6. 从项目 identity_ids 移除
    let mut reg = load_registry(home);
    if let Some(p) = reg.projects.iter_mut().find(|p| p.id == project_id) {
        p.identity_ids.retain(|i| i != identity_id);
        p.updated_at_ms = current_ms();
        save_registry(home, &reg)?;
    }

    Ok(removed_rooms)
}

/// 直接改 rooms.json：从指定房间移除 identity_id 匹配的成员。
fn remove_member_from_rooms_file(home: &Path, room_id: &str, identity_id: &str) {
    let rooms_path = home.join("group-chat").join("rooms.json");
    let Ok(text) = fs::read_to_string(&rooms_path) else { return };
    let Ok(mut rooms) = serde_json::from_str::<Value>(&text) else { return };
    let Some(arr) = rooms.as_array_mut() else { return };
    let mut dirty = false;
    for room in arr.iter_mut() {
        if room["id"].as_str() != Some(room_id) {
            continue;
        }
        if let Some(members) = room["members"].as_array_mut() {
            let before = members.len();
            members.retain(|m| m["identityId"].as_str() != Some(identity_id));
            if members.len() != before {
                dirty = true;
            }
        }
    }
    if dirty {
        let _ = fs::write(&rooms_path, serde_json::to_vec_pretty(&rooms).unwrap_or_default());
    }
}

// ── 项目 → 群聊 ───────────────────────────────────────────

/// 登记房间到项目（room 本体仍由 group_chat 运行时管理，此处只记 id + 确保 workdir）。
pub fn register_room(home: &Path, project_id: &str, room_id: &str) -> Result<PathBuf> {
    let mut reg = load_registry(home);
    if let Some(p) = reg.projects.iter_mut().find(|p| p.id == project_id) {
        if !p.room_ids.iter().any(|r| r == room_id) {
            p.room_ids.push(room_id.to_owned());
        }
        p.updated_at_ms = current_ms();
        save_registry(home, &reg)?;
    }
    let wd = room_workdir(home, project_id, room_id);
    fs::create_dir_all(&wd)?;
    Ok(wd)
}

/// 从项目的 room_ids 引用中移除房间（删除群聊时调用，保持 registry 一致）。
pub fn unregister_room(home: &Path, room_id: &str) {
    let mut reg = load_registry(home);
    let mut changed = false;
    for p in reg.projects.iter_mut() {
        let before = p.room_ids.len();
        p.room_ids.retain(|r| r != room_id);
        if p.room_ids.len() != before {
            p.updated_at_ms = current_ms();
            changed = true;
        }
    }
    if changed {
        let _ = save_registry(home, &reg);
    }
    // 清理房间工作目录（group_chat 侧删除本体，这里清掉项目内残留目录）。
    for p in load_registry(home).projects {
        let wd = room_workdir(home, &p.id, room_id);
        if wd.is_dir() {
            let _ = fs::remove_dir_all(&wd);
        }
    }
}

/// 项目下所有房间 id。
pub fn project_room_ids(home: &Path, project_id: &str) -> Vec<String> {
    get_project(home, project_id)
        .map(|p| p.room_ids)
        .unwrap_or_default()
}

/// 查找房间所属项目 id。
pub fn project_of_room(home: &Path, room_id: &str) -> Option<String> {
    for p in load_registry(home).projects {
        if p.room_ids.iter().any(|r| r == room_id) {
            return Some(p.id);
        }
    }
    None
}

// ── 工作目录隔离校验 ──────────────────────────────────────

/// 校验 path 是否位于项目 workdir 之下。返回 canonicalized 路径。
/// project_id 为空时不校验（兼容旧路径）。
pub fn ensure_path_in_project(
    home: &Path,
    project_id: &str,
    path: &str,
) -> Result<PathBuf, String> {
    if project_id.is_empty() {
        return Ok(PathBuf::from(path));
    }
    let root = project_workdir(home, project_id);
    // 确保 root 存在
    let _ = fs::create_dir_all(&root);
    let canon_root = fs::canonicalize(&root)
        .map_err(|e| format!("项目工作目录不可用: {e}"))?;
    let target = PathBuf::from(path);
    // 目标不存在时校验其最近存在的祖先
    let mut probe = target.clone();
    while !probe.exists() {
        if !probe.pop() {
            return Err("非法路径".into());
        }
    }
    let canon_probe = fs::canonicalize(&probe)
        .map_err(|e| format!("路径不可读: {e}"))?;
    if !canon_probe.starts_with(&canon_root) {
        return Err("路径不在当前项目工作目录内（隔离限制）".into());
    }
    Ok(target)
}

// ── 单聊消息 ──────────────────────────────────────────────

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmMessage {
    pub id: String,
    /// "user" | identity_id
    pub from: String,
    pub content: String,
    #[serde(default)]
    pub kind: String,
    pub ts: f64,
    #[serde(default)]
    pub attachments: Vec<String>,
}

pub fn load_dm_messages(home: &Path, project_id: &str, identity_id: &str) -> Vec<DmMessage> {
    fs::read_to_string(dm_messages_path(home, project_id, identity_id))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn append_dm_message(
    home: &Path,
    project_id: &str,
    identity_id: &str,
    from: &str,
    content: &str,
    attachments: &[String],
) -> Result<DmMessage> {
    let msg = DmMessage {
        id: format!("dm_{}", current_ms()),
        from: from.to_owned(),
        content: content.to_owned(),
        kind: if attachments.is_empty() { "text".into() } else { "file".into() },
        ts: (current_ms() as f64) / 1000.0,
        attachments: attachments.to_vec(),
    };
    let path = dm_messages_path(home, project_id, identity_id);
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    let mut msgs = load_dm_messages(home, project_id, identity_id);
    msgs.push(msg.clone());
    // 上限 500 条
    if msgs.len() > 500 {
        let cut = msgs.len() - 500;
        msgs.drain(0..cut);
    }
    fs::write(&path, serde_json::to_vec_pretty(&msgs)?)?;
    // 更新身份 last_seen / unread
    let mut list = load_identities(home, project_id);
    if let Some(identity) = list.iter_mut().find(|i| i.id == identity_id) {
        identity.last_seen_ms = current_ms();
        if from == "user" {
            // user 发言清零对方未读不在此处理；user 视角的未读在收到 identity 回复时 +1
        } else {
            identity.dm_unread += 1;
        }
        let updated = identity.clone();
        let _ = save_identities(home, project_id, &list);
        if let Ok(bytes) = serde_json::to_vec_pretty(&updated) {
            let _ = fs::write(identity_path(home, project_id, identity_id), bytes);
        }
    }
    Ok(msg)
}

/// 清空单聊未读。
pub fn clear_dm_unread(home: &Path, project_id: &str, identity_id: &str) {
    let mut list = load_identities(home, project_id);
    if let Some(identity) = list.iter_mut().find(|i| i.id == identity_id) {
        if identity.dm_unread > 0 {
            identity.dm_unread = 0;
            let updated = identity.clone();
            let _ = save_identities(home, project_id, &list);
            if let Ok(bytes) = serde_json::to_vec_pretty(&updated) {
                let _ = fs::write(identity_path(home, project_id, identity_id), bytes);
            }
        }
    }
}

// ── 用户习惯记忆 ────────────────────────────────────────────

/// 读取身份的习惯记忆摘要（最近 10 条 habit 类型记忆）。
pub fn load_habit_summary(home: &Path, project_id: &str, identity_id: &str) -> Option<String> {
    let mem_dir = identity_memory_dir(home, project_id, identity_id);
    let mut habits: Vec<String> = Vec::new();
    for name in ["items.json", "memory.jsonl", "memories.json"] {
        let path = mem_dir.join(name);
        let Ok(raw) = fs::read_to_string(&path) else { continue };
        let parse = |v: &Value| -> Option<String> {
            let kind = v.get("kind").and_then(Value::as_str).unwrap_or("");
            if kind != "habit" {
                return None;
            }
            let text = v.get("text").or_else(|| v.get("content")).and_then(Value::as_str)?;
            if !text.trim().is_empty() {
                Some(text.trim().to_owned())
            } else {
                None
            }
        };
        if name.ends_with(".jsonl") {
            for line in raw.lines() {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    if let Some(t) = parse(&v) {
                        habits.push(t);
                    }
                }
            }
        } else if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(arr) = v.as_array() {
                for item in arr {
                    if let Some(t) = parse(item) {
                        habits.push(t);
                    }
                }
            } else if let Some(t) = parse(&v) {
                habits.push(t);
            }
        }
        break;
    }
    if habits.is_empty() {
        return None;
    }
    let start = habits.len().saturating_sub(10);
    let joined: String = habits[start..]
        .iter()
        .map(|h| format!("- {}", h.chars().take(200).collect::<String>()))
        .collect::<Vec<_>>()
        .join("\n");
    if joined.trim().is_empty() { None } else { Some(joined) }
}

/// 追加一条习惯记忆。
pub fn append_habit_memory(
    home: &Path,
    project_id: &str,
    identity_id: &str,
    text: &str,
) -> Result<()> {
    let mem_dir = identity_memory_dir(home, project_id, identity_id);
    fs::create_dir_all(&mem_dir)?;
    let entry = json!({
        "kind": "habit",
        "text": text,
        "ts": current_ms() as f64 / 1000.0,
    });
    let path = mem_dir.join("items.json");
    let mut items: Vec<Value> = if let Ok(raw) = fs::read_to_string(&path) {
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        Vec::new()
    };
    items.push(entry);
    // 上限 50 条
    if items.len() > 50 {
        let cut = items.len() - 50;
        items.drain(0..cut);
    }
    fs::write(&path, serde_json::to_vec_pretty(&items)?)?;
    Ok(())
}

// ── 迁移 / 删除旧数据 ─────────────────────────────────────

/// 旧平铺房间目录。
pub fn legacy_group_chat_dir(home: &Path) -> PathBuf {
    home.join("group-chat")
}

fn legacy_purged_flag(home: &Path) -> PathBuf {
    projects_root(home).join(".legacy_purged")
}

/// 是否存在旧数据。旧版清理功能已下线，恒为 false（不再提示删除）。
pub fn has_legacy_data(_home: &Path) -> bool {
    false
}

/// 删除旧平铺群聊数据（只删不迁；用户确认后调用）。
/// 注意：调用方需先清空 GroupChatRuntime 内存，避免 persist 写回。
pub fn purge_legacy_data(home: &Path) -> Result<usize> {
    let dir = legacy_group_chat_dir(home);
    let mut n = 0;
    if let Ok(text) = fs::read_to_string(dir.join("rooms.json")) {
        if let Ok(rooms) = serde_json::from_str::<Value>(&text) {
            n = rooms.as_array().map(|a| a.len()).unwrap_or(0);
        }
    }
    if dir.is_dir() {
        fs::remove_dir_all(&dir)?;
    }
    // 写清理标记，避免 runtime 再写 rooms.json 后又提示
    fs::create_dir_all(projects_root(home))?;
    fs::write(legacy_purged_flag(home), current_ms().to_string())?;
    Ok(n)
}

/// 将旧房间迁入指定项目（可选路径；默认我们走删除策略，此函数保留给批量迁移）。
pub fn migrate_legacy_into_project(home: &Path, project_id: &str) -> Result<usize> {
    let path = legacy_group_chat_dir(home).join("rooms.json");
    if !path.is_file() {
        return Ok(0);
    }
    let text = fs::read_to_string(&path)?;
    let rooms: Value = serde_json::from_str(&text)?;
    let arr = rooms.as_array().cloned().unwrap_or_default();
    let mut n = 0;
    for room in arr {
        if let Some(rid) = room.get("id").and_then(Value::as_str) {
            let _ = register_room(home, project_id, rid);
            n += 1;
        }
    }
    Ok(n)
}

/// 项目概要（给前端列表用）。
pub fn project_summary(home: &Path, project: &Project) -> Value {
    let identities = list_identities(home, &project.id);
    json!({
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "createdAtMs": project.created_at_ms,
        "updatedAtMs": project.updated_at_ms,
        "roomCount": project.room_ids.len(),
        "identityCount": identities.len(),
        "roomIds": project.room_ids,
    })
}

/// 身份概要（含绑定生命体状态快照）。
pub fn identity_summary(home: &Path, identity: &Identity) -> Value {
    let mut life_state = Value::Null;
    if let Some(life_id) = &identity.life_id {
        if let Ok(text) = fs::read_to_string(
            crate::group_life::group_life_dir(home).join(life_id).join("state.json"),
        ) {
            life_state = serde_json::from_str(&text).unwrap_or(Value::Null);
        }
    }
    json!({
        "id": identity.id,
        "name": identity.name,
        "nameKey": identity.name_key,
        "persona": identity.persona,
        "speakingStyle": identity.speaking_style,
        "values": identity.values,
        "modelSelector": identity.model_selector,
        "color": identity.color,
        "icon": identity.icon,
        "mood": identity.mood,
        "valence": identity.valence,
        "arousal": identity.arousal,
        "attention": identity.attention,
        "bond": identity.bond,
        "memoryCount": identity.memory_count,
        "turnCount": identity.turn_count,
        "milestonesHit": identity.milestones_hit,
        "relationshipScale": identity.relationship_scale,
        "lifeId": identity.life_id,
        "lifeState": life_state,
        "roomIds": identity.room_ids,
        "createdAtMs": identity.created_at_ms,
        "lastSeenMs": identity.last_seen_ms,
        "dmUnread": identity.dm_unread,
    })
}

/// 更新身份运行时状态（情绪/羁绊等，由生命体引擎回写）。
pub fn touch_identity_state(
    home: &Path,
    project_id: &str,
    identity_id: &str,
    mood: Option<f32>,
    valence: Option<f64>,
    arousal: Option<f64>,
    bond: Option<f64>,
    memory_count: Option<u64>,
    turn_count: Option<u64>,
) {
    let mut list = load_identities(home, project_id);
    if let Some(identity) = list.iter_mut().find(|i| i.id == identity_id) {
        if let Some(v) = mood { identity.mood = v.clamp(-1.0, 1.0); }
        if let Some(v) = valence { identity.valence = v; }
        if let Some(v) = arousal { identity.arousal = v; }
        if let Some(v) = bond { identity.bond = v; }
        if let Some(v) = memory_count { identity.memory_count = v; }
        if let Some(v) = turn_count { identity.turn_count = v; }
        identity.last_seen_ms = current_ms();
        let updated = identity.clone();
        let _ = save_identities(home, project_id, &list);
        if let Ok(bytes) = serde_json::to_vec_pretty(&updated) {
            let _ = fs::write(identity_path(home, project_id, identity_id), bytes);
        }
    }
}

// ── 并发安全：全局锁用 std::sync::Mutex 包装在调用方 ──────
// projects 模块本身无全局状态；读写均为文件级。

/// 测试辅助：空 registry。
pub fn empty_registry() -> ProjectRegistry {
    ProjectRegistry { version: 1, projects: Vec::new(), active_id: None }
}
