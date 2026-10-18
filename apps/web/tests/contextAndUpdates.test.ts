import assert from 'node:assert/strict'
import test from 'node:test'
import { contextSegments, formatDurationMs } from '../src/utils/contextUsage.ts'
import { splitUpdateNotes } from '../src/utils/updateNotes.ts'

test('context ring uses capacity, finite values and fixed category colors', () => {
  const segments = contextSegments(250,1000,{messages:100,system_tools:100})
  assert.equal(segments.reduce((s,x)=>s+x.ratio,0),.25)
  assert.equal(segments.find(s=>s.key==='messages')?.share,.5)
  assert.equal(contextSegments(9000,100,{messages:1}).reduce((s,x)=>s+x.ratio,0),1)
  assert.equal(contextSegments(10,0,{messages:NaN}).reduce((s,x)=>s+x.ratio,0),0)
  assert.equal(contextSegments(20,100,{}).find(s=>s.key==='other')?.ratio,.2)
  assert.deepEqual(contextSegments(10,100,{messages:1}).map(s=>s.color),contextSegments(10,100,{system_tools:99}).map(s=>s.color))
  assert.equal(formatDurationMs(12000),'12.0s'); assert.equal(formatDurationMs(12),'12ms'); assert.equal(formatDurationMs(NaN),'--')
})
test('both markdown and plain version titles split into latest and folded history', () => {
  const sections = splitUpdateNotes('# v1.5.0-test.4 更新说明【测试】\nnew\n\n## v1.5.0-test.1 更新说明【测试】\nold\nv1.4.9 更新说明【稳定】\nolder')
  assert.equal(sections.length,3)
  assert.match(sections[0],/test.4/); assert.doesNotMatch(sections[0],/test.1/)
  assert.equal(splitUpdateNotes('intro\n# v1.5.0 更新说明【测试】\nnew\n# v1.4.9 更新说明【测试】\nold').length,2)
  assert.deepEqual(splitUpdateNotes(''),[])
})
