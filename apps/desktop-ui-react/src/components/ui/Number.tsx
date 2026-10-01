/**
 * 数字滚动：@number-flow/react 在项目里的唯一落点，页面里不再各写一套插值/弹跳。
 *
 * 为什么收口成一个组件：换库之前 StatsBar 是「rAF 手动插值（连续量）+ key 重挂播
 * num-pop（离散量）」两套逻辑，位数一变还会左右抖；number-flow 自己管
 * 「旧数字滚出去 / 新数字滚进来」，位数、千分位、前后缀都跟着一起补间，
 * 并且默认 respectMotionPreference —— 系统「减少动态效果」时自动退化成静态数字。
 *
 * 单位（s / ms / % / tok/s）一律用 suffix 交给库：数字和单位在同一个元素里，
 * 宽度由库自己补间，不会出现「数字滚完了、单位还在原地跳一格」。
 *
 * 右侧栏统计页（DockUsageTab / DockContextTab 等）直接引这里的组件即可，
 * 不要再各自 toFixed —— 该保留几位小数是这一层的事。
 */
import NumberFlow, { useIsSupported, type Format } from '@number-flow/react'
import { cn } from '../../lib/cn'

export interface AnimatedNumberProps {
  /** 目标值；null / undefined / NaN 一律显示占位符（默认「—」），不渲染一块空白。 */
  value: number | null | undefined
  /** Intl.NumberFormatOptions（number-flow 只额外禁掉 scientific / engineering）。 */
  format?: Format
  locales?: Intl.LocalesArgument
  prefix?: string
  suffix?: string
  className?: string
  title?: string
  placeholder?: string
}

/** 一个会滚动的数字。全站唯一的数字滚动实现。 */
export function AnimatedNumber({
  value, format, locales = 'en-US', prefix, suffix, className, title, placeholder = '—',
}: AnimatedNumberProps) {
  const supported = useIsSupported()

  if (value == null || !Number.isFinite(value)) {
    return <span className={cn('tabular-nums text-ink-4', className)} title={title}>{placeholder}</span>
  }

  // 老内核不支持 @property / 线性缓动时，number-flow 只会画出第一帧；
  // 这里直接给格式化好的静态文本，读数一定是对的，只是没有补间。
  if (!supported) {
    const text = new Intl.NumberFormat(locales, format).format(value)
    return (
      <span className={cn('tabular-nums', className)} title={title}>
        {prefix}{text}{suffix}
      </span>
    )
  }

  return (
    <NumberFlow
      value={value}
      locales={locales}
      format={format}
      prefix={prefix}
      suffix={suffix}
      title={title}
      className={cn('tabular-nums', className)}
    />
  )
}

/** 秒数：<60 用一位小数；≥60 拆成「分 + 秒」两段，两段各自滚动（1m30s 而不是 90.0s）。 */
export function AnimatedSeconds({ seconds, className, title }: {
  seconds: number | null | undefined
  className?: string
  title?: string
}) {
  // 量化到显示精度再交给库：上游是每帧都在长的毫秒数，不量化会变成每秒几十次补间。
  const s = seconds == null || !Number.isFinite(seconds) ? null : Math.round(seconds * 10) / 10
  if (s == null) return <AnimatedNumber value={null} className={className} title={title} />

  if (s < 60) {
    return (
      <AnimatedNumber
        value={s}
        className={className}
        title={title}
        format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
        suffix='s'
      />
    )
  }

  let minutes = Math.floor(s / 60)
  let rest = Math.round(s % 60)
  // 59.6s 进位后会得到 1m60s：把溢出的那一秒挪进分钟，读数才不会出现 60 秒。
  if (rest === 60) { minutes += 1; rest = 0 }
  return (
    <span className={cn('inline-flex items-baseline tabular-nums', className)} title={title}>
      <AnimatedNumber value={minutes} format={{ maximumFractionDigits: 0 }} suffix='m' />
      <AnimatedNumber value={rest} format={{ maximumFractionDigits: 0 }} suffix='s' />
    </span>
  )
}

/** 毫秒耗时：不到 1 秒按整数毫秒显示，超过就交给 AnimatedSeconds。 */
export function AnimatedDuration({ ms, className, title }: {
  ms: number | null | undefined
  className?: string
  title?: string
}) {
  if (ms == null || !Number.isFinite(ms)) return <AnimatedNumber value={null} className={className} title={title} />
  if (ms < 1000) {
    return <AnimatedNumber value={Math.round(ms)} className={className} title={title} format={{ maximumFractionDigits: 0 }} suffix='ms' />
  }
  return <AnimatedSeconds seconds={ms / 1000} className={className} title={title} />
}

/** token 数：紧凑计数。固定 en-US —— zh-CN 会输出「万 / 亿」，
    和卡片旁边旧文案里的 k / M 读法对不上。 */
export function AnimatedTokens({ value, className, title }: {
  value: number | null | undefined
  className?: string
  title?: string
}) {
  return (
    <AnimatedNumber
      value={value == null || !Number.isFinite(value) ? null : Math.round(value)}
      className={className}
      title={title}
      format={{ notation: 'compact', maximumFractionDigits: 1 }}
    />
  )
}

/** 0–1 的比率 → 整数百分比（缓存命中率这类）。 */
export function AnimatedPercent({ ratio, className, title }: {
  ratio: number | null | undefined
  className?: string
  title?: string
}) {
  return (
    <AnimatedNumber
      value={ratio == null || !Number.isFinite(ratio) ? null : Math.round(ratio * 100)}
      className={className}
      title={title}
      format={{ maximumFractionDigits: 0 }}
      suffix='%'
    />
  )
}

/** 纯整数（轮 / 步 / 条数）：不写 format，交给库按默认分组规则走。 */
export function AnimatedCount({ value, className, title }: {
  value: number | null | undefined
  className?: string
  title?: string
}) {
  return (
    <AnimatedNumber
      value={value == null || !Number.isFinite(value) ? null : Math.round(value)}
      className={className}
      title={title}
      format={{ maximumFractionDigits: 0 }}
    />
  )
}
