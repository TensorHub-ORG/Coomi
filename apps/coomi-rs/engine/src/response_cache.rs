//! 响应缓存 —— 对常见查询缓存响应，减少不必要的 API 调用和 token 开销。
//!
//! 策略：
//! 1. 语义哈希：对查询生成语义哈希（忽略大小写和空格差异）
//! 2. TTL 控制：缓存有效期，过期自动清理
//! 3. 大小限制：限制缓存条目数，防止内存膨胀
//! 4. 命中统计：跟踪缓存命中率

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// 缓存条目
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CacheEntry {
    pub key: String,
    pub response: String,
    pub created_at: u64,
    pub hit_count: u32,
    pub ttl_seconds: u64,
}

/// 响应缓存配置
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CacheConfig {
    pub max_entries: usize,
    pub default_ttl_seconds: u64,
    pub max_response_size: usize,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            max_entries: 100,
            default_ttl_seconds: 3_600, // 1 hour
            max_response_size: 10_000,
        }
    }
}

/// 响应缓存
pub struct ResponseCache {
    config: CacheConfig,
    entries: HashMap<String, CacheEntry>,
    order: Vec<String>, // LRU 顺序
    hits: u64,
    misses: u64,
}

impl ResponseCache {
    pub fn new(config: CacheConfig) -> Self {
        Self {
            config,
            entries: HashMap::new(),
            order: Vec::new(),
            hits: 0,
            misses: 0,
        }
    }

    /// 生成语义缓存键（忽略大小写、多余空格）
    pub fn make_key(&self, query: &str) -> String {
        let normalized: String = query
            .chars()
            .filter(|c| !c.is_whitespace())
            .map(|c| c.to_ascii_lowercase())
            .collect();
        format!(
            "hash:{}",
            format!("{:x}", md5::compute(normalized.as_bytes()))
        )
    }

    /// 获取缓存
    pub fn get(&mut self, key: &str) -> Option<&CacheEntry> {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // 检查过期
        if let Some(entry) = self.entries.get(key) {
            let elapsed = now_secs.saturating_sub(entry.created_at);
            if elapsed > entry.ttl_seconds {
                self.remove(key);
                self.misses += 1;
                return None;
            }
            self.hits += 1;
            // 命中后移到 LRU 末尾
            self.order.retain(|k| k != key);
            self.order.push(key.to_string());
            return self.entries.get(key);
        }

        self.misses += 1;
        None
    }

    /// 存入缓存
    pub fn put(&mut self, key: String, response: String, ttl_seconds: Option<u64>) {
        // 限制响应大小
        let response: String = if response.len() > self.config.max_response_size {
            response
                .chars()
                .take(self.config.max_response_size)
                .collect()
        } else {
            response
        };

        // 如果已存在，更新
        if self.entries.contains_key(&key) {
            self.entries.get_mut(&key).map(|e| {
                e.response = response.clone();
                e.hit_count += 1;
                e.ttl_seconds = ttl_seconds.unwrap_or(self.config.default_ttl_seconds);
            });
            // 移到 LRU 末尾
            self.order.retain(|k| k != &key);
            self.order.push(key.clone());
            return;
        }

        // 淘汰旧条目
        while self.entries.len() >= self.config.max_entries && !self.order.is_empty() {
            if let Some(old_key) = self.order.first().cloned() {
                self.entries.remove(&old_key);
                self.order.remove(0);
            }
        }

        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.entries.insert(
            key.clone(),
            CacheEntry {
                key: key.clone(),
                response,
                created_at: now_secs,
                hit_count: 0,
                ttl_seconds: ttl_seconds.unwrap_or(self.config.default_ttl_seconds),
            },
        );
        self.order.push(key);
    }

    /// 移除缓存
    pub fn remove(&mut self, key: &str) {
        self.entries.remove(key);
        self.order.retain(|k| k != key);
    }

    /// 清空缓存
    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.hits = 0;
        self.misses = 0;
    }

    /// 获取缓存命中率 (0.0 - 1.0)
    pub fn hit_rate(&self) -> f64 {
        let total = self.hits + self.misses;
        if total == 0 {
            return 0.0;
        }
        self.hits as f64 / total as f64
    }

    /// 获取缓存统计
    pub fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.entries.len(),
            hits: self.hits,
            misses: self.misses,
            hit_rate: self.hit_rate(),
        }
    }
}

impl Default for ResponseCache {
    fn default() -> Self {
        Self::new(CacheConfig::default())
    }
}

/// 缓存统计
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CacheStats {
    pub entries: usize,
    pub hits: u64,
    pub misses: u64,
    pub hit_rate: f64,
}

/// 查询规范化器 —— 将不同写法的查询归一化为同一键
pub fn normalize_query(query: &str) -> String {
    query
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_ascii_punctuation())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_put_get() {
        let mut cache = ResponseCache::default();
        let key = cache.make_key("hello world");
        cache.put(key.clone(), "response".to_string(), None);
        // get() requires mutable reference and checks TTL with real time.
        // Since default_ttl is 3600s, the entry should be valid immediately.
        let entry = cache.get(&key);
        assert!(entry.is_some());
        assert_eq!(entry.unwrap().response, "response");
    }

    #[test]
    fn test_hit_rate() {
        let cache = ResponseCache::default();
        assert_eq!(cache.hit_rate(), 0.0);
    }

    #[test]
    fn test_normalize() {
        let a = normalize_query("Hello, World!");
        let b = normalize_query("helloworld");
        assert_eq!(a, b);
    }
}
