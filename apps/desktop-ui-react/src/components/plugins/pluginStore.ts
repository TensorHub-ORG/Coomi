import { create } from 'zustand'
import { ipc } from '../../lib/ipc'
import { applyPluginTheme, clearPluginTheme, mascotUsable, type PluginTheme, type PluginThemeMascot } from './PluginThemeEngine'

/* ── 插件状态 store ──
   持久化：localStorage coomi.plugins.v1 = { id → { enabled, themeSelected } }（启停与主题选择）。
   内存：壳命令 plugin_list 的插件清单（启动时、进「插件」分组时各刷一次）。
   壳命令 plugin_list / plugin_set_enabled / plugin_install_dir / plugin_uninstall 正在由壳侧实现：
   这里的调用按「命令不存在或缺字段」一律友好降级 —— 给可读中文、回滚本地乐观值、不崩。 */

/** 插件声明的斜杠命令：Composer 输入 / 弹出，选中后把 template 填入输入框。 */
export interface PluginSlashCommand {
  /** 命令名（不含斜杠），如 "review"；展示为 /review。 */
  name?: string
  /** 完整命令文本（如 "/review"）；缺省时前端用 name 拼。 */
  command?: string
  description?: string
  /** 选中后填入输入框的模板文本；{{cursor}} 会被替换成光标落点。 */
  template?: string
}

/** 插件声明的子智能体模板：名称 + 描述；systemPrompt 由壳/引擎侧保存。 */
export interface PluginSubagentTemplate {
  id?: string
  name?: string
  description?: string
}

/** 插件人设：启用带 persona 的插件时，Composer 上方提示生效并可一键关闭。 */
export interface PluginPersona {
  name?: string
  description?: string
}

/** 插件市场里的一条（plugin_market_list 的返回项）。 */
export interface MarketPlugin {
  id?: string
  name?: string
  version?: string
  description?: string
  /** zip 下载地址（plugin_install_from_url 的参数）。 */
  zipUrl?: string
}

export interface PluginEntry {
  id: string
  name?: string
  version?: string
  description?: string
  /** 权限骨架：插件声明的权限名（theme.apply 等），前端只负责展示。 */
  permissions?: string[]
  /** 壳侧下发的启用状态；本地 prefs 有记录时以本地为准（见 effectiveEnabled）。 */
  enabled?: boolean
  /** 有主题的插件才带：可能是路径字符串（"theme.json"）或已解析的主题对象。 */
  theme?: string | PluginTheme | null
  /** 壳侧直接下发解析好的主题对象（plugin_list 带上内容，前端才能立即渲染）。 */
  themeData?: PluginTheme | null
  /** 插件提供的技能名（数量用于详情展示；技能中心可另行对接）。 */
  skills?: string[]
  /** 插件附带/需要的 MCP 工具数量（壳侧统计后下发）。 */
  mcpCount?: number
  /** 插件声明的子智能体模板（名称 + 描述；systemPrompt 由壳/引擎侧保存）。 */
  subagents?: PluginSubagentTemplate[]
  /** 插件人设（启用后 Composer 上方显示「插件人设已生效」）。 */
  persona?: PluginPersona | null
  /** 插件声明的斜杠命令（选中后把 template 填入输入框）。 */
  slash?: PluginSlashCommand[]
}

export interface PluginPrefsEntry {
  enabled: boolean
  themeSelected: boolean
}

export type PluginPrefs = Record<string, PluginPrefsEntry>

export type { PluginTheme } from './PluginThemeEngine'

const PREFS_KEY = 'coomi.plugins.v1'

function readPluginPrefs(): PluginPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as PluginPrefs
    const out: PluginPrefs = {}
    for (const [id, value] of Object.entries(raw)) {
      if (!id || !value || typeof value !== 'object') continue
      const entry = value as Partial<PluginPrefsEntry>
      out[id] = {
        enabled: entry.enabled === true,
        themeSelected: entry.themeSelected === true,
      }
    }
    return out
  } catch {
    return {}
  }
}

function writePluginPrefs(prefs: PluginPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* 隐私模式忽略 */ }
}

/* ── 壳返回值的防御性归一化：字段缺了就有缺了的展示，绝不崩 ── */

function toStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function strMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim()
  }
  return Object.keys(out).length ? out : undefined
}

