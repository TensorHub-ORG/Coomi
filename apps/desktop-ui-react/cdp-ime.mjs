/** 用真实输入法路径复现：imeSetComposition（拼音候选）→ 回车提交候选 → 再回车发送。 */
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
const snap = async (tag) => {
  const raw = await ev('JSON.stringify(window.__sessionDebug.read())');
  let d = {}; try { d = JSON.parse(raw); } catch {}
  console.log(tag + ' :: ' + JSON.stringify({ len: d.messagesLen, streaming: d.streaming, tail: (d.messagesTail || []).map((m) => m.kind + ':' + String(m.text || '').replace(/\s+/g, ' ').slice(0, 12)) }));
};
console.log('newSession=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button,a,[role=button]')); var hit=b.filter(function(x){ var s=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim(); return /新建对话|新对话|新建聊天/.test(s); }); if(!hit.length) return 'miss'; hit[0].click(); return 'ok'; })()"));
await sleep(2500);
console.log('focus=' + await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; ta.focus(); ta.click(); return 'ok'; })()"));
const TOKEN = '输入法测试' + Math.floor(Math.random() * 900 + 100);
// 1) 组成中（候选未上屏）
await send('Input.imeSetComposition', { text: 'shurufa', selectionStart: 7, selectionEnd: 7 });
await sleep(300);
// 2) 回车提交候选（真实输入法的第一步回车）
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(500);
console.log('afterImeEnter draft=' + await ev("(function(){ var ta=document.querySelector('textarea'); return ta ? JSON.stringify(ta.value) : 'NOTA'; })()"));
// 3) 上屏成中文（模拟候选提交结果）再回车发送
await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
await send('Input.insertText', { text: TOKEN });
await sleep(300);
console.log('afterInsert draft=' + await ev("(function(){ var ta=document.querySelector('textarea'); return ta ? JSON.stringify(ta.value) : 'NOTA'; })()"));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(1200);
await snap('afterEnterSend');
for (let i = 0; i < 25; i += 1) {
  await sleep(2000);
  const stop = await ev("(function(){ return [].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; })()");
  if (i > 1 && stop === 0) break;
}
await sleep(600);
await snap('turnEnd+0.6s');
await sleep(4000);
await snap('turnEnd+4.6s');
console.log('TOKEN=' + TOKEN);
console.log('draftAfter=' + await ev("(function(){ var ta=document.querySelector('textarea'); return ta ? JSON.stringify(ta.value) : 'NOTA'; })()"));
console.log('journalLast=' + await ev("JSON.stringify((window.__sessionDebug.journal()||[]).slice(-5))"));
ws.close();
