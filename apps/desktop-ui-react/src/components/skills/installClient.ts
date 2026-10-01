/** 一键安装的两条引擎链路（远程 MCP / 本机运行环境）的调用层。
 *
 *  为什么不用 stores/engine 的 api()：install-remote 用 409 与 502 表达「已存在」与
 *  「配置已保存但连不上」，两种 body 里都带着可用信息（stderr 尾部、加载状态）；api()
 *  会把非 2xx 压成一行字符串，这些信息就丢了。所以这里自己判 res.ok、自己解析 JSON，
 *  并把 404 单独归类成「引擎还没有这个接口」——界面据此降级成「复制命令」而不是报故障。
 *
 *  引擎侧接口（apps/coomi-rs/ui/src/web）：
 *   · POST   /api/catalog/mcp/install-remote  {id,name,transport,command,args,env,url,overwrite}
 *   · GET    /api/runtime/install-plan?id=    → {plan, allowed, supported}
 *   · POST   /api/runtime/install             {id,confirm:true,force?} → task_id
 *   · GET    /api/runtime/install-status?task_id= → status / before / after / log_lines
 *   · GET    /api/tasks/{id}/log?lines=       → 任务日志尾部（install-status 不可用时的兜底）
 *   · DELETE /api/tasks/{id}                  → 取消安装任务
 *   · POST   /api/catalog/mcp/install         {id,values}    → {task_id,pending}
 *   · POST   /api/catalog/skills/install      {id}           → {task_id,pending}
 *   · GET    /api/task-details/{task_id}                     → 任务状态（安装进度）
 *   · GET    /api/tasks/{task_id}/log?lines=                 → 安装日志尾部
 */

import { useEngine } from '../../stores/engine'

/* ── 目录安装（工具 / 技能）的任务化（2026-09-28）──
   引擎把 /api/catalog/mcp/install 与 /api/catalog/skills/install 改成「登记任务 + 后台执行」：
   立刻回 { ok, id, task_id, pending: true }，真正干活在后台，状态与日志都在任务中心里。
   前端在这里等它跑完（顺便把输出尾部拿回来显示），旧版引擎（回包里没有 task_id）则视为已完成。 */

export interface CatalogInstallOutcome {
  ok: boolean
  taskId: string
  status: string
  error: string
  /** 任务输出尾部（失败时通常就是唯一有用的信息）。 */
  tail: string
}

/** 目录安装任务的轮询节奏（毫秒）。waitInstallTask 与「技能中心 › 任务」子视图共用这一个值：
 *  任务的输出是流式写进日志的，700ms 一问看起来才像实时；两处各写一个间隔迟早会跑偏。 */
export const INSTALL_TASK_POLL_MS = 700

/** 轮询一次目录安装任务：直到 Completed / Failed / Cancelled 或超时。 */
export async function waitInstallTask(
  taskId: string,
  options: { timeoutMs?: number; onTick?: (info: { status: string; tail: string }) => void } = {},
): Promise<CatalogInstallOutcome> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const startedAt = Date.now()
  let tail = ''
  let status = 'running'
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, INSTALL_TASK_POLL_MS))
    const detail = await request<{ task?: { status?: string; error?: string } }>(
      '/api/task-details/' + encodeURIComponent(taskId),
    )
    const log = await request<{ lines?: string[] }>(
      '/api/tasks/' + encodeURIComponent(taskId) + '/log?lines=20',
    )
    if (Array.isArray(log.data?.lines)) tail = log.data!.lines.join('\n')
    status = String(detail.data?.task?.status ?? status)
    const error = String(detail.data?.task?.error ?? '')
    options.onTick?.({ status, tail })
    if (status === 'completed') return { ok: true, taskId, status, error: '', tail }
    if (status === 'failed' || status === 'cancelled' || status === 'conflict') {
      return { ok: false, taskId, status, error: error || tail || '安装失败', tail }
    }
  }
  return { ok: false, taskId, status, error: '安装超时（10 分钟没有结束）', tail }
}

/* ── 请求底座 ── */

