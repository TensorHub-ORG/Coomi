const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC') : r.result.result.value; };
  await new Promise((r) => setTimeout(r, 5000));
  const expr = "(function(){ var cands=[].slice.call(document.querySelectorAll('div')).filter(function(d){ var st=getComputedStyle(d); return (st.overflowY==='auto'||st.overflowY==='scroll') && d.scrollHeight>d.clientHeight+20; }); var sc=cands.sort(function(a,b){return b.scrollHeight-a.scrollHeight})[0]; if(!sc) return JSON.stringify({no:true}); var gap=Math.round(sc.scrollHeight-sc.clientHeight-sc.scrollTop); return JSON.stringify({ gapToBottom: gap, st: Math.round(sc.scrollTop), sh: sc.scrollHeight, ch: sc.clientHeight }); })()";
  console.log('GEO=' + String(await ev(expr)));
  console.log('DBG=' + String(await ev("(function(){ var s=window.__sessionDebug.read(); return JSON.stringify({ items:s.itemsLen, lastText:s.lastAssistantTextLen, streaming:s.streaming }); })()")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
