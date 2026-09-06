export type ToolAccess = 'read_only' | 'write' | 'destructive'

export interface UsageInfo {
  input_tokens: number; output_tokens: number; total_tokens: number
  cached_input_tokens?: number
  cache_hit_rate?: number | null
  cache_data_available?: boolean
  turn_cache_hit_rate?: number | null
  turn_cache_data_available?: boolean
  context_ratio?: number
  context_used_tokens?: number
  context_window_tokens?: number
  first_token_latency_ms?: number | null
  output_tokens_per_second?: number | null
  turn_total_tokens?: number
}
export interface ReasoningEffortStats {
  turns: number
  cache_hit_rate: number | null
  average_duration_ms: number | null
  average_total_tokens: number | null
  cache_available: boolean
}

export interface TextChunkEvent { event_type: 'text_chunk'; content: string }
export interface ReasoningChunkEvent { event_type: 'reasoning_chunk'; content: string }
export interface ToolStartEvent { event_type: 'tool_start'; call_id: string; tool_name: string; arguments: Record<string, unknown> }
export interface ToolRunningEvent { event_type: 'tool_running'; call_id: string; tool_name: string }
/** 工具执行中的增量输出（shell/local_shell 流式回传），对话页实时可见。 */
export interface ToolOutputEvent { event_type: 'tool_output'; call_id: string; chunk: string }
export interface ToolDoneEvent { event_type: 'tool_done'; call_id: string; tool_name: string; elapsed: number; result_preview: string; is_error: boolean; images?: string[] }
export interface ToolCacheHitEvent { event_type: 'tool_cache_hit'; call_id: string; tool_name: string }
export interface UsageUpdateEvent {
  event_type: 'usage_update'
  usage: UsageInfo
  reasoning_efforts?: Partial<Record<'auto' | 'low' | 'medium' | 'high' | 'xhigh', ReasoningEffortStats>>
  context_categories?: Partial<Record<'system_tools' | 'messages' | 'skills' | 'mcp_tools' | 'system_prompt' | 'other', number>>
}
export interface ConnectionRetryEvent { event_type: 'connection_retry'; attempt: number; max_attempts: number; delay?: number; delay_ms?: number; message: string }
export interface StreamResetEvent { event_type: 'stream_reset' }
export interface CompressionEvent { event_type: 'compression'; before: number; after: number }
export interface AgentErrorEvent { event_type: 'agent_error'; message: string; is_fatal: boolean }
export interface ConfigurationRequiredEvent { event_type: 'configuration_required'; message: string; route: '/providers' }
export interface RetryConfirmationEvent { event_type: 'retry_confirmation'; message: string }
export interface AgentCancelledEvent { event_type: 'agent_cancelled' }
export interface BgTaskDetachedEvent { event_type: 'bg_task_detached'; task_id: string; tool_name: string }
export interface BgTaskCompletedEvent { event_type: 'bg_task_completed'; task_id: string; tool_name: string; is_error: boolean }
export interface LoopStepStartEvent { event_type: 'loop_step_start'; step_index: number; step_description: string; total_steps: number }
export interface LoopStepDoneEvent { event_type: 'loop_step_done'; step_index: number; success: boolean }
export interface LoopProgressEvent { event_type: 'loop_progress'; current_step: number; total_steps: number; status: string }
export interface LoopIssueCreatedEvent { event_type: 'loop_issue_created'; step_index: number; step_description: string }
export interface ToolApprovalRequestEvent { event_type: 'tool_approval_request'; call_id: string; tool_name: string; arguments: Record<string, unknown>; access: ToolAccess; risk_summary?: string; }
export interface UserQuestionOption { label: string; description: string }
export interface UserQuestion { id: string; header: string; question: string; options: UserQuestionOption[] }
export interface UserQuestionRequestEvent { event_type: 'user_question_request'; call_id: string; questions: UserQuestion[] }
export interface FileTransferRequestEvent { event_type: 'file_transfer_request'; request_id: string; operation: 'import' | 'export'; path?: string; suggested_name?: string; multiple: boolean }
export interface TurnEndEvent { event_type: 'turn_end' }
/** 重连补发：会话是否正在后台执行（切走会话后任务继续跑）。 */
export interface SessionStateEvent { event_type: 'session_state'; running: boolean }
export interface SessionLoadedEvent {
  event_type: 'session_loaded'
  session_id: string
  cwd: string
  usage: { input_tokens: number; output_tokens: number; total_tokens: number }
}
/** 数字生命体主动消息投递完成（气泡/开场问候）。 */
export interface LifeDeliveredEvent {
  event_type: 'life_delivered'
  message_id: string
  trigger: string
  text: string
}
export interface CollaborationStartedEvent { event_type: 'collaboration_started'; cycles: number }
export interface CollaborationPhaseEvent { event_type: 'collaboration_phase'; phase: 'coder' | 'reviewer'; cycle: number; status: string }
export interface CollaborationReviewEvent { event_type: 'collaboration_review'; cycle: number; status: 'approved' | 'findings' | 'error'; content: string }
export interface CollaborationFinishedEvent { event_type: 'collaboration_finished'; cycle?: number; status?: 'approved' | 'findings' | 'error'; summary?: string }

export type AgentEvent = (
  | TextChunkEvent | ReasoningChunkEvent | ToolStartEvent | ToolRunningEvent
  | ToolOutputEvent
  | ToolDoneEvent | ToolCacheHitEvent | UsageUpdateEvent | ConnectionRetryEvent | StreamResetEvent
  | CompressionEvent | AgentErrorEvent | ConfigurationRequiredEvent | AgentCancelledEvent | BgTaskDetachedEvent
  | BgTaskCompletedEvent | LoopStepStartEvent | LoopStepDoneEvent | LoopProgressEvent
  | LoopIssueCreatedEvent | RetryConfirmationEvent | ToolApprovalRequestEvent | UserQuestionRequestEvent
  | FileTransferRequestEvent
  | TurnEndEvent
  | SessionStateEvent
  | SessionLoadedEvent
  | LifeDeliveredEvent
  | CollaborationStartedEvent | CollaborationPhaseEvent | CollaborationReviewEvent | CollaborationFinishedEvent
) & { event_seq?: number }

export type AgentEventType = AgentEvent['event_type']
