/**
 * 统计页签：本轮 / 会话累计 / 实时上下文与缓存 / 引擎用量账本。
 * 数据来源：
 * - 会话累计与会话内统计：stores/session 的 stats 与 turnMeta（来自 WS 事件流）
 * - 实时上下文、缓存命中、首 token 延迟、输出速度：stores/engine 的 usage
 * - 跨会话账本：GET /api/usage（引擎的 usage/ledger.jsonl 聚合；每条记录带 session_id 与 model，
 *   旧记录没有这两个字段，聚合时按空串兜底并跳过）
 * - 按模型：在账本记录上另做一份聚合（同模型 token 合计 + 请求数），不改动上面的全局口径
 * 图全部用 div + 主题变量拼，不引第三方图表库。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Gauge, RefreshCw, Sigma } from 'lucide-react'
import { fmtDuration, fmtTokens } from '../../lib/format'
import { useEngine, type UsageState } from '../../stores/engine'
import { useNavPause } from './navPause'
import { useSession } from '../../stores/session'
import { Empty } from '../ui/Card'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Controls'
import { Tip } from '../ui/Overlay'
import { DockSection, MeterRow, MetricRow } from './dockMetrics'
import { StateBlock } from './dockShared'

type RangeKey = 'today' | '7d' | '30d'

interface UsageRecord {
  timestamp_ms?: number
  input_tokens?: number
  output_tokens?: number
  cached_input_tokens?: number
  total_tokens?: number
  elapsed_ms?: number
  /** 引擎新写的账本行带会话与模型；旧行没有，读取侧一律 ?? '' 兜底。 */
  session_id?: string
  model?: string
}

interface ModelTotal {
  model: string
  tokens: number
  requests: number
}

interface UsageLedger {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  requests?: number
  records?: UsageRecord[]
}

const RANGES: Array<{ value: RangeKey; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
]

function rangeStart(range: RangeKey): number {
  const now = new Date()
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const days = range === '7d' ? 7 : 30
  return now.getTime() - days * 86_400_000
}

function dayLabel(ms: number): string {
  const d = new Date(ms)
  return (d.getMonth() + 1) + '/' + d.getDate()
}

/** 把账本流水按「天」聚合成柱状图数据；超过 30 天只画最近 30 根。 */
function dailyTotals(records: UsageRecord[]): Array<{ label: string; tokens: number }> {
  const buckets = new Map<string, { at: number; tokens: number }>()
  for (const record of records) {
    const at = Number(record.timestamp_ms ?? 0)
    if (!at) continue
    const d = new Date(at)
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    const slot = buckets.get(key) ?? { at, tokens: 0 }
    slot.tokens += Number(record.total_tokens ?? 0)
    buckets.set(key, slot)
  }
  return [...buckets.values()]
    .sort((a, b) => a.at - b.at)
    .slice(-30)
    .map((slot) => ({ label: dayLabel(slot.at), tokens: slot.tokens }))
}

/**
 * 按模型聚合账本流水：同一模型的 token 合计 + 请求数，token 多的排前面。
 * 老记录没有 model 字段，读出来是空串：直接跳过，而不是塞进「未知模型」这种假分类。
 */
function modelTotals(records: UsageRecord[]): ModelTotal[] {
  const buckets = new Map<string, ModelTotal>()
  for (const record of records) {
    const model = String(record.model ?? '').trim()
    if (!model) continue
    const slot = buckets.get(model) ?? { model, tokens: 0, requests: 0 }
    slot.tokens += Number(record.total_tokens ?? 0)
    slot.requests += 1
    buckets.set(model, slot)
  }
  return [...buckets.values()].sort((a, b) => b.tokens - a.tokens)
}

/** 账本覆盖的会话数：同样跳过没有 session_id 的旧记录。 */
function sessionCount(records: UsageRecord[]): number {
  const ids = new Set<string>()
  for (const record of records) {
    const id = String(record.session_id ?? '').trim()
    if (id) ids.add(id)
  }
  return ids.size
}

/** 命中率 → 百分比文本：缺数据 / 非有限值时给「—」，绝不编出 0%。 */
function pct(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—'
  return Math.round(Math.max(0, Math.min(1, rate)) * 100) + '%'
}

