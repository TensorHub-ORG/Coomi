/** 技能中心 › 任务：正在安装 / 正在跑的工具任务看板。
 *
 *  数据来源（全部是引擎既有接口，一个字段都没有自造）：
 *   · GET    /api/tasks                              → {tasks[], running_count, concurrency_limit}
 *   · GET    /api/task-details/{task_id}             → {task, events[], logs{events,output}}
 *   · GET    /api/tasks/{task_id}/log?lines=N        → {task_id, path, lines[], truncated}
 *   · POST   /api/task-details/{task_id}/action      → {action:'cancel'|'retry'}
 *
 *  为什么取消走 action 而不是 DELETE /api/tasks/{session_id}：
 *  DELETE 只认「会话任务」（state.tasks 的键就是会话 id）；目录安装这类引擎自建任务的
 *  session_id 是 "catalog:xxx" 这种伪 id，DELETE 会回 400 task not found。task_action 的
 *  cancel 两条路都覆盖（会话任务走 stop_session_task，托管任务走 task_manager 状态迁移），
 *  所以这里统一用它。
 *
 *  参数填写：引擎侧**没有**「任务在等参数」这种状态 —— 读 install_mcp_catalog 可见，缺必填
 *  参数时它直接回 400，任务根本还没登记（body 里的 pending:true 是「已登记、后台执行」，
 *  不是「等参数」）。所以这里不做「任务等待参数」，退一步提供「手动安装工具」入口，
 *  复用市场页那张同款的 InstallParamsDialog。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Ban, ChevronDown, Copy, ListChecks, RefreshCw, RotateCcw, ScrollText, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../../lib/cn'
import { sameJson } from '../../lib/stableState'
import { fmtTime } from '../../lib/format'
import { useEngine } from '../../stores/engine'
import { useLibrary, type CatalogEntry } from '../../stores/library'
import { confirmAction } from '../../stores/dialogs'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Input'
import { Dialog } from '../ui/Overlay'
import { Empty } from '../ui/Card'
import { SkeletonRows } from '../ui/Controls'
import { INSTALL_TASK_POLL_MS } from './installClient'
import { copyText } from './clipboard'
import { InstallParamsDialog } from './InstallParamsDialog'

/** 任务列表轮询间隔：与 installClient 的安装轮询同一个值，不另发明一套节奏。 */
const POLL_MS = INSTALL_TASK_POLL_MS
/** 日志一次取多少行：引擎侧还会再 clamp；限行是为了超长日志不把整个文本塞进 DOM。 */
const LOG_LINES = 300
/** 日志面板最大高度（px）：再长的日志也只在这个盒子里滚，不把整页顶长。 */
const LOG_MAX_H = 320
/** 离底部多近算「贴着底」：在这个范围内才跟着新日志自动吸底。 */
const STICK_SLOP_PX = 32

/* ── 引擎任务的状态口径（与 services/src/task_manager.rs 的 TaskStatus 一一对应）── */

/** 「还没结束」：这些状态在列表里排最前，并且取消按钮可见。 */
const ACTIVE_STATUSES = ['running', 'pause_pending', 'paused', 'awaiting_approval', 'awaiting_input']
/** 「排着队」：排在运行中之后。 */
const QUEUED_STATUSES = ['queued', 'waiting_lock']
/** 终态：日志不再变化，轮询没有意义。 */
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'conflict', 'interrupted']

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  waiting_lock: '等待槽位',
  running: '运行中',
  pause_pending: '正在暂停',
  paused: '已暂停',
  awaiting_approval: '等待授权',
  awaiting_input: '等待回答',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  conflict: '冲突',
}

function statusText(status: string | undefined | null): string {
  return STATUS_TEXT[status ?? ''] ?? (status || '未知')
}

