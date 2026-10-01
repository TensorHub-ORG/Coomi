/** 远程 MCP 源：官方注册表 / npm / GitHub Topic / Smithery / PulseMCP / 自定义 JSON。
 *
 *  这个模块只做「取数 + 归一化」，不含任何 JSX，也不碰引擎接口 —— 技能市场据此做
 *  来源切换浏览与搜索。
 *
 *  安装有三条路，都在这里定好「走哪条」所需的数据：
 *      · 命中内置目录 id 的条目 → 走引擎的内置安装接口（POST /api/catalog/mcp/install）；
 *      · 能推断出启动命令/地址的条目 → 走 POST /api/catalog/mcp/install-remote，一次装完
 *        （见 remoteInstallPlan：官方注册表的 packages/remotes、npm 包名、Smithery 的
 *        deploymentUrl 都已在下面的解析器里折算成了 command/args/url）；
 *      · 推不出来、或清单要求填环境变量的条目 → 弹预填表单让用户补齐后再装，
 *        同时保留「生成配置片段」这条手动路（mcpConfigFragment）。
 *    远端字段命名各家都不一样，所以每个源一个解析器，全部走容错读取（缺字段就留空，
 *    绝不猜、也不造假数据）。 */

import { fetchRemoteText } from '../../lib/remoteFetch'

export type RemoteSourceKey = 'official' | 'npm' | 'github' | 'smithery' | 'pulsemcp' | 'custom'

export interface RemoteSourceDef {
  key: RemoteSourceKey
  /** 左侧来源列表里的名字。 */
  label: string
  /** 一行说明：数据来自哪里、有什么值得注意的。 */
  hint: string
  /** 需要用户填清单地址（自定义源）。 */
  needsUrl?: boolean
  /** 需要用户填 API Key（可选，填了会带上）。 */
  needsKey?: boolean
}

export const REMOTE_SOURCES: RemoteSourceDef[] = [
  {
    key: 'official',
    label: '官方 MCP 注册表',
    hint: 'registry.modelcontextprotocol.io：官方收录的服务器，带包信息与启动命令',
  },
  {
    key: 'npm',
    label: 'npm 搜索',
    hint: 'registry.npmjs.org：按关键词搜 npm 上发布的 MCP 包，可直接用 npx 拉起',
  },
  {
    key: 'github',
    label: 'GitHub Topic',
    hint: 'topic:mcp-server 的仓库，按 star 排序（未登录有频率限制）',
  },
  {
    key: 'smithery',
    label: 'Smithery',
    hint: 'registry.smithery.ai：托管与本地服务器目录，可填 API Key 提高配额',
  },
  {
    key: 'pulsemcp',
    label: 'PulseMCP',
    hint: 'api.pulsemcp.com：社区收录目录，字段较松，缺失信息会留空',
  },
  {
    key: 'custom',
    label: '自定义源',
    hint: '填一个返回 JSON 清单的地址：数组，或 { entries: [...] } / { servers: [...] }',
    needsUrl: true,
  },
]

export function remoteSourceDef(key: RemoteSourceKey): RemoteSourceDef {
  return REMOTE_SOURCES.find((s) => s.key === key) ?? REMOTE_SOURCES[0]
}

/** 归一化后的远程条目：一张卡能用到的全部字段。 */
export interface RemoteEntry {
  /** React key / 去重用的全局唯一标识。 */
  key: string
  /** 原始标识（npm 包名 / owner/repo / server name），用于匹配内置目录。 */
  id: string
  name: string
  description: string
  version: string
  author: string
  homepage: string
  repository: string
  /** stdio | http | sse；空串表示不清楚。 */
  transport: string
  /** 能推导出的启动命令，推不出来就留空（不编造）。 */
  command: string
  args: string[]
  /** 这条命令是从清单的哪个字段推出来的（一键安装时告诉用户依据，推不出来则留空）。 */
  launchBasis: string
  /** 必填环境变量名（仅官方注册表给了这个信息）。 */
  envKeys: string[]
  /** http/sse 的地址。 */
  url: string
  /** 热度：有的源给下载量，有的给 star，取到哪个算哪个。 */
  stars: number | null
  downloads: number | null
  source: RemoteSourceKey
}

