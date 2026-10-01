const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC') : r.result.result.value; };
  const dump = await ev("(function(){ var rows=[].slice.call(document.querySelectorAll('button, [role=option], li')); var out=[]; for (var i=0;i<rows.length;i++){ var el=rows[i]; var t=(el.textContent||'').trim(); if (t.length>2 && t.length<60 && el.getBoundingClientRect().width>80 && el.getBoundingClientRect().left<420) { out.push({ i:i, tag: el.tagName, attrs: (el.getAttributeNames?el.getAttributeNames().join(','):'').slice(0,60), text: t.slice(0,40) }); } } return JSON.stringify(out.slice(0,14)); })()");
  console.log('ROWS=' + String(dump));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
