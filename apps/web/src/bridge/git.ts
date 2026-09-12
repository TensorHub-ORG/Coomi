/**
 * Git 面板 / 一键还原的引擎 API 封装。
 *
 * 端点与 `services/src/git_engine.rs` 一一对应：
 * - GET  /api/git/status | diff?path&cached&context | branches | log?path&limit
 *        | stash | remotes | project-info | snapshots | snapshots/{id}/diff
 *        | snapshots/schedule
 * - POST /api/git/stage | unstage | commit | branch | checkout | remote | fetch
 *        | pull | push | stash/push | stash/pop | stash/drop
 *        | snapshots | snapshots/{id}/preview | snapshots/{id}/restore
 *        | snapshots/{id}/update | compare | backup | ai/fix/suggest | ai/fix/apply
 *        | pr/describe | pr/create | ai/compare | ai/adversarial-review | ai/root-cause
 * - PUT  /api/git/snapshots/schedule
 *
 * 字段命名与后端 serde 序列化输出严格一致：git_engine.rs 的公开结构体
 * 未配置 `#[serde(rename_all = "camelCase")]`，因此 JSON 键保持结构体字段名
 * （snake_case，如 is_repo / session_id / created_at / file_count /
 * reverted_files / untracked_to_delete / backup_snapshot_id）。
 */
import { apiGet, apiSend } from './http'

// ---------------------------------------------------------------------------
// 响应类型（与后端 serde 结构体逐字段对应）
// ---------------------------------------------------------------------------

/** porcelain v2 双字符状态码 + 路径。 */
export interface FileEntry {
  path: string
  /** 如 "M."、"MM"、"??"、"U" 等压缩表示。 */
  status: string
  /** 重命名/复制时是原路径，否则 null。 */
  old_path: string | null
}

export interface GitStatus {
  is_repo: boolean
  branch: string | null
  ahead: number
  behind: number
  staged: FileEntry[]
  unstaged: FileEntry[]
  untracked: FileEntry[]
  conflicted: FileEntry[]
}

export interface DiffInfo {
  /** `git diff --stat` 输出。 */
  stat: string
  /** 完整 diff 文本（超长时被截断并追加提示行）。 */
  diff: string
  truncated: boolean
}

export interface BranchInfo {
  current: string | null
  branches: string[]
}

export interface CommitInfo {
  hash: string
  short: string
  subject: string
  author: string
  /** Unix epoch 秒（字符串）。 */
  date: string
}

export interface StashEntry {
  /** stash@{index} 的数字下标。 */
  index: number
  message: string
}

export interface RemoteInfo {
  name: string
  url: string
  /** 识别出的托管平台（GitHub/Gitee/GitLab/AtomGit/主机名/Other）。 */
  platform: string
}

export type SnapshotKind = 'turn' | 'session' | 'manual' | 'pre-restore'

export interface Snapshot {
  id: string
  kind: SnapshotKind
  session_id: string | null
  turn: number | null
  summary: string
  /** Unix epoch 秒。 */
  created_at: number
  sha: string
  file_count: number
  note: string | null
  locked: boolean
}

export interface SnapshotPreview {
  snapshot: Snapshot
  stat: string
  /** 还原将被回退的已跟踪文件。 */
  reverted_files: string[]
  /** 还原将被删除的未跟踪文件。 */
  untracked_to_delete: string[]
}

export interface RestoreReport {
  restored_to: string
  reverted_files: number
  deleted_untracked: number
  /** 还原前自动备份快照的 id。 */
  backup_snapshot_id: string
}

/** 定时快照配置（GET/PUT /api/git/snapshots/schedule）。 */
export interface SnapshotSchedule {
  /** 是否启用定时快照。 */
  enabled: boolean
  /** cron 表达式（5 段标准格式）；未配置时为 null。 */
  cron: string | null
  /** 保留的快照数量上限。 */
  retain: number
}

export interface ProjectInfo {
  /** 项目类型识别结果，如 ["Node.js"]。 */
  detected: string[]
  /** 对应的 .gitignore 模板内容；无识别结果时为 null。 */
  gitignore: string | null
}

