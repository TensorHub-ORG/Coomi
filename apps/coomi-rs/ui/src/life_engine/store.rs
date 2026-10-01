//! 生命体状态持久化：state.json + memory.jsonl（与 sidecar 格式兼容）。

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use crate::life_engine::{emotion, memory, personality};

const MAX_MEMORY_ITEMS: usize = 5000;
const MAX_TEXT_CHARS: usize = 12000;
const STATE_VERSION: u32 = 2;

pub fn bounded(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn valid_profile_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub struct LifeStore {
    root: PathBuf,
}

impl LifeStore {
    pub fn new(home: &Path) -> Self {
        Self {
            root: home.join("runtime-v2").join("home").join(".coomi").join("life"),
        }
    }

    fn profile_dir(&self, id: &str) -> Result<PathBuf> {
        anyhow::ensure!(valid_profile_id(id), "invalid profile_id");
        let dir = self.root.join(id);
        Ok(dir)
    }

    fn state_path(&self, id: &str) -> Result<PathBuf> {
        Ok(self.profile_dir(id)?.join("state.json"))
    }

    fn memory_path(&self, id: &str) -> Result<PathBuf> {
        Ok(self.profile_dir(id)?.join("memory.jsonl"))
    }

    pub fn load(&self, id: &str) -> Result<Value> {
        let path = self.state_path(id)?;
        anyhow::ensure!(path.is_file(), "profile is not initialized");
        let text = fs::read_to_string(&path).context("read state")?;
        let mut state: Value = serde_json::from_str(&text).context("parse state")?;
        // 迁移 v1 → v2
        if state["version"] == json!(1) {
            state["version"] = json!(STATE_VERSION);
            state["valence"] = state.get("valence").cloned().unwrap_or(json!(0.2));
            state["arousal"] = state.get("arousal").cloned().unwrap_or(json!(0.1));
            state["bond_factors"] = state.get("bond_factors").cloned()
                .unwrap_or(json!({"warmth": 0.0, "reciprocity": 0.0, "history": 0.0}));
            state["agenda"] = state.get("agenda").cloned().unwrap_or(json!([]));
            state["mood_mirror"] = state.get("mood_mirror").cloned()
                .unwrap_or(json!({"valence": 0.0, "arousal": 0.0, "updated_at_ms": 0}));
            state["dream"] = state.get("dream").cloned()
                .unwrap_or(json!({"last_at_ms": 0, "log": []}));
            let _ = self.write_state(&path, &state);
        }
        anyhow::ensure!(state["version"] == json!(STATE_VERSION), "unsupported state version");
        Ok(state)
    }

    fn write_state(&self, path: &Path, state: &Value) -> Result<()> {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p)?;
        }
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(state)?;
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn save(&self, id: &str, state: &Value) -> Result<Value> {
        let mut s = state.clone();
        s["version"] = json!(STATE_VERSION);
        s["updated_at_ms"] = json!(now_ms());
        let path = self.state_path(id)?;
        self.write_state(&path, &s)?;
        Ok(self.public_state(&s))
    }

    pub fn bootstrap(&self, id: &str, name: &str, address: &str, preset: &str) -> Result<Value> {
        let path = self.state_path(id)?;
        if path.is_file() {
            let state = self.load(id)?;
            return Ok(self.public_state(&state));
        }
        let state = default_state(name, address, preset);
        self.save(id, &state)
    }

    pub fn reset(&self, id: &str, name: &str, address: &str, preset: &str) -> Result<Value> {
        let state = default_state(name, address, preset);
        let mem = self.memory_path(id)?;
        let _ = fs::remove_file(&mem);
        self.save(id, &state)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let dir = self.profile_dir(id)?;
        anyhow::ensure!(dir.is_dir(), "profile not found");
        fs::remove_dir_all(&dir)?;
        Ok(())
    }

    pub fn memory_items(&self, id: &str) -> Result<Vec<Value>> {
        let path = self.memory_path(id)?;
        if !path.is_file() {
            return Ok(vec![]);
        }
        let file = fs::File::open(&path)?;
        let reader = BufReader::new(file);
        let mut items = Vec::new();
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            if let Ok(item) = serde_json::from_str::<Value>(&line) {
                let v = item["version"].as_u64().unwrap_or(0);
                if v == 1 || v == STATE_VERSION as u64 {
                    items.push(item);
                }
            }
        }
        let skip = items.len().saturating_sub(MAX_MEMORY_ITEMS);
        Ok(items.into_iter().skip(skip).collect())
    }

    pub fn append_memory(&self, id: &str, user_text: &str, assistant_text: &str) -> Result<()> {
        let path = self.memory_path(id)?;
        if let Some(p) = path.parent() {
            fs::create_dir_all(p)?;
        }
        let mut terms: Vec<String> = memory::tokenize(user_text);
        terms.extend(memory::tokenize(assistant_text));
        terms.sort();
        terms.dedup();
        terms.truncate(120);
        // 自动检测重要性
        let importance = detect_importance(user_text, assistant_text);
        let item = json!({
            "version": STATE_VERSION,
            "at_ms": now_ms(),
            "user": bounded(user_text, 4000),
            "assistant": bounded(assistant_text, 4000),
            "terms": terms,
            "strength": 1.0,
            "importance": importance,
            "forgotten": false,
        });
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&path)?;
        writeln!(file, "{}", serde_json::to_string(&item)?)?;
        // 生命体习惯记忆：检测到明确习惯表述时，单独沉淀为 Habit 记忆（便于长期保持与召回）。
        let _ = self.maybe_extract_habit(id, user_text, assistant_text);
        Ok(())
    }

    /// 从对话中提取习惯（如“我习惯每天早上跑步”），沉淀到 habits.jsonl。
    /// 同一习惯去重：按首句归一化做 key，命中则刷新时间戳而非重复追加。
    fn maybe_extract_habit(&self, id: &str, user_text: &str, assistant_text: &str) -> Result<()> {
        let combined = format!("{user_text} {assistant_text}");
        let habit_keys = ["习惯", "habit", "总是", "经常", "每次", "一直", "always", "usually"];
        if !habit_keys.iter().any(|k| combined.contains(k)) {
            return Ok(());
        }
        let path = self.profile_dir(id)?.join("habits.jsonl");
        if let Some(p) = path.parent() {
            fs::create_dir_all(p)?;
        }
        // 提取习惯描述：取包含习惯关键词的那句（截断到 200 字）。
        let sentence = combined
            .split(['。', '！', '？', '\n', '.', '!', '?'])
            .find(|s| habit_keys.iter().any(|k| s.contains(k)))
            .map(|s| s.trim().to_owned())
            .unwrap_or_else(|| combined.chars().take(200).collect());
        let entry = json!({
            "at_ms": now_ms(),
            "text": bounded(&sentence, 200),
        });
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&path)?;
        writeln!(file, "{}", serde_json::to_string(&entry)?)?;
        Ok(())
    }

    /// forget_pass 改为标记而非删除：
    /// - importance ≥ 0.8 的永不遗忘
    /// - importance < 0.08 保留度的标记为 forgotten（不删除文件）
    pub fn forget_pass(&self, id: &str) -> Result<usize> {
        let path = self.memory_path(id)?;
        if !path.is_file() {
            return Ok(0);
        }
        let now = now_ms();
        let items = self.memory_items(id)?;
        let mut kept = Vec::new();
        let mut dropped = 0;
        for mut item in items {
            // 重要记忆永不遗忘
            let importance = item["importance"].as_f64().unwrap_or(0.5);
            if importance >= 0.8 {
                kept.push(item);
                continue;
            }
            // 已标记遗忘的跳过
            if item["forgotten"].as_bool().unwrap_or(false) {
                continue;
            }
            let at = item["at_ms"].as_u64().unwrap_or(now);
            let age_days = (now.saturating_sub(at) as f64) / 86_400_000.0;
            let strength = item["strength"].as_f64().unwrap_or(1.0);
            let retention = memory::ebbinghaus_retention(age_days, strength);
            if retention < 0.08 {
                // 标记而非删除
                item["forgotten"] = json!(true);
                dropped += 1;
            } else {
                item["strength"] = json!((retention * 10000.0).round() / 10000.0);
            }
            kept.push(item);
        }
        let mut file = fs::File::create(&path)?;
        for item in &kept {
            writeln!(file, "{}", serde_json::to_string(item)?)?;
        }
        Ok(dropped)
    }

    pub fn recall(&self, id: &str, query: &str, limit: usize) -> Result<Vec<String>> {
        let items = self.memory_items(id)?;
        if items.is_empty() {
            return Ok(vec![]);
        }
        let docs: Vec<Vec<String>> = items
            .iter()
            .map(|item| {
                item["terms"]
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                    .unwrap_or_else(|| memory::tokenize(item["user"].as_str().unwrap_or("")))
            })
            .collect();
        let idf = memory::build_idf(&docs);
        let q = memory::tokenize(query);
        let now = now_ms();
        let mut ranked: Vec<(f64, u64, String)> = Vec::new();
        for (item, doc) in items.iter().zip(&docs) {
            let at = item["at_ms"].as_u64().unwrap_or(now);
            let age_days = (now.saturating_sub(at) as f64) / 86_400_000.0;
            let strength = item["strength"].as_f64().unwrap_or(1.0);
            let retention = memory::ebbinghaus_retention(age_days, strength);
            let tfidf = memory::tfidf_score(&q, doc, &idf);
            let score = if q.is_empty() {
                retention * strength
            } else {
                tfidf * retention * strength
            };
            if !q.is_empty() && score <= 0.0 {
                continue;
            }
            let text = format!(
                "User: {}\nResponse: {}",
                bounded(item["user"].as_str().unwrap_or(""), 800),
                bounded(item["assistant"].as_str().unwrap_or(""), 800),
            );
            ranked.push((score, at, text));
        }
        ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(b.1.cmp(&a.1)));
        let take = limit.clamp(1, 20);
        Ok(ranked.into_iter().take(take).map(|(_, _, t)| t).collect())
    }

    /// 获取最近 N 条记忆（原样注入，不走 TF-IDF）。
    /// 这是"同一对话内不丢上下文"的关键。
    pub fn recent_memories(&self, id: &str, limit: usize) -> Result<Vec<String>> {
        let items = self.memory_items(id)?;
        let take = limit.clamp(1, 20);
        let start = items.len().saturating_sub(take);
        Ok(items[start..]
            .iter()
            .filter(|item| !item["forgotten"].as_bool().unwrap_or(false))
            .map(|item| {
                format!(
                    "User: {}\nResponse: {}",
                    bounded(item["user"].as_str().unwrap_or(""), 600),
                    bounded(item["assistant"].as_str().unwrap_or(""), 600),
                )
            })
            .collect())
    }

    /// 获取重要记忆（importance ≥ 0.8）。
    pub fn important_memories(&self, id: &str, limit: usize) -> Result<Vec<String>> {
        let items = self.memory_items(id)?;
        let important: Vec<_> = items
            .iter()
            .filter(|item| {
                item["importance"].as_f64().unwrap_or(0.0) >= 0.8
                    && !item["forgotten"].as_bool().unwrap_or(false)
            })
            .collect();
        let take = limit.clamp(1, 10);
        let start = important.len().saturating_sub(take);
        Ok(important[start..]
            .iter()
            .map(|item| {
                format!(
                    "User: {}\nResponse: {}",
                    bounded(item["user"].as_str().unwrap_or(""), 400),
                    bounded(item["assistant"].as_str().unwrap_or(""), 400),
                )
            })
            .collect())
    }

    pub fn public_state(&self, state: &Value) -> Value {
        let preset_name = state["preset"].as_str().unwrap_or("balanced");
        let personality = personality::preset(preset_name);
        let valence = state["valence"].as_f64().unwrap_or(0.0);
        let arousal = state["arousal"].as_f64().unwrap_or(0.0);
        let emotion_str = state["emotion"].as_str().unwrap_or("");
        let emotion_str = if emotion_str.is_empty() {
            emotion::label(valence, arousal)
        } else {
            emotion_str
        };
        let turns = state["turn_count"].as_u64().unwrap_or(0);
        let bond = state["bond"].as_f64().unwrap_or(0.0);
        let milestone = if turns >= 100 {
            format!("已陪伴 {turns} 轮，羁绊 {:.0}%，越来越懂你了。", bond * 100.0)
        } else if turns >= 30 {
            format!("一起走过了 {turns} 轮对话，羁绊 {:.0}%。", bond * 100.0)
        } else if turns >= 10 {
            format!("第 {turns} 轮了，默契在慢慢建立。")
        } else {
            String::new()
        };
        json!({
            "version": STATE_VERSION,
            "name": bounded(state["name"].as_str().unwrap_or("Coomi Life"), 48),
            "address": bounded(state["address"].as_str().unwrap_or("你"), 48),
            "preset": preset_name,
            "personality": personality,
            "paused": state["paused"].as_bool().unwrap_or(false),
            "emotion": emotion_str,
            "valence": valence,
            "arousal": arousal,
            "dominance": state["dominance"].as_f64().unwrap_or(0.0),
            "attention": state["attention"].as_str().unwrap_or("user"),
            "bond": bond,
            "bond_factors": state.get("bond_factors").cloned().unwrap_or(json!({})),
            "needs": state.get("needs").cloned().unwrap_or(json!({})),
            "agenda": state.get("agenda").cloned().unwrap_or(json!([])),
            "mood_mirror": state.get("mood_mirror").cloned().unwrap_or(json!({})),
            "dream": state.get("dream").cloned().unwrap_or(json!({})),
            "milestone": milestone,
            "memory_count": state["memory_count"].as_u64().unwrap_or(0),
            "turn_count": turns,
            "heartbeat": state.get("heartbeat").cloned().unwrap_or(json!({
                "dailyBudget": 5,
                "quietHours": [23, 8],
                "lastActiveMs": 0,
                "usedToday": 0,
                "dayKey": "",
            })),
            "updated_at_ms": state["updated_at_ms"].as_u64().unwrap_or(0),
        })
    }

    // ── PAD 三维情感 ────────────────────────────────────────

    /// 读取 PAD 情感状态。
    pub fn load_pad(&self, id: &str) -> Result<(f64, f64, f64)> {
        let state = self.load(id)?;
        let pleasure = state["valence"].as_f64().unwrap_or(0.0);
        let arousal = state["arousal"].as_f64().unwrap_or(0.0);
        let dominance = state["dominance"].as_f64().unwrap_or(0.0);
        Ok((pleasure, arousal, dominance))
    }

    /// 更新 PAD 情感状态。
    pub fn save_pad(&self, id: &str, pleasure: f64, arousal: f64, dominance: f64) -> Result<()> {
        let mut state = self.load(id)?;
        state["valence"] = json!(pleasure.clamp(-1.0, 1.0));
        state["arousal"] = json!(arousal.clamp(-1.0, 1.0));
        state["dominance"] = json!(dominance.clamp(-1.0, 1.0));
        // 同步更新情绪标签
        state["emotion"] = json!(emotion::label(pleasure, arousal));
        self.save(id, &state)?;
        Ok(())
    }

    // ── 主动心跳 ────────────────────────────────────────────

    /// 检查是否允许主动发言（预算 + 静默时段）。
    pub fn can_heartbeat(&self, id: &str) -> Result<bool> {
        let state = self.load(id)?;
        let hb = &state["heartbeat"];
        let daily_budget = hb["dailyBudget"].as_u64().unwrap_or(5);
        let used_today = hb["usedToday"].as_u64().unwrap_or(0);
        let last_active = hb["lastActiveMs"].as_u64().unwrap_or(0);
        let day_key = hb["dayKey"].as_str().unwrap_or("");

        // 跨天重置
        let now = now_ms();
        let today = format_timestamp_day(now);
        if day_key != today {
            return Ok(true); // 新的一天，重置后允许
        }

        // 预算检查
        if used_today >= daily_budget {
            return Ok(false);
        }

        // 静默时段检查（quiet_hours: [start_hour, end_hour]）
        let quiet = hb["quietHours"].as_array();
        if let Some(hours) = quiet {
            if hours.len() == 2 {
                let start = hours[0].as_u64().unwrap_or(23);
                let end = hours[1].as_u64().unwrap_or(8);
                let hour = ((now / 3_600_000) % 24) as u64;
                let in_quiet = if start > end {
                    hour >= start || hour < end
                } else {
                    hour >= start && hour < end
                };
                if in_quiet {
                    return Ok(false);
                }
            }
        }

        // 最小间隔 10 分钟
        if now.saturating_sub(last_active) < 10 * 60 * 1000 {
            return Ok(false);
        }

        Ok(true)
    }

    /// 记录一次主动发言。
    pub fn record_heartbeat(&self, id: &str) -> Result<()> {
        let mut state = self.load(id)?;
        let now = now_ms();
        let today = format_timestamp_day(now);
        let hb = &mut state["heartbeat"];
        if hb["dayKey"].as_str().unwrap_or("") != today {
            hb["dayKey"] = json!(today);
            hb["usedToday"] = json!(0);
        }
        hb["usedToday"] = json!(hb["usedToday"].as_u64().unwrap_or(0) + 1);
        hb["lastActiveMs"] = json!(now);
        self.save(id, &state)?;
        Ok(())
    }

    // ── 命名空间记忆（群/单聊）───────────────────────────────

    /// 读取命名空间记忆文件（JSONL 格式）。
    pub fn load_ns_memory(&self, ns_path: &Path) -> Result<Vec<memory::MemoryEntry>> {
        if !ns_path.is_file() {
            return Ok(vec![]);
        }
        let file = fs::File::open(ns_path)?;
        let reader = BufReader::new(file);
        let mut entries = Vec::new();
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            if let Ok(entry) = serde_json::from_str::<memory::MemoryEntry>(&line) {
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    /// 追加一条命名空间记忆。
    pub fn append_ns_memory(
        &self,
        ns_path: &Path,
        entry: &memory::MemoryEntry,
    ) -> Result<()> {
        if let Some(p) = ns_path.parent() {
            fs::create_dir_all(p)?;
        }
        let mut file = fs::OpenOptions::new().create(true).append(true).open(ns_path)?;
        writeln!(file, "{}", serde_json::to_string(entry)?)?;
        Ok(())
    }

    /// 清理低保留度的命名空间记忆。
    pub fn prune_ns_memory(&self, ns_path: &Path, min_retention: f64) -> Result<usize> {
        let entries = self.load_ns_memory(ns_path)?;
        let (kept, dropped): (Vec<_>, Vec<_>) = entries
            .into_iter()
            .partition(|e| e.retention() >= min_retention);
        if dropped.is_empty() {
            return Ok(0);
        }
        let mut file = fs::File::create(ns_path)?;
        for entry in &kept {
            writeln!(file, "{}", serde_json::to_string(entry)?)?;
        }
        Ok(dropped.len())
    }

    /// bond 里程碑检测：bond 跨过阈值（0.2/0.4/0.6/0.8）时，写一条关系里程碑到 milestones.jsonl。
    /// 返回当前 bond 是否刚跨过阈值（供调用方决定是否提示）。
    pub fn maybe_bond_milestone(&self, id: &str, bond: f64, old_bond: f64) -> Option<String> {
        const THRESHOLDS: [(f64, &str); 4] = [
            (0.2, "初识：你们开始互相了解，它记得你的喜好了。"),
            (0.4, "熟络：它会在意你的状态，主动关心你的近况。"),
            (0.6, "亲密：你们有了共同的回忆，它把你当作特别的人。"),
            (0.8, "羁绊：它信任你，愿意为你做更多。"),
        ];
        for (threshold, text) in THRESHOLDS {
            if bond >= threshold && old_bond < threshold {
                let path = match self.profile_dir(id) {
                    Ok(dir) => dir.join("milestones.jsonl"),
                    Err(_) => return None,
                };
                if let Some(p) = path.parent() {
                    let _ = fs::create_dir_all(p);
                }
                let entry = json!({
                    "at_ms": now_ms(),
                    "bond": (bond * 10000.0).round() / 10000.0,
                    "text": text,
                });
                if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
                    use std::io::Write as _;
                    let _ = writeln!(file, "{}", serde_json::to_string(&entry).unwrap_or_default());
                }
                return Some(text.to_owned());
            }
        }
        None
    }

    /// 列出该生命体沉淀的习惯（habits.jsonl），供记忆召回 / before_turn 注入。
    pub fn list_habits(&self, id: &str) -> Vec<Value> {
        let path = match self.profile_dir(id) {
            Ok(dir) => dir.join("habits.jsonl"),
            Err(_) => return Vec::new(),
        };
        if !path.is_file() {
            return Vec::new();
        }
        let mut habits = Vec::new();
        if let Ok(text) = fs::read_to_string(&path) {
            for line in text.lines().rev() {
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    habits.push(value);
                    if habits.len() >= 32 {
                        break;
                    }
                }
            }
        }
        habits.reverse();
        habits
    }
}

