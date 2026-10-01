//! 工具质量层（批 5）。
//!
//! 统一在 CoreTools::call 这一层对每次工具调用做质量加固，全部由能力开关 toolEnhance 控制，
//! 关闭时不介入任何一次调用（行为与改造前一致）：
//! 1. 参数按 schema 校验：缺参/类型错给可读错误，绝不 panic；
//! 2. 瞬时失败有界重试（次数与退避可配置，只重试只读幂等工具）；
//! 3. 每工具超时（只对只读白名单工具生效，交互/长任务工具不设超时）；
//! 4. 并发上限（同一轮内并行工具调用的信号量）；
//! 5. 结果裁剪：超过行数/字节上限时写临时文件并返回路径，而不是把几十万字符塞进上下文；
//! 6. 只读工具 LRU 缓存（带 TTL，任何写操作成功后整体失效）。

use coomi_engine::ToolResult;
use serde_json::Value;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use tokio::sync::Semaphore;

/// 可配置项。
#[derive(Clone, Debug)]
pub struct ToolQualityConfig {
    /// 瞬时失败重试次数（不含首次尝试）。
    pub max_retries: u32,
    /// 退避基数（毫秒），第 n 次重试等待 base * 2^(n-1)，上限 max_retry_backoff_ms。
    pub retry_backoff_ms: u64,
    /// 退避封顶（毫秒）。
    pub max_retry_backoff_ms: u64,
    /// 只读白名单工具的默认超时。
    pub default_timeout_ms: u64,
    /// 同一轮内并行工具调用上限。
    pub max_concurrency: usize,
    /// 结果字节上限，超出写临时文件。
    pub max_output_bytes: usize,
    /// 结果行数上限，超出写临时文件。
    pub max_output_lines: usize,
    /// 只读结果缓存容量（LRU）。
    pub cache_entries: usize,
    /// 缓存存活时间（毫秒）。
    pub cache_ttl_ms: u64,
    /// 溢出内容落盘目录，缺省用系统临时目录下的 coomi-tool-output。
    pub spill_directory: Option<PathBuf>,
}

impl Default for ToolQualityConfig {
    fn default() -> Self {
        Self {
            max_retries: 2,
            retry_backoff_ms: 200,
            max_retry_backoff_ms: 2_000,
            default_timeout_ms: 60_000,
            max_concurrency: 6,
            max_output_bytes: 48_000,
            max_output_lines: 1_000,
            cache_entries: 128,
            cache_ttl_ms: 10_000,
            spill_directory: None,
        }
    }
}

/// 允许设置超时与重试的只读、幂等工具（不会弹审批、不会长时间阻塞）。
const TIMEOUT_SAFE_TOOLS: &[&str] = &[
    "read_file",
    "list_dir",
    "glob_files",
    "grep_files",
    "file_search",
    "context_search",
    "web_search",
    "fetch",
    "web_fetch",
    "git_status",
    "git_diff",
    "git_log",
    "list_skills",
    "read_skill",
    "list_mcp",
    "list_workflows",
    "get_workflow",
    "get_loop",
    "memory_list",
    "memory_read",
    "memory_search",
    "team_files",
    "team_status",
    "list_claims",
];

/// 允许走 LRU 缓存的只读工具（结果稳定、无副作用）。
const CACHEABLE_TOOLS: &[&str] = &[
    "read_file",
    "list_dir",
    "glob_files",
    "grep_files",
    "file_search",
    "read_skill",
    "list_skills",
    "list_mcp",
    "list_workflows",
    "get_workflow",
    "memory_list",
    "memory_read",
    "memory_search",
    "git_status",
    "git_diff",
    "git_log",
];

/// 瞬时（可重试）错误特征。
const TRANSIENT_MARKERS: &[&str] = &[
    "timed out",
    "timeout",
    "time out",
    "connection reset",
    "connection refused",
    "connection closed",
    "broken pipe",
    "temporarily unavailable",
    "resource temporarily unavailable",
    "too many open files",
    "network is unreachable",
    "dns",
    "http 429",
    "http 502",
    "http 503",
    "http 504",
    "429 too many requests",
    "server error",
    "busy",
    "重试",
    "超时",
];

