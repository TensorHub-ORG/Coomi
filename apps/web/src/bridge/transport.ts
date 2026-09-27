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
  send(command: AgentCommand): void
  onMessage(handler: (env: InboundEnvelope) => void): void
  onStateChange(handler: (status: ConnectionStatus) => void): void
}
