<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useStudioStore, type StudioMessage } from '@/stores/studio'
import StudioMemberStrip from '@/components/StudioMemberStrip.vue'
import StudioWorkBoard from '@/components/StudioWorkBoard.vue'
import { goBack } from '@/bridge/navigation'

const route = useRoute()
const router = useRouter()
const studio = useStudioStore()
const studioId = computed(() => route.params.id as string)

const input = ref('')
const scroller = ref<HTMLElement | null>(null)
const showAtPicker = ref(false)
const showWorkBoard = ref(false)
const sending = ref(false)
const pendingUser = ref<StudioMessage | null>(null)
const streamContent = ref('')
const streamingMember = ref('')
/** 后台成员执行错误（原先是静默吞掉，导致「发了消息没反应」） */
const streamNotices = ref<string[]>([])
const importedFiles = ref<string[]>([])
const hasNative = typeof window !== 'undefined' && !!window.CoomiAndroid

const atTargets = computed(() => studio.members.map(m => ({ value: m.id, label: m.name })))

onMounted(async () => {
  await studio.fetchStudio(studioId.value)
  await studio.fetchMessages()
  await studio.fetchWorkItems()
  scrollToBottom()
  window.addEventListener('coomi:files-imported', onFilesImported)
})

onBeforeUnmount(() => {
  studio.reset()
  window.removeEventListener('coomi:files-imported', onFilesImported)
})

watch(() => studio.messages.length, () => { scrollToBottom() })
watch(streamContent, () => { scrollToBottom() })
watch(() => streamNotices.value.length, () => { scrollToBottom() })

function scrollToBottom() {
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  })
}

function insertAt(id: string) {
  const m = studio.members.find(x => x.id === id)
  if (!m) return
  input.value += `@${m.name} `
  showAtPicker.value = false
}

function importFiles() {
  showAtPicker.value = false
  window.CoomiAndroid?.importFiles?.()
}

function onFilesImported(event: Event) {
  const detail = (event as CustomEvent<{ paths?: string[] }>).detail ?? {}
  const paths = detail.paths ?? []
  if (paths.length) importedFiles.value = Array.from(new Set([...importedFiles.value, ...paths]))
}

function removeImportedFile(path: string) {
  importedFiles.value = importedFiles.value.filter(item => item !== path)
}

async function send() {
  const text = input.value.trim()
  if (!text || sending.value) return
  sending.value = true
  streamNotices.value = []
  const fileNames = importedFiles.value.map(path => path.split('/').pop() || '文件')
  const displayText = [text, ...fileNames.map(n => `📎 ${n}`)].filter(Boolean).join('\n')
  pendingUser.value = {
    id: `pending-${Date.now()}`, senderId: 'user', senderName: '我', content: displayText,
    mentions: [], timestamp: Date.now(), type: 'text',
  }
  const fileInstruction = importedFiles.value.length ? `请读取这些已导入文件：\n${importedFiles.value.join('\n')}` : ''
  const requestText = [text, fileInstruction].filter(Boolean).join('\n\n')
  input.value = ''
  importedFiles.value = []
  scrollToBottom()
  try {
    await studio.sendMessage(requestText, (event) => {
      if (event.event_type === 'studio_user_message') return
      if (event.event_type === 'studio_member_status') {
        studio.onMemberStatus(String(event.member_id), event.status as any)
        streamingMember.value = ['thinking', 'executing'].includes(String(event.status)) ? String(event.member_id) : ''
      } else if (event.event_type === 'studio_text_delta') {
        if (streamingMember.value !== String(event.member_id)) { streamingMember.value = String(event.member_id); streamContent.value = '' }
        streamContent.value += String(event.content ?? '')
      } else if (['studio_tool_start', 'studio_tool_done', 'studio_tool_approval'].includes(String(event.event_type))) {
        studio.onToolEvent(event)
      } else if (event.event_type === 'studio_error') {
        const message = String(event.message ?? '成员执行出错')
        streamNotices.value.push(message)
      } else if (event.event_type === 'studio_message') {
        streamContent.value = ''
        streamingMember.value = ''
      }
    })
  } finally {
    pendingUser.value = null
    streamContent.value = ''
    streamingMember.value = ''
    await studio.fetchMessages()
    sending.value = false
  }
}

/** 成员执行中（含未产出首字前的等待）：三点动画指示。 */
const memberActive = computed(() => Boolean(streamingMember.value))

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString()
}
</script>