/** 动作型端点的统一应答。 */
export interface GitAck {
  ok: boolean
}

export interface GitCommitResult extends GitAck {
  /** 提交后的完整 hash（后端返回时才有）。 */
  hash?: string
}

// ---------------------------------------------------------------------------
// 查询参数构造
// ---------------------------------------------------------------------------

export interface DiffQuery {
  path?: string
  cached?: boolean
  context?: number
}

function diffQuery(query: DiffQuery): string {
  const params = new URLSearchParams()
  if (query.path) params.set('path', query.path)
  if (query.cached) params.set('cached', 'true')
  if (query.context !== undefined) params.set('context', String(query.context))
  const s = params.toString()
  return s ? `?${s}` : ''
}

function logQuery(query: { path?: string; limit?: number }): string {
  const params = new URLSearchParams()
  if (query.path) params.set('path', query.path)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const s = params.toString()
  return s ? `?${s}` : ''
}

// ---------------------------------------------------------------------------
// GET 端点
// ---------------------------------------------------------------------------

export function gitStatus(): Promise<GitStatus> {
  return apiGet('/api/git/status')
}

export function gitDiff(query: DiffQuery = {}): Promise<DiffInfo> {
  return apiGet(`/api/git/diff${diffQuery(query)}`)
}

export function gitBranches(): Promise<BranchInfo> {
  return apiGet('/api/git/branches')
}

export function gitLog(query: { path?: string; limit?: number } = {}): Promise<CommitInfo[]> {
  return apiGet(`/api/git/log${logQuery(query)}`)
}

export function gitStashList(): Promise<StashEntry[]> {
  return apiGet('/api/git/stash')
}

export function gitRemotes(): Promise<RemoteInfo[]> {
  return apiGet('/api/git/remotes')
}

export function gitProjectInfo(): Promise<ProjectInfo> {
  return apiGet('/api/git/project-info')
}

export function gitSnapshots(): Promise<Snapshot[]> {
  return apiGet('/api/git/snapshots')
}

export function gitSnapshotDiff(id: string, query: DiffQuery = {}): Promise<DiffInfo> {
  return apiGet(`/api/git/snapshots/${encodeURIComponent(id)}/diff${diffQuery(query)}`)
}

/** 读取定时快照配置。 */
export function gitSnapshotSchedule(): Promise<SnapshotSchedule> {
  return apiGet('/api/git/snapshots/schedule')
}

// ---------------------------------------------------------------------------
// PUT 端点
// ---------------------------------------------------------------------------

/** 更新定时快照配置（enabled / cron / retain 均可省略，只更新传入字段）。 */
export function gitSnapshotScheduleUpdate(payload: Partial<SnapshotSchedule>): Promise<SnapshotSchedule> {
  return apiSend('/api/git/snapshots/schedule', 'PUT', payload)
}

// ---------------------------------------------------------------------------
// POST 端点
// ---------------------------------------------------------------------------

export interface StageRequest {
  paths: string[]
  /** 为 true 时忽略 paths，执行 add -A / restore --staged . */
  all?: boolean
}

export function gitStage(body: StageRequest): Promise<GitAck> {
  return apiSend('/api/git/stage', 'POST', body)
}

export function gitUnstage(body: StageRequest): Promise<GitAck> {
  return apiSend('/api/git/unstage', 'POST', body)
}

export function gitCommit(message: string): Promise<GitCommitResult> {
  return apiSend('/api/git/commit', 'POST', { message })
}

export function gitBranchCreate(name: string): Promise<GitAck> {
  return apiSend('/api/git/branch', 'POST', { name })
}

export function gitCheckout(branch: string): Promise<GitAck> {
  return apiSend('/api/git/checkout', 'POST', { branch })
}

export function gitRemoteAdd(name: string, url: string): Promise<GitAck> {
  return apiSend('/api/git/remote', 'POST', { name, url })
}

export function gitFetch(): Promise<GitAck> {
  return apiSend('/api/git/fetch', 'POST')
}

