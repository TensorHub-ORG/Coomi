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
// 压缩后保留最近三轮的真实用户指令、每轮最终助手回复，以及工作现场尾部。
// 消息数与正文预算均有上限，避免单次长 Agent 任务压缩后仍塞回完整工具瀑布流。
const COMPACT_RECENT_USER_MESSAGES: usize = 3;
const COMPACT_RECENT_ACTIVITY_MESSAGES: usize = 12;
const COMPACT_RECENT_ACTIVITY_MAX_TOKENS: u64 = 20_000;
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

    // 最近三轮必须按原始 user → assistant → tool 顺序整体保留。旧实现把所有
    // assistant/tool 提到 user 前面，会让下一轮模型看到“先回答、后提问”的伪历史，
    // 表现为同一会话中忘记上一轮。用户正文仍按新者优先受预算约束。
    let mut recent_users = Vec::new();
    let mut recent_budget = COMPACT_USER_MESSAGE_MAX_TOKENS;
    for position in recent.iter().rev() {
        if recent_budget == 0 {
            break;
        }
        let message = &messages[*position];
        let tokens = estimate_text_tokens(&message.content);
        if tokens <= recent_budget {
            recent_users.push((*position, message.clone()));
            recent_budget -= tokens;
        } else {
            let mut truncated = message.clone();
            truncated.content = truncate_text_to_tokens(&message.content, recent_budget);
            recent_users.push((*position, truncated));
            recent_budget = 0;
        }
    }
    recent_users.reverse();

    let mut recent_messages = Vec::new();
    for (position, user) in recent_users {
        recent_messages.push(user);
        let end = user_positions
            .iter()
            .copied()
            .find(|next| *next > position)
            .unwrap_or(messages.len());
        recent_messages.extend(
            messages[position + 1..end]
                .iter()
                .filter(|message| !message.compaction_summary)
                .cloned(),
        );
    }
    let recent_messages = bounded_recent_history(&recent_messages);

    // 结构：早期目标 → 摘要 → 最近完整会话轮次。
    let mut output = retained;
    output.push(ChatMessage::summary(format!("{SUMMARY_PREFIX}\n{summary}")));
    output.extend(recent_messages);
    output
}

