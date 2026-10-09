<script setup lang="ts">
import { computed } from 'vue'
import { useSessionsStore, type SessionMeta } from '@/stores/sessions'
import CoomiIcon from './CoomiIcon.vue'
const props = defineProps<{ parentId: string }>()
const emit = defineEmits<{ select: [id: string]; more: [session: SessionMeta] }>()
const sessions = useSessionsStore()
const children = computed(() => sessions.childrenOf(props.parentId))
</script>
<template>
  <div v-if="children.length" class="aux-children" aria-label="附属辅助会话">
    <div v-for="child in children" :key="child.id" class="aux-row">
      <button class="aux-child" @click="emit('select', child.id)">
        <CoomiIcon name="chat" :size="12" />
        <span class="aux-label">辅助 · {{ child.title }}</span>
        <span v-if="sessions.isRunning(child.id)" class="aux-running" aria-label="后台运行中" />
      </button>
      <button class="aux-more" aria-label="辅助会话更多操作" @click="emit('more', child)"><CoomiIcon name="more" :size="15" /></button>
    </div>
  </div>
</template>
<style scoped>
.aux-children { margin: 0 8px 8px 19px; padding-left: 10px; border-left: 1px solid var(--border-strong); }
.aux-row { display: flex; align-items: center; gap: 4px; }
.aux-child { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; text-align: left; padding: 7px 3px; color: var(--text-2); background: transparent; font-size: 12px; }
.aux-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aux-more { flex-shrink: 0; width: 28px; height: 28px; display: grid; place-items: center; color: var(--text-3); background: transparent; }
.aux-child:active, .aux-more:active { background: var(--fill); border-radius: 7px; }
.aux-running { flex-shrink: 0; width: 10px; height: 10px; border: 1.5px solid var(--blue-soft); border-top-color: var(--blue); border-radius: 50%; animation: aux-spin 1s linear infinite; }
@keyframes aux-spin { to { transform: rotate(360deg); } }
</style>
