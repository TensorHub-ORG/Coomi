<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import ThemeSelect from '@/components/ThemeSelect.vue'
import { useConfigStore, type ProviderConfig, type ProviderStatus, type SubAgentConfig } from '@/stores/config'

const router = useRouter()
const config = useConfigStore()
const tab = ref<'providers' | 'subagents'>('providers')
const subAgents = ref<SubAgentConfig[]>([])
const fallbackId = ref<string>()
const subAgentLimit = ref(20)
const savedSnapshot = ref('')
const savingSubAgents = ref(false)
const subAgentMessage = ref('')
const subAgentError = ref('')

const providers = computed(() => config.mergedProviders)
const configuredProviders = computed(() => config.providers.filter(provider => provider.hasKey && provider.models.length > 0))
const configuredProviderOptions = computed(() => configuredProviders.value.map(provider => ({ value: provider.id, label: provider.name, note: provider.id })))
const subAgentDirty = computed(() => JSON.stringify({ agents: subAgents.value, fallbackId: fallbackId.value, maxAgents: subAgentLimit.value }) !== savedSnapshot.value)

onMounted(async () => {
  await config.fetchProviders()
  await config.fetchSubAgentSettings()
  loadSubAgents()
})

function loadSubAgents() {
  subAgents.value = config.subAgentSettings.agents.map(agent => ({ ...agent }))
  fallbackId.value = config.subAgentSettings.fallbackId
  subAgentLimit.value = Math.max(subAgents.value.length, Math.min(30, config.subAgentSettings.maxAgents || 20))
  sortFallbackFirst()
  savedSnapshot.value = JSON.stringify({ agents: subAgents.value, fallbackId: fallbackId.value, maxAgents: subAgentLimit.value })
}

function modelsFor(providerId: string): string[] {
  return configuredProviders.value.find(provider => provider.id === providerId)?.models ?? []
}

function addSubAgent() {
  if (subAgents.value.length >= subAgentLimit.value) return
  const provider = configuredProviders.value[0]
  const id = `sub-${Date.now().toString(36)}-${subAgents.value.length + 1}`
  subAgents.value.push({
    id,
    providerId: provider?.id ?? '',
    model: provider?.models[0] ?? '',
    description: '',
  })
  if (!fallbackId.value) setFallback(id)
}

function updateSubAgentProvider(agent: SubAgentConfig) {
  const models = modelsFor(agent.providerId)
  if (!models.includes(agent.model)) agent.model = models[0] ?? ''
}

function setSubAgentProvider(agent: SubAgentConfig, providerId: string) {
  agent.providerId = providerId
  updateSubAgentProvider(agent)
}

function modelOptions(providerId: string) {
  return modelsFor(providerId).map(model => ({ value: model, label: model }))
}

function removeSubAgent(id: string) {
  subAgents.value = subAgents.value.filter(agent => agent.id !== id)
  if (fallbackId.value === id) fallbackId.value = subAgents.value[0]?.id
  sortFallbackFirst()
}

function setFallback(id: string) {
  fallbackId.value = id
  sortFallbackFirst()
}

function sortFallbackFirst() {
  const fallback = fallbackId.value
  if (!fallback) return
  subAgents.value = [...subAgents.value].sort((a, b) => Number(b.id === fallback) - Number(a.id === fallback))
}

async function saveSubAgents() {
  subAgentError.value = ''
  subAgentMessage.value = ''
  if (subAgents.value.some(agent => !agent.providerId || !agent.model)) {
    subAgentError.value = '请为每个子代理选择提供商和模型'
    return
  }
  if (subAgents.value.length > 0 && !fallbackId.value) {
    subAgentError.value = '请设置一个保底子代理'
    return
  }
  if (!Number.isInteger(subAgentLimit.value) || subAgentLimit.value < subAgents.value.length || subAgentLimit.value > 30) {
    subAgentError.value = `子代理上限必须在 ${Math.max(1, subAgents.value.length)} 到 30 之间`
    return
  }
  savingSubAgents.value = true
  const ok = await config.saveSubAgentSettings({
    agents: subAgents.value.map(agent => ({ ...agent, description: agent.description?.trim() })),
    fallbackId: fallbackId.value,
    maxAgents: subAgentLimit.value,
  })
  savingSubAgents.value = false
  if (!ok) {
    subAgentError.value = config.lastError || '保存失败'
    return
  }
  loadSubAgents()
  subAgentMessage.value = '子代理配置已保存'
}

function statusLabel(status?: ProviderStatus): string {
  if (status === 'current') return '当前'
  if (status === 'configured') return '已配置'
  return '未配置'
}

function statusClass(status?: ProviderStatus): string {
  return status === 'current' ? 'current' : status === 'configured' ? 'configured' : 'unconfigured'
}

function openProvider(provider: ProviderConfig) {
  router.push(`/providers/${encodeURIComponent(provider.id)}`)
}