/// 不可重试（确定性）错误特征：参数/权限/不存在。
const FATAL_MARKERS: &[&str] = &[
    "missing string argument",
    "invalid",
    "denied",
    "not approved",
    "not found",
    "no such file",
    "缺少",
    "参数",
    "未找到",
    "拒绝",
    "未批准",
];

struct CacheEntry {
    result: ToolResult,
    at: Instant,
}

#[derive(Default)]
struct LruCache {
    entries: HashMap<String, CacheEntry>,
    order: VecDeque<String>,
}

impl LruCache {
    fn get(&mut self, key: &str, ttl: Duration) -> Option<ToolResult> {
        let entry = self.entries.get(key)?;
        if entry.at.elapsed() > ttl {
            self.entries.remove(key);
            self.order.retain(|item| item != key);
            return None;
        }
        let result = entry.result.clone();
        self.order.retain(|item| item != key);
        self.order.push_back(key.to_owned());
        Some(result)
    }

    fn put(&mut self, key: String, result: ToolResult, capacity: usize) {
        if capacity == 0 {
            return;
        }
        if self.entries.insert(key.clone(), CacheEntry { result, at: Instant::now() }).is_some() {
            self.order.retain(|item| item != &key);
        }
        self.order.push_back(key);
        while self.order.len() > capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.entries.remove(&evicted);
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// 工具质量层：一次运行内共享的并发闸、缓存与统计。
pub struct ToolQuality {
    config: ToolQualityConfig,
    permits: Semaphore,
    cache: Mutex<LruCache>,
    generation: Mutex<u64>,
    cache_hits: Mutex<u64>,
    cache_misses: Mutex<u64>,
    retries: Mutex<u64>,
}

impl ToolQuality {
    pub fn new(config: ToolQualityConfig) -> Self {
        let permits = Semaphore::new(config.max_concurrency.max(1));
        Self {
            config,
            permits,
            cache: Mutex::new(LruCache::default()),
            generation: Mutex::new(0),
            cache_hits: Mutex::new(0),
            cache_misses: Mutex::new(0),
            retries: Mutex::new(0),
        }
    }

    pub fn config(&self) -> &ToolQualityConfig {
        &self.config
    }

    /// 并发闸：同一轮内并行工具调用的上限。
    pub async fn acquire(&self) -> Option<tokio::sync::SemaphorePermit<'_>> {
        self.permits.acquire().await.ok()
    }

    /// 该工具是否设置超时。
    pub fn timeout_for(&self, tool: &str) -> Option<Duration> {
        TIMEOUT_SAFE_TOOLS
            .contains(&tool)
            .then(|| Duration::from_millis(self.config.default_timeout_ms.max(1_000)))
    }

    /// 该工具是否可缓存（只读白名单）。
    pub fn is_cacheable(&self, tool: &str) -> bool {
        CACHEABLE_TOOLS.contains(&tool)
    }

    /// 该工具是否只读幂等（允许瞬时失败重试）。
    pub fn is_retry_safe(&self, tool: &str) -> bool {
        TIMEOUT_SAFE_TOOLS.contains(&tool)
    }

    /// 重试退避时长（第 attempt 次重试，attempt 从 1 开始）。
    pub fn backoff(&self, attempt: u32) -> Duration {
        let shift = attempt.saturating_sub(1).min(6);
        let base = self.config.retry_backoff_ms.max(1);
        let millis = base.saturating_mul(1u64 << shift);
        Duration::from_millis(millis.min(self.config.max_retry_backoff_ms.max(base)))
    }

    /// 是否应当重试：只读幂等 + 结果失败 + 错误看起来是瞬时的。
    pub fn should_retry(&self, tool: &str, result: &ToolResult, attempt: u32) -> bool {
        attempt < self.config.max_retries
            && !result.success
            && self.is_retry_safe(tool)
            && is_transient_failure(&result.output)
    }

    /// 缓存键：工具名 + 规范化参数 + 工作目录 + 失效代次。
    pub fn cache_key(&self, tool: &str, arguments: &Value, cwd: &str) -> String {
        let generation = *self.generation.lock().unwrap_or_else(|error| error.into_inner());
        format!("{generation}|{cwd}|{tool}|{arguments}")
    }

    pub fn cached(&self, key: &str) -> Option<ToolResult> {
        let ttl = Duration::from_millis(self.config.cache_ttl_ms);
        let mut cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
        let hit = cache.get(key, ttl);
        let mut counter = self
            .cache_hits
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut misses = self
            .cache_misses
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if hit.is_some() {
            *counter = counter.saturating_add(1);
        } else {
            *misses = misses.saturating_add(1);
        }
        hit
    }

    /// 写入缓存：只缓存成功且无副作用的只读结果。
    pub fn store(&self, key: &str, result: &ToolResult) {
        if !result.success
            || result.plan.is_some()
            || result.loop_state.is_some()
            || !result.images.is_empty()
        {
            return;
        }
        let mut cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
        cache.put(key.to_owned(), result.clone(), self.config.cache_entries);
    }

    /// 写操作成功后整体失效（同一轮里先读后写不会读到旧内容）。
    pub fn invalidate(&self) {
        let mut generation = self.generation.lock().unwrap_or_else(|error| error.into_inner());
        *generation = generation.saturating_add(1);
        let mut cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
        cache.clear();
    }

    /// 记录一次重试（可观测）。
    pub fn note_retry(&self) {
        let mut counter = self.retries.lock().unwrap_or_else(|error| error.into_inner());
        *counter = counter.saturating_add(1);
    }

    /// (命中, 未命中, 重试次数, 缓存条目数)
    pub fn stats(&self) -> (u64, u64, u64, usize) {
        let hits = *self.cache_hits.lock().unwrap_or_else(|error| error.into_inner());
        let misses = *self
            .cache_misses
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let retries = *self.retries.lock().unwrap_or_else(|error| error.into_inner());
        let len = self.cache.lock().unwrap_or_else(|error| error.into_inner()).len();
        (hits, misses, retries, len)
    }

    /// 结果裁剪：超出行数/字节上限时把完整内容写入临时文件并返回文件路径。
    pub fn trim_output(&self, tool: &str, output: String) -> String {
        if output.len() <= self.config.max_output_bytes
            && output.lines().count() <= self.config.max_output_lines
        {
            return output;
        }
        let head = take_head(&output, self.config.max_output_bytes / 2, 200);
        let tail = take_tail(&output, self.config.max_output_bytes / 4, 60);
        let bytes = output.len();
        let lines = output.lines().count();
        let spill = self.spill(tool, &output);
        match spill {
            Some(path) => format!(
                "{head}\n\n[... 中间内容省略：共 {lines} 行 / {bytes} 字节，超过上限（{} 行 / {} 字节）]\n\n{tail}\n\n[完整输出已写入临时文件：{path}，如需查看请用 read_file 分段读取]",
                self.config.max_output_lines, self.config.max_output_bytes
            ),
            None => format!(
                "{head}\n\n[... 内容过长已截断：共 {lines} 行 / {bytes} 字节，超过上限（{} 行 / {} 字节）；且临时文件写入失败]\n\n{tail}",
                self.config.max_output_lines, self.config.max_output_bytes
            ),
        }
    }

    /// 把超限结果落盘，返回文件路径（失败返回 None）。
    fn spill(&self, tool: &str, output: &str) -> Option<String> {
        let directory = self
            .config
            .spill_directory
            .clone()
            .unwrap_or_else(|| std::env::temp_dir().join("coomi-tool-output"));
        std::fs::create_dir_all(&directory).ok()?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0);
        let safe_tool = tool
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
            .collect::<String>();
        let path = directory.join(format!(
            "{}-{}-{stamp}.txt",
            if safe_tool.is_empty() { "tool" } else { &safe_tool },
            std::process::id()
        ));
        std::fs::write(&path, output).ok()?;
        Some(path.display().to_string())
    }
}