/** theme.background 字段（v1.5）：本地图片 / 渐变铺一层 fixed 背景。
    image / gradient 至少给一个；fit 只认 cover|contain；opacity 0–1、blur ≥ 0，
    越界值在引擎侧还会再夹一遍（这里只做「非数字就丢」的轻归一化）。 */
function normalizeBackground(v: unknown): NonNullable<PluginTheme['background']> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  const out: NonNullable<PluginTheme['background']> = {}
  const image = toStr(r.image)
  if (image) out.image = image
  const gradient = toStr(r.gradient)
  if (gradient) out.gradient = gradient
  const fit = toStr(r.fit)
  if (fit === 'cover' || fit === 'contain') out.fit = fit
  const opacity = typeof r.opacity === 'number' && Number.isFinite(r.opacity) ? r.opacity : undefined
  if (opacity !== undefined) out.opacity = opacity
  const blur = typeof r.blur === 'number' && Number.isFinite(r.blur) ? r.blur : undefined
  if (blur !== undefined) out.blur = blur
  return Object.keys(out).length ? out : undefined
}

/** theme.mascot 字段（v1.6）：logo / avatar / composer 都是 asset 路径字符串；
     每一项只认非空字符串；全部为空时返回 undefined。 */
function normalizeMascot(v: unknown): PluginThemeMascot | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  const out: PluginThemeMascot = {}
  const logo = toStr(r.logo)
  if (logo) out.logo = logo
  const avatar = toStr(r.avatar)
  if (avatar) out.avatar = avatar
  const composer = toStr(r.composer)
  if (composer) out.composer = composer
  return mascotUsable(out) ? out : undefined
}

/** 把「任意形状的 theme 数据」归一化成 PluginTheme；没有任何可用内容（令牌 / 背景 /
     自定义 CSS / mascot 全空）时返回 null。background、css 与 mascot 归一化时必须保留。 */
function asTheme(v: unknown): PluginTheme | null {
  if (!v || typeof v !== 'object') return null
  const raw = v as Record<string, unknown>
  const colors = strMap(raw.colors)
  const radii = strMap(raw.radii)
  const fonts = strMap(raw.fonts)
  const background = normalizeBackground(raw.background)
  const css = arrayOfStrings(raw.css)
  const mascot = normalizeMascot(raw.mascot)
  if (!colors && !radii && !fonts && !background && !css && !mascot) return null
  const theme: PluginTheme = {}
  if (typeof raw.name === 'string' && raw.name.trim()) theme.name = raw.name.trim()
  if (colors) theme.colors = colors
  if (radii) theme.radii = radii
  if (fonts) theme.fonts = fonts
  if (background) theme.background = background
  if (css) theme.css = css
  if (mascot) theme.mascot = mascot
  return theme
}

/** 字符串数组（技能名等）：非数组 / 全空时返回 undefined。 */
function arrayOfStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
  return out.length ? out : undefined
}

/** 非负整数（MCP 数量等）：字符串数字也认。 */
function toCount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim()) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

function normalizeSubagents(v: unknown): PluginSubagentTemplate[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: PluginSubagentTemplate[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = toStr(r.name) ?? toStr(r.id)
    if (!name) continue
    const item: PluginSubagentTemplate = { name }
    const id = toStr(r.id)
    if (id) item.id = id
    const description = toStr(r.description)
    if (description) item.description = description
    out.push(item)
  }
  return out.length ? out : undefined
}

function normalizePersona(v: unknown): PluginPersona | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const name = toStr(r.name)
  if (!name) return null
  const persona: PluginPersona = { name }
  const description = toStr(r.description)
  if (description) persona.description = description
  return persona
}

function normalizeSlash(v: unknown): PluginSlashCommand[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: PluginSlashCommand[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = toStr(r.name) ?? toStr(r.command)?.replace(/^\//, '')
    if (!name) continue
    const item: PluginSlashCommand = { name }
    const command = toStr(r.command)
    if (command) item.command = command
    const description = toStr(r.description)
    if (description) item.description = description
    const template = toStr(r.template)
    if (template) item.template = template
    out.push(item)
  }
  return out.length ? out : undefined
}

/** plugin_list 的返回可能是数组，也可能是 { plugins: [...] } / { items: [...] } 等外壳。 */
function extractList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record.plugins)) return record.plugins
    if (Array.isArray(record.items)) return record.items
    if (Array.isArray(record.list)) return record.list
  }
  return []
}

