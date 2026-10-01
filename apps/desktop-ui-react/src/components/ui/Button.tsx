import { forwardRef, startTransition } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn'

/** 按下态的属性名：与 CSS 约定成 Tailwind 的 data-[pressed=1]: 变体。 */
export const PRESS_ATTR = 'data-pressed'

/** 按下反馈：pointerdown 那一拍**直接写 DOM**，不经过 React。
 *
 *  为什么不用 setState：点击反馈的预算只有 50ms，而「setState → 重渲染 → 提交」
 *  要跨若干帧，重活（长列表重排、取数、切组）又正好排在这一次点击里，
 *  于是按下态被压在重渲染后面。写属性/内联样式是就地一次样式重算，
 *  下一帧（≈16ms）就是按下态，与 React 那一趟彻底解耦。
 *
 *  为什么不用原生 :active：① 有些调用方（浮层、拖拽手柄）在 pointerdown 里
 *  preventDefault，:active 根本不生效；② :active 那档时长是 --motion-instant（90ms），
 *  背景色要 90ms 才压到位，超过预算。所以这里按下时把这一拍的过渡时长内联压到 0
 *  （内联一定压得过样式表里任何 duration-*），松手再交还给样式表，回弹照旧走令牌。
 *
 *  清理：window 上的 pointerup / pointercancel / blur 各挂一次捕获监听，触发即自摘；
 *  pointerleave 也清 —— 「按住 → 拖出按钮 → 松手」不会留下一个卡住的按下态。 */
export function pressFeedback(el: HTMLElement | null): void {
  if (!el) return
  el.setAttribute(PRESS_ATTR, '1')
  const prev = el.style.transitionDuration
  el.style.transitionDuration = '0s'
  const done = (): void => {
    el.removeAttribute(PRESS_ATTR)
    el.style.transitionDuration = prev
    window.removeEventListener('pointerup', done, true)
    window.removeEventListener('pointercancel', done, true)
    window.removeEventListener('blur', done, true)
    el.removeEventListener('pointerleave', done)
  }
  window.addEventListener('pointerup', done, true)
  window.addEventListener('pointercancel', done, true)
  window.addEventListener('blur', done, true)
  el.addEventListener('pointerleave', done)
}

/** 三档尺寸 + 克制的变体：一屏只允许一个 primary。
    四态（默认 / hover / 按下 / 禁用）+ 载入态都在这里定死，页面里不再各写各的。
    - 按下：整体 scale(.98) + 内阴影（--elev-press），比单纯挪 1px 更「按得下去」，也不会把文字推糊；
      按下态有两条路径：pointerdown 由 pressFeedback() 直接写 data-pressed（下一帧就到位，
      不等 React），键盘激活（Space）走原生的 :active —— 两条路的观感一致；
    - 载入：文字保持占位、转圈绝对居中，宽度因此不跳；
    - 尺寸：sm 28 / md 32 / lg 36，圆角取 --r-md（10px）；
    - 间距：内边距与图标间距全部落在 4px 网格上（px-3 = 12、px-4 = 16、gap-2 = 8）；
    - 焦点：**不写自己的焦点环**，由 base.css 的 :focus-visible 统一用 --focus-ring* 画，
      这样暗色下不会出现「自绘的 ring 亮、系统 outline 暗」两条环叠在一起。 */
