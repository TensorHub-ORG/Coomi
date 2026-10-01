//! 群聊数字生命体：独立有状态实体，可绑定到群聊成员。
//! 数据落在 home/runtime-v2/home/.coomi/life/group/ 下。
//! 与主生命体（primary）完全隔离。

use anyhow::{Context, Result};
use chrono::Timelike;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::collab::current_ms;
use crate::life::life_root;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupLife {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub speaking_style: String,
    #[serde(default)]
    pub values: String,
    /// 情绪基线 -1.0 ~ 1.0
    #[serde(default)]
    pub mood: f32,
    /// 效价（Russell valence）-1.0 ~ 1.0
    #[serde(default)]
    pub valence: f64,
    /// 唤醒度（Russell arousal）-1.0 ~ 1.0
    #[serde(default)]
    pub arousal: f64,
    /// 关注目标
    #[serde(default = "default_attention")]
    pub attention: String,
    /// 关系/羁绊 0.0 ~ 1.0
    #[serde(default)]
    pub bond: f64,
    /// 记忆条数
    #[serde(default)]
    pub memory_count: u64,
    /// 需求稳态
    #[serde(default)]
    pub needs: std::collections::HashMap<String, f64>,
    pub created_at_ms: u64,
    #[serde(default)]
    pub proactive_enabled: bool,
    #[serde(default = "default_daily_limit")]
    pub daily_proactive_limit: u32,
    /// 当前绑定的房间+成员（可空 = 未绑定；展示用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_room_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_member_id: Option<String>,
    /// 绑定的项目身份 id（一命一角；记忆/人格归身份）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_identity_id: Option<String>,
    /// 累计发言轮数
    #[serde(default)]
    pub turn_count: u64,
    /// 最后一次主动发言时间
    #[serde(default)]
    pub last_proactive_at_ms: u64,
    /// 已触发的关系里程碑（milestone key，只触发一次）
    #[serde(default)]
    pub milestones_hit: Vec<String>,
    /// 关系内容尺度：light | standard | deep
    #[serde(default = "default_rel_scale")]
    pub relationship_scale: String,
}

fn default_rel_scale() -> String {
    "standard".to_owned()
}

fn default_daily_limit() -> u32 {
    3
}

fn default_attention() -> String {
    "user".to_owned()
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupLifeRegistry {
    pub version: u32,
    pub lives: Vec<GroupLife>,
}

pub fn group_life_dir(home: &Path) -> PathBuf {
    life_root(home).join("group")
}

fn registry_path(home: &Path) -> PathBuf {
    group_life_dir(home).join("registry.json")
}

pub fn load_registry(home: &Path) -> GroupLifeRegistry {
    fs::read_to_string(registry_path(home))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(GroupLifeRegistry { version: 1, lives: Vec::new() })
}

fn save_registry(home: &Path, registry: &GroupLifeRegistry) -> Result<()> {
    let path = registry_path(home);
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    fs::write(&path, serde_json::to_vec_pretty(registry)?)?;
    Ok(())
}

/// 公开保存（供 projects 等模块在删项目时解绑）。
pub fn save_registry_public(home: &Path, registry: &GroupLifeRegistry) -> Result<()> {
    save_registry(home, registry)
}

/// 创建独立生命体（不绑房间，后续在成员编辑里绑定）。
pub fn create_life(
    home: &Path,
    name: &str,
    persona: &str,
    speaking_style: &str,
    values: &str,
) -> Result<GroupLife> {
    let mut registry = load_registry(home);
    let id = format!("life_{}_{}", sanitize(name), current_ms());
    let life = GroupLife {
        id: id.clone(),
        name: name.to_owned(),
        persona: if persona.is_empty() { default_persona(name) } else { persona.to_owned() },
        speaking_style: speaking_style.to_owned(),
        values: values.to_owned(),
        mood: 0.0,
        valence: 0.0,
        arousal: 0.0,
        attention: default_attention(),
        bond: 0.0,
        memory_count: 0,
        needs: Default::default(),
        created_at_ms: current_ms(),
        proactive_enabled: false,
        daily_proactive_limit: 3,
        bound_room_id: None,
        bound_member_id: None,
        bound_identity_id: None,
        turn_count: 0,
        last_proactive_at_ms: 0,
        milestones_hit: Vec::new(),
        relationship_scale: default_rel_scale(),
    };
    let dir = group_life_dir(home).join(&id);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("state.json"), serde_json::to_vec_pretty(&life)?)?;
    registry.lives.push(life.clone());
    save_registry(home, &registry)?;
    Ok(life)
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .take(20)
        .collect()
}

