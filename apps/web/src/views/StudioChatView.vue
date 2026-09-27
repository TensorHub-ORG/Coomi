<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useStudioStore, type StudioMessage } from '@/stores/studio'
import StudioMemberStrip from '@/components/StudioMemberStrip.vue'
import StudioWorkBoard from '@/components/StudioWorkBoard.vue'
import { goBack } from '@/bridge/navigation'

const route = useRoute(); const router = useRouter(); const studio = useStudioStore()
const studioId = computed(() => route.params.id as string)
const input = ref(''); const scroller = ref<HTMLElement | null>(null)
const showAtPicker = ref(false); const showWorkBoard = ref(false); const sending = ref(false)
const pendingUser = ref<StudioMessage | null>(null); const importedFiles = ref<string[]>([])
const activeMember = ref(''); const streams = reactive<Record<string, string>>({}); const reasoning = reactive<Record<string, string>>({})
const expandedReasoning = reactive<Record<string, boolean>>({}); const expandedTools = reactive<Record<string, boolean>>({})
const longPressTimer = ref<ReturnType<typeof setTimeout> | null>(null); const hasNative = typeof window !== 'undefined' && !!window.CoomiAndroid
const atTargets = computed(() => studio.members.map(m => ({ value: m.id, label: m.name })))
const activeMemberInfo = computed(() => studio.members.find(m => m.id === activeMember.value))

