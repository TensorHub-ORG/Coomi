const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC') : r.result.result.value; };
  const bubbleCount = (text) => ev("(function(){ var t='" + text + "'; var n=0; var all=document.querySelectorAll('*'); for (var i=0;i<all.length;i++){ var el=all[i]; if (el.children.length===0 && (el.textContent||'').trim()===t) n++; } return n; })()");
  const waitIdle = async () => { for (let i=0;i<25;i++){ await new Promise((r)=>setTimeout(r,3000)); const s = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()"); if (i>1 && s===0) return true; } return false; };
  const say = async (text) => {
    await ev("(function(){ var ta=document.querySelector('textarea'); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '" + text + "'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()");
    await new Promise((r)=>setTimeout(r,300));
    await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(b.length) b[b.length-1].click(); return 1; })()");
  };
  const A = 'QA1'; const B = 'QB2'; const C = 'QC3';
  await say(A); await waitIdle();
  console.log('after_A=' + JSON.stringify({ a: await bubbleCount(A) }));
  await say(B); await waitIdle();
  console.log('after_B=' + JSON.stringify({ a: await bubbleCount(A), b: await bubbleCount(B) }));
  await say(C); await waitIdle();
  console.log('after_C=' + JSON.stringify({ a: await bubbleCount(A), b: await bubbleCount(B), c: await bubbleCount(C) }));
  console.log('len=' + String(await ev("String(window.__sessionDebug.read().messagesLen)")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
