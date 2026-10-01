import { ShieldAlert } from 'lucide-react'
import { Dialog } from '../ui/Overlay'
import { Button } from '../ui/Button'
import { useSession } from '../../stores/session'
import { AgentState } from '../ai/AgentState'

/** 工具授权：引擎在危险操作前会停下来问，这里给出明确的三档选择。 */
export function ApprovalDialog() {
  const approval = useSession((s) => s.approval)
  const approve = useSession((s) => s.approve)
  return (
    <Dialog
      open={!!approval}
      onOpenChange={(v) => { if (!v) approve('deny') }}
      title='需要你的授权'
      description={approval ? '即将执行：' + approval.toolName : ''}
      width={480}
      footer={
        <>
          <Button variant='ghost' onClick={() => approve('deny')}>拒绝</Button>
          <Button variant='secondary' onClick={() => approve('always')}>本次会话总是允许</Button>
          <Button variant='primary' onClick={() => approve('allow')}>允许一次</Button>
        </>
      }
    >
      {/* 审批卡入场：卡片自己 rise 8px，左侧点阵用 awaiting（静止 + 慢心跳）——
          「在等你」这件事不该看起来像「正在忙」。 */}
      <div className='animate-bar flex gap-3 rounded-lg border border-line bg-muted p-3'>
        <span className='mt-0.5 flex shrink-0 items-center gap-1.5'>
          <ShieldAlert size={16} className='shrink-0 text-warn' />
          <AgentState state='awaiting' size='md' tone='warn' />
        </span>
        <div className='min-w-0 flex-1'>
          <p className='mb-1 text-12 text-ink-3'>等待你选择「拒绝 / 允许一次 / 本次会话总是允许」</p>
          <pre className='max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-11 leading-[1.6] text-ink-2'>{approval?.detail}</pre>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * 提问弹窗：**已退役**，保留导出只为不惊动 App.tsx 的懒加载表（它按名字取组件）。
 *
 * 提问的界面搬到对话流里了（components/chat/AskUserCard.tsx）：
 *   · 弹窗会挡住整屏 —— 审批（危险动作的闸门）配得上这个分量，提问配不上；
 *   · 更要紧的是它**选完就关**：用户答完就再也看不到自己刚才选了什么。
 *     提问卡答完留在原地显示「你的回答」，所以这里一个字都不渲染。
 * 审批仍是弹窗（ApprovalDialog）：那是要立刻拦住你的动作，不该埋进消息流里。
 */
export function QuestionDialog() {
  return null
}
