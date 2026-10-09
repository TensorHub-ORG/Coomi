import { useEffect, useRef, useState } from 'react'
import { useSession, type RunState } from '../../stores/session'
import { AgentState, type AgentStateKind } from '../ai/AgentState'
import {
  AnimatedCount, AnimatedDuration, AnimatedNumber, AnimatedPercent, AnimatedSeconds, AnimatedTokens,
} from '../ui/Number'

/** 运行态 → 状态语言：等待授权这类「卡在用户身上」的状态，配色和文案都要说清楚。 */
const RUN_STATE: Record<Exclude<RunState, 'idle'>, { state: AgentStateKind; text: string }> = {
  thinking: { state: 'thinking', text: '思考中' },
  executing: { state: 'running', text: '执行中' },
  awaiting_approval: { state: 'awaiting', text: '等待授权' },
  awaiting_question: { state: 'awaiting', text: '等待回答' },
}

/** 输入框下方常驻的「当前会话」统计：轮/步、LLM 与工具耗时、首 token、速度、缓存、token。
 *
 *  数字全部交给 @number-flow/react（见 components/ui/Number）：库自己管「旧数字滚出去、
 *  新数字滚进来」，位数、单位、宽度一起补间 —— 这里不再有 rAF 插值，也不再有
 *  靠 key 重挂播 num-pop 的离散数字，两套逻辑并成一套，位数变化时后面也不会左右抖。
 *  传给库的秒数在 AnimatedSeconds 里先量化到 0.1s：上游是每帧都在长的毫秒数，
 *  不量化的话每秒几十次补间，看着反而毛躁。 */
export function StatsBar() {
  // 补间开关：只有「同一个会话内的数值在长」才滚动。
  // 换会话 / 换工作目录时 stats 会整体换成另一份（从 A 会话的数跳到 B 会话的数），
  // 那是「换了组数」而不是「这个数在长」，补间既无意义又会把输入栏宽度抖一下。
  // 用 stats 对象的身份变化来判定：换会话必然换对象。
  const stats = useSession((s) => s.stats)
  const statsKeyRef = useRef(stats)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    // stats 换了对象 = 换会话：不补间；同一个对象 = 同一会话内增长：补间
    if (statsKeyRef.current !== stats) {
      statsKeyRef.current = stats
      setSettled(false)
    } else if (!settled) {
      setSettled(true)
    }
  }, [stats, settled])
  const turnMeta = useSession((s) => s.turnMeta)
  const runState = useSession((s) => s.runState)
  // 上游抖动、引擎在自动重试：这段时间没有任何内容产出，必须明说，
  // 否则用户看到的就是「卡住不动」（2026-09-29 的「做一半不回我」就是这么被感知的）。
  const retrying = useSession((s) => s.retrying)

  const llmSeconds = stats.llmMs ? stats.llmMs / 1000 : null
  const toolSeconds = stats.toolMs ? stats.toolMs / 1000 : null
  const firstTokenSeconds = stats.firstTokenCount ? stats.firstTokenMsSum / stats.firstTokenCount / 1000 : null
  const speed = turnMeta?.outputTokensPerSecond ?? null
  const active = runState === 'idle' ? null : RUN_STATE[runState]

  const item = (label: string, value: React.ReactNode, tone?: string) => (
    // items-baseline 而不是 items-center：数字是 inline-block 盒子，
    // 按盒子中心对齐会让它比旁边的文字基线高一点，看着不平。
    <span key={label} className='flex items-baseline gap-1 whitespace-nowrap tabular-nums'>
      <span className='text-ink-4'>{label}</span>
      <span className={tone ?? 'text-ink-2'}>{value}</span>
    </span>
  )

  return (
    // min-h 固定：数字换行/位数变化时不撑高输入区（输入栏闪动的另一半原因）
    <div className='flex min-h-[16px] flex-wrap items-center gap-x-3 gap-y-1 px-1 text-11 text-ink-3'>
      {stats.turns || stats.steps ? (
        <span className='flex items-baseline gap-1 whitespace-nowrap tabular-nums'>
          <AnimatedCount value={stats.turns} animate={settled} />
          <span className='text-ink-4'>轮</span>
          <span className='text-ink-4'>·</span>
          <AnimatedCount value={stats.steps} animate={settled} />
          <span className='text-ink-4'>步</span>
        </span>
      ) : null}
      {llmSeconds != null ? item('LLM', <AnimatedSeconds seconds={llmSeconds} animate={settled} />) : null}
      {toolSeconds != null ? item('工具', <AnimatedSeconds seconds={toolSeconds} animate={settled} />) : null}
      {firstTokenSeconds != null ? item('首 token', <AnimatedSeconds seconds={firstTokenSeconds} animate={settled} />) : null}
      {speed != null ? item('速度', <AnimatedNumber value={speed} format={{ maximumFractionDigits: 0 }} suffix=' tok/s' />) : null}
      {stats.cacheHitRate != null
        ? item('缓存', <AnimatedPercent ratio={stats.cacheHitRate} animate={settled} />, stats.cacheHitRate > 0.5 ? 'text-ok' : 'text-ink-2')
        : null}
      {stats.inputTokens ? item('输入', <AnimatedTokens value={stats.inputTokens} animate={settled} />) : null}
      {stats.outputTokens ? item('输出', <AnimatedTokens value={stats.outputTokens} animate={settled} />) : null}
      {!stats.turns && !stats.inputTokens ? <span className='text-ink-4'>这个会话还没有用量</span> : null}
      <span className='flex-1' />
      {/* 本轮的「首 token 延迟」与「生成耗时」分开给：合成一个数字说不清
          「是一直没开口，还是说了很久」。两者都只认引擎口径（见 lib/chat.ts），
          取不到或越界时 AnimatedDuration 会落到「—」。 */}
      {turnMeta ? item('本轮首 token', <AnimatedDuration ms={turnMeta.firstTokenMs} />) : null}
      {turnMeta ? item('本轮生成', <AnimatedDuration ms={turnMeta.generationMs} />) : null}
      {/* 运行态：等待授权 / 等待回答也走同一套状态语言，颜色和形状都能一眼分辨 */}
      {retrying ? (
        <span className='flex items-center gap-1.5 text-warn'>
          <AgentState state='awaiting' size='xs' tone='warn' />
          正在自动恢复（第 {retrying.attempt}/{retrying.max} 次
          {retrying.delayMs ? '，约 ' + Math.max(1, Math.round(retrying.delayMs / 1000)) + 's 后重试' : ''}）
        </span>
      ) : active ? (
        <span className='animate-bar flex items-center gap-1.5 text-primary'>
          <AgentState state={active.state} size='xs' />
          {active.text}
        </span>
      ) : null}
    </div>
  )
}
