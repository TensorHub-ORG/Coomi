const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error('to ' + m)); }, 8000); pending.set(i, (x) => { clearTimeout(t); r(x); }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + String(r.result.exceptionDetails.exception?.description||'').slice(0,140); return r.result.result.value; } catch (e) { return 'ERR:' + e.message; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('newSession=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button,a,[role=button]')); var hit=b.filter(function(x){ var s=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim(); return /新建对话|新对话|新建聊天/.test(s); }); if(!hit.length) return 'miss'; hit[0].click(); return 'ok'; })()"));
await sleep(2500);
await ev("(function(){ window.__coomiTrace && (window.__coomiTrace.length = 0); return 1; })()");
const TEXT = '请原样重复这串字符，不要加任何解释：甲乙丙丁戊己庚辛壬癸子丑寅卯';
await ev("(function(){ var ta=document.querySelector('textarea'); ta.focus(); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, " + JSON.stringify(TEXT) + "); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()");
await sleep(400);
console.log('send=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(!b.length) return 'NOBTN'; b[b.length-1].click(); return 'sent'; })()"));
for (let i = 0; i < 25; i += 1) {
  await sleep(2000);
  const stop = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()");
  if (i > 1 && stop === 0) break;
}
await sleep(800);
const trace = await ev("JSON.stringify((window.__coomiTrace||[]).filter(function(x){return x.t==='text_chunk'||x.t==='reasoning_chunk'||x.t==='turn_end';}))");
let arr = []; try { arr = JSON.parse(trace); } catch {}
console.log('事件条数=' + arr.length + ' text_chunk=' + arr.filter(x=>x.t==='text_chunk').length);
arr.slice(0, 60).forEach((x, i) => console.log('  ' + i + ' ' + x.t + ' seq=' + x.seq + ' :: ' + JSON.stringify(x.m)));
const d = JSON.parse(await ev('JSON.stringify(window.__sessionDebug.read())'));
console.log('前端本地条目:');
for (const m of d.messagesTail) console.log('  ' + m.kind + ' id=' + String(m.id).slice(0,12) + ' msgId=' + (m.msgId?'有':'无') + ' :: ' + JSON.stringify(String(m.text||'').slice(0,140)));
ws.close();
