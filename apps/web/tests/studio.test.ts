import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('studio list view renders create button and empty state', async () => {
  const src = await readFile(new URL('../src/views/StudioListView.vue', import.meta.url), 'utf8')
  assert.match(src, /新建工作室/)
  assert.match(src, /还没有工作室/)
  assert.match(src, /创建一个工作室/)
})

test('studio editor renders member management', async () => {
  const src = await readFile(new URL('../src/views/StudioEditorView.vue', import.meta.url), 'utf8')
  assert.match(src, /添加成员/)
  assert.match(src, /主持人/)
  assert.match(src, /工具权限/)
  assert.match(src, /保存工作室/)
})

test('studio chat renders member strip and work board entry', async () => {
  const src = await readFile(new URL('../src/views/StudioChatView.vue', import.meta.url), 'utf8')
  assert.match(src, /@成员/)
  assert.match(src, /工单看板/)
  assert.match(src, /开始对话吧/)
})

test('studio member strip renders status indicators', async () => {
  const src = await readFile(new URL('../src/components/StudioMemberStrip.vue', import.meta.url), 'utf8')
  assert.match(src, /待机/)
  assert.match(src, /思考/)
  assert.match(src, /执行/)
  assert.match(src, /主持/)
})

test('studio work board renders five status columns', async () => {
  const src = await readFile(new URL('../src/components/StudioWorkBoard.vue', import.meta.url), 'utf8')
  assert.match(src, /待处理/)
  assert.match(src, /进行中/)
  assert.match(src, /待验收/)
  assert.match(src, /完成/)
  assert.match(src, /失败/)
})

test('studio routes registered in router', async () => {
  const src = await readFile(new URL('../src/router/index.ts', import.meta.url), 'utf8')
  assert.match(src, /path:\s*'\/studio'/)
  assert.match(src, /path:\s*'\/studio\/new'/)
  assert.match(src, /path:\s*'\/studio\/:id\/edit'/)
  assert.match(src, /path:\s*'\/studio\/:id\/chat'/)
})
