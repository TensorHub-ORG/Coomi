const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC ' + (r.result.exceptionDetails.text||'')) : r.result.result.value; };
  const expr = "(function(){ var s = window.__sessionDebug.read(); var h = s.historyTail || []; var last = h[h.length-1] || {}; var txt = String(last.content||''); var needle = txt.slice(-40); var body = document.body.innerText; return JSON.stringify({ needle: needle.slice(0,40), inDom: body.indexOf(needle) >= 0, firstline: txt.slice(0,30), firstInDom: body.indexOf(txt.slice(0,30)) >= 0, docScroll: document.documentElement.scrollTop, bodyH: document.body.scrollHeight }); })()";
  console.log('CHECK=' + String(await ev(expr)));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
