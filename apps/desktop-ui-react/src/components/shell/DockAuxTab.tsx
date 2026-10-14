import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Cpu, LoaderCircle, MessageSquarePlus, Plus, Shield, ShieldAlert, Square } from 'lucide-react'
import { useEngine } from '../../stores/engine'
import { createEngineSocket } from '../../lib/engineSocket'
import { applyEventToMessages, applyHistoryItems, itemsFromHistory, type ChatItem } from '../../lib/chat'
import { createSeqGate, readEventSeq } from '../../lib/eventSeq'
import { Markdown } from '../chat/Markdown'
import { Button } from '../ui/Button'
import { Menu } from '../ui/Menu'
import { EffortPicker } from '../ui/EffortSlider'
import { PERMISSION_LABELS, useAgent } from '../../stores/agent'
import { cn } from '../../lib/cn'
import { composerBoxClass, composerInputClass, composerToolsClass, composerSendClass, composerSendState } from '../chat/composerDesign'

const AUX_SESSION_KEY = 'coomi.auxiliary-session.v1'

function storedAuxSession(): string {
  try {
    const value = localStorage.getItem(AUX_SESSION_KEY)
    if (value && /^[0-9a-f-]{36}$/i.test(value)) return value
  } catch { /* privacy mode */ }
  const value = crypto.randomUUID()
  try { localStorage.setItem(AUX_SESSION_KEY, value) } catch { /* privacy mode */ }
  return value
}

function envelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ id: crypto.randomUUID(), payload })
}

function readAuxSequence(sessionId: string): number {
  try { return Number(localStorage.getItem('coomi.aux.sequence.v1.' + sessionId) ?? 0) || 0 } catch { return 0 }
}

