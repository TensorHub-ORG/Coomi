import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { Transition } from 'motion/react'

/** 折叠窗口（ms）：= --motion-base(200) + 一拍余量，与 base.css 那段同口径。 */
export const COLLAPSE_FREEZE_MS = 220

const SPRING_SNAP: Transition = { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 }

let collapseFreezeTimer: number | null = null

/** 折叠块被点开/收起时调一次：把折叠动画窗口挂上 220ms。
 *  窗口里 CSS 把折叠块换成固定高度占位（高度一次落定、只给透明度）；
 *  折叠后内容高度变了，吸底由 useStickToBottom 的 ResizeObserver 收口。
 *  从 MessageList 原样搬出，供 ProcessBlock 复用——两份实现各写一套会让
 *  「折叠窗口」的时长与去抖行为分叉。 */
export function markCollapseMotion(): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.msgCollapse = '1'
  if (collapseFreezeTimer !== null) window.clearTimeout(collapseFreezeTimer)
  collapseFreezeTimer = window.setTimeout(() => {
    collapseFreezeTimer = null
    delete document.documentElement.dataset.msgCollapse
  }, COLLAPSE_FREEZE_MS)
}

/** 关动效 / 系统「减少动态效果」时给 0 —— 与 CSS 那套令牌归零同一件事。 */
export function motionOn(): boolean {
  if (typeof window === 'undefined') return true
  const root = document.documentElement
  if (root.dataset.motion === 'off') return false
  if (root.dataset.perf === 'low') return false
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 可交互元素的动效一律走 spring，不写固定 ms：连点开合从当前速度接着走，不会「卡一下再重来」。 */
export function toggleTransition(): Transition {
  return motionOn() ? SPRING_SNAP : { duration: 0 }
}
/** 折叠内容的隐藏方式（照搬 DSH）：hidden="until-found"（content-visibility: hidden），
 *  **不是** display:none、也不卸载。
 *
 *  换来的能力：折叠起来的内容仍然能被浏览器 Ctrl+F 命中 —— 命中时浏览器派发 beforematch，
 *  这里就地展开。用户不会遇到「明明搜得到、屏幕上却没有」那种假阴性。
 *  焦点若正落在被折叠的子树里也立刻展开：折叠把焦点吞掉会让键盘用户直接迷路。
 *
 *  为什么不能直接写 CSS content-visibility：until-found 是**属性**语义，
 *  浏览器只对 hidden="until-found" 派发 beforematch。 */
export function useSearchableHidden(
  hidden: boolean,
  reveal: () => void,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)
  /// reveal 存进 ref：调用方几乎总会传一个新的箭头函数，挂进依赖会让两段 effect 每次都重跑。
  const revealRef = useRef(reveal)
  revealRef.current = reveal

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    /// 焦点在被折叠的子树里：先展开，别把焦点藏起来。
    if (hidden && el.contains(el.ownerDocument.activeElement)) {
      revealRef.current()
      return
    }
    if (hidden) el.setAttribute('hidden', 'until-found')
    else el.removeAttribute('hidden')
  }, [hidden])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onBeforeMatch = (): void => revealRef.current()
    el.addEventListener('beforematch', onBeforeMatch)
    return () => el.removeEventListener('beforematch', onBeforeMatch)
  }, [])

  return ref
}
