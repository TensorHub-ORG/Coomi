/** 运行环境（node / npx / uv / uvx / docker / kubectl / git / ffmpeg）的状态模型。
 *
 *  数据源是引擎的 GET /api/runtime/runtimes（found / version / path + 建议安装命令 + 官网）。
 *  这个接口还没上线时不能报错：store 会把 404 归为 'unsupported'，状态条显示
 *  「引擎暂不支持检测」，但「怎么装」照旧可用 —— 下面的兜底表里每个运行时都有一份
 *  Windows 一键命令（winget）与官网地址，装好后再点「重新检测」即可。
 *
 *  接口字段名还没最终定稿，所以这里全部走容错读取：数组 / 映射两种形状都收（引擎里
 *  已有的 runtime_availability_payload 回的就是 { npx: { available, label } } 这种映射），
 *  缺字段就留空 —— 绝不编造「已安装」。 */

export interface RuntimeStatus {
  /** 可执行文件名，作为 key（npx / uvx / docker …）。 */
  id: string
  /** 中文名，例如「Node.js（npx）」。 */
  label: string
  found: boolean
  version: string
  /** 引擎解析到的真实路径（Windows 上 npx 实际是 npx.cmd）。 */
  path: string
  /** 一键安装命令（Windows 上是 winget）；引擎没给时用兜底表。 */
  installCommand: string
  /** 官网 / 下载页。 */
  url: string
  /** 一句话说明它是干什么的。 */
  note: string
  /** 安装命令来自引擎还是本地兜底表（兜底命令可能随版本过期，界面上要说清楚）。 */
  fromEngine: boolean
}

export interface RuntimeHint {
  label: string
  /** Windows 一键命令（winget）；没有通用命令时留空。 */
  winget: string
  url: string
  note: string
  /** 装完之后的简要步骤。 */
  steps: string[]
}

/** 展示顺序：先 Node/uv 这两个「市场装不上时的头号原因」，再放其它。 */
export const RUNTIME_ORDER = ['node', 'npm', 'npx', 'uv', 'uvx', 'docker', 'kubectl', 'git', 'ffmpeg', 'python']

const WINDOWS_STEPS = [
  '按 Win 键搜索「PowerShell」并打开，粘贴上面的命令后回车（Windows 10/11 自带 winget）。',
  '提示找不到 winget：点官网链接下载安装包，安装时保持默认选项即可。',
  '装完请完全退出并重新打开 Coomi —— 新装的程序要重新读取 PATH 才会被检测到。',
  '回到技能中心点「重新检测」，条目从「本机不可用」变成可直接安装。',
]

