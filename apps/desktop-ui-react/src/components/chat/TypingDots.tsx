import { cn } from '../../lib/cn'
import { motionOn } from '../../lib/motionPref'

/* ── 生成中的三点跳动 ──
 *
 * 现状：只有「没有正文、也没有工具」时才有一句「正在思考…」；正文一开始就再没有任何存活信号，
 * 用户会以为卡死了。这里给一个只要还在流式就一直挂着的动效信号。
 *
 * 实现约束：styles/ 下的 CSS 不允许改（并行同事在改样式），所以 keyframes 只能随组件自带。
 * 三个点共用一条 keyframes，只错开 animation-delay（0 / 0.15 / 0.30s），周期 1s。
 * 关掉动效（设置开关或系统「减少动态效果」）时退化为**静态三点**：信息（还活着）留着，只是不跳；
 * 系统级 prefers-reduced-motion 另有一条媒体查询兜底，用户中途改系统设置也会立刻生效。 */

const KEYFRAMES = `
@keyframes coomi-typing-dot {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
  30% { transform: translateY(-3px); opacity: 1; }
}
.coomi-typing-dot { animation: coomi-typing-dot 1s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .coomi-typing-dot { animation: none; opacity: 0.7; }
}
`

export function TypingDots({ className }: { className?: string }) {
  /// motionOn() 同时看设置开关与系统偏好；两个来源任一关掉都不跳（与 JS 动画同一判据）。
  const animated = motionOn()
  return (
    <>
      {/* keyframes 单独放，不进 role=status 的存活区：读屏只该听到「正在生成」，不该读到样式文本。 */}
      <style>{KEYFRAMES}</style>
      <span role='status' aria-label='正在生成' className={cn('inline-flex items-end gap-0.5 align-middle', className)}>
        {[0, 0.15, 0.3].map((delay) => (
          <span
            key={delay}
            aria-hidden
            className='coomi-typing-dot h-1 w-1 rounded-full bg-ink-3'
            data-loop-anim
            /// 关掉动效时用内联 animation:none 压掉类里的 animation（内联样式优先级更高）。
            style={animated ? { animationDelay: delay + 's' } : { animation: 'none', opacity: 0.7 }}
          />
        ))}
      </span>
    </>
  )
}
