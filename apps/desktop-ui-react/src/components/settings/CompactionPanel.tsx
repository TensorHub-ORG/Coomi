/** 上下文压缩：设置页「AI 能力」分组下的一小节（自动压缩什么时候触发、压完留多少）。
 *
 *  五个控件对应引擎 preferences 顶层的五个键（apps/coomi-rs/ui/src/web/mod.rs
 *  的 agent_preferences_get / put）：
 *   · autoCompactionEnabled   自动压缩总开关
 *   · autoCompactPercent      触发比例（50~95，窗口占用超过它就开始压缩）
 *   · autoCompactFloorTokens  绝对下限（token，0 = 关闭该条件）
 *   · autoCompactRetainTokens 保留区（token，最近这段原文不参与压缩）
 *   · autoCompactMessageLimit 消息条数触发的第二条条件（0 = 关）
 *
 *  写入一律走 stores/capabilities 的 set()：本地乐观生效 → 只把变化的键 PUT → 失败回滚并提示。
 *  本组件额外 GET 一次 /api/agent/preferences，把**引擎回读的实际生效值**与来源（探测 / 配置 / 默认）
 *  摊在底部：本地值与引擎值不一致、或引擎压根没回读某个键（版本较旧），用户一眼能看出卡在哪。
 *  引擎没起来（无壳 / 浏览器直跑）时只写 localStorage，并在标题旁标注「仅存本地」。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Gauge, RefreshCw } from 'lucide-react'
import { Section } from '../ui/Card'
import { Badge } from '../ui/Input'
import { Button } from '../ui/Button'
import { Segmented, Skeleton, Switch } from '../ui/Controls'
import { cn } from '../../lib/cn'
import { fmtTokens } from '../../lib/format'
import { useEngine } from '../../stores/engine'
import { useSession } from '../../stores/session'
import { COMPACT_PERCENT_MAX, COMPACT_PERCENT_MIN, useCapabilities } from '../../stores/capabilities'
import { withDisplayName } from '../../lib/stormProbe'

/* ── 档位与固定选项 ──
   三档都只改「比例 / 下限 / 条数」三项：保留区不动（它不是触发条件，是压完留多少）。 */

interface Gear {
  key: string
  label: string
  hint: string
  percent: number
  floorTokens: number
  messageLimit: number
}

const GEARS: readonly Gear[] = [
  { key: 'safe', label: '保守', hint: '90% · 20 万 · 条数关', percent: 90, floorTokens: 200_000, messageLimit: 0 },
  { key: 'balanced', label: '平衡', hint: '85% · 10 万 · 200 条', percent: 85, floorTokens: 100_000, messageLimit: 200 },
  { key: 'aggressive', label: '积极', hint: '75% · 5 万 · 80 条', percent: 75, floorTokens: 50_000, messageLimit: 80 },
]

/** 默认档位：与 stores/capabilities 的 DEFAULT_CAPS 一致（85% / 10 万 / 200 条 / 32k）。 */
const DEFAULT_GEAR_KEY = 'balanced'

const FLOOR_OPTIONS = [
  { value: '0', label: '关闭' },
  { value: '50000', label: '5 万' },
  { value: '100000', label: '10 万' },
  { value: '200000', label: '20 万' },
]
const LIMIT_OPTIONS = [
  { value: '0', label: '关' },
  { value: '80', label: '80' },
  { value: '200', label: '200' },
  { value: '500', label: '500' },
]
const RETAIN_OPTIONS = [
  { value: '16384', label: '16k' },
  { value: '32768', label: '32k' },
  { value: '65536', label: '64k' },
]

/** 来源：配置＝引擎明确回读了这个键；默认＝引擎没设这个键（用它自己的默认）；探测＝引擎没回读，值来自本地。 */
type Source = 'config' | 'default' | 'probe'

