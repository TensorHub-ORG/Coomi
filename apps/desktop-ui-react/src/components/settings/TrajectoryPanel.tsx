/** 任务轨迹：设置页「AI 能力」分组下的一小节 —— 引擎每轮任务落一行 trajectory.jsonl 的回放。
 *
 *  为什么单独一块：DeveloperPanel 只看得到引擎「当前」状态，回答不了「上一轮为什么失败」。
 *  这一块把每轮的成败 / 失败类型 / 轮次 / 最后在用的工具 / 耗时 / 提示词长度摊开，
 *  用户据此判断是该换模型、还是某一轮提示词太长 / 工具反复打转。
 *
 *  引擎接口（apps/coomi-rs/ui/src/web/mod.rs 的 trajectory_list）：
 *   · GET /api/trajectory?limit=50 → { entries: [ { ts, session, kind, prompt_chars, prompt_fp,
 *     ok, error, error_kind, rounds_used, last_tool, elapsed_ms } ], path }（最新在前）
 *   · 文件缺失 / 损坏时引擎返回空列表而不是报错；接口本身在旧版本不存在，会回 404。
 *
 *  隐私口径：轨迹只记提示词长度与指纹，不记原文（与 telemetry 一致），只落本地、用户可自行导出。
 *  「导出 JSON」直接对引擎落盘的那一份走壳的另存为：导出的是原始数据，不重新序列化、不会失真。 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, RefreshCw } from 'lucide-react'
import { Empty, Section } from '../ui/Card'
import { Badge } from '../ui/Input'
import { Button } from '../ui/Button'
import { SkeletonRows } from '../ui/Controls'
import { fmtDuration, fmtTime } from '../../lib/format'
import { saveArtifactAs } from '../../lib/saveAs'
import { useEngine } from '../../stores/engine'
import { withDisplayName } from '../../lib/stormProbe'

/** 单条轨迹（字段名跟着引擎 serde 的 snake_case 走，见 record_turn_trajectory）。 */
interface TrajectoryEntry {
  ts?: number
  session?: string
  kind?: string
  prompt_chars?: number
  prompt_fp?: string
  ok?: boolean
  error?: string | null
  error_kind?: string
  rounds_used?: number
  last_tool?: string | null
  elapsed_ms?: number
}

interface TrajectoryPayload {
  entries?: TrajectoryEntry[]
  path?: string
}

/** 一次拉多少条：与引擎端点的默认值一致，够看最近一轮对话的成败脉络。 */
const TRAJECTORY_LIMIT = 50

/** error_kind → 中文标签（引擎 classify_failure 的取值 + 成功）。认不出的分类留给其它。 */
const ERROR_KIND_LABELS: Record<string, string> = {
  ok: '成功',
  upstream_truncated: '上游截断',
  tool_round_limit: '工具轮次耗尽',
  engine_panic: '引擎异常',
  upstream_unavailable: '上游不可用',
  tool_error: '工具报错',
  other: '其它',
}

