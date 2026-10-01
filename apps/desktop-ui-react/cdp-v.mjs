const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true }); return r.result.exceptionDetails ? 'EXC' : r.result.result.value; };
  await new Promise((r) => setTimeout(r, 6000));
  console.log('disconnected=' + String(await ev("document.body.innerText.indexOf('与引擎的连接已断开')>=0")));
  console.log('hasComposer=' + String(await ev("!!document.querySelector('textarea')")));
  console.log('body50=' + String(await ev("document.body.innerText.slice(0,50).replace(/\n/g,'|')")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
