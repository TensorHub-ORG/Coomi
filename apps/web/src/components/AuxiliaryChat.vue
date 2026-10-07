<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue'
import { SessionScope, useAuxiliarySessionStore, type SessionStore } from '@/stores/session'
import { useSessionsStore } from '@/stores/sessions'
import { useConfigStore } from '@/stores/config'
import { buildTimelineBlocks } from '@/utils/chatTimeline'
import TimelineBlock from './TimelineBlock.vue'
import ApprovalSheet from './ApprovalSheet.vue'
import QuestionSheet from './QuestionSheet.vue'

const props = defineProps<{ parentId: string; initialSessionId?: string }>()
const sessions = useSessionsStore()
const config = useConfigStore()
const current = shallowRef<SessionStore | null>(null)
provide(SessionScope, current)
const error = ref('')
const loading = ref(false)
const deleteArmed = ref(false)
const draft = ref('')
const scroll = ref<HTMLElement | null>(null)
const children = computed(() => sessions.childrenOf(props.parentId))
const blocks = computed(() => buildTimelineBlocks(current.value?.timeline ?? []))
const models = computed(() => config.providers.flatMap(p => [...new Set([p.model, ...p.models].filter(Boolean) as string[])].map(model => ({ value: `${p.id}::${model}`, label: `${p.name} · ${model}` }))))
const selectedModel = computed(() => { const m = sessions.find(current.value?.sessionId ?? ''); return m ? `${m.providerId}::${m.model}` : '' })
let selection = 0
let mounted = true
async function choose(id: string, parentId = props.parentId) {
  if (!mounted || parentId !== props.parentId || sessions.find(id)?.parentSessionId !== parentId) return
  const token = ++selection
  current.value?.flushPersistence()
  const store = useAuxiliarySessionStore(id)
  if (store.sessionId !== id) await store.openSession(id)
  else store.connect()
  if (!mounted || token !== selection || parentId !== props.parentId) return
  current.value = store
  deleteArmed.value = false
  localStorage.setItem(`coomi.auxiliary.active.${parentId}`, id)
  draft.value = localStorage.getItem(`coomi.auxiliary.draft.${id}`) ?? ''
}
async function create() {
  if (loading.value) return
  const parentId = props.parentId
  loading.value = true; error.value = ''
  try { await choose(await sessions.createAuxiliary(parentId), parentId) }
  catch (e) { error.value = String(e) }
  finally { loading.value = false }
}
watch(() => [props.parentId, props.initialSessionId], async () => {
  const token = ++selection
  const parentId = props.parentId
  current.value?.flushPersistence()
  current.value = null
  await sessions.syncFromEngine()
  if (!mounted || token !== selection || parentId !== props.parentId) return
  const stored = props.initialSessionId || localStorage.getItem(`coomi.auxiliary.active.${props.parentId}`)
  const id = children.value.find(child => child.id === stored)?.id || children.value[0]?.id
  if (id) await choose(id)
}, { immediate: true })
onBeforeUnmount(() => { mounted = false; ++selection; current.value?.flushPersistence() })
watch(() => current.value?.pendingEdit, edit => { if (edit) draft.value = edit.content })
watch(draft, text => { if (current.value) localStorage.setItem(`coomi.auxiliary.draft.${current.value.sessionId}`, text) }, { flush: 'sync' })
watch(() => {
  const timeline = current.value?.timeline ?? []
  const tail = timeline[timeline.length - 1]
  return [timeline.length, tail && 'content' in tail ? tail.content : '', current.value?.runState]
}, async () => { await nextTick(); if (scroll.value) scroll.value.scrollTop = scroll.value.scrollHeight })
function send() { if (!draft.value.trim() || !current.value) return; current.value.sendMessage(draft.value); draft.value = '' }
function changeModel(event: Event) { const [provider, model] = (event.target as HTMLSelectElement).value.split('::'); if (provider && model) void current.value?.selectModel(provider, model) }
async function removeCurrent() {
  if (!current.value || current.value.isBusy) return
  if (!deleteArmed.value) { deleteArmed.value = true; return }
  const store = current.value
  try {
    store.flushPersistence()
    await sessions.removeAuxiliary(store.sessionId)
    store.disconnect()
    if (!mounted || current.value !== store) return
    current.value = null
    deleteArmed.value = false
    const next = children.value[0]
    if (next) await choose(next.id)
  } catch (e) { error.value = String(e) }
}
</script>