/** A persistent side conversation with its own socket and message state. */
export function DockAuxTab() {
  const ready = useEngine((s) => s.ready)
  const port = useEngine((s) => s.port)
  const token = useEngine((s) => s.token)
  const wsUrl = useEngine((s) => s.wsUrl)
  const api = useEngine((s) => s.api)
  const [sessionId] = useState(() => storedAuxSession())
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [draft, setDraft] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const permission = useAgent((s) => s.permission)
  const effort = useAgent((s) => s.effort)
  const providers = useAgent((s) => s.providers)
  const loadProviders = useAgent((s) => s.loadProviders)
  const providerRevision = useAgent((s) => s.providerRevision)
  const [model, setModel] = useState<{ provider: string; model: string } | null>(null)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const socketRef = useRef<WebSocket | null>(null)
  const modelRequest = useRef<string | null>(null)
  const reconnectTimer = useRef<number | null>(null)
  const tailRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followTail = useRef(true)
  const seqRef = useRef(1)
  const lastEventSeq = useRef(0)
  const lastAckSeq = useRef(0)
  const firstEventOnConnection = useRef(true)
  const seqGate = useRef(createSeqGate<Record<string, any>>())
  const historyRequest = useRef(0)
  const messageRevision = useRef(0)
  const transportEpoch = useRef(0)

  const refreshHistory = useCallback(async (expectedEpoch?: number) => {
    const request = ++historyRequest.current
    const revision = messageRevision.current
    const engine = useEngine.getState()
    const endpoint = engine.port + ':' + engine.token
    try {
      const data = await api<{ messages?: Array<Record<string, any>> }>('/api/sessions/' + encodeURIComponent(sessionId))
      const currentEngine = useEngine.getState()
      if (request !== historyRequest.current || endpoint !== currentEngine.port + ':' + currentEngine.token
        || (expectedEpoch !== undefined && expectedEpoch !== transportEpoch.current)) return
      const incoming = itemsFromHistory(data.messages ?? [])
      const history = data as Record<string, any>
      if (history.provider_id && history.model) setModel({ provider: history.provider_id, model: history.model })
      // A response started before a send or live event merges against the live tail
      // instead of replacing it; the history helper replaces only entries it can
      // positively match by message identity.
      setMessages((current) => revision === messageRevision.current ? incoming : applyHistoryItems(current, incoming))
    } catch {
      // A newly allocated side session has no file until its first prompt is sent.
    }
  }, [api, sessionId])

  useEffect(() => {
    if (!ready || !sessionId) return
    let active = true
    const epoch = ++transportEpoch.current
    lastEventSeq.current = readAuxSequence(sessionId)
    lastAckSeq.current = lastEventSeq.current
    seqGate.current.reset(lastEventSeq.current)
    firstEventOnConnection.current = true
    const socket = createEngineSocket({
      url: wsUrl(sessionId), sessionId, port, token,
      onTransportError: (message) => { if (active) setError(message) },
    })
    socketRef.current = socket
    socket.onopen = () => {
      if (!active) return
      setConnected(true)
      setError('')
      const prefs = useAgent.getState()
      socket.send(envelope({ command: 'set_reasoning_effort', effort: prefs.effort }))
      socket.send(envelope({ command: 'set_permission_mode', mode: prefs.permission }))
      if (lastEventSeq.current > 0) socket.send(envelope({ command: 'resync', after_seq: lastEventSeq.current }))
      void refreshHistory(epoch)
    }
    socket.onmessage = (event) => {
      if (!active) return
      try {
        const frame = JSON.parse(String(event.data)) as Record<string, any>
        const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload as Record<string, any> : frame
        if (frame.type === 'ack' && frame.id === modelRequest.current) {
          void refreshHistory(epoch)
          return
        }
        if (frame.type === 'error' || payload.type === 'error') {
          setError(String(payload.message ?? payload.error ?? '辅助会话请求失败'))
          if (frame.id === modelRequest.current) void refreshHistory(epoch)
          return
        }
        if (typeof payload.event_type !== 'string') return
        const processEvent = (eventPayload: Record<string, any>): void => {
          const type = eventPayload.event_type
          const eventSeq = readEventSeq(eventPayload)
          if (type === 'session_state' || type === 'connection_heartbeat') {
            if (typeof eventPayload.running === 'boolean') setBusy(eventPayload.running)
            const nextSeq = Number(eventPayload.next_seq)
            if (Number.isSafeInteger(nextSeq) && nextSeq > 0 && nextSeq <= seqGate.current.last()) {
              seqGate.current.reset()
              lastEventSeq.current = 0
              lastAckSeq.current = 0
              try { localStorage.removeItem('coomi.aux.sequence.v1.' + sessionId) } catch { /* privacy mode */ }
            }
            return
          }
          if (type === 'session_loaded') return
          if (type === 'agent_error') setError(String(eventPayload.message ?? '辅助会话执行失败'))
          messageRevision.current += 1
          const localSeq = seqRef.current++
          setMessages((current) => applyEventToMessages(current, eventPayload, { seq: localSeq }))
          if (type === 'turn_end') {
            if (eventSeq !== null && eventSeq > lastAckSeq.current) {
              socket.send(envelope({ command: 'ack', seq: eventSeq }))
              lastAckSeq.current = eventSeq
            }
            setBusy(false)
            void refreshHistory(epoch)
          } else if (eventSeq !== null && eventSeq - lastAckSeq.current >= 40) {
            socket.send(envelope({ command: 'ack', seq: eventSeq }))
            lastAckSeq.current = eventSeq
          }
        }
        const eventSeq = readEventSeq(payload)
        if (eventSeq === null) {
          processEvent(payload)
          return
        }
        if (firstEventOnConnection.current) {
          firstEventOnConnection.current = false
          // 引擎重启后每个会话的事件序号会从 1 重新开始。
          if (eventSeq < seqGate.current.last()) {
            seqGate.current.reset()
            lastEventSeq.current = 0
            lastAckSeq.current = 0
          }
        }
        const outcome = seqGate.current.push(eventSeq, payload)
        if (outcome.duplicate) return
        if (outcome.gap) {
          socket.send(envelope({ command: 'resync', after_seq: seqGate.current.last() }))
          return
        }
        for (const ordered of outcome.ready) processEvent(ordered)
        lastEventSeq.current = seqGate.current.last()
        try { localStorage.setItem('coomi.aux.sequence.v1.' + sessionId, String(lastEventSeq.current)) } catch { /* privacy mode */ }
      } catch {
        setError('收到无法识别的引擎消息')
      }
    }
    socket.onerror = () => { if (active) setError('辅助会话连接失败，正在尝试重连') }
    socket.onclose = () => {
      if (!active) return
      setConnected(false)
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current)
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null
        if (active) setReconnectAttempt((value) => value + 1)
      }, 1500)
    }
    return () => {
      active = false
      setConnected(false)
      if (transportEpoch.current === epoch) transportEpoch.current += 1
      if (reconnectTimer.current !== null) { window.clearTimeout(reconnectTimer.current); reconnectTimer.current = null }
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
      if (socketRef.current === socket) socketRef.current = null
    }
  }, [ready, port, token, wsUrl, sessionId, refreshHistory, reconnectAttempt])

  useEffect(() => {
    const area = scrollRef.current
    if (area && followTail.current) area.scrollTop = area.scrollHeight
  }, [messages, busy])

  useEffect(() => { if (ready) void loadProviders() }, [ready, providerRevision, loadProviders])
  useEffect(() => {
    const socket = socketRef.current
    if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(envelope({ command: 'set_reasoning_effort', effort }))
    socket.send(envelope({ command: 'set_permission_mode', mode: permission }))
  }, [connected, effort, permission])
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = Math.min(168, Math.max(56, area.scrollHeight)) + 'px'
  }, [draft])

  const send = (): void => {
    const text = draft.trim()
    const socket = socketRef.current
    if (!text || busy || !socket || socket.readyState !== WebSocket.OPEN) {
      if (!connected) setError('辅助会话尚未连接')
      return
    }
    messageRevision.current += 1
    followTail.current = true
    setMessages((current) => [...current, { kind: 'user', id: 'aux-u-' + seqRef.current++, text }])
    socket.send(envelope({ command: 'send_message', text, interject: false }))
    setDraft('')
    setBusy(true)
    setError('')
  }

  return (
    <section className='flex h-full min-h-0 flex-col' data-dock-tab='side'>
      <div ref={scrollRef} onScroll={() => { const area = scrollRef.current; if (area) followTail.current = area.scrollHeight - area.scrollTop - area.clientHeight < 48 }} className='flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3'>
      <div className='flex min-w-0 flex-col gap-2'>
        {messages.length === 0 ? (
          <div className='m-auto max-w-[280px] text-center text-12 text-ink-3'>
            <MessageSquarePlus size={22} className='mx-auto mb-2 text-ink-4' />
            <p className='font-medium text-ink-2'>辅助会话</p>
            <p className='mt-1'>这里有独立的上下文和连接，不会切换或覆盖主会话。</p>
          </div>
        ) : messages.map((item) => <AuxMessage key={item.id} item={item} />)}
        {busy ? <div className='flex items-center gap-2 text-11 text-ink-4'><LoaderCircle size={13} /> 正在回复</div> : null}
        <div ref={tailRef} />
      </div>
      </div>
      {error ? <div className='mx-3 mb-2 break-words text-11 text-danger'>{error}</div> : null}
      <form data-composer data-aux-composer className='flex w-full flex-col gap-2 px-3 pb-3 pt-2' onSubmit={(event) => { event.preventDefault(); followTail.current = true; send() }}>
        <div data-composer-box className={cn(composerBoxClass, 'border-line')}>
        <div className='flex w-full min-w-0 items-start gap-1.5'>
        <textarea
          ref={areaRef}
          aria-label='辅助会话消息输入框'
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }}
          placeholder={connected ? '告诉 Coomi，你想做些什么…' : '连接引擎中…'}
          disabled={!connected}
          rows={1}
          className={composerInputClass}
        />
        </div>
        <div data-composer-tools className={composerToolsClass}>
          <Menu align='start' side='top' items={[
            { label: '粘贴文本', onSelect: () => { void navigator.clipboard.readText().then((text) => { setDraft((value) => value + text); areaRef.current?.focus() }).catch(() => setError('无法读取剪贴板，请使用 Ctrl+V')) } },
            { label: '清空输入', disabled: !draft, onSelect: () => { setDraft(''); areaRef.current?.focus() } },
          ]} trigger={<Button variant='ghost' size='icon-sm' title='输入操作' aria-label='添加'><Plus size={16} /></Button>} />
          <Menu align='start' side='top' groups={providers.map((provider) => ({ label: provider.name || provider.id, items: (provider.models?.length ? provider.models : provider.model ? [provider.model] : []).map((id) => ({
            label: id, selected: model?.provider === provider.id && model.model === id, disabled: busy || !connected,
            onSelect: () => {
              const requestId = crypto.randomUUID()
              modelRequest.current = requestId
              socketRef.current?.send(JSON.stringify({ id: requestId, payload: { command: 'select_model', provider_id: provider.id, model: id } }))
              // Read back only after the engine acknowledges the saved selection.
            },
          })) }))} trigger={<Button variant='ghost' size='sm' data-aux-model title='选择模型' className='min-w-0 gap-1 text-ink-3'><Cpu size={14} className='shrink-0' /><span className='composer-control-label composer-model-label min-w-0 truncate'>{model?.model || providers.find((provider) => provider.active)?.model || '选择模型'}</span><ChevronDown size={12} className='shrink-0' /></Button>} />
          <EffortPicker className='shrink-0' />
          <Menu align='start' side='top' items={PERMISSION_LABELS.map((mode) => ({ label: mode.label + ' · ' + mode.hint, selected: permission === mode.value, onSelect: () => { void useAgent.getState().setPermission(mode.value) } }))} trigger={<Button variant='ghost' size='sm' title='任务放行程度' className={permission === 'full' ? 'gap-1 text-warn' : 'gap-1 text-ink-3'}>{permission === 'full' ? <ShieldAlert size={14} /> : <Shield size={14} />}<span className='composer-control-label'>{PERMISSION_LABELS.find((mode) => mode.value === permission)?.label}</span></Button>} />
          <div className='ml-auto shrink-0' data-composer-send>
            <button type={busy ? 'button' : 'submit'} className={cn(composerSendClass, composerSendState(busy, !!draft.trim()))} disabled={(!busy && !draft.trim()) || !connected} title={busy ? '停止生成' : '发送（Enter）'} aria-label={busy ? '停止生成' : '发送'} onClick={busy ? () => socketRef.current?.send(envelope({ command: 'cancel' })) : undefined}>
              {busy ? <Square size={13} /> : <ArrowUp size={17} />}
            </button>
          </div>
        </div>
        </div>
      </form>
    </section>
  )
}

