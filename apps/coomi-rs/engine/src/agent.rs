use crate::AgentEvent;
use crate::AgentObserver;
use crate::ApprovalHandler;
use crate::ChatMessage;
use crate::CompactionReason;
use crate::CompactionRecord;
use crate::CompactionRequest;
use crate::InputQueue;
use crate::ModelProvider;
use crate::ModelRequest;
use crate::ModelStreamObserver;
use crate::ProviderRequestError;
use crate::SUMMARIZATION_PROMPT;
use crate::Session;
use crate::ToolCall;
use crate::ToolConcurrency;
use crate::ToolResult;
use crate::ToolRuntime;
use crate::TurnControl;
use crate::Role;
use crate::compacted_history_with_budget;
use crate::normalize_history;
use crate::repair_tool_pairing;
use crate::retained_user_history_with_count;
use crate::trim_history_to_fit;
use crate::types::sanitize_json_encoded_data;
use crate::types::sanitize_long_encoded_data;
use futures_util::StreamExt;
use futures_util::future::join_all;
use futures_util::stream::FuturesUnordered;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Semaphore;

#[derive(Clone, Copy, Debug, Default)]
struct ToolFailureState {
    executions: u8,
    requires_changed_call: bool,
}

/// 一次流式请求的结局：拿到响应，或者被运行中插话软打断。
enum StreamAttempt {
    Done(anyhow::Result<crate::ModelResponse>),
    Interrupted,
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

/// 自动压缩的消息条数下限：低于该值时压缩只会立刻再次触发（压缩本身要保留
/// 最近一段原文），所以配置值一律 clamp 到这个下限以上。
pub const MIN_AUTO_COMPACT_MESSAGE_LIMIT: usize = 80;
/// 自动压缩消息条数的默认阈值：约 200 条消息。条数只是「用量已经不小」时的
/// 第二条保险：用量不超过窗口 50% 时根本不检查条数（见 ContextState::should_compact）。
pub const DEFAULT_AUTO_COMPACT_MESSAGE_LIMIT: usize = 200;
/// 上限：再大也不会「太大」，只是把压缩推迟；防止配置写错导致永不压缩。
pub const MAX_AUTO_COMPACT_MESSAGE_LIMIT: usize = 4_096;

/// 复述消息的识别前缀（下一轮据此替换掉旧的那条，避免堆积）。
const GOAL_RECITE_MARK: &str = "<goal-reminder>";
/// 每隔多少轮复述一次目标与计划。
const GOAL_RECITE_EVERY: usize = 6;

/// 生成本轮的目标复述：**原始用户请求**（截断）+ 计划里未完成的步骤。
///
/// 为什么需要：模型在几十次工具调用之后会忘记最初要干什么，转而优化眼前的子问题。
/// 把目标重新推回注意力尾部是成本最低的纠正手段；内容刻意保持紧凑与确定
/// （它只追加在消息尾部，不碰前缀，因此不影响缓存）。
fn goal_recitation(session: &crate::Session) -> Option<String> {
    let goal = session
        .messages
        .iter()
        .find(|message| {
            message.role == crate::Role::User && !message.internal && !message.compaction_summary
        })
        .map(|message| message.content.trim().chars().take(280).collect::<String>())?;
    if goal.is_empty() {
        return None;
    }
    let mut reminder =
        format!("{GOAL_RECITE_MARK}\n原始目标（始终对齐它，不要被中间步骤带偏）：\n{goal}\n");
    if let Some(plan) = session.plan.as_ref()
        && !plan.steps.is_empty()
    {
        let pending: Vec<&crate::PlanStep> = plan
            .steps
            .iter()
            .filter(|step| step.status != crate::PlanStepStatus::Completed)
            .collect();
        if pending.is_empty() {
            reminder.push_str("\n计划步骤已全部完成：请收尾并给出结论，不要再开新的子任务。\n");
        } else {
            reminder.push_str("\n尚未完成的计划步骤：\n");
            for step in pending.iter().take(12) {
                let mark = if step.status == crate::PlanStepStatus::InProgress {
                    "进行中"
                } else {
                    "待办"
                };
                reminder.push_str(&format!("- [{mark}] {}\n", step.step));
            }
        }
    }
    reminder.push_str("\n如果现实与原计划不符，允许调整计划，但不要把原始目标丢掉。");
    Some(reminder)
}

pub struct Agent {
    system_prompt: String,
    max_tool_rounds: usize,
    provider_retry_count: u8,
    reconnect_initial_delay_ms: u64,
    reconnect_max_delay_ms: u64,
    max_parallel_tools: usize,
    force_compaction: bool,
    /// 自动压缩总开关（F5 的「压缩」能力开关 + settings.json 的
    /// auto_compaction_enabled）。关闭只停自动压缩；provider 报上下文超限时的
    /// 强制压缩兜底路径不受影响。
    auto_compaction_enabled: bool,
    /// 自动压缩的消息条数阈值（双条件触发的第二条）。
    auto_compact_message_limit: usize,
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
    /// 流式草稿回调：模型还在生成时周期性把「本轮基础会话 + 已生成的部分回复」
    /// 交给调用方落盘（节流在引擎内部做）。进程被杀/崩溃后，已生成的内容
    /// 仍以草稿消息的形式留在会话里，不会随内存一起消失。
    draft_checkpoint: Option<Arc<dyn Fn(&Session) + Send + Sync>>,
    turn_control: Option<Arc<dyn TurnControl>>,

}

/// 流式草稿的落盘间隔：不到这个间隔不写盘，避免每个 delta 都序列化整个会话。
const DRAFT_FLUSH_INTERVAL: Duration = Duration::from_millis(2_500);
/// 草稿最多记录多少字节（约 20 万字符）：足够恢复上下文，又不会把会话文件撑爆。
const DRAFT_MAX_BYTES: usize = 400_000;

/// 一次模型请求（一个 tool round）的流式草稿状态。
///
/// 落盘内容是「请求发出前的会话快照 + 一条草稿消息」：快照是本次流式期间
/// 会话的稳定基线，草稿消息 id 整轮固定，因此磁盘上永远只有一条草稿，
/// 每次落盘都是原地覆盖最后一条。
struct DraftState {
    base: Session,
    message: ChatMessage,
    inner: StdMutex<DraftInner>,
}

struct DraftInner {
    text: String,
    /// 与 text 同步累积的思考文本：草稿落盘时一并写入，崩溃恢复后思考框还在。
    reasoning: String,
    last_flush: Instant,
    flushed_bytes: usize,
}

impl DraftState {
    fn new(base: &Session) -> Self {
        Self {
            base: base.clone(),
            message: ChatMessage::assistant_draft(String::new()),
            inner: StdMutex::new(DraftInner {
                text: String::new(),
                reasoning: String::new(),
                // 初始化为「早该落盘」：第一个 delta 就会写一次，别等满一个间隔。
                last_flush: Instant::now() - DRAFT_FLUSH_INTERVAL,
                flushed_bytes: 0,
            }),
        }
    }

    /// 追加一段流式增量，满足节流条件时落盘一次。
    fn push(&self, delta: &str, sink: &(dyn Fn(&Session) + Send + Sync)) {
        let snapshot = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if inner.text.len() < DRAFT_MAX_BYTES {
                inner.text.push_str(delta);
            }
            let bytes = inner.text.len();
            if inner.last_flush.elapsed() < DRAFT_FLUSH_INTERVAL || bytes == inner.flushed_bytes {
                return;
            }
            inner.last_flush = Instant::now();
            inner.flushed_bytes = bytes;
            let mut message = self.message.clone();
            message.content = inner.text.clone();
            message.reasoning = inner.reasoning.clone();
            let mut snapshot = self.base.clone();
            snapshot.messages.push(message);
            snapshot
        };
        sink(&snapshot);
    }

    /// 追加一段思考增量。思考只在结束时才落盘（正文 delta 会带着它一起写），
    /// 因此这里不单独触发落盘，只累积。
    fn push_reasoning(&self, delta: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.reasoning.len() < DRAFT_MAX_BYTES {
            inner.reasoning.push_str(delta);
        }
    }

