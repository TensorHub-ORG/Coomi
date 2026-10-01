import * as RadixSelect from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface SelectOption {
  value: string
  label: string
  /** 不可选中的项（例如已下线的模型）：仍然列出来，但点不动。 */
  disabled?: boolean
  /** 覆盖项的 title（被截断的长名字需要它）。 */
  title?: string
}

/** 下拉选择：与输入框同一套「可见边框」风格（border-line-strong + bg-control + --r-md），
    避免选项看起来是浮在页面上的淡字。
    浮层进出场统一走 .pop-surface：入场按 data-side 给方向（向上弹的从下方 4px 起），
    退场由 Radix 的 data-state=closed 触发；底色 --surface-overlay、高程 --elev-3（浮层档）。
    箭头跟着开合转 180°：data-state 挂在 Trigger 上（不在图标上），所以旋转写在 Trigger 的
    [&_svg] 上——写在图标自己的 data-[state=open] 上永远不会命中。 */
export function Select({ value, options, onChange, placeholder = '请选择', disabled, className, width, invalid }: {
  value: string
  options: SelectOption[]
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  width?: number
  invalid?: boolean
}) {
  return (
    <RadixSelect.Root value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <RadixSelect.Trigger
        style={width ? { width } : undefined}
        aria-invalid={invalid || undefined}
        className={cn(
          'inline-flex h-[calc(2rem*var(--ui-font-scale))] min-w-0 max-w-full items-center justify-between gap-2 overflow-hidden rounded-md border border-line-strong bg-control px-3 text-13 text-ink',
          'transition-[border-color,box-shadow,background-color] duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
          'hover:border-ink-4 focus-visible:outline-none focus-visible:border-primary focus-visible:shadow-[0_0_0_3px_var(--primary-soft)]',
          'data-[state=open]:border-primary data-[state=open]:shadow-[0_0_0_3px_var(--primary-soft)]',
          'data-[state=open]:[&_svg]:rotate-180',
          'disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-4 disabled:hover:border-line-strong',
          invalid && 'border-danger hover:border-danger focus-visible:border-danger focus-visible:shadow-[0_0_0_3px_var(--danger-soft)]',
          className,
        )}
      >
        <RadixSelect.Value placeholder={<span className='truncate text-ink-4'>{placeholder}</span>}>
          <span className='block truncate'>{value ? (options.find((o) => o.value === value)?.label ?? value) : ''}</span>
        </RadixSelect.Value>
        <RadixSelect.Icon className='shrink-0'>
          <ChevronDown
            size={14}
            className='text-ink-3 transition-transform duration-[var(--motion-fast)] ease-[var(--ease-spring)]'
          />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position='popper'
          sideOffset={6}
          collisionPadding={8}
          className='pop-surface z-50 max-h-[280px] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-overlay p-1 shadow-elev-3'
        >
          <RadixSelect.Viewport className='p-0'>
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                title={o.title ?? o.label}
                className={cn(
                  'relative flex h-8 cursor-pointer select-none items-center gap-2 rounded-xs pl-8 pr-2 text-13 text-ink-2 outline-none',
                  'transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
                  'data-[highlighted]:bg-hover data-[highlighted]:text-ink',
                  'active:bg-active',
                  'data-[state=checked]:font-medium data-[state=checked]:text-ink',
                  'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
                )}
              >
                <RadixSelect.ItemIndicator className='absolute left-2 grid place-items-center'>
                  <Check size={13} className='text-primary' />
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText className='truncate'>{o.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
            {!options.length ? <div className='px-2 py-2 text-12 text-ink-4'>没有可选项</div> : null}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