/* ── 插件市场：plugin_market_list / plugin_install_from_url（壳侧 zip 下载解压安装）── */

/** 内置插件市场源：plugin_market_list 无参时的默认仓库，地址由壳侧统一约定。 */
export const BUILTIN_MARKET_URL = 'https://plugins.coomi.app/index.json'

/** plugin_market_list 的返回也可能是数组 / { plugins } / { items } 等外壳。 */
function extractMarketList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record.plugins)) return record.plugins
    if (Array.isArray(record.items)) return record.items
    if (Array.isArray(record.list)) return record.list
    if (Array.isArray(record.entries)) return record.entries
  }
  return []
}

function normalizeMarket(raw: unknown): MarketPlugin | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = toStr(r.name) ?? toStr(r.id)
  if (!name) return null
  const out: MarketPlugin = { name }
  const id = toStr(r.id)
  if (id) out.id = id
  const version = toStr(r.version)
  if (version) out.version = version
  const description = toStr(r.description)
  if (description) out.description = description
  const zipUrl = toStr(r.zipUrl) ?? toStr(r.zip_url) ?? toStr(r.installUrl) ?? toStr(r.install_url) ?? toStr(r.url)
  if (zipUrl) out.zipUrl = zipUrl
  return out
}

function normalizeEntry(raw: unknown): PluginEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = toStr(r.id) ?? toStr(r.name)
  if (!id) return null
  const entry: PluginEntry = { id }
  const name = toStr(r.name)
  if (name) entry.name = name
  const version = toStr(r.version)
  if (version) entry.version = version
  const description = toStr(r.description)
  if (description) entry.description = description
  if (Array.isArray(r.permissions)) {
    const perms = r.permissions
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean)
    if (perms.length) entry.permissions = perms
  }
  if (typeof r.enabled === 'boolean') entry.enabled = r.enabled
  const theme = r.theme ?? r.themeData
  if (typeof theme === 'string' && theme.trim()) {
    entry.theme = theme.trim()
  } else if (theme && typeof theme === 'object') {
    const parsed = asTheme(theme)
    if (parsed) entry.theme = parsed
  }
  // v1.5：themeData 整对象原样透传（background / css 等新字段一字不丢），
  // 只保证「它是对象」这一层 —— 渲染路径只读已知字段，未知键不会被执行。
  const themeData = r.themeData
  if (themeData && typeof themeData === 'object' && !Array.isArray(themeData)) {
    entry.themeData = themeData as PluginTheme
  }
  /* ── v2 能力：技能 / MCP / 子智能体模板 / 人设 / 斜杠命令。
     壳侧 plugin_list 下发，前端只展示与使用；字段缺了就有缺了的展示，绝不崩。 ── */
  const skills = arrayOfStrings(r.skills)
  if (skills) entry.skills = skills
  const mcpCount = toCount(r.mcpCount) ?? toCount(r.mcp)
  if (mcpCount !== null) entry.mcpCount = mcpCount
  const subagents = normalizeSubagents(r.subagents ?? r.subagentTemplates)
  if (subagents) entry.subagents = subagents
  const persona = normalizePersona(r.persona)
  if (persona) entry.persona = persona
  const slash = normalizeSlash(r.slash ?? r.slashCommands)
  if (slash) entry.slash = slash
  return entry
}

/* ── 派生查询（供 PluginsView 与设置页外观组共用）── */

/** 该插件是否有主题能力（壳侧声明了 theme，或直接给了主题数据）。 */
export function hasTheme(p: PluginEntry): boolean {
  return p.theme != null || p.themeData != null
}

/** 能直接拿来注入 CSS 的主题数据；拿不到（壳只给了路径字符串）返回 null。 */
export function getThemeData(p: PluginEntry): PluginTheme | null {
  if (p.themeData) return p.themeData
  if (p.theme && typeof p.theme === 'object') return p.theme
  return null
}

export function pluginName(p: PluginEntry): string {
  return p.name || p.id
}

