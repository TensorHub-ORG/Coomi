/**
 * 界面保险丝（guard）：主线程心跳、提交熔断、单次任务超时保护。
 *
 * 症状：发消息跑任务时**整个界面卡死**（后端正常、消息很少）。卡死 ＝ 主线程被占住：
 * 渲染进程没在等网络，而是在同步跑 JS —— 一帧里塞进几百次 state 提交、或一次折叠就算掉
 * 几百毫秒时，浏览器连「把这一帧画出来」都排不上队，于是整屏不动、点什么都没反应。
 *
 * 这里装三道保险，彼此独立，且都只做减法：
 *   ① 主线程心跳：setInterval 每 1000ms 打一次时间戳。两次心跳间隔 > 3000ms ＝ 这中间
 *      主线程被占住过一回 → 记录 + 自动进精简模式 + 提示一次。它是**唯一**能发现「刚刚卡过」
 *      的判据：卡住的时候没有任何回调跑得起来，只有「回来了、但来晚了」能说明问题。
 *   ② 提交熔断：同一帧内同一个 store 提交 > FRAME_COMMIT_MAX(5) 次 → 这一帧多出来的提交
 *      被挡下并计数（调用方把它们顺延到下一帧合并成一次，状态不丢、只是少画几帧）；
 *      任意 1 秒内总提交 > SECOND_COMMIT_MAX(60) 次 → 直接升精简模式。
 *   ③ 单次任务超时：折叠 / 合并这类纯计算超过 TASK_BUDGET_MS(50) → 放弃本次结果并记录，
 *      界面保持上一拍的内容。宁可晚一帧，也不要为了这一帧把整屏冻住。
 *
 * 精简模式（lean）＝ 一处判定、各处照做：动效、富预览、语法高亮、长列表虚拟化、刻度轨
 * 重算全部让路，Markdown 解析只置标记不解析。判定只有一个出口 isLean()，谁都不许自己再存
 * 一份 —— 两份判据迟早会漂移，那时「关了还在动」就查不出来了。
 * 安全模式（safeMode）是它的人肉入口：设置里的开关，或启动时的 ?safe=1 / localStorage。
 *
 * 这一份是**纯逻辑 + 少量浏览器接线**：三个核心（提交闸门 / 心跳 / 任务计时器）都能脱离
 * 浏览器直接断言（apps/desktop-ui-react/tests/check-guard.mjs）。全文件**不做任何 import**，
 * 免得为了跑一条断言先把 sonner / DOM 拖进来；toast 文案由调用方注入（main.tsx 接 sonner）。
 */

/* ── 阈值：全部写死在这里，别散到调用方 ── */
/** 心跳间隔：每秒一次。 */
export const HEARTBEAT_MS = 1_000
/** 两次心跳间隔超过它 ＝ 这中间卡过一回。 */
export const HEARTBEAT_STALL_MS = 3_000
/** 同一帧内同一个 store 允许的提交次数上限。 */
// 阈值放宽：流式 31 次/秒 + 工具/用量/状态事件很容易贴近旧的 60，一次小波动就误降级。
export const FRAME_COMMIT_MAX = 8
/** 任意 1 秒内允许的总提交次数上限，超了直接进精简模式。 */
export const SECOND_COMMIT_MAX = 120
/** 单次折叠 / 合并的时间预算（ms）。 */
export const TASK_BUDGET_MS = 50
/** 常规流式提交窗口（ms）：与 lib/streamCommit.ts 的 CHUNK_COMMIT_MS 同一口径。 */
export const COMMIT_MS = 32
/** 精简模式的提交窗口（ms）：少画几帧，正文一个字不丢。 */
export const COMMIT_LEAN_MS = 100
/** 熔断挡下的提交往后顺延多久（ms）：下一帧的边上，够 React 把这一帧画完。 */
export const DEFER_MS = 16
/** 强制安全模式的本地开关：把它的值设成 '1' 之后重启即生效（界面卡到点不动时自救用）。 */
export const SAFE_STORAGE_KEY = 'coomi.safe.v1'

/** 进精简模式的原因。 */
export type LeanReason = 'safe-mode' | 'heartbeat-stall' | 'commit-storm' | 'manual'