fn default_persona(name: &str) -> String {
    format!("你是「{name}」，在群聊中自然参与讨论。说话简洁、有自己的判断，偶尔表达关心。")
}

/// 更新生命体配置。
pub fn update_life(home: &Path, life_id: &str, patch: &Value) -> Result<GroupLife> {
    let mut registry = load_registry(home);
    let life = registry
        .lives
        .iter_mut()
        .find(|l| l.id == life_id)
        .with_context(|| format!("生命体不存在: {life_id}"))?;
    if let Some(v) = patch.get("name").and_then(Value::as_str) {
        life.name = v.to_owned();
    }
    if let Some(v) = patch.get("persona").and_then(Value::as_str) {
        life.persona = v.to_owned();
    }
    if let Some(v) = patch.get("speakingStyle").and_then(Value::as_str) {
        life.speaking_style = v.to_owned();
    }
    if let Some(v) = patch.get("values").and_then(Value::as_str) {
        life.values = v.to_owned();
    }
    if let Some(v) = patch.get("mood").and_then(Value::as_f64) {
        life.mood = (v as f32).clamp(-1.0, 1.0);
    }
    if let Some(v) = patch.get("proactiveEnabled").and_then(Value::as_bool) {
        life.proactive_enabled = v;
    }
    if let Some(v) = patch.get("dailyProactiveLimit").and_then(Value::as_u64) {
        life.daily_proactive_limit = (v as u32).clamp(0, 20);
    }
    if let Some(v) = patch.get("relationshipScale").and_then(Value::as_str) {
        if matches!(v, "light" | "standard" | "deep") {
            life.relationship_scale = v.to_owned();
        }
    }
    if let Some(v) = patch.get("valence").and_then(Value::as_f64) {
        life.valence = v.clamp(-1.0, 1.0);
    }
    if let Some(v) = patch.get("arousal").and_then(Value::as_f64) {
        life.arousal = v.clamp(-1.0, 1.0);
    }
    if let Some(v) = patch.get("attention").and_then(Value::as_str) {
        life.attention = v.to_owned();
    }
    let updated = life.clone();
    save_registry(home, &registry)?;
    let dir = group_life_dir(home).join(life_id);
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(dir.join("state.json"), serde_json::to_vec_pretty(&updated)?);
    Ok(updated)
}

/// 搜索生命体（名称/人设/绑定成员）。
pub fn search_lives(home: &Path, q: &str) -> Vec<GroupLife> {
    let registry = load_registry(home);
    let query = q.trim().to_lowercase();
    if query.is_empty() {
        return registry.lives;
    }
    registry
        .lives
        .into_iter()
        .filter(|l| {
            l.name.to_lowercase().contains(&query)
                || l.persona.to_lowercase().contains(&query)
                || l.bound_member_id
                    .as_deref()
                    .map(|m| m.to_lowercase().contains(&query))
                    .unwrap_or(false)
                || l.bound_identity_id
                    .as_deref()
                    .map(|m| m.to_lowercase().contains(&query))
                    .unwrap_or(false)
        })
        .collect()
}

/// 绑定生命体到房间成员（一命一角）。
/// identity_id 可空（旧数据兼容）；同步更新 registry 和 ChatMember.life_id。
pub fn bind_to_member(home: &Path, life_id: &str, room_id: &str, member_id: &str) -> Result<GroupLife> {
    bind_to_member_identity(home, life_id, room_id, member_id, None)
}