function errorKindLabel(kind: string | undefined): string {
  if (!kind) return '失败'
  // 引擎以后新增分类时回落成「其它」，原始 kind 放在徽标的 title 里，信息不丢。
  return ERROR_KIND_LABELS[kind] ?? '其它'
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 时间：引擎落的是 Unix 秒（u64）；个别来源给毫秒，>1e12 时按毫秒处理，避免显示成 1970 年。 */
function timeText(ts: number | undefined): { text: string; title: string } {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return { text: '—', title: '' }
  const ms = ts > 1e12 ? ts : ts * 1000
  return { text: fmtTime(ms), title: new Date(ms).toLocaleString('zh-CN') }
}

function roundsText(rounds: number | undefined): string {
  return typeof rounds === 'number' && Number.isFinite(rounds) ? String(rounds) : '—'
}

function charsText(chars: number | undefined): string {
  return typeof chars === 'number' && Number.isFinite(chars) ? chars + ' 字' : '—'
}

function toolText(tool: string | null | undefined): string {
  const text = (tool ?? '').trim()
  return text || '—'
}

/** 表头 / 数据行共用同一套列宽：数字列右对齐、结果列自适应，长工具名靠 truncate + title 收口。 */
const GRID = 'grid grid-cols-[92px_minmax(150px,1.4fr)_52px_minmax(110px,1fr)_68px_72px]'

export function TrajectoryPanel({ active }: { active: boolean }) {
  const engineReady = useEngine((s) => s.ready)

  const [entries, setEntries] = useState<TrajectoryEntry[]>([])
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const engine = useEngine.getState()
    if (!engine.ready) {
      // 引擎没起来时不当作「版本较旧」：给一句能指导下一步的说明即可。
      setError('引擎还没就绪：启动完成后点右上角刷新，或稍等片刻重试')
      setLoaded(true)
      return
    }
    setLoading(true)
    try {
      const data = await engine.api<TrajectoryPayload>('/api/trajectory?limit=' + TRAJECTORY_LIMIT)
      setEntries(Array.isArray(data?.entries) ? data.entries : [])
      setPath(typeof data?.path === 'string' ? data.path : '')
      setError('')
    } catch (e) {
      // 端点还没上线（旧引擎 404，或链路失败）：只记原因，界面统一收成一句「暂不支持」，
      // 原始错误只挂在 title 上，不把 HTTP 错误刷到界面上。
      setError(errText(e))
      setEntries([])
      setPath('')
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [])

  // 切到「AI 能力」这一组时才拉；引擎从「没起来」变成「就绪」时补一次（与 CompactionPanel 同一套时机）。
  useEffect(() => {
    if (!active) return
    void load()
  }, [active, engineReady, load])

  const exportJson = useCallback(async (): Promise<void> => {
    if (!path) return
    setBusy(true)
    try {
      // 对引擎落盘的那一份走壳的另存为：导出的就是原始 trajectory.jsonl（不止当前显示的 50 条）。
      await saveArtifactAs({ path, name: 'trajectory-' + new Date().toISOString().slice(0, 10) + '.jsonl' })
    } finally {
      setBusy(false)
    }
  }, [path])

  /** 失败态只说一句：引擎版本较旧时不把 404 / 网络错误当报错刷屏。 */
  const failureNotice = !engineReady
    ? '引擎还没就绪：启动完成后点刷新即可读取轨迹。'
    : '引擎版本较旧，暂不支持轨迹。'

  return (
    <Section
      className={active ? '' : 'hidden'}
      title='任务轨迹'
      description='引擎每轮任务落一行本地记录（trajectory.jsonl）：成败、失败类型、轮次、最后的工具与耗时。'
      actions={
        <>
          <Button
            variant='secondary'
            size='sm'
            disabled={!path || busy}
            title={path ? '把整份 trajectory.jsonl 另存到别处（JSON Lines：每行一条 JSON）' : '还没有可导出的轨迹文件'}
            onClick={() => void exportJson()}
          >
            <Download size={13} /> 导出 JSON
          </Button>
          <Button variant='ghost' size='icon-sm' title='重新读取轨迹' disabled={loading} onClick={() => void load()}>
            <RefreshCw size={13} />
          </Button>
        </>
      }
    >
      <div className='flex min-w-0 flex-col gap-2.5 px-5 py-4' data-testid='trajectory-panel'>
        {/* 文件路径：引擎给什么显示什么（没读到就用「—」占位），方便用户自己去翻这份原始记录。 */}
        <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
          <span className='shrink-0 text-12 text-ink-3'>本地文件</span>
          <span className='min-w-0 flex-1 truncate font-mono text-11 text-ink-4' title={path || undefined}>
            {path || '—'}
          </span>
          {entries.length ? <span className='shrink-0 text-11 text-ink-4'>最近 {entries.length} 条</span> : null}
        </div>

        {/* 首次加载铺骨架；之后刷新保留旧列表，避免整块闪一下。 */}
        {loading && !loaded ? <SkeletonRows rows={4} className='px-0' /> : null}

        {loaded && !loading && error ? (
          <div className='flex min-w-0 items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-12 leading-[1.65] text-warn'>
            <AlertTriangle size={13} className='mt-0.5 shrink-0' />
            <span className='min-w-0 break-words' title={error}>{failureNotice}</span>
          </div>
        ) : null}

        {loaded && !loading && !error && entries.length === 0 ? (
          <Empty
            compact
            art='tasks'
            title='还没有任务轨迹'
            description='引擎会在每轮任务结束后写一行本地记录；跑一轮会话后再回来看。'
          />
        ) : null}

        {entries.length ? (
          <div className='min-w-0 overflow-x-auto'>
            <div className='min-w-[620px]'>
              <div className={GRID + ' items-center gap-x-2 border-b border-line-soft px-2 pb-1.5 text-11 text-ink-4'}>
                <span>时间</span>
                <span>结果</span>
                <span className='text-right'>轮次</span>
                <span>最后工具</span>
                <span className='text-right'>耗时</span>
                <span className='text-right'>提示词</span>
              </div>
              {entries.map((entry, index) => {
                const ok = entry.ok !== false
                const when = timeText(entry.ts)
                const tool = toolText(entry.last_tool)
                return (
                  <div
                    key={(entry.ts ?? 0) + '-' + index}
                    data-testid='trajectory-row'
                    className={GRID + ' items-start gap-x-2 border-b border-line-soft px-2 py-1.5 last:border-b-0'}
                  >
                    <span className='truncate font-mono text-11 tabular-nums text-ink-3' title={when.title}>{when.text}</span>
                    <div className='min-w-0'>
                      <Badge
                        tone={ok ? 'ok' : 'danger'}
                        title={entry.error_kind ? 'error_kind=' + entry.error_kind : entry.kind}
                      >
                        {ok ? '成功' : errorKindLabel(entry.error_kind)}
                      </Badge>
                      {!ok && entry.error ? (
                        <p className='mt-0.5 line-clamp-2 break-all text-11 leading-[1.5] text-danger' title={entry.error}>{entry.error}</p>
                      ) : null}
                    </div>
                    <span className='text-right font-mono text-12 tabular-nums text-ink' title='本轮用掉的总轮次'>{roundsText(entry.rounds_used)}</span>
                    <span className='min-w-0 truncate font-mono text-11 text-ink-2' title={tool}>{tool}</span>
                    <span className='text-right font-mono text-12 tabular-nums text-ink'>{fmtDuration(entry.elapsed_ms)}</span>
                    <span className='text-right font-mono text-12 tabular-nums text-ink-2' title={entry.prompt_fp ? '提示词指纹 ' + entry.prompt_fp : '提示词字符数'}>{charsText(entry.prompt_chars)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    </Section>
  )
}

withDisplayName(TrajectoryPanel, 'TrajectoryPanel')
