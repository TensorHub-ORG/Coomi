/**
 * 顶栏「子智能体」按钮 + popover：对话页工具栏右侧的小图标按钮，
 * 带「运行中」数量小徽标（running > 0 才显示点数），点开弹出面板 ——
 * 面板内容就是原来的 SubagentPanel（派生列表 + 详情视图 SubagentDetail 都在里面），
 * 只是不再常驻在对话主列顶部 —— 不占对话空间，进对话页也不会展开一大块。
 */
import { Bot } from 'lucide-react'
import * as RadixPopover from '@radix-ui/react-popover'
import { Button } from '../ui/Button'
import { SubagentPanel, useSubagentDerived } from './SubagentPanel'

/** 浮层统一走 .pop-surface（与 ui/Menu.tsx 的 contentCls 同一套视觉）：
 *  入场 --motion-base + --ease-out-quint、退场 --motion-fast + --ease-in-quad，
 *  底色 --surface-overlay、高程 --elev-3（浮层档），方向由 Radix 的 data-side 决定。 */
const contentCls =
  'pop-surface z-50 min-w-0 overflow-hidden rounded-lg border border-line bg-overlay shadow-elev-3'

export function SubagentPopover() {
  // 角标与面板共用同一份派生数据（配置列表 / entries 折算 / 「运行中」判定），口径一致。
  const { live } = useSubagentDerived()
  const running = live.length

  return (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>
        {/* relative：运行中徽标以按钮右上角为锚点绝对定位 */}
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label={'子智能体' + (running ? ' · 运行中 ' + running + ' 个' : '')}
          title={'子智能体' + (running ? ' · 运行中 ' + running + ' 个' : '')}
          data-testid='subagent-toolbar-button'
          className='relative'
        >
          <Bot size={15} className='shrink-0' />
          {/* 运行中数量小徽标：running > 0 才显示点数；9 个以上压成 9+，别把图标挤爆 */}
          {running > 0 ? (
            <span
              data-testid='subagent-live-badge'
              className='pointer-events-none absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-10 font-semibold leading-none text-white shadow-elev-1'
            >
              {running > 9 ? '9+' : running}
            </span>
          ) : null}
        </Button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align='end'
          side='bottom'
          sideOffset={6}
          collisionPadding={8}
          // 不自动抢焦点/滚动：打开时焦点留在按钮上，面板内容用鼠标/键盘自行进入。
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={contentCls}
        >
          <SubagentPanel
            empty='本轮还没有子智能体：AI 派出子智能体后，会在这里显示它们的进度与对话。'
          />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  )
}
