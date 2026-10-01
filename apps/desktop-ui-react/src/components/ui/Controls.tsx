import { startTransition, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import * as RadixSwitch from '@radix-ui/react-switch'
import { cn } from '../../lib/cn'
// 切页过渡的「让路」闸门（components/shell/navPause）：只依赖 react，方向是 ui → shell 的单向依赖，
// 不会成环。分段控件与外壳的过渡共用同一个判据（html[data-nav-busy]），不另立一套。
import { navPauseBusy, queueDuringNavPause, usePaneActive } from '../shell/navPause'
import { pressFeedback } from './Button'

/** 乐观选中的最长存活时间：父级没接受这次选择时用它回落，避免高亮一直停在旧答案上。 */
const OPTIMISTIC_MS = 600

/** 开关：轨道只切颜色，滑块只动 transform，深浅色都保持「一眼看出状态」。
    尺寸 24×40、内边距 4、滑块 16 —— 全部落在 4px 网格上；
    焦点交给 base.css 的统一焦点环（--focus-ring*），这里不另画一条。 */
export function Switch({ checked, onCheckedChange, disabled, className, 'aria-label': ariaLabel }: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}) {
  return (
    <RadixSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'relative h-6 w-10 shrink-0 rounded-full border transition-[background-color,border-color,box-shadow] duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
        'border-line-strong bg-control-2 shadow-press',
        'hover:border-ink-4',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:hover:border-primary-hover',
        'disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-line-strong',
        'data-[state=checked]:disabled:hover:border-primary',
        className,
      )}
    >
      {/* 滑块：translate-x 从 4px 走到 20px，只动 transform，不碰 left。 */}
      <RadixSwitch.Thumb className='block size-4 translate-x-[4px] rounded-full bg-white shadow-elev-1 transition-transform duration-[var(--motion-base)] ease-[var(--ease-spring)] data-[state=checked]:translate-x-[20px]' />
    </RadixSwitch.Root>
  )
}

/** 分段控件：2–4 个互斥选项，比下拉更省点击。
    「滑块」是一层独立指示器，几何**实测**（子项 rect + ResizeObserver），
    切换时横向滑过去而不是硬切（只动 transform / opacity，宽度与位置由 JS 量出来）。
    为什么不按序号乘百分比算：绝对定位元素的百分比是按容器 padding box 解析的，
    再叠上 flex 的 4px 间隙，n≥3 时最右一格会顶出容器（选中最后一项时高亮框溢出）。

    三件与「切页那一拍」有关的事，都在下面按职责分开：
    ① 观测器接过渡闸门（navPauseBusy）：过渡那 250ms 里每次回调都去读 rect，就是跟
       拍快照/合成新旧两页抢一次强制同步布局 —— 闸门开着只记一笔，收闸时合并成一次测量；
    ② 隐藏时量到的是 0 宽，不是「窄」：直接跳过并保留上一次的几何，可见时再补测；
    ③ 按下反馈由 pressFeedback() 直接写在 DOM 上、选中项走乐观本地态，
       两者都不等这次点击的 React 重渲染（重活丢给 startTransition）。 */
