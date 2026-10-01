/**
 * 渲染风暴探针（stormProbe）：统计「同一个组件在 1 秒内的提交次数」，
 * 超过阈值就记一次风暴（组件名 + 计数 + 时间）并触发一次可注入的回调。
 *
 * 为什么单开一份：React #185（Maximum update depth exceeded）在开发版里报的是
 * 「某处 setState 套 setState」，生产构建里组件名被压成 FB / MT 之后只剩一句
 * 没有主语的话。这里给页面级组件各挂一枚探针（React.Profiler 的 onRender 就是
 * 「一次提交」的口径），谁在刷、刷了多少次，第一时间就落在控制台上。
 *
 * 开销口径：**平时几乎为零**——没有定时器、没有订阅、只在计数超过阈值之后才
 * 计时间、才写 console、才回调。每次提交只做一次整数比较与递增。
 *
 * 与 lib/guard.ts 的分工：guard 的提交闸门盯的是 **store** 的提交频率（全局、带熔断），
 * 这一份盯的是 **单个组件** 的提交频率（定位到人）。两份账互不干扰，共用同一个
 * 「进安全模式」出口（App 里注入的回调走 lib/guard 的 setSafeMode）。
 */
import { Profiler, createElement, type ReactNode } from 'react'

/** 1 秒内的提交次数超过它就记一次风暴。 */
export const STORM_COMMITS = 20
/** 计数窗口：1 秒（和阈值合起来就是「> 20 次/秒」）。 */
export const STORM_WINDOW_MS = 1000

/** 一次风暴的记录。 */
export interface StormRecord {
  /** 组件名（React.Profiler 的 id，即被包裹组件的显示名）。 */
  component: string
  /** 这一次窗口里的提交次数。 */
  commits: number
  /** 窗口长度（毫秒）。 */
  elapsedMs: number
}

export type StormListener = (record: StormRecord) => void

let listener: StormListener | null = null

/** 注入唯一的风暴回调；传 null 取消。后注入的替换前面的（App 只注一次）。 */
export function setStormListener(fn: StormListener | null): void {
  listener = fn
}

/** 现在挂着的风暴回调（诊断用）。 */
export function stormListener(): StormListener | null {
  return listener
}

/** 探针：由 React.Profiler 的 onRender 每提交一次调一下。 */
export interface StormProbe {
  /** 记录一次提交；超阈值的那个窗口里触发一次回调。 */
  report: () => void
  /** 这一次窗口里已经记了多少次（自检 / 开发者面板用）。 */
  count: () => number
  /** 归零：换了挂载点或想重新计时的时候用。 */
  reset: () => void
}

/**
 * 建一枚探针。阈值与窗口都可覆盖（默认 20 次 / 1000ms）。
 *
 * 只认「同一枚探针自己的计数」：每个组件一枚，互不影响；窗口过一秒就归零，
 * 所以只有**持续**每秒 20 次以上才算风暴（一次点击引发的几十次提交不会误报）。
 */
export function createStormProbe(
  component: string,
  options: { threshold?: number; windowMs?: number } = {},
): StormProbe {
  const threshold = options.threshold ?? STORM_COMMITS
  const windowMs = options.windowMs ?? STORM_WINDOW_MS
  let startedAt = 0
  let count = 0
  /** 已经报过的那一秒：同一枚探针不重复刷同一条风暴（否则一次风暴会打出几百行）。 */
  let reportedSecond = -1

  const report = (): void => {
    const now = Date.now()
    if (startedAt === 0 || now - startedAt > windowMs) {
      startedAt = now
      count = 0
    }
    count += 1
    if (count <= threshold) return
    // 跨了「秒」才再报一次：一次风暴只留一条记录 + 一条恢复记录。
    const second = Math.floor(now / windowMs)
    if (second === reportedSecond) return
    reportedSecond = second
    const record: StormRecord = { component, commits: count, elapsedMs: now - startedAt }
    // 只在真的成灾时才写控制台（平时一行都不写）。
    try {
      console.warn('[storm] 渲染风暴：' + component + ' 在 ' + record.elapsedMs + 'ms 内提交了 ' + record.commits + ' 次')
    } catch { /* 控制台不可用不影响判定 */ }
    const fn = listener
    if (!fn) return
    try { fn(record) } catch { /* 回调自己的异常不扩散到渲染路径 */ }
  }

  return { report, count: () => count, reset: () => { startedAt = 0; count = 0; reportedSecond = -1 } }
}

/* ── 显示名 ──
   构建产物（vite build）会把函数名压成 Vh / MT 这种两三个字母，React 的 componentStack
   于是只剩「at FB」这种读不出是谁的东西。displayName 是 React 唯一会原样保留的名字：
   在组件声明之后调一句 withDisplayName(Comp, 'Name')，以后 #185 的报错栈里就是真名。 */
interface DisplayNamed { displayName?: string }

/**
 * 给组件写死显示名并原样返回。**必须写在组件声明之后**（函数提升保证不会用到未初始化的绑定）。
 * 类型上返回同一个组件，使用处一个字都不用改。
 */
export function withDisplayName<C>(component: C, name: string): C {
  try { (component as unknown as DisplayNamed).displayName = name } catch { /* 冻结对象写不进去就算了 */ }
  return component
}

/** 每个组件名一枚探针（进程内复用）：同一个名字包多次也只记一份账。 */
const probes = new Map<string, StormProbe>()

/** 取（或建）某个组件名的探针。**在模块作用域调用**，不要放进渲染期——它是建账，不是 hook。 */
export function probeFor(name: string): StormProbe {
  const hit = probes.get(name)
  if (hit) return hit
  const probe = createStormProbe(name)
  probes.set(name, probe)
  return probe
}

/** 把子树包进 React.Profiler：一次提交 = onRender 一次。参数在模块作用域算好即可稳定。 */
export function profilerOf(name: string, children: ReactNode): ReactNode {
  return createElement(Profiler, { id: name, onRender: probeFor(name).report }, children)
}

/** 诊断快照：每个探针当前窗口里的提交次数（开发者面板 / 自检脚本用）。 */
export function stormCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, probe] of probes) out[name] = probe.count()
  return out
}

/** 全部探针归零（换会话 / 自检之间互不干扰）。 */
export function resetStormProbes(): void {
  for (const probe of probes.values()) probe.reset()
}
