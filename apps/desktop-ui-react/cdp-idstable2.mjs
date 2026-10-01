const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error('to')); }, 9000); pending.set(i, (x) => { clearTimeout(t); r(x); }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC'; return r.result.result.value; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = async () => JSON.parse(await ev("JSON.stringify(window.__sessionDebug.read().messagesTail.map(function(m){return m.kind+'|'+m.id+'|'+(m.msgId?'M':'-');}))") || '[]');
const probe = async () => JSON.parse(await ev("(function(){ var d=window.__sessionDebug.read(); var rows=[].slice.call(document.querySelectorAll('[data-msg-index]')).map(function(el){ var cs=getComputedStyle(el); var v=null; try{ v=el.checkVisibility({contentVisibilityAuto:true,opacityProperty:true,visibilityProperty:true}); }catch(e){} return { idx: el.getAttribute('data-msg-index'), op: Math.round(parseFloat(cs.opacity)*100)/100, painted: v, text:(el.innerText||'').replace(/\\s+/g,' ').slice(0,14) }; }); return JSON.stringify({ len:d.messagesLen, streaming:d.streaming, rows:rows }); })()") || '{}');
await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; ta.focus(); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '用一句话回答：你叫什么名字'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()");
await sleep(300);
console.log('send=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(!b.length) return 'NOBTN'; b[b.length-1].click(); return 'sent'; })()"));
await sleep(2000);
const during = await ids();
console.log('流式中 id = ' + JSON.stringify(during));
// 等「助手条目出现且不再流式」
for (let i = 0; i < 60; i += 1) {
  await sleep(1500);
  const p = await probe();
  if (!p.streaming && p.rows.length >= 2 && i > 2) break;
}
await sleep(2500);
const after = await ids();
const p = await probe();
console.log('回读后 id = ' + JSON.stringify(after));
console.log('结束时行 = ' + JSON.stringify(p.rows));
console.log(JSON.stringify(during) === JSON.stringify(after) ? 'OK id 稳定（不重挂）' : '!! id 变化');
const bad = p.rows.filter((r) => r.op < 0.99 || r.painted === false);
console.log(bad.length ? '!! 异常行：' + JSON.stringify(bad) : 'OK 所有行 opacity=1 且已绘制（' + p.rows.length + ' 行）');
ws.close();
