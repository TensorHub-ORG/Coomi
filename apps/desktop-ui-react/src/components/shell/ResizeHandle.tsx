/**
 * 左右两侧共用的分隔条（拖拽调整宽度）。
 *
 * 两种形态共用同一份视觉与同一套说法：
 * - PanelSeparator：面板组的真分隔条（react-resizable-panels 的 Separator）。
 *   命中区、键盘（←/→/Home/End/Enter）、双击复位、ARIA 全部由面板库提供，
 *   这里只负责「长什么样」——1px 线 + 悬停/聚焦/拖动时浮出的 3 个抓握点。
 *   状态由面板库写在 data-separator 上（inactive / hover / focus / active / disabled）。
 * - ResizeHandle：手写拖拽的老实现，只有「窄窗口抽屉」这个浮层还在用
 *   （浮层不是面板组的子节点，进不了 Group/Panel 那一套）。
 *
 * 约定：
 * - 命中区 8px，视觉只有正中 1px 线，hover / 聚焦 / 拖动时变主色，并浮出 3 个抓握点
 * - 双击复位到调用方给的宽度
 * - 拖动期间 body 上挂 col-resize 与 user-select:none，鼠标移出窗口也不丢
 */
import { useState } from 'react'
import { Separator } from 'react-resizable-panels'
import { cn } from '../../lib/cn'

/** 命中区宽度：视觉只有 1px 线，但鼠标要 8px 才抓得住。 */
export const RESIZE_HIT_W = 8
/** 键盘单次调整步长与 Shift 加速倍数（手写那条老路径用；面板库自己管键盘步长）。 */
export const RESIZE_STEP = 16
export const RESIZE_SHIFT_MULTIPLIER = 4
/** 手柄的固定提示语：两个入口共用一套说法，用户不必猜。 */
export const RESIZE_HINT = '拖动调整宽度 · 双击复位'

export function clampWidth(next: number, min: number, max: number): number {
  if (!Number.isFinite(next)) return min
  return Math.min(max, Math.max(min, Math.round(next)))
}

/** 分隔条的视觉：正中 1px 线 + 3 个抓握点。状态钩子全挂在 group/sep 上。 */
function HandleVisual() {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line',
          'transition-colors duration-[var(--motion-fast)]',
          'group-hover/sep:bg-primary group-focus-visible/sep:bg-primary',
          'group-data-[separator=active]/sep:bg-primary',
        )}
      />
      {/* 抓握点在禁用时不出：此时拖不动，浮出来只会骗人 */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none relative flex flex-col items-center gap-[3px] rounded-full px-[2px] py-1.5',
          'opacity-0 transition-opacity duration-[var(--motion-fast)]',
          'group-hover/sep:opacity-100 group-focus-visible/sep:opacity-100',
          'group-data-[separator=active]/sep:opacity-100',
          'group-data-[separator=disabled]/sep:!opacity-0',
        )}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              'h-[3px] w-[3px] rounded-full bg-ink-4 transition-colors duration-[var(--motion-fast)]',
              'group-hover/sep:bg-primary group-focus-visible/sep:bg-primary',
              'group-data-[separator=active]/sep:bg-primary',
            )}
          />
        ))}
      </span>
    </>
  )
}

/** 面板组里的分隔条：宽度约束、键盘可达、双击复位都交给 react-resizable-panels，
    调用方只需要给 id / 无障碍名称，以及「双击回到多宽」。 */
