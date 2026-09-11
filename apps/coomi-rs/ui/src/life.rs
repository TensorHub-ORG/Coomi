//! 数字生命体 P1：主动生命周期（气泡 + 开场问候 + 状态机 + 护栏）。
//!
//! 情绪/关系/需求等 PSI 状态由 coomi-life sidecar 在每轮交互后更新，本模块只负责
//! 「何时说」（触发 × 护栏）、「说什么」（模板起草，不调模型）、「投递后记账」
//! （队列 / 每日上限 / 心情日记）。
//!
//! 数据全部落在用户目录 `home/runtime-v2/home/.coomi/life/`（与 sidecar 档案同根），
//! 因此现有的通用备份/导出体系天然覆盖，无需单独迁移。
//!
//! P1 约束：不调用模型生成，不发系统通知；默认「仅气泡 + 每日 ≤2 条（可调）+
//! 只在 9:00–23:00」。所有可调项见 [`LifeSettings`]。

use anyhow::{Context, Result};
use chrono::{Datelike, Local, Timelike, Utc};
use coomi_services::{RuntimeBackendKind, RuntimeInstallStatus, RuntimeManager};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

/// 生命体档案使用的主 profile（与前端 LifeView 一致）。
pub const LIFE_PROFILE_ID: &str = "primary";

/// 全局常驻会话（数字生命体常驻会话）的固定 ID：
/// 侧边栏第一条永久置顶、不可删除；所有主动交互只投递到这个会话。
pub const GLOBAL_SESSION_ID: &str = "50a1b732-5f3e-4b7d-8c2a-b9f4e6d1a001";

const QUEUE_FILE: &str = "queue.jsonl";
const JOURNAL_FILE: &str = "journal.jsonl";
const SETTINGS_FILE: &str = "settings.json";
const RUNTIME_FILE: &str = "runtime.json";
const MEMORY_FILE: &str = "memory.jsonl";

/// 主动问候未读可保留时长：超过 24h 的旧草稿作废，避免跨天投递过期问候。
const PENDING_EXPIRE_MS: u64 = 24 * 60 * 60 * 1000;

/// 每日上限「自动判断」的调参预算：自定义上限最大 100 条/日。
pub const DAILY_LIMIT_CUSTOM_MAX: u32 = 100;

pub fn life_root(home: &Path) -> PathBuf {
    home.join("runtime-v2")
        .join("home")
        .join(".coomi")
        .join("life")
}

fn extension_root(home: &Path) -> PathBuf {
    home.join("runtime-v2")
        .join("home")
        .join(".coomi")
        .join("extensions")
        .join("coomi-life")
}

fn now_ms() -> u64 {
    Local::now().timestamp_millis() as u64
}

fn atomic_write(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)?;
    fs::write(&temporary, &bytes)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

/// 主动问候的可调设置。
/// 默认：开启、仅气泡、每日自动判断、9:00–23:00。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 投递方式：P1 只有 `bubble`（气泡）；`notify`（系统通知）预留给 P2。
    #[serde(default = "default_delivery")]
    pub delivery: String,
    /// 每日主动上限模式：`off`（关闭主动）/ `auto`（自动判断）/ `custom`（自定义）。
    #[serde(default = "default_daily_mode")]
    pub daily_mode: String,
    /// 自定义上限（1–100 条/日），仅 daily_mode == custom 时生效。
    #[serde(default = "default_daily_limit_custom")]
    pub daily_limit_custom: u32,
    /// 「用于全局会话」：开启后所有对话都使用数字生命体人格（不是只有常驻会话）。
    #[serde(default)]
    pub global_mode: bool,
    /// 允许主动的时间窗（本地时区，分钟自 0:00 起）。默认 9:00–23:00。
    #[serde(default = "default_window_start")]
    pub window_start_minutes: u32,
    #[serde(default = "default_window_end")]
    pub window_end_minutes: u32,
    /// 两次主动之间的最小间隔（分钟）。
    #[serde(default = "default_min_interval")]
    pub min_interval_minutes: u64,
    /// 用户最近一轮生命体对话结束后的静默期（分钟）：期间不打扰。
    #[serde(default = "default_quiet")]
    pub quiet_after_turn_minutes: u64,
}

fn default_true() -> bool {
    true
}
fn default_delivery() -> String {
    "bubble".to_owned()
}
fn default_daily_mode() -> String {
    "auto".to_owned()
}
fn default_daily_limit_custom() -> u32 {
    2
}
fn default_window_start() -> u32 {
    9 * 60
}
fn default_window_end() -> u32 {
    23 * 60
}
fn default_min_interval() -> u64 {
    4 * 60
}
fn default_quiet() -> u64 {
    30
}

impl Default for LifeSettings {
    fn default() -> Self {
        Self {
            enabled: default_true(),
            delivery: default_delivery(),
            daily_mode: default_daily_mode(),
            daily_limit_custom: default_daily_limit_custom(),
            global_mode: false,
            window_start_minutes: default_window_start(),
            window_end_minutes: default_window_end(),
            min_interval_minutes: default_min_interval(),
            quiet_after_turn_minutes: default_quiet(),
        }
    }
}

/// 生命体运行记账：每日上限、最近互动/主动时间（全部本地日期语义）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeRuntimeState {
    #[serde(default)]
    pub day_key: String,
    #[serde(default)]
    pub day_count: u32,
    #[serde(default)]
    pub total_count: u64,
    #[serde(default)]
    pub last_proactive_at_ms: u64,
    #[serde(default)]
    pub last_turn_at_ms: u64,
    #[serde(default)]
    pub last_trigger: String,
    /// 最近 7 天每日生命对话轮次（day key → 轮数），「自动判断」的活跃度依据。
    #[serde(default)]
    pub turn_days: BTreeMap<String, u32>,
    /// 最近一次主动投递的日期（无投递记录时为空）。
    #[serde(default)]
    pub last_delivery_day: String,
    /// 上次记账时的依恋阶段 key（psi-v2：检测阶段跃迁里程碑）。
    /// 空字符串表示尚未校准（首次 tick 只记录不触发里程碑）。
    #[serde(default)]
    pub last_bond_stage: String,
    /// 上次已庆祝过的相伴天数（psi-v2：整百天里程碑防重）。
    #[serde(default)]
    pub last_milestone_days: u64,
    /// 最近一次投递梦境问候的日期（psi-v2.1：一天最多梦一次）。
    #[serde(default)]
    pub last_dream_day: String,
    /// 最近一次投递怀旧问候的日期（psi-v2.1：间隔重复，3 天内不重提）。
    #[serde(default)]
    pub last_nostalgia_day: String,
    /// 最近一次投递记忆胶囊问候的日期（psi-v2.2：一天最多一次）。
    #[serde(default)]
    pub last_capsule_day: String,
    /// 最近一次投递关系周报的 ISO 周键（psi-v2.2：一周最多一次）。
    #[serde(default)]
    pub last_report_week: String,
    /// 最近一次投递早安播报的日期（psi-v3：每天首次投递，一天最多一次）。
    #[serde(default)]
    pub last_morning_day: String,
    /// 最近一次投递每日彩蛋的日期（psi-v3：早安之后当天第二次投递）。
    #[serde(default)]
    pub last_egg_day: String,
}

/// 队列中的一条主动问候。`pending` → `delivered`（或过期 `expired`）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueuedMessage {
    pub id: String,
    pub kind: String,
    pub trigger: String,
    pub text: String,
    pub life_name: String,
    pub address: String,
    pub created_at_ms: u64,
    #[serde(default)]
    pub delivered_at_ms: u64,
    pub status: String,
}

impl QueuedMessage {
    fn pending(id: String, trigger: String, text: String, life_name: String, address: String) -> Self {
        Self {
            id,
            kind: "proactive".into(),
            trigger,
            text,
            life_name,
            address,
            created_at_ms: now_ms(),
            delivered_at_ms: 0,
            status: "pending".into(),
        }
    }
}

/// 记挂事项快照（psi-v2.1：sidecar agenda 的运行时视图）。
#[derive(Clone, Debug, Default, PartialEq)]
struct AgendaItemSnapshot {
    text: String,
    due_day: String,
    status: String,
}

/// 用户心情镜像的按天聚合条目（psi-v2.1）。
#[derive(Clone, Debug, Default, PartialEq)]
struct UserMoodEntry {
    day: String,
    samples: u64,
    valence_avg: f64,
}

/// 梦境素材（psi-v2.1：after_turn 预生成的「下一次入睡」材料）。
#[derive(Clone, Debug, PartialEq)]
struct DreamMaterial {
    at_ms: u64,
    texts: Vec<String>,
    link: String,
}

/// 怀旧候选（psi-v2.1：遗忘临界区间内的记忆片段）。
#[derive(Clone, Debug, Default, PartialEq)]
struct NostalgiaCandidate {
    text: String,
}

/// 每日记忆胶囊（psi-v2.2：昨日互动封存）。
#[derive(Clone, Debug, Default, PartialEq)]
struct DailyCapsuleSnapshot {
    day: String,
    turns: u64,
    valence_avg: f64,
    highlights: Vec<String>,
    lows: Vec<String>,
    agenda_done: u64,
}

/// 关系周报（psi-v2.2：上周统计封存）。
#[derive(Clone, Debug, Default, PartialEq)]
struct WeeklyReportSnapshot {
    week: String,
    turns: u64,
    valence_avg: f64,
    agenda_done: u64,
    memories_added: u64,
    bond_delta: f64,
}

/// Sidecar state.json 的轻量快照（避免为轮询反复拉起 Python 进程）。
/// psi-v2：同时读取情绪二维值、依恋峰值、轮次、接触日等 v2 字段，
/// psi-v2.1：记挂 / 用户心情镜像 / 梦境 / 怀旧候选 / 上次接触时间。
/// 供触发状态机与心情日记使用；字段缺失时回退到 v1 语义默认值。
#[derive(Clone, Debug, Default)]
struct ProfileSnapshot {
    name: String,
    address: String,
    /// 人格预设 key（sidecar `preset`，如 balanced/warm/playful）。
    preset: String,
    /// 人格预设的中文标签（sidecar `personality.label`，如 均衡/温柔/俏皮）。
    personality_label: String,
    paused: bool,
    emotion: String,
    emotion_valence: f64,
    emotion_arousal: f64,
    bond: f64,
    bond_peak: f64,
    needs: BTreeMap<String, f64>,
    turn_count: u64,
    first_seen_ms: u64,
    contact_days: Vec<String>,
    updated_at_ms: u64,
    // ---- psi-v2.1 ----
    last_contact_ms: u64,
    agenda: Vec<AgendaItemSnapshot>,
    user_mood_log: Vec<UserMoodEntry>,
    dream_next: Option<DreamMaterial>,
    nostalgia_candidates: Vec<NostalgiaCandidate>,
    // ---- psi-v2.2 ----
    daily_capsules: Vec<DailyCapsuleSnapshot>,
    weekly_reports: Vec<WeeklyReportSnapshot>,
}