export interface RemoteFetchOptions {
  key: RemoteSourceKey
  query: string
  /** 自定义源地址。 */
  url?: string
  /** Smithery 等源的 API Key（可选）。 */
  apiKey?: string
  /** 每页条数（首屏与「加载更多」共用）。 */
  limit?: number
  /** 上一页返回的续页游标：各源含义不同（官方 cursor / npm from 偏移 / GitHub page / Smithery page / PulseMCP page / 自定义源的下一页地址）。 */
  cursor?: string | null
}

export interface RemoteFetchResult {
  entries: RemoteEntry[]
  /** 实际请求的地址，展示与排查用。 */
  url: string
  /** 解析过程中值得告诉用户的一句话（例如跳过了几条没有标识的条目）。 */
  note: string
  /** 取下一页要原样带回来的游标；null = 没有下一页了。 */
  nextCursor: string | null
  /** 还有没有下一页（各源按自己的 total / totalPages / nextCursor 判断）。 */
  hasMore: boolean
  /** 源自己回报的总条数：npm / GitHub / Smithery / PulseMCP 有，官方注册表与自定义源拿不到时为 null。 */
  total: number | null
}

/* ── 容错读取：远端 JSON 的字段名各家都不一样，缺什么就留空 ── */

type Json = Record<string, unknown>

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function num(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return null
}

/** 从嵌套对象里取第一个非空值：dig(object, ['attributes', 'github_stars'], 'stars')。 */
function dig(source: Json, ...paths: Array<string | string[]>): unknown {
  for (const path of paths) {
    const keys = Array.isArray(path) ? path : [path]
    let cursor: unknown = source
    for (const key of keys) {
      cursor = obj(cursor)[key]
    }
    if (cursor !== undefined && cursor !== null && cursor !== '') return cursor
  }
  return undefined
}

/* ── 各源解析 ── */

/** 官方注册表的 package → 启动命令：只按 registryType 推导，推不出就留空。 */
function launchFromPackage(pkg: Json): { command: string; args: string[] } {
  const type = str(pkg.registryType).toLowerCase()
  const identifier = str(pkg.identifier, pkg.name)
  if (!identifier) return { command: '', args: [] }
  const runtimeArgs = list(pkg.runtimeArguments)
    .map((arg) => str(obj(arg).value))
    .filter(Boolean)
  const hint = str(pkg.runtimeHint)
  if (type === 'npm') return { command: hint || 'npx', args: [...runtimeArgs, identifier] }
  if (type === 'pypi') return { command: hint || 'uvx', args: [...runtimeArgs, identifier] }
  if (type === 'oci') return { command: hint || 'docker', args: ['run', '-i', '--rm', ...runtimeArgs, identifier] }
  // 其它 registryType（nuget / mcpb / …）没有通用拉起方式：只保留 hint，不猜参数。
  return { command: hint, args: runtimeArgs }
}

/** 官方注册表同一台服务器会按版本各返回一条：标了 isLatest 的排前面，去重时优先留下它。 */
function isLatestRecord(row: unknown): boolean {
  const meta = obj(obj(row)._meta)['io.modelcontextprotocol.registry/official']
  return obj(meta).isLatest === true
}

