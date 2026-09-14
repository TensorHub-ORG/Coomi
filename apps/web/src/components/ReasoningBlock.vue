<script setup lang="ts">
/**
 * 思考过程。
 * 正在想的时候只占一行：sparkle + 最后一句 + 渐变流光，像跑马灯一样滚过去；
 * 停下来之后折成「思考过程 · N 字」，点开才铺全文。
 * 活跃态由会话 store 的流事件生命周期维护，结束后不再靠定时器猜测。
 */
import { computed } from 'vue'
import type { ReasoningBlock } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ block: ReasoningBlock }>()

const live = computed(() => props.block.streaming === true)
function toggle() { props.block.expanded = !props.block.expanded }
function collapse() { props.block.expanded = false }

const chars = computed(() => props.block.content.replace(/\s+/g, '').length)
const tick = computed(() => {
  const lines = props.block.content.split('\n').map(s => s.trim()).filter(Boolean)
  const t = lines[lines.length - 1] ?? ''
  return t.length > 46 ? '…' + t.slice(-46) : t
})
</script>

<template>
  <div class="reasoning fade-in">
    <button type="button" class="toggle" :aria-expanded="block.expanded" @click.stop="toggle">
      <CoomiIcon name="sparkle" :size="14" class="spark" :class="{ live }" />
      <span v-if="live" class="ticker shimmer-text">{{ tick || '正在思考…' }}</span>
      <template v-else>
        <span class="label">思考过程</span>
        <span class="count">{{ chars }} 字</span>
      </template>
      <CoomiIcon name="chevronRight" :size="13" class="chev" :class="{ open: block.expanded }" />
    </button>
    <!-- 批次五 #28：展开态双击内容区即可收起 -->
    <div v-if="block.expanded" class="body" @dblclick="collapse">{{ block.content }}</div>
  </div>
</template>

<style scoped>
.reasoning { padding: 0; }
.toggle {
  display: flex; align-items: center; gap: 7px;
  width: 100%; min-height: 32px; padding: 4px 2px;
  border: 0; background: none; text-align: left;
  font-size: 13px; color: var(--text-3);
  touch-action: manipulation; cursor: pointer;
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
