/** 第三方 SKILL 市场的数据源：官方清单（内置固定 URL）+ 自定义清单地址。
 *
 *  与远程 MCP 的 remoteSources.ts 同一套「取数 + 归一化」分工：本模块只做拉取、
 *  容错解析与按 id 去重，不含 JSX、不碰引擎接口；浏览/分页/卡片由
 *  SkillMarketBrowser.tsx 复用远程 MCP 的架构（分页游标 + mergeEntries 去重）。
 *
 *  清单 schema（与引擎 /api/catalog/skills/install-remote 的 {source,url} 一致）：
 *    { "skills": [ { "id","name","description","repository","platforms","requires" } ] }
 *  也接受 { entries: [...] }、裸数组与单条目对象；缺字段留空，绝不造假数据。
 *  官方清单 = TensorHub coomi-registry 的 registry.json（与引擎 REGISTRY_URLS 同源）。 */

import { fetchRemoteText } from '../../lib/remoteFetch'

export type SkillSourceKey = 'official' | 'custom'

export interface SkillSourceDef {
  key: SkillSourceKey
  label: string
  hint: string
  /** 需要用户填清单地址（自定义源）。 */
  needsUrl?: boolean
}

/** 官方清单的内置固定地址（引擎 REGISTRY_URLS 同一份 registry.json）。 */
export const OFFICIAL_SKILL_MANIFEST_URLS: string[] = [
  'https://raw.githubusercontent.com/TensorHub-ORG/coomi-registry/main/registry.json',
  'https://cdn.jsdelivr.net/gh/TensorHub-ORG/coomi-registry@main/registry.json',
]
export const OFFICIAL_SKILL_MANIFEST_URL = OFFICIAL_SKILL_MANIFEST_URLS[0]

/** 自定义清单地址的 localStorage 键（任务约定 coomi.skillSourceUrl.v1）。 */
export const SKILL_SOURCE_URL_KEY = 'coomi.skillSourceUrl.v1'

export const SKILL_SOURCES: SkillSourceDef[] = [
  {
    key: 'official',
    label: '官方技能清单',
    hint: 'TensorHub coomi-registry：官方收录的技能目录，含平台与运行时声明',
  },
  {
    key: 'custom',
    label: '自定义清单',
    hint: '填一个返回 { "skills": [...] } 的 JSON 地址；条目可带 platforms / requires',
    needsUrl: true,
  },
]

export function skillSourceDef(key: SkillSourceKey): SkillSourceDef {
  return SKILL_SOURCES.find((item) => item.key === key) ?? SKILL_SOURCES[0]
}

/** 清单条目（引擎同款字段，前端按 id 匹配内置目录/已装列表）。 */
export interface SkillSourceEntry {
  /** React key / 去重用（source + id）。 */
  key: string
  id: string
  name: string
  description: string
  repository: string
  /** 支持的操作系统标识（windows/macos/linux/android）；缺省 = 全平台。 */
  platforms: string[]
  /** 需要的可执行文件（npx/uvx/docker…）。 */
  requires: string[]
  /** 仓库下载用的 ref / subdir（缺省 main / 空）。 */
  ref: string
  subdir: string
  source: SkillSourceKey
}

export interface SkillFetchOptions {
  key: SkillSourceKey
  /** 自定义源地址（官方源忽略）。 */
  url?: string
  /** 上一页返回的续页游标（自定义源给了 next 才续；缺省整清单一页拉完）。 */
  cursor?: string | null
}

export interface SkillFetchResult {
  entries: SkillSourceEntry[]
  /** 实际请求的地址（展示与排查用）。 */
  url: string
  note: string
  /** 取下一页要原样带回的游标；null = 没有下一页。 */
  nextCursor: string | null
  hasMore: boolean
  total: number | null
}

/* ── 容错读取 ── */

type Json = Record<string, unknown>

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function str(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value.split(/[,s]+/).map((item) => item.trim()).filter(Boolean)
  }
  return []
}

