/** 执行偏好：思考强度与任务放行程度。引擎侧持久化在 settings.json / web-settings.json，
 *  同时用 WS 命令让当前连接立即生效。 */
import { create } from 'zustand'
import { useEngine } from './engine'
import { useSession } from './session'
import { toast } from 'sonner'

export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra'
export type PermissionMode = 'ask' | 'auto' | 'full'

/** 厂商配置（/api/providers 的条目）。
    以前这个类型与这份数据都只活在 Composer 的局部 state 里：组件一卸载就归零，
    切回对话页会先被判成「还没有配置模型」（横幅闪一下）。搬到这里由 store 常驻。 */
export interface Provider { id: string; name?: string; model?: string; models?: string[]; active?: boolean }

export const EFFORT_LABELS: Array<{ value: ReasoningEffort; label: string; hint: string }> = [
  { value: 'auto', label: '自动', hint: '交给模型自己判断' },
  { value: 'low', label: '低', hint: '快，适合简单任务' },
  { value: 'medium', label: '中', hint: '默认平衡' },
  { value: 'high', label: '高', hint: '复杂任务更稳' },
  { value: 'xhigh', label: '极高', hint: '慢，但推理更深' },
  { value: 'ultra', label: '极限', hint: '最慢，最难的问题' },
]

export const PERMISSION_LABELS: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'ask', label: '每次询问', hint: '危险操作先确认' },
  { value: 'auto', label: '自动放行', hint: '读写放行，删除询问' },
  { value: 'full', label: '完全放行', hint: '全部放行，含删除' },
]

export interface ReasoningStatus { providerId: string; model: string; requested: string; mode: 'configured' | 'unconfigured' | 'standard-unverified'; selectableLevels: string[]; field: string; wireValue: unknown; sent: boolean; verified: boolean }
interface AgentState {
  reasoningStatus: ReasoningStatus | null
  effortSaving: boolean
  effortError: string
  effort: ReasoningEffort
  permission: PermissionMode
  maxToolRounds: number
  /** 瞬时故障（429 限流等）自动重试次数（引擎新语义）：0 = 关闭；1–254 = 次数；
   255 = 无限（一直自动重试直到成功或非瞬时错误）。默认 2。
   *  与 /api/connection/settings 的 providerRetryCount 是同一份配置键。 */
  providerRetryCount: number
  /** 重连最大退避延迟（ms）：引擎侧 clamp 1000–120000，默认 10000（界面用秒展示）。 */
  reconnectMaxDelayMs: number
  loaded: boolean
  /** 厂商配置（providers）的版本号：设置页保存 / 删除 / 激活 / 切换模型后 +1。
      订阅它的页面（对话页的模型选择器）据此重新拉 /api/providers ——
      以前只有设置页刷新自己那份，回到对话页还是旧列表，
      于是刚加完厂商却被提示「还没有配置模型」（2026-09-29）。 */
  providerRevision: number
  /** 厂商列表。放 store 而不是组件里：切走再切回不归零，横幅的根因随之消失。 */
  providers: Provider[]
  /** 是否**成功**拉到过一次厂商列表：三态里的第三态（「没拉到」≠「没有配置」）。 */
  providersLoaded: boolean
  /** 上次成功拉取时 providerRevision 的值：据此判断手里这份是否已经过期。 */
  providersRevision: number
  bumpProviders: () => void
  /** 拉 /api/providers：已有且没过期就直接复用（切页重挂载走这条），force=true 无条件重拉。 */
  loadProviders: (force?: boolean) => Promise<void>
  load: () => Promise<void>
  setEffort: (v: ReasoningEffort) => Promise<void>
  setPermission: (v: PermissionMode) => Promise<void>
  setMaxToolRounds: (n: number) => Promise<void>
  setProviderRetryCount: (n: number) => Promise<void>
  setReconnectMaxDelayMs: (ms: number) => Promise<void>
}

/** 正在飞的那一次 /api/providers（in-flight 去重）：
    Composer 重挂载与 providerRevision 自增可能几乎同时发生，复用同一个 Promise
    就不会打出两条重复请求。模块级即可 —— 整个应用只有一个 store 实例。 */
let providersInFlight: Promise<void> | null = null
let preferencesRequest = 0

