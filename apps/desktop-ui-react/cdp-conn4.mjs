const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map(); const logs = [];
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') logs.push('[' + m.params.type + '] ' + (m.params.args || []).map((x) => String(x.value ?? x.description ?? '')).join(' ').slice(0, 200));
    if (m.method === 'Runtime.exceptionThrown') logs.push('[exc] ' + String(m.params.exceptionDetails.text || '').slice(0, 160));
  });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC'; return r.result.result.value; };
  const info = await ev("(async function(){ try { var t=window.__TAURI__; var inv=(t.core?t.core.invoke:null)||t.invoke; return JSON.stringify(await inv('engine_info')); } catch(e){ return 'ERR:'+e.message; } })()");
  console.log('INFO=' + info);
  await new Promise((r) => setTimeout(r, 8000));
  console.log('DISCONNECTED=' + String(await ev("document.body.innerText.indexOf('与引擎的连接已断开')>=0")));
  for (const l of logs.slice(-20)) console.log('LOG ' + l);
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