    /// 重试/切换模型：上一段生成作废，缓冲区清空重来。
    fn reset(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.text.clear();
        inner.reasoning.clear();
        inner.flushed_bytes = 0;
        inner.last_flush = Instant::now() - DRAFT_FLUSH_INTERVAL;
    }

    /// 取走已生成的部分文本（流式结束，草稿定稿）。
    fn take_text(&self) -> String {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let text = std::mem::take(&mut inner.text);
        inner.flushed_bytes = 0;
        text
    }

    /// 取走已生成的思考文本（草稿定稿时附到最后一条消息上）。
    fn take_reasoning(&self) -> String {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        std::mem::take(&mut inner.reasoning)
    }
}

/// 流式结束后把草稿定稿进会话：有内容就作为最后一条 assistant 消息落库
/// （保留 draft 标记，前端可显示「生成中断」）；没有内容则什么都不做。
fn finalize_draft(session: &mut Session, draft: Option<&DraftState>) -> bool {
    let Some(draft) = draft else {
        return false;
    };
    let text = draft.take_text();
    let reasoning = draft.take_reasoning();
    if text.trim().is_empty() && reasoning.trim().is_empty() {
        return false;
    }
    let mut message = ChatMessage::assistant_draft(text);
    message.id = draft.message.id.clone();
    message.reasoning = reasoning;
    session.messages.push(message);
    true
}

/// 软打断/意外收尾：把这一轮流式已经产出的正文与思考落进会话，绝不丢内容。
///
/// 优先用草稿状态定稿（Web 侧注册了草稿回调时它才是权威副本）；没有草稿
/// （terminal / exec）时退回 ObserverStream 里累积的正文。
fn finalize_stream_partial(
    session: &mut Session,
    draft: Option<&DraftState>,
    stream_observer: &ObserverStream<'_>,
) -> bool {
    if finalize_draft(session, draft) {
        return true;
    }
    let text = stream_observer.take_partial_text();
    let reasoning = stream_observer.reasoning.take();
    if text.trim().is_empty() && reasoning.trim().is_empty() {
        return false;
    }
    let mut message = ChatMessage::assistant_draft(text);
    message.reasoning = reasoning;
    session.messages.push(message);
    true
}

