import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { PermissionMode } from '@/protocol/commands'
import { apiGet, apiSend } from '@/bridge/http'

export interface ProviderConfig {
  id: string; name: string; apiKeyMasked: string; hasKey?: boolean
  models: string[]; baseUrl?: string
  type?: string; model?: string; fastModel?: string | null; toolProtocol?: string
  contextWindow?: number
  supportsWebSearch?: boolean
  supportsVision?: boolean
  active?: boolean
}

export interface ProviderInput {
  id: string; name: string; apiKey: string; models: string[]
  baseUrl?: string; type?: string; toolProtocol?: string; contextWindow?: number
  fastModel?: string | null; activate?: boolean; supportsWebSearch?: boolean; supportsVision?: boolean
}

export const PERMISSION_MODES: { mode: PermissionMode; label: string; desc: string }[] = [
  { mode: 'ask', label: '询问', desc: '每个写入/破坏性操作前都确认' },
  { mode: 'auto', label: '自动', desc: '读写自动放行，仅破坏性需确认' },
  { mode: 'full', label: '放行', desc: '全部自动执行（仅信任场景）' },
]

/** 主题三档：system 跟随系统、light 明亮、dark 夜间。 */
export type ThemeMode = 'system' | 'light' | 'dark'
export const THEME_MODES: { mode: ThemeMode; label: string; desc: string }[] = [
  { mode: 'system', label: '跟随系统', desc: '与手机系统深浅色保持一致' },
  { mode: 'light', label: '明亮模式', desc: '始终使用浅色界面' },
  { mode: 'dark', label: '夜间模式', desc: '始终使用深色界面' },
]

/** 取当前主题档位：优先 Android 原生偏好（JS 桥），其次 localStorage，默认跟随系统。 */
export function readThemeMode(): ThemeMode {
  const bridge = (window as any).CoomiAndroid
  if (bridge && typeof bridge.getThemeMode === 'function') {
    try {
      const v = String(bridge.getThemeMode() ?? '')
      if (v === 'light' || v === 'dark' || v === 'system') return v
    } catch { /* 桥未就绪时走 localStorage */ }
  }
  const saved = localStorage.getItem('coomi.themeMode')
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
}

