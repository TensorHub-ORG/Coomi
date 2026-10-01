/** AI 能力开关：全部可开可关，持久化到本地；引擎侧把它们写进 settings.json 的 capabilities 块，
 *  通过 /api/agent/preferences 读写（GET 给有效值，PUT 做部分更新）。
 *
 *  默认值三处必须一致：本文件的 DEFAULT_CAPS / 引擎 CapabilitySettings::default() / settings.json 现值。
 *  同步策略：
 *  · 引擎就绪 → GET 一次，把引擎的有效值合并进本地；引擎没起来或请求失败时保持 localStorage
 *    现值，不报错、不阻塞界面；
 *  · 用户改动 → 先本地乐观生效（照旧写 localStorage），再只把**变化的键** PUT 给引擎；
 *    失败回滚这一次改动并提示一次，不静默丢弃；
 *  · 没有壳 / 浏览器直跑（引擎永远不 ready）→ 只走 localStorage，改动先记下来，
 *    等引擎起来先 GET 合并、再把这些改动补推上去，避免被引擎旧值覆盖。
 *
 *  自动压缩（设置页「上下文压缩」小节）读写的 5 个顶层键：
 *  autoCompactionEnabled / autoCompactPercent / autoCompactFloorTokens /
 *  autoCompactRetainTokens / autoCompactMessageLimit —— 都在 preferences 顶层平铺，
 *  不塞进 capabilities 块。界面上的「引擎回读值」由 components/settings/CompactionPanel 自己 GET 一次比对。 */
import { create } from 'zustand'
import { toast } from 'sonner'
import { useEngine } from './engine'

export interface Capabilities {
  memory: boolean
  memoryWrite: boolean
  memoryAutoInject: boolean
  memoryVector: boolean
  compression: boolean
  autoPinMilestones: boolean
  promptLayering: boolean
  skillOnDemand: boolean
  toolEnhance: boolean
  trustGate: boolean
  emotionTone: boolean
  persona: boolean
  subagents: boolean
  notifyGuard: boolean
  /** 后台完成提醒：窗口不在前台时，一轮回复结束后弹提醒（系统通知优先，否则应用内 toast）。 */
  backgroundNotify: boolean
  /** 反问澄清：信息不足时允许 AI 先问一句（user_question_request → 输入区的问答卡）。 */
  askUser: boolean
  /** 提问的等待超时（分钟）：0 = 一直等；到点由界面按「跳过」把这一问收掉，
   *  不让整轮对话干等在那里（引擎侧若也实现了同一个超时，谁先到点谁收）。
   *  字段名与引擎对齐；引擎还没上报这个键时只存本地，设置页会标注「仅本地」。 */
  askUserTimeoutMinutes: number
  /** 生成物卡片：一轮结束后在最后一条回复下方列出本轮产出的文件（点开预览 / 右键另存）。
   *  关掉只是不显示这排卡片，产物本身与产物中心都不受影响。 */
  showArtifacts: boolean
  /** 允许「另存为」请求：产物卡片与预览面板里出现「另存为…」，点击会弹系统保存对话框。
   *  默认关 —— 弹原生对话框会打断用户，得先由用户在这里点头。 */
  allowSaveAsRequest: boolean
  metrics: boolean
  /** 端上留痕总开关（默认开）：引擎把每轮任务写进 trajectory.jsonl 的原料。
   *  关掉后引擎不再落盘轨迹；这是「默认攒素材、想清静可以关」的那个开关。 */
  localTraceEnabled: boolean
  /** 端上留痕体积上限（MB）。0 = 不限（默认，不限制增长）；>0 时是上限，
   *  引擎侧把非零值夹在 1~4096（见 web/mod.rs 的 sanitized）。 */
  localTraceMaxMb: number
  subagentConcurrency: number
  compressionThreshold: number
  /** 自动压缩：引擎读写在 preferences 顶层（不在 capabilities 块里），也一起同步。 */
  autoCompactMessageLimit: number
  autoCompactionEnabled: boolean
  /** 0 = 没有显式设置（引擎回落到 compressionThreshold）；引擎侧有效范围 50~95。 */
  autoCompactPercent: number
  /** 绝对下限（token）：上下文再小也不低于它才允许压缩；0 = 关闭该条件。 */
  autoCompactFloorTokens: number
  /** 保留区（token）：最近这一段原文压完仍逐字保留，不参与压缩。 */
  autoCompactRetainTokens: number
  /** 工具条目名称语言：zh = 有中文名就显示中文，en = 一律显示原名，both = 中英并列（中文（原名））。 */
  toolLang: 'zh' | 'en' | 'both'
  /** 远程条目自动翻译：未命中本地词典的名称批量走 POST /api/catalog/translate（≤20/批），
   *  结果缓存到 localStorage；配额用尽 / 接口失败一律回原名。纯显示偏好，不发给引擎。 */
  translateRemote: boolean
}