/// 处理器自带默认值、因此不能被必填校验拦下的参数键。
/// schema 仍然照原样展示给模型，只是校验层放行缺省，避免把合法的简化调用判成参数错误。
const REQUIRED_KEY_EXEMPTIONS: &[(&str, &[&str])] = &[("local_shell", &["action"])];

/// 参数按 schema 校验：返回可读中文错误（多条用「；」连接）。不会 panic。
pub fn validate_arguments(name: &str, schema: &Value, arguments: &Value) -> Result<(), String> {
    let object = match arguments {
        Value::Null => None,
        Value::Object(map) => Some(map),
        _ => {
            return Err(format!(
                "工具 {name} 的参数必须是 JSON 对象（当前是 {}）",
                json_type_name(arguments)
            ));
        }
    };
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Ok(());
    };
    let exempt = REQUIRED_KEY_EXEMPTIONS
        .iter()
        .find(|(tool, _)| *tool == name)
        .map_or(&[][..], |(_, keys)| *keys);
    let mut problems = Vec::new();
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if exempt.contains(&key) {
                continue;
            }
            let present = object
                .and_then(|map| map.get(key))
                .is_some_and(|value| !value.is_null());
            if !present {
                let expected = properties
                    .get(key)
                    .and_then(|property| property.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or("value");
                let hint = properties
                    .get(key)
                    .and_then(|property| property.get("description"))
                    .and_then(Value::as_str)
                    .map(|text| format!("（{text}）"))
                    .unwrap_or_default();
                problems.push(format!("缺少必填参数 {key}，类型应为 {expected}{hint}"));
            }
        }
    }
    if let Some(map) = object {
        for (name, value) in map {
            let Some(property) = properties.get(name) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            let Some(expected) = property.get("type").and_then(Value::as_str) else {
                continue;
            };
            if !type_matches(expected, value) {
                problems.push(format!(
                    "参数 {name} 类型错误：期望 {expected}，实际 {}",
                    json_type_name(value)
                ));
                continue;
            }
            if let Some(options) = property.get("enum").and_then(Value::as_array)
                && !options.iter().any(|option| option == value)
            {
                let allowed = options
                    .iter()
                    .map(|option| option.to_string())
                    .collect::<Vec<_>>()
                    .join(" / ");
                problems.push(format!("参数 {name} 取值非法：仅支持 {allowed}"));
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "工具 {name} 的参数未通过校验：{}。请修正参数后重试。",
            problems.join("；")
        ))
    }
}

