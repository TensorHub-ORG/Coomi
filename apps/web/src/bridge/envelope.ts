import { PROTOCOL_VERSION, type AgentCommand, type CommandEnvelope, type InboundEnvelope } from '@/protocol/commands'

let counter = 0
export function nextId(): string {
  counter += 1
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : `id-${Date.now()}-${counter}`
  return uuid
}

export function wrapCommand(command: AgentCommand): CommandEnvelope {
  return { v: PROTOCOL_VERSION, type: 'command', id: nextId(), ts: Date.now() / 1000, payload: command }
}

export function parseInbound(raw: string): InboundEnvelope | null {
  let obj: unknown
  try { obj = JSON.parse(raw) } catch { return null }
  if (typeof obj !== 'object' || obj === null || !('type' in obj) || !('payload' in obj)) return null
  return obj as InboundEnvelope
}
