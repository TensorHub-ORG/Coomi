/**
 * 流式正文的**提交节流**（纯逻辑，可脱离浏览器直接断言：tests/check-stream-throttle.mjs）。
 *
 * 背景：一个长回答会推来几百个 text_chunk。以前是「每个动画帧提交一次 state」——
 * 窗口能跑 60fps 时就是每秒 60 次 set()，每次都要把整棵消息树重算一遍，长会话里直接掉帧。
 * 现在两次提交之间至少隔 CHUNK_COMMIT_MS（32ms ≈ 31 次/秒 ≈ 30fps）：
 * 窗口内到达的 chunk 攒在同一个缓冲里，到点**一次性**提交。
 *
 * 这一份只管「什么时候提交、提交什么」，三条硬约束都在这里表达：
 *   ① 一个字都不能丢 —— 提交就是把缓冲原样并进事件数组，顺序 = 到达顺序；
 *   ② 一轮结束前必须刷干净 —— turn_end / 任何非 chunk 事件都先同步 flush（调用方保证，
 *      见 stores/session.ts 的 flushChunks）；
 *   ③ **任何合批/去重循环都不许自己转下去** —— 读游标必须严格递增、剩余缓冲必须严格减少，
 *      轮数硬上限 = 条目数 × 2；任何一条不变量被破坏就 break + console.warn（见 advanceGuarded）。
 * 节流只压「多久画一次」，不压内容，也不压统计（字数在到达时就累加了）。
 */

/** 两次 state 提交之间的最小间隔（ms）：≈30fps。 */
export const CHUNK_COMMIT_MS = 32

/** 一帧事件（WS 的 payload）。 */
export type StreamEvent = Record<string, any>

/** 一帧 chunk 的正文：引擎这边三种字段名都出现过（content / delta / text）。 */
export function chunkText(ev: StreamEvent): string {
  return String(ev.content ?? ev.delta ?? ev.text ?? '')
}

/** 本轮正文的非空白字符数（后台完成提醒里的「共 N 字」）。
    在**到达时**累加，不等提交 —— 最后一帧可能在提交之前就被 turn_end 收尾了。 */
export function countChars(ev: StreamEvent): number {
  return chunkText(ev).replace(/\s+/g, '').length
}

/** 距离下一次可以提交还差多少毫秒（0 ＝ 窗口已过，下一帧就能提交）。
    节流窗口的基准是**上一次真的提交的时刻**，不是上一次收到 chunk 的时刻 ——
    否则持续来 chunk 会让提交被无限推后（那才是真的「不画」）。 */
export function commitDelay(now: number, lastCommitAt: number): number {
  const wait = CHUNK_COMMIT_MS - (now - lastCommitAt)
  return wait > 0 ? wait : 0
}

/* ── 循环护栏：合批 / 去重的每一步都必须「可证明地往前走」 ──
   界面整体无响应的头号成因是**同步死循环**：一个游标不推进的 for/while
   （indexOf(needle, at + needle.length) 在 needle 为空时就是这种形状）会把主线程占死，
   连 React 的重渲染都排不进去，表现就是「点哪儿都没反应、风扇狂转」。
   这里把「推进」写成可断言的不变量，任何一条不成立就立刻收手，绝不指望它自己收敛。 */

/** 单次合批 / 去重循环的轮数上限系数：**条目数 × 2**。 */
export const LOOP_STEP_FACTOR = 2

/** 条目数 → 轮数硬上限（至少 1，条目数为 0 时也绝不允许无限轮）。 */
export function loopStepBudget(items: number): number {
  const n = Number.isFinite(items) && items > 0 ? Math.floor(items) : 0
  return Math.max(1, n * LOOP_STEP_FACTOR)
}

/** 护栏触发时的统一出口：带上下文，方便在控制台里一眼看出是哪一段卡住了。 */
export function warnLoopGuard(label: string, detail: string): void {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') return
  console.warn('[streamCommit] 循环护栏触发：' + label + ' —— ' + detail)
}

/**
 * 有护栏的单遍推进循环（合批与去重的**唯一**读法）。
 *
 * 三条不变量，任一被破坏都立刻 break（并 console.warn 带上下文）：
 *   ① 读游标严格递增：next > cursor；
 *   ② 每轮剩余条目严格减少：left < remaining 且 left ≥ 0；
 *   ③ 轮数硬上限：条目数 × 2（budget 可显式覆盖，测试用）。
 *
 * read(cursor) 返回**下一个**游标：读游标不推进（返回原值或更小）就是死循环的形状，
 * 这里第一轮就会收手，不会把主线程占死。
 *
 * @returns 实际推进到的游标；小于 total 表示被护栏截断（调用方据此决定要不要告警/重来）。
 */
export function advanceGuarded(
  total: number,
  read: (cursor: number) => number,
  label: string,
  budget?: number,
): number {
  const count = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  const cap = budget ?? loopStepBudget(count)
  let cursor = 0
  let rounds = 0
  while (cursor < count) {
    rounds += 1
    if (rounds > cap) {
      warnLoopGuard(label, '轮数超过硬上限 ' + cap + '（条目 ' + count + ' 条），强制收手')
      break
    }
    const at = cursor
    const remaining = count - at
    const next = read(at)
    const left = count - next
    if (!(next > at) || !(left < remaining) || left < 0) {
      warnLoopGuard(label, '读游标没有单调推进（cursor ' + at + ' → ' + next
        + '，剩余 ' + remaining + ' → ' + left + '），强制收手')
      break
    }
    cursor = next
  }
  return cursor
}