<template>
  <section class="auxiliary-chat" aria-label="独立辅助对话">
    <header>
      <select aria-label="辅助会话" :value="current?.sessionId" @change="choose(($event.target as HTMLSelectElement).value)">
        <option v-if="!current" value="">选择辅助对话</option>
        <option v-for="child in children" :key="child.id" :value="child.id">{{ sessions.isRunning(child.id) ? '运行中 · ' : '' }}{{ child.title }}</option>
      </select>
      <button :disabled="loading" @click="create">{{ loading ? '创建中' : '新建' }}</button>
      <button v-if="current" :disabled="current.isBusy" @click="removeCurrent">{{ deleteArmed ? '确认删除' : '删除' }}</button>
    </header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <template v-if="current">
      <select class="model" aria-label="辅助会话模型" :value="selectedModel" :disabled="current.isBusy" @change="changeModel">
        <option v-for="model in models" :key="model.value" :value="model.value">{{ model.label }}</option>
      </select>
      <div :key="current.sessionId" ref="scroll" class="transcript">
        <p v-if="!blocks.length" class="hint">独立执行任务，需要时可读取主对话。关闭卡片后任务继续运行。</p>
        <TimelineBlock v-for="(block, i) in blocks" :key="i" :block="block" />
        <p v-if="current.isBusy" role="status" class="hint">{{ current.runState === 'awaiting_approval' ? '等待授权' : '处理中…' }}</p>
        <button v-if="current.undoConfirm" @click="current.confirmUndo()">确认回撤本轮</button>
        <button v-if="current.retryConfirmation" @click="current.retryInterruptedTurn()">重试中断的任务</button>
      </div>
      <form @submit.prevent="send">
        <textarea v-model="draft" rows="2" placeholder="给辅助助手一个任务…" aria-label="辅助对话消息" @keydown.enter.exact.prevent="send" />
        <button v-if="current.isBusy" type="button" @click="current.cancel()">停止</button>
        <button v-else type="submit" :disabled="!draft.trim()">发送</button>
      </form>
      <button v-if="current.pendingEdit" @click="current.cancelEditMessage()">取消编辑</button>
      <ApprovalSheet v-if="current.pendingApproval" :key="current.pendingApproval.callId" :card="current.pendingApproval" @decide="current.approve(current.pendingApproval!.callId, $event)" />
      <QuestionSheet v-if="current.pendingQuestion" :key="current.pendingQuestion.callId" :card="current.pendingQuestion" @answer="current.answerQuestion(current.pendingQuestion!.callId, $event)" />
    </template>
    <div v-else class="empty"><p>辅助助手拥有独立上下文和模型，支持完整工具调用。</p><button :disabled="loading" @click="create">开始辅助对话</button></div>
  </section>
</template>

<style scoped>
.auxiliary-chat { --aux-density: .82; position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; color: var(--text); }
header, form { display: flex; gap: 6px; padding: 8px; flex-shrink: 0; }
select, textarea { min-width: 0; width: 100%; border: 1px solid var(--border); border-radius: 8px; background: var(--fill); color: inherit; padding: 7px; font: inherit; font-size: 12px; }
button { flex-shrink: 0; border: 0; border-radius: 8px; background: var(--fill); color: var(--blue); padding: 7px 9px; font: inherit; font-size: 12px; }
button:disabled { opacity: .5; }.model { width: calc(100% - 16px); margin: 0 8px; }
.transcript { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 9px 8px; }
.transcript :deep(.bubble) { padding: 7px 10px; border-radius: 15px 15px 6px 15px; font-size: 12.5px; line-height: 1.48; }
.transcript :deep(.user-wrap) { max-width: 88%; }
.transcript :deep(.md) { font-size: 12.3px; line-height: 1.58; }
.transcript :deep(.acts) { gap: 1px; margin-top: 4px; }
.transcript :deep(.act) { height: 23px; padding: 0 6px; gap: 3px; font-size: 10.5px; }
.transcript :deep(.act svg) { width: 12px; height: 12px; }
.transcript :deep(.reasoning .toggle) { min-height: 27px; padding: 2px; gap: 5px; font-size: 11px; }
.transcript :deep(.reasoning .body) { margin-top: 2px; padding: 6px 9px; font-size: 11.2px; line-height: 1.55; }
.transcript :deep(.tool) { border-radius: 10px; }
.transcript :deep(.tool .head) { min-height: 36px; padding: 5px 8px; gap: 7px; }
.transcript :deep(.tool .tile) { width: 24px; height: 24px; border-radius: 7px; }
.transcript :deep(.tool .verb) { font-size: 11.5px; }
.transcript :deep(.tool .target), .transcript :deep(.tool .st) { font-size: 9.8px; }
.transcript :deep(.tool .body) { padding: 3px 8px 8px; }
.transcript :deep(.group .ghead) { min-height: 36px; padding: 5px 8px; gap: 6px; }
.transcript :deep(.group .gicon) { width: 24px; height: 24px; border-radius: 7px; }
.transcript :deep(.group .gtitle) { font-size: 11.5px; }
.transcript :deep(.group .gsum), .transcript :deep(.group .gms) { font-size: 9.8px; }
.transcript :deep(.attachment-chip) { height: 31px; }
.transcript :deep(.attachment-chip img), .transcript :deep(.file-icon) { width: 22px; height: 22px; flex-basis: 22px; }
.empty { margin: auto; padding: 16px; font-size: 13px; text-align: center; }.hint { color: var(--text-3); font-size: 12px; }.error { color: var(--danger); font-size: 12px; margin: 4px 8px; }
textarea { resize: none; } :deep(.scrim) { position: absolute; z-index: 10; } :deep(.sheet) { max-height: 100%; overflow: auto; }
</style>
