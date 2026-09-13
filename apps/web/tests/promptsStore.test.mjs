import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

test('prompt refresh waits for writes and queued saves retain both edits', async () => {
  const memory = new Map()
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }
  globalThis.window = { addEventListener() {} }
  const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: `import { createPinia, setActivePinia } from 'pinia'; import { usePromptsStore } from './src/stores/prompts'; import { requests } from '@/bridge/http'; setActivePinia(createPinia()); export { usePromptsStore, requests };`, resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'deferred-http', setup(builder) {
      builder.onResolve({ filter: /^@\/bridge\/http$/ }, args => ({ path: args.path, namespace: 'mock' }))
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `export const requests = []; function request(method, body) { return new Promise((resolve, reject) => requests.push({ method, body, resolve, reject })) } export const apiGet = () => request('GET'); export const apiSend = (_path, method, body) => request(method, body);`, loader: 'js' }))
    } }],
  })
  const { usePromptsStore, requests } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const store = usePromptsStore()
  const initial = store.refresh()
  await settle()
  requests[0].resolve({ prompts: [] })
  await initial
  const first = { id: 'first', title: 'First', content: 'First prompt', tags: [] }
  const second = { id: 'second', title: 'Second', content: 'Second prompt', tags: [] }
  const writing = store.save(first)
  await settle()
  assert.equal(requests[1].method, 'PUT')
  const reopening = store.refresh()
  await settle()
  assert.equal(requests.length, 2, 'reopening must not fetch stale data while PUT is pending')
  assert.equal(store.busy, true)
  requests[1].resolve({})
  assert.equal(await writing, true)
  await settle()
  assert.equal(requests[2].method, 'GET')
  assert.equal(store.busy, true, 'pending refresh must retain busy state after PUT finishes')
  requests[2].resolve({ prompts: [first] })
  await reopening
  assert.equal(store.busy, false)
  const saveSecond = store.save(second)
  const updateFirst = store.save({ ...first, content: 'Updated first' })
  await settle()
  assert.equal(requests.length, 4, 'only one write at a time')
  assert.deepEqual(requests[3].body.prompts.map(p => p.id), ['first', 'second'])
  requests[3].resolve({})
  assert.equal(await saveSecond, true)
  await settle()
  assert.equal(requests.length, 5)
  assert.deepEqual(requests[4].body.prompts.map(p => p.id), ['first', 'second'])
  assert.equal(requests[4].body.prompts[0].content, 'Updated first')
  requests[4].resolve({})
  assert.equal(await updateFirst, true)
  assert.equal(store.busy, false)
  assert.deepEqual(store.custom.map(p => p.id), ['first', 'second'])
})
