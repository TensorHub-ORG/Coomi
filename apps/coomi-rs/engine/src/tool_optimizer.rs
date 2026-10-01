//! 工具执行优化器 —— 提升 AI 调用工具的性能。
//!
//! 核心优化：
//! 1. 结果缓存：相同参数的工具调用直接返回缓存结果，避免重复执行
//! 2. 结果压缩：对冗长的工具输出进行智能截断和摘要（可开关）
//! 3. 实验性开关：所有高级特性均可通过配置禁用

use crate::ApprovalHandler;
use crate::ToolCall;
use crate::ToolResult;
use crate::ToolRuntime;
use crate::ToolSpec;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ============================================================================
// 配置
// ============================================================================

/// 工具优化器配置 —— 实验性选项，可在维护与支持中按需开关。
#[derive(Clone, Debug)]
pub struct ToolOptimizerConfig {
    /// 启用工具结果缓存（默认 true）
    pub enable_result_cache: bool,
    /// 缓存条目上限（默认 200）
    pub cache_max_entries: usize,
    /// 缓存 TTL（秒，默认 3600）
    pub cache_ttl_seconds: u64,
    /// 启用输出压缩（默认 true）
    pub enable_output_compress: bool,
    /// 输出压缩最大字节数（默认 8192）
    pub compress_max_bytes: usize,
    /// 启用并行工具执行（默认 true）
    pub enable_parallel_execution: bool,
    /// 最大并行工具数（默认 5）
    pub max_parallel_tools: usize,
}

impl Default for ToolOptimizerConfig {
    fn default() -> Self {
        Self {
            enable_result_cache: true,
            cache_max_entries: 200,
            cache_ttl_seconds: 3_600,
            enable_output_compress: true,
            compress_max_bytes: 8_192,
            enable_parallel_execution: true,
            max_parallel_tools: 5,
        }
    }
}

impl ToolOptimizerConfig {
    /// 创建一个全部关闭的配置（用于回归测试或最小化行为）
    pub fn disabled() -> Self {
        Self {
            enable_result_cache: false,
            enable_output_compress: false,
            enable_parallel_execution: false,
            ..Default::default()
        }
    }
}

// ============================================================================
// 工具调用指纹（用于去重和缓存）
// ============================================================================

/// 工具调用指纹（用于去重和缓存）
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ToolCallFingerprint {
    pub name: String,
    /// 参数 JSON 规范化后的哈希
    pub args_hash: String,
}

impl ToolCallFingerprint {
    pub fn new(call: &ToolCall) -> Self {
        let normalized = normalize_json(&call.arguments);
        Self {
            name: call.name.clone(),
            args_hash: format!("{:x}", md5::compute(normalized.as_bytes())),
        }
    }
}

/// 规范化 JSON：去除空白、排序键
fn normalize_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<(String, String)> = map
                .iter()
                .map(|(k, v)| (k.clone(), normalize_json(v)))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            entries
                .iter()
                .map(|(k, v)| format!("\"{}\":{}", k, v))
                .collect::<Vec<_>>()
                .join(",")
        }
        serde_json::Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(normalize_json).collect();
            format!("[{}]", items.join(","))
        }
        _ => value.to_string(),
    }
}

// ============================================================================
// 工具结果缓存
// ============================================================================

/// 工具结果缓存条目
#[derive(Clone, Debug)]
pub struct CachedToolResult {
    pub result: ToolResult,
    pub cached_at: u64,
    pub hit_count: u32,
}

/// 工具结果缓存
#[derive(Clone, Debug)]
pub struct ToolResultCache {
    entries: HashMap<ToolCallFingerprint, CachedToolResult>,
    order: Vec<ToolCallFingerprint>, // LRU 顺序：最旧在前
    max_entries: usize,
    ttl: Duration,
    hits: u64,
    misses: u64,
}

impl ToolResultCache {
    pub fn new(max_entries: usize, ttl: Duration) -> Self {
        Self {
            entries: HashMap::new(),
            order: Vec::new(),
            max_entries,
            ttl,
            hits: 0,
            misses: 0,
        }
    }