function AuxMessage({ item }: { item: ChatItem }) {
  if (item.kind === 'user') return <div className='self-end max-w-[94%] rounded-lg bg-primary-soft px-2.5 py-2 text-12 text-ink'>{item.text}</div>
  if (item.kind === 'assistant') return (
    <article className='min-w-0 text-12 text-ink-2'>
      {item.reasoning ? <details className='mb-2 text-11 text-ink-3' open={item.reasoningStreaming}><summary>{item.reasoningStreaming ? '思考中' : '思考记录'}</summary><div className='mt-1 border-l border-line pl-3'><Markdown text={item.reasoning} streaming={item.reasoningStreaming} /></div></details> : null}
      {item.text ? <Markdown text={item.text} streaming={item.streaming} /> : null}
      {item.tools.length ? <details className='mt-1 text-11 text-ink-3'><summary>{item.tools.length} 次工具调用</summary>
        <div className='mt-1 space-y-2 border-l border-line pl-2'>{item.tools.map((tool) => <div key={tool.callId}>
          <p className={tool.status === 'error' ? 'text-danger' : ''}>{tool.name} · {tool.status}</p>
          {tool.output || tool.preview ? <pre className='mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-10'>{tool.output ?? tool.preview}</pre> : null}
        </div>)}</div>
      </details> : null}
    </article>
  )
  if (item.kind === 'notice') return <p className={item.tone === 'error' ? 'text-11 text-danger' : 'text-11 text-ink-3'}>{item.text}</p>
  if (item.kind === 'reminder') return <p className='text-10 text-ink-4'>{item.text}</p>
  return null
}