const SOURCE_META: Record<Source, { label: string; tone: 'primary' | 'neutral' | 'warn'; hint: string }> = {
  config: { label: '配置', tone: 'primary', hint: '引擎 preferences 明确回读了这一项' },
  default: { label: '默认', tone: 'neutral', hint: '引擎没有显式设置这个键，用的是引擎自己的默认值' },
  probe: { label: '探测', tone: 'warn', hint: '引擎没有回读（未就绪 / 版本较旧），这里显示的是本地值' },
}

interface Readback {
  /** 引擎 GET /api/agent/preferences 的原始响应；null = 没读到。 */
  payload: Record<string, unknown> | null
  error: string
  loading: boolean
  /** 上一次读取完成的时间戳，用于「已回读」标注。 */
  at: number
}

const EMPTY_READBACK: Readback = { payload: null, error: '', loading: false, at: 0 }

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 引擎 capabilities 块里的压缩阈值（0.1~0.99）→ 百分比：autoCompactPercent 没设时引擎就回落用它。 */
function thresholdPercent(payload: Record<string, unknown> | null): number {
  const block = payload?.capabilities
  const raw = block && typeof block === 'object' ? (block as Record<string, unknown>).compressionThreshold : undefined
  const value = finiteOrNull(raw)
  if (value === null || value <= 0) return 75
  return Math.min(COMPACT_PERCENT_MAX, Math.max(COMPACT_PERCENT_MIN, Math.round(value * 100)))
}

function tokenLabel(tokens: number, window: number): string {
  if (!window) return '≈ —'
  return '≈ ' + fmtTokens(Math.round((window * tokens) / 100))
}

