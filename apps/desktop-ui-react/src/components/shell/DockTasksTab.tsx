/**
 * 任务 / 日志页签：运行中任务、引擎健康、日志尾部。
 * 数据来源（全部是现有接口，没有自造数据）：
 * - GET /api/tasks 运行中与最近的任务（含并发上限、优先级、重试、错误）
 * - DELETE /api/tasks/{session_id} 取消任务
 * - GET /api/task-details/{task_id} 任务事件与日志文件路径
 * - GET /api/runtime/health 引擎健康（版本 / 工作目录 / 模型 / 工具数）
 * - 引擎日志尾部：GET /api/runtime/logs?lines=N（引擎直接给尾部行，前端不再全量读文件自己 tail）
 * - 任务输出日志尾部：GET /api/tasks/{task_id}/log?lines=N（未知 task_id 时引擎回 400）
 * 壳命令 ipc('engine_log_path') 只在「在文件夹中打开日志文件」时用来拿路径。
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, Ban, FolderOpen, RefreshCw, ScrollText, Server } from 'lucide-react'
import { cn } from '../../lib/cn'
import { sameJson } from '../../lib/stableState'
import { fmtTime } from '../../lib/format'
import { ipc } from '../../lib/ipc'
import { useEngine } from '../../stores/engine'
import { useSession } from '../../stores/session'
import { confirmAction } from '../../stores/dialogs'
import { useUi } from '../../stores/ui'
import { toast } from 'sonner'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Input'
import { Tip } from '../ui/Overlay'
import { DockApiError, fetchRuntimeLogs, fetchTaskLog } from './dockApi'
import { navPauseBusy, queueDuringNavPause } from './navPause'
import { BreakRow, DockSection, MetricRow } from './dockMetrics'
import { revealPath, StateBlock } from './dockShared'

/** 引擎日志尾部要多少行；引擎侧上限 5000，超出会被 clamp。 */
const LOG_TAIL_LINES = 120
/** 任务输出日志尾部行数。 */
const TASK_LOG_TAIL_LINES = 80

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

interface TaskList {
  tasks?: TaskItem[]
  running_count?: number
  concurrency_limit?: number
}

interface Health {
  status?: string
  version?: string
  cwd?: string
  home?: string
  runtime?: string
  engine?: { initialized?: boolean; llm?: string | null; tools?: number }
}

interface TaskDetail {
  task?: TaskItem
  events?: Array<Record<string, unknown>>
  logs?: { events?: string; output?: string }
}

/** 引擎日志尾部（GET /api/runtime/logs）。missing 表示引擎那边根本没有日志文件（404）。 */
interface EngineLogState {
  loading: boolean
  error: string
  missing: boolean
  path: string
  text: string
  lines: number
  truncated: boolean
}

/** 任务输出日志尾部（GET /api/tasks/{task_id}/log）。 */
interface TaskLogState {
  loading: boolean
  error: string
  path: string
  text: string
  lines: number
  truncated: boolean
}

const EMPTY_ENGINE_LOG: EngineLogState = { loading: false, error: '', missing: false, path: '', text: '', lines: 0, truncated: false }

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  waiting_lock: '等待锁',
  running: '运行中',
  pause_pending: '暂停中',
  paused: '已暂停',
  awaiting_approval: '等待授权',
  awaiting_input: '等待回答',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function statusTone(status: string | undefined): 'neutral' | 'primary' | 'ok' | 'warn' | 'danger' {
  switch (status) {
    case 'running': return 'primary'
    case 'awaiting_approval':
    case 'awaiting_input':
    case 'pause_pending':
    case 'paused': return 'warn'
    case 'completed': return 'ok'
    case 'failed': return 'danger'
    default: return 'neutral'
  }
}

function elapsedLabel(startedAt: number | undefined): string {
  if (!startedAt) return '—'
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - startedAt)
  if (seconds < 60) return seconds + 's'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's'
  return Math.floor(seconds / 3600) + 'h' + Math.floor((seconds % 3600) / 60) + 'm'
}

