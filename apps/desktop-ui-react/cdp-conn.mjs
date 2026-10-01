const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + r.result.exceptionDetails.text; return r.result.result.value; };
  const info = await ev("(async function(){ try { var t=window.__TAURI__; var inv=(t.core?t.core.invoke:null)||t.invoke; var r=await inv('engine_info'); return JSON.stringify(r).slice(0,300); } catch(e){ return 'ERR:'+e.message; } })()");
  console.log('ENGINE_INFO=' + info);
  const body = await ev("(function(){ try { var t=document.body.innerText; return t.slice(-180); } catch(e){ return 'ERR'; } })()");
  console.log('BODY_TAIL=' + String(body).replace(/\n/g,' | '));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
