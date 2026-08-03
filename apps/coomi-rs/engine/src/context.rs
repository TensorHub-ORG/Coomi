use crate::AutoCompactScope;
use crate::ChatMessage;
use crate::ContextStatus;
use crate::ModelCapabilities;
use crate::Role;
use crate::TokenUsage;
use crate::ToolSpec;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashSet;
use uuid::Uuid;

const BASELINE_TOKENS: u64 = 12_000;
const COMPACT_USER_MESSAGE_MAX_TOKENS: u64 = 20_000;
const CONTEXT_WINDOW_TRUNCATED_OUTPUT: &str =
    "Output exceeded the available model context and was truncated";

pub const SUMMARIZATION_PROMPT: &str = "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.";
pub const SUMMARY_PREFIX: &str = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContextState {
    #[serde(default)]
    pub last_usage: TokenUsage,
    #[serde(default)]
    pub estimated_active_tokens: u64,
    #[serde(default)]
    pub compaction_count: u64,
    #[serde(default)]
    pub server_observed_local_tokens: u64,
    #[serde(default)]
    pub prefill_input_tokens: Option<u64>,
    #[serde(default)]
    pub comp_hash: Option<String>,
    #[serde(default)]
    pub first_window_id: Option<Uuid>,
    #[serde(default)]
    pub previous_window_id: Option<Uuid>,
    #[serde(default)]
    pub window_id: Option<Uuid>,
}

impl ContextState {
    pub fn observe_usage(
        &mut self,
        usage: &TokenUsage,
        system_prompt: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        capabilities: &ModelCapabilities,
    ) {
        self.last_usage = usage.clone();
        self.estimated_active_tokens = usage.total_tokens();
        self.server_observed_local_tokens = estimate_request_tokens(system_prompt, messages, tools);
        if capabilities.auto_compact_scope == AutoCompactScope::BodyAfterPrefix
            && self.prefill_input_tokens.is_none()
        {
            self.prefill_input_tokens = Some(usage.input_tokens);
        }
        self.comp_hash = capabilities.comp_hash.clone();
    }

    pub fn recompute(&mut self, system_prompt: &str, messages: &[ChatMessage], tools: &[ToolSpec]) {
        let local_tokens = estimate_request_tokens(system_prompt, messages, tools);
        self.estimated_active_tokens =
            if self.last_usage.total_tokens() > 0 && self.server_observed_local_tokens > 0 {
                self.last_usage
                    .total_tokens()
                    .saturating_add(local_tokens.saturating_sub(self.server_observed_local_tokens))
            } else {
                local_tokens
            };
    }

    pub fn reset_after_compaction(
        &mut self,
        system_prompt: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        capabilities: &ModelCapabilities,
    ) {
        let previous = self.window_id.unwrap_or_else(Uuid::new_v4);
        self.first_window_id.get_or_insert(previous);
        self.previous_window_id = Some(previous);
        self.window_id = Some(Uuid::new_v4());
        self.compaction_count = self.compaction_count.saturating_add(1);
        self.last_usage = TokenUsage::default();
        self.server_observed_local_tokens = 0;
        self.estimated_active_tokens = estimate_request_tokens(system_prompt, messages, tools);
        self.prefill_input_tokens = (capabilities.auto_compact_scope
            == AutoCompactScope::BodyAfterPrefix)
            .then_some(self.estimated_active_tokens);
        self.comp_hash = capabilities.comp_hash.clone();
    }

    pub fn auto_compact_scope_tokens(&self, capabilities: &ModelCapabilities) -> u64 {
        match capabilities.auto_compact_scope {
            AutoCompactScope::Total => self.estimated_active_tokens,
            AutoCompactScope::BodyAfterPrefix => self.estimated_active_tokens.saturating_sub(
                self.prefill_input_tokens
                    .unwrap_or(self.estimated_active_tokens),
            ),
        }
    }

    pub fn should_compact(&self, capabilities: &ModelCapabilities) -> bool {
        self.auto_compact_scope_tokens(capabilities) >= capabilities.auto_compact_token_limit()
            || self.estimated_active_tokens >= capabilities.context_window
            || self
                .comp_hash
                .as_ref()
                .zip(capabilities.comp_hash.as_ref())
                .is_some_and(|(previous, current)| previous != current)
    }

