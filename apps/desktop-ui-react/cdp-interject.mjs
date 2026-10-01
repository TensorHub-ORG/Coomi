const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC') : r.result.result.value; };
  const bubbles = (t) => ev("(function(){ var s='" + t + "'; var n=0; var all=document.querySelectorAll('*'); for (var i=0;i<all.length;i++){ var el=all[i]; if (el.children.length===0 && (el.textContent||'').trim()===s) n++; } return n; })()");
  const say = async (text) => {
    await ev("(function(){ var ta=document.querySelector('textarea'); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '" + text + "'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()");
    await new Promise((r)=>setTimeout(r,300));
    await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(b.length) b[b.length-1].click(); return 1; })()");
  };
  await say('INT1');
  await new Promise((r)=>setTimeout(r,2500));   // 第一轮还在生成时插话
  await say('INT2');
  console.log('sent both; waiting...');
  for (let i=0;i<30;i++){
    await new Promise((r)=>setTimeout(r,3000));
    const stop = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()");
    if (i>3 && stop===0) break;
  }
  console.log('final=' + JSON.stringify({ i1: await bubbles('INT1'), i2: await bubbles('INT2'), len: await ev("String(window.__sessionDebug.read().messagesLen)") }));
  console.log('tail=' + String(await ev("JSON.stringify((window.__sessionDebug.read().messagesTail||[]).map(function(m){return m.kind+':'+String(m.text||'').slice(0,12);}))")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
