import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { PermissionMode, ReasoningEffort } from '@/protocol/commands'
import { apiGet, apiSend } from '@/bridge/http'

export interface ProviderConfig {
  id: string; name: string; apiKeyMasked: string; hasKey?: boolean
  models: string[]; baseUrl?: string
  type?: string; model?: string; fastModel?: string | null; toolProtocol?: string
  contextWindow?: number
  modelContextWindows?: Record<string, number>
  supportsWebSearch?: boolean
  supportsVision?: boolean
  active?: boolean
  builtin?: boolean
  status?: ProviderStatus
  modelDescriptions?: Record<string, string>
  modelParameters?: Record<string, ModelParameters>
  capabilityOverrides?: Record<string, CapabilityOverride>
}

export interface ModelParameters {
  temperature?: number
  topK?: number
  topP?: number
  maxOutputTokens?: number
  reasoningEffort?: string
  reasoningField?: string
  reasoningMapping?: Partial<Record<'low' | 'medium' | 'high' | 'xhigh', string>>
}
export interface CapabilityOverride { text?: boolean; vision?: boolean; image_generation?: boolean; reasoning?: boolean }
export interface SubAgentConfig { id: string; providerId: string; model: string; description?: string }
export interface SubAgentSettings { agents: SubAgentConfig[]; fallbackId?: string; maxAgents: number }
export interface CollaborationSettings {
  coderSelector: string
  reviewerSelector: string
  coderPrompt: string
  reviewerPrompt: string
  maxCycles: number
  reviewTests: boolean
}

export type ProviderProtocol = 'openai_compatible' | 'openai_responses' | 'anthropic_messages' | 'gemini_native'
export type ProviderStatus = 'unconfigured' | 'configured' | 'current'

export interface ConnectionSettings {
  providerRetryCount: number
  wsRetryCount: number
  reconnectInitialDelayMs: number
  reconnectMaxDelayMs: number
  maxConcurrentTasks: number
}

export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = {
  providerRetryCount: 2,
  wsRetryCount: 10,
  reconnectInitialDelayMs: 500,
  reconnectMaxDelayMs: 10_000,
  maxConcurrentTasks: 5,
}

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  protocol: ProviderProtocol
}

export const BUILTIN_PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai_compatible' },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', protocol: 'openai_compatible' },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', protocol: 'openai_compatible' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai_responses' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic_messages' },
  { id: 'google', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini_native' },
  { id: 'opencode', name: 'OpenCode', baseUrl: 'https://opencode.ai/zen/go/v1', protocol: 'openai_compatible' },
]

export interface ProviderInput {
  id: string; name: string; apiKey: string; models: string[]
  baseUrl?: string; type?: string; toolProtocol?: string; contextWindow?: number
  modelContextWindows?: Record<string, number>
  fastModel?: string | null; activate?: boolean; supportsWebSearch?: boolean; supportsVision?: boolean
  modelDescriptions?: Record<string, string>; modelParameters?: Record<string, ModelParameters>
  capabilityOverrides?: Record<string, CapabilityOverride>
}

export function providerStatus(provider: ProviderConfig, activeId: string): ProviderStatus {
  // A manually entered model is valid even when the provider catalog could
  // not be fetched (for example Volcengine Ark's intermittent `/models`).
  const configured = Boolean(provider.hasKey && (provider.models.length > 0 || provider.model?.trim()))
  if (configured && provider.id === activeId) return 'current'
  return configured ? 'configured' : 'unconfigured'
}

