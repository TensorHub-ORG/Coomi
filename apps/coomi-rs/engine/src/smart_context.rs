//! 智能上下文压缩 —— 让 AI 更省 token。
//!
//! 核心策略：
//! 1. 滑动窗口：只保留最近 N 轮对话 + 重要系统提示
//! 2. 语义摘要：对旧上下文生成结构化摘要而非丢弃
//! 3. 关键词提取：识别对话中的关键实体和决策点
//! 4. 增量压缩：只在 token 用量超过阈值时触发，减少不必要的计算

use crate::ChatMessage;
use crate::Role;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// 压缩配置
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompressionConfig {
    /// 触发压缩的 token 阈值（估算）
    pub threshold_tokens: usize,
    /// 摘要后保留的最近消息数
    pub keep_recent: usize,
    /// 摘要中保留的最大关键词数
    pub max_keywords: usize,
    /// 是否保留工具调用记录
    pub preserve_tool_calls: bool,
}

impl Default for CompressionConfig {
    fn default() -> Self {
        Self {
            threshold_tokens: 8_000,
            keep_recent: 6,
            max_keywords: 12,
            preserve_tool_calls: true,
        }
    }
}

/// 结构化摘要
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContextSummary {
    /// 摘要文本
    pub summary: String,
    /// 关键词
    pub keywords: Vec<String>,
    /// 提到的文件路径
    pub files_mentioned: Vec<String>,
    /// 做出的关键决策
    pub decisions: Vec<String>,
    /// 未解决的问题
    pub open_questions: Vec<String>,
    /// 摘要覆盖的消息范围
    pub covered_range: (usize, usize),
}

/// 上下文压缩器
pub struct ContextCompressor {
    config: CompressionConfig,
}

impl ContextCompressor {
    pub fn new(config: CompressionConfig) -> Self {
        Self { config }
    }

    /// 估算消息列表的 token 数。
    /// 中文字符（CJK）在 UTF-8 中占 3 字节但约等于 1-2 token，
    /// 旧的「每 4 字符 = 1 token」对中文严重低估。
    pub fn estimate_tokens(&self, messages: &[ChatMessage]) -> usize {
        messages
            .iter()
            .map(|m| estimate_text_tokens(&m.content))
            .sum()
    }

    /// 检查是否需要压缩
    pub fn needs_compression(&self, messages: &[ChatMessage]) -> bool {
        self.estimate_tokens(messages) > self.config.threshold_tokens
    }

