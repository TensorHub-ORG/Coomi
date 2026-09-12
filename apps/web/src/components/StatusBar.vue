<script setup lang="ts">
/**
 * 状态条：只在有话可说的时候出现（忙 / 有用量 / 正在重连）。
 * 停止按钮归输入区的圆形按钮管，这里不重复放一个。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useConnectionStore } from '@/stores/connection'
import CoomiIcon from './CoomiIcon.vue'

const session = useSessionStore()
const connection = useConnectionStore()

const THINKING_LABELS = [
  'Coomi 正在海底捞针',
  'Coomi 数羊把自己数晕了',
  'Coomi 正在热身',
  'Coomi 被咖啡烫到了',
  'Coomi 正在猛猛翻字典',
  'Coomi 正在吵架',
  'Coomi 正在悄悄摸鱼',
  'Coomi 在假装思考中',
  'Coomi 正在翻记忆库',
  'Coomi 尝试计算宇宙终极答案中',
  'Coomi 在捣鼓中',
  'Coomi 在乖乖干活',
  'Coomi 想睡觉',
  'Coomi 眼巴巴等着你夸',
  'Coomi 正在编纂借口',
  'Coomi 的神经网络冒烟了',
  'Coomi 偷瞄了一眼隔壁的答案',
  'Coomi 盘腿打坐中',
  'Coomi 打了个盹，然后被自己吓醒了',
  'Coomi 正在认真比对数据',
  'Coomi 被自己的逻辑绕晕了',
  'Coomi 偷偷打了个哈欠',
  'Coomi 发现线索断了',
  'Coomi 在重组答案中',
  'Coomi 忘记刚才算到哪了',
  'Coomi 正在跟顽固问题激斗',
  'Coomi 觉得自己可能错了，重查中',
  'Coomi 感觉有人在催，手忙脚乱了一下',
  'Coomi 在后台翻箱倒柜',
  'Coomi 正在恢复答案中',
  'Coomi 想偷懒',
  'Coomi 搜索时迷路了',
  'Coomi 正在编一段漂亮的解释',
  'Coomi 怀疑出问题了，正在自检',
  'Coomi 把所有可能都列了一遍，挨个排除',
  'Coomi 准备重头再来',
] as const

const thinkingLabel = ref('')
let thinkingTimer: ReturnType<typeof setInterval> | null = null

function rotateThinkingLabel() {
  let next = thinkingLabel.value
  while (next === thinkingLabel.value) {
    next = THINKING_LABELS[Math.floor(Math.random() * THINKING_LABELS.length)]
  }
  thinkingLabel.value = next
}

function stopThinkingRotation() {
  if (thinkingTimer) clearInterval(thinkingTimer)
  thinkingTimer = null
}

watch(() => session.runState, state => {
  stopThinkingRotation()
  if (state !== 'thinking') return
  rotateThinkingLabel()
  thinkingTimer = setInterval(rotateThinkingLabel, 3500)
}, { immediate: true })

onBeforeUnmount(stopThinkingRotation)

const runLabel = computed(() => {
  switch (session.runState) {
    case 'syncing': return '同步中'
    case 'thinking': return thinkingLabel.value
    case 'executing': return '执行中'
    case 'awaiting_approval': return '等你授权'
    case 'awaiting_question': return '等你回答'
    default: return ''
  }
})

</script>

<template>
  <div v-if="session.isBusy || connection.retryMessage" class="sbar">
    <div v-if="connection.retryMessage" class="retry">
      <CoomiIcon name="alert" :size="14" />
      <span>{{ connection.retryMessage }}</span>
    </div>
    <div class="row">
      <span v-if="session.isBusy" class="dots"><i /><i /><i /></span>
      <span
        v-if="runLabel"
        class="run"
        :class="{ 'thinking-shimmer': session.runState === 'thinking' }"
      >{{ runLabel }}</span>
      <span class="gap" />
    </div>
  </div>
</template>

<style scoped>
.sbar {
  padding: 4px 18px 5px;
  background: var(--bg);
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}
.retry {
  display: flex; align-items: center; gap: 6px; margin-bottom: 3px;
  font-size: 12px; color: var(--orange);
}
.row { display: flex; align-items: center; gap: 8px; min-height: 18px; }
.gap { flex: 1; }
.run { min-width: 0; overflow: hidden; color: var(--text-2); font-size: 12.5px; text-overflow: ellipsis; white-space: nowrap; }
.run.thinking-shimmer {
  color: var(--blue);
  background-image: linear-gradient(90deg, var(--blue) 20%, var(--blue-press) 48%, var(--blue) 76%);
  background-image: linear-gradient(
    90deg,
    var(--blue) 20%,
    color-mix(in srgb, var(--blue), white 55%) 48%,
    var(--blue) 76%
  );
  background-position: 0 0;
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: coomi-shimmer 1.6s linear infinite;
}
.dots { display: inline-flex; align-items: center; gap: 3px; }
.dots i {
  width: 5px; height: 5px; border-radius: 50%; background: var(--blue);
  animation: bounce 1.2s ease-in-out infinite;
}
.dots i:nth-child(2) { animation-delay: .15s; }
.dots i:nth-child(3) { animation-delay: .3s; }
@keyframes bounce {
  0%, 60%, 100% { opacity: .25; transform: none; }
  30% { opacity: 1; transform: translateY(-3px); }
}
@media (prefers-reduced-motion: reduce) {
  .run.thinking-shimmer {
    background: none;
    -webkit-text-fill-color: var(--blue);
    animation: none;
  }
}
</style>