function statusTone(status: string | undefined | null): 'neutral' | 'primary' | 'ok' | 'warn' | 'danger' {
  switch (status) {
    case 'running': return 'primary'
    case 'awaiting_approval':
    case 'awaiting_input':
    case 'pause_pending':
    case 'paused': return 'warn'
    case 'completed': return 'ok'
    case 'failed':
    case 'conflict': return 'danger'
    default: return 'neutral'
  }
}

/** task_kind 的中文名：与引擎 task_kind_title 同一套口径（那边只用在「没有会话标题」时）。 */
const KIND_TEXT: Record<string, string> = {
  catalog_install: '工具安装',
  skill_install: '技能安装',
  runtime_install: '运行时安装',
  runtime_tool_install: '运行时安装',
  cognitive_install: 'Coomi Life',
  agent: '对话',
  team: '协作',
  download: '下载',
}

/** 任务的 kind：有 task_kind 用它；会话任务没有 kind，按「有没有下载」回落到中文名。 */
function kindText(task: TaskItem): string {
  const kind = String(task.task_kind ?? '')
  if (kind) return KIND_TEXT[kind] ?? kind
  return task.download_label ? '下载' : '对话'
}

/** 排序分组：运行中 → 排队 → 其余（最近完成/失败）。 */
function sortRank(task: TaskItem): number {
  const status = String(task.status ?? '')
  if (ACTIVE_STATUSES.includes(status)) return 0
  if (QUEUED_STATUSES.includes(status)) return 1
  return 2
}

function byTaskOrder(a: TaskItem, b: TaskItem): number {
  return sortRank(a) - sortRank(b) || Number(b.started_at ?? 0) - Number(a.started_at ?? 0)
}

function durationText(startedAt: number | undefined): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(startedAt ?? 0))
  if (seconds < 60) return seconds + 's'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's'
  return Math.floor(seconds / 3600) + 'h' + Math.floor((seconds % 3600) / 60) + 'm'
}

/* ── 接口形状 ── */

interface TaskItem {
  task_id?: string
  session_id?: string
  session_title?: string
  status?: string
  running?: boolean
  started_at?: number
  current_tool?: string | null
  task_kind?: string | null
  download_label?: string | null
  download_status?: string | null
  priority?: string | number | null
  retries?: number
  error?: string | null
  model?: string | null
}

interface TaskListPayload {
  tasks?: TaskItem[]
  running_count?: number
  concurrency_limit?: number
}

/** /api/task-details 里 task 就是 TaskRecord（services/src/task_manager.rs）。 */
interface TaskRecord {
  id?: string
  session_id?: string
  kind?: string
  status?: string
  created_at_ms?: number
  updated_at_ms?: number
  model?: string | null
  retries?: number
  error?: string | null
  lock_wait_ms?: number
  resumable_stage?: string | null
}

interface TaskEvent {
  at_ms?: number
  event?: string
  status?: string
  summary?: string | null
}

interface TaskDetailPayload {
  task?: TaskRecord
  events?: TaskEvent[]
  logs?: { events?: string; output?: string }
}

interface TaskLogPayload {
  task_id?: string
  path?: string
  lines?: string[]
  truncated?: boolean
}

interface LogState {
  loading: boolean
  error: string
  path: string
  text: string
  lines: number
  truncated: boolean
}

const EMPTY_LOG: LogState = { loading: false, error: '', path: '', text: '', lines: 0, truncated: false }

/** /api/catalog 的 MCP 条目（与市场页 ToolEntry 同源，这里只取安装要用的字段）。 */
interface ParamSpec {
  key: string
  label: string
  secret?: boolean
  description?: string
  placeholder?: string
  example?: string
}

interface CatalogTool extends CatalogEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  required_parameters?: ParamSpec[]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一行事件的展示文本：[时间] 状态 摘要。 */
function eventLine(event: TaskEvent): string {
  const at = Number(event.at_ms ?? 0)
  const time = at ? fmtTime(at) : '--:--'
  return time + '  ' + statusText(event.status) + (event.summary ? '  ' + event.summary : '')
}

