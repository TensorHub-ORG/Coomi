<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import ModelPickerSheet from '@/components/ModelPickerSheet.vue'
import ThemeSelect, { type ThemeSelectOption } from '@/components/ThemeSelect.vue'
import {
  BUILTIN_PROVIDER_PRESETS,
  useConfigStore,
  type ProviderConfig,
  type ProviderInput,
  type ProviderProtocol,
  type ModelParameters, type CapabilityOverride,
} from '@/stores/config'

type Tab = 'config' | 'models'

interface ProviderDraft {
  id: string
  name: string
  apiKey: string
  models: string[]
  modelContextWindows: Record<string, number>
  baseUrl: string
  protocol: ProviderProtocol
  contextWindow: number
  supportsWebSearch: boolean
  modelDescriptions: Record<string, string>
  modelParameters: Record<string, ModelParameters>
  capabilityOverrides: Record<string, CapabilityOverride>
}

const route = useRoute()
const router = useRouter()
const config = useConfigStore()

const tab = ref<Tab>('config')
const modelCategory = ref<'text' | 'vision' | 'image'>('text')
const draft = ref<ProviderDraft | null>(null)
const original = ref<ProviderDraft | null>(null)
const isNew = computed(() => route.name === 'provider-new')
const idLocked = ref(false)
const saving = ref(false)
const activating = ref(false)
const discovering = ref(false)
const showingKey = ref(false)
const showPicker = ref(false)
const candidates = ref<string[]>([])
const manualModel = ref('')
const message = ref('')
const error = ref('')
const pendingDelete = ref(false)
const pendingClear = ref(false)
const pendingBack = ref(false)
const customContextWindow = ref(64)
const expandedHelpModel = ref<string | null>(null)
const CONTEXT_WINDOW_PRESETS = [128000, 256000, 512000, 1048576]
const SAVE_FEEDBACK_MIN_MS = 200
const REASONING_LEVELS = [
  { key: 'low', label: '低' },
  { key: 'medium', label: '中' },
  { key: 'high', label: '高' },
  { key: 'xhigh', label: '超高' },
] as const

const providerId = computed(() => {
  const value = route.params.id
  return typeof value === 'string' ? decodeURIComponent(value) : ''
})
const provider = computed(() => config.mergedProviders.find(item => item.id === providerId.value) ?? null)
const isBuiltin = computed(() => provider.value?.builtin ?? false)
const isCurrent = computed(() => provider.value?.id === config.activeId)
const canSave = computed(() => Boolean(
  draft.value?.id.trim() && draft.value?.name.trim() && draft.value?.baseUrl.trim(),
))
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(original.value))

function waitForSaveFeedback(startedAt: number) {
  const remaining = SAVE_FEEDBACK_MIN_MS - (Date.now() - startedAt)
  return remaining > 0 ? new Promise<void>(resolve => setTimeout(resolve, remaining)) : Promise.resolve()
}

