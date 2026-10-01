import { cloneElement, forwardRef, isValidElement, useId, useState } from 'react'
import { cn } from '../../lib/cn'

/** 控件观感：底色 bg-control + 可见描边 border-line-strong（与 Select 触发器等宽同色）+ 聚焦反馈。
    聚焦用**边框变色 + 柔光**而不是 outline：输入框是「正在编辑的那一块」，柔光跟着圆角走、
    不占布局，也不会和按钮那套统一焦点环（--focus-ring）叠成两条环。
    圆角取 --r-md（10px），和 Button 的控件圆角一档；错误态整组换成 danger 语义色。 */
const base = [
  'w-full min-w-0 rounded-md border border-line-strong bg-control px-3 text-13 text-ink placeholder:text-ink-4',
  'transition-[border-color,box-shadow,background-color] duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
  'hover:border-ink-4',
  'focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft)] focus-visible:outline-none',
  'read-only:bg-muted read-only:text-ink-3 read-only:hover:border-line-strong',
  'disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-4 disabled:hover:border-line-strong',
].join(' ')

/** 错误态：红边 + 淡淡的红环，和聚焦环同一套画法。 */
const invalidCls =
  'border-danger hover:border-danger focus:border-danger focus:shadow-[0_0_0_3px_var(--danger-soft)]'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** 校验失败：边框与聚焦环转成危险色，并挂 aria-invalid。 */
  invalid?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props }, ref,
) {
  return (
    <input
      ref={ref}
      data-native-menu
      data-invalid={invalid ? 'true' : undefined}
      aria-invalid={invalid || undefined}
      className={cn(base, 'h-[calc(2rem*var(--ui-font-scale))]', invalid && invalidCls, className)}
      {...props}
    />
  )
})

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...props }, ref,
) {
  return (
    <textarea
      ref={ref}
      data-native-menu
      data-invalid={invalid ? 'true' : undefined}
      aria-invalid={invalid || undefined}
      className={cn(base, 'resize-none py-2 leading-[1.6]', invalid && invalidCls, className)}
      {...props}
    />
  )
})

/** 长文本输入：右下角字数（maxLength + 受控 value 时自动出现）。
    计数点靠 absolute 定位，不占布局、不会把输入框顶高一格；
    接近上限转 warn 色，聚焦或已有内容才显形，空着时不抢视线。 */
export function TextareaWithCount({ maxLength, value, hint, className, ...props }: TextareaProps & {
  hint?: React.ReactNode
}) {
  const [focused, setFocused] = useState(false)
  const text = typeof value === 'string' ? value : ''
  const used = text.length
  const near = typeof maxLength === 'number' && used >= maxLength * 0.9
  return (
    <div className='relative w-full min-w-0'>
      <Textarea
        {...props}
        value={value}
        maxLength={maxLength}
        className={cn('pb-6', className)}
        onFocus={(e) => { setFocused(true); props.onFocus?.(e) }}
        onBlur={(e) => { setFocused(false); props.onBlur?.(e) }}
      />
      {typeof maxLength === 'number' ? (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute bottom-2 right-2 font-mono text-11 tabular-nums transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out-quint)]',
            near ? 'text-warn' : 'text-ink-4',
            focused || used > 0 ? 'opacity-100' : 'opacity-0',
          )}
        >
          {used}/{maxLength}
        </span>
      ) : null}
      {hint ? <div className='mt-1 text-11 leading-[1.5] text-ink-4'>{hint}</div> : null}
    </div>
  )
}

export function Field({ label, hint, children, className }: {
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  const id = useId()
  // label 用 htmlFor 关联到唯一的输入控件（直接把 id 注进去，不再套一层包壳），
  // 说明文字走 aria-describedby：读屏和「点标签聚焦」都能正常工作。
  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<{ id?: string; 'aria-describedby'?: string }>, {
        id,
        'aria-describedby': hint ? id + '-hint' : undefined,
      })
    : children
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className='text-12 text-ink-3'>{label}</label>
      {control}
      {hint ? <p id={id + '-hint'} className='text-11 leading-[1.5] text-ink-4'>{hint}</p> : null}
    </div>
  )
}

/** 状态徽标：只表达状态，不可点，所以没有 hover/active；
    高度 20（4px 网格）、圆角 --r-xs（6px），底色一律是语义色的 soft 档。 */
export function Badge({ children, tone = 'neutral', title, className }: {
  children: React.ReactNode
  tone?: 'neutral' | 'primary' | 'ok' | 'warn' | 'danger'
  title?: string
  className?: string
}) {
  const tones: Record<string, string> = {
    // 写 bg-sunken 而不是 bg-surface-sunken：后者在 v4 里没有对应的
    // --color-surface-sunken，类名不生成，徽标会变成一块透明底。
    neutral: 'border-line bg-sunken text-ink-3',
    primary: 'border-primary/25 bg-primary-soft text-primary',
    ok: 'border-ok/25 bg-ok-soft text-ok',
    warn: 'border-warn/30 bg-warn-soft text-warn',
    danger: 'border-danger/25 bg-danger-soft text-danger',
  }
  return (
    <span
      title={title}
      data-tone={tone}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-xs border px-1.5 text-11 leading-none',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
