const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC ' + (r.result.exceptionDetails.text||'')) : r.result.result.value; };
  const expr = "(function(){ var s=window.__sessionDebug.read(); var tail = s.messagesTail || []; var out = tail.map(function(m){ return { k: m.kind, len: String(m.text||'').length, head: String(m.text||'').slice(0,28) }; }); var lastUser = null; for (var i=tail.length-1;i>=0;i--){ if (tail[i].kind==='user'){ lastUser = tail[i]; break; } } var inDom = lastUser ? document.body.innerText.indexOf(String(lastUser.text).slice(0,20)) >= 0 : null; return JSON.stringify({ len: s.messagesLen, tail: out, lastUserHead: lastUser ? String(lastUser.text).slice(0,30) : null, lastUserInDom: inDom }); })()";
  console.log('STORE=' + String(await ev(expr)));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
