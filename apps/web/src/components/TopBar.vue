<script setup lang="ts">
/**
 * 顶栏：汉堡 / 模型名 / 上下文用量。
 * 忙的时候底边跑一条 2px 蓝色扫光，让「正在干活」这件事在最顶层也能看见。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { useConnectionStore } from '@/stores/connection'
import { apiGet } from '@/bridge/http'
import CoomiIcon from './CoomiIcon.vue'
import { displayModelName } from '@/stores/config'

defineEmits<{ menu: [] }>()
const props = defineProps<{ floating?: boolean }>()
const canOpenFloatingWindow = computed(() => !props.floating && typeof window.CoomiAndroid?.openFloatingWindow === 'function')

function openFloatingWindow() { window.CoomiAndroid?.openFloatingWindow?.() }

const config = useConfigStore()
const session = useSessionStore()
const connection = useConnectionStore()
const router = useRouter()
const modelOpen = ref(false)
const usageOpen = ref(false)
const pathPickerOpen = ref(false)
const pathInput = ref('')
const pathNotice = ref('')
const activeModelCategory = ref('')
const pathQuickOptions = computed(() => session.cwd ? [session.cwd] : [])
// 按能力三分类（文本/图像理解/图像生成），恢复 v1.4.4 的模型选择卡片；
// DeepSeek 账号模型归入文本模型。行内保留供应商标注。
const modelGroups = computed(() => {
  const groups: Record<'text' | 'vision' | 'image', Array<{ providerId: string; provider: string; model: string }>> = { text: [], vision: [], image: [] }
  for (const provider of [...config.providers].sort((a, b) => Number(b.id === config.activeId) - Number(a.id === config.activeId))) {
    for (const model of new Set([...(provider.models ?? []), provider.model].filter(Boolean))) {
      const capabilities = provider.capabilityOverrides?.[model!]
      const item = { providerId: provider.id, provider: provider.name, model: model! }
      if (capabilities?.text ?? true) groups.text.push(item)
      if (capabilities?.vision ?? false) groups.vision.push(item)
      if (capabilities?.image_generation ?? false) groups.image.push(item)
    }
  }
  return [
    { id: 'text' as const, label: '文本模型', items: groups.text },
    { id: 'vision' as const, label: '图像理解', items: groups.vision },
    { id: 'image' as const, label: '图像生成', items: groups.image },
  ]
})
const activeModelGroup = computed(() => modelGroups.value.find(group => group.id === activeModelCategory.value) ?? {
  id: '__empty__',
  label: '分类',
  items: [] as Array<{ providerId: string; provider: string; model: string }>,
})
const usagePercent = computed(() => Math.min(100, Math.max(0, Math.round((session.usage?.contextRatio ?? 0) * 100))))
const usageStroke = computed(() => `${usagePercent.value} ${100 - usagePercent.value}`)
const effortLabels = { auto: '自动', low: '低', medium: '中', high: '高', xhigh: '超高' } as const
const categoryLabels = { system_tools: '系统工具', messages: '消息', skills: '技能', mcp_tools: 'MCP 工具', system_prompt: '系统提示', other: '其他' } as const
const categoryTotal = computed(() => Object.values(session.usage?.contextCategories ?? {}).reduce((sum, value) => sum + (value ?? 0), 0))
function categoryPercent(value: number | undefined): string {
  return categoryTotal.value > 0 ? `${((value ?? 0) / categoryTotal.value * 100).toFixed(1)}%` : '--'
}

function formatTokens(value: number): string {
  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M'
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
  return String(value)
}
function formatPercent(value: number | null | undefined): string {
  return value == null ? '暂无缓存数据' : `${(value * 100).toFixed(1)}%`
}
function formatDuration(value: number | null | undefined): string {
  if (value == null) return '--'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`
}

function choose(providerId: string, model: string) {
  session.selectModel(providerId, model)
  modelOpen.value = false
}

// ── 运行环境（上下文环卡片底部徽标，来自 /api/runtime/doctor 真检测）──
interface RuntimeDoctor {
  runtime: { backend?: string; status?: string; active_version?: string | null; error?: string | null }
  facts?: {
    backend?: string; sh?: boolean; python?: string | null; git?: string | null
    node?: string | null; curl?: string | null; workspace?: boolean; tmp_writable?: boolean
  } | null
  termux_available?: boolean
}
const runtimeInfo = ref<RuntimeDoctor | null>(null)
const envBadgeClass = computed(() => {
  const runtime = runtimeInfo.value?.runtime
  if (runtime?.status === 'ready' && runtimeInfo.value?.facts?.sh) return 'ok'
  if (runtime?.status === 'ready') return 'warn'
  if (runtimeInfo.value?.termux_available) return 'warn'
  return 'down'
})
const envBadgeLabel = computed(() => {
  const doctor = runtimeInfo.value
  const runtime = doctor?.runtime
  if (runtime?.status === 'ready') {
    return doctor?.facts?.sh ? 'Debian 12 · proot' : '环境异常'
  }
  if (doctor?.termux_available) return 'Termux 降级'
  return '运行环境未就绪'
})
const envDetail = computed(() => {
  const facts = runtimeInfo.value?.facts
  if (!facts) return ''
  const parts: string[] = []
  if (facts.python) parts.push(`python ${facts.python.replace(/^Python /, '')}`)
  if (facts.git) parts.push(`git ${facts.git.replace(/^git version /, '')}`)
  if (facts.node) parts.push(`node ${facts.node}`)
  if (facts.workspace !== false) parts.push('/workspace ✓')
  return parts.join(' · ')
})
onMounted(async () => {
  try {
    runtimeInfo.value = await apiGet<RuntimeDoctor>('/api/runtime/doctor')
  } catch {
    runtimeInfo.value = null
  }
})

function toggleModel() {
  modelOpen.value = !modelOpen.value
  usageOpen.value = false
  if (modelOpen.value) {
    const selected = modelGroups.value.find(group => group.items.some(item => (
      item.providerId === config.currentProviderId && item.model === config.currentModel
    )))
    activeModelCategory.value = selected?.id ?? modelGroups.value[0]?.id ?? ''
  }
}

function toggleUsage() {
  usageOpen.value = !usageOpen.value
  modelOpen.value = false
}

// ── 会话标记路径（第三批 5：绑定为会话执行目录）──
function openPathPicker() {
  pathInput.value = session.cwd || ''
  pathNotice.value = ''
  pathPickerOpen.value = true
  usageOpen.value = false
}

function pickPath(path: string) {
  pathInput.value = path
}

async function savePath() {
  const path = pathInput.value.trim()
  if (!path) return
  const ok = await session.setSessionCwd(path)
  pathNotice.value = ok ? '已设置，后续对话将在此目录执行' : '设置失败：路径不存在或引擎不可用'
  if (ok) setTimeout(() => { pathPickerOpen.value = false }, 900)
}

function browseInFileManager() {
  pathPickerOpen.value = false
  router.push('/files')
}
</script>

<template>
  <header class="topbar">
    <button class="icon-btn" aria-label="会话历史" @click="$emit('menu')">
      <CoomiIcon name="menu" />
    </button>

    <button class="center" :aria-expanded="modelOpen" @click="toggleModel">
      <span class="model">{{ displayModelName(config.currentModel) }}</span>
      <span v-if="connection.demo" class="demo">演示</span>
      <span v-if="config.planMode" class="plan">计划</span>
      <CoomiIcon name="chevronDown" :size="13" class="caret" />
    </button>

    <Teleport to="body">
    <button v-if="modelOpen" class="model-scrim" aria-label="关闭模型选择" @click="modelOpen = false" />
    <div v-if="modelOpen" class="model-menu">
      <div v-if="modelGroups.length" class="model-tabs" role="tablist" aria-label="按模型能力分类">
        <button
          v-for="group in modelGroups"
          :key="group.id"
          role="tab"
          :aria-selected="activeModelCategory === group.id"
          :class="{ active: activeModelCategory === group.id }"
          @click="activeModelCategory = group.id"
        >{{ group.label }}</button>
      </div>
      <section class="model-list" role="tabpanel">
        <button
          v-for="item in activeModelGroup.items" :key="item.providerId + ':' + item.model" class="model-row"
          :class="{ selected: item.providerId === config.currentProviderId && item.model === config.currentModel }"
          @click="choose(item.providerId, item.model)"
        >
          <span><b>{{ displayModelName(item.model) }}</b><small>{{ item.provider }}</small></span>
          <CoomiIcon v-if="item.providerId === config.currentProviderId && item.model === config.currentModel" name="check" :size="15" />
        </button>
        <p v-if="activeModelGroup.items.length === 0" class="model-empty">{{ modelGroups.length ? '该分类暂无可用模型' : '暂无已配置供应商' }}</p>
      </section>
    </div>
    </Teleport>

    <button
      v-if="canOpenFloatingWindow"
      class="icon-btn floating-button"
      type="button"
      title="小窗聊天"
      aria-label="小窗聊天"
      @click="openFloatingWindow"
    >
      <CoomiIcon name="floatingWindow" />
    </button>

    <button class="usage-button" :aria-expanded="usageOpen" aria-label="上下文用量" @click="toggleUsage">
      <svg class="usage-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle class="usage-track" cx="18" cy="18" r="15" pathLength="100" />
        <circle class="usage-value" cx="18" cy="18" r="15" pathLength="100" :stroke-dasharray="usageStroke" />
      </svg>
    </button>

    <Teleport to="body">
    <button v-if="usageOpen" class="usage-scrim" aria-label="关闭上下文数据" @click="usageOpen = false" />
    <div v-if="usageOpen" class="usage-menu">
      <p class="usage-title">上下文用量</p>
      <div v-if="session.usage" class="usage-stats">
        <div><span>会话 Token</span><strong>{{ formatTokens(session.usage.total) }}</strong></div>
        <div><span>输出速度</span><strong>{{ session.usage.outputTokensPerSecond == null ? '--' : `${session.usage.outputTokensPerSecond.toFixed(1)} token/s` }}</strong></div>
        <div><span>首 token 延迟</span><strong>{{ session.usage.firstTokenLatencyMs == null ? '--' : formatDuration(session.usage.firstTokenLatencyMs) }}</strong></div>
        <div><span>本轮总 token</span><strong>{{ session.usage.turnTotalTokens == null ? '--' : formatTokens(session.usage.turnTotalTokens) }}</strong></div>
        <div><span>上下文使用</span><strong>{{ formatTokens(session.usage.contextUsed) }} / {{ formatTokens(session.usage.contextWindow) }}</strong></div>
        <div><span>本轮缓存命中</span><strong>{{ formatPercent(session.usage.turnCacheHitRate) }}</strong></div>
        <div><span>会话平均命中</span><strong>{{ formatPercent(session.usage.cacheHitRate) }}</strong></div>
      </div>
      <p v-else class="usage-empty">此对话尚无用量数据</p>
      <template v-if="session.usage">
        <p class="usage-subtitle">上下文构成</p>
        <div class="category-grid">
          <div v-for="(label, category) in categoryLabels" :key="category"><span>{{ label }}</span><strong>{{ categoryPercent(session.usage.contextCategories[category]) }}</strong></div>
        </div>
        <p class="usage-subtitle">各推理强度均轮统计</p>
        <div class="effort-table">
          <div class="effort-head"><span>强度</span><span>命中</span><span>耗时</span><span>用量</span></div>
          <div v-for="(label, effort) in effortLabels" :key="effort" class="effort-row">
            <span>{{ label }}</span>
            <span>{{ formatPercent(session.usage.reasoningEfforts[effort]?.cache_hit_rate) }}</span>
            <span>{{ formatDuration(session.usage.reasoningEfforts[effort]?.average_duration_ms) }}</span>
            <span>{{ session.usage.reasoningEfforts[effort]?.average_total_tokens == null ? '--' : formatTokens(session.usage.reasoningEfforts[effort]!.average_total_tokens!) }}</span>
          </div>
        </div>
      </template>
      <div class="usage-path">
        <span>会话标记路径</span>
        <button class="path-btn" @click="openPathPicker">{{ session.cwd || '点击选择' }}</button>
      </div>
      <div v-if="runtimeInfo" class="usage-env">
        <span>运行环境</span>
        <span class="env-row">
          <em class="env-badge" :class="envBadgeClass">{{ envBadgeLabel }}</em>
          <small v-if="envDetail" class="env-detail">{{ envDetail }}</small>
        </span>
      </div>
    </div>

    </Teleport>

    <div v-if="pathPickerOpen" class="path-mask" @click="pathPickerOpen = false">
      <div class="path-sheet" @click.stop>
        <p class="path-title">会话标记路径</p>
        <p class="path-desc">绑定为当前会话的执行目录，coomi 将在此目录下工作。</p>
        <input v-model="pathInput" class="path-input" placeholder="输入运行时路径" spellcheck="false" @keyup.enter="savePath" />
        <div class="path-quick">
          <button v-for="p in pathQuickOptions" :key="p" class="chip" @click="pickPath(p)">当前工作目录</button>
          <button class="chip" @click="browseInFileManager">在文件管理器中浏览…</button>
        </div>
        <p v-if="pathNotice" class="path-notice">{{ pathNotice }}</p>
        <div class="path-actions">
          <button class="btn ghost" @click="pathPickerOpen = false">取消</button>
          <button class="btn primary" @click="savePath">设置</button>
        </div>
      </div>
    </div>

    <div v-if="session.isBusy" class="sweep"><i /></div>
  </header>
</template>

<style scoped>
.topbar {
  position: relative;
  display: flex; align-items: center; justify-content: space-between; gap: 4px; flex-shrink: 0;
  min-height: 52px; padding: calc(var(--safe-top) + 6px) 8px 6px;
  background: var(--bg);
}
.model-scrim { position: fixed; inset: 0; z-index: 19; border: 0; background: rgba(0,0,0,0.3); }
.model-menu {
  position: fixed; z-index: 20; top: calc(var(--safe-top) + 49px); left: 50%;
  width: min(78vw, 300px); max-height: min(70vh, 420px); overflow-y: auto;
  transform: translateX(-50%); padding: 6px; border: 1px solid var(--border);
  border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-2);
  animation: menu-pop .2s cubic-bezier(.2, .9, .3, 1.2) both;
}
@keyframes menu-pop {
  from { opacity: 0; transform: translateX(-50%) translateY(-6px) scale(.97); }
  to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}
.model-tabs {
  display: flex; flex-wrap: nowrap; overflow-x: hidden; scrollbar-width: none;
  max-width: 100%; min-height: 42px; border-bottom: 1px solid var(--border);
}
.model-tabs::-webkit-scrollbar { display: none; }
.model-tabs button {
  position: relative; flex: 1; min-width: 0; padding: 0 2px;
  color: var(--text-3); font-size: 11.5px; font-weight: 600;
  white-space: nowrap; text-align: center;
}
.model-tabs button.active { color: var(--blue); }
.model-tabs button.active::after {
  content: ''; position: absolute; right: 18%; bottom: -1px; left: 18%;
  height: 2px; border-radius: 2px; background: var(--blue);
}
.model-list { max-height: min(43vh, 322px); overflow-y: auto; padding-top: 5px; scrollbar-width: none; }
.model-list::-webkit-scrollbar { display: none; }
.usage-scrim { position: fixed; inset: 0; z-index: 19; border: 0; background: transparent; }
.usage-menu {
  position: absolute; z-index: 20; top: calc(var(--safe-top) + 49px); right: 8px;
  width: min(92vw, 390px); max-height: min(72vh, 560px); overflow-y: auto; padding: 12px 13px;
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
  transform-origin: top right; animation: usage-pop .2s cubic-bezier(.2, .9, .3, 1.15) both;
}
@keyframes usage-pop {
  from { opacity: 0; transform: scale(.92) translateY(-6px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
.usage-title { margin: 0 0 9px; font-size: 12px; font-weight: 650; color: var(--text-2); }
.usage-stats { display: grid; gap: 8px; }
.usage-stats div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.usage-stats span { font-size: 12px; color: var(--text-3); }
.usage-stats strong { font-family: var(--font-mono); font-size: 12.5px; color: var(--text); }
.usage-empty { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-3); }
.usage-subtitle { margin: 12px 0 6px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 11.5px; font-weight: 650; color: var(--text-2); }
.category-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px 12px; }
.category-grid div { display:flex; justify-content:space-between; gap:8px; font-size:11px; }
.category-grid span { color:var(--text-3); }
.category-grid strong { color:var(--text-2); font-family:var(--font-mono); }
.effort-table { display: grid; gap: 1px; font-variant-numeric: tabular-nums; }
.effort-head, .effort-row { display: grid; grid-template-columns: 34px minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 5px; min-height: 27px; overflow-wrap: anywhere; }
.effort-head { color: var(--text-3); font-size: 10.5px; }
.effort-row { border-top: 1px solid var(--border); color: var(--text-2); font-size: 11px; }
.effort-head span:not(:first-child), .effort-row span:not(:first-child) { text-align: right; }
.usage-path {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--border);
}
.usage-path span { font-size: 12px; color: var(--text-3); flex-shrink: 0; }
.usage-env {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 6px; padding-top: 9px; border-top: 1px solid var(--border);
}
.usage-env > span { font-size: 12px; color: var(--text-3); flex-shrink: 0; }
.usage-env .env-row { display: flex; flex-direction: column; gap: 3px; align-items: flex-end; min-width: 0; }
.env-badge {
  font-style: normal; font-size: 11px; padding: 3px 9px; border-radius: var(--r-pill);
  white-space: nowrap;
}
.env-badge.ok { background: var(--ok-soft, #e8f5ee); color: var(--ok, #18794e); }
.env-badge.warn { background: var(--warn-soft, #fdf3e2); color: var(--focus, #b4690e); }
.env-badge.down { background: var(--fill); color: var(--text-3); }
.env-detail { font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.path-btn {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-mono); font-size: 11.5px; color: var(--blue);
  background: var(--blue-soft); border-radius: var(--r-sm); padding: 5px 9px;
}
.path-mask { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.4); display: flex; align-items: flex-end; }
.path-sheet {
  max-height: 100%; overflow-y: auto;
  width: 100%;
  background: var(--bg-card);
  border-radius: 18px 18px 0 0;
  padding: 18px 16px calc(16px + var(--safe-bottom));
}
.path-title { margin: 0; font-size: 16px; font-weight: 650; }
.path-desc { margin: 4px 0 12px; font-size: 12.5px; color: var(--text-3); }
.path-input {
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--bg-input);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12.5px;
}
.path-quick { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.chip {
  padding: 6px 12px;
  border-radius: var(--r-pill);
  background: var(--fill-strong);
  color: var(--text-2);
  font-size: 12px;
}
.path-notice { margin: 10px 0 0; font-size: 12.5px; color: var(--ok); }
.path-actions { display: flex; gap: 10px; margin-top: 16px; }
.path-actions .btn { flex: 1; }
.btn.primary { background: var(--blue); color: #fff; }
.btn.ghost { background: var(--fill-strong); color: var(--text); }
.model-row { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 38px; padding: 7px 9px; border: 0; border-radius: var(--r-sm); background: none; color: var(--text); text-align: left; }
.model-row span { display: flex; flex: 1; min-width: 0; flex-direction: column; overflow: hidden; }
.model-row b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 12.5px; font-weight: 500; }
.model-row small { overflow: hidden; color: var(--text-3); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.model-row.selected { background: var(--blue-soft); color: var(--blue); }
.model-row:active { background: var(--fill-press); }
.model-empty { padding: 16px 10px; text-align: center; font-size: 12.5px; color: var(--text-3); }
.icon-btn {
  display: grid; place-items: center; flex-shrink: 0;
  width: 40px; height: 40px;
  border: 0; border-radius: 50%; background: none; color: var(--text-2);
}
.icon-btn:active { background: var(--fill); }
.floating-button:focus-visible { box-shadow: inset 0 0 0 2px var(--blue); }
/* 顶栏流内子元素是 菜单/小窗/用量 三个：space-between 会把小窗按钮挤到正中间，
   被绝对定位的模型名盖住。margin-left:auto 让它靠右与用量按钮成组。 */