function parseOfficial(payload: unknown): { entries: RemoteEntry[]; note: string } {
  const rows = [...list(obj(payload).servers)].sort((a, b) => Number(isLatestRecord(b)) - Number(isLatestRecord(a)))
  let skipped = 0
  const entries: RemoteEntry[] = []
  for (const row of rows) {
    // v0 的每条记录是 { server: {...}, _meta: {...} }；直接是 server 对象时也接受。
    const holder = obj(row)
    const server = holder.server === undefined ? holder : obj(holder.server)
    const id = str(server.name)
    if (!id) { skipped += 1; continue }
    const packages = list(server.packages)
    const remotes = list(server.remotes)
    const firstPackage = obj(packages[0])
    const firstRemote = obj(remotes[0])
    const launch = launchFromPackage(firstPackage)
    const remoteType = str(firstRemote.type)
    const envKeys = list(firstPackage.environmentVariables)
      .map((item) => obj(item))
      .filter((item) => item.isRequired === true)
      .map((item) => str(item.name))
      .filter(Boolean)
    entries.push({
      key: 'official:' + id,
      id,
      // 官方名字形如 com.pulsemcp/remote-filesystem：卡片上只显示最后一段。
      name: id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id,
      description: str(server.description, server.title),
      version: str(server.version),
      author: str(obj(server.repository).source),
      homepage: str(server.websiteUrl, obj(server.repository).url),
      repository: str(obj(server.repository).url),
      transport: launch.command ? 'stdio' : remoteType === 'sse' ? 'sse' : remoteType ? 'http' : '',
      command: launch.command,
      args: launch.args,
      launchBasis: launch.command
        ? '官方注册表 packages[].registryType 推出来的启动命令'
        : str(firstRemote.url)
          ? '官方注册表 remotes[]（' + (remoteType || 'http') + '）'
          : '',
      envKeys,
      url: str(firstRemote.url),
      stars: null,
      downloads: null,
      source: 'official',
    })
  }
  return { entries, note: skipped ? '跳过 ' + skipped + ' 条没有名称的记录' : '' }
}

function parseNpm(payload: unknown): { entries: RemoteEntry[]; note: string } {
  const rows = list(obj(payload).objects)
  let skipped = 0
  const entries: RemoteEntry[] = []
  for (const row of rows) {
    const pkg = obj(obj(row).package)
    const id = str(pkg.name)
    if (!id) { skipped += 1; continue }
    const links = obj(pkg.links)
    entries.push({
      key: 'npm:' + id,
      id,
      name: id,
      description: str(pkg.description),
      version: str(pkg.version),
      author: str(obj(pkg.publisher).username),
      homepage: str(links.homepage, links.npm),
      repository: str(links.repository),
      transport: 'stdio',
      // npm 上的 MCP 包统一按 npx 拉起：这是 npm 生态的通用做法。
      command: 'npx',
      args: ['-y', id],
      launchBasis: 'npm 包名：按 npx -y <包名> 拉起',
      envKeys: [],
      url: '',
      stars: null,
      downloads: num(dig(obj(row), ['downloads', 'monthly']), dig(obj(row), ['downloads', 'weekly'])),
      source: 'npm',
    })
  }
  return { entries, note: skipped ? '跳过 ' + skipped + ' 条没有包名的记录' : '' }
}

function parseGithub(payload: unknown): { entries: RemoteEntry[]; note: string } {
  const rows = list(obj(payload).items)
  let skipped = 0
  const entries: RemoteEntry[] = []
  for (const row of rows) {
    const repo = obj(row)
    const full = str(repo.full_name, repo.name)
    if (!full) { skipped += 1; continue }
    entries.push({
      key: 'github:' + full,
      id: full,
      name: full,
      description: str(repo.description),
      version: str(repo.default_branch),
      author: str(obj(repo.owner).login),
      homepage: str(repo.homepage, repo.html_url),
      repository: str(repo.html_url),
      // 仓库形态的条目推不出启动命令：留给用户在预填表单里补。
      transport: '',
      command: '',
      args: [],
      launchBasis: '',
      envKeys: [],
      url: '',
      stars: num(repo.stargazers_count),
      downloads: null,
      source: 'github',
    })
  }
  return { entries, note: skipped ? '跳过 ' + skipped + ' 条没有仓库名的记录' : '' }
}

