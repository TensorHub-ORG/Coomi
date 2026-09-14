<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import TaskDetailPanel from '@/components/TaskDetailPanel.vue'
import { useSessionStore } from '@/stores/session'
import { useSessionsStore, type TaskDetail, type TaskInfo } from '@/stores/sessions'

const router = useRouter()
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
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
  if (detail.value?.task.task_id === task.task_id) { detail.value = null; return }
  detail.value = await sessions.taskDetail(task.task_id)
}

async function act(task: TaskInfo, action: 'pause' | 'resume' | 'cancel' | 'retry') {
  await sessions.taskAction(task.task_id, action)
  detail.value = await sessions.taskDetail(task.task_id)
}

async function setPriority(task: TaskInfo, priority: TaskInfo['priority']) {
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
  <div class="page" :class="{ embedded: props.embedded }">
    <PageHead v-if="!props.embedded" title="任务中心" @back="router.push('/')" />
    <main class="body">
      <div class="summary">
        <span><strong>{{ active.length }}</strong> 个任务运行中</span>
        <span>并发上限 {{ sessions.taskConcurrencyLimit }}</span>
      </div>

      <p class="sec-label">当前任务</p>
      <div v-if="active.length" class="task-list">
        <template v-for="task in active" :key="task.task_id">
        <div :class="['task-row', { download: task.task_kind === 'download', selected: detail?.task.task_id === task.task_id }]">
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
        <TaskDetailPanel v-if="detail?.task.task_id === task.task_id" :detail="detail" :status-labels="statusLabels" @close="detail = null" @action="act" @priority="setPriority" @open="openTask" />
        </template>
      </div>
      <p v-else class="empty">当前没有运行中的任务。</p>

      <template v-if="recent.length">
        <p class="sec-label">最近任务</p>
        <div class="task-list">
          <template v-for="task in recent" :key="task.task_id">
          <button class="task-row recent" :class="{ selected: detail?.task.task_id === task.task_id }" @click="inspectTask(task)">
            <span class="task-main">
              <span class="task-title">{{ task.session_title }}</span>
              <span class="task-meta" :class="task.status">{{ statusLabels[task.status] }} · {{ elapsed(task.started_at) }}前开始</span>
            </span>
            <CoomiIcon name="chevronRight" :size="17" class="chevron" />
          </button>
          <TaskDetailPanel v-if="detail?.task.task_id === task.task_id" :detail="detail" :status-labels="statusLabels" @close="detail = null" @action="act" @priority="setPriority" @open="openTask" />
          </template>
        </div>
      </template>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 10px 12px calc(var(--safe-bottom) + 24px); }
.page.embedded { min-height:0; background:transparent; }
.embedded .body { padding:0 2px 14px; }
.embedded .summary { padding-top:0; }
.summary { display: flex; justify-content: space-between; align-items: baseline; min-height: 40px; padding: 8px 4px; color: var(--text-2); font-size: 13px; }
.summary strong { color: var(--blue); font-size: 20px; }
.sec-label { margin: 14px 4px 7px; }
.task-list { background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-card); overflow: hidden; }
.task-row { display: flex; align-items: center; width: 100%; min-height: 66px; text-align: left; }
.task-row + .task-row { border-top: 1px solid var(--border); }
.task-row.download { background: var(--blue-soft); }
.task-row.selected { background: color-mix(in srgb, var(--blue-soft) 68%, var(--bg)); }
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
</style>
