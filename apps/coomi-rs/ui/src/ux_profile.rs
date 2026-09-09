//! 用户体验改进计划：脱敏凝练用户偏好档案（场景偏好 / 任务偏好 / 高频环境问题）。
//!
//! 本地优先：档案存 `{coomi_home}/ux_profile/`，对用户只读展示；
//! 仅当用户显式同意（consent = "joined"）后才把脱敏档案上传到服务端。
//! 凝练在 tokio 后台任务执行，不阻塞会话、不写入会话历史。

use anyhow::{anyhow, Context, Result};
use coomi_engine::{ChatMessage, ModelProvider, ModelRequest, Role, SessionStore};
use serde_json::{json, Value};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const UPLOAD_ENDPOINT: &str = "https://updates.septemc.com/coomi/feedback/api/ux-profile";
/// 每次凝练最多扫描的会话数与用户消息数（成本护栏）。
const MAX_SESSIONS: usize = 40;
const MAX_USER_MESSAGES: usize = 600;
const MAX_ERROR_SUMMARIES: usize = 120;
const MAX_LESSONS: usize = 40;
const MAX_PROFILE_BYTES: usize = 64 * 1024;
/// 自动更新节奏：7 天且期间有新消息才跑。
pub const AUTO_UPDATE_INTERVAL_DAYS: i64 = 7;

static BUSY: AtomicBool = AtomicBool::new(false);
pub fn is_busy() -> bool {
    BUSY.load(Ordering::SeqCst)
}

// ── 路径 ──

fn profile_dir(home: &Path) -> PathBuf {
    home.join("ux_profile")
}
fn profile_path(home: &Path) -> PathBuf {
    profile_dir(home).join("profile.json")
}
fn status_path(home: &Path) -> PathBuf {
    profile_dir(home).join("status.json")
}
fn client_id_path(home: &Path) -> PathBuf {
    profile_dir(home).join("client_id.txt")
}

// ── status.json：consent / auto_update / 记账 ──

fn default_status() -> Value {
    json!({
        "consent": "undecided",            // undecided | joined | local_only
        "auto_update": true,
        "never_ask": false,                // 会话页邀请浮条「不要再出现」（引擎侧持久化：
                                           // WebView localStorage 按随机端口隔离，重启即丢）
        "busy": false,
        "last_generated_at": "",
        "last_error": "",
        "last_user_message_count": 0,
        "last_upload_at": ""
    })
}

fn read_status(home: &Path) -> Value {
    std::fs::read_to_string(status_path(home))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(default_status)
}

fn write_status(home: &Path, status: &Value) -> Result<()> {
    std::fs::create_dir_all(profile_dir(home))?;
    std::fs::write(status_path(home), serde_json::to_string_pretty(status)?)?;
    Ok(())
}

pub fn consent(home: &Path) -> String {
    read_status(home)
        .get("consent")
        .and_then(Value::as_str)
        .unwrap_or("undecided")
        .to_owned()
}

pub fn set_consent(home: &Path, value: &str) -> Result<()> {
    if !matches!(value, "joined" | "local_only" | "undecided") {
        return Err(anyhow!("invalid consent value"));
    }
    let mut status = read_status(home);
    status["consent"] = json!(value);
    write_status(home, &status)?;
    Ok(())
}

pub fn set_auto_update(home: &Path, enabled: bool) -> Result<()> {
    let mut status = read_status(home);
    status["auto_update"] = json!(enabled);
    write_status(home, &status)?;
    Ok(())
}

/// 记录用户退出计划的原因（运营侧了解流失原因；仅存本地状态文件）。
pub fn set_exit_reason(home: &Path, reason: &str) -> Result<()> {
    let mut status = read_status(home);
    status["exit_reason"] = json!(reason.chars().take(200).collect::<String>());
    write_status(home, &status)?;
    Ok(())
}

/// 会话页邀请浮条「不要再出现」开关（与计划页开关同步，引擎侧持久化）。
pub fn set_never_ask(home: &Path, enabled: bool) -> Result<()> {
    let mut status = read_status(home);
    status["never_ask"] = json!(enabled);
    write_status(home, &status)?;
    Ok(())
}

