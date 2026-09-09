<script setup lang="ts">
/**
 * AI 工作室聊天页。
 * 视觉结构 = 群聊消息流 + 顶部半屏工具瀑布流（可展开收起，标注执行成员）：
 * - 成员回复先出现「三点动画 + 单行实时流」气泡，完成后落成正式 Markdown 气泡。
 * - 工具调用一律进顶部工具面板，不混入聊天流。
 * - 长按任意成员头像可直接 @ 该成员。
 */
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useStudioStore, type StudioMessage } from '@/stores/studio'
import StudioMemberStrip from '@/components/StudioMemberStrip.vue'
import StudioWorkBoard from '@/components/StudioWorkBoard.vue'
import Identicon from '@/components/Identicon.vue'
import { goBack } from '@/bridge/navigation'
import { renderMarkdown } from '@/utils/markdown'

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
const streamContentByMember = ref<Record<string, string>>({})
const streamNotices = ref<string[]>([])
const importedFiles = ref<string[]>([])
const hasNative = typeof window !== 'undefined' && !!window.CoomiAndroid

/** 顶部工具面板：默认收起，有待确认操作时强制展开。 */
const toolsOpen = ref(false)
const toolsTouched = ref(false)
const runningTools = computed(() => studio.toolCards.filter(card => card.status === 'running' || card.status === 'approval'))
const approvalPending = computed(() => studio.toolCards.some(card => card.status === 'approval'))
watch(approvalPending, (pending) => { if (pending) toolsOpen.value = true })
watch(() => studio.toolCards.length, () => {
  if (!toolsTouched.value && runningTools.value.length > 0) toolsOpen.value = true
  nextTick(() => { toolBox.value?.scrollTo({ top: toolBox.value.scrollHeight }) })
})
const toolBox = ref<HTMLElement | null>(null)

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
watch(streamContentByMember, () => { scrollToBottom() }, { deep: true })

function scrollToBottom() {
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  })
}

/** 消息 Markdown 渲染（与主会话同一管线：净化 + 代码复制装饰）。 */
const rendered = computed(() => {
  const map = new Map<string, string>()
  for (const msg of studio.messages) map.set(msg.id, renderMarkdown(msg.content))
  return map
})
function html(msg: StudioMessage): string {
  return rendered.value.get(msg.id) ?? ''
}
/** 代码块复制按钮的事件委托（v-html 内容不带 Vue 绑定）。 */
function onContentClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  const button = target?.closest('button[data-copy-code]') as HTMLElement | null
  if (!button) return
  const code = button.parentElement?.querySelector('pre')?.textContent ?? ''
  void navigator.clipboard?.writeText(code)
  button.textContent = '已复制'
  setTimeout(() => { button.textContent = '复制' }, 1200)
}

/** 流式实时流只取最新一行，单行省略展示。每个成员独立保留，避免切换成员时覆盖内容。 */
const activeMemberIds = computed(() => {
  const ids = Object.keys(streamContentByMember.value)
  // SSE 状态事件可能被旧版 WebView 丢弃；发送期间至少展示主持人的执行气泡。
  if (ids.length > 0) return ids
  if (sending.value && studio.host?.id) return [studio.host.id]
  return []
})
const memberActive = computed(() => activeMemberIds.value.length > 0)
const showPendingUser = computed(() => {
  const pending = pendingUser.value
  if (!pending) return false

  // The Rust endpoint persists the user's message before opening the stream.
  // Hide the optimistic bubble as soon as that durable copy is visible.
  const prompt = pending.content.split('\n📎 ')[0]
  return !studio.messages.some(message =>
    message.senderId === 'user' &&
    message.timestamp >= pending.timestamp &&
    message.content.startsWith(prompt),
  )
})
function streamTicker(memberId: string): string {
  const lines = (streamContentByMember.value[memberId] ?? '').split('\n').filter(line => line.trim())
  return lines[lines.length - 1] ?? ''
}
function streamingName(memberId: string): string {
  return studio.members.find(m => m.id === memberId)?.name || 'AI'
}

function insertAt(id: string) {
  const m = studio.members.find(x => x.id === id)
  if (m) insertAtByName(m.name)
  showAtPicker.value = false
}
function insertAtByName(name: string) {
  input.value = input.value ? input.value.replace(/\s+$/, '') + ` @${name} ` : `@${name} `
}