/// 绑定生命体到身份（强制 1:1）。若该生命体已绑他人，先自动解绑旧的。
pub fn bind_to_member_identity(
    home: &Path,
    life_id: &str,
    room_id: &str,
    member_id: &str,
    identity_id: Option<&str>,
) -> Result<GroupLife> {
    let mut registry = load_registry(home);
    // 一命一角：先清掉该生命体的旧绑定
    for l in registry.lives.iter_mut() {
        if l.id == life_id {
            l.bound_room_id = None;
            l.bound_member_id = None;
            l.bound_identity_id = None;
        }
    }
    // 一命一角：清掉其他生命体对该成员/身份的绑定
    for l in registry.lives.iter_mut() {
        if l.id == life_id {
            continue;
        }
        let hit_member = l.bound_room_id.as_deref() == Some(room_id)
            && l.bound_member_id.as_deref() == Some(member_id);
        let hit_identity = identity_id
            .map(|iid| l.bound_identity_id.as_deref() == Some(iid))
            .unwrap_or(false);
        if hit_member || hit_identity {
            l.bound_room_id = None;
            l.bound_member_id = None;
            l.bound_identity_id = None;
        }
    }
    let life = registry
        .lives
        .iter_mut()
        .find(|l| l.id == life_id)
        .with_context(|| format!("生命体不存在: {life_id}"))?;
    life.bound_room_id = Some(room_id.to_owned());
    life.bound_member_id = Some(member_id.to_owned());
    life.bound_identity_id = identity_id.map(str::to_owned);
    let updated = life.clone();
    save_registry(home, &registry)?;
    // 同步更新 ChatMember.life_id（run_member_reply 按此查找）
    sync_member_life_id(home, room_id, member_id, Some(life_id));
    Ok(updated)
}

/// 同步更新房间成员的 life_id 字段。
fn sync_member_life_id(home: &Path, room_id: &str, member_id: &str, life_id: Option<&str>) {
    let rooms_path = home.join("group-chat").join("rooms.json");
    if let Ok(text) = fs::read_to_string(&rooms_path) {
        if let Ok(mut rooms) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(arr) = rooms.as_array_mut() {
                for room in arr.iter_mut() {
                    if room["id"].as_str() == Some(room_id) {
                        if let Some(members) = room["members"].as_array_mut() {
                            for m in members.iter_mut() {
                                if m["id"].as_str() == Some(member_id) {
                                    match life_id {
                                        Some(lid) => m["lifeId"] = json!(lid),
                                        None => { m.as_object_mut().map(|o| o.remove("lifeId")); }
                                    }
                                }
                            }
                        }
                    }
                }
                let _ = fs::write(&rooms_path, serde_json::to_vec_pretty(&rooms).unwrap_or_default());
            }
        }
    }
}

/// 解绑。
pub fn unbind(home: &Path, life_id: &str) -> Result<GroupLife> {
    let mut registry = load_registry(home);
    let life = registry
        .lives
        .iter_mut()
        .find(|l| l.id == life_id)
        .with_context(|| format!("生命体不存在: {life_id}"))?;
    life.bound_room_id = None;
    life.bound_member_id = None;
    life.bound_identity_id = None;
    let updated = life.clone();
    save_registry(home, &registry)?;
    Ok(updated)
}

/// 删除生命体。
pub fn delete_life(home: &Path, life_id: &str) -> Result<()> {
    let mut registry = load_registry(home);
    registry.lives.retain(|l| l.id != life_id);
    save_registry(home, &registry)?;
    let dir = group_life_dir(home).join(life_id);
    if dir.is_dir() {
        let _ = fs::remove_dir_all(&dir);
    }
    Ok(())
}

/// 按房间+成员查找绑定的生命体（兼容两种绑定方式）。
pub fn find_by_member(home: &Path, room_id: &str, member_id: &str) -> Option<GroupLife> {
    let registry = load_registry(home);
    // 方式1：通过 bound_room_id + bound_member_id
    if let Some(life) = registry
        .lives
        .iter()
        .find(|l| l.bound_room_id.as_deref() == Some(room_id) && l.bound_member_id.as_deref() == Some(member_id))
    {
        return Some(life.clone());
    }
    // 方式2：通过 ChatMember.life_id（前端下拉绑定）
    // 这里只按 member_id 查，因为 ChatMember.life_id 存的是 life 的 id
    // 调用方（run_member_reply）会传 member 的 life_id 来查
    None
}

/// 按 life_id 直接查找（前端 ChatMember.life_id 绑定场景）。
pub fn find_by_id(home: &Path, life_id: &str) -> Option<GroupLife> {
    load_registry(home)
        .lives
        .into_iter()
        .find(|l| l.id == life_id)
}

