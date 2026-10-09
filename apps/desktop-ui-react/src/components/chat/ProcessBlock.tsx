import { useCallback, useEffect, useId, useRef, useState } from 'react'

/** 最近的、真的能滚的祖先（消息列表的滚动容器）。 */
function scrollableAncestor(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}
import { Brain, ChevronRight } from 'lucide-react'
import { m } from 'motion/react'
import { ToolCallList } from './ToolCallList'
import { Markdown } from './Markdown'
import { AgentState } from '../ai/AgentState'
import { COLLAPSE_FREEZE_MS, markCollapseMotion, toggleTransition, useSearchableHidden } from './collapseMotion'

import type { ProcessMember, ToolCall } from '../../lib/chat'
import type { MotionProps } from 'motion/react'

/** 没有入场信息时给空属性：ToolCallList 的 enter 是必填，这里就地兜住，
 *  不去改它的契约（那条契约对真正的工具列表仍然是对的）。 */
const EMPTY_ENTER = {} as MotionProps

export interface ProcessBlockProps {
  /** 思考链原文；没有思考时为空串。 */
  reasoning?: string
  /** 思考是否还在产出（决定图标与文案）。 */
  reasoningStreaming?: boolean
  /** 本条消息的工具调用（members 里的 callIds 从它取）。 */
  tools: ToolCall[]
  /** 过程成员：工具之间的叙述与工具组，**顺序即事件顺序**，渲染层不重排。 */
  members?: ProcessMember[]
  /** 这一轮还在跑：强制展开且不可折叠，与 DSH 的 liveProcess 同义。 */
  live?: boolean
  toolFresh: (callId: string) => boolean
  renderTool: (tool: ToolCall, fresh: boolean, defaultOpen: boolean) => React.ReactNode
  enter?: MotionProps
}

/**
 * 回合过程的折叠体（对标 DSH 的 Turn process）。
 *
 * 布局：**折叠头在最上，过程成员折在它下面，答案由调用方渲染在这一整块之后。**
 * 与旧实现的两个关键差别：
 *   ① 旧版把这一块挂在正文**下方**，与注释里写的「思考 → 正文 → 工具」正好相反；
 *      现在过程整体前置，答案独立在后且永不参与折叠 —— 生成中途从「纯思考」变成
 *      「思考 + 正文」时，位置不再翻转。
 *   ② 旧版只展示「已思考」与「使用工具」两级子折叠，用了工具的轮次走的是另一个分支，
 *      思考直接不显示。现在思考与工具是**同一个过程体里的有序成员**，一个都不会丢。
 *
 * 开合：跑的时候强制展开（免得用户以为卡住），定下来后自动折叠；折叠动画走 .collapse
 * 的 grid 过渡，动画播完再把隐藏交给 hidden="until-found"，让 Ctrl+F 仍能命中折叠内容。
 */