/** 长按头像 @ 成员。 */
let pressTimer: ReturnType<typeof setTimeout> | null = null
function onAvatarDown(name: string) {
  pressTimer = setTimeout(() => {
    pressTimer = null
    insertAtByName(name)
    if (navigator.vibrate) navigator.vibrate(10)
  }, 450)
}
function onAvatarUp() {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
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
  toolsTouched.value = false
  scrollToBottom()
  try {
    await studio.sendMessage(requestText, (event) => {
      if (event.event_type === 'studio_user_message') return
      if (event.event_type === 'studio_member_status') {
        const memberId = String(event.member_id ?? '')
        if (!memberId) return
        const status = String(event.status)
        studio.onMemberStatus(memberId, status as never)
        if (['thinking', 'executing'].includes(status)) {
          if (!(memberId in streamContentByMember.value)) streamContentByMember.value[memberId] = ''
        } else if (['done', 'failed'].includes(status)) {
          delete streamContentByMember.value[memberId]
        }
      } else if (event.event_type === 'studio_text_delta') {
        const memberId = String(event.member_id ?? '')
        if (!memberId) return
        streamContentByMember.value[memberId] = (streamContentByMember.value[memberId] ?? '') + String(event.content ?? '')
      } else if (event.event_type === 'studio_reasoning_delta') {
        const memberId = String(event.member_id ?? '')
        if (!memberId) return
        streamContentByMember.value[memberId] = (streamContentByMember.value[memberId] ?? '') + String(event.content ?? '')
      } else if (event.event_type === 'studio_stream_reset') {
        const memberId = String(event.member_id ?? '')
        if (memberId) streamContentByMember.value[memberId] = ''
      } else if (['studio_tool_start', 'studio_tool_done', 'studio_tool_approval'].includes(String(event.event_type))) {
        studio.onToolEvent(event)
      } else if (event.event_type === 'studio_error') {
        streamNotices.value.push(String(event.message ?? '成员执行出错'))
      } else if (event.event_type === 'studio_message') {
        const memberId = String(event.message?.senderId ?? '')
        if (memberId) delete streamContentByMember.value[memberId]
      }
    })
  } finally {
    pendingUser.value = null
    streamContentByMember.value = {}
    await studio.fetchMessages()
    sending.value = false
  }
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString()
}
</script>

