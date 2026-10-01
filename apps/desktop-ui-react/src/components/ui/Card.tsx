import { createContext, useContext, useMemo, useRef } from 'react'
import { cn } from '../../lib/cn'
import { EmptyArt, type EmptyArtKind } from './EmptyArt'

/* ── 卡片入场的错峰序号：分组 / Section 两级重置 ──
   设置页一屏里挂着十几个 Section（非当前分组用 hidden 藏着），卡片总数远不止十个。
   原来的错峰完全交给 motion 的 staggerChildren —— 只有步长、没有上限、也不会重置，
   「本组第几个」一路累加：越靠下的卡片等得越久（最底下那张要等近一秒），
   读起来就是「越往下出现越慢」。现在改成两级计数 + 封顶：
     · 外层（分组）：GroupTransition 挂一个 StaggerScope；
     · 内层（Section）：每个 Section 再挂一个，进到 Section 就从头数。
   延迟一律 = min(i, 5) × 20ms，最多 100ms，跟卡片在屏幕上的位置无关。 */
export const STAGGER_STEP_MS = 20
export const STAGGER_MAX_INDEX = 5

export interface StaggerCursor {
  /** 取下一个序号（0、1、2…）。 */
  next: () => number
}

const StaggerContext = createContext<StaggerCursor | null>(null)

/** 取当前作用域里的下一个错峰序号；没有 provider（组件被单独使用）时返回 0，即不延迟。 */
export function useStaggerIndex(): number {
  const cursor = useContext(StaggerContext)
  return cursor ? cursor.next() : 0
}

/** 序号 → 延迟（秒）：min(i, 5) × 20ms。 */
export function staggerDelay(index: number): number {
  return Math.min(Math.max(0, index), STAGGER_MAX_INDEX) * (STAGGER_STEP_MS / 1000)
}

/** 错峰作用域：每一轮渲染都从 0 开始数，「换分组 / 换 Section」因此天然就是重置。 */
export function StaggerScope({ children }: { children: React.ReactNode }) {
  // 可变计数器而不是 state：它只决定动画延迟，不该触发任何一次渲染。
  const cursor = useRef({ i: 0 })
  cursor.current.i = 0
  const value = useMemo<StaggerCursor>(() => ({ next: () => cursor.current.i++ }), [])
  return <StaggerContext.Provider value={value}>{children}</StaggerContext.Provider>
}

/** 从 ReactNode 里抠出纯文本：标签常包着图标（<Shield/> 任务放行程度），
    title 不能因为不是字符串就丢掉——被 truncate 截断又没 title 是设置页最常见的溢出问题。 */
export function nodeText(node: React.ReactNode): string | undefined {
  if (node === null || node === undefined || typeof node === 'boolean') return undefined
  if (typeof node === 'string') return node.trim() || undefined
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    const text = node.map((child) => nodeText(child)).filter(Boolean).join(' ')
    return text || undefined
  }
  if (typeof node === 'object') {
    const props = (node as { props?: { children?: React.ReactNode } }).props
    return nodeText(props?.children)
  }
  return undefined
}

/** 页面标题区。sticky=true 时吸在滚动容器顶部（设置页/技能中心用它当「分组标题」）：
    只做视觉上的粘住，不参与布局计算，因此不会把内容挤走。 */
export function PageHeader({ title, description, actions, sticky, className }: {
  title: string
  description?: string
  actions?: React.ReactNode
  sticky?: boolean
  className?: string
}) {
  return (
    // 吸顶页头属于「工具栏」那一类：半透明纯色，不做毛玻璃（毛玻璃全站只在标题栏，见 theme.css）。
    // 内容从它底下滚过时靠 92% 的底色盖住字，不再每次滚动都重新采样一遍背景。
    <header
      className={cn(
        'flex items-start gap-4 border-b px-8 pt-7 pb-5',
        sticky ? 'glass-bar sticky top-0 z-20 border-line-soft' : 'border-transparent',
        className,
      )}
    >
      <div className='min-w-0 flex-1'>
        <h1 className='text-20 font-semibold leading-tight text-ink'>{title}</h1>
        {description ? <p className='mt-1 break-words text-12 text-ink-3'>{description}</p> : null}
      </div>
      {actions ? <div className='flex shrink-0 items-center gap-2'>{actions}</div> : null}
    </header>
  )
}

/** 功能分区卡片：标题在卡内，卡片之间留 20px，避免「一坨平铺」。
    圆角统一 14（--r-lg），高程统一 elev-1，hover 抬起一级靠 .card-lift。 */
