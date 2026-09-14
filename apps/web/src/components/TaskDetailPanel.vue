<script setup lang="ts">
import type { TaskDetail, TaskInfo } from '@/stores/sessions'
import CoomiIcon from './CoomiIcon.vue'

defineProps<{
  detail: TaskDetail
  statusLabels: Record<TaskInfo['status'], string>
}>()
const emit = defineEmits<{
  close: []
  action: [task: TaskInfo, action: 'retry']
  priority: [task: TaskInfo, priority: TaskInfo['priority']]
  open: [task: TaskInfo]
}>()
</script>

<template>
  <section class="task-detail">
    <div class="detail-head">
      <div>
        <p class="detail-eyebrow">任务详情</p>
        <strong>{{ detail.task.session_title || detail.task.kind }}</strong>
      </div>
      <button class="control" aria-label="关闭详情" title="关闭详情" @click="emit('close')"><CoomiIcon name="close" :size="17" /></button>
    </div>
    <div class="detail-grid">
      <label>优先级
        <select :value="detail.task.priority" @change="emit('priority', detail.task, ($event.target as HTMLSelectElement).value as TaskInfo['priority'])">
          <option value="high">高</option><option value="normal">普通</option><option value="low">低</option>
        </select>
      </label>
      <span>状态<strong>{{ statusLabels[detail.task.status] }}</strong></span>
      <span>模型<strong>{{ detail.task.model || '未记录' }}</strong></span>
      <span>重试<strong>{{ detail.task.retries ?? 0 }}</strong></span>
    </div>
    <p v-if="detail.task.error" class="error">{{ detail.task.error }}</p>
    <p class="detail-label">资源</p>
    <ul class="resource-list">
      <li v-for="resource in detail.task.resources" :key="resource.key.kind + resource.key.identity">
        <code>{{ resource.key.kind }} · {{ resource.access }}</code><span>{{ resource.key.identity }}</span>
      </li>
    </ul>
    <p class="detail-label">事件日志</p>
    <ol class="event-list">
      <li v-for="event in detail.events.slice().reverse()" :key="event.at_ms + event.event">
        <time>{{ new Date(event.at_ms).toLocaleTimeString() }}</time><strong>{{ statusLabels[event.status] }}</strong><span>{{ event.summary }}</span>
      </li>
    </ol>
    <div class="detail-actions">
      <button v-if="['failed', 'cancelled', 'interrupted', 'conflict', 'completed'].includes(detail.task.status)" @click="emit('action', detail.task, 'retry')"><CoomiIcon name="refresh" :size="16" />重试</button>
      <button @click="emit('open', detail.task)"><CoomiIcon name="chat" :size="16" />打开会话</button>
    </div>
  </section>
</template>

<style scoped>
.task-detail {
  padding: 14px 14px 16px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--blue-soft) 36%, var(--bg));
  animation: task-detail-open .2s cubic-bezier(.2,.8,.2,1) both;
}
@keyframes task-detail-open { from { opacity:0; transform:translateY(-5px) } }
.detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.detail-eyebrow { margin: 0 0 4px; color: var(--text-3); font-size: 11px; }
.detail-head strong { font-size: 15px; }
.control { display: grid; place-items: center; flex: 0 0 36px; width: 36px; height: 36px; border-radius: 50%; color: var(--text-2); }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; margin-top: 16px; }
.detail-grid > span, .detail-grid label { display: flex; min-width: 0; flex-direction: column; gap: 4px; color: var(--text-3); font-size: 11px; }
.detail-grid strong, .detail-grid select { overflow: hidden; min-height: 30px; color: var(--text); font-size: 13px; text-overflow: ellipsis; }
.detail-grid select { border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
.detail-label { margin: 16px 0 7px; color: var(--text-3); font-size: 11px; font-weight: 650; }
.resource-list, .event-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.resource-list li { display: grid; gap: 3px; min-width: 0; }
.resource-list code { color: var(--blue); font-size: 11px; }
.resource-list span { overflow-wrap: anywhere; color: var(--text-2); font-size: 12px; }
.event-list li { display: grid; grid-template-columns: 76px 74px minmax(0, 1fr); gap: 6px; color: var(--text-2); font-size: 11px; }
.event-list time { color: var(--text-3); }
.event-list span { overflow-wrap: anywhere; }
.error { margin-top: 12px; color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }
.detail-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.detail-actions button { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 6px; background: var(--fill); color: var(--text-2); font-size: 12px; }
@media(prefers-reduced-motion:reduce) { .task-detail { animation:none; } }
</style>
