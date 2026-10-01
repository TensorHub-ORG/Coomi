const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const probe = (path, ms) => {
    const expr = "(async function(){ try { var t=window.__TAURI__; var inv=(t.core?t.core.invoke:null)||t.invoke; var info=await inv('engine_info'); var started=Date.now(); var ctrl=new AbortController(); var timer=setTimeout(function(){ctrl.abort()}, " + ms + "); var res=await fetch('http://127.0.0.1:'+info.port+'" + path + "',{headers:{Authorization:'Bearer '+info.token},signal:ctrl.signal}); clearTimeout(timer); var txt=await res.text(); return 'HTTP '+res.status+' '+(Date.now()-started)+'ms len='+txt.length; } catch(e){ return 'ERR ' + e.name + ' after ' + (Date.now()-started) + 'ms'; } })()";
    return Promise.race([
      send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r.result.exceptionDetails ? 'EXC' : r.result.result.value),
      new Promise((res) => setTimeout(() => res('EVAL_HUNG'), ms + 6000)),
    ]);
  };
  console.log('running=' + await probe('/api/sessions/running', 8000));
  console.log('sessions30s=' + await probe('/api/sessions', 30000));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