/// 自动检测对话重要性。
/// - 用户明确说"记住"→ 1.0
/// - 涉及偏好/习惯/重要事件 → 0.8
/// - 涉及情感/承诺 → 0.6
/// - 普通对话 → 0.3
fn detect_importance(user_text: &str, assistant_text: &str) -> f64 {
    let combined = format!("{} {}", user_text, assistant_text).to_lowercase();

    // 用户明确要求记住
    let remember_keys = ["记住", "别忘了", "remember", "重要", "关键"];
    if remember_keys.iter().any(|k| combined.contains(k)) {
        return 1.0;
    }

    // 偏好/习惯/重要事件
    let preference_keys = [
        "喜欢", "讨厌", "偏好", "习惯", "最爱", "不喜欢",
        "生日", "纪念日", "节日", "考试", "面试", "重要",
        "喜欢的", "常用的", "经常", "总是", "每次",
    ];
    if preference_keys.iter().any(|k| combined.contains(k)) {
        return 0.8;
    }

    // 情感/承诺
    let emotion_keys = ["答应", "承诺", "保证", "一定", "永远", "感谢", "对不起", "抱歉"];
    if emotion_keys.iter().any(|k| combined.contains(k)) {
        return 0.6;
    }

    // 长消息（更可能包含有意义的内容）
    if user_text.len() > 200 {
        return 0.5;
    }

    0.3
}