export function Section({ title, description, actions, children, className }: {
  title?: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section data-card='static' className={cn('card-lift rounded-lg border border-line bg-surface elev-1', className)}>
      {title ? (
        <div className='flex min-w-0 items-center gap-3 border-b border-line-soft px-5 pt-4 pb-2.5'>
          <div className='min-w-0 flex-1'>
            <h2 className='text-14 font-semibold text-ink'>{title}</h2>
            {description ? <p className='mt-0.5 break-words text-12 text-ink-3'>{description}</p> : null}
          </div>
          {/* 操作按钮不参与压缩：窄窗口下压缩它会把右侧按钮挤成半个字。 */}
          {actions ? <div className='flex shrink-0 items-center gap-2'>{actions}</div> : null}
        </div>
      ) : null}
      <div className='px-5 py-2'>
        {/* 每个 Section 重置一次错峰计数：卡片的入场延迟只跟「本卡在本 Section 里第几个」有关。 */}
        <StaggerScope>{children}</StaggerScope>
      </div>
    </section>
  )
}

/** 卡片内的一行设置项：左标签+说明，右控件。 */
export function Row({ label, hint, children, className }: {
  label: React.ReactNode
  hint?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-h-[52px] items-center gap-4 border-b border-line-soft py-2.5 last:border-b-0', className)}>
      <div className='min-w-0 flex-1'>
        <div className='text-13 text-ink'>{label}</div>
        {hint ? <div className='mt-0.5 text-12 text-ink-3'>{hint}</div> : null}
      </div>
      {children ? <div className='flex shrink-0 items-center gap-1.5'>{children}</div> : null}
    </div>
  )
}

/** 设置项网格：两列排布，每格都是独立带框的控件格——不再挤成一坨。 */
export function SettingsGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-1 gap-2.5 px-5 py-4 lg:grid-cols-2', className)}>{children}</div>
}

/** 控件格：左标签 + 说明，右控件。
    窄列（设置页是两列网格）里控件必须能换行、能省略，否则会顶出卡片边框。 */
