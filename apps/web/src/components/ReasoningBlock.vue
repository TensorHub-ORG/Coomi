<script setup lang="ts">
/**
 * 思考过程。
 * 正在想的时候只占一行：sparkle + 最后一句 + 渐变流光，像跑马灯一样滚过去；
 * 停下来之后折成「思考过程 · N 字」，点开才铺全文。
 * 没有 streaming 标记可用，所以用「最近 900ms 内还在长」判定活跃。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ReasoningBlock } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ block: ReasoningBlock }>()

const open = ref(false)
const live = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

watch(() => props.block.content, () => {
  live.value = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { live.value = false }, 900)
})
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

const chars = computed(() => props.block.content.replace(/\s+/g, '').length)
const tick = computed(() => {
  const lines = props.block.content.split('\n').map(s => s.trim()).filter(Boolean)
  const t = lines[lines.length - 1] ?? ''
  return t.length > 46 ? '…' + t.slice(-46) : t
})
</script>

<template>
  <div class="reasoning fade-in">
    <button class="toggle" @click="open = !open">
      <CoomiIcon name="sparkle" :size="14" class="spark" :class="{ live }" />
      <span v-if="live" class="ticker shimmer-text">{{ tick || '正在思考…' }}</span>
      <template v-else>
        <span class="label">思考过程</span>
        <span class="count">{{ chars }} 字</span>
      </template>
      <CoomiIcon name="chevronRight" :size="13" class="chev" :class="{ open }" />
    </button>
    <div v-if="open" class="body">{{ block.content }}</div>
  </div>
</template>

<style scoped>
.reasoning { padding: 0; }
.toggle {
  display: flex; align-items: center; gap: 7px;
  width: 100%; min-height: 32px; padding: 4px 2px;
  border: 0; background: none; text-align: left;
  font-size: 13px; color: var(--text-3);
}
.spark { flex-shrink: 0; color: var(--text-3); }
.spark.live { color: var(--blue); animation: coomi-blink 1.4s ease-in-out infinite; }
.ticker {
  flex: 1; min-width: 0; font-size: 12.8px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.label { font-weight: 600; }
.count { flex: 1; font-size: 11.5px; color: var(--text-3); }
.chev { flex-shrink: 0; transition: transform .18s; }
.chev.open { transform: rotate(90deg); }
.body {
  margin: 4px 0 0 6px; padding: 9px 13px;
  border-left: 2px solid var(--blue-border);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
  background: var(--fill);
  font-size: 13px; line-height: 1.7; color: var(--text-2);
  white-space: pre-wrap; word-break: break-word;
}
</style>