const protocols: { value: ProviderProtocol; label: string }[] = [
  { value: 'openai_compatible', label: 'OpenAI Compatible' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
  { value: 'gemini_native', label: 'Google Gemini (Native)' },
]
const protocolOptions: ThemeSelectOption[] = protocols.map(item => ({ ...item }))
const providerContextOptions: ThemeSelectOption[] = [
  ...CONTEXT_WINDOW_PRESETS.map(value => ({ value: String(value), label: formatContextWindow(value) })),
  { value: '0', label: '自定义' },
]

function normalizeProtocol(value?: string): ProviderProtocol {
  if (value === 'openai_responses' || value === 'responses') return 'openai_responses'
  if (value === 'anthropic_messages' || value === 'anthropic') return 'anthropic_messages'
  if (value === 'gemini_native' || value === 'gemini') return 'gemini_native'
  return 'openai_compatible'
}

function emptyDraft(id = '', name = ''): ProviderDraft {
  const preset = BUILTIN_PROVIDER_PRESETS.find(item => item.id === id)
  return {
    id,
    name: name || preset?.name || '',
    apiKey: '',
    models: [],
    modelContextWindows: {},
    baseUrl: preset?.baseUrl || '',
    protocol: preset?.protocol || 'openai_compatible',
    contextWindow: 256000,
    supportsWebSearch: false,
    modelDescriptions: {}, modelParameters: {}, capabilityOverrides: {},
  }
}

function draftFromProvider(value: ProviderConfig | null): ProviderDraft {
  if (!value) return emptyDraft(isNew.value ? '' : providerId.value)
  return {
    id: value.id,
    name: value.name,
    apiKey: '',
    models: [...value.models],
    modelContextWindows: { ...(value.modelContextWindows ?? {}) },
    baseUrl: value.baseUrl || '',
    protocol: normalizeProtocol(value.toolProtocol || value.type),
    contextWindow: value.contextWindow || 256000,
    supportsWebSearch: !!value.supportsWebSearch,
    modelDescriptions: { ...(value.modelDescriptions ?? {}) }, modelParameters: { ...(value.modelParameters ?? {}) },
    capabilityOverrides: { ...(value.capabilityOverrides ?? {}) },
  }
}

function clone(value: ProviderDraft): ProviderDraft {
  return {
    ...value,
    models: [...value.models],
    modelContextWindows: { ...value.modelContextWindows },
    modelDescriptions: { ...value.modelDescriptions }, modelParameters: { ...value.modelParameters }, capabilityOverrides: { ...value.capabilityOverrides },
  }
}

function normalizeModels(models: string[]): string[] {
  return Array.from(new Set(models.map(model => model.trim()).filter(Boolean)))
}

function formatContextWindow(value: number): string {
  return value === 1048576 ? '1024k' : `${Math.round(value / 1000)}k`
}

function modelContextSelection(model: string): string {
  const value = draft.value?.modelContextWindows[model]
  if (!value) return 'default'
  return CONTEXT_WINDOW_PRESETS.includes(value) ? String(value) : 'custom'
}

function capabilityEnabled(model: string, key: 'text' | 'vision' | 'image_generation'): boolean {
  const override = draft.value?.capabilityOverrides[model]?.[key]
  if (override !== undefined) return override
  return key === 'text'
}
const visibleModels = computed(() => {
  if (!draft.value) return []
  return draft.value.models.filter(model => {
    if (modelCategory.value === 'vision') return capabilityEnabled(model, 'vision')
    if (modelCategory.value === 'image') return capabilityEnabled(model, 'image_generation')
    return capabilityEnabled(model, 'text')
  })
})
function modelParams(model: string): ModelParameters {
  if (!draft.value) return {}
  draft.value.modelParameters[model] ||= {}
  return draft.value.modelParameters[model]
}

function updateOptionalNumber(model: string, key: 'temperature' | 'topK', event: Event) {
  const input = event.target as HTMLInputElement
  const params = modelParams(model)
  if (input.value.trim() === '') {
    delete params[key]
    return
  }
  const value = Number(input.value)
  if (!Number.isFinite(value)) return
  params[key] = key === 'temperature'
    ? Math.max(0, Math.min(2, value))
    : Math.max(1, Math.min(65536, Math.round(value)))
}

function updateProviderContext(value: string) {
  if (!draft.value) return
  draft.value.contextWindow = Number(value)
}

function modelContextOptions(model: string): ThemeSelectOption[] {
  return [
    { value: 'default', label: `默认 ${formatContextWindow(draft.value?.contextWindow || 256000)}` },
    ...CONTEXT_WINDOW_PRESETS.map(value => ({ value: String(value), label: formatContextWindow(value) })),
    { value: 'custom', label: '自定义' },
  ]
}

function updateModelContextSelection(model: string, value: string) {
  updateModelContextWindow(model, { target: { value } } as unknown as Event)
}

function reasoningFieldOptions(): ThemeSelectOption[] {
  switch (draft.value?.protocol) {
    case 'openai_responses':
      return [
        { value: 'reasoning.effort', label: 'reasoning.effort', note: 'OpenAI Responses 标准字段' },
        { value: 'reasoning_effort', label: 'reasoning_effort', note: '部分兼容服务使用' },
      ]
    case 'anthropic_messages':
      return [
        { value: 'thinking.budget_tokens', label: 'thinking.budget_tokens', note: 'Anthropic 扩展思考预算' },
      ]
    case 'gemini_native':
      return [
        { value: 'generationConfig.thinkingConfig.thinkingLevel', label: 'thinkingLevel', note: 'Gemini 推理级别' },
        { value: 'generationConfig.thinkingConfig.thinkingBudget', label: 'thinkingBudget', note: 'Gemini 推理 token 预算' },
      ]
    default:
      return [
        { value: 'reasoning_effort', label: 'reasoning_effort', note: 'OpenAI Compatible 常用字段' },
        { value: 'reasoning.effort', label: 'reasoning.effort', note: 'Responses / 部分兼容服务' },
        { value: 'thinking.budget_tokens', label: 'thinking.budget_tokens', note: 'Anthropic 风格预算字段' },
        { value: 'enable_thinking', label: 'enable_thinking', note: '部分国产模型布尔字段' },
      ]
  }
}

function defaultReasoningField(): string {
  return reasoningFieldOptions()[0]?.value ?? 'reasoning_effort'
}

function defaultReasoningMapping(field: string): NonNullable<ModelParameters['reasoningMapping']> {
  if (field.endsWith('budget_tokens') || field.endsWith('thinkingBudget')) {
    return { low: '1024', medium: '4096', high: '8192', xhigh: '16384' }
  }
  if (field.endsWith('thinkingLevel')) {
    return { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'HIGH' }
  }
  if (field === 'enable_thinking') {
    return { low: 'true', medium: 'true', high: 'true', xhigh: 'true' }
  }
  return { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }
}

function setReasoningField(model: string, field: string) {
  const params = modelParams(model)
  params.reasoningField = field
  params.reasoningMapping = defaultReasoningMapping(field)
}

function updateReasoningMapping(model: string, level: 'low' | 'medium' | 'high' | 'xhigh', event: Event) {
  ensureReasoningMapping(model)
  const params = modelParams(model)
  params.reasoningMapping![level] = (event.target as HTMLInputElement).value.trim()
}

function ensureReasoningMapping(model: string) {
  const params = modelParams(model)
  if (!params.reasoningField) params.reasoningField = defaultReasoningField()
  if (!params.reasoningMapping) params.reasoningMapping = defaultReasoningMapping(params.reasoningField)
}

function toggleModelHelp(model: string) {
  if (expandedHelpModel.value === model) {
    expandedHelpModel.value = null
    return
  }
  ensureReasoningMapping(model)
  expandedHelpModel.value = model
}

function reasoningSummary(model: string): string {
  return modelParams(model).reasoningField ? '已映射' : '协议默认'
}
function setOverride(model: string, key: keyof CapabilityOverride, event: Event) {
  if (!draft.value) return
  const next = { ...(draft.value.capabilityOverrides[model] ?? {}) }
  const checked = (event.target as HTMLInputElement).checked
  next[key] = checked
  draft.value.capabilityOverrides[model] = next
}

function modelCustomContextWindow(model: string): number {
  return draft.value?.modelContextWindows[model]
    ?? draft.value?.contextWindow
    ?? 256000
}

function updateModelContextWindow(model: string, event: Event) {
  if (!draft.value) return
  const selection = (event.target as HTMLSelectElement).value
  const windows = { ...draft.value.modelContextWindows }
  if (selection === 'default') {
    delete windows[model]
  } else if (selection === 'custom') {
    const value = Math.max(32, Math.min(1048, Math.round(modelCustomContextWindow(model) / 1000))) * 1000
    windows[model] = value
  } else {
    windows[model] = Number(selection)
  }
  draft.value.modelContextWindows = windows
}

function updateModelCustomContextWindow(model: string, event: Event) {
  if (!draft.value) return
  const value = Math.max(32, Math.min(1048, Math.round(Number((event.target as HTMLInputElement).value) || 64))) * 1000
  draft.value.modelContextWindows = { ...draft.value.modelContextWindows, [model]: value }
}

function loadDraft() {
  const next = draftFromProvider(provider.value)
  draft.value = next
  original.value = clone(next)
  idLocked.value = !isNew.value
  if (!isNew.value && !provider.value) router.replace('/providers')
}

onMounted(async () => {
  await config.fetchProviders()
  loadDraft()
})

watch(() => route.fullPath, () => {
  tab.value = 'config'
  message.value = ''
  error.value = ''
  loadDraft()
})

function back() {
  if (dirty.value) {
    pendingBack.value = true
    return
  }
  router.push('/providers')
}

function discardAndBack() {
  pendingBack.value = false
  router.push('/providers')
}

function providerInput(value: ProviderDraft): ProviderInput {
  const capabilityOverrides = { ...value.capabilityOverrides }
  for (const model of value.models) {
    capabilityOverrides[model] = {
      text: capabilityOverrides[model]?.text ?? true,
      vision: capabilityOverrides[model]?.vision ?? false,
      image_generation: capabilityOverrides[model]?.image_generation ?? false,
    }
  }
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    apiKey: value.apiKey.trim(),
    models: [...value.models],
    modelContextWindows: { ...value.modelContextWindows },
    baseUrl: value.baseUrl.trim(),
    type: value.protocol,
    toolProtocol: value.protocol,
    contextWindow: value.contextWindow === 0
      ? Math.max(32, Math.min(1048, Math.round(customContextWindow.value || 64))) * 1000
      : value.contextWindow,
    supportsWebSearch: value.supportsWebSearch,
    modelDescriptions: { ...value.modelDescriptions }, modelParameters: { ...value.modelParameters }, capabilityOverrides,
    activate: false,
  }
}

