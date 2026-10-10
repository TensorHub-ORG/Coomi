import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const root='G:/DSH/coomi-full-project'
const home=root+'/backups/e2e-system-'+Date.now()
await mkdir(home+'/config',{recursive:true})
await mkdir(home+'/workspace',{recursive:true})
const requests=[]
const server=createServer(async(req,res)=>{
 let raw=''; for await(const chunk of req)raw+=chunk
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model',context_length:65536,max_output_tokens:8192,supports_vision:true,reasoning_efforts:['low','high']}]}));return}
 const body=JSON.parse(raw||'{}');requests.push(body)
 const users=(body.messages||[]).filter(m=>m.role==='user')
 const rawQuery=String(users.at(-1)?.content||''); const query=['parallel-A','parallel-B','slow-check','tool-check','truncate-check','reject-reasoning'].find(marker=>rawQuery.includes(marker))||rawQuery
 const hasTool=body.messages?.at(-1)?.role==='tool'
 if(query.includes('reject-reasoning')&&body.reasoning_effort){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'unknown field reasoning_effort'}}));return}
 if(query.includes('tool-check')&&!hasTool){
  const delta={tool_calls:[{index:0,id:'read-'+randomUUID(),type:'function',function:{name:'read_file',arguments:JSON.stringify({path:home+'/workspace/probe.txt'})}}]}
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');return
 }
 res.writeHead(200,{'Content-Type':'text/event-stream'})
 const chunks=[query.includes('truncate-check')?'PARTIAL-OUTPUT':'RESULT:'+query.slice(-80),'-END']
 for(const part of chunks){res.write('data: '+JSON.stringify({choices:[{delta:{content:part},finish_reason:null}]})+'\n\n');await new Promise(r=>setTimeout(r,query.includes('slow-check')?600:90))}
 res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:query.includes('truncate-check')?'length':'stop'}],usage:{prompt_tokens:100,completion_tokens:5}})+'\n\ndata: [DONE]\n\n')
})
await new Promise(r=>server.listen(19611,'127.0.0.1',r))
await writeFile(home+'/workspace/probe.txt','file-tool-readable')
await writeFile(home+'/config/providers.json',JSON.stringify({active:'test',providers:{test:{type:'openai',base_url:'http://127.0.0.1:19611/v1',model:'test-model',context_window:65536,supports_native_tools:true,modelParameters:{'test-model':{max_output_tokens:4096}}}}}))
await writeFile(home+'/config/settings.json',JSON.stringify({reasoning_effort:'high',provider_retry_count:0,skillOnDemand:false,globalMemory:false}))
const engine=spawn(process.env.COOMI_TEST_EXE||root+'/apps/coomi-rs/target/debug/coomi.exe',['--home',home,'--cwd',home+'/workspace','--policy','full-access','serve','--port','19612','--token','e2e-local-token','--static-dir',root+'/apps/desktop-ui-react/dist'],{stdio:'ignore'})
let failed=false
const clients=[]
async function api(path,init={}){const res=await fetch('http://127.0.0.1:19612'+path,{...init,headers:{Authorization:'Bearer e2e-local-token','Content-Type':'application/json',...(init.headers||{})}});assert.ok(res.ok,'API '+path+' HTTP '+res.status);return res.json()}
function connect(id){return new Promise((resolve,reject)=>{const ws=new WebSocket('ws://127.0.0.1:19612/ws/session/'+id+'?token=e2e-local-token');const events=[];ws.addEventListener('message',e=>{const frame=JSON.parse(e.data);events.push(frame)});ws.addEventListener('error',reject,{once:true});ws.addEventListener('open',()=>resolve({ws,events}),{once:true});clients.push(ws)})}
async function waitEnd(client,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const event=client.events.find(x=>x.payload?.event_type==='turn_end');if(event)return event.payload;await new Promise(r=>setTimeout(r,50))}throw Error('turn end timeout '+JSON.stringify(client.events.slice(-5)))}
try{
 for(let i=0;i<100;i++){try{await api('/api/runtime/health');break}catch{if(i===99)throw Error('engine health timeout');await new Promise(r=>setTimeout(r,200))}}
 if(process.env.COOMI_TEST_HOLD==='1'){console.log(JSON.stringify({ready:true,home,url:'http://127.0.0.1:19612'}));await new Promise(()=>{})}
 const discovery=await api('/api/providers/discover-models-preview',{method:'POST',body:JSON.stringify({type:'openai_compatible',baseUrl:'http://127.0.0.1:19611/v1'})});assert.equal(discovery.metadata['test-model'].contextWindow,65536);assert.equal(discovery.metadata['test-model'].maxOutputTokens,8192);assert.deepEqual(discovery.metadata['test-model'].reasoningEfforts,['low','high']);
 await api('/api/settings/mcp',{method:'PUT',body:JSON.stringify({servers:{probe:{enabled:false,command:'node',args:['--version'],env:{TEST:'1'},cwd:home+'/workspace'}}})});const mcp=await api('/api/settings/mcp');assert.deepEqual(mcp.servers.probe.args,['--version']);
 const a=await connect(randomUUID()),b=await connect(randomUUID())
 a.ws.send(JSON.stringify({id:randomUUID(),payload:{command:'send_message',text:'parallel-A'}}))
 b.ws.send(JSON.stringify({id:randomUUID(),payload:{command:'send_message',text:'parallel-B'}}))
 assert.equal((await waitEnd(a)).ok,true);assert.equal((await waitEnd(b)).ok,true)
 const text=c=>c.events.filter(x=>x.payload?.event_type==='text_chunk').map(x=>x.payload.content).join('')
 assert.ok(text(a).includes('parallel-A'));assert.ok(!text(a).includes('parallel-B'));assert.ok(text(b).includes('parallel-B'))
 const sid=randomUUID(), dropped=await connect(sid)
 dropped.ws.send(JSON.stringify({payload:{command:'send_message',text:'slow-check'}}))
 const deadline=Date.now()+8000
 while(!text(dropped)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30))
 assert.ok(text(dropped),'must receive first delta before disconnect')
 dropped.ws.close()
 await new Promise(r=>setTimeout(r,100))
 const recovered=await connect(sid)
 const done=await waitEnd(recovered)
 assert.equal(done.ok,true,'disconnect must not cancel engine task')
 assert.ok(text(recovered).includes('-END'),'new socket must receive tail')
 const beforeResume=requests.length
 recovered.events.length=0
 const cmd={id:'resume-once',payload:{command:'retry_turn'}}
 recovered.ws.send(JSON.stringify(cmd));recovered.ws.send(JSON.stringify(cmd))
 assert.equal((await waitEnd(recovered)).ok,true)
 assert.equal(requests.length,beforeResume+1,'duplicate resume must not create a second worker')
 recovered.ws.send(JSON.stringify(cmd));await new Promise(r=>setTimeout(r,250));assert.equal(requests.length,beforeResume+1,'completed resume id must not run again')
 const tool=await connect(randomUUID());tool.ws.send(JSON.stringify({payload:{command:'send_message',text:'tool-check'}}));assert.equal((await waitEnd(tool)).ok,true);assert.ok(tool.events.some(x=>x.payload?.event_type==='tool_done'))
 const truncated=await connect(randomUUID());truncated.ws.send(JSON.stringify({payload:{command:'send_message',text:'truncate-check'}}));assert.equal((await waitEnd(truncated)).ok,false);assert.ok(text(truncated).includes('PARTIAL-OUTPUT'))
 const retry=await connect(randomUUID());retry.ws.send(JSON.stringify({payload:{command:'send_message',text:'reject-reasoning'}}));assert.equal((await waitEnd(retry)).ok,true)
 const relevant=requests.filter(x=>x.messages?.some(m=>m.role==='user'&&String(m.content).includes('reject-reasoning')));assert.ok(relevant.length>=2);assert.ok(relevant.every(x=>x.tools?.length),'fallback must retain tools')
 console.log(JSON.stringify({ok:true,home,checks:['parallel sessions','disconnect survives and replays','duplicate resume worker guard','real read_file','truncation visible','parameter fallback preserves tools'],requests:requests.length}))
}catch(e){failed=true;console.error(e.stack)}finally{for(const ws of clients)ws.close();engine.kill();server.close()}
process.exit(failed?1:0)
