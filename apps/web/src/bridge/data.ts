/**
 * 开发数据工具（Wave 3 引擎 API）封装。
 *
 * 端点与 `services/src/data_tools.rs` 对应：
 * - GET  /api/git/contributions?sinceDays=   Git 贡献统计
 * - POST /api/sessions/{id}/export           会话导出为 Markdown
 * - GET  /api/sessions/search?q&limit        会话全文搜索
 * - GET  /api/usage/by-day                   用量按天聚合
 *
 * 字段命名与后端 serde 序列化输出严格一致（snake_case，如 session_id /
 * message_index / total_commits / first_commit_at / by_day）。
 */
import { apiGet, apiSend } from './http'

// ---------------------------------------------------------------------------
// 响应类型（与后端 serde 结构体逐字段对应）
// ---------------------------------------------------------------------------

export interface AuthorContribution {
  name: string
  email: string
  commits: number
}

export interface DayCount {
  /** YYYY-MM-DD（本地时区）。 */
  date: string
  commits: number
}

export interface ContributionReport {
  authors: AuthorContribution[]
  total_commits: number
  /** Unix epoch 秒；无提交时为 null。 */
  first_commit_at: number | null
  last_commit_at: number | null
  by_day: DayCount[]
}

export interface SearchHit {
  session_id: string
  message_index: number
  /** 命中点前后各 40 字符片段（去换行）。 */
  snippet: string
}

export interface DayUsage {
  /** YYYY-MM-DD（本地时区）。 */
  date: string
  requests: number
  /** 当日 token 总量；数据源缺 token 字段时为 null。 */
  tokens: number | null
}

/** 会话导出应答（产物文件路径）。 */
export interface ExportResult {
  path: string
}

// ---------------------------------------------------------------------------
// GET 端点
// ---------------------------------------------------------------------------

/** Git 贡献统计；sinceDays 省略时统计全部历史。 */
export function contributionStats(sinceDays?: number): Promise<ContributionReport> {
  const params = sinceDays !== undefined ? `?sinceDays=${sinceDays}` : ''
  return apiGet(`/api/git/contributions${params}`)
}

/** 会话全文搜索（大小写不敏感）；limit 省略时后端取默认 50。 */
export function searchSessions(query: string, limit = 50): Promise<SearchHit[]> {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  params.set('limit', String(limit))
  const s = params.toString()
  return apiGet(`/api/sessions/search${s ? `?${s}` : ''}`)
}

/** 用量按天聚合（日期倒序）。 */
export function usageByDay(): Promise<DayUsage[]> {
  return apiGet('/api/usage/by-day')
}

// ---------------------------------------------------------------------------
// POST 端点
// ---------------------------------------------------------------------------

/** 将会话导出为 Markdown 文件并返回落盘路径。 */
export function exportSession(id: string): Promise<ExportResult> {
  return apiSend(`/api/sessions/${encodeURIComponent(id)}/export`, 'POST')
}
