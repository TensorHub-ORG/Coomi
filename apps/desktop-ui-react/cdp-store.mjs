const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC ' + (r.result.exceptionDetails.text||'')) : r.result.result.value; };
  console.log('DBG_KEYS=' + String(await ev("(function(){ try { var s=window.__sessionDebug.read(); return JSON.stringify(Object.keys(s)); } catch(e){ return 'ERR '+e.message; } })()")));
  const tailExpr = "(function(){ try { var s=window.__sessionDebug.read(); var list = s.messages || s.messageTail || null; if(!list) return 'NO_MESSAGES_FIELD'; var t = list.slice(-6).map(function(m){ return { k: m.kind, len: (m.text||'').length, head: String(m.text||'').slice(0,24) }; }); return JSON.stringify(t); } catch(e){ return 'ERR '+e.message; } })()";
  console.log('STORE_TAIL=' + String(await ev(tailExpr)));
  console.log('DOM_TAIL=' + JSON.stringify(await ev("document.body.innerText.slice(-200)")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
