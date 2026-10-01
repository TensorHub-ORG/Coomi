/** 设置页的分组导航 + 「分组内容旧出 / 新入」。
 *
 *  为什么单开一个文件：设置页的分组切换牵扯三件互相咬合的事，散在视图里会互相踩——
 *  ① GroupNav      左列分组导航，选中态是一层**独立滑块**（与 components/ui/Controls 的 Segmented
 *                  同一套思路：指示层绝对定位、只动 transform，不用重排），换分组时滑过去而不是硬切；
 *  ② GroupTransition 分组内容「旧出 + 新入」：AnimatePresence(mode='wait') + 方向变体，
 *                  方向按分组顺序——往后面的分组切，内容向上走（新的从下方入、旧的向上出）；
 *  ③ StaggerGrid / Stagger 卡片按 20ms 错峰入场（错峰靠 motion 的 staggerChildren，
 *                  逐个卡片包一层变体项；关掉动效或性能模式选「省电」时不包，直接静态渲染）。
 *
 *  滚动位置：全页共用一个滚动容器，所以每个分组的位置由调用方按 key 记（SettingsView 的 scrollMemo），
 *  新分组挂载时由 GroupTransition 放回去——原来的实现换分组会把上一个分组的位置带过去。
 */
import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, m, type Variants } from 'motion/react'
import { cn } from '../../lib/cn'
import { motionOn } from '../../lib/motionPref'
import { SettingsGrid, StaggerScope, staggerDelay, useStaggerIndex } from '../ui/Card'
import { useUi } from '../../stores/ui'
import { withDisplayName } from '../../lib/stormProbe'

/** 现在允许播设置页的过渡吗：设置里的「动效」开关 + 系统「减少动态效果」+ 性能模式「省电」档。
    三处任一说停就停，且与 CSS 那套（[data-motion=off] / [data-perf=low]）判据一致。 */
export function useGroupMotion(): boolean {
  const lowPerf = useUi((s) => s.prefs.perf === 'low')
  return motionOn() && !lowPerf
}

/* 方向变体：custom = 1 表示往后面的分组切（向上走），-1 表示往前面切（向下走）。
   AnimatePresence 的 custom 会传给正在退场的那一个，所以进出场方向始终一致。 */
const PANE_VARIANTS: Variants = {
  enter: (dir: number) => ({ opacity: 0, y: dir >= 0 ? 14 : -14 }),
  center: {
    opacity: 1,
    y: 0,
    // 这里**故意不用** staggerChildren：它只有步长、没有上限、也不会重置，
    // 一屏几十个控件排下来，越靠下的卡片延迟越大（「越往下出现越慢」就是这么来的）。
    // 错峰改成每个卡片自己按 min(i,5)×20ms 算（见下面的 StaggerItem）。
    transition: { duration: 0.2, ease: 'easeOut' },
  },
  exit: (dir: number) => ({ opacity: 0, y: dir >= 0 ? -10 : 10, transition: { duration: 0.14, ease: 'easeIn' } }),
}

/** 单张卡片的入场：只动 opacity / transform，卡片身上 .card-lift:hover 的位移不受影响。
    custom = 错峰延迟（秒），由 StaggerItem 按「作用域内第几个」算好传下来。 */
const ITEM_VARIANTS: Variants = {
  enter: { opacity: 0, y: 8 },
  center: (delay: number) => ({ opacity: 1, y: 0, transition: { duration: 0.18, ease: 'easeOut', delay } }),
  exit: { opacity: 0, transition: { duration: 0.1 } },
}

/** 错峰项：序号取自最近的作用域（分组 / Section，见 Card 的 StaggerScope），
    延迟 = min(i, 5) × 20ms —— 封顶之后，卡片再多也不会「越往下等得越久」。 */
function StaggerItem({ className, children }: { className?: string; children: React.ReactNode }) {
  const index = useStaggerIndex()
  return (
    <m.div custom={staggerDelay(index)} variants={ITEM_VARIANTS} className={className}>
      {children}
    </m.div>
  )
}

/** 关掉动效时用的静态变体：标签照旧传下去（结构不变），但什么都不动。 */
const STILL: Variants = { enter: { opacity: 1 }, center: { opacity: 1 }, exit: { opacity: 1 } }

export interface NavGroupSpec<G extends string> {
  key: G
  label: string
}

/** 左列分组导航：选中指示条是一层独立滑块，位置实测（offsetTop/offsetHeight），
    所以字号、密度、文案长度变化后它依然贴得住——不是写死的 38px 步长。 */