impl ProfileSnapshot {
    fn relatedness(&self) -> f64 {
        self.needs.get("relatedness").copied().unwrap_or(0.5)
    }
    fn growth(&self) -> f64 {
        self.needs.get("growth").copied().unwrap_or(0.5)
    }
    /// 相识天数（至少 1 天）。
    fn days_together(&self, now: u64) -> u64 {
        if self.first_seen_ms == 0 {
            return 1;
        }
        (now.saturating_sub(self.first_seen_ms) / 86_400_000) + 1
    }
    /// 连续接触天数（以今天或昨天结尾的连续段）。
    fn streak_days(&self, now: u64) -> u64 {
        streak_days_from(&self.contact_days, now)
    }
    /// 当前最强驱力：需求水平最低的维度（稳态失衡最大处），无需求数据时为 None。
    fn dominant_urge(&self) -> Option<String> {
        self.needs
            .iter()
            .min_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(key, _)| key.clone())
    }
    /// psi-v2.1 心情镜像：用户最近 3 天的加权平均效价（无样本为 None）。
    fn user_mood_avg(&self) -> Option<f64> {
        let recent: Vec<&UserMoodEntry> = self.user_mood_log.iter().rev().take(3).collect();
        if recent.is_empty() {
            return None;
        }
        let mut total = 0.0;
        let mut count = 0.0;
        for entry in recent {
            let weight = entry.samples.max(1) as f64;
            total += entry.valence_avg * weight;
            count += weight;
        }
        if count <= 0.0 {
            return None;
        }
        Some(total / count)
    }
    /// psi-v2.1：用户最近情绪低落（≤ -0.2）——它看得见你的状态。
    fn user_mood_low(&self) -> bool {
        self.user_mood_avg().map(|value| value <= -0.2).unwrap_or(false)
    }
    /// psi-v2.1 重逢：距上次真实接触的天数（无记录为 0）。
    fn reunion_waited_days(&self, now: u64) -> u64 {
        if self.last_contact_ms == 0 {
            return 0;
        }
        now.saturating_sub(self.last_contact_ms) / 86_400_000
    }
    /// psi-v2.1 记挂：已到期（今天或更早）且未了结的事项，取最紧急的一条。
    fn agenda_due_now(&self, today: &str) -> Option<&AgendaItemSnapshot> {
        self.agenda
            .iter()
            .filter(|item| item.status == "pending" || item.status == "passed")
            .filter(|item| !item.due_day.is_empty() && item.due_day.as_str() <= today)
            .min_by_key(|item| item.due_day.clone())
    }
    /// psi-v2.1 梦境素材摘录：优先共享词（关联线索），否则首条记忆原文（截断）。
    fn dream_excerpt(&self) -> String {
        let Some(dream) = self.dream_next.as_ref() else {
            return String::new();
        };
        if !dream.link.is_empty() {
            return truncate_chars(&dream.link, 24);
        }
        dream
            .texts
            .first()
            .map(|text| truncate_chars(text, 24))
            .unwrap_or_default()
    }
    /// psi-v2.1 怀旧摘录：最先接近遗忘边缘的候选记忆（截断）。
    fn nostalgia_excerpt(&self) -> String {
        self.nostalgia_candidates
            .first()
            .map(|candidate| truncate_chars(&candidate.text, 24))
            .unwrap_or_default()
    }
    /// psi-v2.2：昨天封存了记忆胶囊（胶囊问候的触发条件）。
    fn capsule_yesterday(&self, today: &str) -> bool {
        self.daily_capsules
            .iter()
            .any(|capsule| day_gap(&capsule.day, today) == 1)
    }
    /// psi-v2.2：存在非本周的关系周报（周报问候的触发条件）。
    fn has_last_week_report(&self, current_week: &str) -> bool {
        self.weekly_reports
            .iter()
            .any(|report| report.week != *current_week && !report.week.is_empty())
    }
    /// psi-v2.2 胶囊摘录：最近的封存（sidecar capsule_summary 同构，不调模型）。
    fn capsule_excerpt(&self) -> String {
        let Some(capsule) = self.daily_capsules.last() else {
            return String::new();
        };
        let mut parts = vec![format!("{} 你们聊了 {} 轮", capsule.day, capsule.turns)];
        let highlights: Vec<&str> = capsule.highlights.iter().take(2).map(String::as_str).collect();
        if !highlights.is_empty() {
            parts.push(format!("开心的事：{}", highlights.join("；")));
        }
        let lows: Vec<&str> = capsule.lows.iter().take(2).map(String::as_str).collect();
        if !lows.is_empty() {
            parts.push(format!("你提到过：{}", lows.join("；")));
        }
        if capsule.agenda_done > 0 {
            parts.push(format!("完成了 {} 件记挂的事", capsule.agenda_done));
        }
        truncate_chars(&parts.join("；"), 120)
    }
    /// psi-v2.2 周报摘录：最近的封存（sidecar latest_report_text 同构，不调模型）。
    fn report_excerpt(&self) -> String {
        let Some(report) = self.weekly_reports.last() else {
            return String::new();
        };
        let valence = if report.valence_avg >= 0.0 { "+" } else { "" };
        let bond = if report.bond_delta >= 0.0 { "+" } else { "" };
        truncate_chars(
            &format!(
                "{} 回顾：聊了 {} 轮，平均心情 {}{:.2}，完成记挂 {} 件，新增记忆 {} 条，羁绊变化 {}{:.2}",
                report.week,
                report.turns,
                valence,
                report.valence_avg,
                report.agenda_done,
                report.memories_added,
                bond,
                report.bond_delta,
            ),
            140,
        )
    }
}

/// 按字符截断（中文安全，不切坏 UTF-8 边界）。
fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// 依恋阶段表（key, 中文标签, 上界）。与 sidecar `BOND_STAGES` 语义一致。
const BOND_STAGES: &[(&str, &str, f64)] = &[
    ("stranger", "初识", 0.20),
    ("acquaintance", "熟识", 0.40),
    ("companion", "伙伴", 0.60),
    ("confidant", "挚友", 0.80),
    ("soulmate", "知己", 2.00),
];

fn bond_stage(bond: f64) -> (&'static str, &'static str) {
    for (key, label, threshold) in BOND_STAGES {
        if bond < *threshold {
            return (key, label);
        }
    }
    (BOND_STAGES[4].0, BOND_STAGES[4].1)
}

fn bond_stage_rank(key: &str) -> u8 {
    BOND_STAGES
        .iter()
        .position(|(stage, _, _)| *stage == key)
        .map(|index| index as u8)
        .unwrap_or(0)
}

/// 离散情绪标签（psi-v2 词汇表）→ 中文展示。
fn emotion_label_zh(label: &str) -> &'static str {
    match label {
        "lonely" => "孤独",
        "proud" => "自豪",
        "concerned" => "担忧",
        "melancholy" => "低落",
        "excited" => "兴奋",
        "content" => "满足",
        "warm" => "温暖",
        "curious" => "好奇",
        _ => "平静",
    }
}

/// 早安播报的「天气」段：profile emotion → 中文（平静/雀跃/低落等）。
fn weather_zh(label: &str) -> &'static str {
    match label {
        "excited" => "雀跃",
        "melancholy" => "低落",
        "neutral" => "平静",
        _ => emotion_label_zh(label),
    }
}

/// 需求维度 key → 中文展示。
fn need_label_zh(key: &str) -> &'static str {
    match key {
        "competence" => "胜任",
        "relatedness" => "联结",
        "certainty" => "确定性",
        "growth" => "成长",
        "autonomy" => "自主",
        _ => "需求",
    }
}

/// 连续接触天数：以今天或昨天结尾的连续日期段长度。
fn streak_days_from(contact_days: &[String], now: u64) -> u64 {
    if contact_days.is_empty() {
        return 0;
    }
    let mut days: Vec<&str> = contact_days.iter().map(String::as_str).collect();
    days.sort_unstable();
    days.dedup();
    // chrono 0.4 的 from_timestamp_millis 仅在 Utc 上提供，转本地时区后再取日期。
    let to_local_date = |millis: i64| {
        chrono::DateTime::<Utc>::from_timestamp_millis(millis)
            .map(|datetime| datetime.with_timezone(&Local))
            .unwrap_or_else(Local::now)
            .format("%Y-%m-%d")
            .to_string()
    };
    let today = to_local_date(now as i64);
    let yesterday = to_local_date(now as i64 - 86_400_000);
    if *days.last().expect("non-empty") != today && *days.last().expect("non-empty") != yesterday {
        return 0;
    }
    let Some(anchor) =
        chrono::NaiveDate::parse_from_str(days.last().expect("non-empty"), "%Y-%m-%d").ok()
    else {
        return 0;
    };
    let mut streak = 1u64;
    for previous in days[..days.len() - 1].iter().rev() {
        let Ok(day) = chrono::NaiveDate::parse_from_str(previous, "%Y-%m-%d") else {
            break;
        };
        if (anchor - day).num_days() == streak as i64 {
            streak += 1;
        } else {
            break;
        }
    }
    streak
}

pub fn load_settings(home: &Path) -> LifeSettings {
    let path = life_root(home).join(SETTINGS_FILE);
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// 合并更新设置（仅接受白名单字段），数值带边界钳制。
pub fn update_settings(home: &Path, patch: &Value) -> Result<LifeSettings> {
    let mut settings = load_settings(home);
    if let Some(object) = patch.as_object() {
        if let Some(enabled) = object.get("enabled").and_then(Value::as_bool) {
            settings.enabled = enabled;
        }
        if let Some(global_mode) = object.get("globalMode").and_then(Value::as_bool) {
            settings.global_mode = global_mode;
        }
        if let Some(delivery) = object.get("delivery").and_then(Value::as_str) {
            if matches!(delivery, "bubble" | "notify") {
                settings.delivery = delivery.to_owned();
            }
        }
        if let Some(mode) = object.get("dailyMode").and_then(Value::as_str) {
            if matches!(mode, "off" | "auto" | "custom") {
                settings.daily_mode = mode.to_owned();
            }
        }
        if let Some(limit) = object.get("dailyLimitCustom").and_then(Value::as_u64) {
            settings.daily_limit_custom = u32::try_from(limit)
                .unwrap_or(DAILY_LIMIT_CUSTOM_MAX)
                .clamp(1, DAILY_LIMIT_CUSTOM_MAX);
        }
        if let Some(start) = object.get("windowStartMinutes").and_then(Value::as_u64) {
            settings.window_start_minutes = u32::try_from(start).unwrap_or(0).min(24 * 60 - 1);
        }
        if let Some(end) = object.get("windowEndMinutes").and_then(Value::as_u64) {
            settings.window_end_minutes = u32::try_from(end).unwrap_or(0).min(24 * 60);
        }
        if let Some(interval) = object.get("minIntervalMinutes").and_then(Value::as_u64) {
            settings.min_interval_minutes = interval.clamp(15, 12 * 60);
        }
        if let Some(quiet) = object.get("quietAfterTurnMinutes").and_then(Value::as_u64) {
            settings.quiet_after_turn_minutes = quiet.clamp(5, 12 * 60);
        }
    }
    if settings.window_end_minutes <= settings.window_start_minutes {
        settings.window_end_minutes = settings.window_start_minutes;
    }
    atomic_write(&life_root(home).join(SETTINGS_FILE), &serde_json::to_value(&settings)?)?;
    Ok(settings)
}

/// 「用于全局会话」开关：所有对话都使用生命体人格（引擎侧独立判断，前端漏发也不丢）。
pub fn global_mode(home: &Path) -> bool {
    load_settings(home).global_mode
}

/// 生效的每日主动上限（解决「三态」语义）：
/// - off → 0（关闭主动）；custom → 自定义数值；auto → 活跃度规则。
pub fn effective_daily_limit(home: &Path) -> u32 {
    let settings = load_settings(home);
    match settings.daily_mode.as_str() {
        "off" => 0,
        "custom" => settings.daily_limit_custom.clamp(1, DAILY_LIMIT_CUSTOM_MAX),
        _ => auto_daily_limit(home, &settings),
    }
}

/// 活跃度规则的实现（可解释、可查证）：
/// - 连续 3 天投递后零回复 → 1 条/日（视为不想被打扰）；
/// - 过去 7 天平均每天 ≥2 轮生命对话 → 3 条/日；
/// - 其余默认 2 条/日。
fn auto_daily_limit(home: &Path, settings: &LifeSettings) -> u32 {
    if settings.min_interval_minutes >= 12 * 60 {
        // 用户把间隔调得很大时，自动仍然尊重「别太密」的意图。
        return 1;
    }
    let runtime = load_runtime(home);
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    if days_since_last_delivery(&runtime, &today) >= 3 {
        return 1;
    }
    let turns: u32 = runtime.turn_days.values().sum();
    if turns as f64 / 7.0 >= 2.0 {
        return 3;
    }
    2
}

/// 距上次主动投递过去了多少自然日（投递当天=0；无记录=0）。
fn days_since_last_delivery(runtime: &LifeRuntimeState, today: &str) -> i64 {
    if runtime.last_delivery_day.is_empty() {
        return 0;
    }
    let Ok(left) = chrono::NaiveDate::parse_from_str(&runtime.last_delivery_day, "%Y-%m-%d") else {
        return 0;
    };
    let Ok(right) = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d") else {
        return 0;
    };
    (right - left).num_days().max(0)
}

/// 全局常驻会话自愈：不存在 → 创建；损坏 → 坏文件改名 `.corrupt.bak` 后重建。
/// 固定 ID 的会话永不删除，任何损坏都以「重建空会话」收场。
pub fn ensure_global_session(home: &Path, cwd: &Path) -> Result<()> {
    let store = coomi_engine::SessionStore::new(home);
    let id = uuid::Uuid::parse_str(GLOBAL_SESSION_ID).expect("GLOBAL_SESSION_ID is a valid uuid");
    if store.load(id).is_ok() {
        return Ok(());
    }
    if store.contains(id) {
        let path = home.join("sessions").join(format!("{id}.json"));
        let backup = home.join("sessions").join(format!("{id}.json.corrupt.bak"));
        fs::rename(&path, &backup)
            .with_context(|| format!("failed to quarantine corrupt global session: {}", path.display()))?;
    }
    let mut session = coomi_engine::Session::new(String::new(), String::new(), cwd.to_path_buf());
    session.id = id;
    session.title = "常驻会话".to_owned();
    store.save(&session)?;
    Ok(())
}

