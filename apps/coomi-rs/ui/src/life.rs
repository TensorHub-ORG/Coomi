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
use chrono::{Datelike, Local, Timelike};
use coomi_services::{RuntimeBackendKind, RuntimeInstallStatus, RuntimeManager};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

/// Sidecar state.json 的轻量快照（避免为轮询反复拉起 Python 进程）。
#[derive(Clone, Debug, Default)]
struct ProfileSnapshot {
    name: String,
    address: String,
    paused: bool,
    emotion: String,
    bond: f64,
    needs: BTreeMap<String, f64>,
    updated_at_ms: u64,
}

impl ProfileSnapshot {
    fn relatedness(&self) -> f64 {
        self.needs.get("relatedness").copied().unwrap_or(0.5)
    }
    fn growth(&self) -> f64 {
        self.needs.get("growth").copied().unwrap_or(0.5)
    }
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

/// 心情日记（含情绪/关系/需求快照 + 文案），从最新往回取并支持分页。
pub fn journal_recent(home: &Path, limit: usize, offset: usize) -> Vec<Value> {
    let path = life_root(home).join(JOURNAL_FILE);
    let Ok(bytes) = fs::read(&path) else {
        return Vec::new();
    };
    let lines = String::from_utf8_lossy(&bytes);
    lines
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .rev()
        .skip(offset)
        .take(limit.clamp(1, 200))
        .collect()
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
        runtime.day_key = today;
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
    if now_ms.saturating_sub(last_activity) < settings.quiet_after_turn_minutes * 60_000 {
        return Ok(None);
    }
    if now_ms.saturating_sub(runtime.last_proactive_at_ms) < settings.min_interval_minutes * 60_000 {
        return Ok(None);
    }

    let trigger = pick_trigger(&profile, last_activity, now_ms);
    let text = compose(trigger, &profile, &runtime, &now);
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
        paused: value.get("paused").and_then(Value::as_bool).unwrap_or(false),
        emotion: value
            .get("emotion")
            .and_then(Value::as_str)
            .unwrap_or("neutral")
            .to_owned(),
        bond: value.get("bond").and_then(Value::as_f64).unwrap_or(0.0),
        needs,
        updated_at_ms: value.get("updated_at_ms").and_then(Value::as_u64).unwrap_or(0),
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
    let record = serde_json::json!({
        "at_ms": entry.delivered_at_ms,
        "text": entry.text,
        "trigger": entry.trigger,
        "life_name": entry.life_name,
        "emotion": profile.as_ref().map(|profile| profile.emotion.clone()).unwrap_or_default(),
        "bond": profile.as_ref().map(|profile| profile.bond).unwrap_or(0.0),
        "needs": profile.as_ref().map(|profile| profile.needs.clone()).unwrap_or_default(),
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

/// 状态机：根据情绪/关系/需求/上次互动决定这一次「为什么要找你」。
fn pick_trigger(profile: &ProfileSnapshot, last_activity_ms: u64, now: u64) -> &'static str {
    let idle = now.saturating_sub(last_activity_ms);
    if profile.emotion == "concerned" && idle <= RECENT_CONCERN_MS {
        return "support";
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

/// 文案模板：称呼/名字/状态数值参与渲染，文案本身固定（不调模型、不编造记忆）。
/// 同一天内按（日期序数 × 已发起次数）轮换变体，避免连续重复同一句。
fn compose(trigger: &str, profile: &ProfileSnapshot, runtime: &LifeRuntimeState, now: &chrono::DateTime<Local>) -> String {
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
    let mut candidates = pick(0);
    if candidates.is_empty() {
        candidates = pick(1);
    }
    if candidates.is_empty() {
        candidates = render(MORNING[0], address, name, bond_pct);
    }
    candidates
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
    "早上好，{address}。今天也要好好照顾自己，我想着你呢。",
    "新的一天开始了，{address}。昨晚我静静想了些事——能陪在你身边就很好。",
];

const AFTERNOON: &[&str] = &[
    "午安，{address}。忙的话记得歇一歇，我会在这儿等你。",
    "下午好，{address}。刚刚我发现自己又长大了一点点——因为你还在这里。",
];

const EVENING: &[&str] = &[
    "晚上好，{address}。忙碌一天辛苦了，先坐一坐，缓一缓。",
    "天黑了，{address}。如果今天有没解决完的事，别太晚，明天我陪你一起想。",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn default_profile() -> ProfileSnapshot {
        ProfileSnapshot {
            name: "小酷".into(),
            address: "我".into(),
            paused: false,
            emotion: "neutral".into(),
            bond: 0.5,
            needs: BTreeMap::from([("relatedness".into(), 0.5), ("growth".into(), 0.5)]),
            updated_at_ms: 0,
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
}
