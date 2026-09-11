import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { apiGet, apiSend, authedFetch } from '@/bridge/http'

export type MemberStatus = 'idle' | 'thinking' | 'executing' | 'waiting' | 'done' | 'failed'
export type WorkItemStatus = 'pending' | 'in_progress' | 'review' | 'done' | 'failed'
export type ToolPermission = 'ask' | 'auto' | 'full'

export interface StudioMember {
  id: string
  name: string
  avatar?: string
  providerId: string
  model: string
  role: string
  systemPrompt?: string
  toolPermission: ToolPermission
  status: MemberStatus
  lastActive?: number
}

export interface WorkItem {
  id: string
  title: string
  description?: string
  assigneeId?: string
  status: WorkItemStatus
  dependsOn: string[]
  result?: string
  createdAt: number
  updatedAt: number
}

export interface StudioMessage {
  id: string
  senderId: string
  senderName: string
  content: string
  mentions: string[]
  workItemId?: string
  timestamp: number
  type: 'text' | 'system' | 'work_item'
}

export interface StudioToolCard {
  callId: string; memberId: string; memberName: string; toolName: string
  arguments?: unknown; status: 'running' | 'approval' | 'success' | 'error'
  resultPreview?: string; images?: string[]; riskSummary?: string
}

export interface Studio {
  id: string
  name: string
  description?: string
  sharedDir?: string
  hostId?: string
  members: StudioMember[]
  createdAt: number
  updatedAt: number
}

export interface StudioListItem {
  id: string
  name: string
  description?: string
  memberCount: number
  running: boolean
  lastActive?: number
}

function normalizeStudio(value: Studio): Studio {
  return {
    ...value,
    members: (value.members ?? []).map(member => ({
      ...member,
      // Rust's persisted enum uses running/completed; the chat UI uses the
      // more descriptive executing/done labels for the same states.
      status: ({ running: 'executing', completed: 'done' } as Record<string, MemberStatus>)[String(member.status)] ?? member.status,
    })),
  }
}

