import type { ToolAccess } from '@/protocol/events'

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
  /** show_image 历史恢复但图片数据不可用（如已被上下文压缩清理）。 */
  imageMissing?: boolean
}

export interface AssistantMessage { kind: 'assistant'; id: string; content: string; streaming: boolean }
export interface UserMessage { kind: 'user'; id: string; content: string }
export interface ReasoningBlock { kind: 'reasoning'; id: string; content: string; expanded: boolean }

export interface QuestionCard {
  kind: 'question'; callId: string; question: string
  options?: string[]; allowFreeText: boolean; answered: boolean; answer?: string
}

export interface NoticeItem { kind: 'notice'; id: string; tone: 'info' | 'warn' | 'error' | 'success'; text: string; detail?: string }

export type Timelineitem = UserMessage | AssistantMessage | ReasoningBlock | ToolCard | QuestionCard | NoticeItem

export type RunState = 'idle' | 'thinking' | 'executing' | 'awaiting_approval' | 'awaiting_question'

export interface LoopProgress {
  active: boolean; currentStep: number; totalSteps: number
  status: string; currentDescription?: string
}