    pub fn status(&self, capabilities: &ModelCapabilities) -> ContextStatus {
        let effective = capabilities.effective_context_window();
        let used = self.estimated_active_tokens;
        let remaining_percent = if effective <= BASELINE_TOKENS {
            0
        } else {
            let adjustable = effective - BASELINE_TOKENS;
            let adjustable_used = used.saturating_sub(BASELINE_TOKENS);
            u8::try_from(
                adjustable
                    .saturating_sub(adjustable_used)
                    .saturating_mul(100)
                    .saturating_div(adjustable)
                    .min(100),
            )
            .unwrap_or(0)
        };
        ContextStatus {
            used_tokens: used,
            context_window: capabilities.context_window,
            effective_context_window: effective,
            auto_compact_token_limit: capabilities.auto_compact_token_limit(),
            remaining_tokens: effective.saturating_sub(used),
            used_percent: 100u8.saturating_sub(remaining_percent),
            remaining_percent,
            auto_compact_scope_tokens: self.auto_compact_scope_tokens(capabilities),
            compaction_count: self.compaction_count,
        }
    }
}

pub fn normalize_history(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut known_calls = HashSet::new();
    for message in messages {
        if message.role == Role::Assistant {
            known_calls.extend(message.tool_calls.iter().map(|call| call.id.clone()));
        }
    }

    let output_ids = messages
        .iter()
        .filter(|message| message.role == Role::Tool)
        .filter_map(|message| message.tool_call_id.clone())
        .collect::<HashSet<_>>();
    let mut output = Vec::with_capacity(messages.len());
    for message in messages {
        if message.role == Role::Tool
            && message
                .tool_call_id
                .as_ref()
                .is_none_or(|id| !known_calls.contains(id))
        {
            continue;
        }
        output.push(message.clone());
        if message.role == Role::Assistant {
            for call in &message.tool_calls {
                if !output_ids.contains(&call.id) {
                    output.push(ChatMessage::tool(&call.id, "error: aborted"));
                }
            }
        }
    }
    output
}

pub fn estimate_request_tokens(
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
) -> u64 {
    let mut bytes = u64::try_from(system_prompt.len()).unwrap_or(u64::MAX);
    for message in messages {
        bytes = bytes
            .saturating_add(u64::try_from(message.content.len()).unwrap_or(u64::MAX))
            .saturating_add(32);
        for call in &message.tool_calls {
            bytes = bytes
                .saturating_add(u64::try_from(call.name.len()).unwrap_or(u64::MAX))
                .saturating_add(u64::try_from(call.arguments.to_string().len()).unwrap_or(u64::MAX))
                .saturating_add(24);
        }
        for item in &message.provider_items {
            bytes = bytes.saturating_add(u64::try_from(item.to_string().len()).unwrap_or(u64::MAX));
        }
        for image in &message.images {
            bytes = bytes
                .saturating_add(u64::try_from(image.media_type.len()).unwrap_or(u64::MAX))
                // 图片 base64 数据不计入 token 预算：全量数据会撑爆估算，
                // 导致「读一张图就触发上下文压缩」。每张图按固定 ~85 token 估算。
                .saturating_add(85 * 4);
        }
    }
    for tool in tools {
        bytes = bytes
            .saturating_add(u64::try_from(tool.name.len()).unwrap_or(u64::MAX))
            .saturating_add(u64::try_from(tool.description.len()).unwrap_or(u64::MAX))
            .saturating_add(u64::try_from(tool.parameters.to_string().len()).unwrap_or(u64::MAX));
    }
    bytes.saturating_add(3) / 4
}

pub fn compacted_history(messages: &[ChatMessage], summary: &str) -> Vec<ChatMessage> {
    let mut compacted = retained_user_history(messages);
    compacted.push(ChatMessage::summary(format!("{SUMMARY_PREFIX}\n{summary}")));
    compacted
}

