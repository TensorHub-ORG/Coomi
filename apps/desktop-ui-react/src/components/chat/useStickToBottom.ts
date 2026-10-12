/** 对话主列表的**唯一吸底入口**。
 *
 * 全应用只有这一个地方碰消息列表的滚动（MessageList 的滚动容器）：
 *   · 新消息（条目数变了）→ 用户还贴着底就 scrollToBottom()；
 *   · 内容增长（ResizeObserver 监听内容包装的高度）→ 用户还贴着底就 scrollToBottom()；
 *   · turn_end（streaming true → false）→ 用户还贴着底就 scrollToBottom()；
 *   · SCROLL_CHAT_BOTTOM_EVENT（「到最新」浮标 / End / 后台完成提醒）→ **强制**贴底
 *     （先恢复吸底再贴）。
 * 用户主动上翻 → 解除吸底并上报给「到底」浮标（MessageNav 的 reportChatAtBottom）。
 * 不再有多拍贴底重试：滚动只看这三件事，一次 scrollTop 落定。 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { SCROLL_CHAT_BOTTOM_EVENT } from '../../lib/notify'
import { navPauseBusy, queueDuringNavPause } from '../shell/navPause'
import { reportChatAtBottom } from './MessageNav'

/** 距离底部的几何读数；解除吸底只由真实用户滚动手势决定。 */
const BOTTOM_THRESHOLD = 4

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
  /** 吸底是否还跟着走：用户主动滚动离开底部就解除。 */
  const stick = useRef(true)
  const userMoved = useRef(false)
  const prevStreaming = useRef(streaming)

  /* 每一帧最多写一次 scrollTop（2026-09-28 流式卡顿）：
     以前每次内容增长都同步写一次 —— 而流式提交最坏是「每帧 8 次提交」（见 lib/guard），
     也就是同一帧里连做 8 次「读 scrollHeight → 写 scrollTop」，每次都强制一次布局。
     现在合并到 rAF：同一帧里的多次请求只落一次，读到的还是布局完成后的值。 */
  const scrollFrame = useRef(0)
  /** 这一帧真正执行的滚动动作。切页过渡期间可能暂时不能写布局，
      但不能把「发送后回到底」丢掉：收闸后由 queueDuringNavPause 补执行。 */
  const runScrollToBottom = useCallback((): void => {
    if (scrollFrame.current) return
    const run = (): void => {
      scrollFrame.current = 0
      const el = scrollerRef.current
      if (el && stick.current) { el.scrollTop = el.scrollHeight; reportChatAtBottom(true) }
    }
    // 已经在 rAF 里（或正要跑）：本帧不再排第二次。
    scrollFrame.current = window.requestAnimationFrame(run)
  }, [scrollerRef])
  /** 唯一的滚动入口：过渡期间合并请求，过渡结束只执行一次。 */
  const scrollToBottom = useCallback((): void => {
    if (navPauseBusy()) {
      queueDuringNavPause('chat-scroll-bottom', runScrollToBottom)
      return
    }
    runScrollToBottom()
  }, [runScrollToBottom])
  useEffect(() => () => { if (scrollFrame.current) window.cancelAnimationFrame(scrollFrame.current) }, [])

  /** 滚动事件：真实用户手势离开底部时暂停跟随；手动滚回底部时恢复。 */
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      const atBottom = distance <= BOTTOM_THRESHOLD
      // Layout, streaming and browser anchoring also dispatch scroll events.
      // Only a deliberate user gesture may detach automatic following.
      if (atBottom) {
        stick.current = true
        userMoved.current = false
      } else if (userMoved.current) {
        stick.current = false
        userMoved.current = false
      }
      // In follow mode, transient layout growth may emit a scroll event before the
      // ResizeObserver brings the list down. Keep the affordance steady through it.
      reportChatAtBottom(stick.current ? true : atBottom)
    }
    const detach = (): void => {
      stick.current = false
      userMoved.current = true
      if (scrollFrame.current) { cancelAnimationFrame(scrollFrame.current); scrollFrame.current = 0 }
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      reportChatAtBottom(distance <= BOTTOM_THRESHOLD)
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || !event.deltaY) return
      const target = event.target instanceof Element ? event.target : null
      // Scrolling a tool log or reasoning panel should not detach the chat.
      for (let node = target; node && node !== el; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
          const canMove = event.deltaY < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1
          if (canMove) return
        }
      }
      if (event.deltaY < 0 || el.scrollHeight - el.scrollTop - el.clientHeight > 2) detach()
    }
    const onKey = (event: KeyboardEvent): void => {
      if ((event.target as HTMLElement)?.closest('input,textarea,[contenteditable=true]')) return
      if (['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', ' '].includes(event.key)) detach()
    }
    const onPointer = (event: PointerEvent): void => {
      // A scrollbar drag does not emit a wheel/touch signal. Only treat the
      // narrow native scrollbar strip as a user scroll gesture; clicking the
      // message canvas must not unexpectedly stop following.
      if (event.target !== el) return
      const rect = el.getBoundingClientRect()
      if (event.clientX >= rect.right - 24) detach()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchmove', detach, { passive: true })
    el.addEventListener('keydown', onKey)
    el.addEventListener('pointerdown', onPointer)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', detach)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('pointerdown', onPointer)
    }
  }, [scrollerRef])

  /** 切会话（以及历史就绪的那一帧）：恢复默认「吸底」并复位浮标读数。 */
  useLayoutEffect(() => {
    stick.current = true
    userMoved.current = false
    reportChatAtBottom(true)
  }, [sessionId, historyReady])

  /** 新消息：条数变了 → 用户还贴着底就贴一次。 */
  useLayoutEffect(() => {
    if (!historyReady || searching) return
    if (!stick.current) return
    // This effect runs after React commits a newly sent row. A scroll request made
    // synchronously by send() can only see the previous DOM height, so settle the
    // final position here in the same commit before the browser paints it.
    if (scrollFrame.current) { window.cancelAnimationFrame(scrollFrame.current); scrollFrame.current = 0 }
    const el = scrollerRef.current
    if (el) { el.scrollTop = el.scrollHeight; reportChatAtBottom(true) }
  }, [itemCount, historyReady, searching, sessionId, scrollerRef])

  /** 内容增长：ResizeObserver 观察内容包装（正文在长 / 折叠块开合 / 回读换内容都算）。
   *
   *  **折叠窗口内不吸附**（html[data-msg-collapse]，由 markCollapseMotion 挂 220ms）。
   *  为什么必须让路：折叠体在答案**上方**，用户点开时内容在头部下面长高；
   *  如果这时还钉在底部，增长的空间只能从上方「借」—— 头部被顶上去，
   *  看起来就是「点展开，它向上展开」。手动开合期间位置由折叠头自己锚定
   *  （见 ProcessBlock 的补偿），这里必须收手。 */
  useEffect(() => {
    const el = contentRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!historyReady || searching) return
      if (document.documentElement.dataset.msgCollapse === '1') return
      if (!stick.current) return
      scrollToBottom()
    })
    observer.observe(el)
    if (scrollerRef.current) observer.observe(scrollerRef.current)
    return () => observer.disconnect()
  }, [contentRef, scrollerRef, historyReady, searching, scrollToBottom])

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
      userMoved.current = false
      reportChatAtBottom(true)
      // 强制贴底要**立刻**落，不能等下一帧（用户按 End / 点「到最新」时要有即时反馈）。
      if (scrollFrame.current) { window.cancelAnimationFrame(scrollFrame.current); scrollFrame.current = 0 }
      const el = scrollerRef.current
      if (el && !navPauseBusy()) el.scrollTop = el.scrollHeight
      // Sending updates the store before React commits the new message.
      // The next frame covers that commit, subsequent growth uses the observer.
      scrollToBottom()
    }
    window.addEventListener(SCROLL_CHAT_BOTTOM_EVENT, onBackToBottom)
    return () => window.removeEventListener(SCROLL_CHAT_BOTTOM_EVENT, onBackToBottom)
  }, [scrollerRef, scrollToBottom])
}