<template>
  <div class="page">
    <PageHead :title="studio.currentStudio?.name ?? '工作室'" @back="goBack(router, '/studio')">
      <template #right>
        <button class="icon-btn" aria-label="工单看板" @click="showWorkBoard = true"><CoomiIcon name="todo" :size="18" /></button>
        <button class="icon-btn" aria-label="编辑" @click="router.push(`/studio/${studioId}/edit`)"><CoomiIcon name="pencil" :size="18" /></button>
      </template>
    </PageHead>

    <StudioMemberStrip />

    <!-- ── 顶部半屏工具瀑布流（可展开/收起） ── -->
    <div class="tool-panel">
      <button class="tool-head" @click="toolsOpen = !toolsOpen; toolsTouched = true">
        <CoomiIcon name="wrench" :size="14" />
        <span class="tool-title">工具调用</span>
        <span v-if="runningTools.length" class="tool-run">{{ runningTools.length }} 个执行中</span>
        <span v-else-if="studio.toolCards.length" class="tool-done">共 {{ studio.toolCards.length }} 次</span>
        <CoomiIcon name="chevronDown" :size="14" class="tool-chev" :class="{ open: toolsOpen }" />
      </button>
      <div v-show="toolsOpen" ref="toolBox" class="tool-body">
        <p v-if="!studio.toolCards.length" class="tool-empty">本轮尚无工具调用</p>
        <article v-for="tool in studio.toolCards" :key="tool.callId" class="tool-card" :class="tool.status">
          <div class="tool-head-row">
            <Identicon :seed="tool.memberId + tool.memberName" :size="20" />
            <span class="tool-who">{{ tool.memberName }}</span>
            <span class="tool-name">{{ tool.toolName }}</span>
            <em class="tool-state" :class="tool.status">
              {{ tool.status === 'approval' ? '等待确认' : tool.status === 'running' ? '执行中' : tool.status === 'success' ? '完成' : '失败' }}
            </em>
          </div>
          <p v-if="tool.riskSummary" class="tool-risk">{{ tool.riskSummary }}</p>
          <pre v-if="tool.resultPreview" class="tool-out">{{ tool.resultPreview }}</pre>
          <div v-if="tool.status === 'approval'" class="tool-actions">
            <button @click="studio.approveTool(tool.callId, 'deny')">拒绝</button>
            <button @click="studio.approveTool(tool.callId, 'allow')">允许一次</button>
            <button class="primary" @click="studio.approveTool(tool.callId, 'always')">始终允许</button>
          </div>
        </article>
      </div>
    </div>

    <main ref="scroller" class="stream">
      <div v-for="(note, index) in streamNotices" :key="'err-' + index" class="notice err">{{ note }}</div>
      <p v-if="studio.messages.length === 0 && !pendingUser && !memberActive" class="empty">开始对话吧，长按成员头像或输入 @成员 直接指派任务。</p>
      <div v-for="msg in studio.messages" :key="msg.id" class="msg" :class="{ me: msg.senderId === 'user' }">
        <div
          v-if="msg.senderId !== 'user'"
          class="avatar"
          @touchstart.prevent="onAvatarDown(msg.senderName)"
          @touchend="onAvatarUp"
          @touchcancel="onAvatarUp"
          @contextmenu.prevent
        >
          <Identicon :seed="msg.senderId + msg.senderName" :size="32" />
        </div>
        <div v-else class="avatar"><Identicon seed="user" :size="32" /></div>
        <div class="bubble">
          <div class="meta"><b>{{ msg.senderName }}</b><span>{{ fmtTime(msg.timestamp) }}</span></div>
          <!-- eslint-disable-next-line vue/no-v-html —— renderMarkdown 已净化 -->
          <div class="content md" v-html="html(msg)" @click="onContentClick" />
        </div>
      </div>
      <div v-if="showPendingUser" class="msg me pending-msg">
        <div class="avatar"><Identicon seed="user" :size="32" /></div>
        <div class="bubble">
          <div class="meta"><b>我</b><span>{{ fmtTime(pendingUser?.timestamp ?? 0) }}</span></div>
          <div class="content">{{ pendingUser?.content ?? '' }}</div>
        </div>
      </div>
      <!-- 成员执行中：三点动画 + 单行实时流气泡。每位成员一条稳定气泡。 -->
      <div v-for="memberId in activeMemberIds" :key="'streaming-' + memberId" class="msg streaming-msg">
        <div
          class="avatar"
          @touchstart.prevent="onAvatarDown(streamingName(memberId))"
          @touchend="onAvatarUp"
          @touchcancel="onAvatarUp"
          @contextmenu.prevent
        >
          <Identicon :seed="memberId || 'ai'" :size="32" />
        </div>
        <div class="stream-col">
          <div class="typing" aria-label="成员执行中"><i /><i /><i /></div>
          <div v-if="streamContentByMember[memberId]" class="bubble ticker-bubble">
            <div class="meta"><b>{{ streamingName(memberId) }}</b><span>正在回复</span></div>
            <div class="ticker">{{ streamTicker(memberId) }}<i class="stream-cursor" aria-hidden="true" /></div>
          </div>
        </div>
      </div>
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

