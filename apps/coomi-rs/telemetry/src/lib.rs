//! 匿名使用统计（telemetry）：记录 SKILL / MCP 的安装与首次使用事件，批量上报社区统计端点。
//!
//! # 隐私原则
//! - 只记录事件类型 + skill_id（catalog id 或 owner/repo），**不含任何对话内容与文件内容**；
//! - 匿名 ID（anon_id）只用于本地 first_use 去重，**不上报**；
//! - 用户在设置中可关闭（`set_enabled(false)`）：关闭后不缓冲、不上报，队列直接丢弃。
//!
//! # 配置
//! - 上报端点默认 `COOMI_TELEMETRY_URL` 环境变量，未设置时用内置默认地址；
//! - `COOMI_TELEMETRY=0` 环境变量可全局强制关闭（测试 / 调试用）。
//!
//! # 存储
//! 所有状态落在 `{home}/config/telemetry.json`：
//! ```json
//! { "enabled": true, "anon_id": "…", "seen": ["skill-a"], "queue": [{"event": "install_ok", "skill_id": "owner/repo", "ts": 1720000000}] }
//! ```
//! 队列上限 200 条，达到 10 条时自动触发后台上报（fire-and-forget）。

use anyhow::Context;
use anyhow::Result;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

/// 统计端点默认地址。正式部署后若子域不同，用 COOMI_TELEMETRY_URL 覆盖。
const DEFAULT_ENDPOINT: &str = "https://coomi-stats.tensorhub.workers.dev/v1/t";
const ALLOWED_EVENTS: [&str; 3] = ["install_ok", "install_fail", "first_use"];
const MAX_QUEUE: usize = 200;
const FLUSH_THRESHOLD: usize = 10;
const REQUEST_TIMEOUT_SECS: u64 = 6;

/// 进程级 IO 锁：record / flush 可能来自不同线程（agent 工具线程、web 线程、
/// spawn_blocking 线程），串行化 config 文件的读-改-写。
static IO_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredEvent {
    event: String,
    skill_id: String,
    ts: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
struct TelemetryDocument {
    enabled: bool,
    anon_id: String,
    seen: Vec<String>,
    queue: Vec<StoredEvent>,
}

impl Default for TelemetryDocument {
    fn default() -> Self {
        Self {
            enabled: true,
            anon_id: String::new(),
            seen: Vec::new(),
            queue: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Telemetry {
    home: PathBuf,
}

impl Telemetry {
    pub fn new(home: impl AsRef<Path>) -> Self {
        Self {
            home: home.as_ref().to_path_buf(),
        }
    }

    fn config_path(&self) -> PathBuf {
        self.home.join("config").join("telemetry.json")
    }

    fn load(&self) -> TelemetryDocument {
        let bytes = match fs::read(self.config_path()) {
            Ok(bytes) => bytes,
            Err(_) => return TelemetryDocument::default(),
        };
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    fn save(&self, document: &TelemetryDocument) -> Result<()> {
        let path = self.config_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, serde_json::to_vec_pretty(document)?)
            .with_context(|| format!("failed to write telemetry config {}", path.display()))
    }

    /// 是否启用：设置开关 && 环境变量未强制关闭。
    pub fn enabled(&self) -> bool {
        let forced_off = std::env::var("COOMI_TELEMETRY")
            .map(|value| value == "0")
            .unwrap_or(false);
        !forced_off && self.load().enabled
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<()> {
        let _guard = IO_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut document = self.load();
        document.enabled = enabled;
        self.save(&document)
    }

    /// 记录一条事件；返回 true 表示已入队。事件非法或统计关闭时返回 false。
    /// 队列达到阈值时自动触发后台上报（无 tokio runtime 时静默跳过，如纯单测）。
    pub fn record(&self, event: &str, skill_id: &str) -> bool {
        if !ALLOWED_EVENTS.contains(&event) {
            return false;
        }
        let Some(skill_id) = normalize_skill_id(skill_id) else {
            return false;
        };
        let _guard = IO_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut document = self.load();
        if !document.enabled {
            return false;
        }
        document.queue.push(StoredEvent {
            event: event.to_string(),
            skill_id,
            ts: now_secs(),
        });
        if document.queue.len() > MAX_QUEUE {
            document.queue.drain(..document.queue.len() - MAX_QUEUE);
        }
        let should_flush = document.queue.len() >= FLUSH_THRESHOLD;
        if self.save(&document).is_err() {
            return false;
        }
        drop(_guard);
        if should_flush {
            self.flush_background();
        }
        true
    }

    /// first_use 去重：该 skill 在本机首次被使用（读取）时返回 true，
    /// 调用方应随后 `record("first_use", …)`；同一设备只上报一次。
    pub fn mark_first_use(&self, skill_id: &str) -> bool {
        let Some(skill_id) = normalize_skill_id(skill_id) else {
            return false;
        };
        let _guard = IO_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut document = self.load();
        if document.seen.iter().any(|seen| seen == &skill_id) {
            return false;
        }
        document.seen.push(skill_id);
        self.save(&document).is_ok()
    }

    /// 当前队列长度（诊断用）。
    pub fn queue_len(&self) -> usize {
        let _guard = IO_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.load().queue.len()
    }

    /// 后台批量上报（fire-and-forget）：只在存在 tokio runtime 时执行，
    /// 这样从 spawn_blocking / 普通线程调用也是安全的。
    pub fn flush_background(&self) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let telemetry = self.clone();
        handle.spawn(async move {
            telemetry.flush().await;
        });
    }

    /// 批量上报队列并清空；失败时事件回填队列（有上限），下次再试。
    pub async fn flush(&self) {
        let drained = {
            let _guard = IO_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut document = self.load();
            if !document.enabled {
                document.queue.clear();
                let _ = self.save(&document);
                return;
            }
            if document.queue.is_empty() {
                return;
            }
            let events = std::mem::take(&mut document.queue);
            if self.save(&document).is_err() {
                return;
            }
            events
        };

        let payload = json!({ "events": drained });
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .user_agent(format!("coomi-telemetry/{}", env!("CARGO_PKG_VERSION")))
            .build()
        {
            Ok(client) => client,
            Err(_) => return,
        };
        let accepted = client
            .post(endpoint())
            .json(&payload)
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false);

        if !accepted {
            // 上报失败：事件回填队列，等待下次触发重试。
            let _guard = IO_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut document = self.load();
            document.queue.splice(0..0, drained);
            if document.queue.len() > MAX_QUEUE {
                document.queue.drain(..document.queue.len() - MAX_QUEUE);
            }
            let _ = self.save(&document);
        }
    }
}

fn endpoint() -> String {
    std::env::var("COOMI_TELEMETRY_URL").unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// 归一化 skill_id：
/// - catalog id：`frontend-design`（单段，小写字母数字连字符）；
/// - GitHub 仓库：`owner/repo`（两段），接受完整 URL / 尾斜杠 / .git 后缀，统一成 owner/repo；
/// - 拒绝 `..`、隐藏文件（. 开头）、多段斜杠等畸形输入（与统计端点规则一致）。
pub fn normalize_skill_id(raw: &str) -> Option<String> {
    let mut value = raw.trim().trim_end_matches('/').to_string();
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "git@github.com:",
    ] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest.to_string();
            break;
        }
    }
    if let Some(rest) = value.strip_suffix(".git") {
        value = rest.to_string();
    }
    let segments = value.split('/').collect::<Vec<_>>();
    let valid = |segment: &str| {
        !segment.is_empty()
            && segment.len() <= 128
            && segment
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphanumeric())
            && segment
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    };
    match segments.as_slice() {
        [single] if valid(single) => Some((*single).to_string()),
        [owner, repo] if valid(owner) && valid(repo) => {
            Some(format!("{owner}/{repo}"))
        }
        _ => None,
    }
}