export function gitPull(remote: string, branch: string): Promise<GitAck> {
  return apiSend('/api/git/pull', 'POST', { remote, branch })
}

export function gitPush(remote: string, branch: string, token?: string): Promise<GitAck> {
  const body = token ? { remote, branch, token } : { remote, branch }
  return apiSend('/api/git/push', 'POST', body)
}

export function gitStashPush(message?: string): Promise<GitAck> {
  return apiSend('/api/git/stash/push', 'POST', message ? { message } : undefined)
}

export function gitStashPop(index: number): Promise<GitAck> {
  return apiSend('/api/git/stash/pop', 'POST', { index })
}

export function gitStashDrop(index: number): Promise<GitAck> {
  return apiSend('/api/git/stash/drop', 'POST', { index })
}

export interface SnapshotCreateRequest {
  kind: SnapshotKind
  sessionId?: string
  turn?: number
  summary: string
}

export function gitSnapshotCreate(body: SnapshotCreateRequest): Promise<Snapshot> {
  return apiSend('/api/git/snapshots', 'POST', {
    kind: body.kind,
    session_id: body.sessionId ?? null,
    turn: body.turn ?? null,
    summary: body.summary,
  })
}

export function gitSnapshotPreview(id: string): Promise<SnapshotPreview> {
  return apiSend(`/api/git/snapshots/${encodeURIComponent(id)}/preview`, 'POST')
}

export function gitSnapshotRestore(id: string): Promise<RestoreReport> {
  return apiSend(`/api/git/snapshots/${encodeURIComponent(id)}/restore`, 'POST')
}

export function gitSnapshotUpdate(id: string, body: { note?: string; locked?: boolean }): Promise<Snapshot> {
  return apiSend(`/api/git/snapshots/${encodeURIComponent(id)}/update`, 'POST', body)
}

/** 删除快照（DELETE /api/git/snapshots/{id}）。 */
export function gitSnapshotDelete(id: string): Promise<GitAck> {
  return apiSend(`/api/git/snapshots/${encodeURIComponent(id)}`, 'DELETE')
}

/** 对比两个 ref（快照 id / 提交 hash），返回差异。 */
export function gitCompare(from: string, to: string): Promise<DiffInfo> {
  return apiSend('/api/git/compare', 'POST', { from, to })
}

export function gitBackup(): Promise<GitAck> {
  return apiSend('/api/git/backup', 'POST')
}

// ---------------------------------------------------------------------------
// AI 一键修复（POST /api/git/ai/fix/*）
// ---------------------------------------------------------------------------

/** AI 修复建议中的单条问题；patch 为该文件的 unified diff 文本，模型未给出时为 null。 */
export interface ReviewIssue {
  path: string
  severity: string
  summary: string
  patch: string | null
  /** 问题所在行号（后端可能省略）。 */
  line?: number | null
}

/** suggest 端点应答。 */
export interface AiFixSuggestResult {
  issues: ReviewIssue[]
}

/** apply 端点应答；commit_hash 仅在提交修复时返回。 */
export interface AiFixApplyResult {
  ok: boolean
  snapshot_id: string
  commit_hash?: string
}

export interface AiFixApplyPayload {
  patch: string
  path?: string
  commit?: boolean
  message?: string
}

/** 分析当前改动（path 省略时）或指定文件，返回结构化问题清单。 */
export function gitAiFixSuggest(path?: string): Promise<AiFixSuggestResult> {
  return apiSend('/api/git/ai/fix/suggest', 'POST', path ? { path } : undefined)
}

/** 应用单条修复 patch；应用前自动创建快照，返回快照 id 以便回滚。 */
export function gitAiFixApply(payload: AiFixApplyPayload): Promise<AiFixApplyResult> {
  return apiSend('/api/git/ai/fix/apply', 'POST', payload)
}

// ---------------------------------------------------------------------------
// 远程 PR 集成（POST /api/git/pr/*）
// ---------------------------------------------------------------------------

export interface PrDescribePayload {
  /** 基础分支（合并目标），如 main。 */
  base: string
  /** 目标分支（来源分支）；省略时后端取当前分支。 */
  head?: string
}

