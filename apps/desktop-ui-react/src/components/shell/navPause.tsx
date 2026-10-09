/**
 * 切页过渡窗口的「让路」闸门 + 页面 pane 的前后台判据（外壳级基建）。
 *
 * 为什么需要它：换页那一拍（进场动画 240ms + 正文挂载，共约 320ms）主线程要干三件事 ——
 * 播新旧两页的动画、卸载旧页、挂目标页正文。
 * 这段时间里再跑「引擎事件驱动的重算、观测器回调、轮询、量尺寸」，等于跟过渡抢同一拍，
 * 表现出来就是切页掉帧。所以全站只用这一个开关表达「过渡正在跑」：
 *
 *   · markNavPause()             App 切页时开闸，NAV_PAUSE_MS 后自动收闸（连点只把窗口撑到
 *                               NAV_PAUSE_MAX_MS 上限，不会无限往后推）；
 *   · navPauseBusy()             同步判据。CSS 读的是同一个属性 html[data-nav-busy]
 *                                （base.css 里停内容列循环动效那一段），JS 与 CSS 不会各判一套；
 *   · queueDuringNavPause(k,fn)  闸门开着时排队，收闸时**合并成一次**执行（同 key 只留最后一次）：
 *                                统计/用量这类「过渡结束再刷一次就够」的重算走这里，
 *                                不是每次都往主线程塞一遍；
 *   · subscribeNavPause(cb)      闸门开合的通知（观测器/轮询据此挂起与恢复）；
 *   · useNavPause()              React 侧读闸门；
 *   · usePaneActive()            页面 pane 是否在前台：ViewSlot 通过 PaneActiveProvider 注入，
 *                                隐藏的那一页（只保留「当前 + 上一次」里的「上一次」）据此
 *                                停掉自己的定时器/观测器，而不是躲在 opacity:0 背后继续空转。
 *
 * 时长口径：进场动画 240ms（PANE_ENTER_MS）之后还有一拍 rAF + 一次 startTransition
 * 才把正文挂上，所以闸门取 PANE_ENTER_MS + 80ms（＝320ms）：正文挂载落在闸门之内，
 * 收闸即「一次 flush」，不早不晚。
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'

/** 新页进场动画时长（毫秒）：--pane-in 的同一个数，App 用它排时间轴。 */
export const PANE_ENTER_MS = 240
/** 旧页退场动画时长（毫秒）：比进场短，压住新旧两页叠在一起的重影。 */
export const PANE_EXIT_MS = 140
/** 让路窗口（毫秒）：进场动画 + 挂正文那一拍的余量。 */
export const NAV_PAUSE_MS = PANE_ENTER_MS + 80
/** 让路窗口硬上限（毫秒）：两倍窗口 ≈ 640ms。
    为什么需要上限：开闸窗口里全站（CSS 循环动效 + JS 轮询/测量）都在为过渡让路，
    连点若把窗口无限往后推，「全身让路」就会一直叠加——点 N 下 = N×320ms。 */
export const NAV_PAUSE_MAX_MS = NAV_PAUSE_MS * 2

/** 与 CSS 约定的属性名：html[data-nav-busy='1']。 */
const BUSY_ATTR = 'navBusy'

let timer: number | null = null
/** 计划中的收闸时间点（Date.now() 口径）：连点取「剩余时间」要靠它——setTimeout 不暴露剩余时长。 */
let deadline = 0
/** 过渡期间排队的收尾动作：key 相同只留最后一次。 */
const queued = new Map<string, () => void>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const cb of [...listeners]) {
    try { cb() } catch { /* 订阅方自己的异常不扩散到别的订阅方 */ }
  }
}

/** 同步判据：闸门开着 = 过渡正在跑。CSS 读同一个属性，两边口径永远一致。 */
export function navPauseBusy(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset[BUSY_ATTR] === '1'
}

/** 开闸。连点不再把窗口无限往后推：已在忙时取「剩余时间与新时长」的较大值，
    并封顶在 NAV_PAUSE_MAX_MS（最后那次过渡说了算 → 连点只把窗口撑到上限）。 */
export function markNavPause(ms: number = NAV_PAUSE_MS): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const wasBusy = root.dataset[BUSY_ATTR] === '1'
  // 同值不重写：dataset 的同值赋值同样走 setAttribute → 属性值没变也触发一次样式失效重算；
  // 连点高频下这就是白付的开销（[data-loop-anim] 收敛后代价变小，也不该每次点都付）。
  if (!wasBusy) root.dataset[BUSY_ATTR] = '1'
  if (timer !== null) {
    // 连点：窗口取「当前剩余」与「新时长」的较大值，而不是把窗口整体往后推
    //（否则点 N 下窗口就是 N×320ms，「全身让路」一直叠加）。
    const remaining = Math.max(0, deadline - Date.now())
    ms = Math.max(ms, remaining)
  }
  // 硬上限：连点只把窗口撑到两倍（约 640ms），之后每次点击都维持这个封顶值，不再变长。
  ms = Math.min(ms, NAV_PAUSE_MAX_MS)
  if (timer !== null) window.clearTimeout(timer)
  deadline = Date.now() + ms
  timer = window.setTimeout(() => { endNavPause() }, ms)
  if (!wasBusy) emit()
}

/** 收闸：属性收回、通知订阅方，然后把排队的东西合并成一次放出来。 */
export function endNavPause(): void {
  if (timer !== null) { window.clearTimeout(timer); timer = null }
  deadline = 0
  if (typeof document !== 'undefined') delete document.documentElement.dataset[BUSY_ATTR]
  emit()
  flushQueued()
}

/** 排队中的收尾动作一次性执行；单个抛错不影响其它（收闸这一拍不该被谁拖住）。 */
function flushQueued(): void {
  if (!queued.size) return
  const batch = [...queued.values()]
  queued.clear()
  for (const run of batch) {
    try { run() } catch { /* 忽略：单个收尾动作失败不该连累别的 */ }
  }
}

/** 过渡期间排队、收闸时合并执行；闸门没开就直接跑（不引入额外一帧延迟）。 */
export function queueDuringNavPause(key: string, run: () => void): void {
  if (!navPauseBusy()) { run(); return }
  queued.set(key, run)
}

/** 订阅闸门开合，返回退订函数。 */
export function subscribeNavPause(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** React 侧读闸门：过渡期间 true，收闸后自动变回 false。 */
export function useNavPause(): boolean {
  return useSyncExternalStore(subscribeNavPause, navPauseBusy, () => false)
}

/* ── 页面 pane 的前后台 ──
   隐藏页（「上一次」那一页）不卸载是为了保住滚动位置与已渲染内容，但它不该继续干活：
   量尺寸、轮询、观察器一律停。判据由 ViewSlot 注入，页面里只需要 usePaneActive()。
   默认 true：外壳部件（导航条、侧栏）不在任何 pane 里，不该被当成隐藏。 */
const PaneActive = createContext(true)

export function PaneActiveProvider({ active, children }: { active: boolean; children: ReactNode }) {
  return <PaneActive.Provider value={active}>{children}</PaneActive.Provider>
}

/** 当前组件所在的页面 pane 是否在前台。 */
export function usePaneActive(): boolean {
  return useContext(PaneActive)
}
