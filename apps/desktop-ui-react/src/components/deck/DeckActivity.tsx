import { Brain, MessageSquare, Wrench, User, Info } from 'lucide-react'
import type { ChatItem, ToolCall } from '../../lib/chat'

export type CoordinatorLayout = 'compact' | 'half' | 'full'
const status: Record<ToolCall['status'], string> = { queued: '等待', running: '执行中', done: '完成', error: '失败', denied: '已拒绝' }
function summary(text: string): string { return text.replace(/\s+/g, ' ').trim() }

/** One line per activity, derived from the same live messages as expanded view. */
export function DeckActivity({ messages }: { messages: ChatItem[] }) {
  return <>{messages.map((item) => {
    if (item.kind === 'assistant') {
      const segments = item.segments?.length ? item.segments : [
        ...(item.text ? [{ kind: 'text' as const, text: item.text }] : []),
        ...(item.tools.length ? [{ kind: 'tools' as const, callIds: item.tools.map(tool => tool.callId) }] : []),
      ]
      return <div key={item.id} className='deck-activity-group'>
        {item.reasoning ? <div className='deck-activity-line' data-activity='reasoning'><Brain size={13} /><span className='deck-activity-label'>{item.reasoningStreaming ? '思考中' : '思考'}</span><span className='truncate' title={item.reasoning}>{summary(item.reasoning)}</span></div> : null}
        {segments.map((segment, index) => segment.kind === 'text'
          ? <div key={index} className='deck-activity-line' data-activity='text'><MessageSquare size={13} /><span className='deck-activity-label'>{item.streaming ? '回复中' : 'Coomi'}</span><span className='truncate' title={segment.text}>{summary(segment.text)}</span></div>
          : segment.callIds.map(id => {
            const tool = item.tools.find(tool => tool.callId === id)
            return tool ? <div key={id} className='deck-activity-line' data-activity='tool'><Wrench size={13} /><span className='deck-activity-label'>{status[tool.status]}</span><span className={'truncate ' + (tool.status === 'error' ? 'text-danger' : '')} title={tool.name}>{tool.name}{tool.preview ? ' · ' + summary(tool.preview) : ''}</span></div> : null
          }))}
      </div>
    }
    if (item.kind === 'user') return <div key={item.id} className='deck-activity-line' data-activity='user'><User size={13} /><span className='deck-activity-label'>你</span><span className='truncate' title={item.text}>{summary(item.text)}</span></div>
    if (item.kind === 'notice' || item.kind === 'reminder') return <div key={item.id} className='deck-activity-line'><Info size={13} /><span className='truncate'>{summary(item.text)}</span></div>
    return null
  })}</>
}

/** A single live summary while the complete conversation is collapsed. */
export function DeckActivitySummary({ messages, streaming }: { messages: ChatItem[]; streaming: boolean }) {
  let text = streaming ? '正在调度…' : '描述任务，让 Coomi 操作 CLI'
  for (const item of [...messages].reverse()) {
    if (item.kind === 'assistant') {
      const active = item.tools.findLast(tool => tool.status === 'running' || tool.status === 'queued')
      const latest = item.tools.at(-1)
      if (active) text = `${status[active.status]} · ${active.name}`
      else if (item.reasoningStreaming) text = '思考中 · ' + summary(item.reasoning || '')
      else if (item.text) text = 'Coomi · ' + summary(item.text)
      else if (latest) text = `${status[latest.status]} · ${latest.name}`
      else if (item.reasoning) text = '思考 · ' + summary(item.reasoning)
      else continue
      break
    }
    if (item.kind === 'user' || item.kind === 'notice' || item.kind === 'reminder') { text = summary(item.text); break }
  }
  return <span data-deck-summary className='block min-w-0 truncate text-12 text-ink-3' title={text}>{text}</span>
}
