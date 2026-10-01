// 桌面壳 UI 验证工具（CDP）：把 Tauri WebView2 当普通页面驱动，读取真实渲染结果。
//
// 用法：
//   1) 让应用带上远程调试端口启动：
//        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
//        Start-Process 'C:/Program Files/Coomi/coomi-desktop.exe'
//   2) 写一个步骤文件 steps.json：
//        [{"label":"点击设置","expr":"document.querySelector('.nav button').click()"},
//         {"sleep":1000},
//         {"label":"设置页文本","expr":"document.body.innerText"}]
//   3) node apps/desktop/devtools/verify-ui.mjs steps.json
//
// 输出包含每一步的求值结果与页面 console/日志（fetch 失败、CORS 报错都会在这里现形）。
// CDP driver: reads a JSON file of {expr} steps, prints each result.
import { readFileSync } from 'node:fs';
const base='http://127.0.0.1:9222';
let list=[];
for(let i=0;i<25;i++){try{list=await (await fetch(base+'/json/list')).json();if(list.some(t=>t.type==='page'))break;}catch(e){}await new Promise(r=>setTimeout(r,600));}
const page=list.find(t=>t.type==='page');
if(!page){console.log('NO PAGE');process.exit(1);}
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r));
let id=0; const logs=[];
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);
  if(m.method==='Runtime.consoleAPICalled'){logs.push('['+m.params.type+'] '+m.params.args.map(a=>a.value??a.description??a.type).join(' '));}
  if(m.method==='Log.entryAdded'){logs.push('[log:'+m.params.entry.level+'] '+m.params.entry.text);}
  if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;logs.push('[exception] '+(d.exception&&(d.exception.description||d.exception.value)||d.text));}
});
const send=(method,params={})=>new Promise(res=>{const my=++id;const h=ev=>{const m=JSON.parse(ev.data);if(m.id===my){ws.removeEventListener('message',h);res(m);}};ws.addEventListener('message',h);ws.send(JSON.stringify({id:my,method,params}));});
await send('Runtime.enable'); await send('Log.enable');
const ev=async(expr)=>{const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});if(r.result&&r.result.exceptionDetails) return 'EXC: '+JSON.stringify(r.result.exceptionDetails.exception&&r.result.exceptionDetails.exception.description||r.result.exceptionDetails.text);return r.result&&r.result.result?r.result.result.value:JSON.stringify(r);};
const steps=JSON.parse(readFileSync(process.argv[2],'utf8'));
for(const s of steps){
  if(s.sleep) { await new Promise(r=>setTimeout(r,s.sleep)); continue; }
  // 真实键盘输入：某些受控组件只认 CDP 注入的文本，不认 dispatchEvent。
  if(s.focus){ await ev("document.querySelector("+JSON.stringify(s.focus)+")?.focus()"); continue; }
  if(s.insertText){ await send('Input.insertText',{text:s.insertText}); console.log('### insertText'); console.log(s.insertText); continue; }
  if(s.key){ await send('Input.dispatchKeyEvent',{type:'keyDown',key:s.key,code:s.key==='Enter'?'Enter':undefined,windowsVirtualKeyCode:s.key==='Enter'?13:undefined}); await send('Input.dispatchKeyEvent',{type:'keyUp',key:s.key}); console.log('### key '+s.key); continue; }
  const out=await ev(s.expr);
  console.log('### '+(s.label||s.expr).slice(0,120));
  console.log(typeof out==='string'?out:JSON.stringify(out,null,1));
}
if(logs.length){console.log('### CONSOLE');console.log(logs.slice(-40).join('\n'));}
ws.close();process.exit(0);