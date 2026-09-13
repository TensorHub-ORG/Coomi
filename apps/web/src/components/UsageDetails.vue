<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session'
defineProps<{ runtimeInfo: unknown; envBadgeClass: string; envBadgeLabel: string; envDetail: string }>()
defineEmits<{ path: [] }>()
const session = useSessionStore()
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

</script>
<template><div class="usage-details">
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
        <button class="path-btn" @click="$emit('path')">{{ session.cwd || '点击选择' }}</button>
      </div>
      <div v-if="runtimeInfo" class="usage-env">
        <span>运行环境</span>
        <span class="env-row">
          <em class="env-badge" :class="envBadgeClass">{{ envBadgeLabel }}</em>
          <small v-if="envDetail" class="env-detail">{{ envDetail }}</small>
        </span>
      </div>
</div></template>
<style scoped>
.usage-details { min-height:0; overflow:auto; }
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
.usage-env .env-row {
  display: flex; flex-direction: row; align-items: center; gap: 6px;
  flex: 1; min-width: 0; overflow: hidden; justify-content: flex-end;
}
.usage-env .env-detail { flex: 1; min-width: 0; }
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
</style>