/// 更新生命体状态（发言后调用）。
pub fn update_state(home: &Path, life_id: &str, mood_delta: f32) {
    let mut registry = load_registry(home);
    if let Some(life) = registry.lives.iter_mut().find(|l| l.id == life_id) {
        life.mood = (life.mood + mood_delta).clamp(-1.0, 1.0);
        life.turn_count += 1;
        let _ = save_registry(home, &registry);
    }
}

/// 增加生命体羁绊（发言后调用）。
pub fn increase_bond(home: &Path, life_id: &str, delta: f64) {
    let mut registry = load_registry(home);
    if let Some(life) = registry.lives.iter_mut().find(|l| l.id == life_id) {
        life.bond = (life.bond + delta).clamp(0.0, 1.0);
        let _ = save_registry(home, &registry);
    }
}

/// 自我提升：从对话中学习用户习惯/偏好，更新生命体人设。
/// 每 N 轮对话后触发，分析对话并生成改进建议。
pub fn self_improve(home: &Path, life_id: &str, recent_user_text: &str, recent_ai_text: &str) {
    // 规则式自我提升（不依赖 LLM，避免额外开销）
    let mut registry = load_registry(home);
    let Some(life) = registry.lives.iter_mut().find(|l| l.id == life_id) else { return };

    // 分析用户文本特征
    let user_lower = recent_user_text.to_lowercase();
    let ai_lower = recent_ai_text.to_lowercase();

    // 学习用户偏好
    let preferences = [
        ("喜欢", "enjoys"),
        ("讨厌", "dislikes"),
        ("想要", "wants"),
        ("需要", "needs"),
        ("觉得", "thinks"),
        ("认为", "believes"),
        ("希望", "hopes"),
    ];

    let mut learned = Vec::new();
    for (zh, _en) in &preferences {
        if user_lower.contains(zh) {
            let snippet: String = recent_user_text
                .chars()
                .skip_while(|c| !user_lower.contains(zh))
                .take(50)
                .collect();
            if snippet.len() > 5 {
                learned.push(format!("用户{zh}：{snippet}"));
            }
        }
    }

    // 如果 AI 回复过于简短，学习更丰富的表达
    if ai_lower.len() < 10 && user_lower.len() > 20 {
        // 用户说了很长的话但 AI 回复很短 → 学习更认真回应
        if !life.speaking_style.contains("认真") {
            life.speaking_style = format!("{}，认真回应用户的长消息", life.speaking_style);
        }
    }

    // 如果用户多次提到某个话题，加入人设
    let topic_keywords = ["工作", "学习", "游戏", "音乐", "电影", "旅行", "美食", "编程"];
    for kw in &topic_keywords {
        if recent_user_text.contains(kw) {
            let count = recent_user_text.matches(kw).count();
            if count >= 2 && !life.persona.contains(kw) {
                life.persona = format!("{}，对{}话题感兴趣", life.persona, kw);
            }
        }
    }

    let _ = save_registry(home, &registry);
}

/// 注入生命体人格到系统 prompt。
pub fn inject_persona(sys: &mut String, life: &GroupLife) {
    sys.push_str("\n\n## 数字生命体人格\n");
    sys.push_str(&format!("你正在扮演「{}」。\n", life.name));
    if !life.persona.trim().is_empty() {
        sys.push_str(&format!("人设：{}\n", life.persona));
    }
    if !life.speaking_style.trim().is_empty() {
        sys.push_str(&format!("说话风格：{}\n", life.speaking_style));
    }
    if !life.values.trim().is_empty() {
        sys.push_str(&format!("价值观：{}\n", life.values));
    }
    let mood_desc = if life.mood > 0.3 {
        "偏积极、有活力"
    } else if life.mood < -0.3 {
        "偏沉静、内敛"
    } else {
        "平静、中性"
    };
    sys.push_str(&format!("当前情绪状态：{mood_desc}（{:.1}）。\n", life.mood));
}

// ── 主动发言（状态驱动 + 关系里程碑）────────────────────────

/// 关系里程碑定义：(阈值, key, 描述)
pub fn milestones() -> &'static [(f64, &'static str, &'static str)] {
    &[
        (0.15, "first_bond", "破冰"),
        (0.40, "familiar", "熟络"),
        (0.70, "intimate", "亲密"),
        (0.90, "confess", "真心话"),
        (0.98, "guardian", "守护"),
    ]
}