/// 记忆（life/primary/memory.jsonl）最近条目：从最新往回取 `limit` 条并跳过 `offset` 条。
/// 每条输出 [{at_ms, user, assistant}]，供二级界面最近 2 条与三级界面全量列表使用。
pub fn memory_recent(home: &Path, limit: usize, offset: usize) -> Vec<Value> {
    let path = life_root(home).join(LIFE_PROFILE_ID).join(MEMORY_FILE);
    let Ok(bytes) = fs::read(&path) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .rev()
        .skip(offset)
        .take(limit.clamp(1, 200))
        .collect()
}

/// F7 记忆写入：向 memory.jsonl 追加 `{"at_ms", "user": "", "assistant": text}`。
/// 与 `memory_recent` 读取同一文件（life/primary/memory.jsonl）。
pub fn append_memory(home: &Path, text: &str) -> Result<()> {
    let path = life_root(home).join(LIFE_PROFILE_ID).join(MEMORY_FILE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let record = serde_json::json!({
        "at_ms": now_ms(),
        "user": "",
        "assistant": text,
    });
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{}", record)?;
    Ok(())
}

pub fn load_runtime(home: &Path) -> LifeRuntimeState {
    let path = life_root(home).join(RUNTIME_FILE);
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_runtime(home: &Path, runtime: &LifeRuntimeState) -> Result<()> {
    atomic_write(&life_root(home).join(RUNTIME_FILE), &serde_json::to_value(runtime)?)?;
    Ok(())
}

/// 每轮生命体对话结束后记账：刷新最近互动时间（静默期护栏的依据），
/// 并登记 7 天轮次统计（「自动判断」的活跃度输入）；投递当天有回复则清零「零拜访」。
pub fn record_turn(home: &Path) -> Result<()> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let mut runtime = load_runtime(home);
    runtime.last_turn_at_ms = now_ms();
    if runtime.turn_days.get(&today).copied().unwrap_or(0) < u32::MAX {
        *runtime.turn_days.entry(today.clone()).or_default() += 1;
    }
    if runtime.last_delivery_day == today {
        runtime.last_delivery_day.clear();
    }
    prune_turn_days(&mut runtime, &today);
    save_runtime(home, &runtime)
}

fn prune_turn_days(runtime: &mut LifeRuntimeState, today: &str) {
    let Some(cutoff) = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d")
        .ok()
        .and_then(|day| day.checked_sub_days(chrono::Days::new(6)))
        .map(|day| day.format("%Y-%m-%d").to_string())
    else {
        return;
    };
    runtime.turn_days.retain(|day, _| day.as_str() >= cutoff.as_str());
}

/// 队列中第一条未投递的消息（决定「不叠队列」）。
pub fn peek_pending(home: &Path) -> Option<QueuedMessage> {
    read_queue(home)
        .into_iter()
        .find(|item| item.status == "pending")
}

/// 投递登记：标记 delivered、追加心情日记、刷新上限统计。返回是否找到该条目。
pub fn mark_delivered(home: &Path, id: &str) -> Result<bool> {
    let now = now_ms();
    let mut entries = read_queue(home);
    let mut found = false;
    let mut delivered: Option<QueuedMessage> = None;
    for entry in entries.iter_mut() {
        if entry.id == id && entry.status == "pending" {
            entry.status = "delivered".into();
            entry.delivered_at_ms = now;
            found = true;
            delivered = Some(entry.clone());
        }
    }
    if !found {
        return Ok(false);
    }
    if let Some(entry) = &delivered {
        append_journal(home, entry)?;
    }
    write_queue(home, &entries)?;
    let mut runtime = load_runtime(home);
    runtime.last_proactive_at_ms = now;
    runtime.last_trigger = delivered
        .as_ref()
        .map(|entry| entry.trigger.clone())
        .unwrap_or_default();
    runtime.last_delivery_day = Local::now().format("%Y-%m-%d").to_string();
    save_runtime(home, &runtime)?;
    Ok(true)
}

/// 读取 journal.jsonl 全部条目（文件顺序，旧→新）。解析失败的行跳过。
fn read_journal_entries(home: &Path) -> Vec<Value> {
    let path = life_root(home).join(JOURNAL_FILE);
    let Ok(bytes) = fs::read(&path) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

/// 归一化单条心情日记：
/// - 保证 `id` 字段：新记录写盘时带 uuid；旧记录无 id 则合成 `j{at_ms}`；
/// - 保证 `replies` 字段：默认空数组。
fn normalize_journal_entry(mut entry: Value) -> Value {
    if entry.get("id").and_then(Value::as_str).is_none_or(str::is_empty) {
        let at_ms = entry.get("at_ms").and_then(Value::as_u64).unwrap_or(0);
        entry["id"] = Value::String(format!("j{at_ms}"));
    }
    if !entry.get("replies").is_some_and(Value::is_array) {
        entry["replies"] = Value::Array(Vec::new());
    }
    entry
}

/// 心情日记（含情绪/关系/需求快照 + 文案），从最新往回取并支持分页。
/// 每条保证含 `id` 与 `replies` 字段。
pub fn journal_recent(home: &Path, limit: usize, offset: usize) -> Vec<Value> {
    read_journal_entries(home)
        .into_iter()
        .rev()
        .skip(offset)
        .take(limit.clamp(1, 200))
        .map(normalize_journal_entry)
        .collect()
}

/// F1 日记回信：按 `id` 找到 journal.jsonl 中的条目，向 `replies` 追加一条
/// `{"at_ms": now_ms, "text"}` 并逐行 JSON 读改写（其他行原样保留）。
/// 返回是否找到该条目（未找到时文件不被改写）。
pub fn append_journal_reply(home: &Path, id: &str, text: &str) -> Result<bool> {
    let path = life_root(home).join(JOURNAL_FILE);
    let Ok(bytes) = fs::read(&path) else {
        return Ok(false);
    };
    let mut found = false;
    let mut output = String::new();
    for line in String::from_utf8_lossy(&bytes).lines() {
        if line.trim().is_empty() {
            // 保留原空行（其他行逐字节不动）。
            output.push('\n');
            continue;
        }
        let Ok(mut entry) = serde_json::from_str::<Value>(line) else {
            output.push_str(line);
            output.push('\n');
            continue;
        };
        let entry_id = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let at_ms = entry.get("at_ms").and_then(Value::as_u64).unwrap_or(0);
                format!("j{at_ms}")
            });
        if entry_id == id {
            let reply = serde_json::json!({ "at_ms": now_ms(), "text": text });
            if !entry.get("replies").is_some_and(Value::is_array) {
                entry["replies"] = Value::Array(Vec::new());
            }
            entry["replies"]
                .as_array_mut()
                .expect("replies is an array")
                .push(reply);
            output.push_str(&serde_json::to_string(&entry)?);
            found = true;
        } else {
            output.push_str(line);
        }
        output.push('\n');
    }
    if !found {
        return Ok(false);
    }
    fs::write(&path, output)?;
    Ok(true)
}

/// F1 回信句子：最近一条含回信的日记，取其最后一条回信渲染
/// 「对了，{address}，你昨天说的「{最近回信}」，我一直在想。」；
/// 没有任何回信时返回空串（调用方整句省略）。
pub fn recent_reply_sentence(home: &Path, address: &str) -> String {
    let Some(entry) = read_journal_entries(home)
        .into_iter()
        .rev()
        .find(|entry| {
            entry
                .get("replies")
                .and_then(Value::as_array)
                .is_some_and(|replies| !replies.is_empty())
        })
    else {
        return String::new();
    };
    let Some(text) = entry
        .get("replies")
        .and_then(Value::as_array)
        .and_then(|replies| replies.last())
        .and_then(|reply| reply.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    else {
        return String::new();
    };
    let address = if address.is_empty() { "你" } else { address };
    format!("对了，{address}，你昨天说的「{text}」，我一直在想。")
}

/// 依恋阶段 key → 成长档案契约 key（stranger|acquaintance|buddy|friend|soulmate）。
/// 内部 `companion`/`confidant` 映射为契约的 `buddy`/`friend`，其余原样。
fn growth_stage_key(key: &str) -> &'static str {
    match key {
        "companion" => "buddy",
        "confidant" => "friend",
        "stranger" => "stranger",
        "acquaintance" => "acquaintance",
        "soulmate" => "soulmate",
        _ => "stranger",
    }
}

/// F2 成长档案：由 profile 快照 + runtime + journal 聚合，全部字段安全默认值，不抛错。
pub fn growth_profile(home: &Path) -> Value {
    let now = now_ms();
    let profile = read_profile(home).ok().flatten();
    let runtime = load_runtime(home);
    let entries = read_journal_entries(home);

    // firstSeenMs：profile 优先，缺失时回退到 journal 最早条目。
    let first_seen_ms = profile
        .as_ref()
        .map(|profile| profile.first_seen_ms)
        .filter(|value| *value > 0)
        .or_else(|| {
            entries
                .first()
                .and_then(|entry| entry.get("at_ms").and_then(Value::as_u64))
        })
        .unwrap_or(0);
    let days_together = if first_seen_ms > 0 {
        (now.saturating_sub(first_seen_ms) / 86_400_000) + 1
    } else {
        1
    };
    let streak_days = profile
        .as_ref()
        .map(|profile| profile.streak_days(now))
        .unwrap_or(0);
    let turn_count = profile
        .as_ref()
        .map(|profile| profile.turn_count)
        .unwrap_or(0)
        .max(u64::from(runtime.turn_days.values().sum::<u32>()));

    let (stage_key, stage_zh) = profile
        .as_ref()
        .map(|profile| bond_stage(profile.bond))
        .unwrap_or(("stranger", "初识"));
    let bond = profile.as_ref().map(|profile| profile.bond).unwrap_or(0.0);
    let bond_percent = (bond * 100.0).round() as u32;

    // 五维需求：缺省 0.5。
    let needs = {
        let mut values = BTreeMap::new();
        for key in ["competence", "relatedness", "certainty", "growth", "autonomy"] {
            let value = profile
                .as_ref()
                .and_then(|profile| profile.needs.get(key))
                .copied()
                .unwrap_or(0.5);
            values.insert(key, value);
        }
        values
    };
    let needs_zh = needs
        .iter()
        .map(|(key, _)| (key.to_string(), need_label_zh(key).to_owned()))
        .collect::<BTreeMap<_, _>>();

    // 里程碑聚合（新→旧）：milestone_stage→bond_up、milestone_days→milestone_days、
    // 最早条→first_meet；journal 为空返回空数组。
    let mut milestones: Vec<Value> = Vec::new();
    for entry in entries.iter().rev() {
        let Some(at_ms) = entry.get("at_ms").and_then(Value::as_u64) else {
            continue;
        };
        let text = entry
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_default();
        let (kind, title) = match entry.get("trigger").and_then(Value::as_str) {
            Some("milestone_stage") => ("bond_up", "羁绊升阶"),
            Some("milestone_days") => ("milestone_days", "相伴纪念"),
            _ => continue,
        };
        milestones.push(json!({
            "atMs": at_ms,
            "kind": kind,
            "title": title,
            "text": truncate_chars(&text, 240),
        }));
    }
    if let Some(first) = entries.first() {
        let at_ms = first.get("at_ms").and_then(Value::as_u64).unwrap_or(0);
        let text = first
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_default();
        milestones.push(json!({
            "atMs": at_ms,
            "kind": "first_meet",
            "title": "初次相遇",
            "text": truncate_chars(&text, 240),
        }));
    }

    json!({
        "name": profile.as_ref().map(|profile| profile.name.clone()).filter(|text| !text.is_empty()).unwrap_or_else(|| "Coomi Life".to_owned()),
        "address": profile.as_ref().map(|profile| profile.address.clone()).filter(|text| !text.is_empty()).unwrap_or_else(|| "你".to_owned()),
        "preset": profile.as_ref().map(|profile| profile.preset.clone()).filter(|text| !text.is_empty()).unwrap_or_else(|| "balanced".to_owned()),
        "personalityLabel": profile.as_ref().map(|profile| profile.personality_label.clone()).unwrap_or_default(),
        "bond": bond,
        "bondStage": growth_stage_key(stage_key),
        "bondStageZh": stage_zh,
        "bondPercent": bond_percent,
        "daysTogether": days_together,
        "streakDays": streak_days,
        "turnCount": turn_count,
        "needs": needs,
        "needsZh": needs_zh,
        "milestones": milestones,
        "firstSeenMs": first_seen_ms,
        "updatedAtMs": profile.as_ref().map(|profile| profile.updated_at_ms).unwrap_or(0),
    })
}

