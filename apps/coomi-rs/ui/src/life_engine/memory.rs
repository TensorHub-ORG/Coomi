//! 记忆系统：TF-IDF 检索 + Ebbinghaus 衰减 + 三层命名空间 + 记忆类型分类。
//!
//! 三层命名空间（严格隔离）：
//! - primary: 正常对话（用户专属）
//! - group: 群组公共记忆
//! - dm: 群成员单聊私有记忆
//!
//! 记忆类型：
//! - Episodic: 情景（对话细节、情绪、承诺）
//! - Semantic: 语义（偏好、习惯、价值观）
//! - Relational: 关系（亲密度、信任、共同经历）

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── 记忆类型 ────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    /// 情景记忆：对话细节、情绪、承诺
    Episodic,
    /// 语义记忆：偏好、习惯、价值观
    Semantic,
    /// 关系记忆：亲密度、信任、共同经历
    Relational,
    /// 习惯记忆（从对话中自动提取）
    Habit,
}

// ── 记忆条目 ────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    /// 内容
    pub text: String,
    /// 记忆类型
    #[serde(default = "default_kind")]
    pub kind: MemoryKind,
    /// 情感色彩 -1..1
    #[serde(default)]
    pub emotional_tone: f64,
    /// 重要性 0..1（越高衰减越慢）
    #[serde(default = "default_importance")]
    pub importance: f64,
    /// 创建时间戳 ms
    #[serde(default = "now_ms")]
    pub created_at_ms: u64,
    /// 最后回忆时间戳 ms
    #[serde(default)]
    pub last_recalled_ms: u64,
    /// 回忆次数（每次回忆 +1，增强记忆）
    #[serde(default)]
    pub recall_count: u32,
}

fn default_kind() -> MemoryKind {
    MemoryKind::Episodic
}

fn default_importance() -> f64 {
    0.5
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl MemoryEntry {
    pub fn new(text: &str, kind: MemoryKind, importance: f64) -> Self {
        Self {
            text: text.to_owned(),
            kind,
            emotional_tone: 0.0,
            importance: importance.clamp(0.0, 1.0),
            created_at_ms: now_ms(),
            last_recalled_ms: now_ms(),
            recall_count: 0,
        }
    }

    /// 计算当前保留度（Ebbinghaus 衰减 + 重要性加权 + 回忆强化）。
    /// retention = importance * e^(-λ * age_days / (1 + recall_count))
    /// 每次回忆：recall_count += 1, last_recalled = now
    pub fn retention(&self) -> f64 {
        let now = now_ms();
        let age_days = (now.saturating_sub(self.last_recalled_ms)) as f64 / 86_400_000.0;
        let decay_rate = 0.1; // 基础衰减率
        let strength = self.importance * (1.0 + self.recall_count as f64 * 0.2);
        let retention = strength * (-decay_rate * age_days / (1.0 + self.recall_count as f64)).exp();
        retention.clamp(0.0, 1.0)
    }

    /// 记忆被回忆时：增强强度
    pub fn recall(&mut self) {
        self.recall_count += 1;
        self.last_recalled_ms = now_ms();
    }
}

// ── TF-IDF 检索 ────────────────────────────────────────────

/// 分词：英文按词；中文连续串拆成 bigram + trigram（字符 n-gram），
/// 否则中文句子会被当成一整串，TF-IDF 检索基本失效。
pub fn tokenize(text: &str) -> Vec<String> {
    let bounded: String = text.chars().take(12000).collect();
    let mut out: Vec<String> = Vec::new();
    for seg in bounded.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '#' && c != '+' && c != '.' && c != '-') {
        if seg.is_empty() {
            continue;
        }
        let lower = seg.to_lowercase();
        // 含 CJK 字符：按字符 n-gram 拆，避免整句成单 token。
        if lower.chars().any(is_cjk) {
            let chars: Vec<char> = lower.chars().collect();
            // 单字也保留（短词命中），再加 bigram/trigram。
            if chars.len() == 1 {
                out.push(lower.clone());
                continue;
            }
            for w in chars.windows(2) {
                out.push(w.iter().collect());
            }
            for w in chars.windows(3) {
                out.push(w.iter().collect());
            }
            // 整段也保留一份（供长专名命中）。
            if chars.len() <= 12 {
                out.push(lower.clone());
            }
        } else if lower.len() >= 2 {
            out.push(lower);
        }
    }
    out
}