function backToDashboard() {
  if (window.CoomiAndroid?.openDashboard) window.CoomiAndroid.openDashboard()
  else router.push('/')
}
</script>

<template>
  <div class="page">
    <PageHead title="提供商配置" @back="backToDashboard">
      <template #right>
        <button v-if="tab === 'providers'" class="icon-btn blue" aria-label="添加提供商" @click="router.push('/providers/new')">
          <CoomiIcon name="plus" />
        </button>
      </template>
    </PageHead>

    <main class="body">
      <div class="tabs" role="tablist">
        <button :class="{ on: tab === 'providers' }" @click="tab = 'providers'">主模型</button>
        <button :class="{ on: tab === 'subagents' }" @click="tab = 'subagents'">子代理 <span>{{ subAgents.length }}/{{ subAgentLimit }}</span></button>
      </div>
      <p v-if="config.usingMock" class="banner">
        <CoomiIcon name="alert" :size="15" />
        <span>后端未连接，下面是本地示例数据，修改不会保存。</span>
      </p>
      <p v-if="config.loading" class="hint">加载中...</p>

      <div v-if="tab === 'providers'" class="group">
        <button
          v-for="provider in providers"
          :key="provider.id"
          class="provider-row"
          @click="openProvider(provider)"
        >
          <span class="tile" :class="{ on: provider.status === 'current', ready: provider.status === 'configured' }">
            <CoomiIcon name="key" :size="18" />
          </span>
          <span class="row-text">
            <span class="name">{{ provider.name }}</span>
            <span class="meta">{{ provider.id }}<template v-if="provider.models.length"> · {{ provider.models.length }} 个模型</template></span>
          </span>
          <span class="status" :class="statusClass(provider.status)">{{ statusLabel(provider.status) }}</span>
          <CoomiIcon name="chevronRight" :size="16" class="arrow" />
        </button>
      </div>

      <p v-if="tab === 'providers' && !config.loading && providers.length === 0" class="hint">还没有提供商配置。</p>

      <section v-if="tab === 'subagents'" class="subagent-panel">
        <p class="subagent-note">从已配置的提供商中选择模型。保底子代理始终置顶，未指定子代理时自动使用它。</p>
        <div class="agent-limit">
          <span><strong>子代理上限</strong><small>最多可配置 30 个</small></span>
          <input v-model.number="subAgentLimit" type="range" :min="Math.max(1, subAgents.length)" max="30" step="1" aria-label="子代理上限" />
          <output>{{ subAgentLimit }}</output>
        </div>
        <p v-if="subAgentMessage" class="notice ok">{{ subAgentMessage }}</p>
        <p v-if="subAgentError" class="notice err">{{ subAgentError }}</p>
        <div v-if="configuredProviders.length === 0" class="empty-state">
          <CoomiIcon name="key" :size="22" />
          <b>还没有可用的提供商</b>
          <span>请先在“主模型”中配置 API Key 并添加模型。</span>
        </div>
        <div v-else class="agent-list">
          <article v-for="agent in subAgents" :key="agent.id" class="agent-item">
            <div class="agent-head">
              <span class="agent-mark"><CoomiIcon name="subtask" :size="16" /></span>
              <code>{{ agent.id }}</code>
              <label class="fallback"><input type="radio" name="fallback-agent" :checked="fallbackId === agent.id" @change="setFallback(agent.id)" />保底</label>
              <button class="icon-btn remove" type="button" aria-label="删除子代理" @click="removeSubAgent(agent.id)"><CoomiIcon name="trash" :size="15" /></button>
            </div>
            <div class="agent-selects">
              <label><span>提供商</span><ThemeSelect :model-value="agent.providerId" :options="configuredProviderOptions" title="选择子代理提供商" aria-label="子代理提供商" @update:model-value="setSubAgentProvider(agent, $event)" /></label>
              <label><span>模型</span><ThemeSelect :model-value="agent.model" :options="modelOptions(agent.providerId)" title="选择子代理模型" aria-label="子代理模型" @update:model-value="agent.model = $event" /></label>
            </div>
            <input v-model="agent.description" class="description" maxlength="500" placeholder="用途或模型描述（可选）" />
          </article>
        </div>
        <button v-if="configuredProviders.length && subAgents.length < subAgentLimit" class="add-agent" type="button" @click="addSubAgent"><CoomiIcon name="plus" :size="16" />添加子代理</button>
        <button class="save-agent" type="button" :disabled="savingSubAgents || !subAgentDirty" @click="saveSubAgents">{{ savingSubAgents ? '保存中...' : '保存子代理配置' }}</button>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.tabs { display:flex; gap:3px; margin-bottom:12px; padding:3px; border-radius:var(--r-pill); background:var(--fill-strong); }