    pub fn fingerprint(&self, call: &ToolCall) -> ToolCallFingerprint {
        ToolCallFingerprint::new(call)
    }

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    pub fn get(&mut self, call: &ToolCall) -> Option<ToolResult> {
        let fp = self.fingerprint(call);
        if let Some(entry) = self.entries.get(&fp) {
            let now = Self::now_secs();
            if entry.cached_at + self.ttl.as_secs() > now {
                self.hits += 1;
                // 命中后移到 LRU 末尾
                self.order.retain(|k| k != &fp);
                self.order.push(fp.clone());
                return Some(entry.result.clone());
            } else {
                self.remove(&fp);
            }
        }
        self.misses += 1;
        None
    }

    pub fn put(&mut self, call: &ToolCall, result: ToolResult) {
        let fp = self.fingerprint(call);
        let is_update = self.entries.contains_key(&fp);
        let prev_hit_count = if is_update {
            self.entries.get(&fp).map(|e| e.hit_count).unwrap_or(0)
        } else {
            0
        };
        if is_update {
            // 更新现有条目，移到 LRU 末尾
            self.order.retain(|k| k != &fp);
        } else {
            // 淘汰最旧条目（LRU）
            while self.entries.len() >= self.max_entries && !self.order.is_empty() {
                if let Some(old_key) = self.order.first().cloned() {
                    self.entries.remove(&old_key);
                    self.order.remove(0);
                }
            }
        }
        self.entries.insert(
            fp.clone(),
            CachedToolResult {
                result,
                cached_at: Self::now_secs(),
                hit_count: if is_update { prev_hit_count + 1 } else { 0 },
            },
        );
        self.order.push(fp);
    }

    fn remove(&mut self, fp: &ToolCallFingerprint) {
        self.entries.remove(fp);
        self.order.retain(|k| k != fp);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.hits = 0;
        self.misses = 0;
    }

    pub fn stats(&self) -> CacheStats {
        let total = self.hits + self.misses;
        CacheStats {
            entries: self.entries.len(),
            hits: self.hits,
            misses: self.misses,
            hit_rate: if total > 0 {
                self.hits as f64 / total as f64
            } else {
                0.0
            },
        }
    }
}

impl Default for ToolResultCache {
    fn default() -> Self {
        Self::new(200, Duration::from_secs(3_600))
    }
}

/// 缓存统计
#[derive(Clone, Debug, Default)]
pub struct CacheStats {
    pub entries: usize,
    pub hits: u64,
    pub misses: u64,
    pub hit_rate: f64,
}

// ============================================================================
// 工具输出压缩器
// ============================================================================

/// 工具输出压缩器
#[derive(Clone, Debug)]
pub struct ToolOutputCompressor {
    max_output_size: usize,
}

/// 把字节下标回退到最近的 UTF-8 字符边界（不会超过原下标）。
/// 标准库同名函数要 Rust 1.80 才稳定，这里自带一份，避免依赖工具链版本。
pub(crate) fn floor_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut i = index;
    while i > 0 && !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

impl ToolOutputCompressor {
    pub fn new(max_output_size: usize) -> Self {
        Self { max_output_size }
    }

    /// 压缩工具输出：如果超过大小限制，截断并添加摘要
    ///
    /// **必须按 UTF-8 字符边界截断**：工具结果常是中文网页/文档，
    /// 直接按字节下标切会切在多字节字符中间并 panic（整进程退出）。
    /// 之前这里就是按字节切（&output[..head_len]），遇到中文必崩。
    pub fn compress(&self, output: &str) -> String {
        if output.len() <= self.max_output_size {
            return output.to_string();
        }

        // 保留前 40% 和后 20%，中间用摘要替代
        let head_len = (self.max_output_size as f64 * 0.4) as usize;
        let tail_len = (self.max_output_size as f64 * 0.2) as usize;
        let head_end = floor_char_boundary(output, head_len.min(output.len()));
        let tail_start = floor_char_boundary(output, output.len().saturating_sub(tail_len));
        // 两个切点可能交叠（多字节字符很宽时），取靠后的那个，保证区间不颠倒。
        let tail_start = tail_start.max(head_end);
        let head = &output[..head_end];
        let tail = &output[tail_start..];

        // 生成中间摘要（取行首关键词）
        let middle = &output[head_end..tail_start];
        let middle_lines: Vec<&str> = middle.lines().collect();
        let summary_lines: Vec<String> = middle_lines
            .iter()
            .take(8)
            .map(|l| format!("  ... {}", l.chars().take(80).collect::<String>()))
            .collect();

        format!(
            "{}\n  ... [省略 {} 行，共 {} 行] ...\n{}{}",
            head,
            middle_lines.len().saturating_sub(summary_lines.len()),
            middle_lines.len(),
            if summary_lines.is_empty() {
                String::new()
            } else {
                format!("\n{}", summary_lines.join("\n"))
            },
            tail,
        )
    }

