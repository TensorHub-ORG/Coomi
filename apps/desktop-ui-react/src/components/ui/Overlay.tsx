import * as RadixTooltip from '@radix-ui/react-tooltip'
import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from './Button'

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <RadixTooltip.Provider delayDuration={380}>{children}</RadixTooltip.Provider>
}

/** 气泡提示：走 .pop-surface 的方向语义（向上弹的从下方 4px 起），进出场都有。
    底色 --surface-overlay、高程 --elev-2（悬浮档）——比菜单低一档，提示不该压过菜单。 */
export function Tip({ label, children, side = 'bottom' }: { label: string; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className='pop-surface z-50 max-w-[280px] rounded-md border border-line bg-overlay px-2 py-1 text-12 text-ink-2 shadow-elev-2'
        >
          {label}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}

/** 对话框：用于审批、提问、Provider 表单等需要专注的场景。
    整块出现用 --motion-page，退场靠 data-state=closed（Radix 会等动画播完再卸载）；
    底色 --surface-overlay + 高程 --elev-4（模态/顶层档），盖得住底下所有浮层。
    内边距全部落在 4px 网格上（20 / 16 / 12），正文区自己滚、不带动外框。 */
export function Dialog({ open, onOpenChange, title, description, children, footer, width = 460 }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description?: string
  children?: React.ReactNode
  footer?: React.ReactNode
  width?: number
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        {/* 遮罩只用纯色压暗（毛玻璃全站只在标题栏那一层，见 theme.css）：全屏 blur
            在开关对话框的那几帧里最贵，而它并不比纯色更好看。 */}
        <RadixDialog.Overlay className='dialog-scrim fixed inset-0 z-40 bg-black/35' />
        <RadixDialog.Content
          style={{ width, maxWidth: 'calc(100vw - 32px)' }}
          className={cn(
            'dialog-surface fixed left-1/2 top-1/2 z-50 max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden',
            'rounded-lg border border-line bg-overlay shadow-elev-4',
          )}
        >
          <div className='flex items-start gap-3 px-5 pt-4 pb-3'>
            <div className='min-w-0 flex-1'>
              <RadixDialog.Title className='text-15 font-semibold text-ink'>{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className='mt-1 text-12 text-ink-3'>{description}</RadixDialog.Description> : null}
            </div>
            {/* 右上角关闭：Esc 之外的第二条退路，hover 才显形，不抢标题。 */}
            <RadixDialog.Close asChild>
              <Button variant='ghost' size='icon-sm' aria-label='关闭' className='-mr-2 -mt-1 text-ink-4 hover:text-ink'>
                <X size={14} />
              </Button>
            </RadixDialog.Close>
          </div>
          {children ? <div className='max-h-[60vh] overflow-y-auto overscroll-contain px-5 pb-3'>{children}</div> : null}
          {footer ? <div className='flex justify-end gap-2 border-t border-line-soft bg-muted/40 px-5 py-3'>{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = '确认', danger, onConfirm }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description?: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      width={400}
      footer={
        <>
          <Button variant='ghost' onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => { onOpenChange(false); onConfirm() }}>{confirmLabel}</Button>
        </>
      }
    />
  )
}
