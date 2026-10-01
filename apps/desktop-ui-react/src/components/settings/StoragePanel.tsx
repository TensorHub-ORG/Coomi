/** 存储位置：设置页「引擎与诊断」分组下的一个 Section。
 *
 *  管的是两件「东西放哪儿」的事：MCP 的安装目录、会话工作区根目录（新会话默认落在这里）。
 *  两件都能改，但**改完只有点「迁移」才会真正搬数据**——只改输入框再点保存，动的是引擎记的路径；
 *  迁移才是复制 + 校验 + 切换，失败由引擎回滚，原目录不受影响。
 *
 *  引擎接口（apps/coomi-rs/ui/src/web/api/paths.rs）：
 *   · GET  /api/settings/paths → {
 *       paths:     { mcpInstallDir, workspaceRoot },   ← 配置值；空串 = 用默认位置
 *       resolved:  { mcpInstallDir, workspaceRoot },   ← 实际生效目录（始终有值）
 *       defaults:  { … }, exists: { … }, settings_path, note }
 *   · PUT  /api/settings/paths { mcpInstallDir?, workspaceRoot? }（也接受包一层 paths）
 *   · POST /api/settings/paths/migrate { kind, to } ← **同步**执行：复制 → 校验 → 原子切换，
 *     失败自动回滚；kind 是 mcpInstallDir / workspaceRoot 之一（一次搬一个）。
 *
 *  两个踩过的坑：
 *   ① 「配置值是空串」是**正常状态**（＝用默认位置），界面必须显示 resolved 里的真实目录；
 *      以前只看配置值，于是「两个都空」被误判成「引擎没有返回存储位置」，整块面板变成不可用。
 *   ② migrate 的 body 是 {kind,to} 单类写法；一次改两个目录就发两次请求。
 *  接口没上（404）时降级成只读展示（工作区根目录回落到 /api/runtime/health 的 cwd），
 *  输入框与迁移按钮全部禁用——不假装保存成功，也不把读到的只读数据当成可写设置。
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, FolderOpen, HardDrive, RefreshCw, Save, X } from 'lucide-react'
import { Section } from '../ui/Card'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Progress, Skeleton, Spinner } from '../ui/Controls'
import { secondNow, useStableTick } from '../ui/stableTick'
import { cancelEngineTask, fetchTaskLogLines, isUnsupportedReply, replyMessage } from '../skills/installClient'
import { ipc } from '../../lib/ipc'
import { cn } from '../../lib/cn'
import { useEngine } from '../../stores/engine'
import { withDisplayName } from '../../lib/stormProbe'
import { useUi } from '../../stores/ui'

/* ── 类型与解析 ── */

interface Paths {
  /** MCP 服务器的安装目录（界面里显示的**实际生效**目录）。 */
  mcpDir: string
  /** 会话工作区根目录（新会话默认落进来）。 */
  workspaceRoot: string
  /** 上面两个目录是不是「没配置、用默认位置」。 */
  mcpFromDefault: boolean
  workspaceFromDefault: boolean
  /** 引擎给出的默认位置（恢复默认时的提示用）。 */
  mcpDefault: string
  workspaceDefault: string
  /** settings.json 的路径（排查用，可空）。 */
  settingsPath: string
}

const EMPTY_PATHS: Paths = {
  mcpDir: '', workspaceRoot: '', mcpFromDefault: false, workspaceFromDefault: false,
  mcpDefault: '', workspaceDefault: '', settingsPath: '',
}

interface Reply<T> {
  status: number
  ok: boolean
  data: T | null
  text: string
  networkError: string
}

interface MigrationState {
  taskId: string
  status: string
  running: boolean
  /** 0–1；引擎没给百分比时是 null，进度条退化成不确定态。 */
  progress: number | null
  message: string
  log: string[]
  error: string
  /** 引擎明确回了「已回滚」：失败提示里要说清楚原目录没事。 */
  rolledBack: boolean
  startedAt: number
}