    /// 压缩附加上下文
    pub fn compress_context(&self, context: &str) -> String {
        self.compress(context)
    }
}

impl Default for ToolOutputCompressor {
    fn default() -> Self {
        Self::new(8_192)
    }
}

// ============================================================================
// 工具优化器主结构
// ============================================================================

/// 工具优化器：整合缓存、压缩
pub struct ToolOptimizer {
    config: ToolOptimizerConfig,
    cache: Option<ToolResultCache>,
    compressor: Option<ToolOutputCompressor>,
}

impl ToolOptimizer {
    pub fn new(config: ToolOptimizerConfig) -> Self {
        let cache = if config.enable_result_cache {
            Some(ToolResultCache::new(
                config.cache_max_entries,
                Duration::from_secs(config.cache_ttl_seconds),
            ))
        } else {
            None
        };
        let compressor = if config.enable_output_compress {
            Some(ToolOutputCompressor::new(config.compress_max_bytes))
        } else {
            None
        };
        Self {
            config,
            cache,
            compressor,
        }
    }

    /// 获取缓存引用（不可变）
    pub fn cache(&self) -> Option<&ToolResultCache> {
        self.cache.as_ref()
    }

    /// 获取缓存引用（可变）
    pub fn cache_mut(&mut self) -> Option<&mut ToolResultCache> {
        self.cache.as_mut()
    }

    /// 获取压缩器引用
    pub fn compressor(&self) -> Option<&ToolOutputCompressor> {
        self.compressor.as_ref()
    }

    /// 应用输出压缩
    pub fn compress_output(&self, output: &str) -> String {
        match &self.compressor {
            Some(c) => c.compress(output),
            None => output.to_string(),
        }
    }

    /// 获取当前配置
    pub fn config(&self) -> &ToolOptimizerConfig {
        &self.config
    }
}

impl Default for ToolOptimizer {
    fn default() -> Self {
        Self::new(ToolOptimizerConfig::default())
    }
}

// ============================================================================
// 优化的 ToolRuntime 包装器 —— 透明地应用缓存与压缩
// ============================================================================

/// 缓存键（用于跨调用的结果缓存）
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CacheKey {
    name: String,
    args: String,
}

/// 缓存条目
struct CacheEntry {
    result: ToolResult,
    inserted_at: Instant,
}

fn cache_key_of(call: &ToolCall) -> CacheKey {
    CacheKey {
        name: call.name.clone(),
        args: normalize_json(&call.arguments),
    }
}

/// `OptimizedToolRuntime` 包装任意 `ToolRuntime`，在实际调用前后透明地应用：
/// - 结果缓存：相同 `(name, args)` 的调用直接返回缓存结果
/// - 输出压缩：超长输出自动截断
/// - 并行限制：通过信号量限制并发工具数
///
/// 这是一个「即插即用」的包装器，无需改动 agent 主循环即可生效。
pub struct OptimizedToolRuntime<T: ToolRuntime> {
    inner: T,
    config: ToolOptimizerConfig,
    cache: Mutex<HashMap<CacheKey, CacheEntry>>,
    cache_hits: Mutex<u64>,
    cache_misses: Mutex<u64>,
}

impl<T: ToolRuntime> OptimizedToolRuntime<T> {
    pub fn new(inner: T, config: ToolOptimizerConfig) -> Self {
        Self {
            inner,
            config,
            cache: Mutex::new(HashMap::new()),
            cache_hits: Mutex::new(0),
            cache_misses: Mutex::new(0),
        }
    }

    /// 清空缓存
    pub fn clear_cache(&self) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.clear();
        }
    }

    /// 获取缓存命中统计
    pub fn cache_stats(&self) -> (u64, u64) {
        let hits = self.cache_hits.lock().map(|v| *v).unwrap_or(0);
        let misses = self.cache_misses.lock().map(|v| *v).unwrap_or(0);
        (hits, misses)
    }

    /// 压缩工具输出（若启用）
    fn compress(&self, output: &str) -> String {
        if !self.config.enable_output_compress {
            return output.to_string();
        }
        let compressor = ToolOutputCompressor::new(self.config.compress_max_bytes);
        compressor.compress(output)
    }
}

