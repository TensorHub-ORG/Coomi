const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + (r.result.exceptionDetails.text||''); return r.result.result.value; };
  await new Promise((r) => setTimeout(r, 12000));
  const health = await ev("(async function(){ try { var t=window.__TAURI__; var inv=(t.core?t.core.invoke:null)||t.invoke; var info=await inv('engine_info'); var res=await fetch('http://127.0.0.1:'+info.port+'/api/runtime/health',{headers:{Authorization:'Bearer '+info.token}}); return 'HTTP '+res.status+' port='+info.port; } catch(e){ return 'ERR:'+e.message; } })()");
  console.log('HEALTH=' + String(health));
  const disconn = await ev("document.body.innerText.indexOf('与引擎的连接已断开') >= 0");
  console.log('DISCONNECTED=' + String(disconn));
  const dbg = await ev("(function(){ try { var d=window.__sessionDebug; if(!d) return 'nodbg'; var s=d.read(); return JSON.stringify({ sid: (s.sessionId||'').slice(0,8), hist: s.historyLen, ev: s.eventsLen, streaming: s.streaming }); } catch(e){ return 'ERR'; } })()");
  console.log('DBG=' + String(dbg));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
