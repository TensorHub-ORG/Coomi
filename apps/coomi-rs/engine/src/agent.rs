use crate::AgentEvent;
use crate::AgentObserver;
use crate::ApprovalHandler;
use crate::ChatMessage;
use crate::CompactionRequest;
use crate::InputQueue;
use crate::ModelProvider;
use crate::ModelRequest;
use crate::ModelStreamObserver;
use crate::ProviderRequestError;
use crate::SUMMARIZATION_PROMPT;
use crate::Session;
use crate::ToolConcurrency;
use crate::ToolCall;
use crate::ToolResult;
use crate::ToolRuntime;
use crate::TurnControl;
use crate::compacted_history;
use crate::normalize_history;
use crate::trim_history_to_fit;
use crate::types::sanitize_json_encoded_data;
use crate::types::sanitize_long_encoded_data;
use futures_util::future::join_all;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Semaphore;

#[derive(Clone, Copy, Debug, Default)]
struct ToolFailureState {
    executions: u8,
    requires_changed_call: bool,
}

#[derive(Debug)]
pub enum AgentError {
    Provider(anyhow::Error),
    Compaction(anyhow::Error),
    ToolRoundLimit { limit: usize },
    Hook(String),
    Control(String),
}

impl fmt::Display for AgentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Provider(error) => write!(formatter, "provider request failed: {error}"),
            Self::Compaction(error) => write!(formatter, "context compaction failed: {error}"),
            Self::ToolRoundLimit { limit } => {
                write!(formatter, "tool round limit reached ({limit})")
            }
            Self::Hook(error) => write!(formatter, "hook failed: {error}"),
            Self::Control(error) => write!(formatter, "task control failed: {error}"),
        }
    }
}

impl std::error::Error for AgentError {}

pub struct Agent {
    system_prompt: String,
    max_tool_rounds: usize,
    provider_retry_count: u8,
    reconnect_initial_delay_ms: u64,
    reconnect_max_delay_ms: u64,
    max_parallel_tools: usize,
    force_compaction: bool,
    input_queue: Option<Arc<InputQueue>>,
    /// 是否在请求中重放历史图片（Tool 消息的 images）。
    /// 为 false 时（图片降级会话）每个模型请求前都会剥离历史/当轮
    /// 工具消息携带的图片，避免上游拒绝图片导致整会话反复失败。
    vision_replay: bool,
    vision_fallback: Option<Arc<dyn Fn() + Send + Sync>>,
    reasoning_effort: Option<String>,
    /// 上下文检查点回调：任务执行中的关键节点（用户消息、模型回复、每轮
    /// 工具结果）落盘会话，意外中断/重启后仍能从磁盘恢复完整上下文。
    checkpoint: Option<Arc<dyn Fn(&Session) + Send + Sync>>,
    turn_control: Option<Arc<dyn TurnControl>>,
}

impl Agent {
    pub fn new(system_prompt: impl Into<String>) -> Self {
        Self {
            system_prompt: system_prompt.into(),
            max_tool_rounds: 192,
            provider_retry_count: 2,
            reconnect_initial_delay_ms: 1_000,
            reconnect_max_delay_ms: 10_000,
            max_parallel_tools: 5,
            force_compaction: false,
            input_queue: None,
            vision_replay: true,
            vision_fallback: None,
            reasoning_effort: None,
            checkpoint: None,
            turn_control: None,
        }
    }

    /// 注册上下文检查点：每次关键消息落盘时调用（由调用方负责持久化 session）。
    pub fn with_checkpoint(mut self, checkpoint: Arc<dyn Fn(&Session) + Send + Sync>) -> Self {
        self.checkpoint = Some(checkpoint);
        self
    }

    pub fn with_turn_control(mut self, control: Arc<dyn TurnControl>) -> Self {
        self.turn_control = Some(control);
        self
    }

    async fn safe_point(&self) -> Result<(), AgentError> {
        if let Some(control) = &self.turn_control {
            control
                .safe_point()
                .await
                .map_err(|error| AgentError::Control(format!("{error:#}")))?;
        }
        Ok(())
    }

    /// 执行检查点（若已注册）。中断保护：任务执行中的上下文按节点落盘，
    /// 断线/被杀后重连同 session 仍能恢复完整记录。
    fn run_checkpoint(&self, session: &Session) {
        if let Some(checkpoint) = &self.checkpoint {
            checkpoint(session);
        }
    }

    pub fn with_forced_compaction(mut self, force_compaction: bool) -> Self {
        self.force_compaction = force_compaction;
        self
    }

    pub fn with_max_tool_rounds(mut self, max_tool_rounds: usize) -> Self {
        self.max_tool_rounds = max_tool_rounds.clamp(1, 512);
        self
    }

    /// Configure retries for transient provider failures. A count of zero disables
    /// automatic replay. Non-retryable protocol/auth/argument failures still fail fast.
    pub fn with_provider_retry_policy(
        mut self,
        retry_count: u8,
        initial_delay_ms: u64,
        max_delay_ms: u64,
    ) -> Self {
        self.provider_retry_count = retry_count.min(10);
        self.reconnect_initial_delay_ms = initial_delay_ms.clamp(500, 60_000);
        self.reconnect_max_delay_ms = max_delay_ms
            .clamp(1_000, 120_000)
            .max(self.reconnect_initial_delay_ms);
        self
    }

    pub fn with_max_parallel_tools(mut self, max_parallel_tools: usize) -> Self {
        self.max_parallel_tools = max_parallel_tools.clamp(1, 16);
        self
    }

    pub fn with_input_queue(mut self, input_queue: Arc<InputQueue>) -> Self {
        self.input_queue = Some(input_queue);
        self
    }

    pub fn with_vision_replay(mut self, vision_replay: bool) -> Self {
        self.vision_replay = vision_replay;
        self
    }

    pub fn with_vision_fallback(mut self, fallback: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.vision_fallback = Some(fallback);
        self
    }

    pub fn with_reasoning_effort(mut self, effort: impl Into<String>) -> Self {
        self.reasoning_effort = Some(effort.into());
        self
    }

    pub async fn run_turn(
        &self,
        session: &mut Session,
        prompt: impl Into<String>,
        provider: &dyn ModelProvider,
        tools: &dyn ToolRuntime,
        approval: &dyn ApprovalHandler,
        observer: &dyn AgentObserver,
    ) -> Result<String, AgentError> {
        self.run_accounted_turn(
            session,
            ChatMessage::user(prompt),
            provider,
            tools,
            approval,
            observer,
        )
        .await
    }

    /// Resume an interrupted turn without presenting the recovery instruction as a
    /// new user-authored message in clients or transcript-derived metadata.
    pub async fn continue_interrupted_turn(
        &self,
        session: &mut Session,
        provider: &dyn ModelProvider,
        tools: &dyn ToolRuntime,
        approval: &dyn ApprovalHandler,
        observer: &dyn AgentObserver,
    ) -> Result<String, AgentError> {
        self.run_accounted_turn(
            session,
            ChatMessage::internal_user(
                "<recovery_context>The previous turn was interrupted by a temporary network or upstream service failure. Continue from the current session checkpoint, complete only the unfinished work, and do not repeat completed tool operations.</recovery_context>",
            ),
            provider,
            tools,
            approval,
            observer,
        )
        .await
    }

