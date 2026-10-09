/**
 * 数字滚动（自研）：全站唯一的数字滚动实现。
 *
 * 为什么不用 @number-flow/react：
 *   1. 它靠 useIsSupported() 探测能力再决定是否补间 —— 探测结果受时机影响，
 *      于是同一个界面时而动、时而静（用户反馈「数字有时动有时不动」）。
 *   2. 补间期间它改宽度（位数滚动），输入栏因此重排闪烁。
 *   3. 无法与本项目自己的降级策略（prefers-reduced-motion / html[data-motion]）统一。
 * 自研把这三点都根治：能力探测删掉、只动不透明度不碰布局、降级自己判。
 *
 * 动效约定（全站统一）：
 *   · 只动 transform / opacity，**不改变任何影响布局的属性**（tabular-nums 固定数字宽）
 *   · animate=false 时直接跳到目标值：切会话属于「换了个数」，不是「这个数在长」，
 *     补间反而是错的 —— 这也是「动不动画取决于工作目录」的根因。
 *   · 减动效（系统 or html[data-motion=off]）时同样直接跳。
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn'

type Format = Intl.NumberFormatOptions

/** 补间时长：跨度小则短、跨度大则长；上限 700ms，避免长时间占用主线程。 */
function durationFor(from: number, to: number): number {
  const d = Math.abs(to - from)
  if (d <= 0) return 0
  if (d < 5) return 240
  if (d < 50) return 380
  return 700
}

/** 三次缓出：起步快、收尾慢，与全局 --ease-out 同族。 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/** 系统级与 App 内开关两入口都要认。 */
function reducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  const sys = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const app = document.documentElement.dataset.motion === 'off'
  return sys || app
}

/**
 * 数字补间，返回当前应显示的值。
 * @param value 目标值（null/NaN 走占位符）
 * @param animate 是否补间；切会话 / 减动效 / 首次出现都直接跳
 */
function useCountUp(value: number | null, animate: boolean): number | null {
  const [shown, setShown] = useState<number | null>(value)
  const fromRef = useRef<number | null>(value)
  const rafRef = useRef(0)

  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    if (value == null) {
      fromRef.current = null
      setShown(null)
      return
    }
    const from = fromRef.current
    if (from == null || !animate || reducedMotion() || from === value) {
      fromRef.current = value
      setShown(value)
      return
    }
    const dur = durationFor(from, value)
    const t0 = performance.now()
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / dur)
      if (p < 1) {
        setShown(from + (value - from) * easeOutCubic(p))
        rafRef.current = requestAnimationFrame(step)
      } else {
        fromRef.current = value
        setShown(value)
        rafRef.current = 0
      }
    }
    rafRef.current = requestAnimationFrame(step)
    // 依赖变化时把「当前显示值」记成新起点：中途再变也能平滑接上
    return () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [value, animate])

  return shown
}

export interface AnimatedNumberProps {
  /** 目标值；null / undefined / NaN 一律显示占位符（默认「—」），不渲染空白。 */
  value: number | null | undefined
  /** 是否补间到目标值。切会话这类「值换了但不该滚动」的场景传 false。 */
  animate?: boolean
  /** Intl.NumberFormatOptions。 */
  format?: Format
  locales?: string | string[]
  prefix?: string
  suffix?: string
  className?: string
  title?: string
  placeholder?: string
}

/** 一个会滚动的数字。全站唯一实现。 */
export function AnimatedNumber({
  value, animate = true, format, locales = 'en-US', prefix, suffix, className, title, placeholder = '—',
}: AnimatedNumberProps) {
  const shown = useCountUp(value == null || !Number.isFinite(value) ? null : value, animate)
  if (shown == null) {
    return <span className={cn('tabular-nums text-ink-4', className)} title={title}>{placeholder}</span>
  }
  /* 必须是**普通 inline**（不能是 inline-block，更不能加 contain）。
   * inline-block 与 contain: layout 都会让这个 span 变成独立格式化上下文，
   * 它的基线改按自身内容算 —— 于是数字整体比旁边的「轮 / LLM」等文字高出一截。
   * 宽度抖动由父层的 items-baseline + tabular-nums 兜住，不靠这里加 contain。 */
  return (
    <span className={cn('tabular-nums', className)} title={title}>
      {prefix}{new Intl.NumberFormat(locales, format).format(shown)}{suffix}
    </span>
  )
}

