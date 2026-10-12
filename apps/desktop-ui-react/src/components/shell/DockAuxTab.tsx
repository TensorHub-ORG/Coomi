import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, MessageSquarePlus, Square } from 'lucide-react'
import { useEngine } from '../../stores/engine'
import { createEngineSocket } from '../../lib/engineSocket'
import { applyEventToMessages, applyHistoryItems, itemsFromHistory, type ChatItem } from '../../lib/chat'
import { createSeqGate, readEventSeq } from '../../lib/eventSeq'
import { Markdown } from '../chat/Markdown'
import { Button } from '../ui/Button'

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
  const [sessionId] = useState(storedAuxSession)
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [draft, setDraft] = useState('')
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<number | null>(null)
  const tailRef = useRef<HTMLDivElement>(null)
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
      if (lastEventSeq.current > 0) socket.send(envelope({ command: 'resync', after_seq: lastEventSeq.current }))
      void refreshHistory(epoch)
    }
    socket.onmessage = (event) => {
      if (!active) return
      try {
        const frame = JSON.parse(String(event.data)) as Record<string, any>
        const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload as Record<string, any> : frame
        if (frame.type === 'error' || payload.type === 'error') {
          setError(String(payload.message ?? payload.error ?? '辅助会话请求失败'))
          setBusy(false)
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
    tailRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const send = (): void => {
    const text = draft.trim()
    const socket = socketRef.current
    if (!text || busy || !socket || socket.readyState !== WebSocket.OPEN) {
      if (!connected) setError('辅助会话尚未连接')
      return
    }
    messageRevision.current += 1
    setMessages((current) => [...current, { kind: 'user', id: 'aux-u-' + seqRef.current++, text }])
    socket.send(envelope({ command: 'send_message', text, interject: false }))
    setDraft('')
    setBusy(true)
    setError('')
  }

  return (
    <section className='flex h-full min-h-0 flex-col' data-dock-tab='side'>
      <div className='flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3'>
        {messages.length === 0 ? (
          <div className='m-auto max-w-[280px] text-center text-12 text-ink-3'>
            <MessageSquarePlus size={22} className='mx-auto mb-2 text-ink-4' />
            <p className='font-medium text-ink-2'>辅助会话</p>
            <p className='mt-1'>这里有独立的上下文和连接，不会切换或覆盖主会话。</p>
          </div>
        ) : messages.map((item) => (
          <AuxMessage key={item.id} item={item} />
        ))}
        {busy ? <div className='flex items-center gap-2 text-11 text-ink-4'><LoaderCircle size={13} /> 正在回复</div> : null}
        <div ref={tailRef} />
      </div>
      {error ? <div className='mx-3 mb-2 break-words text-11 text-danger'>{error}</div> : null}
      <form className='border-t border-line px-3 py-2' onSubmit={(event) => { event.preventDefault(); send() }}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }}
          placeholder={connected ? '继续询问…' : '连接引擎中…'}
          disabled={!connected}
          rows={2}
          className='max-h-28 min-h-14 w-full resize-y bg-transparent px-1 py-1.5 text-12 text-ink outline-none placeholder:text-ink-4'
        />
        <div className='mt-1 flex items-center justify-between'>
          <span className='text-10 text-ink-4'>独立辅助对话</span>
          <Button type='submit' variant='primary' size='icon-sm' disabled={!draft.trim() || busy || !connected} aria-label={busy ? '等待回复' : '发送'}>
            {busy ? <Square size={12} /> : <ArrowUp size={14} />}
          </Button>
        </div>
      </form>
    </section>
  )
}

function AuxMessage({ item }: { item: ChatItem }) {
  if (item.kind === 'user') return <div className='self-end max-w-[94%] rounded-lg bg-primary-soft px-2.5 py-2 text-12 text-ink'>{item.text}</div>
  if (item.kind === 'assistant') return (
    <article className='min-w-0 text-12 text-ink-2'>
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