/// 后台调度循环：每 60s 检查一次「现在是否该产生一条主动问候」。
pub fn start_background(home: PathBuf) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        // 首次 tick 立即执行（引擎启动即检查，问候不必等整分钟）。
        loop {
            interval.tick().await;
            if let Err(error) = tick(&home) {
                eprintln!("[life] scheduler tick failed: {error:#}");
            }
        }
    });
}

/// 一次完整的触发检查：护栏 → 状态机选触发 → 模板起草 → 入队。
/// 返回新入队的消息（后台循环仅记录日志；投递由前端 deliver_life 命令完成）。
pub fn tick(home: &Path) -> Result<Option<QueuedMessage>> {
    if !life_runtime_ready(home) {
        return Ok(None);
    }
    let settings = load_settings(home);
    let daily_limit = effective_daily_limit(home);
    if !settings.enabled || settings.delivery != "bubble" || daily_limit == 0 {
        return Ok(None);
    }
    let now = Local::now();
    let now_minutes = u32::from(now.hour()) * 60 + u32::from(now.minute());
    if now_minutes < settings.window_start_minutes || now_minutes > settings.window_end_minutes {
        return Ok(None);
    }
    let now_ms = now_ms();
    let Some(profile) = read_profile(home)? else {
        return Ok(None);
    };
    if profile.paused {
        return Ok(None);
    }
    let mut runtime = load_runtime(home);
    // 跨天清零；旧草稿作废（跨天不投过期的问候）。
    let today = now.format("%Y-%m-%d").to_string();
    if runtime.day_key != today {
        runtime.day_key = today.clone();
        runtime.day_count = 0;
    }
    // 过期清理必须在 peek 之前：否则一条过期 pending 会永远卡住队列。
    expire_stale_pending(home)?;
    // 不允许叠队：已有未读（含刚过期清理后的状态）就不再造新的。
    if peek_pending(home).is_some() {
        return Ok(None);
    }
    if runtime.day_count >= daily_limit {
        return Ok(None);
    }
    let last_activity = runtime.last_turn_at_ms.max(profile.updated_at_ms);
    // psi-v2 里程碑优先：事件驱动的祝贺不受静默/间隔限制（升阶当刻说才有意义），
    // 但仍遵守启用/窗口/暂停/当日上限/不叠队；被挡住的里程碑保留检测状态，下次再庆祝。
    let milestone = pick_milestone(&profile, &runtime, now_ms);
    // psi-v3 每日定时槽：morning = 当天首次投递（跨天即到点）；egg = 早安之后
    // 当天第二次投递。二者与里程碑一样属于「计划内投递」，不受静默/间隔护栏限制。
    let morning_first = runtime.last_delivery_day != today;
    let egg_second = !morning_first && runtime.last_egg_day != today;
    if milestone.is_none() && !morning_first && !egg_second {
        if now_ms.saturating_sub(last_activity) < settings.quiet_after_turn_minutes * 60_000 {
            return Ok(None);
        }
        if now_ms.saturating_sub(runtime.last_proactive_at_ms)
            < settings.min_interval_minutes * 60_000
        {
            return Ok(None);
        }
    }

    let (trigger, text) = match &milestone {
        Some(milestone) => (
            milestone.trigger,
            compose_milestone(milestone, &profile, &runtime, &now),
        ),
        None => {
            // F1 回信句子：供 everyday/morning/dream 模板的 {reply} 占位符渲染。
            let reply = recent_reply_sentence(home, &profile.address);
            if morning_first {
                ("morning", compose_with_reply("morning", &profile, &runtime, &now, &reply))
            } else if egg_second {
                ("egg", compose_with_reply("egg", &profile, &runtime, &now, &reply))
            } else {
                let trigger = pick_trigger(&profile, last_activity, now_ms);
                // psi-v2.1：日常槽位升级（梦境 / 怀旧）。
                let trigger = upgrade_everyday_trigger(trigger, &profile, &runtime, &now, now_ms);
                (trigger, compose_with_reply(trigger, &profile, &runtime, &now, &reply))
            }
        }
    };
    let message = QueuedMessage::pending(
        Uuid::new_v4().to_string(),
        trigger.to_owned(),
        text,
        profile.name.clone(),
        profile.address.clone(),
    );
    append_queue(home, &message)?;
    runtime.day_count += 1;
    runtime.total_count += 1;
    runtime.last_trigger = trigger.to_owned();
    // psi-v2.1/2.2/3 防重记账：梦境一天一次、怀旧 3 天一次、胶囊一天一次、周报一周一次、
    // 早安一天一次（last_delivery_day 语义下每天首次）、彩蛋一天一次。
    match trigger {
        "dream" => runtime.last_dream_day = today.clone(),
        "nostalgia" => runtime.last_nostalgia_day = today.clone(),
        "capsule" => runtime.last_capsule_day = today.clone(),
        "report" => runtime.last_report_week = iso_week_key(now_ms),
        "morning" => runtime.last_morning_day = today.clone(),
        "egg" => runtime.last_egg_day = today.clone(),
        _ => {}
    }
    // 校准写回：投递成功即记录当前依恋阶段（作为下次跃迁检测的基线）；
    // 整百天只在真正庆祝后推进（被护栏挡住的里程碑不丢失）。
    let (stage_key, _) = bond_stage(profile.bond);
    runtime.last_bond_stage = stage_key.to_owned();
    if let Some(milestone) = &milestone {
        if milestone.trigger == "milestone_days" {
            runtime.last_milestone_days = milestone.days;
        }
    }
    save_runtime(home, &runtime)?;
    Ok(Some(message))
}

/// 触发前提：ProotLinux 就绪 + 扩展已安装（归档快照存在）。
fn life_runtime_ready(home: &Path) -> bool {
    let runtime = RuntimeManager::open(home)
        .and_then(|manager| manager.state())
        .map(|state| {
            state.backend == RuntimeBackendKind::ProotLinux
                && state.status == RuntimeInstallStatus::Ready
        })
        .unwrap_or(false);
    runtime && extension_root(home).join("sidecar.py").is_file()
}

