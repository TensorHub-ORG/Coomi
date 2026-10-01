const WS_URL = process.argv[2];
(async () => {
  const ws = new WebSocket(WS_URL); let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r)); await send('Runtime.enable', {});
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) return 'EXC:' + (r.result.exceptionDetails.text || '');
    return r.result.result.value;
  };
  // 确保在对话页
  await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('title')||'').indexOf('对话')>=0 || (x.getAttribute('aria-label')||'').indexOf('对话')>=0; })[0]; if(b){b.click(); return 'NAV';} return 'ALREADY'; })()");
  await new Promise((r) => setTimeout(r, 1500));
  const msg = '你好，请用一句话介绍你自己';
  const sent = await ev("(function(){ try { var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta,'" + msg + "'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'TYPED'; } catch(e){ return 'ERR:'+e.message; } })()");
  await new Promise((r) => setTimeout(r, 400));
  const clicked = await ev("(function(){ try { var ta=document.querySelector('textarea'); var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); var btn=b.length?b[b.length-1]:null; if(btn){btn.click(); return 'CLICKED';} ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true})); return 'ENTER'; } catch(e){ return 'ERR:'+e.message; } })()");
  const probe = "JSON.stringify((function(){ try { var t=document.body.innerText; return { len:t.length, hasSent:t.indexOf('" + msg + "')>=0, rows:document.querySelectorAll('[data-message-id], article, [class*=bubble]').length, tail:t.slice(-120).replace(/\n/g,' ') }; } catch(e){ return {err:e.message}; } })())";
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const val = await ev(probe);
    let done = false;
    try {
      const s = JSON.parse(val);
      done = s.len > 0 && !(await ev("(function(){ return !!document.querySelector('[aria-label*=停止]'); })()")) && i > 2;
      console.log(JSON.stringify({ i: i, sent: sent, click: clicked, s: s, done: done }));
      if (done && s.hasSent) { console.log(JSON.stringify({ RESULT: 'PAIR_VISIBLE', s: s })); break; }
      if (done && !s.hasSent) { console.log(JSON.stringify({ RESULT: 'SENT_SWALLOWED', s: s })); break; }
    } catch (e) { console.log(JSON.stringify({ i: i, raw: String(val).slice(0,200) })); }
  }
  ws.close();
})().catch((e) => console.log('FAIL ' + e.message));
