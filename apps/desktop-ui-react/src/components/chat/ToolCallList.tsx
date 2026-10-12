import type { ReactNode } from 'react'
import type { MotionProps, Transition } from 'motion/react'
import type { ToolCall } from '../../lib/chat'

export interface ToolCallListProps {
  tools: ToolCall[]
  /** 整条消息是否还在流式：标准模式下流式期间强制展开。 */
  streaming: boolean
  /** 某一个工具行是不是这次才出现（复用消息列表的 seen 判定，旧工具行不重播入场）。 */
  toolFresh: (callId: string) => boolean
  /** 渲染单个工具行：注入现有 ToolRow。defaultOpen 用于「失败项默认展开」。 */
  renderTool: (tool: ToolCall, fresh: boolean, defaultOpen: boolean) => ReactNode
  /** 折叠动画窗口标记（点开合前调用）：注入 MessageList 的 markCollapseMotion。 */
  onToggle: () => void
  /** 摘要行入场属性：注入 enterProps(...)，与其它条目同一来源。 */
  enter: MotionProps
  /** 箭头旋转用的 spring：注入 toggleTransition()。 */
  spring: Transition
}

export function ToolCallList({ tools, toolFresh, renderTool }: ToolCallListProps) {
  if (!tools.length) return null
  return <div data-tool-group className='min-w-0'>
    {tools.map(tool => renderTool(tool, toolFresh(tool.callId), tool.status === 'error' || tool.status === 'denied'))}
  </div>
}
