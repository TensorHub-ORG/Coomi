/**
 * 运维诊断（Wave 3 引擎 API）封装。
 *
 * 端点与 `services/src/ops.rs` 对应：
 * - GET  /api/git/network-diagnostics | storage | guest-tools | credentials
 * - POST /api/git/log-bundle | credentials | remote/test
 * - DELETE /api/git/credentials/{service}/{key}
 *
 * 字段命名与后端 serde 序列化输出严格一致（snake_case，如 proxy_env /
 * latency_ms / workspace_bytes / git_dir_bytes / home_bytes）。
 */
import { apiGet, apiSend } from './http'

// ---------------------------------------------------------------------------
// 响应类型（与后端 serde 结构体逐字段对应）
// ---------------------------------------------------------------------------

/** 网络诊断报告：代理环境变量 + 固定端点探测结果。 */
export interface NetworkReport {
  /** 已设置的代理环境变量，格式 `NAME=value`（仅非空项）。 */
  proxy_env: string[]
  endpoints: EndpointProbe[]
}

/** 单个端点的连通性探测结果。 */
export interface EndpointProbe {
  host: string
  ok: boolean
  /** 毫秒级延迟；探测失败时为错误耗时，成功时必有值。 */
  latency_ms: number | null
  /** 失败原因（如连接错误 / HTTP 状态码），成功时为 null。 */
  error: string | null
}

export interface FileSize {
  path: string
  bytes: number
}

export interface CategorySize {
  category: string
  bytes: number
}

/** 存储分析报告：workspace / .git / home 大小、类别分组与 top 大文件。 */
export interface StorageReport {
  workspace_bytes: number
  git_dir_bytes: number
  home_bytes: number
  largest: FileSize[]
  categories: CategorySize[]
  /** 文件数超过上限时提前截断并标注。 */
  truncated: boolean
}

/** 宿主 CLI 工具探测结果。 */
export interface GuestTool {
  name: string
  version: string | null
  available: boolean
}

/** 凭据列表条目（只暴露 service/key，不返回 token）。 */
export interface CredentialEntry {
  service: string
  key: string
}

/** 远端连通测试结果。 */
export interface RemoteTestResult {
  ok: boolean
  latency_ms?: number | null
  error?: string | null
}

/** 诊断包 / 会话导出等「产物路径」类端点的统一应答。 */
export interface PathResult {
  path: string
}

// ---------------------------------------------------------------------------
// GET 端点
// ---------------------------------------------------------------------------

export function networkDiagnostics(): Promise<NetworkReport> {
  return apiGet('/api/git/network-diagnostics')
}

export function storageAnalysis(): Promise<StorageReport> {
  return apiGet('/api/git/storage')
}

export function guestTools(): Promise<GuestTool[]> {
  return apiGet('/api/git/guest-tools')
}

export function listCredentials(): Promise<CredentialEntry[]> {
  return apiGet('/api/git/credentials')
}

// ---------------------------------------------------------------------------
// POST / DELETE 端点
// ---------------------------------------------------------------------------

/** 生成日志诊断包（home/diagnostics/coomi-diagnose-<unix秒>.tar.gz）。 */
export function createLogBundle(): Promise<PathResult> {
  return apiSend('/api/git/log-bundle', 'POST')
}

export interface CredentialSaveRequest {
  service: string
  key: string
  token: string
}

export function saveCredential(body: CredentialSaveRequest): Promise<{ ok: boolean }> {
  return apiSend('/api/git/credentials', 'POST', body)
}

export function deleteCredential(service: string, key: string): Promise<{ ok: boolean }> {
  return apiSend(`/api/git/credentials/${encodeURIComponent(service)}/${encodeURIComponent(key)}`, 'DELETE')
}

export interface RemoteTestRequest {
  url: string
  token?: string
}

export function testRemote(body: RemoteTestRequest): Promise<RemoteTestResult> {
  return apiSend('/api/git/remote/test', 'POST', body)
}