/** 按 id（忽略大小写）去重，保留先出现的那条。 */
function dedupe(entries: SkillSourceEntry[]): SkillSourceEntry[] {
  const seen = new Set<string>()
  const out: SkillSourceEntry[] = []
  for (const entry of entries) {
    const key = entry.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

const FETCH_TIMEOUT_MS = 15_000

function httpHint(status: number): string {
  if (status === 403) return 'HTTP 403：该来源拒绝了请求（可能触发频率限制，稍后再试或换一个来源）'
  if (status === 404) return 'HTTP 404：清单地址不存在'
  if (status === 429) return 'HTTP 429：请求过于频繁，稍后再试'
  if (status >= 500) return 'HTTP ' + status + '：源端出错'
  return 'HTTP ' + status
}

async function fetchJson(url: string): Promise<unknown> {
  // 同 remoteSources：改由壳代取，绕开 CSP / CORS / WebView 网络策略。
  const reply = await fetchRemoteText(url, FETCH_TIMEOUT_MS)
  if (!reply.ok) throw new Error(httpHint(reply.status))
  try {
    return JSON.parse(reply.body) as unknown
  } catch {
    throw new Error('该来源返回的不是合法 JSON（HTTP ' + reply.status + '）')
  }
}

function normalizeEntries(rows: unknown[], source: SkillSourceKey): SkillSourceEntry[] {
  const entries: SkillSourceEntry[] = []
  for (const row of rows) {
    const item = obj(row)
    // 兼容 { server: {...} } 之类的包装。
    const entry = item.server === undefined ? item : obj(item.server)
    const id = str(entry.id, entry.identifier, entry.name)
    if (!id) continue
    entries.push({
      key: source + ':' + id,
      id,
      name: str(entry.name, entry.title, entry.id),
      description: str(entry.description, entry.summary, entry.overview),
      repository: typeof entry.repository === 'string' ? entry.repository : str(obj(entry.repository).url, obj(entry.repository).repo),
      platforms: strList(entry.platforms).length ? strList(entry.platforms) : [],
      requires: strList(entry.requires),
      ref: str(entry.ref, entry.branch, entry.default_branch) || 'main',
      subdir: str(entry.subdir, entry.path),
      source,
    })
  }
  return dedupe(entries)
}

/** 官方清单是 registry.json（skills 数组 + 元数据）；自定义源按 schema 宽容读取。 */
function parseManifest(payload: unknown, url: string, source: SkillSourceKey): { entries: SkillSourceEntry[]; note: string; nextCursor: string | null; total: number | null } {
  const root = obj(payload)
  // 官方 registry.json：skills 数组 / 自定义：entries 数组 / 裸数组 / 单条目对象。
  let rows: unknown[] = []
  let note = ''
  if (Array.isArray(payload)) rows = payload
  else rows = Array.isArray(root.skills) ? root.skills : Array.isArray(root.entries) ? root.entries : []
  if (!rows.length && !Array.isArray(payload)) {
    // 单条目对象（有 id）也当一条处理。
    const solo = root.id !== undefined || root.identifier !== undefined
    if (solo) rows = [payload]
  }
  if (!rows.length) note = source === 'official' ? '官方清单里没有 skills 数组（可能暂时为空）' : '清单里没有可识别的条目（需要 skills / entries 数组或单条目对象）'
  const entries = normalizeEntries(rows, source)
  if (entries.length < rows.length) note = (note ? note + '；' : '') + '已跳过 ' + (rows.length - entries.length) + ' 条缺 id 的记录'
  // 分页：清单自己给 next / nextCursor 这类续页地址时才续（与 MCP 自定义源同规则）。
  const rawNext = str(root.next, root.nextUrl, root.next_url, root.nextCursor, root.next_cursor)
  let nextCursor: string | null = null
  if (rawNext && !/^\d+$/.test(rawNext)) {
    try { nextCursor = new URL(rawNext, url).toString() } catch { nextCursor = null }
  }
  const total = (() => {
    if (typeof root.total === 'number') return root.total
    if (typeof root.total_count === 'number') return root.total_count
    return null
  })()
  return { entries, note, nextCursor, total }
}

/** 取一页清单。官方源在多个镜像间逐一尝试；自定义源只请求用户给的地址。 */
export async function fetchSkillManifest(options: SkillFetchOptions): Promise<SkillFetchResult> {
  if (options.key === 'official') {
    // 依次尝试官方镜像（raw → jsDelivr），哪个先通就用哪个。
    let lastError: unknown = null
    for (const mirror of OFFICIAL_SKILL_MANIFEST_URLS) {
      try {
        const payload = await fetchJson(mirror)
        const parsed = parseManifest(payload, mirror, 'official')
        return {
          entries: parsed.entries,
          url: mirror,
          note: parsed.note,
          nextCursor: parsed.nextCursor,
          hasMore: !!parsed.nextCursor,
          total: parsed.total,
        }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('官方清单全部镜像拉取失败')
  }
  const base = (options.url ?? '').trim()
  if (!base) throw new Error('请先填写自定义清单的地址')
  if (!/^https?:\/\//i.test(base)) throw new Error('清单地址需要以 http:// 或 https:// 开头')
  const next = options.cursor ? resolveNext(base, options.cursor) : ''
  const url = next || base
  const payload = await fetchJson(url)
  const parsed = parseManifest(payload, url, 'custom')
  return {
    entries: parsed.entries,
    url,
    note: parsed.note,
    nextCursor: parsed.nextCursor,
    hasMore: !!parsed.nextCursor,
    total: parsed.total,
  }
}

function resolveNext(base: string, next: string): string {
  try { return new URL(next, base).toString() } catch { return '' }
}

/* ── 平台适配（与引擎 catalogs::host_platform / platform_unavailable_reason 同口径） ── */

export function hostPlatform(): string {
  const ua = navigator.userAgent
  if (/android/i.test(ua)) return 'android'
  if (/windows/i.test(ua)) return 'windows'
  if (/macintosh|mac os/i.test(ua)) return 'macos'
  return 'linux'
}

export function platformLabel(platform: string): string {
  switch (platform.toLowerCase()) {
    case 'windows': return 'Windows'
    case 'macos': return 'macOS'
    case 'linux': return 'Linux'
    case 'android': return 'Android'
    default: return platform || '未知系统'
  }
}

/** 平台不适配时返回中文原因（None 表示当前平台受支持或未声明）。 */
export function platformUnavailableReason(platforms: string[]): string | null {
  if (!platforms.length) return null
  const host = hostPlatform()
  if (platforms.some((value) => value.toLowerCase() === host)) return null
  const names = platforms.map(platformLabel).join(' / ')
  return '该技能仅支持 ' + names + '，当前系统是 ' + platformLabel(host) + '，装上也无法使用'
}