export function PanelSeparator({ separatorId, label, disabled, onReset, onInteractStart, onInteractEnd, className }: {
  /** 面板库用它当 DOM id / data-testid，同一组里必须唯一。 */
  separatorId: string
  /** 无障碍名称，例如「调整侧栏宽度」。 */
  label: string
  disabled?: boolean
  /** 双击复位：由调用方把对应面板 resize 回默认宽度。 */
  onReset?: () => void
  /** 拖拽/方向键调整的开始与结束：调用方据此只在「用户正在调」的时候落盘宽度。 */
  onInteractStart?: () => void
  onInteractEnd?: () => void
  className?: string
}) {
  return (
    <Separator
      id={separatorId}
      aria-label={label}
      onPointerDown={onInteractStart}
      onPointerUp={onInteractEnd}
      onPointerCancel={onInteractEnd}
      onKeyDown={onInteractStart}
      onKeyUp={onInteractEnd}
      title={disabled ? undefined : RESIZE_HINT}
      disabled={disabled}
      // 双击复位自己实现：面板的 defaultSize 取的就是「上次记住的宽度」，
      // 用库自带的复位等于原地不动，用户会以为双击坏了。
      disableDoubleClick={!!onReset}
      onDoubleClick={onReset}
      style={{ width: RESIZE_HIT_W }}
      className={cn(
        'group/sep relative z-20 flex touch-none select-none items-center justify-center outline-none',
        'data-[separator=disabled]:cursor-default',
        className,
      )}
    >
      <HandleVisual />
    </Separator>
  )
}

export interface ResizeHandleProps {
  /** 手柄贴目标的哪条边：left=左缘（向左拖变宽），right=右缘（向右拖变宽）。 */
  side: 'left' | 'right'
  /** 目标当前宽度（受控）。 */
  width: number
  min: number
  max: number
  onWidth: (next: number) => void
  /** 双击复位的宽度。 */
  defaultWidth: number
  /** 无障碍名称，例如「调整侧栏宽度」。 */
  label: string
  className?: string
  disabled?: boolean
  /** 拖拽比例：桌面栏位取 1；居中定位的浮层（左右两边对称伸缩）取 2，边线才会跟着指针走。 */
  rate?: number
}

export function ResizeHandle({
  side, width, min, max, onWidth, defaultWidth, label, className, disabled, rate = 1,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false)
  // 手柄在右缘：往右拖是变宽；在左缘：往左拖才是变宽。
  const dir = side === 'right' ? 1 : -1

  /// 拖动：pointermove 挂在 window 上，鼠标拖出面板甚至拖出窗口都不会断。
  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = width
    setDragging(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent): void => {
      onWidth(clampWidth(startWidth + dir * (ev.clientX - startX) * rate, min, max))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = RESIZE_STEP * (e.shiftKey ? RESIZE_SHIFT_MULTIPLIER : 1)
    onWidth(clampWidth(width + (e.key === 'ArrowRight' ? 1 : -1) * dir * step, min, max))
  }

  return (
    <div
      role='separator'
      aria-orientation='vertical'
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={disabled ? -1 : 0}
      title={RESIZE_HINT}
      data-resize-handle={side}
      data-dragging={dragging ? '' : undefined}
      onPointerDown={startResize}
      onDoubleClick={() => { if (!disabled) onWidth(clampWidth(defaultWidth, min, max)) }}
      onKeyDown={onKeyDown}
      style={{ width: RESIZE_HIT_W }}
      className={cn(
        'group/resize group/sep relative z-20 flex shrink-0 cursor-col-resize touch-none select-none items-center justify-center',
        'outline-none disabled:pointer-events-none',
        disabled && 'pointer-events-none opacity-0',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2',
          'transition-colors duration-[var(--motion-fast)]',
          dragging
            ? 'bg-primary'
            : 'bg-line group-hover/resize:bg-primary group-focus-visible/resize:bg-primary',
        )}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none relative flex flex-col items-center gap-[3px] rounded-full px-[2px] py-1.5',
          'transition-opacity duration-[var(--motion-fast)]',
          dragging ? 'opacity-100' : 'opacity-0 group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100',
        )}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              'h-[3px] w-[3px] rounded-full transition-colors duration-[var(--motion-fast)]',
              dragging ? 'bg-primary' : 'bg-ink-4 group-hover/resize:bg-primary group-focus-visible/resize:bg-primary',
            )}
          />
        ))}
      </span>
    </div>
  )
}
