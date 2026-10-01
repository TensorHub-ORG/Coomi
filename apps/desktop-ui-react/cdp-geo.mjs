const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC ' + (r.result.exceptionDetails.text||'')) : r.result.result.value; };
  const expr = "(function(){ var s=window.__sessionDebug.read(); var h=s.historyTail||[]; var last=h[h.length-1]||{}; var txt=String(last.content||''); var needle=txt.slice(-40); var hit=null; var all=document.querySelectorAll('*'); for (var i=0;i<all.length;i++){ var el=all[i]; if (el.children.length===0 && (el.textContent||'').indexOf(needle)>=0) { hit=el; break; } } var scroller=document.querySelector('[data-testid=virtuoso-scroller]') || document.querySelector('[data-virtuoso-scroller]'); if(!scroller){ var cands=[].slice.call(document.querySelectorAll('div')).filter(function(d){ var st=getComputedStyle(d); return (st.overflowY==='auto'||st.overflowY==='scroll') && d.scrollHeight>d.clientHeight+20; }); scroller=cands.sort(function(a,b){return b.scrollHeight-a.scrollHeight})[0]||null; } function box(el){ if(!el) return null; var r=el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; } return JSON.stringify({ found: !!hit, hitBox: box(hit), scroller: scroller ? { st: scroller.scrollTop, sh: scroller.scrollHeight, ch: scroller.clientHeight, box: box(scroller) } : null, viewportH: window.innerHeight }); })()";
  console.log('GEO=' + String(await ev(expr)));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
