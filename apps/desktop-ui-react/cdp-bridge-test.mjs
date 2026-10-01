/** 强制走 IPC 桥，验证聊天是否真的能用（这是给那两台连不上的机器准备的传输）。 */
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {}); await send('Page.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + String(r.result.exceptionDetails.exception?.description||'').slice(0,120); return r.result.result.value; } catch (e) { return 'ERR:' + e.message; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('置传输标记=' + await ev("(function(){ localStorage.setItem('coomi.transport.v1','ipc'); return localStorage.getItem('coomi.transport.v1'); })()"));
await send('Page.reload', { ignoreCache: true });
await sleep(10000);
console.log('传输模式=' + await ev("String(localStorage.getItem('coomi.transport.v1'))"));
console.log('桥提示=' + await ev("(function(){ try { return String(window.__engineBridgeNote || ''); } catch(e){ return ''; } })()"));
console.log('会话状态=' + String(await ev("(function(){ var d=window.__sessionDebug.read(); return JSON.stringify({sid:String(d.sessionId).slice(0,8), len:d.messagesLen, streaming:d.streaming}); })()")));
// 发一条消息，走桥
await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button,a,[role=button]')); var hit=b.filter(function(x){ var s=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim(); return /新建对话|新对话|新建聊天/.test(s); }); if(hit.length) hit[0].click(); return 'ok'; })()");
await sleep(2500);
await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; ta.focus(); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '只回四个字：桥接正常'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()");
await sleep(400);
console.log('发送=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(!b.length) return 'NOBTN'; b[b.length-1].click(); return 'sent'; })()"));
for (let i = 0; i < 30; i += 1) {
  await sleep(2000);
  const st = await ev("(function(){ var d=window.__sessionDebug.read(); var stop=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; return JSON.stringify({s:d.streaming,stop:stop,len:d.messagesLen}); })()");
  try { const o = JSON.parse(st); if (i > 2 && !o.s && o.stop === 0 && o.len >= 2) break; } catch {}
}
await sleep(1500);
console.log('结果=' + String(await ev("(function(){ var d=window.__sessionDebug.read(); return JSON.stringify({len:d.messagesLen, tail:(d.messagesTail||[]).map(function(m){return m.kind+':'+String(m.text||'').replace(/\\s+/g,' ').slice(0,26);})}); })()")));
ws.close();