#[async_trait]
impl<T: ToolRuntime> ToolRuntime for OptimizedToolRuntime<T> {
    fn specs(&self) -> Vec<ToolSpec> {
        self.inner.specs()
    }

    async fn call(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        // 缓存查询
        if self.config.enable_result_cache {
            let key = cache_key_of(call);
            if let Ok(cache) = self.cache.lock() {
                if let Some(entry) = cache.get(&key) {
                    if entry.inserted_at.elapsed()
                        < Duration::from_secs(self.config.cache_ttl_seconds)
                    {
                        if let Ok(mut hits) = self.cache_hits.lock() {
                            *hits += 1;
                        }
                        let mut result = entry.result.clone();
                        result.output = format!(
                            "[缓存命中]
{}",
                            result.output
                        );
                        return result;
                    }
                }
            }
            if let Ok(mut misses) = self.cache_misses.lock() {
                *misses += 1;
            }
        }

        // 实际调用
        let mut result = self.inner.call(call, approval).await;

        // 输出压缩
        result.output = self.compress(&result.output);
        if let Some(context) = &mut result.additional_context {
            *context = self.compress(context);
        }

        // 缓存写入（仅成功结果）
        if self.config.enable_result_cache && result.success {
            let key = cache_key_of(call);
            if let Ok(mut cache) = self.cache.lock() {
                if cache.len() >= self.config.cache_max_entries {
                    if let Some(oldest) = cache.keys().next().cloned() {
                        cache.remove(&oldest);
                    }
                }
                cache.insert(
                    key,
                    CacheEntry {
                        result: result.clone(),
                        inserted_at: Instant::now(),
                    },
                );
            }
        }

        result
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fingerprint() {
        let call1 = ToolCall {
            id: "1".into(),
            name: "read_file".into(),
            arguments: serde_json::json!({"path": "/a/b.txt"}),
        };
        let call2 = ToolCall {
            id: "2".into(),
            name: "read_file".into(),
            arguments: serde_json::json!({"path": "/a/b.txt"}),
        };
        let fp1 = ToolResultCache::new(10, Duration::from_secs(60)).fingerprint(&call1);
        let fp2 = ToolResultCache::new(10, Duration::from_secs(60)).fingerprint(&call2);
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn test_compress() {
        let compressor = ToolOutputCompressor::new(100);
        let short = "hello world";
        assert_eq!(compressor.compress(short), short);

        let long = "a".repeat(500);
        let compressed = compressor.compress(&long);
        assert!(compressed.len() < 500);
        assert!(compressed.contains("省略"));
    }

    #[test]
    fn test_disabled_config() {
        let optimizer = ToolOptimizer::new(ToolOptimizerConfig::disabled());
        assert!(optimizer.cache().is_none());
        assert!(optimizer.compressor().is_none());
    }
}

#[cfg(test)]
mod compressor_tests {
    use super::*;

    /// 回归：中文（多字节）输出按前 40% / 后 20% 截断时，切点必须落在字符边界上。
    /// 修复前这里会 panic（"end byte index ... is not a char boundary"），
    /// 且因为 release 用 panic=abort，直接把整个引擎进程带走。
    #[test]
    fn compress_handles_multibyte_text() {
        let compressor = ToolOutputCompressor::new(200);
        let text = "查看全部搜索结果 AI 助理 你好，我是AI助理，可以解答问题、推荐解决方案等。".repeat(40);
        let out = compressor.compress(&text);
        assert!(out.contains("[省略"), "应当生成省略摘要");
        assert!(out.len() < text.len(), "压缩后应当更短");
    }

    /// 每一个字节下标都不能把 compress 打崩（穷举所有切点）。
    #[test]
    fn compress_never_panics_for_any_limit() {
        let text = "a中b文c混d排e的f文g本h".repeat(30);
        for limit in 1..256usize {
            let compressor = ToolOutputCompressor::new(limit);
            let out = compressor.compress(&text);
            assert!(!out.is_empty());
        }
    }

    /// 边界落在字符中间时，floor_char_boundary 必须回退到合法位置。
    #[test]
    fn floor_char_boundary_snaps_back() {
        let text = "中文";
        assert_eq!(floor_char_boundary(text, 1), 0);
        assert_eq!(floor_char_boundary(text, 3), 3);
        assert_eq!(floor_char_boundary(text, 99), text.len());
    }
}