    pub async fn continue_loop(
        &self,
        session: &mut Session,
        provider: &dyn ModelProvider,
        tools: &dyn ToolRuntime,
        approval: &dyn ApprovalHandler,
        observer: &dyn AgentObserver,
    ) -> Result<String, AgentError> {
        let objective = session
            .loop_state
            .as_ref()
            .filter(|state| state.status == crate::LoopStatus::Active)
            .map(|state| state.objective.clone())
            .unwrap_or_default();
        let prompt = format!(
            "<loop_context>\nContinue working autonomously toward the active Loop objective: {objective}\nMake concrete progress, use tools when needed, and only mark the Loop complete when the objective is fully achieved.\n</loop_context>"
        );
        self.run_accounted_turn(
            session,
            ChatMessage::internal_user(prompt),
            provider,
            tools,
            approval,
            observer,
        )
        .await
    }

    pub async fn compact_session(
        &self,
        session: &mut Session,
        provider: &dyn ModelProvider,
        tools: &dyn ToolRuntime,
        observer: &dyn AgentObserver,
    ) -> Result<(), AgentError> {
        if session.messages.is_empty() {
            return Err(AgentError::Compaction(anyhow::anyhow!(
                "the current session has no context to compact"
            )));
        }
        let tool_specs = tools.specs();
        session.messages = normalize_history(&session.messages);
        session
            .context
            .recompute(&self.system_prompt, &session.messages, &tool_specs);
        observer.on_event(&AgentEvent::ContextUpdated(
            session.context.status(&provider.capabilities()),
        ));
        self.compact(session, provider, &tool_specs, observer, false)
            .await?;
        session.touch();
        self.run_checkpoint(session);
        Ok(())
    }

    async fn run_accounted_turn(
        &self,
        session: &mut Session,
        prompt: ChatMessage,
        provider: &dyn ModelProvider,
        tools: &dyn ToolRuntime,
        approval: &dyn ApprovalHandler,
        observer: &dyn AgentObserver,
    ) -> Result<String, AgentError> {
        let usage_snapshot = session.usage.clone();
        let usage_before = usage_snapshot.total_tokens();
        let started = Instant::now();
        let mut result = self
            .run_turn_message(session, prompt, provider, tools, approval, observer)
            .await;
        let lifecycle = tools
            .lifecycle(
                "turn_end",
                serde_json::json!({
                    "session_id": session.id,
                    "success": result.is_ok(),
                    "error": result.as_ref().err().map(ToString::to_string),
                }),
            )
            .await;
        match lifecycle {
            Ok(Some(context)) if !context.trim().is_empty() => {
                session.messages.push(ChatMessage::internal_user(context));
            }
            Err(error) if result.is_ok() => result = Err(AgentError::Hook(error)),
            _ => {}
        }
        update_loop_accounting(
            session,
            usage_before,
            started.elapsed(),
            result.as_ref().err(),
            observer,
        );
        if result.is_ok() {
            observer.on_event(&AgentEvent::TurnCompleted {
                total: session.usage.clone(),
                turn: session.usage.saturating_sub(&usage_snapshot),
            });
        }
        result
    }