export const useAgent = create<AgentState>((set, get) => ({
  effort: 'auto',
  reasoningStatus: null, effortSaving: false, effortError: '',
  permission: 'ask',
  maxToolRounds: 192,
  // 与引擎 configured_connection_settings 的默认值一致（2 次 / 10s）。
  providerRetryCount: 2,
  reconnectMaxDelayMs: 10000,
  loaded: false,
  providerRevision: 0,
  providers: [],
  providersLoaded: false,
  providersRevision: -1,

  load: async () => {
    const request = ++preferencesRequest
    const endpoint = useEngine.getState().port + ":" + useEngine.getState().token
    try {
      const session = useSession.getState()
      const selector = session.currentProviderId && session.currentModel ? session.currentProviderId + ':' + session.currentModel : ''
      const d = await useEngine.getState().api<{ reasoningStatus?: ReasoningStatus; reasoningEffort?: string; permissionMode?: string; maxToolRounds?: number; providerRetryCount?: number; reconnectMaxDelayMs?: number }>('/api/agent/preferences' + (selector ? '?selector=' + encodeURIComponent(selector) : ''))
      const current = useSession.getState()
      if (request !== preferencesRequest || endpoint !== useEngine.getState().port + ":" + useEngine.getState().token) return
      if (selector && selector !== current.currentProviderId + ':' + current.currentModel) return
      set({
        effort: get().effortSaving ? get().effort : (d.reasoningEffort as ReasoningEffort) ?? 'auto',
        reasoningStatus: d.reasoningStatus ?? null,
        permission: (d.permissionMode as PermissionMode) ?? 'ask',
        maxToolRounds: d.maxToolRounds ?? 192,
        providerRetryCount: d.providerRetryCount ?? 2,
        reconnectMaxDelayMs: d.reconnectMaxDelayMs ?? 10000,
        loaded: true,
      })
    } catch { /* 引擎未就绪时保持默认 */ }
  },

  setEffort: async (v) => {
    if (get().effortSaving) return
    const previous = get().effort
    set({ effort: v, effortSaving: true, effortError: '' })
    try {
      await useEngine.getState().api('/api/agent/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reasoningEffort: v }) })
      useSession.getState().sendCommand({ command: 'set_reasoning_effort', effort: v })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ effort: previous, effortError: message })
      toast.error('思考强度未保存', { description: message })
    } finally {
      set({ effortSaving: false })
    }
    await get().load()
  },

  setPermission: async (v) => {
    set({ permission: v })
    useSession.getState().sendCommand({ command: 'set_permission_mode', mode: v })
    try { await useEngine.getState().api('/api/agent/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionMode: v }) }) } catch { /* 忽略 */ }
    void get().load()
  },

  loadProviders: async (force) => {
    // 手里这份是成功的、且厂商版本没变过 → 直接复用，不打网络。
    // 这就是「切回对话页不再闪空态」的关键：数据常驻 store，重挂载只是复用。
    const upToDate = (): boolean => {
      const s = get()
      return s.providersLoaded && s.providersRevision === s.providerRevision
    }
    if (!force && upToDate()) return
    if (providersInFlight) {
      // 复用正在飞的那次（in-flight 去重）；但它可能是在厂商变更**之前**发出的，
      // 所以落地后要按同一套判据复核一遍，不够新就补一次。
      const flying = providersInFlight
      await flying
      if (upToDate()) return
      if (providersInFlight && providersInFlight !== flying) return providersInFlight
    }
    const revision = get().providerRevision
    const run = (async () => {
      try {
        const d = await useEngine.getState().api<{ providers?: Provider[] }>('/api/providers')
        set({ providers: d.providers ?? [], providersLoaded: true, providersRevision: revision })
      } catch {
        /* 引擎未就绪：保持原样 —— **不能**在这里置 providersLoaded，
           否则「加载失败」会被三态判定当成「确实没有配置」，又回到误报横幅。 */
      }
    })()
    providersInFlight = run
    try { await run } finally {
      // 无论成败都要清空：留着一个已 settle 的旧 Promise 会让后续每次都立刻拿到它而什么都不做。
      if (providersInFlight === run) providersInFlight = null
    }
  },

  /** 厂商配置变了：让所有订阅方重新拉一次（幂等，调用方不用管有没有页面在听）。 */
  bumpProviders: () => set((state) => ({ providerRevision: state.providerRevision + 1 })),

  setMaxToolRounds: async (n) => {
    set({ maxToolRounds: n })
    try { await useEngine.getState().api('/api/agent/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxToolRounds: n }) }) } catch { /* 忽略 */ }
  },

  setProviderRetryCount: async (n) => {
    set({ providerRetryCount: n })
    try {
      await useEngine.getState().api('/api/agent/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerRetryCount: n }) })
    } catch { /* 引擎未就绪 / 写入失败：下面的回读会把本地还原成引擎侧有效值 */ }
    // 回读：PUT 成功后引擎可能夹紧 / 取整，界面显示以它返回的有效值为准。
    void get().load()
  },

  setReconnectMaxDelayMs: async (ms) => {
    set({ reconnectMaxDelayMs: ms })
    try {
      await useEngine.getState().api('/api/agent/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reconnectMaxDelayMs: ms }) })
    } catch { /* 同上 */ }
    void get().load()
  },
}))
