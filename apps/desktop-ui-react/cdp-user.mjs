const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC ' + (r.result.exceptionDetails.text||'')) : r.result.result.value; };
  console.log('HAS_DBG=' + String(await ev("typeof window.__sessionDebug")));
  console.log('DOM_TAIL=' + JSON.stringify(await ev("document.body.innerText.slice(-260)")));
  console.log('HAS_USER_HELLO=' + String(await ev("document.body.innerText.indexOf('你好，用一句话介绍你自己')>=0")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
