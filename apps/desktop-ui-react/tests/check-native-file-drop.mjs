import assert from 'node:assert/strict'
const listeners = new Map()
globalThis.window = { __TAURI__: { event: { listen: async (name, callback) => {
  listeners.set(name, callback)
  return () => listeners.delete(name)
} } } }
const { subscribeNativeFileDrop } = await import('../src/lib/nativeFileDrop.ts')
let selected = 'a'
const calls = []
const offA = subscribeNativeFileDrop({active:()=>selected==='a',hover:()=>{},drop:paths=>calls.push(['a',paths])})
const offB = subscribeNativeFileDrop({active:()=>selected==='b',hover:()=>{},drop:paths=>calls.push(['b',paths])})
await Promise.resolve()
assert.equal(listeners.size,4,'native event subscriptions must not multiply per composer')
listeners.get('tauri://drag-drop')({payload:{paths:['C:/文档/a.txt','C:/文档/a.txt']}})
assert.deepEqual(calls,[['a',['C:/文档/a.txt']]])
selected='b'
listeners.get('tauri://drag-drop')({payload:{paths:['C:/b.png']}})
assert.deepEqual(calls[1],['b',['C:/b.png']])
selected='settings'
listeners.get('tauri://drag-drop')({payload:{paths:['C:/bad.png']}})
assert.equal(calls.length,2,'hidden composers must not accept drops')
offA();offB()
assert.equal(listeners.size,0)
console.log('OK native drop: single listeners / active target / dedup / cleanup')
