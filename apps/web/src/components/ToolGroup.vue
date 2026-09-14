<script lang="ts">
import { reactive } from 'vue'

/**
 * 组的手动开合状态存放处（模块级，跨组件实例共享）。
 * 以组 key（首个工具 callId）为键 —— 不能放 <script setup> 的本地变量
 * （每个实例各一份）：虚拟列表回收重建组件后状态仍在，
 * 「用户手动点过之后就听用户的」这条约定才能真正跨回收生效。
 *
 * 必须是 reactive Map：普通 Map 不是响应式数据源，computed 不追踪它的
 * 变化，点击后状态写了、界面永远不更新——这正是「工具调用点不开」的根因。
 */
const groupManual = reactive(new Map<string, boolean>())
</script>

<script setup lang="ts">
/**
 * 连续工具调用的分组容器。
 * 单个调用不套壳；两个以上折成一组，跑的时候自动展开、全部结束后自动收起，
 * 用户手动点过之后就听用户的。长任务几十次调用不会把时间线冲成卡片墙。
 */
import { computed } from 'vue'
import type { ToolCard } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'
import ToolCardItem from './ToolCardItem.vue'

const props = defineProps<{ cards: ToolCard[] }>()

const groupKey = computed(() => `g:${props.cards[0]?.callId ?? ''}`)

const active = computed(() =>
  props.cards.some(c => c.status === 'running' || c.status === 'starting' || c.status === 'awaiting_approval'),
)
const open = computed(() => groupManual.get(groupKey.value) ?? active.value)
function toggleGroup() { groupManual.set(groupKey.value, !open.value) }
const finished = computed(() => props.cards.filter(c => c.status !== 'running' && c.status !== 'starting' && c.status !== 'awaiting_approval').length)
const failed = computed(() => props.cards.filter(c => c.status === 'error').length)
const elapsed = computed(() => props.cards.reduce((s, c) => s + (c.elapsed ?? 0), 0))

const summary = computed(() => {
  if (active.value) return `进行中 ${finished.value}/${props.cards.length}`
  if (failed.value) return `${failed.value} 个失败`
  return '全部完成'
})
const cls = computed(() => (active.value ? 'run' : failed.value ? 'err' : 'ok'))
</script>

<template>
  <ToolCardItem v-if="cards.length === 1" :card="cards[0]" class="cascade" />

  <div v-else class="group cascade" :class="cls">
    <button class="ghead" @click="toggleGroup">
      <span class="gicon" :class="cls"><CoomiIcon name="wrench" :size="16" /></span>
      <span class="gtitle">工具调用 · {{ cards.length }}</span>
      <span class="gsum" :class="cls">{{ summary }}</span>
      <span v-if="!active && elapsed > 0" class="gms">{{ elapsed.toFixed(1) }}s</span>
      <CoomiIcon name="chevronRight" :size="14" class="gchev" :class="{ open }" />
    </button>

    <div v-if="!open" class="peek">
      <code v-for="c in cards.slice(0, 3)" :key="c.callId" class="pchip">{{ c.toolName }}</code>
      <span v-if="cards.length > 3" class="pmore">+{{ cards.length - 3 }}</span>
    </div>

    <div v-else class="glist">
      <ToolCardItem v-for="c in cards" :key="c.callId" :card="c" />
    </div>
  </div>
</template>

<style scoped>
.group {
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden;
}
.group.run { border-color: var(--blue-border); }
.group.err { border-color: var(--danger-border); }

.ghead {
  display: flex; align-items: center; gap: 9px;
  width: 100%; min-height: 46px; padding: 8px 12px;
  border: 0; background: none; text-align: left;
}
.ghead:active { background: var(--fill); }

.gicon {
  display: grid; place-items: center; flex-shrink: 0;
  width: 29px; height: 29px; border-radius: 9px;
  background: var(--fill); color: var(--text-2);
}
.gicon.run { color: var(--blue); }
.gicon.err { color: var(--danger); }
.gicon.ok { color: var(--ok); }

.gtitle { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 600; color: var(--text); }
.gsum { flex-shrink: 0; font-size: 11.5px; font-weight: 600; color: var(--text-3); }
.gsum.run { color: var(--blue); }
.gsum.err { color: var(--danger); }
.gsum.ok { color: var(--ok); }
.gms { flex-shrink: 0; font-size: 11.5px; color: var(--text-3); }
.gchev { flex-shrink: 0; color: var(--text-3); transition: transform .18s; }
.gchev.open { transform: rotate(90deg); }

.peek { display: flex; align-items: center; gap: 5px; padding: 0 12px 10px; }
.pchip {
  padding: 2px 9px; border-radius: var(--r-pill);
  background: var(--fill); border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  font-family: var(--font-mono); font-size: 10.8px; color: var(--text-2);
}
.pmore { font-size: 11px; color: var(--text-3); }

.glist { display: flex; flex-direction: column; gap: 7px; padding: 0 7px 8px; }
</style>