<template>
  <div class="page">
    <PageHead :title="studio.currentStudio?.name ?? '工作室'" @back="goBack(router, 'dashboard')">
      <template #right>
        <button class="icon-btn" aria-label="工单看板" @click="showWorkBoard = true"><CoomiIcon name="todo" :size="18" /></button>
        <button class="icon-btn" aria-label="编辑" @click="router.push(`/studio/${studioId}/edit`)"><CoomiIcon name="pencil" :size="18" /></button>
      </template>
    </PageHead>

    <StudioMemberStrip />

    <main ref="scroller" class="stream">
      <div v-if="studio.error" class="notice err">{{ studio.error }}</div>
      <div v-for="(note, index) in streamNotices" :key="'err-' + index" class="notice err">{{ note }}</div>
      <p v-if="studio.messages.length === 0 && !pendingUser && !streamContent" class="empty">开始对话吧，输入 @成员 直接指派任务。</p>
      <div v-for="msg in studio.messages" :key="msg.id" class="msg" :class="{ me: msg.senderId === 'user' }">
        <div class="avatar">{{ msg.senderName[0] }}</div>
        <div class="bubble">
          <div class="meta"><b>{{ msg.senderName }}</b><span>{{ fmtTime(msg.timestamp) }}</span></div>
          <div class="content">{{ msg.content }}</div>
        </div>
      </div>
      <div v-if="pendingUser" class="msg me pending-msg">
        <div class="avatar">我</div>
        <div class="bubble">
          <div class="meta"><b>我</b><span>{{ fmtTime(pendingUser.timestamp) }}</span></div>
          <div class="content">{{ pendingUser.content }}</div>
        </div>
      </div>
      <div v-if="memberActive" class="msg streaming-msg">
        <div class="avatar">{{ studio.members.find(m => m.id === streamingMember)?.name?.[0] || 'AI' }}</div>
        <div class="stream-col">
          <div class="typing" aria-label="成员执行中"><i /><i /><i /></div>
          <div v-if="streamContent" class="bubble">
            <div class="meta"><b>{{ studio.members.find(m => m.id === streamingMember)?.name || 'AI' }}</b><span>正在回复</span></div>
            <div class="content">{{ streamContent }}<i class="stream-cursor" aria-hidden="true" /></div>
          </div>
        </div>
      </div>
      <article v-for="tool in studio.toolCards" :key="tool.callId" class="tool-card" :class="tool.status">
        <div class="tool-head"><span><CoomiIcon name="wrench" :size="14" />{{ tool.memberName }} · {{ tool.toolName }}</span><em>{{ tool.status === 'approval' ? '等待确认' : tool.status === 'running' ? '执行中' : tool.status === 'success' ? '已完成' : '失败' }}</em></div>
        <p v-if="tool.riskSummary">{{ tool.riskSummary }}</p><pre v-if="tool.resultPreview">{{ tool.resultPreview }}</pre>
        <div v-if="tool.status === 'approval'" class="tool-actions"><button @click="studio.approveTool(tool.callId,'deny')">拒绝</button><button @click="studio.approveTool(tool.callId,'allow')">允许一次</button><button class="primary" @click="studio.approveTool(tool.callId,'always')">始终允许</button></div>
      </article>
    </main>

    <div class="composer">
      <div v-if="importedFiles.length" class="attachments">
        <span v-for="path in importedFiles" :key="path" class="attachment">
          <CoomiIcon name="fileRead" :size="14" />
          <span>{{ path.split('/').pop() || '文件' }}</span>
          <button type="button" aria-label="移除文件" @click="removeImportedFile(path)"><CoomiIcon name="close" :size="12" /></button>
        </span>
      </div>
      <div class="input-row">
        <button class="at-btn" aria-label="提及成员" @click="showAtPicker = !showAtPicker"><CoomiIcon name="at" :size="18" /></button>
        <button v-if="hasNative" class="file-btn" aria-label="导入文件" @click="importFiles"><CoomiIcon name="fileRead" :size="18" /></button>
        <input v-model="input" placeholder="输入消息，@成员 直接指派…" @keyup.enter="send" />
        <button v-if="sending" class="send-btn stop" aria-label="停止" @click="studio.stopRun()"><CoomiIcon name="stop" :size="15" /></button>
        <button v-else class="send-btn" :disabled="!input.trim() && !importedFiles.length" @click="send"><CoomiIcon name="arrowRight" :size="16" /></button>
      </div>
    </div>

    <div v-if="showAtPicker" class="at-picker">
      <div class="at-grip" />
      <button v-for="t in atTargets" :key="t.value" class="at-item" @click="insertAt(t.value)">{{ t.label }}</button>
    </div>

    <StudioWorkBoard v-if="showWorkBoard" @close="showWorkBoard = false" />
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); position: relative; }
.icon-btn { display: grid; place-items: center; width: 36px; height: 36px; border: 0; background: none; color: var(--text-2); }
.stream { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; }
.empty { text-align: center; padding: 30px 16px; font-size: 13px; color: var(--text-3); }
.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; font-size: 12.5px; }
.notice.err { background: color-mix(in srgb, var(--orange) 16%, var(--bg)); color: var(--orange); }
.msg { display: flex; gap: 8px; margin-bottom: 12px; }
.msg.me { flex-direction: row-reverse; }
.avatar { width: 32px; height: 32px; border-radius: 50%; background: var(--blue-soft); color: var(--blue); display: grid; place-items: center; font-size: 12px; font-weight: 600; flex-shrink: 0; }
.bubble { max-width: 75%; padding: 8px 12px; border-radius: 12px; background: var(--bg-elev); border: 1px solid var(--border); }
.msg.me .bubble { background: var(--blue-soft); }
.meta { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px; }
.meta b { font-size: 12px; color: var(--text); }
.meta span { font-size: 10px; color: var(--text-3); }
.content { font-size: 13px; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.stream-col { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; max-width: 75%; min-width: 0; }
.stream-col .bubble { max-width: 100%; }
.typing { display: inline-flex; align-items: center; gap: 4px; padding: 9px 13px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px; }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); animation: studio-typing 1.2s ease-in-out infinite; }
.typing i:nth-child(2) { animation-delay: .18s; }
.typing i:nth-child(3) { animation-delay: .36s; }
@keyframes studio-typing { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
.stream-cursor { display: inline-block; width: 2px; height: 1em; margin-left: 3px; vertical-align: -.15em; border-radius: 1px; background: var(--blue); animation: studio-cursor .85s steps(1) infinite; }
@keyframes studio-cursor { 50% { opacity: 0; } }
.composer { padding: 6px 10px calc(var(--safe-bottom) + 8px); background: var(--bg); border-top: 1px solid var(--border); }
.attachments { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 0 6px; }
.attachment { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; height: 28px; padding: 0 7px 0 9px; border: 1px solid var(--blue-border); border-radius: 10px; background: var(--blue-soft); color: var(--blue); font-size: 12px; }
.attachment > span { min-width: 0; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment button { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: inherit; }
.attachment button:active { background: color-mix(in srgb, var(--blue) 12%, transparent); }
.input-row { display: flex; align-items: center; gap: 6px; }
.at-btn, .file-btn { display: grid; place-items: center; width: 36px; height: 36px; border: 0; background: none; color: var(--text-3); flex-shrink: 0; }
.input-row input { flex: 1; min-width: 0; height: 36px; padding: 0 12px; border: 1px solid var(--border); border-radius: 18px; background: var(--fill); color: var(--text); font-size: 13px; }
.send-btn { display: grid; place-items: center; width: 36px; height: 36px; border: 0; border-radius: 50%; background: var(--blue); color: #fff; flex-shrink: 0; }
.send-btn:disabled { opacity: .4; }
.send-btn.stop { background:var(--text); }
.tool-card { margin:8px 40px 12px; padding:10px 12px; border:1px solid var(--border); border-radius:12px; background:var(--bg-elev); }
.tool-card.approval { border-color:var(--blue-border); background:var(--blue-soft); }
.tool-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.tool-head span { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:650; }
.tool-head em { font-size:10px; font-style:normal; color:var(--text-3); }
.tool-card p,.tool-card pre { margin-top:7px; font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
.tool-actions { display:flex; gap:6px; margin-top:9px; }
.tool-actions button { flex:1; min-height:32px; border-radius:8px; background:var(--bg); color:var(--text-2); font-size:11px; }
.tool-actions .primary { background:var(--blue); color:#fff; }
.at-picker { position: absolute; left: 0; right: 0; bottom: 56px; z-index: 50; background: var(--bg); border: 1px solid var(--border); border-radius: 12px 12px 0 0; padding: 8px; max-height: 200px; overflow-y: auto; }
.at-grip { width: 38px; height: 4px; margin: 4px auto 10px; border-radius: 2px; background: var(--border-strong); }
.at-item { display: block; width: 100%; text-align: left; padding: 10px 12px; border: 0; background: none; font-size: 13px; color: var(--text); border-radius: 6px; }
.at-item:active { background: var(--fill); }
</style>
