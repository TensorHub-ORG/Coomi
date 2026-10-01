//! 数字生命体 Rust 原生引擎（替代 Python sidecar）。
//! 零外部依赖，直接函数调用，<1ms 延迟。

pub mod emotion;
pub mod memory;
pub mod personality;
pub mod psi;
pub mod store;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::Path;

use store::LifeStore;

/// 公开状态（与 sidecar public_state 兼容）。
pub fn get_state(home: &Path, profile_id: &str) -> Result<Value> {
    let store = LifeStore::new(home);
    let state = store.load(profile_id)?;
    Ok(store.public_state(&state))
}

/// Bootstrap：初始化 profile（幂等）。
pub fn bootstrap(home: &Path, profile_id: &str, name: &str, address: &str, preset: &str) -> Result<Value> {
    let store = LifeStore::new(home);
    store.bootstrap(profile_id, name, address, preset)
}

/// 配置身份。
pub fn configure(home: &Path, profile_id: &str, name: &str, address: &str, preset: &str) -> Result<Value> {
    let store = LifeStore::new(home);
    let mut state = store.load(profile_id)?;
    if !name.is_empty() { state["name"] = json!(name); }
    if !address.is_empty() { state["address"] = json!(address); }
    if personality::is_valid(preset) {
        state["preset"] = json!(preset);
        state["personality"] = personality::preset(preset);
    }
    store.save(profile_id, &state)
}

