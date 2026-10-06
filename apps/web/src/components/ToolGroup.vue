<script setup lang="ts">
/**
 * 连续工具调用的分组容器。
 * 单个调用不套壳；两个以上折成一组，跑的时候自动展开、全部结束后自动收起，
 * 用户手动点过之后就听用户的。长任务几十次调用不会把时间线冲成卡片墙。
 */
import { computed, ref } from 'vue'
import type { ToolCard } from '@/stores/viewModel'
import { useConfigStore } from '@/stores/config'
import CoomiIcon from './CoomiIcon.vue'
import ToolCardItem from './ToolCardItem.vue'

const props = defineProps<{ cards: ToolCard[] }>()
const config = useConfigStore()

const manual = ref<boolean | null>(null)

const active = computed(() =>
  props.cards.some(c => c.status === 'running' || c.status === 'starting' || c.status === 'awaiting_approval'),
)
const open = computed(() => manual.value ?? active.value)
const finished = computed(() => props.cards.filter(c => c.status !== 'running' && c.status !== 'starting' && c.status !== 'awaiting_approval').length)
const failed = computed(() => props.cards.filter(c => c.status === 'error').length)
const elapsed = computed(() => props.cards.reduce((s, c) => s + (c.elapsed ?? 0), 0))

const summary = computed(() => {
  if (active.value) return `进行中 ${finished.value}/${props.cards.length}`
  if (failed.value) return `${failed.value} 个失败`
  return '全部完成'
})
const cls = computed(() => (active.value ? 'run' : failed.value ? 'err' : 'ok'))
const miniLabel = computed(() => {
  if (props.cards.length === 1) return `${props.cards[0].toolName}${active.value ? '…' : ''}`
  if (active.value) return `工具 × ${props.cards.length} · 进行中 ${finished.value}/${props.cards.length}`
  return `工具 × ${props.cards.length} · ${summary.value}`
})
</script>

<template>
  <!-- 单一根节点：从「单个调用」变成「分组」时根元素不变，
       只替换内部结构，避免整棵子树被销毁重建导致 .cascade 入场动画重播（表现为闪一下）。 -->
  <div class="tg" :class="cards.length === 1 ? 'tg-single' : ['group', cls]">
    <!-- 极简模式：所有调用合一枚小方框，点开才看详情。 -->
    <template v-if="config.minimalUi">
      <button class="mini-tool" :class="cls" @click="manual = !open">
        <span class="mini-ic" :class="cls"><CoomiIcon name="wrench" :size="13" /></span>
        <span class="mini-txt">{{ miniLabel }}</span>
        <span v-if="active" class="mini-live" aria-label="运行中" />
        <span v-else-if="failed" class="mini-err">{{ failed }} 失败</span>
        <CoomiIcon name="chevronRight" :size="12" class="gchev" :class="{ open }" />
      </button>
      <div v-if="open" class="mini-list">
        <ToolCardItem v-for="c in cards" :key="c.callId" :card="c" />
      </div>
    </template>

    <template v-else-if="cards.length === 1">
      <ToolCardItem :card="cards[0]" />
    </template>

    <template v-else>
      <button class="ghead" @click="manual = !open">
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
    </template>
  </div>
</template>

<style scoped>
.group {
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); overflow: hidden;
}
.group.run { border-color: var(--blue-border); }
.group.err { border-color: var(--danger-border); }

.ghead {
  display: flex; align-items: center; gap: 9px;
  width: 100%; min-height: 44px; padding: 7px 11px;
  border: 0; background: none; text-align: left;
}
.ghead:active { background: var(--fill-press); }

.gicon {
  display: grid; place-items: center; flex-shrink: 0;
  width: 27px; height: 27px; border-radius: 8px;
  background: var(--bg); color: var(--text-2);
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

.peek { display: flex; align-items: center; gap: 5px; padding: 0 11px 10px; }
.pchip {
  padding: 2px 8px; border-radius: var(--r-pill);
  background: var(--bg); border: 1px solid var(--border);
  font-family: var(--font-mono); font-size: 10.8px; color: var(--text-2);
}
.pmore { font-size: 11px; color: var(--text-3); }

.glist { display: flex; flex-direction: column; gap: 7px; padding: 0 7px 8px; }

/* ── 极简界面模式：工具调用折叠成一小块方框 ── */
.mini-tool {
  display: flex; align-items: center; gap: 7px;
  width: 100%; min-height: 34px; padding: 5px 10px;
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--fill); text-align: left;
}
.mini-tool.run { border-color: var(--blue-border); background: var(--blue-soft); }
.mini-tool.err { border-color: var(--danger-border); background: var(--danger-soft); }
.mini-ic {
  display: grid; place-items: center; flex-shrink: 0;
  width: 20px; height: 20px; border-radius: 6px;
  background: var(--bg); color: var(--text-2); font-size: 12px;
}
.mini-ic.run { color: var(--blue); }
.mini-ic.err { color: var(--danger); }
.mini-txt {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: var(--text-2);
}
.mini-live {
  flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%;
  background: var(--blue); animation: coomi-blink 1.1s ease-in-out infinite;
}
.mini-err { flex-shrink: 0; font-size: 10.5px; font-weight: 650; color: var(--danger); }
.mini-list { margin-top: 6px; display: flex; flex-direction: column; }
</style>

