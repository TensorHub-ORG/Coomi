const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result.result.value;
  const msg = '测试消息吞没复现 001';
  const setOk = await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '" + msg + "'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'SET'; })()");
  await new Promise((r) => setTimeout(r, 400));
  const clickOk = await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); var btn=b.length?b[b.length-1]:null; if(!btn) return 'NOBTN'; btn.click(); return 'CLICKED'; })()");
  const snap = async (i) => {
    const val = await ev("(function(){ var t=document.body.innerText; var rows=document.querySelectorAll('[data-message-id], [class*=bubble]'); return { len:t.length, hasSent:t.indexOf('测试消息吞没复现 001')>=0, rows:rows.length, tail:t.slice(-140).replace(/\n/g,' ') }; })()");
    console.log(JSON.stringify({ i: i, set: setOk, click: clickOk, s: val }));
  };
  await new Promise((r) => setTimeout(r, 2000));
  await snap(0);
  for (let i = 1; i <= 25; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const done = await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }); return b.length===0; })()");
    await snap(i);
    if (done) { console.log(JSON.stringify({ done: true, atSec: i * 3 })); break; }
  }
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