async function saveProvider(successMessage: string, returnToList = false) {
  if (!draft.value || !canSave.value) return false
  const value = draft.value
  value.models = normalizeModels(value.models)
  const startedAt = Date.now()
  saving.value = true
  error.value = ''
  const ok = await config.upsertProvider(providerInput(value))
  await waitForSaveFeedback(startedAt)
  saving.value = false
  if (!ok) {
    error.value = config.lastError || '保存失败'
    return false
  }
  idLocked.value = true
  original.value = clone(value)
  message.value = successMessage
  if (returnToList) {
    await router.replace('/providers')
  } else if (isNew.value) {
    await router.replace(`/providers/${encodeURIComponent(value.id)}`)
  }
  return true
}

async function saveConfig() {
  const saved = await saveProvider('配置已保存')
  if (!saved) return false
  tab.value = 'models'
  await discover(true)
  return true
}

async function saveConfigAndBack() {
  return saveProvider('配置已保存', true)
}

async function saveModels() {
  return saveProvider('模型列表已保存')
}

async function activateCurrentProvider() {
  if (!draft.value || isNew.value || activating.value || isCurrent.value) return
  error.value = ''
  message.value = ''
  if (dirty.value && !(await saveProvider('配置已保存'))) return
  activating.value = true
  const ok = await config.activateProvider(draft.value.id)
  activating.value = false
  if (!ok) {
    error.value = config.lastError || '设为当前提供商失败'
    return
  }
  message.value = '密钥和模型验证通过，已设为当前提供商'
}