function parseSmithery(payload: unknown): { entries: RemoteEntry[]; note: string } {
  const rows = list(obj(payload).servers)
  let skipped = 0
  const entries: RemoteEntry[] = []
  for (const row of rows) {
    const server = obj(row)
    // qualifiedName 是 Smithery CLI 认的名字（namespace/slug），优先用它。
    const id = str(server.qualifiedName, server.displayName, server.id)
    if (!id) { skipped += 1; continue }
    entries.push({
      key: 'smithery:' + id,
      id,
      name: str(server.displayName, id),
      description: str(server.description),
      version: str(server.version),
      author: str(server.owner, server.namespace),
      homepage: str(server.homepage, server.documentationUrl),
      // 搜索结果里没有部署地址：退回 Smithery 的服务器页，用户点进去能看到完整用法。
      repository: str(server.repository) || (str(server.qualifiedName) ? 'https://smithery.ai/server/' + str(server.qualifiedName) : ''),
      // 托管型（remote）走 URL，本地型用 Smithery CLI 拉起。
      transport: server.remote === true ? 'http' : 'stdio',
      command: server.remote === true ? '' : 'npx',
      args: server.remote === true ? [] : ['-y', '@smithery/cli@latest', 'run', id],
      launchBasis: server.remote === true
        ? 'Smithery 托管服务器：deploymentUrl 直接连'
        : 'Smithery CLI：npx -y @smithery/cli run ' + id,
      envKeys: [],
      url: str(server.deploymentUrl, server.url, server.endpoint),
      stars: null,
      downloads: num(server.useCount, server.toolsCount),
      source: 'smithery',
    })
  }
  return { entries, note: skipped ? '跳过 ' + skipped + ' 条没有标识的记录' : '' }
}

function parsePulseMcp(payload: unknown): { entries: RemoteEntry[]; note: string } {
  const root = obj(payload)
  // PulseMCP 的返回结构换过几版：servers / data / items 都接。
  const rows = list(root.servers).length ? list(root.servers) : list(root.data).length ? list(root.data) : list(root.items)
  let skipped = 0
  const entries: RemoteEntry[] = []
  for (const row of rows) {
    const server = obj(row)
    const id = str(server.name, server.slug, server.title, server.display_name)
    if (!id) { skipped += 1; continue }
    const attributes = obj(server.attributes)
    const links = obj(server.links)
    entries.push({
      key: 'pulsemcp:' + id,
      id,
      name: str(server.title, server.display_name, server.name),
      description: str(server.short_description, server.description, server.tagline, attributes.short_description),
      version: str(server.version),
      author: str(server.author, attributes.github_owner),
      homepage: str(server.url, server.homepage, links.homepage, attributes.github_url),
      repository: str(links.repository, attributes.github_url, server.source_url),
      transport: '',
      command: '',
      args: [],
      launchBasis: '',
      envKeys: [],
      url: '',
      stars: num(attributes.github_stars, server.github_stars, server.stars),
      downloads: null,
      source: 'pulsemcp',
    })
  }
  return { entries, note: skipped ? '跳过 ' + skipped + ' 条没有名字的记录' : '' }
}

/** 自定义清单：数组、{entries} 或 {servers} 都接受；条目里有 command/url 就照抄。 */
function parseCustom(payload: unknown): { entries: RemoteEntry[]; note: string } {
  const root = obj(payload)
  const rows = Array.isArray(payload)
    ? payload
    : list(root.entries).length
      ? list(root.entries)
      : list(root.servers).length
        ? list(root.servers)
        : list(root.items)
  let skipped = 0
  const entries: RemoteEntry[] = []
  for (const row of rows) {
    const entry = obj(row)
    // 兼容官方注册表那种 { server: {...} } 包装。
    const item = entry.server === undefined ? entry : obj(entry.server)
    const id = str(item.id, item.name, item.identifier)
    if (!id) { skipped += 1; continue }
    const transport = str(item.transport, item.type).toLowerCase()
    const rawArgs = list(item.args).length ? list(item.args) : list(item.runtimeArguments)
    const args = rawArgs.map((arg) => str(typeof arg === 'object' ? obj(arg).value : arg)).filter(Boolean)
    const env = item.env ?? item.environmentVariables
    const envKeys = Array.isArray(env)
      ? list(env).map((v) => str(obj(v).name, v)).filter(Boolean)
      : Object.keys(obj(env))
    entries.push({
      key: 'custom:' + id,
      id,
      name: str(item.name, item.title, id),
      description: str(item.description, item.summary),
      version: str(item.version),
      author: str(item.author, item.publisher, item.owner),
      homepage: str(item.homepage, item.website, item.url),
      repository: str(item.repository, obj(item.repository).url),
      transport,
      command: str(item.command),
      args,
      launchBasis: str(item.command)
        ? '清单里的 command 字段'
        : str(item.url, item.endpoint, item.remote_url)
          ? '清单里的地址字段（' + (transport || 'http') + '）'
          : '',
      envKeys,
      url: str(item.url, item.endpoint, item.remote_url),
      stars: num(item.stars, item.stargazers_count),
      downloads: num(item.downloads, item.use_count),
      source: 'custom',
    })
  }
  return { entries, note: skipped ? '跳过 ' + skipped + ' 条没有 id 的条目' : '' }
}