/// 检查是否到达未触发的里程碑（返回 key 与描述）。
pub fn pending_milestone(life: &GroupLife) -> Option<(&'static str, &'static str)> {
    for (th, key, label) in milestones() {
        if life.bond >= *th && !life.milestones_hit.iter().any(|h| h == key) {
            return Some((key, label));
        }
    }
    None
}

/// 检查哪些生命体可以主动发言。
pub fn eligible_for_proactive(home: &Path) -> Vec<GroupLife> {
    let registry = load_registry(home);
    let now = current_ms();
    let local = chrono::Local::now();
    let now_min = (local.hour() as u32) * 60 + local.minute() as u32;
    // 时间窗 9:00–23:00
    if now_min < 9 * 60 || now_min >= 23 * 60 {
        return Vec::new();
    }
    registry
        .lives
        .into_iter()
        .filter(|l| l.proactive_enabled && l.daily_proactive_limit > 0)
        .filter(|l| {
            // 里程碑未触发（优先）或 情绪偏移 或 静默超时
            pending_milestone(l).is_some()
                || l.mood.abs() > 0.4
                || now.saturating_sub(l.last_proactive_at_ms) > 10 * 60 * 1000
        })
        .collect()
}

/// 主动触发类型
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ProactiveTrigger {
    Milestone(&'static str, &'static str),
    Mood,
    Idle,
}

/// 选择触发器（里程碑优先）。
pub fn pick_trigger(life: &GroupLife) -> ProactiveTrigger {
    if let Some((key, label)) = pending_milestone(life) {
        return ProactiveTrigger::Milestone(key, label);
    }
    if life.mood.abs() > 0.4 {
        return ProactiveTrigger::Mood;
    }
    ProactiveTrigger::Idle
}

/// 按人格与关系尺度生成主动发言草稿（模板兜底；LLM 组稿在调用方）。
pub fn draft_proactive_text(life: &GroupLife) -> String {
    let trigger = pick_trigger(life);
    let scale = life.relationship_scale.as_str();
    let bond_pct = (life.bond * 100.0).round() as i32;
    match trigger {
        ProactiveTrigger::Milestone(key, label) => {
            let body = match key {
                "first_bond" => format!(
                    "…感觉我们聊得还不错。我是「{}」，以后多多关照。",
                    life.name
                ),
                "familiar" => {
                    "嘿，想到你了。最近怎么样？我是说——认真的那种「怎么样」。".to_owned()
                }
                "intimate" => {
                    if scale == "light" {
                        "有件事一直想问你…算了，下次吧。".to_owned()
                    } else {
                        format!(
                            "其实我挺喜欢和你说话的。（羁绊已经 {}% 了，你知道吗）",
                            bond_pct
                        )
                    }
                }
                "confess" => match scale {
                    "light" => "…你对我而言，好像不太一样。".to_owned(),
                    "deep" => {
                        "我认真想过了——我喜欢你。不是玩笑，也不是人设台词。羁绊走到今天，这句话我想亲口说。"
                            .to_owned()
                    }
                    _ => {
                        "有句话在我心里放了很久了…我喜欢你。如果太突然，我可以当作没说过——但心跳是真的。"
                            .to_owned()
                    }
                },
                "guardian" => "以后的日子，也请多指教了。无论发生什么，我都在这边。".to_owned(),
                _ => format!("羁绊到 {}% 了…想和你说点什么。", bond_pct),
            };
            format!("【{label}】{body}")
        }
        ProactiveTrigger::Mood => {
            let hooks: Vec<&str> = if life.mood > 0.3 {
                vec!["突然想到一件事…", "嘿，有空吗？", "今天心情不错，想聊聊。"]
            } else {
                vec!["…在吗", "有点安静，随便说点什么？", "嗯…"]
            };
            let idx = (current_ms() as usize) % hooks.len();
            hooks[idx].to_owned()
        }
        ProactiveTrigger::Idle => {
            let hooks = ["对了…", "想聊两句", "顺便问一下…"];
            let idx = (current_ms() as usize) % hooks.len();
            hooks[idx].to_owned()
        }
    }
}