const KEY = 'coomi.capabilities.v1'

/** 引擎把压缩阈值夹在 0.1~0.99：前端先夹一遍，免得发出去的值在引擎侧被改写成别的数。 */
export const THRESHOLD_MIN = 0.1
export const THRESHOLD_MAX = 0.99

/** 压缩阈值百分比的有效范围（引擎侧同口径，见 web/mod.rs 的 clamp(50, 95)）。 */
export const COMPACT_PERCENT_MIN = 50
export const COMPACT_PERCENT_MAX = 95

/** 端上留痕体积上限的有效范围（MB）：与引擎 web/mod.rs 的 clamp(1, 4096) 同口径。 */
export const TRACE_MAX_MB_MIN = 1
export const TRACE_MAX_MB_MAX = 4096

/** preferences 里不在 capabilities 块下的顶层字段：PUT 时要平铺，不能塞进 capabilities。 */
const TOP_LEVEL_KEYS: readonly string[] = [
  'autoCompactMessageLimit',
  'autoCompactionEnabled',
  'autoCompactPercent',
  'autoCompactFloorTokens',
  'autoCompactRetainTokens',
]

export const DEFAULT_CAPS: Capabilities = {
  memory: true,
  memoryWrite: true,
  memoryAutoInject: true,
  memoryVector: true,
  compression: true,
  autoPinMilestones: true,
  promptLayering: true,
  skillOnDemand: true,
  toolEnhance: true,
  trustGate: true,
  emotionTone: false,
  persona: false,
  subagents: true,
  notifyGuard: true,
  backgroundNotify: true,
  // 反问澄清与生成物卡片默认开：前者让 AI 少猜、后者是「这轮干了什么」的直接反馈。
  askUser: true,
  // 默认「一直等」：自动替用户跳过提问，比多等一会儿更让人意外。
  askUserTimeoutMinutes: 0,
  showArtifacts: true,
  // 另存为默认关：它会在用户点一下的时候弹出系统保存对话框，属于要显式打开的打扰型能力。
  allowSaveAsRequest: false,
  metrics: true,
  // 端上留痕默认「开 + 不限体积」：先让本机素材攒着（产品决定），用户想控体积再设上限。
  localTraceEnabled: true,
  localTraceMaxMb: 0,
  subagentConcurrency: 3,
  // 与引擎默认一致（85%）。compressionThreshold 是旧字段，引擎侧现在优先用 autoCompactPercent。
  compressionThreshold: 0.85,
  // 自动压缩默认「平衡」档（设置页「上下文压缩」小节的一键档位）：
  // 85% 触发 / 10 万 token 下限 / 200 条消息 / 32k 保留区 / 自动压缩开。
  // 引擎侧读不到这些键时以本文件为默认；引擎回读到的有效值优先（见 syncFromEngine）。
  autoCompactMessageLimit: 200,
  autoCompactionEnabled: true,
  autoCompactPercent: 85,
  autoCompactFloorTokens: 100000,
  autoCompactRetainTokens: 32000,
  // 翻译是显示偏好：默认中文优先、远程条目自动翻译开（引擎侧不认识这两个键也没关系，
  // 它们只落 localStorage；translateRemote 即使被当作未知键 PUT 给引擎，引擎也会原样保留）。
  toolLang: 'zh',
  translateRemote: true,
}

/** GET/PUT 的响应体：capabilities 块 + 五个自动压缩顶层字段。 */
interface PreferencesPayload {
  capabilities?: unknown
  autoCompactMessageLimit?: unknown
  autoCompactionEnabled?: unknown
  autoCompactPercent?: unknown
  autoCompactFloorTokens?: unknown
  autoCompactRetainTokens?: unknown
}

type Flat = Record<string, boolean | number>

function asFlat(caps: Capabilities): Flat {
  return caps as unknown as Flat
}

function read(): Capabilities {
  try { return { ...DEFAULT_CAPS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Capabilities>) } } catch { return DEFAULT_CAPS }
}

function persist(caps: Capabilities): void {
  try { localStorage.setItem(KEY, JSON.stringify(caps)) } catch { /* 隐私模式忽略 */ }
}

