const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || '').slice(0, 120); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('scripts=' + await ev("JSON.stringify([].slice.call(document.querySelectorAll('script[src]')).map(function(s){return s.src.split('/').pop();}))"));
console.log('hasJournal=' + await ev('String(!!window.__sessionDebug && typeof window.__sessionDebug.journal)'));
console.log('appVersion=' + await ev("(async function(){ try { return await window.__TAURI__.app.getVersion(); } catch(e) { return 'ERR:'+String(e&&e.message||e).slice(0,80); } })()"));
// 进设置 → 关于，读渲染出来的版本号
const clickText = async (t) => ev("(function(){ var all=[].slice.call(document.querySelectorAll('button,a,[role=tab],[role=button],div,span')); var hit=null; for (var i=0;i<all.length;i++){ var el=all[i]; if (el.children.length===0 && (el.textContent||'').trim()===decodeURIComponent('" + encodeURIComponent(t) + "')) { hit=el; } } if(!hit) return 'miss'; hit.click(); return 'ok'; })()");
console.log('clickSettings=' + await clickText('设置'));
await sleep(1200);
console.log('clickAbout=' + await clickText('关于'));
await sleep(1200);
console.log('aboutText=' + await ev("(function(){ var t=document.body.innerText||''; var m=t.match(/0\\.9\\.9-rc\\d+/g); return JSON.stringify({hits:m, hasClient:/客户端版本/.test(t), hasUndef:/undefined/.test(t)}); })()"));
for (let i = 0; i < 10; i += 1) {
  await sleep(1500);
  const stop = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()");
  if (i > 1 && stop === 0) break;
}
console.log('len=' + await ev('String(window.__sessionDebug.read().messagesLen)'));
console.log('shrinks=' + await ev("JSON.stringify((window.__sessionDebug.journal()||[]).filter(function(e){return e.phase==='SHRINK';}))"));
ws.close();
