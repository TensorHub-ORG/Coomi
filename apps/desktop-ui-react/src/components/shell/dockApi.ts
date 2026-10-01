/**
 * 侧边栏的引擎只读端点收口层：把新增的 4 个只读端点包成带类型的函数，
 * 让各页签只关心「拿到数据」和「怎么显示」，不再各自拼 URL、各自解析错误串。
 *
 * 收录的端点（全部只读，不改变引擎状态）：
 * - GET /api/sessions/{id}/context    完整 ContextStatus（已用 / 剩余 / 压缩阈值 / 压缩次数）
 * - GET /api/sessions/{id}/artifacts  会话产物清单（真实文件 + size + modified + kind，scope=cwd 时扫会话目录）
 * - GET /api/runtime/logs?lines=N     引擎运行日志尾部（没有日志文件时 404）
 * - GET /api/tasks/{task_id}/log      任务输出日志尾部（未知 task_id 时 400）
 *
 * 失败一律抛 DockApiError：带 HTTP 状态码与可展示文案，页签据此区分
 * 「引擎没有这个接口 / 资源不存在（404）」「任务不存在（400）」与真正的故障。
 */
import { useEngine } from '../../stores/engine'
import { basename, readRawText, useDockPreview } from './dockShared'

/* ── 错误 ── */

export class DockApiError extends Error {
  readonly status: number
  readonly endpoint: string
  /** 引擎返回体里的 `error` 原文（可能是英文），只用于排查，不作为主文案。 */
  readonly detail: string

  constructor(endpoint: string, status: number, message: string, detail = '') {
    super(message)
    this.name = 'DockApiError'
    this.endpoint = endpoint
    this.status = status
    this.detail = detail
  }
}

/** 从引擎的错误响应体里取 `{"error": "..."}`；取不到就用空串（例如路由本身不存在）。 */
function errorDetail(body: string): string {
  if (!body) return ''
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed?.error === 'string') return parsed.error
  } catch { /* 不是 JSON：按纯文本截断展示 */ }
  return body.slice(0, 200)
}

function describeError(status: number, detail: string): string {
  if (!detail) {
    if (status === 404) return '引擎没有这个接口（可能引擎版本较旧）'
    return '引擎返回 HTTP ' + status
  }
  if (status === 400) return '请求被引擎拒绝：' + detail
  if (status === 404) return '引擎找不到对应资源：' + detail
  return 'HTTP ' + status + '：' + detail
}

