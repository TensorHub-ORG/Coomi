import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

test('auxiliary sockets, model selection, timeline and active main session stay isolated', async () => {
  const composer = readFileSync(new URL('../src/components/Composer.vue', import.meta.url), 'utf8')
  const nativeHandlers = composer.slice(composer.indexOf('function onFilesImported('), composer.indexOf('function removeImportedFile('))
  const memory = new Map()
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) }
  globalThis.window = { location: { search: '' } }
  const mocks = {
    '@/bridge': `export const sockets = []; export function createTransport(id) { const t = { id, alive: true, sent: [], send(v) { this.sent.push(v) }, onStateChange(cb) { this.state = cb }, onMessage(cb) { this.message = cb }, connect() { this.state({ state: 'open' }) }, close() { this.alive = false } }; sockets.push(t); return t }`,
    '@/bridge/http': `export const remote = []; export async function authedFetch(url) { return { ok: true, json: async () => url === '/api/sessions' ? { sessions: remote } : { messages: [] } } } export async function apiGet() { return {} } export async function apiSend(url) { const parent = url.split('/')[3]; const id = crypto.randomUUID(); remote.push({ id, parent_session_id: parent, title: '辅助对话', provider_id: 'main-provider', model: 'main-model', updated_at: new Date().toISOString(), created_at: new Date().toISOString() }); return { id } }`,
    '@/bridge/demoMode': `export const isDemoMode = () => false`,
    '@/bridge/life': `export const GLOBAL_SESSION_ID = 'global'; export const isGlobalSession = id => id === GLOBAL_SESSION_ID`,
    '@/bridge/feedback': `export const reportErrorToNative = () => {}; export const sendFeedbackViaBridge = async () => ({})`,
    '@/bridge/tts': `export const speak = () => {}`,
    '@/router': `export const router = { push() {} }`,
    './config': `export const config = { permissionMode: 'ask', currentProviderId: 'main-provider', currentModel: 'main-model', reasoningEffort: 'medium', maxToolRounds: 192, validateAndSelectModel() { throw Error('must not mutate global model') } }; export const useConfigStore = () => config`,
  }
  const result = await build({
    absWorkingDir: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    stdin: { loader: 'ts', contents: `import { createPinia, setActivePinia } from 'pinia'; import { useSessionStore, useAuxiliarySessionStore, completePendingFileTransfer } from './src/stores/session'; import { useSessionsStore } from './src/stores/sessions'; import { sockets } from '@/bridge'; setActivePinia(createPinia()); const session = useSessionStore(); const normalizeAttachments = paths => paths.map(path => ({ path })); const transferText = { value: '' }, transferProgress = { value: 0 }, attachments = { value: [] }; ${nativeHandlers} export { useSessionStore, useAuxiliarySessionStore, useSessionsStore, completePendingFileTransfer, sockets, onFilesImported, onFileExported };`, resolveDir: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'agent-transport', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: 'mock' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
    } }],
  })
  const { useSessionStore, useAuxiliarySessionStore, useSessionsStore, completePendingFileTransfer, sockets, onFilesImported, onFileExported } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  const main = useSessionStore()
  const mainId = main.sessionId
  main.connect()
  const childId = '11111111-1111-4111-8111-111111111111'
  const secondId = '22222222-2222-4222-8222-222222222222'
  const child = useAuxiliarySessionStore(childId)
  const second = useAuxiliarySessionStore(secondId)
  await child.openSession(childId)
  await second.openSession(secondId)
  assert.equal(main.sessionId, mainId)
  assert.equal(memory.get('coomi.activeSessionId.v1'), mainId)
  assert.notEqual(child.timeline, main.timeline)
  assert.notEqual(child.timeline, second.timeline)
  await child.selectModel('child-provider', 'child-model')
  const socket = sockets.find(s => s.id === childId)
  assert.deepEqual(socket.sent.at(-1), { command: 'select_model', provider_id: 'child-provider', model: 'child-model' })
  assert.equal(sockets.find(s => s.id === mainId).sent.some(s => s.model === 'child-model'), false)
  assert.equal(useAuxiliarySessionStore(childId), child, 'reopening reuses the live session')
  socket.message({ type: 'event', payload: { event_type: 'tool_approval_request', call_id: 'tool-1', tool_name: 'write_file', arguments: { path: 'a.txt' }, access: 'write', risk_summary: 'write' } })
  assert.equal(child.pendingApproval.callId, 'tool-1')
  assert.equal(main.pendingApproval, undefined)
  child.approve('tool-1', 'allow')
  assert.equal(socket.sent.at(-1).command, 'approve_tool')
  socket.message({ type: 'event', payload: { event_type: 'user_question_request', call_id: 'question-1', questions: [{ id: 'target', question: 'Which target?', options: [] }] } })
  child.answerQuestion('question-1', { target: 'local' })
  assert.equal(socket.sent.at(-1).command, 'answer_question')
  assert.equal(main.timeline.length, 0)
  socket.message({ type: 'event', payload: { event_type: 'file_transfer_request', operation: 'import', request_id: 'child-file' } })
  onFilesImported(new CustomEvent('coomi:files-imported', { detail: { requestId: 'child-file', paths: ['/tmp/input.txt'] } }))
  assert.deepEqual(socket.sent.at(-1), { command: 'file_transfer_result', request_id: 'child-file', paths: ['/tmp/input.txt'] })
  assert.equal(completePendingFileTransfer('child-file', []), false)
  socket.message({ type: 'event', payload: { event_type: 'file_transfer_request', operation: 'export', request_id: 'child-export', path: '/tmp/output.txt' } })
  onFileExported(new CustomEvent('coomi:file-exported', { detail: { requestId: 'child-export', path: '/tmp/output.txt' } }))
  assert.deepEqual(socket.sent.at(-1), { command: 'file_transfer_result', request_id: 'child-export', paths: ['/tmp/output.txt'] })
  assert.equal(sockets.find(s => s.id === mainId).sent.some(s => s.command === 'file_transfer_result'), false)
  child.cancel()
  assert.equal(socket.sent.at(-1).command, 'cancel')
  assert.equal(sockets.find(s => s.id === secondId).sent.some(s => s.command === 'cancel'), false)
  const sessions = useSessionsStore()
  const created = await sessions.createAuxiliary(mainId)
  assert.equal(sessions.find(created).parentSessionId, mainId, 'creation must survive its immediate engine sync')
  await sessions.syncFromEngine()
  assert.equal(sessions.childrenOf(mainId).some(s => s.id === created), true, 'later refresh must retain the child')
  assert.equal(sessions.filtered.some(s => s.id === created), true, 'auxiliary sessions are visible in history')
  for (const store of [main, child, second]) { store.flushPersistence(); store.disconnect() }
})
