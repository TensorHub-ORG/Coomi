import { useId, useState, type ReactNode } from 'react'
import { ChevronRight, Wrench, LoaderCircle, CircleCheck } from 'lucide-react'
import { m, type MotionProps, type Transition } from 'motion/react'
import { cn } from '../../lib/cn'
import type { ToolCall } from '../../lib/chat'
import { useUi } from '../../stores/ui'
import { toolDisclosure } from '../../lib/toolDisclosure'

/* ── 一轮工具调用的折叠列表 ──
 *
 * 改造前 `item.tools.map(...)` 是平铺的：一轮调 6 个工具就是 6 张卡，屏幕全被工具占满，
 * 正文反而要往上翻。这里把**同一组**工具收成一行摘要，按需展开。
 *
 * 两种展示密度：
 *  ① 极简模式：所有调用默认收为摘要，运行状态持续可见，错误默认展开，用户可手动开合。
 *  ② 标准模式：流式 / 运行中强制展开，小于等于三个工具平铺，更多工具结束后折叠。
 *  ③ 工具行本身**不在这里重画**：由调用方通过 renderTool 注入现有 ToolRow ——
 *     `ToolMark`（状态点）、`toolTarget`（目标）以及「展开看参数与结果」都留在 ToolRow 里，
 *     这里只负责摘要与折叠，避免同一套行渲染存在两份、日后改一处漏一处。
 *
 * 动效完全复用 MessageList 那一套（onToggle = markCollapseMotion、enter = enterProps、
 * spring = toggleTransition），不引入第二套机制。 */

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

/** 失败判定：被拒（denied）与出错一样，都属于「不该被折叠藏起来」的一项。 */
function isFailure(tool: ToolCall): boolean {
  return tool.status === 'error' || tool.status === 'denied'
}

export function ToolCallList({ tools, streaming, toolFresh, renderTool, onToggle, enter, spring }: ToolCallListProps) {
  const minimal = useUi((s) => s.prefs.minimalUi)
  /// 用户显式开合过没有：null = 还没点过，按自动规则来；点过之后以用户为准。
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  /// aria-controls 指向折叠面板：给读屏一个明确的「这个按钮管哪一块」。
  const panelId = useId()

  if (!tools.length) return null

  const { active, failed, canFold, showHeader, open } = toolDisclosure(tools, streaming, minimal, userOpen)

  const done = tools.filter((t) => t.status === 'done').length
  /// 用时：有 elapsedMs 的求和（没有更好的口径）；一个都没有时整项不显示。
  const elapsed = tools.reduce((sum, t) => sum + (t.elapsedMs ?? 0), 0)

  const toggle = (): void => {
    if (!canFold) return
    /// 先落折叠动画窗口标记，再改状态：与 ToolRow / Reasoning 的开合同一个顺序。
    onToggle()
    setUserOpen(!open)
  }

  const summary = minimal ? (
    <>
      <Wrench size={13} className='shrink-0' />
      <span className='min-w-0 truncate'>{tools.length === 1 ? tools[0].name : `${tools.length} 项工具调用`}</span>
      <span className='tool-summary-state'>
        {active ? <><LoaderCircle size={12} className='animate-spin' />正在执行 {done}/{tools.length}</>
          : failed ? `${failed} 项失败` : <><CircleCheck size={12} />已完成</>}
      </span>
      {!active && elapsed > 0 ? <span className='shrink-0 text-ink-3'>{(elapsed / 1000).toFixed(1)}s</span> : null}
    </>
  ) : (
    <>
      <span className='shrink-0'>调用了 {tools.length} 个工具</span>
      <span aria-hidden className='shrink-0 text-ink-4'>·</span>
      <span className='shrink-0'>成功 {done}</span>
      {failed ? (
        <>
          <span aria-hidden className='shrink-0 text-ink-4'>·</span>
          {/* 失败数用语义红标出来：扫一眼就知道这一轮有没有砸。 */}
          <span className='shrink-0 text-tool-error'>失败 {failed}</span>
        </>
      ) : null}
      {elapsed > 0 ? (
        <>
          <span aria-hidden className='shrink-0 text-ink-4'>·</span>
          <span className='shrink-0 text-ink-4'>用时 {elapsed}ms</span>
        </>
      ) : null}
    </>
  )

  const headerClass = minimal ? 'tool-summary' : 'flex w-full items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-0.5 text-12 text-ink-3'

  /// 能折时是按钮（键盘原生可触发 + aria-expanded）；强制展开期间是普通 div ——
  /// 一个点不动的按钮比「没有按钮」更让人困惑。
  const header = canFold ? (
    <button
      type='button'
      aria-expanded={open}
      aria-controls={panelId}
      onClick={toggle}
      className={cn(headerClass, 'text-left transition-colors duration-[var(--motion-hover)] ease-[var(--ease-spring)] hover:bg-hover hover:text-ink-2')}
    >
      {/* 箭头旋转走 spring：连点开合从当前角度接着转，不从头补时间（与 ToolRow 一致）。 */}
      <m.span className='inline-flex shrink-0' initial={false} animate={{ rotate: open ? 90 : 0 }} transition={spring}>
        <ChevronRight size={12} />
      </m.span>
      {summary}
    </button>
  ) : (
    <div className={headerClass}>
      <m.span className='inline-flex shrink-0' initial={false} animate={{ rotate: 90 }} transition={spring}>
        <ChevronRight size={12} />
      </m.span>
      {summary}
    </div>
  )

  return (
    <div className='my-0.5' data-tool-group data-minimal={minimal} data-status={failed ? 'error' : active ? 'running' : 'done'}>
      {/* 入场只给摘要行：工具行各自的入场仍在 ToolRow 里，套两层会叠出 12px 的位移。 */}
      {showHeader ? <m.div {...enter}>{header}</m.div> : null}
      {/* 折叠统一走 .collapse + data-open：与 Reasoning / ToolRow 同一套高度与透明度收放。 */}
      <div id={panelId} className='collapse' data-open={open} inert={!open}>
        <div>
          <div className='flex flex-col'>
            {tools.map((tool) => renderTool(tool, toolFresh(tool.callId), isFailure(tool)))}
          </div>
        </div>
      </div>
    </div>
  )
}
