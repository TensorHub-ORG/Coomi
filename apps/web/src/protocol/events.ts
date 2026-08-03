export type ToolAccess = 'read_only' | 'write' | 'destructive'

export interface UsageInfo {
  input_tokens: number; output_tokens: number; total_tokens: number
  context_ratio?: number
  context_used_tokens?: number
  context_window_tokens?: number
}

export interface TextChunkEvent { event_type: 'text_chunk'; content: string }
export interface ReasoningChunkEvent { event_type: 'reasoning_chunk'; content: string }
export interface ToolStartEvent { event_type: 'tool_start'; call_id: string; tool_name: string; arguments: Record<string, unknown> }
export interface ToolRunningEvent { event_type: 'tool_running'; call_id: string; tool_name: string }
export interface ToolDoneEvent { event_type: 'tool_done'; call_id: string; tool_name: string; elapsed: number; result_preview: string; is_error: boolean; images?: string[] }
export interface ToolCacheHitEvent { event_type: 'tool_cache_hit'; call_id: string; tool_name: string }
export interface UsageUpdateEvent { event_type: 'usage_update'; usage: UsageInfo }
export interface ConnectionRetryEvent { event_type: 'connection_retry'; attempt: number; max_attempts: number; delay: number; message: string }
export interface CompressionEvent { event_type: 'compression'; before: number; after: number }
export interface AgentErrorEvent { event_type: 'agent_error'; message: string; is_fatal: boolean }
export interface AgentCancelledEvent { event_type: 'agent_cancelled' }
export interface BgTaskDetachedEvent { event_type: 'bg_task_detached'; task_id: string; tool_name: string }
export interface BgTaskCompletedEvent { event_type: 'bg_task_completed'; task_id: string; tool_name: string; is_error: boolean }
export interface LoopStepStartEvent { event_type: 'loop_step_start'; step_index: number; step_description: string; total_steps: number }
export interface LoopStepDoneEvent { event_type: 'loop_step_done'; step_index: number; success: boolean }
export interface LoopProgressEvent { event_type: 'loop_progress'; current_step: number; total_steps: number; status: string }
export interface LoopIssueCreatedEvent { event_type: 'loop_issue_created'; step_index: number; step_description: string }
export interface ToolApprovalRequestEvent { event_type: 'tool_approval_request'; call_id: string; tool_name: string; arguments: Record<string, unknown>; access: ToolAccess; risk_summary?: string; }
export interface UserQuestionRequestEvent { event_type: 'user_question_request'; call_id: string; question: string; options?: string[]; allow_free_text?: boolean }
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

export type AgentEvent =
  | TextChunkEvent | ReasoningChunkEvent | ToolStartEvent | ToolRunningEvent
  | ToolDoneEvent | ToolCacheHitEvent | UsageUpdateEvent | ConnectionRetryEvent
  | CompressionEvent | AgentErrorEvent | AgentCancelledEvent | BgTaskDetachedEvent
  | BgTaskCompletedEvent | LoopStepStartEvent | LoopStepDoneEvent | LoopProgressEvent
  | LoopIssueCreatedEvent | ToolApprovalRequestEvent | UserQuestionRequestEvent
  | FileTransferRequestEvent
  | TurnEndEvent
  | SessionStateEvent
  | SessionLoadedEvent

export type AgentEventType = AgentEvent['event_type']
