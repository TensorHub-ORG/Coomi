const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && /tauri|index/i.test(t.url || '')) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
const send = (m, p) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push('[' + m.params.type + '] ' + text.slice(0, 300));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300));
  }
  if (m.method === 'Log.entryAdded') {
    logs.push('[log/' + m.params.entry.level + '] ' + String(m.params.entry.text || '').slice(0, 300));
  }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {}); await send('Log.enable', {}); await send('Page.enable', {});
const ev = async (x) => { try { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) return 'EXC'; return r.result.result.value; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('DOM=' + await ev("JSON.stringify({textarea: !!document.querySelector('textarea'), sendBtn: [].slice.call(document.querySelectorAll('button')).filter(function(b){return /发送|send/i.test((b.getAttribute('aria-label')||'')+(b.textContent||''));}).length, hasTauri: !!window.__TAURI__, hasEvent: !!(window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen)})"));
console.log('listen测试=' + await ev("(async function(){ try { var off = await window.__TAURI__.event.listen('engine:ws-open', function(){}); off(); return 'ok'; } catch(e) { return 'ERR: ' + String(e && e.message || e).slice(0,160); } })()"));
await ev("(function(){ localStorage.setItem('coomi.transport.v1','ipc'); return 1; })()");
await send('Page.reload', { ignoreCache: true });
await sleep(12000);
console.log('--- 重载后控制台 ---');
for (const line of logs.slice(-25)) console.log('  ' + line);
ws.close();