export function Cell({ label, hint, children, className, wide, labelTitle, hintClamp }: {
  label?: React.ReactNode
  hint?: React.ReactNode
  children?: React.ReactNode
  className?: string
  wide?: boolean
  /** 覆盖 label 的 title（默认从 label 的文本内容里取）。 */
  labelTitle?: string
  /** 说明文字默认换行不截断；确实要收窄时给 1–3 行，收窄后仍应有 title。 */
  hintClamp?: 1 | 2 | 3
}) {
  return (
    <div
      className={cn(
        'card-lift flex min-h-[64px] min-w-0 flex-wrap items-center gap-x-4 gap-y-2 overflow-hidden rounded-lg',
        'border border-line bg-surface px-3.5 py-3',
        wide && 'lg:col-span-2',
        className,
      )}
    >
      <div className='min-w-[132px] flex-1 basis-[180px]'>
        {label ? <div className='truncate text-13 text-ink' title={labelTitle ?? nodeText(label)}>{label}</div> : null}
        {hint ? (
          <div
            className={cn('mt-1 break-words text-12 leading-[1.5] text-ink-3', hintClamp === 1 ? 'line-clamp-1' : hintClamp === 2 ? 'line-clamp-2' : hintClamp === 3 ? 'line-clamp-3' : '')}
            title={hintClamp ? nodeText(hint) : undefined}
          >
            {hint}
          </div>
        ) : null}
      </div>
      {children ? (
        <div className='flex min-w-0 flex-wrap items-center justify-end gap-1.5 [&_select]:max-w-full [&_input]:max-w-full'>
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** 空态：配图 + 一句说明 + 一个动作，三件套固定。全站空态都走这里，别再各画各的。
    两种配图：art = 自绘空态插画（五种语义各一张，见 EmptyArt，64 网格、统一线宽）；
    icon = lucide 图标（留给还没有对应插画的一次性场景）。给了 art 就忽略 icon。 */
export function Empty({ icon, art, title, description, action, compact, className }: {
  icon?: React.ReactNode
  /** 自绘空态插画：无会话 / 无产物 / 无任务 / 无搜索 / 引擎未就绪。 */
  art?: EmptyArtKind
  title: string
  description?: string
  action?: React.ReactNode
  /** 侧栏/抽屉里的窄空态：留白减半。 */
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-1.5 px-6 text-center',
        compact ? 'py-8' : 'py-16',
        className,
      )}
    >
      {art ? (
        <EmptyArt kind={art} size={compact ? 52 : 64} className='mb-1' />
      ) : icon ? (
        <span
          aria-hidden
          className={cn(
            // bg-muted 才是 --surface-muted 的工具类名：写 bg-surface-muted 在 v4 里
            // 没有对应的 --color-surface-muted，会静默不生效（圆圈整个是透明的）。
            'mb-1 grid place-items-center rounded-full border border-line bg-muted text-ink-4',
            compact ? 'h-9 w-9 [&_svg]:size-4' : 'h-12 w-12 [&_svg]:size-5',
          )}
        >
          {icon}
        </span>
      ) : null}
      <p className={cn('font-medium text-ink-2', compact ? 'text-13' : 'text-14')}>{title}</p>
      {description ? <p className='max-w-[380px] text-12 leading-[1.6] text-ink-3'>{description}</p> : null}
      {action ? <div className='mt-2.5 flex items-center gap-2'>{action}</div> : null}
    </div>
  )
}

/** 分隔线：横向一条发丝线（分组之间），纵向给工具栏用（按钮组之间）。
    颜色一律取 --line-soft，间距落在 4px 网格上（mx-1 = 4、my-2 = 8）；
    只做视觉分隔，因此不参与焦点、不进 tab 序列，data-orientation 供样式与测试选择。 */
export function Divider({ vertical, className }: { vertical?: boolean; className?: string }) {
  return (
    <span
      role='separator'
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      data-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn('shrink-0 bg-line-soft', vertical ? 'mx-1 h-4 w-px' : 'my-2 block h-px w-full', className)}
    />
  )
}

/* ── 列表 / 表格：表头粘性 + 行 hover + 数字等宽 ──
   产物、已安装、模型表这些地方以前各写一套行样式，现在统一走这四个零件：
   <TableWrap><Table><THead><TR>… / <TBody><TR><TD>。 */

export function TableWrap({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 overflow-hidden rounded-lg border border-line bg-surface', className)}>
      <div className='max-h-full overscroll-contain overflow-auto'>{children}</div>
    </div>
  )
}

export function Table({ children, className, minWidth }: {
  children: React.ReactNode
  className?: string
  /** 窄容器里允许横向滚动的最小宽度（px），不传则自适应。 */
  minWidth?: number
}) {
  return (
    <table
      className={cn('w-full border-collapse text-12', className)}
      style={minWidth ? { minWidth } : undefined}
    >
      {children}
    </table>
  )
}

export function THead({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <thead className={cn('glass-surface sticky top-0 z-10 border-b border-line-soft', className)}>
      <tr className='border-b border-line'>{children}</tr>
    </thead>
  )
}

export function TBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <tbody className={className}>{children}</tbody>
}

export function TR({ children, className, onClick, interactive, selected }: {
  children: React.ReactNode
  className?: string
  onClick?: () => void
  /** 可点行：hover 高亮 + 按下位移；键盘可达（Enter / 空格）。 */
  interactive?: boolean
  selected?: boolean
}) {
  return (
    <tr
      onClick={onClick}
      tabIndex={interactive ? 0 : undefined}
      aria-selected={selected}
      onKeyDown={interactive && onClick
        ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }
        : undefined}
      className={cn(
        'border-b border-line-soft transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] last:border-b-0',
        interactive && 'cursor-pointer hover:bg-hover active:bg-active',
        // 行在 TableWrap 的滚动容器里，焦点环默认 1px 外扩会被裁掉半条：
        // 键盘走到这一行时用内描边（负偏移）画环。
        interactive && 'focus-visible:outline-offset-[-2px]',
        selected && 'bg-row-active',
        className,
      )}
    >
      {children}
    </tr>
  )
}

export function TH({ children, className, numeric }: {
  children?: React.ReactNode
  className?: string
  /** 数字列：右对齐 + tabular-nums，位数不同也能对齐。 */
  numeric?: boolean
}) {
  return (
    <th
      scope='col'
      className={cn('h-8 whitespace-nowrap px-3 text-left font-medium text-ink-3', numeric && 'text-right tabular-nums', className)}
    >
      {children}
    </th>
  )
}

export function TD({ children, className, numeric, title }: {
  children?: React.ReactNode
  className?: string
  numeric?: boolean
  title?: string
}) {
  return (
    <td
      title={title}
      className={cn('h-9 px-3 align-middle text-ink-2', numeric && 'text-right font-mono tabular-nums', className)}
    >
      {children}
    </td>
  )
}
