/**
 * 上下文页签：把当前会话的上下文占用讲清楚。
 * 数据来源：
 * - 已用 / 剩余 / 有效窗口 / 压缩阈值 / 压缩次数：GET /api/sessions/{id}/context
 *   （引擎完整 ContextStatus，与终端界面同源，是精确值而不是前端推导）
 * - 压缩历史（compaction_history）：同一次 GET 里带的 CompactionRecord 列表——
 *   每次压缩的 before/after token、原因（token_limit / message_limit / manual…）与条数，
 *   所以「为什么压的、压掉多少」都按「窗口的 N% · 手动/自动（原因）」展示，而不是只给一个次数
 * - 消息条数 / 字符数 / 流式状态：stores/session 的 messages（单一消息数组）
 * - 执行配置：GET /api/agent/preferences（思考强度 / 放行程度 / 最大工具轮次）
 * 降级：端点不可用时（引擎较旧 / 会话还没落盘 / 请求失败）回落到按引擎同规则推导的估算值，
 * 并在页顶与「压缩」卡片里明确标注「估算」，绝不把推导值当精确值展示。
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileText, Gauge, History, Layers, RefreshCw, Shrink } from 'lucide-react'
import { fmtTime, fmtTokens } from '../../lib/format'
import { EFFORT_LABELS, PERMISSION_LABELS, useAgent } from '../../stores/agent'
import { useEngine } from '../../stores/engine'
import { useSession } from '../../stores/session'
import { Button } from '../ui/Button'
import { Tip } from '../ui/Overlay'
import { DockApiError, fetchSessionContext } from './dockApi'
import type { SessionContextStatus } from './dockApi'
import { DockSection, MeterRow, MetricRow } from './dockMetrics'
import { StateBlock } from './dockShared'

interface Preferences {
  reasoningEffort?: string
  permissionMode?: string
  maxToolRounds?: number
}

/** 引擎的 token 估算口径（apps/coomi-rs/ui/src/web/mod.rs 的 estimated_tokens）：(字节数 + 3) / 4。 */
function estimateTokens(text: string): number {
  return Math.max(0, Math.floor((text.length + 3) / 4))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function numOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/* ── 压缩的原因与占比 ──
   引擎的 CompactionReason（apps/coomi-rs/engine/src/types.rs）落到事件与压缩历史上是这些字符串。
   界面上不再只说「压缩了」，而是「窗口的 16% · 手动」/「窗口的 16% · 自动（消息条数触发）」。 */
const COMPACTION_REASONS: Record<string, string> = {
  token_limit: '达到 token 阈值',
  context_window: '窗口耗尽',
  comp_hash: '前缀指纹变化',
  message_limit: '消息条数触发',
  provider_error: '上游报上下文超限',
  manual: '手动',
}

/** 引擎 CompactionRecord（GET /api/sessions/{id}/context 的 compaction_history 元素）。 */
interface CompactionRecord {
  /** 压缩完成的 Unix 毫秒时间戳。 */
  at_ms?: number
  /** true = 自动触发，false = 用户手动触发。 */
  automatic?: boolean
  reason?: string
  before_tokens?: number
  after_tokens?: number
  messages_before?: number
  messages_after?: number
}

/** 「窗口的 16%」：分母一律用引擎上报的上下文窗口；窗口未知时明确写占位，不编一个百分比。 */
function windowShare(tokens: number, window: number): string {
  if (!window) return '窗口占比 —'
  return '窗口的 ' + Math.round((tokens / window) * 100) + '%'
}

/** 「窗口的 16% · 手动」：占比 + 触发方式；自动的再补一句是哪条条件命中的。 */
function compactionTrigger(record: CompactionRecord, window: number): string {
  const share = windowShare(numOr(record.before_tokens, 0), window)
  if (record.automatic === false) return share + ' · 手动'
  const raw = String(record.reason ?? '')
  const reason = COMPACTION_REASONS[raw] ?? (raw || '原因未知')
  return share + ' · 自动（' + reason + '）'
}

/** 实时事件只有 before / after / reason（没有 automatic 位）：reason=manual 就是用户手动触发的。 */
function liveRecord(event: Record<string, any>): CompactionRecord {
  const reason = String(event.reason ?? '')
  return {
    automatic: reason !== 'manual',
    reason,
    before_tokens: numOr(event.before, 0),
    after_tokens: numOr(event.after, 0),
  }
}

/** 压缩历史的单行摘要：时间 + 触发原因与占比 + 前后 token / 条数。 */
function compactionDetail(record: CompactionRecord): string {
  const before = fmtTokens(numOr(record.before_tokens, 0))
  const after = fmtTokens(numOr(record.after_tokens, 0))
  const from = numOr(record.messages_before, 0)
  const to = numOr(record.messages_after, 0)
  return before + ' → ' + after + ' token · ' + from + ' → ' + to + ' 条'
}

export function DockContextTab({ refresh, onRefresh }: { refresh: number; onRefresh: () => void }) {
  const ready = useEngine((s) => s.ready)
  const usage = useEngine((s) => s.usage)
  const messages = useSession((s) => s.messages)
  const streaming = useSession((s) => s.streaming)
  const sessionId = useSession((s) => s.sessionId)
  const connected = useSession((s) => s.connected)
  const sendCommand = useSession((s) => s.sendCommand)
  const effort = useAgent((s) => s.effort)
  const permission = useAgent((s) => s.permission)

  const [prefs, setPrefs] = useState<Preferences | null>(null)
  const [prefsError, setPrefsError] = useState('')
  const [prefsBusy, setPrefsBusy] = useState(false)

  /** 引擎精确值：GET /api/sessions/{id}/context 拿到的完整 ContextStatus。 */
  const [context, setContext] = useState<SessionContextStatus | null>(null)
  const [contextError, setContextError] = useState('')
  const [contextBusy, setContextBusy] = useState(false)

  useEffect(() => {
    if (!ready || !sessionId) {
      setContext(null)
      setContextError('')
      setContextBusy(false)
      return
    }
    let alive = true
    setContextBusy(true)
    void fetchSessionContext(sessionId)
      .then((data) => { if (alive) { setContext(data); setContextError(''); setContextBusy(false) } })
      .catch((e) => {
        // 拿不到精确值就回落到下面的推导值，但保留原因让用户知道为什么是估算。
        // 404 = 引擎里还没有这个会话的落盘记录（刚开的新会话很常见），换成可读说法而不是英文原文。
        if (!alive) return
        const message = e instanceof DockApiError && e.status === 404
          ? '引擎里还没有这个会话的落盘记录（新会话首次落盘前只有估算值）'
          : e instanceof Error ? e.message : String(e)
        setContext(null)
        setContextError(message)
        setContextBusy(false)
      })
    return () => { alive = false }
  }, [ready, sessionId, refresh])

  useEffect(() => {
    if (!ready) { setPrefs(null); return }
    let alive = true
    setPrefsBusy(true)
    setPrefsError('')
    void useEngine.getState()
      .api<Preferences>('/api/agent/preferences')
      .then((data) => { if (alive) { setPrefs(data); setPrefsBusy(false) } })
      .catch((e) => { if (alive) { setPrefsError(e instanceof Error ? e.message : String(e)); setPrefs(null); setPrefsBusy(false) } })
    return () => { alive = false }
  }, [ready, refresh])

  const roles = { user: 0, assistant: 0, tool: 0, other: 0 }
  let chars = 0
  let estimated = 0
  let compactionSummaries = 0
  for (const item of messages) {
    if (item.kind === 'user') roles.user += 1
    else if (item.kind === 'assistant') {
      roles.assistant += 1
      // 工具调用折进助手那条：参数 + 结果预览的字符量。
      const calls = item.tools.map((t) => (t.args ?? '') + (t.preview ?? '')).join('')
      chars += item.text.length + calls.length
      estimated += estimateTokens(item.text) + estimateTokens(calls)
    }
    else if (item.kind === 'notice') {
      roles.other += 1
      chars += item.text.length
      estimated += estimateTokens(item.text)
      if (item.text.startsWith('上下文已压缩')) compactionSummaries += 1
    }
    else roles.other += 1
  }

  /* ── 展示口径 ──
     precise 有值时全部走引擎 ContextStatus；没有值时用下面这几个推导量兜底（页面上会标明估算）。 */
  // 会话切换后、新请求回来之前，context 里可能还是上一个会话的数据：用 session_id 挡掉。
  const precise = context && (!context.session_id || context.session_id === sessionId) ? context : null
  const estimatedWindow = usage.contextWindow
  const estimatedUsed = usage.contextUsed || estimated
  // 引擎真实规则：auto_compact_token_limit = min(窗口 × 90%, 有效窗口)；有效窗口 = 窗口 × 95%。
  const estimatedLimit = estimatedWindow ? Math.min(Math.round(estimatedWindow * 0.9), Math.round(estimatedWindow * 0.95)) : 0

  const windowTokens = precise?.context_window || estimatedWindow
  const effective = precise ? precise.effective_context_window : windowTokens ? Math.round(windowTokens * 0.95) : 0
  const used = precise ? precise.used_tokens : estimatedUsed
  const remaining = precise ? precise.remaining_tokens : Math.max(0, effective - used)
  const compactLimit = precise ? precise.auto_compact_token_limit : estimatedLimit
  const compactScope = precise ? precise.auto_compact_scope_tokens : used
  const compactionCount = precise ? precise.compaction_count : compactionSummaries
  // used_percent 是引擎自己算的口径（与终端界面显示的 ctx N% 一致）；降级时按已用 / 窗口算。
  const usedRatio = precise ? clamp01(precise.used_percent / 100) : windowTokens ? clamp01(used / windowTokens) : 0
  const compactRatio = compactLimit ? clamp01(compactScope / compactLimit) : 0

  /* 窗口是从哪儿来的：精确值走会话落盘的能力配置，降级值走引擎的实时用量上报。
     压缩占比的分母就是这个数，所以来源必须与数字一起显示，不能只给一个百分比。 */
  const windowSource = precise?.context_window
    ? '引擎 ContextStatus（会话能力配置）'
    : estimatedWindow ? '引擎用量上报（usage.context_window_tokens）' : '引擎尚未上报'
  const limitShare = windowTokens && compactLimit ? Math.round((compactLimit / windowTokens) * 100) : 0

  /* 压缩历史：引擎在同一次 GET 里补的 compaction_history（最近 50 条，越靠后越新）。
     dockApi 的 SessionContextStatus 类型里还没有这个字段，这里按需读，缺了就当没有。 */
  const compactionHistory = useMemo<CompactionRecord[]>(() => {
    const raw = (precise as unknown as { compaction_history?: unknown } | null)?.compaction_history
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is CompactionRecord => !!item && typeof item === 'object')
  }, [precise])
  const latestCompaction = compactionHistory.length ? compactionHistory[compactionHistory.length - 1] : null

  /* 本轮的压缩提示：引擎 CompactionCompleted 推的实时事件（带 reason），
     历史要等落盘才有，这一条保证「刚压完」立刻能看见原因与占比（走事件里的 before/after）。 */
  const liveCompaction = useMemo<{ before: number; after: number } | null>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const item = messages[i]
      if (item.kind !== 'notice' || !item.text.startsWith('上下文已压缩')) continue
      const match = /^上下文已压缩\s*(\d+)\s*→\s*(\d+)/.exec(item.text)
      if (match) return { before: Number(match[1]), after: Number(match[2]) }
      return null
    }
    return null
  }, [messages])

  const compress = (): void => {
    // 引擎把 /compact 当成一条特殊消息处理（见 web/mod.rs 的 send_message 分支），
    // 走 WS 命令下发，不会在会话里留下用户气泡。
    sendCommand({ command: 'send_message', text: '/compact' })
  }

  return (
    <div data-dock-tab='context' className='flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overflow-x-hidden p-2.5'>
      {contextError ? (
        <div className='rounded-md border border-warn/40 bg-warn-soft px-2.5 py-2 text-11 leading-[1.5] text-warn'>
          <p className='flex items-start gap-1.5'>
            <AlertTriangle size={12} className='mt-[2px] shrink-0' />
            <span className='min-w-0 break-all'>拿不到引擎精确值：{contextError}</span>
          </p>
          <p className='mt-0.5'>下面的占用与压缩数据是按已上报窗口和历史推导的估算值，不是引擎精确值。</p>
          <button type='button' className='mt-1 underline underline-offset-2' onClick={onRefresh}>重试</button>
        </div>
      ) : null}

      <DockSection
        title='上下文占用'
        hint={precise
          ? '引擎精确值 · GET /api/sessions/{id}/context' + (precise.model ? ' · ' + precise.model : '')
          : windowTokens ? '端点不可用，按已上报窗口估算' : '引擎尚未上报上下文窗口'}
        actions={
          <Tip label='刷新'>
            <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={onRefresh}><RefreshCw size={12} /></Button>
          </Tip>
        }
      >
        {contextBusy && !precise && !windowTokens ? (
          <StateBlock loading />
        ) : windowTokens ? (
          <>
            <MeterRow
              label='已用 / 有效窗口'
              ratio={usedRatio}
              value={fmtTokens(used) + ' / ' + fmtTokens(effective || windowTokens)}
              hint={'剩余 ' + fmtTokens(remaining) + ' token' + (precise ? ' · 引擎口径 ' + precise.used_percent + '%' : ' · 估算')}
              tone={usedRatio > 0.85 ? 'danger' : usedRatio > 0.6 ? 'warn' : 'primary'}
            />
            <MeterRow
              label='距压缩阈值'
              ratio={compactRatio}
              value={Math.round(compactRatio * 100) + '%'}
              hint={'阈值 ' + fmtTokens(compactLimit) + ' token（' + windowShare(compactLimit, windowTokens) + '）'
                + (precise ? ' · 已计入压缩判定 ' + fmtTokens(compactScope) + ' token' : ' · 估算')}
              tone={compactRatio >= 1 ? 'danger' : compactRatio > 0.75 ? 'warn' : 'ok'}
            />
            <MetricRow
              label='上下文窗口'
              value={fmtTokens(windowTokens) + ' token'}
              hint={(precise ? '有效窗口 ' + fmtTokens(effective) + ' token' : '按窗口 × 95% 估算') + ' · 来源：' + windowSource}
            />
            {precise ? (
              <MetricRow label='精确已用' value={used.toLocaleString('zh-CN')} hint='ContextStatus.used_tokens' />
            ) : null}
            {contextBusy ? <p className='pt-1 text-11 text-ink-4'>正在读取引擎精确值…</p> : null}
          </>
        ) : (
          <MetricRow label='上下文窗口' value='—' hint='引擎未上报，暂无法计算占比' />
        )}
      </DockSection>

      <DockSection title='会话内容' hint={sessionId ? '来自 messages（引擎落库 + 实时就地追加的唯一消息数组）' : '还没有打开的会话'}>
        <MetricRow label='消息总数' value={String(messages.length)} />
        <MetricRow label='用户 / 助手 / 工具' value={roles.user + ' / ' + roles.assistant + ' / ' + roles.tool} />
        <MetricRow label='字符数' value={chars.toLocaleString('zh-CN')} />
        <MetricRow label='估算 token' value={fmtTokens(estimated)} hint='按引擎口径 (字符数+3)/4' />
        <MetricRow label='流式状态' value={streaming ? '正在生成' : '已结束'} />
      </DockSection>

      <DockSection
        title='压缩'
        hint={precise
          ? '引擎精确值 · compaction_count / compaction_history · 窗口来源：' + windowSource
          : '端点不可用，按历史摘要与引擎规则估算 · 窗口来源：' + windowSource}
        actions={
          <Tip label={connected ? '下发引擎的 /compact 命令' : '连接已断开'}>
            <Button
              variant='ghost'
              size='sm'
              className='h-6 gap-1 px-1.5 text-11'
              disabled={!connected || !sessionId || streaming}
              onClick={compress}
            >
              <Shrink size={12} /> 立即压缩
            </Button>
          </Tip>
        }
      >
        {/* 压缩提示：刚压完的那一次（实时事件，带原因）优先，其次是最新的历史记录。 */}
        {liveCompaction || latestCompaction ? (
          <div
            className='mb-1 flex min-w-0 flex-col gap-0.5 rounded-md border border-line-soft bg-muted px-2 py-1.5 text-11 leading-[1.55]'
            data-testid='compaction-notice'
          >
            <span className='min-w-0 break-words text-ink-2'>
              {liveCompaction
                ? '本轮已压缩：' + compactionTrigger(liveRecord(liveCompaction), windowTokens)
                : '最近一次压缩：' + compactionTrigger(latestCompaction ?? {}, windowTokens)}
            </span>
            <span className='font-mono tabular-nums text-ink-4'>
              {fmtTokens(numOr(liveCompaction ? liveCompaction.before : latestCompaction?.before_tokens, 0))}
              {' → '}
              {fmtTokens(numOr(liveCompaction ? liveCompaction.after : latestCompaction?.after_tokens, 0))} token
              {!liveCompaction && numOr(latestCompaction?.at_ms, 0) > 0 ? ' · ' + fmtTime(numOr(latestCompaction?.at_ms, 0)) : ''}
            </span>
          </div>
        ) : null}

        <MetricRow
          label='已压缩次数'
          value={String(compactionCount)}
          hint={precise ? '引擎 ContextStatus.compaction_count' : 'messages 中的压缩提示条数（估算）'}
        />
        <MetricRow
          label='压缩阈值'
          value={compactLimit ? fmtTokens(compactLimit) + ' token' : '—'}
          hint={(precise ? 'auto_compact_token_limit' : '按引擎规则推导：窗口 × 90%（估算）')
            + (limitShare ? ' · ' + windowShare(compactLimit, windowTokens) : '')}
        />
        <MetricRow
          label='有效窗口'
          value={effective ? fmtTokens(effective) + ' token' : '—'}
          hint={precise ? 'context_window × 有效占比' : '窗口 × 95%（估算）'}
        />
        <MetricRow label='窗口来源' value={windowSource} hint='压缩占比的分母就是这个窗口' />
        {precise ? (
          <>
            <MetricRow label='已计入压缩判定' value={fmtTokens(compactScope) + ' token'} hint='auto_compact_scope_tokens' />
            <MetricRow label='剩余额度' value={fmtTokens(remaining) + ' token'} hint={'剩余占比 ' + precise.remaining_percent + '%'} />
          </>
        ) : null}
        {/* 压缩历史：为什么压、压掉多少（原因 + 占比），最近 5 条。 */}
        {compactionHistory.length ? (
          <div className='mt-1.5 flex min-w-0 flex-col gap-1' data-testid='compaction-history'>
            <p className='flex items-center gap-1.5 text-11 text-ink-4'>
              <History size={12} className='shrink-0' />
              压缩历史 · 最近 {Math.min(5, compactionHistory.length)} / 共 {compactionHistory.length} 条（引擎 compaction_history）
            </p>
            {compactionHistory.slice(-5).reverse().map((record, index) => (
              <div
                key={String(numOr(record.at_ms, 0)) + '-' + index}
                className='flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border border-line-soft px-2 py-1 text-11 leading-[1.5]'
              >
                <span className='shrink-0 font-mono tabular-nums text-ink-4'>
                  {numOr(record.at_ms, 0) > 0 ? fmtTime(numOr(record.at_ms, 0)) : '—'}
                </span>
                <span className='min-w-0 break-words text-ink-2'>{compactionTrigger(record, windowTokens)}</span>
                <span className='ml-auto shrink-0 font-mono tabular-nums text-ink-4'>{compactionDetail(record)}</span>
              </div>
            ))}
          </div>
        ) : precise ? (
          <p className='mt-1.5 text-11 leading-[1.5] text-ink-4'>
            引擎没有返回压缩历史（compaction_history）：可能这个会话还没压缩过，也可能是引擎版本较旧不带这段记录。
          </p>
        ) : null}

        <p className='mt-1.5 text-11 leading-[1.5] text-ink-4'>
          {precise
            ? '以上数字直接来自引擎的 ContextStatus（GET /api/sessions/{id}/context），与终端界面同源，是精确值；'
              + '占比一律以窗口 ' + fmtTokens(windowTokens) + ' token（' + windowSource + '）为分母。'
            : '引擎上下文接口暂时不可用，这里是按引擎同规则推导的估算值，只作参考。'}
        </p>
      </DockSection>

      <DockSection title='执行配置' hint='GET /api/agent/preferences'>
        <StateBlock loading={prefsBusy && !prefs} error={prefsError} onRetry={onRefresh}>
          <MetricRow
            label='思考强度'
            value={EFFORT_LABELS.find((e) => e.value === effort)?.label ?? (prefs?.reasoningEffort ?? '—')}
          />
          <MetricRow
            label='任务放行程度'
            value={PERMISSION_LABELS.find((p) => p.value === permission)?.label ?? (prefs?.permissionMode ?? '—')}
          />
          <MetricRow
            label='最大工具轮次'
            value={prefs?.maxToolRounds != null ? String(prefs.maxToolRounds) : '—'}
            hint='每轮最多调用工具的轮数'
          />
          <p className='mt-1.5 flex min-w-0 items-start gap-1.5 text-11 leading-[1.5] text-ink-4'>
            <Layers size={12} className='mt-[2px] shrink-0' />
            这三个值决定了每轮塞进上下文的工具与历史规模，直接决定压缩频率。
          </p>
        </StateBlock>
      </DockSection>

      <p className='flex min-w-0 items-start gap-1.5 px-1 text-11 leading-[1.5] text-ink-4'><Gauge size={12} className='mt-[2px] shrink-0' /> 占用比例超 85% 时条会转成危险色。</p>
      <p className='flex min-w-0 items-start gap-1.5 px-1 text-11 leading-[1.5] text-ink-4'><FileText size={12} className='mt-[2px] shrink-0' /> 估算 token 只用于横向比较，不等于账单口径。</p>
    </div>
  )
}
