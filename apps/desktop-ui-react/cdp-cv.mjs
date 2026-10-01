/** 实测 content-visibility:auto 有没有让「已经在 DOM 里、且落在视口内」的消息行不被绘制。 */
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + String(r.result.exceptionDetails.exception?.description||'').slice(0,160); return r.result.result.value; } catch (e) { return 'ERR:' + e.message; } };
const probe = `(function(){
  var rows = [].slice.call(document.querySelectorAll('[data-msg-index]'));
  var sc = document.querySelector('[data-msg-scroller]');
  var srect = sc ? sc.getBoundingClientRect() : null;
  var out = rows.map(function(el){
    var r = el.getBoundingClientRect();
    var inView = srect ? (r.bottom > srect.top && r.top < srect.bottom) : false;
    var vis = null;
    try { vis = el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }); } catch (e) { vis = 'no-api'; }
    var cs = getComputedStyle(el);
    return {
      idx: el.getAttribute('data-msg-index'),
      h: Math.round(r.height),
      top: Math.round(r.top),
      inView: inView,
      painted: vis,
      cv: cs.contentVisibility,
      cis: cs.containIntrinsicSize,
      text: (el.innerText || '').replace(/\\s+/g,' ').slice(0, 26),
    };
  });
  return JSON.stringify({
    scrollTop: sc ? Math.round(sc.scrollTop) : -1,
    scrollHeight: sc ? Math.round(sc.scrollHeight) : -1,
    clientHeight: sc ? Math.round(sc.clientHeight) : -1,
    rows: out,
  });
})()`;
const r = JSON.parse(await ev(probe));
console.log('scrollTop=' + r.scrollTop + ' scrollHeight=' + r.scrollHeight + ' clientHeight=' + r.clientHeight);
for (const row of r.rows) {
  const flag = (row.inView && row.painted === false) ? '  <<<< 在视口内却没被绘制！' : '';
  console.log('  idx=' + row.idx + ' h=' + row.h + ' inView=' + row.inView + ' painted=' + row.painted + ' cv=' + row.cv + ' cis=' + row.cis + ' :: ' + JSON.stringify(row.text) + flag);
}
ws.close();
