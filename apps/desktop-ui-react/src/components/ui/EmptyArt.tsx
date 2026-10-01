/**
 * 空态插画：五张自绘 SVG，统一一套画法 —— 淡线条主体（opacity .55）+ 一个主色实心点/短划。
 *
 * 为什么自绘而不是用图标库：lucide 是 24px 单线图标，放大到 64px 会「细得像根头发」，
 * 而且它没有「空」的语感（放大镜就是放大镜，不是「没搜到」）。这里五张图共用同一套
 * 网格（64×64）、同一档线宽（1.5）与同样的视觉重心，并排出现在同一屏里不会像拼凑的。
 *
 * 颜色全部走 currentColor：外层给 text-ink-4 就是灰的，给 text-primary 就是蓝的，
 * 主色那一点点单独用 text-primary —— 暗色主题下不用改一行。
 */
import { cn } from '../../lib/cn'

export type EmptyArtKind = 'sessions' | 'artifacts' | 'tasks' | 'search' | 'engine'

/** 插画语义：需要 alt/提示文案而不只是装饰时（例如卡片 grid 的空态）取这里。 */
export const EMPTY_ART_LABELS: Record<EmptyArtKind, string> = {
  sessions: '还没有会话',
  artifacts: '还没有产物',
  tasks: '还没有任务',
  search: '没有匹配的结果',
  engine: '引擎还没就绪',
}

const ART: Record<EmptyArtKind, React.ReactNode> = {
  // 无会话：一个对话气泡，第二行留了一截 + 一个等着输入的光标点
  sessions: (
    <>
      <g opacity='.55'>
        <rect x='10' y='13' width='44' height='30' rx='8' />
        <path d='M20 43v7l8-7' />
        <path d='M20 24h24' />
        <path d='M20 31h7' />
      </g>
      <circle cx='32' cy='31' r='1.9' className='text-primary' fill='currentColor' stroke='none' />
    </>
  ),
  // 无产物：一张带折角的文档，末行同样留了一截
  artifacts: (
    <>
      <g opacity='.55'>
        <path d='M18 10h16l12 12v32a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4Z' />
        <path d='M34 10v9a3 3 0 0 0 3 3h9' />
        <path d='M24 30h16' />
        <path d='M24 38h10' />
      </g>
      <circle cx='38.5' cy='38' r='1.9' className='text-primary' fill='currentColor' stroke='none' />
    </>
  ),
  // 无任务：清单，前两项已勾、最后一项还没开始
  tasks: (
    <>
      <g opacity='.55'>
        <rect x='14' y='12' width='36' height='40' rx='7' />
        <rect x='20' y='20' width='7' height='7' rx='2' />
        <path d='M21.6 23.6l1.6 1.6 3-3.2' />
        <path d='M32 23.6h12' />
        <rect x='20' y='31' width='7' height='7' rx='2' />
        <path d='M32 34.6h9' />
      </g>
      <rect x='20' y='42' width='7' height='7' rx='2' className='text-primary' />
      <path d='M32 45.6h4' className='text-primary' />
    </>
  ),
  // 无搜索：放大镜，镜里只剩一个光标点
  search: (
    <>
      <g opacity='.55'>
        <circle cx='28' cy='27' r='14' />
        <path d='M38.4 37.4 50 49' />
      </g>
      <path d='M21 27h6' className='text-primary' />
      <circle cx='33' cy='27' r='1.9' className='text-primary' fill='currentColor' stroke='none' />
    </>
  ),
  // 引擎未就绪：芯片八条引脚都在，中间那条链路是断的
  engine: (
    <>
      <g opacity='.55'>
        <rect x='18' y='18' width='28' height='28' rx='7' />
        <path d='M26 18v-6M38 18v-6M26 46v6M38 46v6' />
        <path d='M18 26h-6M18 38h-6M46 26h6M46 38h6' />
        <path d='M24 32h5M35 32h5' />
      </g>
      <circle cx='32' cy='32' r='2.1' className='text-primary' fill='currentColor' stroke='none' />
    </>
  ),
}

export function EmptyArt({ kind, size = 64, className }: {
  kind: EmptyArtKind
  /** 渲染边长（px）。放在紧凑空态里给 44–52。 */
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox='0 0 64 64'
      width={size}
      height={size}
      aria-hidden
      focusable='false'
      fill='none'
      stroke='currentColor'
      strokeWidth={1.5}
      strokeLinecap='round'
      strokeLinejoin='round'
      className={cn('shrink-0 text-ink-4', className)}
    >
      {ART[kind]}
    </svg>
  )
}
