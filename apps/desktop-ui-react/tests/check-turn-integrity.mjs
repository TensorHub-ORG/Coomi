import assert from 'node:assert/strict'
import { applyEventsToMessages } from '../src/lib/chat.ts'
const events = [
 {event_type:'text_chunk',content:'正在处理'},
 {event_type:'tool_start',call_id:'c1',tool_name:'write_file'},
 {event_type:'agent_error',message:'connection lost',code:'transport'},
]
const failed = applyEventsToMessages([], [...events,{event_type:'turn_end',ok:false,status:'failed'}])
assert.notEqual(failed.find(x=>x.kind==='assistant').tools[0].status,'done','unfinished tool must not become successful')
assert.notEqual(failed.find(x=>x.kind==='notice').resolved,true,'failure must remain visible')
const reset = applyEventsToMessages([], [...events,{event_type:'stream_reset'},{event_type:'text_chunk',content:'重试正文'}])
const reply = reset.find(x=>x.kind==='assistant')
assert.equal(reply.text,'重试正文')
assert.deepEqual(reply.segments,[{kind:'tools',callIds:['c1']},{kind:'text',text:'重试正文'}],'reset must clear obsolete text without hiding tool execution')
console.log('OK turn integrity: failed tool / visible error / clean stream reset')
