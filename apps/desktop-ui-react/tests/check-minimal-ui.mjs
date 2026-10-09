import assert from 'node:assert/strict'
import { toolDisclosure } from '../src/lib/toolDisclosure.ts'
import { cn } from '../src/lib/cn.ts'

const tool = (status = 'done') => ({ callId: '1', name: 'read_file', args: '{}', status })
assert.equal(toolDisclosure([tool()], false, true, null).open, false, 'single successful call starts collapsed')
assert.equal(toolDisclosure([tool('running')], true, true, null).open, false, 'streaming remains compact')
assert.equal(toolDisclosure([tool('queued')], true, true, null).active, true, 'queued tools show activity')
assert.equal(toolDisclosure([tool('error')], false, true, null).open, true, 'errors disclose details automatically')
assert.equal(toolDisclosure([tool('denied')], false, true, null).failed, 1, 'denied calls remain visible failures')
assert.equal(toolDisclosure([tool('running')], true, true, true).open, true, 'user can inspect a live call')
assert.equal(toolDisclosure([tool()], false, true, true).open, true, 'manual expansion survives completion')
assert.equal(toolDisclosure([tool('error')], false, true, false).open, false, 'user may dismiss failure details')
assert.equal(toolDisclosure([tool()], false, false, null).open, true, 'standard mode preserves small groups')
assert.equal(toolDisclosure(Array.from({ length: 4 }, () => tool()), false, false, null).open, false)
assert.equal(toolDisclosure([tool('running')], true, false, false).open, true, 'standard mode preserves active disclosure')
console.log('PASS: 11 tool disclosure checks')
assert.equal(cn('text-white text-12', 'text-13'), 'text-white text-13', 'custom sizes preserve text colors')
assert.equal(cn('text-13 text-ink', 'text-primary'), 'text-13 text-primary', 'colors preserve custom sizes')
console.log('PASS: 2 typography class merge checks')
