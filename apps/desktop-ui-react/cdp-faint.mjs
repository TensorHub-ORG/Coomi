/** 验证：正文段落不再有不透明度过渡；回复结束后所有段落 opacity=1。 */
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
console.log('paragraphTransition=' + await ev("(function(){ var p=document.querySelector('.md-body > p'); if(!p) return 'no-paragraph'; return getComputedStyle(p).transitionProperty; })()"));
console.log('newSession=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button,a,[role=button]')); var hit=b.filter(function(x){ var s=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim(); return /新建对话|新对话|新建聊天/.test(s); }); if(!hit.length) return 'miss'; hit[0].click(); return 'ok'; })()"));
await sleep(2500);
await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; ta.focus(); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '分三段回答：第一段说你好，第二段说天气，第三段说再见'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()");
await sleep(300);
console.log('send=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(!b.length) return 'NOBTN'; b[b.length-1].click(); return 'sent'; })()"));
for (let i = 0; i < 40; i += 1) {
  await sleep(1500);
  const stop = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()");
  if (i > 2 && stop === 0) break;
}
await sleep(2500);
const probe = "JSON.stringify((function(){ var out=[]; var bodies=document.querySelectorAll('.md-body'); for (var b=0;b<bodies.length;b++){ var kids=bodies[b].children; for (var k=0;k<kids.length;k++){ var el=kids[k]; var cs=getComputedStyle(el); out.push({ tag: el.tagName.toLowerCase(), op: Math.round(parseFloat(cs.opacity)*100)/100, tp: cs.transitionProperty, text:(el.innerText||'').replace(/\\s+/g,' ').slice(0,16) }); } } return out; })())";
const paras = JSON.parse(await ev(probe) || '[]');
console.log('段落数=' + paras.length);
for (const p of paras) console.log('  ' + p.tag + ' opacity=' + p.op + ' transition=' + JSON.stringify(p.tp) + ' :: ' + JSON.stringify(p.text));
const bad = paras.filter((p) => p.op < 0.99);
console.log(bad.length ? '!! 有段落发淡：' + JSON.stringify(bad) : 'OK 所有段落 opacity=1（正文不可能再发淡）');
ws.close();