export function TaskBoard() {
  const ready = useEngine((s) => s.ready)
  const tools = useLibrary((s) => s.tools) as CatalogTool[]
  const loadCatalog = useLibrary((s) => s.loadCatalog)

  const [list, setList] = useState<TaskListPayload | null>(null)
  const [error, setError] = useState('')
  /** 手动刷新 / 执行动作后立刻重拉一次（轮询本身不受影响）。 */
  const [tick, setTick] = useState(0)
  const [openId, setOpenId] = useState('')
  const [detail, setDetail] = useState<TaskDetailPayload | null>(null)
  const [detailError, setDetailError] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [log, setLog] = useState<LogState>(EMPTY_LOG)
  const [actionBusy, setActionBusy] = useState('')

  /** 页面是否在前台：隐藏时把轮询整条停掉（省电，也不在后台空转）。 */
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')

  const logRef = useRef<HTMLPreElement | null>(null)
  /** 日志是否贴着底：只有贴着底才在刷新后自动滚到底，用户往上翻时不会被拽回去。 */
  const stickRef = useRef(true)

  /* ── 手动安装（引擎没有「任务等参数」状态时的兜底入口）── */
  const [manualOpen, setManualOpen] = useState(false)
  const [manualTarget, setManualTarget] = useState<CatalogTool | null>(null)
  const [manualBusy, setManualBusy] = useState(false)

  useEffect(() => {
    const onVisibility = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const loadList = useCallback(async (): Promise<void> => {
    try {
      const data = await useEngine.getState().api<TaskListPayload>('/api/tasks')
      // 内容一样就保留旧引用：700ms 一跳，每跳都换新对象会把整张列表重画一遍。
      setList((prev) => (sameJson(prev, data) ? prev : data))
      setError('')
    } catch (e) {
      setError(describe(e))
    }
  }, [])

  // 列表轮询：进入子视图即拉，700ms 一跳；切走（组件卸载）或页面隐藏就停。
  useEffect(() => {
    if (!ready || !visible) return
    void loadList()
    const timer = window.setInterval(() => { void loadList() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [ready, visible, tick, loadList])

  const items = useMemo(() => [...(list?.tasks ?? [])].sort(byTaskOrder), [list])
  const openTask = useMemo(
    () => items.find((task) => String(task.task_id ?? '') === openId) ?? null,
    [items, openId],
  )
  /** 打开的任务是否还没结束：只有它需要刷新详情与日志。 */
  const openActive = !!openTask && !TERMINAL_STATUSES.includes(String(openTask.status ?? ''))

  const loadDetail = useCallback(async (taskId: string): Promise<void> => {
    setDetailLoading(true)
    try {
      const data = await useEngine.getState().api<TaskDetailPayload>(
        '/api/task-details/' + encodeURIComponent(taskId),
      )
      setDetail(data ?? null)
      setDetailError('')
    } catch (e) {
      setDetail(null)
      setDetailError(describe(e))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  // 打开某条任务、或它的状态发生变化时取一次详情（进度文字来自事件，状态一变就要重取）。
  useEffect(() => {
    if (!openId) {
      setDetail(null)
      setDetailError('')
      setLog(EMPTY_LOG)
      return
    }
    void loadDetail(openId)
  }, [openId, openTask?.status, loadDetail])

  const loadLog = useCallback(async (taskId: string): Promise<void> => {
    try {
      const data = await useEngine.getState().api<TaskLogPayload>(
        '/api/tasks/' + encodeURIComponent(taskId) + '/log?lines=' + LOG_LINES,
      )
      const payload = data ?? {}
      const lines = Array.isArray(payload.lines) ? payload.lines : []
      setLog({
        loading: false,
        error: '',
        path: payload.path ?? '',
        text: lines.join('\n'),
        lines: lines.length,
        truncated: payload.truncated === true,
      })
    } catch (e) {
      setLog((prev) => ({ ...prev, loading: false, error: describe(e) }))
    }
  }, [])

  // 日志：打开就取一次；任务还在跑就跟着列表一起 700ms 刷新，终态后停止。
  useEffect(() => {
    if (!openId || !visible) return
    void loadLog(openId)
    if (!openActive) return
    const timer = window.setInterval(() => { void loadLog(openId) }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [openId, openActive, visible, loadLog])

  // 新日志落位后吸底：只动 scrollTop，不改内容，不触发布局抖动。
  useEffect(() => {
    const el = logRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [log.text])

  const toggleOpen = (task: TaskItem): void => {
    const id = String(task.task_id ?? '')
    if (!id) return
    stickRef.current = true
    // 换一条任务时先把上一条的详情/日志清掉：否则新任务的数据回来之前会短暂显示旧任务的内容。
    if (openId !== id) {
      setDetail(null)
      setDetailError('')
      setLog(EMPTY_LOG)
    }
    setOpenId((prev) => (prev === id ? '' : id))
  }

  const runAction = async (task: TaskItem, action: 'cancel' | 'retry'): Promise<void> => {
    const id = String(task.task_id ?? '')
    if (!id) return
    if (action === 'cancel') {
      const ok = await confirmAction({
        title: '取消任务',
        description: '「' + (task.session_title || kindText(task)) + '」会被停止，已经写出的日志与产物保留。',
        confirmLabel: '取消任务',
        danger: true,
      })
      if (!ok) return
    }
    setActionBusy(id)
    try {
      await useEngine.getState().api('/api/task-details/' + encodeURIComponent(id) + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      toast.success(action === 'cancel' ? '已请求取消' : '已请求重试')
      setTick((v) => v + 1)
      if (openId === id) void loadDetail(id)
    } catch (e) {
      toast.error((action === 'cancel' ? '取消失败：' : '重试失败：') + describe(e))
    } finally {
      setActionBusy('')
    }
  }

  const installManual = async (entry: CatalogTool, values: Record<string, string>): Promise<void> => {
    setManualBusy(true)
    try {
      await useEngine.getState().api('/api/catalog/mcp/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entry.id, values }),
      })
      toast.success('已提交安装：' + (entry.name || entry.id))
      setManualTarget(null)
      setTick((v) => v + 1)
    } catch (e) {
      toast.error('安装失败：' + describe(e))
    } finally {
      setManualBusy(false)
    }
  }

  const openManual = (): void => {
    setManualOpen(true)
    if (!tools.length) void loadCatalog()
  }

  const copyLog = async (): Promise<void> => {
    const ok = await copyText(log.text)
    if (ok) toast.success('日志已复制')
    else toast.error('复制失败，请手动选中文本复制')
  }

  // 先取到数组再取末项：detail?.events 在三元里不能把 detail 收窄成非空，直接索引会报 possibly-undefined。
  const events = detail?.events ?? []
  const latestEvent: TaskEvent | null = events.length ? events[events.length - 1] : null
  const loading = ready && !list && !error

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      {/* 工具条：并发概览 + 手动刷新 + 手动安装入口。 */}
      <div className='flex flex-wrap items-center gap-3'>
        <span className='text-12 text-ink-3'>
          运行中 <span className='tabular-nums text-ink-2'>{list?.running_count ?? 0}</span>
          <span className='px-1 text-ink-4'>·</span>
          并发上限 <span className='tabular-nums text-ink-2'>{list?.concurrency_limit ?? '—'}</span>
        </span>
        <Button variant='ghost' size='sm' onClick={() => setTick((v) => v + 1)}>
          <RefreshCw size={13} /> 刷新
        </Button>
        <Button variant='secondary' size='sm' onClick={openManual}>
          <ListChecks size={13} /> 手动安装工具
        </Button>
        <span className='text-11 text-ink-4'>列表每 {Math.round(POLL_MS / 1000 * 10) / 10}s 自动刷新；页面切走或隐藏时停止。</span>
      </div>

      <div className='mt-3 min-h-0 flex-1 overflow-y-auto pb-2'>
        {!ready ? (
          <p className='py-10 text-center text-12 text-ink-4'>引擎还没就绪，任务列表会在连接成功后自动出现。</p>
        ) : null}

        {/* 错误态：读失败必须说出来，不能静默空白。 */}
        {error ? (
          <div className='flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft p-3 text-12 text-ink-2'>
            <AlertTriangle size={14} className='mt-0.5 shrink-0 text-danger' />
            <div className='min-w-0 flex-1'>
              <div className='text-danger'>读取任务列表失败</div>
              <div className='mt-0.5 break-all'>{error}</div>
              <Button variant='secondary' size='sm' className='mt-2' onClick={() => setTick((v) => v + 1)}>
                <RefreshCw size={13} /> 重试
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? <SkeletonRows rows={4} className='px-0' /> : null}

        {!error && ready && list && !items.length ? (
          <Empty
            art='tasks'
            title='当前没有正在进行的安装或工具任务'
            description='从「市场 › 工具市场」装一个工具、或一键装运行环境后，这里会实时显示状态与日志。'
          />
        ) : null}

        {!error && items.length ? (
          <ul className='flex flex-col gap-2'>
            {items.map((task) => {
              const id = String(task.task_id ?? '')
              const status = String(task.status ?? '')
              const open = openId === id
              const cancellable = !TERMINAL_STATUSES.includes(status)
              const retriable = status === 'failed'
              const progress = progressHint(task, open ? latestEvent : null)
              return (
                <li key={id} className='rounded-lg border border-line bg-surface elev-1'>
                  <div className='flex items-start gap-2.5 p-3'>
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        status === 'running' ? 'animate-pulse bg-primary' : statusTone(status) === 'danger' ? 'bg-danger' : 'bg-ink-4',
                      )}
                    />
                    <button
                      type='button'
                      aria-expanded={open}
                      onClick={() => toggleOpen(task)}
                      className='min-w-0 flex-1 text-left'
                    >
                      <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
                        <span className='min-w-0 max-w-full truncate text-13 text-ink' title={String(task.session_title ?? '')}>
                          {task.session_title || kindText(task)}
                        </span>
                        <Badge tone={statusTone(status)}>{statusText(status)}</Badge>
                        <Badge tone='neutral'>{kindText(task)}</Badge>
                        {task.download_status ? <Badge tone='neutral' title={'下载状态 ' + task.download_status}>下载 {task.download_status}</Badge> : null}
                      </div>
                      {/* 「进度」一行：引擎没有百分比，只报实况（当前工具 / 最新事件 / 阶段名）。 */}
                      <div className='mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-11 tabular-nums text-ink-4'>
                        <span className='min-w-0 max-w-full truncate' title={progress}>
                          进度 · {progress}
                        </span>
                        {task.started_at ? <span className='shrink-0'>开始 {fmtTime(Number(task.started_at) * 1000)}</span> : null}
                        {ACTIVE_STATUSES.includes(status) && task.started_at ? <span className='shrink-0'>已运行 {durationText(task.started_at)}</span> : null}
                        {task.retries ? <span className='shrink-0'>重试 {task.retries}</span> : null}
                        {task.current_tool ? (
                          <span className='min-w-0 max-w-full truncate' title={'当前工具 ' + task.current_tool}>工具 {task.current_tool}</span>
                        ) : null}
                      </div>
                      {task.error ? (
                        <p className='mt-1 flex items-start gap-1 text-11 text-danger'>
                          <AlertTriangle size={11} className='mt-[2px] shrink-0' />
                          <span className='min-w-0 break-all'>{task.error}</span>
                        </p>
                      ) : null}
                    </button>
                    <div className='flex shrink-0 items-center gap-1'>
                      {cancellable ? (
                        <Button
                          variant='ghost'
                          size='sm'
                          className='text-danger'
                          disabled={actionBusy === id}
                          onClick={() => void runAction(task, 'cancel')}
                        >
                          <Ban size={12} /> 取消
                        </Button>
                      ) : null}
                      {retriable ? (
                        <Button variant='secondary' size='sm' disabled={actionBusy === id} onClick={() => void runAction(task, 'retry')}>
                          <RotateCcw size={12} /> 重试
                        </Button>
                      ) : null}
                      <Button variant='ghost' size='sm' aria-expanded={open} onClick={() => toggleOpen(task)}>
                        <ChevronDown size={13} className={cn('transition-transform duration-[var(--motion-collapse)] ease-[var(--ease-enter)]', open && 'rotate-180')} />
                        {open ? '收起' : '日志'}
                      </Button>
                    </div>
                  </div>

                  {open ? (
                    <div className='border-t border-line-soft px-3 py-2.5'>
                      {detailLoading && !detail ? <p className='text-11 text-ink-4'>读取任务详情…</p> : null}
                      {detailError ? <p className='break-all text-11 text-danger'>读取任务详情失败：{detailError}</p> : null}

                      <div className='grid grid-cols-1 gap-x-6 gap-y-1 text-11 leading-[1.7] sm:grid-cols-2'>
                        <div className='min-w-0'>
                          <span className='text-ink-4'>任务 id </span>
                          <span className='break-all font-mono text-ink-2'>{detail?.task?.id || id}</span>
                        </div>
                        <div className='min-w-0'>
                          <span className='text-ink-4'>会话 / 归属 </span>
                          <span className='break-all font-mono text-ink-2'>{detail?.task?.session_id || task.session_id || '—'}</span>
                        </div>
                        <div className='min-w-0'>
                          <span className='text-ink-4'>进度 </span>
                          <span className='text-ink-2'>{progress}</span>
                        </div>
                        <div className='min-w-0'>
                          <span className='text-ink-4'>模型 </span>
                          <span className='break-all text-ink-2'>{detail?.task?.model || task.model || '—'}</span>
                        </div>
                        <div className='min-w-0'>
                          <span className='text-ink-4'>重试次数 </span>
                          <span className='tabular-nums text-ink-2'>{detail?.task?.retries ?? task.retries ?? 0}</span>
                        </div>
                        <div className='min-w-0'>
                          <span className='text-ink-4'>等待安装槽位 </span>
                          <span className='tabular-nums text-ink-2'>{detail?.task?.lock_wait_ms ?? 0} ms</span>
                        </div>
                        <div className='min-w-0 sm:col-span-2'>
                          <span className='text-ink-4'>日志文件 </span>
                          <span className='break-all font-mono text-ink-2'>{log.path || detail?.logs?.output || '—'}</span>
                        </div>
                      </div>

                      {latestEvent ? (
                        <div className='mt-2 rounded-md border border-line-soft bg-muted/50 px-2 py-1.5 text-11 text-ink-2'>
                          最新事件 · {eventLine(latestEvent)}
                        </div>
                      ) : null}

                      {/* 日志：可滚动、可复制；只渲染尾部若干行，超长也不会把页面卡住。 */}
                      <div className='mt-2.5'>
                        <div className='flex items-center gap-1.5'>
                          <ScrollText size={12} className='shrink-0 text-ink-4' />
                          <span className='min-w-0 flex-1 truncate text-11 text-ink-4' title={log.path}>
                            {log.error
                              ? '日志不可用'
                              : log.lines
                                ? '日志尾部 · ' + log.lines + ' 行' + (log.truncated ? '（引擎已按上限截断）' : '')
                                : '这个任务还没有输出日志'}
                          </span>
                          <Button variant='ghost' size='sm' onClick={() => void loadLog(id)}>
                            <RefreshCw size={12} /> 刷新
                          </Button>
                          <Button variant='ghost' size='sm' disabled={!log.text} onClick={() => void copyLog()}>
                            <Copy size={12} /> 复制
                          </Button>
                        </div>
                        {log.error ? <p className='mt-1 break-all text-11 text-warn'>{log.error}</p> : null}
                        {log.text ? (
                          <pre
                            ref={logRef}
                            onScroll={(event) => {
                              const el = event.currentTarget
                              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLOP_PX
                            }}
                            style={{ maxHeight: LOG_MAX_H }}
                            className='mt-1 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sunken p-2 font-mono text-10 leading-[1.55] text-ink-2'
                          >
                            {log.text}
                          </pre>
                        ) : null}
                        {openActive ? <p className='mt-1 text-11 text-ink-4'>任务还在跑，日志每 {Math.round(POLL_MS / 1000 * 10) / 10}s 自动刷新并吸底。</p> : null}
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>

      {/* 手动安装工具：引擎没有「任务等参数」状态，所以参数填写入口放在这里。 */}
      <Dialog
        open={manualOpen}
        onOpenChange={setManualOpen}
        title='手动安装工具'
        description='挑一个内置工具装上；需要参数的条目会先弹出参数表单，值写进本机配置后引擎才开始装。'
        width={560}
        footer={<Button variant='ghost' onClick={() => setManualOpen(false)}>关闭</Button>}
      >
        {tools.length ? (
          <ul className='flex flex-col gap-1.5'>
            {tools.map((tool) => {
              const params = tool.required_parameters ?? []
              const command = [tool.command ?? '', ...(tool.args ?? [])].filter(Boolean).join(' ')
              return (
                <li key={tool.id} className='flex items-center gap-2 rounded-lg border border-line bg-muted/40 px-3 py-2'>
                  <div className='min-w-0 flex-1'>
                    <div className='flex flex-wrap items-center gap-1.5'>
                      <span className='min-w-0 truncate text-13 text-ink'>{tool.name || tool.id}</span>
                      {params.length ? <Badge tone='warn'>需填 {params.length} 个参数</Badge> : null}
                    </div>
                    <div className='mt-0.5 truncate text-11 text-ink-4' title={tool.description}>{tool.description || '暂无描述'}</div>
                    {command ? (
                      <div className='mt-0.5 flex items-center gap-1 text-11 text-ink-4'>
                        <Terminal size={11} className='shrink-0' />
                        <span className='truncate font-mono' title={command}>{command}</span>
                      </div>
                    ) : null}
                  </div>
                  <Button
                    variant='secondary'
                    size='sm'
                    disabled={manualBusy}
                    onClick={() => { if (params.length) setManualTarget(tool); else void installManual(tool, {}) }}
                  >
                    安装
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className='py-6 text-center text-12 text-ink-4'>目录还没加载出来。稍等片刻，或去「市场 › 工具市场」刷新一次再回来。</p>
        )}
      </Dialog>

      {/* 参数填写：直接复用市场页那张 InstallParamsDialog（字段渲染与帮助文案同一套）。 */}
      <InstallParamsDialog
        open={!!manualTarget}
        onOpenChange={(open) => { if (!open) setManualTarget(null) }}
        entry={manualTarget}
        busy={manualBusy}
        onSubmit={async (values) => {
          const entry = manualTarget
          if (!entry) return
          await installManual(entry, values)
        }}
      />
    </div>
  )
}

/** 「进度」文案：引擎没有百分比字段，只能报实况 —— 当前工具 / 下载状态 / 最新事件摘要 / 阶段名。 */
function progressHint(task: TaskItem, latest: TaskEvent | null): string {
  const status = String(task.status ?? '')
  if (status === 'running') {
    if (task.current_tool) return '正在执行 ' + task.current_tool
    if (latest?.summary) return String(latest.summary)
    if (task.download_status) return '下载 ' + task.download_status
    return '正在执行'
  }
  if (status === 'queued') return '排队等待执行'
  if (status === 'waiting_lock') return '等待安装槽位'
  if (status === 'pause_pending') return '正在暂停'
  if (status === 'paused') return '已暂停'
  if (latest?.summary) return String(latest.summary)
  if (task.error) return String(task.error)
  return statusText(status)
}