/// 格式化时间戳为日期字符串（YYYY-MM-DD）。
fn format_timestamp_day(ms: u64) -> String {
    let secs = ms / 1000;
    let days = secs / 86400;
    // 简化：直接用毫秒计算（不需要精确时区）
    let epoch_days = days as i64;
    let year = 1970 + epoch_days / 365;
    let day_of_year = epoch_days % 365;
    let month = (day_of_year / 30 + 1).min(12);
    let day = (day_of_year % 30 + 1).min(31);
    format!("{:04}-{:02}-{:02}", year, month, day)
}

fn default_state(name: &str, address: &str, preset: &str) -> Value {
    let preset = if personality::is_valid(preset) { preset } else { "balanced" };
    let name = if name.is_empty() { "Coomi Life".to_owned() } else { bounded(name, 48) };
    let address = if address.is_empty() { "你".to_owned() } else { bounded(address, 48) };
    json!({
        "version": STATE_VERSION,
        "name": name,
        "address": address,
        "preset": preset,
        "paused": false,
        "valence": 0.2,
        "arousal": 0.1,
        "dominance": 0.0,
        "emotion": "neutral",
        "attention": "user",
        "needs": {
            "competence": 0.5, "relatedness": 0.5, "growth": 0.5,
            "certainty": 0.5, "autonomy": 0.5,
        },
        "bond": 0.0,
        "bond_factors": {"warmth": 0.0, "reciprocity": 0.0, "history": 0.0},
        "personality": personality::preset(preset),
        "memory_count": 0,
        "turn_count": 0,
        "agenda": [],
        "mood_mirror": {"valence": 0.0, "arousal": 0.0, "updated_at_ms": 0},
        "dream": {"last_at_ms": 0, "log": []},
        "heartbeat": {
            "dailyBudget": 5,
            "quietHours": [23, 8],
            "lastActiveMs": 0,
            "usedToday": 0,
            "dayKey": "",
        },
        "updated_at_ms": now_ms(),
    })
}