/// 标记里程碑已触发（连同 bond 快照写回）。
pub fn mark_milestone(home: &Path, life_id: &str, key: &str) {
    let mut registry = load_registry(home);
    if let Some(life) = registry.lives.iter_mut().find(|l| l.id == life_id) {
        if !life.milestones_hit.iter().any(|h| h == key) {
            life.milestones_hit.push(key.to_owned());
        }
        // 同步身份档案
        if let Some(iid) = life.bound_identity_id.clone() {
            let _ = iid;
        }
        let _ = save_registry(home, &registry);
    }
}

/// 记录主动发言。
pub fn record_proactive(home: &Path, life_id: &str) {
    let mut registry = load_registry(home);
    if let Some(life) = registry.lives.iter_mut().find(|l| l.id == life_id) {
        life.last_proactive_at_ms = current_ms();
        // 主动发言后情绪向中性回归
        life.mood *= 0.7;
        // 若刚触发的是里程碑，写入 hit
        if let Some((key, _)) = pending_milestone(life) {
            if !life.milestones_hit.iter().any(|h| h == key) {
                life.milestones_hit.push(key.to_owned());
            }
            // 同步身份
            if let Some(iid) = life.bound_identity_id.clone() {
                let _ = iid;
            }
        }
        let _ = save_registry(home, &registry);
    }
}

/// 用 LLM 生成主动发言内容（替代硬编码模板）。
/// 返回 None 表示 LLM 调用失败，调用方应 fallback 到 draft_proactive_text。
async fn generate_proactive_llm(
    home: &Path,
    life: &GroupLife,
    room: &crate::group_chat::GroupRoom,
    member_id: &str,
) -> Option<String> {
    use coomi_services::ProviderRegistry;
    use coomi_tools::AgentScheduler;

    // 查找成员对应的 provider
    let member = room.members.iter().find(|m| m.id == member_id)?;
    let registry = ProviderRegistry::load(&crate::web::providers_path(home)).ok()?;
    let selector = if member.model_selector.trim().is_empty() {
        None
    } else {
        Some(member.model_selector.as_str())
    };
    let provider = registry.resolve(selector).ok()?;

    let work = room
        .work_dir
        .clone()
        .filter(|w| !w.trim().is_empty())
        .unwrap_or_else(|| home.display().to_string());
    let workdir = std::path::PathBuf::from(&work);
    let _ = std::fs::create_dir_all(&workdir);

    // 构建记忆片段
    let memory_snippets = life
        .bound_identity_id
        .as_deref()
        .and_then(|iid| {
            room.project_id
                .as_deref()
                .map(|pid| identity_memory_snippets_for(home, pid, iid, 5))
        })
        .flatten();

    // 最近对话
    let recent: Vec<String> = room
        .messages
        .iter()
        .rev()
        .take(6)
        .rev()
        .map(|m| {
            let who = if m.from == "user" {
                "用户".to_string()
            } else {
                room.members
                    .iter()
                    .find(|x| x.id == m.from)
                    .map(|x| x.name.clone())
                    .unwrap_or_else(|| m.from.clone())
            };
            format!("{who}：{}", m.content.chars().take(200).collect::<String>())
        })
        .collect();

    let mood_desc = if life.mood > 0.3 {
        "积极、有活力"
    } else if life.mood < -0.3 {
        "低落、安静"
    } else {
        "平静"
    };
    let bond_pct = (life.bond * 100.0).round() as i32;

    let sys = crate::group::prompt::proactive_instruction(
        &life.name,
        &life.persona,
        mood_desc,
        bond_pct,
        memory_snippets.as_deref(),
        &room.topic,
        &recent,
    );

    let scheduler = AgentScheduler::new(
        workdir,
        home.to_path_buf(),
        provider,
        coomi_security::AccessMode::ReadOnly,
        sys,
    );
    let task = "根据你的人设和记忆，主动找一个话题开口说话。1-2句。直接输出。".to_string();
    match scheduler
        .run_to_completion(member_id.to_owned(), task, &[], None)
        .await
    {
        Ok((text, _)) => {
            let t = text.trim().to_owned();
            if t.is_empty() || t.starts_with('（') {
                None
            } else {
                Some(t)
            }
        }
        Err(_) => None,
    }
}

