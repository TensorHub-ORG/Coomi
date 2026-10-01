//! 会话扩展功能 —— 分叉、搜索、自动标题生成。

use crate::Role;
use crate::SessionStore;
use anyhow::Result;
use std::fs;
use std::path::Path;
use uuid::Uuid;

/// 会话搜索结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionSearchResult {
    pub session_id: Uuid,
    pub title: Option<String>,
    pub matches: Vec<SessionMatch>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionMatch {
    pub message_id: String,
    pub role: String,
    pub snippet: String,
}

impl SessionStore {
    /// 从指定消息 ID 分叉会话
    pub fn fork_from(
        &self,
        source_id: Uuid,
        fork_at_message: &str,
        new_title: Option<&str>,
    ) -> Result<crate::Session> {
        let source = self.load(source_id)?;
        let split_index = source
            .find_message(fork_at_message)
            .ok_or_else(|| anyhow::anyhow!("message {} not found", fork_at_message))?;

        let mut forked =
            crate::Session::new(&source.provider_id, &source.model, source.cwd.clone());
        forked.messages = source.messages[..split_index].to_vec();
        forked.mode = source.mode;

        let title = new_title.map(|t| t.to_owned()).unwrap_or_else(|| {
            let first_user = forked
                .messages
                .iter()
                .find(|m| m.role == Role::User && !m.internal);
            match first_user {
                Some(m) => derive_title(&m.content),
                None => format!("Fork of {}", source.id),
            }
        });
        forked.title = title;

        self.save(&forked)?;
        Ok(forked)
    }

    /// 跨会话关键词搜索
    pub fn search(&self, query: &str) -> Result<Vec<SessionSearchResult>> {
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();

        if !self.directory().exists() {
            return Ok(results);
        }

        for entry in fs::read_dir(self.directory())? {
            let entry = entry?;
            if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(session) = serde_json::from_slice::<crate::Session>(&bytes) else {
                continue;
            };

            let mut matches = Vec::new();
            for message in &session.messages {
                if message.content.to_lowercase().contains(&query_lower) {
                    matches.push(SessionMatch {
                        message_id: message.id.clone(),
                        role: format!("{:?}", message.role),
                        snippet: truncate_around_match(&message.content, &query_lower, 60),
                    });
                }
            }

            if !matches.is_empty() {
                let title = if !session.title.trim().is_empty() {
                    Some(session.title.clone())
                } else {
                    let first_user = session
                        .messages
                        .iter()
                        .find(|m| m.role == Role::User && !m.internal);
                    first_user.map(|m| derive_title(&m.content))
                };
                results.push(SessionSearchResult {
                    session_id: session.id,
                    title,
                    matches,
                });
            }
        }

        Ok(results)
    }
}

/// 在文本中围绕匹配点截断
fn truncate_around_match(text: &str, query: &str, context_chars: usize) -> String {
    let text_lower = text.to_lowercase();
    let query_lower = query.to_lowercase();

    if let Some(pos) = text_lower.find(&query_lower) {
        // 全部按字符边界计算，避免中文等多字节字符下字节/字符索引混用导致截断错位。
        let chars: Vec<char> = text.chars().collect();
        let char_pos = text[..pos].chars().count();
        let query_chars = query.chars().count();
        let start = char_pos.saturating_sub(context_chars);
        let end = (char_pos + query_chars + context_chars).min(chars.len());
        let snippet: String = chars[start..end].iter().collect();
        if start > 0 {
            format!("…{}", snippet)
        } else if end < chars.len() {
            format!("{}…", snippet)
        } else {
            snippet
        }
    } else {
        text.chars().take(context_chars * 2).collect()
    }
}

/// 从用户消息派生标题
fn derive_title(value: &str) -> String {
    let single_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = single_line.trim();
    let mut chars = trimmed.chars();
    let head: String = chars.by_ref().take(42).collect();
    if chars.next().is_some() {
        format!("{}…", head)
    } else {
        head
    }
}

/// 上下文预热器
pub struct ContextWarmer {
    warm_entries: std::collections::HashMap<String, String>,
    warm_path: std::path::PathBuf,
}

impl ContextWarmer {
    pub fn new(coomi_home: impl AsRef<Path>) -> Self {
        let warm_path = coomi_home.as_ref().join("warm_context.json");
        let warm_entries = if warm_path.exists() {
            fs::read_to_string(&warm_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            std::collections::HashMap::new()
        };
        Self {
            warm_entries,
            warm_path,
        }
    }

    /// 将预热上下文插入到 system prompt 之前
    pub fn warm(&self, system_prompt: &str) -> String {
        if self.warm_entries.is_empty() {
            return system_prompt.to_string();
        }
        let mut warm_parts = Vec::new();
        for (key, value) in &self.warm_entries {
            warm_parts.push(format!(
                "<warm_context key=\"{}\">\n{}\n</warm_context>",
                key, value
            ));
        }
        format!("{}\n\n{}", system_prompt, warm_parts.join("\n\n"))
    }

    /// 学习新的常用上下文
    pub fn learn(&mut self, key: &str, value: &str) {
        self.warm_entries.insert(key.to_string(), value.to_string());
        // 限制最多 20 条
        if self.warm_entries.len() > 20 {
            let excess = self.warm_entries.len() - 20;
            let keys_to_remove: Vec<String> = self
                .warm_entries
                .iter()
                .take(excess)
                .map(|(k, _)| k.clone())
                .collect();
            for k in keys_to_remove {
                self.warm_entries.remove(&k);
            }
        }
    }

    pub fn save(&self) -> Result<(), std::io::Error> {
        let json = serde_json::to_string_pretty(&self.warm_entries)?;
        fs::write(&self.warm_path, json)
    }

    pub fn len(&self) -> usize {
        self.warm_entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_around_match() {
        let text = "这是一个很长的文本内容，我们需要在里面找到特定的关键词";
        let snippet = truncate_around_match(text, "特定", 10);
        assert!(snippet.contains("特定"));
    }

    #[test]
    fn test_derive_title() {
        // 超过 42 字符才触发截断，预期标题以省略号结尾。
        let title = derive_title("这是一个测试用的标题，这段文字需要足够长才能触发截断逻辑，必须明显超过四十二个字符的长度限制才行，否则断言不会成立，所以再多写一些内容");
        assert!(title.ends_with('…'));
        assert!(title.chars().count() <= 43);
    }
}
