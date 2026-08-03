<script setup lang="ts">
/**
 * Provider / API Key。
 *
 * 两个刻意的选择：
 *   - 明文 key 默认不回填；只有用户主动点击“查看”才通过专用接口读取。
 *   - 删除确认走底部弹层而不是 confirm()：WebView 里原生弹窗经常被吞掉。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useConfigStore, type ProviderConfig } from '@/stores/config'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

const router = useRouter()
const config = useConfigStore()

type ProviderProtocol = 'openai_compatible' | 'openai_responses' | 'anthropic_messages' | 'gemini_native'
type ProviderPresetId = 'deepseek' | 'zhipu' | 'minimax' | 'openai' | 'anthropic' | 'google' | 'custom'

interface ProviderPreset {
  id: ProviderPresetId; name: string; providerId: string; baseUrl: string
  model: string; protocol: ProviderProtocol
}

interface ProviderForm {
  preset: ProviderPresetId; id: string; name: string; apiKey: string; models: string
  baseUrl: string; protocol: ProviderProtocol; contextWindow: number; supportsWebSearch: boolean; supportsVision: boolean
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', protocol: 'openai_compatible' },
  { id: 'zhipu', name: '智谱', providerId: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5', protocol: 'openai_compatible' },
  { id: 'minimax', name: 'Minimax', providerId: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2.7', protocol: 'openai_compatible' },
  { id: 'openai', name: 'OpenAI', providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', protocol: 'openai_responses' },
  { id: 'anthropic', name: 'Anthropic', providerId: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', protocol: 'anthropic_messages' },
  { id: 'google', name: 'Google Gemini', providerId: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash', protocol: 'gemini_native' },
  { id: 'custom', name: '自定义 / 兼容接口', providerId: '', baseUrl: '', model: '', protocol: 'openai_compatible' },
]

const PROTOCOLS: { value: ProviderProtocol; label: string }[] = [
  { value: 'openai_compatible', label: 'OpenAI Compatible' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
  { value: 'gemini_native', label: 'Google Gemini (Native)' },
]

function normalizeProtocol(value?: string): ProviderProtocol {
  if (value === 'openai_responses' || value === 'responses') return 'openai_responses'
  if (value === 'anthropic_messages' || value === 'anthropic') return 'anthropic_messages'
  if (value === 'gemini_native' || value === 'gemini') return 'gemini_native'
  return 'openai_compatible'
}

function formForPreset(id: ProviderPresetId): ProviderForm {
  const preset = PROVIDER_PRESETS.find(item => item.id === id) ?? PROVIDER_PRESETS[0]
  return {
    preset: preset.id, id: preset.providerId, name: preset.id === 'custom' ? '' : preset.name, apiKey: '', models: preset.model,
    baseUrl: preset.baseUrl, protocol: preset.protocol, contextWindow: 256000, supportsWebSearch: false, supportsVision: false,
  }
}

const editing = ref(false)
const isNew = ref(true)
const saving = ref(false)
const showingKey = ref(false)
const discovering = ref(false)
const savedNote = ref('')
const pendingDelete = ref<ProviderConfig | null>(null)
const form = ref<ProviderForm>(formForPreset('deepseek'))

onMounted(() => { void config.fetchProviders() })

const canSave = computed(() => Boolean(
  form.value.id.trim() && form.value.name.trim() && form.value.baseUrl.trim(),
))

function startNew() {
  isNew.value = true
  showingKey.value = false
  savedNote.value = ''
  form.value = formForPreset('deepseek')
  editing.value = true
}

function applyPreset() {
  const apiKey = form.value.apiKey
  form.value = { ...formForPreset(form.value.preset), apiKey }
}

function startEdit(p: ProviderConfig) {
  isNew.value = false
  showingKey.value = false
  const preset = PROVIDER_PRESETS.find(item => item.providerId === p.id)?.id ?? 'custom'
  form.value = {
    preset, id: p.id, name: p.name, apiKey: '', models: p.models.join(', '), baseUrl: p.baseUrl ?? '',
    protocol: normalizeProtocol(p.toolProtocol ?? p.type), contextWindow: p.contextWindow ?? 256000,
    supportsWebSearch: !!p.supportsWebSearch,
    supportsVision: !!p.supportsVision,
  }
  editing.value = true
}

async function save(): Promise<boolean> {
  if (!canSave.value) return false
  const f = form.value
  saving.value = true
  const ok = await config.upsertProvider({
    id: f.id.trim(),
    name: f.name.trim(),
    apiKey: f.apiKey.trim(),
    models: f.models.split(',').map(m => m.trim()).filter(Boolean),
    baseUrl: f.baseUrl.trim() || undefined,
    type: f.protocol,
    toolProtocol: f.protocol,
    contextWindow: f.contextWindow,
    activate: true,
    supportsWebSearch: f.supportsWebSearch,
    supportsVision: f.supportsVision,
  })
  saving.value = false
  if (!ok) return false
  if (!form.value.models.trim()) {
    // 模型未填：保存配置但留在编辑页，方便检索模型后补充再保存
    savedNote.value = '已保存配置（尚未设为当前）。点击「检索」拉取模型列表，再点一次保存生效。'
  } else {
    savedNote.value = ''
    editing.value = false
  }
  return true
}

async function copyProvider(p: ProviderConfig) {
  await config.copyProvider(p.id)
}

async function toggleKey() {
  if (showingKey.value) { showingKey.value = false; return }
  if (!isNew.value && !form.value.apiKey) {
    const key = await config.revealProviderKey(form.value.id)
    if (key === null) return
    form.value.apiKey = key
  }
  showingKey.value = true
}

async function discoverModels() {
  if (isNew.value) {
    // 新 Provider：先保存配置（模型可空），再检索模型列表
    const f = form.value
    if (!f.id.trim() || !f.name.trim() || !f.baseUrl.trim()) {
      config.lastError = '请先填写标识、名称和 Base URL 后再检索'
      return
    }
    if (!(await save())) return
  }
  discovering.value = true
  const models = await config.discoverModels(form.value.id)
  discovering.value = false
  if (models) {
    form.value.models = models.join(', ')
    savedNote.value = '模型列表已填入，点「保存并设为当前」完成配置。'
  }
}

async function confirmDelete() {
  const p = pendingDelete.value
  pendingDelete.value = null
  if (p) await config.deleteProvider(p.id)
}

function back() {
  if (editing.value) { editing.value = false; return }
  // 从控制台进入：返回统一回控制台（浏览器环境回聊天主页）
  if (window.CoomiAndroid?.openDashboard) window.CoomiAndroid.openDashboard()
  else router.push('/')
}
</script>
<template>
  <div class="page">
    <PageHead :title="editing ? (isNew ? '添加 Provider' : '编辑 Provider') : 'Provider'" @back="back">
      <template #right>
        <button v-if="!editing" class="icon-btn blue" aria-label="添加" @click="startNew">
          <CoomiIcon name="plus" />
        </button>
      </template>
    </PageHead>

    <main class="body">
      <template v-if="!editing">
        <p v-if="config.usingMock" class="banner">
          <CoomiIcon name="alert" :size="15" />
          <span>后端未连接，下面是本地示例数据，改动不会保存。</span>
        </p>
        <p v-if="config.loading" class="hint">加载中…</p>

        <div v-for="(p, i) in config.providers" :key="p.id" class="card cascade" :style="{ animationDelay: 40 * i + 'ms' }">
          <div class="chead">
            <span class="tile" :class="{ on: p.id === config.activeId }"><CoomiIcon name="key" :size="17" /></span>
            <span class="ctitle">
              <span class="cname">{{ p.name }}</span>
              <code class="cid">{{ p.id }}</code>
            </span>
            <span v-if="p.id === config.activeId" class="badge">当前</span>
          </div>

          <div class="kv"><span class="k">API Key</span><code class="v">{{ p.hasKey ? p.apiKeyMasked : '未设置' }}</code></div>
          <div class="kv model-kv"><span class="k">模型</span><span class="v wrap">{{ p.models.join('、') || '—' }}</span></div>
          <div class="kv"><span class="k">上下文</span><span class="v">{{ ((p.contextWindow ?? 256000) / 1000).toFixed(0) }}k</span></div>
          <div class="kv"><span class="k">兼容模式</span><code class="v">{{ PROTOCOLS.find(item => item.value === normalizeProtocol(p.toolProtocol ?? p.type))?.label }}</code></div>
          <div v-if="p.baseUrl" class="kv"><span class="k">Base URL</span><code class="v wrap">{{ p.baseUrl }}</code></div>

          <div class="acts">
            <button v-if="p.id !== config.activeId" class="act soft" @click="config.activateProvider(p.id)">设为当前</button>
            <button class="act" @click="startEdit(p)">编辑</button>
            <button class="act" @click="copyProvider(p)">复制</button>
            <button class="act danger" @click="pendingDelete = p">删除</button>
          </div>
        </div>

        <p v-if="!config.loading && config.providers.length === 0" class="hint">
          还没有 Provider。点右上角 ＋ 添加一个，填好 API Key 就能开始对话。
        </p>
        <p class="note">API Key 只以后 4 位脱敏展示，界面不回显明文；提交后写入 App 私有目录。</p>
      </template>
      <form v-else class="form" @submit.prevent="save">
        <label v-if="isNew" class="fld">
          <span class="flabel">提供方</span>
          <select v-model="form.preset" class="finput" @change="applyPreset">
            <option v-for="preset in PROVIDER_PRESETS" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
          </select>
        </label>
        <label class="fld">
          <span class="flabel">标识（id）</span>
          <input v-model="form.id" class="finput" :readonly="!isNew || form.preset !== 'custom'" placeholder="如 openai" autocapitalize="off" />
        </label>
        <label class="fld">
          <span class="flabel">名称</span>
          <input v-model="form.name" class="finput" placeholder="如 OpenAI" />
        </label>
        <label class="fld">
          <span class="flabel">API Key</span>
          <span class="input-action">
            <input v-model="form.apiKey" class="finput" :type="showingKey ? 'text' : 'password'" :placeholder="isNew ? 'sk-…' : '留空则沿用原值'" autocapitalize="off" />
            <button type="button" @click="toggleKey">{{ showingKey ? '隐藏' : '查看' }}</button>
          </span>
        </label>
        <label class="fld">
          <span class="flabel">模型（逗号分隔）</span>
          <span class="input-action">
            <input v-model="form.models" class="finput" placeholder="gpt-4o, gpt-4o-mini" autocapitalize="off" />
            <button type="button" :disabled="discovering" @click="discoverModels">{{ discovering ? '检索中' : '检索' }}</button>
          </span>
        </label>
        <label class="fld">
          <span class="flabel">Base URL</span>
          <input v-model="form.baseUrl" class="finput" placeholder="https://api.openai.com/v1" autocapitalize="off" />
        </label>
        <label class="fld">
          <span class="flabel">接口兼容模式</span>
          <select v-model="form.protocol" class="finput">
            <option v-for="protocol in PROTOCOLS" :key="protocol.value" :value="protocol.value">{{ protocol.label }}</option>
          </select>
        </label>
        <label class="fld">
          <span class="flabel">上下文窗口</span>
          <select v-model.number="form.contextWindow" class="finput">
            <option :value="128000">128k</option>
            <option :value="256000">256k（默认）</option>
            <option :value="512000">512k</option>
          </select>
        </label>
        <label class="toggle-row">
          <input v-model="form.supportsWebSearch" type="checkbox" />
          <span>使用 Provider 原生 Web Search</span>
        </label>
        <label class="toggle-row">
          <input v-model="form.supportsVision" type="checkbox" />
          <span class="v-hint">支持图像理解（view_image 会把图片上传给模型识别）<em>仅模型支持视觉时开启</em></span>
        </label>

        <button class="btn btn-primary" type="submit" :disabled="!canSave || saving">
          {{ saving ? '保存中…' : (form.models.trim() ? '保存并设为当前' : '保存配置') }}
        </button>
        <p v-if="savedNote" class="note ok-note">{{ savedNote }}</p>
        <p v-if="config.lastError && !config.usingMock" class="err">保存失败：{{ config.lastError }}</p>
        <p class="note">Key 默认脱敏；只有主动点击“查看”时才读取完整值。</p>
      </form>

    </main>
    <div v-if="pendingDelete" class="scrim" @click.self="pendingDelete = null">
      <div class="sheet">
        <div class="grip" />
        <p class="sq">删除 Provider「{{ pendingDelete.name }}」？</p>
        <p class="ssub">对应的 API Key 也会一起从本机删除，无法恢复。</p>
        <div class="sacts">
          <button class="btn" @click="pendingDelete = null">取消</button>
          <button class="btn btn-danger" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>

  </div>
</template>
<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 14px 12px calc(var(--safe-bottom) + 24px); }
.icon-btn.blue { color: var(--blue); }

.banner {
  display: flex; align-items: flex-start; gap: 7px; margin-bottom: 12px;
  padding: 10px 12px; border-radius: var(--r-md);
  background: var(--orange-soft); color: #8a4a30; font-size: 12.8px; line-height: 1.55;
}
.banner :deep(svg) { flex-shrink: 0; margin-top: 1px; color: var(--orange); }
.hint { padding: 4px 4px 10px; font-size: 13px; line-height: 1.65; color: var(--text-3); }

.card { padding: 13px 14px 12px; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); margin-bottom: 10px; }
.chead { display: flex; align-items: center; gap: 10px; }
.tile {
  display: grid; place-items: center; flex-shrink: 0;
  width: 32px; height: 32px; border-radius: 9px;
  background: var(--fill-strong); color: var(--text-2);
}
.tile.on { background: var(--blue-soft); color: var(--blue); }
.ctitle { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.cname { font-size: 15px; font-weight: 620; color: var(--text); }
.cid { min-width: 0; word-break: break-all; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); }
.badge {
  flex-shrink: 0; padding: 3px 10px; border-radius: var(--r-pill);
  background: var(--blue-soft); color: var(--blue); font-size: 11.5px; font-weight: 650;
}

.kv { display: flex; align-items: baseline; gap: 10px; padding: 5px 0 0; font-size: 13px; }
.kv .k { flex-shrink: 0; min-width: 66px; color: var(--text-3); }
.kv .v { flex: 1; min-width: 0; text-align: right; color: var(--text); }
.kv code.v { font-family: var(--font-mono); font-size: 12px; }
.kv .wrap { word-break: break-all; }
.model-kv .v {
  max-height: 76px; overflow-y: auto; padding-right: 4px;
  overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
}

.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.act {
  flex: 1 1 68px; min-height: 38px; border-radius: var(--r-sm);
  background: var(--fill); color: var(--text-2);
  font-size: 12.8px; font-weight: 600; transition: transform .06s;
}
.act.soft { background: var(--blue-soft); color: var(--blue); }
.act.danger { background: var(--danger-soft); color: var(--danger); }
.act:active { transform: scale(.98); }
.note { margin-top: 14px; padding: 0 4px; font-size: 12px; line-height: 1.7; color: var(--text-3); }
.ok-note { color: var(--ok); }
.err { margin-top: 10px; font-size: 12.5px; line-height: 1.6; color: var(--danger); }

.form { display: flex; flex-direction: column; gap: 12px; }
.fld { display: flex; flex-direction: column; gap: 6px; }
.flabel { padding-left: 4px; font-size: 12.5px; color: var(--text-2); }
.finput {
  min-height: 46px; padding: 0 14px;
  border: 1.5px solid var(--border); border-radius: var(--r-md);
  background: var(--bg); font-size: 14.5px; color: var(--text);
  transition: border-color .14s;
}
.finput::placeholder { color: var(--text-3); }
.finput:focus { outline: none; border-color: var(--blue-border); }
.finput[readonly] { background: var(--fill); color: var(--text-2); }
.input-action { display: flex; align-items: stretch; gap: 7px; }
.input-action .finput { flex: 1; min-width: 0; }
.input-action button { flex: 0 0 58px; border: 0; border-radius: var(--r-sm); background: var(--fill); color: var(--blue); font-size: 12.5px; font-weight: 600; }
.input-action button:disabled { color: var(--text-3); }
.toggle-row { display: flex; align-items: center; gap: 9px; min-height: 40px; padding: 0 4px; color: var(--text-2); font-size: 13px; }
.toggle-row input { width: 18px; height: 18px; accent-color: var(--blue); }
.toggle-row em { font-style: normal; font-size: 11px; color: var(--text-3); margin-left: 2px; }
.form .btn { margin-top: 4px; }

.scrim {
  position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: flex-end;
  background: rgba(17, 22, 31, .36); animation: fade .18s ease-out;
}
@keyframes fade { from { opacity: 0; } }
.sheet {
  width: 100%; padding: 6px 16px calc(var(--safe-bottom) + 16px);
  border-radius: 22px 22px 0 0; background: var(--bg);
  box-shadow: var(--shadow-sheet); animation: rise .26s cubic-bezier(.2, .8, .2, 1);
}
@keyframes rise { from { transform: translateY(100%); } }
.grip { width: 38px; height: 4px; margin: 4px auto 14px; border-radius: 2px; background: var(--border-strong); }
.sq { font-size: 15.5px; font-weight: 620; color: var(--text); }
.ssub { margin-top: 6px; font-size: 13px; line-height: 1.6; color: var(--text-2); }
.sacts { display: flex; gap: 8px; margin-top: 16px; }
.sacts .btn { flex: 1; }

</style>
