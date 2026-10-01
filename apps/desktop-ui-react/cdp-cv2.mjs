const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC'; return r.result.result.value; } catch (e) { return 'ERR:' + e.message; } };
const probe = `(function(){
  var sc = document.querySelector('[data-msg-scroller]');
  var srect = sc.getBoundingClientRect();
  var rows = [].slice.call(document.querySelectorAll('[data-msg-index]'));
  return JSON.stringify({
    scroller: { top: Math.round(srect.top), bottom: Math.round(srect.bottom), h: Math.round(srect.height) },
    scrollTop: Math.round(sc.scrollTop), scrollHeight: Math.round(sc.scrollHeight),
    rows: rows.map(function(el){
      var r = el.getBoundingClientRect();
      var vis = null; try { vis = el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }); } catch (e) {}
      var overlap = Math.max(0, Math.min(r.bottom, srect.bottom) - Math.max(r.top, srect.top));
      return { idx: el.getAttribute('data-msg-index'), top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), overlapPx: Math.round(overlap), painted: vis, text: (el.innerText||'').replace(/\\s+/g,' ').slice(0,20) };
    }),
  });
})()`;
// 先滚到底（用户平时的位置），再测
await ev("(function(){ var sc=document.querySelector('[data-msg-scroller]'); if(sc){ sc.scrollTop = sc.scrollHeight; } return 1; })()");
await new Promise((r) => setTimeout(r, 600));
const a = JSON.parse(await ev(probe));
console.log('滚到底后: scroller h=' + a.scroller.h + ' scrollTop=' + a.scrollTop + '/' + (a.scrollHeight - a.scroller.h));
for (const row of a.rows) console.log('  idx=' + row.idx + ' top=' + row.top + ' h=' + row.h + ' 可见重叠=' + row.overlapPx + 'px painted=' + row.painted + ' :: ' + JSON.stringify(row.text) + ((row.overlapPx > 8 && row.painted === false) ? '   <<<< 可见却没画' : ''));
ws.close();
