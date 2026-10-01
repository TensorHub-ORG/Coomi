/** 对话主列表的**唯一吸底入口**。
 *
 * 全应用只有这一个地方碰消息列表的滚动（MessageList 的滚动容器）：
 *   · 新消息（条目数变了）→ 用户还贴着底就 scrollToBottom()；
 *   · 内容增长（ResizeObserver 监听内容包装的高度）→ 用户还贴着底就 scrollToBottom()；
 *   · turn_end（streaming true → false）→ 用户还贴着底就 scrollToBottom()；
 *   · SCROLL_CHAT_BOTTOM_EVENT（「到最新」浮标 / End / 后台完成提醒）→ **强制**贴底
 *     （先恢复吸底再贴）。
 * 用户上翻（离底 > 80px）→ 解除吸底并上报给「到底」浮标（MessageNav 的 reportChatAtBottom）。
 * 不再有多拍贴底重试：滚动只看这三件事，一次 scrollTop 落定。 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { SCROLL_CHAT_BOTTOM_EVENT } from '../../lib/notify'
import { navPauseBusy } from '../shell/navPause'
import { reportChatAtBottom } from './MessageNav'

/** 离底超过这个像素就算「用户上翻」，解除吸底。 */
const BOTTOM_THRESHOLD = 80

export interface StickToBottomOptions {
  /** 滚动容器（MessageList 的 div；搜索 / 消息跳转共用同一个 ref）。 */
  scrollerRef: RefObject<HTMLElement | null>
  /** 内容包装元素（ResizeObserver 观察它：内容变高 = 增长）。 */
  contentRef: RefObject<HTMLElement | null>
  /** 历史没回读完之前不吸底（骨架阶段）。 */
  historyReady: boolean
  /** 搜索打开时不动滚动。 */
  searching: boolean
  /** 切会话时恢复吸底。 */
  sessionId: string
  /** 流式标记：turn_end（true→false）时贴一次底。 */
  streaming: boolean
  /** 消息条数：新消息（条数变了）时贴一次底。 */
  itemCount: number
}

export function useStickToBottom(options: StickToBottomOptions): void {
  const { scrollerRef, contentRef, historyReady, searching, sessionId, streaming, itemCount } = options
  /** 吸底是否还跟着走：用户上翻（离底 > 80px）就解除。 */
  const stick = useRef(true)
  const prevStreaming = useRef(streaming)

  /* 每一帧最多写一次 scrollTop（2026-09-28 流式卡顿）：
     以前每次内容增长都同步写一次 —— 而流式提交最坏是「每帧 8 次提交」（见 lib/guard），
     也就是同一帧里连做 8 次「读 scrollHeight → 写 scrollTop」，每次都强制一次布局。
     现在合并到 rAF：同一帧里的多次请求只落一次，读到的还是布局完成后的值。 */
  const scrollFrame = useRef(0)
  /** 唯一的滚动动作：瞬时贴到底。切页过渡那一拍让路（过渡结束会再触发一次）。 */
  const scrollToBottom = useCallback((): void => {
    if (navPauseBusy()) return
    if (scrollFrame.current) return
    const run = (): void => {
      scrollFrame.current = 0
      const el = scrollerRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    // 已经在 rAF 里（或正要跑）：本帧不再排第二次。
    scrollFrame.current = window.requestAnimationFrame(run)
  }, [scrollerRef])
  useEffect(() => () => { if (scrollFrame.current) window.cancelAnimationFrame(scrollFrame.current) }, [])

  /** 滚动事件：量「离底距离」，> 80px 解除吸底并上报浮标；滚回底部重新吸住。 */
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      const atBottom = distance <= BOTTOM_THRESHOLD
      stick.current = atBottom
      reportChatAtBottom(atBottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollerRef])

  /** 切会话（以及历史就绪的那一帧）：恢复默认「吸底」并复位浮标读数。 */
  useLayoutEffect(() => {
    stick.current = true
    reportChatAtBottom(true)
  }, [sessionId, historyReady])

  /** 新消息：条数变了 → 用户还贴着底就贴一次。 */
  useLayoutEffect(() => {
    if (!historyReady || searching) return
    if (!stick.current) return
    scrollToBottom()
  }, [itemCount, historyReady, searching, sessionId, scrollToBottom])

  /** 内容增长：ResizeObserver 观察内容包装（正文在长 / 折叠块开合 / 回读换内容都算）。 */
  useEffect(() => {
    const el = contentRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!historyReady || searching) return
      if (!stick.current) return
      scrollToBottom()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [contentRef, historyReady, searching, scrollToBottom])

  /** turn_end：流式翻转（true → false）→ 用户还贴着底就贴一次（不做多拍重试）。 */
  useEffect(() => {
    const was = prevStreaming.current
    prevStreaming.current = streaming
    if (!was || streaming) return
    if (!historyReady || searching) return
    if (!stick.current) return
    scrollToBottom()
  }, [streaming, historyReady, searching, scrollToBottom])

  /** 「到最新」浮标 / End 键 / 后台完成提醒（SCROLL_CHAT_BOTTOM_EVENT）：**强制**贴底 ——
      先恢复吸底（后面的增长继续贴着走），再贴。 */
  useEffect(() => {
    const onBackToBottom = (): void => {
      stick.current = true
      reportChatAtBottom(true)
      // 强制贴底要**立刻**落，不能等下一帧（用户按 End / 点「到最新」时要有即时反馈）。
      if (scrollFrame.current) { window.cancelAnimationFrame(scrollFrame.current); scrollFrame.current = 0 }
      const el = scrollerRef.current
      if (el && !navPauseBusy()) el.scrollTop = el.scrollHeight
    }
    window.addEventListener(SCROLL_CHAT_BOTTOM_EVENT, onBackToBottom)
    return () => window.removeEventListener(SCROLL_CHAT_BOTTOM_EVENT, onBackToBottom)
  }, [scrollerRef])
}