    async fn run_turn_message(
        &self,
        session: &mut Session,
        prompt: ChatMessage,
        provider: &dyn ModelProvider,
        tools: &dyn ToolRuntime,
        approval: &dyn ApprovalHandler,
        observer: &dyn AgentObserver,
    ) -> Result<String, AgentError> {
        if !session.hooks_started {
            if let Some(context) = tools
                .lifecycle(
                    "session_start",
                    serde_json::json!({"session_id": session.id, "cwd": session.cwd}),
                )
                .await
                .map_err(AgentError::Hook)?
                .filter(|context| !context.trim().is_empty())
            {
                session.messages.push(ChatMessage::internal_user(context));
            }
            session.hooks_started = true;
        }
        if let Some(context) = tools
            .lifecycle(
                "turn_start",
                serde_json::json!({
                    "session_id": session.id,
                    "prompt": prompt.content,
                    "internal": prompt.internal,
                }),
            )
            .await
            .map_err(AgentError::Hook)?
            .filter(|context| !context.trim().is_empty())
        {
            session.messages.push(ChatMessage::internal_user(context));
        }
        session.messages.push(prompt);
        self.run_checkpoint(session);
        let tool_specs = tools.specs();
        let capabilities = provider.capabilities();
        let mut compacted_for_provider_error = false;
        let mut vision_replay = self.vision_replay;
        let mut invalid_tool_retry_used = false;
        let mut tool_failures: HashMap<String, ToolFailureState> = HashMap::new();

        'tool_rounds: for round in 1..=self.max_tool_rounds {
            self.safe_point().await?;
            session.messages = normalize_history(&session.messages);
            session
                .context
                .recompute(&self.system_prompt, &session.messages, &tool_specs);
            observer.on_event(&AgentEvent::ContextUpdated(
                session.context.status(&capabilities),
            ));
            let should_compact = (self.force_compaction && round == 1)
                || session.context.should_compact(&capabilities);
            if should_compact {
                self.compact(
                    session,
                    provider,
                    &tool_specs,
                    observer,
                    !(self.force_compaction && round == 1),
                )
                .await?;
            }

            observer.on_event(&AgentEvent::ModelStarted {
                provider: provider.provider_id().to_string(),
                model: provider.model().to_string(),
                round,
            });

            let mut messages = Vec::with_capacity(session.messages.len() + 1);
            messages.push(ChatMessage::system(self.system_prompt.clone()));
            messages.extend(session.messages.iter().cloned());
            for message in &mut messages {
                message.content = sanitize_long_encoded_data(&message.content);
                for item in &mut message.provider_items {
                    sanitize_json_encoded_data(item);
                }
                for call in &mut message.tool_calls {
                    sanitize_json_encoded_data(&mut call.arguments);
                }
            }
            if !vision_replay {
                // 图片降级：请求中剥离工具消息携带的图片（base64），避免上游
                // 拒绝图片导致整会话反复失败。图片本身仍留在会话记录中，
                // 前端历史展示与 show_image 预览不受影响。
                for message in &mut messages {
                    message.images.clear();
                }
            }
            let mut request = ModelRequest {
                model: provider.model().to_string(),
                messages,
                tools: tool_specs.clone(),
                reasoning_effort: self.reasoning_effort.clone(),
            };
            let stream_observer = ObserverStream { observer };
            let mut retry_attempt = 0_u8;
            let mut image_retry_used = false;
            let response = loop {
                match provider
                    .complete_stream(request.clone(), &stream_observer)
                    .await
                {
                    Ok(response) => break response,
                    Err(error)
                        if !compacted_for_provider_error && is_context_window_error(&error) =>
                    {
                        compacted_for_provider_error = true;
                        self.compact(session, provider, &tool_specs, observer, true)
                            .await?;
                        self.run_checkpoint(session);
                        continue 'tool_rounds;
                    }
                    Err(error)
                        if !image_retry_used
                            && request_has_images(&request)
                            && is_image_compatibility_error(&error) =>
                    {
                        image_retry_used = true;
                        vision_replay = false;
                        strip_request_images(&mut request);
                        if let Some(fallback) = &self.vision_fallback {
                            fallback();
                        }
                        observer.on_event(&AgentEvent::StreamReset);
                        observer.on_event(&AgentEvent::ConnectionRetry {
                            attempt: 1,
                            max_attempts: 1,
                            delay_ms: 0,
                            message: "当前模型拒绝图片内容，正在切换为纯文本恢复".into(),
                        });
                    }
                    Err(error)
                        if retry_attempt < self.provider_retry_count
                            && is_transient_provider_error(&error) =>
                    {
                        retry_attempt += 1;
                        let delay_ms = retry_delay_ms(
                            &error,
                            retry_attempt,
                            self.reconnect_initial_delay_ms,
                            self.reconnect_max_delay_ms,
                        );
                        observer.on_event(&AgentEvent::StreamReset);
                        observer.on_event(&AgentEvent::ConnectionRetry {
                            attempt: retry_attempt,
                            max_attempts: self.provider_retry_count,
                            delay_ms,
                            message: "网络或上游服务暂时不可用，正在自动恢复".into(),
                        });
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    }
                    Err(error) => return Err(AgentError::Provider(error)),
                }
            };

            // 兜底：部分模型会把工具调用写成 XML 文本（<dots_function_call>/<invoke name=...> 等）。
            // 解析为原生调用执行，并从内容中剥离该片段；提示词侧同时要求遵守原生协议。
            let mut response_content = response.content;
            let mut response_tool_calls = response.tool_calls;
            if response_tool_calls.is_empty() && !response_content.is_empty() {
                if let Some(alias_calls) = parse_alias_xml_calls(&response_content) {
                    response_tool_calls = alias_calls;
                    response_content = strip_alias_xml(&response_content);
                }
            }

            session.usage.add(&response.usage);
            observer.on_event(&AgentEvent::ModelUsage {
                total: session.usage.clone(),
                request: response.usage.clone(),
            });
            if !response.streamed && !response_content.is_empty() {
                observer.on_event(&AgentEvent::Text(response_content.clone()));
            }
            let recorded_tool_calls = if response.invalid_tool_calls.is_empty() {
                response_tool_calls.clone()
            } else {
                Vec::new()
            };
            session.messages.push(ChatMessage::assistant(
                response_content.clone(),
                recorded_tool_calls,
            ));
            session.context.observe_usage(
                &response.usage,
                &self.system_prompt,
                &session.messages,
                &tool_specs,
                &capabilities,
            );
            observer.on_event(&AgentEvent::ContextUpdated(
                session.context.status(&capabilities),
            ));
            self.run_checkpoint(session);

            if !response.invalid_tool_calls.is_empty() {
                // A missing function name is a provider protocol failure, not
                // an argument-shape problem. Sending a correction prompt
                // cannot repair a tool call whose target is unknown and only
                // causes an avoidable second model request.
                let protocol_failure = response
                    .invalid_tool_calls
                    .iter()
                    .any(|call| {
                        call.reason.contains("no function name")
                            || call.name == "provider_protocol_error"
                    });
                if protocol_failure {
                    invalid_tool_retry_used = true;
                }
                if invalid_tool_retry_used {
                    for invalid in &response.invalid_tool_calls {
                        // A missing function name is a provider protocol
                        // failure, not an executable tool call. Do not emit a
                        // synthetic `unknown` tool card into the transcript.
                        if invalid.reason.contains("no function name")
                            || invalid.name == "provider_protocol_error"
                        {
                            continue;
                        }
                        let call = crate::ToolCall {
                            id: invalid.id.clone(),
                            name: invalid.name.clone(),
                            arguments: serde_json::json!({"invalid_arguments_omitted": true}),
                        };
                        let result = crate::ToolResult::error(format!(
                            "工具参数纠正后仍未通过校验，已阻止执行。{}",
                            invalid.reason
                        ));
                        observer.on_event(&AgentEvent::ToolStarted(call.clone()));
                        observer.on_event(&AgentEvent::ToolFinished { call, result });
                    }
                    let recovery_message = if protocol_failure {
                        "模型返回了不完整的工具调用（缺少函数名），相关工具未执行。请重试；如持续发生，请更换模型或检查供应商的工具调用兼容性。"
                    } else {
                        "工具参数在一次纠正后仍未通过校验，相关工具未执行。请调整请求或补充参数后继续。"
                    };
                    observer.on_event(&AgentEvent::Text(recovery_message.into()));
                    session
                        .messages
                        .push(ChatMessage::assistant(recovery_message, Vec::new()));
                    self.run_checkpoint(session);
                    session.touch();
                    return Ok(recovery_message.into());
                }
                invalid_tool_retry_used = true;
                let problems = response
                    .invalid_tool_calls
                    .iter()
                    .map(|call| tool_correction_problem(call, &tool_specs))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                session.messages.push(ChatMessage::internal_user(format!(
                    "<tool_call_correction>The previous tool call was not executed because its arguments were invalid. Return the same tool call once more with exactly one valid JSON object matching the supplied schema. Do not use Markdown fences or explanatory text.\n{problems}</tool_call_correction>"
                )));
                self.run_checkpoint(session);
                continue;
            }

            if response_tool_calls.is_empty() {
                if self.accept_queued_input(session, observer) {
                    continue;
                }
                session.touch();
                return Ok(response_content);
            }

            let calls = response_tool_calls;
            for call in &calls {
                observer.on_event(&AgentEvent::ToolStarted(call.clone()));
            }
            let specs_by_name: HashMap<&str, &crate::ToolSpec> = tool_specs
                .iter()
                .map(|spec| (spec.name.as_str(), spec))
                .collect();
            let mutating_resources: HashSet<String> = calls
                .iter()
                .filter(|call| {
                    specs_by_name
                        .get(call.name.as_str())
                        .is_none_or(|spec| spec.concurrency() != ToolConcurrency::ReadOnly)
                })
                .filter_map(|call| call.resource_key())
                .collect();
            let parallel_limit = Arc::new(Semaphore::new(self.max_parallel_tools));
            let serial_gate = Arc::new(AsyncMutex::new(()));
            let mut scheduled_fingerprints = HashSet::new();
            let scheduled = calls.into_iter().map(|call| {
                let fingerprint = tool_call_fingerprint(&call);
                let repeated_in_batch = !scheduled_fingerprints.insert(fingerprint.clone());
                let previous = tool_failures.get(&fingerprint).copied().unwrap_or_default();
                let blocked =
                    repeated_in_batch || previous.requires_changed_call || previous.executions >= 2;
                (call, fingerprint, blocked, previous, repeated_in_batch)
            });
            let executions = scheduled.map(
                |(call, fingerprint, blocked, previous, repeated_in_batch)| {
                    let parallel_limit = Arc::clone(&parallel_limit);
                    let serial_gate = Arc::clone(&serial_gate);
                    let resource = call.resource_key();
                    let read_only = specs_by_name
                        .get(call.name.as_str())
                        .is_some_and(|spec| spec.concurrency() == ToolConcurrency::ReadOnly);
                    let parallel = read_only
                        && resource
                            .as_ref()
                            .is_none_or(|key| !mutating_resources.contains(key));
                    async move {
                        let result = if blocked {
                            ToolResult::error(tool_retry_block_reason(previous, repeated_in_batch))
                        } else if parallel {
                            let _permit = parallel_limit.acquire().await.ok();
                            tools.call(&call, approval).await
                        } else {
                            let _guard = serial_gate.lock().await;
                            tools.call(&call, approval).await
                        };
                        (call, fingerprint, result, !blocked)
                    }
                },
            );

            for (call, fingerprint, mut result, executed) in join_all(executions).await {
                result.output = sanitize_long_encoded_data(&result.output);
                if let Some(context) = &mut result.additional_context {
                    *context = sanitize_long_encoded_data(context);
                }
                if let Some(plan) = result.plan.clone() {
                    session.plan = Some(plan.clone());
                    observer.on_event(&AgentEvent::PlanUpdated(plan));
                }
                if let Some(loop_state) = result.loop_state.clone() {
                    session.loop_state = Some(loop_state.clone());
                    observer.on_event(&AgentEvent::LoopUpdated(loop_state));
                }
                observer.on_event(&AgentEvent::ToolFinished {
                    call: call.clone(),
                    result: result.clone(),
                });
                let status = if result.success { "success" } else { "error" };
                let mut tool_message =
                    ChatMessage::tool(call.id, format!("{status}: {}", result.output));
                tool_message.images = result.images.clone();
                session.messages.push(tool_message);
                if let Some(context) = result.additional_context
                    && !context.trim().is_empty()
                {
                    session.messages.push(ChatMessage::internal_user(context));
                }
                if result.success {
                    tool_failures.remove(&fingerprint);
                } else if executed {
                    let state = tool_failures.entry(fingerprint).or_default();
                    state.executions = state.executions.saturating_add(1);
                    state.requires_changed_call =
                        tool_failure_requires_changed_call(&result.output);
                }
            }
            self.accept_queued_input(session, observer);
            self.run_checkpoint(session);
        }

