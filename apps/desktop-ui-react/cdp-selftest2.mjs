const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) return { exc: r.result.exceptionDetails.text || 'Uncaught' };
    return r.result.result.value;
  };
  const msg = '继续，简短回答';
  const probe = "(function(){ var t=document.body.innerText; var rows=document.querySelectorAll('[data-message-id], article').length; return { len:t.length, hasSent:t.indexOf('" + msg + "')>=0, rows:rows, tail:t.slice(-140) }; })()";
  console.log(JSON.stringify({ step: 'ready', nav: await ev("(function(){ return document.body.innerText.slice(0,20); })()") }));
  const typed = await ev("(function(){ try { var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta,'" + msg + "'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'TYPED'; } catch(e){ return 'ERR:'+e.message; } })()");
  await new Promise((r) => setTimeout(r, 300));
  const clicked = await ev("(function(){ try { var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); var btn=b.length?b[b.length-1]:null; if(btn){btn.click(); return 'CLICKED';} return 'NOBTN'; } catch(e){ return 'ERR:'+e.message; } })()");
  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const s = await ev(probe);
    const stop = await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }); return b.length; })()");
    console.log(JSON.stringify({ i: i, typed: typed, clicked: clicked, len: s.len, hasSent: s.hasSent, rows: s.rows, tail: s.tail, stop: stop }));
    if (i > 1 && stop === 0 && s.hasSent) { console.log(JSON.stringify({ RESULT: 'OK_VISIBLE' })); break; }
    if (i > 1 && stop === 0 && !s.hasSent && s.len > 0) { console.log(JSON.stringify({ RESULT: 'SWALLOWED_LIKELY' })); break; }
  }
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