/** 只读 GET：连不上、非 2xx、响应不是 JSON 都归一到 DockApiError。 */
async function engineGet<T>(path: string): Promise<T> {
  const engine = useEngine.getState()
  let response: Response
  try {
    response = await fetch('http://127.0.0.1:' + engine.port + path, { headers: engine.authHeaders() })
  } catch (error) {
    throw new DockApiError(path, 0, '连不上本地引擎：' + (error instanceof Error ? error.message : String(error)))
  }
  const body = await response.text().catch(() => '')
  if (!response.ok) {
    const detail = errorDetail(body)
    throw new DockApiError(path, response.status, describeError(response.status, detail), detail)
  }
  if (!body) return null as T
  try {
    return JSON.parse(body) as T
  } catch {
    throw new DockApiError(path, response.status, '引擎返回了无法解析的内容')
  }
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/* ── 1) 会话上下文：GET /api/sessions/{id}/context ── */

/** 引擎 ContextStatus（9 个字段顶层平铺）+ session_id / provider_id / model。 */
export interface SessionContextStatus {
  used_tokens: number
  context_window: number
  effective_context_window: number
  auto_compact_token_limit: number
  remaining_tokens: number
  used_percent: number
  remaining_percent: number
  auto_compact_scope_tokens: number
  compaction_count: number
  session_id?: string
  provider_id?: string
  model?: string
}

export function fetchSessionContext(sessionId: string): Promise<SessionContextStatus> {
  return engineGet<SessionContextStatus>('/api/sessions/' + encodeURIComponent(sessionId) + '/context')
}

/* ── 2) 会话产物：GET /api/sessions/{id}/artifacts ── */

export type ArtifactKind = 'image' | 'text' | 'code' | 'other'

export interface SessionArtifact {
  path: string
  name: string
  size: number
  /** 引擎给的是秒级时间戳，这里统一换算成毫秒。 */
  modified: number
  kind: ArtifactKind
}

export interface SessionArtifacts {
  root: string
  artifacts: SessionArtifact[]
  /** 引擎的条目上限（500）被打满时为 true，说明清单可能不全。 */
  capped: boolean
}

const ARTIFACT_KINDS: ArtifactKind[] = ['image', 'text', 'code', 'other']
const ARTIFACT_LIMIT = 500

/**
 * 会话产物清单。默认只扫会话隔离工作区；scope='cwd' 时扫会话自选的目录
 * （会话没设 cwd 时引擎会退回工作区，界面用 root 比对后会跳过重复卡片）。
 */
export async function fetchSessionArtifacts(sessionId: string, scope?: 'cwd'): Promise<SessionArtifacts> {
  const query = scope ? '?scope=' + scope : ''
  const data = await engineGet<{ root?: unknown; artifacts?: unknown }>(
    '/api/sessions/' + encodeURIComponent(sessionId) + '/artifacts' + query,
  )
  const raw = Array.isArray(data?.artifacts) ? data.artifacts : []
  const artifacts: SessionArtifact[] = raw.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>
    const path = String(entry.path ?? '')
    const kind = String(entry.kind ?? '')
    return {
      path,
      name: String(entry.name ?? '') || basename(path),
      size: num(entry.size),
      modified: num(entry.modified) * 1000,
      kind: (ARTIFACT_KINDS as string[]).includes(kind) ? (kind as ArtifactKind) : 'other',
    }
  }).filter((item) => item.path.length > 0)
  return { root: String(data?.root ?? ''), artifacts, capped: raw.length >= ARTIFACT_LIMIT }
}

/* ── 3) 引擎日志：GET /api/runtime/logs ── */

export interface LogTail {
  path: string
  lines: string[]
  truncated: boolean
}

export async function fetchRuntimeLogs(lines = 120): Promise<LogTail> {
  const data = await engineGet<{ path?: unknown; lines?: unknown; truncated?: unknown }>(
    '/api/runtime/logs?lines=' + Math.max(1, Math.floor(lines)),
  )
  return {
    path: String(data?.path ?? ''),
    lines: Array.isArray(data?.lines) ? data.lines.map((line) => String(line)) : [],
    truncated: data?.truncated === true,
  }
}

/* ── 4) 任务输出日志：GET /api/tasks/{task_id}/log ── */

export interface TaskLogTail extends LogTail {
  task_id: string
}

export async function fetchTaskLog(taskId: string, lines = 80): Promise<TaskLogTail> {
  const data = await engineGet<{ task_id?: unknown; path?: unknown; lines?: unknown; truncated?: unknown }>(
    '/api/tasks/' + encodeURIComponent(taskId) + '/log?lines=' + Math.max(1, Math.floor(lines)),
  )
  return {
    task_id: String(data?.task_id ?? taskId),
    path: String(data?.path ?? ''),
    lines: Array.isArray(data?.lines) ? data.lines.map((line) => String(line)) : [],
    truncated: data?.truncated === true,
  }
}

/* ── 预览：按引擎给的 kind 挑方式 ──
   端点 2 已经告诉我们条目是什么类型，不用再靠扩展名猜：
   image 走 /api/fs/raw 直接渲染图片，text/code 走文本预览，other 交给共享预览按扩展名判断。 */
export async function openArtifactPreview(item: { path: string; kind?: ArtifactKind }): Promise<void> {
  const path = item.path
  if (!path) return
  const kind = item.kind
  if (kind === 'text' || kind === 'code') {
    // 引擎归类为文本/代码：直接读原文，不再让共享预览重复按扩展名放行一次。
    useDockPreview.setState({ path, name: basename(path), text: '', loading: true, error: '' })
    try {
      const text = await readRawText(path)
      useDockPreview.setState({ text, loading: false, error: '' })
    } catch (error) {
      useDockPreview.setState({ text: '', loading: false, error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  await useDockPreview.getState().open(path)
}