/** 生效的启用状态：本地 prefs 有记录时以本地为准（用户手改过），否则跟随壳。 */
export function effectiveEnabled(p: PluginEntry, prefs: PluginPrefs): boolean {
  const pref = prefs[p.id]
  return pref ? pref.enabled : Boolean(p.enabled)
}

/** 当前生效的插件主题：已选 && 已启用 && 带主题的插件 id；没有则 null。 */
export function activeThemePluginId(plugins: PluginEntry[], prefs: PluginPrefs): string | null {
  for (const p of plugins) {
    const pref = prefs[p.id]
    if (!pref?.themeSelected || !pref.enabled) continue
    if (!hasTheme(p)) continue
    return p.id
  }
  return null
}

/** 外观组「插件主题」下拉的候选项：已启用且带主题的插件。 */
export function themePlugins(plugins: PluginEntry[], prefs: PluginPrefs): PluginEntry[] {
  return plugins.filter((p) => effectiveEnabled(p, prefs) && hasTheme(p))
}

/** 该插件声明的斜杠命令数量（详情展示与「有没有斜杠能力」共用）。 */
export function slashCount(p: PluginEntry): number {
  return p.slash?.length ?? 0
}

/** 该插件声明的子智能体模板数量（详情展示）。 */
export function subagentTemplateCount(p: PluginEntry): number {
  return p.subagents?.length ?? 0
}

/** 按「已选 && 已启用 && 有数据」重算当前插件主题并落地到 DOM（引擎只认这一处输入）。 */
export function syncPluginTheme(plugins: PluginEntry[], prefs: PluginPrefs): void {
  const activeId = activeThemePluginId(plugins, prefs)
  const entry = activeId ? plugins.find((p) => p.id === activeId) ?? null : null
  const applied = entry ? getThemeData(entry) : null
  if (applied && entry) applyPluginTheme(entry.id, applied)
  else clearPluginTheme()
}

/* ── 壳命令缺字段 / 不存在时的可读错误 ── */

const MISSING_CMD_RE = /not found|unknown command|no command|not implemented|unavailable|is not a function|invalid command|does not exist/i

export function describeIpcError(cmd: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (MISSING_CMD_RE.test(msg)) {
    return '壳命令 ' + cmd + ' 尚不可用（壳侧还没有实现它），插件功能已降级。' + msg
  }
  return msg || '壳命令 ' + cmd + ' 调用失败'
}

/* ── store ── */

interface PluginState {
  plugins: PluginEntry[]
  status: 'idle' | 'loading' | 'ready'
  error: string
  prefs: PluginPrefs
  /** 拉插件清单；命令缺失 / 壳没起来时留空列表 + 可读错误，主题一并清除。 */
  refresh: () => Promise<void>
  /** 切启用开关：本地乐观生效 → 调壳 → 失败回滚并抛可读错误。 */
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  /** 设为当前主题（null = 恢复内置）；同一时刻只有一个插件能是当前主题。 */
  setThemeSelected: (id: string | null) => void
  /** 选目录 → plugin_install_dir → 重刷列表。返回 { ok, message }（取消时 message 为空串）。 */
  installFromDir: () => Promise<{ ok: boolean; message: string }>
  /** 选本地 .zip → plugin_install_zip → 重刷列表。返回 { ok, message }（取消时 message 为空串）。 */
  installFromZip: () => Promise<{ ok: boolean; message: string }>
  /** 卸载；失败抛可读错误。 */
  uninstall: (id: string) => Promise<void>
  /** 市场页拉清单：plugin_market_list(url)；url 空时用内置固定源。 */
  listMarket: (url?: string) => Promise<{ ok: boolean; plugins: MarketPlugin[]; source: string; message: string }>
  /** 市场页安装：plugin_install_from_url(zipUrl) 下载解压安装，成功后刷新列表。 */
  installFromUrl: (zipUrl: string) => Promise<{ ok: boolean; message: string }>
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  status: 'idle',
  error: '',
  prefs: readPluginPrefs(),

  refresh: async () => {
    set({ status: 'loading', error: '' })
    try {
      const payload = await ipc('plugin_list')
      const entries: PluginEntry[] = []
      for (const raw of extractList(payload)) {
        const entry = normalizeEntry(raw)
        if (entry) entries.push(entry)
      }
      const prefs = get().prefs
      set({ plugins: entries, status: 'ready', error: '' })
      syncPluginTheme(entries, prefs)
    } catch (e) {
      // 命令缺失 / 壳没起来：列表留空、给可读原因；主题无从应用，清掉残留注入。
      set({ plugins: [], status: 'ready', error: describeIpcError('plugin_list', e) })
      clearPluginTheme()
    }
  },

