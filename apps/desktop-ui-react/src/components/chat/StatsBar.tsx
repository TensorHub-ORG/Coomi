import { useEffect, useRef, useState } from 'react'
import { useSession } from '../../stores/session'
import { AnimatedPercent, AnimatedTokens } from '../ui/Number'

/** 输入框下方只保留对用户有用的用量：缓存命中、输入、输出。
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

  const item = (label: string, value: React.ReactNode, tone?: string) => (
    // items-baseline 而不是 items-center：数字是 inline-block 盒子，
    // 按盒子中心对齐会让它比旁边的文字基线高一点，看着不平。
    <span key={label} data-stat={label} className='flex items-baseline gap-1 whitespace-nowrap tabular-nums'>
      <span className='text-ink-4'>{label}</span>
      <span className={tone ?? 'text-ink-2'}>{value}</span>
    </span>
  )

  return (
    // min-h 固定：数字换行/位数变化时不撑高输入区（输入栏闪动的另一半原因）
    <div data-chat-stats className='flex min-h-[16px] flex-wrap items-center gap-x-3 gap-y-1 px-1 text-11 text-ink-3'>
      {stats.cacheHitRate != null
        ? item('缓存', <AnimatedPercent ratio={stats.cacheHitRate} animate={settled} />, stats.cacheHitRate > 0.5 ? 'text-ok' : 'text-ink-2')
        : null}
      {stats.inputTokens ? item('输入', <AnimatedTokens value={stats.inputTokens} animate={settled} />) : null}
      {stats.outputTokens ? item('输出', <AnimatedTokens value={stats.outputTokens} animate={settled} />) : null}
      {stats.cacheHitRate == null && !stats.inputTokens && !stats.outputTokens ? <span className='text-ink-4'>暂无用量</span> : null}
    </div>
  )
}
