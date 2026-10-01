/** 「值没变就不提交」的共享护栏（纯逻辑，零依赖 —— 能被 tests/*.mjs 直接 import）。
 *
 *  背景：渲染风暴（React #185「Maximum update depth exceeded」）几乎都长成同一个形状 ——
 *    effect / 定时器 / 派生计算**无条件**把一份新引用写回状态，
 *    而这份状态又在依赖里，于是「写 → 重算 → 再写」自激。
 *
 *  这里只放两件纯事，React 侧的节拍钩子在 components/ui/stableTick.ts：
 *    ① commitIfChanged —— 值没变就别写（返回原值，调用方据此跳过 setState）；
 *    ② sameJson —— 轮询回读的结构化数据比较（键序无关），对象全等时保留旧引用，下游 memo 才有意义。
 *
 *  计数（commitCount / resetCommitCount）给纯逻辑断言用：静止输入下连续 N 拍必须是 0 次提交。
 *  见 tests/check-render-stability.mjs。
 */

/* ── 提交计数：断言「静止时不产生提交」的唯一口径 ── */
let commits = 0
/** 记一次真实提交（值确实变了）。 */
export function noteCommit(): void { commits += 1 }
/** 至今为止的提交次数。 */
export function commitCount(): number { return commits }
/** 断言前归零。 */
export function resetCommitCount(): void { commits = 0 }

/** 值真的变了才返回 next，否则原样返回 prev 并**不记账**。
 *  调用方写成 `const next = commitIfChanged(prev, value)`，
 *  或者直接把结果喂给 setState —— React 对 Object.is 相等的值会自己跳过这一帧的提交。 */
export function commitIfChanged<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev
  noteCommit()
  return next
}

/** 结构化数据的稳定比较：键序无关、递归到叶子。数组顺序**有关**（顺序变了界面就得重排）。
 *  轮询回读（任务列表 / 健康 / 用量）用它挡住「内容一样、引用不同」的空提交。 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!sameJson(a[i], b[i])) return false
    return true
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false
    if (!sameJson(left[key], right[key])) return false
  }
  return true
}
/* ── 单调度节拍器的纯核心 ──
   React 钩子（components/ui/stableTick.ts 的 useStableTick）只是这层的外壳，
   测试桩（tests/check-render-stability.mjs）喂假时钟跑的也是这一份 —— 两边不许各写一遍。 */

/** 注入的定时器：浏览器传 window.setInterval / clearInterval，测试传假时钟。 */
export interface TickClock {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export interface ValueTicker<T> {
  /** 起拍：幂等 —— 已经在拍就什么都不做（同一时刻只允许**一条**在途调度）。 */
  start: (ms: number) => void
  /** 停拍并清掉在途调度。 */
  stop: () => void
  /** 现在有没有在途调度（断言「没有叠加第二条」用）。 */
  pending: () => boolean
  /** 手动走一拍（React 侧开启时先补的那一拍、测试里的假时钟都走它）。 */
  tick: () => boolean
  /** 当前读到的值。 */
  value: () => T
}

/**
 * 值没变就不提交的节拍器。tick() 的返回值就是「这一拍有没有产生提交」：
 *   · false ＝ 值没变，commit 一次都没调（静止时零提交）；
 *   · true  ＝ 值变了，commit 被调用了一次。
 */
export function createValueTicker<T>(
  read: () => T,
  initial: T,
  commit: (value: T) => void,
  clock: TickClock,
): ValueTicker<T> {
  let current = initial
  let handle: unknown = null
  let running = false

  const tick = (): boolean => {
    const next = read()
    if (Object.is(current, next)) return false
    current = next
    noteCommit()
    commit(next)
    return true
  }

  return {
    start: (ms) => {
      if (running) return
      running = true
      handle = clock.setTimer(() => { tick() }, ms)
    },
    stop: () => {
      running = false
      if (handle !== null) { clock.clearTimer(handle); handle = null }
    },
    pending: () => handle !== null,
    tick,
    value: () => current,
  }
}
