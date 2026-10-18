<script setup lang="ts">
import { computed } from 'vue'
import { contextSegments, nonnegative } from '@/utils/contextUsage'
const props = defineProps<{ used: number; window: number; categories?: Partial<Record<string, number>> }>()
const segments = computed(() => {
  let offset = 0
  return contextSegments(props.used, props.window, props.categories).map(segment => {
    const start = offset; offset += segment.ratio * 100
    return { ...segment, start, length: segment.ratio * 100 }
  })
})
const percent = computed(() => nonnegative(props.window) > 0 ? Math.round(Math.min(1, nonnegative(props.used) / props.window) * 100) : null)
</script>
<template>
  <span class="context-ring" role="img" :aria-label="percent === null ? '上下文窗口未知' : `上下文使用 ${percent}%，分类为估算`">
    <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16" class="track" />
      <circle v-for="segment in segments" :key="segment.key" cx="20" cy="20" r="16" pathLength="100"
        fill="none" :stroke="segment.color" :stroke-dasharray="`${segment.length} ${100 - segment.length}`" :stroke-dashoffset="-segment.start" />
    </svg><small>{{ percent === null ? '—' : percent + '%' }}</small>
  </span>
</template>
<style scoped>
.context-ring { position:relative; display:inline-grid; width:40px; height:40px; place-items:center; flex-shrink:0; }
svg { width:100%; height:100%; transform:rotate(-90deg); }
circle { stroke-width:3; }
.track { fill:none; stroke:var(--fill-strong); }
small { position:absolute; font:9px var(--font-mono); color:var(--text-2); }
</style>
