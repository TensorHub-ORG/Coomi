const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? 'EXC' : r.result.result.value; };
  console.log('INFO=' + await ev("(async function(){ var t=window.__TAURI__; var inv=(t.core?t.core.invoke:null)||t.invoke; return JSON.stringify(await inv('engine_info')); })()"));
  console.log('DISC=' + String(await ev("document.body.innerText.indexOf('与引擎的连接已断开')>=0")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
