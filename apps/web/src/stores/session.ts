import { defineStore } from 'pinia'
import { ref, computed, shallowRef } from 'vue'
import { createTransport, type Transport } from '@/bridge'
import { authedFetch } from '@/bridge/http'
import { isDemoMode } from '@/bridge/demoMode'
import type { AgentEvent } from '@/protocol/events'
import type { InboundEnvelope } from '@/protocol/commands'
import { nextId } from '@/bridge/envelope'
import { useConnectionStore } from './connection'
import { useConfigStore } from './config'
import { useSessionsStore } from './sessions'
import type { AssistantMessage, LoopProgress, QuestionCard, ReasoningBlock, RunState, Timelineitem, ToolCard } from './viewModel'

export const useSessionStore = defineStore('session', () => {
  const connection = useConnectionStore()
  const config = useConfigStore()
  const sessions = useSessionsStore()

  const sessionId = ref(createSessionId())
  const timeline = ref<Timelineitem[]>([])
  const runState = ref<RunState>('idle')
  const usage = ref<{
    total: number; input: number; output: number; contextRatio: number
    contextUsed: number; contextWindow: number
  } | null>(null)
  /** 当前会话的工作目录（会话标记路径，绑定为会话执行目录）。 */
  const cwd = ref('')
  const loop = ref<LoopProgress>({ active: false, currentStep: 0, totalSteps: 0, status: '' })

  let currentAssistant: AssistantMessage | null = null
  let connectedSessionId = ''
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const transport = shallowRef<Transport | null>(null)

  const isBusy = computed(() => runState.value !== 'idle')
  const pendingApproval = computed(() => timeline.value.find((t): t is ToolCard => t.kind === 'tool' && t.status === 'awaiting_approval'))
  const pendingQuestion = computed(() => timeline.value.find((t): t is QuestionCard => t.kind === 'question' && !t.answered))

  /** 时间线写回 localStorage 有节流：流式期间不要每个 chunk 都序列化。 */
  function persistSoon() {
    if (isDemoMode()) return // 演示内容不该混进真实历史
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      const items = timeline.value.filter(t => t.kind !== 'notice')
      if (items.length === 0) return
      sessions.touch(sessionId.value, { turns: timeline.value.filter(t => t.kind === 'user').length })
      sessions.saveTranscript(sessionId.value, timeline.value)
    }, 1200)
  }

  function flushPersistence() {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (isDemoMode()) return
    const items = timeline.value.filter(t => t.kind !== 'notice')
    if (items.length === 0) return
    sessions.touch(sessionId.value, { turns: timeline.value.filter(t => t.kind === 'user').length })
    sessions.saveTranscript(sessionId.value, timeline.value)
  }

  /** 换 sessionId 后必须重连：WS 的路径里带着 session id。 */
  function connect(wsUrl?: string) {
    if (transport.value && connectedSessionId === sessionId.value) return
    const targetSessionId = sessionId.value
    const previous = transport.value
    transport.value = null
    connectedSessionId = ''
    previous?.close()
    if (wsUrl) connection.setWsUrl(wsUrl)
    const t = createTransport(targetSessionId, wsUrl)
    transport.value = t
    connectedSessionId = targetSessionId
    t.onStateChange(s => {
      if (transport.value !== t || sessionId.value !== targetSessionId) return
      connection.setState(s)
      if (s === 'open') {
        t.send({ command: 'set_permission_mode', mode: config.permissionMode })
        if (config.currentProviderId && config.currentModel) {
          t.send({ command: 'select_model', provider_id: config.currentProviderId, model: config.currentModel })
        }
      }
    })
    t.onMessage(env => {
      if (transport.value !== t || sessionId.value !== targetSessionId) return
      onInbound(env)
    })
    t.connect()
  }

  function disconnect() { transport.value?.close(); transport.value = null; connectedSessionId = '' }

  function onInbound(env: InboundEnvelope) {
    if (env.type === 'event') applyEvent(env.payload)
    else if (env.type === 'error') pushNotice('error', env.payload.message)
  }

  function applyEvent(ev: AgentEvent) {
    switch (ev.event_type) {
      // 兜底：turn_end 之后又开始吐字（引擎续了一轮），状态得跟着回到忙。
      case 'text_chunk': if (runState.value === 'idle') runState.value = 'thinking'; appendAssistant(ev.content); break
      case 'reasoning_chunk': if (runState.value === 'idle') runState.value = 'thinking'; appendReasoning(ev.content); break
      case 'tool_start':
        endAssistantStream()
        timeline.value.push({ kind: 'tool', callId: ev.call_id, toolName: ev.tool_name, arguments: ev.arguments, status: 'starting', expanded: ev.tool_name === 'show_image' })
        runState.value = 'executing'
        break
      case 'tool_running': patchTool(ev.call_id, c => c.status = 'running'); runState.value = 'executing'; break
      case 'tool_done':
        patchTool(ev.call_id, c => {
          c.status = ev.is_error ? 'error' : 'success'
          c.elapsed = ev.elapsed
          c.resultPreview = ev.result_preview
          c.isError = ev.is_error
          // 工具产生的图片：瀑布流渲染（历史恢复时由 messages.images 补回）
          if (Array.isArray(ev.images) && ev.images.length > 0) c.images = ev.images
        })
        // 工具跑完不等于一轮结束 —— 模型接着想下一步。回 idle 只认 turn_end /
        // 取消 / 致命错误，否则输入区会在循环中途闪回「下达任务」和发送箭头。
        runState.value = 'thinking'
        break
      case 'tool_cache_hit': patchTool(ev.call_id, c => c.status = 'cache_hit'); break
      case 'tool_approval_request':
        endAssistantStream()
        if (!patchTool(ev.call_id, c => { c.status = 'awaiting_approval'; c.access = ev.access; c.riskSummary = ev.risk_summary; c.expanded = true })) {
          timeline.value.push({ kind: 'tool', callId: ev.call_id, toolName: ev.tool_name, arguments: ev.arguments, status: 'awaiting_approval', access: ev.access, riskSummary: ev.risk_summary, expanded: true })
        }
        runState.value = 'awaiting_approval'
        break
      case 'user_question_request':
        endAssistantStream()
        timeline.value.push({ kind: 'question', callId: ev.call_id, question: ev.question, options: ev.options, allowFreeText: ev.allow_free_text ?? true, answered: false })
        runState.value = 'awaiting_question'
        break
      case 'file_transfer_request':
        if (ev.operation === 'import') {
          window.CoomiAndroid?.importFilesForRequest?.(ev.request_id)
        } else if (ev.path) {
          window.CoomiAndroid?.exportFileForRequest?.(
            ev.request_id,
            ev.path,
            ev.suggested_name ?? ev.path.split('/').pop() ?? 'coomi-export',
          )
        }
        break
      case 'usage_update': {
        const previous = usage.value
        usage.value = {
          total: ev.usage.total_tokens ?? previous?.total ?? 0,
          input: ev.usage.input_tokens ?? previous?.input ?? 0,
          output: ev.usage.output_tokens ?? previous?.output ?? 0,
          contextRatio: ev.usage.context_ratio ?? previous?.contextRatio ?? 0,
          contextUsed: ev.usage.context_used_tokens ?? previous?.contextUsed ?? 0,
          contextWindow: ev.usage.context_window_tokens ?? previous?.contextWindow ?? 0,
        }
        break
      }
      case 'compression': pushNotice('info', `上下文已压缩 ${fmtTokens(ev.before)} → ${fmtTokens(ev.after)}`); break
      case 'connection_retry': connection.setRetry(`${ev.message}（${ev.attempt}/${ev.max_attempts}）`); break
      case 'agent_error': endAssistantStream(); pushNotice(ev.is_fatal ? 'error' : 'warn', ev.message); if (ev.is_fatal) runState.value = 'idle'; persistSoon(); break
      case 'agent_cancelled': endAssistantStream(); cancelRunningTools(); pushNotice('warn', '已停止本轮执行'); break
      case 'bg_task_detached': pushNotice('info', `↪ 已转入后台任务 #${ev.task_id}（${ev.tool_name}）`); break
      case 'bg_task_completed': pushNotice(ev.is_error ? 'error' : 'success', `${ev.is_error ? '✕' : '✓'} 后台任务 #${ev.task_id} ${ev.is_error ? '失败' : '完成'}`); break
      case 'loop_progress':
        loop.value = { active: ev.status !== 'done', currentStep: ev.current_step, totalSteps: ev.total_steps, status: ev.status, currentDescription: loop.value.currentDescription }
        break
      case 'loop_step_start':
        loop.value = { ...loop.value, active: true, totalSteps: ev.total_steps, currentStep: ev.step_index, currentDescription: ev.step_description }
        break
      case 'turn_end': endAssistantStream(); cancelRunningTools(); connection.setRetry(null); runState.value = 'idle'; persistSoon(); break
      case 'session_state': {
        // 重连后引擎告知本会话是否仍在后台执行（切走会话后任务继续跑）。
        sessions.refreshRunning()
        if (ev.running && runState.value === 'idle') runState.value = 'thinking'
        break
      }
      case 'session_loaded': {
        // 打开历史会话时，引擎把持久化的累计用量推过来，避免显示 0。
        const u = ev.usage ?? {}
        usage.value = {
          total: u.total_tokens ?? usage.value?.total ?? 0,
          input: u.input_tokens ?? usage.value?.input ?? 0,
          output: u.output_tokens ?? usage.value?.output ?? 0,
          contextRatio: usage.value?.contextRatio ?? 0,
          contextUsed: usage.value?.contextUsed ?? 0,
          contextWindow: usage.value?.contextWindow ?? 0,
        }
        if (typeof ev.cwd === 'string' && ev.cwd) cwd.value = ev.cwd
        break
      }
    }
  }

  function cancelRunningTools() {
    // 停止后引擎可能不会逐个补发 tool_done：把仍在运行/准备中的工具卡片
    // 收尾为「已取消」，否则卡片会永远停在旋转的「运行中」状态。
    let changed = false
    for (const item of timeline.value) {
      if (item.kind === 'tool' && (item.status === 'running' || item.status === 'starting')) {
        item.status = 'cancelled'
        item.isError = true
        changed = true
      }
    }
    if (changed) persistSoon()
  }

  function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    // 首条用户消息作为会话标题，抽屉里就不会全是「新对话」。
    const isFirst = !timeline.value.some(t => t.kind === 'user')
    if (isFirst) sessions.touch(sessionId.value, { title: sessions.deriveTitle(trimmed) })
    if (isBusy.value) {
      timeline.value.push({ kind: 'user', id: nextId(), content: trimmed })
      transport.value?.send({ command: 'jump_in', text: trimmed })
      persistSoon()
      return
    }
    timeline.value.push({ kind: 'user', id: nextId(), content: trimmed })
    runState.value = 'thinking'
    transport.value?.send({ command: 'send_message', text: trimmed })
    persistSoon()
  }

  function cancel() { transport.value?.send({ command: 'cancel' }) }
  function approve(callId: string, decision: 'allow' | 'deny' | 'always') {
    patchTool(callId, c => { c.status = decision === 'deny' ? 'error' : 'running'; if (decision === 'deny') { c.resultPreview = '（用户拒绝执行）'; c.isError = true } })
    transport.value?.send({ command: 'approve_tool', call_id: callId, decision })
    if (runState.value === 'awaiting_approval') runState.value = 'executing'
  }
  function answerQuestion(callId: string, answer: string) {
    patchQuestion(callId, q => { q.answered = true; q.answer = answer })
    transport.value?.send({ command: 'answer_question', call_id: callId, answer })
    if (runState.value === 'awaiting_question') runState.value = 'thinking'
  }
  function setPermissionMode(mode: 'ask' | 'auto' | 'full') { config.setPermissionMode(mode); transport.value?.send({ command: 'set_permission_mode', mode }) }
  function togglePlanMode() { const entering = !config.planMode; config.togglePlanMode(); transport.value?.send({ command: entering ? 'enter_plan_mode' : 'exit_plan_mode' }) }
  function selectModel(providerId: string, model: string) { config.selectModel(providerId, model); transport.value?.send({ command: 'select_model', provider_id: providerId, model }) }
  function completeFileTransfer(requestId: string, paths: string[]) {
    transport.value?.send({ command: 'file_transfer_result', request_id: requestId, paths })
  }

  function newSession() {
    flushPersistence()
    endAssistantStream(); timeline.value = []; usage.value = null
    loop.value = { active: false, currentStep: 0, totalSteps: 0, status: '' }; runState.value = 'idle'
    sessionId.value = createSessionId()
    connect()
  }

  /** 从引擎 /api/sessions/{id} 恢复完整历史；成功返回 true。 */
  async function restoreFromEngine(id: string): Promise<boolean> {
    try {
      const res = await authedFetch(`/api/sessions/${id}`)
      if (!res.ok) return false
      const session = await res.json()
      const messages = (session.messages ?? []) as ChatMessageJson[]
      if (messages.length === 0) return false
      if (messages.some(m => m.compaction_summary)) {
        // 上下文已压缩：引擎只剩摘要 + 截断的部分历史。前端从未收到压缩版，
        // 本机 localStorage 缓存仍是完整时间线 —— 优先用它恢复展示，
        // 并把压缩摘要折叠成一条提示附在末尾。
        const cached = sessions.loadTranscript(id)
        if (cached && cached.length > 0) {
          const detail = messages.find(m => m.compaction_summary)?.content ?? ''
          timeline.value = [
            ...cached,
            { kind: 'notice', id: nextId(), tone: 'info', text: '（上下文已压缩 · 点击查看摘要）', detail },
          ]
          return true
        }
      }
      timeline.value = messagesToTimeline(messages)
      return true
    } catch {
      return false
    }
  }

  /** 把引擎磁盘会话消息转换为前端时间线（含工具调用卡片与结果回填）。 */
  function messagesToTimeline(messages: ChatMessageJson[]): Timelineitem[] {
    const items: Timelineitem[] = []
    const toolResults = new Map<string, string>()
    const toolImages = new Map<string, string[]>()
    for (const m of messages) {
      if (m.internal) continue
      if (m.compaction_summary) {
        items.push({ kind: 'notice', id: nextId(), tone: 'info', text: '（上下文已压缩 · 点击查看摘要）', detail: m.content ?? '' })
        continue
      }
      if (m.role === 'user') {
        items.push({ kind: 'user', id: nextId(), content: m.content })
      } else if (m.role === 'assistant') {
        if (m.content) items.push({ kind: 'assistant', id: nextId(), content: m.content, streaming: false })
        for (const tc of m.tool_calls ?? []) {
          items.push({
            kind: 'tool', callId: tc.id, toolName: tc.name,
            arguments: tc.arguments as Record<string, unknown>,
            status: 'success', expanded: tc.name === 'show_image',
            images: (tc.images ?? []).map((img: { media_type: string; data: string }) =>
              `data:${img.media_type};base64,${img.data}`),
          })
        }
      } else if (m.role === 'tool' && m.tool_call_id) {
        toolResults.set(m.tool_call_id, m.content)
        if (m.images?.length) {
          toolImages.set(m.tool_call_id, m.images.map((img: { media_type: string; data: string }) =>
            `data:${img.media_type};base64,${img.data}`))
        }
      }
    }
    for (const item of items) {
      if (item.kind === 'tool') {
        const result = toolResults.get(item.callId)
        if (result != null) {
          const preview = result.length > 200 ? result.slice(0, 200) + '…' : result
          item.resultPreview = preview
          item.isError = /error|fail|exception|panic/i.test(result.slice(0, 500))
        } else {
          // 没有结果回填（比如被取消/未执行）的调用收尾为已取消
          item.status = 'cancelled'
          item.isError = true
        }
        const imgs = toolImages.get(item.callId)
        if (imgs?.length) {
          item.images = imgs
        } else if (item.toolName === 'show_image' && item.expanded && item.status === 'success') {
          // show_image 历史恢复但图片数据不可用（如已被上下文压缩清理）
          item.imageMissing = true
        }
      }
    }
    return items
  }

  /**
   * 打开一条历史会话：优先从引擎磁盘拉完整历史（权威源，修复“会话消失/串话”），
   * 引擎不可用才回退本机 localStorage 记录。
   */
  async function openSession(id: string) {
    if (id === sessionId.value) return
    flushPersistence()
    endAssistantStream()
    usage.value = null
    loop.value = { active: false, currentStep: 0, totalSteps: 0, status: '' }
    runState.value = 'idle'
    const targetId = isUuid(id) ? id : sessions.migrateId(id, createSessionId())
    sessionId.value = targetId
    const restoredFromEngine = await restoreFromEngine(targetId)
    if (!restoredFromEngine) {
      const restored = sessions.loadTranscript(targetId)
      timeline.value = restored
      if (restored.length > 0) {
        timeline.value.push({
          kind: 'notice', id: nextId(), tone: 'info',
          text: '已恢复本机记录。若引擎重启过，模型这边的上下文可能已经清空。',
        })
      }
    }
    connect()
  }

  function deleteSession(id: string) {
    sessions.remove(id)
    try { localStorage.removeItem(`coomi.draft.${id}`) } catch { /* ignore */ }
    if (id === sessionId.value) newSession()
  }

  /** 更新当前会话的工作目录（会话标记路径）。成功后引擎后续 turn 都在该目录执行。 */
  async function setSessionCwd(path: string): Promise<boolean> {
    const id = sessionId.value
    try {
      const res = await authedFetch(`/api/sessions/${id}/cwd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: path }),
      })
      if (!res.ok) return false
      cwd.value = path
      const meta = sessions.find(id)
      if (meta) { meta.cwd = path; sessions.setCurrentCwd(path) }
      return true
    } catch {
      return false
    }
  }

  function appendAssistant(content: string) {
    if (!currentAssistant) {
      timeline.value.push({ kind: 'assistant', id: nextId(), content: '', streaming: true })
      // 必须拿 push 之后数组里的那个对象：ref 会把它包成代理，
      // 直接改 push 进去的原始对象不触发渲染，流式文本就只会停在第一片。
      currentAssistant = timeline.value[timeline.value.length - 1] as AssistantMessage
    }
    currentAssistant.content += content
  }
  function endAssistantStream() { if (currentAssistant) { currentAssistant.streaming = false; currentAssistant = null } }
  function appendReasoning(content: string) {
    const last = timeline.value[timeline.value.length - 1]
    if (last && last.kind === 'reasoning') { (last as ReasoningBlock).content += content }
    else { timeline.value.push({ kind: 'reasoning', id: nextId(), content, expanded: false }) }
  }
  function patchTool(callId: string, fn: (c: ToolCard) => void): boolean {
    for (let i = timeline.value.length - 1; i >= 0; i--) { const t = timeline.value[i]; if (t.kind === 'tool' && t.callId === callId) { fn(t); return true } }
    return false
  }
  function patchQuestion(callId: string, fn: (q: QuestionCard) => void) {
    for (let i = timeline.value.length - 1; i >= 0; i--) { const t = timeline.value[i]; if (t.kind === 'question' && t.callId === callId) { fn(t); return } }
  }
  function pushNotice(tone: 'info' | 'warn' | 'error' | 'success', text: string) { timeline.value.push({ kind: 'notice', id: nextId(), tone, text }) }

  return { sessionId, timeline, runState, usage, cwd, loop, isBusy, pendingApproval, pendingQuestion, connect, disconnect, sendMessage, cancel, approve, answerQuestion, setPermissionMode, togglePlanMode, selectModel, completeFileTransfer, newSession, openSession, deleteSession, setSessionCwd }
})

function fmtTokens(n: number): string { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n) }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/** 引擎磁盘上会话文件的原始消息结构（与 coomi-engine 的 ChatMessage 对应）。 */
interface ChatMessageJson {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    id: string
    name: string
    arguments: unknown
    images?: Array<{ media_type: string; data: string }>
  }>
  tool_call_id?: string
  compaction_summary?: boolean
  internal?: boolean
  images?: Array<{ media_type: string; data: string }>
}

function createSessionId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  cryptoApi.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
