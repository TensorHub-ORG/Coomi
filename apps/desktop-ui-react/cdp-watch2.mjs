/**
 * 常驻观测器（只读 + 自动重连）：抓「消息被吞 / 整轮不显示」的瞬间。
 * 每 200ms 记：messages 条数、tail 签名、**界面里渲染出来的对话文本长度**、滚动位置、滚动离底距离。
 *  · 状态少条目 → SHRINK（前后 tail 都留）
 *  · 最后一条用户条目不见了 → USER-ITEM-GONE
 *  · 状态没变但渲染文本骤降 → RENDER-EMPTY（说明是渲染/滚动问题，不是数据丢了）
 *  · 对话容器短窗口批量增删 → DOM-CHURN（闪烁）
 * 应用重启会掉 CDP：自动重连并重装观察器。
 */
import { appendFileSync } from 'node:fs';
const LOG = './cdp-watch.log';
const rec = (o) => { try { appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n'); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(function(){
  var d = window.__sessionDebug.read();
  var cands = [].slice.call(document.querySelectorAll('div')).filter(function(x){
    return x.scrollHeight > x.clientHeight + 40 && x.clientHeight > 200;
  });
  var host = cands.length ? cands[cands.length - 1] : null;
  var txt = host ? (host.innerText || '').length : -1;
  var top = host ? Math.round(host.scrollTop) : -1;
  var fromBottom = host ? Math.round(host.scrollHeight - host.scrollTop - host.clientHeight) : -1;
  var rows = document.querySelectorAll('[data-msg-id]').length;
  return JSON.stringify({
    len: d.messagesLen, streaming: d.streaming,
    tail: (d.messagesTail || []).map(function(m){ return m.kind + ':' + String(m.text || '').replace(/\\s+/g, ' ').slice(0, 14); }),
    txt: txt, top: top, fromBottom: fromBottom, rows: rows,
  });
})()`;

const OBSERVER = `(function(){
  window.__watchEvents = [];
  var cands = [].slice.call(document.querySelectorAll('div')).filter(function(x){
    return x.scrollHeight > x.clientHeight + 40 && x.clientHeight > 200;
  });
  var host = cands.length ? cands[cands.length - 1] : document.body;
  if (window.__watchMo) { try { window.__watchMo.disconnect(); } catch (e) {} }
  var mo = new MutationObserver(function(recs){
    var add = 0, rem = 0;
    for (var i = 0; i < recs.length; i++) { add += recs[i].addedNodes.length; rem += recs[i].removedNodes.length; }
    if (add + rem >= 5) window.__watchEvents.push({ at: Date.now(), add: add, rem: rem });
    if (window.__watchEvents.length > 400) window.__watchEvents.splice(0, 200);
  });
  mo.observe(host, { childList: true, subtree: true });
  window.__watchMo = mo;
  return 'installed';
})()`;

let ws = null, seq = 0, pending = new Map(), alive = false;
function send(method, params) {
  return new Promise((resolve, reject) => {
    if (!alive || !ws) { reject(new Error('socket down')); return; }
    const i = ++seq;
    const timer = setTimeout(() => { pending.delete(i); reject(new Error('timeout ' + method)); }, 4000);
    pending.set(i, (m) => { clearTimeout(timer); resolve(m); });
    try { ws.send(JSON.stringify({ id: i, method, params })); }
    catch (e) { clearTimeout(timer); pending.delete(i); reject(e); }
  });
}
async function connect() {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  pending = new Map(); seq = 0;
  ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  ws.addEventListener('close', () => { alive = false; });
  ws.addEventListener('error', () => { alive = false; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('open timeout')), 6000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('open error')); }, { once: true });
  });
  alive = true;
  await send('Runtime.enable', {});
  await send('Runtime.evaluate', { expression: OBSERVER, returnByValue: true });
  rec({ ev: 'connected', url: page.url });
}
async function ev(expr) {
  try { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return null; return r.result.result.value; } catch { return null; }
}

rec({ ev: 'boot' });
let prev = null, lastBeat = Date.now(), waiting = 0;
for (let i = 0; i < 15000; i += 1) {
  if (!alive) {
    try { await connect(); prev = null; waiting = 0; }
    catch (e) { waiting += 1; if (waiting % 5 === 1) rec({ ev: 'reconnect-wait', msg: String(e && e.message || e).slice(0, 80) }); await sleep(3000); continue; }
  }
  await sleep(200);
  const raw = await ev(PROBE);
  if (typeof raw !== 'string') { if (!alive) rec({ ev: 'link-lost' }); continue; }
  let d; try { d = JSON.parse(raw); } catch { continue; }
  const sig = d.tail.join('|');
  if (prev) {
    if (d.len < prev.len) rec({ ev: 'SHRINK', from: prev.len, to: d.len, before: prev.tail, after: d.tail, streaming: d.streaming });
    const lastUser = [...prev.tail].reverse().find((t) => t.startsWith('user:'));
    if (lastUser && !d.tail.some((t) => t === lastUser)) rec({ ev: 'USER-ITEM-GONE', item: lastUser, from: prev.len, to: d.len, after: d.tail });
    // 状态没少但界面渲染文本骤降 → 渲染/滚动问题
    if (d.len >= prev.len && d.txt >= 0 && prev.txt > 200 && d.txt < prev.txt * 0.5) {
      rec({ ev: 'RENDER-EMPTY', len: d.len, txtFrom: prev.txt, txtTo: d.txt, top: d.top, fromBottom: d.fromBottom, rows: d.rows });
    }
    if (d.fromBottom >= 0 && prev.fromBottom >= 0 && prev.fromBottom < 80 && d.fromBottom > 400) {
      rec({ ev: 'SCROLL-JUMP', fromBottomFrom: prev.fromBottom, fromBottomTo: d.fromBottom, len: d.len, txt: d.txt });
    }
    if (sig !== prev.sig || d.txt !== prev.txt) rec({ ev: 'state', len: d.len, streaming: d.streaming, txt: d.txt, fromBottom: d.fromBottom, rows: d.rows, tail: d.tail });
  }
  const evts = await ev('JSON.stringify((window.__watchEvents || []).slice(-6))');
  if (typeof evts === 'string') {
    try { const fresh = JSON.parse(evts).filter((x) => x.at > lastBeat); if (fresh.length) { rec({ ev: 'DOM-CHURN', bursts: fresh }); lastBeat = Date.now(); } } catch { /* 忽略 */ }
  }
  prev = d;
  if (i % 150 === 0) rec({ ev: 'beat', len: d.len, streaming: d.streaming, txt: d.txt });
}
rec({ ev: 'exit' });
