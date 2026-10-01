const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC') : r.result.result.value; };
  console.log('SID=' + String(await ev("String(window.__sessionDebug.read().sessionId).slice(0,8)")));
  console.log('LEN=' + String(await ev("String(window.__sessionDebug.read().messagesLen)")));
  console.log('TAIL=' + String(await ev("JSON.stringify((window.__sessionDebug.read().messagesTail||[]).map(function(m){return m.kind+':'+String(m.text||'').slice(0,14);}))")));
  console.log('DOM_LAST300=' + JSON.stringify(await ev("document.body.innerText.slice(-300)")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