/// 正式回复落库：若会话末尾正好是这一轮的草稿，就地替换它（id 保持不变，
/// 前端不会看到「草稿 + 正式回复」两条重复消息）。
fn push_final_assistant(
    session: &mut Session,
    content: &str,
    tool_calls: Vec<ToolCall>,
    reasoning: &str,
    draft: Option<&DraftState>,
) {
    let mut message = ChatMessage::assistant(content, tool_calls);
    // 思考文本随正式回复一起落库：一轮结束后前端回读历史时思考框不会消失。
    let reasoning = crate::types::sanitize_long_encoded_data(reasoning);
    if !reasoning.trim().is_empty() {
        message.reasoning = reasoning;
    }
    if let Some(draft) = draft
        && let Some(index) = session
            .messages
            .iter()
            .position(|item| item.id == draft.message.id)
    {
        message.id = draft.message.id.clone();
        // 兜底：本轮没收到 reasoning 增量时，保留草稿定稿时已写入的思考文本。
        if message.reasoning.trim().is_empty() {
            message.reasoning = session.messages[index].reasoning.clone();
        }
        session.messages[index] = message;
        return;
    }
    session.messages.push(message);
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
            auto_compaction_enabled: true,
            auto_compact_message_limit: DEFAULT_AUTO_COMPACT_MESSAGE_LIMIT,
            input_queue: None,
            vision_replay: true,
            vision_fallback: None,
            reasoning_effort: None,
            checkpoint: None,
            draft_checkpoint: None,
            turn_control: None,
        }
    }

    /// 注册上下文检查点：每次关键消息落盘时调用（由调用方负责持久化 session）。
    pub fn with_checkpoint(mut self, checkpoint: Arc<dyn Fn(&Session) + Send + Sync>) -> Self {
        self.checkpoint = Some(checkpoint);
        self
    }

    /// 注册流式草稿回调：模型生成过程中周期性收到「部分回复已写入的会话快照」，
    /// 由调用方负责持久化（见 SessionStore::save_draft）。
    pub fn with_draft_checkpoint(
        mut self,
        checkpoint: Arc<dyn Fn(&Session) + Send + Sync>,
    ) -> Self {
        self.draft_checkpoint = Some(checkpoint);
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

    /// 自动压缩的消息条数阈值（第二条触发条件）。带下限保护：小于
    /// MIN_AUTO_COMPACT_MESSAGE_LIMIT 的值会被抬到下限，避免「压完立刻又满足条件」。
    pub fn with_auto_compact_message_limit(mut self, limit: usize) -> Self {
        self.auto_compact_message_limit = limit
            .clamp(MIN_AUTO_COMPACT_MESSAGE_LIMIT, MAX_AUTO_COMPACT_MESSAGE_LIMIT);
        self
    }

    /// 自动压缩总开关。false 时只停「自动」触发，provider 上下文超限的
    /// 强制压缩兜底仍然生效。
    pub fn with_auto_compaction_enabled(mut self, enabled: bool) -> Self {
        self.auto_compaction_enabled = enabled;
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
        self.run_user_message(
            session,
            ChatMessage::user(prompt),
            provider,
            tools,
            approval,
            observer,
        )
        .await
    }

    /// 跑一轮，但直接接收一条完整的用户消息：content 是用户原文（UI 显示的就是它），
    /// 结构化 attachments/quotes 随会话落盘，模型侧由引擎在组装请求时内联。
    pub async fn run_user_message(
        &self,
        session: &mut Session,
        message: ChatMessage,
        provider: &dyn ModelProvider,
        tools: &dyn ToolRuntime,
        approval: &dyn ApprovalHandler,
        observer: &dyn AgentObserver,
    ) -> Result<String, AgentError> {
        self.run_accounted_turn(session, message, provider, tools, approval, observer)
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
        // 先补 tool_call_id 配对，再交给 normalize_history：否则「结果消息没带 id」
        // 的旧会话会被当成孤儿结果丢掉，真实工具输出被 error: aborted 顶替。
        repair_tool_pairing(&mut session.messages);
        session.messages = normalize_history(&session.messages);
        session
            .context
            .recompute(&self.system_prompt, &session.messages, &tool_specs);
        observer.on_event(&AgentEvent::ContextUpdated(
            session.context.status(&provider.capabilities()),
        ));
        self.compact(
            session,
            provider,
            &tool_specs,
            observer,
            false,
            CompactionReason::Manual,
        )
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
        let all_tool_specs = tools.specs();
        let capabilities = provider.capabilities();
        let mut compacted_for_provider_error = false;
        let mut vision_replay = self.vision_replay;
        let mut invalid_tool_retry_used = false;
        let mut tool_failures: HashMap<String, ToolFailureState> = HashMap::new();
        let mut consecutive_failures = 0usize;
        // 工具集与会话无关、顺序确定（见 stable_tool_specs）：工具清单也是请求前缀的一部分，
        // 按提问裁剪会让前缀每轮变化 —— 那是缓存失效的第二个来源。
        let tool_specs = stable_tool_specs(&all_tool_specs);

        'tool_rounds: for round in 1..=self.max_tool_rounds {
            self.safe_point().await?;
            // 历史里 tool 结果与 tool_calls 的 id 先配对，避免正常结果被当作
            // 孤儿消息丢弃（工具卡片在历史里消失的另一个来源）。
            repair_tool_pairing(&mut session.messages);
            session.messages = normalize_history(&session.messages);
            // 下一个模型调用前的安全点：运行中插话在这里并入本轮上下文并继续本轮
            // （同一轮，不新开 turn）；工具正在跑时不会走到这里，所以插话不会打断工具。
            self.accept_interjections(session, observer, "model_call");
            // 周期性复述目标与计划：长任务跑到后面，最初的目标会掉出注意力窗口
            // （lost-in-the-middle）。Manus 靠重读 task_plan.md，Claude Code 早期每 5 轮
            // 注入一次目标提醒 —— 这里每 6 轮把「原始目标 + 未完成的计划步骤」推回尾部。
            // 注意：只追加在尾部、且内容确定，不碰前缀，缓存不受影响。
            if round > 1 && round % GOAL_RECITE_EVERY == 0
                && let Some(reminder) = goal_recitation(session)
            {
                // 只保留最新一份：192 轮下来否则会堆出三十多条提醒。
                session
                    .messages
                    .retain(|message| !message.content.starts_with(GOAL_RECITE_MARK));
                session.messages.push(ChatMessage::internal_user(reminder));
            }
            session
                .context
                .recompute(&self.system_prompt, &session.messages, &tool_specs);
            observer.on_event(&AgentEvent::ContextUpdated(
                session.context.status(&capabilities),
            ));
            // 双条件触发：token/窗口/指纹（原有）或消息条数（新增）。
            // 自动压缩被关掉时短路这几条自动判定，但不动下面的 provider 兜底。
            let forced_compaction = self.force_compaction && round == 1;
            let compaction_reason = if forced_compaction {
                Some(CompactionReason::Manual)
            } else if self.auto_compaction_enabled {
                session.context.should_compact(
                    &capabilities,
                    session.messages.len(),
                    self.auto_compact_message_limit,
                )
            } else {
                None
            };
            if let Some(reason) = compaction_reason {
                self.compact(
                    session,
                    provider,
                    &tool_specs,
                    observer,
                    !forced_compaction,
                    reason,
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
            // 附件路径与引用原文只在请求里内联（模型必须能读到文件）；
            // 会话里存的仍是用户原文，UI 不会显示拼接出来的清单。
            render_request_messages(&mut messages);
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
            // 流式草稿：本轮请求发出后开始记录增量，周期性落盘（节流）。
            // 未注册回调时整段零成本（不 clone 会话）。
            let draft = self
                .draft_checkpoint
                .as_ref()
                .map(|_| DraftState::new(session));
            let stream_observer = ObserverStream {
                observer,
                draft: match (&draft, self.draft_checkpoint.as_ref()) {
                    (Some(state), Some(sink)) => Some((state, sink.as_ref())),
                    _ => None,
                },
                reasoning: ReasoningBuffer::default(),
                produced_text: std::sync::atomic::AtomicBool::new(false),
                partial: StdMutex::new(String::new()),
            };
            let mut retry_attempt = 0_u8;
            let mut image_retry_used = false;
            let response = loop {
                match self
                    .stream_response(provider, &request, &stream_observer)
                    .await
                {
                    StreamAttempt::Interrupted => {
                        // 软打断：正文正在流式输出时插话到达。优雅收尾这一次流
                        // （已生成内容先定稿落盘，不丢），随后并入插话继续本轮。
                        finalize_stream_partial(session, draft.as_ref(), &stream_observer);
                        self.run_checkpoint(session);
                        self.accept_interjections(session, observer, "stream_interrupt");
                        continue 'tool_rounds;
                    }
                    StreamAttempt::Done(Ok(response)) => break response,
                    StreamAttempt::Done(Err(error))
                        if !compacted_for_provider_error && is_context_window_error(&error) =>
                    {
                        compacted_for_provider_error = true;
                        // 上下文超限会重开本轮：先把这一段已生成的内容定稿，
                        // 否则它会随着新一轮草稿一起被丢掉。
                        finalize_draft(session, draft.as_ref());
                        self.compact(
                            session,
                            provider,
                            &tool_specs,
                            observer,
                            true,
                            CompactionReason::ProviderError,
                        )
                        .await?;
                        self.run_checkpoint(session);
                        continue 'tool_rounds;
                    }
                    StreamAttempt::Done(Err(error))
                        if !image_retry_used
                            && request_has_images(&request)
                            && is_image_compatibility_error(&error) =>
                    {
                        image_retry_used = true;
                        vision_replay = false;
                        strip_request_images(&mut request);
                        // 重试会从头重新生成：上一段正文与思考增量都作废。
                        stream_observer.reasoning.reset();
                        if let Some(draft) = &draft {
                            draft.reset();
                        }
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
                    StreamAttempt::Done(Err(error))
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
                        // 重试会从头重新生成：上一段正文与思考增量都作废。
                        stream_observer.reasoning.reset();
                        if let Some(draft) = &draft {
                            draft.reset();
                        }
                        observer.on_event(&AgentEvent::StreamReset);
                        observer.on_event(&AgentEvent::ConnectionRetry {
                            attempt: retry_attempt,
                            max_attempts: self.provider_retry_count,
                            delay_ms,
                            message: "网络或上游服务暂时不可用，正在自动恢复".into(),
                        });
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    }
                    StreamAttempt::Done(Err(error)) => {
                        // 不再重试：把已生成的部分内容定稿进会话，随调用方的
                        // checkpoint 一起落盘（否则这段内容只存在于内存里）。
                        finalize_draft(session, draft.as_ref());
                        return Err(AgentError::Provider(error));
                    }
                }
            };

            // 流式结束：草稿定稿（下面的正式回复会就地替换它）。
            finalize_draft(session, draft.as_ref());
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
            // 本轮流式思考文本（可能与草稿一起定稿，也可能只存在于累加器里）。
            let reasoning = stream_observer.reasoning.take();
            push_final_assistant(
                session,
                &response_content,
                recorded_tool_calls,
                &reasoning,
                draft.as_ref(),
            );
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
                let protocol_failure = response.invalid_tool_calls.iter().any(|call| {
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
                // 收尾前的安全点：这一轮流式期间到达的插话并入后继续本轮，
                // 不把已经收尾的回复当成最终答案丢掉用户刚说的话。
                let interjected = self.accept_interjections(session, observer, "before_final_answer");
                if interjected > 0 || self.accept_queued_input(session, observer) {
                    continue;
                }
                session.touch();
                return Ok(response_content);
            }

            // 本批工具调用的 id 顺序：工具并发执行、完成顺序不定，落库时必须按
            // assistant.tool_calls 的顺序回填 tool 结果，才能与调用一一配对。
            let call_order: Vec<String> = response_tool_calls
                .iter()
                .map(|call| call.id.clone())
                .collect();
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
            // 写/破坏性工具：全局串行闸（一次只有一个 mutating 在跑）。
            let mutating_gate = Arc::new(AsyncMutex::new(()));
            // 交互工具：用户一次只能答一个请求。
            let interactive_gate = Arc::new(AsyncMutex::new(()));
            // 按资源路径细分的写锁：不同文件的写可并行，同文件互斥。
            let resource_locks: Arc<std::sync::Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
                Arc::new(std::sync::Mutex::new(HashMap::new()));
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
                    let mutating_gate = Arc::clone(&mutating_gate);
                    let interactive_gate = Arc::clone(&interactive_gate);
                    let resource_locks = Arc::clone(&resource_locks);
                    let resource = call.resource_key();
                    let concurrency = specs_by_name
                        .get(call.name.as_str())
                        .map(|spec| spec.concurrency())
                        .unwrap_or(ToolConcurrency::Mutating);
                    let read_only = concurrency == ToolConcurrency::ReadOnly;
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
                        } else if concurrency == ToolConcurrency::Interactive {
                            // 交互工具全局串行，避免多路 request_user_input 交错。
                            let _gate = interactive_gate.lock().await;
                            tools.call(&call, approval).await
                        } else if concurrency == ToolConcurrency::Destructive {
                            let _gate = mutating_gate.lock().await;
                            tools.call(&call, approval).await
                        } else if let Some(key) = resource {
                            // Mutating + 已知资源：同路径互斥，异路径可并行（仍受总信号量约束）。
                            let lock = {
                                let mut map = resource_locks
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                Arc::clone(
                                    map.entry(key).or_insert_with(|| Arc::new(AsyncMutex::new(()))),
                                )
                            };
                            let _permit = parallel_limit.acquire().await.ok();
                            let _path = lock.lock().await;
                            tools.call(&call, approval).await
                        } else {
                            // 无路径的 mutating（shell 等）：全局串行更安全。
                            let _gate = mutating_gate.lock().await;
                            tools.call(&call, approval).await
                        };
                        (call.clone(), fingerprint.clone(), result, !blocked)
                    }
                },
            );

            // 每条消息先挂在「它属于哪个 tool_call」上，全部跑完后按 call_order
            // 统一写入会话（实时事件仍然随完成即时下发，不影响前端进度显示）。
            let mut pending: Vec<(String, ChatMessage)> = Vec::new();
            let mut futures: FuturesUnordered<_> = executions.collect();
            while let Some((call, fingerprint, mut result, executed)) = futures.next().await {
                let output = sanitize_long_encoded_data(&result.output);
                if let Some(context) = &mut result.additional_context {
                    *context = sanitize_long_encoded_data(context);
                }
                // 用 take() 避免 clone：plan/loop_state 只需要移动一次
                if let Some(plan) = result.plan.take() {
                    session.plan = Some(plan.clone());
                    observer.on_event(&AgentEvent::PlanUpdated(plan));
                }
                if let Some(loop_state) = result.loop_state.take() {
                    session.loop_state = Some(loop_state.clone());
                    observer.on_event(&AgentEvent::LoopUpdated(loop_state));
                }
                observer.on_event(&AgentEvent::ToolFinished {
                    call: call.clone(),
                    result: result.clone(),
                });
                let status = if result.success { "success" } else { "error" };
                let mut tool_message =
                    ChatMessage::tool(call.id.clone(), format!("{status}: {}", output));
                tool_message.images = result.images.clone();
                pending.push((call.id.clone(), tool_message));
                if let Some(context) = result.additional_context
                    && !context.trim().is_empty()
                {
                    pending.push((call.id.clone(), ChatMessage::internal_user(context)));
                }
                if result.success {
                    tool_failures.remove(&fingerprint);
                    consecutive_failures = 0;
                } else if executed {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    let state = tool_failures.entry(fingerprint.clone()).or_default();
                    state.executions = state.executions.saturating_add(1);
                    state.requires_changed_call = tool_failure_requires_changed_call(&output);
                    // 连续失败自愈提示已移除（用户反馈太烦）；失败由 requires_changed_call 与 auto_correct 兜底。
                    // 工具失败自愈：分析常见错误并尝试自动修正后重试一次
                    if state.executions == 1 {
                        if let Some(corrected) = auto_correct_tool_call(&call, &output) {
                            let retry_result = tools.call(&corrected, approval).await;
                            let retry_succeeded = retry_result.success;
                            observer.on_event(&AgentEvent::ToolFinished {
                                call: corrected.clone(),
                                result: retry_result.clone(),
                            });
                            pending.push((
                                corrected.id.clone(),
                                ChatMessage::tool(
                                    corrected.id,
                                    format!(
                                        "{}: {}",
                                        if retry_succeeded { "success" } else { "error" },
                                        retry_result.output
                                    ),
                                ),
                            ));
                            if retry_succeeded {
                                tool_failures.remove(&fingerprint);
                                consecutive_failures = 0;
                            }
                        }
                    }
                }
            }
            // 按 assistant.tool_calls 的顺序落库：id 与顺序都与调用配对。
            for id in &call_order {
                let mut index = 0;
                while index < pending.len() {
                    if pending[index].0 == *id {
                        session.messages.push(pending.remove(index).1);
                    } else {
                        index += 1;
                    }
                }
            }
            // 兜底：id 不在本轮 tool_calls 里的消息（异常协议）仍按到达顺序保留。
            for (_, message) in pending {
                session.messages.push(message);
            }
            self.accept_queued_input(session, observer);
            // 工具轮边界：本批工具全部结束（没有被中途打断）之后并入插话。
            self.accept_interjections(session, observer, "tool_round");
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
        reason: CompactionReason,
    ) -> Result<(), AgentError> {
        let before_tokens = session.context.estimated_active_tokens;
        let messages_before = session.messages.len();
        observer.on_event(&AgentEvent::CompactionStarted { automatic });
        let capabilities = provider.capabilities();
        // 压缩前的用量占比：压缩历史与事件都要带上「用了窗口的多少才压」。
        let before_used_percent = capabilities.used_percent(before_tokens);
        let mut normalized = normalize_history(&session.messages);
        // 压缩摘要也要看得到附件路径与引用原文（否则压缩后模型丢失这些上下文）。
        render_request_messages(&mut normalized);
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
        let compaction_limit = capabilities
            .context_window
            .saturating_sub(capabilities.max_output_tokens)
            .max(1);
        trim_history_to_fit(&self.system_prompt, &mut normalized, &[], compaction_limit);
        let remote = match provider
            .compact(CompactionRequest {
                model: provider.model().to_string(),
                messages: normalized.clone(),
                system_prompt: self.system_prompt.clone(),
                tools: tool_specs.to_vec(),
            })
            .await
        {
            Ok(remote) => remote,
            Err(error) if automatic => {
                // 自动压缩失败不能打断本轮：降级为直接裁剪，保证上下文能塞进窗口。
                return self.fallback_trim_compaction(
                    session,
                    &mut normalized,
                    tool_specs,
                    observer,
                    automatic,
                    reason,
                    before_tokens,
                    messages_before,
                    &capabilities,
                    error,
                );
            }
            Err(error) => return Err(AgentError::Compaction(error)),
        };

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
            match provider
                .complete(ModelRequest {
                    model: provider.model().to_string(),
                    messages: compact_input,
                    tools: Vec::new(),
                    reasoning_effort: None,
                })
                .await
            {
                Ok(response) => {
                    let compacted = compacted_history_with_budget(
                        &normalized,
                        response.content.trim(),
                        // pinned 保留预算：有效窗口的 20%。
                        capabilities.effective_context_window() / 5,
                        // 近期原文条数上限：压缩后条数必须明显低于消息数阈值，
                        // 否则下一轮立刻又满足条件（每轮多一次摘要模型调用）。
                        (self.auto_compact_message_limit / 2).clamp(8, 64),
                    );
                    // 压缩决策留痕（排查「长输出后最新回复消失」）：记录压缩前后条数，
                    // 以及压缩结果是否包含最新一条助手消息与其尾部正文。
                    let newest_assistant = compacted.iter().rev().find(|m| m.role == Role::Assistant);
                    eprintln!(
                        "[compact] in={} out={} retains_newest_assistant={} newest_len={}",
                        normalized.len(),
                        compacted.len(),
                        newest_assistant.is_some(),
                        newest_assistant.map_or(0, |m| m.content.len()),
                    );
                    (compacted, response.usage)
                },
                Err(error) if automatic => {
                    return self.fallback_trim_compaction(
                        session,
                        &mut normalized,
                        tool_specs,
                        observer,
                        automatic,
                        reason,
                        before_tokens,
                        messages_before,
                        &capabilities,
                        error,
                    );
                }
                Err(error) => return Err(AgentError::Compaction(error)),
            }
        };
        session.messages = messages;
        session.context.reset_after_compaction(
            &self.system_prompt,
            &session.messages,
            tool_specs,
            &capabilities,
            CompactionRecord::started(automatic, reason, before_tokens, messages_before)
                .with_usage(before_used_percent, capabilities.context_window),
        );
        session.usage.add(&compact_usage);
        let status = session.context.status(&provider.capabilities());
        observer.on_event(&AgentEvent::CompactionCompleted {
            automatic,
            before_tokens,
            after_tokens: status.used_tokens,
            reason,
            used_percent: before_used_percent,
            window: capabilities.context_window,
        });
        observer.on_event(&AgentEvent::ContextUpdated(status));
        Ok(())
    }

    /// 自动压缩失败时的兜底：放弃摘要，直接裁剪历史到窗口内。
    fn fallback_trim_compaction(
        &self,
        session: &mut Session,
        normalized: &mut Vec<ChatMessage>,
        tool_specs: &[crate::ToolSpec],
        observer: &dyn AgentObserver,
        automatic: bool,
        reason: CompactionReason,
        before_tokens: u64,
        messages_before: usize,
        capabilities: &crate::ModelCapabilities,
        error: anyhow::Error,
    ) -> Result<(), AgentError> {
        let compaction_limit = capabilities
            .context_window
            .saturating_sub(capabilities.max_output_tokens)
            .max(1);
        trim_history_to_fit(&self.system_prompt, normalized, &[], compaction_limit);
        // 摘要不可用时，保留原始用户消息并注入降级标记，避免静默丢上下文。
        let mut messages = std::mem::take(normalized);
        // 条数兜底：token 没超但条数仍达到消息数阈值时，只保留近期尾段（pinned 优先），
        // 否则压缩后条数没下降，下一轮会立刻再次触发压缩（每轮多一次失败模型调用）。
        if messages.len() >= self.auto_compact_message_limit {
            messages = retained_user_history_with_count(
                &messages,
                capabilities.effective_context_window() / 5,
                (self.auto_compact_message_limit / 2).clamp(8, 64),
            );
        }
        messages.push(ChatMessage::summary(format!(
            "[automatic compaction summary unavailable: {error:#}; history was trimmed to fit the context window]"
        )));
        session.messages = messages;
        session.context.reset_after_compaction(
            &self.system_prompt,
            &session.messages,
            tool_specs,
            capabilities,
            CompactionRecord::started(automatic, reason, before_tokens, messages_before).with_usage(
                capabilities.used_percent(before_tokens),
                capabilities.context_window,
            ),
        );
        let status = session.context.status(capabilities);
        observer.on_event(&AgentEvent::CompactionCompleted {
            automatic,
            before_tokens,
            after_tokens: status.used_tokens,
            reason,
            used_percent: capabilities.used_percent(before_tokens),
            window: capabilities.context_window,
        });
        observer.on_event(&AgentEvent::ContextUpdated(status));
        Ok(())
    }

    /// 发起一次流式请求，并在「正文已开始输出 + 运行中插话到达」时软打断。
    ///
    /// 软打断的语义：停止等待这一次流（放弃还没生成的部分），但**已生成内容不丢**
    /// ——草稿缓冲由调用方在返回后立刻定稿落盘；随后插话并入本轮上下文，本轮继续。
    /// 还没有正文（纯思考阶段）时不打断：让这次模型调用自然结束，
    /// 插话在下一个安全点并入。
    async fn stream_response(
        &self,
        provider: &dyn ModelProvider,
        request: &ModelRequest,
        stream_observer: &ObserverStream<'_>,
    ) -> StreamAttempt {
        let Some(input_queue) = self.input_queue.as_ref() else {
            return StreamAttempt::Done(
                provider
                    .complete_stream(request.clone(), stream_observer)
                    .await,
            );
        };
        let stream = provider.complete_stream(request.clone(), stream_observer);
        tokio::pin!(stream);
        loop {
            // 先查标志再 await：push 用 notify_one（会留 permit），
            // 「查完还没注册 waiter」的窗口不会丢唤醒。
            if input_queue.has_pending_interjections() && stream_observer.produced_text() {
                return StreamAttempt::Interrupted;
            }
            tokio::select! {
                biased;
                () = input_queue.wait_for_interjection() => {}
                result = stream.as_mut() => return StreamAttempt::Done(result),
            }
        }
    }

    /// 在当前轮的下一个安全点并入「运行中插话」：消息作为 user 消息进入本轮上下文，
    /// 本轮继续跑（不新开一轮）。工具执行中不打断工具——调用方只在工具批次结束后
    /// 或下一次模型调用前调用它。返回真正并入的条数。
    fn accept_interjections(
        &self,
        session: &mut Session,
        observer: &dyn AgentObserver,
        step: &str,
    ) -> usize {
        let Some(input_queue) = &self.input_queue else {
            return 0;
        };
        let interjections = input_queue.drain_interjections();
        if interjections.is_empty() {
            return 0;
        }
        let mut applied = 0;
        for interjection in interjections {
            if interjection.message.content.trim().is_empty()
                && !interjection.message.has_structured_context()
            {
                observer.on_event(&AgentEvent::InterjectionRejected {
                    id: interjection.id,
                    reason: "插话内容为空，已忽略".to_owned(),
                });
                continue;
            }
            let text = interjection.message.content.clone();
            session.messages.push(interjection.message);
            observer.on_event(&AgentEvent::InterjectionApplied {
                id: interjection.id,
                step: step.to_owned(),
                text,
            });
            applied += 1;
        }
        if applied > 0 {
            repair_tool_pairing(&mut session.messages);
            session.messages = normalize_history(&session.messages);
            self.run_checkpoint(session);
        }
        applied
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

/// 最近一条「用户亲自发的」消息正文：工具裁剪按它选关键词。
fn latest_user_prompt(session: &Session) -> String {
    session
        .messages
        .iter()
        .rev()
        .find(|message| matches!(message.role, crate::Role::User) && !message.internal)
        .map(|message| message.content.chars().take(2_000).collect::<String>())
        .unwrap_or_default()
}

/// 请求侧渲染：把结构化附件（路径）与引用（原文）内联进正文。
/// 只作用于发往模型的副本，session.messages 原样保留（UI 侧不显示拼接文本）。
fn render_request_messages(messages: &mut [ChatMessage]) {
    for message in messages.iter_mut() {
        if message.has_structured_context() {
            message.content = message.model_content();
        }
        // 本轮上下文尾巴（记忆/技能/目标/MCP）：随消息**持久化**、发请求时再拼上去。
        // 存下来是必须的 —— 下一轮它就成了历史的一部分，只有历史里存的和这一轮发出去的
        // 逐字节一致，前缀缓存才能连上（临时拼接会让每条用户消息都成为一个分叉点）。
        if !message.request_context.is_empty() {
            message.content.push_str("\n\n");
            message.content.push_str(&message.request_context);
        }
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

/// 稳定的工具清单：**全集 + 确定性顺序**（按名字排序）。
///
/// 为什么不再按当前提问裁剪（旧 select_tool_specs 已删除）：工具数组排在请求最前面
/// （OpenAI 的 tools / Anthropic 顶层 tools），一删一加就等于把整段前缀缓存作废 ——
/// 实测同一会话里命中率 0% 与 98% 交替，正是相邻两轮提问关键词不同造成的。
/// 而且「工具时有时无」本身就在削模型能力：关键词没命中时，模型压根不知道有这个工具。
///
/// 多出来的工具描述 token 属于**可缓存的稳定前缀**：稳态下每轮都命中，只为首轮与
/// 写缓存那一轮付费；换来的是「工具永远齐全 + 前缀永不抖动」。
fn stable_tool_specs(all: &[crate::ToolSpec]) -> Vec<crate::ToolSpec> {
    let mut specs = all.to_vec();
    // MCP 工具的到达顺序取决于运行时连接顺序，必须排序才能跨轮一致。
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    specs
}

/// 把本轮的「上下文尾巴」挂到请求里**最后一条 user 消息**的末尾（只改请求，不改会话历史）。
///
/// 为什么是"并进 user 消息"而不是新加一条消息、也不是放系统提示：
///   ① 各家对角色交替的约束不同（连续两条 user 有的拒绝、有的自动合并）→ 同一条最兼容；
///   ② 它紧跟当前提问，是近因位置，模型对它的注意力最强，指令遵循不降反升；
///   ③ 历史里更早的消息**一个字节都不动** —— 前缀缓存靠的就是这一点（system+tools+历史逐字节不变）。
fn inject_request_tail(messages: &mut [ChatMessage], tail: &str) {
    let tail = tail.trim();
    if tail.is_empty() {
        return;
    }
    for message in messages.iter_mut().rev() {
        if message.role == crate::Role::User {
            message.content.push_str("\n\n");
            message.content.push_str(tail);
            return;
        }
    }
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

/// 工具调用失败自愈：分析常见错误模式，自动修正参数后返回修正后的调用。
/// 返回 None 表示无法自动修复，交由模型重新决策。
fn auto_correct_tool_call(call: &ToolCall, output: &str) -> Option<ToolCall> {
    let text = output.to_ascii_lowercase();

    // 路径不存在 → 尝试修正相对路径为绝对路径
    if text.contains("no such file")
        || text.contains("not found")
        || text.contains("不存在")
        || text.contains("未找到")
    {
        if let Some(args) = call.arguments.as_object() {
            for (key, value) in args {
                if let Some(path_str) = value.as_str() {
                    if path_str.starts_with("./") || path_str.starts_with("../") {
                        let corrected = std::path::PathBuf::from(path_str);
                        if let Ok(canonical) = corrected.canonicalize() {
                            let mut new_args = args.clone();
                            new_args.insert(
                                key.clone(),
                                serde_json::Value::String(canonical.to_string_lossy().into_owned()),
                            );
                            let mut new_call = call.clone();
                            new_call.arguments = serde_json::Value::Object(new_args);
                            return Some(new_call);
                        }
                    }
                }
            }
        }
    }

    // 权限被拒 → 提示用户授权而非重试
    if text.contains("permission denied") || text.contains("not permitted") {
        return None;
    }

    None
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

/// 本轮思考文本累加器：所有流式协议（chat/completions 的 reasoning_content、
/// Responses 的 reasoning summary delta）都经 on_reasoning_delta 汇聚到这里，
/// 流式结束后写入 assistant 消息的 reasoning 字段并落盘。
///
/// 重试/重新生成时必须 reset()，否则上一段作废的思考会混进正式回复。
#[derive(Default)]
struct ReasoningBuffer(StdMutex<String>);

impl ReasoningBuffer {
    fn push(&self, delta: &str) {
        let mut text = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if text.len() < REASONING_MAX_BYTES {
            text.push_str(delta);
        }
    }

    fn reset(&self) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    fn take(&self) -> String {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|p| p.into_inner()))
    }
}

/// 思考文本落盘上限（约 20 万字符）：与草稿同量级，避免异常模型把会话文件撑爆。
const REASONING_MAX_BYTES: usize = 400_000;

struct ObserverStream<'a> {
    observer: &'a dyn AgentObserver,
    /// 流式草稿：本轮草稿状态 + 落盘回调，未注册回调时为 None。
    draft: Option<(&'a DraftState, &'a (dyn Fn(&Session) + Send + Sync))>,
    /// 本轮思考累积（与是否注册草稿回调无关）。
    reasoning: ReasoningBuffer,
    /// 是否已经产出过正文：软打断只在「正在流式输出正文」时触发
    /// （纯思考阶段不打断这一次模型调用）。
    produced_text: std::sync::atomic::AtomicBool,
    /// 本轮正文增量（与是否注册草稿回调无关）。软打断/失败收尾时用它兜底，
    /// 保证「已经生成的正文」在任何收尾路径上都能落进会话。
    partial: StdMutex<String>,
}

impl ModelStreamObserver for ObserverStream<'_> {
    fn on_text_delta(&self, delta: &str) {
        if !delta.is_empty() {
            self.produced_text
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let mut partial = self.partial.lock().unwrap_or_else(|p| p.into_inner());
            if partial.len() < DRAFT_MAX_BYTES {
                partial.push_str(delta);
            }
        }
        self.observer
            .on_event(&AgentEvent::TextDelta(delta.to_owned()));
        if let Some((draft, sink)) = &self.draft {
            draft.push(delta, *sink);
        }
    }


    fn on_reasoning_delta(&self, delta: &str) {
        self.observer
            .on_event(&AgentEvent::ReasoningDelta(delta.to_owned()));
        self.reasoning.push(delta);
        if let Some((draft, _)) = &self.draft {
            draft.push_reasoning(delta);
        }
    }
}

impl ObserverStream<'_> {
    /// 已经流过正文（哪怕一个字符）：软打断的判定条件。
    fn produced_text(&self) -> bool {
        self.produced_text
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 取走已累积的正文（DraftState 缺席时的兜底来源）。
    fn take_partial_text(&self) -> String {
        std::mem::take(&mut *self.partial.lock().unwrap_or_else(|p| p.into_inner()))
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

    /// 流式草稿：模型还在生成时，部分输出必须已经写进会话的最后一条草稿消息。
    struct StreamProvider;

    #[async_trait]
    impl ModelProvider for StreamProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "mock-stream"
        }

        async fn complete(&self, _request: ModelRequest) -> Result<ModelResponse> {
            Ok(ModelResponse {
                content: "hello world".into(),
                ..ModelResponse::default()
            })
        }

        async fn complete_stream(
            &self,
            _request: ModelRequest,
            observer: &dyn ModelStreamObserver,
        ) -> Result<ModelResponse> {
            // 分片到达：第一片就该触发一次草稿落盘（间隔计时从“早该落盘”开始）。
            observer.on_text_delta("hello");
            observer.on_text_delta(" world");
            Ok(ModelResponse {
                content: "hello world".into(),
                streamed: true,
                ..ModelResponse::default()
            })
        }
    }


    /// 只读工具（名字命中只读并发集合）：两个调用真正并发执行，完成顺序可以
    /// 与 tool_calls 顺序相反 —— 用来验证结果落库时按调用顺序重排、id 保持配对。
    struct ReadFileTool;

    #[async_trait]
    impl ToolRuntime for ReadFileTool {
        fn specs(&self) -> Vec<ToolSpec> {
            vec![ToolSpec {
                name: "read_file".into(),
                description: "read".into(),
                parameters: json!({"type": "object"}),
            }]
        }

        async fn call(&self, call: &ToolCall, _approval: &dyn ApprovalHandler) -> ToolResult {
            let delay = call.arguments["delay_ms"].as_u64().unwrap_or(0);
            tokio::time::sleep(Duration::from_millis(delay)).await;
            ToolResult::success(format!(
                "contents of {}",
                call.arguments["path"].as_str().unwrap_or_default()
            ))
        }
    }

    /// 思考 + 两个工具调用 + 最终回答：验证 reasoning 落库、tool_calls 与 tool 结果配对。
    struct ReasoningToolProvider;

    #[async_trait]
    impl ModelProvider for ReasoningToolProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "mock-reasoning"
        }

        async fn complete(&self, _request: ModelRequest) -> Result<ModelResponse> {
            Ok(ModelResponse::default())
        }

        async fn complete_stream(
            &self,
            request: ModelRequest,
            observer: &dyn ModelStreamObserver,
        ) -> Result<ModelResponse> {
            let has_tool_output = request
                .messages
                .iter()
                .any(|message| message.role == crate::Role::Tool);
            if has_tool_output {
                observer.on_reasoning_delta("final-thought");
                observer.on_text_delta("done");
                return Ok(ModelResponse {
                    content: "done".into(),
                    streamed: true,
                    ..ModelResponse::default()
                });
            }
            observer.on_reasoning_delta("think-a ");
            observer.on_reasoning_delta("think-b");
            Ok(ModelResponse {
                tool_calls: vec![
                    ToolCall {
                        id: "call-a".into(),
                        name: "read_file".into(),
                        arguments: json!({"path": "a.rs", "delay_ms": 60}),
                    },
                    ToolCall {
                        id: "call-b".into(),
                        name: "read_file".into(),
                        arguments: json!({"path": "b.rs", "delay_ms": 0}),
                    },
                ],
                streamed: true,
                ..ModelResponse::default()
            })
        }
    }

    #[tokio::test]
    async fn thinking_and_tool_cards_survive_the_turn() {
        let mut session = Session::new("mock", "mock-reasoning", PathBuf::from("."));
        // 草稿检查点：流式期间的落盘快照也必须带上思考文本。
        let drafts: Arc<Mutex<Vec<Vec<ChatMessage>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&drafts);
        let agent = Agent::new("test").with_draft_checkpoint(Arc::new(move |snapshot: &Session| {
            sink.lock()
                .expect("lock draft sink")
                .push(snapshot.messages.clone());
        }));
        let output = agent
            .run_turn(
                &mut session,
                "read two files",
                &ReasoningToolProvider,
                &ReadFileTool,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("agent turn");
        assert_eq!(output, "done");

        let calls = &session.messages[1].tool_calls;
        assert_eq!(calls.len(), 2, "assistant message keeps both tool calls");
        assert_eq!(session.messages[1].reasoning, "think-a think-b");
        // tool 结果按 tool_calls 的顺序落库（b 先跑完也不能插到 a 前面），id 一一配对。
        let first = &session.messages[2];
        let second = &session.messages[3];
        assert_eq!(first.tool_call_id.as_deref(), Some(calls[0].id.as_str()));
        assert_eq!(second.tool_call_id.as_deref(), Some(calls[1].id.as_str()));
        assert!(first.content.contains("a.rs"), "{}", first.content);
        assert!(second.content.contains("b.rs"), "{}", second.content);
        assert_eq!(session.messages[4].reasoning, "final-thought");
        assert_eq!(session.messages.len(), 5);

        let captured = drafts.lock().expect("lock draft sink");
        assert!(
            captured.iter().flatten().any(|message| message.draft
                && message.reasoning.contains("final-thought")),
            "a draft snapshot must carry the reasoning text"
        );
    }

    #[tokio::test]
    async fn draft_checkpoint_persists_partial_stream_output() {
        let mut session = Session::new("mock", "mock-stream", PathBuf::from("."));
        let drafts: Arc<Mutex<Vec<Vec<ChatMessage>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&drafts);
        let agent = Agent::new("test").with_draft_checkpoint(Arc::new(move |snapshot: &Session| {
            sink.lock()
                .expect("lock draft sink")
                .push(snapshot.messages.clone());
        }));
        let output = agent
            .run_turn(
                &mut session,
                "hi",
                &StreamProvider,
                &EchoTool,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("agent turn");
        assert_eq!(output, "hello world");

        // 流式期间落过盘，且落盘的就是当时已生成的部分文本。
        let captured = drafts.lock().expect("lock draft sink");
        let first = captured.first().expect("draft checkpoint was called");
        let draft = first.last().expect("draft message");
        assert!(draft.draft, "the persisted message must be marked as a draft");
        assert_eq!(draft.content, "hello");

        // 正常结束：草稿被正式回复就地替换，不会留下两条助手消息。
        let assistants = session
            .messages
            .iter()
            .filter(|message| message.role == crate::Role::Assistant)
            .collect::<Vec<_>>();
        assert_eq!(assistants.len(), 1);
        assert!(!assistants[0].draft);
        assert_eq!(assistants[0].content, "hello world");
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

    /// 事件记录器：断言插话事件（applied / rejected）与它们的 step。
    #[derive(Default)]
    struct RecordingObserver {
        events: Mutex<Vec<String>>,
    }

    impl RecordingObserver {
        fn steps(&self, event_type: &str) -> Vec<String> {
            self.events
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .iter()
                .filter_map(|entry| entry.strip_prefix(&format!("{event_type}:")))
                .map(str::to_owned)
                .collect()
        }
    }

    impl AgentObserver for RecordingObserver {
        fn on_event(&self, event: &AgentEvent) {
            let entry = match event {
                AgentEvent::InterjectionApplied { step, text, .. } => {
                    format!("interjection_applied:{step}:{text}")
                }
                AgentEvent::InterjectionRejected { reason, .. } => {
                    format!("interjection_rejected:{reason}")
                }
                _ => return,
            };
            self.events
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(entry);
        }
    }

    /// 工具执行中用户插话：工具不会被中断，本批工具结束后插话并入本轮继续。
    struct InterjectingTool {
        queue: Arc<InputQueue>,
    }

    #[async_trait]
    impl ToolRuntime for InterjectingTool {
        fn specs(&self) -> Vec<ToolSpec> {
            vec![ToolSpec {
                name: "echo".into(),
                description: "echo".into(),
                parameters: json!({"type": "object"}),
            }]
        }

        async fn call(&self, call: &ToolCall, _approval: &dyn ApprovalHandler) -> ToolResult {
            // 工具还在跑的时候用户把话说完（插话只能等这个工具结束再并入）。
            self.queue
                .push_interjection("ij-tool", ChatMessage::user("顺便把 README 也看了"));
            tokio::time::sleep(Duration::from_millis(50)).await;
            ToolResult::success(call.arguments["value"].as_str().unwrap_or_default())
        }
    }

    struct ToolBoundaryInterjectionProvider;

    #[async_trait]
    impl ModelProvider for ToolBoundaryInterjectionProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "interject"
        }

        async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
            let saw_tool = request
                .messages
                .iter()
                .any(|message| message.role == crate::Role::Tool);
            if !saw_tool {
                return Ok(ModelResponse {
                    tool_calls: vec![ToolCall {
                        id: "call-1".into(),
                        name: "echo".into(),
                        arguments: json!({"value": "ok"}),
                    }],
                    ..ModelResponse::default()
                });
            }
            assert!(
                request.messages.iter().any(|message| {
                    message.role == crate::Role::User
                        && message.content.contains("顺便把 README 也看了")
                }),
                "插话必须出现在同一个请求上下文里"
            );
            Ok(ModelResponse {
                content: "已按插话继续".into(),
                ..ModelResponse::default()
            })
        }
    }

    #[tokio::test]
    async fn interjection_joins_the_active_turn_after_the_tool_round() {
        let queue = Arc::new(InputQueue::default());
        let observer = RecordingObserver::default();
        let mut session = Session::new("mock", "interject", PathBuf::from("."));
        let output = Agent::new("test")
            .with_input_queue(Arc::clone(&queue))
            .run_turn(
                &mut session,
                "开始",
                &ToolBoundaryInterjectionProvider,
                &InterjectingTool {
                    queue: Arc::clone(&queue),
                },
                &Approve,
                &observer,
            )
            .await
            .expect("interjected turn");
        // 同一轮里就并入了插话并给出最终答案（没有新开 turn）。
        assert_eq!(output, "已按插话继续");
        assert!(
            session
                .messages
                .iter()
                .any(|message| message.role == crate::Role::User
                    && message.content == "顺便把 README 也看了")
        );
        assert_eq!(
            observer.steps("interjection_applied"),
            vec!["tool_round:顺便把 README 也看了".to_owned()]
        );
        assert!(!queue.has_pending_interjections());
    }

    /// 流式正文期间插话：软打断这一次流，但已生成内容必须保留并继续本轮。
    struct SlowStreamInterjectionProvider {
        calls: Mutex<usize>,
        queue: Arc<InputQueue>,
    }

    #[async_trait]
    impl ModelProvider for SlowStreamInterjectionProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "slow"
        }

        async fn complete(&self, _request: ModelRequest) -> Result<ModelResponse> {
            Ok(ModelResponse::default())
        }

        async fn complete_stream(
            &self,
            request: ModelRequest,
            observer: &dyn ModelStreamObserver,
        ) -> Result<ModelResponse> {
            let call = {
                let mut calls = self.calls.lock().expect("lock calls");
                *calls += 1;
                *calls
            };
            if call > 1 {
                assert!(
                    request.messages.iter().any(|message| {
                        message.role == crate::Role::User && message.content == "换个方向"
                    }),
                    "软打断之后插话必须并入本轮"
                );
                return Ok(ModelResponse {
                    content: "新方向的回答".into(),
                    ..ModelResponse::default()
                });
            }
            observer.on_text_delta("第一段结论：");
            self.queue
                .push_interjection("ij-stream", ChatMessage::user("换个方向"));
            observer.on_text_delta("继续生成的正文");
            // 模型还在慢慢吐字：软打断必须立刻生效，不能等这一次流自然结束。
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(ModelResponse {
                content: "不该被采纳".into(),
                streamed: true,
                ..ModelResponse::default()
            })
        }
    }

    #[tokio::test]
    async fn streaming_interjection_soft_interrupts_and_keeps_generated_text() {
        let queue = Arc::new(InputQueue::default());
        let observer = RecordingObserver::default();
        let mut session = Session::new("mock", "slow", PathBuf::from("."));
        let started = Instant::now();
        let output = Agent::new("test")
            .with_input_queue(Arc::clone(&queue))
            .run_turn(
                &mut session,
                "开始",
                &SlowStreamInterjectionProvider {
                    calls: Mutex::new(0),
                    queue: Arc::clone(&queue),
                },
                &EchoTool,
                &Approve,
                &observer,
            )
            .await
            .expect("soft interrupted turn");
        assert_eq!(output, "新方向的回答");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "软打断必须立刻收尾，而不是等模型吐完：{:?}",
            started.elapsed()
        );
        // 已生成的正文以草稿消息留在会话里（内容不丢）。
        assert!(session.messages.iter().any(|message| {
            message.role == crate::Role::Assistant
                && message.draft
                && message.content.contains("第一段结论：")
        }));
        let steps = observer.steps("interjection_applied");
        assert_eq!(steps.len(), 1);
        assert!(steps[0].starts_with("stream_interrupt:"));
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
                // 这个 fixture 专测「窗口比例」这一条：关掉保留区与绝对下限。
                auto_compact_floor_tokens: 0,
                auto_compact_retain_tokens: 0,
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
        // 压缩历史（F4）：原因与前后规模都要落账。
        let record = session
            .context
            .compaction_history
            .last()
            .expect("compaction record");
        assert_eq!(record.reason, CompactionReason::Percent);
        assert!(record.automatic);
        // 压缩历史带原因与占比（F4）：窗口 100、压缩前约 193 token。
        assert_eq!(record.window, 100);
        assert!(record.used_percent >= 90);
        assert_eq!(record.messages_before, 2);
        assert!(record.messages_after <= record.messages_before);
        assert!(record.after_tokens > 0);
    }

    #[test]
    fn compaction_reason_maps_to_wire_names() {
        assert_eq!(CompactionReason::Percent.as_str(), "percent");
        assert_eq!(CompactionReason::Floor.as_str(), "floor");
        assert_eq!(CompactionReason::Messages.as_str(), "messages");
        assert_eq!(CompactionReason::Cache.as_str(), "cache");
        assert_eq!(CompactionReason::ProviderError.as_str(), "provider_error");
        assert_eq!(CompactionReason::Manual.as_str(), "manual");
    }

    /// 旧会话文件里的历史原因（token_limit / context_window / comp_hash /
    /// message_limit）必须还能反序列化，否则老会话读不出来。
    #[test]
    fn legacy_compaction_reasons_still_deserialize() {
        let parse = |raw: &str| serde_json::from_str::<CompactionReason>(raw).expect("legacy reason");
        assert_eq!(parse("\"token_limit\""), CompactionReason::Percent);
        assert_eq!(parse("\"context_window\""), CompactionReason::Percent);
        assert_eq!(parse("\"comp_hash\""), CompactionReason::Cache);
        assert_eq!(parse("\"message_limit\""), CompactionReason::Messages);
        assert_eq!(parse("\"provider_error\""), CompactionReason::ProviderError);
        assert_eq!(parse("\"manual\""), CompactionReason::Manual);
    }

    /// 消息条数 fixture 的每条历史消息长度：约 22 token/条，
    /// 79 条加起来刚好让用量超过窗口 50%（条数条件的门槛）而不触及窗口比例阈值。
    fn history_message(index: usize) -> String {
        format!("history message {index} {}", "x".repeat(64))
    }

    /// 没有 token 维度压缩原因的 provider：只有消息条数条件能触发它。
    /// 窗口 8_000、阈值 95%（7_600）：fixture 用量落在（4_000, 7_600），
    /// 命中「条数条件」而不是「窗口比例条件」。
    struct RoomyProvider {
        calls: Mutex<usize>,
    }

    #[async_trait]
    impl ModelProvider for RoomyProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "roomy"
        }

        fn capabilities(&self) -> ModelCapabilities {
            ModelCapabilities {
                context_window: 8_000,
                effective_context_window_percent: 100,
                auto_compact_percent: 95,
                auto_compact_floor_tokens: 0,
                auto_compact_retain_tokens: 0,
                ..ModelCapabilities::default()
            }
        }

        async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
            let mut calls = self.calls.lock().expect("lock calls");
            *calls += 1;
            if request.tools.is_empty() {
                return Ok(ModelResponse {
                    content: "summary".into(),
                    ..ModelResponse::default()
                });
            }
            Ok(ModelResponse {
                content: "done".into(),
                ..ModelResponse::default()
            })
        }
    }

    #[tokio::test]
    async fn message_limit_is_the_second_compaction_trigger() {
        let mut session = Session::new("mock", "roomy", PathBuf::from("."));
        // 79 条历史 + 本轮用户消息 = 80 条，正好达到消息数阈值；
        // 用量超过窗口 50% 但没到 95% 阈值，唯一能触发的原因就是 messages。
        for index in 0..79 {
            session.messages.push(ChatMessage::user(history_message(index)));
        }
        let provider = RoomyProvider {
            calls: Mutex::new(0),
        };
        Agent::new("test")
            .with_auto_compact_message_limit(80)
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
        let record = session
            .context
            .compaction_history
            .last()
            .expect("compaction record");
        assert_eq!(record.reason, CompactionReason::Messages);
        assert!(record.automatic);
        assert_eq!(record.window, 8_000);
        assert_eq!(record.messages_before, 80);
        assert!(record.messages_after < record.messages_before);
    }

    #[tokio::test]
    async fn message_limit_is_clamped_to_a_floor() {
        // 下限保护：配置 5 条也会被抬到 MIN_AUTO_COMPACT_MESSAGE_LIMIT。
        let mut session = Session::new("mock", "roomy", PathBuf::from("."));
        for index in 0..(MIN_AUTO_COMPACT_MESSAGE_LIMIT - 1) {
            session.messages.push(ChatMessage::user(history_message(index)));
        }
        let provider = RoomyProvider {
            calls: Mutex::new(0),
        };
        Agent::new("test")
            .with_auto_compact_message_limit(5)
            .run_turn(
                &mut session,
                "continue",
                &provider,
                &EchoTool,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("turn");
        // 下限 80 条才达标（79 + 1）：配置 5 不会提前触发。
        assert_eq!(session.context.compaction_count, 1);
        assert_eq!(
            session.context.compaction_history.last().expect("record").messages_before,
            MIN_AUTO_COMPACT_MESSAGE_LIMIT
        );
    }

    #[tokio::test]
    async fn disabled_auto_compaction_skips_automatic_triggers() {
        let mut session = Session::new("mock", "tiny", PathBuf::from("."));
        session.messages.push(ChatMessage::user("x".repeat(500)));
        let provider = CompactingProvider {
            calls: Mutex::new(0),
        };
        Agent::new("test")
            .with_auto_compaction_enabled(false)
            .run_turn(
                &mut session,
                "continue",
                &provider,
                &EchoTool,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("turn");
        assert_eq!(session.context.compaction_count, 0);
        assert!(session.context.compaction_history.is_empty());
    }

    /// 第一次带工具请求直接报「上下文超限」的 provider。
    struct OverflowProvider {
        calls: Mutex<usize>,
    }

    #[async_trait]
    impl ModelProvider for OverflowProvider {
        fn provider_id(&self) -> &str {
            "mock"
        }

        fn model(&self) -> &str {
            "overflow"
        }

        async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
            let mut calls = self.calls.lock().expect("lock calls");
            *calls += 1;
            let first = *calls == 1;
            if request.tools.is_empty() {
                return Ok(ModelResponse {
                    content: "summary".into(),
                    ..ModelResponse::default()
                });
            }
            if first {
                anyhow::bail!("upstream error: too many tokens for this model");
            }
            Ok(ModelResponse {
                content: "done".into(),
                ..ModelResponse::default()
            })
        }
    }

    #[tokio::test]
    async fn provider_context_overflow_still_compacts_when_auto_is_disabled() {
        let mut session = Session::new("mock", "overflow", PathBuf::from("."));
        session.messages.push(ChatMessage::user("hello"));
        let provider = OverflowProvider {
            calls: Mutex::new(0),
        };
        Agent::new("test")
            .with_auto_compaction_enabled(false)
            .run_turn(
                &mut session,
                "continue",
                &provider,
                &EchoTool,
                &Approve,
                &NoopObserver,
            )
            .await
            .expect("turn");
        // 关掉自动压缩不能关掉 provider 兜底：报超限时仍然强制压缩一次。
        assert_eq!(session.context.compaction_count, 1);
        let record = session
            .context
            .compaction_history
            .last()
            .expect("compaction record");
        assert_eq!(record.reason, CompactionReason::ProviderError);
        assert!(record.automatic);
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
        assert!(session.messages.last().is_some_and(|message| {
            message.compaction_summary && message.content.contains("summary")
        }));
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
    if calls.is_empty() { None } else { Some(calls) }
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
