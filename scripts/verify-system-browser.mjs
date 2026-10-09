import { spawn } from 'node:child_process'
import { mkdir,writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const profile='G:/DSH/coomi-full-project/backups/browser-system-'+Date.now()
await mkdir(profile,{recursive:true})
const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--disable-gpu','--remote-debugging-port=19614','--user-data-dir='+profile,'--window-size=1280,900','about:blank'],{stdio:'ignore'})
let ws;const pending=new Map();let id=0;const errors=[]
try{
 let page;for(let i=0;i<80;i++){try{const list=await(await fetch('http://127.0.0.1:19614/json')).json();page=list.find(x=>x.type==='page');if(page)break}catch{}await new Promise(r=>setTimeout(r,100))}assert.ok(page,'browser CDP page')
 ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}))
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}if(m.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(m.params.type))console.log('CONSOLE='+m.params.args.map(x=>x.value??x.description).join(' ').slice(0,600));if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text)})
 const send=(method,params={})=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);ws.send(JSON.stringify({id:n,method,params}))})
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value}
 await send('Runtime.enable');await send('Page.enable')
 await send('Page.addScriptToEvaluateOnNewDocument',{source:
  'window.__COOMI_BOOT__={port:19612,token:"e2e-local-token",version:"audit-test"};window.__mockEvents=new Map();window.__TAURI__={core:{invoke:async(cmd,args)=>{if(cmd==="engine_info")return {port:19612,token:"e2e-local-token"};if(cmd==="plugin_list")return [];if(cmd==="desktop_prefs")return {};return null}},event:{listen:async(name,cb)=>{window.__mockEvents.set(name,cb);return ()=>window.__mockEvents.delete(name)}}};localStorage.setItem("coomi.onboarding.v1",JSON.stringify({version:999,acceptedAt:new Date().toISOString()}));'})
 await send('Page.navigate',{url:'http://127.0.0.1:19612/'})
 async function until(expression,label){for(let i=0;i<120;i++){const value=await evaluate(expression);if(value)return value;await new Promise(r=>setTimeout(r,100))}throw Error('UI timeout '+label+' '+await evaluate('document.body.innerText.slice(-1400)'))}
 await until('!!document.querySelector("textarea:not([disabled])")','ready composer')
 await until('!document.body.innerText.includes("正在准备一个新对话")','startup session')
 async function sendText(text){await evaluate('document.querySelector("textarea:not([disabled])").focus()');await send('Input.insertText',{text});await new Promise(r=>setTimeout(r,100));await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})}
 await new Promise(r=>setTimeout(r,3000))
 console.log('TRANSPORT='+JSON.stringify(await evaluate('window.__transportDebug?.()')))
 const marker='browser-visible-'+Date.now()
 await sendText(marker)
 console.log('INPUT_STATE='+JSON.stringify(await evaluate('({value:document.querySelector("textarea")?.value,active:document.activeElement?.tagName,buttons:[...document.querySelectorAll("button")].filter(x=>x.getAttribute("aria-label")?.includes("发送")).map(x=>({label:x.getAttribute("aria-label"),disabled:x.disabled})),errors:'+JSON.stringify(errors)+'})')))
 await until('document.body.innerText.includes('+JSON.stringify('RESULT:'+marker+'-END')+')','visible completed answer')
 await until('!!document.querySelector("button[aria-label=发送]") && !document.querySelector("button[aria-label=停止生成]")','completed task idle')
 const counts=await evaluate('({users:[...document.querySelectorAll("[data-msg-index]")].filter(x=>x.innerText.split("\\n")[0].trim()==='+JSON.stringify(marker)+').length,answers:[...document.querySelectorAll("[data-msg-index]")].filter(x=>x.innerText.includes('+JSON.stringify('RESULT:'+marker+'-END')+')).length})')
 console.log('ROWS='+JSON.stringify(await evaluate('[...document.querySelectorAll("[data-msg-index]")].map(x=>x.innerText.slice(0,200))')))
 assert.equal(counts.users,1,'one user row for this request')
 assert.equal(counts.answers,1,'one answer row for this request')
 await until('window.__mockEvents.has("tauri://drag-drop")','native drop listener')
 const drop=await evaluate('(()=>{const cb=window.__mockEvents.get("tauri://drag-drop");cb({payload:{paths:["C:/测试/附件.txt"]}});return true})()')
 assert.ok(drop);await until('document.body.innerText.includes("附件.txt")','attachment chip')
 await evaluate('document.querySelector("[data-effort-picker]").click()')
 await until('!!document.querySelector("[data-effort-slider]")','effort popover')
 await until('document.body.innerText.includes("自动：不发送强度覆盖")||document.body.innerText.includes("将发送")','truthful effort status')
 const probe=await evaluate('({overflow:document.documentElement.scrollWidth>innerWidth+1,body:document.body.innerText.slice(-1800),events:[...window.__mockEvents.keys()]})')
 assert.equal(probe.overflow,false,'no horizontal overflow')
 assert.equal(errors.length,0,'no runtime exceptions '+JSON.stringify(errors))
 const shot=await send('Page.captureScreenshot',{format:'png'});if(shot.result?.data)await writeFile(profile+'/acceptance.png',Buffer.from(shot.result.data,'base64'))
 console.log(JSON.stringify({ok:true,profile,checks:['built UI startup','completed answer visible','native event attachment chip (mock shell)','truthful effort mapping','no horizontal overflow','no runtime exceptions']}))
}catch(e){console.error(e.stack);process.exitCode=1}finally{ws?.close();browser.kill()}