/** 合并引擎返回的值：只认识「本地已经有、且类型一致」的键，
 *  引擎多返回的键 / 类型对不上的键一律忽略，绝不污染本地状态。 */
function mergeEngineValues(current: Capabilities, raw: unknown): Capabilities {
  const patch: Flat = {}
  if (raw && typeof raw === 'object') {
    const own = asFlat(current)
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const mine = own[key]
      if (typeof value === 'boolean' && typeof mine === 'boolean') patch[key] = value
      else if (typeof value === 'number' && typeof mine === 'number' && Number.isFinite(value)) patch[key] = value
    }
  }
  return { ...current, ...(patch as unknown as Partial<Capabilities>) }
}

/** 自动压缩五项：引擎没设百分比时返回 null，本地用 0 表示「未设置」。
 *  下限 / 保留区是后加的键：引擎版本较旧时不回读，此时保持本地值（界面上会标注「引擎未上报」）。 */
function mergeTopLevel(current: Capabilities, data: PreferencesPayload | null): Capabilities {
  const patch: Flat = {}
  const limit = data?.autoCompactMessageLimit
  if (typeof limit === 'number' && Number.isFinite(limit)) patch.autoCompactMessageLimit = limit
  if (typeof data?.autoCompactionEnabled === 'boolean') patch.autoCompactionEnabled = data.autoCompactionEnabled
  const percent = data?.autoCompactPercent
  if (typeof percent === 'number' && Number.isFinite(percent)) patch.autoCompactPercent = percent
  const floor = data?.autoCompactFloorTokens
  if (typeof floor === 'number' && Number.isFinite(floor)) patch.autoCompactFloorTokens = floor
  const retain = data?.autoCompactRetainTokens
  if (typeof retain === 'number' && Number.isFinite(retain)) patch.autoCompactRetainTokens = retain
  return { ...current, ...(patch as unknown as Partial<Capabilities>) }
}

/** 发给引擎前过一遍：NaN/Infinity 不能发（JSON 会变成 null，
 *  而引擎解析失败会把整块能力开关重置成默认值），阈值按引擎的范围先夹好。 */
function engineValue(key: string, value: boolean | number): boolean | number | undefined {
  if (typeof value === 'boolean') return value
  if (!Number.isFinite(value)) return undefined
  if (key === 'compressionThreshold') return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, value))
  if (key === 'autoCompactPercent') return value <= 0 ? 0 : Math.min(COMPACT_PERCENT_MAX, Math.max(COMPACT_PERCENT_MIN, value))
  if (key === 'autoCompactMessageLimit') return Math.round(value)
  // 0 = 关闭该条件（下限）／未设置（保留区）：原样发出去，别被负数或小数污染。
  if (key === 'autoCompactFloorTokens' || key === 'autoCompactRetainTokens') return value <= 0 ? 0 : Math.round(value)
  // 留痕体积上限：0 = 不限（原样发）；给了值先按引擎的 1~4096 夹好并取整，
  // 免得界面上填出 0.5 / 99999 这种值、被引擎静默改写成另一个数（回读时会对不上）。
  if (key === 'localTraceMaxMb') return value <= 0 ? 0 : Math.min(TRACE_MAX_MB_MAX, Math.max(TRACE_MAX_MB_MIN, Math.round(value)))
  return value
}

/** 变化的键 → PUT 请求体：capabilities 块 + 顶层字段，只带变化的键。 */
function toPayload(changed: Flat): Record<string, unknown> | null {
  const capabilities: Flat = {}
  const top: Flat = {}
  for (const [key, value] of Object.entries(changed)) {
    const safe = engineValue(key, value)
    if (safe === undefined) continue
    if (TOP_LEVEL_KEYS.includes(key)) top[key] = safe
    else capabilities[key] = safe
  }
  const body: Record<string, unknown> = {}
  if (Object.keys(capabilities).length) body.capabilities = capabilities
  for (const [key, value] of Object.entries(top)) body[key] = value
  return Object.keys(body).length ? body : null
}

/** 引擎没起来时改的开关：先记着，等引擎就绪补一次 PUT（GET 合并时会跳过这些键）。 */
let deferred: Flat = {}
/// 同一类保存失败只留一个 toast，连着点几下不会刷屏。
const SAVE_ERROR_TOAST = 'coomi-caps-save-error'