/** 单调时钟（ms）：performance.now 更稳（不受系统改时间影响），没有就退回 Date.now。 */
export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
  return Date.now()
}

/* ══════════════════════════════════════════════════════════════════
   ① 提交闸门（纯逻辑）
   ══════════════════════════════════════════════════════════════════ */

/** 一次提交的裁决结果。 */
export interface CommitDecision {
  /** true ＝ 这一帧可以提交；false ＝ 被熔断挡下（调用方负责顺延到下一帧）。 */
  allowed: boolean
  /** 本次是不是被挡下的那一次（与 allowed 互补，单独列出来只为可读）。 */
  blocked: boolean
  /** 本帧内这个 store 的第几次提交（1 起）。 */
  frameCount: number
  /** 本秒内这个 store 的第几次提交（1 起）。 */
  secondCount: number
  /** 本秒总提交数在这一刻越界了（风暴），每秒最多报一次。 */
  storm: boolean
}

export interface CommitGateStats {
  /** 放行的提交次数。 */
  allowed: number
  /** 被挡下的提交次数（＝本帧多出来的那些）。 */
  blocked: number
  /** 见过的单帧同 store 最大提交次数。 */
  maxFrame: number
  /** 见过的单秒最大总提交次数。 */
  peakSecond: number
  /** 判成风暴的秒数（跨秒才 +1，不是每一次越界都算）。 */
  storms: number
}

export interface CommitGate {
  report: (store: string, now: number, options?: { critical?: boolean }) => CommitDecision
  stats: () => CommitGateStats
  reset: () => void
}

export interface CommitGateOptions {
  /** 一帧按多少毫秒算，默认 16ms（60fps 的一帧）。 */
  frameMs?: number
  /** 同帧同 store 的提交上限。 */
  perFrameMax?: number
  /** 每秒总提交上限。 */
  perSecondMax?: number
  /** 判成风暴时回调一次（每秒最多一次）。 */
  onStorm?: (info: { store: string; secondCount: number; at: number }) => void
}

/**
 * 建一个提交闸门。**同一帧** ＝ `Math.floor(now / frameMs)` 相同的那些提交：
 * 用时间片而不是 rAF 计数，是为了让这套判定脱离浏览器也能断言（tests/check-guard.mjs），
 * 而 16ms 的时间片与「一帧」在 60fps 下本来就是同一件事。
 */
export function createCommitGate(options: CommitGateOptions = {}): CommitGate {
  const frameMs = options.frameMs && options.frameMs > 0 ? options.frameMs : 16
  const perFrameMax = options.perFrameMax ?? FRAME_COMMIT_MAX
  const perSecondMax = options.perSecondMax ?? SECOND_COMMIT_MAX

  const byStore = new Map<string, { frame: number; frameCount: number; second: number; secondCount: number }>()
  let totalSecond = -1
  let totalSecondCount = 0
  let stormSecond = -1
  let allowed = 0
  let blocked = 0
  let maxFrame = 0
  let peakSecond = 0
  let storms = 0

  const report = (store: string, now: number, opts?: { critical?: boolean }): CommitDecision => {
    const frame = Math.floor(now / frameMs)
    const second = Math.floor(now / 1000)
    const entry = byStore.get(store) ?? { frame: -1, frameCount: 0, second: -1, secondCount: 0 }
    entry.frameCount = entry.frame === frame ? entry.frameCount + 1 : 1
    entry.frame = frame
    entry.secondCount = entry.second === second ? entry.secondCount + 1 : 1
    entry.second = second
    byStore.set(store, entry)

    totalSecondCount = totalSecond === second ? totalSecondCount + 1 : 1
    totalSecond = second
    if (entry.frameCount > maxFrame) maxFrame = entry.frameCount
    if (totalSecondCount > peakSecond) peakSecond = totalSecondCount

    // 越界的那一秒只回调一次：enterLean 自带去重，但没人愿意被一个 while 循环刷几百条提示。
    let storm = false
    if (totalSecondCount > perSecondMax && stormSecond !== second) {
      storm = true
      stormSecond = second
      storms += 1
      try { options.onStorm?.({ store, secondCount: totalSecondCount, at: now }) } catch { /* 回调失败不影响裁决 */ }
    }

    // critical 的提交不受帧预算限制（连接状态、轮次收尾这类丢了会让界面永远停在旧状态），
    // 但照样计数 —— 统计里「谁在刷 state」不能因为标了 critical 就看不见。
    const ok = opts?.critical === true || entry.frameCount <= perFrameMax
    if (ok) allowed += 1
    else blocked += 1
    return { allowed: ok, blocked: !ok, frameCount: entry.frameCount, secondCount: entry.secondCount, storm }
  }

  return {
    report,
    stats: () => ({ allowed, blocked, maxFrame, peakSecond, storms }),
    reset: () => {
      byStore.clear()
      totalSecond = -1
      totalSecondCount = 0
      stormSecond = -1
      allowed = 0
      blocked = 0
      maxFrame = 0
      peakSecond = 0
      storms = 0
    },
  }
}