export const useStudioStore = defineStore('studio', () => {
  const studios = ref<StudioListItem[]>([])
  const currentStudio = ref<Studio | null>(null)
  const messages = ref<StudioMessage[]>([])
  const workItems = ref<WorkItem[]>([])
  const running = ref(false)
  const loading = ref(false)
  const error = ref('')
  const notice = ref('')
  const streamingMembers = ref<Record<string, string>>({})
  const toolCards = ref<StudioToolCard[]>([])
  // 并发发送（如剧场对谈中插话）：running 由计数维护，activeRequestAborts 跟踪
  // 全部活动流，停止时统一中止，避免第一个流结束时把 running 误置为 false。
  let runningCount = 0
  const activeRequestAborts = new Set<AbortController>()

  const members = computed(() => currentStudio.value?.members ?? [])
  const host = computed(() => members.value.find(m => m.id === currentStudio.value?.hostId) ?? members.value[0] ?? null)
  const pendingWorkItems = computed(() => workItems.value.filter(w => w.status === 'pending'))
  const inProgressWorkItems = computed(() => workItems.value.filter(w => w.status === 'in_progress'))
  const reviewWorkItems = computed(() => workItems.value.filter(w => w.status === 'review'))
  const doneWorkItems = computed(() => workItems.value.filter(w => w.status === 'done'))
  const failedWorkItems = computed(() => workItems.value.filter(w => w.status === 'failed'))

  async function fetchStudios() {
    loading.value = true
    error.value = ''
    try {
      const data = await apiGet<{ studios: StudioListItem[] }>('/api/studios')
      studios.value = data.studios ?? []
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  async function fetchStudio(id: string) {
    loading.value = true
    error.value = ''
    try {
      const data = await apiGet<{ studio: Studio; messages?: StudioMessage[]; workItems?: WorkItem[] }>(`/api/studios/${encodeURIComponent(id)}`)
      currentStudio.value = normalizeStudio(data.studio)
      messages.value = data.messages ?? []
      workItems.value = data.workItems ?? []
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  async function createStudio(input: Studio) {
    error.value = ''
    try {
      const data = await apiSend<{ studio: Studio }>('/api/studios', 'POST', input)
      currentStudio.value = normalizeStudio(data.studio)
      await fetchStudios()
      return data.studio
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  async function updateStudio(id: string, input: Partial<Studio>) {
    error.value = ''
    try {
      const data = await apiSend<{ studio: Studio }>(`/api/studios/${encodeURIComponent(id)}`, 'PUT', input)
      currentStudio.value = normalizeStudio(data.studio)
      await fetchStudios()
      return data.studio
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  async function deleteStudio(id: string) {
    error.value = ''
    try {
      await apiSend(`/api/studios/${encodeURIComponent(id)}`, 'DELETE')
      if (currentStudio.value?.id === id) currentStudio.value = null
      await fetchStudios()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function addMember(input: Omit<StudioMember, 'status'>) {
    if (!currentStudio.value) return null
    error.value = ''
    try {
      const data = await apiSend<StudioMember>(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/members`, 'POST', input)
      currentStudio.value.members.push(data)
      return data
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  async function updateMember(memberId: string, input: Partial<StudioMember>) {
    if (!currentStudio.value) return null
    error.value = ''
    try {
      const data = await apiSend<StudioMember>(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/members/${encodeURIComponent(memberId)}`, 'PUT', input)
      const idx = currentStudio.value.members.findIndex(m => m.id === memberId)
      if (idx >= 0) currentStudio.value.members[idx] = data
      return data
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  async function removeMember(memberId: string) {
    if (!currentStudio.value) return false
    error.value = ''
    try {
      await apiSend(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/members/${encodeURIComponent(memberId)}`, 'DELETE')
      currentStudio.value.members = currentStudio.value.members.filter(m => m.id !== memberId)
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function fetchWorkItems() {
    if (!currentStudio.value) return
    error.value = ''
    try {
      const data = await apiGet<{ workItems: WorkItem[] }>(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/work-items`)
      workItems.value = data.workItems ?? []
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function createWorkItem(input: Omit<WorkItem, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: WorkItemStatus }) {
    if (!currentStudio.value) return null
    error.value = ''
    try {
      const data = await apiSend<WorkItem>(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/work-items`, 'POST', input)
      workItems.value.push(data)
      return data
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  async function updateWorkItem(workItemId: string, input: Partial<WorkItem>) {
    if (!currentStudio.value) return null
    error.value = ''
    try {
      const data = await apiSend<WorkItem>(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/work-items/${encodeURIComponent(workItemId)}`, 'PUT', input)
      const idx = workItems.value.findIndex(w => w.id === workItemId)
      if (idx >= 0) workItems.value[idx] = data
      return data
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  async function fetchMessages() {
    if (!currentStudio.value) return
    error.value = ''
    try {
      const data = await apiGet<{ messages: StudioMessage[] }>(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/messages`)
      messages.value = data.messages ?? []
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /**
   * Merge server state without replacing the reactive array. Replacing it while
   * a response bubble is being rendered causes WebView Vue builds to lose the
   * current DOM node. Sorting also keeps messages from concurrent member runs
   * in their actual chat order.
   */
  function mergeServerMessages(items: StudioMessage[]) {
    for (const item of items) {
      const index = messages.value.findIndex(m => m.id === item.id)
      if (index >= 0) messages.value[index] = item
      else messages.value.push(item)
    }
    messages.value.sort((a, b) => a.timestamp - b.timestamp)
  }

  async function sendMessage(content: string, onEvent?: (event: Record<string, any>) => void) {
    if (!currentStudio.value) return null
    error.value = ''
    runningCount += 1
    running.value = true
    const studioIdNow = currentStudio.value.id
    let pollInFlight = false
    const pollMessages = async () => {
      if (pollInFlight) return
      pollInFlight = true
      try {
        const data = await apiGet<{ messages: StudioMessage[] }>(`/api/studios/${encodeURIComponent(studioIdNow)}/messages`)
        mergeServerMessages(data.messages ?? [])
      } catch { /* transient bridge failures are retried on the next tick */ }
      finally { pollInFlight = false }
    }
    // Start immediately, then keep the persisted transcript as a second channel
    // while SSE is open. This is deliberately independent of reader.read().
    void pollMessages()
    const pollTimer = setInterval(() => { void pollMessages() }, 1000)
    const dispatch = (event: Record<string, any>) => {
      onEvent?.(event)
      if (['studio_message', 'studio_user_message'].includes(String(event.event_type)) && event.message) {
        onMessage(event.message as StudioMessage)
      }
    }
    const requestAbort = new AbortController()
    activeRequestAborts.add(requestAbort)
    try {
      const response = await authedFetch(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ content }), signal: requestAbort.signal,
      })
      if (!response.ok || !response.body) throw new Error(`POST studio message → ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const consume = (flush = false) => {
        // SSE permits CRLF and multiple data lines per event. Normalizing the
        // block first avoids dropping events split across WebView read chunks.
        buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        const blocks = buffer.split('\n\n')
        if (!flush) buffer = blocks.pop() ?? ''
        else buffer = ''
        for (const block of blocks) {
          const data = block.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .join('\n')
            .trim()
          if (!data || data === '[DONE]') continue
          try {
            const event = JSON.parse(data) as Record<string, any>
            dispatch(event)
          } catch { /* malformed upstream event: keep the stream alive */ }
        }
      }
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        consume()
      }
      buffer += decoder.decode()
      consume(true)
      clearInterval(pollTimer)
      await pollMessages()
      await fetchMessages()
      return true
    } catch (e) {
      clearInterval(pollTimer)
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        error.value = e instanceof Error ? e.message : String(e)
      }
      return null
    } finally {
      activeRequestAborts.delete(requestAbort)
      runningCount -= 1
      running.value = runningCount > 0
    }
  }

  function onMemberStatus(memberId: string, status: MemberStatus) {
    const m = currentStudio.value?.members.find(x => x.id === memberId)
    if (m) { m.status = status; m.lastActive = Date.now() }
  }

  function onMessage(msg: StudioMessage) {
    const existing = messages.value.findIndex(m => m.id === msg.id)
    if (existing >= 0) messages.value[existing] = msg
    else messages.value.push(msg)
    messages.value.sort((a, b) => a.timestamp - b.timestamp)
  }

  function onTextDelta(memberId: string, delta: string) {
    streamingMembers.value[memberId] = (streamingMembers.value[memberId] ?? '') + delta
  }

  function clearStreaming(memberId: string) {
    delete streamingMembers.value[memberId]
  }

  function onToolEvent(event: Record<string, any>) {
    const id = String(event.call_id ?? '')
    let card = toolCards.value.find(item => item.callId === id)
    if (!card) {
      const member = members.value.find(item => item.id === String(event.member_id))
      card = { callId:id, memberId:String(event.member_id), memberName:String(event.member_name ?? member?.name ?? '成员'), toolName:String(event.tool_name ?? '工具'), arguments:event.arguments, status:'running' }
      toolCards.value.push(card)
    }
    if (event.event_type === 'studio_tool_approval') { card.status='approval'; card.riskSummary=String(event.risk_summary ?? '') }
    if (event.event_type === 'studio_tool_done') { card.status=event.is_error?'error':'success'; card.resultPreview=String(event.result_preview ?? ''); card.images=event.images ?? [] }
  }

  async function approveTool(callId: string, decision: 'allow' | 'deny' | 'always') {
    if (!currentStudio.value) return
    await apiSend(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/approve`, 'POST', { callId, decision })
    const card=toolCards.value.find(item=>item.callId===callId); if(card) card.status=decision==='deny'?'error':'running'
  }

  async function stopRun() {
    if (!currentStudio.value) return
    const id = currentStudio.value.id
    // Release every long-lived SSE connection first so the stop request is not
    // queued behind them by the WebView's per-host connection pool.
    for (const controller of [...activeRequestAborts]) controller.abort()
    try {
      await apiSend(`/api/studios/${encodeURIComponent(id)}/stop`, 'POST')
    } finally {
      // The server-side abort above still stops the member task if the request
      // reaches the engine after the reader has been closed.
      for (const controller of [...activeRequestAborts]) controller.abort()
    }
  }

  function onWorkItem(item: WorkItem) {
    const idx = workItems.value.findIndex(w => w.id === item.id)
    if (idx >= 0) workItems.value[idx] = item
    else workItems.value.push(item)
  }

  function reset() {
    for (const controller of [...activeRequestAborts]) controller.abort()
    activeRequestAborts.clear()
    runningCount = 0
    currentStudio.value = null
    messages.value = []
    workItems.value = []
    running.value = false
    error.value = ''
    notice.value = ''
    streamingMembers.value = {}
    toolCards.value = []
  }

  return {
    studios, currentStudio, messages, workItems, running, loading, error, notice, streamingMembers, toolCards,
    members, host, pendingWorkItems, inProgressWorkItems, reviewWorkItems, doneWorkItems, failedWorkItems,
    fetchStudios, fetchStudio, createStudio, updateStudio, deleteStudio,
    addMember, updateMember, removeMember,
    fetchWorkItems, createWorkItem, updateWorkItem,
    fetchMessages, sendMessage, stopRun, approveTool, onMemberStatus, onMessage, onTextDelta, clearStreaming, onToolEvent, onWorkItem, reset,
  }
})