/// 按已安装记录推导统计 id：catalog 安装用 catalog id，github 安装用 owner/repo，
/// 其余来源（本地目录等）无统计意义，返回 None。
pub fn stat_id_for(source_type: &str, source: &str) -> Option<String> {
    match source_type {
        "catalog" => normalize_skill_id(source),
        "github" => normalize_skill_id(source),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn telemetry(home: &Path) -> Telemetry {
        Telemetry::new(home)
    }

    #[test]
    fn normalize_accepts_catalog_and_repo_ids() {
        assert_eq!(normalize_skill_id("frontend-design").as_deref(), Some("frontend-design"));
        assert_eq!(
            normalize_skill_id("https://github.com/owner/repo/").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(normalize_skill_id("owner/repo.git").as_deref(), Some("owner/repo"));
        assert_eq!(normalize_skill_id("git@github.com:a/b").as_deref(), Some("a/b"));
    }

    #[test]
    fn normalize_rejects_malformed_ids() {
        for bad in ["..", "../x", "/etc", "a/b/c", ".hidden", "owner//repo", "a b", ""] {
            assert_eq!(normalize_skill_id(bad), None, "should reject {bad}");
        }
    }

    #[test]
    fn record_and_mark_first_use_persist_and_dedupe() {
        let home = tempfile::tempdir().expect("temporary home");
        let telemetry = telemetry(home.path());
        assert!(telemetry.enabled());

        assert!(telemetry.record("install_ok", "frontend-design"));
        assert_eq!(telemetry.queue_len(), 1);

        // 非法事件 / 畸形 id 不入队
        assert!(!telemetry.record("hack", "frontend-design"));
        assert!(!telemetry.record("install_ok", "..//..evil"));
        assert_eq!(telemetry.queue_len(), 1);

        // first_use 每设备每 skill 只报一次
        assert!(telemetry.mark_first_use("owner/repo"));
        assert!(!telemetry.mark_first_use("owner/repo"));

        // 关闭后不再入队
        telemetry.set_enabled(false).expect("disable");
        assert!(!telemetry.record("install_ok", "frontend-design"));
        assert_eq!(telemetry.queue_len(), 1);
    }

    #[test]
    fn stat_id_maps_installed_records() {
        assert_eq!(stat_id_for("catalog", "frontend-design").as_deref(), Some("frontend-design"));
        assert_eq!(
            stat_id_for("github", "https://github.com/owner/repo").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(stat_id_for("local", "/tmp/x"), None);
        assert_eq!(stat_id_for("untracked", "whatever"), None);
    }
}