/// Keep the recent transcript chronological while bounding long single-turn tool waterfalls.
/// The newest activity tail and each retained turn's final assistant reply survive; large content
/// is truncated from the older side of that retained set.
fn bounded_recent_history(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let real_user_positions = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            message.role == Role::User && !message.internal && !message.compaction_summary
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let activity_positions = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            !(message.role == Role::User && !message.internal && !message.compaction_summary)
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut kept_activity = activity_positions
        .iter()
        .rev()
        .take(COMPACT_RECENT_ACTIVITY_MESSAGES)
        .copied()
        .collect::<HashSet<_>>();

    for (turn, user_position) in real_user_positions.iter().enumerate() {
        let end = real_user_positions.get(turn + 1).copied().unwrap_or(messages.len());
        if let Some((assistant_position, _)) = messages[*user_position + 1..end]
            .iter()
            .enumerate()
            .rev()
            .find(|(_, message)| message.role == Role::Assistant)
        {
            kept_activity.insert(*user_position + 1 + assistant_position);
        }
    }

    let output = messages
        .iter()
        .enumerate()
        .filter(|(index, message)| {
            (message.role == Role::User && !message.internal && !message.compaction_summary)
                || kept_activity.contains(index)
        })
        .map(|(_, message)| message.clone())
        .collect::<Vec<_>>();
    let mut normalized = normalize_history(&output);
    // Opaque provider replay items are no longer needed after a fresh compaction summary and
    // can dwarf the visible transcript. Tool calls remain structured and are budgeted with
    // their matching outputs as an indivisible activity group.
    for message in &mut normalized {
        message.provider_items.clear();
    }

    let mut groups: Vec<(bool, Vec<ChatMessage>)> = Vec::new();
    let mut index = 0;
    while index < normalized.len() {
        let message = &normalized[index];
        let real_user = message.role == Role::User && !message.internal && !message.compaction_summary;
        if message.role == Role::Assistant && !message.tool_calls.is_empty() {
            let call_ids = message
                .tool_calls
                .iter()
                .map(|call| call.id.as_str())
                .collect::<HashSet<_>>();
            let mut group = vec![message.clone()];
            index += 1;
            while index < normalized.len()
                && normalized[index].role == Role::Tool
                && normalized[index]
                    .tool_call_id
                    .as_deref()
                    .is_some_and(|id| call_ids.contains(id))
            {
                group.push(normalized[index].clone());
                index += 1;
            }
            groups.push((false, group));
        } else {
            groups.push((real_user, vec![message.clone()]));
            index += 1;
        }
    }

    let mut retained_groups = Vec::new();
    let mut remaining = COMPACT_RECENT_ACTIVITY_MAX_TOKENS;
    for (real_user, mut group) in groups.into_iter().rev() {
        if real_user {
            retained_groups.push(group);
            continue;
        }
        let tokens = estimate_request_tokens("", &group, &[]);
        if tokens <= remaining {
            remaining -= tokens;
            retained_groups.push(group);
            continue;
        }
        // A plain assistant answer may be longer than the remaining budget. Preserve its newest
        // text tail. Structured tool-call groups are skipped whole so no malformed arguments or
        // orphaned results can enter the provider request.
        if group.len() == 1 && group[0].tool_calls.is_empty() && remaining > 0 {
            let mut shell = group[0].clone();
            shell.content.clear();
            let fixed = estimate_request_tokens("", &[shell], &[]);
            let content_budget = remaining.saturating_sub(fixed);
            if content_budget > 0 {
                group[0].content = truncate_text_to_tokens(&group[0].content, content_budget);
                remaining = remaining.saturating_sub(estimate_request_tokens("", &group, &[]));
                retained_groups.push(group);
            }
        }
    }
    retained_groups.reverse();
    let retained = retained_groups
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    normalize_history(&retained)
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
        // 结构：摘要 → 最近完整会话轮次；助手回复不能跑到提问前面。
        assert_eq!(compacted.len(), 4);
        assert!(compacted[0].compaction_summary);
        assert_eq!(compacted[1].content, "first");
        assert_eq!(compacted[2].role, Role::Assistant);
        assert_eq!(compacted[3].content, "second");
    }

    #[test]
    fn compaction_preserves_recent_user_assistant_turn_order() {
        let messages = vec![
            ChatMessage::user("第一问"),
            ChatMessage::assistant("第一答", Vec::new()),
            ChatMessage::user("第二问"),
            ChatMessage::assistant("第二答", Vec::new()),
            ChatMessage::user("第三问"),
        ];
        let compacted = compacted_history(&messages, "此前摘要");
        let transcript = compacted
            .iter()
            .filter(|message| !message.compaction_summary)
            .map(|message| (message.role, message.content.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(transcript, vec![
            (Role::User, "第一问"),
            (Role::Assistant, "第一答"),
            (Role::User, "第二问"),
            (Role::Assistant, "第二答"),
            (Role::User, "第三问"),
        ]);
    }

    #[test]
    fn compaction_bounds_a_tool_heavy_single_turn_without_losing_final_reply() {
        let mut messages = vec![ChatMessage::user("完成一个很长的任务")];
        for index in 0..80 {
            let call = ToolCall {
                id: format!("call-{index}"),
                name: "shell".into(),
                arguments: serde_json::json!({
                    "command": format!("step-{index}"),
                    "large_write": "a".repeat(24_000),
                }),
            };
            let mut assistant = ChatMessage::assistant("", vec![call]);
            assistant.provider_items.push(serde_json::json!({
                "type": "reasoning",
                "payload": "p".repeat(24_000),
            }));
            messages.push(assistant);
            messages.push(ChatMessage::tool(
                format!("call-{index}"),
                format!("tool output {index}: {}", "x".repeat(8_000)),
            ));
        }
        messages.push(ChatMessage::assistant("最终完成结论", Vec::new()));

        let compacted = compacted_history(&messages, "长任务摘要");
        assert!(compacted.iter().any(|message| message.content == "最终完成结论"));
        assert!(compacted.iter().all(|message| message.provider_items.is_empty()));
        assert!(
            compacted.len() <= COMPACT_RECENT_ACTIVITY_MESSAGES + 3,
            "tool waterfall should be a bounded suffix, got {} messages",
            compacted.len()
        );
        assert!(
            estimate_request_tokens("", &compacted, &[]) < 30_000,
            "bounded transcript unexpectedly exceeds its text budget"
        );
        let user = compacted.iter().position(|message| message.role == Role::User).unwrap();
        let final_reply = compacted.iter().position(|message| message.content == "最终完成结论").unwrap();
        assert!(user < final_reply);
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
        assert_eq!(compacted[1].content, "goal");
        assert_eq!(compacted[2].role, Role::Assistant);
        assert_eq!(compacted[3].role, Role::Tool);
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