export function ProcessBlock({
  reasoning, reasoningStreaming, tools, members, live, toolFresh, renderTool, enter,
}: ProcessBlockProps): React.ReactNode {
  const [open, setOpen] = useState(false)
  const panelId = useId()

  const text = reasoning ?? ''
  const steps = text ? text.split(/\n{2,}/).filter(Boolean).length : 0
  const inFlight = tools.filter((t) => t.status === 'running' || t.status === 'queued').length
  const done = tools.filter((t) => t.status === 'done').length
  const failed = tools.filter((t) => t.status === 'error' || t.status === 'denied').length
  const list = members ?? []

  /// 这一轮还在跑（思考在产出 / 有工具在跑 / 调用方说还活着）：强制展开且不可折叠。
  const running = !!live || !!reasoningStreaming || inFlight > 0
  const shown = running || open
  const hasContent = !!text || tools.length > 0
  const canCollapse = hasContent && !running

  /* 收起并且**动画播完**之后，才把隐藏交给 hidden="until-found"。
     不能一收起就挂：until-found 是 content-visibility: hidden，会当场吃掉那 200ms 的收放，
     折叠变成「啪」地消失。所以先让 .collapse 把动画走完，再交棒。 */
  const [settledClosed, setSettledClosed] = useState(false)
  useEffect(() => {
    if (shown) { setSettledClosed(false); return }
    const timer = window.setTimeout(() => setSettledClosed(true), COLLAPSE_FREEZE_MS)
    return () => window.clearTimeout(timer)
  }, [shown])
  const reveal = useCallback(() => setOpen(true), [])
  const bodyRef = useSearchableHidden(settledClosed, reveal)
  const headerRef = useRef<HTMLButtonElement | null>(null)
  const reasoningRef = useRef<HTMLDivElement | null>(null)
  const followReasoning = useRef(true)
  useEffect(() => {
    if (!shown || !followReasoning.current) return
    const frame = requestAnimationFrame(() => {
      const node = reasoningRef.current
      if (node) node.scrollTop = node.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [text, shown])

  if (!hasContent) return null

  /* 开合时**以折叠头为锚**：先量头的视口位置，布局提交后把差值补回 scrollTop，
     头部在屏幕上就不动 —— 内容只能向下长，不会「向上展开」。
     只靠 useStickToBottom 让路还不够：用户本来贴着底时，容器仍会因为总高度变化
     把视口往上带；这一补是最后一道校正。两帧各校一次：grid 过渡起步那一拍也会挪。 */
  const toggle = (): void => {
    if (!canCollapse) return
    markCollapseMotion()
    const el = headerRef.current
    const before = el ? el.getBoundingClientRect().top : 0
    setOpen((v) => !v)
    if (!el) return
    const restore = (): void => {
      const delta = el.getBoundingClientRect().top - before
      if (Math.abs(delta) < 0.5) return
      const scroller = scrollableAncestor(el)
      if (scroller) scroller.scrollTop += delta
    }
    window.requestAnimationFrame(() => { restore(); window.requestAnimationFrame(restore) })
  }

  return (
    <div className='mb-2'>
      <button
        ref={headerRef}
        type='button'
        onClick={toggle}
        disabled={!canCollapse}
        aria-expanded={hasContent ? shown : undefined}
        aria-controls={panelId}
        className='flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-12 text-ink-3 transition-colors hover:text-ink-2 disabled:cursor-default disabled:hover:text-ink-3'
      >
        {running ? <AgentState state='reasoning' size='xs' tone='primary' /> : <Brain size={12} />}
        <span>
          {steps > 0 ? '已思考 · ' + steps + ' 段' : '已思考'}
          {tools.length > 0 ? ' · 使用工具 ' + tools.length + ' 次' : ''}
          {inFlight > 0 ? '（进行中 ' + inFlight + '）' : ''}
          {!running && done > 0 ? ' · 成功 ' + done : ''}
          {!running && failed > 0 ? ' · 失败 ' + failed : ''}
        </span>
        {canCollapse ? (
          <m.span className='inline-flex shrink-0' initial={false} animate={{ rotate: shown ? 90 : 0 }} transition={toggleTransition()}>
            <ChevronRight size={12} />
          </m.span>
        ) : null}
      </button>

      {/* 过程体：思考 + 有序成员（叙述 / 工具组）。整体折在这一层里，答案在它之后。 */}
      <div
        className='collapse'
        id={panelId}
        data-open={shown}
        data-until-found={settledClosed ? '1' : undefined}
      >
        <div>
          <div ref={bodyRef} className='mt-1.5 border-l border-line pl-2.5'>
            {text ? (
              <div
                ref={reasoningRef}
                onScroll={(event) => {
                  const node = event.currentTarget
                  followReasoning.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32
                }}
                className='max-h-[40vh] overflow-y-auto text-13 leading-[1.7] whitespace-pre-wrap break-words text-ink-3'
                style={{ maxHeight: 'min(40vh, 320px)' }}
              >
                {text}
              </div>
            ) : null}
            {list.map((member, index) => {
              if (member.kind === 'text') {
                if (!member.text.trim()) return null
                return (
                  <div key={'m' + index} className='mt-2 min-w-0 max-w-[var(--reading-w)] text-ink-3'>
                    {/* 流式期间按仓库既有策略走纯文本（见 check-stream-plain）：
                        定下来之后再交给 Markdown，叙述段的格式不会丢。 */}
                    {running ? (
                      <div className='text-13 leading-[1.7] whitespace-pre-wrap break-words'>{member.text}</div>
                    ) : (
                      <div className='text-13 opacity-90'>
                        <Markdown text={member.text} streaming={false} />
                      </div>
                    )}
                  </div>
                )
              }
              const group = member.callIds
                .map((id) => tools.find((t) => t.callId === id))
                .filter((t): t is ToolCall => !!t)
              if (!group.length) return null
              return (
                <div key={'m' + index} className='mt-1.5 min-w-0'>
                  <ToolCallList
                    tools={group}
                    toolFresh={toolFresh}
                    renderTool={renderTool}
                    onToggle={markCollapseMotion}
                    enter={enter ?? EMPTY_ENTER}
                    spring={toggleTransition()}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
