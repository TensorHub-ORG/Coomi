const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC'; return r.result.result.value; };
  await new Promise((r) => setTimeout(r, 4000));
  const t = await ev("(function(){ try { return document.body.innerText.slice(-160).replace(/\n/g,' | '); } catch(e){ return 'ERR'; } })()");
  console.log('BODY_TAIL=' + String(t));
  const disconnected = await ev("document.body.innerText.indexOf('与引擎的连接已断开') >= 0");
  console.log('DISCONNECTED=' + String(disconnected));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