async function revealKey() {
  if (!draft.value || isNew.value || showingKey.value) {
    showingKey.value = !showingKey.value
    return
  }
  const value = await config.revealProviderKey(draft.value.id)
  if (value !== null) {
    draft.value.apiKey = value
    if (original.value) original.value.apiKey = value
    showingKey.value = true
  } else {
    error.value = config.lastError || '无法读取 API Key'
  }
}

async function discover(skipSave = false) {
  if (!draft.value) return
  if (!draft.value.apiKey.trim() && !provider.value?.hasKey) {
    error.value = '请先填写 API Key 后再获取模型'
    return
  }
  if (!draft.value.baseUrl.trim()) {
    error.value = '请先填写 API Base URL 后再获取模型'
    return
  }
  if (!skipSave && !(await saveProvider('配置已保存'))) return
  discovering.value = true
  error.value = ''
  const models = await config.discoverModels(draft.value.id)
  discovering.value = false
  if (models === null) {
    error.value = config.lastError || '模型获取失败'
    return
  }
  candidates.value = Array.from(new Set(models.map(model => model.trim()).filter(Boolean)))
  showPicker.value = true
}

function addManualModel() {
  if (!draft.value) return
  const value = manualModel.value.trim()
  if (!value || draft.value.models.includes(value)) return
  draft.value.models.push(value)
  draft.value.capabilityOverrides[value] = { text: true, vision: false, image_generation: false }
  manualModel.value = ''
}

function removeModel(model: string) {
  if (!draft.value) return
  draft.value.models = draft.value.models.filter(item => item !== model)
  const windows = { ...draft.value.modelContextWindows }
  delete windows[model]
  draft.value.modelContextWindows = windows
  const descriptions = { ...draft.value.modelDescriptions }
  const parameters = { ...draft.value.modelParameters }
  const capabilities = { ...draft.value.capabilityOverrides }
  delete descriptions[model]
  delete parameters[model]
  delete capabilities[model]
  draft.value.modelDescriptions = descriptions
  draft.value.modelParameters = parameters
  draft.value.capabilityOverrides = capabilities
  if (expandedHelpModel.value === model) expandedHelpModel.value = null
}

async function clearBuiltin() {
  if (!draft.value || !isBuiltin.value) return
  pendingClear.value = false
  const hasSavedConfig = config.providers.some(provider => provider.id === draft.value?.id)
  if (hasSavedConfig && !(await config.deleteProvider(draft.value.id))) {
    error.value = config.lastError || '清空失败'
    return
  }
  router.push('/providers')
}

async function deleteCustom() {
  if (!draft.value || isBuiltin.value) return
  if (isCurrent.value) {
    error.value = '请先切换到其他供应商，再删除当前供应商'
    pendingDelete.value = false
    return
  }
  pendingDelete.value = false
  if (!(await config.deleteProvider(draft.value.id))) {
    error.value = config.lastError || '删除失败'
    return
  }
  router.push('/providers')
}

function onPickerConfirm(models: string[]) {
  const next = normalizeModels(models)
  if (draft.value) draft.value.models = next
  if (draft.value) {
    for (const model of next) {
      draft.value.capabilityOverrides[model] ||= { text: true, vision: false, image_generation: false }
    }
    const windows = { ...draft.value.modelContextWindows }
    for (const model of Object.keys(windows)) {
      if (!next.includes(model)) delete windows[model]
    }
    draft.value.modelContextWindows = windows
  }
  showPicker.value = false
}

function openModelConfig() {
  tab.value = 'models'
}
</script>

