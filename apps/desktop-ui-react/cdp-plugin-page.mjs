const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC ' + (r.result.exceptionDetails.text || ''); return r.result.result.value; } catch (e) { return 'ERR ' + e.message; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('① 启用演示插件=' + await ev("(async () => { try { return await window.__TAURI__.core.invoke('plugin_set_enabled', { id: 'demo-page', on: true }); } catch (e) { return 'ERR ' + String(e); } })()"));
sleep(600);
console.log('② plugin-views=' + await ev("(async () => { const b = window.__COOMI_BOOT__; const r = await fetch('http://127.0.0.1:' + b.port + '/api/plugins/views', { headers: { Authorization: 'Bearer ' + b.token } }); return await r.text(); })()"));
// 前端要重新拉一次注册表：刷新页面最直接
await send('Page.enable', {});
await send('Page.reload', { ignoreCache: true });
await sleep(9000);
console.log('③ 侧边栏入口=' + await ev("(function(){ var els = Array.from(document.querySelectorAll('[data-nav-key]')); return JSON.stringify(els.map(function(e){ return e.getAttribute('data-nav-key') + '|' + (e.getAttribute('aria-label')||''); })); })()"));
console.log('④ 点开插件页=' + await ev("(function(){ var el = document.querySelector('[data-nav-key=\"plugin:demo-page:demo\"]'); if (!el) return 'no-entry'; el.click(); return 'clicked'; })()"));
await sleep(2500);
console.log('⑤ iframe=' + await ev("(function(){ var f = document.querySelector('iframe'); if (!f) return 'no-iframe'; return JSON.stringify({ src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox') }); })()"));
ws.close();