/** 写入 <html data-theme>，前端 global.css 据此切换暗色主题。 */
export function applyTheme(mode: ThemeMode) {
  const dark = mode === 'dark'
    || (mode === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}

// 浏览器独立开发时的兜底数据（后端不可达时使用）
const MOCK_PROVIDERS: ProviderConfig[] = [
  { id: 'openai', name: 'OpenAI', apiKeyMasked: '****a1b2', hasKey: true, models: ['gpt-4o', 'gpt-4o-mini'], baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', apiKeyMasked: '****9f3c', hasKey: true, models: ['claude-sonnet-4', 'claude-opus-4'] },
]

export const useConfigStore = defineStore('config', () => {
  const savedPermission = localStorage.getItem('coomi.permissionMode') as PermissionMode | null
  const permissionMode = ref<PermissionMode>(['ask', 'auto', 'full'].includes(savedPermission ?? '') ? savedPermission! : 'ask')
  const planMode = ref(false)
  const themeMode = ref<ThemeMode>(readThemeMode())

  const providers = ref<ProviderConfig[]>([])
  const activeId = ref('')
  const loading = ref(false)
  const usingMock = ref(false)
  const lastError = ref<string | null>(null)

  const currentProviderId = ref('')
  const currentModel = ref('')
  const currentProvider = computed(() => providers.value.find(p => p.id === currentProviderId.value) ?? null)

  function applyList(list: ProviderConfig[], active: string) {
    providers.value = list
    activeId.value = active
    // 同步当前选择：优先 active，其次第一个
    const sel = list.find(p => p.id === active) ?? list[0]
    if (sel) {
      const savedProvider = localStorage.getItem('coomi.providerId')
      const savedModel = localStorage.getItem('coomi.model')
      const saved = list.find(p => p.id === savedProvider && p.models.includes(savedModel ?? ''))
      currentProviderId.value = saved?.id ?? sel.id
      currentModel.value = savedModel && saved ? savedModel : (sel.model || sel.models[0] || '')
    }
  }

  /** 从后端拉取 Provider 列表；失败则用 mock 兜底（浏览器独立开发）。 */
  async function fetchProviders() {
    loading.value = true
    lastError.value = null
    try {
      const data = await apiGet<{ providers: ProviderConfig[]; active: string }>('/api/providers')
      usingMock.value = false
      applyList(data.providers ?? [], data.active ?? '')
    } catch (e) {
      usingMock.value = true
      lastError.value = String(e)
      applyList(MOCK_PROVIDERS, 'openai')
    } finally {
      loading.value = false
    }
  }

  function selectModel(providerId: string, model: string) {
    currentProviderId.value = providerId; currentModel.value = model
    localStorage.setItem('coomi.providerId', providerId)
    localStorage.setItem('coomi.model', model)
  }
  function setPermissionMode(mode: PermissionMode) {
    permissionMode.value = mode
    localStorage.setItem('coomi.permissionMode', mode)
  }

  /**
   * 三档主题。应用后：
   * - 写入 <html data-theme>（前端样式即时切换）；
   * - Android WebView 内通知原生（CoomiAndroid.setThemeMode），原生据此改状态栏
   *   颜色并重新注入 data-theme；桌面浏览器直接由 applyTheme 生效。
   */
  function setThemeMode(mode: ThemeMode) {
    themeMode.value = mode
    localStorage.setItem('coomi.themeMode', mode)
    applyTheme(mode)
    const bridge = (window as any).CoomiAndroid
    if (bridge && typeof bridge.setThemeMode === 'function') {
      try { bridge.setThemeMode(mode) } catch { /* 忽略桥异常 */ }
    }
  }
  function cyclePermissionMode(): PermissionMode {
    const order: PermissionMode[] = ['ask', 'auto', 'full']
    const idx = order.indexOf(permissionMode.value)
    permissionMode.value = order[(idx + 1) % order.length]
    return permissionMode.value
  }
  function togglePlanMode() { planMode.value = !planMode.value }

  /**
   * 全局会话记忆：关闭（默认）时 Coomi 无法读取任何历史会话文件；
   * 开启后它才能读取所有历史会话记录。历史会话列表始终可见，与本开关无关。
   * 引擎 settings.json 是权威值；localStorage 只是 UI 缓存，启动时以引擎为准。
   */
  const globalMemory = ref(localStorage.getItem('coomi.globalMemory') === '1')
  /** 从引擎拉取权威值（应用启动时调用），覆盖本地缓存与开关显示。 */
  async function syncGlobalMemoryFromEngine() {
    try {
      const data = await apiGet<{ enabled: boolean }>('/api/runtime/global-memory')
      const enabled = !!data?.enabled
      globalMemory.value = enabled
      localStorage.setItem('coomi.globalMemory', enabled ? '1' : '0')
    } catch {
      /* 引擎未就绪：保持本地缓存，稍后用户操作开关时会再次同步 */
    }
  }
  async function toggleGlobalMemory() {
    const previous = globalMemory.value
    const next = !previous
    globalMemory.value = next
    localStorage.setItem('coomi.globalMemory', next ? '1' : '0')
    // 同步引擎侧：关闭时引擎屏蔽会话/配置目录的工具访问 + 系统提示加隐私禁令。
    // 失败必须回滚并提示，否则会出现「开关显示关、引擎实际开着」的脱节。
    try {
      await apiSend('/api/runtime/global-memory', 'POST', { enabled: next })
    } catch {
      globalMemory.value = previous
      localStorage.setItem('coomi.globalMemory', previous ? '1' : '0')
      throw new Error('同步引擎失败，开关已还原')
    }
  }

  /** 新增/更新 Provider。空 apiKey 表示沿用旧 key（后端语义）。 */
  async function upsertProvider(input: ProviderInput): Promise<boolean> {
    if (usingMock.value) {
      // 浏览器兜底：仅本地更新，不落盘
      const masked = input.apiKey ? '****' + input.apiKey.slice(-4) : '****'
      const existing = providers.value.find(p => p.id === input.id)
      if (existing) { existing.name = input.name; existing.apiKeyMasked = masked; existing.models = input.models; existing.baseUrl = input.baseUrl; existing.type = input.type; existing.toolProtocol = input.toolProtocol; existing.contextWindow = input.contextWindow }
      else { providers.value.push({ id: input.id, name: input.name, apiKeyMasked: masked, hasKey: !!input.apiKey, models: input.models, baseUrl: input.baseUrl, type: input.type, toolProtocol: input.toolProtocol, contextWindow: input.contextWindow }) }
      return true
    }
    try {
      await apiSend('/api/providers', 'POST', {
        id: input.id,
        name: input.name,
        apiKey: input.apiKey,
        models: input.models,
        model: input.models[0],
        baseUrl: input.baseUrl,
        type: input.type,
        toolProtocol: input.toolProtocol,
        contextWindow: input.contextWindow,
        fastModel: input.fastModel,
        supportsWebSearch: input.supportsWebSearch,
        supportsVision: input.supportsVision,
        activate: input.activate,
      })
      await fetchProviders()
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function deleteProvider(id: string): Promise<boolean> {
    if (usingMock.value) {
      providers.value = providers.value.filter(p => p.id !== id)
      return true
    }
    try {
      await apiSend(`/api/providers/${encodeURIComponent(id)}`, 'DELETE')
      await fetchProviders()
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function activateProvider(id: string): Promise<boolean> {
    if (usingMock.value) { activeId.value = id; return true }
    try {
      await apiSend(`/api/providers/${encodeURIComponent(id)}/activate`, 'POST')
      await fetchProviders()
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function copyProvider(id: string): Promise<string | null> {
    try {
      const result = await apiSend<{ id: string }>(`/api/providers/${encodeURIComponent(id)}/copy`, 'POST')
      await fetchProviders()
      return result.id
    } catch (e) {
      lastError.value = String(e)
      return null
    }
  }

  async function revealProviderKey(id: string): Promise<string | null> {
    try {
      const result = await apiSend<{ apiKey: string }>(`/api/providers/${encodeURIComponent(id)}/reveal`, 'POST')
      return result.apiKey
    } catch (e) {
      lastError.value = String(e)
      return null
    }
  }

  async function discoverModels(id: string): Promise<string[] | null> {
    try {
      const result = await apiSend<{ models: string[] }>(`/api/providers/${encodeURIComponent(id)}/discover-models`, 'POST')
      await fetchProviders()
      return result.models
    } catch (e) {
      lastError.value = String(e)
      return null
    }
  }

  return {
    permissionMode, planMode, themeMode, globalMemory, providers, activeId, loading, usingMock, lastError,
    currentProviderId, currentModel, currentProvider,
    fetchProviders, selectModel, setPermissionMode, setThemeMode, cyclePermissionMode, togglePlanMode,
    toggleGlobalMemory, syncGlobalMemoryFromEngine,
    upsertProvider, deleteProvider, activateProvider, copyProvider, revealProviderKey, discoverModels,
  }
})