fn type_matches(expected: &str, value: &Value) -> bool {
    match expected {
        "string" => value.is_string(),
        "integer" => {
            value.as_i64().is_some()
                || value.as_u64().is_some()
                || value.as_f64().is_some_and(|number| number.fract() == 0.0)
        }
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// 失败结果是否属于「瞬时」错误（可重试）。
pub fn is_transient_failure(output: &str) -> bool {
    let text = output.to_ascii_lowercase();
    if FATAL_MARKERS.iter().any(|marker| text.contains(marker)) {
        return false;
    }
    TRANSIENT_MARKERS.iter().any(|marker| text.contains(marker))
}

/// 取前若干个字符（按 UTF-8 边界安全截断）。
fn take_head(text: &str, max_bytes: usize, max_lines: usize) -> String {
    let mut end = max_bytes.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let slice = &text[..end];
    slice
        .lines()
        .take(max_lines)
        .collect::<Vec<_>>()
        .join("\n")
}

/// 取末尾若干个字符。
fn take_tail(text: &str, max_bytes: usize, max_lines: usize) -> String {
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    let slice = &text[start..];
    let lines = slice.lines().collect::<Vec<_>>();
    let skip = lines.len().saturating_sub(max_lines);
    lines[skip..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "limit": {"type": "integer"},
                "mode": {"type": "string", "enum": ["text", "bytes"]}
            },
            "required": ["path"],
            "additionalProperties": false
        })
    }

    #[test]
    fn validate_reports_missing_and_wrong_typed_arguments() {
        let schema = schema();
        let name = "read_file";
        let error =
            validate_arguments(name, &schema, &json!({"limit": "many"})).expect_err("应当报错");
        assert!(error.contains("缺少必填参数 path"), "{error}");
        assert!(error.contains("参数 limit 类型错误"), "{error}");
        assert!(error.contains("工具 read_file"), "{error}");

        assert!(validate_arguments(name, &schema, &json!({"path": "a.txt"})).is_ok());
        assert!(validate_arguments(name, &schema, &json!({"path": "a.txt", "limit": 3})).is_ok());
        assert!(validate_arguments(name, &schema, &json!({"path": "a.txt", "limit": 3.5})).is_err());
        assert!(validate_arguments(name, &schema, &json!({"path": "a.txt", "mode": "hex"})).is_err());
        assert!(validate_arguments(name, &schema, &json!({"path": "a.txt", "mode": "bytes"})).is_ok());
    }

    #[test]
    fn validate_rejects_non_object_arguments_with_readable_error() {
        let error =
            validate_arguments("read_file", &schema(), &json!("oops")).expect_err("应当报错");
        assert!(error.contains("必须是 JSON 对象"), "{error}");
        assert!(error.contains("string"), "{error}");
        // null 视作空参数对象：只报缺参，不 panic。
        let error =
            validate_arguments("read_file", &schema(), &Value::Null).expect_err("应当报错");
        assert!(error.contains("缺少必填参数 path"), "{error}");
    }

    #[test]
    fn handler_defaulted_required_keys_are_not_rejected() {
        // local_shell 的 action 在处理器里默认 exec，缺省时不能被必填校验拦下。
        let schema = json!({
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["exec", "write", "wait", "terminate"]},
                "command": {"type": "string"}
            },
            "required": ["action"],
            "additionalProperties": false
        });
        assert!(validate_arguments("local_shell", &schema, &json!({"command": "ls"})).is_ok());
        assert!(validate_arguments("local_shell", &schema, &json!({"action": "bogus"})).is_err());
        // 其它工具的必填仍然生效。
        assert!(validate_arguments("other_tool", &schema, &json!({"command": "ls"})).is_err());
    }

    #[test]
    fn transient_failures_are_retryable_but_deterministic_ones_are_not() {
        assert!(is_transient_failure("request failed: connection reset by peer"));
        assert!(is_transient_failure("HTTP 503 Service Unavailable"));
        assert!(is_transient_failure("工具执行超时"));
        assert!(!is_transient_failure("missing string argument: path"));
        assert!(!is_transient_failure("access denied by policy"));
        assert!(!is_transient_failure("file not found"));
    }

    #[test]
    fn retry_policy_respects_tool_whitelist_and_attempt_budget() {
        let quality = ToolQuality::new(ToolQualityConfig {
            max_retries: 2,
            ..ToolQualityConfig::default()
        });
        let transient = ToolResult::error("connection reset by peer");
        assert!(quality.should_retry("read_file", &transient, 0));
        assert!(quality.should_retry("read_file", &transient, 1));
        assert!(!quality.should_retry("read_file", &transient, 2), "不得超过次数上限");
        assert!(!quality.should_retry("local_shell", &transient, 0), "写工具不得重试");
        assert!(!quality.should_retry("read_file", &ToolResult::success("ok"), 0));
        assert!(!quality.should_retry("read_file", &ToolResult::error("invalid path"), 0));
    }

    #[test]
    fn timeouts_apply_only_to_read_only_whitelist() {
        let quality = ToolQuality::new(ToolQualityConfig::default());
        assert!(quality.timeout_for("read_file").is_some());
        assert!(quality.timeout_for("web_fetch").is_some());
        assert!(quality.timeout_for("local_shell").is_none());
        assert!(quality.timeout_for("request_user_input").is_none());
        assert!(quality.timeout_for("spawn_agent").is_none());
    }

    #[test]
    fn cache_hits_respect_ttl_and_capacity() {
        let quality = ToolQuality::new(ToolQualityConfig {
            cache_entries: 2,
            ..ToolQualityConfig::default()
        });
        let key = quality.cache_key("read_file", &json!({"path": "a"}), "G:/ws");
        assert!(quality.cached(&key).is_none());
        quality.store(&key, &ToolResult::success("内容"));
        let hit = quality.cached(&key).expect("命中缓存");
        assert_eq!(hit.output, "内容");

        // 写操作让缓存整体失效。
        quality.invalidate();
        assert!(quality.cached(&key).is_none());

        // 失败结果不入缓存。
        let failed = quality.cache_key("read_file", &json!({"path": "b"}), "G:/ws");
        quality.store(&failed, &ToolResult::error("boom"));
        assert!(quality.cached(&failed).is_none());

        // 容量上限：最旧的条目被淘汰。
        let first = quality.cache_key("read_file", &json!({"path": "1"}), "G:/ws");
        let second = quality.cache_key("read_file", &json!({"path": "2"}), "G:/ws");
        let third = quality.cache_key("read_file", &json!({"path": "3"}), "G:/ws");
        quality.store(&first, &ToolResult::success("1"));
        quality.store(&second, &ToolResult::success("2"));
        quality.cached(&first);
        quality.store(&third, &ToolResult::success("3"));
        assert_eq!(quality.stats().3, 2, "缓存条目数不得超过容量");
    }

    #[test]
    fn expired_cache_entries_are_ignored() {
        let quality = ToolQuality::new(ToolQualityConfig {
            cache_ttl_ms: 0,
            ..ToolQualityConfig::default()
        });
        let key = quality.cache_key("read_file", &json!({"path": "a"}), "G:/ws");
        quality.store(&key, &ToolResult::success("内容"));
        assert!(quality.cached(&key).is_none(), "TTL 为 0 时立即过期");
    }

    #[test]
    fn oversized_output_spills_to_temp_file_and_keeps_head_and_tail() {
        let directory = tempfile::tempdir().expect("temp dir");
        let quality = ToolQuality::new(ToolQualityConfig {
            max_output_bytes: 400,
            max_output_lines: 20,
            spill_directory: Some(directory.path().to_path_buf()),
            ..ToolQualityConfig::default()
        });
        let head = "HEAD-MARKER\n";
        let body = "x".repeat(5_000);
        let tail = "\nTAIL-MARKER";
        let output = format!("{head}{body}{tail}");
        let trimmed = quality.trim_output("grep_files", output.clone());
        assert!(trimmed.len() < output.len());
        assert!(trimmed.contains("HEAD-MARKER"));
        assert!(trimmed.contains("TAIL-MARKER"));
        assert!(trimmed.contains("完整输出已写入临时文件"));
        let path = trimmed
            .split("临时文件：")
            .nth(1)
            .and_then(|rest| rest.split('，').next())
            .expect("临时文件路径");
        let spilled = std::fs::read_to_string(path).expect("溢出文件可读");
        assert_eq!(spilled, output, "完整内容必须落盘");
        assert!(
            std::path::Path::new(path).starts_with(directory.path()),
            "溢出文件必须写在配置目录内"
        );
    }

    #[test]
    fn small_output_is_returned_untouched() {
        let quality = ToolQuality::new(ToolQualityConfig::default());
        let output = "hello\nworld".to_owned();
        assert_eq!(quality.trim_output("read_file", output.clone()), output);
    }

    #[test]
    fn spill_failure_falls_back_to_plain_truncation() {
        // 目录不可创建（父路径是文件）时必须降级为普通截断而不是 panic。
        let directory = tempfile::tempdir().expect("temp dir");
        let blocker = directory.path().join("blocker");
        std::fs::write(&blocker, "not a directory").expect("write blocker");
        let quality = ToolQuality::new(ToolQualityConfig {
            max_output_bytes: 100,
            max_output_lines: 5,
            spill_directory: Some(blocker.join("nested")),
            ..ToolQualityConfig::default()
        });
        let trimmed = quality.trim_output("read_file", "y".repeat(2_000));
        assert!(trimmed.contains("内容过长已截断"), "{trimmed}");
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        let quality = ToolQuality::new(ToolQualityConfig {
            retry_backoff_ms: 100,
            max_retry_backoff_ms: 400,
            ..ToolQualityConfig::default()
        });
        assert_eq!(quality.backoff(1), Duration::from_millis(100));
        assert_eq!(quality.backoff(2), Duration::from_millis(200));
        assert_eq!(quality.backoff(3), Duration::from_millis(400));
        assert_eq!(quality.backoff(9), Duration::from_millis(400));
    }
}
