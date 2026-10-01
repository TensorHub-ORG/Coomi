const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + r.result.exceptionDetails.text; return r.result.result.value; };
  const out = await ev("(function(){ try { var t=document.body.innerText; var chat=document.querySelector('main')||document.body; var rows=chat.querySelectorAll('[data-message-id]').length; return { len:t.length, tail:t.slice(-260), rows:rows }; } catch(e){ return {err:e.message}; } })()");
  console.log(JSON.stringify(out));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
