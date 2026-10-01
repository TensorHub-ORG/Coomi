const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) return 'EXC:' + (r.result.exceptionDetails.text || r.result.exceptionDetails.exception?.description || '');
    const v = r.result.result.value;
    if (v && typeof v === 'object' && v.__proto__ && v.__proto__.constructor && v.__proto__.constructor.name === 'Promise') return 'PROMISE?';
    return v;
  };
  console.log(JSON.stringify({ two: await ev('2+2') }));
  console.log(JSON.stringify({ ready: await ev('document.readyState') }));
  console.log(JSON.stringify({ bodyHead: String(await ev('(function(){ try { return document.body ? document.body.innerText.slice(0,150) : "NOBODY"; } catch(e){ return "ERR:"+e.message; } })()')).slice(0,220) }));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
