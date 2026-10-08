import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

test('studio cancellation aborts streaming, blocks late events and preserves the next studio', async () => {
  const result = await build({
    stdin: { loader: 'ts', resolveDir: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), contents: `
      import { createPinia, setActivePinia } from 'pinia';
      import { useStudioStore } from './src/stores/studio';
      import { requests, streams } from '@/bridge/http';
      setActivePinia(createPinia()); export { useStudioStore, requests, streams };
    ` }, bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'studio-api', setup(b) {
      b.onResolve({ filter: /^@\/bridge\/http$/ }, () => ({ path: 'http', namespace: 'mock' }))
      b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ loader: 'js', contents: `
        export const requests=[], streams=[];
        export async function apiGet(url) {
          if (url.endsWith('/status')) return { running:false };
          if (url.endsWith('/messages')) return { messages:[] };
          return { studio:{id:url.split('/').pop(),members:[]}, messages:[] };
        }
        export async function apiSend(url) { requests.push(url); return {} }
        export async function authedFetch(url, init) {
          requests.push({url,signal:init.signal});
          const body=new ReadableStream({start(controller){streams.push(controller)},cancel(){}});
          return new Response(body,{status:200});
        }
      ` }))
    } }],
  })
  const { useStudioStore, requests, streams } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  const store = useStudioStore(), encoder = new TextEncoder(), events = []
  await store.fetchStudio('one')
  const first = store.sendMessage('work', e => events.push(e))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.running, true)
  const request = requests.find(r => r.url)
  streams[0].enqueue(encoder.encode('data: {"event_type":"studio_text_delta","content":"before"}\n\n'))
  await new Promise(resolve => setImmediate(resolve))
  store.onToolEvent({ call_id:'t', member_id:'member', event_type:'studio_tool_start' })
  await store.stopRun()
  assert.equal(request.signal.aborted, true)
  assert.equal(store.toolCards[0].status, 'stopped')
  assert.ok(requests.includes('/api/studios/one/stop'))
  streams[0].enqueue(encoder.encode('data: {"event_type":"studio_message","message":{"id":"late"}}\n\n'))
  streams[0].close()
  store.reset()
  await store.fetchStudio('two')
  await first
  assert.equal(store.currentStudio.id, 'two')
  assert.equal(events.length, 1)
  assert.equal(store.messages.length, 0)
  // The SSE decoder must dispatch a final record even without a trailing newline.
  const second = store.sendMessage('second', e => events.push(e))
  await new Promise(resolve => setImmediate(resolve))
  streams[1].enqueue(encoder.encode('data: {"event_type":"studio_end","label":"完成"}'))
  streams[1].close()
  assert.equal(await second, true)
  assert.equal(events.at(-1).label, '完成')
  assert.equal(store.running, false)
})