  setEnabled: async (id, enabled) => {
    const prev = get().prefs
    const prevEntry = prev[id] ?? { enabled: false, themeSelected: false }
    const next = { ...prev, [id]: { ...prevEntry, enabled } }
    writePluginPrefs(next)
    set({
      prefs: next,
      plugins: get().plugins.map((p) => (p.id === id ? { ...p, enabled } : p)),
    })
    // 关掉正被用作主题的插件：主题随之停用（sync 里「已启用」条件不满足）。
    syncPluginTheme(get().plugins, next)
    try {
      await ipc('plugin_set_enabled', { id, on: enabled })
    } catch (e) {
      // 回滚本地乐观值：壳命令失败不能把开关留在「以为关了、其实没关」的状态。
      writePluginPrefs(prev)
      set({
        prefs: prev,
        plugins: get().plugins.map((p) => (p.id === id ? { ...p, enabled: prevEntry.enabled } : p)),
      })
      syncPluginTheme(get().plugins, prev)
      throw new Error(describeIpcError('plugin_set_enabled', e))
    }
  },

  setThemeSelected: (id) => {
    const plugins = get().plugins
    const target = id !== null && plugins.some((p) => p.id === id) ? id : null
    const prev = get().prefs
    const next: PluginPrefs = {}
    for (const [pid, entry] of Object.entries(prev)) {
      next[pid] = { ...entry, themeSelected: pid === target }
    }
    if (target && !next[target]) {
      next[target] = { enabled: plugins.find((p) => p.id === target)?.enabled ?? false, themeSelected: true }
    }
    writePluginPrefs(next)
    set({ prefs: next })
    syncPluginTheme(plugins, next)
  },

  installFromDir: async () => {
    try {
      const dir = await ipc<string | null>('pick_directory')
      if (!dir) return { ok: false, message: '' }
      await ipc('plugin_install_dir', { path: dir })
      await get().refresh()
      return { ok: true, message: '插件已安装，列表已刷新' }
    } catch (e) {
      return { ok: false, message: describeIpcError('plugin_install_dir', e) }
    }
  },

  installFromZip: async () => {
    try {
      const zip = await ipc<string | null>('pick_zip_file')
      if (!zip) return { ok: false, message: '' }
      await ipc('plugin_install_zip', { zipPath: zip })
      await get().refresh()
      return { ok: true, message: '插件已从 zip 安装，列表已刷新' }
    } catch (e) {
      return { ok: false, message: describeIpcError('plugin_install_zip', e) }
    }
  },

  uninstall: async (id) => {
    try {
      await ipc('plugin_uninstall', { id })
      const prefs = { ...get().prefs }
      delete prefs[id]
      writePluginPrefs(prefs)
      const plugins = get().plugins.filter((p) => p.id !== id)
      set({ plugins, prefs })
      // 卸载的恰好是当前主题时，主题一并恢复为内置。
      syncPluginTheme(plugins, prefs)
    } catch (e) {
      throw new Error(describeIpcError('plugin_uninstall', e))
    }
  },

  listMarket: async (url) => {
    const source = (url ?? '').trim() || BUILTIN_MARKET_URL
    try {
      const payload = await ipc('plugin_market_list', { url: source })
      const list: MarketPlugin[] = []
      for (const raw of extractMarketList(payload)) {
        const entry = normalizeMarket(raw)
        if (entry) list.push(entry)
      }
      return { ok: true, plugins: list, source, message: list.length ? '拉到 ' + list.length + ' 个插件' : '仓库没有返回插件' }
    } catch (e) {
      return { ok: false, plugins: [], source, message: describeIpcError('plugin_market_list', e) }
    }
  },

  installFromUrl: async (zipUrl) => {
    try {
      await ipc('plugin_install_from_url', { zipUrl })
      await get().refresh()
      return { ok: true, message: '插件已安装，列表已刷新' }
    } catch (e) {
      return { ok: false, message: describeIpcError('plugin_install_from_url', e) }
    }
  },
}))