/** 秒数：<60 一位小数；≥60 拆「分 + 秒」两段各自滚动（1m30s 而不是 90.0s）。 */
export function AnimatedSeconds({ seconds, className, title, animate }: {
  seconds: number | null | undefined
  className?: string
  title?: string
  animate?: boolean
}) {
  // 量化到显示精度再补间：上游是每帧都在长的毫秒数，不量化会每秒重绘几十次
  const s = seconds == null || !Number.isFinite(seconds) ? null : Math.round(seconds * 10) / 10
  if (s == null) return <AnimatedNumber value={null} className={className} title={title} />
  if (s < 60) {
    return (
      <AnimatedNumber
        value={s}
        animate={animate}
        className={className}
        title={title}
        format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
        suffix='s'
      />
    )
  }
  return (
      // 同样用普通 inline：inline-flex 也会脱离基线，「1m30s」会比旁边文字高
      <span className={cn('whitespace-nowrap', className)} title={title}>
      <AnimatedNumber value={Math.floor(s / 60)} animate={animate} format={{ maximumFractionDigits: 0 }} />
      <span>m</span>
      <AnimatedNumber value={Math.round(s % 60)} animate={animate} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
      <span>s</span>
    </span>
  )
}

/** 毫秒时长：<1s 显示整数毫秒，≥1s 走秒。 */
export function AnimatedDuration({ ms, className, title, animate }: {
  ms: number | null | undefined
  className?: string
  title?: string
  animate?: boolean
}) {
  if (ms == null || !Number.isFinite(ms)) return <AnimatedNumber value={null} className={className} title={title} />
  if (ms < 1000) {
    return (
      <AnimatedNumber
        value={Math.round(ms)}
        animate={animate}
        className={className}
        title={title}
        format={{ maximumFractionDigits: 0 }}
        suffix='ms'
      />
    )
  }
  return <AnimatedSeconds seconds={ms / 1000} className={className} title={title} animate={animate} />
}

/** token 数：紧凑记法（k / M），与卡片角落旧文案的读法对齐。 */
export function AnimatedTokens({ value, className, title, animate }: {
  value: number | null | undefined
  className?: string
  title?: string
  animate?: boolean
}) {
  return (
    <AnimatedNumber
      value={value == null || !Number.isFinite(value) ? null : Math.round(value)}
      animate={animate}
      className={className}
      title={title}
      format={{ notation: 'compact', maximumFractionDigits: 1 }}
    />
  )
}

/** 0–1 的比率 → 整数百分数（缓存命中率这类指标）。 */
export function AnimatedPercent({ ratio, className, title, animate }: {
  ratio: number | null | undefined
  className?: string
  title?: string
  animate?: boolean
}) {
  return (
    <AnimatedNumber
      value={ratio == null || !Number.isFinite(ratio) ? null : Math.round(ratio * 100)}
      animate={animate}
      className={className}
      title={title}
      format={{ maximumFractionDigits: 0 }}
      suffix='%'
    />
  )
}

/** 纯整数（轮 / 步 / 次数）。 */
export function AnimatedCount({ value, className, title, animate }: {
  value: number | null | undefined
  className?: string
  title?: string
  animate?: boolean
}) {
  return (
    <AnimatedNumber
      value={value == null || !Number.isFinite(value) ? null : Math.round(value)}
      animate={animate}
      className={className}
      title={title}
      format={{ maximumFractionDigits: 0 }}
    />
  )
}