/** 累计命中率的三态：
    ready = 有可用比例；unsupported = 引擎明确说本模型 / 供应商不提供（显示「未提供」而不是 0%）；
    pending = 旧引擎没这个字段，或引擎这一拍还没算出来。 */
function cacheAvailability(available: boolean | null, rate: number | null): 'ready' | 'unsupported' | 'pending' {
  if (available === false) return 'unsupported'
  if (rate != null && Number.isFinite(rate)) return 'ready'
  return 'pending'
}

/** 本轮命中率的三态：本轮刚开始时 turn_cache_data_available 也是 false，
    不能据此断言「本模型不提供」——只有累计口径明确不支持时才那么说。 */
function turnAvailability(totalAvailable: boolean | null, turnAvailable: boolean | null): 'ready' | 'unsupported' | 'pending' {
  if (totalAvailable === false) return 'unsupported'
  if (turnAvailable === true) return 'ready'
  return 'pending'
}

export function DockUsageTab({ refresh, onRefresh }: { refresh: number; onRefresh: () => void }) {
  const ready = useEngine((s) => s.ready)
  /* 过渡期间把用量「冻」住，收闸一次性补上（排队 + 一次 flush）：
     引擎每来一个 token 就换一次 usage 的引用，而这一页是侧栏里最重的一块
     （数字滚动 + 若干图表），过渡那 250ms 里跟着重算纯属和过渡抢主线程。
     做法：暂停时选择器返回**上一次那个引用**（Object.is 相同 → zustand 不通知 → 不重渲染）；
     收闸时 useNavPause 翻回 false，组件重渲染、选择器重算，最新用量一次到位。 */
  const paused = useNavPause()
  const held = useRef<UsageState | null>(null)
  const usage = useEngine((s) => {
    if (paused) return held.current ?? s.usage
    held.current = s.usage
    return s.usage
  })
  const stats = useSession((s) => s.stats)
  const turnMeta = useSession((s) => s.turnMeta)
  const sessionId = useSession((s) => s.sessionId)

  const [range, setRange] = useState<RangeKey>('7d')
  const [ledger, setLedger] = useState<UsageLedger | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!ready) { setLedger(null); return }
    let alive = true
    setBusy(true)
    setError('')
    const from = rangeStart(range)
    void useEngine.getState()
      .api<UsageLedger>('/api/usage?from=' + from + '&to=' + Date.now())
      .then((data) => { if (alive) { setLedger(data); setBusy(false) } })
      .catch((e) => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setLedger(null); setBusy(false) } })
    return () => { alive = false }
  }, [ready, range, refresh])

  const days = useMemo(() => dailyTotals(ledger?.records ?? []), [ledger])
  const peak = Math.max(1, ...days.map((d) => d.tokens))
  const byModel = useMemo(() => modelTotals(ledger?.records ?? []), [ledger])
  const sessions = useMemo(() => sessionCount(ledger?.records ?? []), [ledger])

  // 权威来源是 stores/engine 的 usage（WS usage_update 实时推送）；session stats 是同一事件按会话持久化的兜底，
  // 两者本就同源，这里只做「实时优先、历史兜底」，不再另起一份口径。
  const cacheRate = usage.cacheHitRate ?? stats.cacheHitRate
  const cacheState = cacheAvailability(usage.cacheDataAvailable, cacheRate)
  const turnState = turnAvailability(usage.cacheDataAvailable, usage.turnCacheDataAvailable)
  const cachedInputTokens = usage.cachedInput || stats.cachedInputTokens
  const inputTokens = usage.input || stats.inputTokens
  const contextRatio = usage.contextWindow ? Math.min(1, usage.contextUsed / usage.contextWindow) : 0
  const toolRatio = stats.llmMs + stats.toolMs > 0 ? stats.toolMs / (stats.llmMs + stats.toolMs) : 0
  const avgFirstToken = stats.firstTokenCount ? stats.firstTokenMsSum / stats.firstTokenCount : null

  return (
    <div data-dock-tab='stats' className='flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overflow-x-hidden p-2.5'>
      <DockSection
        title='本轮'
        hint={turnMeta ? turnMeta.model : '这一轮还没结束'}
        actions={
          <Tip label='刷新账本'>
            <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={onRefresh}><RefreshCw size={12} /></Button>
          </Tip>
        }
      >
        <MetricRow label='本轮 token' value={usage.turnTotal != null ? fmtTokens(usage.turnTotal) : '—'} />
        <MetricRow label='首 token 延迟' value={fmtDuration(usage.firstTokenLatencyMs)} hint={turnMeta?.firstTokenMs != null ? '本轮记录' : undefined} />
        <MetricRow label='输出速度' value={usage.outputTokensPerSecond != null ? usage.outputTokensPerSecond.toFixed(1) + ' tok/s' : '—'} />
        <MetricRow label='本轮耗时' value={turnMeta ? fmtDuration(turnMeta.endedAt - turnMeta.startedAt) : '—'} />
      </DockSection>

      {/* 缓存命中率默认可见：省钱的唯一直接指标 —— 命中率高 = 同样的前缀被上游复用，
          不重复计费、首 token 也更快。供应商没给缓存字段时明确说「未提供」，
          绝不能落成 0%（0% 会被读成「一次都没命中」，把用户吓一跳）。 */}
      <DockSection title='缓存命中率' hint='越高越省钱：系统提示与历史前缀被上游复用，不重复计费，速度也更快'>
        {cacheState === 'ready' ? (
          <MeterRow
            label='累计命中率'
            ratio={Math.min(1, Math.max(0, cacheRate ?? 0))}
            value={pct(cacheRate)}
            hint={'命中 ' + fmtTokens(cachedInputTokens) + ' / 输入 ' + fmtTokens(inputTokens) + ' token'}
            tone='ok'
          />
        ) : (
          <MetricRow
            label='累计命中率'
            value={cacheState === 'unsupported' ? '未提供' : '—'}
            hint={cacheState === 'unsupported'
              ? '本模型/供应商未提供缓存计量，不代表命中率是 0%'
              : '引擎尚未上报该指标'}
          />
        )}
        {turnState === 'ready' && usage.turnCacheHitRate != null ? (
          <MetricRow label='本轮命中率' value={pct(usage.turnCacheHitRate)} hint='本轮请求里命中缓存的比例' />
        ) : (
          <MetricRow
            label='本轮命中率'
            value={turnState === 'unsupported' ? '未提供' : '—'}
            hint={turnState === 'unsupported'
              ? '本模型/供应商未提供缓存计量'
              : '本轮还没有缓存计量（新一轮刚开始或尚未上报）'}
          />
        )}
      </DockSection>

      <DockSection title='会话累计' hint={sessionId ? '按会话单独记账，切会话不串号' : '还没有打开的会话'}>
        <MetricRow label='累计 token' value={fmtTokens(stats.totalTokens)} />
        <MetricRow label='输入 / 输出' value={fmtTokens(stats.inputTokens) + ' / ' + fmtTokens(stats.outputTokens)} />
        <MetricRow label='缓存命中输入' value={fmtTokens(stats.cachedInputTokens)} />
        <MetricRow label='轮次 / 工具步数' value={stats.turns + ' / ' + stats.steps} />
        <MetricRow label='模型耗时' value={fmtDuration(stats.llmMs)} />
        <MetricRow label='工具耗时' value={fmtDuration(stats.toolMs)} />
        <MetricRow label='平均首 token' value={fmtDuration(avgFirstToken)} />
        <MeterRow
          label='工具耗时占比'
          ratio={toolRatio}
          value={Math.round(toolRatio * 100) + '%'}
          hint='工具耗时 /（模型耗时 + 工具耗时）'
        />
      </DockSection>

      <DockSection title='上下文占用' hint='来自引擎实时推送的 usage 事件'>
        {usage.contextWindow ? (
          <MeterRow
            label='上下文占用'
            ratio={contextRatio}
            value={fmtTokens(usage.contextUsed) + ' / ' + fmtTokens(usage.contextWindow)}
            hint={'剩余 ' + fmtTokens(Math.max(0, usage.contextWindow - usage.contextUsed)) + ' token'}
            tone={contextRatio > 0.85 ? 'danger' : contextRatio > 0.6 ? 'warn' : 'primary'}
          />
        ) : (
          <MetricRow label='上下文窗口' value='—' hint='引擎尚未上报' />
        )}
      </DockSection>

      <DockSection
        title='引擎用量账本'
        hint='/api/usage 聚合，跨会话累计'
        actions={<Segmented value={range} options={RANGES} onChange={setRange} />}
      >
        <StateBlock
          loading={busy && !ledger}
          error={error}
          onRetry={onRefresh}
          empty={!ledger}
          emptyArt='artifacts'
          emptyTitle='没有读取到用量账本'
          emptyDesc='引擎未就绪，或这个区间还没有流水。'
        >
          {ledger ? (
            <>
              <MetricRow label='请求次数' value={String(ledger.requests ?? 0)} />
              <MetricRow label='总 token' value={fmtTokens(ledger.total_tokens ?? 0)} />
              <MetricRow label='输入 / 输出' value={fmtTokens(ledger.input_tokens ?? 0) + ' / ' + fmtTokens(ledger.output_tokens ?? 0)} />
              <MetricRow label='缓存命中输入' value={fmtTokens(ledger.cached_input_tokens ?? 0)} />

              {days.length ? (
                <div className='mt-3 min-w-0'>
                  {/* 柱子容器写 min-h-16 而不是只有 h-16：弹性列里只给高度会被压成一条「显示不全的长方形」 */}
                  <div className='flex h-16 min-h-16 items-end gap-1'>
                    {days.map((day) => (
                      <Tip key={day.label} label={day.label + ' · ' + fmtTokens(day.tokens) + ' token'}>
                        <div className='flex h-full min-h-16 min-w-0 flex-1 items-end'>
                          <div
                            className={cnBar(day.tokens, peak)}
                            style={{ height: Math.max(4, Math.round((day.tokens / peak) * 100)) + '%' }}
                          />
                        </div>
                      </Tip>
                    ))}
                  </div>
                  <div className='mt-1 flex min-w-0 items-center justify-between gap-1 text-11 tabular-nums text-ink-4'>
                    <span className='min-w-0 truncate' title={days[0].label}>{days[0].label}</span>
                    <span className='shrink-0'>峰值 {fmtTokens(peak)}</span>
                    <span className='min-w-0 truncate' title={days[days.length - 1].label}>{days[days.length - 1].label}</span>
                  </div>
                </div>
              ) : (
                // 空态统一走 Empty 组件，不再各页各写一段灰字。
                <Empty compact art='artifacts' title='这个区间还没有用量流水' description='换个时间区间，或等引擎把用量记账写进来。' />
              )}

              {byModel.length ? (
                <div className='mt-3 border-t border-line-soft pt-2'>
                  <p className='min-w-0 break-words text-11 text-ink-4'>
                    按模型{sessions ? ' · 覆盖 ' + sessions + ' 个会话' : ''}
                  </p>
                  {byModel.slice(0, 8).map((row) => (
                    <MetricRow
                      key={row.model}
                      label={row.model}
                      hint={row.requests + ' 次请求'}
                      value={fmtTokens(row.tokens)}
                    />
                  ))}
                  {byModel.length > 8 ? <p className='px-1 pt-0.5 text-11 text-ink-4'>只显示 token 最多的 8 个模型。</p> : null}
                </div>
              ) : null}
            </>
          ) : null}
        </StateBlock>
      </DockSection>

      <p className='flex min-w-0 items-start gap-1.5 px-1 text-11 leading-[1.5] text-ink-4'>
        <Sigma size={12} className='mt-[2px] shrink-0' /> 账本来自引擎 usage/ledger.jsonl，时间区间按本机时区。
      </p>
      <p className='flex min-w-0 items-start gap-1.5 px-1 text-11 leading-[1.5] text-ink-4'>
        <Gauge size={12} className='mt-[2px] shrink-0' /> 缺省值显示「—」表示引擎尚未上报该指标，而不是 0。
      </p>
      <p className='flex min-w-0 items-start gap-1.5 px-1 text-11 leading-[1.5] text-ink-4'>
        <BarChart3 size={12} className='mt-[2px] shrink-0' /> 柱状图为每日 token 总量。
      </p>
    </div>
  )
}

/** 柱子样式：高占比用主色，其余用弱化的面板色，避免整片同一块颜色。 */
function cnBar(tokens: number, peak: number): string {
  const strong = tokens >= peak * 0.6
  return 'w-full min-h-[3px] rounded-t-[3px] transition-[height] duration-[var(--motion-base)] ' + (strong ? 'bg-primary' : 'bg-primary/45')
}
