/** 实验：用户消息发出后，引擎在多快的时间里把它落库？回读期间会不会读到「没有这条消息」的历史？ */
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error('to ' + m)); }, 10000); pending.set(i, (x) => { clearTimeout(t); r(x); }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + String(r.result.exceptionDetails.exception?.description||'').slice(0,160); return r.result.result.value; } catch (e) { return 'ERR:' + e.message; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 拿引擎 port/token
console.log('info=' + await ev("(async function(){ try { var i = await window.__TAURI__.core.invoke('engine_info'); window.__einfo = i; return JSON.stringify({port:i.port, hasToken:!!i.token}); } catch(e) { return 'ERR:'+String(e&&e.message||e).slice(0,80); } })()"));

// 2) 新会话 + 发一条独特消息
console.log('newSession=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button,a,[role=button]')); var hit=b.filter(function(x){ var s=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim(); return /新建对话|新对话|新建聊天/.test(s); }); if(!hit.length) return 'miss'; hit[0].click(); return 'ok'; })()"));
await sleep(2500);
const TOKEN = 'PERSIST' + Math.floor(Math.random() * 900 + 100);
await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; ta.focus(); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, " + JSON.stringify(TOKEN) + "); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()");
await sleep(300);
const sid = await ev('String(window.__sessionDebug.read().sessionId)');
console.log('sid=' + sid);
console.log('send=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(!b.length) return 'NOBTN'; b[b.length-1].click(); return 'sent'; })()"));

const probe = async (tag) => {
  const out = await ev("(async function(){ try { var i = window.__einfo; var r = await fetch('http://127.0.0.1:'+i.port+'/api/sessions/'+'" + sid + "', { headers: { Authorization: 'Bearer '+i.token } }); var j = await r.json(); var ms = j.messages || []; var has = ms.some(function(m){ return String(m.content||'').indexOf('" + TOKEN + "') >= 0; }); var lastText = ms.length ? String((ms[ms.length-1].content||'')).replace(/\\s+/g,' ').slice(0,40) : ''; return JSON.stringify({status:r.status, n:ms.length, hasToken:has, lastText:lastText}); } catch(e) { return 'ERR:'+String(e&&e.message||e).slice(0,120); } })()");
  console.log('  ' + tag + ' :: ' + out);
};
await sleep(250);
await probe('t+0.25s');
await sleep(750);
await probe('t+1.0s');
await sleep(1500);
await probe('t+2.5s');
await sleep(2500);
await probe('t+5.0s');
console.log('frontend=' + await ev("JSON.stringify(window.__sessionDebug.read().messagesTail.map(function(m){return m.kind+':'+String(m.text||'').slice(0,20);}))"));
ws.close();