/** 按 id（忽略大小写）去重，保留先出现的那条。 */
function dedupe(entries: RemoteEntry[]): RemoteEntry[] {
  const seen = new Set<string>()
  const out: RemoteEntry[] = []
  for (const entry of entries) {
    const key = entry.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/* ── 取数 ── */

/** 一页多少条：首屏与「加载更多」共用，界面上的「已加载 N 条」就是按它一页页垒起来的。 */
const PAGE_SIZE = 24
const TIMEOUT_MS = 15_000
/** npm / GitHub 的搜索接口都只开放前 1000 条：到顶就老实说「没有更多」，别让用户一直点。 */
const NPM_MAX_RESULTS = 1000
const GITHUB_MAX_RESULTS = 1000

/** 这一页之后还有没有下一页：各源给的字段完全不一样（nextCursor / total / totalPages）。 */
interface PageProbe {
  /** 取下一页要原样带回的游标；null = 没有下一页。 */
  cursor: string | null
  hasMore: boolean
  total: number | null
}

/** npm 的 from 是偏移量：游标里放的就是「下一页从第几条开始」。 */
function offsetOf(cursor: string | null | undefined): number {
  const value = Number.parseInt((cursor ?? '').trim(), 10)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** GitHub / Smithery / PulseMCP 的游标是页码（1 起算）。 */
function pageOf(cursor: string | null | undefined): number {
  const value = Number.parseInt((cursor ?? '').trim(), 10)
  return Number.isFinite(value) && value > 0 ? value : 1
}

/** 把清单给的「下一页地址」解成绝对地址：解不出来就当作没有下一页，绝不拼一个假的。 */
function resolveNext(base: string, next: string): string {
  try {
    return new URL(next, base).toString()
  } catch {
    return ''
  }
}

function httpHint(status: number): string {
  if (status === 403) return 'HTTP 403：该源拒绝了请求（可能触发频率限制，稍后再试或换一个源）'
  if (status === 404) return 'HTTP 404：清单地址不存在'
  if (status === 410) return 'HTTP 410：这个接口已经下线（PulseMCP 的 v0beta 已停用），换一个来源或改用「自定义源」填可直连的清单地址'
  if (status === 429) return 'HTTP 429：请求过于频繁，稍后再试'
  if (status >= 500) return 'HTTP ' + status + '：源端出错'
  return 'HTTP ' + status
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  // 改由**壳**代取（见 lib/remoteFetch.ts）：渲染进程直接 fetch 会受 CSP / CORS /
  // WebView 网络策略三重限制，而壳走 curl 都不受影响。
  void headers
  const reply = await fetchRemoteText(url, TIMEOUT_MS)
  if (!reply.ok) throw new Error(httpHint(reply.status))
  try {
    return JSON.parse(reply.body) as unknown
  } catch {
    // 以前这里会抛 JSON 解析的原始错误，用户只看到一句看不懂的英文。
    throw new Error('该源返回的不是合法 JSON（HTTP ' + reply.status + '）')
  }
}

/**
 * 按来源拉**一页**清单，并把「下一页怎么取」一并回报。
 *
 * 每个源的分页参数都不一样，这里逐个适配（不传 cursor 就是第一页）：
 *   · 官方注册表：?limit=&search=&cursor=   ← 续页游标来自 metadata.nextCursor
 *   · npm 搜索：  ?text=&size=&from=        ← from 是偏移量（上一页条数累加）
 *   · GitHub：    ?q=&per_page=&page=       ← 页码，官方硬上限 1000 条
 *   · Smithery：  ?pageSize=&page=&q=       ← 页码，总数看 pagination.totalPages
 *   · PulseMCP：  ?count_per_page=&page=    ← 页码（该源的 v0beta 接口已下线，取不到就报错）
 *   · 自定义源：  清单自己给 next / nextCursor 这类续页地址时才续得下去，否则只有一页。
 *
 * 任何失败都抛可读中文错误，由界面渲染成「错误态」。
 */
export async function fetchRemoteEntries(options: RemoteFetchOptions): Promise<RemoteFetchResult> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? PAGE_SIZE) || PAGE_SIZE, 250))
  const query = (options.query ?? '').trim()
  const cursor = (options.cursor ?? '').trim()
  let url = ''
  let headers: Record<string, string> | undefined
  let parse: (payload: unknown) => { entries: RemoteEntry[]; note: string }
  let probe: (payload: unknown) => PageProbe

  switch (options.key) {
    case 'official': {
      const params = new URLSearchParams({ limit: String(limit) })
      if (query) params.set('search', query)
      if (cursor) params.set('cursor', cursor)
      url = 'https://registry.modelcontextprotocol.io/v0/servers?' + params.toString()
      parse = parseOfficial
      // 官方注册表按游标翻页：metadata.nextCursor 就是下一页的入场券（没有它 = 到底了）。
      probe = (payload) => {
        const meta = obj(obj(payload).metadata)
        const next = str(meta.nextCursor)
        return { cursor: next || null, hasMore: !!next && (num(meta.count) ?? 0) > 0, total: null }
      }
      break
    }
    case 'npm': {
      // 没输关键词时给一个默认查询：MCP 相关的包。
      const from = offsetOf(cursor)
      const text = query || 'keywords:mcp'
      const params = new URLSearchParams({ text, size: String(limit), from: String(from) })
      url = 'https://registry.npmjs.org/-/v1/search?' + params.toString()
      parse = parseNpm
      // npm 回报 total：到底了没有看「已取到的偏移 + 本页条数」有没有追上它。
      probe = (payload) => {
        const root = obj(payload)
        const total = num(root.total)
        const got = list(root.objects).length
        const reach = from + got
        const ceiling = total === null ? null : Math.min(total, NPM_MAX_RESULTS)
        const more = got > 0 && (ceiling === null ? got >= limit : reach < ceiling)
        return { cursor: more ? String(reach) : null, hasMore: more, total }
      }
      break
    }
    case 'github': {
      const page = pageOf(cursor)
      const q = query ? query + ' topic:mcp-server' : 'topic:mcp-server'
      const params = new URLSearchParams({ q, per_page: String(limit), page: String(page), sort: 'stars', order: 'desc' })
      url = 'https://api.github.com/search/repositories?' + params.toString()
      parse = parseGithub
      // GitHub 搜索按页码翻页，总数见 total_count；官方对搜索结果封顶 1000 条。
      probe = (payload) => {
        const root = obj(payload)
        const total = num(root.total_count)
        const got = list(root.items).length
        const ceiling = total === null ? GITHUB_MAX_RESULTS : Math.min(total, GITHUB_MAX_RESULTS)
        const more = got > 0 && page * limit < ceiling
        return { cursor: more ? String(page + 1) : null, hasMore: more, total }
      }
      break
    }
    case 'smithery': {
      const page = pageOf(cursor)
      const params = new URLSearchParams({ pageSize: String(limit), page: String(page) })
      if (query) params.set('q', query)
      url = 'https://registry.smithery.ai/servers?' + params.toString()
      headers = options.apiKey?.trim() ? { Authorization: 'Bearer ' + options.apiKey.trim() } : undefined
      parse = parseSmithery
      // Smithery 把页码与总页数一起放在 pagination 里：以它为准，最稳。
      probe = (payload) => {
        const root = obj(payload)
        const pg = obj(root.pagination)
        const total = num(pg.totalCount)
        const totalPages = num(pg.totalPages)
        const current = num(pg.currentPage) ?? page
        const got = list(root.servers).length
        const more = got > 0 && (totalPages !== null ? current < totalPages : got >= limit)
        return { cursor: more ? String(current + 1) : null, hasMore: more, total }
      }
      break
    }
    case 'pulsemcp': {
      const page = pageOf(cursor)
      const params = new URLSearchParams({ count_per_page: String(limit), page: String(page) })
      if (query) params.set('query', query)
      url = 'https://api.pulsemcp.com/v0beta/servers?' + params.toString()
      parse = parsePulseMcp
      // 这个源的返回换过几版：分页元数据在哪儿都接，都读不到就按「本页装满 = 可能还有」处理。
      probe = (payload) => {
        const root = obj(payload)
        const pg = obj(root.pagination)
        const total = num(root.total_count, root.total, pg.total_count)
        const totalPages = num(root.total_pages, root.page_count, pg.total_pages)
        const current = num(root.page, root.current_page, pg.current_page) ?? page
        const rows = list(root.servers).length ? list(root.servers) : list(root.data).length ? list(root.data) : list(root.items)
        const more = rows.length > 0 && (totalPages !== null
          ? current < totalPages
          : total !== null
            ? current * limit < total
            : rows.length >= limit)
        return { cursor: more ? String(current + 1) : null, hasMore: more, total }
      }
      break
    }
    case 'custom': {
      const base = (options.url ?? '').trim()
      if (!base) throw new Error('请先填写自定义源的清单地址')
      if (!/^https?:\/\//i.test(base)) throw new Error('清单地址需要以 http:// 或 https:// 开头')
      // 自定义清单没有统一的分页参数：只有它自己给了下一页地址时才继续，绝不瞎拼 page/offset。
      const next = cursor ? resolveNext(base, cursor) : ''
      url = next || base
      parse = parseCustom
      probe = (payload) => {
        const root = Array.isArray(payload) ? {} : obj(payload)
        const raw = str(
          root.next, root.nextUrl, root.next_url, root.nextPage, root.next_page_url,
          root.nextCursor, root.next_cursor,
          dig(root, ['pagination', 'next']), dig(root, ['pagination', 'next_cursor']),
          dig(root, ['links', 'next']), dig(root, ['_links', 'next']),
        )
        const total = num(root.total, root.total_count, root.count, dig(root, ['pagination', 'total_count']))
        // 纯数字的 next 当作「还有下一页但不知道怎么取」，不猜参数：只把总数报出来。
        const follow = raw && !/^\d+$/.test(raw) ? resolveNext(url, raw) : ''
        return { cursor: follow || null, hasMore: !!follow, total }
      }
      break
    }
  }

  const payload = await fetchJson(url, headers)
  const parsed = parse(payload)
  // 同一个 id 只留一条：官方注册表按版本返回多条，其它源偶有重复条目。
  const entries = dedupe(parsed.entries)
  const dropped = parsed.entries.length - entries.length
  const info = probe(payload)
  const leftover = info.total !== null ? info.total - entries.length : 0
  const note = [
    parsed.note,
    dropped > 0 ? '已合并 ' + dropped + ' 条同 id 记录' : '',
    // 有总数、却续不下去：把原因说清楚，免得用户以为是界面把条目藏了。
    !info.hasMore && options.key === 'custom' && leftover > 0
      ? '清单里还有 ' + leftover + ' 条，但它没有给续页地址（自定义源只认 next / nextCursor 这类字段）'
      : '',
    !info.hasMore && options.key === 'npm' && info.total !== null && info.total > NPM_MAX_RESULTS
      ? '这个源共 ' + info.total + ' 条，npm 搜索只开放前 ' + NPM_MAX_RESULTS + ' 条'
      : '',
    !info.hasMore && options.key === 'github' && info.total !== null && info.total > GITHUB_MAX_RESULTS
      ? '这个源共 ' + info.total + ' 条，GitHub 搜索结果只开放前 ' + GITHUB_MAX_RESULTS + ' 条'
      : '',
  ].filter(Boolean).join('；')
  return { entries, url, note, nextCursor: info.cursor, hasMore: info.hasMore, total: info.total }
}