/* ══════════════════════════════════════════════════════════════════
   ② 心跳（纯逻辑）
   ══════════════════════════════════════════════════════════════════ */

export interface HeartbeatVerdict {
  /** 与上一次心跳的间隔（ms）；第一次打点没有上一次，给 0。 */
  gap: number
  /** 这一次打点时发现「刚刚卡过」：间隔超过了 stallMs。 */
  stalled: boolean
  /** 累计打点次数。 */
  beats: number
  /** 累计判成卡顿的次数。 */
  stalls: number
}

export interface Heartbeat {
  beat: (now: number) => HeartbeatVerdict
  /** 只把基准挪到当下、**不做判定**：页面被挂起 / 隐藏时的空档不是「卡」。 */
  rebase: (now: number) => HeartbeatVerdict
  lastAt: () => number
  stats: () => { beats: number; stalls: number }
  reset: () => void
}

/** 心跳判定：只认「两次打点的间隔」这一条硬证据；第一次打点（还没有上一次）永远不算卡。 */
export function createHeartbeat(options: { stallMs?: number } = {}): Heartbeat {
  const stallMs = options.stallMs && options.stallMs > 0 ? options.stallMs : HEARTBEAT_STALL_MS
  let last = 0
  // 「有没有打过点」单独记一个布尔：用 last === 0 当哨兵的话，时刻 0 上打的那一次会被当成没打过。
  let started = false
  let beats = 0
  let stalls = 0
  const beat = (now: number): HeartbeatVerdict => {
    const gap = started ? now - last : 0
    const stalled = started && gap > stallMs
    if (stalled) stalls += 1
    last = now
    started = true
    beats += 1
    return { gap, stalled, beats, stalls }
  }
  const rebase = (now: number): HeartbeatVerdict => {
    last = now
    started = true
    beats += 1
    return { gap: 0, stalled: false, beats, stalls }
  }
  return {
    beat,
    rebase,
    lastAt: () => last,
    stats: () => ({ beats, stalls }),
    reset: () => { last = 0; started = false; beats = 0; stalls = 0 },
  }
}

/* ══════════════════════════════════════════════════════════════════
   ③ 单次任务超时（纯逻辑）
   ══════════════════════════════════════════════════════════════════ */

/** 交给被保护的函数：长循环可以自己进来问一句「还值得算吗」，早点收手。 */
export interface TaskDeadline {
  expired: () => boolean
  elapsed: () => number
}

export interface TaskRunStats {
  /** 按时算完、结果被采纳的次数。 */
  runs: number
  /** 超预算被放弃的次数。 */
  timeouts: number
  /** 自己抛异常被放弃的次数。 */
  failures: number
  lastMs: number
  maxMs: number
  lastLabel: string
}

export interface TaskRunner {
  run: <T>(label: string, fn: (deadline: TaskDeadline) => T, fallback: T, budgetMs?: number) => T
  stats: () => TaskRunStats
  reset: () => void
}

/** 这一次计算是不是已经超了预算（纯函数，测试直接喂数）。 */
export function overBudget(start: number, now: number, budgetMs: number): boolean {
  return now - start > budgetMs
}

/**
 * 建一个「算太慢就放弃」的执行器。JS 不能抢占，所以这里做的是**结果层**的保护：
 * 照样把函数跑完、量出耗时 —— 超过预算就丢掉这次结果、退回上一拍，并记账。
 * 配合 fn 里自己轮询的 deadline，长循环还能中途收手（省掉尾巴上那几百毫秒）。
 */