export function mergeProviderList(configured: ProviderConfig[], activeId: string): ProviderConfig[] {
  const configuredById = new Map(configured.map(provider => [provider.id, provider]))
  const builtInIds = new Set(BUILTIN_PROVIDER_PRESETS.map(preset => preset.id))
  const builtIns = BUILTIN_PROVIDER_PRESETS.map(preset => {
    const saved = configuredById.get(preset.id)
    const provider: ProviderConfig = {
      id: preset.id,
      name: saved?.name || preset.name,
      apiKeyMasked: saved?.apiKeyMasked || '',
      hasKey: Boolean(saved?.hasKey),
      models: saved?.models ?? [],
      baseUrl: saved?.baseUrl || preset.baseUrl,
      type: saved?.type || preset.protocol,
      model: saved?.model,
      fastModel: saved?.fastModel,
      toolProtocol: saved?.toolProtocol || preset.protocol,
      contextWindow: saved?.contextWindow ?? 256000,
      modelContextWindows: { ...(saved?.modelContextWindows ?? {}) },
      supportsWebSearch: saved?.supportsWebSearch ?? false,
      supportsVision: saved?.supportsVision ?? false,
      modelDescriptions: { ...(saved?.modelDescriptions ?? {}) },
      modelParameters: { ...(saved?.modelParameters ?? {}) },
      capabilityOverrides: { ...(saved?.capabilityOverrides ?? {}) },
      active: activeId === preset.id,
      builtin: true,
    }
    provider.status = providerStatus(provider, activeId)
    return provider
  })
  const custom = configured
    .filter(provider => !builtInIds.has(provider.id))
    .map(provider => ({ ...provider, builtin: false, status: providerStatus(provider, activeId) }))
  return [...builtIns, ...custom]
}

export const PERMISSION_MODES: { mode: PermissionMode; label: string; desc: string }[] = [
  { mode: 'ask', label: '询问', desc: '每个写入/破坏性操作前都确认' },
  { mode: 'auto', label: '自动', desc: '读写自动放行，仅破坏性需确认' },
  { mode: 'full', label: '放行', desc: '全部自动执行（仅信任场景）' },
]

export type ThemeMode = 'system' | 'light' | 'dark' | 'book' | 'orange' | 'ink' | 'abyss' | 'ember' | 'celadon' | 'linen'
const THEME_VALUES: ThemeMode[] = ['system', 'light', 'dark', 'book', 'orange', 'ink', 'abyss', 'ember', 'celadon', 'linen']
export const THEME_MODES: { mode: ThemeMode; label: string; desc: string }[] = [
  { mode: 'system', label: '跟随系统', desc: '与手机系统深浅色保持一致' },
  { mode: 'light', label: '明亮模式', desc: '始终使用浅色界面' },
  { mode: 'dark', label: '夜间模式', desc: '始终使用深色界面' },
  { mode: 'book', label: '书卷纸', desc: '柔和纸张底色与墨绿色点缀' },
  { mode: 'orange', label: '橙白', desc: '明快白色底面与暖橙色点缀' },
  { mode: 'ink', label: '墨玉', desc: '墨黑底面与温润玉绿色点缀' },
  { mode: 'abyss', label: '深海', desc: '深海蓝黑底面与清冷青蓝点缀' },
  { mode: 'ember', label: '炭褐', desc: '炭黑褐底面与余烬铜色点缀' },
  { mode: 'celadon', label: '青瓷', desc: '青瓷浅灰底面与釉绿色点缀' },
  { mode: 'linen', label: '亚麻', desc: '自然亚麻白底面与沉静靛色点缀' },
]

export const REASONING_EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
]

/** 取当前主题档位：优先 Android 原生偏好（JS 桥），其次 localStorage，默认跟随系统。 */
export function readThemeMode(): ThemeMode {
  const bridge = (window as any).CoomiAndroid
  if (bridge && typeof bridge.getThemeMode === 'function') {
    try {
      const v = String(bridge.getThemeMode() ?? '')
      if (THEME_VALUES.includes(v as ThemeMode)) return v as ThemeMode
    } catch { /* 桥未就绪时走 localStorage */ }
  }
  const saved = localStorage.getItem('coomi.themeMode')
  return THEME_VALUES.includes(saved as ThemeMode) ? saved as ThemeMode : 'system'
}

/** 写入 <html data-theme>，前端 global.css 据此切换暗色主题。 */
export function applyTheme(mode: ThemeMode) {
  const dark = mode === 'dark'
    || (mode === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : mode === 'system' ? 'light' : mode)
}

