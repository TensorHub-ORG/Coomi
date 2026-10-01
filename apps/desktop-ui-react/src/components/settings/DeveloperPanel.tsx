/** 开发者面板：设置页「引擎与诊断」分组下的一个 Section。
 *
 *  只显示引擎真实给出的数据，取不到就明说取不到（不填充假值）：
 *   · 引擎指标 —— /api/runtime/health（版本/工作目录/模型/工具数）+ /api/usage（30 天用量）
 *     + 前端已知的端口与运行状态；
 *   · /api/metrics —— 引擎当前版本没有这个端点，面板会探测一次并如实显示「未提供」，
 *     引擎以后补上就会自动渲染它的原始 JSON；
 *   · 能力开关原始 JSON —— GET /api/agent/preferences（引擎侧权威值）；
 *   · 当前会话上下文原始 JSON —— GET /api/sessions/{id}/context；
 *   · 一键复制诊断信息 —— 版本 / 端口 / 模型 / 最近 50 行日志，方便直接贴进 issue。 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ClipboardCopy, RefreshCw, Stethoscope } from 'lucide-react'
import { Section } from '../ui/Card'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Controls'
import { copyText } from '../skills/clipboard'
import { RestartPrompt, useRestartPromptPref } from '../skills/RestartPrompt'
import { useEngine } from '../../stores/engine'
import { withDisplayName } from '../../lib/stormProbe'
import { useSession } from '../../stores/session'
import { useCapabilities } from '../../stores/capabilities'

const LOG_LINES = 50
/** JSON 预览的体积上限：上下文/用量记录可能很大，超出就截断并在界面上说明。 */
const JSON_PREVIEW_LIMIT = 20_000

interface HealthPayload {
  status?: string
  version?: string
  cwd?: string
  home?: string
  runtime?: string
  engine?: { initialized?: boolean; llm?: string; tools?: number }
}

interface LogsPayload { path?: string; lines?: string[]; truncated?: boolean }

interface UsagePayload {
  from?: number
  to?: number
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  requests?: number
  records?: unknown[]
}

interface Async<T> {
  loading: boolean
  error: string
  data: T | null
}