/** 兜底安装指引：引擎接口不可用、或接口没给安装命令时用它。 */
const HINTS: Record<string, RuntimeHint> = {
  node: {
    label: 'Node.js',
    winget: 'winget install --id OpenJS.NodeJS.LTS -e',
    url: 'https://nodejs.org/zh-cn/download',
    note: 'JavaScript 运行时；npx / npm 随它一起安装。',
    steps: WINDOWS_STEPS,
  },
  npm: {
    label: 'Node.js（npm）',
    winget: 'winget install --id OpenJS.NodeJS.LTS -e',
    url: 'https://nodejs.org/zh-cn/download',
    note: 'npm 随 Node.js 一起安装，装 Node.js 就有。',
    steps: WINDOWS_STEPS,
  },
  npx: {
    label: 'Node.js（npx）',
    winget: 'winget install --id OpenJS.NodeJS.LTS -e',
    url: 'https://nodejs.org/zh-cn/download',
    note: 'npx 随 Node.js 一起安装；市场上大多数 MCP 服务器靠它拉起。',
    steps: WINDOWS_STEPS,
  },
  uv: {
    label: 'uv（含 uvx）',
    winget: 'winget install --id astral-sh.uv -e',
    url: 'https://docs.astral.sh/uv/getting-started/installation/',
    note: 'Astral 的 Python 包与工具管理器，uvx 是它附带的运行器。',
    steps: WINDOWS_STEPS,
  },
  uvx: {
    label: 'uv（uvx）',
    winget: 'winget install --id astral-sh.uv -e',
    url: 'https://docs.astral.sh/uv/getting-started/installation/',
    note: 'uvx 随 uv 一起安装；Python 类 MCP 服务器靠它拉起。',
    steps: WINDOWS_STEPS,
  },
  docker: {
    label: 'Docker CLI',
    winget: 'winget install --id Docker.DockerDesktop -e',
    url: 'https://www.docker.com/products/docker-desktop/',
    note: '容器运行时；装完要先启动 Docker Desktop，docker 命令才可用。',
    steps: WINDOWS_STEPS,
  },
  kubectl: {
    label: 'kubectl',
    winget: 'winget install --id Kubernetes.kubectl -e',
    url: 'https://kubernetes.io/zh-cn/docs/tasks/tools/',
    note: 'Kubernetes 命令行；还需要一份可用的 kubeconfig 才能连上集群。',
    steps: WINDOWS_STEPS,
  },
  git: {
    label: 'Git',
    winget: 'winget install --id Git.Git -e',
    url: 'https://git-scm.com/downloads',
    note: 'Git 命令行；技能仓库的拉取与更新也要用它。',
    steps: WINDOWS_STEPS,
  },
  ffmpeg: {
    label: 'FFmpeg',
    winget: 'winget install --id Gyan.FFmpeg -e',
    url: 'https://ffmpeg.org/download.html',
    note: '音视频处理命令行工具。',
    steps: WINDOWS_STEPS,
  },
  python: {
    label: 'Python',
    winget: 'winget install --id Python.Python.3.12 -e',
    url: 'https://www.python.org/downloads/windows/',
    note: 'Python 解释器；用 uvx 的话通常不需要单独装。',
    steps: WINDOWS_STEPS,
  },
}

export function runtimeHint(id: string): RuntimeHint {
  const key = id.trim().toLowerCase()
  const hit = HINTS[key]
  if (hit) return hit
  const name = key.split(/[\\/]/).pop() ?? key
  return {
    label: name || id,
    winget: '',
    url: '',
    note: '引擎没有给出这个运行时的安装方式，请按它的官方文档安装，然后回到这里重新检测。',
    steps: WINDOWS_STEPS,
  }
}

export function runtimeLabel(id: string): string {
  return runtimeHint(id).label || id
}

/** node / npm / npx 是一家，uv / uvx 是一家：装其中一个另一个就有了。 */
const FAMILIES: Record<string, string> = {
  node: 'node', npm: 'node', npx: 'node',
  uv: 'uv', uvx: 'uv',
}

export function runtimeFamily(id: string): string {
  const key = id.trim().toLowerCase()
  return FAMILIES[key] ?? key
}

function isSameFamily(left: string, right: string): boolean {
  return runtimeFamily(left) === runtimeFamily(right)
}

/* ── /api/runtime/runtimes 的容错归一化 ── */

type Json = Record<string, unknown>

function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function pickString(source: Json, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

const TRUE_WORDS = ['true', 'yes', '1', 'ok', 'found', 'available', 'installed', 'ready', 'present']
const FALSE_WORDS = ['false', 'no', '0', 'missing', 'unavailable', 'absent', 'not_found']

function pickBoolean(source: Json, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase()
      if (TRUE_WORDS.includes(text)) return true
      if (FALSE_WORDS.includes(text)) return false
    }
  }
  return null
}

const ID_KEYS = ['id', 'key', 'runtime', 'executable', 'command', 'tool', 'name']

