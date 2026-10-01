const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC') : r.result.result.value; };
  const say = async (text) => {
    await ev("(function(){ var ta=document.querySelector('textarea'); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '" + text + "'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()");
    await new Promise((r) => setTimeout(r, 300));
    await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(b.length) b[b.length-1].click(); return 1; })()");
  };
  const waitIdle = async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const stop = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()");
      if (i > 1 && stop === 0) return true;
    }
    return false;
  };
  await say('1+1等于几');
  console.log('turn1 done=' + await waitIdle());
  console.log('after1=' + String(await ev("JSON.stringify({ u1: document.body.innerText.indexOf('1+1等于几')>=0 })")));
  await say('2+2等于几');
  console.log('turn2 done=' + await waitIdle());
  console.log('after2=' + String(await ev("JSON.stringify({ u1: document.body.innerText.indexOf('1+1等于几')>=0, u2: document.body.innerText.indexOf('2+2等于几')>=0 })")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
