const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC'; return r.result.result.value; } catch { return null; } };
console.log('写诊断文件=' + await ev("(async function(){ try { return await window.__TAURI__.core.invoke('write_diagnostics'); } catch(e){ return 'ERR: '+String(e&&e.message||e).slice(0,200); } })()"));
const text = String(await ev("(async function(){ try { return await window.__TAURI__.core.invoke('collect_diagnostics'); } catch(e){ return 'ERR'; } })()"));
console.log('--- 诊断文本关键行 ---');
for (const line of text.split('\n')) {
  if (/代理|IPC|探活|WebView2|管理员|引擎端口/.test(line)) console.log('  ' + line);
}
ws.close();