        session.touch();
        Err(AgentError::ToolRoundLimit {
            limit: self.max_tool_rounds,
        })
    }

    async fn compact(
        &self,
        session: &mut Session,
        provider: &dyn ModelProvider,
        tool_specs: &[crate::ToolSpec],
        observer: &dyn AgentObserver,
        automatic: bool,
    ) -> Result<(), AgentError> {
        let before_tokens = session.context.estimated_active_tokens;
        observer.on_event(&AgentEvent::CompactionStarted { automatic });
        let capabilities = provider.capabilities();
        let mut normalized = normalize_history(&session.messages);
        // Compaction endpoints are commonly text-only even when normal chat supports
        // vision. Keep the textual tool result while never replaying image payloads.
        for message in &mut normalized {
            message.images.clear();
            message.content = sanitize_long_encoded_data(&message.content);
            for item in &mut message.provider_items {
                sanitize_json_encoded_data(item);
            }
            for call in &mut message.tool_calls {
                sanitize_json_encoded_data(&mut call.arguments);
            }
        }
        // 摘要输入（normalized）会被 trim 掐头或截断；压缩后的正式历史
        // 必须从这份未裁剪的脱敏副本取材，避免截断标记泄漏进后续上下文。
        let sanitized_source = normalized.clone();
        let compaction_limit = capabilities
            .context_window
            .saturating_sub(capabilities.max_output_tokens)
            .max(1);
        trim_history_to_fit(&self.system_prompt, &mut normalized, &[], compaction_limit);
        let remote = provider
            .compact(CompactionRequest {
                model: provider.model().to_string(),
                messages: normalized.clone(),
                system_prompt: self.system_prompt.clone(),
                tools: tool_specs.to_vec(),
            })
            .await
            .map_err(AgentError::Compaction)?;

        let (messages, compact_usage) = if let Some(response) = remote {
            (normalize_history(&response.messages), response.usage)
        } else {
            let prompt_overhead = crate::estimate_request_tokens(
                &self.system_prompt,
                &[ChatMessage::user(SUMMARIZATION_PROMPT)],
                &[],
            );
            trim_history_to_fit(
                &self.system_prompt,
                &mut normalized,
                &[],
                compaction_limit.saturating_sub(prompt_overhead).max(1),
            );
            let mut compact_input = Vec::with_capacity(normalized.len() + 2);
            compact_input.push(ChatMessage::system(self.system_prompt.clone()));
            compact_input.extend(normalized.clone());
            compact_input.push(ChatMessage::user(SUMMARIZATION_PROMPT));
            let request = ModelRequest {
                model: provider.model().to_string(),
                messages: compact_input,
                tools: Vec::new(),
                reasoning_effort: None,
            };
            // 内置策略：摘要调用失败或返回空内容时重试一次（上游瞬时错误常见），再失败才报压缩失败。
            let response = match provider.complete(request.clone()).await {
                Ok(response) if !response.content.trim().is_empty() => response,
                _ => {
                    let retried = provider
                        .complete(request)
                        .await
                        .map_err(AgentError::Compaction)?;
                    if retried.content.trim().is_empty() {
                        return Err(AgentError::Compaction(anyhow::anyhow!(
                            "compaction summary was empty"
                        )));
                    }
                    retried
                }
            };
            (
                compacted_history(&sanitized_source, response.content.trim()),
                response.usage,
            )
        };
        session.messages = messages;
        session.context.reset_after_compaction(
            &self.system_prompt,
            &session.messages,
            tool_specs,
            &capabilities,
        );
        session.usage.add(&compact_usage);
        let status = session.context.status(&provider.capabilities());
        observer.on_event(&AgentEvent::CompactionCompleted {
            automatic,
            before_tokens,
            after_tokens: status.used_tokens,
        });
        observer.on_event(&AgentEvent::ContextUpdated(status));
        Ok(())
    }

    fn accept_queued_input(&self, session: &mut Session, observer: &dyn AgentObserver) -> bool {
        let Some(input_queue) = &self.input_queue else {
            return false;
        };
        let messages = input_queue.drain();
        if messages.is_empty() {
            return false;
        }
        session
            .messages
            .extend(messages.iter().cloned().map(ChatMessage::user));
        observer.on_event(&AgentEvent::QueuedInputAccepted(messages));
        true
    }
}