const button = cva(
  [
    'relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium',
    // 可交互元素取弹性曲线（过冲一点点＝「按得下去」），按下那一刻单独压到 instant 档。
    'transition-[background-color,color,border-color,box-shadow,transform] duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
    // 按下：data-pressed 由 pressFeedback() 写在 DOM 上，:active 兜住键盘激活那一路。
    // scale 走的是独立的 scale 属性，不在上面的过渡列表里 —— 它是瞬时的，正是想要的。
    'active:scale-[.98] active:duration-[var(--motion-instant)] data-[pressed=1]:scale-[.98]',
    'disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none',
    '[&_svg]:shrink-0',
  ],
  {
    variants: {
      // 每个变体的按下态都写两遍（active: 与 data-[pressed=1]:）：前者管键盘与原生路径，
      // 后者管指针按下那一拍。两处值必须一致，改一处要顺手改另一处。
      variant: {
        primary:
          'bg-primary text-white shadow-elev-1 hover:bg-primary-hover active:bg-primary-active active:shadow-press data-[pressed=1]:bg-primary-active data-[pressed=1]:shadow-press',
        // neutral：两套主题下都“压得住”的中性按钮（浅色深墨底 / 深色浅于卡片的面板色），
        // 之前的 ink 变体在深色主题下会变成一块白底，看起来和页面反色。
        neutral: 'bg-neutral-btn btn-neutral-ink shadow-elev-1 hover:bg-neutral-btn-hover active:shadow-press data-[pressed=1]:bg-neutral-btn-hover data-[pressed=1]:shadow-press',
        ink: 'bg-ink text-ink-inverse hover:opacity-90 data-[pressed=1]:opacity-90',
        secondary:
          'border border-line-strong bg-surface text-ink shadow-elev-1 hover:border-ink-4 hover:bg-hover active:bg-active active:shadow-press data-[pressed=1]:bg-active data-[pressed=1]:border-ink-4 data-[pressed=1]:shadow-press',
        ghost: 'text-ink-2 hover:bg-hover hover:text-ink active:bg-active active:shadow-none data-[pressed=1]:bg-active data-[pressed=1]:text-ink data-[pressed=1]:shadow-none',
        danger:
          'border border-danger/25 bg-danger-soft text-danger hover:border-danger/45 hover:bg-danger-soft active:bg-danger-soft active:shadow-press data-[pressed=1]:border-danger/45 data-[pressed=1]:shadow-press',
        link: 'px-0 text-primary hover:underline underline-offset-2 active:scale-100 data-[pressed=1]:scale-100',
      },
      size: {
        /* 高度跟着 --ui-font-scale 走（见 theme.css 的字号令牌）：字号放大而盒子不动时，
           文字会贴边甚至被裁 —— 「大 / 特大」档看上去就是「错位」。 */
        sm: 'h[calc(1.75rem*var(--ui-font-scale))] px-3 text-12 [&_svg]:size-3.5',
        md: 'h[calc(2rem*var(--ui-font-scale))] px-3 text-13 [&_svg]:size-4',
        lg: 'h[calc(2.25rem*var(--ui-font-scale))] px-4 text-14 [&_svg]:size-4',
        icon: 'h[calc(2rem*var(--ui-font-scale))] w[calc(2rem*var(--ui-font-scale))] p-0 [&_svg]:size-4',
        'icon-sm': 'h[calc(1.75rem*var(--ui-font-scale))] w[calc(1.75rem*var(--ui-font-scale))] p-0 [&_svg]:size-3.5',
        'icon-lg': 'h[calc(2.25rem*var(--ui-font-scale))] w[calc(2.25rem*var(--ui-font-scale))] p-0 [&_svg]:size-[18px]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

/** 载入态转圈：只动 opacity，时长走统一动效令牌。 */
function ButtonSpinner() {
  return (
    <span
      aria-hidden
      className='pointer-events-none absolute inset-0 grid place-items-center motion-safe:animate-[fade-in_var(--motion-fast)_var(--ease-out-quint)]'
    >
      <span className='inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-80' />
    </span>
  )
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  /** 载入态：自动禁用并显示转圈；文字保留占位，宽度不跳。 */
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', loading = false, disabled, children, onClick, onPointerDown, ...props }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      // 变体/尺寸落到 data-* 上：调用方要微调（例如窄面板里改成整宽）时不用再重算一遍变体名。
      data-variant={variant ?? 'secondary'}
      data-size={size ?? 'md'}
      data-loading={loading ? 'true' : undefined}
      className={cn(button({ variant, size }), className)}
      // 按下反馈先落：只跟这一次指针事件有关，不等下面那次点击引发的重渲染。
      onPointerDown={(e) => { pressFeedback(e.currentTarget); onPointerDown?.(e) }}
      // 点击引发的那一趟走 transition：startTransition 的回调**仍是同步执行**的
      // （preventDefault、读 currentTarget、命令式调用都不变），被降级的只是它产生的状态更新。
      // 于是「改值引发的重渲染」在后台分片跑，不跟已经画出来的按下态抢这一帧。
      onClick={onClick ? (e) => { startTransition(() => { onClick(e) }) } : undefined}
      {...props}
    >
      <span className={cn('inline-flex items-center gap-2', loading && 'opacity-0')}>{children}</span>
      {loading ? <ButtonSpinner /> : null}
    </button>
  )
})
