<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import StudioMemberStrip from '@/components/StudioMemberStrip.vue'
import StudioWorkBoard from '@/components/StudioWorkBoard.vue'
import { useStudioStore, type StudioMessage } from '@/stores/studio'
import { goBack } from '@/bridge/navigation'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

interface Entry { key: string; memberId: string; name: string; timestamp: number; content: string; reasoning: string; tools: string[]; status: string; live: boolean }
const route = useRoute(), router = useRouter(), studio = useStudioStore()
const studioId = String(route.params.id)
const input = ref(''), scroller = ref<HTMLElement | null>(null), entries = ref<Entry[]>([])
const showAtPicker = ref(false), showWorkBoard = ref(false), sending = ref(false), stopping = ref(false)
const importedFiles = ref<string[]>([]), expanded = reactive<Record<string, boolean>>({}), expandedTools = reactive<Record<string, boolean>>({})
const hasNative = !!window.CoomiAndroid
let alive = true, sequence = 0, pressTimer: ReturnType<typeof setTimeout> | undefined
const activeEntries = new Map<string, Entry>()
const busy = computed(() => sending.value || studio.running || stopping.value)
function fromMessage(msg: StudioMessage): Entry { return { key: msg.id, memberId: msg.senderId, name: msg.senderName, timestamp: msg.timestamp, content: msg.content, reasoning: '', tools: [], status: 'done', live: false } }
function scrollToBottom() { nextTick(() => { if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight }) }
function insertAt(id: string) { const m = studio.members.find(m => m.id === id); if (m) input.value += `@${m.name} `; showAtPicker.value = false }
function endPress() { clearTimeout(pressTimer); pressTimer = undefined }
function startPress(id: string) { endPress(); pressTimer = setTimeout(() => insertAt(id), 520) }
function importFiles() { window.CoomiAndroid?.importFiles?.() }
function liveEntry(id: string) {
  let entry = activeEntries.get(id)
  if (!entry) {
    entry = reactive({ key: `live-${++sequence}`, memberId: id, name: studio.members.find(m => m.id === id)?.name ?? '成员', timestamp: Date.now(), content: '', reasoning: '', tools: [], status: 'thinking', live: true })
    entries.value.push(entry); activeEntries.set(id, entry)
  }
  return entry
}
function toolsFor(entry: Entry) { return studio.toolCards.filter(t => entry.tools.includes(t.callId)) }
function statusText(status: string) { return ({ thinking: '深入思考中', executing: '执行中', running: '执行中', approval: '待确认', done: '完成', success: '完成', failed: '失败', error: '失败', stopped: '已停止', idle: '就绪' } as Record<string, string>)[status] ?? status }
function onFilesImported(event: Event) { const paths = (event as CustomEvent<{ paths?: string[] }>).detail?.paths ?? []; importedFiles.value = [...new Set([...importedFiles.value, ...paths])] }
function onEvent(event: Record<string, any>) {
  if (!alive) return
  const type = event.event_type, id = String(event.member_id ?? event.message?.senderId ?? '')
  if (type === 'studio_user_message' && event.message) {
    const pending = entries.value.find(e => e.key.startsWith('pending-'))
    if (pending) { pending.key = event.message.id; pending.status = 'done' }
  } else if (type === 'studio_member_status') {
    studio.onMemberStatus(id, event.status)
    if (event.status === 'done' && !activeEntries.has(id)) return
    const entry = liveEntry(id); entry.status = event.status
    if (event.status === 'failed') { entry.live = false; activeEntries.delete(id) }
  } else if (type === 'studio_text_delta') liveEntry(id).content += String(event.content ?? '')
  else if (type === 'studio_reasoning_delta') liveEntry(id).reasoning += String(event.content ?? '')
  else if (type === 'studio_stream_reset') { const entry = activeEntries.get(id); if (entry) entry.content = '' }
  else if (['studio_tool_start', 'studio_tool_done', 'studio_tool_approval'].includes(type)) {
    studio.onToolEvent(event); const entry = liveEntry(id)
    if (!entry.tools.includes(event.call_id)) entry.tools.push(event.call_id)
  } else if (type === 'studio_message') {
    const entry = liveEntry(id); entry.key = event.message.id; entry.content = event.message.content; entry.timestamp = event.message.timestamp; entry.live = false; entry.status = 'done'
    activeEntries.delete(id)
  } else if (type === 'studio_error') studio.error = String(event.message ?? '工作室运行失败')
  else if (type === 'studio_notice') studio.notice = String(event.message ?? '')
  scrollToBottom()
}
async function send() {
  const text = input.value.trim(), files = [...importedFiles.value]
  if ((!text && !files.length) || busy.value) return
  sending.value = true
  entries.value.push({ ...fromMessage({ id: `pending-${++sequence}`, senderId: 'user', senderName: '我', content: [text, ...files.map(p => `📎 ${p.split('/').pop()}`)].filter(Boolean).join('\n'), mentions: [], timestamp: Date.now(), type: 'text' }), status: 'sending' })
  input.value = ''; importedFiles.value = []; scrollToBottom()
  try { await studio.sendMessage([text, files.length ? `请读取这些已导入文件：\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n'), onEvent) }
  finally {
    if (alive) { sending.value = false; for (const entry of activeEntries.values()) { entry.live = false; if (!['done', 'failed'].includes(entry.status)) entry.status = studio.error ? 'failed' : 'stopped' }; activeEntries.clear() }
  }
}
async function stop() { stopping.value = true; try { await studio.stopRun() } catch { /* store displays failure */ } finally { stopping.value = false } }
async function approve(callId: string, decision: 'allow' | 'deny' | 'always') { try { await studio.approveTool(callId, decision) } catch (e) { studio.error = String(e) } }
onMounted(async () => {
  window.addEventListener('coomi:files-imported', onFilesImported)
  await studio.fetchStudio(studioId)
  if (!alive) return
  entries.value = studio.messages.map(fromMessage)
  await studio.fetchStatus(); scrollToBottom()
})
onBeforeRouteLeave(async () => { try { await studio.stopRun() } catch { return false } })
onBeforeUnmount(() => {
  alive = false
  if (studio.running || sending.value) void studio.stopRun().catch(() => {})
  studio.reset(); endPress(); window.removeEventListener('coomi:files-imported', onFilesImported)
  unregisterOverlay('studio-mentions'); unregisterOverlay('studio-board')
})
watch(showAtPicker, open => open ? registerOverlay('studio-mentions', () => { showAtPicker.value = false }) : unregisterOverlay('studio-mentions'))
watch(showWorkBoard, open => open ? registerOverlay('studio-board', () => { showWorkBoard.value = false }) : unregisterOverlay('studio-board'))
</script>

<template>
  <div class="page">
    <PageHead :title="studio.currentStudio?.name ?? '工作室'" @back="goBack(router, 'dashboard')">
      <template #right><button class="icon-btn" aria-label="工单看板" @click="showWorkBoard = true"><CoomiIcon name="todo" :size="18" /></button><button class="icon-btn" aria-label="编辑" @click="router.push(`/studio/${studioId}/edit`)"><CoomiIcon name="pencil" :size="18" /></button></template>
    </PageHead>
    <StudioMemberStrip @mention="insertAt" />
    <main ref="scroller" class="stream">
      <div v-if="!entries.length" class="intro"><CoomiIcon name="sparkle" :size="26" /><b>一起完成一件事</b><span>输入任务，或长按头像 @ 成员协作。</span></div>
      <p v-if="studio.error" class="notice" role="alert">{{ studio.error }}</p>
      <p v-if="studio.notice" class="notice" role="status">{{ studio.notice }}</p>
      <article v-for="entry in entries" :key="entry.key" class="entry" :class="{ me: entry.memberId === 'user' }">
        <div class="meta"><button class="avatar" :disabled="entry.memberId === 'user'" @pointerdown="startPress(entry.memberId)" @pointerup="endPress" @pointercancel="endPress" @pointerleave="endPress" @contextmenu.prevent="insertAt(entry.memberId)">{{ entry.name?.[0] }}</button><b>{{ entry.name }}</b><span v-if="entry.live" class="live-label">{{ statusText(entry.status) }}</span><span v-else>{{ new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span></div>
        <div v-if="entry.reasoning || entry.tools.length" class="execution">
          <button class="execution-toggle" :aria-expanded="!!expanded[entry.key]" @click="expanded[entry.key] = !expanded[entry.key]"><CoomiIcon :name="entry.live ? 'loop' : 'check'" :size="13" /><span>{{ entry.reasoning ? '思考' : '执行' }}{{ entry.tools.length ? ` · ${entry.tools.length} 次工具调用` : '' }}</span><em v-if="toolsFor(entry).some(t => t.status === 'approval')">待确认</em><CoomiIcon name="chevronRight" :size="12" :class="{ rotated: expanded[entry.key] }" /></button>
          <div v-if="expanded[entry.key]" class="execution-detail">
            <details v-if="entry.reasoning" class="reasoning"><summary>查看思考过程</summary><p>{{ entry.reasoning }}</p></details>
            <div v-for="tool in toolsFor(entry)" :key="tool.callId" class="tool" :class="tool.status">
              <button class="tool-head" :aria-expanded="!!expandedTools[tool.callId]" @click="expandedTools[tool.callId] = !expandedTools[tool.callId]"><CoomiIcon name="wrench" :size="12" /><span>{{ tool.toolName }}</span><small>{{ statusText(tool.status) }}</small><CoomiIcon name="chevronRight" :size="12" :class="{ rotated: expandedTools[tool.callId] }" /></button>
              <div v-if="expandedTools[tool.callId]" class="tool-detail"><pre v-if="tool.arguments">{{ JSON.stringify(tool.arguments, null, 2) }}</pre><pre v-if="tool.resultPreview">{{ tool.resultPreview }}</pre><img v-for="src in tool.images" :key="src" :src="src" alt="工具结果" /></div>
              <div v-if="tool.status === 'approval'" class="approval"><p>{{ tool.riskSummary || '此工具需要确认后执行' }}</p><div class="tool-actions"><button @click="approve(tool.callId, 'deny')">拒绝</button><button @click="approve(tool.callId, 'allow')">允许一次</button><button @click="approve(tool.callId, 'always')">始终允许</button></div></div>
            </div>
          </div>
        </div>
        <p v-if="entry.content" class="content">{{ entry.content }}</p>
        <span v-else-if="!entry.live && entry.status !== 'done'" class="ended">{{ statusText(entry.status) }}</span>
      </article>
    </main>
    <div class="composer"><div v-if="importedFiles.length" class="attachments"><button v-for="path in importedFiles" :key="path" @click="importedFiles = importedFiles.filter(p => p !== path)">{{ path.split('/').pop() }} ×</button></div><div class="input-row"><button class="round-tool" aria-label="提及成员" @click="showAtPicker = !showAtPicker"><CoomiIcon name="at" :size="18" /></button><button v-if="hasNative" class="round-tool" aria-label="导入文件" @click="importFiles"><CoomiIcon name="fileRead" :size="18" /></button><input v-model="input" placeholder="告诉工作室要做什么…" @keyup.enter="send" /><button v-if="busy" class="send-btn stop" :disabled="stopping" aria-label="停止" @click="stop"><CoomiIcon name="stop" :size="15" /></button><button v-else class="send-btn" :disabled="!input.trim() && !importedFiles.length" aria-label="发送" @click="send"><CoomiIcon name="arrowRight" :size="16" /></button></div></div>
    <div v-if="showAtPicker" class="at-picker"><p>选择协作成员</p><button v-for="m in studio.members" :key="m.id" @click="insertAt(m.id)"><span class="avatar">{{ m.name[0] }}</span>{{ m.name }}</button></div>
    <StudioWorkBoard v-if="showWorkBoard" @close="showWorkBoard = false" />
  </div>
</template>

<style scoped>
.page{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--page);position:relative}.icon-btn,.round-tool{display:grid;place-items:center;width:36px;height:36px;flex:none;padding:0;border:0;background:none;color:var(--text-2)}.stream{flex:1;min-height:0;overflow:auto;padding:16px 16px 22px}.intro{display:flex;flex-direction:column;align-items:center;gap:10px;padding:46px 12px;color:var(--text-3);font-size:12px}.intro svg{color:var(--blue)}.intro b{color:var(--text);font-size:15px}.notice{padding:10px 12px;background:var(--danger-soft);color:var(--danger);border-radius:10px;font-size:12px}.entry{margin-bottom:19px;min-width:0}.meta{display:flex;align-items:center;gap:7px;color:var(--text-3);font-size:10px}.meta b{color:var(--text-2);font-size:12px;font-weight:600}.meta>span:last-child{margin-left:auto}.avatar{display:grid;place-items:center;flex:none;width:24px;height:24px;padding:0;border:0;border-radius:8px;background:var(--blue-soft);color:var(--blue);font-size:10px}.live-label{color:var(--blue)}.content{margin:7px 0 0 31px;color:var(--text);font-size:13px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere}.me{padding:10px 12px;background:var(--fill);border-radius:13px}.me .content{margin:5px 0 0}.me .avatar{display:none}.execution{margin:4px 0 0 31px}.execution-toggle,.tool-head{display:flex;align-items:center;gap:6px;min-height:30px;width:100%;padding:2px 0;border:0;background:none;color:var(--text-3);font-size:11px;text-align:left}.execution-toggle>span,.tool-head>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.execution-toggle em{font-style:normal;color:var(--orange)}.rotated{transform:rotate(90deg)}.execution-detail{padding:3px 10px;border-left:1px solid var(--border)}.reasoning{font-size:11px;color:var(--text-3)}.reasoning summary{padding:6px 0;cursor:pointer}.reasoning p{max-height:240px;overflow:auto;white-space:pre-wrap;line-height:1.6}.tool+.tool{border-top:1px solid var(--border)}.tool-head small{font-size:10px}.approval .tool-head{color:var(--orange)}.tool-detail pre{margin:4px 0;max-height:160px;overflow:auto;padding:8px;background:var(--code-bg);color:var(--code-text);border-radius:7px;font:11px/1.5 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}.tool-detail img{max-width:100%;max-height:220px;object-fit:contain}.approval p{margin:4px 0 8px;font-size:11px;line-height:1.5;color:var(--orange)}.tool-actions{display:flex;gap:6px;padding-bottom:8px}.tool-actions button{flex:1;min-height:32px;border:0;border-radius:7px;background:var(--blue-soft);color:var(--blue);font-size:11px}.ended{display:block;margin:6px 0 0 31px;font-size:11px;color:var(--text-3)}.composer{flex:none;padding:8px 10px calc(var(--safe-bottom) + 10px);border-top:1px solid var(--border);background:var(--bg)}.input-row{display:flex;align-items:center;gap:4px}.input-row input{flex:1;min-width:0;height:40px;padding:0 12px;border:1px solid var(--border);border-radius:20px;background:var(--fill);color:var(--text);font-size:13px;outline:none}.send-btn{display:grid;place-items:center;flex:none;width:38px;height:38px;border:0;border-radius:50%;background:var(--blue);color:#fff}.send-btn:disabled{opacity:.4}.send-btn.stop{background:var(--text)}.attachments{display:flex;flex-wrap:wrap;gap:5px;padding-bottom:7px}.attachments button{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 9px;border:0;border-radius:8px;background:var(--blue-soft);color:var(--blue);font-size:11px}.at-picker{position:absolute;left:10px;right:10px;bottom:calc(var(--safe-bottom) + 66px);max-height:45%;overflow:auto;z-index:60;padding:10px;border:1px solid var(--border);border-radius:14px;background:var(--bg);box-shadow:var(--shadow-2)}.at-picker p{margin:3px 8px 7px;color:var(--text-3);font-size:11px}.at-picker>button{display:flex;align-items:center;gap:9px;width:100%;min-height:42px;padding:7px;border:0;background:none;color:var(--text);font-size:13px;text-align:left}
</style>