fn tool_correction_problem(call: &crate::InvalidToolCall, specs: &[crate::ToolSpec]) -> String {
    let schema = specs
        .iter()
        .find(|spec| spec.name == call.name)
        .and_then(|spec| serde_json::to_string(&spec.parameters).ok())
        .map(|schema| truncate_chars(&schema, 4_000))
        .unwrap_or_else(|| "unavailable; do not guess fields".into());
    format!(
        "tool_name: {}\nvalidation_stage: arguments\nfield_error: {}\njson_schema: {}",
        call.name, call.reason, schema
    )
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_owned();
    }
    let mut output = input.chars().take(max_chars).collect::<String>();
    output.push_str("...[truncated]");
    output
}

fn tool_call_fingerprint(call: &crate::ToolCall) -> String {
    let arguments = serde_json::to_vec(&call.arguments).unwrap_or_default();
    let mut bytes = Vec::with_capacity(call.name.len() + 1 + arguments.len());
    bytes.extend_from_slice(call.name.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&arguments);
    format!("{:x}", md5::compute(bytes))
}

fn tool_failure_requires_changed_call(output: &str) -> bool {
    let text = output.to_ascii_lowercase();
    [
        "permission denied",
        "not permitted",
        "policy",
        "sandbox",
        "invalid argument",
        "invalid parameter",
        "missing required",
        "not found",
        "no such file",
        "old_string",
        "权限",
        "策略",
        "参数",
        "不存在",
        "未找到",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn tool_retry_block_reason(previous: ToolFailureState, repeated_in_batch: bool) -> String {
    if repeated_in_batch {
        return "已阻止同一批次中的重复工具调用；请合并调用或修改参数。".into();
    }
    if previous.requires_changed_call {
        return "相同工具与参数此前因权限、策略、参数或路径问题失败，已阻止原样重试；请修改参数、路径或改用其他工具。".into();
    }
    "相同工具与参数已达到最多一次重试上限，已阻止继续执行；请修改参数或切换工具。".into()
}

fn is_transient_provider_error(error: &anyhow::Error) -> bool {
    if let Some(error) = error.downcast_ref::<ProviderRequestError>() {
        return error.retryable;
    }
    let text = error.to_string().to_ascii_lowercase();
    if ["http 400", "http 401", "http 402", "http 403", "http 404"]
        .iter()
        .any(|status| text.contains(status))
    {
        return false;
    }
    [
        "timed out",
        "timeout",
        "connection",
        "dns",
        "reset",
        "broken pipe",
        "stream failed",
        "502",
        "503",
        "504",
        "429",
        "temporarily unavailable",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn retry_delay_ms(
    error: &anyhow::Error,
    attempt: u8,
    initial_delay_ms: u64,
    max_delay_ms: u64,
) -> u64 {
    if let Some(delay) = error
        .downcast_ref::<ProviderRequestError>()
        .and_then(|error| error.retry_after_ms)
    {
        return delay.clamp(initial_delay_ms, max_delay_ms);
    }
    let exponent = u32::from(attempt.saturating_sub(1)).min(16);
    let base = initial_delay_ms.saturating_mul(1_u64 << exponent);
    let jitter = (error
        .to_string()
        .bytes()
        .fold(0_u64, |sum, byte| sum.wrapping_add(u64::from(byte)))
        % 251)
        + 50;
    base.saturating_add(jitter).min(max_delay_ms)
}

fn request_has_images(request: &ModelRequest) -> bool {
    request
        .messages
        .iter()
        .any(|message| !message.images.is_empty())
}

fn strip_request_images(request: &mut ModelRequest) {
    for message in &mut request.messages {
        message.images.clear();
    }
}

fn is_image_compatibility_error(error: &anyhow::Error) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    [
        "image_url",
        "input_image",
        "inline_data",
        "media_type",
        "multimodal",
        "vision is not supported",
        "image input is not supported",
        "expected `text`",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn update_loop_accounting(
    session: &mut Session,
    usage_before: u64,
    elapsed: Duration,
    error: Option<&AgentError>,
    observer: &dyn AgentObserver,
) {
    let Some(loop_state) = session.loop_state.as_mut() else {
        return;
    };
    loop_state.tokens_used = loop_state
        .tokens_used
        .saturating_add(session.usage.total_tokens().saturating_sub(usage_before));
    loop_state.time_used_seconds = loop_state
        .time_used_seconds
        .saturating_add(elapsed.as_secs());
    loop_state.turns_completed = loop_state.turns_completed.saturating_add(1);
    if loop_state.status == crate::LoopStatus::Active
        && loop_state
            .token_budget
            .is_some_and(|budget| loop_state.tokens_used >= budget)
    {
        loop_state.status = crate::LoopStatus::BudgetLimited;
    } else if loop_state.status == crate::LoopStatus::Active
        && error.is_some_and(is_usage_limit_error)
    {
        loop_state.status = crate::LoopStatus::UsageLimited;
    }
    observer.on_event(&AgentEvent::LoopUpdated(loop_state.clone()));
}

fn is_usage_limit_error(error: &AgentError) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    text.contains("429")
        || text.contains("rate limit")
        || text.contains("usage limit")
        || text.contains("quota")
}

struct ObserverStream<'a> {
    observer: &'a dyn AgentObserver,
}

impl ModelStreamObserver for ObserverStream<'_> {
    fn on_text_delta(&self, delta: &str) {
        self.observer
            .on_event(&AgentEvent::TextDelta(delta.to_owned()));
    }

    fn on_reasoning_delta(&self, delta: &str) {
        self.observer
            .on_event(&AgentEvent::ReasoningDelta(delta.to_owned()));
    }
}

fn is_context_window_error(error: &anyhow::Error) -> bool {
    let value = format!("{error:#}").to_ascii_lowercase();
    value.contains("context_window_exceeded")
        || value.contains("context length")
        || value.contains("maximum context")
        || value.contains("too many tokens")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::InvalidToolCall;
    use crate::ModelCapabilities;
    use crate::ModelResponse;
    use crate::NoopObserver;
    use crate::ProviderErrorKind;
    use crate::ToolCall;
    use crate::ToolResult;
    use crate::ToolSpec;
    use anyhow::Result;
    use async_trait::async_trait;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    struct Approve;

    #[async_trait]
    impl ApprovalHandler for Approve {
        async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool {
            true
        }
    }

    struct EchoTool;

    #[async_trait]
    impl ToolRuntime for EchoTool {
        fn specs(&self) -> Vec<ToolSpec> {
            vec![ToolSpec {
                name: "echo".into(),
                description: "echo".into(),
                parameters: json!({"type": "object"}),
            }]
        }

        async fn call(&self, call: &ToolCall, _approval: &dyn ApprovalHandler) -> ToolResult {
            ToolResult::success(call.arguments["value"].as_str().unwrap_or_default())
        }
    }

    struct MockProvider {
        calls: Mutex<usize>,
    }

    #[async_trait]
    impl ModelProvider for MockProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "mock-model"
        }

        async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
            let mut calls = self.calls.lock().expect("lock mock call count");
            *calls += 1;
            if *calls == 1 {
                return Ok(ModelResponse {
                    tool_calls: vec![ToolCall {
                        id: "call-1".into(),
                        name: "echo".into(),
                        arguments: json!({"value": "ok"}),
                    }],
                    ..ModelResponse::default()
                });
            }
            assert!(request.messages.iter().any(|message| {
                message.role == crate::Role::Tool && message.content.contains("success: ok")
            }));
            Ok(ModelResponse {
                content: "done".into(),
                ..ModelResponse::default()
            })
        }
    }

    #[tokio::test]
    async fn completes_a_native_tool_loop() {
        let mut session = Session::new("mock", "mock-model", PathBuf::from("."));
        let provider = MockProvider {
            calls: Mutex::new(0),
        };
        let output = Agent::new("test")
            .run_turn(
                &mut session,
                "run",
                &provider,
                &EchoTool,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("agent turn");
        assert_eq!(output, "done");
        assert_eq!(session.messages.len(), 4);
    }

    struct ParallelReadTools;

    #[async_trait]
    impl ToolRuntime for ParallelReadTools {
        fn specs(&self) -> Vec<ToolSpec> {
            vec![ToolSpec {
                name: "read_file".into(),
                description: "read".into(),
                parameters: json!({"type": "object"}),
            }]
        }

        async fn call(&self, call: &ToolCall, _approval: &dyn ApprovalHandler) -> ToolResult {
            tokio::time::sleep(Duration::from_secs(1)).await;
            ToolResult::success(call.id.clone())
        }
    }

    struct ParallelReadProvider {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl ModelProvider for ParallelReadProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }
        fn model(&self) -> &str {
            "mock-model"
        }

        async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                return Ok(ModelResponse {
                    tool_calls: vec![
                        ToolCall {
                            id: "first".into(),
                            name: "read_file".into(),
                            arguments: json!({"path": "a"}),
                        },
                        ToolCall {
                            id: "second".into(),
                            name: "read_file".into(),
                            arguments: json!({"path": "b"}),
                        },
                    ],
                    ..ModelResponse::default()
                });
            }
            let outputs = request
                .messages
                .iter()
                .filter(|message| message.role == crate::Role::Tool)
                .collect::<Vec<_>>();
            assert_eq!(outputs.len(), 2);
            assert!(outputs[0].content.contains("first"));
            assert!(outputs[1].content.contains("second"));
            Ok(ModelResponse {
                content: "done".into(),
                ..ModelResponse::default()
            })
        }
    }

    #[tokio::test]
    async fn independent_read_tools_run_concurrently_and_keep_result_order() {
        let mut session = Session::new("mock", "mock-model", PathBuf::from("."));
        let provider = ParallelReadProvider {
            calls: AtomicUsize::new(0),
        };
        let started = Instant::now();
        Agent::new("test")
            .run_turn(
                &mut session,
                "read",
                &provider,
                &ParallelReadTools,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("parallel reads should complete");
        assert!(started.elapsed() < Duration::from_millis(1_700));
    }

    struct QueuedInputProvider {
        calls: Mutex<usize>,
    }

    #[async_trait]
    impl ModelProvider for QueuedInputProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "queued"
        }

        async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
            let mut calls = self.calls.lock().expect("lock calls");
            *calls += 1;
            if *calls == 1 {
                return Ok(ModelResponse {
                    content: "ready for follow-up".into(),
                    ..Default::default()
                });
            }
            assert!(request.messages.iter().any(|message| {
                message.role == crate::Role::User && message.content == "also check tests"
            }));
            Ok(ModelResponse {
                content: "done".into(),
                ..Default::default()
            })
        }
    }

    #[tokio::test]
    async fn queued_input_continues_the_active_model_loop() {
        let queue = Arc::new(InputQueue::default());
        queue.push("also check tests".into());
        let mut session = Session::new("mock", "queued", PathBuf::from("."));
        let output = Agent::new("test")
            .with_input_queue(queue)
            .run_turn(
                &mut session,
                "start",
                &QueuedInputProvider {
                    calls: Mutex::new(0),
                },
                &EchoTool,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("queued turn");
        assert_eq!(output, "done");
    }

    struct CompactingProvider {
        calls: Mutex<usize>,
    }

    #[async_trait]
    impl ModelProvider for CompactingProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "tiny"
        }

        fn capabilities(&self) -> ModelCapabilities {
            ModelCapabilities {
                context_window: 100,
                effective_context_window_percent: 100,
                auto_compact_token_limit: Some(90),
                ..ModelCapabilities::default()
            }
        }

        async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
            let mut calls = self.calls.lock().expect("lock calls");
            *calls += 1;
            if request.tools.is_empty() {
                return Ok(ModelResponse {
                    content: "summary".into(),
                    usage: crate::TokenUsage {
                        input_tokens: 40,
                        output_tokens: 4,
                        ..Default::default()
                    },
                    ..Default::default()
                });
            }
            Ok(ModelResponse {
                content: "done".into(),
                usage: crate::TokenUsage {
                    input_tokens: 50,
                    output_tokens: 2,
                    ..Default::default()
                },
                ..Default::default()
            })
        }
    }

    #[tokio::test]
    async fn auto_compaction_replaces_history_with_summary() {
        let mut session = Session::new("mock", "tiny", PathBuf::from("."));
        session.messages.push(ChatMessage::user("x".repeat(500)));
        let provider = CompactingProvider {
            calls: Mutex::new(0),
        };
        Agent::new("test")
            .run_turn(
                &mut session,
                "continue",
                &provider,
                &EchoTool,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("compacted turn");
        assert_eq!(session.context.compaction_count, 1);
        assert!(
            session
                .messages
                .iter()
                .any(|message| message.compaction_summary)
        );
    }

    #[tokio::test]
    async fn manual_compaction_is_a_standalone_operation() {
        let mut session = Session::new("mock", "tiny", PathBuf::from("."));
        session
            .messages
            .push(ChatMessage::user("keep this context"));
        let provider = CompactingProvider {
            calls: Mutex::new(0),
        };
        Agent::new("test")
            .compact_session(&mut session, &provider, &EchoTool, &NoopObserver)
            .await
            .expect("manual compaction");
        assert_eq!(*provider.calls.lock().expect("lock calls"), 1);
        assert_eq!(session.context.compaction_count, 1);
        // 压缩后结构：摘要在前，最近用户指令收尾（最后一条是用户消息而非摘要）
        assert!(session.messages.first().is_some_and(|message| {
            message.compaction_summary && message.content.contains("summary")
        }));
        assert_eq!(
            session.messages.last().map(|message| message.content.as_str()),
            Some("keep this context")
        );
    }

    #[test]
    fn transient_retry_excludes_non_retryable_http_statuses() {
        for status in [400, 401, 402, 403, 404] {
            assert!(!is_transient_provider_error(&anyhow::anyhow!(
                "provider returned HTTP {status}: connection field invalid"
            )));
        }
        for status in [429, 502, 503, 504] {
            assert!(is_transient_provider_error(&anyhow::anyhow!(
                "provider returned HTTP {status}"
            )));
        }
        assert!(is_transient_provider_error(&anyhow::anyhow!(
            "provider stream failed: connection reset"
        )));
    }

    struct CountingTool {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl ToolRuntime for CountingTool {
        fn specs(&self) -> Vec<ToolSpec> {
            EchoTool.specs()
        }

        async fn call(&self, _call: &ToolCall, _approval: &dyn ApprovalHandler) -> ToolResult {
            self.calls.fetch_add(1, Ordering::SeqCst);
            ToolResult::success("unexpected")
        }
    }

    struct InvalidToolProvider {
        requests: Mutex<Vec<ModelRequest>>,
    }

    #[async_trait]
    impl ModelProvider for InvalidToolProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "invalid-tool"
        }

        async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
            self.requests.lock().expect("requests").push(request);
            Ok(ModelResponse {
                invalid_tool_calls: vec![InvalidToolCall {
                    id: "call-1".into(),
                    name: "echo".into(),
                    reason: "tool arguments are not valid JSON".into(),
                }],
                ..Default::default()
            })
        }
    }

    #[tokio::test]
    async fn invalid_tool_arguments_get_one_correction_and_never_execute() {
        let provider = InvalidToolProvider {
            requests: Mutex::new(Vec::new()),
        };
        let tools = CountingTool {
            calls: AtomicUsize::new(0),
        };
        let mut session = Session::new("mock", "invalid-tool", PathBuf::from("."));
        let output = Agent::new("test")
            .run_turn(
                &mut session,
                "run",
                &provider,
                &tools,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("second invalid call should remain recoverable");
        assert!(output.contains("仍未通过校验"));
        assert_eq!(tools.calls.load(Ordering::SeqCst), 0);
        let requests = provider.requests.lock().expect("requests");
        assert_eq!(requests.len(), 2);
        assert!(requests[1].messages.iter().any(|message| {
            message.internal
                && message.content.contains("tool_call_correction")
                && message.content.contains("json_schema")
        }));
    }

    struct RepeatedCallProvider {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl ModelProvider for RepeatedCallProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "repeated-tool"
        }

        async fn complete(&self, _request: ModelRequest) -> Result<ModelResponse> {
            let round = self.calls.fetch_add(1, Ordering::SeqCst);
            if round < 3 {
                return Ok(ModelResponse {
                    tool_calls: vec![ToolCall {
                        id: format!("call-{round}"),
                        name: "echo".into(),
                        arguments: json!({"value": "same"}),
                    }],
                    ..Default::default()
                });
            }
            Ok(ModelResponse {
                content: "done".into(),
                ..Default::default()
            })
        }
    }

    struct FailingTool {
        calls: AtomicUsize,
        output: &'static str,
    }

    #[async_trait]
    impl ToolRuntime for FailingTool {
        fn specs(&self) -> Vec<ToolSpec> {
            EchoTool.specs()
        }

        async fn call(&self, _call: &ToolCall, _approval: &dyn ApprovalHandler) -> ToolResult {
            self.calls.fetch_add(1, Ordering::SeqCst);
            ToolResult::error(self.output)
        }
    }

    #[tokio::test]
    async fn unchanged_generic_failure_is_executed_at_most_twice() {
        let provider = RepeatedCallProvider {
            calls: AtomicUsize::new(0),
        };
        let tools = FailingTool {
            calls: AtomicUsize::new(0),
            output: "process exited with code 1",
        };
        let mut session = Session::new("mock", "repeated-tool", PathBuf::from("."));
        Agent::new("test")
            .run_turn(
                &mut session,
                "run",
                &provider,
                &tools,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("turn remains recoverable");
        assert_eq!(tools.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn unchanged_permission_failure_is_not_retried() {
        let provider = RepeatedCallProvider {
            calls: AtomicUsize::new(0),
        };
        let tools = FailingTool {
            calls: AtomicUsize::new(0),
            output: "permission denied by sandbox policy",
        };
        let mut session = Session::new("mock", "repeated-tool", PathBuf::from("."));
        Agent::new("test")
            .run_turn(
                &mut session,
                "run",
                &provider,
                &tools,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("turn remains recoverable");
        assert_eq!(tools.calls.load(Ordering::SeqCst), 1);
    }

    struct ImageFallbackProvider {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl ModelProvider for ImageFallbackProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "image-fallback"
        }

        async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                assert!(request_has_images(&request));
                return Err(ProviderRequestError {
                    phase: "response_body",
                    kind: ProviderErrorKind::Http,
                    status: Some(400),
                    retry_after_ms: None,
                    request_id: None,
                    retryable: false,
                    detail: "provider rejected image input (image_url)".into(),
                }
                .into());
            }
            assert!(!request_has_images(&request));
            Ok(ModelResponse {
                content: "recovered".into(),
                ..Default::default()
            })
        }
    }

    #[tokio::test]
    async fn image_protocol_error_retries_same_round_without_images() {
        let provider = ImageFallbackProvider {
            calls: AtomicUsize::new(0),
        };
        let degraded = Arc::new(AtomicBool::new(false));
        let mut session = Session::new("mock", "image-fallback", PathBuf::from("."));
        let mut image_message = ChatMessage::user("inspect this image");
        image_message.images.push(crate::ImageContent {
            media_type: "image/png".into(),
            data: "BASE64".into(),
        });
        session.messages.push(image_message);
        let output = Agent::new("test")
            .with_vision_fallback({
                let degraded = Arc::clone(&degraded);
                Arc::new(move || degraded.store(true, Ordering::SeqCst))
            })
            .run_turn(
                &mut session,
                "continue",
                &provider,
                &EchoTool,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("image fallback turn");
        assert_eq!(output, "recovered");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        assert!(degraded.load(Ordering::SeqCst));
    }

    struct AlwaysTransientProvider {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl ModelProvider for AlwaysTransientProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "transient"
        }

        async fn complete(&self, _request: ModelRequest) -> Result<ModelResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(ProviderRequestError {
                phase: "response_body",
                kind: ProviderErrorKind::Http,
                status: Some(429),
                retry_after_ms: Some(0),
                request_id: None,
                retryable: true,
                detail: "provider rate or token limit was exceeded".into(),
            }
            .into())
        }
    }

    #[tokio::test]
    async fn transient_provider_failure_retries_at_most_twice() {
        let provider = AlwaysTransientProvider {
            calls: AtomicUsize::new(0),
        };
        let mut session = Session::new("mock", "transient", PathBuf::from("."));
        Agent::new("test")
            .run_turn(
                &mut session,
                "run",
                &provider,
                &EchoTool,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect_err("transient failure should stop after retries");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn structured_retry_policy_and_delay_are_bounded() {
        for (status, retryable) in [(400, false), (404, false), (429, true), (503, true)] {
            let error = anyhow::Error::new(ProviderRequestError {
                phase: "response_body",
                kind: ProviderErrorKind::Http,
                status: Some(status),
                retry_after_ms: Some(if status == 429 { 90_000 } else { 0 }),
                request_id: None,
                retryable,
                detail: "classified".into(),
            });
            assert_eq!(is_transient_provider_error(&error), retryable);
            if status == 429 {
                assert_eq!(retry_delay_ms(&error, 1, 1_000, 30_000), 30_000);
            }
        }
    }

    #[test]
    fn loop_accounting_stops_at_the_token_budget() {
        let mut session = Session::new("mock", "model", PathBuf::from("."));
        session.usage.input_tokens = 30;
        session.loop_state = Some(crate::LoopState {
            objective: "finish".into(),
            status: crate::LoopStatus::Active,
            token_budget: Some(20),
            tokens_used: 0,
            time_used_seconds: 0,
            blocked_streak: 0,
            turns_completed: 0,
        });
        update_loop_accounting(&mut session, 0, Duration::from_secs(2), None, &NoopObserver);
        let state = session.loop_state.expect("loop state");
        assert_eq!(state.status, crate::LoopStatus::BudgetLimited);
        assert_eq!(state.tokens_used, 30);
        assert_eq!(state.turns_completed, 1);
    }
}

// ── 别名 XML 工具调用兜底（<dots_function_call>/<tool_call>/<invoke name=...> 等）──

/// 解析内容中的别名 XML 工具调用块；一个也没解析出来时返回 None。
fn parse_alias_xml_calls(content: &str) -> Option<Vec<ToolCall>> {
    let mut calls = Vec::new();
    let mut pos = 0_usize;
    while let Some(rel) = content[pos..].find("<invoke") {
        let start = pos + rel;
        let Some(tag_end_rel) = content[start..].find('>') else {
            break;
        };
        let tag_end = start + tag_end_rel;
        let attrs = &content[start + "<invoke".len()..tag_end];
        let Some(name) = xml_attr(attrs, "name") else {
            pos = tag_end + 1;
            continue;
        };
        let body_start = tag_end + 1;
        let Some(body_rel) = content[body_start..].find("</invoke>") else {
            break;
        };
        let body = &content[body_start..body_start + body_rel];
        let mut args = serde_json::Map::new();
        let mut p = 0_usize;
        while let Some(pr) = body[p..].find("<parameter") {
            let ps = p + pr;
            let Some(ptag_rel) = body[ps..].find('>') else {
                break;
            };
            let ptag_end = ps + ptag_rel;
            let pattrs = &body[ps + "<parameter".len()..ptag_end];
            let Some(key) = xml_attr(pattrs, "name") else {
                p = ptag_end + 1;
                continue;
            };
            let pbody_start = ptag_end + 1;
            let Some(vrel) = body[pbody_start..].find("</parameter>") else {
                break;
            };
            let raw = &body[pbody_start..pbody_start + vrel];
            let value = if raw.trim().is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_str(raw.trim())
                    .unwrap_or_else(|_| serde_json::Value::String(raw.trim().to_owned()))
            };
            args.insert(key.to_owned(), value);
            p = pbody_start + vrel + "</parameter>".len();
        }
        calls.push(ToolCall {
            id: format!("call_xml_{}_{}", name, calls.len()),
            name: name.to_owned(),
            arguments: serde_json::Value::Object(args),
        });
        pos = body_start + body_rel + "</invoke>".len();
    }
    if calls.is_empty() {
        None
    } else {
        Some(calls)
    }
}