/** 把任意形状的响应摊成 [{ id, raw }]：数组、映射、以及「根对象直接就是映射」三种都收。 */
function candidates(payload: unknown): Array<{ id: string; raw: Json }> {
  // 根就是数组：["npx", "uvx"] 或 [{ id, found }] 都按名字收下。
  if (Array.isArray(payload)) {
    return payload.map((item) => {
      const raw = typeof item === 'string' ? { id: item } : asRecord(item)
      return { id: pickString(raw, ID_KEYS), raw }
    })
  }
  const root = asRecord(payload)
  const listed = root.runtimes ?? root.tools ?? root.entries ?? root.items ?? root.data
  if (listed === undefined || listed === null) {
    // 根对象就是 { npx: {...}, git: {...} } 的映射（引擎已有的 runtime_availability_payload 形状）。
    const pairs = Object.entries(root).filter(([, value]) => Object.keys(asRecord(value)).length > 0)
    return pairs.map(([key, value]) => ({ id: key, raw: asRecord(value) }))
  }
  if (Array.isArray(listed)) {
    return listed.map((item) => ({ id: pickString(asRecord(item), ID_KEYS), raw: asRecord(item) }))
  }
  return Object.entries(asRecord(listed)).map(([key, value]) => ({
    id: pickString(asRecord(value), ID_KEYS) || key,
    raw: asRecord(value),
  }))
}

function sortRuntimes(list: RuntimeStatus[]): RuntimeStatus[] {
  const rank = (id: string): number => {
    const at = RUNTIME_ORDER.indexOf(id)
    return at < 0 ? RUNTIME_ORDER.length : at
  }
  return [...list].sort((a, b) => (rank(a.id) === rank(b.id) ? a.id.localeCompare(b.id) : rank(a.id) - rank(b.id)))
}

/** 归一化 /api/runtime/runtimes 的响应（引擎还没上线时调用方根本不会走到这里）。 */
export function normalizeRuntimes(payload: unknown): RuntimeStatus[] {
  const out: RuntimeStatus[] = []
  const seen = new Set<string>()
  for (const { id, raw } of candidates(payload)) {
    const key = id.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const install = asRecord(raw.install ?? raw.installation)
    const found = pickBoolean(raw, ['found', 'available', 'installed', 'ok', 'present', 'detected', 'exists'])
    const path = pickString(raw, ['path', 'executable_path', 'executablePath', 'location', 'bin', 'resolved_path'])
    const version = pickString(raw, ['version', 'ver', 'release'])
    const engineCommand = pickString(raw, [
      'install_command', 'installCommand', 'install_hint', 'suggested_install', 'winget', 'winget_command', 'hint',
    ]) || pickString(install, ['command', 'winget', 'winget_command', 'cmd'])
    const url = pickString(raw, ['url', 'homepage', 'website', 'install_url', 'download_url', 'docs'])
      || pickString(install, ['url', 'homepage', 'website'])
    const hint = runtimeHint(key)
    // 引擎把 label 直接填成可执行文件名时（"ffmpeg"），用兜底表里更好读的中文名。
    const rawLabel = pickString(raw, ['label', 'title', 'display_name', 'name'])
    out.push({
      id: key,
      label: rawLabel && rawLabel.toLowerCase() !== key ? rawLabel : hint.label,
      // 引擎只说「有版本 / 有路径」时也当成已安装：比默认「缺失」更保守，不会误报。
      found: found ?? (path !== '' || version !== ''),
      version,
      path,
      installCommand: engineCommand || hint.winget,
      url: url || hint.url,
      note: pickString(raw, ['note', 'description', 'usage']) || hint.note,
      fromEngine: engineCommand !== '',
    })
  }
  return sortRuntimes(out)
}

/** 按 id 找运行时；找不到就退回同一家（node/npm/npx、uv/uvx）。 */
export function runtimeStatusFor(runtimes: RuntimeStatus[], id: string): RuntimeStatus | null {
  const key = id.trim().toLowerCase()
  if (!key) return null
  const exact = runtimes.find((item) => item.id === key)
  if (exact) return exact
  const family = runtimes.find((item) => isSameFamily(item.id, key))
  if (family) return family
  return runtimes.find((item) => item.label.toLowerCase().includes(key)) ?? null
}

/** 条目真正需要的可执行文件：启动命令 + 显式声明的 requires（与引擎 catalogs::entry_requires 同口径）。 */
export function entryRuntimeIds(entry: { command?: string; requires?: string[] }): string[] {
  const out: string[] = []
  const push = (value: string | undefined): void => {
    const token = (value ?? '').trim().split(/\s+/)[0] ?? ''
    const name = token.split(/[\\/]/).pop() ?? ''
    if (!name) return
    if (out.some((seen) => seen.toLowerCase() === name.toLowerCase())) return
    out.push(name)
  }
  push(entry.command)
  for (const value of entry.requires ?? []) push(value)
  return out
}