export interface PrDescribeResult {
  /** 中文 PR 描述文本（含标题与正文 Markdown）。 */
  text: string
}

export interface PrCreatePayload {
  base: string
  head?: string
  /** 跨仓库（fork→上游）PR 时填写 fork 仓库所有者（如 `myname` 或 `myname/coomi`）；留空=自动取当前 remote 的 owner。 */
  headRepo?: string
  title?: string
  body?: string
  /** head（fork）仓库来源的远端名称；省略时后端取 origin。 */
  remote?: string
  /** 合并目标（base 所在）仓库：远端名（如 upstream）或完整 URL；省略时后端优先取名为 upstream 的远端，再回退 origin。 */
  upstream?: string
  /** 访问令牌；省略时后端使用已保存的令牌。 */
  token?: string
}

export interface PrCreateResult {
  url: string
  number: number
}

/** 生成中文 PR 描述（标题 + 正文 Markdown）。 */
export function gitPrDescribe(payload: PrDescribePayload): Promise<PrDescribeResult> {
  return apiSend('/api/git/pr/describe', 'POST', payload)
}

/** 创建 PR；返回 PR 链接与编号（后端未配置令牌且未传入 token 时返回 404 错误）。 */
export function gitPrCreate(payload: PrCreatePayload): Promise<PrCreateResult> {
  return apiSend('/api/git/pr/create', 'POST', payload)
}

// ---------------------------------------------------------------------------
// AI 深度分析（POST /api/git/ai/compare | adversarial-review | root-cause）
// ---------------------------------------------------------------------------

/**
 * A/B 实验对比：对比两个分支的差异并生成中文分析报告。
 * body {branch_a, branch_b} → {text}。
 */
export function gitAiCompare(payload: { branch_a: string; branch_b: string }): Promise<{ text: string }> {
  return apiSend('/api/git/ai/compare', 'POST', payload)
}

/**
 * 对抗式评审：以对抗视角评审当前改动（path 省略时）或指定文件，返回中文评审文本。
 * body {path?} → {text}。
 */
export function gitAiAdversarialReview(path?: string): Promise<{ text: string }> {
  return apiSend('/api/git/ai/adversarial-review', 'POST', path ? { path } : undefined)
}

/**
 * 变更根因分析：分析某次提交（commit 省略时取当前 HEAD）的根因，返回中文分析文本。
 * body {commit?} → {text}。
 */
export function gitAiRootCause(commit?: string): Promise<{ text: string }> {
  return apiSend('/api/git/ai/root-cause', 'POST', commit ? { commit } : undefined)
}

// ---------------------------------------------------------------------------
// Git AI 独立模型配置（GET/POST /api/git/ai/config | POST .../config/test）
// ---------------------------------------------------------------------------

/**
 * Git 面板 AI 助手的独立模型配置（不依赖全局 Provider）。
 * 启用且配置完整时，后端优先使用本配置调用模型。
 */
export interface GitAiConfig {
  /** 是否启用独立配置。 */
  enabled: boolean
  /** 协议：openai_compatible（默认）/ anthropic / gemini / deepseek_account。 */
  kind: string
  /** API 入口地址，如 https://api.deepseek.com/v1。 */
  base_url: string
  /** API Key（deepseek_account 时为账号登录令牌）。 */
  api_key: string
  /** 模型名，如 deepseek-chat。 */
  model: string
}

/** 读取 Git AI 独立配置。 */
export function gitAiConfigGet(): Promise<GitAiConfig> {
  return apiGet('/api/git/ai/config')
}

/** 保存 Git AI 独立配置（保存后立即生效）。 */
export function gitAiConfigSave(config: GitAiConfig): Promise<GitAiConfig> {
  return apiSend('/api/git/ai/config', 'POST', config)
}

/** 连通性测试：用给定配置向模型发一次请求，{ok} 或 {ok:false, error}。 */
export function gitAiConfigTest(config: GitAiConfig): Promise<{ ok: boolean; error?: string }> {
  return apiSend('/api/git/ai/config/test', 'POST', config)
}
