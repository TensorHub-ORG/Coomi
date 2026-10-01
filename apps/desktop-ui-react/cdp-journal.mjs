// 消息流水账探针：发一条独特消息 → 等跑完 → 打印 journal（尤其 SHRINK）+ DOM 气泡计数。
const TOKEN = 'ZQ7TEST';
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /index\.html|localhost|tauri/i.test(t.url || '')) || list.find((t) => t.type === 'page');
if (!page) { console.log('NO_PAGE ' + JSON.stringify(list.map((t) => t.url))); process.exit(0); }
console.log('PAGE ' + page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || '').slice(0, 200);
  return r.result.result.value;
};
console.log('hasDebug=' + await ev('String(!!window.__sessionDebug && typeof window.__sessionDebug.journal)'));
await ev("window.__sessionDebug && window.__sessionDebug.clearJournal && window.__sessionDebug.clearJournal(); 1");
await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '" + TOKEN + "'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()");
await new Promise((r) => setTimeout(r, 400));
const clicked = await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(!b.length) return 'NOBTN'; b[b.length-1].click(); return 'sent'; })()");
console.log('send=' + clicked);
for (let i = 0; i < 24; i += 1) {
  await new Promise((r) => setTimeout(r, 2500));
  const stop = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()");
  if (i > 1 && stop === 0) break;
}
await new Promise((r) => setTimeout(r, 2500));
const read = await ev("JSON.stringify(window.__sessionDebug.read()).slice(0,0) || 'skip'");
console.log('len=' + await ev('String(window.__sessionDebug.read().messagesLen)'));
console.log('tail=' + await ev("JSON.stringify((window.__sessionDebug.read().messagesTail||[]).map(function(m){return m.kind+':'+String(m.text||'').slice(0,12);}))"));
console.log('domBubbles=' + await ev("(function(){ var s='" + TOKEN + "'; var n=0; var all=document.querySelectorAll('*'); for (var i=0;i<all.length;i++){ var el=all[i]; if (el.children.length===0 && (el.textContent||'').trim()===s) n++; } return n; })()"));
const jr = await ev("JSON.stringify((window.__sessionDebug.journal?window.__sessionDebug.journal():[]).filter(function(e){return e.phase==='SHRINK'||e.phase==='readback';}).slice(-24))");
console.log('journal=' + jr);
ws.close();
