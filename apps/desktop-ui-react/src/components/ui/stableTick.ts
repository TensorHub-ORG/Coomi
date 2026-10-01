/** React 侧的节拍器：定时器只在「值真的变了」时才提交，且同一时刻只有一条在途。
 *  纯判据与调度核心（commitIfChanged / createValueTicker / 提交计数）在 lib/stableState.ts，
 *  那边零依赖、可被 node 断言直接跑 —— 这里只是它的一层 React 外壳。 */
import { useEffect, useRef, useState } from 'react'
import { createValueTicker, type TickClock } from '../../lib/stableState'

/** 浏览器时钟：壳里的定时器只有这一处出口（组件不许自己写 setInterval 走字）。 */
const WINDOW_CLOCK: TickClock = {
  setTimer: (fn, ms) => window.setInterval(fn, ms),
  clearTimer: (handle) => window.clearInterval(handle as number),
}

/**
 * 每 ms 毫秒读一次 read()，**只在读出来的值真的变了**时才 setState。
 *
 *  三条硬规矩：
 *    · enabled=false 时一条调度都不建（静止的界面不该有定时器）；
 *    · 同一时刻只有一条在途（start 幂等，绝不叠加第二条 interval）；
 *    · 值没变＝连 setState 都不调（不是「调了让 React 自己 bail out」）——静止时零提交。
 */
export function useStableTick<T>(enabled: boolean, ms: number, read: () => T, initial: T): T {
  const readRef = useRef(read)
  readRef.current = read
  const [value, setValue] = useState<T>(initial)
  const ticker = useRef<ReturnType<typeof createValueTicker<T>> | null>(null)
  if (ticker.current === null) {
    ticker.current = createValueTicker<T>(() => readRef.current(), initial, (next) => setValue(next), WINDOW_CLOCK)
  }

  useEffect(() => {
    const timer = ticker.current
    if (!timer) return
    if (!enabled) { timer.stop(); return }
    // 开启时先补一拍：上一次关掉时留下的值可能已经很旧了，等一个周期才刷新会先画一帧错的读数。
    // 这一拍同样只在**值确实不同**时才提交，与静止判据是一条规矩。
    timer.tick()
    timer.start(ms)
    return () => { timer.stop() }
  }, [enabled, ms])

  return value
}

/** 每秒走字的通用形态（用时 / 倒计时）：值不变（还是同一秒）就不提交。 */
export function useSecondTick<T>(enabled: boolean, read: () => T, initial: T): T {
  return useStableTick(enabled, 1000, read, initial)
}

/** 当前时间**按秒量化**：同一秒里读多少次都是同一个数 —— 走字面板的静止判据。
 *  直接读 Date.now() 的话，每一拍都是新数，一秒一次提交永远停不下来。 */
export function secondNow(): number {
  return Math.floor(Date.now() / 1000) * 1000
}