#[inline]
fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4e00}'..='\u{9fff}'      // CJK 统一汉字
        | '\u{3400}'..='\u{4dbf}'    // 扩展 A
        | '\u{3040}'..='\u{30ff}'    // 日文假名
        | '\u{ac00}'..='\u{d7af}'    // 韩文音节
    )
}

pub fn build_idf(docs: &[Vec<String>]) -> HashMap<String, f64> {
    let n = docs.len().max(1) as f64;
    let mut df: HashMap<String, u32> = HashMap::new();
    for doc in docs {
        let mut seen = std::collections::HashSet::new();
        for token in doc {
            if seen.insert(token) {
                *df.entry(token.clone()).or_insert(0) += 1;
            }
        }
    }
    df.into_iter()
        .map(|(t, c)| (t, ((n + 1.0) / (c as f64 + 1.0)).ln() + 1.0))
        .collect()
}

pub fn tfidf_score(query: &[String], doc: &[String], idf: &HashMap<String, f64>) -> f64 {
    if query.is_empty() {
        return 0.0;
    }
    let mut doc_tf: HashMap<String, u32> = HashMap::new();
    for t in doc {
        *doc_tf.entry(t.clone()).or_insert(0) += 1;
    }
    let mut score = 0.0;
    for q in query {
        if let Some(&tf) = doc_tf.get(q) {
            score += tf as f64 * idf.get(q).copied().unwrap_or(1.0);
        }
    }
    score
}

pub fn ebbinghaus_retention(age_days: f64, strength: f64) -> f64 {
    let half = (7.0 * (1.0 + age_days.min(30.0) / 60.0)).max(0.25);
    strength * 0.5f64.powf(age_days / half)
}

// ── 记忆检索（基于 MemoryEntry）──────────────────────────────

/// 检索最相关的记忆条目，返回索引列表（按相关度降序）。
/// 检索时自动增强命中记忆（recall）。
pub fn retrieve_memories(
    entries: &[MemoryEntry],
    query: &str,
    limit: usize,
) -> Vec<usize> {
    if entries.is_empty() || query.trim().is_empty() {
        return Vec::new();
    }
    let query_tokens = tokenize(query);
    if query_tokens.is_empty() {
        return Vec::new();
    }
    let docs: Vec<Vec<String>> = entries.iter().map(|e| tokenize(&e.text)).collect();
    let idf = build_idf(&docs);

    let mut scored: Vec<(usize, f64)> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let relevance = tfidf_score(&query_tokens, &docs[i], &idf);
            let retention = e.retention();
            let score = relevance * (0.3 + retention * 0.7); // 相关度 * 保留度加权
            (i, score)
        })
        .filter(|(_, score)| *score > 0.01)
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
        .into_iter()
        .take(limit)
        .map(|(i, _)| i)
        .collect()
}

// ── 命名空间 ────────────────────────────────────────────────

/// 记忆命名空间：三层严格隔离。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryNamespace {
    /// 正常对话（用户专属）- 不注入群聊/单聊
    Primary,
    /// 群组公共记忆 - 可注入该群所有成员的单聊
    Group { project_id: String, room_id: String },
    /// 群成员单聊私有记忆 - 只注入该单聊
    Dm { project_id: String, identity_id: String },
}

impl MemoryNamespace {
    /// 判断两个命名空间是否允许记忆共享。
    /// 规则：
    /// - Primary → 不注入 Group/Dm
    /// - Group → 可注入同群的 Dm
    /// - Dm → 不注入其他 Dm 或 Group
    pub fn can_inject_into(&self, target: &MemoryNamespace) -> bool {
        match (self, target) {
            // 群公共记忆 → 同群单聊
            (MemoryNamespace::Group { project_id: p1, room_id: r1 },
             MemoryNamespace::Dm { project_id: p2, .. }) => p1 == p2,
            // 同一命名空间内
            (a, b) => a == b,
            _ => false,
        }
    }
}
