import type { ToolAccess, UserQuestion } from '@/protocol/events'

export type ToolCardStatus = 'starting' | 'running' | 'success' | 'error' | 'awaiting_approval' | 'cache_hit' | 'cancelled'

export interface ToolCard {
  kind: 'tool'
  callId: string
  toolName: string
  arguments: Record<string, unknown>
  status: ToolCardStatus
  elapsed?: number
  resultPreview?: string
  isError?: boolean
  access?: ToolAccess
  riskSummary?: string
  expanded?: boolean
  /** 工具产生的图片（data URL），瀑布流渲染用。 */
  images?: string[]
  /** 执行中的实时输出流（shell/local_shell 增量回传），done 后清空并入 resultPreview。 */
  liveOutput?: string
  /** show_image 历史恢复但图片数据不可用（如已被上下文压缩清理）。 */
  imageMissing?: boolean
}

export interface AssistantMessage {
  kind: 'assistant'
  id: string
  mid: string
  content: string
  streaming: boolean
  life?: boolean
  /** 生命体主动消息的投递触发类型（morning/egg/milestone_stage/everyday），由 life_delivered 事件回填，气泡据此定制卡片渲染。 */
  lifeTrigger?: string
}
export interface UserMessage { kind: 'user'; id: string; mid: string; content: string }
export interface ReasoningBlock { kind: 'reasoning'; id: string; content: string; expanded: boolean }

export interface QuestionCard {
  kind: 'question'; callId: string; questions: UserQuestion[]
  answered: boolean; answers?: Record<string, string>
}

/** 回合反馈卡片携带的数据（v2 schema 的 web 侧部分，native 上传前会补齐环境/日志并终检脱敏）。 */
export interface FeedbackPayloadData {
  /** 反馈通道：工具失败 / 运行时错误 / 性能（停滞等）。 */
  channel: 'tool_failure' | 'runtime_error' | 'performance'
  /** 一行摘要（卡片标题）。 */
  summary: string
  /** 是否调用模型做溯源分析（有工具失败轨迹时才需要）。 */
  needsAnalysis: boolean
  /** 完整工具轨迹（仅密钥类值打码，保留真实路径/命令/参数）。 */
  toolTrace: ToolDiagnosticTrace[]
  /** 是否可附带最近对话（用户在设置中开启且时间线里有对话）。 */
  hasConversation: boolean
}

export interface NoticeItem {
  kind: 'notice'
  id: string
  tone: 'info' | 'warn' | 'error' | 'success'
  text: string
  detail?: string
  /** 非空表示这是一张反馈卡片，由 FeedbackCard.vue 渲染（统一布局）。 */
  feedback?: FeedbackPayloadData
  feedbackEligible?: boolean
  analysisStatus?: 'consent' | 'analyzing' | 'ready' | 'uploading' | 'complete' | 'failed'
  /** 溯源分析结论（needsAnalysis 完成后回填，卡片可展开查看）。 */
  analysisText?: string
  /** 上传结果独立提示（完成态展示，避免与卡片摘要重复）。 */
  statusNote?: string
  failureCount?: number
}

export interface ToolDiagnosticTrace {
  callId?: string
  sequence: number
  tool: string
  argumentShape: unknown
  status: 'running' | 'error' | 'success'
  category?: string
  errorSummary?: string
  elapsedMs?: number
}

export type Timelineitem = UserMessage | AssistantMessage | ReasoningBlock | ToolCard | QuestionCard | NoticeItem

export type RunState = 'idle' | 'syncing' | 'thinking' | 'executing' | 'awaiting_approval' | 'awaiting_question'

export interface LoopProgress {
  active: boolean; currentStep: number; totalSteps: number
  status: string; currentDescription?: string
}