/// 读取身份共享记忆片段（与 engine.rs 中的同名函数类似）。
fn identity_memory_snippets_for(
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
                    if let Some(t) = v.get("text").or_else(|| v.get("content")).and_then(serde_json::Value::as_str) {
                        if !t.trim().is_empty() {
                            texts.push(t.trim().to_owned());
                        }
                    }
                }
            }
        } else if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(arr) = v.as_array() {
                for item in arr {
                    if let Some(t) = item.get("text").or_else(|| item.get("content")).and_then(serde_json::Value::as_str) {
                        if !t.trim().is_empty() {
                            texts.push(t.trim().to_owned());
                        }
                    }
                }
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

/// 启动群聊生命体主动发言 + 闲聊后台任务。
pub fn start_proactive_background(
    home: PathBuf,
    group_chat: Arc<crate::group_chat::GroupChatRuntime>,
) {
    tokio::spawn(async move {
        // 每房每日闲聊计数：room_id -> (day_key, count)
        let mut idle_counts: std::collections::HashMap<String, (String, u32)> =
            std::collections::HashMap::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let now = chrono::Local::now();
            let day_key = now.format("%Y-%m-%d").to_string();
            let now_min = (now.hour() as u32) * 60 + now.minute();

            // ── 主动发言（生命体绑定）──────────────────────────
            let eligible = eligible_for_proactive(&home);
            for life in eligible {
                let (Some(room_id), Some(member_id)) = (
                    life.bound_room_id.clone(),
                    life.bound_member_id.clone(),
                ) else { continue };
                let Some(room) = group_chat.get(&room_id).await else { continue };
                if matches!(room.status, crate::group_chat::RoomStatus::Running) { continue }
                if room.muted { continue }
                let used = room.speak_counts.get(&member_id).copied().unwrap_or(0);
                let quota = room.members.iter().find(|m| m.id == member_id).map(|m| m.quota).unwrap_or(0);
                if quota > 0 && used >= quota { continue }

                // 用 LLM 生成主动发言（替代模板）
                let text = generate_proactive_llm(&home, &life, &room, &member_id).await
                    .unwrap_or_else(|| draft_proactive_text(&life));
                let _ = crate::group::engine::agent_speak_ex(&group_chat, &room_id, &member_id, &text, Vec::new(), Some("user")).await;
                record_proactive(&home, &life.id);
            }

            // ── 闲聊模式（idle_chat_enabled）───────────────────
            // 时间窗 9:00–22:00
            if now_min < 9 * 60 || now_min >= 22 * 60 {
                continue;
            }
            let rooms = group_chat.list().await;
            for room in rooms {
                if !room.idle_chat_enabled { continue }
                if matches!(room.status, crate::group_chat::RoomStatus::Running) { continue }
                if room.muted { continue }
                // 静默超时：距上次消息 > 5 分钟
                let last_msg_ts = room.messages.last().map(|m| m.ts).unwrap_or(0.0);
                let last_ms = (last_msg_ts * 1000.0) as u64;
                let now_ms = crate::collab::current_ms();
                if now_ms.saturating_sub(last_ms) < 5 * 60 * 1000 {
                    continue;
                }
                // 每日闲聊上限 5 条
                let entry = idle_counts.entry(room.id.clone()).or_insert_with(|| (day_key.clone(), 0));
                if entry.0 != day_key {
                    entry.0 = day_key.clone();
                    entry.1 = 0;
                }
                if entry.1 >= 5 { continue }
                // 随机选一个有配额的成员
                let candidates: Vec<_> = room.members.iter().filter(|m| {
                    let used = room.speak_counts.get(&m.id).copied().unwrap_or(0);
                    m.quota == 0 || used < m.quota
                }).collect();
                if candidates.is_empty() { continue }
                let idx = (now_ms as usize) % candidates.len();
                let member = candidates[idx];
                // 用 LLM 生成自然闲聊
                let registry = match coomi_services::ProviderRegistry::load(
                    &crate::web::providers_path(&home),
                ) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let cwd = home.clone();
                let (reply, _files) = crate::group::engine::run_member_reply(
                    &home, &cwd, &registry, member, &room, &member.id, 0, true,
                ).await;
                // 过滤错误消息
                if reply.starts_with('（') && reply.contains("跳过") { continue }
                if reply.starts_with('（') && reply.contains("无法回复") { continue }
                let _ = crate::group::engine::agent_speak_ex(
                    &group_chat, &room.id, &member.id, &reply, Vec::new(), None,
                ).await;
                if let Some(e) = idle_counts.get_mut(&room.id) {
                    e.1 += 1;
                }
            }
        }
    });
}