export function CompactionPanel({ active }: { active: boolean }) {
  const caps = useCapabilities((s) => s.caps)
  const setCaps = useCapabilities((s) => s.set)
  const engineReady = useEngine((s) => s.ready)
  const usageWindow = useEngine((s) => s.usage.contextWindow)
  const sessionId = useSession((s) => s.sessionId)

  const [read, setRead] = useState<Readback>(EMPTY_READBACK)
  /** usage 没上报窗口时，用当前会话的 ContextStatus 探一次。 */
  const [probedWindow, setProbedWindow] = useState(0)
  /** 拖动中的比例：只更新显示，松手（或键盘 / 失焦）才真正 PUT，避免拖一次发几十个请求。 */
  const [draftPercent, setDraftPercent] = useState<number | null>(null)

  const load = useCallback(async (silent = false): Promise<void> => {
    const engine = useEngine.getState()
    if (!engine.ready) {
      setRead({ ...EMPTY_READBACK, at: Date.now() })
      return
    }
    if (!silent) setRead((prev) => ({ ...prev, loading: true }))
    try {
      const payload = await engine.api<Record<string, unknown>>('/api/agent/preferences')
      setRead({ payload: payload ?? {}, error: '', loading: false, at: Date.now() })
    } catch (e) {
      setRead({ payload: null, error: e instanceof Error ? e.message : String(e), loading: false, at: Date.now() })
    }
  }, [])

  // 进这一组时读一次；引擎从「没起来」变成「就绪」时补一次。
  useEffect(() => {
    if (!active) return
    void load()
  }, [active, engineReady, load])

  /* 改完值之后再回读一次：引擎会夹紧非法值（例如条数下限 40），
     只有回读才能知道它到底生效成多少 —— 这一拍也是「实际生效值」那一块的来源。 */
  const fingerprint = [
    caps.autoCompactionEnabled, caps.autoCompactPercent, caps.autoCompactFloorTokens,
    caps.autoCompactRetainTokens, caps.autoCompactMessageLimit,
  ].join('|')
  const skipFirstRead = useRef(true)
  useEffect(() => {
    if (skipFirstRead.current) { skipFirstRead.current = false; return }
    if (!active || !engineReady) return
    const timer = window.setTimeout(() => { void load(true) }, 600)
    return () => window.clearTimeout(timer)
  }, [fingerprint, active, engineReady, load])

  useEffect(() => {
    if (!active || !engineReady || usageWindow > 0 || !sessionId) return
    let alive = true
    void useEngine.getState()
      .api<{ context_window?: number }>('/api/sessions/' + encodeURIComponent(sessionId) + '/context')
      .then((data) => { if (alive) setProbedWindow(finiteOrNull(data?.context_window) ?? 0) })
      .catch(() => { if (alive) setProbedWindow(0) })
    return () => { alive = false }
  }, [active, engineReady, usageWindow, sessionId])

  const payload = read.payload
  const windowTokens = usageWindow || probedWindow
  const windowSource = usageWindow
    ? '引擎用量上报（usage.context_window_tokens）'
    : probedWindow ? '引擎会话上下文（GET /api/sessions/{id}/context）' : ''

  const fallbackPercent = useMemo(() => thresholdPercent(payload), [payload])
  const explicitPercent = caps.autoCompactPercent > 0 ? Math.round(caps.autoCompactPercent) : 0
  const shownPercent = explicitPercent || fallbackPercent
  const sliderPercent = draftPercent ?? shownPercent

  const activeGear = GEARS.find((g) =>
    g.percent === explicitPercent &&
    g.floorTokens === caps.autoCompactFloorTokens &&
    g.messageLimit === caps.autoCompactMessageLimit) ?? null

  const applyGear = (gear: Gear): void => {
    setDraftPercent(null)
    setCaps({
      autoCompactPercent: gear.percent,
      autoCompactFloorTokens: gear.floorTokens,
      autoCompactMessageLimit: gear.messageLimit,
    })
  }

  const commitPercent = (value: number): void => {
    setDraftPercent(null)
    const next = Math.min(COMPACT_PERCENT_MAX, Math.max(COMPACT_PERCENT_MIN, Math.round(value)))
    if (next === explicitPercent) return
    setCaps({ autoCompactPercent: next })
  }

  /* ── 引擎回读：每一项的「实际生效值 + 来源」 ── */
  const hasPayload = payload !== null
  const engEnabled = typeof payload?.autoCompactionEnabled === 'boolean' ? payload.autoCompactionEnabled : null
  const engPercent = hasPayload ? finiteOrNull(payload?.autoCompactPercent) : null
  const engFloor = hasPayload ? finiteOrNull(payload?.autoCompactFloorTokens) : null
  const engRetain = hasPayload ? finiteOrNull(payload?.autoCompactRetainTokens) : null
  const engLimit = hasPayload ? finiteOrNull(payload?.autoCompactMessageLimit) : null

  const rows: Array<{ label: string; value: string; source: Source; note?: string }> = [
    {
      label: '自动压缩',
      value: (engEnabled ?? caps.autoCompactionEnabled) ? '开' : '关',
      source: engEnabled === null ? (hasPayload ? 'default' : 'probe') : 'config',
      note: engEnabled === null ? (hasPayload ? '引擎没回读这个键，按引擎默认（开）' : '引擎未就绪，用本地值') : undefined,
    },
    {
      label: '触发比例',
      value: (engPercent ?? fallbackPercent) + '%',
      source: engPercent === null ? (hasPayload ? 'default' : 'probe') : 'config',
      note: engPercent === null
        ? (hasPayload
          ? '引擎没有显式设置百分比，回落到能力开关的压缩阈值（' + fallbackPercent + '%）'
          : '引擎未就绪，用本地值')
        : undefined,
    },
    {
      label: '绝对下限',
      value: engFloor === null
        ? (caps.autoCompactFloorTokens > 0 ? fmtTokens(caps.autoCompactFloorTokens) + ' token（本地）' : '关闭（本地）')
        : (engFloor > 0 ? fmtTokens(engFloor) + ' token' : '关闭'),
      source: engFloor === null ? (hasPayload ? 'default' : 'probe') : 'config',
      note: engFloor === null
        ? (hasPayload ? '引擎没有回读这个键（版本较旧？）：值只存在本地，引擎侧未生效' : '引擎未就绪，用本地值')
        : undefined,
    },
    {
      label: '保留区',
      value: engRetain === null
        ? fmtTokens(caps.autoCompactRetainTokens) + ' token（本地）'
        : fmtTokens(engRetain) + ' token',
      source: engRetain === null ? (hasPayload ? 'default' : 'probe') : 'config',
      note: engRetain === null
        ? (hasPayload ? '引擎没有回读这个键（版本较旧？）：值只存在本地，引擎侧未生效' : '引擎未就绪，用本地值')
        : undefined,
    },
    {
      label: '消息条数触发',
      value: engLimit === null
        ? (caps.autoCompactMessageLimit > 0 ? String(caps.autoCompactMessageLimit) + ' 条（本地）' : '关（本地）')
        : (engLimit > 0 ? String(engLimit) + ' 条' : '关'),
      source: engLimit === null ? (hasPayload ? 'default' : 'probe') : 'config',
      note: engLimit === null
        ? (hasPayload ? '引擎没有回读这个键（版本较旧？）：值只存在本地' : '引擎未就绪，用本地值')
        : undefined,
    },
  ]

  /* 本地值与引擎回读值不一致的项：列出来，别让「我明明设了」变成一个说不清的现象。 */
  const diverged = [
    engEnabled !== null && engEnabled !== caps.autoCompactionEnabled ? '自动压缩' : '',
    engPercent !== null && engPercent !== explicitPercent ? '触发比例' : '',
    engFloor !== null && engFloor !== caps.autoCompactFloorTokens ? '绝对下限' : '',
    engRetain !== null && engRetain !== caps.autoCompactRetainTokens ? '保留区' : '',
    engLimit !== null && engLimit !== caps.autoCompactMessageLimit ? '消息条数' : '',
  ].filter(Boolean)

  const headerBadge = !engineReady
    ? <Badge tone='warn' title='没有连上引擎：改动只写在本地，引擎就绪后会自动补推'>仅存本地</Badge>
    : read.error
      ? <Badge tone='danger' title={read.error}>引擎回读失败</Badge>
      : null

  return (
    <Section
      className={active ? '' : 'hidden'}
      title='上下文压缩'
      description='自动压缩什么时候触发、压完留多少；改完立刻写进引擎的 /api/agent/preferences。'
      actions={
        <>
          {headerBadge}
          <Button variant='ghost' size='icon-sm' title='重新读取引擎的有效值' disabled={read.loading} onClick={() => void load()}>
            <RefreshCw size={13} />
          </Button>
        </>
      }
    >
      <div className='flex min-w-0 flex-col gap-2.5 px-5 py-4' data-testid='compaction-panel'>

        {!engineReady ? (
          <p className='flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-12 leading-[1.65] text-warn'>
            <AlertTriangle size={13} className='mt-0.5 shrink-0' />
            <span className='min-w-0'>
              引擎没就绪（无壳或浏览器直跑）：这些值只存在本地，引擎起来后会先合并、再自动补推上去。
            </span>
          </p>
        ) : read.error ? (
          <p className='flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-12 leading-[1.65] text-danger'>
            <AlertTriangle size={13} className='mt-0.5 shrink-0' />
            <span className='min-w-0 break-all'>读不到引擎的有效值：{read.error}</span>
          </p>
        ) : null}

        {/* ① 一键档位 */}
        <div className='flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface px-3.5 py-3'>
          <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
            <span className='text-13 text-ink'>一键档位</span>
            {activeGear
              ? <Badge tone='primary'>{activeGear.label}{activeGear.key === DEFAULT_GEAR_KEY ? ' · 默认' : ''}</Badge>
              : <Badge tone='warn' title={explicitPercent === 0 ? '还没有显式设置比例，引擎按压缩阈值回落' : '当前组合不在标准档位里'}>自定义</Badge>}
            <span className='min-w-0 break-words text-12 text-ink-3'>
              三档只改比例 / 下限 / 条数；保留区不受档位影响。
            </span>
          </div>
          <div className='flex min-w-0 flex-wrap gap-1.5'>
            {GEARS.map((gear) => (
              <button
                key={gear.key}
                type='button'
                onClick={() => applyGear(gear)}
                className={cn(
                  'flex min-w-0 flex-col items-start rounded-md border px-2.5 py-1.5 text-left transition-colors',
                  activeGear?.key === gear.key
                    ? 'border-primary/40 bg-primary-soft text-primary'
                    : 'border-line text-ink-3 hover:text-ink',
                )}
              >
                <span className='text-12'>{gear.label}{gear.key === DEFAULT_GEAR_KEY ? '（默认）' : ''}</span>
                <span className='text-11 text-ink-4'>{gear.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ② 自动压缩总开关 */}
        <div className='flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-3.5 py-3'>
          <div className='min-w-[160px] flex-1 basis-[220px]'>
            <div className='text-13 text-ink'>自动压缩</div>
            <div className='mt-0.5 text-12 leading-[1.5] text-ink-3'>
              {caps.autoCompactionEnabled
                ? '接近上限时自动压缩历史；关掉只停「自动」，上游直接报超限时的兜底压缩仍然生效'
                : '已关闭：不再自动压缩历史，只有上游报上下文超限时才会强制压一次'}
            </div>
          </div>
          <Switch
            checked={caps.autoCompactionEnabled}
            aria-label='自动压缩'
            onCheckedChange={(v) => setCaps({ autoCompactionEnabled: v })}
          />
        </div>

        {/* ③ 触发比例：拖动只更新显示，松手才写 */}
        <div className='flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface px-3.5 py-3'>
          <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1'>
            <span className='text-13 text-ink'>触发比例</span>
            {explicitPercent === 0 ? <Badge tone='neutral' title='引擎按能力开关里的压缩阈值回落'>未显式设置</Badge> : null}
            <span className='ml-auto font-mono text-13 tabular-nums text-primary'>{sliderPercent}%</span>
            <span className='font-mono text-11 tabular-nums text-ink-4' data-testid='compaction-percent-tokens'>
              {tokenLabel(sliderPercent, windowTokens)}
            </span>
          </div>
          <input
            type='range'
            min={COMPACT_PERCENT_MIN}
            max={COMPACT_PERCENT_MAX}
            step={1}
            value={sliderPercent}
            aria-label='自动压缩触发比例'
            // 总开关关着也让拖动可用：先调好再打开，比「必须先开开关才能调」顺手。
            onChange={(e) => setDraftPercent(Number(e.currentTarget.value))}
            // 松手 / 键盘 / 失焦才提交：拖一次只发一次 PUT。
            onPointerUp={(e) => commitPercent(Number(e.currentTarget.value))}
            onKeyUp={(e) => commitPercent(Number(e.currentTarget.value))}
            onBlur={(e) => commitPercent(Number(e.currentTarget.value))}
            className={cn('h-5 w-full min-w-0 cursor-pointer accent-primary', !caps.autoCompactionEnabled && 'opacity-60')}
          />
          {!caps.autoCompactionEnabled ? (
            <p className='min-w-0 break-words text-12 leading-[1.5] text-warn'>
              自动压缩已关闭：这个比例暂时不生效（打开上面的开关后按它触发）。
            </p>
          ) : null}
          <p className='min-w-0 break-words text-12 leading-[1.5] text-ink-3'>
            {windowTokens
              ? '当前窗口 ' + fmtTokens(windowTokens) + ' token（' + windowSource + '）：' + sliderPercent + '% ≈ ' + fmtTokens(Math.round((windowTokens * sliderPercent) / 100)) + ' token 时触发压缩。'
              : '拿不到引擎当前窗口（引擎未上报、也没有打开的会话）：只显示比例，「≈」处留占位，不编一个窗口出来。'}
            {' '}引擎还会取「窗口 × 该比例」与「有效窗口」里更小的那个。
          </p>
        </div>

        {/* ④⑤⑥ 下限 / 条数 / 保留区 */}
        <div className='flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-3.5 py-3'>
          <div className='min-w-[160px] flex-1 basis-[220px]'>
            <div className='text-13 text-ink'>绝对下限</div>
            <div className='mt-0.5 text-12 leading-[1.5] text-ink-3'>
              上下文总量低于它就不压缩：小窗口 / 小模型不必为了跑压缩白烧一次调用
            </div>
          </div>
          <Segmented<string>
            value={String(caps.autoCompactFloorTokens)}
            onChange={(v) => setCaps({ autoCompactFloorTokens: Number(v) })}
            options={FLOOR_OPTIONS}
          />
        </div>

        <div className='flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-3.5 py-3'>
          <div className='min-w-[160px] flex-1 basis-[220px]'>
            <div className='text-13 text-ink'>消息条数触发</div>
            <div className='mt-0.5 text-12 leading-[1.5] text-ink-3'>
              会话条数达到它也算命中压缩（与比例是「或」的关系）；「关」= 只按比例判断
            </div>
          </div>
          <Segmented<string>
            value={String(caps.autoCompactMessageLimit)}
            onChange={(v) => setCaps({ autoCompactMessageLimit: Number(v) })}
            options={LIMIT_OPTIONS}
          />
        </div>

        <div className='flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-3.5 py-3'>
          <div className='min-w-[160px] flex-1 basis-[220px]'>
            <div className='text-13 text-ink'>保留区</div>
            <div className='mt-0.5 text-12 leading-[1.5] text-ink-3'>
              压缩后最近这段原文逐字保留（不参与摘要），保证刚说过的话不会丢
            </div>
          </div>
          <Segmented<string>
            value={String(caps.autoCompactRetainTokens)}
            onChange={(v) => setCaps({ autoCompactRetainTokens: Number(v) })}
            options={RETAIN_OPTIONS}
          />
        </div>

        {/* ⑦ 引擎回读的实际生效值与来源 */}
        <div className='flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-muted px-3.5 py-3' data-testid='compaction-readback'>
          <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
            <Gauge size={13} className='shrink-0 text-ink-3' />
            <span className='text-13 text-ink'>引擎实际生效值</span>
            <span className='min-w-0 break-words text-11 text-ink-4'>
              GET /api/agent/preferences{read.error ? ' · 未回读' : read.at ? ' · 已回读' : ''}
            </span>
          </div>
          {read.loading && !hasPayload ? (
            <div className='flex flex-col gap-1.5'>
              <Skeleton className='h-5 rounded-md' />
              <Skeleton className='h-5 rounded-md' />
              <Skeleton className='h-5 rounded-md' />
            </div>
          ) : (
            <div className='flex min-w-0 flex-col gap-1'>
              {rows.map((row) => (
                <div key={row.label} className='flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-12'>
                  <span className='w-[92px] shrink-0 text-ink-3'>{row.label}</span>
                  <span className='font-mono tabular-nums text-ink'>{row.value}</span>
                  <Badge tone={SOURCE_META[row.source].tone} title={SOURCE_META[row.source].hint}>{SOURCE_META[row.source].label}</Badge>
                  {row.note ? <span className='min-w-0 break-words text-11 text-ink-4'>{row.note}</span> : null}
                </div>
              ))}
            </div>
          )}
          {diverged.length ? (
            <p className='min-w-0 break-words text-11 leading-[1.6] text-warn'>
              引擎回读值与上面选的不一致（{diverged.join('、')}）：引擎侧会夹紧非法值，改一次对应控件即可写入。
            </p>
          ) : null}
          <p className='min-w-0 break-words text-11 leading-[1.6] text-ink-4'>
            来源：配置＝引擎读到了这个键；默认＝引擎没设它，用引擎自己的默认值；探测＝引擎没回读，这里显示的是本地值。
            保存失败会回滚这一次改动并提示，不会静默丢弃。
          </p>
        </div>
      </div>
    </Section>
  )
}

withDisplayName(CompactionPanel, 'CompactionPanel')
