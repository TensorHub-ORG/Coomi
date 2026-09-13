<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'
import CoomiIcon from './CoomiIcon.vue'
import PromptLibrary from './PromptLibrary.vue'

const props = defineProps<{ floating?: boolean; usagePercent: number }>()
const emit = defineEmits<{ usage: []; open: [] }>()
const session = useSessionStore()
const tools = [
  { id: 'version', label: '版本工具', icon: 'git' },
  { id: 'prompts', label: '提示词', icon: 'pencil' },
  { id: 'auxiliary', label: '辅助会话', icon: 'chat' },
  { id: 'usage', label: '上下文用量', icon: 'tachometer' },
  { id: 'files', label: '文件管理', icon: 'folder' },
  { id: 'floating', label: '小窗', icon: 'floatingWindow' },
] as const
type Tool = typeof tools[number]['id']
const versionViews = {
  git: defineAsyncComponent(() => import('@/views/GitPanelView.vue')),
  restore: defineAsyncComponent(() => import('@/views/RestoreView.vue')),
  ops: defineAsyncComponent(() => import('@/views/OpsView.vue')),
  data: defineAsyncComponent(() => import('@/views/DataView.vue')),
}
const AuxiliaryChat = defineAsyncComponent(() => import('./AuxiliaryChat.vue'))
const FileManager = defineAsyncComponent(() => import('@/views/FileManagerView.vue'))
const versionTabs = [{ id: 'git', label: 'Git 面板' }, { id: 'restore', label: '一键还原' }, { id: 'ops', label: '运维诊断' }, { id: 'data', label: '数据工具' }] as const
const version = ref<keyof typeof versionViews>('git')
const opened = ref(false), active = ref<Tool | 'usage' | null>(null)
const anchor = ref<HTMLButtonElement | null>(null)
const closeAnchor = ref<HTMLButtonElement | null>(null)
const card = ref<HTMLElement | null>(null)
const initialChild = ref('')
let mounted = true
let auxiliaryRequest = 0
let anchorObserver: ResizeObserver | null = null
let measureFrame = 0
const bounds = ref({ x: 0, y: 0, width: 360, height: 640 })
// Keep a real touch target even in narrow windows; shrinking this fan clips text.
const radius = ref(136)
const notch = computed(() => radius.value + 6)
const title = computed(() => active.value === 'usage' ? '上下文用量' : tools.find(t => t.id === active.value)?.label ?? '')
const nativeFloating = computed(() => typeof window.CoomiAndroid?.openFloatingWindow === 'function')
const overlayStyle = computed(() => ({
  '--anchor-x': `${bounds.value.x}px`, '--anchor-y': `${bounds.value.y}px`,
  '--orbit-radius': `${radius.value}px`, '--notch': `${notch.value}px`,
  '--card-width': `${Math.max(180, Math.min(440, bounds.value.x - 10))}px`,
  '--card-height': `${Math.max(180, Math.min(720, bounds.value.height - bounds.value.y - 12))}px`,
}))
function measure() {
  const rect = anchor.value?.getBoundingClientRect()
  if (!rect) return
  const viewport = window.visualViewport
  const next = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
    width: viewport?.width ?? innerWidth,
    height: (viewport?.height ?? innerHeight) + (viewport?.offsetTop ?? 0) }
  if (Object.keys(next).some(key => next[key as keyof typeof next] !== bounds.value[key as keyof typeof next])) bounds.value = next
}
function afterAncestorMotion(event: Event) {
  // Router entry transforms move the anchor without resizing it. Opening the
  // tools during that transition otherwise freezes the fan at its initial Y.
  if (opened.value && event.target instanceof Element && anchor.value
      && event.target.contains(anchor.value)) measure()
}
function toggle() {
  auxiliaryRequest++
  if (opened.value) { opened.value = false; active.value = null; void nextTick(() => anchor.value?.focus()) }
  else { measure(); opened.value = true; emit('open') }
}
function choose(id: Tool) {
  active.value = active.value === id ? null : id
  initialChild.value = ''
}
function outside(event: PointerEvent) {
  if (!active.value) return
  const target = event.target as Element | null
  if (target?.closest('[data-context-tools]')) return
  active.value = null
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && active.value) { event.preventDefault(); active.value = null; closeAnchor.value?.focus() }
}
function fill(text: string) {
  window.dispatchEvent(new CustomEvent('coomi:prefill-draft', { detail: { sessionId: session.sessionId, text } }))
  active.value = null
}
function showUsage() { active.value = 'usage' }
function openFloating() { window.CoomiAndroid?.openFloatingWindow?.() }
async function openAuxiliary(event: Event) {
  const detail = (event as CustomEvent<{ parentId: string; sessionId: string }>).detail
  if (!detail?.parentId || !detail.sessionId || props.floating) return
  const request = ++auxiliaryRequest
  if (session.sessionId !== detail.parentId) await session.openSession(detail.parentId)
  await nextTick()
  if (!mounted || props.floating || request !== auxiliaryRequest || session.sessionId !== detail.parentId) return
  measure(); opened.value = true; active.value = 'auxiliary'; initialChild.value = detail.sessionId; emit('open')
}
watch(() => props.floating, floating => { if (floating) { auxiliaryRequest++; opened.value = false; active.value = null } })
watch(opened, async value => {
  cancelAnimationFrame(measureFrame)
  if (!value) return
  await nextTick()
  if (!mounted || !opened.value) return
  measure()
  closeAnchor.value?.focus()
  // Follow an in-flight route entry transform until the opening motion settles.
  // ResizeObserver alone cannot see transforms; stop polling after this burst.
  const until = performance.now() + 400
  const followOpening = () => {
    if (!mounted || !opened.value) return
    measure()
    if (performance.now() < until) measureFrame = requestAnimationFrame(followOpening)
  }
  measureFrame = requestAnimationFrame(followOpening)
})
watch(() => session.sessionId, () => { active.value = null; initialChild.value = '' })
watch(active, value => {
  if (value) registerOverlay('context-tool-card', () => { active.value = null })
  else unregisterOverlay('context-tool-card')
})
onMounted(() => {
  measure()
  // Font loading, model labels and safe-area changes can resize the header
  // without a viewport resize. Keep the teleported fan on its actual anchor.
  if (typeof ResizeObserver !== 'undefined' && anchor.value) {
    anchorObserver = new ResizeObserver(measure)
    anchorObserver.observe(anchor.value)
    const header = anchor.value.closest('header')
    if (header) anchorObserver.observe(header, { box: 'border-box' })
  }
  window.addEventListener('resize', measure)
  window.visualViewport?.addEventListener('resize', measure)
  window.visualViewport?.addEventListener('scroll', measure)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', keydown)
  document.addEventListener('transitionend', afterAncestorMotion, true)
  document.addEventListener('animationend', afterAncestorMotion, true)
  window.addEventListener('coomi:open-auxiliary', openAuxiliary)
})
onBeforeUnmount(() => {
  mounted = false
  auxiliaryRequest++
  cancelAnimationFrame(measureFrame)
  anchorObserver?.disconnect()
  anchorObserver = null
  window.removeEventListener('resize', measure)
  window.visualViewport?.removeEventListener('resize', measure)
  window.visualViewport?.removeEventListener('scroll', measure)
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('keydown', keydown)
  document.removeEventListener('transitionend', afterAncestorMotion, true)
  document.removeEventListener('animationend', afterAncestorMotion, true)
  window.removeEventListener('coomi:open-auxiliary', openAuxiliary)
  unregisterOverlay('context-tool-card')
})
// Flat fan surface; labels live in independent rounded targets, never inside
// a polygon clip. Short labels leave space for Android's enlarged text setting.
const shortLabels: Record<Tool, string> = { version: '版本', prompts: '提示', auxiliary: '辅助', usage: '用量', files: '文件', floating: '小窗' }
const sectors = computed(() => tools.map((tool, index) => {
  const row = index < 3 ? 2 : index < 5 ? 1 : 0
  const [x, y] = [[-112, 30], [-82, 82], [-30, 112], [-70, 30], [-30, 70], [-30, 30]][index]!
  return { ...tool, row, style: {
    left: `${radius.value + x!}px`, top: `${y}px`,
  } }
}))
</script>
<template>
  <div class="context-tools" data-context-tools>
    <button v-if="!floating" class="entry" :class="{ concealed: opened }" :aria-hidden="opened || undefined" :tabindex="opened ? -1 : 0" aria-label="展开快捷工具" :aria-expanded="opened" @click="toggle"><CoomiIcon name="more" :size="21" /></button>
    <button ref="anchor" class="context-anchor" :class="{ expanded: opened }" :aria-hidden="opened || undefined" :tabindex="opened ? -1 : 0" aria-label="上下文用量" :aria-expanded="opened" @click="opened ? toggle() : emit('usage')">
      <svg viewBox="0 0 36 36" aria-hidden="true"><circle class="track" cx="18" cy="18" r="15" pathLength="100" /><circle class="value" cx="18" cy="18" r="15" pathLength="100" :stroke-dasharray="`${usagePercent} ${100 - usagePercent}`" /></svg>
      <CoomiIcon v-if="opened" class="close-mark" name="close" :size="15" />
    </button>
    <Teleport to="body">
      <Transition name="orbit-veil"><div v-if="opened && active" class="orbit-backdrop" aria-hidden="true" @pointerdown="active = null" /></Transition>
      <Transition name="orbit-reveal" :duration="280">
      <div v-if="opened" class="orbit-layer" :style="overlayStyle" data-context-tools>
        <button ref="closeAnchor" class="context-anchor orbit-anchor" aria-label="关闭快捷工具带" aria-expanded="true" @click="toggle">
          <svg viewBox="0 0 36 36" aria-hidden="true"><circle class="track" cx="18" cy="18" r="15" pathLength="100" /><circle class="value" cx="18" cy="18" r="15" pathLength="100" :stroke-dasharray="`${usagePercent} ${100 - usagePercent}`" /></svg>
          <CoomiIcon class="close-mark" name="close" :size="15" />
        </button>
        <Transition name="card-reveal" mode="out-in">
        <section v-if="active" ref="card" class="orbit-card" :class="{ compact: active === 'usage' || active === 'floating' }" role="dialog" :aria-label="title" aria-modal="false">
          <header class="card-heading"><span class="eyebrow">快捷工具</span><h2>{{ title }}</h2><button class="usage-link" @click="showUsage">上下文 {{ usagePercent }}%<CoomiIcon name="chevronRight" :size="12" /></button><button class="card-close" aria-label="关闭工具卡片" @click="active = null">收起卡片</button></header>
          <div class="card-content">
            <slot v-if="active === 'usage'" name="usage" />
            <template v-else-if="active === 'version'">
              <nav class="version-tabs" aria-label="版本管理工具"><button v-for="tab in versionTabs" :key="tab.id" :class="{ selected: version === tab.id }" @click="version = tab.id">{{ tab.label }}</button></nav>
              <div class="version-content"><component :is="versionViews[version]" embedded /></div>
            </template>
            <PromptLibrary v-else-if="active === 'prompts'" @fill="fill" />
            <AuxiliaryChat v-else-if="active === 'auxiliary'" :parent-id="session.sessionId" :initial-session-id="initialChild" />
            <FileManager v-else-if="active === 'files'" embedded />
            <div v-else class="floating-content"><CoomiIcon name="floatingWindow" :size="30" /><h3>小窗聊天</h3><p>{{ nativeFloating ? '将当前聊天移入悬浮窗口，切换应用时也能继续查看进展。' : '小窗聊天可在 Android 应用中使用。' }}</p><button v-if="nativeFloating" class="floating-action" @click="openFloating">打开悬浮窗口</button></div>
          </div>
        </section>
        </Transition>
        <nav class="orbit-band" aria-label="快捷工具带">
          <svg class="fan-surface" :viewBox="`0 0 ${radius} ${radius}`" aria-hidden="true"><path :d="`M 0 0 A ${radius} ${radius} 0 0 0 ${radius} ${radius} L ${radius} 22 A 22 22 0 0 1 ${radius - 22} 0 Z`" /></svg>
          <button v-for="tool in sectors" :key="tool.id" class="orbit-tool" :class="{ selected: active === tool.id }" :style="tool.style" :data-row="tool.row" :aria-label="tool.label" :title="tool.label" :aria-pressed="active === tool.id" @click="choose(tool.id)"><span class="tool-label"><CoomiIcon :name="tool.icon" :size="16" /><span>{{ shortLabels[tool.id] }}</span></span></button>
        </nav>
      </div>
      </Transition>
    </Teleport>
  </div>