/** 推给引擎。返回 false 表示引擎没就绪或写入失败（调用方据此决定是否回滚）。 */
async function pushToEngine(changed: Flat): Promise<boolean> {
  const engine = useEngine.getState()
  // 没有壳 / 引擎没起来：没有可写的引擎，交给调用方只走 localStorage。
  if (!engine.ready) return false
  const body = toPayload(changed)
  if (!body) return true
  try {
    const data = await engine.api<PreferencesPayload>('/api/agent/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    // 引擎会夹紧/补齐（阈值、条数上限），以它返回的有效值为准回写这几个键。
    const store = useCapabilities.getState()
    const confirmed = mergeEngineValues(mergeTopLevel(store.caps, data), data?.capabilities)
    const onlySent: Flat = {}
    const confirmedFlat = asFlat(confirmed)
    for (const key of Object.keys(changed)) {
      const value = confirmedFlat[key]
      if (typeof value === 'boolean' || typeof value === 'number') onlySent[key] = value
    }
    const caps = { ...store.caps, ...(onlySent as unknown as Partial<Capabilities>) }
    persist(caps)
    useCapabilities.setState({ caps })
    return true
  } catch { return false }
}

interface CapState {
  caps: Capabilities
  set: (patch: Partial<Capabilities>) => void
  /** 拉一次引擎侧有效值并合并；引擎没就绪 / 请求失败时静默保持本地值。 */
  syncFromEngine: () => Promise<void>
}

export const useCapabilities = create<CapState>((set, get) => {
  /** 引擎没接受这次改动：只回滚「这次真正改过的键」，并提示一次。 */
  const rollback = (changed: Flat, before: Capabilities): void => {
    const current = get().caps
    const now = asFlat(current)
    const old = asFlat(before)
    const restored: Flat = {}
    for (const key of Object.keys(changed)) {
      // 用户可能在这期间又改过同一个键：那就以最新值为准，不回滚。
      if (now[key] !== changed[key]) continue
      const value = old[key]
      if (typeof value === 'boolean' || typeof value === 'number') restored[key] = value
    }
    if (Object.keys(restored).length) {
      const caps = { ...current, ...(restored as unknown as Partial<Capabilities>) }
      persist(caps)
      set({ caps })
    }
    toast.error('保存到引擎失败，已恢复', {
      id: SAVE_ERROR_TOAST,
      description: '这次改动没有写进引擎，界面已回到改动前的状态。',
    })
  }

  return {
    caps: read(),

    set: (patch) => {
      const before = get().caps
      const caps = { ...before, ...patch }
      // 照旧先落本地：界面立刻生效，不等网络。
      persist(caps)
      set({ caps })

      const now = asFlat(caps)
      const old = asFlat(before)
      const changed: Flat = {}
      for (const key of Object.keys(patch)) {
        const value = now[key]
        if (value === old[key]) continue
        if (typeof value === 'boolean' || typeof value === 'number') changed[key] = value
      }
      if (!Object.keys(changed).length) return

      if (!useEngine.getState().ready) {
        // 浏览器直跑 / 引擎没起来：只走 localStorage，改动等引擎就绪再补推。
        deferred = { ...deferred, ...changed }
        return
      }
      void (async () => {
        if (await pushToEngine(changed)) return
        rollback(changed, before)
      })()
    },

    syncFromEngine: async () => {
      const engine = useEngine.getState()
      if (!engine.ready) return
      try {
        const data = await engine.api<PreferencesPayload>('/api/agent/preferences')
        const merged = mergeTopLevel(mergeEngineValues(get().caps, data?.capabilities), data)
        // 引擎没起来时用户改过的键以本地为准，随后补推，别被引擎的旧值盖掉。
        const next = { ...merged, ...(deferred as unknown as Partial<Capabilities>) }
        persist(next)
        set({ caps: next })

        const pending = deferred
        deferred = {}
        if (!Object.keys(pending).length) return
        if (!(await pushToEngine(pending))) {
          deferred = { ...pending, ...deferred }
          toast.error('保存到引擎失败', {
            id: SAVE_ERROR_TOAST,
            description: '本地设置已保留，但引擎侧没有写入。',
          })
        }
      } catch { /* 引擎没就绪 / 请求失败：保持 localStorage 现值，不打扰用户 */ }
    },
  }
})

/* 引擎就绪时同步一次：无壳或浏览器直跑时 ready 永远是 false，这里就是空转。 */
useEngine.subscribe((state, prev) => {
  if (state.ready && !prev.ready) void useCapabilities.getState().syncFromEngine()
})
// 引擎已经就绪而模块才加载（延迟 import / 热更新）：立刻补一次。
if (useEngine.getState().ready) void useCapabilities.getState().syncFromEngine()
