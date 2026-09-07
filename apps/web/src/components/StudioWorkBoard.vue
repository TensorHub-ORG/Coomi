<script setup lang="ts">
import { useStudioStore } from '@/stores/studio'
import type { WorkItemStatus } from '@/stores/studio'

const emit = defineEmits<{ close: [] }>()
const studio = useStudioStore()

const columns: { status: WorkItemStatus; label: string; cls: string }[] = [
  { status: 'pending', label: '待处理', cls: 'pending' },
  { status: 'in_progress', label: '进行中', cls: 'in_progress' },
  { status: 'review', label: '待验收', cls: 'review' },
  { status: 'done', label: '完成', cls: 'done' },
  { status: 'failed', label: '失败', cls: 'failed' },
]

function itemsBy(status: WorkItemStatus) {
  return studio.workItems.filter(w => w.status === status)
}

function memberName(id?: string) {
  if (!id) return '-'
  return studio.members.find(m => m.id === id)?.name ?? '-'
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString()
}
</script>

<template>
  <div class="board-scrim" @click.self="emit('close')">
    <div class="board">
      <header class="board-head">
        <h3>工单看板</h3>
        <button class="icon-btn" aria-label="关闭" @click="emit('close')">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M5.2 5.2 14.8 14.8M14.8 5.2 5.2 14.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        </button>
      </header>
      <div class="columns">
        <div v-for="col in columns" :key="col.status" class="column">
          <div class="col-head" :class="col.cls">
            <span>{{ col.label }}</span>
            <span class="count">{{ itemsBy(col.status).length }}</span>
          </div>
          <div class="col-body">
            <div v-for="w in itemsBy(col.status)" :key="w.id" class="card">
              <p class="title">{{ w.title }}</p>
              <p v-if="w.description" class="desc">{{ w.description }}</p>
              <div class="meta">
                <span>负责人：{{ memberName(w.assigneeId) }}</span>
                <span>{{ fmtTime(w.updatedAt) }}</span>
              </div>
              <p v-if="w.result" class="result">{{ w.result }}</p>
            </div>
            <p v-if="itemsBy(col.status).length === 0" class="empty">暂无</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.board-scrim { position: fixed; inset: 0; z-index: 80; display: flex; align-items: flex-end; background: rgba(17, 22, 31, .4); }
.board { width: 100%; height: 80vh; display: flex; flex-direction: column; background: var(--bg); border-radius: 18px 18px 0 0; box-shadow: var(--shadow-sheet); }
.board-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.board-head h3 { font-size: 15px; font-weight: 650; color: var(--text); }
.icon-btn { display: grid; place-items: center; width: 32px; height: 32px; border: 0; background: none; color: var(--text-2); }
.columns { flex: 1; min-height: 0; display: flex; gap: 8px; padding: 10px; overflow-x: auto; }
.column { flex: 1; min-width: 180px; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.col-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; font-size: 12px; font-weight: 600; color: var(--text-2); background: var(--fill); }
.col-head .count { padding: 1px 7px; border-radius: var(--r-pill); background: var(--bg); font-size: 10px; }
.col-head.pending { border-left: 3px solid var(--text-3); }
.col-head.in_progress { border-left: 3px solid var(--orange); }
.col-head.review { border-left: 3px solid var(--blue); }
.col-head.done { border-left: 3px solid var(--ok); }
.col-head.failed { border-left: 3px solid var(--danger); }
.col-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; }
.card { padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elev); margin-bottom: 6px; }
.card .title { font-size: 12px; font-weight: 600; color: var(--text); }
.card .desc { font-size: 11px; color: var(--text-2); margin-top: 2px; }
.card .meta { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-3); margin-top: 4px; }
.card .result { font-size: 10px; color: var(--ok); margin-top: 4px; padding-top: 4px; border-top: 1px dashed var(--border); }
.empty { text-align: center; font-size: 11px; color: var(--text-3); padding: 12px 0; }
</style>