/** 与 stores 那套一致：不用 engine.api()，因为这里全靠状态码区分「404 降级」与「真失败」。 */
async function request<T>(path: string, init?: RequestInit): Promise<Reply<T>> {
  const engine = useEngine.getState()
  if (!engine.port) {
    return { status: 0, ok: false, data: null, text: '', networkError: '引擎还没有就绪（拿不到端口）' }
  }
  try {
    const res = await fetch('http://127.0.0.1:' + engine.port + path, {
      ...init,
      headers: engine.authHeaders(init?.headers as Record<string, string> | undefined),
    })
    const text = await res.text().catch(() => '')
    let data: T | null = null
    if (text) {
      try { data = JSON.parse(text) as T } catch { data = null }
    }
    return { status: res.status, ok: res.ok, data, text, networkError: '' }
  } catch (error) {
    return {
      status: 0, ok: false, data: null, text: '',
      networkError: error instanceof Error ? error.message : String(error),
    }
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function pickPath(source: Record<string, unknown> | null, keys: string[]): string {
  if (!source) return ''
  for (const key of keys) {
    const text = asText(source[key])
    if (text) return text
  }
  return ''
}

/**
 * 解析 GET/PUT /api/settings/paths 的返回。
 * 配置值（paths）可能是空串＝用默认位置，这时界面要显示 resolved 里的真实目录，
 * 所以两个都读：配置值优先，空则回落到 resolved，再没有才用顶层同名字段。
 * 字段名 snake_case / camelCase 都认，少认一个就整块空着是更糟的错。
 */
function parsePaths(payload: unknown): Paths {
  const root = isRecord(payload) ? payload : {}
  const configured = isRecord(root.paths) ? root.paths : root
  const resolved = isRecord(root.resolved) ? root.resolved : null
  const defaults = isRecord(root.defaults) ? root.defaults : null
  const mcpKeys = ['mcp_dir', 'mcpDir', 'mcp_install_dir', 'mcpInstallDir', 'mcp']
  const rootKeys = ['workspace_root', 'workspaceRoot', 'sessions_root', 'sessionsRoot', 'workspace']
  const mcpConfigured = pickPath(configured, mcpKeys)
  const rootConfigured = pickPath(configured, rootKeys)
  const mcpResolved = pickPath(resolved, mcpKeys)
  const rootResolved = pickPath(resolved, rootKeys)
  return {
    mcpDir: mcpConfigured || mcpResolved || pickPath(root, mcpKeys),
    workspaceRoot: rootConfigured || rootResolved || pickPath(root, rootKeys),
    mcpFromDefault: !mcpConfigured && !!mcpResolved,
    workspaceFromDefault: !rootConfigured && !!rootResolved,
    mcpDefault: pickPath(defaults, mcpKeys),
    workspaceDefault: pickPath(defaults, rootKeys),
    settingsPath: asText(root.settings_path) || asText(root.settingsPath),
  }
}

/** 0–1 的进度：引擎可能给 0–100，也可能是 0–1，都可能带 progress_pct 这种名字。 */
function asProgress(value: unknown): number | null {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null
  if (raw === null || !Number.isFinite(raw)) return null
  const ratio = raw > 1 ? raw / 100 : raw
  return Math.min(1, Math.max(0, ratio))
}

/** 引擎回的计数类字段（files / bytes）：数字或数字串都认，认不出当 0。 */
function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return 0
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return (unit === 0 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[unit]
}

/** 绝对路径校验：windows 盘符 / UNC / posix 三选一，其余（相对路径、空串）当场拦下。 */
function dirProblem(value: string, label: string): string {
  const text = value.trim()
  if (!text) return label + '不能为空'
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(text)) return label + '要填绝对路径，例如 D:\\Coomi\\mcp'
  return ''
}

const TERMINAL_STATUS = ['completed', 'failed', 'cancelled', 'interrupted', 'conflict']

function statusLabel(status: string): string {
  switch (status) {
    case 'queued': return '排队中'
    case 'waiting_lock': return '等待迁移槽位'
    case 'running': return '正在迁移'
    case 'completed': return '迁移完成'
    case 'failed': return '迁移失败'
    case 'cancelled': return '已取消'
    case 'interrupted': return '已中断'
    default: return status ? '进行中（' + status + '）' : '进行中'
  }
}

/** 迁移中每秒走一次时间：有个走字的「已用时」才不像卡死。
 *  读数按秒量化，且不迁移时一条调度都不建 —— 静止时零提交（原来是每秒无条件 setNow）。 */
function useElapsed(active: boolean, since: number): number {
  const now = useStableTick(active, 1000, secondNow, secondNow())
  return active && since ? Math.max(0, Math.round((now - since) / 1000)) : 0
}

/* ── 目录行 ── */

function DirRow({ label, hint, value, placeholder, problem, disabled, busy, onInput, onOpenPath }: {
  label: string
  hint: string
  value: string
  placeholder: string
  /** 校验出的问题；有值时输入框转错误态并显示这句话。 */
  problem: string
  disabled: boolean
  busy: boolean
  onInput: (next: string) => void
  onOpenPath: () => void
}) {
  const pick = async (): Promise<void> => {
    try {
      const dir = await ipc<string | null>('pick_directory')
      if (dir) onInput(dir)
    } catch {
      toast.error('打不开目录选择器（桌面壳未就绪），可以直接把路径粘进输入框')
    }
  }
  return (
    <div className='rounded-lg border border-line bg-surface px-3.5 py-3'>
      <div className='flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2'>
        <div className='min-w-[132px] flex-1 basis-[180px]'>
          <div className='text-13 text-ink'>{label}</div>
          <div className='mt-1 break-words text-12 leading-[1.5] text-ink-3'>{hint}</div>
        </div>
        <div className='flex min-w-0 flex-wrap items-center justify-end gap-1.5'>
          <Input
            className='h-8 w-[240px] max-w-full font-mono text-12'
            value={value}
            placeholder={placeholder}
            invalid={!!problem}
            disabled={disabled}
            onChange={(e) => onInput(e.target.value)}
          />
          <Button variant='secondary' size='sm' disabled={disabled || busy} onClick={() => void pick()}>
            <FolderOpen size={13} /> 选择目录
          </Button>
          <Button variant='ghost' size='sm' disabled={!value.trim()} title='在资源管理器中打开' onClick={onOpenPath}>打开</Button>
        </div>
      </div>
      {problem ? <p className='mt-1.5 text-11 text-danger'>{problem}</p> : null}
    </div>
  )
}

/* ── 面板 ── */

export function StoragePanel({ active = true }: { active?: boolean }) {
  const ready = useEngine((s) => s.ready)
  const confirmDanger = useUi((s) => s.prefs.confirmDanger)

  const [saved, setSaved] = useState<Paths>(EMPTY_PATHS)
  const [draft, setDraft] = useState<Paths>(EMPTY_PATHS)
  const [unsupported, setUnsupported] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [migration, setMigration] = useState<MigrationState | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!ready) { setError('引擎还没就绪，启动完成后再刷新'); return }
    setLoading(true)
    const reply = await request<unknown>('/api/settings/paths')
    if (reply.ok) {
      setLoading(false)
      const next = parsePaths(reply.data)
      setSaved(next)
      setDraft(next)
      setUnsupported(false)
      // 「配置值是空串」＝用默认位置，parsePaths 已经回落到 resolved 的真实目录；
      // 两个都还空才是真的没拿到（这时把引擎的原话带上，而不是笼统一句「不可用」）。
      setError(next.mcpDir || next.workspaceRoot
        ? ''
        : '引擎没有返回存储位置：' + (reply.text.trim().slice(0, 200) || '（响应体为空）'))
      return
    }
    if (isUnsupportedReply(reply)) {
      // 引擎还没有这个接口：只读展示，工作区根目录回落到运行时健康里的 cwd（并写明来源）。
      const health = await request<Record<string, unknown>>('/api/runtime/health')
      setLoading(false)
      const body = isRecord(health.data) ? health.data : {}
      const fallback: Paths = {
        ...EMPTY_PATHS,
        mcpDir: '',
        workspaceRoot: asText(body.cwd),
        workspaceFromDefault: !!asText(body.cwd),
      }
      setUnsupported(true)
      setSaved(fallback)
      setDraft(fallback)
      setError('')
      return
    }
    setLoading(false)
    setError(replyMessage(reply, '读取存储位置失败'))
  }, [ready])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  /* 迁移进度轮询：900ms 一次，状态到终态就停。取消按钮走引擎既有的 DELETE /api/tasks/{id}。 */
  const taskId = migration?.taskId ?? ''
  const running = migration?.running === true
  useEffect(() => {
    if (!taskId || !running) return
    let alive = true
    const tick = async (): Promise<void> => {
      const detail = await request<unknown>('/api/task-details/' + encodeURIComponent(taskId))
      const log = await fetchTaskLogLines(taskId, 60)
      if (!alive) return
      const payload = isRecord(detail.data) ? detail.data : null
      const task = payload && isRecord(payload.task) ? payload.task : payload
      const status = asText(task?.status)
      const stillRunning = !!status && !TERMINAL_STATUS.includes(status)
      const progress = asProgress(task?.progress ?? task?.progress_ratio ?? task?.percent ?? task?.progressPct)
      const message = asText(task?.message) || asText(task?.stage) || asText(task?.label)
      const taskError = asText(task?.error)
      const rolledBack = task?.rolled_back === true || task?.rollback === true || /回滚/.test(taskError)
      setMigration((prev) => (
        prev && prev.taskId === taskId
          ? {
            ...prev,
            status: status || prev.status,
            running: stillRunning,
            progress: progress === null ? prev.progress : progress,
            message: message || prev.message,
            log: log ?? prev.log,
            error: taskError || prev.error,
            rolledBack: prev.rolledBack || rolledBack,
          }
          : prev
      ))
      if (stillRunning) return
      // 终态：把真实目录再读一次（成功＝新目录，失败/取消＝回滚后的原目录）。
      if (status === 'completed') toast.success('迁移完成，存储位置已切换')
      else if (status === 'failed') toast.error('迁移失败：' + (taskError || '引擎没有返回原因') + '，目录已回滚')
      else if (status === 'cancelled' || status === 'interrupted') toast('迁移已取消，目录已回滚')
      void load()
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 900)
    return () => { alive = false; window.clearInterval(timer) }
  }, [taskId, running, load])

  const elapsed = useElapsed(running, migration?.startedAt ?? 0)

  const dirty = draft.mcpDir.trim() !== saved.mcpDir.trim() || draft.workspaceRoot.trim() !== saved.workspaceRoot.trim()
  const mcpProblem = draft.mcpDir.trim() ? dirProblem(draft.mcpDir, 'MCP 安装目录') : ''
  const rootProblem = draft.workspaceRoot.trim() ? dirProblem(draft.workspaceRoot, '会话工作区根目录') : ''
  const readOnly = unsupported || loading
  const migrating = running

  /** 两个目录的实际目标值（界面里显示的就是绝对值，直接回写即可）。 */
  const target = (): Paths => ({
    ...EMPTY_PATHS,
    mcpDir: draft.mcpDir.trim(),
    workspaceRoot: draft.workspaceRoot.trim(),
  })

  const savePaths = async (): Promise<void> => {
    const problem = dirProblem(draft.mcpDir, 'MCP 安装目录') || dirProblem(draft.workspaceRoot, '会话工作区根目录')
    if (problem) { setError(problem); toast.error(problem); return }
    const next = target()
    setBusy(true)
    // 引擎的键名是 camelCase 的 mcpInstallDir / workspaceRoot；两种写法都带上（含包一层 paths），
    // 引擎读哪种都能对上，读不到的字段会被忽略。
    const body = {
      mcpInstallDir: next.mcpDir,
      workspaceRoot: next.workspaceRoot,
      mcp_dir: next.mcpDir,
      mcpDir: next.mcpDir,
      workspace_root: next.workspaceRoot,
      paths: { mcpInstallDir: next.mcpDir, workspaceRoot: next.workspaceRoot },
    }
    const reply = await request<unknown>('/api/settings/paths', jsonInit('PUT', body))
    setBusy(false)
    if (!reply.ok) {
      if (isUnsupportedReply(reply)) {
        setUnsupported(true)
        toast.error('引擎暂不支持修改存储位置（没有 /api/settings/paths 接口）')
        void load()
        return
      }
      const message = replyMessage(reply, '引擎没有返回原因')
      setError('保存失败：' + message)
      toast.error('保存失败：' + message)
      return
    }
    // 引擎回传的归一化结果优先（它会建目录、展开环境变量、拒绝非法路径）。
    const echoed = parsePaths(reply.data)
    const settled = echoed.mcpDir || echoed.workspaceRoot ? echoed : next
    setSaved(settled)
    setDraft(settled)
    setError('')
    toast.success('存储位置已保存')
  }

  /** 一次搬一个目录：引擎的 migrate 是同步的（复制 → 校验 → 原子切换，失败回滚），body 只认 {kind,to}。 */
  const migrateOne = async (kind: 'mcpInstallDir' | 'workspaceRoot', label: string, to: string): Promise<boolean> => {
    const startedAt = Date.now()
    setMigration({
      taskId: '', status: 'running', running: true, progress: null,
      message: '正在复制 ' + label + ' → ' + to, log: [], error: '', rolledBack: false, startedAt,
    })
    const reply = await request<unknown>('/api/settings/paths/migrate', jsonInit('POST', {
      kind,
      to,
      // 旧写法也带上：引擎只读它认识的键，多给几个不影响。
      mcp_dir: to,
      mcpDir: to,
      workspace_root: to,
      workspaceRoot: to,
    }))
    if (!reply.ok) {
      const message = replyMessage(reply, '引擎没有返回原因')
      setMigration({
        taskId: '', status: 'failed', running: false, progress: null,
        message: label, log: [], error: message, rolledBack: !isUnsupportedReply(reply), startedAt,
      })
      if (isUnsupportedReply(reply)) {
        setUnsupported(true)
        toast.error('引擎暂不支持迁移（没有 /api/settings/paths/migrate 接口）')
      } else {
        setError('迁移失败：' + message + '（引擎会回滚，原目录不受影响）')
        toast.error('迁移失败：' + message)
      }
      // 失败＝引擎回滚：把界面上的路径重新读回真实值，别让输入框停在没成功的那个目标上。
      void load()
      return false
    }
    const payload = isRecord(reply.data) ? reply.data : null
    const files = asNumber(payload?.files)
    const bytes = asNumber(payload?.bytes)
    const copied = payload?.copied !== false
    const verified = payload?.verified !== false
    const detail = copied
      ? '已复制 ' + files + ' 个文件（' + formatBytes(bytes) + '）' + (verified ? '，校验通过' : '')
      : '源目录没有内容，只切换了指针'
    const nextTaskId = asText(payload?.task_id) || asText(payload?.taskId) || asText(payload?.id)
    if (nextTaskId) {
      // 有的引擎版本仍然返回任务 id（异步）：交给上面那段轮询继续跟。
      setMigration({
        taskId: nextTaskId, status: asText(payload?.status) || 'running', running: true,
        progress: asProgress(payload?.progress), message: asText(payload?.message) || detail,
        log: [], error: '', rolledBack: false, startedAt,
      })
      return true
    }
    setMigration({
      taskId: '', status: 'completed', running: false, progress: 1,
      message: label + '：' + detail, log: [], error: '', rolledBack: false, startedAt,
    })
    return true
  }

  const startMigration = async (): Promise<void> => {
    const problem = dirProblem(draft.mcpDir, 'MCP 安装目录') || dirProblem(draft.workspaceRoot, '会话工作区根目录')
    if (problem) { setError(problem); toast.error(problem); return }
    const to = target()
    const jobs: Array<{ kind: 'mcpInstallDir' | 'workspaceRoot'; label: string; to: string }> = []
    if (to.mcpDir !== saved.mcpDir.trim()) jobs.push({ kind: 'mcpInstallDir', label: 'MCP 安装目录', to: to.mcpDir })
    if (to.workspaceRoot !== saved.workspaceRoot.trim()) jobs.push({ kind: 'workspaceRoot', label: '会话工作区根目录', to: to.workspaceRoot })
    if (!jobs.length) { toast.error('路径没有变化，先改一个再迁移'); return }
    if (confirmDanger && !window.confirm('开始迁移？迁移期间请勿关闭 Coomi；失败会自动回滚，原目录不受影响。')) return
    setBusy(true)
    setError('')
    let ok = 0
    for (const job of jobs) {
      const done = await migrateOne(job.kind, job.label, job.to)
      if (!done) break
      ok += 1
    }
    setBusy(false)
    if (ok === jobs.length) toast.success('迁移完成，存储位置已切换（原目录里的内容保留着，确认无误后可自行清理）')
    void load()
  }

  const cancelMigration = async (): Promise<void> => {
    if (!migration) return
    setCancelling(true)
    const accepted = await cancelEngineTask(migration.taskId)
    setCancelling(false)
    if (accepted) toast('已请求取消：引擎会把已复制的文件回滚')
    else toast.error('取消失败：引擎没有接受（任务可能已经结束）')
  }

  const openPath = (path: string): void => {
    if (!path.trim()) return
    void ipc('open_path', { path }).catch(() => toast.error('打开失败：桌面壳未就绪'))
  }

  return (
    <Section
      className={active ? '' : 'hidden'}
      title='存储位置'
      description='MCP 与工作区数据放在哪里；改动只影响 Coomi 自己管理的目录。'
      actions={
        <>
          <Button variant='ghost' size='icon-sm' title='重新读取' disabled={busy || loading || migrating} onClick={() => void load()}>
            {loading ? <Spinner /> : <RefreshCw size={13} />}
          </Button>
          <Button
            variant='secondary'
            size='sm'
            disabled={busy || readOnly || migrating || !dirty || !!mcpProblem || !!rootProblem}
            title={dirty ? '把输入框里的路径写进引擎设置' : '还没有改动'}
            onClick={() => void savePaths()}
          >
            <Save size={13} /> 保存
          </Button>
          <Button
            variant='primary'
            size='sm'
            disabled={busy || readOnly || migrating || !dirty || !!mcpProblem || !!rootProblem}
            title={dirty ? '把已有数据复制到新目录，成功后切换；失败自动回滚' : '先改路径，再迁移'}
            onClick={() => void startMigration()}
          >
            <HardDrive size={13} /> 迁移
          </Button>
        </>
      }
    >
      <div className='flex min-w-0 flex-col gap-2.5 px-5 py-4' data-testid='storage-panel'>
        {unsupported ? (
          <p className='flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-12 leading-[1.65] text-warn'>
            <AlertTriangle size={13} className='mt-0.5 shrink-0' />
            <span className='min-w-0'>
              引擎暂不支持存储位置管理（没有 /api/settings/paths 接口）。这里只读展示：
              工作区根目录来自 /api/runtime/health 的当前工作目录，迁移按钮已禁用。
            </span>
          </p>
        ) : null}

        {error ? (
          <p className='flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-12 leading-[1.65] text-danger'>
            <AlertTriangle size={13} className='mt-0.5 shrink-0' />
            <span className='min-w-0 break-all'>{error}</span>
          </p>
        ) : null}

        {loading && !saved.mcpDir && !saved.workspaceRoot ? (
          <div className='flex flex-col gap-2.5'>
            <Skeleton className='h-[68px] rounded-lg' />
            <Skeleton className='h-[68px] rounded-lg' />
          </div>
        ) : (
          <>
            <DirRow
              label='MCP 安装目录'
              hint={unsupported
                ? '引擎暂不支持读取或修改'
                : saved.mcpFromDefault
                  ? 'MCP 服务器（npx / uvx 拉起的那些）落盘的目录；现在用的是默认位置' + (saved.mcpDefault ? '：' + saved.mcpDefault : '')
                  : 'MCP 服务器（npx / uvx 拉起的那些）落盘的目录'}
              value={draft.mcpDir}
              placeholder={unsupported ? '引擎暂不支持' : 'D:\\Coomi\\mcp'}
              problem={mcpProblem}
              disabled={readOnly || migrating}
              busy={busy}
              onInput={(next) => setDraft((d) => ({ ...d, mcpDir: next }))}
              onOpenPath={() => openPath(draft.mcpDir)}
            />
            <DirRow
              label='会话工作区根目录'
              hint={unsupported
                ? '只读：/api/runtime/health 返回的当前工作目录'
                : saved.workspaceFromDefault
                  ? '新会话默认的工作目录，会话产物也落在这里；现在用的是默认位置' + (saved.workspaceDefault ? '：' + saved.workspaceDefault : '')
                  : '新会话默认的工作目录，会话产物也落在这里'}
              value={draft.workspaceRoot}
              placeholder={unsupported ? '引擎暂不支持' : 'D:\\Coomi\\workspaces'}
              problem={rootProblem}
              disabled={readOnly || migrating}
              busy={busy}
              onInput={(next) => setDraft((d) => ({ ...d, workspaceRoot: next }))}
              onOpenPath={() => openPath(draft.workspaceRoot)}
            />
          </>
        )}

        {migration ? (
          <div className='rounded-lg border border-line bg-muted px-3 py-3' data-testid='storage-migrate-card'>
            <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5'>
              <span className='flex items-center gap-1.5 text-12 font-medium text-ink'>
                {migration.running ? <Spinner /> : null}
                {statusLabel(migration.status)}
              </span>
              {migration.running ? <span className='text-11 text-ink-4'>已用时 {elapsed} 秒</span> : null}
              {migration.message ? <span className='min-w-0 truncate text-11 text-ink-4' title={migration.message}>{migration.message}</span> : null}
              <span className='ml-auto flex shrink-0 items-center gap-1.5'>
                {migration.progress !== null ? (
                  <span className='font-mono text-11 tabular-nums text-ink-2'>{Math.round(migration.progress * 100)}%</span>
                ) : null}
                {migration.running && migration.taskId ? (
                  <Button variant='ghost' size='sm' className='text-ink-3 hover:text-danger' disabled={cancelling} onClick={() => void cancelMigration()}>
                    <X size={13} /> 取消迁移
                  </Button>
                ) : migration.running ? (
                  // 引擎这次是同步迁移（复制完才回话），没有任务 id 可取消。
                  <span className='text-11 text-ink-4'>正在复制，请稍候…</span>
                ) : (
                  <Button variant='ghost' size='sm' onClick={() => setMigration(null)}>关闭</Button>
                )}
              </span>
            </div>
            {migration.running ? (
              migration.progress === null
                // 引擎没给百分比：用不确定进度条，不编一个假的百分比出来。
                ? <Skeleton className='mt-2 h-1 rounded-full' />
                : <Progress className='mt-2' value={migration.progress} />
            ) : null}
            {migration.error ? (
              <p className='mt-2 flex items-start gap-1.5 text-11 leading-[1.6] text-danger'>
                <AlertTriangle size={12} className='mt-0.5 shrink-0' />
                <span className='min-w-0 break-all'>{migration.error}</span>
              </p>
            ) : null}
            {migration.rolledBack && !migration.running ? (
              <p className='mt-1.5 text-11 text-ink-4'>引擎已回滚：原目录里的数据仍然完整，可以直接重试。</p>
            ) : null}
            {migration.log.length ? (
              <pre className='mt-2 max-h-[140px] overflow-auto whitespace-pre-wrap break-all font-mono text-11 leading-[1.6] text-ink-2'>
                {migration.log.slice(-12).join('\n')}
              </pre>
            ) : null}
          </div>
        ) : null}

        <p className={cn('text-11 leading-[1.75] text-ink-4', migrating && 'opacity-70')}>
          {migrating
            ? '迁移进行中：引擎正在复制数据，其间请勿关闭 Coomi；中途取消或失败都会回滚到原目录。'
            : '保存只是把路径写进引擎设置；要让数据真的搬过去，点右上角「迁移」。迁移成功后旧目录里的内容不会被删除，确认无误后可以自行清理。'}
        </p>
      </div>
    </Section>
  )
}

/* #185 的报错栈里显示真名（生产构建会压掉函数名） */
withDisplayName(StoragePanel, 'StoragePanel')