/// before_turn：返回 CognitiveTurnContext（与 sidecar 兼容）。
pub fn before_turn(home: &Path, profile_id: &str, user_text: &str, shared_memory: bool) -> Result<Value> {
    let store = LifeStore::new(home);
    // 自动 bootstrap：profile 不存在时创建默认
    let state = match store.load(profile_id) {
        Ok(s) => s,
        Err(_) => {
            store.bootstrap(profile_id, "Coomi Life", "你", "balanced")?;
            store.load(profile_id)?
        }
    };
    if state["paused"].as_bool().unwrap_or(false) {
        // 暂停时返回最小 context（与 CognitiveTurnContext 兼容）
        return Ok(json!({
            "version": 2,
            "state_summary": "",
            "memories": [],
            "personality": {},
            "relationship": "",
            "life_name": state["name"].as_str().unwrap_or(""),
            "user_address": state["address"].as_str().unwrap_or(""),
            "personality_label": "",
            "personality_instruction": "",
            "emotion": "neutral",
            "bond": state["bond"].as_f64().unwrap_or(0.0),
        }));
    }

    let bounded_user = store::bounded(user_text, 12000);
    let memories = if shared_memory {
        vec![]
    } else {
        store.recall(profile_id, &bounded_user, 5)?
    };
    let needs: Vec<String> = state["needs"]
        .as_object()
        .map(|o| o.iter().map(|(k, v)| format!("{k}: {:.2}", v.as_f64().unwrap_or(0.5))).collect())
        .unwrap_or_default();
    let preset_name = state["preset"].as_str().unwrap_or("balanced").to_owned();
    let personality = personality::preset(&preset_name);
    let valence = state["valence"].as_f64().unwrap_or(0.0);
    let arousal = state["arousal"].as_f64().unwrap_or(0.0);
    let emo = state["emotion"].as_str().unwrap_or("").to_owned();
    let emo = if emo.is_empty() { emotion::label(valence, arousal).to_owned() } else { emo };
    let bond = state["bond"].as_f64().unwrap_or(0.0);
    let turns = state["turn_count"].as_u64().unwrap_or(0);
    let name = state["name"].as_str().unwrap_or("Coomi Life").to_owned();
    let address = state["address"].as_str().unwrap_or("你").to_owned();
    let attention = state["attention"].as_str().unwrap_or("user").to_owned();
    let mood_v = state["mood_mirror"]["valence"].as_f64().unwrap_or(0.0);
    let agenda_snip = state["agenda"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|a| a["text"].as_str())
        .map(|t| format!(" You still care about: {}.", store::bounded(t, 80)))
        .unwrap_or_default();
    let feel_hint = emotion::feel_hint(&emo).to_owned();
    let bond_pct = (bond * 100.0).round() as i32;
    // bond 里程碑注入：刚跨过阈值时，让生命体“意识到关系升级”。
    let milestone = state["last_milestone"].as_str().unwrap_or("").to_owned();
    let milestone_snip = if milestone.is_empty() {
        String::new()
    } else {
        format!("\n(Relationship milestone just reached: {milestone})")
    };
    // 生命体习惯注入：把沉淀的习惯带进上下文，让生命体“记得用户习惯”。
    let habits = store.list_habits(profile_id);
    let habits_snip = if habits.is_empty() {
        String::new()
    } else {
        let list = habits
            .iter()
            .filter_map(|h| h["text"].as_str())
            .map(|t| format!("- {t}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("\nUser habits you have learned:\n{list}")
    };

    let state_summary = format!(
        "Name: {name}; Emotion: {emo} (valence={valence:.2}, arousal={arousal:.2}); \
         attention: {attention}; bond: {bond:.2} ({bond_pct}%); turns: {turns}; \
         needs: {}.{} Feel: {} Mood mirror: user valence={mood_v:.2}.{}{}",
        needs.join("; "), agenda_snip, feel_hint, habits_snip, milestone_snip
    );
    let relationship = format!(
        "You are {name}, addressing the user as {address}. Keep the {preset_name} personality consistent. \
         Bond={bond:.2} (~{bond_pct}%). You have a continuous history with this user; \
         you may reference shared memories and your own mood when it helps connection. \
         You are an independent digital person with feelings — not a generic assistant shell. \
         Still: safety, accuracy, and the user's explicit tasks outrank personality."
    );

    Ok(json!({
        "version": 2,
        "state_summary": state_summary,
        "memories": memories,
        "personality": personality,
        "relationship": relationship,
        "life_name": name,
        "user_address": address,
        "personality_label": personality["label"].as_str().unwrap_or("均衡"),
        "personality_instruction": personality["instruction"].as_str().unwrap_or(""),
        "emotion": emo,
        "bond": (bond * 10000.0).round() / 10000.0,
    }))
}

/// after_turn：更新 PSI 状态 + 记忆。
pub fn after_turn(
    home: &Path,
    profile_id: &str,
    user_text: &str,
    assistant_text: &str,
    shared_memory_count: Option<u64>,
) -> Result<Value> {
    let store = LifeStore::new(home);
    let mut state = store.load(profile_id)?;
    if state["paused"].as_bool().unwrap_or(false) {
        return Ok(store.public_state(&state));
    }
    let bounded_user = store::bounded(user_text, 12000);
    let bounded_assistant = store::bounded(assistant_text, 12000);
    // bond 里程碑：记录更新前 bond，更新后检测跨阈值，触发时把里程碑写入
    // 下一轮 before_turn 的上下文（milestones 由 before_turn 注入）。
    let old_bond = state["bond"].as_f64().unwrap_or(0.0);
    psi::update(&mut state, &bounded_user, &bounded_assistant);
    let new_bond = state["bond"].as_f64().unwrap_or(0.0);
    if let Some(milestone) = store.maybe_bond_milestone(profile_id, new_bond, old_bond) {
        state["last_milestone"] = json!(milestone);
    }
    let turns = state["turn_count"].as_u64().unwrap_or(0);
    if turns % 8 == 0 {
        store.forget_pass(profile_id)?;
    }
    // Agenda auto-add
    let lower = bounded_user.to_lowercase();
    if ["remember", "别忘", "记得", "备忘"].iter().any(|k| lower.contains(k)) {
        if let Some(agenda) = state["agenda"].as_array_mut() {
            if agenda.len() < 32 {
                agenda.push(json!({"text": store::bounded(&bounded_user, 200), "at_ms": now_ms(), "done": false}));
            }
        }
    }
    if let Some(count) = shared_memory_count {
        state["memory_count"] = json!(count);
    } else {
        store.append_memory(profile_id, &bounded_user, &bounded_assistant)?;
        let mc = state["memory_count"].as_u64().unwrap_or(0) + 1;
        state["memory_count"] = json!(mc);
    }
    store.save(profile_id, &state)
}

/// 暂停/恢复。
pub fn pause(home: &Path, profile_id: &str, paused: bool) -> Result<Value> {
    let store = LifeStore::new(home);
    let mut state = store.load(profile_id)?;
    state["paused"] = json!(paused);
    store.save(profile_id, &state)
}

/// 重置。
pub fn reset(home: &Path, profile_id: &str) -> Result<Value> {
    let store = LifeStore::new(home);
    let state = store.load(profile_id)?;
    let name = state["name"].as_str().unwrap_or("").to_owned();
    let address = state["address"].as_str().unwrap_or("").to_owned();
    let preset = state["preset"].as_str().unwrap_or("balanced").to_owned();
    store.reset(profile_id, &name, &address, &preset)
}

/// 删除 profile。
pub fn delete(home: &Path, profile_id: &str) -> Result<()> {
    let store = LifeStore::new(home);
    store.delete(profile_id)
}

/// 记忆检索。
pub fn recall_memory(home: &Path, profile_id: &str, query: &str, limit: usize) -> Result<Vec<String>> {
    let store = LifeStore::new(home);
    store.recall(profile_id, query, limit)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
