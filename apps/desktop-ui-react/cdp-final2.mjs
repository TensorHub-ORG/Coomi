const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? 'EXC' : r.result.result.value; };
  console.log('DBG=' + await ev("(function(){ try { var d=window.__sessionDebug; if(!d) return 'nodbg'; var s=d.read(); return JSON.stringify({ sid:(s.sessionId||'').slice(0,8), hist:s.historyLen, ev:s.eventsLen, streaming:s.streaming }); } catch(e){ return 'ERR'; } })()"));
  console.log('DISC=' + String(await ev("document.body.innerText.indexOf('与引擎的连接已断开')>=0")));
  console.log('TAIL=' + String(await ev("document.body.innerText.slice(-120).replace(/\\n/g,' | ')")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