export function createTaskRunner(
  options: { budgetMs?: number; clock?: () => number; onTimeout?: (label: string, elapsed: number) => void } = {},
): TaskRunner {
  const defaultBudget = options.budgetMs ?? TASK_BUDGET_MS
  const clock = options.clock ?? nowMs
  let runs = 0
  let timeouts = 0
  let failures = 0
  let lastMs = 0
  let maxMs = 0
  let lastLabel = ''

  const run = <T>(label: string, fn: (deadline: TaskDeadline) => T, fallback: T, budgetMs?: number): T => {
    const budget = budgetMs ?? defaultBudget
    const start = clock()
    const deadline: TaskDeadline = { expired: () => overBudget(start, clock(), budget), elapsed: () => clock() - start }
    let value: T
    try {
      value = fn(deadline)
    } catch {
      // 折叠函数自己炸了：界面保持上一拍的内容，绝不把异常甩到渲染树上。
      failures += 1
      lastLabel = label
      return fallback
    }
    const end = clock()
    lastMs = end - start
    lastLabel = label
    if (lastMs > maxMs) maxMs = lastMs
    if (overBudget(start, end, budget)) {
      timeouts += 1
      try { options.onTimeout?.(label, lastMs) } catch { /* 记账失败不影响返回值 */ }
      return fallback
    }
    runs += 1
    return value
  }

  return {
    run,
    stats: () => ({ runs, timeouts, failures, lastMs, maxMs, lastLabel }),
    reset: () => { runs = 0; timeouts = 0; failures = 0; lastMs = 0; maxMs = 0; lastLabel = '' },
  }
}

/* ══════════════════════════════════════════════════════════════════
   精简模式 / 安全模式：全应用唯一的判定
   ══════════════════════════════════════════════════════════════════ */

export interface GuardNotice {
  /** 去重键：同一条提示在这一次精简期间只弹一次。 */
  key: string
  title: string
  description?: string
}

const LEAN_TITLES: Record<LeanReason, string> = {
  'safe-mode': '安全模式已开启',
  'heartbeat-stall': '界面刚刚卡过一回',
  'commit-storm': '状态提交过于频繁',
  manual: '已切到精简模式',
}

const LEAN_DESCRIPTIONS: Record<LeanReason, string> = {
  'safe-mode': '动效、富预览、语法高亮与长列表虚拟化都已关闭，界面只画纯文本，保证不再整屏卡死。',
  'heartbeat-stall': '主线程被占住过，已自动降级：提交合并得更粗、重活让路，正文一个字都不会丢。',
  'commit-storm': '1 秒内的状态提交次数越过了上限，已自动降级，避免界面被拖死。',
  manual: '按你的请求切到精简模式。',
}

let lean = false
let leanReason: LeanReason | null = null
let safe = false
let notifier: ((notice: GuardNotice) => void) | null = null
const leanListeners = new Set<(lean: boolean, reason: LeanReason | null) => void>()
const noticed = new Set<string>()
let lastTimeout: { label: string; elapsed: number; at: number } | null = null
let heartbeatTimer: number | null = null
let visibilityHook: (() => void) | null = null

/** 注入提示通道（main.tsx 接 sonner 的 toast）。传 null 取消。 */
export function setGuardNotice(fn: ((notice: GuardNotice) => void) | null): void {
  notifier = fn
}

/** 订阅精简模式变化：ui.ts 用它把 data-lean / data-motion 落到 <html> 上。 */
export function subscribeLean(cb: (lean: boolean, reason: LeanReason | null) => void): () => void {
  leanListeners.add(cb)
  return () => { leanListeners.delete(cb) }
}

function noticeOnce(info: GuardNotice): void {
  if (noticed.has(info.key)) return
  noticed.add(info.key)
  const fn = notifier
  if (!fn) return
  try { fn(info) } catch { /* 提示失败绝不能反过来影响主流程 */ }
}

function applyLeanAttr(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (lean) root.dataset.lean = 'on'
  else delete root.dataset.lean
}

