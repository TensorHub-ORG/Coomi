const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC ' + (r.result.exceptionDetails.text||'')) : r.result.result.value; };
  const msg = '你好，用一句话介绍你自己';
  const typed = await ev("(function(){ try { var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '" + msg + "'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'TYPED'; } catch(e){ return 'ERR'; } })()");
  await new Promise((r) => setTimeout(r, 400));
  const clicked = await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); var btn=b.length?b[b.length-1]:null; if(!btn) return 'NOBTN'; btn.click(); return 'CLICKED'; })()");
  const geoExpr = "(function(){ var cands=[].slice.call(document.querySelectorAll('div')).filter(function(d){ var st=getComputedStyle(d); return (st.overflowY==='auto'||st.overflowY==='scroll') && d.scrollHeight>d.clientHeight+20; }); var sc=cands.sort(function(a,b){return b.scrollHeight-a.scrollHeight})[0]; var t=document.body.innerText; var gap = sc ? Math.round(sc.scrollHeight-sc.clientHeight-sc.scrollTop) : -1; return JSON.stringify({ gap: gap, hasUserMsg: t.indexOf('你好，用一句话介绍你自己')>=0, tail: t.slice(-90) }); })()";
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const g = await ev(geoExpr);
    const stop = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()");
    console.log(JSON.stringify({ i: i, stop: stop, geo: g }));
    if (i > 2 && stop === 0) { console.log('DONE_AT=' + (i*3) + 's'); break; }
  }
  console.log('typed=' + typed + ' clicked=' + clicked);
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
