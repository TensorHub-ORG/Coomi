const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC ' + (r.result.exceptionDetails.text||'')) : r.result.result.value; };
  console.log('ORIGIN=' + await ev('location.origin'));
  const test = await ev("(async function(){ try { var t=window.__TAURI__; var inv=(t.core?t.core.invoke:null)||t.invoke; var info=await inv('engine_info'); var started=Date.now(); var res=await fetch('http://127.0.0.1:'+info.port+'/api/runtime/health',{headers:{Authorization:'Bearer '+info.token}}); var txt=await res.text(); return 'HTTP '+res.status+' in '+(Date.now()-started)+'ms len='+txt.length; } catch(e){ return 'FETCH_ERR ' + e.name + ' ' + String(e.message).slice(0,120); } })()");
  console.log('PAGE_FETCH=' + test);
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
