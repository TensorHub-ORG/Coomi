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
      currentStudio.value = data.studio
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
      currentStudio.value = data.studio
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
      currentStudio.value = data.studio
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

  async function sendMessage(content: string, onEvent?: (event: Record<string, any>) => void) {
    if (!currentStudio.value) return null
    error.value = ''
    try {
      const response = await authedFetch(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ content }),
      })
      if (!response.ok || !response.body) throw new Error(`POST studio message → ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try { const event = JSON.parse(line.slice(5).trim()); onEvent?.(event); if (event.event_type === 'studio_message') onMessage(event.message) } catch { /* 忽略不完整事件 */ }
        }
      }
      await fetchMessages()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return null
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
    await apiSend(`/api/studios/${encodeURIComponent(currentStudio.value.id)}/stop`, 'POST')
  }

  function onWorkItem(item: WorkItem) {
    const idx = workItems.value.findIndex(w => w.id === item.id)
    if (idx >= 0) workItems.value[idx] = item
    else workItems.value.push(item)
  }

  function reset() {
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
