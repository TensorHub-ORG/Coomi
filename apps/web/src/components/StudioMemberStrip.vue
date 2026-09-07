<script setup lang="ts">
import { useStudioStore } from '@/stores/studio'
import type { MemberStatus } from '@/stores/studio'

const studio = useStudioStore()

const statusLabel: Record<MemberStatus, string> = {
  idle: '待机', thinking: '思考中', executing: '执行中', waiting: '等待', done: '完成', failed: '失败',
}

const statusClass: Record<MemberStatus, string> = {
  idle: '', thinking: 'thinking', executing: 'executing', waiting: 'waiting', done: 'done', failed: 'failed',
}
</script>

<template>
  <div class="strip">
    <div class="list">
      <div v-for="m in studio.members" :key="m.id" class="item" :class="{ active: m.status === 'thinking' || m.status === 'executing' }">
        <div class="dot" :class="statusClass[m.status]" />
        <div class="info">
          <span class="name">{{ m.name }}</span>
          <span class="status">{{ statusLabel[m.status] }}</span>
        </div>
        <span v-if="m.id === studio.currentStudio?.hostId" class="host-badge">主持</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.strip { flex-shrink: 0; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--bg); }
.list { display: flex; gap: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.item { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--r-pill); background: var(--bg-elev); white-space: nowrap; }
.item.active { border-color: var(--blue-border); background: var(--blue-soft); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
.dot:not(.idle) { box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 12%, transparent); }
.dot.thinking { background: var(--blue); animation: pulse 1.2s ease-in-out infinite; }
.dot.executing { background: var(--orange); animation: pulse 0.8s ease-in-out infinite; }
.dot.waiting { background: var(--text-2); }
.dot.done { background: var(--ok); }
.dot.failed { background: var(--danger); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.info { display: flex; flex-direction: column; line-height: 1.2; }
.name { font-size: 12px; font-weight: 600; color: var(--text); }
.status { font-size: 10px; color: var(--text-3); }
.host-badge { font-size: 10px; padding: 1px 6px; border-radius: var(--r-pill); background: var(--blue-soft); color: var(--blue); font-weight: 600; }
</style>