export function Segmented<T extends string>({ value, options, onChange, className, ariaLabel, size = 'sm', disabled }: {
  value: T
  options: Array<{ value: T; label: React.ReactNode }>
  onChange: (v: T) => void
  className?: string
  ariaLabel?: string
  /** sm = 设置项里的紧凑档；lg = 页面级分页签。 */
  size?: 'sm' | 'lg'
  /** 整组禁用：画面上仍然看得出选中的是哪一项，只是点不动。 */
  disabled?: boolean
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  /// 排队用的 key 必须按实例分开：全站共用一张排队表，同 key 只留最后一次。
  const queueKey = useId()
  /// 页面 pane 是否在前台（ViewSlot 注入）：隐藏的那一页不观察、不测量。
  const paneActive = usePaneActive()
  /// 乐观选中：点击那一刻本地先顶上（urgent），指示器当帧就滑过去；
  /// onChange 引发的那趟重活丢给 startTransition（见 select）。
  const [tap, setTap] = useState<{ v: T; base: T } | null>(null)
  /// base 对不上 value ＝ 父级已经把新值顶上来 → 乐观值自动作废，不需要 effect 去清。
  const active = tap !== null && tap.base === value ? tap.v : value
  const index = Math.max(0, options.findIndex((o) => o.value === active))
  const [box, setBox] = useState<{ left: number; width: number } | null>(null)
  /// 量到过几何没有：环境触发的重测据此判断这次压不压得起（见 measureAmbient）。
  const measured = useRef(false)

  /// 实测被选中子项的几何，而不是按序号乘百分比。
  /// 原来那套 left = 4px + i*(100%-8px)/n + i*4px 有两个错：
  /// ① 绝对定位元素的百分比是按容器的 **padding box** 解析的，却被当成内容宽用；
  /// ② 公式里漏掉了 flex 的 4px 间隙。两者叠加，n>=3 时最右一格会顶出容器 4~8px
  ///    （选中最后一项时高亮框明显溢出，就是这个）。
  const measureNow = useCallback((): void => {
    const host = hostRef.current
    if (!host) return
    const item = host.querySelectorAll<HTMLElement>('[data-seg-item]')[index]
    if (!item) return
    const hostRect = host.getBoundingClientRect()
    const rect = item.getBoundingClientRect()
    /// 取不到几何时量出来的是 0，不是「窄」：收起的面板（右侧栏收到 0 宽）、
    /// display:none 的浮层、还没落位的挂载帧都会量到 0。这一拍**跳过并保留上一次的几何** ——
    /// 0 宽的指示器比「停在上一次的位置」更糟（高亮框直接消失，还会贴到最左边）。
    /// 等它可见时 ResizeObserver 会再叫一次：0 → N 的尺寸变化本身就是它的触发条件。
    if (hostRect.width < 1 || hostRect.height < 1 || rect.width < 1) return
    measured.current = true
    // host.clientLeft = 左边框宽：绝对定位的 left 相对 padding box，先扣掉它，再左右各内缩 1px。
    const next = {
      left: rect.left - hostRect.left - host.clientLeft + 1,
      width: Math.max(0, rect.width - 2),
    }
    // 值没变就不 setState：否则 ResizeObserver 的每次回调都要多渲染一轮。
    setBox((prev) => (prev && Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.width - next.width) < 0.5 ? prev : next))
  }, [index])

  /// 环境触发的重测（观测器 / 窗口换宽 / 重新露面）：切页过渡那一拍让路。
  /// 闸门开着的 250ms 里主线程在拍旧页快照、合成新旧两张、挂目标页正文，
  /// 这时每次 ResizeObserver 回调都去 getBoundingClientRect，就是跟过渡抢一次强制同步布局。
  /// 所以只记一笔，交给 queueDuringNavPause 在收闸时**合并成一次**执行
  ///（同 key 只留最后一次，连点导航也只会补测一次）。
  /// 例外：还没量到过几何（指示器压根没出现，或刚从 0 宽恢复）时必须真量，
  /// 压掉就等于它 250ms 不出现 —— 那比丢几帧更难解释。
  const measureAmbient = useCallback((): void => {
    if (navPauseBusy() && measured.current) { queueDuringNavPause(queueKey, measureNow); return }
    measureNow()
  }, [measureNow, queueKey])

  // 布局阶段量一次：指示器不会先在错误的位置出现再跳过去。
  // 这一拍**不过闸门**：换选中项时指示器必须当帧跟上，压到收闸再量就等于半秒不动。
  useLayoutEffect(() => { measureNow() }, [measureNow])

  useEffect(() => {
    // 隐藏页（「上一次」那一页）不观察：它 inert + opacity:0，量尺寸、挂观测器都是空转。
    // 它重新变成前台页时这个 effect 会重跑，那时补测一次（隐藏期间量到的 0 不会落进 box）。
    if (!paneActive) return
    const host = hostRef.current
    if (!host) return
    measureAmbient()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureAmbient)
    // 容器与每个子项都要观察：字体加载完、文案变长、窗口换宽都会改变实测宽度。
    if (observer) {
      observer.observe(host)
      host.querySelectorAll('[data-seg-item]').forEach((el) => observer.observe(el))
    }
    window.addEventListener('resize', measureAmbient)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measureAmbient)
    }
  }, [measureAmbient, paneActive])

  /// 父级没接受这次选择（value 一直没变）时，乐观态不能永远停在那：超时自己回落。
  /// 接受了的话 value 会先变、active 已经等于 value，这次 setTap 只是把状态清干净。
  useEffect(() => {
    if (!tap) return
    const timer = window.setTimeout(() => setTap(null), OPTIMISTIC_MS)
    return () => window.clearTimeout(timer)
  }, [tap])

  /// 选中一项：按下反馈已经在 pointerdown 落过了；这里让指示器当帧跟手（乐观、urgent），
  /// 而 onChange 引发的那趟（长列表重排、切分组、取数）丢给 startTransition 在后台跑。
  /// 直接把 onChange 当普通更新发出去的话，「高亮滑过去」和「整页重渲染」是同一次提交，
  /// 反馈就被那次重渲染压在后面了 —— 这正是要把它拆开的原因。
  const select = (next: T): void => {
    if (disabled || next === value) return
    setTap({ v: next, base: value })
    startTransition(() => { onChange(next) })
  }

  // 滑动方向：往右走就从左边滑进来（--seg-step 取正），往左走反过来。
  const prev = useRef(index)
  useEffect(() => { prev.current = index }, [index])
  const dir = index >= prev.current ? 1 : -1
  const step = box ? (box.width + 4) * dir + 'px' : '0px'

  return (
    <div
      ref={hostRef}
      role='group'
      aria-label={ariaLabel}
      data-seg
      data-disabled={disabled ? 'true' : undefined}
      className={cn(
        // overflow-hidden：兜底裁切，正常情况由实测几何保证指示器本来就贴合。
        'relative inline-flex items-center gap-1 overflow-hidden rounded-md border border-line-strong bg-control-2 p-1',
        disabled && 'opacity-60',
        className,
      )}
    >
      {/* 量到几何之前不渲染：否则它会先在 left:0 出现，再「跳」到选中项上。
          key={active} 让切换时这一层重新挂载，animate-seg-indicator 才会重播一次
          （乐观切换也走这里，所以指示器在点击那一帧就开始滑，不等 onChange 的那趟渲染）。 */}
      {box ? (
        <span
          key={active}
          aria-hidden
          data-seg-indicator
          className='pointer-events-none absolute bottom-1 top-1 animate-seg-indicator rounded-xs border border-line-strong bg-control shadow-elev-1'
          style={{ left: box.left, width: box.width, ['--seg-step' as string]: step }}
        />
      ) : null}
      {options.map((o) => (
        <button
          key={o.value}
          type='button'
          data-size={size}
          data-seg-item
          disabled={disabled}
          aria-pressed={active === o.value}
          // 按下反馈：pointerdown 那一拍直接写 DOM（下一帧就是按下态），不等这次点击的重渲染。
          onPointerDown={(e) => pressFeedback(e.currentTarget)}
          onClick={() => select(o.value)}
          className={cn(
            'relative z-[1] h-6 flex-1 whitespace-nowrap rounded-xs border border-transparent px-3 text-12',
            // 尺寸由使用处决定：不给固定高度，页面级分页签可以写成 h-7 text-13。
            'data-[size=lg]:h-7 data-[size=lg]:px-4 data-[size=lg]:text-13',
            'transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
            active === o.value ? 'font-medium text-ink' : 'text-ink-3 hover:bg-surface/60 hover:text-ink-2 active:bg-active',
            // 按下态（背景 + 一点点缩放）：由 pressFeedback 写在 DOM 上，与 :active 那一路并存。
            // scale 是独立的 scale 属性、不在 transition-colors 的列表里 —— 瞬时生效，正是想要的。
            'data-[pressed=1]:bg-active data-[pressed=1]:text-ink data-[pressed=1]:scale-[.97]',
            'disabled:cursor-not-allowed disabled:hover:bg-transparent',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 进度条：轨道取 sunken 档，填充只动 width（不重排）。
    语义色由 tone 决定，默认 primary；带 role=progressbar 与百分比读数。 */
export function Progress({ value, tone = 'primary', className }: {
  /** 0–1 的完成度；超出范围会被夹到 0–1。 */
  value: number
  tone?: 'primary' | 'ok' | 'warn' | 'danger'
  className?: string
}) {
  const ratio = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  const tones: Record<string, string> = {
    primary: 'bg-primary',
    ok: 'bg-ok',
    warn: 'bg-warn',
    danger: 'bg-danger',
  }
  return (
    <div
      role='progressbar'
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-sunken', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-[var(--motion-base)] ease-[var(--ease-out-quint)]', tones[tone])}
        style={{ width: ratio * 100 + '%' }}
      />
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent', className)}
      aria-hidden
    />
  )
}

/** 骨架屏：加载态统一形状，别再写「加载中…」这三个字。
    底色取 sunken（写 bg-surface-sunken 在 v4 里不会生成，骨架会变成透明的）；
    只动 opacity 的 pulse（在 [data-motion=off] / prefers-reduced-motion 下由 base.css 停掉）。 */
export function Skeleton({ className, style, lines = 1, circle }: {
  className?: string
  style?: React.CSSProperties
  /** 多行文本骨架：最后一行短一截，看起来才像文字。 */
  lines?: number
  circle?: boolean
}) {
  // data-skeleton / animate-skeleton：关掉动效时由 base.css 统一停掉呼吸动画
  const bar = cn('animate-skeleton animate-pulse bg-sunken', circle ? 'rounded-full' : 'rounded-md')
  if (lines <= 1) return <span aria-hidden style={style} className={cn(bar, 'block h-3 w-full', className)} />
  return (
    <span aria-hidden style={style} className={cn('block w-full', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className={cn(bar, 'mb-2 block h-3', i === lines - 1 ? 'w-[58%]' : i % 2 ? 'w-[86%]' : 'w-full')}
        />
      ))}
    </span>
  )
}

/** 内容交换容器：切换分组/页签时重放一次入场动画，但**不重挂载子节点**。
    做法是把动画类摘掉、等两帧再挂回去：DOM 结构与 React 状态全程保留，
    只有动画重新播一次。用 key 重挂载会丢滚动位置与内部展开态，这里刻意不这么做。 */
export function SwapIn({ token, className, children }: {
  /** 变化即重放（例如 'models' 或 'tools:builtin'）。 */
  token: string
  className?: string
  children: React.ReactNode
}) {
  const [ready, setReady] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; setReady(true); return }
    setReady(false)
    let inner = 0
    const outer = window.requestAnimationFrame(() => { inner = window.requestAnimationFrame(() => setReady(true)) })
    return () => { window.cancelAnimationFrame(outer); if (inner) window.cancelAnimationFrame(inner) }
  }, [token])
  return <div className={cn(className, ready && 'animate-page')}>{children}</div>
}

/** 卡片骨架：产物页与技能页的首屏加载用同一副骨架，避免各画各的。 */
export function SkeletonCard({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div style={style} className={cn('rounded-lg border border-line bg-surface p-4 elev-1', className)}>
      <div className='flex items-start gap-3'>
        <Skeleton circle className='h-10 w-10 shrink-0' />
        <div className='min-w-0 flex-1'>
          <Skeleton className='h-3.5 w-[46%]' />
          <Skeleton className='mt-2 h-3 w-[72%]' />
        </div>
      </div>
      <Skeleton className='mt-3 h-3 w-[88%]' />
    </div>
  )
}

/** 列表行骨架：目录 / 会话 / 条目列表通用。 */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div aria-busy='true' className={cn('flex flex-col gap-1.5 p-1', className)} data-skeleton>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className='flex h-8 items-center gap-2 px-2'>
          <Skeleton circle className='h-4 w-4 shrink-0' />
          <Skeleton className='h-3 shrink-0' style={{ width: 38 + ((i * 13) % 42) + '%' }} />
        </div>
      ))}
    </div>
  )
}
