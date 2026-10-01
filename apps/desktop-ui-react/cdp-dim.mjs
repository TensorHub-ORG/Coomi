/** 回复过程中高频采样：行有没有消失、有没有变暗、有没有不被绘制。 */
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
const probe = `(function(){
  var sc = document.querySelector('[data-msg-scroller]');
  var rows = [].slice.call(document.querySelectorAll('[data-msg-index]'));
  var d = window.__sessionDebug.read();
  var out = rows.map(function(el){
    var cs = getComputedStyle(el);
    var vis = null; try { vis = el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }); } catch(e){}
    var rect = el.getBoundingClientRect();
    return { idx: el.getAttribute('data-msg-index'), op: parseFloat(cs.opacity), painted: vis, h: Math.round(rect.height),
             anim: cs.animationName !== 'none' ? cs.animationName : '', text: (el.innerText||'').replace(/\\s+/g,' ').slice(0,16) };
  });
  return JSON.stringify({ len: d.messagesLen, streaming: d.streaming, domRows: rows.length, rows: out,
    scrollTop: sc ? Math.round(sc.scrollTop) : -1, scrollHeight: sc ? Math.round(sc.scrollHeight) : -1, clientHeight: sc ? Math.round(sc.clientHeight) : -1 });
})()`;
console.log('newSession=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button,a,[role=button]')); var hit=b.filter(function(x){ var s=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim(); return /新建对话|新对话|新建聊天/.test(s); }); if(!hit.length) return 'miss'; hit[0].click(); return 'ok'; })()"));
await sleep(2500);
await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; ta.focus(); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '写三句话介绍你自己，每句一行'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()");
await sleep(300);
console.log('send=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(!b.length) return 'NOBTN'; b[b.length-1].click(); return 'sent'; })()"));
let prevSig = '';
for (let i = 0; i < 90; i += 1) {
  await sleep(300);
  const raw = await ev(probe);
  if (typeof raw !== 'string') { console.log('  (probe 失败)'); continue; }
  const d = JSON.parse(raw);
  const sig = d.rows.map((r) => r.idx + ':' + r.op + ':' + r.painted).join(',') + '|len=' + d.len + '|rows=' + d.domRows;
  if (sig !== prevSig) {
    prevSig = sig;
    const bad = d.rows.filter((r) => r.painted === false || r.op < 0.98);
    console.log('t=' + (i * 0.3).toFixed(1) + 's len=' + d.len + ' streaming=' + d.streaming + ' domRows=' + d.domRows + ' scroll=' + d.scrollTop + '/' + (d.scrollHeight - d.clientHeight));
    for (const r of d.rows) {
      const flag = (r.painted === false || r.op < 0.98) ? '   <<<< 异常' : '';
      if (flag || d.rows.length <= 8) console.log('    idx=' + r.idx + ' op=' + r.op + ' painted=' + r.painted + ' h=' + r.h + ' anim=' + JSON.stringify(r.anim) + ' :: ' + JSON.stringify(r.text) + flag);
    }
    if (bad.length) console.log('    ---- 本拍异常行数=' + bad.length);
  }
}
ws.close();