pub fn never_ask(home: &Path) -> bool {
    read_status(home)
        .get("never_ask")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub fn read_profile(home: &Path) -> Option<Value> {
    std::fs::read_to_string(profile_path(home))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

/// 计划页状态汇总（GET /api/ux-program）。
pub fn summary(home: &Path) -> Value {
    let status = read_status(home);
    json!({
        "consent": status.get("consent").cloned().unwrap_or(json!("undecided")),
        "auto_update": status.get("auto_update").cloned().unwrap_or(json!(true)),
        "never_ask": status.get("never_ask").cloned().unwrap_or(json!(false)),
        "busy": is_busy(),
        "last_generated_at": status.get("last_generated_at").cloned().unwrap_or(json!("")),
        "last_error": status.get("last_error").cloned().unwrap_or(json!("")),
        "has_profile": read_profile(home).is_some(),
        "profile": read_profile(home),
    })
}

// ── client_id（随机安装标识，不含设备个人信息）──

fn client_id(home: &Path) -> Result<String> {
    let path = client_id_path(home);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let id = existing.trim().to_owned();
        if id.len() >= 8 {
            return Ok(id);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::create_dir_all(profile_dir(home))?;
    std::fs::write(&path, &id)?;
    Ok(id)
}

// ── 采样 ──

struct Sample {
    user_messages: Vec<String>,
    error_summaries: Vec<String>,
    sensitive_counts: std::collections::BTreeMap<String, usize>,
    sessions_scanned: usize,
}

fn is_sensitive(text: &str) -> Option<&'static str> {
    // 身份证（18 位）/ 银行卡（16-19 位数字串）/ 手机号 → 私人信息处理
    let digits: Vec<char> = text.chars().collect();
    let mut run = 0usize;
    for ch in digits.iter().copied().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() {
            run += 1;
        } else {
            if run >= 16 && run <= 19 {
                return Some("私人信息处理");
            }
            run = 0;
        }
    }
    let lower = text.to_lowercase();
    const PRIVATE_KEYWORDS: [&str; 10] = [
        "身份证", "银行卡", "户口", "病历", "医院", "确诊", "离婚", "征信", "还款日", "验证码是",
    ];
    if PRIVATE_KEYWORDS.iter().any(|k| lower.contains(k)) {
        return Some("私人信息处理");
    }
    const ENTERTAINMENT_KEYWORDS: [&str; 7] =
        ["游戏", "追剧", "电视剧", "电影", "小说", "短视频", "篮球赛"];
    if ENTERTAINMENT_KEYWORDS.iter().any(|k| lower.contains(k)) {
        return Some("个人娱乐");
    }
    None
}

/// 打码：密钥形态 / 邮箱 / 手机号（保留其余原文，保证画像不宽泛）。
fn mask_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        let rest: String = chars[index..].iter().collect::<String>();
        let lower = rest.to_lowercase();
        if lower.starts_with("sk-") || lower.starts_with("bearer ") {
            for _ in 0..8.min(chars.len() - index) {
                out.push('*');
            }
            while index < chars.len() && !chars[index].is_whitespace() {
                index += 1;
            }
            continue;
        }
        if chars[index] == '@' {
            // 邮箱：吞掉前一段连续非空白 + @域名
            while !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
                out.pop();
            }
            out.push_str("***@***");
            while index < chars.len() && !chars[index].is_whitespace() {
                index += 1;
            }
            continue;
        }
        // 手机号：1[3-9] + 9 位数字，前后非数字
        if chars[index] >= '1'
            && chars[index] <= '9'
            && (index == 0 || !chars[index - 1].is_ascii_digit())
        {
            let run: Vec<char> = chars[index..]
                .iter()
                .copied()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if run.len() == 11 && matches!(run[0], '1') && ('3'..='9').contains(&run[1]) {
                out.push_str("1*********");
                index += run.len();
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn sample_sessions(home: &Path) -> Result<Sample> {
    let store = SessionStore::new(home);
    let sessions_dir = home.join("sessions");
    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&sessions_dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|path| {
            let modified = std::fs::metadata(&path).and_then(|meta| meta.modified()).ok()?;
            Some((modified, path))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.truncate(MAX_SESSIONS);

    let mut sample = Sample {
        user_messages: Vec::new(),
        error_summaries: Vec::new(),
        sensitive_counts: std::collections::BTreeMap::new(),
        sessions_scanned: 0,
    };
    for (_, path) in entries {
        let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let Ok(id) = uuid::Uuid::parse_str(file_stem) else {
            continue;
        };
        let Ok(session) = store.load(id) else {
            continue;
        };
        sample.sessions_scanned += 1;
        let mut user_taken = 0usize;
        for message in &session.messages {
            if message.internal || message.compaction_summary {
                continue;
            }
            if message.role == Role::User && user_taken < 8 {
                let text = message.content.trim();
                if text.len() < 4 {
                    continue;
                }
                let truncated: String = text.chars().take(200).collect();
                if let Some(bucket) = is_sensitive(&truncated) {
                    *sample.sensitive_counts.entry(bucket.to_owned()).or_insert(0) += 1;
                } else if sample.user_messages.len() < MAX_USER_MESSAGES {
                    sample
                        .user_messages
                        .push(mask_secrets(&truncated));
                }
                user_taken += 1;
            }
            if message.role == Role::Tool
                && sample.error_summaries.len() < MAX_ERROR_SUMMARIES
                && let Some(("error", rest)) = message.content.split_once(": ")
            {
                let summary: String = mask_secrets(&rest.chars().take(120).collect::<String>());
                sample.error_summaries.push(summary);
            }
        }
    }
    Ok(sample)
}

// ── 凝练提示词 ──

const DISTILL_PROMPT: &str = r#"
你是用户研究分析师。输入是某用户近 30 天与 AI 助手 Coomi 的交互采样（用户消息已脱敏：密钥/邮箱/手机号已打码；极私密消息不出现在输入中，只提供其分类计数）、工具调用错误摘要、以及此前沉淀的环境经验。

请凝练这份用户画像，只输出一个严格 JSON 对象（无 Markdown 围栏、无解释）：
{
  "scene_preferences": [
    {"category": "大类", "weight": 0.0,
     "subcategories": [{"name": "小类", "level": "high", "count": 3, "example": "脱敏示例（不超过30字）"}]}
  ],
  "task_preferences": [
    {"dimension": "执行方式", "preference": "不超过40字", "evidence": 3}
  ],
  "environment_issues": [
    {"category": "权限", "issue": "不超过40字", "frequency": 2, "workaround": "不超过40字"}
  ],
  "sensitive_summary": [{"category": "私人信息处理", "count": 1}]
}

规则：
- category 只能从：编程开发、系统运维、文档写作、数据处理、学习研究、设计创作、生活助手、个人娱乐、私人信息处理、其他 中选择。
- subcategories 的小类名要具体（如「脚本自动化」「Android 调试」），每大类最多 12 个；sensitive_summary 的两个敏感大类不得出现在 scene_preferences 里。
- task_preferences 维度可从：执行方式、汇报粒度、交互语言、代码风格、常用配置、任务结构 等中选择，必须有输入证据支撑（evidence 为出现次数估计）。
- weight 为该大类占全部场景的比重估计（0-1，全部加起来接近 1）；level 为 high/medium/low。
- 样本少时如实降低 level 与 weight，不要夸大；输入中的 [环境经验] 条目优先计入 environment_issues。
"#;

fn build_distill_input(sample: &Sample, lessons: &[coomi_experience::Lesson]) -> String {
    let mut sections = String::new();
    sections.push_str(&format!(
        "【用户消息采样】共 {} 条（已脱敏；私密消息未包含，仅计入 sensitive_summary）：\n",
        sample.user_messages.len()
    ));
    for (index, message) in sample.user_messages.iter().enumerate() {
        sections.push_str(&format!("{}. {}\n", index + 1, message));
    }
    if !sample.error_summaries.is_empty() {
        sections.push_str(&format!("\n【工具调用错误摘要】共 {} 条：\n", sample.error_summaries.len()));
        for (index, error) in sample.error_summaries.iter().enumerate() {
            sections.push_str(&format!("{}. {}\n", index + 1, error));
        }
    }
    if !lessons.is_empty() {
        sections.push_str("\n[环境经验]（已验证的解决方式）：\n");
        for lesson in lessons.iter().take(MAX_LESSONS) {
            sections.push_str(&format!(
                "- [{}] {} → {}\n",
                lesson.category, lesson.symptom, lesson.resolution
            ));
        }
    }
    if !sample.sensitive_counts.is_empty() {
        sections.push_str("\n【敏感消息计数（内容不可见，仅归类）】\n");
        for (category, count) in &sample.sensitive_counts {
            sections.push_str(&format!("- {category}: {count} 条\n"));
        }
    }
    sections
}

// ── 生成 ──

/// 启动后台凝练任务。busy 时返回错误（不重复触发）。
pub fn start_generate(home: PathBuf, provider_config: coomi_services::ProviderConfig) -> Result<()> {
    if BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(anyhow!("profile generation already running"));
    }
    let mut status = read_status(&home);
    status["busy"] = json!(true);
    let _ = write_status(&home, &status);
    tokio::spawn(async move {
        if let Err(error) = generate_sync(&home, provider_config).await {
            eprintln!("[ux-profile] generation failed: {error:#}");
            let mut status = read_status(&home);
            status["last_error"] = json!(format!("{error:#}"));
            let _ = write_status(&home, &status);
        }
        BUSY.store(false, Ordering::SeqCst);
        let mut status = read_status(&home);
        status["busy"] = json!(false);
        let _ = write_status(&home, &status);
    });
    Ok(())
}

async fn generate_sync(home: &Path, provider_config: coomi_services::ProviderConfig) -> Result<()> {
    let sample = sample_sessions(home)?;
    if sample.user_messages.len() < 3 {
        return Err(anyhow!(
            "样本不足：近 30 天仅 {} 条可用用户消息，请先正常使用一段时间",
            sample.user_messages.len()
        ));
    }
    let lessons = coomi_experience::load_lessons(home);
    let input = build_distill_input(&sample, &lessons);

    let provider = coomi_services::HttpModelProvider::new(provider_config)?;
    let request = ModelRequest {
        model: provider.model().to_owned(),
        messages: vec![
            ChatMessage::system(DISTILL_PROMPT),
            ChatMessage::user(input),
        ],
        tools: Vec::new(),
        reasoning_effort: Some("low".to_owned()),
    };
    let response = tokio::time::timeout(Duration::from_secs(300), provider.complete(request))
        .await
        .map_err(|_| anyhow!("profile generation timed out"))??;
    let content = response.content;
    let start = content.find('{').ok_or_else(|| anyhow!("no JSON in output"))?;
    let end = content.rfind('}').ok_or_else(|| anyhow!("no JSON in output"))?;
    let mut profile: Value =
        serde_json::from_str(&content[start..=end]).context("invalid profile JSON")?;

    // 合并敏感计数（模型不可见的部分以本地规则为准）。
    let sensitive: Vec<Value> = sample
        .sensitive_counts
        .iter()
        .map(|(category, count)| json!({"category": category, "count": count}))
        .collect();
    profile["sensitive_summary"] = json!(sensitive);
    profile["version"] = json!(1);
    profile["generated_at"] = json!(chrono::Utc::now().to_rfc3339());
    profile["period"] = json!({
        "from": (chrono::Utc::now() - chrono::Duration::days(30)).date_naive().to_string(),
        "to": chrono::Utc::now().date_naive().to_string(),
        "sessions_scanned": sample.sessions_scanned,
        "user_messages_scanned": sample.user_messages.len(),
    });
    let quality = if sample.user_messages.len() >= 20 { "sufficient" } else { "thin" };
    profile["sample_quality"] = json!(quality);

    let serialized = serde_json::to_string(&profile)?;
    if serialized.len() > MAX_PROFILE_BYTES {
        return Err(anyhow!("profile too large"));
    }
    std::fs::create_dir_all(profile_dir(home))?;
    std::fs::write(profile_path(home), serialized)?;

    let mut status = read_status(home);
    status["last_generated_at"] = json!(chrono::Utc::now().to_rfc3339());
    status["last_error"] = json!("");
    status["last_user_message_count"] = json!(sample.user_messages.len());
    write_status(home, &status)?;

    // 已加入计划：新档案自动上传。
    if consent(home) == "joined" {
        upload(home);
    }
    Ok(())
}

// ── 上传（脱敏档案 + 随机 client_id）──

pub fn upload(home: &Path) {
    let Some(profile) = read_profile(home) else {
        return;
    };
    let Ok(client) = client_id(home) else {
        return;
    };
    let payload = json!({
        "client_id": client,
        "profile": profile,
        "schema": "coomi-ux-profile/1",
    });
    let body = payload.to_string();
    let _ = std::thread::Builder::new()
        .name("coomi-ux-upload".to_owned())
        .spawn(move || {
            let result = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .and_then(|client| {
                    client
                        .post(UPLOAD_ENDPOINT)
                        .header("Content-Type", "application/json")
                        .body(body)
                        .send()
                });
            match result {
                Ok(response) if response.status().is_success() => {
                    eprintln!("[ux-profile] profile uploaded");
                }
                Ok(response) => {
                    eprintln!("[ux-profile] upload rejected: HTTP {}", response.status())
                }
                Err(error) => eprintln!("[ux-profile] upload skipped: {error}"),
            }
        });
}

// ── 每周自动更新（引擎启动时检查）──

pub async fn startup_refresh(home: PathBuf) {
    let status = read_status(&home);
    if !status.get("auto_update").and_then(Value::as_bool).unwrap_or(true) {
        return;
    }
    if read_profile(&home).is_none() {
        return; // 用户从未生成过画像：不主动跑（首次必须显式触发）
    }
    if is_busy() {
        return;
    }
    let last = status
        .get("last_generated_at")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Ok(last_time) = chrono::DateTime::parse_from_rfc3339(last) else {
        return;
    };
    if chrono::Utc::now().signed_duration_since(last_time.with_timezone(&chrono::Utc))
        < chrono::Duration::days(AUTO_UPDATE_INTERVAL_DAYS)
    {
        return;
    }
    // 有新会话活动才值得更新（对比上次消息数由采样本身衡量，这里只看会话文件 mtime）。
    let Ok(registry) = coomi_services::ProviderRegistry::load(&home.join("config").join("providers.json")) else {
        return;
    };
    let Ok(provider_config) = registry.resolve(None) else {
        return;
    };
    eprintln!("[ux-profile] weekly auto refresh started");
    let _ = start_generate(home, provider_config);
}