/// 在属性串中读取 `attr="value"` / `attr='value'` / `attr=value`。
fn xml_attr<'a>(attrs: &'a str, attr: &str) -> Option<&'a str> {
    let mut rest = attrs;
    while let Some(idx) = rest.find(attr) {
        let previous = rest[..idx].chars().last();
        if previous.map(char::is_alphanumeric).unwrap_or(true) {
            rest = &rest[idx + attr.len()..];
            continue;
        }
        let value = rest[idx + attr.len()..].trim_start().strip_prefix('=')?;
        let value = value.trim_start();
        if let Some(v) = value.strip_prefix('"') {
            let end = v.find('"')?;
            return Some(&v[..end]);
        }
        if let Some(v) = value.strip_prefix('\'') {
            let end = v.find('\'')?;
            return Some(&v[..end]);
        }
        let cut = value
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(value.len());
        return Some(&value[..cut]);
    }
    None
}

/// 从内容中剥离解析过的 XML 调用片段（含外围 <dots_function_call> 等包裹块）。
fn strip_alias_xml(content: &str) -> String {
    let mut result = content.to_owned();
    for tag in ["dots_function_call", "tool_call", "function_call"] {
        let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
        loop {
            let Some(mut s) = result.find(&open) else {
                break;
            };
            let Some(e) = result[s..].find(&close) else {
                break;
            };
            // 顺手清掉紧邻的 markdown 代码围栏
            if s >= 8 && &result[s - 4..s] == "```" {
                s -= 4;
                if s >= 1 && &result[s - 1..s] == "\n" {
                    s -= 1;
                }
            }
            let end = s + e + close.len() - s;
            result.replace_range(s..s + end, "");
        }
    }
    while let Some(s) = result.find("<invoke") {
        let Some(tag_end_rel) = result[s..].find('>') else {
            break;
        };
        let tag_end = s + tag_end_rel;
        let Some(body_rel) = result[tag_end + 1..].find("</invoke>") else {
            break;
        };
        let end = tag_end + 1 + body_rel + "</invoke>".len();
        result.replace_range(s..end, "");
    }
    while result.contains("\n\n\n") {
        result = result.replace("\n\n\n", "\n\n");
    }
    result.trim().to_owned()
}

