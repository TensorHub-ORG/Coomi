/**
 * 复现：在**新会话**里发一条消息，等回答结束，抓住「回答完就整轮不显示」。
 * 输出：发送后 / 回答中 / 回答结束后三个时刻的 messages 长度、tail、DOM 气泡数、journal。
 */
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error('to ' + m)); }, 8000); pending.set(i, (x) => { clearTimeout(t); r(x); }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + String(r.result.exceptionDetails.exception?.description || '').slice(0, 120); return r.result.result.value; } catch (e) { return 'ERR:' + e.message; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'REPRO' + Math.floor(Math.random() * 9000 + 1000);

const snap = async (tag) => {
  const raw = await ev('JSON.stringify(window.__sessionDebug.read())');
  let d = null; try { d = JSON.parse(raw); } catch {}
  const dom = await ev("(function(){ var t='" + TOKEN + "'; var leaf=0, all=document.querySelectorAll('*'); for(var i=0;i<all.length;i++){var el=all[i]; if(el.children.length===0 && (el.textContent||'').trim()===t) leaf++;} var rows=document.querySelectorAll('[data-msg-id]').length; var txt=(document.body.innerText||'').length; return JSON.stringify({tokenLeaf:leaf, rows:rows, bodyLen:txt}); })()");
  console.log(tag + ' :: ' + JSON.stringify({ len: d && d.messagesLen, streaming: d && d.streaming, tail: d && (d.messagesTail || []).map((m) => m.kind + ':' + String(m.text || '').replace(/\s+/g, ' ').slice(0, 12)), dom: dom }));
};

// 新会话：点「新建对话」
const made = await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button,a,[role=button]')); var hit=b.filter(function(x){ var s=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim(); return /新建对话|新对话|新建聊天/.test(s); }); if(!hit.length) return 'miss'; hit[0].click(); return 'ok'; })()");
console.log('newSession=' + made);
await sleep(2500);
await snap('before-send');

await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, '" + TOKEN + "'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()");
await sleep(400);
console.log('send=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(!b.length) return 'NOBTN'; b[b.length-1].click(); return 'sent'; })()"));
await sleep(1200);
await snap('just-sent');
await sleep(6000);
await snap('streaming');
// 等回答结束
for (let i = 0; i < 30; i += 1) {
  await sleep(2000);
  const stop = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()");
  if (i > 1 && stop === 0) break;
}
await sleep(500);
await snap('turn-end+0.5s');
await sleep(3000);
await snap('turn-end+3.5s');
await sleep(6000);
await snap('turn-end+9.5s');
console.log('journal=' + await ev("JSON.stringify((window.__sessionDebug.journal()||[]).slice(-8))"));
console.log('TOKEN=' + TOKEN);
ws.close();
