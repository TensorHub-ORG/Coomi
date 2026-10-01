/** 决定性验证：回读前后条目 id 必须完全不变（变了＝行重挂＝动画重播＝消息变透明）。 */
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error('to ' + m)); }, 9000); pending.set(i, (x) => { clearTimeout(t); r(x); }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC'; return r.result.result.value; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = async () => JSON.parse(await ev("JSON.stringify(window.__sessionDebug.read().messagesTail.map(function(m){return m.kind+'|'+m.id+'|'+(m.msgId?'M':'-');}))") || '[]');
const opacities = async () => JSON.parse(await ev("JSON.stringify([].slice.call(document.querySelectorAll('[data-msg-index]')).map(function(el){ var cs=getComputedStyle(el); var v=null; try{ v=el.checkVisibility({contentVisibilityAuto:true,opacityProperty:true,visibilityProperty:true}); }catch(e){} return { idx: el.getAttribute('data-msg-index'), op: Math.round(parseFloat(cs.opacity)*100)/100, painted: v }; }))") || '[]');
console.log('newSession=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button,a,[role=button]')); var hit=b.filter(function(x){ var s=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim(); return /新建对话|新对话|新建聊天/.test(s); }); if(!hit.length) return 'miss'; hit[0].click(); return 'ok'; })()"));
await sleep(2500);
await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; ta.focus(); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '只回一句话：今天天气不错'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()");
await sleep(300);
console.log('send=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(!b.length) return 'NOBTN'; b[b.length-1].click(); return 'sent'; })()"));
await sleep(1500);
const during = await ids();
console.log('流式中 id = ' + JSON.stringify(during));
for (let i = 0; i < 40; i += 1) {
  await sleep(1000);
  const stop = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()");
  if (i > 2 && stop === 0) break;
}
await sleep(2500);
const after = await ids();
console.log('回读后 id = ' + JSON.stringify(after));
const same = JSON.stringify(during) === JSON.stringify(after);
console.log(same ? 'OK 回读前后 id 完全一致（行不会重挂）' : '!! id 变了：' + JSON.stringify(during) + ' → ' + JSON.stringify(after));
await sleep(1500);
const ops = await opacities();
console.log('结束时各行不透明度：' + JSON.stringify(ops));
const bad = ops.filter((o) => o.op < 0.99 || o.painted === false);
console.log(bad.length ? '!! 异常行：' + JSON.stringify(bad) : 'OK 所有行 opacity=1 且已绘制');
ws.close();