/* ── 从「本机缺少运行环境：Node.js（npx）、Git；…」这类原因里认出运行时 ── */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 词边界匹配：避免 'uv' 命中 'uvx'。 */
function mentions(text: string, token: string): boolean {
  if (!token || token.length < 2) return false
  return new RegExp('(^|[^a-z0-9])' + escapeRegExp(token) + '([^a-z0-9]|$)', 'i').test(text)
}

/** 匹配顺序：同一家里先试更具体的名字（npx 先于 node、uvx 先于 uv），
 *  否则「Node.js（npx）」会先命中 node，帮助弹窗就指向了一个宽泛的名字。 */
const MATCH_ORDER = ['npx', 'npm', 'node', 'uvx', 'uv', 'docker', 'kubectl', 'git', 'ffmpeg', 'python']

/** 原因文本 → 运行时 id（同一家只留第一个命中的）。 */
export function matchRuntimeIds(text: string): string[] {
  const out: string[] = []
  if (!text.trim()) return out
  for (const id of MATCH_ORDER) {
    if (id === 'npm') continue
    const hint = runtimeHint(id)
    const hit = mentions(text, id) || mentions(text, hint.label)
    if (!hit) continue
    if (out.some((seen) => isSameFamily(seen, id))) continue
    out.push(id)
  }
  return out
}

/** 弹窗要展示的内容：优先用引擎给的状态，缺了就退回兜底表。 */
export interface RuntimeHelpTarget {
  id: string
  label: string
  installCommand: string
  url: string
  note: string
  steps: string[]
  /** 来自 /api/runtime/runtimes 的状态；接口不可用时为 null。 */
  status: RuntimeStatus | null
}

export function helpTargetFor(id: string, runtimes: RuntimeStatus[]): RuntimeHelpTarget {
  const hint = runtimeHint(id)
  const status = runtimeStatusFor(runtimes, id)
  return {
    id: status?.id ?? id,
    label: status?.label || hint.label,
    installCommand: status?.installCommand || hint.winget,
    url: status?.url || hint.url,
    note: status?.note || hint.note,
    steps: hint.steps,
    status,
  }
}

/** 市场里所有条目会用到、但本机没检测到的运行时（含受影响的条目数）。 */
export function missingRuntimesFor(
  runtimes: RuntimeStatus[],
  entries: Array<{ command?: string; requires?: string[]; available?: boolean }>,
): Array<{ runtime: RuntimeStatus; affected: number }> {
  const out: Array<{ runtime: RuntimeStatus; affected: number }> = []
  for (const runtime of runtimes) {
    if (runtime.found) continue
    const affected = entries.filter((entry) =>
      entry.available === false && entryRuntimeIds(entry).some((id) => isSameFamily(id, runtime.id)),
    ).length
    out.push({ runtime, affected })
  }
  return out
}

/** 接口不支持检测时：市场条目引用到的运行时 id（用来提示「市场需要这些」）。 */
export function referencedRuntimeIds(entries: Array<{ command?: string; requires?: string[] }>): string[] {
  const out: string[] = []
  for (const entry of entries) {
    for (const id of entryRuntimeIds(entry)) {
      const key = id.toLowerCase()
      if (!out.includes(key)) out.push(key)
    }
  }
  return sortRuntimes(out.map((id) => {
    const hint = runtimeHint(id)
    return {
      id,
      label: hint.label,
      found: false,
      version: '',
      path: '',
      installCommand: hint.winget,
      url: hint.url,
      note: hint.note,
      fromEngine: false,
    }
  })).map((item) => item.id)
}

/** 两个 id 是否属于同一家（node/npm/npx、uv/uvx）。 */
export function isSameRuntime(left: string, right: string): boolean {
  return isSameFamily(left, right)
}
