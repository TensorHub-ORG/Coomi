import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'sucrase'

// Real transport implementation; only the browser/native boundaries are mocked.
const handlers = new Map(), timers = new Map(), calls = [], realSockets = []
let timerId = 0, unblockFirst
const store = new Map()
globalThis.localStorage = {getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)}
globalThis.window = {
  setTimeout:fn=>{timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id),
  __TAURI__:{event:{listen:async(name,fn)=>{handlers.set(name,fn);return()=>handlers.delete(name)}}},
}
const emit=(name,payload)=>handlers.get(name)?.({payload})
globalThis.__testInvoke=async(command,args)=>{
  calls.push({command,...args})
  if(command==='engine_ws_open')emit('engine:ws-open',{session:args.session,connection:args.connection})
  if(command==='engine_ws_send'&&args.frame==='first')await new Promise(resolve=>{unblockFirst=resolve})
}
globalThis.WebSocket=class {
  static OPEN=1
  constructor(){this.readyState=0;realSockets.push(this)}
  close(){this.readyState=3;this.onclose?.()}
  send(){}
}
const source=readFileSync(new URL('../src/lib/engineSocket.ts',import.meta.url),'utf8')
  .replace("import { ipc } from './ipc'",'const ipc=(...args)=>globalThis.__testInvoke(...args)')
const code=transform(source,{transforms:['typescript']}).code
const transport=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()}
const options={url:'ws://unused',port:1,token:'test',sessionId:'session'}
try {
  const direct=transport.createEngineSocket(options)
  const first=realSockets[0]
  first.onerror()
  assert.equal(realSockets.length,2,'one failure retries direct connection')
  const second=realSockets[1]
  first.onclose();first.onopen();first.onmessage({data:'stale'})
  assert.equal(transport.currentTransport(),'direct','stale callbacks do not force IPC fallback')
  second.readyState=1;second.onopen()
  assert.equal(direct.readyState,1,'replacement direct socket opens normally')
  first.onclose()
  assert.equal(direct.readyState,1,'old close does not close replacement socket')
  direct.close()

  const old=transport.createEngineSocket({...options,forceIpc:true})
  await flush()
  const oldConnection=calls.find(call=>call.command==='engine_ws_open').connection
  old.send('first');old.send('second');await flush()
  assert.deepEqual(calls.filter(call=>call.command==='engine_ws_send').map(call=>call.frame),['first'],'IPC sends await earlier frames')
  unblockFirst();await flush()
  assert.deepEqual(calls.filter(call=>call.command==='engine_ws_send').map(call=>call.frame),['first','second'],'IPC frame order is preserved')
  old.close()
  const current=transport.createEngineSocket({...options,forceIpc:true});await flush()
  let closed=0,messages=0
  current.onclose=()=>closed++;current.onmessage=()=>messages++
  emit('engine:ws-closed',{session:'session',connection:oldConnection})
  emit('engine:ws-message',{session:'session',connection:oldConnection,data:'stale'})
  assert.equal(current.readyState,1,'stale bridge close is ignored')
  assert.equal(closed,0);assert.equal(messages,0)
  current.close()
  const count=calls.filter(call=>call.command==='engine_ws_open').length
  const cancelled=transport.createEngineSocket({...options,forceIpc:true});cancelled.close();await flush()
  assert.equal(calls.filter(call=>call.command==='engine_ws_open').length,count,'cancelled listener startup does not open a native bridge')
  console.log('PASS: direct retries, stale callbacks, ordered IPC sends, connection isolation and cancelled startup')
} finally { transport.releaseTransportListeners() }
