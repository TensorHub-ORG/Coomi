const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC') : r.result.result.value; };
  const expr = "(function(){ var n=0; var all=document.querySelectorAll('*'); for (var i=0;i<all.length;i++){ var el=all[i]; if (el.children.length===0 && (el.textContent||'').trim()==='nihuisha') n++; } var t=document.body.innerText; return JSON.stringify({ bubbleCount: n, appearsInText: t.indexOf('nihuisha')>=0, occurrences: t.split('nihuisha').length - 1 }); })()";
  console.log('CHECK=' + String(await ev(expr)));
  const winExpr = "(function(){ var el=document.querySelector('[data-msg-freeze]'); return JSON.stringify({ rows: document.querySelectorAll('[data-msg-freeze] > *').length }); })()";
  console.log('WINDOW=' + String(await ev(winExpr)));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
