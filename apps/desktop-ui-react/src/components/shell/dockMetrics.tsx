/**
 * 右侧侧栏（RightDock）的小件收口：卡片 / 指标行 / 进度条行 / 长文本行。
 *
 * 为什么不用 dockShared.tsx 里那份：那边是侧栏第一版的小件，在窄面板下有三个老问题——
 * - 值用 shrink-0 且不设上限：超长模型名 / 版本号会把整行顶出面板（「文字超出框」）
 * - hint 不换行也不带 title：长路径直接把卡片撑宽
 * - 卡片在弹性列里没有 shrink-0 / min-h：内容高的卡片会被压成一条「显示不全的长方形」
 * 侧栏这五个页签统一改用这里的版本；dockShared.tsx 不在本次改动范围内，那边保持原样。
 */
import { cn } from '../../lib/cn'
import { nodeText } from '../ui/Card'
import { Progress } from '../ui/Controls'

/**
 * 分组卡片。
 * shrink-0 + min-w-0：卡片是弹性列（页签根节点 flex flex-col）的子项，
 * 默认 flex-shrink:1 会在内容高于可视区时把卡片压扁，里面的文字就被裁掉半截。
 */
export function DockSection({ title, hint, actions, children, className }: {
  title?: string
  hint?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('card-lift min-w-0 shrink-0 rounded-lg border border-line bg-surface elev-1', className)}>
      {title ? (
        // 标题区给一个 120px 的基准宽度：窄面板下右边的操作控件（分段控件等）会换行到第二行，
        // 而不是把标题区压到十几 px、逼得说明文字溢出卡片。
        <div className='flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 px-3 pt-2.5 pb-1'>
          <div className='min-w-0 flex-1 basis-[120px]'>
            <h3 className='truncate text-12 font-semibold text-ink' title={title}>{title}</h3>
            {/* 说明常常是完整路径（引擎给的 root / cwd / 日志路径），break-all 换行 + title 兜底 */}
            {hint ? <p className='mt-0.5 break-all text-11 leading-[1.5] text-ink-4' title={hint}>{hint}</p> : null}
          </div>
          {actions ? <div className='flex shrink-0 items-center gap-0.5'>{actions}</div> : null}
        </div>
      ) : null}
      <div className='min-w-0 px-3 pb-3 pt-1'>{children}</div>
    </section>
  )
}

/** 一行「标签 — 值」：值不设宽度上限的老版本会把行顶破，这里给值封顶 + 省略号 + title。 */
export function MetricRow({ label, value, hint, labelTitle, valueTitle }: {
  label: React.ReactNode
  value: React.ReactNode
  hint?: string
  labelTitle?: string
  valueTitle?: string
}) {
  return (
    <div className='flex min-w-0 items-baseline gap-2 py-1'>
      <div className='min-w-0 flex-1 truncate' title={labelTitle ?? nodeText(label)}>
        <span className='text-12 text-ink-2'>{label}</span>
        {hint ? <span className='ml-1.5 text-11 text-ink-4'>{hint}</span> : null}
      </div>
      <span
        className='max-w-[58%] shrink-0 truncate text-right font-mono text-12 tabular-nums text-ink'
        title={valueTitle ?? nodeText(value)}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * 长串专用的一行：标签一行、值一行并 break-all 换行显示全文。
 * 版本号 / 模型名 / 运行环境这类没有空格的长串，用省略号会看不出关键信息，换行更合适。
 */
export function BreakRow({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0 py-1'>
      <p className='truncate text-11 text-ink-4' title={label}>{label}</p>
      <p className='mt-0.5 break-all font-mono text-12 tabular-nums leading-[1.45] text-ink' title={value}>{value}</p>
    </div>
  )
}

/** 进度条一行：条容器 shrink-0 + min-h，弹性列再挤也不会把条压没。 */
export function MeterRow({ label, ratio, value, hint, tone = 'primary' }: {
  label: string
  ratio: number
  value: string
  hint?: string
  tone?: 'primary' | 'ok' | 'warn' | 'danger'
}) {
  const toneClass = tone === 'ok' ? '[&>div]:bg-ok' : tone === 'warn' ? '[&>div]:bg-warn' : tone === 'danger' ? '[&>div]:bg-danger' : ''
  return (
    <div className='min-w-0 py-1.5'>
      <div className='flex min-w-0 items-baseline gap-2'>
        <span className='min-w-0 flex-1 truncate text-12 text-ink-2' title={label}>{label}</span>
        <span className='max-w-[58%] shrink-0 truncate text-right font-mono text-12 tabular-nums text-ink' title={value}>{value}</span>
      </div>
      <div className='mt-1.5 shrink-0'>
        <Progress value={ratio} className={cn('h-1.5 min-h-[6px]', toneClass)} />
      </div>
      {hint ? <p className='mt-1 break-all text-11 leading-[1.5] text-ink-4' title={hint}>{hint}</p> : null}
    </div>
  )
}
