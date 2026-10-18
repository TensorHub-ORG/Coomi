import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

test('session snapshots survive late restores, background ACKs and engine sequence resets', async () => {
  const memory = new Map()
  globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) }
  globalThis.window = { location: { search: '' } }
  const mocks = {
    '@/bridge': `export const sockets = []; export function createTransport(id) { const t = { id, sent: [], send(v) { this.sent.push(v) }, onStateChange(cb) { this.state = cb }, onMessage(cb) { this.message = cb }, connect() { this.state({state:'open'}) }, close() {} }; sockets.push(t); return t }`,
    '@/bridge/http': `export const requests = new Map(); export async function authedFetch(url) { if (!url.endsWith('/snapshot')) return {ok:true,json:async()=>({sessions:[]})}; return new Promise(resolve => requests.set(url.split('/')[3], data => resolve({ok:true,status:200,json:async()=>data}))) } export async function apiGet() { return {} } export async function apiSend() { return {} }`,
    '@/bridge/demoMode': `export const isDemoMode = () => false`,
    '@/bridge/life': `export const GLOBAL_SESSION_ID = 'global'; export const isGlobalSession = () => false`,
    '@/router': `export const router = {push(){}}`,
    '@/bridge/controlFloat': `export const pushStatus = () => {}; export const pushTrace = () => {}; export const setControlModeActive = () => {}`,
    './config': `export const useConfigStore = () => ({permissionMode:'ask', currentProviderId:'p',currentModel:'m',reasoningEffort:'medium', maxToolRounds:192,async syncStartupPermission(){}})`,
  }
  const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
  const result = await build({ absWorkingDir: root, stdin: { loader: 'ts', resolveDir: root,
    contents: `import {createPinia,setActivePinia} from 'pinia'; import {useSessionStore} from './src/stores/session'; import {sockets} from '@/bridge'; import {requests} from '@/bridge/http'; setActivePinia(createPinia()); export {useSessionStore,sockets,requests};` },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'snapshot-transport', setup(builder) {
      builder.onResolve({filter:/.*/}, args => args.path in mocks ? {path:args.path,namespace:'mock'} : undefined)
      builder.onLoad({filter:/.*/,namespace:'mock'}, args => ({contents:mocks[args.path],loader:'js'}))
    } }],
  })
  const {useSessionStore, sockets, requests} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  globalThis.document = { hidden: false }
  const store = useSessionStore()
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  const snapshot = (events, event_seq, running = false, messages = []) => ({session:{messages,cwd:'/project',usage:{}},events,event_seq,running})
  const first = store.openSession(a)
  const second = store.openSession(b)
  requests.get(b)(snapshot([], 0, false, [{id:'b',role:'assistant',content:'B'}]))
  await second
  requests.get(a)(snapshot([], 0, false, [{id:'a',role:'assistant',content:'stale A'}]))
  await first
  assert.equal(store.sessionId, b)
  assert.equal(store.timeline[0].content, 'B', 'late A must not replace B')

  const socket = sockets.find(s => s.id === a)
  const event = payload => socket.message({type:'event',payload})
  event({event_seq:3,event_type:'text_chunk',content:'hidden'})
  assert.equal(socket.sent.at(-1).command, 'ack_event')
  assert.equal(store.timeline[0].content, 'B')
  const reopening = store.openSession(a)
  event({event_seq:3,event_type:'text_chunk',content:'hello'})
  event({event_seq:4,event_type:'text_chunk',content:' world'})
  event({event_seq:5,event_type:'tool_start',call_id:'tool',tool_name:'write_file',arguments:{path:'a'}})
  event({event_seq:6,event_type:'tool_approval_request',call_id:'tool',tool_name:'write_file',arguments:{path:'a'},access:'write'})
  const journal = [
    {event_seq:1,event_type:'user_message',message_id:'u',content:'task'},
    {event_seq:2,event_type:'reasoning_chunk',content:'thinking'},
    {event_seq:3,event_type:'text_chunk',content:'hello'},
  ]
  requests.get(a)(snapshot(journal, 3, true))
  await reopening
  assert.deepEqual(store.timeline.filter(t => t.kind === 'assistant').map(t => t.content), ['hello world'])
  assert.equal(store.timeline.filter(t => t.kind === 'user').length, 1)
  assert.equal(store.timeline.find(t => t.kind === 'reasoning').content, 'thinking')
  assert.equal(store.pendingApproval.callId, 'tool')
  assert.equal(store.runState, 'awaiting_approval')

  document.hidden = true
  event({event_seq:7,event_type:'tool_done',call_id:'tool',tool_name:'write_file',elapsed:1,result_preview:'ok',is_error:false})
  assert.equal(store.pendingApproval.callId, 'tool')
  document.hidden = false
  store.resumeFromBackground()
  requests.get(a)(snapshot([...journal,
    {event_seq:5,event_type:'tool_start',call_id:'tool',tool_name:'write_file',arguments:{path:'a'}},
    {event_seq:7,event_type:'tool_done',call_id:'tool',tool_name:'write_file',elapsed:1,result_preview:'ok',is_error:false},
    {event_seq:8,event_type:'turn_end'},
  ], 8))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.pendingApproval, undefined)
  assert.equal(store.runState, 'idle')
  assert.equal(store.timeline.find(t => t.kind === 'tool').status, 'success')

  store.resumeFromBackground()
  event({event_seq:2,event_type:'text_chunk',content:' after restart'})
  requests.get(a)(snapshot([{event_seq:1,event_type:'text_chunk',content:'fresh'}], 1, true))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.timeline.find(t => t.kind === 'assistant').content, 'fresh after restart')
  event({event_seq:3,event_type:'assistant_message',message_id:'first',content:'fresh after restart'})
  event({event_seq:4,event_type:'text_chunk',content:'completion check'})
  event({event_seq:5,event_type:'assistant_message',message_id:'second',content:'completion check'})
  assert.deepEqual(store.timeline.filter(t => t.kind === 'assistant').map(t => [t.mid, t.content]),
    [['first','fresh after restart'], ['second','completion check']], 'committed replies must not absorb a later completion check')
  event({event_seq:6,event_type:'reasoning_chunk',content:'partial'})
  assert.equal(store.timeline.findLast(t=>t.kind==='reasoning').streaming,true)
  event({event_seq:7,event_type:'reasoning_end'})
  assert.equal(store.timeline.findLast(t=>t.kind==='reasoning').streaming,false)
  event({event_seq:8,event_type:'stream_reset'})
  assert.equal(store.timeline.filter(t=>t.kind==='assistant').length,2,'retry must keep committed earlier rounds')
  event({event_seq:9,event_type:'compression',before:200,after:50,summary_id:'summary',summary:'handoff'})
  event({event_seq:10,event_type:'compression',before:200,after:50,summary_id:'summary',summary:'handoff'})
  assert.equal(store.timeline.filter(t=>t.id==='compression:summary').length,1)
  assert.equal(store.timeline.find(t=>t.id==='compression:summary').detail,'handoff')
  store.flushPersistence(); store.disconnect()
})
