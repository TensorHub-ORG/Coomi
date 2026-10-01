import { AlertTriangle } from 'lucide-react'
import { useEngine } from '../../stores/engine'
import { useSession } from '../../stores/session'
import { AgentState } from '../ai/AgentState'

/** 引擎重启 / 恢复会话中：壳把引擎拉起来、前端重连并回读当前会话的这段时间显示。
    两个来源合成一条提示——restarting（引擎还没就绪）与 resuming（就绪后正在重开会话）。 */
export function EngineRestartBar() {
  const restarting = useEngine((s) => s.restarting)
  const resuming = useSession((s) => s.resuming)
  if (!restarting && !resuming) return null
  return (
    <div
      data-engine-restart-bar
      className='flex items-center gap-2 border-b border-primary/25 bg-primary-soft px-4 py-1.5 text-12 text-primary'
    >
      {/* 引擎重启 / 重连：断续闪烁的点阵（与「正在思考」的呼吸明显不同） */}
      <AgentState state='reconnecting' size='xs' tone='primary' className='shrink-0' />
      <span className='min-w-0 flex-1 truncate'>引擎已重启，正在恢复会话</span>
      <span className='shrink-0 text-11 text-primary/70'>{resuming ? '重新连接并回读历史…' : '引擎启动中…'}</span>
    </div>
  )
}

/** 崩溃中断条：引擎挂掉时这一轮还没跑完。
    手动停止有消息底部的「已中断 · 继续生成」，那是温和提示；崩溃是整进程没了，
    必须给一条醒目的、能一键接着跑的横幅，所以单独做在这里。 */
export function CrashResumeBar() {
  const crashInterrupted = useSession((s) => s.crashInterrupted)
  const streaming = useSession((s) => s.streaming)
  const resume = useSession((s) => s.resumeInterruptedTurn)
  const dismiss = useSession((s) => s.dismissCrashInterrupted)
  if (!crashInterrupted || streaming) return null
  return (
    <div
      data-crash-resume-bar
      className='flex items-center gap-2 border-b border-warn/40 bg-warn-soft px-4 py-2 text-12 text-warn'
    >
      <AlertTriangle size={13} className='shrink-0' />
      <span className='min-w-0 flex-1 truncate'>上次任务被中断</span>
      <button
        type='button'
        onClick={resume}
        className='shrink-0 rounded-md border border-warn/40 bg-canvas px-2.5 py-0.5 font-medium text-warn transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-warn/10'
      >
        继续
      </button>
      <button
        type='button'
        onClick={dismiss}
        className='shrink-0 rounded-md px-2 py-0.5 text-11 text-warn/80 transition-colors duration-[var(--motion-fast)] ease-[var(--ease-spring)] hover:bg-warn/10'
      >
        知道了
      </button>
    </div>
  )
}
