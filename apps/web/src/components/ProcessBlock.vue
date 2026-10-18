<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TimelineBlockItem } from '@/utils/chatTimeline'
import TimelineEntry from './TimelineEntry.vue'
import CoomiIcon from './CoomiIcon.vue'
const props = defineProps<{ block: Extract<TimelineBlockItem, { t: 'process' }> }>()
const choice = ref<boolean | null>(null)
const open = computed(() => choice.value ?? props.block.running)
watch(() => props.block.running, running => { if (!running) choice.value = null })
const count = computed(() => props.block.blocks.reduce((n, b) => n + (b.t === 'tools' ? b.cards.length : 1), 0))
</script>
<template>
  <section class="process-block">
    <button class="process-toggle" :aria-expanded="open" @click="choice = !open">
      <CoomiIcon name="chevronRight" :size="14" :class="{ open }" />
      <span>{{ block.running ? '执行过程' : '查看执行过程' }}</span><small>{{ count }} 项</small>
    </button>
    <div v-if="open" class="process-content"><TimelineEntry v-for="entry in block.blocks" :key="entry.key" :block="entry" /></div>
  </section>
</template>
<style scoped>
.process-block { min-width:0; width:100%; border:1px solid var(--border); border-radius:var(--r-md); background:var(--bg); overflow:hidden; }
.process-toggle { display:flex; align-items:center; gap:7px; width:100%; padding:10px; background:var(--fill); color:var(--text-2); text-align:left; font-size:12px; }
.process-toggle small { margin-left:auto; color:var(--text-3); }
.process-toggle .open { transform:rotate(90deg); }
.process-content { display:flex; flex-direction:column; gap:10px; padding:10px; min-width:0; }
</style>
