const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC') : r.result.result.value; };
  console.log('TAILCOUNT=' + String(await ev("(function(){ var s=window.__sessionDebug.read(); return (s.messagesTail||[]).length + ' / len=' + s.messagesLen; })()"));
  console.log('TAILKINDS=' + String(await ev("(function(){ var s=window.__sessionDebug.read(); return JSON.stringify((s.messagesTail||[]).map(function(m){ return m.kind + ':' + String(m.text||'').length + ':' + String(m.text||'').slice(0,18); })); })()"));
  console.log('DOM600=' + JSON.stringify(await ev("document.body.innerText.slice(-600)")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