onMounted(async () => { await studio.fetchStudio(studioId.value); await studio.fetchMessages(); await studio.fetchWorkItems(); scrollToBottom(); window.addEventListener('coomi:files-imported', onFilesImported) })
onBeforeUnmount(() => { studio.reset(); window.removeEventListener('coomi:files-imported', onFilesImported); if (longPressTimer.value) clearTimeout(longPressTimer.value) })
watch(() => studio.messages.length, scrollToBottom); watch(streams, scrollToBottom, { deep: true }); watch(reasoning, scrollToBottom, { deep: true })
function scrollToBottom() { nextTick(() => { if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight }) }
function memberName(id: string) { return studio.members.find(m => m.id === id)?.name || '成员' }
function insertAt(id: string) { const m = studio.members.find(x => x.id === id); if (!m) return; input.value += `@${m.name} `; showAtPicker.value = false }
function startLongPress(id: string) { if (longPressTimer.value) clearTimeout(longPressTimer.value); longPressTimer.value = setTimeout(() => insertAt(id), 520) }
function endLongPress() { if (longPressTimer.value) { clearTimeout(longPressTimer.value); longPressTimer.value = null } }
function importFiles() { showAtPicker.value = false; window.CoomiAndroid?.importFiles?.() }
function onFilesImported(event: Event) { const paths = (event as CustomEvent<{ paths?: string[] }>).detail?.paths ?? []; if (paths.length) importedFiles.value = Array.from(new Set([...importedFiles.value, ...paths])) }
function removeImportedFile(path: string) { importedFiles.value = importedFiles.value.filter(item => item !== path) }
function clearStream(id: string) { delete streams[id]; delete reasoning[id] }
async function send() {
  const text = input.value.trim(); if ((!text && !importedFiles.value.length) || sending.value) return
  sending.value = true; const files = importedFiles.value.slice(); const fileNames = files.map(p => p.split('/').pop() || '文件')
  pendingUser.value = { id:`pending-${Date.now()}`, senderId:'user', senderName:'我', content:[text, ...fileNames.map(n => `📎 ${n}`)].filter(Boolean).join('\n'), mentions:[], timestamp:Date.now(), type:'text' }
  const requestText = [text, files.length ? `请读取这些已导入文件：\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n'); input.value=''; importedFiles.value=[]; scrollToBottom()
  try { await studio.sendMessage(requestText, event => {
    const type = String(event.event_type ?? ''), id = String(event.member_id ?? '')
    if (type === 'studio_member_status') { studio.onMemberStatus(id, event.status as any); if (['thinking','executing'].includes(String(event.status))) activeMember.value=id; else if (activeMember.value===id && ['done','failed'].includes(String(event.status))) activeMember.value='' }
    else if (type === 'studio_text_delta') { activeMember.value=id; streams[id]=(streams[id]||'')+String(event.content??'') }
    else if (type === 'studio_reasoning_delta') { activeMember.value=id; reasoning[id]=(reasoning[id]||'')+String(event.content??'') }
    else if (type === 'studio_stream_reset') clearStream(id)
    else if (['studio_tool_start','studio_tool_done','studio_tool_approval'].includes(type)) studio.onToolEvent(event)
    else if (type === 'studio_message') { clearStream(id); activeMember.value='' }
    else if (type === 'studio_error') studio.error=String(event.message??'工作室运行失败')
  }) } finally { pendingUser.value=null; Object.keys(streams).forEach(clearStream); activeMember.value=''; await studio.fetchMessages(); sending.value=false }
}
function fmtTime(ts: number) { return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) }
function statusText(status: string) { return ({ approval:'等待确认', running:'执行中', success:'已完成', error:'失败' } as Record<string,string>)[status] || '准备中' }
</script>

<template>
  <div class="page">
    <PageHead :title="studio.currentStudio?.name ?? '工作室'" @back="goBack(router, 'dashboard')">
      <template #right><button class="icon-btn" aria-label="工单看板" @click="showWorkBoard=true"><CoomiIcon name="todo" :size="18" /></button><button class="icon-btn" aria-label="编辑" @click="router.push(`/studio/${studioId}/edit`)"><CoomiIcon name="pencil" :size="18" /></button></template>
    </PageHead>
    <StudioMemberStrip @mention="insertAt" />
    <main ref="scroller" class="stream">
      <div class="intro" v-if="studio.messages.length===0 && !pendingUser && !Object.keys(streams).length"><div class="intro-mark"><CoomiIcon name="sparkle" :size="25" /></div><b>一起完成一件事</b><span>输入任务，或长按成员头像直接 @ 他。</span></div>
      <div v-if="studio.error" class="notice err"><CoomiIcon name="alert" :size="14" />{{ studio.error }}</div>
      <div v-for="msg in studio.messages" :key="msg.id" class="msg" :class="{ me:msg.senderId==='user' }">
        <button class="avatar" :class="{ clickable:msg.senderId!=='user' }" @pointerdown="msg.senderId!=='user' && startLongPress(msg.senderId)" @pointerup="endLongPress" @pointercancel="endLongPress" @pointerleave="endLongPress" @contextmenu.prevent="msg.senderId!=='user' && insertAt(msg.senderId)">{{ msg.senderName?.[0] || '我' }}</button>
        <div class="bubble"><div class="meta"><b>{{ msg.senderName }}</b><span>{{ fmtTime(msg.timestamp) }}</span></div><div class="content">{{ msg.content }}</div></div>
      </div>
      <div v-if="pendingUser" class="msg me"><div class="avatar">我</div><div class="bubble pending"><div class="meta"><b>我</b><span>发送中</span></div><div class="content">{{ pendingUser.content }}</div></div></div>
      <template v-for="m in studio.members" :key="`live-${m.id}`">
        <div v-if="reasoning[m.id] || streams[m.id]" class="msg live-msg">
          <button class="avatar live" @pointerdown="startLongPress(m.id)" @pointerup="endLongPress" @pointercancel="endLongPress" @pointerleave="endLongPress" @contextmenu.prevent="insertAt(m.id)">{{ m.name[0] }}</button>
          <div class="live-body"><div class="meta"><b>{{ m.name }}</b><span class="live-label"><i />{{ streams[m.id] ? '正在回复' : '正在思考' }}</span></div>
            <div v-if="reasoning[m.id]" class="reasoning"><button @click="expandedReasoning[m.id]=!expandedReasoning[m.id]"><CoomiIcon name="sparkle" :size="14" class="spark" :class="{ spinning:!expandedReasoning[m.id] }" /><span>{{ expandedReasoning[m.id] ? '思考过程' : (reasoning[m.id].split('\n').filter(Boolean).slice(-1)[0] || '正在思考…') }}</span><small v-if="expandedReasoning[m.id]">{{ reasoning[m.id].replace(/\s/g,'').length }} 字</small><CoomiIcon name="chevronRight" :size="13" :class="{ rotated:expandedReasoning[m.id] }" /></button><div v-if="expandedReasoning[m.id]" class="reasoning-detail">{{ reasoning[m.id] }}</div></div>
            <div v-if="streams[m.id]" class="content live-content">{{ streams[m.id] }}<i class="cursor" /></div>
          </div>
        </div>
      </template>
      <article v-for="tool in studio.toolCards" :key="tool.callId" class="tool-card" :class="tool.status">
        <button class="tool-head" @click="expandedTools[tool.callId]=!expandedTools[tool.callId]"><span class="tool-icon"><CoomiIcon :name="tool.status==='success'?'check':tool.status==='error'?'close':tool.status==='approval'?'shield':'wrench'" :size="16" /></span><span class="tool-title"><b>{{ tool.memberName }}</b><span>{{ tool.toolName }}</span></span><em>{{ statusText(tool.status) }}</em><CoomiIcon name="chevronRight" :size="13" :class="{ rotated:expandedTools[tool.callId] }" /></button>
        <div class="tool-progress" v-if="tool.status==='running'" />
        <div v-if="tool.status==='approval'" class="risk"><CoomiIcon name="alert" :size="14" />{{ tool.riskSummary || '需要授权后执行' }}</div>
        <div v-if="expandedTools[tool.callId]" class="tool-detail"><pre v-if="tool.arguments">{{ JSON.stringify(tool.arguments,null,2) }}</pre><pre v-if="tool.resultPreview">{{ tool.resultPreview }}</pre><div v-if="tool.status==='approval'" class="tool-actions"><button @click="studio.approveTool(tool.callId,'deny')">拒绝</button><button @click="studio.approveTool(tool.callId,'allow')">允许一次</button><button class="primary" @click="studio.approveTool(tool.callId,'always')">始终允许</button></div></div>
      </article>
    </main>
    <div class="composer"><div v-if="importedFiles.length" class="attachments"><span v-for="path in importedFiles" :key="path" class="attachment"><CoomiIcon name="fileRead" :size="14" /><span>{{ path.split('/').pop() }}</span><button aria-label="移除文件" @click="removeImportedFile(path)"><CoomiIcon name="close" :size="12" /></button></span></div><div class="input-row"><button class="round-tool" aria-label="提及成员" @click="showAtPicker=!showAtPicker"><CoomiIcon name="at" :size="18" /></button><button v-if="hasNative" class="round-tool" aria-label="导入文件" @click="importFiles"><CoomiIcon name="fileRead" :size="18" /></button><input v-model="input" placeholder="告诉工作室要做什么…" @keyup.enter="send" /><button v-if="sending" class="send-btn stop" aria-label="停止" @click="studio.stopRun()"><CoomiIcon name="stop" :size="15" /></button><button v-else class="send-btn" :disabled="!input.trim()&&!importedFiles.length" aria-label="发送" @click="send"><CoomiIcon name="arrowRight" :size="16" /></button></div></div>
    <div v-if="showAtPicker" class="at-picker"><div class="at-grip" /><p>选择成员，或长按头像快速 @</p><button v-for="t in atTargets" :key="t.value" class="at-item" @click="insertAt(t.value)"><span class="mini-avatar">{{ t.label[0] }}</span><span>{{ t.label }}</span><CoomiIcon name="chevronRight" :size="13" /></button></div>
    <StudioWorkBoard v-if="showWorkBoard" @close="showWorkBoard=false" />
  </div>
</template>

<style scoped>
.page{display:flex;flex-direction:column;height:100%;background:var(--page);position:relative}.icon-btn{display:grid;place-items:center;width:38px;height:38px;border:0;background:transparent;color:var(--text-2)}
.stream{flex:1;min-height:0;overflow-y:auto;padding:14px 14px 20px}.intro{display:flex;align-items:center;flex-direction:column;gap:7px;padding:42px 16px 30px;color:var(--text-3);text-align:center}.intro-mark{display:grid;place-items:center;width:54px;height:54px;margin-bottom:4px;border-radius:18px;background:var(--blue-soft);color:var(--blue)}.intro b{font-size:15px;color:var(--text)}.intro span{font-size:12px}.notice{display:flex;align-items:center;gap:7px;margin-bottom:12px;padding:10px 12px;border-radius:11px;background:var(--danger-soft);color:var(--danger);font-size:12px}
.msg{display:flex;gap:9px;margin-bottom:16px;align-items:flex-start}.msg.me{flex-direction:row-reverse}.avatar{display:grid;place-items:center;width:34px;height:34px;flex:none;padding:0;border:0;border-radius:12px;background:var(--blue-soft);color:var(--blue);font-size:12px;font-weight:700}.avatar.clickable{cursor:pointer;-webkit-touch-callout:none}.avatar.live{box-shadow:0 0 0 4px var(--blue-soft);animation:avatar-pulse 1.5s ease-in-out infinite}.bubble{max-width:78%;padding:10px 12px;border:1px solid var(--border);border-radius:6px 15px 15px 15px;background:var(--bg-elev);box-shadow:var(--shadow-1)}.msg.me .bubble{border-color:var(--blue-border);border-radius:15px 6px 15px 15px;background:var(--blue-soft)}.bubble.pending{opacity:.72}.meta{display:flex;align-items:baseline;gap:7px;margin-bottom:4px}.meta b{font-size:12px;color:var(--text)}.meta span{font-size:10px;color:var(--text-3)}.content{font-size:13px;line-height:1.65;color:var(--text);white-space:pre-wrap;word-break:break-word}.live-msg{margin-bottom:18px}.live-body{min-width:0;max-width:82%;flex:1}.live-label{display:inline-flex;align-items:center;gap:4px;color:var(--blue)}.live-label i{width:5px;height:5px;border-radius:50%;background:currentColor;animation:blink .9s infinite}.live-content{padding:2px 0}.cursor{display:inline-block;width:2px;height:1em;margin-left:3px;vertical-align:-.15em;background:var(--blue);animation:blink .8s steps(1) infinite}
.reasoning{margin:0 0 7px}.reasoning button{display:flex;align-items:center;gap:7px;width:100%;min-height:29px;padding:2px 0;border:0;background:none;text-align:left;color:var(--text-3);font-size:12px}.reasoning button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.reasoning button small{margin-left:auto;color:var(--text-3)}.spark{color:var(--blue);flex:none}.spark.spinning{animation:spin-soft 1.5s linear infinite}.rotated{transform:rotate(90deg)}.reasoning-detail{margin:3px 0 7px 6px;padding:8px 11px;border-left:2px solid var(--blue-border);border-radius:0 8px 8px 0;background:var(--fill);color:var(--text-2);font-size:12px;line-height:1.65;white-space:pre-wrap}
.tool-card{position:relative;margin:3px 0 15px 43px;overflow:hidden;border:1px solid var(--border);border-radius:13px;background:var(--bg-elev);box-shadow:var(--shadow-1)}.tool-card.approval{border-color:var(--orange-border);background:var(--orange-soft)}.tool-card.success{border-color:color-mix(in srgb,var(--ok) 35%,var(--border))}.tool-head{display:flex;align-items:center;gap:8px;width:100%;min-height:45px;padding:7px 10px;border:0;background:none;text-align:left;color:var(--text)}.tool-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:var(--fill);color:var(--blue)}.success .tool-icon{color:var(--ok);background:var(--ok-soft)}.approval .tool-icon{color:var(--orange);background:rgba(255,255,255,.35)}.tool-title{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}.tool-title b{font-size:11px}.tool-title span{font-size:12px;color:var(--text-2)}.tool-head em{font-size:10px;font-style:normal;color:var(--text-3)}.risk{display:flex;gap:6px;padding:0 11px 9px;color:var(--orange);font-size:11px}.tool-progress{height:2px;background:linear-gradient(90deg,transparent,var(--blue),transparent);animation:slide 1.15s infinite}.tool-detail{padding:0 10px 10px}.tool-detail pre{max-height:180px;margin:0 0 8px;overflow:auto;padding:9px;border-radius:8px;background:var(--code-bg);color:var(--code-text);font:11px/1.5 var(--font-mono);white-space:pre-wrap;word-break:break-word}.tool-actions{display:flex;gap:6px}.tool-actions button{flex:1;min-height:32px;border:0;border-radius:8px;background:var(--bg);color:var(--text-2);font-size:11px}.tool-actions .primary{background:var(--blue);color:#fff}
.composer{padding:8px 11px calc(var(--safe-bottom) + 10px);border-top:1px solid var(--border);background:var(--bg)}.attachments{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:7px}.attachment{display:flex;align-items:center;gap:5px;max-width:100%;height:29px;padding:0 7px 0 9px;border:1px solid var(--blue-border);border-radius:9px;background:var(--blue-soft);color:var(--blue);font-size:11px}.attachment span{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.attachment button{display:grid;place-items:center;width:20px;height:20px;border:0;background:none;color:inherit}.input-row{display:flex;align-items:center;gap:5px}.round-tool{display:grid;place-items:center;width:35px;height:35px;border:0;background:none;color:var(--text-3)}.input-row input{flex:1;min-width:0;height:38px;padding:0 13px;border:1px solid var(--border);border-radius:19px;background:var(--fill);color:var(--text);font-size:13px;outline:none}.input-row input:focus{border-color:var(--blue-border);box-shadow:0 0 0 3px var(--blue-soft)}.send-btn{display:grid;place-items:center;width:38px;height:38px;border:0;border-radius:50%;background:var(--blue);color:#fff}.send-btn:disabled{opacity:.4}.send-btn.stop{background:var(--text)}.at-picker{position:absolute;left:10px;right:10px;bottom:67px;z-index:60;padding:9px;border:1px solid var(--border);border-radius:16px;background:var(--bg);box-shadow:var(--shadow-2)}.at-grip{width:35px;height:4px;margin:1px auto 8px;border-radius:2px;background:var(--border-strong)}.at-picker p{margin:2px 8px 7px;color:var(--text-3);font-size:11px}.at-item{display:flex;align-items:center;gap:9px;width:100%;min-height:42px;padding:5px 8px;border:0;border-radius:9px;background:none;color:var(--text);text-align:left}.at-item:active{background:var(--fill)}.at-item>svg{margin-left:auto;color:var(--text-3)}.mini-avatar{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:var(--blue-soft);color:var(--blue);font-size:11px;font-weight:700}
@keyframes blink{50%{opacity:.2}}@keyframes spin-soft{to{transform:rotate(360deg)}}@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}@keyframes avatar-pulse{50%{box-shadow:0 0 0 7px transparent}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
</style>