/** 提交：把缓冲里攒下的 chunk 并进事件数组。
    顺序 = 到达顺序，条数一条不少（不丢字就是这一行保证的）；
    空缓冲时**返回原数组**（同一个引用），免得白白换一份 state 让整棵树重算。
    读法只有一条：advanceGuarded（游标严格递增 + 剩余严格减少 + 轮数上限）。 */
export function commitChunks(events: StreamEvent[], buffered: StreamEvent[]): StreamEvent[] {
  if (!buffered.length) return events
  const out = events.slice()
  const cursor = advanceGuarded(buffered.length, (at) => {
    out.push(buffered[at])
    return at + 1
  }, 'commitChunks')
  if (cursor < buffered.length) {
    warnLoopGuard('commitChunks', '护栏收手时还有 ' + (buffered.length - cursor) + ' 条没提交')
  }
  return out
}

/** 提交**并且清空**缓冲：flush 的唯一入口。
    出口保证：缓冲长度恒为 0（显式写 0，不是做减法 —— 长度永远不可能为负，
    这里把这条不变量显式断言出来，防止以后有人改成「先加后减」的写法）。 */
export function flushChunks(events: StreamEvent[], buffer: StreamEvent[]): StreamEvent[] {
  const next = commitChunks(events, buffer)
  const left = buffer.length
  if (left !== 0) buffer.length = 0
  if (buffer.length !== 0 || left < 0) {
    warnLoopGuard('flushChunks', 'flush 之后缓冲没有清空（剩余 ' + left + ' 条，现在 ' + buffer.length + ' 条）')
  }
  return next
}

/* ── 合批调度：**只保留一条路** ──
   以前 rAF 与定时器两条路都能 flush 同一个缓冲（窗口已过走 rAF、窗口未到挂定时器），
   两条路各持一个句柄、取消时要分别 cancel 一遍；只要有一条漏了取消，
   同一个缓冲就会被 flush 两次（第二次读到空缓冲，看似无害，但两条路互相插队时顺序不再确定）。
   现在只留**定时器**一条：rAF 在窗口不可见时几乎不跑，光靠它正文会滞留；
   而定时器的语义就是「到点提交」，与 32ms 窗口完全同构。
   约束：同一个缓冲**只允许一条在途调度**（handle 非空时 schedule 直接返回）。 */

/** 注入的时钟与定时器（浏览器里传 window.setTimeout / clearTimeout / Date.now；
    测试里传假时钟，纯逻辑因此可以脱离浏览器断言）。 */
export interface CommitClock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => number
  clearTimer: (handle: number) => void
}

export interface StreamCommitter {
  /** 收一条 chunk：进缓冲，并按**唯一一条**调度路径排下一拍。 */
  arrive: (ev: StreamEvent) => void
  /** 立即提交并清空缓冲（turn_end / 非 chunk 事件 / 切会话之前都要先走这一步）。 */
  flush: () => void
  /** 丢掉还没提交的缓冲（发新消息 / 截断重发）。 */
  drop: () => void
  /** 缓冲里还攒着多少条。 */
  pending: () => number
  /** 在排的那一拍还等多久（-1 ＝ 没在排）。 */
  scheduledIn: () => number
  /** 取消在排的那一拍（卸载 / 切会话）。 */
  dispose: () => void
}

/** 造一个「单调度路径」的合批器：缓冲、节流窗口、在途句柄三件事只在这里维护。
    sink 拿到的是**已经与缓冲脱离**的那一批（顺序 = 到达顺序，条数一条不少）。 */
export function createStreamCommitter(
  clock: CommitClock,
  sink: (buffered: StreamEvent[]) => void,
  windowMs: number = CHUNK_COMMIT_MS,
): StreamCommitter {
  let buffer: StreamEvent[] = []
  let handle: number | null = null
  let dueAt = -1
  let lastCommitAt = 0

  const cancel = (): void => {
    if (handle === null) return
    clock.clearTimer(handle)
    handle = null
    dueAt = -1
  }

  const flush = (): void => {
    cancel()
    if (!buffer.length) return
    const batch = buffer
    buffer = []
    lastCommitAt = clock.now()
    sink(batch)
    if (buffer.length !== 0) warnLoopGuard('streamCommitter.flush', '提交后缓冲里还剩 ' + buffer.length + ' 条')
  }

  /** 唯一的一条调度路径：到点由定时器提交。已经在排的那一拍不算第二条路。 */
  const schedule = (): void => {
    if (handle !== null) return
    const wait = windowMs - (clock.now() - lastCommitAt)
    const delay = wait > 0 ? wait : 0
    dueAt = clock.now() + delay
    handle = clock.setTimer(() => { handle = null; dueAt = -1; flush() }, delay)
  }

  return {
    arrive: (ev: StreamEvent): void => { buffer.push(ev); schedule() },
    flush,
    drop: (): void => { cancel(); buffer = [] },
    pending: (): number => buffer.length,
    scheduledIn: (): number => (handle === null ? -1 : Math.max(0, dueAt - clock.now())),
    dispose: cancel,
  }
}
