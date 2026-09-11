import type { AgentCommand, InboundEnvelope } from '@/protocol/commands'
import { wrapCommand } from './envelope'
import type { ConnectionState, ConnectionStatus, Transport } from './transport'

export interface WsTransportOptions {
  url: string
  maxRetries?: number
  backoffBase?: number
  backoffMax?: number
}

export class WsTransport implements Transport {
  private ws: WebSocket | null = null
  private msgHandlers: ((env: InboundEnvelope) => void)[] = []
  private stateHandlers: ((status: ConnectionStatus) => void)[] = []
  private retries = 0
  private closedByUser = false
  /** 重试次数耗尽后的永久停摆状态：不再自动重连，等待显式恢复（retryNow）。 */
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 连接建立前的待发命令：打开后一次性 flush，避免「连上之前发的消息被静默吞掉」。 */
  private pending: AgentCommand[] = []
  constructor(private readonly opts: WsTransportOptions) {
    // 停摆后只要网络恢复或页面重新可见，就自动再试一次，避免「死连接」留到下次进页面。
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleRecovery)
      window.addEventListener('visibilitychange', this.handleRecovery)
    }
  }

  get alive(): boolean {
    if (this.reconnectTimer !== null) return true
    if (this.ws === null) return false
    return this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING
  }

  private handleRecovery = (): void => {
    if (this.stopped && !this.closedByUser) this.retryNow()
  }

  connect(): void { this.closedByUser = false; this.stopped = false; this.open() }

  /** 显式从停摆/关闭状态恢复：重置计数并立即重开。 */
  retryNow(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.closedByUser = false
    this.stopped = false
    this.retries = 0
    this.open()
  }

  private open(): void {
    this.emitState('connecting')
    try { this.ws = new WebSocket(this.opts.url) } catch { this.scheduleReconnect('无法创建连接'); return }
    this.ws.onopen = () => {
      this.retries = 0
      const queued = this.pending
      this.pending = []
      for (const command of queued) this.ws?.send(JSON.stringify(wrapCommand(command)))
      this.emitState('open')
    }
    this.ws.onmessage = (ev) => {
      try { const env = JSON.parse(ev.data as string) as InboundEnvelope; this.msgHandlers.forEach(h => h(env)) } catch {}
    }
    this.ws.onerror = () => this.emitState('error', { reason: '连接发生错误' })
    this.ws.onclose = (event) => {
      this.ws = null
      if (this.closedByUser) { this.emitState('closed'); return }
      this.scheduleReconnect(event.reason || (event.code ? `连接关闭 (${event.code})` : '连接关闭'))
    }
  }

  private scheduleReconnect(reason: string): void {
    const max = this.opts.maxRetries ?? 10
    if (this.retries >= max) {
      this.stopped = true
      this.emitState('error', { attempt: this.retries, maxRetries: max, reason: `${reason}，已停止重连` })
      return
    }
    const base = this.opts.backoffBase ?? 500
    const delay = Math.min(base * 2 ** this.retries, this.opts.backoffMax ?? 10_000)
    this.retries += 1
    this.emitState('reconnecting', { attempt: this.retries, maxRetries: max, delayMs: delay, reason })
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.open() }, delay)
  }

  close(): void {
    this.closedByUser = true
    this.pending = []
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.ws?.close()
    this.ws = null
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleRecovery)
      window.removeEventListener('visibilitychange', this.handleRecovery)
    }
  }
  send(command: AgentCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(wrapCommand(command))); return }
    // 已停摆或主动关闭：不接收新命令（不再入队，避免无限堆积）。
    if (this.closedByUser || this.stopped) return
    // 连接建立/重连等待期间入队，onopen 后 flush，保证「连上之前发的消息」不丢。
    this.pending.push(command)
  }
  onMessage(handler: (env: InboundEnvelope) => void): void { this.msgHandlers.push(handler) }
  onStateChange(handler: (status: ConnectionStatus) => void): void { this.stateHandlers.push(handler) }
  private emitState(state: ConnectionState, detail: Omit<ConnectionStatus, 'state'> = {}): void {
    this.stateHandlers.forEach(h => h({ state, ...detail }))
  }
}
