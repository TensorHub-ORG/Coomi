const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? ('EXC') : r.result.result.value; };
  const has = async (txt) => String(await ev("document.body.innerText.indexOf('" + txt + "')>=0"));
  const say = async (text) => {
    await ev("(function(){ var ta=document.querySelector('textarea'); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '" + text + "'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()");
    await new Promise((r) => setTimeout(r, 300));
    await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(b.length) b[b.length-1].click(); return 1; })()");
  };
  const clickNthSession = async (n) => ev("(function(){ var rows=[].slice.call(document.querySelectorAll('[data-session-row], [data-list-pane] button, aside button')).filter(function(x){ var t=(x.textContent||'').trim(); return t.length>1 && t.indexOf('新对话')<0 && t.indexOf('会话列表')<0; }); var r=rows[" + n + "]; if(!r) return 'NOROW'; r.click(); return 'CLICK'; })()");
  await say('3+3等于几');
  await new Promise((r) => setTimeout(r, 1500));
  console.log('right_after_send_u3=' + await has('3+3等于几'));
  console.log('switch_away=' + await clickNthSession(1));
  await new Promise((r) => setTimeout(r, 2500));
  console.log('switch_back=' + await clickNthSession(0));
  await new Promise((r) => setTimeout(r, 3000));
  console.log('after_switch_back_u3=' + await has('3+3等于几'));
  console.log('after_switch_back_tail=' + JSON.stringify(await ev("document.body.innerText.slice(-120)")));
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
