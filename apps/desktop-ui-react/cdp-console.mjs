const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map(); const logs = [];
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = (m.params.args || []).map((x) => String(x.value ?? x.description ?? '')).join(' ');
      logs.push('[' + m.params.type + '] ' + a.slice(0, 220));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + String(m.params.exceptionDetails.text || '').slice(0, 200));
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable', {});
  await new Promise((r) => setTimeout(r, 9000));
  console.log('LOGS=' + logs.length);
  for (const l of logs.slice(-25)) console.log(l);
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
