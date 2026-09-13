import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePrompts, savePrompt, BUILTIN_PROMPTS, type SavedPrompt } from '../src/utils/promptLibrary.ts'

test('corrupted storage never hides built-in prompts', () => {
  assert.deepEqual(parsePrompts('{broken'), [])
  assert.ok(BUILTIN_PROMPTS.length >= 4)
})
test('custom prompts validate required fields, trim and de-duplicate category tags', () => {
  assert.throws(() => savePrompt([], { id: 'a', title: ' ', content: 'text', tags: [] }))
  const result = savePrompt([], { id: 'a', title: ' Review ', content: ' Check code ', tags: [' Code ', 'Code', ''] })
  assert.deepEqual(result, [{ id: 'a', title: 'Review', content: 'Check code', tags: ['Code'] }])
})
test('editing updates only selected custom prompt and survives persistence', () => {
  const original: SavedPrompt[] = [{ id: 'a', title: 'A', content: 'one', tags: [] }, { id: 'b', title: 'B', content: 'two', tags: ['code'] }]
  const changed = savePrompt(original, { ...original[0], content: 'updated' })
  assert.equal(original[0].content, 'one')
  assert.deepEqual(parsePrompts(JSON.stringify(changed)), changed)
  assert.equal(changed[1].content, 'two')
})
test('storage excludes malformed entries and duplicate identifiers', () => {
  assert.deepEqual(parsePrompts(JSON.stringify([{ id: 'x', title: 'X', content: 'text', tags: [] }, { id: 'x', title: 'duplicate', content: 'text', tags: [] }, { id: 'bad' }])), [{ id: 'x', title: 'X', content: 'text', tags: [] }])
})