/* ── 顶部工具面板（半屏、可展开收起） ── */
.tool-panel {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.tool-head {
  width: 100%; display: flex; align-items: center; gap: 7px;
  padding: 8px 12px; border: 0; background: none;
  color: var(--text-2); font-size: 12.5px; font-weight: 650; cursor: pointer;
}
.tool-title { color: var(--text-2); }
.tool-run { color: var(--orange); font-size: 11.5px; }
.tool-done { color: var(--text-3); font-size: 11.5px; }
.tool-chev { margin-left: auto; color: var(--text-3); transition: transform .18s; }
.tool-chev.open { transform: rotate(180deg); }
.tool-body {
  max-height: 46vh; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px;
  border-top: 1px solid var(--border);
}
.tool-empty { text-align: center; color: var(--text-3); font-size: 12px; padding: 12px 0; }
.tool-card { padding: 9px 11px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-elev); }
.tool-card.approval { border-color: var(--blue-border); background: var(--blue-soft); }
.tool-card.error { border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.tool-head-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
.tool-who { font-size: 11.5px; font-weight: 700; color: var(--text); flex-shrink: 0; }
.tool-name { font-size: 11.5px; color: var(--text-2); font-family: var(--font-mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-state { margin-left: auto; font-size: 10px; font-style: normal; color: var(--text-3); flex-shrink: 0; }
.tool-state.running { color: var(--orange); }
.tool-state.success { color: var(--ok); }
.tool-state.error { color: var(--danger); }
.tool-state.approval { color: var(--blue); }
.tool-risk { margin-top: 6px; font-size: 11px; color: var(--text-3); }
.tool-out { margin-top: 6px; max-height: 88px; overflow-y: auto; font-size: 10.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--text-2); background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px; }
.tool-actions { display: flex; gap: 6px; margin-top: 8px; }
.tool-actions button { flex: 1; min-height: 30px; border-radius: 8px; background: var(--bg); color: var(--text-2); font-size: 11px; }
.tool-actions .primary { background: var(--blue); color: #fff; }

/* ── 消息流 ── */
.stream { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; }
.empty { text-align: center; padding: 30px 16px; font-size: 13px; color: var(--text-3); }
.notice { margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; font-size: 12.5px; }
.notice.err { background: color-mix(in srgb, var(--orange) 16%, var(--bg)); color: var(--orange); }
.msg { display: flex; gap: 8px; margin-bottom: 12px; }
.msg.me { flex-direction: row-reverse; }
.avatar {
  width: 32px; height: 32px; border-radius: 50%; overflow: hidden; flex-shrink: 0; cursor: pointer;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.avatar :deep(svg) { width: 100%; height: 100%; }
.bubble { max-width: 78%; padding: 8px 12px; border-radius: 12px; background: var(--bg-elev); border: 1px solid var(--border); min-width: 0; }
.msg.me .bubble { background: var(--blue-soft); }
.meta { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px; }
.meta b { font-size: 12px; color: var(--text); }
.meta span { font-size: 10px; color: var(--text-3); }
.content { font-size: 13px; color: var(--text); overflow-wrap: break-word; min-width: 0; }
.content :deep(p) { margin: 0 0 6px; line-height: 1.65; }
.content :deep(p:last-child) { margin-bottom: 0; }
.content :deep(h1), .content :deep(h2), .content :deep(h3) { font-size: 13.5px; margin: 8px 0 5px; }
.content :deep(ul), .content :deep(ol) { margin: 4px 0 6px; padding-left: 18px; }
.content :deep(li) { margin: 2px 0; line-height: 1.6; }
.content :deep(code) { font-family: var(--font-mono); font-size: 11.5px; background: var(--fill); border-radius: 4px; padding: 1px 4px; }
.content :deep(pre) { margin: 6px 0; padding: 8px 10px; background: var(--code-bg, var(--fill)); border-radius: 8px; overflow-x: auto; font-size: 11px; line-height: 1.55; }
.content :deep(blockquote) { margin: 6px 0; padding: 2px 10px; border-left: 3px solid var(--border-strong, var(--border)); color: var(--text-2); }
.content :deep(table) { border-collapse: collapse; font-size: 11.5px; margin: 6px 0; }
.content :deep(th), .content :deep(td) { border: 1px solid var(--border); padding: 3px 7px; }
.content :deep(.code-wrap) { position: relative; }
.content :deep(.code-copy) { position: absolute; top: 5px; right: 5px; border: 0; border-radius: 6px; background: rgba(127, 137, 160, .2); color: inherit; font-size: 10px; padding: 2px 7px; cursor: pointer; }

/* ── 流式：三点动画 + 单行实时流 ── */
.stream-col { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; max-width: 78%; min-width: 0; }
.typing { display: inline-flex; align-items: center; gap: 4px; padding: 9px 13px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px; }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); animation: studio-typing 1.2s ease-in-out infinite; }
.typing i:nth-child(2) { animation-delay: .18s; }
.typing i:nth-child(3) { animation-delay: .36s; }
@keyframes studio-typing { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
.ticker-bubble { max-width: 100%; }
.ticker {
  display: block; font-size: 12.5px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.stream-cursor { display: inline-block; width: 2px; height: 1em; margin-left: 3px; vertical-align: -.15em; border-radius: 1px; background: var(--blue); animation: studio-cursor .85s steps(1) infinite; }
@keyframes studio-cursor { 50% { opacity: 0; } }

/* ── 输入区 ── */
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
.send-btn.stop { background: var(--text); }
.at-picker { position: absolute; left: 0; right: 0; bottom: 56px; z-index: 50; background: var(--bg); border: 1px solid var(--border); border-radius: 12px 12px 0 0; padding: 8px; max-height: 200px; overflow-y: auto; }
.at-grip { width: 38px; height: 4px; margin: 4px auto 10px; border-radius: 2px; background: var(--border-strong); }
.at-item { display: block; width: 100%; text-align: left; padding: 10px 12px; border: 0; background: none; font-size: 13px; color: var(--text); border-radius: 6px; }
.at-item:active { background: var(--fill); }
</style>
