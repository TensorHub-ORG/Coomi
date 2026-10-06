<script setup lang="ts">
/**
 * 计划进度条：把原来的「循环模式」改名为「计划进度」，可点击展开查看步骤明细。
 * loop 数据来自引擎 loop_progress / loop_step_start 事件。
 */
import { computed, ref } from 'vue'
import type { LoopProgress } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ loop: LoopProgress }>()
const expanded = ref(false)
const pct = computed(() => (props.loop.totalSteps > 0 ? Math.round((props.loop.currentStep / props.loop.totalSteps) * 100) : 0))
const steps = computed(() => {
  if (!props.loop.currentDescription) return []
  return [{ label: props.loop.currentDescription, state: 'doing' as const }]
})
</script>

<template>
  <div v-if="loop.active" class="loop fade-in" :class="{ open: expanded }">
    <button class="head" type="button" @click="expanded = !expanded">
      <CoomiIcon name="subtask" :size="14" class="ic" />
      <span class="tag">计划进度</span>
      <span class="txt">{{ loop.currentDescription || loop.status || '执行中' }}</span>
      <span class="count">{{ loop.currentStep }}/{{ loop.totalSteps }}</span>
      <CoomiIcon :name="expanded ? 'chevronUp' : 'chevronDown'" :size="13" class="caret" />
    </button>
    <div class="track"><div class="fill" :style="{ width: pct + '%' }" /></div>
    <Transition name="fold">
      <div v-if="expanded" class="detail">
        <div v-for="(s, i) in steps" :key="i" class="step">
          <span class="dot" :class="s.state" />
          <span class="label">{{ s.label }}</span>
          <em v-if="s.state === 'doing'" class="badge">进行中</em>
        </div>
        <p v-if="!steps.length" class="empty">暂无步骤明细</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.loop {
  margin: 2px 12px 4px; padding: 9px 12px 10px;
  border-radius: var(--r-md); background: var(--blue-soft);
}
.head { display: flex; align-items: center; gap: 7px; width: 100%; border: 0; background: none; text-align: left; color: inherit; }
.ic { color: var(--blue); flex-shrink: 0; }
.tag { flex-shrink: 0; font-size: 11.5px; font-weight: 700; color: var(--blue); }
.txt {
  flex: 1; min-width: 0; font-size: 12.5px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.count { flex-shrink: 0; font-size: 11.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.caret { flex-shrink: 0; color: var(--text-3); }
.track { height: 4px; border-radius: 2px; background: var(--bg); overflow: hidden; margin-top: 8px; }
.fill { height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--blue), #5b87dc); transition: width .35s ease; }
.detail { margin-top: 9px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--blue) 22%, transparent); display: flex; flex-direction: column; gap: 6px; }
.step { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text-2); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex-shrink: 0; }
.dot.doing { background: var(--blue); animation: pulse 1.1s ease-in-out infinite; }
.label { flex: 1; min-width: 0; }
.badge { font-style: normal; font-size: 10.5px; padding: 2px 7px; border-radius: var(--r-pill); background: var(--blue); color: #fff; }
.empty { font-size: 12px; color: var(--text-3); }
@keyframes pulse { 50% { opacity: .35; } }
.fold-enter-active, .fold-leave-active { transition: opacity .18s ease, transform .18s ease; }
.fold-enter-from, .fold-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