/* ── 一键安装：从远程条目推断「装什么」 ── */

/** 一键安装的落点：引擎 POST /api/catalog/mcp/install-remote 的入参。 */
export interface RemoteInstallPlan {
  transport: 'stdio' | 'http' | 'sse'
  command: string
  args: string[]
  url: string
  /** 清单声明的必填环境变量（没填值之前不能装）。 */
  envKeys: string[]
  /** 推断依据：卡片/表单上要告诉用户这条命令是从哪来的。 */
  basis: string
  /** 能不能不看表单直接装：有命令或地址，且没有待填的环境变量。 */
  direct: boolean
  /** 推不出启动方式时要用户在预填表单里补齐。 */
  needsForm: boolean
}

/** 配置文件里的键名：清单 id 常带 `/`（owner/repo、官方注册表的命名空间），直接当键不友好。 */
export function remoteServerName(entry: RemoteEntry): string {
  const base = (entry.name || entry.id).trim() || 'mcp-server'
  const cleaned = base
    .replace(/^@/, '')
    .replace(/[\\/\s]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 60) || 'mcp-server'
}

/**
 * 远程条目 → 一键安装计划。
 *
 * 优先用清单里已经归一化好的字段（各种源的解析器已经把 packages/remotes、npm 包名、
 * Smithery 的 deploymentUrl 折算成了 command/args/url），这里只做「够不够直接装」的判断：
 * 有命令（stdio）或地址（http/sse）且没有待填的环境变量 → 直接装；否则弹预填表单。
 */