function emitLean(): void {
  for (const cb of [...leanListeners]) {
    try { cb(lean, leanReason) } catch { /* 订阅者出错不影响其他订阅者 */ }
  }
}

/** 现在是不是精简模式 —— 全应用唯一的判据（动效 / 富预览 / 高亮 / 虚拟化 / 刻度轨都读它）。 */
export function isLean(): boolean {
  return lean
}

/** 安全模式开关的当前值（人肉入口，见 setSafeMode）。 */
export function safeMode(): boolean {
  return safe
}

/** 当前为什么在精简模式；null ＝ 不在精简模式。 */
export function leanReasonOf(): LeanReason | null {
  return leanReason
}

/** 进精简模式（同一个原因重复调用是幂等的）。detail 会拼进提示文案，说清这一回到底是哪儿卡了。 */
export function enterLean(reason: LeanReason, detail?: string): void {
  if (lean && leanReason === reason) return
  lean = true
  leanReason = reason
  applyLeanAttr()
  emitLean()
  noticeOnce({
    key: reason,
    title: LEAN_TITLES[reason],
    description: LEAN_DESCRIPTIONS[reason] + (detail ? '（' + detail + '）' : ''),
  })
}

/** 退出精简模式（手动的自救出口）。 */
export function exitLean(): void {
  if (!lean) return
  lean = false
  leanReason = null
  // 下一次再卡，提示要能再弹一次：这里清掉的是「这一轮已经提示过」的账。
  noticed.clear()
  applyLeanAttr()
  emitLean()
}

/** 开 / 关安全模式。开启即进精简模式；关闭只撤掉「安全模式」自己那一次降级，不碰心跳/风暴引起的降级。 */
export function setSafeMode(on: boolean): void {
  safe = on
  if (on) {
    enterLean('safe-mode')
    return
  }
  if (leanReason === 'safe-mode') exitLean()
}

/** 启动时是不是被强制开了安全模式：URL `?safe=1`（也认 true / on），或本地开关。 */
export function forcedSafeMode(): boolean {
  try {
    if (typeof location !== 'undefined' && location.search) {
      const v = new URLSearchParams(location.search).get('safe')
      if (v === '1' || v === 'true' || v === 'on') return true
    }
  } catch { /* 拿不到 URL 参数就算了 */ }
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(SAFE_STORAGE_KEY) === '1') return true
  } catch { /* 隐私模式忽略 */ }
  return false
}

/** 写 / 清本地强制开关（地址栏不方便改时用；下一次启动生效）。 */
export function setSafeOverride(on: boolean): void {
  try {
    if (on) localStorage.setItem(SAFE_STORAGE_KEY, '1')
    else localStorage.removeItem(SAFE_STORAGE_KEY)
  } catch { /* 隐私模式忽略 */ }
}

/* ══════════════════════════════════════════════════════════════════
   单例：把三个核心接到真实运行时上
   ══════════════════════════════════════════════════════════════════ */

const gate = createCommitGate({
  // **不再自动降级**（用户明确要求：消息再多也不降级）：风暴只记账留痕，
  // 界面继续按正常窗口提交（32ms），动画与渲染质量不受影响。
  onStorm: (info) => {
    try { console.warn('[guard] commit storm (no degrade): ' + info.secondCount + ' commits in 1s') } catch { /* 忽略 */ }
  },
})

const beat = createHeartbeat()

const tasks = createTaskRunner({
  onTimeout: (label, elapsed) => { lastTimeout = { label, elapsed, at: nowMs() } },
})

/**
 * 提交一次 state 变更前问一句。返回 false ＝ **这一帧先别提交**，
 * 调用方要把这次变更顺延到下一帧、合并成一次（状态不丢，只是少画几帧）。
 * critical ＝ 连接状态 / 轮次收尾这类丢了会让界面永远停在旧状态的提交：不挡，但照样计数。
 */
export function reportCommit(store = 'session', critical = false): boolean {
  return gate.report(store, nowMs(), { critical }).allowed
}

/** 精简模式下把流式提交窗口放宽到 100ms（常规 32ms）。 */
export function commitWindowMs(): number {
  return lean ? COMMIT_LEAN_MS : COMMIT_MS
}

