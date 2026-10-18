import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RecoveryEvents } from '../src/utils/sessionRecovery.ts'

test('snapshot watermark excludes acknowledged duplicates while preserving later deltas', () => {
  const events = new RecoveryEvents<{ event_seq: number; content: string }>()
  events.push({ event_seq: 10, content: 'already in snapshot' })
  events.push({ event_seq: 12, content: 'b' })
  events.push({ event_seq: 11, content: 'a' })
  events.push({ event_seq: 11, content: 'duplicate' })
  assert.deepEqual(events.after(10).map(event => event.content), ['a', 'b'])
  assert.deepEqual(events.after(12), [])
})

test('both byte and event limits require a new snapshot', () => {
  const count = new RecoveryEvents(1)
  count.push({ event_seq: 1 }); count.push({ event_seq: 2 })
  assert.equal(count.overflow, true)
  assert.deepEqual(count.after(0), [])
  const bytes = new RecoveryEvents(100, 10)
  bytes.push({ event_seq: 1 })
  assert.equal(bytes.overflow, true)
})