</template>
<style scoped>
.context-tools { display:flex; align-items:center; gap:2px; margin-left:auto; flex-shrink:0; }
.entry,.context-anchor { width:40px; height:40px; border:0; border-radius:50%; display:grid; place-items:center; background:transparent; color:var(--text-2); flex-shrink:0; }
.entry:active { background:var(--fill); }
.entry.concealed { visibility:hidden; }
.context-anchor { position:relative; transform:translate(4px,-3px); }
.context-anchor.expanded { visibility:hidden; }
.context-anchor.orbit-anchor { position:absolute; left:var(--anchor-x); top:var(--anchor-y); transform:translate(-50%,-50%); z-index:2; background:var(--bg); pointer-events:auto; }
.context-anchor > svg { width:30px; height:30px; transform:rotate(-90deg); }
.context-anchor circle { fill:none; stroke-width:3.8; }
.track { stroke:var(--border-strong); }.value { stroke:var(--blue); stroke-linecap:round; }
.context-anchor :deep(.close-mark) { position:absolute; width:15px; height:15px; transform:none; }
.orbit-layer { position:fixed; inset:0; z-index:40; pointer-events:none; }
.orbit-backdrop { position:fixed; inset:0; z-index:39; background:rgba(25,35,52,.07); -webkit-backdrop-filter:blur(3px); backdrop-filter:blur(3px); }
.orbit-band { position:absolute; left:calc(var(--anchor-x) - var(--orbit-radius)); top:var(--anchor-y); width:var(--orbit-radius); height:var(--orbit-radius); filter:drop-shadow(0 2px 5px rgba(23,32,54,.05)); transform-origin:top right; }
.fan-surface { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
.fan-surface path { fill:var(--bg); stroke:var(--border); stroke-width:.75; }
.orbit-tool { position:absolute; width:40px; height:38px; transform:translate(-50%,-50%); border:0; border-radius:10px; padding:0; color:var(--text-2); background:transparent; pointer-events:auto; display:grid; place-items:center; transition:background 160ms ease,color 160ms ease; }
.tool-label { display:flex; flex-direction:column; align-items:center; gap:3px; pointer-events:none; }
.tool-label > span { font-size:11px; line-height:1.15; white-space:nowrap; font-weight:550; }
.orbit-tool.selected { background:var(--blue-soft); color:var(--blue); }
.orbit-tool:focus-visible { background:var(--blue-soft-2); color:var(--blue); }
@media(hover:hover) { .orbit-tool:hover { background:var(--blue-soft); color:var(--blue); } }
.orbit-card { position:absolute; top:var(--anchor-y); left:calc(var(--anchor-x) - var(--card-width)); width:var(--card-width); height:var(--card-height); display:flex; flex-direction:column; border:1px solid var(--border); border-radius:var(--r-card); background:var(--bg); box-shadow:var(--shadow-2); pointer-events:auto; overflow:hidden; mask-image:radial-gradient(circle at top right,transparent var(--notch),black calc(var(--notch) + 1px)); }
.card-heading { min-height:var(--notch); flex-shrink:0; width:calc(100% - var(--notch)); min-width:0; padding:14px 0 10px 15px; display:flex; flex-direction:column; align-items:flex-start; gap:6px; }
.eyebrow { font-size:10px; color:var(--text-3); letter-spacing:.08em; }
h2 { margin:0; font-size:16px; line-height:1.4; font-weight:650; white-space:nowrap; }
.usage-link { display:flex; align-items:center; gap:2px; color:var(--blue); font-size:11px; white-space:nowrap; padding:3px 0; background:transparent; }
.card-close { color:var(--text-3); font-size:11px; background:transparent; padding:4px 0; }
.card-content { flex:1; min-height:0; padding:0 12px 12px; display:flex; flex-direction:column; overflow:hidden; }
.card-content :deep(.prompt-library),.card-content :deep(.transcript),.card-content :deep(.usage-details),.card-content :deep(.embedded .body),.floating-content { scrollbar-gutter:stable; padding-right:12px; overscroll-behavior:contain; }
.orbit-card.compact { height:auto; max-height:var(--card-height); }
.compact .card-content { flex:0 1 auto; max-height:calc(var(--card-height) - var(--notch)); }
.compact :deep(.usage-title) { display:none; }
.version-tabs { display:flex; flex-shrink:0; gap:2px; border-bottom:1px solid var(--border); margin-bottom:8px; }
.version-tabs button { flex:1; min-width:0; padding:9px 0; white-space:nowrap; color:var(--text-3); background:transparent; font-size:clamp(10px,2.7vw,12px); border-bottom:2px solid transparent; }
.version-tabs .selected { color:var(--blue); border-bottom-color:var(--blue); }
.version-content { flex:1; min-height:0; overflow:hidden; }
.floating-content { padding:20px 10px; text-align:center; color:var(--text-2); overflow:auto; }
.floating-content p { font-size:13px; line-height:1.7; }.floating-content h3 {font-size:15px}
.floating-action { background:var(--blue); color:white; padding:10px 18px; border-radius:var(--r-pill); font-size:13px; }
.orbit-reveal-enter-active .orbit-band,.orbit-reveal-leave-active .orbit-band { transition:transform 280ms cubic-bezier(.2,.8,.2,1),opacity 220ms ease; }
.orbit-reveal-enter-from .orbit-band,.orbit-reveal-leave-to .orbit-band { transform:scale(.84) rotate(-7deg); opacity:0; }
.card-reveal-enter-active,.card-reveal-leave-active,.orbit-reveal-leave-active .orbit-card { transition:transform 220ms cubic-bezier(.2,.8,.2,1),opacity 180ms ease; transform-origin:top right; }
.card-reveal-enter-from,.card-reveal-leave-to,.orbit-reveal-leave-to .orbit-card { transform:translate(0,-6px) scale(.985); opacity:0; }
.orbit-veil-enter-active,.orbit-veil-leave-active { transition:opacity 220ms ease; }
.orbit-veil-enter-from,.orbit-veil-leave-to { opacity:0; }
@media(max-width:320px) { .card-content {padding-inline:8px} .card-heading {padding-left:10px} h2 {font-size:14px} }
@media(max-width:280px) { h2 {font-size:12px} .card-heading .usage-link {display:none} }
@media(prefers-reduced-motion:reduce) {
  .orbit-reveal-enter-active .orbit-band,.orbit-reveal-leave-active .orbit-band,.card-reveal-enter-active,.card-reveal-leave-active,.orbit-reveal-leave-active .orbit-card,.orbit-veil-enter-active,.orbit-veil-leave-active,.orbit-tool { transition:none; }
  .orbit-reveal-enter-from .orbit-band,.orbit-reveal-leave-to .orbit-band,.card-reveal-enter-from,.card-reveal-leave-to,.orbit-reveal-leave-to .orbit-card { transform:none; }
}
</style>