<template>
  <div class="page">
    <PageHead :title="draft?.name || (isNew ? '新建提供商' : '提供商详情')" @back="back">
      <template #right>
        <button v-if="tab === 'config'" class="head-save" :disabled="!canSave || saving" @click="saveConfig">保存</button>
      </template>
    </PageHead>

    <main v-if="draft" class="body">
      <div class="tabs" role="tablist">
        <button :class="{ on: tab === 'config' }" @click="tab = 'config'"><CoomiIcon name="settings" :size="16" />配置</button>
        <button :class="{ on: tab === 'models' }" @click="tab = 'models'"><CoomiIcon name="cpu" :size="16" />模型<span class="count">{{ draft.models.length }}</span></button>
      </div>

      <p v-if="message" class="notice ok">{{ message }}</p>
      <p v-if="error" class="notice err">{{ error }}</p>
      <p v-if="providerId === 'zhipu'" class="provider-warning">
        <CoomiIcon name="alert" :size="15" />
        <span><strong>智谱 Coding Plan 使用提醒</strong>请填写智谱官方 API Key 或 Coding Key。账号套餐与 Coding Plan 可能限定支持的客户端和用途，超出范围可能触发限流或账号异常，请以智谱当前规则为准。</span>
      </p>

      <div v-if="!isNew && provider" class="activate-area">
        <button
          type="button"
          class="btn wide activate-btn"
          :class="isCurrent ? 'is-current' : 'btn-primary'"
          :disabled="isCurrent || activating || saving"
          @click="activateCurrentProvider"
        >
          <CoomiIcon v-if="isCurrent" name="check" :size="16" />
          {{ isCurrent ? '当前提供商' : activating ? '正在设为当前...' : '设为当前' }}
        </button>
      </div>

      <form v-if="tab === 'config'" class="form" @submit.prevent="saveConfig">
        <label class="field">
          <span>名称</span>
          <input v-model="draft.name" class="input" placeholder="例如 OpenAI" />
        </label>
        <label class="field">
          <span>供应商 ID</span>
          <input v-model="draft.id" class="input" :readonly="idLocked || (isBuiltin && !isNew)" placeholder="例如 my-provider" autocapitalize="off" />
        </label>
        <label class="field">
          <span>API Key</span>
          <span class="input-action">
            <input v-model="draft.apiKey" class="input" :type="showingKey ? 'text' : 'password'" :placeholder="isNew ? '输入 API Key' : '留空以保留原 Key'" autocomplete="off" autocapitalize="off" />
            <button type="button" aria-label="查看 API Key" @click="revealKey"><CoomiIcon :name="showingKey ? 'eye' : 'eye'" :size="17" /></button>
          </span>
        </label>
        <label class="field">
          <span>API Base URL</span>
          <input v-model="draft.baseUrl" class="input" placeholder="https://api.openai.com/v1" inputmode="url" autocapitalize="off" />
        </label>
        <label class="field">
          <span>协议</span>
          <ThemeSelect
            class="form-select"
            :model-value="draft.protocol"
            :options="protocolOptions"
            title="选择提供商协议"
            aria-label="提供商协议"
            @update:model-value="draft.protocol = normalizeProtocol($event)"
          />
        </label>
        <label class="field">
          <span>默认上下文窗口</span>
          <ThemeSelect
            class="form-select"
            :model-value="String(draft.contextWindow)"
            :options="providerContextOptions"
            title="选择默认上下文窗口"
            aria-label="默认上下文窗口"
            @update:model-value="updateProviderContext"
          />
          <input v-if="draft.contextWindow === 0" v-model.number="customContextWindow" class="input" type="number" min="32" max="1048" placeholder="单位：k" />
        </label>
        <label class="toggle"><input v-model="draft.supportsWebSearch" type="checkbox" /><span>使用供应商原生 Web Search</span></label>
        <button class="btn btn-primary wide" type="submit" :disabled="!canSave || saving">{{ saving ? '保存中...' : '保存配置' }}</button>
        <button
          v-if="message && draft.models.length === 0"
          type="button"
          class="model-prompt"
          @click="openModelConfig"
        >
          请前往配置可用模型
          <CoomiIcon name="chevronRight" :size="15" />
        </button>
      </form>

      <section v-else-if="tab === 'models'" class="models-panel">
        <div class="tabs model-categories" role="tablist">
          <button :class="{ on: modelCategory === 'text' }" type="button" @click="modelCategory = 'text'">文本模型</button>
          <button :class="{ on: modelCategory === 'vision' }" type="button" @click="modelCategory = 'vision'">图像理解</button>
          <button :class="{ on: modelCategory === 'image' }" type="button" @click="modelCategory = 'image'">图像生成</button>
        </div>
        <div class="model-tools">
          <label class="input-action add-model">
            <input v-model="manualModel" class="input" placeholder="输入模型 ID" autocomplete="off" autocapitalize="off" @keyup.enter="addManualModel" />
            <button type="button" aria-label="添加模型" @click="addManualModel"><CoomiIcon name="plus" :size="17" /></button>
          </label>
          <button type="button" class="btn btn-soft discover" :disabled="discovering || saving" @click="discover()"><CoomiIcon name="refresh" :size="16" />{{ discovering ? '获取中...' : '在线获取' }}</button>
        </div>
        <p class="subnote">每个模型可单独设置上下文窗口，选择“默认”时继承供应商配置。</p>
        <div class="model-list">
          <div v-for="model in visibleModels" :key="model" class="model-item">
            <div class="model-head">
              <code :title="model">{{ model }}</code>
              <input class="model-description" v-model="draft.modelDescriptions[model]" placeholder="模型描述（可选）" />
              <button class="icon-btn delete-model" type="button" aria-label="移除模型" @click="removeModel(model)"><CoomiIcon name="trash" :size="14" /></button>
            </div>
            <div class="model-controls">
              <label class="model-param"><span>温度<small>默认 1.0</small></span>
                <input type="number" min="0" max="2" step="0.1" placeholder="1.0" :value="modelParams(model).temperature ?? ''" @input="updateOptionalNumber(model, 'temperature', $event)" />
              </label>
              <label class="model-param"><span>Top-k<small>默认不发送</small></span>
                <input type="number" min="1" max="65536" step="1" placeholder="默认" :value="modelParams(model).topK ?? ''" @input="updateOptionalNumber(model, 'topK', $event)" />
              </label>
              <div class="model-param"><span>推理映射<small>Coomi 四档</small></span><button type="button" class="mapping-trigger" @click="toggleModelHelp(model)">{{ reasoningSummary(model) }}</button></div>
              <label class="model-param model-context"><span>上下文窗口</span>
                <span class="context-fields">
                  <ThemeSelect
                    class="model-window"
                    :model-value="modelContextSelection(model)"
                    :options="modelContextOptions(model)"
                    :title="`${model} 上下文窗口`"
                    :aria-label="`${model} 上下文窗口`"
                    @update:model-value="updateModelContextSelection(model, $event)"
                  />
                  <input
                    v-if="modelContextSelection(model) === 'custom'"
                    class="model-window-custom"
                    type="number"
                    min="32"
                    max="1048"
                    :value="Math.round(modelCustomContextWindow(model) / 1000)"
                    aria-label="自定义上下文窗口（千 token）"
                    @change="updateModelCustomContextWindow(model, $event)"
                  />
                </span>
              </label>
              <button class="parameter-help" type="button" :class="{ on: expandedHelpModel === model }" aria-label="参数调节指南" @click="toggleModelHelp(model)">?</button>
            </div>
            <section v-if="expandedHelpModel === model" class="parameter-guide">
              <div class="guide-title"><strong>参数建议与推理映射</strong><span>留空即使用模型默认值</span></div>
              <p>温度越低越稳定，代码与工具任务建议 0–0.4；创意任务可使用 0.7–1.2。Top-k 会限制候选词范围，仅在提供商支持时填写。</p>
              <div class="reasoning-field">
                <span>原模型推理字段</span>
                <ThemeSelect
                  :model-value="modelParams(model).reasoningField || defaultReasoningField()"
                  :options="reasoningFieldOptions()"
                  title="选择原模型推理字段"
                  aria-label="原模型推理字段"
                  @update:model-value="setReasoningField(model, $event)"
                />
              </div>
              <div class="mapping-grid">
                <label v-for="level in REASONING_LEVELS" :key="level.key">
                  <span>Coomi {{ level.label }}</span>
                  <input :value="modelParams(model).reasoningMapping?.[level.key] || ''" :placeholder="level.key" @input="updateReasoningMapping(model, level.key, $event)" />
                </label>
              </div>
              <p class="mapping-note">对话设置中的推理档位会按上表转换后写入 <code>{{ modelParams(model).reasoningField }}</code>；自动档不发送该字段。</p>
            </section>
            <div class="capability-overrides">
              <span>模型能力</span>
              <label><input type="checkbox" :checked="capabilityEnabled(model, 'text')" @change="setOverride(model, 'text', $event)" />文本</label>
              <label><input type="checkbox" :checked="capabilityEnabled(model, 'vision')" @change="setOverride(model, 'vision', $event)" />视觉</label>
              <label><input type="checkbox" :checked="capabilityEnabled(model, 'image_generation')" @change="setOverride(model, 'image_generation', $event)" />生图</label>
            </div>
          </div>
          <p v-if="draft.models.length === 0" class="empty">还没有模型。可以手动添加，或在线获取。</p>
        </div>
        <button class="btn btn-primary wide" :disabled="saving || !dirty" @click="saveModels">{{ saving ? '保存中...' : '保存模型列表' }}</button>
      </section>

      <div class="danger-area">
        <button v-if="isBuiltin" class="danger-link" @click="pendingClear = true">清空配置</button>
        <button v-else class="danger-link" :disabled="isCurrent" @click="pendingDelete = true">删除提供商</button>
      </div>
    </main>

    <ModelPickerSheet v-if="showPicker" :candidates="candidates" :selected="draft?.models || []" @cancel="showPicker = false" @confirm="onPickerConfirm" />

    <div v-if="pendingBack || pendingClear || pendingDelete" class="mask" @click.self="pendingBack = pendingClear = pendingDelete = false">
      <section class="confirm-sheet">
        <div class="grip" />
        <h2>{{ pendingBack ? '放弃未保存的修改？' : pendingClear ? '清空提供商配置？' : '删除提供商？' }}</h2>
        <p>{{ pendingBack ? '当前修改还没有保存，离开后会丢失。' : pendingClear ? '只会删除已保存的配置，内置供应商仍会保留在列表中。' : '该供应商的 API Key 和模型配置也会一并删除。' }}</p>
        <div class="confirm-actions">
          <button class="btn btn-ghost" @click="pendingBack = pendingClear = pendingDelete = false">取消</button>
          <button v-if="pendingBack" class="btn btn-danger" @click="discardAndBack">放弃修改</button>
          <button v-else class="btn btn-danger" @click="pendingClear ? clearBuiltin() : deleteCustom()">确认</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px calc(var(--safe-bottom) + 24px); }