#[cfg(test)]
mod alias_xml_tests {
    use super::*;

    #[test]
    fn parses_dots_style_calls() {
        let content = r#"推送成功。我需要添加它。
<dots_function_call>
<invoke name="read_file">
<parameter name="limit">12</parameter>
<parameter name="path">/home/coomi/a.yaml</parameter>
</invoke>
</dots_function_call>"#;
        let calls = parse_alias_xml_calls(content).expect("should parse");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].arguments["limit"], 12);
        assert_eq!(calls[0].arguments["path"], "/home/coomi/a.yaml");
        let stripped = strip_alias_xml(content);
        assert!(!stripped.contains("<dots_function_call"));
        assert!(!stripped.contains("<invoke"));
    }

    #[test]
    fn parses_bare_invoke_and_string_values() {
        let content = r#"<invoke name="write_file"><parameter name="path">/tmp/x.txt</parameter><parameter name="content">hello</parameter></invoke>"#;
        let calls = parse_alias_xml_calls(content).expect("should parse");
        assert_eq!(calls[0].name, "write_file");
        assert_eq!(calls[0].arguments["content"], "hello");
    }

    #[test]
    fn no_invoke_returns_none() {
        assert!(parse_alias_xml_calls("普通的回答，没有调用").is_none());
    }
}