    /// 压缩消息列表：保留最近 N 条 + 生成摘要
    pub fn compress(&self, messages: &[ChatMessage]) -> (Vec<ChatMessage>, Option<ContextSummary>) {
        if messages.len() <= self.config.keep_recent {
            return (messages.to_vec(), None);
        }

        let split = messages.len() - self.config.keep_recent;
        let old_messages = &messages[..split];
        let recent_messages = &messages[split..];

        // 生成摘要
        let summary = self.summarize(old_messages);

        // 构建压缩后消息列表：摘要系统消息 + 最近消息
        let mut result = Vec::with_capacity(recent_messages.len() + 1);

        let summary_msg = ChatMessage {
            id: String::new(),
            role: Role::System,
            content: format!("[上下文摘要]\n{}", summary.summary),
            reasoning: String::new(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            compaction_summary: true,
            internal: true,
            reminder: None,
            life_proactive: false,
            pinned: false,
            draft: false,
            provider_items: Vec::new(),
            images: Vec::new(),
            attachments: Vec::new(),
            quotes: Vec::new(),
            request_context: String::new(),
        };
        result.push(summary_msg);
        result.extend_from_slice(recent_messages);

        (result, Some(summary))
    }

    /// 生成结构化摘要
    fn summarize(&self, messages: &[ChatMessage]) -> ContextSummary {
        let mut keywords = HashSet::new();
        let mut files_mentioned: Vec<String> = Vec::new();
        let mut decisions: Vec<String> = Vec::new();
        let mut open_questions: Vec<String> = Vec::new();
        let mut summary_parts: Vec<String> = Vec::new();

        for msg in messages {
            let content = &msg.content;

            // 提取关键词（简单实现：取较长的单词）
            for word in content.split_whitespace() {
                let clean: String = word
                    .chars()
                    .filter(|c| c.is_alphabetic() || *c == '/')
                    .collect();
                if clean.len() > 3 && clean.len() < 40 {
                    keywords.insert(clean);
                }
            }

            // 提取文件路径
            for part in content.split_whitespace() {
                if part.contains('/') && part.contains('.') {
                    let clean = part.trim_matches(|c: char| {
                        !c.is_alphanumeric() && c != '/' && c != '.' && c != '-' && c != '_'
                    });
                    if clean.starts_with('/') || clean.starts_with('.') {
                        if !files_mentioned.contains(&clean.to_string()) {
                            files_mentioned.push(clean.to_string());
                        }
                    }
                }
            }

            // 检测决策和问题
            if content.contains("决定") || content.contains("选择") || content.contains("使用")
            {
                decisions.push(content.chars().take(120).collect());
            }
            if content.contains("?") || content.contains("？") || content.contains("待确认") {
                open_questions.push(content.chars().take(120).collect());
            }
        }

        let keyword_list: Vec<String> = keywords
            .into_iter()
            .take(self.config.max_keywords)
            .collect();

        // 生成摘要文本
        summary_parts.push(format!(
            "对话涵盖 {} 条消息。主要话题关键词：{}。",
            messages.len(),
            keyword_list.join("、")
        ));

        if !files_mentioned.is_empty() {
            summary_parts.push(format!("涉及文件：{}", files_mentioned.join(", ")));
        }

        if !decisions.is_empty() {
            summary_parts.push(format!(
                "关键决策：{}",
                decisions
                    .iter()
                    .map(|d| d.trim())
                    .collect::<Vec<_>>()
                    .join(" | ")
            ));
        }

        if !open_questions.is_empty() {
            summary_parts.push(format!(
                "待解决问题：{}",
                open_questions
                    .iter()
                    .map(|q| q.trim())
                    .collect::<Vec<_>>()
                    .join(" | ")
            ));
        }

        ContextSummary {
            summary: summary_parts.join("\n"),
            keywords: keyword_list,
            files_mentioned,
            decisions,
            open_questions,
            covered_range: (0, messages.len()),
        }
    }
}

impl Default for ContextCompressor {
    fn default() -> Self {
        Self::new(CompressionConfig::default())
    }
}

/// 智能消息去重：移除重复或高度相似的消息
pub fn deduplicate_messages(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut seen = HashSet::new();
    messages
        .iter()
        .filter(|m| {
            // 用内容的前 80 字符作为去重键
            let key: String = m.content.chars().take(80).collect();
            seen.insert(key.clone())
        })
        .cloned()
        .collect()
}

/// 估算文本的 token 数（CJK 感知）。
///
/// 英文/符号：约 4 字符 = 1 token（GPT-4 粗估）
/// 中文（CJK）：约 2 字符 = 1 token（中文编码密度更高）
pub fn estimate_text_tokens(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut ascii = 0usize;
    for ch in text.chars() {
        let code = ch as u32;
        if code < 0x80 {
            ascii += 1;
        } else if is_cjk_codepoint(code) {
            cjk += 1;
        } else {
            ascii += 1;
        }
    }
    ascii / 4 + cjk / 2
}

/// 判断 Unicode 码点是否为 CJK 字符
pub fn is_cjk_codepoint(code: u32) -> bool {
    (0x4E00..=0x9FFF).contains(&code)
        || (0x3400..=0x4DBF).contains(&code)
        || (0x20000..=0x2A6DF).contains(&code)
        || (0xF900..=0xFAFF).contains(&code)
        || (0x2F800..=0x2FA1F).contains(&code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_msg(content: &str) -> ChatMessage {
        ChatMessage {
            id: String::new(),
            role: Role::User,
            content: content.to_string(),
            reasoning: String::new(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            compaction_summary: false,
            internal: false,
            reminder: None,
            life_proactive: false,
            pinned: false,
            draft: false,
            provider_items: Vec::new(),
            images: Vec::new(),
            attachments: Vec::new(),
            quotes: Vec::new(),
            // 既有的坏测试：ChatMessage 新增 request_context 后这个手写初始化没跟上，
            // 导致 cargo check --all-targets / cargo test 直接在编译期失败。
            request_context: String::new(),
        }
    }

    #[test]
    fn test_estimate_tokens() {
        let compressor = ContextCompressor::default();
        let msgs = vec![make_msg("hello")];
        assert!(compressor.estimate_tokens(&msgs) > 0);
    }

    #[test]
    fn test_needs_compression() {
        let compressor = ContextCompressor::default();
        let small: Vec<ChatMessage> = vec![];
        assert!(!compressor.needs_compression(&small));
    }

    #[test]
    fn test_compress_small() {
        let compressor = ContextCompressor::default();
        let msgs = vec![make_msg("hi")];
        let (result, summary) = compressor.compress(&msgs);
        assert!(summary.is_none());
        assert_eq!(result.len(), 1);
    }
}
