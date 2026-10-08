<script setup lang="ts">
/**
 * 新会话空态：只保留品牌标记与格言。模式选择和快捷能力在 Composer 中，
 * 避免首屏堆满快捷问题；品牌动效在会话开始后由 ChatView 接管。
 *
 * 动效交给 GSAP：一次编排（标记落位 → 格言 → 副文案），再挂一个很轻的呼吸循环。
 * 比两段独立的 CSS keyframes 更容易对齐节奏，也方便在 reduced-motion 下整体关掉。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useConnectionStore } from '@/stores/connection'
import { useSessionStore } from '@/stores/session'
import { QUICK_COMMAND_CHANGED_EVENT, loadQuickCommandConfig, type QuickCommand } from '@/utils/quickCommands'
import { gsap, prefersReducedMotion, useGsapScope } from '@/composables/useGsap'
import CoomiIcon from './CoomiIcon.vue'
import CoomiMark from './CoomiMark.vue'

const config = useConfigStore()
const session = useSessionStore()
const connection = useConnectionStore()
const suggestions = ref<QuickCommand[]>([])
const suggestionsExpanded = ref(false)
let reveal: gsap.core.Tween | null = null
function animateSuggestions(element: Element, done: () => void, opening: boolean) {
  reveal?.kill()
  const panel = element as HTMLElement
  // Animate the small panel's layout height so the centered brand above it
  // moves continuously with the list, including interrupted toggle gestures.
  panel.inert = !opening
  if (prefersReducedMotion()) {
    panel.style.height = opening ? 'auto' : '0px'
    panel.style.opacity = opening ? '1' : '0'
    done()
    return
  }
  reveal = gsap.to(panel, {
    height: opening ? panel.scrollHeight : 0,
    opacity: opening ? 1 : 0,
    duration: opening ? .42 : .32,
    ease: 'power2.inOut',
    onComplete: () => {
      if (opening) panel.style.height = 'auto'
      reveal = null
      done()
    },
  })
}
function beforeSuggestionsEnter(element: Element) {
  const panel = element as HTMLElement
  if (!panel.style.height) {
    panel.style.height = '0px'
    panel.style.opacity = '0'
  }
}
onBeforeUnmount(() => reveal?.kill())
function refreshSuggestions() {
  const value = loadQuickCommandConfig()
  suggestions.value = (value.sets.find(set => set.id === value.activeSetId) ?? value.sets[0]).commands
}
function runSuggestion(command: QuickCommand) {
  if (command.guide) session.sendGuide(command.guide)
  else session.sendMessage(command.content)
}
onMounted(() => {
  refreshSuggestions()
  window.addEventListener(QUICK_COMMAND_CHANGED_EVENT, refreshSuggestions)
})
onBeforeUnmount(() => window.removeEventListener(QUICK_COMMAND_CHANGED_EVENT, refreshSuggestions))

const root = ref<HTMLElement | null>(null)
useGsapScope(root, (_context, element) => {
  gsap.timeline({ defaults: { ease: 'power2.out' } })
    .from(element.querySelector('.brand-aura'), { opacity: 0, scale: 0.86, duration: 0.55 })
    .from(element.querySelector('.motto'), { opacity: 0, y: 10, duration: 0.45 }, '-=0.2')
    .from(element.querySelector('.sub'), { opacity: 0, y: 8, duration: 0.4 }, '-=0.3')
    .from(element.querySelector('.demobar'), { opacity: 0, y: 8, duration: 0.35 }, '-=0.25')

  // 呼吸：只动 transform 与透明度，避免 box-shadow 每帧重绘（低端机上是明显的掉帧源）。
  gsap.to(element.querySelector('.brand-aura'), {
    y: -6,
    duration: 2.4,
    ease: 'sine.inOut',
    repeat: -1,
    yoyo: true,
  })
  gsap.to(element.querySelector('.logo'), {
    opacity: 0.88,
    duration: 2.4,
    ease: 'sine.inOut',
    repeat: -1,
    yoyo: true,
  })
})
</script>

<template>
  <div ref="root" class="empty">
    <div class="brand-aura"><CoomiMark :size="64" class="logo" /></div>
    <p class="motto" :class="{ 'motto-guofeng': config.mottoFont === 'guofeng' }">
      <span v-if="config.mottoFont === 'guofeng'" class="motto-art" role="img" aria-label="慎终如始，则无败事" />
      <template v-else>慎终如始，则无败事</template>
    </p>
    <p class="sub">准备好了，就告诉我想做什么</p>
    <button class="suggestions-toggle" :class="{ expanded: suggestionsExpanded }" type="button"
      :aria-label="suggestionsExpanded ? '收起快捷开始' : '展开快捷开始'"
      :aria-expanded="suggestionsExpanded" aria-controls="start-suggestions"
      @click="suggestionsExpanded = !suggestionsExpanded">
      <CoomiIcon name="chevronDown" :size="18" />
    </button>
    <Transition :css="false" @before-enter="beforeSuggestionsEnter"
      @enter="(el, done) => animateSuggestions(el, done, true)"
      @leave="(el, done) => animateSuggestions(el, done, false)"
      @enter-cancelled="() => reveal?.kill()" @leave-cancelled="() => reveal?.kill()">
    <div v-if="suggestionsExpanded" id="start-suggestions" class="suggestions-reveal">
    <div class="suggestions" aria-label="新会话快捷指令">
      <button v-for="command in suggestions" :key="command.id" class="suggestion" @click="runSuggestion(command)">
        <CoomiIcon :name="command.icon" :size="16" />
        <span>{{ command.name }}</span>
        <CoomiIcon name="chevronRight" :size="12" />
      </button>
    </div>
    </div>
    </Transition>
    <p v-if="connection.demo" class="demobar">
      <CoomiIcon name="alert" :size="14" />
      <span>演示模式：对话由脚本驱动，只用来预览界面，不会真的执行命令。</span>
    </p>
  </div>
</template>

<style scoped>
.empty { margin:auto 0; padding:34px 4px 18px; display:flex; flex-direction:column; align-items:center; text-align:center; }
.brand-aura { display:grid; place-items:center; padding:16px; border-radius:50%; will-change:transform; }
.logo { display:block; }
.motto { margin:12px 0 0; color:var(--text); font-family:var(--font-ui); font-size:17px; line-height:1.6; font-weight:750; letter-spacing:.04em; }
.motto-guofeng { line-height:0; }
.motto-art { display:block; width:min(236px, calc(100vw - 84px)); aspect-ratio:1722 / 210; background:var(--text); -webkit-mask:url('/brand/motto-calligraphy.png') center / contain no-repeat; mask:url('/brand/motto-calligraphy.png') center / contain no-repeat; }
.sub { margin-top:8px; color:var(--text-3); font-size:13px; }
.suggestions-toggle { display: grid; place-items: center; width: 44px; height: 36px; margin-top: 14px; padding: 0; border: 0; border-radius: 18px; background: transparent; color: var(--text-3); }
.suggestions-toggle:active, .suggestions-toggle:focus-visible { background: var(--fill); color: var(--blue); }
.suggestions-toggle :deep(svg) { transition: transform .2s; }
.suggestions-toggle.expanded :deep(svg) { transform: rotate(180deg); }
.suggestions-reveal { width: min(calc(100% - 32px), 280px); overflow: hidden; flex-shrink: 0; }
.suggestions { display: grid; gap: 6px; width: 100%; padding-top: 6px; }
.suggestion { display: flex; align-items: center; gap: 9px; min-height: 44px; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--fill); color: var(--text-2); text-align: left; font-size: 13px; }
.suggestion span { flex: 1; min-width: 0; }
.suggestion > :first-child { color: var(--blue); flex-shrink: 0; }
.suggestion:active { background: var(--blue-soft); color: var(--blue); }
.demobar { display:flex; align-items:flex-start; gap:7px; max-width:320px; margin-top:18px; padding:9px 12px; border-radius:var(--r-md); background:var(--orange-soft); color:var(--orange); font-size:12.5px; line-height:1.55; text-align:left; }
.demobar :deep(svg) { flex-shrink:0; margin-top:1px; }
@media (prefers-reduced-motion: reduce) { .suggestions-toggle :deep(svg) { transition: none; } }
</style>