pub fn retained_user_history(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut retained = Vec::new();
    let mut remaining = COMPACT_USER_MESSAGE_MAX_TOKENS;
    for message in messages.iter().rev().filter(|message| {
        message.role == Role::User && !message.compaction_summary && !message.internal
    }) {
        if remaining == 0 {
            break;
        }
        let tokens = estimate_text_tokens(&message.content);
        if tokens <= remaining {
            retained.push(message.clone());
            remaining = remaining.saturating_sub(tokens);
        } else {
            let mut truncated = message.clone();
            truncated.content = truncate_text_to_tokens(&message.content, remaining);
            retained.push(truncated);
            break;
        }
    }
    retained.reverse();
    retained
}

pub fn trim_history_to_fit(
    system_prompt: &str,
    messages: &mut Vec<ChatMessage>,
    tools: &[ToolSpec],
    token_limit: u64,
) -> usize {
    let mut rewritten = 0;
    for index in 0..messages.len() {
        if estimate_request_tokens(system_prompt, messages, tools) <= token_limit {
            break;
        }
        let message = &mut messages[index];
        if message.role != Role::Tool {
            continue;
        }
        if message.content != CONTEXT_WINDOW_TRUNCATED_OUTPUT {
            message.content = CONTEXT_WINDOW_TRUNCATED_OUTPUT.into();
            rewritten += 1;
        }
    }
    while messages.len() > 1
        && estimate_request_tokens(system_prompt, messages, tools) > token_limit
    {
        messages.remove(0);
        *messages = normalize_history(messages);
    }
    if estimate_request_tokens(system_prompt, messages, tools) > token_limit
        && let Some(message) = messages.first_mut()
    {
        let fixed = estimate_request_tokens(system_prompt, &[], tools);
        message.content =
            truncate_text_to_tokens(&message.content, token_limit.saturating_sub(fixed));
    }
    rewritten
}

fn estimate_text_tokens(value: &str) -> u64 {
    u64::try_from(value.len())
        .unwrap_or(u64::MAX)
        .saturating_add(3)
        / 4
}

fn truncate_text_to_tokens(value: &str, max_tokens: u64) -> String {
    let max_bytes = usize::try_from(max_tokens.saturating_mul(4)).unwrap_or(usize::MAX);
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let marker = "[earlier content truncated]\n";
    let keep = max_bytes.saturating_sub(marker.len());
    let mut start = value.len().saturating_sub(keep);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    format!("{marker}{}", &value[start..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolCall;
    use serde_json::json;

    #[test]
    fn normalization_pairs_calls_and_drops_orphans() {
        let messages = vec![
            ChatMessage::assistant(
                "",
                vec![ToolCall {
                    id: "one".into(),
                    name: "read_file".into(),
                    arguments: json!({}),
                }],
            ),
            ChatMessage::tool("orphan", "ignored"),
        ];
        let normalized = normalize_history(&messages);
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[1].tool_call_id.as_deref(), Some("one"));
        assert!(normalized[1].content.contains("aborted"));
    }

    #[test]
    fn compacted_history_keeps_real_user_messages_and_one_summary() {
        let messages = vec![
            ChatMessage::user("first"),
            ChatMessage::summary(format!("{SUMMARY_PREFIX}\nold")),
            ChatMessage::assistant("answer", Vec::new()),
            ChatMessage::user("second"),
        ];
        let compacted = compacted_history(&messages, "new");
        assert_eq!(compacted.len(), 3);
        assert!(compacted[2].compaction_summary);
    }

    #[test]
    fn compaction_caps_retained_user_history() {
        let messages = vec![ChatMessage::user("x".repeat(100_000))];
        let compacted = compacted_history(&messages, "summary");
        assert_eq!(compacted.len(), 2);
        assert!(estimate_text_tokens(&compacted[0].content) <= COMPACT_USER_MESSAGE_MAX_TOKENS);
    }

    #[test]
    fn compaction_advances_persistent_window_ids() {
        let mut state = ContextState::default();
        state.reset_after_compaction("system", &[], &[], &ModelCapabilities::default());
        assert_eq!(state.compaction_count, 1);
        assert_eq!(state.first_window_id, state.previous_window_id);
        assert_ne!(state.previous_window_id, state.window_id);
    }
}
