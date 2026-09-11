import type { AgentCommand, InboundEnvelope } from '@/protocol/commands'

export type ConnectionState = 'connecting' | 'reconnecting' | 'open' | 'closed' | 'error'

export interface ConnectionStatus {
  state: ConnectionState
  attempt?: number
  maxRetries?: number
  delayMs?: number
  reason?: string
}

export interface Transport {
  connect(): void
  close(): void
  /** 是否仍可能收发：已打开、连接中或重连等待中都算存活；已停止重连/被关闭则视为死亡。 */
  readonly alive: boolean
  send(command: AgentCommand): void
  onMessage(handler: (env: InboundEnvelope) => void): void
  onStateChange(handler: (status: ConnectionStatus) => void): void
}
