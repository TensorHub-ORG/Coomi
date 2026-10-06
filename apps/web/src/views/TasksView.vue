<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useSessionStore } from '@/stores/session'
import { useSessionsStore, type TaskDetail, type TaskInfo } from '@/stores/sessions'

const router = useRouter()
const session = useSessionStore()
const sessions = useSessionsStore()
const detail = ref<TaskDetail | null>(null)
let poll: ReturnType<typeof setInterval> | null = null

const active = computed(() => sessions.tasks.filter(task => task.running))
const recent = computed(() => sessions.tasks.filter(task => !task.running).slice(0, 20))

const statusLabels: Record<TaskInfo['status'], string> = {
  queued: '等待执行',
  waiting_lock: '等待资源',
  running: '执行中',
  pause_pending: '等待安全点暂停',
  paused: '已暂停',
  awaiting_approval: '等待授权',
  awaiting_input: '等待输入',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  conflict: '发生冲突',
}

const downloadLabels: Record<NonNullable<TaskInfo['download_status']>, string> = {
  downloading: '下载中',
  completed: '下载完成，等待使用',
  failed: '下载失败',
}

function openTask(task: TaskInfo) {
  session.openSession(task.session_id)
  router.push('/')
}

async function inspectTask(task: TaskInfo) {
  detail.value = await sessions.taskDetail(task.task_id)
}

async function act(task: TaskInfo, action: 'pause' | 'resume' | 'cancel' | 'retry') {
  await sessions.taskAction(task.task_id, action)
  detail.value = await sessions.taskDetail(task.task_id)
}

async function setPriority(task: TaskInfo, event: Event) {
  const priority = (event.target as HTMLSelectElement).value as TaskInfo['priority']
  await sessions.taskAction(task.task_id, 'priority', priority)
}

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - startedAt))
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  return `${Math.floor(seconds / 3600)} 小时`
}

onMounted(() => {
  void sessions.refreshTasks()
  poll = setInterval(() => sessions.refreshTasks(), 1500)
})
onBeforeUnmount(() => { if (poll) clearInterval(poll) })
</script>

<template>
  <div class="page">
    <PageHead title="任务中心" @back="router.push('/')" />
    <main class="body">
      <div class="summary">
        <span><strong>{{ active.length }}</strong> 个任务运行中</span>
        <span>并发上限 {{ sessions.taskConcurrencyLimit }}</span>
      </div>

      <p class="sec-label">当前任务</p>
      <div v-if="active.length" class="task-list">
        <div v-for="task in active" :key="task.task_id" :class="['task-row', { download: task.task_kind === 'download' }]">
          <button class="task-main" @click="inspectTask(task)">
            <span class="task-title">{{ task.session_title }}</span>
            <span class="task-meta">
              <span class="live-dot" />{{ task.download_status ? downloadLabels[task.download_status] : statusLabels[task.status] }} · {{ elapsed(task.started_at) }}
              <template v-if="task.download_label"> · {{ task.download_label }}</template>
              <template v-else-if="task.current_tool"> · {{ task.current_tool }}</template>
            </span>
          </button>
          <button v-if="task.status === 'running'" class="control" aria-label="暂停任务" title="暂停任务" @click="act(task, 'pause')">
            <CoomiIcon name="pause" :size="17" />
          </button>
          <button v-if="task.status === 'paused' || task.status === 'pause_pending'" class="control" aria-label="恢复任务" title="恢复任务" @click="act(task, 'resume')">
            <CoomiIcon name="play" :size="17" />
          </button>
          <button class="stop" aria-label="取消任务" title="取消任务" @click="act(task, 'cancel')">
            <CoomiIcon name="stop" :size="17" />
          </button>
        </div>
      </div>
      <p v-else class="empty">当前没有运行中的任务。</p>

      <template v-if="recent.length">
        <p class="sec-label">最近任务</p>
        <div class="task-list">
          <button v-for="task in recent" :key="task.task_id" class="task-row recent" @click="inspectTask(task)">
            <span class="task-main">
              <span class="task-title">{{ task.session_title }}</span>
              <span class="task-meta" :class="task.status">{{ statusLabels[task.status] }} · {{ elapsed(task.started_at) }}前开始</span>
            </span>
            <CoomiIcon name="chevronRight" :size="17" class="chevron" />
          </button>
        </div>
      </template>

      <section v-if="detail" class="detail">
        <div class="detail-head">
          <div>
            <p class="sec-label">任务详情</p>
            <strong>{{ detail.task.session_title || detail.task.kind }}</strong>
          </div>
          <button class="control" aria-label="关闭详情" title="关闭详情" @click="detail = null"><CoomiIcon name="close" :size="17" /></button>
        </div>
        <div class="detail-grid">
          <label>优先级
            <select :value="detail.task.priority" @change="setPriority(detail.task, $event)">
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
          <button v-if="['failed', 'cancelled', 'interrupted', 'conflict', 'completed'].includes(detail.task.status)" @click="act(detail.task, 'retry')"><CoomiIcon name="refresh" :size="16" />重试</button>
          <button @click="openTask(detail.task)"><CoomiIcon name="chat" :size="16" />打开会话</button>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 10px 12px calc(var(--safe-bottom) + 24px); }
.summary { display: flex; justify-content: space-between; align-items: baseline; min-height: 40px; padding: 8px 4px; color: var(--text-2); font-size: 13px; }
.summary strong { color: var(--blue); font-size: 20px; }
.sec-label { margin: 14px 4px 7px; }
.task-list { background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-card); overflow: hidden; }
.task-row { display: flex; align-items: center; width: 100%; min-height: 66px; text-align: left; }
.task-row + .task-row { border-top: 1px solid var(--border); }
.task-row.download { background: var(--blue-soft); }
.task-row.download .task-title::before { content: '下载 · '; color: var(--blue); font-weight: 650; }
.task-main { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; padding: 11px 6px 11px 14px; text-align: left; }
.task-title { overflow: hidden; color: var(--text); font-size: 14.5px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.task-meta { display: flex; align-items: center; min-width: 0; overflow: hidden; color: var(--text-3); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.live-dot { width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--blue); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
.stop { display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; margin-right: 6px; border-radius: 50%; color: var(--danger); }
.control { display: grid; place-items: center; flex: 0 0 40px; width: 40px; height: 40px; border-radius: 50%; color: var(--text-2); }
.stop:active { background: var(--danger-soft); }
.recent { padding: 0; }
.recent:active { background: var(--fill); }
.recent .task-main { pointer-events: none; }
.task-meta.failed { color: var(--danger); }
.task-meta.completed { color: var(--ok); }
.chevron { margin-right: 12px; color: var(--text-3); }
.empty { padding: 24px 8px; text-align: center; color: var(--text-3); font-size: 13px; }
.detail { margin-top: 22px; padding: 14px 4px 0; border-top: 1px solid var(--border); }
.detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.detail-head .sec-label { margin: 0 0 4px; }
.detail-head strong { font-size: 15px; }
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
</style>