export function GroupNav<G extends string>({ groups, value, onChange, className }: {
  groups: ReadonlyArray<NavGroupSpec<G>>
  value: G
  onChange: (key: G) => void
  className?: string
}) {
  const hostRef = useRef<HTMLElement | null>(null)
  const [box, setBox] = useState<{ top: number; height: number } | null>(null)

  const measure = useCallback((): void => {
    const host = hostRef.current
    if (!host) return
    const item = host.querySelector<HTMLElement>('[data-nav-key="' + value + '"]')
    if (!item) return
    const next = { top: item.offsetTop, height: item.offsetHeight }
    // 值没变就不 setState：否则 ResizeObserver 的每次回调都触发一轮渲染。
    setBox((prev) => (prev && prev.top === next.top && prev.height === next.height ? prev : next))
  }, [value])

  // 布局阶段量一次：指示条不会先出现在错误的位置再跳过去。
  useLayoutEffect(() => { measure() }, [measure])

  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  const animated = useGroupMotion()
  const indicatorH = 18
  const y = box ? box.top + (box.height - indicatorH) / 2 : 0

  return (
    <nav ref={hostRef} className={cn('relative shrink-0', className)}>
      {/* 量到位置之前不渲染：否则它先在 y=0 出现，再「从顶部滑下来」。
          量到之后才挂载，initial 就等于当下的 y —— 首次是原地淡入，之后换分组才滑动。 */}
      {box ? (
        <m.span
          aria-hidden
          data-nav-indicator
          initial={{ y, opacity: 0 }}
          animate={{ y, opacity: 1 }}
          transition={animated ? { type: 'spring', stiffness: 520, damping: 34 } : { duration: 0 }}
          className='pointer-events-none absolute left-0.5 top-0 w-[3px] rounded-full bg-primary'
          style={{ height: indicatorH }}
        />
      ) : null}
      {groups.map((group) => {
        const active = group.key === value
        return (
          <button
            key={group.key}
            type='button'
            data-nav-key={group.key}
            aria-current={active || undefined}
            onClick={() => onChange(group.key)}
            className={cn(
              'relative mb-0.5 flex h-9 w-full items-center rounded-[8px] py-0 pl-3.5 pr-3 text-left text-13',
              'transition-[background-color,color,transform] duration-[var(--motion-fast)] ease-[var(--ease-enter)]',
              active ? 'bg-row-active text-ink' : 'text-ink-2 hover:translate-x-[1px] hover:bg-hover',
            )}
          >
            {group.label}
          </button>
        )
      })}
    </nav>
  )
}

/** 分组内容容器：旧分组先退场（向上/向下）、新分组随后入场，方向按分组顺序。
    外层 AnimatePresence 的 mode='wait' 保证「旧出 + 新入」不同时占位——
    两个分组同时在场会让 data-testid 重复、也会把滚动高度算乱。 */
export function GroupTransition({ groupKey, dir, scroller, scrollTop = 0, className, children }: {
  /** 分组 key：换 key 即换内容（AnimatePresence 靠它判断进出场）。 */
  groupKey: string
  /** 1＝往后面的分组切（向上走），-1＝往前面切。 */
  dir: number
  /** 分组共用滚动容器：新分组挂载时按 scrollTop 还原它自己的位置。 */
  scroller?: React.RefObject<HTMLElement | null>
  /** 这一分组上次离开时的滚动位置（px）。 */
  scrollTop?: number
  className?: string
  children: React.ReactNode
}) {
  const animated = useGroupMotion()

  useLayoutEffect(() => {
    const host = scroller?.current
    if (!host) return
    host.scrollTop = scrollTop
    // 内容高度要等字体与图片落位：再补一帧，避免长分组被当成「滚不动」而停在 0。
    const raf = window.requestAnimationFrame(() => { host.scrollTop = scrollTop })
    return () => window.cancelAnimationFrame(raf)
    // 只在挂载时跑：key 变了就是新分组，正好把这一组自己的滚动位置放回去。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <AnimatePresence mode='wait' initial={false} custom={dir}>
      <m.div
        key={groupKey}
        custom={dir}
        variants={animated ? PANE_VARIANTS : STILL}
        initial='enter'
        animate='center'
        exit='exit'
        className={className}
      >
        {/* 分组级错峰计数：整组从 0 开始数；组里的每个 Section 又会各自重置一次。 */}
        <StaggerScope>{children}</StaggerScope>
      </m.div>
    </AnimatePresence>
  )
}

/** 卡片错峰：把一组设置卡逐个包进变体项，父层（GroupTransition）用 staggerChildren 按 20ms 依次放行。
    只包一层 div（不重挂载卡片本身：Cell 的内部状态与 DOM 结构都不变），
    wide 的卡片由外层补上跨列，网格布局与原来一致。 */
export function StaggerGrid({ children, className }: {
  children: React.ReactNode
  className?: string
}) {
  const animated = useGroupMotion()
  const cells = useMemo(() => {
    if (!animated) return null
    return Children.toArray(children).map((child, index) => {
      const wide = isValidElement(child) && (child as { props?: { wide?: boolean } }).props?.wide === true
      const key = isValidElement(child) && child.key != null ? child.key : 'cell-' + index
      return (
        <StaggerItem key={key} className={cn('min-w-0', wide && 'lg:col-span-2')}>
          {child}
        </StaggerItem>
      )
    })
  }, [children, animated])
  // 关掉动效时不包：DOM 与原来一字不差，静态渲染。
  return <SettingsGrid className={className}>{animated && cells ? cells : children}</SettingsGrid>
}

/** 单块内容的错峰项（模型页那几张并列卡用它，卡片不在 SettingsGrid 里）。 */
export function Stagger({ children, className }: { children: React.ReactNode; className?: string }) {
  const animated = useGroupMotion()
  // 包一层 flex 列 + [&>*]:flex-1：它多半是网格里的**卡片格子**，
  // 卡片本身要撑满格子（同一行的卡片才会等高），少了这一层就会各自按内容高度缩水。
  const base = 'flex min-w-0 flex-col [&>*]:flex-1'
  if (!animated) return <div className={cn(base, className)}>{children}</div>
  return <StaggerItem className={cn(base, className)}>{children}</StaggerItem>
}

/* #185 的报错栈里显示真名（生产构建会压掉函数名） */
withDisplayName(GroupTransition, 'GroupTransition')