export interface EngineReply<T> {
  status: number
  ok: boolean
  data: T | null
  text: string
  /** 网络层失败（引擎没起来 / 端口还没分配）的原因：与 HTTP 错误分开表达。 */
  networkError: string
}

async function request<T>(path: string, init?: RequestInit): Promise<EngineReply<T>> {
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
      status: 0,
      ok: false,
      data: null,
      text: '',
      networkError: error instanceof Error ? error.message : String(error),
    }
  }
}

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function field(source: Record<string, unknown> | null | undefined, key: string): string {
  const value = source?.[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** 引擎的错误体统一是 {"error": "..."}；没有 JSON 时退回文本片段 / 网络原因。 */
export function replyMessage(reply: EngineReply<unknown>, fallback: string): string {
  const fromBody = field(isRecord(reply.data) ? reply.data : null, 'error')
    || field(isRecord(reply.data) ? reply.data : null, 'message')
  if (fromBody) return fromBody
  const text = reply.text.trim()
  if (text) return text.slice(0, 300)
  if (reply.networkError) return reply.networkError
  return fallback
}

/** 404（或明确写着 404 的文本）＝引擎还没有这个接口：界面要降级，不要报故障。 */
export function isUnsupportedReply(reply: EngineReply<unknown>): boolean {
  return reply.status === 404 || /HTTP 404|unknown route|no route/i.test(reply.text)
}

/* ── 远程 MCP：一键写进 config/mcp_servers.json 并热重载 ── */

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpInstallDefinition {
  /** 原始标识（远程源里的 id），只用于回显与冲突判定。 */
  id: string
  /** 写进 mcp_servers.json 的键名（servers 的键）。 */
  name?: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  overwrite?: boolean
}

export interface McpInstallResult {
  httpStatus: number
  /** 写盘 + 热重载后连上了（HTTP 200）。 */
  ok: boolean
  /** 配置已经写进 mcp_servers.json（502 时也是 true：写盘成功、连接失败）。 */
  saved: boolean
  connected: boolean
  /** 409：同名/同 id 条目已存在，需要 overwrite。 */
  conflict: boolean
  /** 404：引擎没有 install-remote 接口。 */
  unsupported: boolean
  id: string
  name: string
  transport: string
  status: string
  toolsCount: number
  error: string
  /** 引擎回传的子进程 stderr 尾部（连接失败时最有用的那几行）。 */
  stderrTail: string
  path: string
  message: string
}

export async function installRemoteMcp(definition: McpInstallDefinition): Promise<McpInstallResult> {
  const reply = await request<Record<string, unknown>>('/api/catalog/mcp/install-remote', jsonInit({
    id: definition.id,
    name: definition.name || definition.id,
    transport: definition.transport,
    command: definition.command ?? '',
    args: definition.args ?? [],
    env: definition.env ?? {},
    url: definition.url ?? '',
    overwrite: definition.overwrite === true,
  }))
  const body = isRecord(reply.data) ? reply.data : null
  const toolsCount = body && typeof body.tools_count === 'number' ? body.tools_count : 0
  const saved = body?.saved === true || reply.status === 200 || reply.status === 502
  return {
    httpStatus: reply.status,
    ok: reply.status === 200,
    saved,
    connected: body?.connected === true,
    conflict: reply.status === 409,
    unsupported: isUnsupportedReply(reply),
    id: field(body, 'id') || definition.id,
    name: field(body, 'name') || definition.name || definition.id,
    transport: field(body, 'transport') || definition.transport,
    status: field(body, 'status'),
    toolsCount,
    error: field(body, 'error'),
    stderrTail: field(body, 'stderr_tail'),
    path: field(body, 'path'),
    message: reply.ok ? '' : replyMessage(reply, '安装失败：引擎没有返回可读原因'),
  }
}

/* ── 运行环境：确认卡 → 一键安装 → 实时日志 → 取消 ── */

export interface RuntimeProbe {
  label: string
  found: boolean
  version: string
  path: string
}

export interface RuntimeInstallPlan {
  id: string
  label: string
  /** winget：引擎代装；guided：只给人工引导（例如 Docker）。 */
  kind: string
  installable: boolean
  /** 确认卡上展示的完整命令——引擎实际执行的同一条。 */
  command: string
  manualCommand: string
  program: string
  args: string[]
  scope: string
  requiresElevation: boolean
  wingetAvailable: boolean
  /** 引擎设置里「允许一键安装运行时」开关的当前值。 */
  allowed: boolean
  alreadyInstalled: boolean
  found: boolean
  version: string
  path: string
  guidance: string
  note: string
  url: string
  steps: string[]
}

export interface RuntimePlanReply {
  plan: RuntimeInstallPlan | null
  allowed: boolean
  supported: string[]
  /** 引擎没有 install-plan 接口（404）：界面降级回「复制命令」。 */
  unsupported: boolean
  error: string
}

function asProbe(value: unknown): RuntimeProbe | null {
  if (!isRecord(value)) return null
  return {
    label: field(value, 'label') || field(value, 'id'),
    found: value.found === true,
    version: field(value, 'version'),
    path: field(value, 'path'),
  }
}

function asPlan(value: unknown): RuntimeInstallPlan | null {
  if (!isRecord(value)) return null
  const id = field(value, 'id')
  if (!id) return null
  return {
    id,
    label: field(value, 'label') || id,
    kind: field(value, 'kind'),
    installable: value.installable === true,
    command: field(value, 'command'),
    manualCommand: field(value, 'manual_command'),
    program: field(value, 'program'),
    args: strArray(value.args),
    scope: field(value, 'scope'),
    requiresElevation: value.requires_elevation === true,
    wingetAvailable: value.winget_available !== false,
    allowed: value.allowed !== false,
    alreadyInstalled: value.already_installed === true,
    found: value.found === true,
    version: field(value, 'version'),
    path: field(value, 'path'),
    guidance: field(value, 'guidance'),
    note: field(value, 'note'),
    url: field(value, 'url'),
    steps: strArray(value.steps),
  }
}

/** GET /api/runtime/install-plan?id=：只读，拿确认卡数据（引擎此时不执行任何东西）。 */
export async function fetchRuntimeInstallPlan(id: string): Promise<RuntimePlanReply> {
  const reply = await request<Record<string, unknown>>('/api/runtime/install-plan?id=' + encodeURIComponent(id))
  if (reply.ok && isRecord(reply.data)) {
    const plan = asPlan(reply.data.plan)
    return {
      plan,
      allowed: reply.data.allowed !== false,
      supported: strArray(reply.data.supported),
      unsupported: false,
      error: plan ? '' : '引擎没有返回这条运行时的安装计划',
    }
  }
  const unsupported = isUnsupportedReply(reply)
  return {
    plan: null,
    allowed: false,
    supported: [],
    unsupported,
    error: unsupported ? '引擎暂不支持一键安装（没有 /api/runtime/install-plan 接口）' : replyMessage(reply, '取安装计划失败'),
  }
}

export interface RuntimeInstallStart {
  httpStatus: number
  ok: boolean
  unsupported: boolean
  /** 引擎不代装（Docker）：installable=false + guidance 文案。 */
  guided: boolean
  installable: boolean
  alreadyInstalled: boolean
  taskId: string
  status: string
  command: string
  label: string
  guidance: string
  before: RuntimeProbe | null
  after: RuntimeProbe | null
  message: string
}

/** POST /api/runtime/install {id, confirm:true}：建任务、拿 task_id。 */
export async function startRuntimeInstallTask(id: string, options?: { force?: boolean }): Promise<RuntimeInstallStart> {
  const reply = await request<Record<string, unknown>>('/api/runtime/install', jsonInit({
    id,
    confirm: true,
    force: options?.force === true,
  }))
  const body = isRecord(reply.data) ? reply.data : null
  const unsupported = isUnsupportedReply(reply)
  return {
    httpStatus: reply.status,
    ok: reply.ok && body?.ok !== false,
    unsupported,
    guided: body?.guided === true,
    installable: body?.installable !== false,
    alreadyInstalled: body?.already_installed === true,
    taskId: field(body, 'task_id'),
    status: field(body, 'status'),
    command: field(body, 'command'),
    label: field(body, 'label'),
    guidance: field(body, 'guidance'),
    before: asProbe(body?.before),
    after: asProbe(body?.after),
    message: reply.ok
      ? field(body, 'message')
      : unsupported
        ? '引擎暂不支持一键安装'
        : replyMessage(reply, '发起安装失败'),
  }
}

export interface RuntimeInstallSnapshot {
  taskId: string
  status: string
  running: boolean
  error: string
  before: RuntimeProbe | null
  after: RuntimeProbe | null
  log: string[]
  /** 这次进度从哪个接口读到的：install-status 更完整，任务日志是兜底。 */
  source: 'install-status' | 'task-log' | 'none'
}

const TERMINAL_TASK_STATUS = ['completed', 'failed', 'cancelled', 'conflict', 'interrupted']

/** GET /api/tasks/{id}/log?lines=N —— 引擎既有的任务日志接口。 */
export async function fetchTaskLogLines(taskId: string, lines = 200): Promise<string[] | null> {
  const reply = await request<Record<string, unknown>>(
    '/api/tasks/' + encodeURIComponent(taskId) + '/log?lines=' + lines,
  )
  if (!reply.ok || !isRecord(reply.data)) return null
  return strArray(reply.data.lines)
}

/**
 * 一次进度轮询：优先 /api/runtime/install-status（带 before/after + 日志尾部），
 * 它不可用时退回「任务日志 + 任务详情」这条既有链路。
 */
export async function pollRuntimeInstall(taskId: string): Promise<RuntimeInstallSnapshot> {
  const reply = await request<Record<string, unknown>>(
    '/api/runtime/install-status?task_id=' + encodeURIComponent(taskId),
  )
  if (reply.ok && isRecord(reply.data)) {
    const status = field(reply.data, 'status')
    return {
      taskId,
      status,
      running: reply.data.running === true,
      error: field(reply.data, 'error'),
      before: asProbe(reply.data.before),
      after: asProbe(reply.data.after),
      log: strArray(reply.data.log_lines),
      source: 'install-status',
    }
  }
  const log = await fetchTaskLogLines(taskId)
  const detail = await request<Record<string, unknown>>('/api/task-details/' + encodeURIComponent(taskId))
  const task = isRecord(detail.data) && isRecord(detail.data.task) ? detail.data.task : null
  if (!task && log === null) {
    return {
      taskId,
      status: '',
      running: false,
      error: replyMessage(reply, '读取安装进度失败'),
      before: null,
      after: null,
      log: [],
      source: 'none',
    }
  }
  const status = field(task, 'status')
  return {
    taskId,
    status,
    running: !!status && !TERMINAL_TASK_STATUS.includes(status),
    error: field(task, 'error'),
    before: null,
    after: null,
    log: log ?? [],
    source: 'task-log',
  }
}

/** DELETE /api/tasks/{id}：取消安装（引擎会杀掉 winget 并落结果行）。 */
export async function cancelEngineTask(taskId: string): Promise<boolean> {
  const reply = await request<Record<string, unknown>>('/api/tasks/' + encodeURIComponent(taskId), { method: 'DELETE' })
  if (!reply.ok) return false
  return isRecord(reply.data) ? reply.data.cancelled !== false : true
}

/** 安装任务的状态文案（进度卡与 toast 共用）。 */
export function runtimeTaskLabel(status: string): string {
  switch (status) {
    case 'queued': return '排队中'
    case 'waiting_lock': return '等待安装槽位'
    case 'running': return '正在安装'
    case 'pause_pending': return '正在暂停'
    case 'paused': return '已暂停'
    case 'awaiting_approval': return '等待授权'
    case 'awaiting_input': return '等待输入'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    case 'interrupted': return '已中断'
    case 'conflict': return '冲突'
    default: return status || '进行中'
  }
}