export function DockTasksTab({ refresh, onRefresh }: { refresh: number; onRefresh: () => void }) {
  const ready = useEngine((s) => s.ready)
  const [tasks, setTasks] = useState<TaskList | null>(null)
  const [tasksError, setTasksError] = useState('')
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState('')
  const [detail, setDetail] = useState<Record<string, TaskDetail | 'loading'>>({})
  const [taskLogs, setTaskLogs] = useState<Record<string, TaskLogState>>({})
  const [log, setLog] = useState<EngineLogState>(EMPTY_ENGINE_LOG)
  const [tick, setTick] = useState(0)

  /// 任务与健康每 4s 自刷一次（页签只在打开时挂载，不会在后台空转）。
  useEffect(() => {
    if (!ready) { setTasks(null); setHealth(null); return }
    let alive = true
    const load = async (): Promise<void> => {
      if (!alive) return
      // 切页过渡那一拍不刷任务与健康：让路给过渡（与 App 的探活看门狗同一个判据），
      // 收闸时合并补一次。
      if (navPauseBusy()) { queueDuringNavPause('dock-tasks-poll', () => { void load() }); return }
      // 4s 一次的轮询回读：内容一样就**保留旧引用**（setTasks(prev)），
      // 否则每 4s 都会因为「新解析出来的对象」产生一次提交，把整张任务表连同
      // 它下面的 memo 全部重画一遍 —— 引擎静悄悄的时候界面也在动。
      try {
        const data = await useEngine.getState().api<TaskList>('/api/tasks')
        if (alive) { setTasks((prev) => (sameJson(prev, data) ? prev : data)); setTasksError('') }
      } catch (e) {
        if (alive) { setTasksError(e instanceof Error ? e.message : String(e)); setTasks(null) }
      }
      try {
        const data = await useEngine.getState().api<Health>('/api/runtime/health')
        if (alive) { setHealth((prev) => (sameJson(prev, data) ? prev : data)); setHealthError('') }
      } catch (e) {
        if (alive) { setHealthError(e instanceof Error ? e.message : String(e)); setHealth(null) }
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 4000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [ready, tick])

  /// 引擎日志尾部：引擎直接回尾部行；没有日志文件时回 404，这里当空态处理而不是报错。
  useEffect(() => {
    if (!ready) return
    let alive = true
    setLog((s) => ({ ...s, loading: true, error: '', missing: false }))
    void (async () => {
      try {
        const data = await fetchRuntimeLogs(LOG_TAIL_LINES)
        if (!alive) return
        setLog({
          loading: false,
          error: '',
          missing: false,
          path: data.path,
          text: data.lines.join('\n'),
          lines: data.lines.length,
          truncated: data.truncated,
        })
      } catch (e) {
        if (!alive) return
        // 404：引擎侧没有 engine.log / crash_rust.log（命令行或移动端启动就是这样），是可预期的空态。
        const missing = e instanceof DockApiError && e.status === 404
        setLog({
          ...EMPTY_ENGINE_LOG,
          missing,
          error: missing ? '' : e instanceof Error ? e.message : String(e),
        })
      }
    })()
    return () => { alive = false }
  }, [ready, refresh, tick])

  /// 打开日志文件：优先用端点给的路径，端点没给（没有日志文件）时才问壳要。
  const openLogFile = async (): Promise<void> => {
    try {
      const path = log.path || await ipc<string | null>('engine_log_path')
      if (!path) { toast.error('引擎还没有生成日志文件'); return }
      await revealPath(path)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '无法打开日志文件')
    }
  }

  /** 任务输出尾部：展开详情时取一次，也可以手动刷新。 */
  const loadTaskLog = async (id: string): Promise<void> => {
    setTaskLogs((prev) => ({
      ...prev,
      [id]: {
        loading: true,
        error: '',
        path: prev[id]?.path ?? '',
        text: prev[id]?.text ?? '',
        lines: prev[id]?.lines ?? 0,
        truncated: prev[id]?.truncated ?? false,
      },
    }))
    try {
      const data = await fetchTaskLog(id, TASK_LOG_TAIL_LINES)
      setTaskLogs((prev) => ({
        ...prev,
        [id]: { loading: false, error: '', path: data.path, text: data.lines.join('\n'), lines: data.lines.length, truncated: data.truncated },
      }))
    } catch (e) {
      // 未知 task_id 引擎回 400：说清楚是任务不认识，而不是把英文原文丢给用户。
      const message = e instanceof DockApiError && e.status === 400
        ? '引擎不认识这个任务（可能已被清理，或还没登记到任务中心）。'
        : e instanceof Error ? e.message : String(e)
      setTaskLogs((prev) => ({
        ...prev,
        [id]: { loading: false, error: message, path: prev[id]?.path ?? '', text: '', lines: 0, truncated: false },
      }))
    }
  }

  const openDetail = async (task: TaskItem): Promise<void> => {
    const id = String(task.task_id ?? '')
    if (!id) return
    if (detail[id]) {
      setDetail((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      setTaskLogs((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      return
    }
    setDetail((prev) => ({ ...prev, [id]: 'loading' }))
    try {
      const data = await useEngine.getState().api<TaskDetail>('/api/task-details/' + encodeURIComponent(id))
      setDetail((prev) => ({ ...prev, [id]: data }))
      void loadTaskLog(id)
    } catch (e) {
      setDetail((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      toast.error(e instanceof Error ? e.message : '读取任务详情失败')
    }
  }

  const cancelTask = async (task: TaskItem): Promise<void> => {
    const sessionId = String(task.session_id ?? '')
    if (!sessionId) return
    const ok = await confirmAction({
      title: '取消任务',
      description: '「' + (task.session_title || sessionId) + '」正在运行的任务会被停止，已产出的内容保留。',
      confirmLabel: '取消任务',
      danger: true,
    })
    if (!ok) return
    try {
      await useEngine.getState().api('/api/tasks/' + encodeURIComponent(sessionId), { method: 'DELETE' })
      toast.success('已请求取消')
      setTick((v) => v + 1)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '取消失败')
    }
  }

  const jumpToSession = async (task: TaskItem): Promise<void> => {
    const sessionId = String(task.session_id ?? '')
    if (!sessionId) return
    useUi.getState().setView('chat')
    await useSession.getState().openSession(sessionId)
  }

  const items = tasks?.tasks ?? []
  const running = items.filter((item) => item.running)

  return (
    <div data-dock-tab='tasks' className='flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overflow-x-hidden p-2.5'>
      <DockSection
        title='任务'
        hint={tasks ? '运行中 ' + (tasks.running_count ?? 0) + ' 个 · 并发上限 ' + (tasks.concurrency_limit ?? '—') : '引擎任务中心'}
        actions={
          <Tip label='刷新'>
            <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => { setTick((v) => v + 1); onRefresh() }}>
              <RefreshCw size={12} />
            </Button>
          </Tip>
        }
      >
        <StateBlock
          loading={ready && !tasks && !tasksError}
          error={tasksError}
          onRetry={() => setTick((v) => v + 1)}
          empty={ready && !!tasks && !items.length}
          emptyArt='tasks'
          emptyTitle='当前没有任务'
          emptyDesc='发起一轮会话或后台安装任务后，这里会实时显示状态。'
        >
          <ul className='-mx-1'>
            {items.slice(0, 20).map((task) => {
              const id = String(task.task_id ?? '')
              const opened = Boolean(detail[id])
              const label = STATUS_LABELS[String(task.status ?? '')] ?? String(task.status ?? '未知')
              const taskLog = taskLogs[id]
              return (
                <li key={id} className='mb-1 min-w-0 rounded-md border border-line-soft bg-muted/60 px-2 py-1.5'>
                  <div className='flex items-center gap-1.5'>
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', task.running ? 'animate-pulse bg-primary' : 'bg-ink-4')} data-loop-anim={task.running ? '' : undefined} />
                    <span className='min-w-0 flex-1 truncate text-12 text-ink' title={String(task.session_title ?? '')}>
                      {task.session_title || task.task_kind || '任务'}
                    </span>
                    <Badge tone={statusTone(task.status)} className='shrink-0'>{label}</Badge>
                  </div>
                  {/* 元信息行：每条都可能很长（工具名带完整路径、模型名一长串），一律 max-w-full + truncate + title */}
                  <div className='mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-11 tabular-nums text-ink-4'>
                    <span className='shrink-0'>已运行 {elapsedLabel(task.started_at)}</span>
                    {task.current_tool ? <span className='min-w-0 max-w-full truncate' title={'工具 ' + task.current_tool}>工具 {task.current_tool}</span> : null}
                    {task.model ? <span className='min-w-0 max-w-full truncate' title={task.model}>{task.model}</span> : null}
                    {task.retries ? <span className='shrink-0'>重试 {task.retries}</span> : null}
                    {task.download_status ? <span className='min-w-0 max-w-full truncate' title={'下载 ' + task.download_status}>下载 {task.download_status}</span> : null}
                  </div>
                  {task.error ? (
                    <p className='mt-1 flex items-start gap-1 text-11 text-danger'>
                      <AlertTriangle size={11} className='mt-[2px] shrink-0' />
                      <span className='min-w-0 break-all'>{task.error}</span>
                    </p>
                  ) : null}
                  <div className='mt-1 flex items-center gap-1'>
                    <Button variant='ghost' size='sm' className='h-6 px-1.5 text-11' onClick={() => void openDetail(task)}>
                      {opened ? '收起详情' : '详情'}
                    </Button>
                    <Button variant='ghost' size='sm' className='h-6 px-1.5 text-11' onClick={() => void jumpToSession(task)}>跳到会话</Button>
                    {task.running ? (
                      <Button variant='ghost' size='sm' className='h-6 px-1.5 text-11 text-danger' onClick={() => void cancelTask(task)}>
                        <Ban size={11} /> 取消
                      </Button>
                    ) : null}
                  </div>
                  {opened && detail[id] !== 'loading' ? (
                    <div className='mt-1.5 border-t border-line-soft pt-1.5'>
                      {(() => {
                        const data = detail[id] as TaskDetail
                        const events = data.events ?? []
                        // 输出日志优先用端点给的路径，端点没给时退回详情里的 logs.output。
                        const outputPath = taskLog?.path || String(data.logs?.output ?? '')
                        return (
                          <>
                            <MetricRow label='事件条数' value={String(events.length)} hint={events.length ? '最近 ' + fmtTime(Number((events[events.length - 1] as Record<string, unknown>)?.ts ?? 0) * 1000) : undefined} />
                            <pre className='mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sunken p-1.5 font-mono text-10 leading-[1.5] text-ink-2'>
                              {events.slice(-6).map((event) => JSON.stringify(event)).join('\n') || '（这次任务还没有事件）'}
                            </pre>
                            <div className='mt-1.5'>
                              <div className='flex items-center gap-1'>
                                <span className='min-w-0 flex-1 truncate text-11 text-ink-4' title={taskLog?.path || undefined}>
                                  {taskLog?.error
                                    ? '输出日志不可用'
                                    : taskLog?.loading
                                      ? '读取输出日志…'
                                      : taskLog?.lines
                                        ? '输出尾部 · 最后 ' + taskLog.lines + ' 行' + (taskLog.truncated ? '（已截断）' : '')
                                        : '这个任务还没有输出'}
                                </span>
                                <Button variant='ghost' size='sm' className='h-6 px-1.5 text-11' onClick={() => void loadTaskLog(id)}>刷新</Button>
                                {outputPath ? (
                                  <Tip label='在文件夹中打开'>
                                    <Button variant='ghost' size='sm' className='h-6 gap-1 px-1.5 text-11' onClick={() => void revealPath(outputPath)}>
                                      <FolderOpen size={11} /> 输出日志
                                    </Button>
                                  </Tip>
                                ) : null}
                              </div>
                              {taskLog?.error ? (
                                <p className='mt-1 break-all text-11 text-warn'>{taskLog.error}</p>
                              ) : taskLog?.text ? (
                                <pre className='mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sunken p-1.5 font-mono text-10 leading-[1.5] text-ink-2'>
                                  {taskLog.text}
                                </pre>
                              ) : null}
                            </div>
                          </>
                        )
                      })()}
                    </div>
                  ) : null}
                  {opened && detail[id] === 'loading' ? <p className='mt-1 text-11 text-ink-4'>读取中…</p> : null}
                </li>
              )
            })}
          </ul>
          {items.length > 20 ? <p className='px-1 pt-1 text-11 text-ink-4'>只显示最近 20 个任务。</p> : null}
          {running.length === 0 && items.length ? <p className='px-1 pt-1 text-11 text-ink-4'>当前没有运行中的任务。</p> : null}
        </StateBlock>
      </DockSection>

      <DockSection title='引擎健康' hint='GET /api/runtime/health' actions={
        <Tip label='重新探测'>
          <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => setTick((v) => v + 1)}><Server size={12} /></Button>
        </Tip>
      }>
        <StateBlock loading={ready && !health && !healthError} error={healthError} onRetry={() => setTick((v) => v + 1)} empty={!health && !ready}>
          {health ? (
            <>
              <MetricRow
                label='状态'
                value={health.status === 'ok' ? '正常' : health.status === 'setup_required' ? '待配置模型' : (health.status ?? '—')}
              />
              {/* 版本 / 模型 / 运行环境都是没有空格的长串：换行显示全文，不给省略号 */}
              <BreakRow label='版本' value={health.version ?? '—'} />
              <BreakRow label='模型' value={health.engine?.llm ?? '未选择'} />
              <MetricRow label='可用工具' value={health.engine?.tools != null ? String(health.engine.tools) : '—'} />
              <BreakRow label='运行环境' value={health.runtime ?? '—'} />
              <div className='mt-1 min-w-0 space-y-0.5'>
                <p className='truncate text-11 text-ink-4' title={health.cwd ?? undefined}>工作目录 {health.cwd ?? '—'}</p>
                <p className='truncate text-11 text-ink-4' title={health.home ?? undefined}>数据目录 {health.home ?? '—'}</p>
              </div>
            </>
          ) : null}
        </StateBlock>
      </DockSection>

      <DockSection
        title='引擎日志'
        hint={log.path || 'GET /api/runtime/logs · 引擎日志尾部'}
        actions={
          <>
            <Tip label='打开日志文件'>
              <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => void openLogFile()}><FolderOpen size={12} /></Button>
            </Tip>
            <Tip label='刷新日志'>
              <Button variant='ghost' size='icon-sm' className='h-6 w-6' onClick={() => setTick((v) => v + 1)}><ScrollText size={12} /></Button>
            </Tip>
          </>
        }
      >
        <StateBlock
          loading={log.loading}
          error={log.error}
          onRetry={() => setTick((v) => v + 1)}
          empty={!log.text && !log.error && !log.loading}
          emptyIcon={<ScrollText size={20} />}
          emptyTitle={log.missing ? '引擎还没有生成日志文件' : '日志文件是空的'}
          emptyDesc={log.missing
            ? '引擎运行日志由桌面壳写到 engine.log；命令行或移动端启动时没有这个文件，所以这里没有内容可读。'
            : '引擎刚启动，还没有写入内容，稍后刷新试试。'}
        >
          {log.text ? (
            <pre className='max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sunken p-2 font-mono text-10 leading-[1.55] text-ink-2'>
              {log.text}
            </pre>
          ) : null}
        </StateBlock>
        <p className='mt-1 text-11 leading-[1.5] text-ink-4'>
          只显示最后 {LOG_TAIL_LINES} 行{log.truncated ? '（日志较长，引擎已按上限截断）' : ''}；完整日志点右上角的文件夹按钮打开。
        </p>
      </DockSection>
    </div>
  )
}
