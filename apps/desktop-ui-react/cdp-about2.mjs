/** 打开「设置 → 关于」，抓渲染出来的版本号（验证不再写死、也不是「—」）。 */
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC:' + String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || '').slice(0, 140); return r.result.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickByText = (t) => ev("(function(){ var want=decodeURIComponent('" + encodeURIComponent(t) + "'); var all=[].slice.call(document.querySelectorAll('button,a,[role=tab],[role=button],li,div,span,p')); var hits=all.filter(function(el){ return (el.textContent||'').trim()===want; }); if(!hits.length) return 'miss'; var el=hits[hits.length-1]; var tgt=el.closest('button,a,[role=tab],[role=button]')||el; tgt.click(); return 'ok:'+tgt.tagName; })()");
console.log('getVersion=' + await ev("(async function(){ try { return await window.__TAURI__.app.getVersion(); } catch(e) { return 'ERR:'+String(e&&e.message||e).slice(0,90); } })()"));
console.log('openSettings=' + await ev("(function(){ var b=[].slice.call(document.querySelectorAll('button,a,[role=button]')); var hit=b.filter(function(x){ var s=((x.getAttribute('aria-label')||'')+' '+(x.textContent||'')).trim(); return /设置/.test(s); }); if(!hit.length) return 'miss'; hit[0].click(); return 'ok'; })()"));
await sleep(1600);
console.log('clickAbout=' + await clickByText('关于'));
await sleep(1800);
console.log('about=' + await ev("(function(){ var t=document.body.innerText||''; var lines=t.split('\\n'); return JSON.stringify({ versionLines: lines.filter(function(l){ return /客户端版本|build|0\\.9\\.9|—/.test(l); }).slice(0,8) }); })()"));
ws.close();
