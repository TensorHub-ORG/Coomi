import assert from 'node:assert/strict'
import { applyEventsToMessages, itemsFromHistory, splitProcessAnswer } from '../src/lib/chat.ts'

let messages = applyEventsToMessages([{ kind: 'user', id: 'u', text: '执行任务' }], [
  { event_type: 'text_chunk', content: '先检查文件。' },
  { event_type: 'tool_start', call_id: 'c', name: 'shell', arguments: '{}' },
  { event_type: 'tool_done', call_id: 'c', result: 'success: checked', ok: true },
  { event_type: 'text_chunk', content: '最终回' },
], 1)
messages = applyEventsToMessages(messages, [{ event_type: 'assistant_final', content: '最终回复完整。' }], 5)
let item = messages.at(-1)
assert.equal(splitProcessAnswer(item).answer, '最终回复完整。')
assert.equal(item.tools.length, 1)
assert.ok(item.text.includes('先检查文件。'))
messages = applyEventsToMessages(messages, [{ event_type: 'assistant_final', content: '最终回复完整。' }, { event_type: 'turn_end', ok: true }], 6)
item = messages.at(-1)
assert.equal(item.text.match(/最终回复完整。/g).length, 1)
assert.equal(item.streaming, false)
const missingDeltas = applyEventsToMessages([{ kind: 'user', id: 'u', text: '执行任务' }], [{ event_type: 'assistant_final', content: '完整回复' }], 1)
assert.equal(splitProcessAnswer(missingDeltas.at(-1)).answer, '完整回复')
const history = itemsFromHistory([
  { role: 'user', id: 'u', content: '执行任务' },
  { role: 'assistant', id: 'a', content: '先检查文件。', tool_calls: [{ id: 'c', name: 'shell' }] },
  { role: 'tool', tool_call_id: 'c', content: 'success: checked' },
  { role: 'assistant', id: 'final', content: '最终回复完整。' },
])
assert.equal(splitProcessAnswer(history.at(-1)).answer, splitProcessAnswer(item).answer)
assert.equal(history.at(-1).tools.length, item.tools.length)
console.log('OK final answer repair, replay idempotence, process preservation, history parity')
