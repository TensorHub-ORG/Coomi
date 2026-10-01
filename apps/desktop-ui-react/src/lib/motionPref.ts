/**
 * 动效开关的运行时判断。
 *
 * base.css 里那套做法是「把动效令牌归零」（[data-motion=off] 与 prefers-reduced-motion
 * 同一套待遇），CSS 动画因此自动降级；JS 动画（motion/LazyMotion + m）读不到 CSS 变量，
 * 就得在这里问同一件事——两边的判据必须一致，否则设置里关了动效 JS 还在动。
 */

/** 现在允许播动效吗（设置里的「动效」开关 + 系统「减少动态效果」）。 */
export function motionOn(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (document.documentElement.dataset.motion === 'off') return false
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 错峰步长（秒）。关掉动效时返回 0：延迟也没必要留。 */
export function staggerSeconds(step = 0.03): number {
  return motionOn() ? step : 0
}