/**
 * 打一次心跳。返回判定结果；发现「刚刚卡过」时自动进精简模式 + 提示一次。
 * 正常运行时由 startHeartbeat 每秒调用；断言里直接喂时刻。
 */
export function heartbeat(at = nowMs()): HeartbeatVerdict {
  // 页面不可见时定时器会被浏览器节流（隐藏的标签页可能一分钟才醒一次）。那不是「主线程卡住」，
  // 是浏览器按规矩办事 —— 直接只挪基准、不判定，否则「最小化到托盘」会被判成一次卡顿，
  // 白白把界面降级成精简模式。
  if (pageHidden()) return beat.rebase(at)
  const verdict = beat.beat(at)
  if (verdict.stalled) {
    // 心跳停滞也**不再自动降级**：只记录，界面保持正常渲染（用户明确要求不降级）。
    try { console.warn('[guard] heartbeat stall (no degrade): gap=' + Math.round(verdict.gap) + 'ms') } catch { /* 忽略 */ }
  }
  return verdict
}

/** 停心跳（幂等）。 */
export /** 页面是不是不可见（隐藏 / 最小化到托盘）：只有这一种情况该按「不算卡」处理。 */
function pageHidden(): boolean {
  if (typeof document === 'undefined') return false
  return document.hidden === true
}

/** 停心跳（幂等）：顺带摘掉可见性钩子。 */
export function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    if (typeof window !== 'undefined') window.clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (visibilityHook && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHook)
    visibilityHook = null
  }
}

/** 起搏心跳：每秒打一次时间戳，返回停止函数。重复调用不会叠加定时器。 */
export function startHeartbeat(): () => void {
  if (heartbeatTimer !== null || typeof window === 'undefined') return stopHeartbeat
  heartbeatTimer = window.setInterval(() => { heartbeat() }, HEARTBEAT_MS)
  // 回到前台的第一件事是把基准对到当下：隐藏期间攒下的那几个「迟到的心跳」不能算卡。
  const onVisible = (): void => { if (!pageHidden()) beat.rebase(nowMs()) }
  visibilityHook = onVisible
  document.addEventListener('visibilitychange', onVisible)
  return stopHeartbeat
}

/** 跑一次「算太慢就放弃」的折叠 / 合并：超预算或抛异常都退回 fallback，界面保持上一拍。 */
export function guardTask<T>(label: string, fn: (deadline: TaskDeadline) => T, fallback: T, budgetMs = TASK_BUDGET_MS): T {
  return tasks.run(label, fn, fallback, budgetMs)
}

export interface GuardStatsSnapshot {
  lean: boolean
  reason: LeanReason | null
  safe: boolean
  commit: CommitGateStats
  /** 心跳打点次数。 */
  beats: number
  /** 心跳判成卡顿的次数。 */
  stalls: number
  tasks: TaskRunStats
  /** 最近一次被超时保护放弃的任务。 */
  lastTimeout: { label: string; elapsed: number; at: number } | null
}

/** 诊断快照（开发者面板 / 自检用）。 */
export function guardStats(): GuardStatsSnapshot {
  const hbStats = beat.stats()
  return {
    lean,
    reason: leanReason,
    safe,
    commit: gate.stats(),
    beats: hbStats.beats,
    stalls: hbStats.stalls,
    tasks: tasks.stats(),
    lastTimeout,
  }
}

/** 全部计数清零；顺带退出「自动降级」那一档（安全模式是用户的意图，不动）。 */
export function resetGuard(): void {
  gate.reset()
  beat.reset()
  tasks.reset()
  lastTimeout = null
  noticed.clear()
  if (!safe) exitLean()
}

export interface GuardOptions {
  /** 提示通道（main.tsx 接 toast）。 */
  notify?: (notice: GuardNotice) => void
  /** 要不要顺带起搏心跳，默认 true。 */
  heartbeat?: boolean
}

/** 首帧之前调用：接上提示通道并起搏心跳。返回卸载函数（测试里用得到）。 */
export function installGuard(options: GuardOptions = {}): () => void {
  if (options.notify) setGuardNotice(options.notify)
  const stop = options.heartbeat === false ? stopHeartbeat : startHeartbeat()
  return () => { stop(); setGuardNotice(null) }
}
