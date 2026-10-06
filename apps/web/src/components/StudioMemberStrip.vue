<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useStudioStore } from '@/stores/studio'
import type { MemberStatus } from '@/stores/studio'

const emit = defineEmits<{ mention: [id: string] }>()
const studio = useStudioStore()
const statusLabel: Record<MemberStatus, string> = { idle:'待机', thinking:'思考中', executing:'工作中', waiting:'等待', done:'完成', failed:'失败' }
const statusClass: Record<MemberStatus, string> = { idle:'', thinking:'thinking', executing:'executing', waiting:'waiting', done:'done', failed:'failed' }
const timer = ref<ReturnType<typeof setTimeout> | null>(null)
function start(id: string) { stop(); timer.value=setTimeout(()=>emit('mention',id),520) }
function stop() { if(timer.value){clearTimeout(timer.value);timer.value=null} }
onBeforeUnmount(stop)
</script>
<template>
  <div class="strip"><div class="list">
    <button v-for="m in studio.members" :key="m.id" class="item" :class="{ active:m.status==='thinking'||m.status==='executing' }" @pointerdown="start(m.id)" @pointerup="stop" @pointercancel="stop" @pointerleave="stop" @contextmenu.prevent="emit('mention',m.id)">
      <span class="avatar">{{ m.name?.[0] || 'AI' }}</span><span class="dot" :class="statusClass[m.status]" /><span class="info"><span class="name">{{ m.name }}</span><span class="status">{{ statusLabel[m.status] }}</span></span><span v-if="m.id===studio.currentStudio?.hostId" class="host-badge">主持</span>
    </button>
  </div></div>
</template>
<style scoped>
.strip{flex-shrink:0;padding:9px 13px;border-bottom:1px solid var(--border);background:var(--bg)}.list{display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch}.item{display:flex;align-items:center;gap:6px;min-height:48px;padding:5px 10px 5px 6px;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev);color:var(--text);white-space:nowrap;text-align:left;-webkit-touch-callout:none}.item:active{background:var(--fill-press);transform:scale(.98)}.item.active{border-color:var(--blue-border);background:var(--blue-soft)}.avatar{display:grid;place-items:center;width:29px;height:29px;border-radius:10px;background:var(--blue-soft-2);color:var(--blue);font-size:11px;font-weight:700}.dot{width:7px;height:7px;border-radius:50%;background:var(--text-3)}.dot.thinking{background:var(--blue);animation:pulse 1.2s ease-in-out infinite}.dot.executing{background:var(--orange);animation:pulse .8s ease-in-out infinite}.dot.waiting{background:var(--text-2)}.dot.done{background:var(--ok)}.dot.failed{background:var(--danger)}.info{display:flex;flex-direction:column;line-height:1.2}.name{font-size:11px;font-weight:650;color:var(--text)}.status{font-size:9px;color:var(--text-3)}.host-badge{font-size:9px;padding:2px 5px;border-radius:var(--r-pill);background:var(--blue-soft);color:var(--blue);font-weight:650}@keyframes pulse{50%{opacity:.35}}
</style>