function idle<T>(): Async<T> {
  return { loading: false, error: '', data: null }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pretty(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? ''
  return text.length > JSON_PREVIEW_LIMIT
    ? text.slice(0, JSON_PREVIEW_LIMIT) + '\n…（已截断，完整内容请用复制按钮）'
    : text
}

function compactNumber(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN')
}

/** 一块原始 JSON 预览：标题 + 复制；加载中/失败都有明确状态，不留空白。 */
function JsonBlock({ title, hint, state, emptyText }: {
  title: string
  hint?: string
  state: Async<unknown>
  emptyText: string
}) {
  const text = state.data === null ? '' : pretty(state.data)
  return (
    <div className='rounded-lg border border-line bg-muted p-3'>
      <div className='flex min-w-0 items-center gap-2'>
        <div className='min-w-0 flex-1'>
          <div className='text-12 font-medium text-ink'>{title}</div>
          {hint ? <div className='mt-0.5 truncate text-11 text-ink-4' title={hint}>{hint}</div> : null}
        </div>
        <Button
          variant='ghost'
          size='sm'
          className='shrink-0'
          disabled={!text}
          onClick={() => { void copyText(text).then((ok) => (ok ? toast.success('已复制「' + title + '」') : toast.error('复制失败：剪贴板不可用'))) }}
        >
          <ClipboardCopy size={12} /> 复制
        </Button>
      </div>
      {state.loading ? (
        <div className='mt-2 flex items-center gap-2 text-11 text-ink-3'><Spinner /> 读取中…</div>
      ) : state.error ? (
        <div className='mt-2 flex items-start gap-1.5 text-11 leading-[1.6] text-danger'>
          <AlertTriangle size={12} className='mt-0.5 shrink-0' />
          <span className='min-w-0 break-all'>{state.error}</span>
        </div>
      ) : (
        <pre className='mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all font-mono text-11 leading-[1.6] text-ink-2'>
          {text || emptyText}
        </pre>
      )}
    </div>
  )
}

export function DeveloperPanel({ active = true }: { active?: boolean }) {
  const api = useEngine((s) => s.api)
  const ready = useEngine((s) => s.ready)
  const port = useEngine((s) => s.port)
  const version = useEngine((s) => s.version)
  const status = useEngine((s) => s.status)
  const sessionId = useSession((s) => s.sessionId)
  const caps = useCapabilities((s) => s.caps)

  const [health, setHealth] = useState<Async<HealthPayload>>(idle)
  const [usage, setUsage] = useState<Async<UsagePayload>>(idle)
  const [logs, setLogs] = useState<Async<LogsPayload>>(idle)
  const [prefs, setPrefs] = useState<Async<unknown>>(idle)
  const [context, setContext] = useState<Async<unknown>>(idle)
  /// /api/metrics 未必存在：探到就显示原始值，探不到就如实说没有，不编指标。
  const [metrics, setMetrics] = useState<Async<unknown>>(idle)
  const [busy, setBusy] = useState(false)
  /** 开发者面板也能看到并复位「本次不再提示」这个进程内开关。 */
  const suppressed = useRestartPromptPref((s) => s.suppressed)
  const restore = useRestartPromptPref((s) => s.restore)

  const load = useCallback(async (): Promise<void> => {
    if (!ready) {
      const message = '引擎还没就绪，启动完成后再刷新'
      setHealth({ loading: false, error: message, data: null })
      setUsage({ loading: false, error: message, data: null })
      setLogs({ loading: false, error: message, data: null })
      setPrefs({ loading: false, error: message, data: null })
      setContext({ loading: false, error: message, data: null })
      setMetrics({ loading: false, error: message, data: null })
      return
    }
    setBusy(true)
    setHealth((s) => ({ ...s, loading: true }))
    setUsage((s) => ({ ...s, loading: true }))
    setLogs((s) => ({ ...s, loading: true }))
    setPrefs((s) => ({ ...s, loading: true }))
    setContext((s) => ({ ...s, loading: true }))
    setMetrics((s) => ({ ...s, loading: true }))

    const results = await Promise.allSettled([
      api<HealthPayload>('/api/runtime/health'),
      api<UsagePayload>('/api/usage'),
      api<LogsPayload>('/api/runtime/logs?lines=' + LOG_LINES),
      api<unknown>('/api/agent/preferences'),
      sessionId ? api<unknown>('/api/sessions/' + encodeURIComponent(sessionId) + '/context') : Promise.reject(new Error('还没有打开的会话')),
      api<unknown>('/api/metrics'),
    ])
    const settle = <T,>(index: number): Async<T> => {
      const result = results[index]
      if (result.status === 'fulfilled') return { loading: false, error: '', data: result.value as T }
      return { loading: false, error: describe(result.reason), data: null }
    }
    setHealth(settle<HealthPayload>(0))
    setUsage(settle<UsagePayload>(1))
    setLogs(settle<LogsPayload>(2))
    setPrefs(settle<unknown>(3))
    setContext(settle<unknown>(4))
    setMetrics(settle<unknown>(5))
    setBusy(false)
  }, [api, ready, sessionId])

  // 切到「引擎与诊断」分组时才拉数据：设置页其它分组不该被这几条请求拖慢。
  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const usageRange = useMemo(() => {
    const from = usage.data?.from
    const to = usage.data?.to
    if (typeof from !== 'number' || typeof to !== 'number') return ''
    return new Date(from).toLocaleDateString('zh-CN') + ' – ' + new Date(to).toLocaleDateString('zh-CN')
  }, [usage.data])

  const logLines = logs.data?.lines ?? []
  const model = health.data?.engine?.llm ?? ''

  /** 诊断信息：纯文本，粘进 issue 就能看懂的那种，不含任何密钥。 */
  const diagnostics = useCallback((): string => {
    const lines = [
      'Coomi Desktop 诊断信息',
      '生成时间: ' + new Date().toLocaleString('zh-CN'),
      '引擎状态: ' + status + (ready ? '（已就绪）' : '（未就绪）'),
      '引擎版本: ' + (health.data?.version || version || '未知'),
      '引擎端口: ' + (port || '未知'),
      '运行时: ' + (health.data?.runtime || '未知'),
      '当前模型: ' + (model || '未知'),
      '工作目录: ' + (health.data?.cwd || '未知'),
      '数据目录: ' + (health.data?.home || '未知'),
      '会话: ' + (sessionId || '无'),
      '--- 引擎日志（末尾 ' + LOG_LINES + ' 行' + (logs.data?.path ? '：' + logs.data.path : '') + '）---',
      ...(logLines.length ? logLines : ['（没有日志内容：' + (logs.error || '引擎没有写日志文件') + '）']),
    ]
    return lines.join('\n')
  }, [status, ready, health.data, version, port, model, sessionId, logs.data, logs.error, logLines])

  const copyDiagnostics = async (): Promise<void> => {
    const ok = await copyText(diagnostics())
    if (ok) toast.success('诊断信息已复制（版本 / 端口 / 模型 / 最近 ' + LOG_LINES + ' 行日志）')
    else toast.error('复制失败：剪贴板不可用，可在下方手动选中日志')
  }

  const metricCells: Array<{ label: string; value: string; hint?: string }> = [
    { label: '引擎版本', value: health.data?.version || version || '—' },
    { label: '端口', value: port ? String(port) : '—' },
    { label: '运行状态', value: status === 'running' ? '运行中' : status === 'starting' ? '启动中' : status === 'stopped' ? '已停止' : '异常' },
    { label: '当前模型', value: model || '—', hint: health.data?.engine?.initialized === false ? '引擎还没有可用的 Provider' : undefined },
    { label: '工具数', value: health.data?.engine?.tools === undefined ? '—' : String(health.data.engine.tools) },
    { label: '30 天总量', value: compactNumber(usage.data?.total_tokens), hint: usageRange || '来自 /api/usage' },
    { label: '输入 / 输出', value: compactNumber(usage.data?.input_tokens) + ' / ' + compactNumber(usage.data?.output_tokens) },
    { label: '缓存命中输入', value: compactNumber(usage.data?.cached_input_tokens) },
    { label: '请求数', value: usage.data?.requests === undefined ? '—' : compactNumber(usage.data.requests) },
  ]

  return (
    <Section
      className={active ? '' : 'hidden'}
      title='开发者'
      description='引擎指标、能力开关与会话上下文的原始数据；只读，方便贴进问题反馈。'
      actions={
        <>
          <Button variant='ghost' size='sm' disabled={busy} onClick={() => void load()}>
            {busy ? <Spinner /> : <RefreshCw size={13} />} 刷新
          </Button>
          <Button variant='secondary' size='sm' onClick={() => void copyDiagnostics()}>
            <ClipboardCopy size={13} /> 复制诊断信息
          </Button>
        </>
      }
    >
      <div className='flex flex-col gap-3 px-5 py-4'>
        <div className='grid grid-cols-1 gap-2.5 md:grid-cols-3'>
          {metricCells.map((cell) => (
            <div key={cell.label} className='card-lift min-w-0 rounded-[10px] border border-line bg-surface px-3.5 py-2.5'>
              <div className='text-11 text-ink-4'>{cell.label}</div>
              <div className='mt-1 truncate font-mono text-13 text-ink' title={cell.value}>{cell.value}</div>
              {cell.hint ? <div className='mt-0.5 truncate text-11 text-ink-4' title={cell.hint}>{cell.hint}</div> : null}
            </div>
          ))}
        </div>
        {health.error ? (
          <p className='flex items-start gap-1.5 text-11 leading-[1.6] text-danger'>
            <AlertTriangle size={12} className='mt-0.5 shrink-0' /> /api/runtime/health：{health.error}
          </p>
        ) : null}

        {/* 重启入口：装了运行环境（Node / uv / winget）之后，只有新进程才会读到新的 PATH，
            所以「重启应用」和「重启引擎」是两个不同的动作，这里都给出来。 */}
        <div className='rounded-lg border border-line bg-muted p-3' data-testid='developer-restart'>
          <div className='mb-2 text-12 font-medium text-ink'>重启</div>
          <RestartPrompt scenario='manual' />
          <div className='mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5'>
            <span className='text-11 text-ink-4'>
              走 Tauri IPC（engine_restart / app_restart）：引擎重启后前端会自动换端口与令牌并回读当前会话。
            </span>
            {suppressed ? (
              <Button variant='ghost' size='sm' onClick={() => { restore(); toast('已恢复：安装完成后会重新弹出重启提示') }}>
                恢复「安装完成后提示重启」
              </Button>
            ) : (
              <span className='text-11 text-ink-4'>安装完成卡会提示重启（可在卡上勾「本次不再提示」）。</span>
            )}
          </div>
        </div>

        <JsonBlock
          title='/api/metrics（引擎原始指标）'
          hint={metrics.error ? '引擎当前版本没有这个端点，补上后这里会自动显示' : '引擎返回的原始 JSON'}
          state={{ loading: metrics.loading, data: metrics.data, error: metrics.error ? '引擎未提供 /api/metrics：' + metrics.error : '' }}
          emptyText='（引擎返回了空内容）'
        />

        <JsonBlock
          title='能力开关（引擎原始 JSON）'
          hint={prefs.error ? '引擎未就绪时显示前端本地值作为参照' : 'GET /api/agent/preferences：以引擎侧的有效值为准'}
          state={prefs.error ? { loading: false, error: '', data: caps } : prefs}
          emptyText='（引擎没有返回能力开关）'
        />

        <JsonBlock
          title='当前会话上下文（原始 JSON）'
          hint={sessionId ? 'GET /api/sessions/' + sessionId + '/context' : '还没有打开的会话'}
          state={context}
          emptyText='（没有会话上下文数据）'
        />

        <div className='rounded-lg border border-line bg-muted p-3'>
          <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1'>
            <span className='flex items-center gap-1.5 text-12 font-medium text-ink'><Stethoscope size={13} /> 引擎日志（末尾 {LOG_LINES} 行）</span>
            {logs.data?.path ? <span className='min-w-0 truncate font-mono text-11 text-ink-4' title={logs.data.path}>{logs.data.path}</span> : null}
            {logs.data?.truncated ? <span className='shrink-0 rounded bg-warn-soft px-1.5 py-0.5 text-11 text-warn'>仅末尾若干行</span> : null}
          </div>
          {logs.loading ? (
            <div className='mt-2 flex items-center gap-2 text-11 text-ink-3'><Spinner /> 读取中…</div>
          ) : logs.error ? (
            <div className='mt-2 flex items-start gap-1.5 text-11 leading-[1.6] text-danger'>
              <AlertTriangle size={12} className='mt-0.5 shrink-0' />
              <span className='min-w-0 break-all'>{logs.error}</span>
            </div>
          ) : (
            <pre className='mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words font-mono text-11 leading-[1.6] text-ink-2'>
              {logLines.length ? logLines.join('\n') : '（引擎当前没有日志文件：正常运行时不会写日志）'}
            </pre>
          )}
        </div>
      </div>
    </Section>
  )
}

/* #185 的报错栈里显示真名（生产构建会压掉函数名） */
withDisplayName(DeveloperPanel, 'DeveloperPanel')