.tabs button { display:flex; flex:1; align-items:center; justify-content:center; gap:6px; min-height:36px; border-radius:var(--r-pill); color:var(--text-3); font-size:13.5px; font-weight:600; }
.tabs button.on { background:var(--bg); color:var(--blue); box-shadow:var(--shadow-1); }
.tabs span { font-size:10.5px; }
.icon-btn.blue { color: var(--blue); }
.banner {
  display: flex; align-items: flex-start; gap: 7px; margin-bottom: 12px;
  padding: 10px 12px; border-radius: var(--r-md); background: var(--orange-soft);
  color: #8a4a30; font-size: 12.8px; line-height: 1.55;
}
.banner :deep(svg) { flex-shrink: 0; margin-top: 1px; color: var(--orange); }
.hint { padding: 4px; text-align: center; font-size: 13px; line-height: 1.65; color: var(--text-3); }
.group { overflow: hidden; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.provider-row {
  display: flex; align-items: center; gap: 11px; width: 100%; min-height: 66px;
  padding: 11px 13px; text-align: left; background: var(--bg);
}
.provider-row + .provider-row { border-top: 1px solid var(--border); }
.provider-row:active { background: var(--fill); }
.tile {
  display: grid; place-items: center; flex-shrink: 0; width: 36px; height: 36px;
  border-radius: 10px; background: var(--fill-strong); color: var(--text-2);
}
.tile.ready { color: var(--ok); background: var(--ok-soft); }
.tile.on { color: var(--blue); background: var(--blue-soft); }
.row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14.5px; font-weight: 600; color: var(--text); }
.meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); }
.status { flex-shrink: 0; padding: 3px 8px; border-radius: var(--r-pill); font-size: 11px; font-weight: 650; }
.status.unconfigured { color: var(--text-3); background: var(--fill); }
.status.configured { color: var(--ok); background: var(--ok-soft); }
.status.current { color: var(--blue); background: var(--blue-soft); }
.arrow { flex-shrink: 0; color: var(--text-3); }
.subagent-note { margin:0 3px 11px; color:var(--text-3); font-size:12px; line-height:1.6; }
.agent-limit { display:grid; grid-template-columns:minmax(108px, auto) minmax(0,1fr) 34px; align-items:center; gap:10px; min-height:58px; margin-bottom:10px; padding:8px 12px; border:1px solid var(--border); border-radius:8px; background:var(--bg); }
.agent-limit > span { display:flex; flex-direction:column; line-height:1.35; }
.agent-limit strong { color:var(--text); font-size:13px; }
.agent-limit small { color:var(--text-3); font-size:10px; }
.agent-limit input { width:100%; accent-color:var(--blue); }
.agent-limit output { display:grid; place-items:center; width:34px; height:30px; border-radius:6px; background:var(--blue-soft); color:var(--blue); font-size:12px; font-weight:700; font-variant-numeric:tabular-nums; }
.notice { margin:0 0 10px; padding:9px 11px; border-radius:var(--r-md); font-size:12.5px; line-height:1.5; }
.notice.ok { color:var(--ok); background:var(--ok-soft); }
.notice.err { color:var(--danger); background:var(--danger-soft); }
.empty-state { display:flex; align-items:center; flex-direction:column; gap:6px; padding:27px 16px; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:var(--text-3); text-align:center; }
.empty-state b { color:var(--text); font-size:14px; }
.empty-state span { font-size:12px; line-height:1.5; }
.agent-list { overflow:hidden; border:1px solid var(--border); border-radius:8px; background:var(--bg); }
.agent-item { padding:12px; }
.agent-item + .agent-item { border-top:1px solid var(--border); }
.agent-head { display:grid; grid-template-columns:28px minmax(0,1fr) auto 30px; align-items:center; gap:7px; }
.agent-mark { display:grid; place-items:center; width:27px; height:27px; border-radius:6px; background:var(--blue-soft); color:var(--blue); }
.agent-head code { overflow:hidden; color:var(--text-2); font-family:var(--font-mono); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.fallback { display:flex; align-items:center; gap:4px; color:var(--text-2); font-size:11.5px; }
.fallback input { width:15px; height:15px; margin:0; accent-color:var(--blue); }
.remove { width:30px; height:30px; color:var(--danger); }
.agent-selects { display:grid; grid-template-columns:minmax(0, .8fr) minmax(0, 1.2fr); gap:7px; margin-top:9px; }
.agent-selects label { display:flex; min-width:0; flex-direction:column; gap:4px; color:var(--text-3); font-size:10px; }
.agent-selects .select-trigger, .description { width:100%; min-width:0; min-height:36px; padding:0 9px; border:1px solid var(--border); border-radius:5px; background:var(--fill); color:var(--text); font-size:12px; }
.description { margin-top:7px; }
.add-agent, .save-agent { display:flex; align-items:center; justify-content:center; gap:6px; width:100%; min-height:42px; margin-top:10px; border-radius:8px; font-size:13px; }
.add-agent { border:1px solid var(--border); background:var(--bg); color:var(--blue); }
.save-agent { background:var(--blue); color:#fff; }
.save-agent:disabled { background:var(--fill-strong); color:var(--text-3); }
</style>