.floating-button { margin-left: auto; margin-right: 2px; }
.usage-button {
  position: relative; display: grid; place-items: center; flex-shrink: 0;
  width: 40px; height: 40px; border: 0; border-radius: 50%; background: none; color: var(--text-2);
}
.usage-button:active { background: var(--fill); }
.usage-ring { width: 30px; height: 30px; transform: rotate(-90deg); }
.usage-ring circle { fill: none; stroke-width: 3.8; }
.usage-track { stroke: var(--border-strong); }
.usage-value { stroke: var(--blue); stroke-linecap: round; transition: stroke-dasharray .22s ease; }

.center {
  position: absolute; left: 50%; transform: translateX(-50%);
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 36px; padding: 0 10px; max-width: 60%;
  border: 0; border-radius: var(--r-pill); background: none; color: var(--text);
}
.center:active { background: var(--fill); }
.model {
  font-size: 15.5px; font-weight: 600; letter-spacing: -.1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.plan {
  flex-shrink: 0; padding: 2px 7px; border-radius: var(--r-pill);
  background: var(--blue-soft); color: var(--blue);
  font-size: 11px; font-weight: 600;
}
/* 演示标记用点缀橙，和蓝色的功能性标记（计划）区分开。 */
.demo {
  flex-shrink: 0; padding: 2px 7px; border-radius: var(--r-pill);
  background: var(--orange-soft); color: var(--orange);
  font-size: 11px; font-weight: 600;
}
.caret { color: var(--text-3); }

/* 底边扫光：不表示进度，只表示「还在动」。 */
.sweep {
  position: absolute; left: 0; right: 0; bottom: 0;
  height: 2px; overflow: hidden;
}
.sweep i {
  display: block; width: 100%; height: 100%;
  background: linear-gradient(90deg, transparent, var(--blue), transparent);
  animation: coomi-sweep 1.25s ease-in-out infinite;
}
</style>
