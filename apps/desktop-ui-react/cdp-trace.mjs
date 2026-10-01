const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC'; return r.result.result.value; };
  const trace = await ev("(function(){ try { var t = window.__coomiTrace || []; return t.slice(-260).map(function(e){ return { t: e.t, s: e.seq, m: e.m }; }); } catch(e){ return null; } })()");
  console.log('TRACE_LEN=' + (Array.isArray(trace) ? trace.length : String(trace)));
  if (Array.isArray(trace)) {
    const kinds = {};
    for (const e of trace) kinds[e.t] = (kinds[e.t] || 0) + 1;
    console.log('KINDS=' + JSON.stringify(kinds));
    // 打印最近 120 条完整
    const recent = trace.slice(-120);
    for (const e of recent) console.log(JSON.stringify(e));
  } else {
    console.log('TRACE=' + String(trace));
  }
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
