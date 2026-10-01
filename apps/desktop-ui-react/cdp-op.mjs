/** 量每一行当前的真实不透明度 / 正在跑的动画 / framer-motion 留下的内联样式。 */
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
  var out = rows.map(function(el){
    var cs = getComputedStyle(el);
    var low = [];
    var walk = function(node, depth){
      if (depth > 3) return;
      for (var i = 0; i < node.children.length; i++) {
        var ch = node.children[i];
        var c = getComputedStyle(ch);
        var op = parseFloat(c.opacity);
        var anim = c.animationName && c.animationName !== 'none' ? (c.animationName + '/' + c.animationPlayState) : '';
        if (op < 0.98 || anim) {
          low.push({ tag: ch.tagName.toLowerCase(), op: op, anim: anim, inline: (ch.getAttribute('style')||'').slice(0,90), depth: depth });
        }
        walk(ch, depth + 1);
      }
    };
    walk(el, 1);
    return {
      idx: el.getAttribute('data-msg-index'),
      op: parseFloat(cs.opacity),
      inline: (el.getAttribute('style')||'').slice(0, 110),
      anim: cs.animationName && cs.animationName !== 'none' ? cs.animationName + '/' + cs.animationPlayState + ' fill=' + cs.animationFillMode : '',
      lowOpacityChildren: low.slice(0, 5),
      text: (el.innerText||'').replace(/\\s+/g,' ').slice(0, 22),
    };
  });
  var html = document.documentElement;
  return JSON.stringify({
    motion: html.getAttribute('data-motion'),
    themeBg: !!document.querySelector('.theme-bg'),
    rows: out,
  });
})()`;
const r = JSON.parse(await ev(probe));
console.log('data-motion=' + r.motion + ' theme-bg=' + r.themeBg);
for (const row of r.rows) {
  console.log('idx=' + row.idx + ' opacity=' + row.op + ' anim=' + JSON.stringify(row.anim) + ' inline=' + JSON.stringify(row.inline) + ' :: ' + JSON.stringify(row.text));
  for (const ch of row.lowOpacityChildren) console.log('     └ ' + ch.tag + ' op=' + ch.op + ' anim=' + JSON.stringify(ch.anim) + ' inline=' + JSON.stringify(ch.inline));
}
ws.close();
