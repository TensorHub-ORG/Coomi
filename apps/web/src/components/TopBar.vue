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
import ContextTools from './ContextTools.vue'
import UsageDetails from './UsageDetails.vue'
import { displayModelName } from '@/stores/config'

defineEmits<{ menu: [] }>()
const props = defineProps<{ floating?: boolean }>()

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

    <ContextTools :floating="props.floating" :usage-percent="usagePercent" @usage="toggleUsage" @open="usageOpen = false; modelOpen = false">
      <template #usage><UsageDetails :runtime-info="runtimeInfo" :env-badge-class="envBadgeClass" :env-badge-label="envBadgeLabel" :env-detail="envDetail" @path="openPathPicker" /></template>
    </ContextTools>

    <Teleport to="body">
    <button v-if="usageOpen" class="usage-scrim" aria-label="关闭上下文数据" @click="usageOpen = false" />
    <div v-if="usageOpen" class="usage-menu">
      <UsageDetails :runtime-info="runtimeInfo" :env-badge-class="envBadgeClass" :env-badge-label="envBadgeLabel" :env-detail="envDetail" @path="openPathPicker" />
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
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
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
  width: min(92vw, 390px); max-height: min(72vh, 560px);
  overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent;
  padding: 12px 13px; padding-right: 10px;
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
  transform-origin: top right; animation: usage-pop .2s cubic-bezier(.2, .9, .3, 1.15) both;
}
/* 滚动条内收：轨道上下留出圆角半径的边距，滑块不会伸进圆角视觉区 */
.usage-menu::-webkit-scrollbar { width: 4px; }
.usage-menu::-webkit-scrollbar-track { margin: 16px 0; background: transparent; }
.usage-menu::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
@keyframes usage-pop {
  from { opacity: 0; transform: scale(.92) translateY(-6px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
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
  position: relative; flex: 1; min-width: 0;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 36px; padding: 0 6px;
  border: 0; border-radius: var(--r-pill); background: none; color: var(--text);
  transition: background .15s;
}
.center:active { background: var(--fill-strong); }
.model {
  font-size: 15.5px; font-weight: 650; letter-spacing: -.1px;
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
