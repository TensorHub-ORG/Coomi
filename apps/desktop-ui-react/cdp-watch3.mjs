/**
 * 常驻观测器 v3（只读 + 自动重连）：抓「整轮不显示 / 消息被吞」。
 * 常规每 200ms 采样；一旦出现可疑变化（条目变少 / 最后一条用户条目消失 / 渲染文本骤降 / 滚动跳变），
 * 立刻把**界面每一行的文本+位置+高度**、滚动容器指标、可见性一次性转储到日志。
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
  return JSON.stringify({
    len: d.messagesLen, streaming: d.streaming,
    tail: (d.messagesTail || []).map(function(m){ return m.kind + ':' + String(m.text || '').replace(/\\s+/g, ' ').slice(0, 16); }),
    txt: host ? (host.innerText || '').length : -1,
    top: host ? Math.round(host.scrollTop) : -1,
    sh: host ? Math.round(host.scrollHeight) : -1,
    ch: host ? Math.round(host.clientHeight) : -1,
    rows: host ? host.children.length : -1,
    vis: document.visibilityState,
  });
})()`;

const DUMP = `(function(){
  var cands = [].slice.call(document.querySelectorAll('div')).filter(function(x){
    return x.scrollHeight > x.clientHeight + 40 && x.clientHeight > 200;
  });
  var host = cands.length ? cands[cands.length - 1] : null;
  if (!host) return '{"err":"no-host"}';
  // 往下钻过单子元素的包装层，直到真正装着「消息行」的那一层
  var guard = 0;
  while (host.children.length === 1 && host.children[0].scrollHeight > host.clientHeight && guard < 6) { host = host.children[0]; guard += 1; }
  var rows = [];
  for (var i = 0; i < host.children.length; i++) {
    var el = host.children[i];
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    rows.push({
      i: i,
      text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 90),
      top: Math.round(r.top), h: Math.round(r.height),
      disp: cs.display, vis: cs.visibility, op: cs.opacity,
    });
  }
  return JSON.stringify({
    scrollTop: Math.round(host.scrollTop), scrollHeight: Math.round(host.scrollHeight),
    clientHeight: Math.round(host.clientHeight), viewportH: window.innerHeight,
    hostRect: (function(){ var r = host.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; })(),
    visibility: document.visibilityState, hasFocus: document.hasFocus(),
    tailText: (host.innerText || '').replace(/\s+/g, ' ').slice(-300),
    rows: rows,
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
const dump = async (why) => {
  const d = await ev(DUMP);
  if (typeof d === 'string') { try { rec({ ev: 'DUMP', why, ...JSON.parse(d) }); } catch { rec({ ev: 'DUMP', why, raw: d.slice(0, 400) }); } }
};

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
    let why = null;
    if (d.len < prev.len) { rec({ ev: 'SHRINK', from: prev.len, to: d.len, before: prev.tail, after: d.tail, streaming: d.streaming }); why = 'shrink'; }
    const lastUser = [...prev.tail].reverse().find((t) => t.startsWith('user:'));
    if (lastUser && !d.tail.some((t) => t === lastUser)) { rec({ ev: 'USER-ITEM-GONE', item: lastUser, from: prev.len, to: d.len, after: d.tail }); why = why || 'user-gone'; }
    if (d.txt >= 0 && prev.txt > 200 && d.txt < prev.txt * 0.5) { rec({ ev: 'RENDER-EMPTY', len: d.len, txtFrom: prev.txt, txtTo: d.txt, top: d.top, sh: d.sh, ch: d.ch, rows: d.rows }); why = why || 'render-empty'; }
    if (prev.ch > 0 && d.ch > 0 && prev.sh - prev.top - prev.ch < 80 && d.sh - d.top - d.ch > 400) { rec({ ev: 'SCROLL-JUMP', len: d.len, sh: d.sh, top: d.top, ch: d.ch }); why = why || 'scroll-jump'; }
    if (sig !== prev.sig || d.txt !== prev.txt || d.rows !== prev.rows) rec({ ev: 'state', len: d.len, streaming: d.streaming, txt: d.txt, top: d.top, sh: d.sh, ch: d.ch, rows: d.rows, vis: d.vis, tail: d.tail });
    if (why) await dump(why);
  }
  const evts = await ev('JSON.stringify((window.__watchEvents || []).slice(-6))');
  if (typeof evts === 'string') {
    try { const fresh = JSON.parse(evts).filter((x) => x.at > lastBeat); if (fresh.length) { rec({ ev: 'DOM-CHURN', bursts: fresh }); lastBeat = Date.now(); await dump('dom-churn'); } } catch { /* 忽略 */ }
  }
  prev = d;
  if (i % 150 === 0) rec({ ev: 'beat', len: d.len, streaming: d.streaming, txt: d.txt, rows: d.rows });
}
rec({ ev: 'exit' });
