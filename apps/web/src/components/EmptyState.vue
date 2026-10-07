<script setup lang="ts">
/**
 * 新会话空态：只保留品牌标记与格言。模式选择和快捷能力在 Composer 中，
 * 避免首屏堆满快捷问题；品牌动效在会话开始后由 ChatView 接管。
 *
 * 动效交给 GSAP：一次编排（标记落位 → 格言 → 副文案），再挂一个很轻的呼吸循环。
 * 比两段独立的 CSS keyframes 更容易对齐节奏，也方便在 reduced-motion 下整体关掉。
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useConnectionStore } from '@/stores/connection'
import { useSessionStore } from '@/stores/session'
import { QUICK_COMMAND_CHANGED_EVENT, loadQuickCommandConfig, type QuickCommand } from '@/utils/quickCommands'
import { gsap, useGsapScope } from '@/composables/useGsap'
import CoomiIcon from './CoomiIcon.vue'
import CoomiMark from './CoomiMark.vue'

const config = useConfigStore()
const session = useSessionStore()
const connection = useConnectionStore()
const suggestions = ref<QuickCommand[]>([])
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
const motto = computed(() => config.productionMode ? '慎终如始，则无败事' : '海内存知己，天涯若比邻')

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
    <p class="motto">{{ motto }}</p>
    <p class="sub">准备好了，就告诉我想做什么</p>
    <div class="suggestions" aria-label="新会话快捷指令">
      <button v-for="command in suggestions" :key="command.id" class="suggestion" @click="runSuggestion(command)">
        <CoomiIcon :name="command.icon" :size="16" />
        <span>{{ command.name }}</span>
        <CoomiIcon name="chevronRight" :size="12" />
      </button>
    </div>
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
.motto { margin:12px 0 0; color:var(--text); font-size:17px; line-height:1.6; font-weight:750; letter-spacing:.04em; }
.sub { margin-top:8px; color:var(--text-3); font-size:13px; }
.suggestions { display: grid; gap: 6px; width: min(100%, 340px); margin-top: 20px; }
.suggestion { display: flex; align-items: center; gap: 9px; min-height: 44px; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--fill); color: var(--text-2); text-align: left; font-size: 13px; }
.suggestion span { flex: 1; min-width: 0; }
.suggestion > :first-child { color: var(--blue); flex-shrink: 0; }
.suggestion:active { background: var(--blue-soft); color: var(--blue); }
.demobar { display:flex; align-items:flex-start; gap:7px; max-width:320px; margin-top:18px; padding:9px 12px; border-radius:var(--r-md); background:var(--orange-soft); color:var(--orange); font-size:12.5px; line-height:1.55; text-align:left; }
.demobar :deep(svg) { flex-shrink:0; margin-top:1px; }
</style>
