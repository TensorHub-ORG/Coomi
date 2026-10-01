const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x, ms) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }),
      new Promise((res) => setTimeout(() => res({ timedOut: true }), ms || 15000)),
    ]);
    if (r.timedOut) return 'HUNG';
    if (r.result && r.result.exceptionDetails) return 'EXC ' + (r.result.exceptionDetails.text || '');
    return r.result.result.value;
  };
  const probe = (path, ms) => ev("(async function(){ try { var t=window.__TAURI__; var inv=(t.core?t.core.invoke:null)||t.invoke; var info=await inv('engine_info'); var started=Date.now(); var ctrl=new AbortController(); var timer=setTimeout(function(){ctrl.abort()}, " + ms + "); var res=await fetch('http://127.0.0.1:'+info.port+'" + path + "',{headers:{Authorization:'Bearer '+info.token},signal:ctrl.signal}); clearTimeout(timer); var txt=await res.text(); return 'HTTP '+res.status+' '+(Date.now()-started)+'ms len='+txt.length; } catch(e){ return 'ERR ' + e.name + ' ' + (e.message||'').slice(0,60); } })()", ms + 4000);
  console.log('restart=' + await ev("(async function(){ try { var t=window.__TAURI__; var inv=(t.core?t.core.invoke:null)||t.invoke; await inv('engine_restart',{source:'diag'}); return 'sent'; } catch(e){ return 'ERR '+(e.message||'').slice(0,80); } })()", 12000));
  await new Promise((r) => setTimeout(r, 4000));
  console.log('health=' + await probe('/api/runtime/health', 5000));
  console.log('sessions=' + await probe('/api/sessions', 5000));
  console.log('prefs=' + await probe('/api/agent/preferences', 5000));
  console.log('health2=' + await probe('/api/runtime/health', 5000));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
