/** 缓存验收：连发 4 条关键词互不相同的消息，逐轮量命中率。
 *  修复前：工具清单随关键词裁剪 → 前缀每轮变 → 命中率 0%~30% 乱跳。
 *  修复后：前缀稳定（system+tools+历史只追加）→ 第 2 轮起应 ≥85%。 */
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r, rej) => { const i = ++id; const t = setTimeout(() => { pending.delete(i); rej(new Error('to ' + m)); }, 9000); pending.set(i, (x) => { clearTimeout(t); r(x); }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + String(r.result.exceptionDetails.exception?.description||'').slice(0,120); return r.result.result.value; } catch (e) { return 'ERR:' + e.message; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('info=' + await ev("(async function(){ try { var i = await window.__TAURI__.core.invoke('engine_info'); window.__einfo = i; return 'ok'; } catch(e) { return 'ERR'; } })()"));
console.log('newSession=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button,a,[role=button]')); var hit=b.filter(function(x){ var s=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim(); return /新建对话|新对话|新建聊天/.test(s); }); if(!hit.length) return 'miss'; hit[0].click(); return 'ok'; })()"));
await sleep(2500);
const sid = await ev('String(window.__sessionDebug.read().sessionId)');
console.log('sid=' + sid);
const usage = async () => {
  const raw = await ev("(async function(){ try { var i=window.__einfo; var r=await fetch('http://127.0.0.1:'+i.port+'/api/sessions/'+'" + sid + "',{headers:{Authorization:'Bearer '+i.token}}); var j=await r.json(); var u=j.usage||{}; return JSON.stringify({i:u.input_tokens||0,c:u.cached_input_tokens||0,w:u.cache_write_tokens||0}); } catch(e){ return 'ERR'; } })()");
  try { return JSON.parse(raw); } catch { return null; }
};
const MSGS = [
  '你好，只回两个字',
  '帮我 ssh 连到远程服务器看看磁盘（不用真连，说明步骤即可）',
  '写一个快速排序的伪代码，简短',
  '用 memory_list 看看有哪些记忆（不用真的调用，说一句就行）',
  '把上面那条快排改成 Python，只给代码',
  '总结一下我们刚才聊了什么，一句话',
];
let prev = await usage();
console.log('起始用量=' + JSON.stringify(prev));
for (let k = 0; k < MSGS.length; k += 1) {
  await ev("(function(){ var ta=document.querySelector('textarea'); if(!ta) return 'NOTA'; ta.focus(); var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta, " + JSON.stringify(MSGS[k]) + "); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()");
  await sleep(350);
  await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){ var t=(x.getAttribute('aria-label')||'')+(x.textContent||''); return /发送|send/i.test(t); }); if(b.length) b[b.length-1].click(); return 1; })()");
  for (let i = 0; i < 60; i += 1) {
    await sleep(1500);
    const st = await ev("(function(){ var d=window.__sessionDebug.read(); var stop=[].slice.call(document.querySelectorAll('button')).filter(function(x){ return (x.getAttribute('aria-label')||'').indexOf('停止')>=0 }).length; return JSON.stringify({s:d.streaming,stop:stop}); })()");
    const u = await usage();
    try { const o = JSON.parse(st); if (i > 2 && !o.s && o.stop === 0 && u && prev && u.i > prev.i) break; } catch {}
  }
  await sleep(1200);
  const now = await usage();
  if (now && prev) {
    const di = now.i - prev.i, dc = now.c - prev.c, dw = (now.w || 0) - (prev.w || 0);
    console.log('第' + (k + 1) + '轮 输入+' + di + ' 命中+' + dc + ' 写+' + dw + ' → 本轮命中率=' + (di ? (dc / di * 100).toFixed(1) : '0') + '%');
  }
  prev = now;
}
console.log('结束时用量=' + JSON.stringify(prev));
ws.close();
