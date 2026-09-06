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
// 压缩后保留的"最近用户指令"条数与"最近工具活动"消息数：
// 摘要之后依次跟随工具活动尾部与最近用户指令，保证模型最后读到的是最新指令与工作现场。
const COMPACT_RECENT_USER_MESSAGES: usize = 3;
const COMPACT_RECENT_TOOL_MESSAGES: usize = 5;
const CONTEXT_WINDOW_TRUNCATED_OUTPUT: &str =
    "Output exceeded the available model context and was truncated";

pub const SUMMARIZATION_PROMPT: &str = "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nRespond with the following sections, in this order:\n1. TASK GOAL - the user's original task and the desired outcome.\n2. COMPLETED - work already done, with key decisions and important file/artifact paths.\n3. IN PROGRESS - the exact step underway when this summary was created.\n4. NEXT STEPS - ordered actions that remain.\n5. ACTIVE USER INSTRUCTIONS - every constraint and instruction the user has given. Honor recency: when a later user instruction conflicts with an earlier one or with the original task, the LATER instruction wins, and the override must be recorded here.\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work instead of restarting it.";
pub const SUMMARY_PREFIX: &str = "Another language model started to solve this problem and produced a summary of its thinking process. Recent working messages and the latest user instructions follow this summary. Build on the work that has already been done, avoid duplicating it, and when a recent user instruction conflicts with the summary, follow the user instruction. Here is the summary:";

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
    let user_positions: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            message.role == Role::User && !message.compaction_summary && !message.internal
        })
        .map(|(index, _)| index)
        .collect();
    let recent_count = COMPACT_RECENT_USER_MESSAGES.min(user_positions.len());
    let older = &user_positions[..user_positions.len() - recent_count];
    let recent = &user_positions[user_positions.len() - recent_count..];

    // 早期用户消息：新者优先占用预算，超预算时从更早的消息开始丢弃/截断。
    let mut retained = Vec::new();
    let mut budget = COMPACT_USER_MESSAGE_MAX_TOKENS;
    for position in older.iter().rev() {
        if budget == 0 {
            break;
        }
        let message = &messages[*position];
        let tokens = estimate_text_tokens(&message.content);
        if tokens <= budget {
            retained.push(message.clone());
            budget -= tokens;
        } else {
            let mut truncated = message.clone();
            truncated.content = truncate_text_to_tokens(&message.content, budget);
            retained.push(truncated);
            break;
        }
    }
    retained.reverse();

    // 最近工具活动尾部：保留最近几条 assistant/tool 消息作为工作现场；
    // 窗口切断造成的悬空 tool 输出由 normalize_history 丢弃/补齐。
    let tail: Vec<ChatMessage> = messages
        .iter()
        .rev()
        .filter(|message| message.role != Role::User)
        .take(COMPACT_RECENT_TOOL_MESSAGES)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let tail = normalize_history(&tail);

    // 最近用户指令：置于历史最末，保证模型最后读到的是最新指令；
    // 同样受预算约束（新者优先），单条超预算截断，预算耗尽后更早的最近消息跳过。
    let mut recent_messages = Vec::new();
    let mut recent_budget = COMPACT_USER_MESSAGE_MAX_TOKENS;
    for position in recent.iter().rev() {
        if recent_budget == 0 {
            break;
        }
        let message = &messages[*position];
        let tokens = estimate_text_tokens(&message.content);
        if tokens <= recent_budget {
            recent_messages.push(message.clone());
            recent_budget -= tokens;
        } else {
            let mut truncated = message.clone();
            truncated.content = truncate_text_to_tokens(&message.content, recent_budget);
            recent_messages.push(truncated);
            recent_budget = 0;
        }
    }
    recent_messages.reverse();

    // 结构：早期用户消息 → 摘要 → 最近工具活动 → 最近用户指令
    let mut output = retained;
    output.push(ChatMessage::summary(format!("{SUMMARY_PREFIX}\n{summary}")));
    output.extend(tail);
    output.extend(recent_messages);
    output
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
    // 逐条删除最旧消息以塞进预算；首条真实用户消息（原始任务目标）必须保住——
    // 否则摘要模型看不到任务，产出的摘要丢失进度，压缩后 Agent 会"重新开始"。
    while messages.len() > 1
        && estimate_request_tokens(system_prompt, messages, tools) > token_limit
    {
        let front_is_protected_user = messages.first().is_some_and(|message| {
            message.role == Role::User && !message.internal && !message.compaction_summary
        });
        let remove_index = if front_is_protected_user { 1 } else { 0 };
        messages.remove(remove_index);
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
        // 结构：摘要 → 工具活动尾部 → 最近用户指令
        assert_eq!(compacted.len(), 4);
        assert!(compacted[0].compaction_summary);
        assert_eq!(compacted[1].role, Role::Assistant);
        assert_eq!(compacted[2].content, "first");
        assert_eq!(compacted[3].content, "second");
    }

    #[test]
    fn compaction_caps_retained_user_history() {
        let messages = vec![ChatMessage::user("x".repeat(100_000))];
        let compacted = compacted_history(&messages, "summary");
        assert_eq!(compacted.len(), 2);
        assert!(compacted[0].compaction_summary);
        assert!(estimate_text_tokens(&compacted[1].content) <= COMPACT_USER_MESSAGE_MAX_TOKENS);
    }

    #[test]
    fn compaction_moves_recent_user_instructions_after_summary() {
        let messages = vec![
            ChatMessage::user("goal"),
            ChatMessage::user("pivot-a"),
            ChatMessage::user("pivot-b"),
            ChatMessage::user("latest-instruction"),
        ];
        let compacted = compacted_history(&messages, "summary");
        // 最近 3 条用户指令移到摘要之后，早期消息保留在摘要之前
        assert_eq!(compacted[0].content, "goal");
        assert!(compacted[1].compaction_summary);
        assert_eq!(compacted[2].content, "pivot-a");
        assert_eq!(compacted[3].content, "pivot-b");
        assert_eq!(compacted[4].content, "latest-instruction");
    }

    #[test]
    fn compaction_keeps_recent_tool_activity_tail() {
        let messages = vec![
            ChatMessage::user("goal"),
            ChatMessage::assistant(
                "",
                vec![ToolCall {
                    id: "one".into(),
                    name: "edit_file".into(),
                    arguments: json!({}),
                }],
            ),
            ChatMessage::tool("one", "edited"),
            ChatMessage::user("latest"),
        ];
        let compacted = compacted_history(&messages, "summary");
        assert!(compacted[0].compaction_summary);
        assert_eq!(compacted[1].role, Role::Assistant);
        assert_eq!(compacted[2].role, Role::Tool);
        assert_eq!(compacted[3].content, "goal");
        assert_eq!(compacted[4].content, "latest");
    }

    #[test]
    fn trim_history_protects_first_real_user_message() {
        let system = "system";
        let tools: Vec<ToolSpec> = Vec::new();
        let mut messages = vec![
            ChatMessage::user("original task"),
            ChatMessage::assistant("working", Vec::new()),
            ChatMessage::user("recent instruction"),
        ];
        // 预算压到只够容纳首条用户消息，验证删除时保护的是它而不是后续消息
        let limit = estimate_request_tokens(system, &[ChatMessage::user("original task")], &tools);
        trim_history_to_fit(system, &mut messages, &tools, limit);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "original task");
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
