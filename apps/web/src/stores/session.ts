import { defineStore } from 'pinia'
import { ref, computed, shallowRef, watch } from 'vue'
import { createTransport, type Transport } from '@/bridge'
import { authedFetch, apiGet } from '@/bridge/http'
import { isDemoMode } from '@/bridge/demoMode'
import type { AgentEvent } from '@/protocol/events'
import type { ReasoningEffortStats } from '@/protocol/events'
import type { ReasoningEffort } from '@/protocol/commands'
import type { InboundEnvelope } from '@/protocol/commands'
import { nextId } from '@/bridge/envelope'
import { useConnectionStore } from './connection'
import { useConfigStore } from './config'
import { useSessionsStore } from './sessions'
import { isGlobalSession as isGlobalSessionId } from '@/bridge/life'
import { reportErrorToNative, sendFeedbackViaBridge } from '@/bridge/feedback'
import { router } from '@/router'
import type { AssistantMessage, LoopProgress, QuestionCard, ReasoningBlock, RunState, Timelineitem, ToolCard, ToolDiagnosticTrace } from './viewModel'

export const useSessionStore = defineStore('session', () => {
  const connection = useConnectionStore()
  const config = useConfigStore()
  const sessions = useSessionsStore()

  const sessionId = ref(readActiveSessionId())
  const mode = ref<'agent' | 'team' | 'life'>(sessions.find(sessionId.value)?.mode ?? 'agent')
  const timeline = ref<Timelineitem[]>(sessions.loadTranscript(sessionId.value))
  const runState = ref<RunState>('idle')
  const usage = ref<{
    total: number; input: number; output: number; contextRatio: number
    contextUsed: number; contextWindow: number
    cachedInput: number; cacheHitRate: number | null; cacheDataAvailable: boolean
    turnCacheHitRate: number | null; turnCacheDataAvailable: boolean
    reasoningEfforts: Partial<Record<ReasoningEffort, ReasoningEffortStats>>
    contextCategories: Partial<Record<'system_tools' | 'messages' | 'skills' | 'mcp_tools' | 'system_prompt' | 'other', number>>
    firstTokenLatencyMs: number | null
    outputTokensPerSecond: number | null
    turnTotalTokens: number | null
  } | null>(null)
  const retryConfirmation = ref<string | null>(null)
  /** 当前会话的工作目录（会话标记路径，绑定为会话执行目录）。 */
  const cwd = ref('')
  const loop = ref<LoopProgress>({ active: false, currentStep: 0, totalSteps: 0, status: '' })
  const collaboration = ref({ active: false, phase: '', cycle: 0, cycles: 0, status: '', review: '' })
  /** 生命体待投递问候（队列唯一 pending → 气泡/开场问候的数据源）。 */
  const lifeUnread = ref<LifeUnreadItem[]>([])
  const lifeUnreadName = ref('')
  const lifeDelivering = ref(false)
  /** 本次打开会话是否已做过开场问候（避免轮询重复触发投递）。 */
  let lifeAutoSent = false
  /** 编辑覆盖状态：非空表示输入框正处于「编辑上一条消息」模式。 */
  const pendingEdit = ref<{ mid: string; content: string } | null>(null)
  /** 回撤确认弹窗状态：非空表示等待用户确认回撤该轮。 */
  const undoConfirm = ref<{ mid: string } | null>(null)

  let currentAssistant: AssistantMessage | null = null
  let connectedSessionId = ''
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let turnToolTrace: ToolDiagnosticTrace[] = []
  let consecutiveToolFailures = 0
  let maxConsecutiveToolFailures = 0
  /** 回合级异常信号：任一工具失败 / agent_error / 输出流停滞都会置位，turn_end 汇总成一张反馈卡。 */
  let turnHadError = false
  let lastTurnErrorDetail = ''
  /** 停滞检测：回合运行中超过 STALL_TIMEOUT_MS 无任何 WS 事件视为疑似停滞。 */
  let stallWatchTimer: ReturnType<typeof setInterval> | null = null
  let stallDetected = false
  let lastEventAt = Date.now()
  const STALL_TIMEOUT_MS = 90_000
  const transport = shallowRef<Transport | null>(null)

  function armStallWatch() {
    disarmStallWatch()
    lastEventAt = Date.now()
    stallWatchTimer = setInterval(() => {
      if (runState.value === 'idle') { disarmStallWatch(); return }
      if (Date.now() - lastEventAt < STALL_TIMEOUT_MS) return
      if (!stallDetected) {
        stallDetected = true
        pushNotice('warn', `输出流已停滞 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒，本轮结束后可一键反馈`)
      }
      disarmStallWatch()
    }, 15_000)
  }
  function disarmStallWatch() {
    if (stallWatchTimer) { clearInterval(stallWatchTimer); stallWatchTimer = null }
  }

  const isBusy = computed(() => runState.value !== 'idle')
  const pendingApproval = computed(() => timeline.value.find((t): t is ToolCard => t.kind === 'tool' && t.status === 'awaiting_approval'))
  const pendingQuestion = computed(() => timeline.value.find((t): t is QuestionCard => t.kind === 'question' && !t.answered))
  /** 时间线里最新的用户消息（仅它可「编辑重发」）。 */
  const lastUserMessage = computed(() => {
    for (let i = timeline.value.length - 1; i >= 0; i--) {
      if (timeline.value[i].kind === 'user') return timeline.value[i]
    }
    return null
  })
  /** 时间线里最新的助手消息（仅它可「回撤」）。 */
  const lastAssistantMessage = computed(() => {
    for (let i = timeline.value.length - 1; i >= 0; i--) {
      if (timeline.value[i].kind === 'assistant') return timeline.value[i]
    }
    return null
  })

  persistActiveSessionId(sessionId.value)
  if (typeof window !== 'undefined') {
    ;(window as Window & { __coomiActiveSessionId?: string }).__coomiActiveSessionId = sessionId.value
  }

  // Native task status is derived from /api/tasks in the sessions store. A
  // foreground idle session must not overwrite another session's running state.

  /** 发送内置引导（EmptyState 引导卡）：先置用户标题消息，再让引擎流式推正文。 */
  const GUIDE_TITLES: Record<string, string> = {
    newbie: 'Coomi 新手使用指南',
    extension: '自定义拓展进化指南',
  }
  function sendGuide(key: string) {
    const trimmed = (GUIDE_TITLES[key] ?? 'Coomi 指南').trim()
    // 首条用户消息作为会话标题，抽屉里就不会全是「新对话」。
    const isFirst = !timeline.value.some(t => t.kind === 'user')
    if (isFirst && !isGlobalSessionId(sessionId.value)) sessions.touch(sessionId.value, { title: sessions.deriveTitle(trimmed) })
    timeline.value.push({ kind: 'user', id: nextId(), mid: '', content: trimmed })
    runState.value = 'thinking'
    armStallWatch()
    transport.value?.send({ command: 'send_guide', key })
    persistSoon()
  }

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
    let lastEventSeq = 0
    t.onStateChange(status => {
      if (transport.value !== t || sessionId.value !== targetSessionId) return
      connection.setStatus(status)
      if (status.state === 'open') {
        t.send({ command: 'set_permission_mode', mode: config.permissionMode })
        t.send({ command: 'set_session_mode', mode: mode.value })
        const meta = sessions.find(targetSessionId)
        const providerId = meta?.providerId || config.currentProviderId
        const model = meta?.model || config.currentModel
        if (providerId && model) {
          t.send({ command: 'select_model', provider_id: providerId, model })
        }
        t.send({ command: 'set_reasoning_effort', effort: config.reasoningEffort })
        t.send({ command: 'set_max_tool_rounds', rounds: config.maxToolRounds })
      }
    })
    t.onMessage(env => {
      if (transport.value !== t || sessionId.value !== targetSessionId) return
      if (env.type === 'event' && env.payload.event_seq) {
        const seq = env.payload.event_seq
        if (seq <= lastEventSeq) {
          t.send({ command: 'ack_event', event_seq: seq })
          return
        }
        lastEventSeq = seq
        onInbound(env)
        t.send({ command: 'ack_event', event_seq: seq })
        return
      }
      onInbound(env)
    })
    t.connect()
  }

  function disconnect() { transport.value?.close(); transport.value = null; connectedSessionId = '' }

  /** Recreate the active socket so newly saved retry settings take effect immediately. */
  function reconnect() {
    const previous = transport.value
    transport.value = null
    connectedSessionId = ''
    previous?.close()
    connect(connection.wsUrl || undefined)
  }

  function onInbound(env: InboundEnvelope) {
    if (env.type === 'event') applyEvent(env.payload)
    else if (env.type === 'error') pushNotice('error', env.payload.message)
  }

  function applyEvent(ev: AgentEvent) {
    lastEventAt = Date.now()
    switch (ev.event_type) {
      // 兜底：turn_end 之后又开始吐字（引擎续了一轮），状态得跟着回到忙。
      case 'text_chunk': connection.setRetry(null); if (runState.value === 'idle') runState.value = 'thinking'; appendAssistant(ev.content); break
      case 'reasoning_chunk': if (runState.value === 'idle') runState.value = 'thinking'; appendReasoning(ev.content); break
      case 'tool_start':
        connection.setRetry(null)
        endAssistantStream()
        timeline.value.push({ kind: 'tool', callId: ev.call_id, toolName: ev.tool_name, arguments: ev.arguments, status: 'starting', expanded: ev.tool_name === 'show_image' })
        turnToolTrace.push({
          callId: ev.call_id,
          sequence: turnToolTrace.length + 1,
          tool: sanitizeToolName(ev.tool_name),
          argumentShape: summarizeArguments(ev.arguments),
          status: 'running',
        })
        runState.value = 'executing'
        break
      case 'tool_running': patchTool(ev.call_id, c => c.status = 'running'); runState.value = 'executing'; break
      case 'tool_output':
        // Agent 执行实时流（批次三 #31）：shell/local_shell 增量输出追加到卡片。
        patchTool(ev.call_id, c => {
          if (c.expanded === undefined) c.expanded = true
          // 上限 24KB：超长丢头部，保尾部（最新输出最有信息量）。
          const merged = (c.liveOutput ?? '') + ev.chunk
          c.liveOutput = merged.length > 24_000 ? '…（前段已截断）\n' + merged.slice(-24_000) : merged
        })
        runState.value = 'executing'
        break
      case 'tool_done':
        patchTool(ev.call_id, c => {
          c.status = ev.is_error ? 'error' : 'success'
          c.elapsed = ev.elapsed
          c.resultPreview = ev.result_preview
          c.isError = ev.is_error
          c.liveOutput = undefined
          // 工具产生的图片：瀑布流渲染（历史恢复时由 messages.images 补回）
          if (Array.isArray(ev.images) && ev.images.length > 0) c.images = ev.images
        })
        // 工具跑完不等于一轮结束 —— 模型接着想下一步。回 idle 只认 turn_end /
        // 取消 / 致命错误，否则输入区会在循环中途闪回「下达任务」和发送箭头。
        runState.value = 'thinking'
        {
          const trace = turnToolTrace.find(item => item.callId === ev.call_id)
          if (trace) {
            trace.status = ev.is_error ? 'error' : 'success'
            trace.elapsedMs = Math.max(0, Math.round(ev.elapsed * 1000))
            if (ev.is_error) {
              consecutiveToolFailures += 1
              maxConsecutiveToolFailures = Math.max(maxConsecutiveToolFailures, consecutiveToolFailures)
              trace.category = classifyToolError(ev.result_preview)
              trace.errorSummary = sanitizeDiagnosticText(ev.result_preview)
              turnHadError = true
              lastTurnErrorDetail = trace.errorSummary
            } else consecutiveToolFailures = 0
          }
        }
        break
      case 'tool_cache_hit':
        patchTool(ev.call_id, c => c.status = 'cache_hit')
        {
          const trace = turnToolTrace.find(item => item.callId === ev.call_id)
          if (trace) trace.status = 'success'
          consecutiveToolFailures = 0
        }
        break
      case 'tool_approval_request':
        endAssistantStream()
        if (!patchTool(ev.call_id, c => { c.status = 'awaiting_approval'; c.access = ev.access; c.riskSummary = ev.risk_summary; c.expanded = true })) {
          timeline.value.push({ kind: 'tool', callId: ev.call_id, toolName: ev.tool_name, arguments: ev.arguments, status: 'awaiting_approval', access: ev.access, riskSummary: ev.risk_summary, expanded: true })
        }
        runState.value = 'awaiting_approval'
        break
      case 'user_question_request':
        endAssistantStream()
        timeline.value.push({ kind: 'question', callId: ev.call_id, questions: ev.questions, answered: false })
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
          cachedInput: ev.usage.cached_input_tokens ?? previous?.cachedInput ?? 0,
          cacheHitRate: ev.usage.cache_hit_rate ?? previous?.cacheHitRate ?? null,
          cacheDataAvailable: ev.usage.cache_data_available ?? previous?.cacheDataAvailable ?? false,
          turnCacheHitRate: ev.usage.turn_cache_hit_rate ?? previous?.turnCacheHitRate ?? null,
          turnCacheDataAvailable: ev.usage.turn_cache_data_available ?? previous?.turnCacheDataAvailable ?? false,
          reasoningEfforts: ev.reasoning_efforts ?? previous?.reasoningEfforts ?? {},
          contextCategories: ev.context_categories ?? previous?.contextCategories ?? {},
          // `null` is an intentional reset at the start of a new turn. Only
          // retain the previous value when an older engine omitted the field.
          firstTokenLatencyMs: ev.usage.first_token_latency_ms === undefined
            ? previous?.firstTokenLatencyMs ?? null
            : ev.usage.first_token_latency_ms,
          outputTokensPerSecond: ev.usage.output_tokens_per_second === undefined
            ? previous?.outputTokensPerSecond ?? null
            : ev.usage.output_tokens_per_second,
          turnTotalTokens: ev.usage.turn_total_tokens === undefined
            ? previous?.turnTotalTokens ?? null
            : ev.usage.turn_total_tokens,
        }
        break
      }
      case 'compression': pushNotice('info', `上下文已压缩 ${fmtTokens(ev.before)} → ${fmtTokens(ev.after)}`); break
      case 'connection_retry':
        connection.setRetry(`${ev.message}（${ev.attempt}/${ev.max_attempts}）`)
        // 重试到上限仍连不上且用户可交互：交给原生弹「一键反馈」。
        if (ev.attempt >= ev.max_attempts && !isBusy.value) {
          reportErrorToNative('runtime_error', '网络连接失败', `${ev.message}（已重试 ${ev.attempt} 次）`)
        }
        break
      case 'stream_reset':
        endAssistantStream()
        while (timeline.value.length > 0) {
          const last = timeline.value[timeline.value.length - 1]
          if (last.kind === 'assistant' || last.kind === 'reasoning') timeline.value.pop()
          else break
        }
        break
      case 'retry_confirmation':
        endAssistantStream()
        runState.value = 'idle'
        retryConfirmation.value = ev.message
        disarmStallWatch()
        break
      case 'agent_error':
        endAssistantStream(); pushNotice('error', ev.message)
        turnHadError = true
        lastTurnErrorDetail = sanitizeDiagnosticText(ev.message)
        disarmStallWatch()
        if (ev.is_fatal) {
          runState.value = 'idle'
          pushFeedbackCard('runtime_error', `本轮执行异常终止：${ev.message.slice(0, 80)}`, lastTurnErrorDetail, false)
          resetTurnFeedbackSignals()
        }
        persistSoon(); break
      case 'configuration_required': endAssistantStream(); runState.value = 'idle'; pushNotice('warn', ev.message); void router.push(ev.route); break
      case 'agent_cancelled': endAssistantStream(); cancelRunningTools(); pushNotice('warn', '已停止本轮执行'); disarmStallWatch(); break
      case 'bg_task_detached': pushNotice('info', `↪ 已转入后台任务 #${ev.task_id}（${ev.tool_name}）`); break
      case 'bg_task_completed': pushNotice(ev.is_error ? 'error' : 'success', `${ev.is_error ? '✕' : '✓'} 后台任务 #${ev.task_id} ${ev.is_error ? '失败' : '完成'}`); break
      case 'loop_progress':
        loop.value = { active: ev.status !== 'done', currentStep: ev.current_step, totalSteps: ev.total_steps, status: ev.status, currentDescription: loop.value.currentDescription }
        break
      case 'loop_step_start':
        loop.value = { ...loop.value, active: true, totalSteps: ev.total_steps, currentStep: ev.step_index, currentDescription: ev.step_description }
        break
      case 'life_delivered': {
        // 气泡投递完成：把最后一条 assistant 标记为生命体气泡并复位投递态。
        lifeDelivering.value = false
        const last = timeline.value[timeline.value.length - 1]
        if (last?.kind === 'assistant') last.life = true
        void refreshLifeUnread()
        break
      }
      case 'collaboration_started':
        collaboration.value = { active: true, phase: '', cycle: 0, cycles: ev.cycles, status: 'started', review: '' }
        break
      case 'collaboration_phase':
        collaboration.value = { ...collaboration.value, active: true, phase: ev.phase, cycle: ev.cycle, status: ev.status }
        break
      case 'collaboration_review':
        collaboration.value = { ...collaboration.value, active: true, phase: 'reviewer', cycle: ev.cycle, status: ev.status, review: ev.content }
        break
      case 'collaboration_finished':
        collaboration.value = { ...collaboration.value, active: false, phase: 'reviewer', cycle: ev.cycle ?? collaboration.value.cycle, status: ev.status ?? collaboration.value.status, review: ev.summary ?? collaboration.value.review }
        break
      case 'turn_end':
        endAssistantStream(); cancelRunningTools(); connection.setRetry(null); runState.value = 'idle'
        disarmStallWatch()
        // 收尾清理：去掉空白思考块（部分供应商会发空的 reasoning 分片）。
        timeline.value = timeline.value.filter(item => !(item.kind === 'reasoning' && !item.content.trim()))
        // 批次五 #7：任务结束后执行过程自动折叠——收起全部已展开的工具卡，
        // 最终总结（最后一条助手消息）保持醒目；用户手动点开的（manual）不受影响。
        timeline.value.forEach(item => {
          if (item.kind === 'tool' && item.status !== 'awaiting_approval') item.expanded = false
        })
        {
          // 回合末统一反馈卡：本轮有任何异常（工具失败/agent_error/输出停滞）
          // 就在瀑布流末尾放一张卡片，用户一键授权即自动采集上传。
          const failures = turnToolTrace.filter(item => item.status === 'error').length
          if (turnHadError || stallDetected) {
            const parts: string[] = []
            if (failures > 0) parts.push(`${failures} 次工具调用失败`)
            if (stallDetected) parts.push('输出流一度停滞')
            const summary = `本轮出现${parts.join('、')}，遇到问题了吗？`
            pushFeedbackCard(
              failures > 0 ? 'tool_failure' : 'performance',
              summary,
              lastTurnErrorDetail,
              failures > 0,
            )
          }
        }
        resetTurnFeedbackSignals()
        persistSoon()
        break
      case 'session_state': {
        // 重连后引擎告知本会话是否仍在后台执行（切走会话后任务继续跑）。
        sessions.refreshRunning()
        runState.value = ev.running ? 'thinking' : 'idle'
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
          cachedInput: usage.value?.cachedInput ?? 0,
          cacheHitRate: usage.value?.cacheHitRate ?? null,
          cacheDataAvailable: usage.value?.cacheDataAvailable ?? false,
          turnCacheHitRate: usage.value?.turnCacheHitRate ?? null,
          turnCacheDataAvailable: usage.value?.turnCacheDataAvailable ?? false,
          reasoningEfforts: usage.value?.reasoningEfforts ?? {},
          contextCategories: usage.value?.contextCategories ?? {},
          firstTokenLatencyMs: usage.value?.firstTokenLatencyMs ?? null,
          outputTokensPerSecond: usage.value?.outputTokensPerSecond ?? null,
          turnTotalTokens: usage.value?.turnTotalTokens ?? null,
        }
        if (typeof ev.cwd === 'string' && ev.cwd) cwd.value = ev.cwd
        break
      }
    }
  }

  function activateSession(id: string) {
    sessionId.value = id
    if (typeof window !== 'undefined') {
      ;(window as Window & { __coomiActiveSessionId?: string }).__coomiActiveSessionId = id
    }
    mode.value = resolveLifeMode(id)
    collaboration.value = { active: false, phase: '', cycle: 0, cycles: 0, status: '', review: '' }
    persistActiveSessionId(id)
    lifeAutoSent = false
  }

  /**
   * 会话模式决议：生命体人格只属于「常驻会话」；「用于全局会话」开关开启后所有会话都带人格。
   * 历史会话即使曾被切成 life，关闭全局开关后也强制回到 agent（人格只活在它该在的地方）。
   */
  function resolveLifeMode(id: string): 'agent' | 'team' | 'life' {
    if (config.digitalLifeEnabled && (isGlobalSessionId(id) || config.lifeGlobalMode)) return 'life'
    return sessions.find(id)?.mode === 'team' ? 'team' : 'agent'
  }

  const isGlobalSession = computed(() => isGlobalSessionId(sessionId.value))

  function retryInterruptedTurn() {
    retryConfirmation.value = null
    runState.value = 'thinking'
    armStallWatch()
    transport.value?.send({ command: 'retry_turn' })
  }

  function dismissRetry() { retryConfirmation.value = null }

  function setReasoningEffort(effort: ReasoningEffort) {
    config.setReasoningEffort(effort)
    transport.value?.send({ command: 'set_reasoning_effort', effort })
  }

  function setMaxToolRounds(rounds: number) {
    config.setMaxToolRounds(rounds)
    transport.value?.send({ command: 'set_max_tool_rounds', rounds: config.maxToolRounds })
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
    // 编辑覆盖模式：截断目标轮次（与引擎 edit_turn 行为一致），以新文本重新执行。
    const edit = pendingEdit.value
    if (edit) {
      pendingEdit.value = null
      let cutAt = -1
      if (edit.mid) cutAt = timeline.value.findIndex(t => t.kind === 'user' && t.mid === edit.mid)
      if (cutAt < 0) {
        for (let i = timeline.value.length - 1; i >= 0; i--) {
          if (timeline.value[i].kind === 'user') { cutAt = i; break }
        }
      }
      if (cutAt >= 0) timeline.value.splice(cutAt)
      timeline.value.push({ kind: 'user', id: nextId(), mid: '', content: trimmed })
      runState.value = 'thinking'
      armStallWatch()
      transport.value?.send({ command: 'edit_turn', msg_id: edit.mid, text: trimmed })
      persistSoon()
      return
    }
    // 首条用户消息作为会话标题，抽屉里就不会全是「新对话」。
    const isFirst = !timeline.value.some(t => t.kind === 'user')
    if (isFirst && !isGlobalSessionId(sessionId.value)) sessions.touch(sessionId.value, { title: sessions.deriveTitle(trimmed) })
    if (isBusy.value) {
      timeline.value.push({ kind: 'user', id: nextId(), mid: '', content: trimmed })
      transport.value?.send({ command: 'jump_in', text: trimmed })
      persistSoon()
      return
    }
    turnToolTrace = []
    timeline.value.push({ kind: 'user', id: nextId(), mid: '', content: trimmed })
    runState.value = 'thinking'
    armStallWatch()
    transport.value?.send({ command: 'send_message', text: trimmed })
    persistSoon()
  }

  function cancel() { transport.value?.send({ command: 'cancel' }) }
  function approve(callId: string, decision: 'allow' | 'deny' | 'always') {
    patchTool(callId, c => { c.status = decision === 'deny' ? 'error' : 'running'; if (decision === 'deny') { c.resultPreview = '（用户拒绝执行）'; c.isError = true } })
    transport.value?.send({ command: 'approve_tool', call_id: callId, decision })
    if (runState.value === 'awaiting_approval') runState.value = 'executing'
  }
  function answerQuestion(callId: string, answers: Record<string, string>) {
    patchQuestion(callId, q => { q.answered = true; q.answers = answers })
    transport.value?.send({ command: 'answer_question', call_id: callId, answers })
    if (runState.value === 'awaiting_question') runState.value = 'thinking'
  }
  function setPermissionMode(mode: 'ask' | 'auto' | 'full') { config.setPermissionMode(mode); transport.value?.send({ command: 'set_permission_mode', mode }) }
  function togglePlanMode() { const entering = !config.planMode; config.togglePlanMode(); transport.value?.send({ command: entering ? 'enter_plan_mode' : 'exit_plan_mode' }) }
  async function selectModel(providerId: string, model: string) {
    if (!(await config.validateAndSelectModel(providerId, model))) {
      pushNotice('error', config.lastError || '模型凭据验证失败，未切换模型')
      return
    }
    transport.value?.send({ command: 'select_model', provider_id: providerId, model })
    sessions.setModel(sessionId.value, providerId, model)
  }
  function setSessionMode(value: 'agent' | 'team' | 'life') {
    if (isBusy.value || mode.value === value) return
    mode.value = value
    sessions.setMode(sessionId.value, value)
    transport.value?.send({ command: 'set_session_mode', mode: value })
  }
  /** 按「人格只属于常驻会话 / 用于全局会话开关」重算当前会话模式并同步引擎。 */
  function syncLifeMode() {
    if (isBusy.value) return
    const next = resolveLifeMode(sessionId.value)
    if (mode.value === next) return
    mode.value = next
    sessions.setMode(sessionId.value, next)
    transport.value?.send({ command: 'set_session_mode', mode: next })
  }
  function completeFileTransfer(requestId: string, paths: string[]) {
    transport.value?.send({ command: 'file_transfer_result', request_id: requestId, paths })
  }

  /** 生命体未读问候（/api/life/unread）：窗口轮询 + 打开会话时刷新。 */
  async function refreshLifeUnread() {
    try {
      const data = await apiGet<{ pending: LifeUnreadItem | null; lifeName?: string } | null>('/api/life/unread')
      const pending = data?.pending ?? null
      lifeUnread.value = pending ? [pending] : []
      lifeUnreadName.value = pending?.lifeName ?? ''
      if (!pending) {
        // 引擎侧已无未读（可能已投递/过期）：复位投递态，允许后续再触发。
        lifeDelivering.value = false
        lifeAutoSent = true
      }
    } catch {
      /* 引擎未就绪时保持上次状态 */
    }
  }

  /** 手动投递（气泡 pill）：引擎侧把队列第一条写入本会话并流式推送。 */
  function deliverLife() {
    if (!lifeUnread.value.length || lifeDelivering.value) return
    lifeDelivering.value = true
    lifeAutoSent = true
    transport.value?.send({ command: 'deliver_life' })
  }

  /**
   * 开场问候：常驻会话已打开且引擎已连、有未读时自动投递一次。
   * 由 ChatView 常驻轮询每 2s 调用；lifeDelivering/lifeAutoSent 防止重复触发。
   * 主动消息只在常驻会话出现，其他会话永不投递。
   */
  function autoDeliverLifeIfReady() {
    if (lifeAutoSent || lifeDelivering.value) return
    if (!isGlobalSessionId(sessionId.value)) return
    if (mode.value !== 'life' || !lifeUnread.value.length || isBusy.value) return
    if (!connection.isOpen) return
    deliverLife()
    void refreshLifeUnread()
  }

  function newSession() {
    flushPersistence()
    endAssistantStream(); timeline.value = []; usage.value = null
    loop.value = { active: false, currentStep: 0, totalSteps: 0, status: '' }; runState.value = 'idle'
    pendingEdit.value = null
    undoConfirm.value = null
    activateSession(createSessionId())
    connect()
  }

  /** 从引擎 /api/sessions/{id} 恢复完整历史；成功返回 true。 */
  async function restoreFromEngine(id: string): Promise<boolean> {
    try {
      const res = await authedFetch(`/api/sessions/${id}`)
      if (!res.ok) return false
      const session = await res.json()
      mode.value = resolveLifeMode(id)
      sessions.setMode(id, mode.value)
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
        items.push({ kind: 'user', id: nextId(), mid: m.id ?? '', content: m.content })
      } else if (m.role === 'assistant') {
        if (m.content) items.push({ kind: 'assistant', id: nextId(), mid: m.id ?? '', content: m.content, streaming: false, life: m.life_proactive === true })
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
    pendingEdit.value = null
    undoConfirm.value = null
    runState.value = 'syncing'
    const targetId = isUuid(id) ? id : sessions.migrateId(id, createSessionId())
    activateSession(targetId)
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
    // 先停掉待落盘的持久化定时器：被删会话不应再写回（否则会“复活”成空标题的新会话）。
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    if (id === sessionId.value) {
      // 删除的是当前会话：先切到新会话并重连（关闭旧 id 的 WS 连接、清空时间线），
      // 避免 flushPersistence 把已删会话写回，也避免引擎在文件删除后重建同 id 会话。
      endAssistantStream(); timeline.value = []; usage.value = null
      loop.value = { active: false, currentStep: 0, totalSteps: 0, status: '' }; runState.value = 'idle'
      activateSession(createSessionId())
      connect()
    }
    sessions.remove(id)
    try { localStorage.removeItem(`coomi.draft.${id}`) } catch { /* ignore */ }
  }

  async function clearSessionData(id: string, mode: 'context' | 'all' = 'context'): Promise<{ ok: boolean; error?: string }> {
    // 注意：这里绝不能再弹 window.confirm——WebView 无 WebChromeClient 会静默吞掉，
    // 永远返回 false（「清空失败」的历史根因）。确认交互统一在 SideDrawer 两次点击完成。
    try {
      const response = await authedFetch(`/api/sessions/${encodeURIComponent(id)}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
          const data = await response.json()
          if (data?.message) message = data.message
        } catch { /* 无错误体就用状态码 */ }
        return { ok: false, error: message }
      }
      sessions.clearTranscript(id)
      sessions.touch(id, { turns: 0 })
      if (id === sessionId.value) {
        endAssistantStream()
        timeline.value = []
        usage.value = null
        loop.value = { active: false, currentStep: 0, totalSteps: 0, status: '' }
        runState.value = 'idle'
        reconnect()
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
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

  /** 编辑单条消息正文（改文本），成功后从引擎重新拉取时间线。 */
  /** 进入编辑模式：把旧文本回填到输入框，发送时覆盖该轮重新执行。 */
  function startEditMessage(mid: string, content: string) {
    if (isBusy.value) return
    pendingEdit.value = { mid, content }
    window.dispatchEvent(new CustomEvent('coomi:prefill-draft', {
      detail: { sessionId: sessionId.value, text: content },
    }))
  }

  /** 取消编辑模式（输入框内容保留，可继续作为普通新消息发送）。 */
  function cancelEditMessage() {
    pendingEdit.value = null
  }

  /** 点击「回撤」：先弹确认，避免误触后无法找回。 */
  function requestUndo(mid: string) {
    undoConfirm.value = { mid }
  }

  /** 确认回撤：执行截断，返回选定轮之前的状态。 */
  function confirmUndo() {
    const target = undoConfirm.value
    undoConfirm.value = null
    if (target) undoTurn(target.mid)
  }

  function cancelUndo() {
    undoConfirm.value = null
  }

  /** 回撤一轮：截断该轮 user 提问及其后的所有消息（含工具执行过程），不重新执行。 */
  function undoTurn(mid: string) {
    if (isBusy.value) return
    let cutAt = -1
    if (mid) {
      const aiIdx = timeline.value.findIndex(t => t.kind === 'assistant' && t.mid === mid)
      if (aiIdx >= 0) {
        for (let i = aiIdx; i >= 0; i--) {
          if (timeline.value[i].kind === 'user') { cutAt = i; break }
        }
      }
    }
    if (cutAt < 0) {
      for (let i = timeline.value.length - 1; i >= 0; i--) {
        if (timeline.value[i].kind === 'user') { cutAt = i; break }
      }
    }
    if (cutAt >= 0) timeline.value.splice(cutAt)
    runState.value = 'idle'
    pendingEdit.value = null
    transport.value?.send({ command: 'undo_turn', msg_id: mid })
    persistSoon()
  }

  function appendAssistant(content: string) {
    if (!currentAssistant) {
      timeline.value.push({ kind: 'assistant', id: nextId(), mid: '', content: '', streaming: true })
      // 必须拿 push 之后数组里的那个对象：ref 会把它包成代理，
      // 直接改 push 进去的原始对象不触发渲染，流式文本就只会停在第一片。
      currentAssistant = timeline.value[timeline.value.length - 1] as AssistantMessage
    }
    currentAssistant.content += content
  }
  function endAssistantStream() { if (currentAssistant) { currentAssistant.streaming = false; currentAssistant = null } }
  function appendReasoning(content: string) {
    // 就近合并：从末尾向前找最近的思考块；途中允许跳过工具/问题/通知卡和
    // 还没产出文字的助手消息 —— 部分供应商（如 deepseek）的 reasoning 与
    // text 交错发送，否则思考过程会被拆成多条碎片。
    const items = timeline.value
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind === 'reasoning') { (item as ReasoningBlock).content += content; return }
      if (item.kind === 'assistant' && item.content.trim() !== '') break
      if (item.kind === 'user' || item.kind === 'question') break
    }
    // 没有可合并目标时，纯空白的思考分片不值得新建一个「0 字」块。
    if (!content.trim()) return
    timeline.value.push({ kind: 'reasoning', id: nextId(), content, expanded: false })
  }
  function patchTool(callId: string, fn: (c: ToolCard) => void): boolean {
    for (let i = timeline.value.length - 1; i >= 0; i--) { const t = timeline.value[i]; if (t.kind === 'tool' && t.callId === callId) { fn(t); return true } }
    return false
  }
  function patchQuestion(callId: string, fn: (q: QuestionCard) => void) {
    for (let i = timeline.value.length - 1; i >= 0; i--) { const t = timeline.value[i]; if (t.kind === 'question' && t.callId === callId) { fn(t); return } }
  }
  function pushNotice(tone: 'info' | 'warn' | 'error' | 'success', text: string) { timeline.value.push({ kind: 'notice', id: nextId(), tone, text }) }

  /** 在瀑布流末尾放一张统一反馈卡（每回合至多一张，由 turn_end / 致命错误触发）。 */
  function pushFeedbackCard(
    channel: 'tool_failure' | 'runtime_error' | 'performance',
    summary: string,
    detail: string,
    needsAnalysis: boolean,
  ) {
    timeline.value.push({
      kind: 'notice', id: nextId(), tone: 'warn',
      text: summary,
      detail: detail || undefined,
      feedback: {
        channel,
        summary,
        needsAnalysis,
        toolTrace: turnToolTrace.map(({ callId: _callId, ...item }) => item),
        hasConversation: timeline.value.some(t => t.kind === 'user' || (t.kind === 'assistant' && t.content)),
      },
      analysisStatus: 'consent', feedbackEligible: true,
      failureCount: turnToolTrace.filter(item => item.status === 'error').length,
    })
  }

  /** 回合结束后清空异常信号（反馈卡已携带轨迹快照）。 */
  function resetTurnFeedbackSignals() {
    turnToolTrace = []
    consecutiveToolFailures = 0
    maxConsecutiveToolFailures = 0
    turnHadError = false
    lastTurnErrorDetail = ''
    stallDetected = false
    disarmStallWatch()
  }

  function updateAnalysisNotice(id: string, patch: Partial<Extract<Timelineitem, { kind: 'notice' }>>) {
    const notice = timeline.value.find(item => item.kind === 'notice' && item.id === id)
    if (notice?.kind === 'notice') Object.assign(notice, patch)
  }

  /**
   * 反馈第一步（consent → analyzing → ready/failed）：
   * 有工具失败轨迹时调用引擎做一次轻量溯源分析；纯运行时错误跳过分析直接 ready。
   */
  async function prepareTurnFeedback(noticeId: string): Promise<boolean> {
    const notice = timeline.value.find(item => item.kind === 'notice' && item.id === noticeId)
    if (notice?.kind !== 'notice' || !notice.feedback) return false
    if (!['consent', 'failed'].includes(notice.analysisStatus ?? '')) return false
    const feedback = notice.feedback
    if (!feedback.needsAnalysis || feedback.toolTrace.length === 0) {
      updateAnalysisNotice(noticeId, { analysisStatus: 'ready' })
      return true
    }
    updateAnalysisNotice(noticeId, {
      analysisStatus: 'analyzing', feedbackEligible: false, detail: undefined,
    })
    persistSoon()
    try {
      const response = await authedFetch('/api/tool-failure-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: config.currentProviderId,
          trace: feedback.toolTrace,
          conversation_excerpt: buildConversationExcerpt(),
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      const analysis = typeof data.analysis === 'string' ? data.analysis.trim() : ''
      if (!analysis) throw new Error('empty analysis')
      updateAnalysisNotice(noticeId, {
        analysisStatus: 'ready', feedbackEligible: false,
        analysisText: analysis,
      })
      persistSoon()
      return true
    } catch (error) {
      updateAnalysisNotice(noticeId, {
        analysisStatus: 'failed', feedbackEligible: true, detail: undefined,
        analysisText: error instanceof Error ? error.message : String(error),
      })
      persistSoon()
      return false
    }
  }

  /** 反馈第二步（ready → 上传）：组装 v2 payload，经原生桥上传（含脱敏终检与 Outbox 兜底）。 */
  async function sendTurnFeedback(noticeId: string): Promise<{ ok: boolean; reason: string; queued: boolean }> {
    const notice = timeline.value.find(item => item.kind === 'notice' && item.id === noticeId)
    if (notice?.kind !== 'notice' || !notice.feedback) return { ok: false, reason: 'gone', queued: false }
    const feedback = notice.feedback
    const payload = {
      channel: feedback.channel,
      error: { title: feedback.summary, message: feedback.summary, detail: notice.detail ?? '' },
      context: {
        conversation_excerpt: buildConversationExcerpt(),
        tool_trace: feedback.toolTrace,
      },
      analysis: notice.analysisText ?? null,
      session: {
        session_id: sessionId.value,
        provider: config.currentProviderId,
        model: config.currentModel,
        permission_mode: config.permissionMode,
      },
      time: new Date().toISOString(),
    }
    const result = await sendFeedbackViaBridge(payload)
    return { ok: result.ok, reason: result.error ?? '', queued: result.status === 'queued' }
  }

  /** 反馈第三步：回写卡片状态（不改动摘要文本，状态提示由卡片自身渲染，避免重复）。 */
  function finishTurnFeedback(noticeId: string, ok: boolean, reason = '', queued = false) {
    updateAnalysisNotice(noticeId, ok ? {
      analysisStatus: 'complete', feedbackEligible: false,
      statusNote: queued ? '反馈已加入队列，联网后自动发送' : undefined,
    } : {
      analysisStatus: 'ready', feedbackEligible: true,
      statusNote: reason ? `上传失败：${reason}` : undefined,
    })
    persistSoon()
  }

  /** 最近数轮对话摘要（仅密钥/联系方式打码，保留原文场景，供反馈溯源；上限 ~8000 字符）。 */
  function buildConversationExcerpt(): Array<{ role: 'user' | 'assistant'; text: string }> {
    const excerpt: Array<{ role: 'user' | 'assistant'; text: string }> = []
    let total = 0
    for (let i = timeline.value.length - 1; i >= 0 && total < 8000; i--) {
      const item = timeline.value[i]
      if (item.kind !== 'user' && item.kind !== 'assistant') continue
      const content = item.content.trim()
      if (!content) continue
      const text = maskSecrets(content.slice(0, 2000))
      excerpt.unshift({ role: item.kind === 'user' ? 'user' : 'assistant', text })
      total += text.length
    }
    return excerpt
  }

  return { sessionId, mode, timeline, runState, usage, retryConfirmation, cwd, loop, collaboration, isBusy, pendingEdit, undoConfirm, lastUserMessage, lastAssistantMessage, pendingApproval, pendingQuestion, lifeUnread, lifeUnreadName, lifeDelivering, isGlobalSession, resolveLifeMode, syncLifeMode, refreshLifeUnread, deliverLife, autoDeliverLifeIfReady, connect, reconnect, disconnect, flushPersistence, sendMessage, cancel, approve, answerQuestion, setPermissionMode, setReasoningEffort, setMaxToolRounds, setSessionMode, togglePlanMode, selectModel, retryInterruptedTurn, dismissRetry, completeFileTransfer, newSession, openSession, deleteSession, clearSessionData, setSessionCwd, startEditMessage, cancelEditMessage, requestUndo, confirmUndo, cancelUndo, undoTurn, sendGuide, prepareTurnFeedback, sendTurnFeedback, finishTurnFeedback }
})

function fmtTokens(n: number): string { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n) }

/** 生命体待投递问候（/api/life/unread 返回的 pending 项）。 */
interface LifeUnreadItem {
  id: string
  text: string
  trigger: string
  lifeName?: string
  createdAtMs?: number
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80) || 'unknown_tool'
}

/**
 * 密钥/联系方式打码（唯一保留的脱敏项）：只处理密码、API Key、Bearer 令牌、
 * 邮箱与手机号。路径、命令、URL、参数值一律保留原文，保证反馈可溯源。
 */
function maskSecrets(text: string): string {
  return text
    .replace(/\b(?:sk|rk|pk)-[a-zA-Z0-9._-]{8,}\b/g, 'sk-***')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{8,}/gi, 'Bearer ***')
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)s?\s*[:=]\s*)(["']?)[^\s"',}&]+\2/gi, '$1***')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '***@***')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '1**********')
}

function classifyToolError(message: string): string {
  const text = message.toLowerCase()
  if (/permission|denied|allowed area/.test(text)) return 'permission_or_sandbox'
  if (/timeout|timed out/.test(text)) return 'timeout'
  if (/not found|enoent/.test(text)) return 'not_found'
  if (/invalid|schema|argument|parse/.test(text)) return 'invalid_arguments'
  if (/network|connect|dns|http/.test(text)) return 'network_or_upstream'
  return 'execution_error'
}

/**
 * 工具参数脱敏（放松版）：保留真实字符串（路径/命令/URL 原文，仅打码密钥与长文本截断），
 * 结构上限不变（深度 4、数组 12、对象 30），保证反馈能还原真实任务场景。
 */
function summarizeArguments(value: unknown, key = '', depth = 0): unknown {
  if (depth > 4) return '[max_depth]'
  if (value === null) return null
  if (Array.isArray(value)) return value.slice(0, 12).map(item => summarizeArguments(item, key, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([childKey, child]) => [
      childKey.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80) || 'field',
      summarizeArguments(child, childKey, depth + 1),
    ]))
  }
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value !== 'string') return `[${typeof value}]`
  const lowerKey = key.toLowerCase()
  if (/key|token|secret|password|authorization|credential/.test(lowerKey)) return '[redacted_secret]'
  // 保留原文：仅密钥形态打码 + 超长截断（保留头尾）。
  const text = value.trim()
  const masked = maskSecrets(text)
  if (masked.length <= 600) return masked
  return masked.slice(0, 400) + `…（截断，全长 ${masked.length} 字符）…` + masked.slice(-120)
}

/** 错误摘要打码：仅密钥与联系方式，长度上限 1200。 */
function sanitizeDiagnosticText(message: string): string {
  return maskSecrets(String(message ?? '')).slice(0, 1200)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTIVE_SESSION_KEY = 'coomi.activeSessionId.v1'

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function readActiveSessionId(): string {
  try {
    const requested = new URLSearchParams(window.location.search).get('session_id') ?? ''
    if (isUuid(requested)) return requested
    const saved = localStorage.getItem(ACTIVE_SESSION_KEY) ?? ''
    if (isUuid(saved)) return saved
  } catch {
    // WebView storage can be unavailable during early startup; create a valid fallback.
  }
  return createSessionId()
}

function persistActiveSessionId(id: string) {
  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, id)
  } catch {
    // Keeping the in-memory id is enough for this process lifetime.
  }
}

/** 引擎磁盘上会话文件的原始消息结构（与 coomi-engine 的 ChatMessage 对应）。 */
interface ChatMessageJson {
  id?: string
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
  life_proactive?: boolean
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
