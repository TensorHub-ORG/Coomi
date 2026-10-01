const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + (r.result.exceptionDetails.text || ''); return r.result.result.value; };
  const dbg = await ev("(function(){ try { var d = window.__sessionDebug; if (!d) return { nodbg: true }; var s = d.read(); var out = { sessionId: s.sessionId, historyLen: s.historyLen, eventsLen: s.eventsLen, streaming: s.streaming }; out.histTail = s.historyTail.map(function(m){ return { role: m.role, content: String(m.content||'').slice(0,60), id: m.id }; }); return out; } catch(e){ return { err: e.message }; } })()");
  console.log('DBG=' + JSON.stringify(dbg));
  const trace = await ev("(function(){ try { var t = window.__coomiTrace || []; return t.slice(-60).map(function(e){ return { t: e.t, s: e.seq, m: e.m }; }); } catch(e){ return null; } })()");
  console.log('TRACE_TAIL=' + (Array.isArray(trace) ? trace.length : String(trace)));
  if (Array.isArray(trace)) for (const e of trace) console.log(JSON.stringify(e));
  const dom = await ev("(function(){ try { var t=document.body.innerText; return { len:t.length, tail:t.slice(-220) }; } catch(e){ return { err:e.message }; } })()");
  console.log('DOM=' + JSON.stringify(dom));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