.head-save { min-height: 34px; padding: 0 11px; border-radius: var(--r-sm); color: var(--blue); font-size: 13px; font-weight: 650; }
.head-save:disabled { color: var(--text-3); }
.tabs { display: flex; gap: 3px; padding: 3px; margin-bottom: 12px; border-radius: var(--r-pill); background: var(--fill-strong); }
.tabs button { display: flex; align-items: center; justify-content: center; gap: 6px; flex: 1; min-height: 36px; border-radius: var(--r-pill); color: var(--text-3); font-size: 13.5px; font-weight: 600; }
.tabs button.on { background: var(--bg); color: var(--blue); box-shadow: var(--shadow-1); }
.count { min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--r-pill); background: var(--fill); font-size: 11px; line-height: 18px; text-align: center; }
.notice { margin: 0 0 10px; padding: 9px 11px; border-radius: var(--r-md); font-size: 12.5px; line-height: 1.55; }
.notice.ok { color: var(--ok); background: var(--ok-soft); }
.notice.err { color: var(--danger); background: var(--danger-soft); }
.provider-warning { display:flex; align-items:flex-start; gap:8px; margin:0 0 11px; padding:10px 11px; border:1px solid color-mix(in srgb,var(--orange) 28%,var(--border)); border-radius:var(--r-md); background:color-mix(in srgb,var(--orange-soft) 54%,var(--bg)); color:var(--text-2); font-size:11.8px; line-height:1.55; }
.provider-warning :deep(svg) { flex-shrink:0; margin-top:2px; color:var(--orange); }
.provider-warning span { display:flex; flex-direction:column; gap:2px; }
.provider-warning strong { color:var(--text); font-size:12.3px; }
.activate-area { margin-bottom: 12px; }
.activate-btn { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 42px; }
.activate-btn.is-current { border: 1px solid var(--ok); background: var(--ok-soft); color: var(--ok); opacity: 1; }
.form { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field > span:first-child { padding-left: 3px; color: var(--text-2); font-size: 12.5px; }
.input { width: 100%; min-height: 44px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg); color: var(--text); font-size: 14px; }
.input::placeholder { color: var(--text-3); }
.input:focus { border-color: var(--blue-border); outline: none; }
.input[readonly] { background: var(--fill); color: var(--text-2); }
.form-select { min-height: 44px; padding: 0 12px; border-color: var(--border); border-radius: var(--r-md); background: var(--bg); color: var(--text); font-size: 14px; }
.input-action { display: flex; align-items: stretch; gap: 7px; }
.input-action .input { flex: 1; min-width: 0; }
.input-action > button { display: grid; place-items: center; flex: 0 0 45px; border-radius: var(--r-sm); background: var(--fill-strong); color: var(--blue); }
.toggle { display: flex; align-items: center; gap: 9px; min-height: 38px; padding: 0 3px; color: var(--text-2); font-size: 13px; }
.toggle input { width: 18px; height: 18px; accent-color: var(--blue); }
.wide { width: 100%; margin-top: 3px; }
.model-prompt { display: flex; align-items: center; justify-content: center; gap: 4px; width: 100%; min-height: 38px; margin-top: 4px; color: var(--blue); font-size: 13px; }
.model-tools { display: flex; gap: 8px; }
.add-model { flex: 1; min-width: 0; }
.discover { flex-shrink: 0; min-height: 44px; padding: 0 12px; }
.subnote { margin: 8px 3px 12px; color: var(--text-3); font-size: 12px; line-height: 1.55; }
.model-list { overflow: hidden; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.model-item { min-height: 52px; padding: 11px; }
.model-item + .model-item { border-top: 2px solid var(--border-strong); }
.model-head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(84px, 38%) 28px; align-items: center; gap: 7px; }
.model-head code { min-width: 0; overflow: hidden; color: var(--text); font-family: var(--font-mono); font-size: 12.5px; text-overflow: ellipsis; white-space: nowrap; }
.model-description { width: 100%; min-width: 0; min-height: 30px; padding: 0 8px; border: 1px solid var(--border); border-radius: 5px; background: var(--fill); color: var(--text-2); font-size: 10.5px; }
.delete-model { width: 28px; height: 30px; border-radius:50%; color: var(--danger); }
.delete-model:active { background:var(--danger-soft); }
.model-controls { display: grid; grid-template-columns: minmax(50px,.72fr) minmax(54px,.78fr) minmax(62px,.9fr) minmax(78px,1.25fr) 24px; align-items: end; gap: 5px; margin-top: 10px; }
.model-param { display: flex; min-width: 0; flex-direction: column; gap: 3px; color: var(--text-3); font-size: 9.5px; }
.model-param > span:first-child { display:flex; min-width:0; height:26px; flex-direction:column; justify-content:flex-end; line-height:1.15; white-space:nowrap; }
.model-param small { display:block; overflow:hidden; color:var(--text-3); font-size:7.5px; font-weight:400; text-overflow:ellipsis; }
.model-param input { width: 100%; min-width: 0; min-height: 30px; padding: 0 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--fill); color: var(--text-2); font-size: 10.5px; }
.mapping-trigger { width:100%; min-width:0; min-height:30px; padding:0 5px; overflow:hidden; border:1px solid var(--border); border-radius:5px; background:var(--fill); color:var(--text-2); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.context-fields { display: flex; min-width: 0; gap: 4px; }
.capability-overrides { display: grid; grid-template-columns: auto repeat(3, minmax(0, 1fr)); align-items: center; gap: 8px; margin-top: 9px; padding-top: 8px; border-top: 1px solid var(--border); color: var(--text-2); font-size: 11px; }
.capability-overrides > span { color: var(--text-3); font-size: 9.5px; }
.capability-overrides label { display: inline-flex; align-items: center; justify-content: center; gap: 4px; white-space: nowrap; }
.capability-overrides input { width: 14px; height: 14px; margin: 0; accent-color: var(--blue); }
.model-categories { margin-top: 0; }
.model-window { flex: 1; }
.model-window-custom { flex: 0 0 45px; }
.parameter-help { display:grid; place-items:center; width:24px; height:24px; margin-bottom:3px; border:1px solid var(--border-strong); border-radius:50%; background:var(--fill); color:var(--text-3); font-size:12px; font-weight:700; }
.parameter-help.on { border-color:var(--blue-border); background:var(--blue-soft); color:var(--blue); }
.parameter-guide { margin-top:9px; padding:10px; border:1px solid var(--border); border-radius:7px; background:var(--fill); color:var(--text-2); }
.guide-title { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.guide-title strong { color:var(--text); font-size:12px; }
.guide-title span { color:var(--text-3); font-size:9.5px; }
.parameter-guide > p { margin:5px 0 0; font-size:10.5px; line-height:1.55; }
.reasoning-field { display:grid; grid-template-columns:92px minmax(0,1fr); align-items:center; gap:7px; margin-top:9px; }
.reasoning-field > span { font-size:10.5px; }
.mapping-grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:5px; margin-top:8px; }
.mapping-grid label { display:flex; min-width:0; flex-direction:column; gap:3px; color:var(--text-3); font-size:8.5px; }
.mapping-grid input { width:100%; min-width:0; height:29px; padding:0 5px; border:1px solid var(--border); border-radius:5px; background:var(--bg); color:var(--text); font-size:10px; }
.parameter-guide .mapping-note { color:var(--text-3); }
.mapping-note code { overflow-wrap:anywhere; color:var(--blue); font-family:var(--font-mono); }
.empty { padding: 20px 12px; text-align: center; color: var(--text-3); font-size: 13px; }
.danger-area { display: flex; justify-content: center; margin-top: 24px; }
.danger-link { min-height: 36px; padding: 0 12px; color: var(--danger); font-size: 13px; }
.danger-link:disabled { color: var(--text-3); }
.mask { position: fixed; inset: 0; z-index: 80; display: flex; align-items: flex-end; background: rgba(17, 22, 31, .42); }
.confirm-sheet { width: 100%; padding: 8px 16px calc(var(--safe-bottom) + 16px); border-radius: 22px 22px 0 0; background: var(--bg); box-shadow: var(--shadow-sheet); }
.grip { width: 38px; height: 4px; margin: 3px auto 14px; border-radius: 2px; background: var(--border-strong); }
.confirm-sheet h2 { font-size: 16px; color: var(--text); }
.confirm-sheet p { margin: 7px 0 0; color: var(--text-2); font-size: 13px; line-height: 1.6; }
.confirm-actions { display: flex; gap: 9px; margin-top: 16px; }
.confirm-actions .btn { flex: 1; }
.btn-danger { background: var(--danger); color: #fff; }
</style>
