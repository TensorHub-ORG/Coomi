import * as RadixMenu from '@radix-ui/react-dropdown-menu'
import * as RadixContext from '@radix-ui/react-context-menu'
import { cn } from '../../lib/cn'

/// 浮层统一走 .pop-surface：入场 --motion-base + --ease-out-quint、退场 --motion-fast + --ease-in-quad，
/// 方向由 Radix 的 data-side 决定（向上弹出的从下方 4px 起，向下弹出的从上方 4px 起）。
/// 底色取表面第 4 档 --surface-overlay、高程取 --elev-3（浮层档）：暗色下比卡片更亮一档，
/// 面板「浮在内容之上」的层次不用靠描边硬撑。
const contentCls =
  'pop-surface z-50 min-w-[184px] overflow-hidden rounded-lg border border-line bg-overlay p-1 shadow-elev-3'
const itemCls = [
  'flex h-8 cursor-pointer select-none items-center gap-2 rounded-xs px-2 text-13 text-ink-2 outline-none',
  'transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)]',
  // 键盘/指针高亮是同一档（bg-hover），按下再深一档（bg-active），禁用只降透明度、不响应指针。
  'data-[highlighted]:bg-hover data-[highlighted]:text-ink',
  'active:bg-active',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
].join(' ')

export interface MenuEntry {
  label?: string
  icon?: React.ReactNode
  danger?: boolean
  divider?: boolean
  disabled?: boolean
  onSelect?: () => void
}

function Entries({ items }: { items: MenuEntry[] }) {
  return (
    <>
      {items.map((it, i) =>
        it.divider ? (
          <RadixMenu.Separator key={'d' + i} className='my-1 h-px bg-line-soft' />
        ) : (
          <RadixMenu.Item
            key={it.label ?? i}
            disabled={it.disabled}
            onSelect={it.onSelect}
            className={cn(itemCls, it.danger && 'text-danger data-[highlighted]:bg-danger-soft data-[highlighted]:text-danger')}
          >
            {it.icon ? <span className='shrink-0 text-ink-3 [&_svg]:h-3.5 [&_svg]:w-3.5'>{it.icon}</span> : null}
            <span className='truncate'>{it.label}</span>
          </RadixMenu.Item>
        ),
      )}
    </>
  )
}

/** 下拉菜单：Radix 自带边界碰撞检测，靠近窗口边缘会自动翻转/收缩，不会再出界。 */
export function Menu({ trigger, items, groups, header, align = 'end', side = 'bottom' }: {
  trigger: React.ReactNode
  /// 菜单顶部固定区域（例如搜索框）
  header?: React.ReactNode
  items?: MenuEntry[]
  /// 分组菜单：用于「厂商名 → 模型列表」这种层级。
  groups?: Array<{ label: string; items: MenuEntry[] }>
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(contentCls, 'max-h-[420px] overflow-y-auto overscroll-contain')}
        >
          {header ? <div onClick={(e) => e.stopPropagation()}>{header}</div> : null}
          {groups
            ? groups.map((g, gi) => (
                <RadixMenu.Group key={g.label}>
                  {gi > 0 ? <RadixMenu.Separator className='my-1 h-px bg-line-soft' /> : null}
                  <RadixMenu.Label className='px-2 pb-1 pt-1.5 text-11 text-ink-4'>{g.label}</RadixMenu.Label>
                  <Entries items={g.items} />
                </RadixMenu.Group>
              ))
            : <Entries items={items ?? []} />}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}

/** 右键菜单：同一套视觉，Radix 负责定位与边界处理。 */
export function ContextMenu({ trigger, items }: { trigger: React.ReactNode; items: MenuEntry[] }) {
  return (
    <RadixContext.Root>
      <RadixContext.Trigger asChild>{trigger}</RadixContext.Trigger>
      <RadixContext.Portal>
        <RadixContext.Content collisionPadding={8} className={cn(contentCls, 'overscroll-contain')}>
          <RadixContext.Separator className='hidden' />
          {items.map((it, i) =>
            it.divider ? (
              <RadixContext.Separator key={'d' + i} className='my-1 h-px bg-line-soft' />
            ) : (
              <RadixContext.Item
                key={it.label ?? i}
                disabled={it.disabled}
                onSelect={it.onSelect}
                className={cn(itemCls, it.danger && 'text-danger data-[highlighted]:bg-danger-soft data-[highlighted]:text-danger')}
              >
                {it.icon ? <span className='shrink-0 text-ink-3 [&_svg]:h-3.5 [&_svg]:w-3.5'>{it.icon}</span> : null}
                <span className='truncate'>{it.label}</span>
              </RadixContext.Item>
            ),
          )}
        </RadixContext.Content>
      </RadixContext.Portal>
    </RadixContext.Root>
  )
}
