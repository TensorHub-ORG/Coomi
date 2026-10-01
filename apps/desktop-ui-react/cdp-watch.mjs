/**
 * 常驻观测器（只读）：盯着对话区，抓「消息被吞」和「界面闪烁」的瞬间。
 *  - 每 200ms 采一次 __sessionDebug.read()：条目数变少 → 立刻记 SHRINK（前后 tail 都留）。
 *  - 在页面里装一个 MutationObserver 盯对话容器的 childList：短窗口内大量增删 = 闪烁/重挂载。
 *  - 同时记录最后一次用户消息正文是否还在（被吞的直接证据）。
 * 输出追加到 cdp-watch.log（JSONL）。
 */
import { appendFileSync } from 'node:fs';
const LOG = new URL('./cdp-watch.log', import.meta.url).pathname.replace(/^\//, '');
const rec = (o) => { try { appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n'); } catch {} };
rec({ ev: 'boot' });

const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
if (!page) { rec({ ev: 'no-page' }); process.exit(0); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return null; return r.result.result.value; };

// 装观察器：数对话区的增删（闪烁 = 短窗口内大量 remove/insert）。
await ev(`(function(){
  if (window.__watchInstalled) return 'already';
  window.__watchEvents = [];
  window.__watchInstalled = true;
  var pick = function(){
    var cands = [].slice.call(document.querySelectorAll('div')).filter(function(d){
      return d.scrollHeight > d.clientHeight + 40 && d.clientHeight > 200;
    });
    return cands.length ? cands[cands.length - 1] : document.body;
  };
  var host = pick();
  window.__watchHost = host;
  var mo = new MutationObserver(function(recs){
    var add = 0, rem = 0;
    for (var i = 0; i < recs.length; i++) { add += recs[i].addedNodes.length; rem += recs[i].removedNodes.length; }
    if (add + rem >= 5) window.__watchEvents.push({ at: Date.now(), add: add, rem: rem });
    if (window.__watchEvents.length > 400) window.__watchEvents.splice(0, 200);
  });
  mo.observe(host, { childList: true, subtree: true });
  window.__watchMo = mo;
  return 'installed';
})()`);

let prev = null;
let lastBeat = Date.now();
for (let i = 0; i < 9000; i += 1) {
  await new Promise((r) => setTimeout(r, 200));
  const raw = await ev('JSON.stringify(window.__sessionDebug.read())');
  if (typeof raw !== 'string') { rec({ ev: 'probe-failed' }); continue; }
  const d = JSON.parse(raw);
  const tail = (d.messagesTail || []).map((m) => m.kind + ':' + String(m.text || '').replace(/\s+/g, ' ').slice(0, 14));
  const sig = tail.join('|');
  if (prev) {
    if (d.messagesLen < prev.len) {
      rec({ ev: 'SHRINK', from: prev.len, to: d.messagesLen, before: prev.tail, after: tail, streaming: d.streaming });
    }
    // 最后一条用户消息消失了（不管总条数变没变）
    const lastUserBefore = [...prev.tail].reverse().find((t) => t.startsWith('user:'));
    if (lastUserBefore && !tail.some((t) => t === lastUserBefore)) {
      rec({ ev: 'USER-ITEM-GONE', item: lastUserBefore, from: prev.len, to: d.messagesLen, after: tail });
    }
    if (sig !== prev.sig) rec({ ev: 'tail-changed', len: d.messagesLen, tail, streaming: d.streaming });
  }
  const evts = await ev('JSON.stringify((window.__watchEvents || []).slice(-6))');
  if (typeof evts === 'string') {
    const arr = JSON.parse(evts);
    const fresh = arr.filter((x) => x.at > lastBeat);
    if (fresh.length) { rec({ ev: 'DOM-CHURN', bursts: fresh }); lastBeat = Date.now(); }
  }
  prev = { len: d.messagesLen, tail, sig };
  if (i % 150 === 0) rec({ ev: 'beat', len: d.messagesLen, streaming: d.streaming });
}
rec({ ev: 'exit' });
ws.close();