// 浏览器独立开发时的兜底数据（后端不可达时使用）
const MOCK_PROVIDERS: ProviderConfig[] = [
  { id: 'openai', name: 'OpenAI', apiKeyMasked: '****a1b2', hasKey: true, models: ['gpt-4o', 'gpt-4o-mini'], baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', apiKeyMasked: '****9f3c', hasKey: true, models: ['claude-sonnet-4', 'claude-opus-4'] },
]

/**
 * 模型名展示净化：剔除私有区/零宽/变体选择等「豆腐块」字符。
 * 仅影响显示；API 调用仍使用未净化的原始模型 ID。
 * 典型场景：从网页文档复制模型名时带进了图标字体字符（如 deepseek-□4-flash）。
 */
export function displayModelName(name: string): string {
  if (!name) return name
  const cleaned = name.replace(/[-​-‏‪-‮⁠-⁤︀-️￰-￿]/g, '')
  return cleaned || name
}

export const useConfigStore = defineStore('config', () => {
  const savedPermission = localStorage.getItem('coomi.permissionMode') as PermissionMode | null
  const permissionMode = ref<PermissionMode>(['ask', 'auto', 'full'].includes(savedPermission ?? '') ? savedPermission! : 'ask')
  const planMode = ref(false)
  const themeMode = ref<ThemeMode>(readThemeMode())
  const savedEffort = localStorage.getItem('coomi.reasoningEffort') as ReasoningEffort | null
  const reasoningEffort = ref<ReasoningEffort>(REASONING_EFFORTS.some(item => item.value === savedEffort) ? savedEffort! : 'auto')
  const savedRounds = Number(localStorage.getItem('coomi.maxToolRounds'))
  const maxToolRounds = ref([192, 256, 512].includes(savedRounds) ? savedRounds : 192)
  const subAgentSettings = ref<SubAgentSettings>({ agents: [], maxAgents: 20 })
  const collaborationSettings = ref<CollaborationSettings>({
    coderSelector: '', reviewerSelector: '', coderPrompt: '', reviewerPrompt: '', maxCycles: 2, reviewTests: true,
  })
  const connectionSettings = ref<ConnectionSettings>({
    providerRetryCount: readStoredInt('coomi.providerRetryCount', 0, 10, DEFAULT_CONNECTION_SETTINGS.providerRetryCount),
    wsRetryCount: readStoredInt('coomi.wsRetryCount', 0, 30, DEFAULT_CONNECTION_SETTINGS.wsRetryCount),
    reconnectInitialDelayMs: readStoredInt('coomi.reconnectInitialDelayMs', 500, 60_000, DEFAULT_CONNECTION_SETTINGS.reconnectInitialDelayMs),
    reconnectMaxDelayMs: readStoredInt('coomi.reconnectMaxDelayMs', 1_000, 120_000, DEFAULT_CONNECTION_SETTINGS.reconnectMaxDelayMs),
    maxConcurrentTasks: readStoredInt('coomi.maxConcurrentTasks', 1, 20, DEFAULT_CONNECTION_SETTINGS.maxConcurrentTasks),
  })

  const providers = ref<ProviderConfig[]>([])
  const activeId = ref('')
  const loading = ref(false)
  const usingMock = ref(false)
  const lastError = ref<string | null>(null)

  const currentProviderId = ref('')
  const currentModel = ref('')
  const currentProvider = computed(() => providers.value.find(p => p.id === currentProviderId.value) ?? null)
  const mergedProviders = computed(() => mergeProviderList(providers.value, activeId.value))

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
    } else {
      currentProviderId.value = ''
      currentModel.value = ''
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
  function setReasoningEffort(effort: ReasoningEffort) {
    reasoningEffort.value = effort
    localStorage.setItem('coomi.reasoningEffort', effort)
  }
  function setMaxToolRounds(rounds: number) {
    maxToolRounds.value = [192, 256, 512].includes(rounds) ? rounds : 192
    localStorage.setItem('coomi.maxToolRounds', String(maxToolRounds.value))
  }

  function cacheConnectionSettings(value: ConnectionSettings) {
    connectionSettings.value = { ...value }
    localStorage.setItem('coomi.providerRetryCount', String(value.providerRetryCount))
    localStorage.setItem('coomi.wsRetryCount', String(value.wsRetryCount))
    localStorage.setItem('coomi.reconnectInitialDelayMs', String(value.reconnectInitialDelayMs))
    localStorage.setItem('coomi.reconnectMaxDelayMs', String(value.reconnectMaxDelayMs))
    localStorage.setItem('coomi.maxConcurrentTasks', String(value.maxConcurrentTasks))
  }

  async function fetchConnectionSettings(): Promise<boolean> {
    try {
      const value = await apiGet<ConnectionSettings>('/api/settings/connection')
      cacheConnectionSettings(value)
      return true
    } catch {
      return false
    }
  }

  async function saveConnectionSettings(value: ConnectionSettings): Promise<boolean> {
    const normalized: ConnectionSettings = {
      providerRetryCount: Math.trunc(value.providerRetryCount),
      wsRetryCount: Math.trunc(value.wsRetryCount),
      reconnectInitialDelayMs: Math.trunc(value.reconnectInitialDelayMs),
      reconnectMaxDelayMs: Math.trunc(value.reconnectMaxDelayMs),
      maxConcurrentTasks: Math.trunc(value.maxConcurrentTasks),
    }
    if (normalized.providerRetryCount < 0 || normalized.providerRetryCount > 10
      || normalized.wsRetryCount < 0 || normalized.wsRetryCount > 30
      || normalized.reconnectInitialDelayMs < 500 || normalized.reconnectInitialDelayMs > 60_000
      || normalized.reconnectMaxDelayMs < 1_000 || normalized.reconnectMaxDelayMs > 120_000
      || normalized.maxConcurrentTasks < 1 || normalized.maxConcurrentTasks > 20
      || normalized.reconnectMaxDelayMs < normalized.reconnectInitialDelayMs) return false
    try {
      const saved = await apiSend<ConnectionSettings>('/api/settings/connection', 'PUT', normalized)
      cacheConnectionSettings(saved)
      return true
    } catch {
      return false
    }
  }

  /**
   * 三档主题。应用后：
   * - 写入 <html data-theme>（前端样式即时切换）；
   * - Android WebView 内通知原生（CoomiAndroid.setThemeMode），原生据此改状态栏
   *   颜色并重新注入 data-theme；桌面浏览器直接由 applyTheme 生效。
   */
  function setThemeMode(mode: ThemeMode) {
    if (document.documentElement.dataset.customAppearance === 'true') return
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
  const digitalLifeEnabled = ref(localStorage.getItem('coomi.digitalLifeEnabled') === '1')
  /** 数字生命体「用于全局会话」：开启后所有对话都带生命体人格（引擎侧 settings.globalMode 为权威）。 */
  const lifeGlobalMode = ref(localStorage.getItem('coomi.lifeGlobalMode') === '1')

  function setLifeGlobalMode(enabled: boolean) {
    lifeGlobalMode.value = enabled
    localStorage.setItem('coomi.lifeGlobalMode', enabled ? '1' : '0')
  }

  function syncDigitalLifeEnabled() {
    const bridge = (window as any).CoomiAndroid
    if (bridge && typeof bridge.getDigitalLifeEnabled === 'function') {
      try { digitalLifeEnabled.value = !!bridge.getDigitalLifeEnabled() } catch { /* 使用本地缓存 */ }
    }
    localStorage.setItem('coomi.digitalLifeEnabled', digitalLifeEnabled.value ? '1' : '0')
  }

  async function fetchSubAgentSettings(): Promise<boolean> {
    if (usingMock.value) return true
    try {
      const data = await apiGet<SubAgentSettings>('/api/settings/subagents')
      subAgentSettings.value = {
        agents: (data.agents ?? []).map(agent => ({ ...agent })),
        fallbackId: data.fallbackId,
        maxAgents: Math.max(1, Math.min(30, data.maxAgents || 20)),
      }
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function saveSubAgentSettings(value: SubAgentSettings): Promise<boolean> {
    if (usingMock.value) {
      subAgentSettings.value = {
        agents: value.agents.map(agent => ({ ...agent })),
        fallbackId: value.fallbackId,
        maxAgents: value.maxAgents,
      }
      return true
    }
    try {
      const saved = await apiSend<SubAgentSettings>('/api/settings/subagents', 'PUT', value)
      subAgentSettings.value = {
        agents: (saved.agents ?? []).map(agent => ({ ...agent })),
        fallbackId: saved.fallbackId,
        maxAgents: Math.max(1, Math.min(30, saved.maxAgents || value.maxAgents)),
      }
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function fetchCollaborationSettings(): Promise<boolean> {
    if (usingMock.value) return true
    try {
      const data = await apiGet<CollaborationSettings>('/api/settings/collaboration')
      collaborationSettings.value = { ...collaborationSettings.value, ...data }
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function saveCollaborationSettings(value: CollaborationSettings): Promise<boolean> {
    const normalized = {
      ...value,
      coderSelector: value.coderSelector.trim(),
      reviewerSelector: value.reviewerSelector.trim(),
      maxCycles: Math.max(1, Math.min(3, Math.trunc(value.maxCycles))),
    }
    if (usingMock.value) {
      collaborationSettings.value = normalized
      return true
    }
    try {
      const saved = await apiSend<CollaborationSettings>('/api/settings/collaboration', 'PUT', normalized)
      collaborationSettings.value = { ...collaborationSettings.value, ...saved }
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }
  async function validateAndSelectModel(providerId: string, model: string): Promise<boolean> {
    try {
      await apiSend(`/api/providers/${encodeURIComponent(providerId)}/select-model`, 'POST', { model })
      selectModel(providerId, model)
      activeId.value = providerId
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  function setDigitalLifeEnabled(enabled: boolean) {
    digitalLifeEnabled.value = enabled
    localStorage.setItem('coomi.digitalLifeEnabled', enabled ? '1' : '0')
    const bridge = (window as any).CoomiAndroid
    if (bridge && typeof bridge.setDigitalLifeEnabled === 'function') {
      try { bridge.setDigitalLifeEnabled(enabled) } catch { /* 本地状态仍可用 */ }
    }
  }
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

  /**
   * 定制身份提示词：用户设置的专属身份/定位指令，保存后注入系统提示词，
   * 让 AI 认知自己的身份与定位。引擎 settings.json 是权威值；
   * localStorage 只做 UI 缓存。
   */
  const customPrompt = ref(localStorage.getItem('coomi.customPrompt') ?? '')
  /** 从引擎拉取权威值（应用启动 / 进入设置页时调用）。 */
  async function fetchCustomPrompt() {
    try {
      const data = await apiGet<{ text: string }>('/api/runtime/custom-prompt')
      customPrompt.value = data?.text ?? ''
      localStorage.setItem('coomi.customPrompt', customPrompt.value)
      return true
    } catch {
      return false
    }
  }
  /** 保存定制提示词；空文本表示清除。成功返回 true。 */
  async function saveCustomPrompt(text: string): Promise<boolean> {
    try {
      const data = await apiSend<{ text: string }>('/api/runtime/custom-prompt', 'POST', { text })
      customPrompt.value = data?.text ?? text
      localStorage.setItem('coomi.customPrompt', customPrompt.value)
      return true
    } catch {
      return false
    }
  }

  /** 新增/更新 Provider。空 apiKey 表示沿用旧 key（后端语义）。 */
  async function upsertProvider(input: ProviderInput): Promise<boolean> {
    if (usingMock.value) {
      // 浏览器兜底：仅本地更新，不落盘
      const existing = providers.value.find(p => p.id === input.id)
      const apiKeyMasked = input.apiKey ? '****' + input.apiKey.slice(-4) : (existing?.apiKeyMasked ?? '')
      const hasKey = input.apiKey ? true : (existing?.hasKey ?? false)
      if (existing) {
        Object.assign(existing, {
          name: input.name, apiKeyMasked, hasKey, models: input.models,
          baseUrl: input.baseUrl, type: input.type, toolProtocol: input.toolProtocol,
          contextWindow: input.contextWindow, fastModel: input.fastModel,
          modelContextWindows: { ...(input.modelContextWindows ?? {}) },
          supportsWebSearch: input.supportsWebSearch, supportsVision: input.supportsVision,
          modelDescriptions: { ...(input.modelDescriptions ?? {}) }, modelParameters: { ...(input.modelParameters ?? {}) },
          capabilityOverrides: { ...(input.capabilityOverrides ?? {}) },
          model: input.models[0],
        })
      } else {
        providers.value.push({
          id: input.id, name: input.name, apiKeyMasked, hasKey, models: input.models,
          baseUrl: input.baseUrl, type: input.type, toolProtocol: input.toolProtocol,
          contextWindow: input.contextWindow, fastModel: input.fastModel,
          modelContextWindows: { ...(input.modelContextWindows ?? {}) },
          supportsWebSearch: input.supportsWebSearch, supportsVision: input.supportsVision,
          modelDescriptions: { ...(input.modelDescriptions ?? {}) }, modelParameters: { ...(input.modelParameters ?? {}) },
          capabilityOverrides: { ...(input.capabilityOverrides ?? {}) },
          model: input.models[0],
        })
      }
      if (input.activate) activeId.value = input.id
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
        modelContextWindows: input.modelContextWindows,
        fastModel: input.fastModel,
        supportsWebSearch: input.supportsWebSearch,
        supportsVision: input.supportsVision,
        modelDescriptions: input.modelDescriptions,
        modelParameters: input.modelParameters,
        capabilityOverrides: input.capabilityOverrides,
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
    if (!id.trim()) return true
    if (usingMock.value) {
      const remaining = providers.value.filter(p => p.id !== id)
      applyList(remaining, activeId.value === id ? (remaining[0]?.id ?? '') : activeId.value)
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
    if (usingMock.value) {
      const provider = providers.value.find(item => item.id === id)
      if (!provider) return false
      activeId.value = id
      selectModel(id, provider.model || provider.models[0] || '')
      return true
    }
    try {
      await apiSend(`/api/providers/${encodeURIComponent(id)}/activate`, 'POST')
      await fetchProviders()
      const provider = providers.value.find(item => item.id === id)
      if (!provider) throw new Error('已激活的提供商未出现在配置列表中')
      const savedProvider = localStorage.getItem('coomi.providerId')
      const savedModel = localStorage.getItem('coomi.model')
      const model = savedProvider === id && provider.models.includes(savedModel ?? '')
        ? savedModel!
        : (provider.model || provider.models[0] || '')
      selectModel(id, model)
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
    if (usingMock.value) return null
    try {
      const result = await apiSend<{ apiKey: string }>(`/api/providers/${encodeURIComponent(id)}/reveal`, 'POST')
      return result.apiKey
    } catch (e) {
      lastError.value = String(e)
      return null
    }
  }

  async function discoverModels(id: string, persist = false): Promise<string[] | null> {
    if (usingMock.value) return providers.value.find(provider => provider.id === id)?.models ?? []
    try {
      const result = await apiSend<{ models: string[] }>(
        `/api/providers/${encodeURIComponent(id)}/discover-models`,
        'POST',
        { persist },
      )
      if (persist) await fetchProviders()
      return result.models
    } catch (e) {
      lastError.value = String(e)
      return null
    }
  }

  return {
    permissionMode, planMode, themeMode, reasoningEffort, maxToolRounds, connectionSettings, globalMemory, digitalLifeEnabled, lifeGlobalMode, setLifeGlobalMode, customPrompt, providers, activeId, loading, usingMock, lastError, subAgentSettings, collaborationSettings,
    currentProviderId, currentModel, currentProvider, mergedProviders,
    fetchProviders, selectModel, validateAndSelectModel, setPermissionMode, setThemeMode, setReasoningEffort, setMaxToolRounds, fetchConnectionSettings, saveConnectionSettings, cyclePermissionMode, togglePlanMode,
    toggleGlobalMemory, syncGlobalMemoryFromEngine, setDigitalLifeEnabled, syncDigitalLifeEnabled, fetchCustomPrompt, saveCustomPrompt,
    upsertProvider, deleteProvider, activateProvider, copyProvider, revealProviderKey, discoverModels, fetchSubAgentSettings, saveSubAgentSettings, fetchCollaborationSettings, saveCollaborationSettings,
  }
})

function readStoredInt(key: string, min: number, max: number, fallback: number): number {
  const value = Number(localStorage.getItem(key))
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}
