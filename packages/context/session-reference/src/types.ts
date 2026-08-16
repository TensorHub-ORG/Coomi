/** Public session-reference request, candidate, and preparation records. */

import type { ContentBlock } from '@coomi/coomi-llm'
import type { SessionId, UserMessage } from '@coomi/coomi-session'

/** Durable source session, cited event seqs, and snapshot facts for prepared cross-session context. */
export interface SessionReferenceSource {
  kind: 'session-reference'
  /** Material lifted out of another session's log (`recall` context form). */
  form: 'recall'
  version: 1
  references: {
    sessionId: string
    label: string
    capturedThroughSeq: number | null
    compacted: boolean
    originalMessages: number
    retainedMessages: number
    omittedMessages: number
    omittedBytes: number
    truncated: boolean
    inputIndex: number
  }[]
}

declare module '@coomi/coomi-llm' {
  interface MessageSourceMap {
    'session-reference': SessionReferenceSource
  }
}

/** One source session selected by a host. */
export interface SessionReferenceInput {
  /** Opaque source session identity. */
  sessionId: SessionId
  /** Optional user-facing mention label. */
  label?: string
}

/** One host-facing candidate from exact session metadata. */
export interface SessionReferenceCandidate {
  /** Opaque source session identity. */
  sessionId: SessionId
  /** Latest log-backed title, falling back to the opaque session id. */
  label: string
  /** Source session working directory, when recorded. */
  cwd?: string
  /** Source session creation time in Unix epoch milliseconds. */
  createdAt: number
}

/** Direct message content and optional referenced-session context. */
export interface PreparedReferencedMessage {
  /** Readable message content after host mention tokens are removed. */
  content: ContentBlock[]
  /** Aggregated untrusted snapshot, absent when the message has no references. */
  additionalContext?: UserMessage
}

/** Text-only projected conversation item. */
export interface ReferencedConversationItem {
  /** Original message role. */
  role: 'user' | 'assistant'
  /** Visible text retained from that message. */
  text: string
}