export function remoteInstallPlan(entry: RemoteEntry): RemoteInstallPlan {
  const url = entry.url.trim()
  const command = entry.command.trim()
  const transport: RemoteInstallPlan['transport'] = entry.transport === 'http' || entry.transport === 'sse'
    ? entry.transport
    : command
      ? 'stdio'
      : url
        ? 'http'
        : 'stdio'
  const usable = transport === 'stdio' ? !!command : !!url
  const envKeys = entry.envKeys.filter(Boolean)
  return {
    transport,
    command: transport === 'stdio' ? command : '',
    args: transport === 'stdio' ? entry.args : [],
    url: transport === 'stdio' ? '' : url,
    envKeys,
    basis: entry.launchBasis || (usable ? '清单里给出的启动方式' : ''),
    direct: usable && envKeys.length === 0,
    needsForm: !usable || envKeys.length > 0,
  }
}

/** 远程条目 → config/mcp_servers.json 里的一段（供「自定义安装」复制）。 */
export function mcpConfigFragment(entry: {
  id: string
  transport: string
  command: string
  args: string[]
  env?: Record<string, string>
  url?: string
}): string {
  const transport = entry.transport || (entry.url ? 'http' : 'stdio')
  const record: Record<string, unknown> = { transport, enabled: true }
  if (transport === 'stdio') {
    record.command = entry.command
    record.args = entry.args
    record.env = entry.env ?? {}
  } else {
    record.url = entry.url ?? ''
  }
  return JSON.stringify({ [entry.id]: record }, null, 2)
}

/** 把参数行（一行一个，或空格分隔）拆成数组；带引号的片段保持完整。 */
export function splitArgs(text: string): string[] {
  return (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((part) => part.replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}