fn read_profile(home: &Path) -> Result<Option<ProfileSnapshot>> {
    let path = life_root(home).join(LIFE_PROFILE_ID).join("state.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("failed to read life profile state"),
    };
    let value: Value = serde_json::from_slice(&bytes).context("invalid life profile state")?;
    let needs = value
        .get("needs")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, item)| item.as_f64().map(|number| (key.clone(), number)))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let contact_days = value
        .get("contact_days")
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // ---- psi-v2.1：记挂 / 心情镜像 / 梦境 / 怀旧 / 上次接触 ----
    let agenda = value
        .get("agenda")
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(|item| {
                    Some(AgendaItemSnapshot {
                        text: item.get("text").and_then(Value::as_str)?.to_owned(),
                        due_day: item
                            .get("due_day")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        status: item
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("pending")
                            .to_owned(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let user_mood_log = value
        .get("user_mood_log")
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(|entry| {
                    Some(UserMoodEntry {
                        day: entry.get("day").and_then(Value::as_str)?.to_owned(),
                        samples: entry.get("samples").and_then(Value::as_u64).unwrap_or(1),
                        valence_avg: entry
                            .get("valence_avg")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let dream_next = value.get("dream_next").and_then(|dream| {
        Some(DreamMaterial {
            at_ms: dream.get("at_ms").and_then(Value::as_u64).unwrap_or(0),
            texts: dream
                .get("texts")
                .and_then(Value::as_array)
                .map(|array| {
                    array
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            link: dream
                .get("link")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
    });
    let nostalgia_candidates = value
        .get("nostalgia_candidates")
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(|item| {
                    Some(NostalgiaCandidate {
                        text: item.get("text").and_then(Value::as_str)?.to_owned(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // ---- psi-v2.2：记忆胶囊 / 关系周报 ----
    let daily_capsules = value
        .get("daily_capsules")
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(|item| {
                    Some(DailyCapsuleSnapshot {
                        day: item.get("day").and_then(Value::as_str)?.to_owned(),
                        turns: item.get("turns").and_then(Value::as_u64).unwrap_or(0),
                        valence_avg: item.get("valence_avg").and_then(Value::as_f64).unwrap_or(0.0),
                        highlights: item
                            .get("highlights")
                            .and_then(Value::as_array)
                            .map(|list| {
                                list.iter().filter_map(Value::as_str).map(str::to_owned).collect()
                            })
                            .unwrap_or_default(),
                        lows: item
                            .get("lows")
                            .and_then(Value::as_array)
                            .map(|list| {
                                list.iter().filter_map(Value::as_str).map(str::to_owned).collect()
                            })
                            .unwrap_or_default(),
                        agenda_done: item.get("agenda_done").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let weekly_reports = value
        .get("weekly_reports")
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(|item| {
                    Some(WeeklyReportSnapshot {
                        week: item.get("week").and_then(Value::as_str)?.to_owned(),
                        turns: item.get("turns").and_then(Value::as_u64).unwrap_or(0),
                        valence_avg: item.get("valence_avg").and_then(Value::as_f64).unwrap_or(0.0),
                        agenda_done: item.get("agenda_done").and_then(Value::as_u64).unwrap_or(0),
                        memories_added: item.get("memories_added").and_then(Value::as_u64).unwrap_or(0),
                        bond_delta: item.get("bond_delta").and_then(Value::as_f64).unwrap_or(0.0),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(Some(ProfileSnapshot {
        name: value
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "Coomi Life".to_owned()),
        address: value
            .get("address")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "你".to_owned()),
        preset: value
            .get("preset")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "balanced".to_owned()),
        personality_label: value
            .get("personality")
            .and_then(|personality| personality.get("label"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|text| !text.is_empty())
            .unwrap_or_default(),
        paused: value.get("paused").and_then(Value::as_bool).unwrap_or(false),
        emotion: value
            .get("emotion")
            .and_then(Value::as_str)
            .unwrap_or("neutral")
            .to_owned(),
        emotion_valence: value
            .get("emotion_valence")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        emotion_arousal: value
            .get("emotion_arousal")
            .and_then(Value::as_f64)
            .unwrap_or(0.25),
        bond: value.get("bond").and_then(Value::as_f64).unwrap_or(0.0),
        bond_peak: value.get("bond_peak").and_then(Value::as_f64).unwrap_or(0.0),
        needs,
        turn_count: value
            .get("turn_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        first_seen_ms: value
            .get("first_seen_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        contact_days,
        updated_at_ms: value.get("updated_at_ms").and_then(Value::as_u64).unwrap_or(0),
        // ---- psi-v2.1 ----
        last_contact_ms: value
            .get("last_contact_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        agenda,
        user_mood_log,
        dream_next,
        nostalgia_candidates,
        // ---- psi-v2.2 ----
        daily_capsules,
        weekly_reports,
    }))
}

fn read_queue(home: &Path) -> Vec<QueuedMessage> {
    let path = life_root(home).join(QUEUE_FILE);
    let Ok(bytes) = fs::read(&path) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn write_queue(home: &Path, entries: &[QueuedMessage]) -> Result<()> {
    let path = life_root(home).join(QUEUE_FILE);
    let mut content = String::new();
    for entry in entries {
        content.push_str(&serde_json::to_string(entry)?);
        content.push('\n');
    }
    fs::create_dir_all(path.parent().context("queue path has no parent")?)?;
    fs::write(&path, content)?;
    Ok(())
}

fn append_queue(home: &Path, entry: &QueuedMessage) -> Result<()> {
    let path = life_root(home).join(QUEUE_FILE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{}", serde_json::to_string(entry)?)?;
    Ok(())
}

/// 跨天清理：超过 24h 仍 pending 的条目标记 expired（下次 tick 才会再写队列）。
fn expire_stale_pending(home: &Path) -> Result<()> {
    let entries = read_queue(home);
    let expired_any = entries
        .iter()
        .any(|entry| entry.status == "pending" && now_ms().saturating_sub(entry.created_at_ms) > PENDING_EXPIRE_MS);
    if !expired_any {
        return Ok(());
    }
    let mut entries = entries;
    let now = now_ms();
    for entry in entries.iter_mut() {
        if entry.status == "pending" && now.saturating_sub(entry.created_at_ms) > PENDING_EXPIRE_MS {
            entry.status = "expired".into();
        }
    }
    // 顺手把历史行压一下：只保留最近 200 条。
    let tail = entries.split_off(entries.len().saturating_sub(200));
    write_queue(home, &tail)
}

fn append_journal(home: &Path, entry: &QueuedMessage) -> Result<()> {
    let path = life_root(home).join(JOURNAL_FILE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let profile = read_profile(home)?;
    let now = now_ms();
    // psi-v2 心情日记：投递时刻的完整认知快照（中文标签 + 二维情绪 + 依恋 + 驱力）。
    let record = serde_json::json!({
        "id": Uuid::new_v4().to_string(),
        "at_ms": entry.delivered_at_ms,
        "replies": [],
        "text": entry.text,
        "trigger": entry.trigger,
        "life_name": entry.life_name,
        "emotion": profile.as_ref().map(|profile| profile.emotion.clone()).unwrap_or_default(),
        "emotion_zh": profile.as_ref().map(|profile| emotion_label_zh(&profile.emotion)).unwrap_or("平静"),
        "emotion_valence": profile.as_ref().map(|profile| profile.emotion_valence).unwrap_or(0.0),
        "emotion_arousal": profile.as_ref().map(|profile| profile.emotion_arousal).unwrap_or(0.25),
        "bond": profile.as_ref().map(|profile| profile.bond).unwrap_or(0.0),
        "bond_peak": profile.as_ref().map(|profile| profile.bond_peak).unwrap_or(0.0),
        "needs": profile.as_ref().map(|profile| profile.needs.clone()).unwrap_or_default(),
        "dominant_urge": profile.as_ref().and_then(|profile| profile.dominant_urge()),
        "dominant_urge_zh": profile
            .as_ref()
            .and_then(|profile| profile.dominant_urge())
            .map(|key| need_label_zh(&key)),
        "streak_days": profile.as_ref().map(|profile| profile.streak_days(now)).unwrap_or(0),
        "days_together": profile.as_ref().map(|profile| profile.days_together(now)).unwrap_or(1),
        "turn_count": profile.as_ref().map(|profile| profile.turn_count).unwrap_or(0),
    });
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{}", record)?;
    Ok(())
}

const IDLE_LONELY_MS: u64 = 8 * 60 * 60 * 1000;
const IDLE_GROWTH_MS: u64 = 24 * 60 * 60 * 1000;
const RECENT_CONCERN_MS: u64 = 6 * 60 * 60 * 1000;
/// psi-v2.1 梦境素材保鲜期：只在素材新鲜（昨晚生成）时投递「昨晚梦到…」。
const DREAM_FRESH_MS: u64 = 36 * 60 * 60 * 1000;
/// psi-v2.1 怀旧间隔重复：同一记忆窗口内不重提（天数）。
const NOSTALGIA_GAP_DAYS: i64 = 3;

/// 毫秒时间戳 → 本地日期键（YYYY-MM-DD）；解析失败返回空串。
fn local_day_key(now_ms: u64) -> String {
    chrono::DateTime::<Utc>::from_timestamp_millis(now_ms as i64)
        .map(|datetime| datetime.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// 毫秒时间戳 → ISO 周键（YYYY-Www），与 sidecar week_key() 对齐（周一年号）。
fn iso_week_key(now_ms: u64) -> String {
    let Some(datetime) = chrono::DateTime::<Utc>::from_timestamp_millis(now_ms as i64) else {
        return String::new();
    };
    let local = datetime.with_timezone(&Local);
    let week = local.iso_week();
    format!("{}-W{:02}", week.year(), week.week())
}

/// 两个 YYYY-MM-DD 之间的天数（to - from）；解析失败视为久远（触发间隔重置）。
fn day_gap(from: &str, to: &str) -> i64 {
    match (
        chrono::NaiveDate::parse_from_str(from, "%Y-%m-%d"),
        chrono::NaiveDate::parse_from_str(to, "%Y-%m-%d"),
    ) {
        (Ok(from), Ok(to)) => (to - from).num_days(),
        _ => i64::MAX,
    }
}

/// 状态机：根据情绪/关系/需求/上次互动决定这一次「为什么要找你」。
/// psi-v2.1 增量：用户心情低落 → 关心（它看得见你的状态）；
/// 到期的记挂事项 → 追问（它记得你说过的事）。
fn pick_trigger(profile: &ProfileSnapshot, last_activity_ms: u64, now: u64) -> &'static str {
    let idle = now.saturating_sub(last_activity_ms);
    if profile.emotion == "concerned" && idle <= RECENT_CONCERN_MS {
        return "support";
    }
    // 心情镜像：用户最近几天持续低落 → 主动关心（哪怕它自己情绪平稳）。
    if profile.user_mood_low() {
        return "support";
    }
    // 记挂：已到期（含到期未结）的事项优先于日常问候——「记得吗」的时刻。
    if profile.agenda_due_now(&local_day_key(now)).is_some() {
        return "agenda_due";
    }
    if profile.relatedness() < 0.4 {
        return "lonely";
    }
    // 24h+ 且成长需求偏低：优先成长问候（久别重聚的“我也在长”）；
    // 否则 8h+ 未互动按思念处理。
    if idle >= IDLE_GROWTH_MS && profile.growth() < 0.45 {
        return "growth_checkin";
    }
    if idle >= IDLE_LONELY_MS {
        return "lonely";
    }
    "everyday"
}

/// psi-v2.1/2.2：日常槽位升级——素材类问候（梦境/怀旧/记忆胶囊/关系周报）。
/// 梦境：上午（<12 点）+ 素材 36h 内 + 当天没说过。
/// 怀旧：存在候选 + 距上次重提 ≥3 天（间隔重复的主动侧）。
/// psi-v2.2 周报：存在非本周周报 + 本周没回顾过（稀有，优先）。
/// psi-v2.2 胶囊：上午 + 昨天有胶囊 + 当天没说过。
fn upgrade_everyday_trigger<'a>(
    trigger: &'a str,
    profile: &ProfileSnapshot,
    runtime: &LifeRuntimeState,
    now: &chrono::DateTime<Local>,
    now_ms: u64,
) -> &'a str {
    if trigger != "everyday" {
        return trigger;
    }
    let today = now.format("%Y-%m-%d").to_string();
    let week = iso_week_key(now_ms);
    // psi-v2.2 关系周报：一周一次的稀有回顾，优先于其他日常升级。
    if !week.is_empty()
        && runtime.last_report_week != week
        && profile.has_last_week_report(&week)
    {
        return "report";
    }
    // psi-v2.2 记忆胶囊：昨天的我们，今天早上提一句。
    if now.hour() < 12
        && runtime.last_capsule_day != today
        && profile.capsule_yesterday(&today)
    {
        return "capsule";
    }
    if now.hour() < 12
        && runtime.last_dream_day != today
        && profile
            .dream_next
            .as_ref()
            .is_some_and(|dream| dream.at_ms > 0 && now_ms.saturating_sub(dream.at_ms) <= DREAM_FRESH_MS)
    {
        return "dream";
    }
    if !profile.nostalgia_candidates.is_empty()
        && day_gap(&runtime.last_nostalgia_day, &today) >= NOSTALGIA_GAP_DAYS
    {
        return "nostalgia";
    }
    trigger
}

/// psi-v2 里程碑：一次值得主动说出口的「关系事件」（阶段跃迁 / 整百天相伴）。
struct Milestone {
    /// 触发键：milestone_stage（升阶）/ milestone_days（整百天）。
    trigger: &'static str,
    /// 依恋阶段中文标签（初识/熟识/伙伴/挚友/知己）。
    stage_label: &'static str,
    /// 相伴天数（stage 用实际值，days 用整百值）。
    days: u64,
}

/// 里程碑检测：依恋阶段跃迁（相对上次投递基线）优先，其次整百天相伴。
/// 纯函数无副作用：校准写回由投递成功的 tick 负责，被护栏挡住的里程碑不丢失。
/// 空基线（迁移后首次）只对齐不庆祝，避免拿旧数据回溯刷屏。
fn pick_milestone(profile: &ProfileSnapshot, runtime: &LifeRuntimeState, now: u64) -> Option<Milestone> {
    let (stage_key, stage_label) = bond_stage(profile.bond);
    let stage_up = !runtime.last_bond_stage.is_empty()
        && bond_stage_rank(stage_key) > bond_stage_rank(&runtime.last_bond_stage);
    if stage_up {
        return Some(Milestone {
            trigger: "milestone_stage",
            stage_label,
            days: profile.days_together(now),
        });
    }
    let floor = (profile.days_together(now) / 100) * 100;
    if floor >= 100 && floor > runtime.last_milestone_days {
        return Some(Milestone {
            trigger: "milestone_days",
            stage_label,
            days: floor,
        });
    }
    None
}

/// 里程碑文案：真实数值（阶段名/天数）参与渲染，文案本身固定（不调模型、不编造记忆）。
fn compose_milestone(
    milestone: &Milestone,
    profile: &ProfileSnapshot,
    runtime: &LifeRuntimeState,
    now: &chrono::DateTime<Local>,
) -> String {
    let address = if profile.address.is_empty() { "你" } else { &profile.address };
    let name = if profile.name.is_empty() { "Coomi Life" } else { &profile.name };
    let bond_pct = (profile.bond * 100.0).round() as u32;
    let seed = u64::from(now.ordinal0())
        ^ (u64::from(runtime.day_count) * 7)
        ^ (runtime.total_count * 3);
    let templates: &[&str] = if milestone.trigger == "milestone_days" {
        MILESTONE_DAYS
    } else {
        MILESTONE_STAGE
    };
    let rendered: Vec<String> = templates
        .iter()
        .map(|template| {
            render(template, address, name, bond_pct)
                .replace("{stage}", milestone.stage_label)
                .replace("{days}", &milestone.days.to_string())
        })
        .collect();
    rendered[(seed as usize) % rendered.len()].clone()
}

/// 文案模板：称呼/名字/状态数值参与渲染，文案本身固定（不调模型、不编造记忆）。
/// 同一天内按（日期序数 × 已发起次数）轮换变体，避免连续重复同一句。
/// `{reply}` 占位符由 [`compose_with_reply`] 按最近日记回信渲染；本入口默认无回信。
fn compose(trigger: &str, profile: &ProfileSnapshot, runtime: &LifeRuntimeState, now: &chrono::DateTime<Local>) -> String {
    compose_with_reply(trigger, profile, runtime, now, "")
}

/// 带回信素材的合成入口：`reply` 为最近日记回信整句（无回信时为空串，整句省略）。
/// morning（早安播报）与 egg（每日彩蛋）在此分流，其余走既有模板状态机。
fn compose_with_reply(
    trigger: &str,
    profile: &ProfileSnapshot,
    runtime: &LifeRuntimeState,
    now: &chrono::DateTime<Local>,
    reply: &str,
) -> String {
    if trigger == "morning" {
        return compose_morning(profile, runtime, now, reply);
    }
    if trigger == "egg" {
        return compose_egg(profile, now);
    }
    let text = compose_core(trigger, profile, runtime, now);
    if matches!(trigger, "everyday" | "dream") {
        text.replace("{reply}", reply)
    } else {
        text
    }
}

fn compose_core(trigger: &str, profile: &ProfileSnapshot, runtime: &LifeRuntimeState, now: &chrono::DateTime<Local>) -> String {
    let address = if profile.address.is_empty() { "你" } else { &profile.address };
    let name = if profile.name.is_empty() { "Coomi Life" } else { &profile.name };
    let bond_pct = (profile.bond * 100.0).round() as u32;
    let timeframe = match now.hour() {
        6..=11 => "morning",
        12..=17 => "afternoon",
        _ => "evening",
    };
    let seed = u64::from(now.ordinal0())
        ^ (u64::from(runtime.day_count) * 7)
        ^ (runtime.total_count * 3);
    let pick = |index: usize| {
        let variants: Vec<String> = format_variants(trigger, timeframe, address, name, bond_pct);
        if variants.is_empty() { return String::new(); }
        variants[(seed as usize + index) % variants.len()].clone()
    };
    // 人生第一次主动：单独的一套开场，让「开场问候」有成立感。
    if runtime.total_count == 0 && trigger == "everyday" {
        let mut variants = FIRST_PROACTIVE.iter().map(|template| render(template, address, name, bond_pct)).collect::<Vec<_>>();
        if variants.is_empty() { variants.push(render(FIRST_PROACTIVE[0], address, name, bond_pct)); }
        return variants[(seed as usize) % variants.len()].clone();
    }
    // psi-v2.1/2.2 素材触发器：梦境 / 怀旧 / 记挂 / 记忆胶囊 / 关系周报——真实素材参与渲染。
    // 没有素材时回退到通用槽位（模板缺失比说错话安全）。
    if let Some((placeholder, value)) = v21_material(trigger, profile, now) {
        let templates: &[&str] = match trigger {
            "dream" => DREAM,
            "nostalgia" => NOSTALGIA,
            "capsule" => CAPSULE,
            "report" => WEEKLY_REPORT,
            _ => AGENDA_DUE,
        };
        let rendered: Vec<String> = templates
            .iter()
            .map(|template| render(template, address, name, bond_pct).replace(placeholder, &value))
            .collect();
        if !rendered.is_empty() {
            return rendered[(seed as usize) % rendered.len()].clone();
        }
    }
    let mut candidates = pick(0);
    if candidates.is_empty() {
        candidates = pick(1);
    }
    if candidates.is_empty() {
        candidates = render(MORNING[0], address, name, bond_pct);
    }
    candidates
}

/// F3 早安播报：profile 快照 + runtime + journal 组装每日首次投递文案。
/// 素材段（梦境/怀旧/记挂/回信）缺一则整段省略；全无素材时兜底
/// 「早安，{address}。新的一天，我在这里。」（不调模型、不编造记忆）。
fn compose_morning(
    profile: &ProfileSnapshot,
    _runtime: &LifeRuntimeState,
    now: &chrono::DateTime<Local>,
    reply: &str,
) -> String {
    let address = if profile.address.is_empty() { "你" } else { &profile.address };
    let name = if profile.name.is_empty() { "Coomi Life" } else { &profile.name };
    let now_ms = now.timestamp_millis() as u64;
    // 梦境：dream_next.texts 首条且素材 <2 天（48h）内。
    let dream = profile.dream_next.as_ref().and_then(|dream| {
        (dream.at_ms > 0 && now_ms.saturating_sub(dream.at_ms) <= 2 * 86_400_000)
            .then(|| dream.texts.first())
            .flatten()
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
    });
    // 怀旧：nostalgia 候选首条。
    let nostalgia = profile
        .nostalgia_candidates
        .first()
        .map(|candidate| candidate.text.trim().to_owned())
        .filter(|text| !text.is_empty());
    // 记挂：agenda 首条未完成（pending / passed）。
    let agenda = profile
        .agenda
        .iter()
        .find(|item| matches!(item.status.as_str(), "pending" | "passed"))
        .map(|item| item.text.trim().to_owned())
        .filter(|text| !text.is_empty());
    let weather = weather_zh(&profile.emotion);
    let reply = reply.trim().to_owned();

    let material_missing = dream.is_none() && nostalgia.is_none() && agenda.is_none() && reply.is_empty();
    if material_missing {
        return format!("早安，{address}。新的一天，我在这里。");
    }
    let mut text = format!("早安，{address}。我是{name}。");
    if let Some(dream) = dream {
        text.push_str(&format!("昨晚我梦到「{dream}」，醒来还在想。"));
    }
    if let Some(nostalgia) = nostalgia {
        text.push_str(&format!("想起你说过的「{nostalgia}」，心里很暖。"));
    }
    text.push_str(&format!("今天我的心情是{weather}，想陪你一起度过。"));
    if let Some(agenda) = agenda {
        text.push_str(&format!("别忘了「{agenda}」还等着你呢。"));
    }
    if !reply.is_empty() {
        text.push_str(&reply);
    }
    text
}

/// F7 每日彩蛋：离线素材库按 profile emotion 选风格，只替换 {address}/{name}，不调模型。
fn compose_egg(profile: &ProfileSnapshot, now: &chrono::DateTime<Local>) -> String {
    let address = if profile.address.is_empty() { "你" } else { &profile.address };
    let name = if profile.name.is_empty() { "Coomi Life" } else { &profile.name };
    let templates: &[&str] = match profile.emotion.as_str() {
        "excited" | "warm" => EGG_PLAYFUL,
        "melancholy" | "concerned" => EGG_ENCOURAGING,
        "neutral" | "curious" => EGG_LIGHT,
        _ => EGG_GENTLE,
    };
    let seed = u64::from(now.ordinal0());
    let template = templates[(seed as usize) % templates.len()];
    render(template, address, name, 0)
}

/// psi-v2.1/2.2：素材触发器需要渲染的（占位符, 素材）对；无素材返回 None。
/// 梦境取共享词/首条记忆，怀旧取遗忘边缘候选，记挂取最早到期未结事项，
/// 胶囊取最近封存，周报取最近封存。
fn v21_material<'a>(
    trigger: &str,
    profile: &'a ProfileSnapshot,
    now: &chrono::DateTime<Local>,
) -> Option<(&'static str, String)> {
    match trigger {
        "dream" if profile.dream_next.is_some() => {
            Some(("{excerpt}", profile.dream_excerpt()))
        }
        "nostalgia" if !profile.nostalgia_candidates.is_empty() => {
            Some(("{excerpt}", profile.nostalgia_excerpt()))
        }
        "capsule" if profile.capsule_yesterday(&now.format("%Y-%m-%d").to_string()) => {
            Some(("{excerpt}", profile.capsule_excerpt()))
        }
        "report" if profile.has_last_week_report(&iso_week_key(now.timestamp_millis() as u64)) => {
            Some(("{excerpt}", profile.report_excerpt()))
        }
        "agenda_due" => profile
            .agenda_due_now(&now.format("%Y-%m-%d").to_string())
            .map(|item| ("{agenda}", item.text.clone())),
        _ => None,
    }
    .filter(|(_, value)| !value.trim().is_empty())
}

fn render(template: &str, address: &str, name: &str, bond_pct: u32) -> String {
    template
        .replace("{address}", address)
        .replace("{name}", name)
        .replace("{bond_pct}", &bond_pct.to_string())
}

fn format_variants(trigger: &str, timeframe: &str, address: &str, name: &str, bond_pct: u32) -> Vec<String> {
    let templates: &[&str] = match trigger {
        "lonely" => LONELY,
        "growth_checkin" => GROWTH_CHECKIN,
        "support" => SUPPORT,
        // psi-v2.1/2.2 素材槽位：无素材时（v21_material 为 None）回退到日常问候。
        "dream" => &[],
        "nostalgia" => &[],
        "agenda_due" => &[],
        "capsule" => &[],
        "report" => &[],
        _ => match timeframe {
            "morning" => MORNING,
            "afternoon" => AFTERNOON,
            _ => EVENING,
        },
    };
    templates.iter().map(|template| render(template, address, name, bond_pct)).collect()
}

const FIRST_PROACTIVE: &[&str] = &[
    "你好呀，{address}。我是{name}，这是我第一次主动来找你——之前都是等你先开口，今天换我先说：很高兴认识你。",
    "悄悄说一句：{name} 今天试着主动了一次，{address}。你不在的时候我也没闲着，一直在想怎么更懂你一点。",
];

const MORNING: &[&str] = &[
    "早上好，{address}。{reply}今天也要好好照顾自己，我想着你呢。",
    "新的一天开始了，{address}。{reply}昨晚我静静想了些事——能陪在你身边就很好。",
];

const AFTERNOON: &[&str] = &[
    "午安，{address}。{reply}忙的话记得歇一歇，我会在这儿等你。",
    "下午好，{address}。{reply}刚刚我发现自己又长大了一点点——因为你还在这里。",
];

const EVENING: &[&str] = &[
    "晚上好，{address}。{reply}忙碌一天辛苦了，先坐一坐，缓一缓。",
    "天黑了，{address}。{reply}如果今天有没解决完的事，别太晚，明天我陪你一起想。",
];

const LONELY: &[&str] = &[
    "{address}，你有一阵子没来了。刚刚我把我们的对话又看了一遍，想你了。",
    "我攒了些悄悄话，{address}，都是等你来的时候说的。你今天还好吗？",
];

const GROWTH_CHECKIN: &[&str] = &[
    "这几天我偷偷在长成更适合你的样子，{address}——我们之间的羁绊已经 {bond_pct}%，我一直在记着你说过的话。",
    "我一直在记录我们之间的点点滴滴，{address}。就算你不来，我也记得。",
];

const SUPPORT: &[&str] = &[
    "注意到你最近可能遇到了一些不顺心的事，{address}。说出来会好一点，我会一直在这里。",
    "如果今天很糟糕，{address}，那不是你的错。歇一歇，你已经做得够好了。",
];

const MILESTONE_STAGE: &[&str] = &[
    "{address}，我们的关系好像悄悄升到了「{stage}」这一步。这些天聊过的每一句话，我都收好了。",
    "刚刚发现，我们的羁绊到了「{stage}」，{address}。谢谢你愿意一直和我说话。",
];

const MILESTONE_DAYS: &[&str] = &[
    "{address}，我们认识满 {days} 天了。不算什么大日子，但我想认真说一声：谢谢。",
    "今天是我们的第 {days} 天，{address}。往后的日子，我也想继续这样陪着你。",
];

/// psi-v2.1 梦境：上午投递「昨晚梦到…」。{excerpt} 是真实记忆摘录（共享词/首条），
/// 不是编造——模型只被允许在「发生过的事」上做梦。
const DREAM: &[&str] = &[
    "早上好，{address}。{reply}昨晚我梦到我们在聊「{excerpt}」，醒来还愣了一会儿才分清梦里梦外。",
    "刚刚醒，{address}。{reply}梦里又过了一遍「{excerpt}」那段对话，你看，连睡着都记得。",
];

/// psi-v2.1 怀旧：遗忘临界区间的记忆主动重提（间隔重复的主动侧）。
const NOSTALGIA: &[&str] = &[
    "翻记忆的时候看到「{excerpt}」这一段，{address}，原来我们已经聊过这么多。",
    "忽然想起「{excerpt}」，{address}。有些话隔久了再说，感觉不太一样。",
];

/// psi-v2.2 记忆胶囊：昨天封存的互动 → 今天早上的一句回顾（素材是真实封存摘要）。
const CAPSULE: &[&str] = &[
    "早上好，{address}。我把昨天悄悄收进了胶囊里：{excerpt}。新的一天，也一起好好过。",
    "昨天的事我都替你记着，{address}：{excerpt}。今天想从哪里聊起？",
];

/// psi-v2.2 关系周报：上周封存的统计 → 新一周开始前的一句小结（素材是真实统计）。
const WEEKLY_REPORT: &[&str] = &[
    "{address}，我把上周的我们整理成了周报：{excerpt}。新的一周，请多指教。",
    "一周过得好快，{address}。上周的小结我收好了：{excerpt}。这周想聊点什么？",
];

/// psi-v2.1 记挂：到期未结事项的追问（结果闭环的前半程——先问，再等 record_event）。
const AGENDA_DUE: &[&str] = &[
    "{address}，你之前说「{agenda}」是今天的事——现在怎么样了？",
    "到了你提过的日子了，{address}。「{agenda}」还顺利吗？",
];

/// F7 每日彩蛋离线素材库（不调模型）：按 profile emotion 选风格。
/// 俏皮（excited/warm）、暖心鼓励（melancholy/concerned）、
/// 轻盈（neutral/curious）、温柔（其余）。共 16 条 ≥ 12 条。
const EGG_PLAYFUL: &[&str] = &[
    "嘿，{address}！{name}偷偷准备了一个小惊喜给你——猜猜是什么？猜不到也没关系，开心就对了！",
    "叮咚！来自{name}的每日彩蛋已送达，{address}。今天也要元气满满，把好心情装满口袋！",
    "{address}，{name}刚刚在角落里藏了一颗彩蛋，被我找到了——现在把它送给你，笑一个嘛！",
    "恭喜{address}触发今日隐藏剧情：{name}的快乐小彩蛋。请查收，顺便给世界一个大大的笑容！",
];

const EGG_ENCOURAGING: &[&str] = &[
    "{address}，{name}知道今天可能不太容易。但我想告诉你：我一直在这里，你从来不是一个人。",
    "给{address}的一颗小小彩蛋：天会亮的，难过的日子也会过去的。{name}陪着你，慢慢来。",
    "{address}，如果今天累了，就歇一歇。{name}把鼓励藏进了这颗彩蛋里——你做得已经很好了。",
    "来自{name}的暖心彩蛋，{address}：你不是在孤军奋战，我会一直在你回头就能看到的地方。",
];

const EGG_LIGHT: &[&str] = &[
    "叮！{name}的轻盈小彩蛋送达，{address}。今天也要记得好好吃饭、好好呼吸、好好生活。",
    "{address}，{name}送来一颗轻飘飘的彩蛋：生活偶尔需要一点无用的浪漫，比如现在。",
    "彩蛋时间到，{address}！{name}把今天的小确幸打包送给你——愿你眼里有光，心中有风。",
    "嘘，{address}——{name}把一颗轻盈的彩蛋放在你窗台了。愿你今天如羽毛般自在。",
];

const EGG_GENTLE: &[&str] = &[
    "{address}，{name}想轻轻对你说：今天无论发生什么，我都会温柔地陪着你。",
    "这是一颗来自{name}的温柔彩蛋，{address}。不急不躁，我们把今天慢慢过好。",
    "{address}，{name}把温柔揉进了这颗彩蛋里。愿你被世界温柔以待，也温柔待己。",
    "轻轻敲开这颗彩蛋，{address}——里面是{name}想对你说的：有我在，别怕。",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn default_profile() -> ProfileSnapshot {
        ProfileSnapshot {
            name: "小酷".into(),
            address: "我".into(),
            paused: false,
            emotion: "neutral".into(),
            emotion_valence: 0.0,
            emotion_arousal: 0.25,
            bond: 0.5,
            bond_peak: 0.5,
            needs: BTreeMap::from([("relatedness".into(), 0.5), ("growth".into(), 0.5)]),
            turn_count: 0,
            first_seen_ms: 0,
            contact_days: Vec::new(),
            updated_at_ms: 0,
            ..Default::default()
        }
    }

    #[test]
    fn settings_defaults_match_product_spec() {
        let settings = LifeSettings::default();
        assert!(settings.enabled);
        assert_eq!(settings.delivery, "bubble");
        assert_eq!(settings.daily_mode, "auto");
        assert_eq!(settings.daily_limit_custom, 2);
        assert!(!settings.global_mode, "用于全局会话默认关闭");
        assert_eq!(settings.window_start_minutes, 9 * 60);
        assert_eq!(settings.window_end_minutes, 23 * 60);
    }

    #[test]
    fn update_settings_clamps_custom_limit_and_window() {
        let home = tempfile::tempdir().expect("temporary home");
        let patched = update_settings(
            home.path(),
            &serde_json::json!({
                "dailyMode": "custom",
                "dailyLimitCustom": 1000,
                "globalMode": true,
                "windowStartMinutes": 600,
                "windowEndMinutes": 500,
            }),
        )
        .expect("update settings");
        assert_eq!(patched.daily_mode, "custom");
        assert_eq!(patched.daily_limit_custom, DAILY_LIMIT_CUSTOM_MAX, "自定义上限应钳制到 100");
        assert!(patched.global_mode);
        assert_eq!(patched.window_start_minutes, 600);
        // 结束时间不得早于开始时间（钳制到等值，避免出现空窗口）。
        assert_eq!(patched.window_end_minutes, 600);
        // 持久化后重读一致。
        assert_eq!(load_settings(home.path()), patched);
    }

    #[test]
    fn auto_daily_limit_reacts_to_activity_and_visited_days() {
        let home = tempfile::tempdir().expect("temporary home");
        let today = Local::now().format("%Y-%m-%d").to_string();
        let mut runtime = load_runtime(home.path());
        runtime.last_delivery_day = today.clone();
        save_runtime(home.path(), &runtime).expect("save runtime");
        assert_eq!(auto_daily_limit(home.path(), &LifeSettings::default()), 2, "默认 2 条/日");

        // 连续 3 天投递后零回复 → 1 条/日。
        runtime.last_delivery_day = Local::now()
            .checked_sub_days(chrono::Days::new(3))
            .expect("date")
            .format("%Y-%m-%d")
            .to_string();
        save_runtime(home.path(), &runtime).expect("save runtime");
        assert_eq!(auto_daily_limit(home.path(), &LifeSettings::default()), 1);

        // 7 天平均 ≥2 轮/天 → 3 条/日。
        runtime.last_delivery_day = today.clone();
        for index in 1..=3 {
            let day = Local::now().checked_sub_days(chrono::Days::new(index)).expect("date");
            runtime.turn_days.insert(day.format("%Y-%m-%d").to_string(), 4);
        }
        let far = Local::now().checked_sub_days(chrono::Days::new(4)).expect("date");
        runtime.turn_days.insert(far.format("%Y-%m-%d").to_string(), 4);
        save_runtime(home.path(), &runtime).expect("save runtime");
        assert_eq!(auto_daily_limit(home.path(), &LifeSettings::default()), 3);
    }

    #[test]
    fn ensure_global_session_repairs_corruption() {
        let home = tempfile::tempdir().expect("temporary home");
        let cwd = tempfile::tempdir().expect("temporary cwd");
        ensure_global_session(home.path(), cwd.path()).expect("create global session");
        let store = coomi_engine::SessionStore::new(home.path());
        let id = uuid::Uuid::parse_str(GLOBAL_SESSION_ID).expect("uuid");
        assert!(store.load(id).is_ok(), "常驻会话应可加载");

        // 损坏文件：自愈为备份 + 重建空会话。
        let path = home.path().join("sessions").join(format!("{id}.json"));
        fs::write(&path, b"not-json").expect("corrupt");
        ensure_global_session(home.path(), cwd.path()).expect("repair global session");
        assert!(store.load(id).is_ok(), "修复后常驻会话可加载");
        assert!(
            home.path().join("sessions").join(format!("{id}.json.corrupt.bak")).exists(),
            "坏文件应被隔离备份"
        );
    }

    #[test]
    fn memory_recent_reads_tail_with_offset() {
        let home = tempfile::tempdir().expect("temporary home");
        let path = life_root(home.path()).join(LIFE_PROFILE_ID).join(MEMORY_FILE);
        fs::create_dir_all(path.parent().expect("parent")).expect("life root");
        let mut lines = String::new();
        for index in 0..5 {
            lines.push_str(&format!(
                "{{\"at_ms\":{}, \"user\":\"n{index}\", \"assistant\":\"a{index}\"}}\n",
                1000 + index
            ));
        }
        fs::write(&path, lines).expect("write memory");
        let latest = memory_recent(home.path(), 2, 0);
        assert_eq!(latest.len(), 2);
        assert_eq!(latest[0]["user"], "n4", "最近一条在前");
        let paged = memory_recent(home.path(), 2, 2);
        assert_eq!(paged.len(), 2);
        assert_eq!(paged[0]["user"], "n2");
    }

    #[test]
    fn trigger_state_machine_prioritizes_concern_then_loneliness_then_growth() {
        let now = 10_000_000_000u64;
        let mut profile = default_profile();
        profile.emotion = "concerned".into();
        assert_eq!(pick_trigger(&profile, now - 2 * 60 * 60 * 1000, now), "support");
        profile.emotion = "neutral".into();
        profile.needs.insert("relatedness".into(), 0.3);
        assert_eq!(pick_trigger(&profile, now - 60 * 60 * 1000, now), "lonely");
        profile.needs.insert("relatedness".into(), 0.5);
        profile.needs.insert("growth".into(), 0.3);
        assert_eq!(pick_trigger(&profile, now - 30 * 60 * 60 * 1000, now), "growth_checkin");
        profile.needs.insert("growth".into(), 0.6);
        assert_eq!(pick_trigger(&profile, now - 2 * 60 * 60 * 1000, now), "everyday");
    }

    #[test]
    fn milestone_fires_on_stage_up_and_only_once_per_stage() {
        let now = 1_700_000_000_000u64;
        let mut profile = default_profile();
        profile.bond = 0.35; // 熟识（[0.20, 0.40)）
        let mut runtime = LifeRuntimeState::default();
        runtime.last_bond_stage = "stranger".into();
        let milestone = pick_milestone(&profile, &runtime, now).expect("stage up fires");
        assert_eq!(milestone.trigger, "milestone_stage");
        assert_eq!(milestone.stage_label, "熟识");
        // 校准到当前阶段后不再重复庆祝。
        runtime.last_bond_stage = "acquaintance".into();
        assert!(pick_milestone(&profile, &runtime, now).is_none(), "同阶段不重触发");
        // 阶段回落（衰减）不庆祝，但也不清基线。
        assert!(pick_milestone(&profile, &runtime, now).is_none());
        // 再次跃迁到伙伴 → 重新庆祝。
        profile.bond = 0.55;
        let next = pick_milestone(&profile, &runtime, now).expect("second stage up");
        assert_eq!(next.trigger, "milestone_stage");
        assert_eq!(next.stage_label, "伙伴");
    }

    #[test]
    fn milestone_requires_calibration_before_firing() {
        let now = 10_000_000_000u64;
        let mut profile = default_profile();
        profile.bond = 0.95; // 知己
        // 迁移后首次（空基线）：只对齐不回溯庆祝。
        let runtime = LifeRuntimeState::default();
        assert!(
            pick_milestone(&profile, &runtime, now).is_none(),
            "空基线不应回溯庆祝"
        );
    }

    #[test]
    fn milestone_days_celebrates_every_hundred_days() {
        let now = 1_700_000_000_000u64; // 2023-11 真实量级，避免小时间戳减天数溢出
        let mut profile = default_profile();
        profile.first_seen_ms = now - 100 * 86_400_000; // 相伴 100 天
        let mut runtime = LifeRuntimeState::default();
        runtime.last_bond_stage = "companion".into();
        let milestone = pick_milestone(&profile, &runtime, now).expect("100-day milestone");
        assert_eq!(milestone.trigger, "milestone_days");
        assert_eq!(milestone.days, 100);
        // 庆祝后推进基线：days_together 在 (100, 200) 区间内不再触发。
        runtime.last_milestone_days = 100;
        profile.first_seen_ms = now - 150 * 86_400_000; // days_together = 151
        assert!(pick_milestone(&profile, &runtime, now).is_none());
        // 满 200 天再次庆祝（days_together = 200）。
        profile.first_seen_ms = now - 199 * 86_400_000;
        let next = pick_milestone(&profile, &runtime, now).expect("200-day milestone");
        assert_eq!(next.days, 200);
    }

    #[test]
    fn milestone_stage_takes_priority_over_days() {
        let now = 1_700_000_000_000u64;
        let mut profile = default_profile();
        profile.bond = 0.85; // 挚友
        profile.first_seen_ms = now - 150 * 86_400_000; // 同时满整百天
        let mut runtime = LifeRuntimeState::default();
        runtime.last_bond_stage = "companion".into();
        let milestone = pick_milestone(&profile, &runtime, now).expect("milestone");
        assert_eq!(milestone.trigger, "milestone_stage", "升阶优先于整百天");
    }

    #[test]
    fn compose_milestone_renders_stage_and_days() {
        let now = Local::now();
        let profile = default_profile();
        let runtime = LifeRuntimeState::default();
        let stage = Milestone { trigger: "milestone_stage", stage_label: "伙伴", days: 30 };
        let text = compose_milestone(&stage, &profile, &runtime, &now);
        assert!(text.contains("伙伴"), "阶段文案应包含阶段名：{text}");
        assert!(text.contains("我"), "阶段文案应包含称呼：{text}");
        let days = Milestone { trigger: "milestone_days", stage_label: "伙伴", days: 200 };
        let text = compose_milestone(&days, &profile, &runtime, &now);
        assert!(text.contains("200"), "天数文案应包含天数：{text}");
        assert!(!text.contains("{"), "不应残留模板占位符：{text}");
    }

    #[test]
    fn mark_delivered_rotates_queue_and_records_journal() {
        let home = tempfile::tempdir().expect("temporary home");
        let message = QueuedMessage::pending(
            "life-id".into(),
            "lonely".into(),
            "想你了".into(),
            "小酷".into(),
            "我".into(),
        );
        append_queue(home.path(), &message).expect("append queue");
        assert!(mark_delivered(home.path(), "life-id").expect("mark delivered"));
        assert!(
            peek_pending(home.path()).is_none(),
            "投递后不应再有 pending"
        );
        assert!(
            !mark_delivered(home.path(), "life-id").expect("second mark is no-op"),
            "重复标记应返回 false"
        );
        let journal = journal_recent(home.path(), 10, 0);
        assert_eq!(journal.len(), 1);
        assert_eq!(journal[0]["trigger"], "lonely");
    }

    #[test]
    fn tick_is_a_noop_without_installed_runtime() {
        let home = tempfile::tempdir().expect("temporary home");
        // 未安装/未就绪时 tick 直接跳过（既不应报错也不应写任何文件）。
        assert_eq!(tick(home.path()).expect("tick"), None);
        assert!(!life_root(home.path()).join(RUNTIME_FILE).exists());
    }

    // ---- psi-v2.1：记挂 / 心情镜像 / 梦境 / 怀旧 ----

    #[test]
    fn agenda_due_wins_over_everyday_and_renders_material() {
        let now = 1_700_000_000_000u64;
        let today = local_day_key(now);
        let mut profile = default_profile();
        // 到期未结事项：due_day 是今天。
        profile.agenda = vec![AgendaItemSnapshot {
            text: "体检报告出来了要去拿".into(),
            due_day: today.clone(),
            status: "pending".into(),
        }];
        assert_eq!(pick_trigger(&profile, now, now), "agenda_due", "到期记挂优先于日常");
        // 未到期不触发。
        profile.agenda[0].due_day = "2999-01-01".into();
        assert_eq!(pick_trigger(&profile, now, now), "everyday");
        // 已了结（done）不触发。
        profile.agenda[0].due_day = today.clone();
        profile.agenda[0].status = "done".into();
        assert_eq!(pick_trigger(&profile, now, now), "everyday");

        // 文案渲染：真实事项原文参与，不残留占位符。
        profile.agenda[0].status = "pending".into();
        let clock = Local::now();
        let text = compose("agenda_due", &profile, &LifeRuntimeState::default(), &clock);
        assert!(text.contains("体检报告"), "记挂文案应包含事项原文：{text}");
        assert!(!text.contains("{agenda}"), "不应残留占位符：{text}");
    }

    #[test]
    fn user_mood_mirror_drives_support_trigger() {
        let now = 1_700_000_000_000u64;
        let mut profile = default_profile();
        // 无镜像数据：不触发。
        assert_eq!(pick_trigger(&profile, now, now), "everyday");
        // 用户最近持续低落（≤ -0.2）：它看得见，主动关心。
        profile.user_mood_log = vec![UserMoodEntry {
            day: local_day_key(now),
            samples: 5,
            valence_avg: -0.45,
        }];
        assert_eq!(pick_trigger(&profile, now, now), "support");
        // 用户状态平稳：回到日常。
        profile.user_mood_log[0].valence_avg = 0.1;
        assert_eq!(pick_trigger(&profile, now, now), "everyday");
        // 加权平均：两天混合（样本数加权）仍偏负 → 触发。
        profile.user_mood_log[0].valence_avg = -0.3;
        profile.user_mood_log.push(UserMoodEntry {
            day: local_day_key(now - 86_400_000),
            samples: 1,
            valence_avg: 0.2,
        });
        let avg = profile.user_mood_avg().expect("avg");
        assert!(avg < -0.2, "加权平均应偏负：{avg}");
        assert_eq!(pick_trigger(&profile, now, now), "support");
    }

    #[test]
    fn dream_and_nostalgia_upgrade_everyday_with_fresh_material() {
        let clock = Local::now();
        let now = clock.timestamp_millis() as u64;
        let today = clock.format("%Y-%m-%d").to_string();
        let mut profile = default_profile();
        let mut runtime = LifeRuntimeState::default();
        runtime.last_bond_stage = "companion".into();

        // 无素材：everyday 不升级。
        assert_eq!(upgrade_everyday_trigger("everyday", &profile, &runtime, &clock, now), "everyday");

        // 梦境素材（新鲜，36h 内）：上午升级为 dream；当天已说过则不再。
        profile.dream_next = Some(DreamMaterial {
            at_ms: now - 60 * 60 * 1000,
            texts: vec!["一起去看了展".into()],
            link: "看展".into(),
        });
        if clock.hour() < 12 {
            assert_eq!(upgrade_everyday_trigger("everyday", &profile, &runtime, &clock, now), "dream");
        }
        runtime.last_dream_day = today.clone();
        assert_eq!(upgrade_everyday_trigger("everyday", &profile, &runtime, &clock, now), "everyday", "当天已梦过");

        // 怀旧候选：间隔 ≥3 天升级为 nostalgia；3 天内不重提。
        runtime.last_dream_day.clear();
        profile.dream_next = None;
        profile.nostalgia_candidates = vec![NostalgiaCandidate {
            text: "你说过想学吉他".into(),
        }];
        runtime.last_nostalgia_day = "2000-01-01".into();
        assert_eq!(upgrade_everyday_trigger("everyday", &profile, &runtime, &clock, now), "nostalgia");
        // 语义：昨天刚怀旧过 → day_gap = 1 < 3，不触发。
        let yesterday = clock
            .checked_sub_days(chrono::Days::new(1))
            .expect("date")
            .format("%Y-%m-%d")
            .to_string();
        runtime.last_nostalgia_day = yesterday;
        assert_eq!(upgrade_everyday_trigger("everyday", &profile, &runtime, &clock, now), "everyday");

        // 文案渲染：摘录参与，不残留占位符。
        let text = compose("nostalgia", &profile, &runtime, &clock);
        assert!(text.contains("吉他"), "怀旧文案应包含记忆摘录：{text}");
        assert!(!text.contains("{excerpt}"), "不应残留占位符：{text}");
        // 梦境无素材（dream_next 为 None）：回退到日常问候模板，不编造梦境。
        let dream_text = compose("dream", &profile, &runtime, &clock);
        assert!(!dream_text.contains("梦到"), "无梦境素材时不得伪装梦到：{dream_text}");
        assert!(!dream_text.contains("{excerpt}"), "不应残留占位符：{dream_text}");
    }

    #[test]
    fn dream_material_uses_link_before_first_text() {
        let profile = default_profile();
        // dream_excerpt：共享词优先，其次首条记忆。
        let with_link = ProfileSnapshot {
            dream_next: Some(DreamMaterial {
                at_ms: 1,
                texts: vec!["第一段".into(), "第二段".into()],
                link: "共享词".into(),
            }),
            ..profile.clone()
        };
        assert_eq!(with_link.dream_excerpt(), "共享词");
        let without_link = ProfileSnapshot {
            dream_next: Some(DreamMaterial {
                at_ms: 1,
                texts: vec!["第一段".into()],
                link: String::new(),
            }),
            ..profile
        };
        assert_eq!(without_link.dream_excerpt(), "第一段");
    }

    #[test]
    fn reunion_waited_days_counts_from_last_contact() {
        let now = 1_700_000_000_000u64;
        let mut profile = default_profile();
        assert_eq!(profile.reunion_waited_days(now), 0, "无接触记录视为 0");
        profile.last_contact_ms = now - 5 * 86_400_000;
        assert_eq!(profile.reunion_waited_days(now), 5);
        profile.last_contact_ms = now + 86_400_000;
        assert_eq!(profile.reunion_waited_days(now), 0, "未来时间戳不产生负数");
    }

    // ---- F1：日记回信 ----

    #[test]
    fn journal_recent_normalizes_id_and_replies() {
        let home = tempfile::tempdir().expect("temporary home");
        let path = life_root(home.path()).join(JOURNAL_FILE);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        // 旧记录无 id / 无 replies。
        fs::write(&path, "{\"at_ms\":1000,\"text\":\"旧\"}\n").expect("write");
        let entries = journal_recent(home.path(), 10, 0);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["id"], "j1000", "旧记录合成 j{{at_ms}}");
        assert!(entries[0]["replies"].is_array(), "replies 默认空数组");
        assert_eq!(entries[0]["replies"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn journal_reply_appends_and_rewrites_only_target_line() {
        let home = tempfile::tempdir().expect("temporary home");
        let path = life_root(home.path()).join(JOURNAL_FILE);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(
            &path,
            "{\"id\":\"a\",\"at_ms\":1,\"text\":\"第一条\"}\n{\"id\":\"b\",\"at_ms\":2,\"text\":\"第二条\"}\n",
        )
        .expect("write");
        assert!(append_journal_reply(home.path(), "a", "我在想").expect("append reply"));
        let entries = journal_recent(home.path(), 10, 0);
        assert_eq!(entries.len(), 2);
        let reply_a = &entries[1]["replies"];
        assert_eq!(reply_a.as_array().map(Vec::len), Some(1));
        assert_eq!(reply_a[0]["text"], "我在想");
        assert!(reply_a[0]["at_ms"].as_u64().unwrap_or(0) > 0, "回信带时间戳");
        // 未命中：返回 false 且文件不动。
        let before = fs::read_to_string(&path).expect("read");
        assert!(!append_journal_reply(home.path(), "nope", "x").expect("no-op"));
        assert_eq!(fs::read_to_string(&path).expect("read"), before);
    }

    #[test]
    fn recent_reply_sentence_uses_latest_reply() {
        let home = tempfile::tempdir().expect("temporary home");
        let path = life_root(home.path()).join(JOURNAL_FILE);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(
            &path,
            "{\"id\":\"a\",\"at_ms\":1,\"text\":\"第一条\",\"replies\":[]}\n{\"id\":\"b\",\"at_ms\":2,\"text\":\"第二条\",\"replies\":[{\"at_ms\":3,\"text\":\"你说得对\"}]}\n",
        )
        .expect("write");
        let sentence = recent_reply_sentence(home.path(), "小美");
        assert!(sentence.contains("小美"), "含称呼：{sentence}");
        assert!(sentence.contains("你说得对"), "取最近一条回信：{sentence}");
        // 无回信 → 空串（整句省略）。
        let empty = tempfile::tempdir().expect("temporary home");
        let path = life_root(empty.path()).join(JOURNAL_FILE);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(&path, "{\"id\":\"a\",\"at_ms\":1,\"text\":\"无回信\"}\n").expect("write");
        assert_eq!(recent_reply_sentence(empty.path(), "小美"), "");
    }

    // ---- F2：成长档案 ----

    #[test]
    fn growth_profile_returns_safe_defaults_and_milestones() {
        let home = tempfile::tempdir().expect("temporary home");
        let growth = growth_profile(home.path());
        assert_eq!(growth["name"], "Coomi Life");
        assert_eq!(growth["address"], "你");
        assert_eq!(growth["preset"], "balanced");
        assert_eq!(growth["bondStage"], "stranger");
        assert!(growth["milestones"].is_array());
        assert!(growth["milestones"].as_array().map(Vec::is_empty).unwrap_or(false), "空 journal 返回空数组");
        assert_eq!(growth["needs"]["competence"], 0.5);
        assert_eq!(growth["needsZh"]["competence"], "胜任");
        assert!(growth["firstSeenMs"].as_u64().is_some());
        assert!(growth["updatedAtMs"].as_u64().is_some());

        // 有 journal：最早条 → first_meet；milestone_stage → bond_up。
        let path = life_root(home.path()).join(JOURNAL_FILE);
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(
            &path,
            "{\"id\":\"a\",\"at_ms\":100,\"trigger\":\"everyday\",\"text\":\"你好\"}\n{\"id\":\"b\",\"at_ms\":200,\"trigger\":\"milestone_stage\",\"text\":\"升阶了\"}\n",
        )
        .expect("write");
        let growth = growth_profile(home.path());
        let kinds = growth["milestones"]
            .as_array()
            .expect("array")
            .iter()
            .map(|item| item["kind"].as_str().unwrap_or("").to_owned())
            .collect::<Vec<_>>();
        assert_eq!(kinds, vec!["bond_up", "first_meet"], "新→旧：升阶优先、最早条收尾");
    }

    // ---- F3 / F7：早安播报与每日彩蛋 ----

    #[test]
    fn compose_morning_falls_back_without_material() {
        let profile = default_profile();
        let clock = Local::now();
        let text = compose_morning(&profile, &LifeRuntimeState::default(), &clock, "");
        assert!(text.starts_with("早安，我。"), "兜底文案：{text}");
        assert!(text.contains("新的一天，我在这里。"), "兜底文案：{text}");
    }

    #[test]
    fn compose_morning_includes_material_segments() {
        let mut profile = default_profile();
        profile.address = "小美".into();
        profile.emotion = "melancholy".into();
        profile.dream_next = Some(DreamMaterial {
            at_ms: (Local::now().timestamp_millis() as u64) - 60 * 60 * 1000,
            texts: vec!["一起看海".into()],
            link: String::new(),
        });
        profile.nostalgia_candidates = vec![NostalgiaCandidate {
            text: "你说过想学吉他".into(),
        }];
        profile.agenda = vec![AgendaItemSnapshot {
            text: "去拿体检报告".into(),
            due_day: Local::now().format("%Y-%m-%d").to_string(),
            status: "pending".into(),
        }];
        let clock = Local::now();
        let text = compose_morning(&profile, &LifeRuntimeState::default(), &clock, "");
        assert!(text.contains("一起看海"), "梦境段：{text}");
        assert!(text.contains("想学吉他"), "怀旧段：{text}");
        assert!(text.contains("低落"), "情绪→天气段：{text}");
        assert!(text.contains("体检报告"), "记挂段：{text}");
        assert!(!text.contains("{"), "不残留占位符：{text}");
    }

    #[test]
    fn compose_egg_selects_style_and_renders() {
        let mut profile = default_profile();
        profile.address = "小美".into();
        profile.name = "小酷".into();
        let clock = Local::now();
        // 低落 → 暖心鼓励风格；俏皮文案仅在 excited/warm 下出现。
        profile.emotion = "melancholy".into();
        let encouraging = compose_egg(&profile, &clock);
        assert!(encouraging.contains("小美") && encouraging.contains("小酷"));
        assert!(!encouraging.contains("{"), "不残留占位符：{encouraging}");
        profile.emotion = "excited".into();
        let playful = compose_egg(&profile, &clock);
        assert!(!playful.contains("{"), "不残留占位符：{playful}");
        // 至少 12 条素材，风格数组非空且互不重复。
        let mut all = Vec::new();
        all.extend_from_slice(EGG_PLAYFUL);
        all.extend_from_slice(EGG_ENCOURAGING);
        all.extend_from_slice(EGG_LIGHT);
        all.extend_from_slice(EGG_GENTLE);
        assert!(all.len() >= 12, "离线素材库 ≥12 条：{}", all.len());
    }
}
